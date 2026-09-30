/**
 * GeoPics 云函数 `api` 的业务逻辑。依赖（wx-server-sdk 实例、环境变量、时钟）由外部注入，便于本地测试。
 *
 * 调用约定：小程序端 wx.cloud.callFunction({ name: 'api', data: { action, ... } })，返回 { ok, ... }。
 *   getEntitlement        -> { ok, state }
 *   createOrder           { kind: 'plan'|'single', planId? } -> { ok, orderId, payment }
 *   syncOrder             { orderId } -> { ok, status: 'pending'|'paid'|'failed', state }
 *   consume               { keys: [string] } -> { ok, state } | { ok:false, code:'insufficient', state }
 *   redeemInvite          { code } -> { ok, valid, state }
 * 微信支付结果回调也发给同一个函数（事件里没有 action，带 returnCode / outTradeNo），见 onPayNotify。
 *
 * 数据库集合（权限一律设为“仅云函数可读写”，小程序端不能直接访问）：
 *   users   _id = openid    { invite, bought, freeUsed, singles, packs, charged, inviteFails, ... }
 *   orders  _id = 商户订单号  { openid, kind, planId, title, totalFee, status, createdAt, paidAt, transactionId }
 *
 * 环境变量：SUB_MCH_ID（云开发微信支付子商户号，必填）、INVITE_CODES（邀请码，逗号分隔）、
 *   ENV_ID（可选，默认当前环境）、PAY_CALLBACK_FUNCTION（可选，默认 api）。
 */
const catalog = require('./catalog');
const quota = require('./quota');

const CHARGED_KEEP = 300;
const MAX_KEYS = 20;
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
  const db = cloud.database();
  const users = db.collection('users');
  const orders = db.collection('orders');

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

  // 保存前扣额度。每个 key 只计费一次（同一张照片重试不重复扣）；邀请码会员不扣。
  async function consume(openid, rawKeys) {
    const keys = Array.from(new Set((Array.isArray(rawKeys) ? rawKeys : []).map((k) => String(k || '')).filter((k) => k && k.length <= 64)));
    if (!keys.length || keys.length > MAX_KEYS) return { ok: false, code: 'bad_request', message: 'invalid keys' };
    await ensureUser(openid);
    const t0 = now();
    const result = await db.runTransaction(async (t) => {
      const ref = t.collection('users').doc(openid);
      const user = (await ref.get()).data;
      if (user.invite) return { ok: true, user };
      const charged = Array.isArray(user.charged) ? user.charged : [];
      const fresh = keys.filter((k) => !charged.includes(k));
      if (!fresh.length) return { ok: true, user };
      if (quota.available(user, catalog.freeQuota, t0) < fresh.length) return { ok: false, code: 'insufficient', user };
      const next = quota.consume(user, fresh.length, catalog.freeQuota, t0);
      next.charged = charged.concat(fresh).slice(-CHARGED_KEEP);
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
    const item = kind === 'plan' ? catalog.plans[event.planId] : kind === 'single' ? catalog.single : null;
    if (!item) return { ok: false, code: 'bad_request', message: 'unknown product' };
    if (!env.SUB_MCH_ID) return { ok: false, code: 'not_configured', message: 'SUB_MCH_ID is not set' };
    await ensureUser(openid);

    const orderId = `GP${now().toString(36).toUpperCase()}${randomText(8, '0123456789ABCDEFGHJKLMNPQRSTUVWXYZ')}`;
    await orders.add({
      data: { _id: orderId, openid, kind, planId: kind === 'plan' ? item.id : '', title: item.name, totalFee: item.price, status: 'pending', createdAt: now() }
    });
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
      if (paid.totalFee !== undefined && Number(paid.totalFee) !== order.totalFee) return { ok: false, code: 'amount_mismatch' };
      const uref = t.collection('users').doc(order.openid);
      const user = (await uref.get()).data;
      const grant = order.kind === 'plan' ? quota.grantPlan(user, catalog.plans[order.planId], orderId, t0) : quota.grantSingle(user, catalog.single);
      await uref.update({ data: grant });
      await oref.update({ data: { status: 'paid', paidAt: t0, transactionId: paid.transactionId || '' } });
      return { ok: true };
    });
  }

  // 主动向微信查单，补偿回调丢失的情况。字段以云开发文档为准，任何异常都视为“未支付”
  async function queryPaid(order) {
    if (!env.SUB_MCH_ID) return null;
    try {
      const r = await cloud.cloudPay.queryOrder({
        sub_mch_id: env.SUB_MCH_ID,
        out_trade_no: order._id,
        nonce_str: randomText(32, '0123456789abcdef')
      });
      if (r && r.returnCode === 'SUCCESS' && r.resultCode === 'SUCCESS' && r.tradeState === 'SUCCESS') {
        return { totalFee: r.totalFee, transactionId: r.transactionId };
      }
    } catch (e) {
      console.error('queryOrder failed', order._id, e);
    }
    return null;
  }

  async function reconcile(order) {
    if (order.status !== 'pending') return;
    const paid = await queryPaid(order);
    if (paid) await markPaid(order._id, paid);
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

  // 微信支付结果通知（cloudPay.unifiedOrder 的 functionName 回调）。返回 errcode 0 表示已处理，非 0 会被重试
  async function onPayNotify(event) {
    if (event.returnCode !== 'SUCCESS' || event.resultCode !== 'SUCCESS') return { errcode: 0, errmsg: 'ignored' };
    try {
      const r = await markPaid(String(event.outTradeNo || ''), { totalFee: event.totalFee, transactionId: event.transactionId });
      if (!r.ok) console.error('pay notify not applied', event.outTradeNo, r.code);
      return { errcode: 0, errmsg: 'OK' };
    } catch (e) {
      console.error('pay notify failed', event.outTradeNo, e);
      return { errcode: -1, errmsg: 'retry' };
    }
  }

  return async function main(event) {
    const ev = event || {};
    if (!ev.action) {
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
          return await consume(openid, ev.keys);
        case 'redeemInvite':
          return await redeemInvite(openid, ev.code);
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
