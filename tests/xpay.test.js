// 虚拟支付（iOS Apple 支付 / 其他平台微信支付）：云函数下单签名、推送入账、查单补偿、退款，以及小程序端 payment.js
const test = require('node:test');
const assert = require('node:assert');
const config = require('../utils/config');
const catalog = require('../cloudfunctions/api/catalog');
const { createHandler } = require('../cloudfunctions/api/handler');
const { createFakeCloud } = require('./helpers/fake-cloud');
const { createFakeXpay, hmac, APP, VIRTUAL_ENV } = require('./helpers/fake-xpay');

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);

function setup(extraEnv) {
  const fake = createFakeCloud();
  const xp = createFakeXpay();
  const main = createHandler({ cloud: fake.cloud, env: Object.assign({}, VIRTUAL_ENV, extraEnv), http: xp.http, now: () => NOW });
  return { fake, xp, main };
}

const order = (main, extra) => main(Object.assign({ action: 'createOrder', kind: 'plan', planId: 'month', code: 'code-a' }, extra));
const deliver = (orderId, extra) => ({ Event: 'xpay_goods_deliver_notify', MsgType: 'event', OpenId: 'openid-a', OutTradeNo: orderId, Env: 0, ...extra });
const ACK = { ErrCode: 0, ErrMsg: 'success' };
const pick = (r) => [r.ok, r.code];
const packsOf = (fake) => fake.dump().users['openid-a'].packs;

test('catalog: every product has a unique virtual-payment item id', () => {
  const ids = Object.values(catalog.productIds);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.deepStrictEqual(Object.keys(catalog.productIds).sort(), [...Object.keys(catalog.plans), 'lifetime', 'single'].sort());
});

test('xpay createOrder: signs signData with the AppKey and the user session key, price comes from the catalog', async () => {
  const { main, fake } = setup();
  const r = await order(main, { totalFee: 1, price: 1, goodsPrice: 1 });
  assert.ok(r.ok, JSON.stringify(r));
  assert.strictEqual(r.payment, undefined);
  const v = r.virtual;
  assert.strictEqual(v.mode, 'short_series_goods');
  const data = JSON.parse(v.signData);
  assert.deepStrictEqual(data, {
    offerId: APP.XPAY_OFFER_ID,
    buyQuantity: 1,
    env: 0,
    currencyType: 'CNY',
    productId: 'geopics_month',
    goodsPrice: 1490,
    outTradeNo: r.orderId,
    attach: 'geopics_month'
  });
  assert.ok(/^[^_].{7,31}$/.test(data.outTradeNo), 'outTradeNo is 8-32 chars and does not start with an underscore');
  assert.strictEqual(v.paySig, hmac(APP.XPAY_APP_KEY, `requestVirtualPayment&${v.signData}`));
  assert.strictEqual(v.signature, hmac('session-key-a==', v.signData));
  const o = fake.dump().orders[r.orderId];
  assert.deepStrictEqual([o.channel, o.productId, o.totalFee, o.status, o.openid], ['virtual', 'geopics_month', 1490, 'pending', 'openid-a']);
});

test('xpay createOrder: every product maps to its own item id and catalog price', async () => {
  const { main } = setup();
  const seen = {};
  for (const [kind, planId] of [['plan', 'month'], ['plan', 'year'], ['lifetime'], ['single']]) {
    const r = await order(main, { kind, planId });
    const d = JSON.parse(r.virtual.signData);
    seen[d.productId] = d.goodsPrice;
  }
  assert.deepStrictEqual(seen, { geopics_month: 1490, geopics_year: 10990, geopics_lifetime: 29900, geopics_single: 129 });
});

test('xpay createOrder: sandbox env signs with env 1', async () => {
  const { main } = setup({ XPAY_ENV: '1' });
  assert.strictEqual(JSON.parse((await order(main)).virtual.signData).env, 1);
});

test('xpay createOrder: refuses without config, login code, matching identity or when lifetime is owned', async () => {
  const { main, fake, xp } = setup();
  assert.strictEqual((await setup({ XPAY_APP_KEY: '' }).main({ action: 'createOrder', kind: 'single', code: 'code-a' })).code, 'not_configured');
  assert.strictEqual((await setup({ WX_APPSECRET: '' }).main({ action: 'createOrder', kind: 'single', code: 'code-a' })).code, 'not_configured');
  assert.strictEqual((await order(main, { code: '' })).code, 'need_login');
  assert.strictEqual((await order(main, { code: 'code-stale' })).code, 'login_failed');
  assert.strictEqual((await order(main, { kind: 'gift' })).code, 'bad_request');
  assert.deepStrictEqual(Object.keys(fake.dump().orders || {}), [], 'no order is created when the request is refused');

  fake.setOpenid('openid-b');
  assert.strictEqual((await order(main)).code, 'login_failed', "another user's code cannot be used to sign");

  fake.setOpenid('openid-a');
  const life = await order(main, { kind: 'lifetime' });
  xp.pay(life.orderId, 29900);
  await main(deliver(life.orderId));
  assert.deepStrictEqual(pick(await order(main, { kind: 'lifetime' })), [false, 'already_owned']);
});

test('xpay deliver notify: grants only what WeChat confirms via query_order, exactly once', async () => {
  const { main, fake, xp } = setup();
  const { orderId } = await order(main);

  assert.strictEqual((await main(deliver(orderId))).ErrCode, -1, 'WeChat does not know the order yet');
  xp.pay(orderId, 1490, { status: 1 });
  assert.deepStrictEqual(await main(deliver(orderId)), { ErrCode: -1, ErrMsg: 'order not paid yet' }, 'unpaid order is not granted and WeChat retries');
  assert.strictEqual(packsOf(fake).length, 0);

  xp.pay(orderId, 1490);
  assert.deepStrictEqual(await main(deliver(orderId)), ACK);
  assert.deepStrictEqual(await main(deliver(orderId)), ACK, 'repeated push');
  assert.strictEqual(packsOf(fake).length, 1);
  assert.deepStrictEqual([packsOf(fake)[0].planId, packsOf(fake)[0].quota], ['month', 120]);
  const o = fake.dump().orders[orderId];
  assert.deepStrictEqual([o.status, o.transactionId], ['paid', `VPO${orderId}`]);
});

test('xpay deliver notify: forged, mismatched or foreign events grant nothing', async () => {
  const { main, fake, xp } = setup();
  const { orderId } = await order(main);

  // 任何人都能调用云函数，伪造的推送没有微信侧付款就不会入账
  const forged = await main(deliver(orderId, { GoodsInfo: { ProductId: 'geopics_month', ActualPrice: 1490 }, WeChatPayInfo: { MchOrderNo: 'x' } }));
  assert.strictEqual(forged.ErrCode, -1);
  assert.strictEqual(packsOf(fake).length, 0);

  xp.pay(orderId, 1);
  assert.deepStrictEqual(await main(deliver(orderId)), ACK, 'paid amount differs from the catalog price: logged, not granted');
  assert.strictEqual(packsOf(fake).length, 0);
  assert.strictEqual(fake.dump().orders[orderId].status, 'pending');

  xp.pay(orderId, 1490);
  assert.deepStrictEqual(await main(deliver(orderId, { Env: 1 })), ACK, 'sandbox push is ignored in production');
  assert.strictEqual(packsOf(fake).length, 0);
  assert.deepStrictEqual(await main(deliver('GPNOSUCHORDER')), ACK, 'unknown orders are acknowledged, not retried forever');
  assert.deepStrictEqual(await main({ Event: 'xpay_complaint_notify', OutTradeNo: orderId }), ACK);

  xp.orders[orderId].status = 5;
  assert.strictEqual((await main(deliver(orderId))).ErrCode, -1, 'a refunded order never counts as paid');
  assert.strictEqual(packsOf(fake).length, 0);
});

test('xpay deliver notify: a failing lookup asks WeChat to retry, and the lost push is reconciled on demand', async () => {
  const { main, fake, xp } = setup();
  const { orderId } = await order(main);
  xp.pay(orderId, 1490);
  const failing = createHandler({ cloud: fake.cloud, env: VIRTUAL_ENV, http: async () => { throw new Error('network'); }, now: () => NOW });
  assert.deepStrictEqual(await failing(deliver(orderId)), { ErrCode: -1, ErrMsg: 'retry' });
  assert.strictEqual(packsOf(fake).length, 0);

  // 推送没到：用户回到小程序时 getEntitlement / syncOrder 查单入账
  const s = await main({ action: 'syncOrder', orderId });
  assert.deepStrictEqual([s.status, s.state.packs.length], ['paid', 1]);
  assert.strictEqual((await main({ action: 'getEntitlement' })).state.packs.length, 1, 'no double grant');
});

test('xpay query_order: signs the request body, caches and refreshes the access token', async () => {
  const { main, xp } = setup();
  const a = await order(main);
  const b = await order(main, { kind: 'single' });
  assert.strictEqual((await main({ action: 'syncOrder', orderId: a.orderId })).status, 'pending');
  assert.strictEqual((await main({ action: 'syncOrder', orderId: b.orderId })).status, 'pending');
  assert.strictEqual(xp.calls.token, 1, 'access_token is reused');
  assert.strictEqual(xp.calls.query, 2);

  xp.expireToken();
  xp.pay(a.orderId, 1490);
  assert.strictEqual((await main({ action: 'syncOrder', orderId: a.orderId })).status, 'paid', 'expired token is refreshed once and retried');
  assert.strictEqual(xp.calls.token, 2);

  const wrongKey = setup({ XPAY_APP_KEY: 'another-key' });
  const o = await order(wrongKey.main);
  assert.strictEqual((await wrongKey.main({ action: 'syncOrder', orderId: o.orderId })).status, 'pending', 'signature errors never grant');
});

test('xpay refund notify: revokes the granted entitlement only when the order is really refunded', async () => {
  const { main, fake, xp } = setup();
  const month = await order(main);
  const single = await order(main, { kind: 'single' });
  const life = await order(main, { kind: 'lifetime' });
  xp.pay(month.orderId, 1490); xp.pay(single.orderId, 129); xp.pay(life.orderId, 29900);
  for (const o of [month, single, life]) await main(deliver(o.orderId));
  let st = (await main({ action: 'getEntitlement' })).state;
  assert.deepStrictEqual([st.packs.length, st.singles, !!st.lifetime], [1, 1, true]);

  const refundEvent = (id) => ({ Event: 'xpay_refund_notify', OpenId: 'openid-a', MchOrderId: id, WxOrderId: `VPO${id}`, RefundFee: 1490, RetCode: 0, Env: 0 });
  assert.deepStrictEqual(await main(refundEvent(month.orderId)), ACK, 'forged refund: WeChat still says paid');
  assert.strictEqual(packsOf(fake).length, 1);
  assert.deepStrictEqual(await main({ ...refundEvent(month.orderId), RetCode: 1 }), ACK);

  for (const o of [month, single, life]) xp.refund(o.orderId);
  for (const o of [month, single, life]) assert.deepStrictEqual(await main(refundEvent(o.orderId)), ACK);
  assert.deepStrictEqual(await main(refundEvent(month.orderId)), ACK, 'repeated refund push');
  st = (await main({ action: 'getEntitlement' })).state;
  assert.deepStrictEqual([st.packs.length, st.singles, st.lifetime], [0, 0, null]);
  assert.strictEqual(fake.dump().orders[month.orderId].status, 'refunded');

  const again = await order(main, { kind: 'lifetime' });
  assert.ok(again.ok, 'after a refund the lifetime plan can be bought again');
});

test('xpay refund notify: one refund only removes its own order', async () => {
  const { main, fake, xp } = setup();
  const first = await order(main);
  const second = await order(main);
  xp.pay(first.orderId, 1490); xp.pay(second.orderId, 1490);
  await main(deliver(first.orderId)); await main(deliver(second.orderId));
  assert.strictEqual(packsOf(fake).length, 2);
  xp.refund(first.orderId);
  await main({ Event: 'xpay_refund_notify', MchOrderId: first.orderId, RetCode: 0, Env: 0 });
  assert.deepStrictEqual(packsOf(fake).map((p) => p.orderId), [second.orderId]);
});

/* ------------------------ 小程序端 utils/payment.js ------------------------ */

function withClient(main, wxExtra, run) {
  const payment = require('../utils/payment');
  const saved = { mode: config.payment.mode, confirm: config.payment.confirm, wx: global.wx };
  const calls = { virtual: [], modal: [], login: 0, callFunction: [] };
  config.payment.mode = 'cloud';
  config.payment.confirm = { tries: 3, delayMs: 0 };
  global.wx = Object.assign(
    {
      cloud: { callFunction: async ({ data }) => { calls.callFunction.push(data); return { result: await main(data) }; } },
      login: (o) => { calls.login += 1; o.success({ code: 'code-a' }); },
      getDeviceInfo: () => ({ platform: 'ios' }),
      getAppBaseInfo: () => ({ version: '8.0.68' }),
      canIUse: () => true,
      showModal: (o) => { calls.modal.push(o); o.success({ confirm: true }); },
      requestVirtualPayment: (o) => { calls.virtual.push(o); o.success({ errMsg: 'requestVirtualPayment:ok' }); }
    },
    wxExtra
  );
  const restore = () => { config.payment.mode = saved.mode; config.payment.confirm = saved.confirm; global.wx = saved.wx; };
  return run(payment, calls).then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}

test('client: pay() logs in, opens the virtual payment sheet with the signed params and confirms with the server', async () => {
  const { main, xp } = setup();
  let params = null;
  const pay = {
    requestVirtualPayment: (o) => {
      params = o;
      const d = JSON.parse(o.signData);
      // 用户在收银台付款，随后微信把发货推送发给云函数
      xp.pay(d.outTradeNo, d.goodsPrice);
      main(deliver(d.outTradeNo)).then(() => o.success({ errMsg: 'requestVirtualPayment:ok' }));
    }
  };
  await withClient(main, pay, async (payment, calls) => {
    const res = await payment.pay({ kind: 'plan', planId: 'month', title: '月度会员', priceText: '¥14.9' });
    assert.deepStrictEqual(Object.keys(params).sort(), ['fail', 'mode', 'paySig', 'signData', 'signature', 'success']);
    assert.strictEqual(params.mode, 'short_series_goods');
    assert.strictEqual(params.paySig, hmac(APP.XPAY_APP_KEY, `requestVirtualPayment&${params.signData}`));
    assert.strictEqual(params.signature, hmac('session-key-a==', params.signData));
    assert.strictEqual(res.ok, true); assert.ok(!res.pending);
    assert.deepStrictEqual([res.state.packs[0].quota, res.state.bought], [120, true]);
    assert.strictEqual(calls.login, 1);
    assert.strictEqual(calls.callFunction[0].code, 'code-a');
    assert.strictEqual(calls.virtual.length, 0, 'the override replaced the recorder');
  });
});

test('client: pay() reports pending when Apple / WeChat confirmation has not reached the server yet', async () => {
  const { main, fake, xp } = setup();
  await withClient(main, {}, async (payment) => {
    const res = await payment.pay({ kind: 'single', title: '单张解锁', priceText: '¥1.29' });
    assert.deepStrictEqual([res.ok, res.pending, res.state], [true, true, undefined]);
    assert.strictEqual((await payment.fetchEntitlement()).singles, 0);
    const orderId = Object.keys(fake.dump().orders)[0];
    xp.pay(orderId, 129);
    assert.strictEqual((await payment.fetchEntitlement()).singles, 1, 'entitlement catches up through query_order');
  });
});

test('client: iOS WeChat older than 8.0.68 is asked to update and nothing is charged', async () => {
  const { main } = setup();
  for (const wxExtra of [
    { getAppBaseInfo: () => ({ version: '8.0.67' }) },
    { getAppBaseInfo: () => ({ version: '7.0.20' }) },
    { canIUse: () => false }
  ]) {
    await withClient(main, wxExtra, async (payment, calls) => {
      assert.deepStrictEqual(await payment.pay({ kind: 'single', title: 't', priceText: 'p' }), { ok: false, unsupported: true });
      assert.strictEqual(calls.virtual.length, 0);
      assert.deepStrictEqual([calls.modal[0].title, calls.modal[0].confirmText, calls.modal[0].showCancel], ['需要更新微信', '知道了', false]);
      assert.ok(calls.modal[0].confirmText.length <= 4);
    });
  }
  await withClient(main, { getAppBaseInfo: () => ({ version: '8.0.100' }) }, async (payment, calls) => {
    assert.strictEqual((await payment.pay({ kind: 'single', title: 't', priceText: 'p' })).ok, true);
    assert.strictEqual(calls.virtual.length, 1);
  });
  await withClient(main, { getDeviceInfo: () => ({ platform: 'android' }), getAppBaseInfo: () => ({ version: '8.0.40' }) }, async (payment, calls) => {
    assert.strictEqual((await payment.pay({ kind: 'single', title: 't', priceText: 'p' })).ok, true);
    assert.strictEqual(calls.virtual.length, 1, 'the version floor only applies to iOS');
  });
});

test('client: cancel, payment failure and login failure', async () => {
  const { main } = setup();
  await withClient(main, { requestVirtualPayment: (o) => o.fail({ errMsg: 'requestVirtualPayment:fail cancel', errCode: -2 }) }, async (payment) => {
    assert.deepStrictEqual(await payment.pay({ kind: 'single', title: 't', priceText: 'p' }), { ok: false });
  });
  await withClient(main, { requestVirtualPayment: (o) => o.fail({ errMsg: 'requestVirtualPayment:fail system error', errCode: -15004 }) }, async (payment) => {
    await assert.rejects(payment.pay({ kind: 'single', title: 't', priceText: 'p' }), (e) => e.errCode === -15004);
  });
  await withClient(main, { login: (o) => o.fail({ errMsg: 'login:fail' }) }, async (payment, calls) => {
    await assert.rejects(payment.pay({ kind: 'single', title: 't', priceText: 'p' }), (e) => e.code === 'need_login');
    assert.strictEqual(calls.virtual.length, 0);
  });
});
