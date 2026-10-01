/**
 * GeoPics 云函数 `api` 的业务逻辑。依赖（wx-server-sdk 实例、环境变量、时钟）由外部注入，便于本地测试。
 *
 * 调用约定：小程序端 wx.cloud.callFunction({ name: 'api', data: { action, ... } })，返回 { ok, ... }。
 *   getEntitlement        -> { ok, state }
 *   createOrder           { kind: 'plan'|'lifetime'|'single', planId? } -> { ok, orderId, payment }
 *                         买断已拥有时返回 code: 'already_owned'
 *   syncOrder             { orderId } -> { ok, status: 'pending'|'paid'|'failed', state }
 *   consume               { items: [{ key, tpl }] } -> { ok, state } | { ok:false, code:'insufficient', state }
 *                         key 相同只计费一次；tpl 是海报所用模板，免费模板先用免费额度
 *   redeemInvite          { code } -> { ok, valid, state }
 *   checkText             { text } -> { ok, safe }                     文本内容安全（msgSecCheck），见 security.js
 *   checkImage            { fileID } -> { ok, traceId } | { ok, skipped }  提交云存储里的图片副本做安全检测（mediaCheckAsync）
 *   imageResult           { traceId } -> { ok, status: 'pending'|'pass'|'risky'|'unknown' }
 * 支付通道由环境变量 PAY_CHANNEL 决定：
 *   virtual（默认）小程序虚拟支付 wx.requestVirtualPayment，iOS 走 Apple 支付、其他平台走微信支付。
 *     createOrder 需要 code（wx.login 的临时登录凭证）用来换 session_key 做用户态签名，返回 { virtual: { mode, signData, paySig, signature } }
 *   jsapi  云开发云支付（JSAPI），仅限不含 iOS 的场景，返回 { payment }
 * 支付结果通知也发给同一个函数，见 onPayNotify（云支付，事件里没有 action，带 returnCode / outTradeNo）
 * 与 onXpayNotify（虚拟支付消息推送，事件带 Event = xpay_*）。通知里的内容一律不直接采信，
 * 入账前都会向微信查单确认，所以伪造的请求不会发放权益。
 *
 * 数据库集合（权限一律设为“仅云函数可读写”，小程序端不能直接访问）：
 *   users   _id = openid    { invite, bought, freeMonth, freeUsed, singles, lifetime, packs, charged, inviteFails, ... }
 *   seccheck _id = trace_id  { openid, fileID, status: 'pending'|'pass'|'risky'|'expired', createdAt, checkedAt }
 *   orders  _id = 商户订单号  { openid, channel, productId, kind, planId, title, totalFee, status, createdAt, paidAt, transactionId }
 *
 * 环境变量：PAY_CHANNEL、INVITE_CODES（邀请码，逗号分隔）；
 *   virtual：XPAY_OFFER_ID、XPAY_APP_KEY、XPAY_ENV、WX_APPID、WX_APPSECRET（详见 xpay.js）；
 *   jsapi：SUB_MCH_ID（云开发微信支付子商户号）、ENV_ID（可选，默认当前环境）、PAY_CALLBACK_FUNCTION（可选，默认 api）。
 */
const catalog = require('./catalog');
const quota = require('./quota');
const { createXpay } = require('./xpay');
const { createSecurity } = require('./security');

const CHARGED_KEEP = 300;
const MAX_KEYS = 20;
const MAX_KEY_LEN = 64;
const PENDING_WINDOW = 2 * 60 * 60 * 1000;
const INVITE_MAX_FAILS = 10;
const INVITE_WINDOW = 60 * 60 * 1000;

function isMissing(e) {
  const text = `${(e && (e.errMsg || e.message)) || ''} ${(e && e.errCode) || ''}`;
  return /not exist|not found|-502004|-1\b/i.test(text);
}

function normalizeCode(code) {
  return String(code || '').trim().toLowerCase();
}

function createHandler(deps) {
  const { cloud } = deps;
  const env = deps.env || {};
  const now = deps.now || (() => Date.now());
  const random = deps.random || Math.random;
  const xpay = deps.xpay || createXpay({ env, http: deps.http, now });
  const channelOf = () => (env.PAY_CHANNEL === 'jsapi' ? 'jsapi' : 'virtual');
  const db = cloud.database();
  const users = db.collection('users');
  const orders = db.collection('orders');
  const security = createSecurity({ cloud, db, now });

  function randomText(len, alphabet) {
    let out = '';
    for (let i = 0; i < len; i += 1) out += alphabet[Math.floor(random() * alphabet.length)];
    return out;
  }

  async function ensureUser(openid) {
    try {
      return (await users.doc(openid).get()).data;
    } catch (e) {
      if (!isMissing(e)) throw e;
    }
    const fresh = quota.newUser(now());
    try {
      await users.add({ data: Object.assign({ _id: openid }, fresh) });
    } catch (e) {
      // 并发创建时另一个请求已写入，重新读取即可
      return (await users.doc(openid).get()).data;
    }
    return fresh;
  }

  const stateOf = (user) => quota.publicState(user, now());

  /* ------------------------------ 权益 ------------------------------ */

  async function getEntitlement(openid) {
    await ensureUser(openid);
    await syncPendingOrders(openid);
    return { ok: true, state: stateOf(await ensureUser(openid)) };
  }

  // 保存前扣额度。每个 key 只计费一次（同一张照片同一模板重试不重复扣）；邀请码会员不扣。
  async function consume(openid, rawItems) {
    const seen = new Set();
    const items = [];
    (Array.isArray(rawItems) ? rawItems : []).forEach((it) => {
      const key = String((it && it.key) || '');
      const tpl = String((it && it.tpl) || '');
      if (!key || key.length > MAX_KEY_LEN || tpl.length > MAX_KEY_LEN || seen.has(key)) return;
      seen.add(key);
      items.push({ key, tpl });
    });
    if (!items.length || items.length > MAX_KEYS) return { ok: false, code: 'bad_request', message: 'invalid items' };
    await ensureUser(openid);
    const t0 = now();
    const result = await db.runTransaction(async (t) => {
      const ref = t.collection('users').doc(openid);
      const user = (await ref.get()).data;
      if (user.invite) return { ok: true, user };
      const charged = Array.isArray(user.charged) ? user.charged : [];
      const fresh = items.filter((it) => !charged.includes(it.key));
      if (!fresh.length) return { ok: true, user };
      const tpls = fresh.map((it) => it.tpl);
      if (!quota.available(user, tpls, catalog.free, t0)) return { ok: false, code: 'insufficient', user };
      const next = quota.consume(user, tpls, catalog.free, t0);
      next.charged = charged.concat(fresh.map((it) => it.key)).slice(-CHARGED_KEEP);
      await ref.update({ data: next });
      return { ok: true, user: Object.assign({}, user, next) };
    });
    const out = { ok: result.ok, state: stateOf(result.user) };
    if (!result.ok) out.code = result.code;
    return out;
  }

  async function redeemInvite(openid, code) {
    const user = await ensureUser(openid);
    const t = now();
    const inWindow = t - (user.inviteFailsSince || 0) < INVITE_WINDOW;
    if (inWindow && (user.inviteFails || 0) >= INVITE_MAX_FAILS) {
      return { ok: true, valid: false, code: 'too_many_attempts', state: stateOf(user) };
    }
    const codes = String(env.INVITE_CODES || '').split(',').map(normalizeCode).filter(Boolean);
    const c = normalizeCode(code);
    if (c && codes.includes(c)) {
      await users.doc(openid).update({ data: { invite: true, inviteFails: 0, inviteFailsSince: 0 } });
      return { ok: true, valid: true, state: stateOf(Object.assign({}, user, { invite: true })) };
    }
    const fails = inWindow ? (user.inviteFails || 0) + 1 : 1;
    const since = inWindow ? user.inviteFailsSince : t;
    await users.doc(openid).update({ data: { inviteFails: fails, inviteFailsSince: since } });
    return { ok: true, valid: false, state: stateOf(user) };
  }

  /* ------------------------------ 订单 / 支付 ------------------------------ */

  async function createOrder(openid, event) {
    const kind = event && event.kind;
    const item =
      kind === 'plan' ? catalog.plans[event.planId] : kind === 'lifetime' ? catalog.lifetime : kind === 'single' ? catalog.single : null;
    if (!item) return { ok: false, code: 'bad_request', message: 'unknown product' };
    const channel = channelOf();
    if (channel === 'jsapi' && !env.SUB_MCH_ID) return { ok: false, code: 'not_configured', message: 'SUB_MCH_ID is not set' };
    if (channel === 'virtual' && !xpay.isConfigured()) return { ok: false, code: 'not_configured', message: 'virtual payment env vars are not set' };
    const user = await ensureUser(openid);
    if (kind === 'lifetime' && user.lifetime) return { ok: false, code: 'already_owned', message: 'lifetime already owned' };

    const productId = catalog.productIds[kind === 'plan' ? item.id : kind];
    let sessionKey = '';
    if (channel === 'virtual') {
      const code = String((event && event.code) || '');
      if (!code) return { ok: false, code: 'need_login', message: 'login code is required' };
      try {
        sessionKey = await xpay.sessionKey(code, openid);
      } catch (e) {
        console.error('session key failed', e);
        return { ok: false, code: 'login_failed', message: 'code2Session failed' };
      }
    }

    const orderId = `GP${now().toString(36).toUpperCase()}${randomText(8, '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ')}`;
    await orders.add({
      data: { _id: orderId, openid, channel, productId, kind, planId: kind === 'plan' ? item.id : '', title: item.name, totalFee: item.price, status: 'pending', createdAt: now() }
    });
    if (channel === 'virtual') {
      return { ok: true, orderId, virtual: xpay.buildPayment({ orderId, productId, price: item.price, sessionKey }) };
    }
    let res;
    try {
      res = await cloud.cloudPay.unifiedOrder({
        body: `GeoPics-${item.name}`,
        outTradeNo: orderId,
        spbillCreateIp: '127.0.0.1',
        subMchId: env.SUB_MCH_ID,
        totalFee: item.price,
        envId: env.ENV_ID || cloud.DYNAMIC_CURRENT_ENV,
        functionName: env.PAY_CALLBACK_FUNCTION || 'api',
        nonceStr: randomText(32, '0123456789abcdef'),
        tradeType: 'JSAPI'
      });
    } catch (e) {
      res = { returnCode: 'FAIL', returnMsg: (e && (e.errMsg || e.message)) || 'unifiedOrder error' };
    }
    if (!res || res.returnCode !== 'SUCCESS' || res.resultCode !== 'SUCCESS' || !res.payment) {
      await orders.doc(orderId).update({ data: { status: 'failed', failReason: String((res && (res.errCodeDes || res.returnMsg)) || '') } });
      return { ok: false, code: 'pay_unavailable', message: (res && (res.errCodeDes || res.returnMsg)) || 'unifiedOrder failed' };
    }
    return { ok: true, orderId, payment: res.payment };
  }

  // 支付成功入账：订单置为已支付并发放权益，同一事务内完成，重复调用无副作用
  async function markPaid(orderId, paid) {
    const t0 = now();
    return db.runTransaction(async (t) => {
      const oref = t.collection('orders').doc(orderId);
      let order;
      try {
        order = (await oref.get()).data;
      } catch (e) {
        if (isMissing(e)) return { ok: false, code: 'unknown_order' };
        throw e;
      }
      if (order.status === 'paid') return { ok: true, already: true };
      if (paid.channel && paid.channel !== (order.channel || 'jsapi')) return { ok: false, code: 'channel_mismatch' };
      if (paid.totalFee !== undefined && Number(paid.totalFee) !== order.totalFee) return { ok: false, code: 'amount_mismatch' };
      const uref = t.collection('users').doc(order.openid);
      const user = (await uref.get()).data;
      let grant;
      if (order.kind === 'plan') grant = quota.grantPlan(user, catalog.plans[order.planId], orderId, t0);
      else if (order.kind === 'lifetime') grant = quota.grantLifetime(user, catalog.lifetime, orderId, t0);
      else grant = quota.grantSingle(user, catalog.single);
      await uref.update({ data: grant });
      await oref.update({ data: { status: 'paid', paidAt: t0, transactionId: paid.transactionId || '' } });
      return { ok: true };
    });
  }

  // 向微信查单。已支付返回 { totalFee, transactionId, channel }，未支付返回 null，查询失败抛错
  async function queryPaidStrict(order) {
    if ((order.channel || 'jsapi') === 'virtual') {
      if (!xpay.isConfigured()) return null;
      const r = await xpay.queryOrder(order.openid, order._id);
      return r.paid ? { totalFee: r.totalFee, transactionId: r.transactionId, channel: 'virtual' } : null;
    }
    if (!env.SUB_MCH_ID) return null;
    const r = await cloud.cloudPay.queryOrder({
      sub_mch_id: env.SUB_MCH_ID,
      out_trade_no: order._id,
      nonce_str: randomText(32, '0123456789abcdef')
    });
    if (r && r.returnCode === 'SUCCESS' && r.resultCode === 'SUCCESS' && r.tradeState === 'SUCCESS') {
      return { totalFee: r.totalFee, transactionId: r.transactionId, channel: 'jsapi' };
    }
    return null;
  }

  // 补偿回调丢失的场景用：任何异常都视为“未支付”，下次再查
  async function queryPaid(order) {
    try {
      return await queryPaidStrict(order);
    } catch (e) {
      console.error('query order failed', order._id, e);
      return null;
    }
  }

  async function reconcile(order) {
    if (order.status !== 'pending') return;
    const paid = await queryPaid(order);
    if (paid) await markPaid(order._id, paid);
  }

  // 收到支付通知后入账：只认向微信查到的结果，不采信通知里的金额与状态
  async function settle(orderId) {
    let order;
    try {
      order = (await orders.doc(orderId).get()).data;
    } catch (e) {
      if (isMissing(e)) return { ok: false, code: 'unknown_order' };
      throw e;
    }
    if (order.status === 'paid') return { ok: true, already: true };
    const paid = await queryPaidStrict(order);
    if (!paid) return { ok: false, code: 'not_paid' };
    return markPaid(orderId, paid);
  }

  async function syncOrder(openid, orderId) {
    if (!orderId) return { ok: false, code: 'not_found' };
    let order;
    try {
      order = (await orders.doc(String(orderId || '')).get()).data;
    } catch (e) {
      if (isMissing(e)) return { ok: false, code: 'not_found' };
      throw e;
    }
    if (order.openid !== openid) return { ok: false, code: 'not_found' };
    await reconcile(order);
    const latest = (await orders.doc(order._id).get()).data;
    return { ok: true, status: latest.status, state: stateOf(await ensureUser(openid)) };
  }

  async function syncPendingOrders(openid) {
    let list = [];
    try {
      list = (await orders.where({ openid, status: 'pending' }).orderBy('createdAt', 'desc').limit(3).get()).data || [];
    } catch (e) {
      console.error('list pending orders failed', e);
      return;
    }
    const cutoff = now() - PENDING_WINDOW;
    for (const order of list.filter((o) => o.createdAt > cutoff)) {
      await reconcile(order);
    }
  }

  // 云支付结果通知（cloudPay.unifiedOrder 的 functionName 回调）。返回 errcode 0 表示已处理，非 0 会被重试
  async function onPayNotify(event) {
    if (event.returnCode !== 'SUCCESS' || event.resultCode !== 'SUCCESS') return { errcode: 0, errmsg: 'ignored' };
    try {
      const r = await settle(String(event.outTradeNo || ''));
      if (!r.ok) console.error('pay notify not applied', event.outTradeNo, r.code);
      return { errcode: 0, errmsg: 'OK' };
    } catch (e) {
      console.error('pay notify failed', event.outTradeNo, e);
      return { errcode: -1, errmsg: 'retry' };
    }
  }

  // 退款完成后收回权益。以向微信查到的订单状态为准，只处理虚拟支付订单
  async function revoke(orderId) {
    let order;
    try {
      order = (await orders.doc(orderId).get()).data;
    } catch (e) {
      if (isMissing(e)) return { ok: false, code: 'unknown_order' };
      throw e;
    }
    if (order.channel !== 'virtual' || !xpay.isConfigured()) return { ok: false, code: 'not_applicable' };
    if (order.status !== 'paid') return { ok: false, code: 'not_paid' };
    const r = await xpay.queryOrder(order.openid, order._id);
    if (!r.refunded) return { ok: false, code: 'not_refunded' };
    const t0 = now();
    return db.runTransaction(async (t) => {
      const oref = t.collection('orders').doc(orderId);
      const cur = (await oref.get()).data;
      if (cur.status !== 'paid') return { ok: true, already: true };
      const uref = t.collection('users').doc(cur.openid);
      const user = (await uref.get()).data;
      await uref.update({ data: quota.revokeOrder(user, cur) });
      await oref.update({ data: { status: 'refunded', refundedAt: t0 } });
      return { ok: true };
    });
  }

  // 虚拟支付消息推送。必须返回 { ErrCode: 0 } 才算处理成功，否则微信最多重试 15 次
  async function onXpayNotify(ev) {
    const ack = { ErrCode: 0, ErrMsg: 'success' };
    const orderId = String(ev.OutTradeNo || ev.MchOrderId || '');
    if (ev.Env !== undefined && Number(ev.Env) !== xpay.env) return ack;
    try {
      if (ev.Event === 'xpay_goods_deliver_notify') {
        const r = await settle(orderId);
        if (r.code === 'not_paid') return { ErrCode: -1, ErrMsg: 'order not paid yet' };
        if (!r.ok) console.error('xpay deliver not applied', orderId, r.code);
      } else if (ev.Event === 'xpay_refund_notify') {
        if (Number(ev.RetCode) === 0) {
          const r = await revoke(String(ev.MchOrderId || ''));
          if (!r.ok) console.error('xpay refund not applied', ev.MchOrderId, r.code);
        }
      } else {
        console.log('xpay event ignored', ev.Event);
      }
      return ack;
    } catch (e) {
      console.error('xpay notify failed', ev.Event, orderId, e);
      return { ErrCode: -1, ErrMsg: 'retry' };
    }
  }

  return async function main(event) {
    const ev = event || {};
    if (!ev.action) {
      if (typeof ev.Event === 'string' && ev.Event.startsWith('xpay_')) return onXpayNotify(ev);
      if (ev.Event === 'wxa_media_check') return security.onMediaCheck(ev);
      if (ev.returnCode !== undefined || ev.outTradeNo) return onPayNotify(ev);
      return { ok: false, code: 'bad_request' };
    }
    const openid = cloud.getWXContext().OPENID;
    if (!openid) return { ok: false, code: 'unauthorized' };
    try {
      switch (ev.action) {
        case 'getEntitlement':
          return await getEntitlement(openid);
        case 'createOrder':
          return await createOrder(openid, ev);
        case 'syncOrder':
          return await syncOrder(openid, ev.orderId);
        case 'consume':
          return await consume(openid, ev.items);
        case 'redeemInvite':
          return await redeemInvite(openid, ev.code);
        case 'checkText':
          return await security.checkText(openid, ev.text);
        case 'checkImage':
          return await security.checkImage(openid, ev.fileID);
        case 'imageResult':
          return await security.imageResult(openid, ev.traceId);
        default:
          return { ok: false, code: 'bad_request', message: 'unknown action' };
      }
    } catch (e) {
      console.error('api error', ev.action, e);
      return { ok: false, code: 'server_error' };
    }
  };
}

module.exports = { createHandler };
