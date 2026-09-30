const test = require('node:test');
const assert = require('node:assert');
const config = require('../utils/config');
const membership = require('../utils/membership');
const catalog = require('../cloudfunctions/api/catalog');
const serverQuota = require('../cloudfunctions/api/quota');
const { createHandler } = require('../cloudfunctions/api/handler');
const { createFakeCloud } = require('./helpers/fake-cloud');

const NOW = Date.UTC(2026, 8, 30, 12, 0, 0);
const ENV = { SUB_MCH_ID: '1900000001', INVITE_CODES: 'Geo0930, spare-code' };

function setup(extraEnv, clock) {
  const fake = createFakeCloud();
  let t = NOW;
  const main = createHandler({ cloud: fake.cloud, env: Object.assign({}, ENV, extraEnv), now: () => (clock ? clock() : t) , random: Math.random });
  return { fake, main, advance: (ms) => { t += ms; } };
}

// 服务端一次最多接受 20 项：按批发送 n 个同模板的保存请求，返回最后一批的结果
async function consumeMany(main, prefix, n, tpl) {
  let last = null;
  for (let done = 0; done < n; done += 20) {
    const items = Array.from({ length: Math.min(20, n - done) }, (_, i) => ({ key: `${prefix}${done + i}`, tpl }));
    last = await main({ action: 'consume', items });
    if (!last.ok) return last;
  }
  return last;
}

// 模拟微信在用户支付成功后向云函数发送的结果通知
const notify = (orderId, totalFee, extra) =>
  Object.assign({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: orderId, totalFee, transactionId: `wx-${orderId}` }, extra);

test('catalog: server prices, quotas and free tier match the mini program config', () => {
  const { plans, single, lifetime, free } = config.membership;
  assert.deepStrictEqual(catalog.free, free);
  for (const p of plans) {
    assert.deepStrictEqual(catalog.plans[p.id], { id: p.id, name: p.name, price: p.price, days: p.days, quota: p.quota });
  }
  assert.strictEqual(Object.keys(catalog.plans).length, plans.length);
  assert.deepStrictEqual(catalog.lifetime, { id: lifetime.id, name: lifetime.name, price: lifetime.price, monthly: lifetime.monthly });
  assert.strictEqual(catalog.single.price, single.price);
  assert.strictEqual(catalog.single.name, single.name);
  assert.strictEqual(catalog.single.quota, 1);
});

test('quota: server charging order matches the client membership rules', () => {
  let seed = 7;
  const rnd = (n) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  const plans = { month: catalog.plans.month, year: catalog.plans.year };
  const templates = ['polaroid', 'polaroid', 'magazine', 'arch', 'unknown-template'];
  let affordable = 0;
  let refused = 0;
  for (let i = 0; i < 600; i += 1) {
    const t = NOW + rnd(70) * serverQuota.DAY;
    let user = serverQuota.newUser(NOW);
    const monthNow = serverQuota.monthKey(t);
    user.freeMonth = ['', monthNow, '2020-01'][rnd(3)];
    user.freeUsed = rnd(12);
    user.singles = rnd(3);
    if (rnd(2)) {
      user = Object.assign(user, serverQuota.grantLifetime(user, catalog.lifetime, 'lt', NOW));
      user.lifetime.month = [monthNow, '2020-01'][rnd(2)];
      user.lifetime.used = rnd(catalog.lifetime.monthly + 1);
    }
    const packCount = rnd(3);
    for (let k = 0; k < packCount; k += 1) {
      const plan = rnd(2) ? plans.month : plans.year;
      user = Object.assign(user, serverQuota.grantPlan(user, plan, `o${k}`, NOW + rnd(5) * serverQuota.DAY));
      user.packs[user.packs.length - 1].used = rnd(plan.quota + 1);
    }
    const tpls = Array.from({ length: 1 + rnd(6) }, () => templates[rnd(templates.length)]);
    const client = membership.normalize(user);

    assert.strictEqual(serverQuota.freeRemaining(user, catalog.free, t), membership.freeRemaining(client, t));
    assert.strictEqual(serverQuota.paidRemaining(user, t), membership.paidRemaining(client, t));
    const freeWanted = tpls.filter(membership.isFreeTemplate).length;
    const useFree = Math.min(freeWanted, membership.freeRemaining(client, t));
    const clientOk = tpls.length - useFree <= membership.paidRemaining(client, t);
    assert.strictEqual(serverQuota.available(user, tpls, catalog.free, t), clientOk);
    if (!clientOk) { refused += 1; continue; }
    affordable += 1;

    const a = serverQuota.consume(user, tpls, catalog.free, t);
    const b = membership.consume(client, tpls, t);
    assert.strictEqual(a.freeMonth || '', b.freeMonth);
    assert.strictEqual(a.freeUsed, b.freeUsed);
    assert.strictEqual(a.singles, b.singles);
    assert.deepStrictEqual(a.lifetime && [a.lifetime.month, a.lifetime.used], b.lifetime && [b.lifetime.month, b.lifetime.used]);
    assert.deepStrictEqual(a.packs.map((p) => p.used), b.packs.map((p) => p.used));
  }
  assert.ok(affordable > 100 && refused > 50, `both outcomes are exercised (${affordable}/${refused})`);
});

test('api: new users start on the free tier; consuming is per key and template-aware', async () => {
  const { main } = setup();
  const first = await main({ action: 'getEntitlement' });
  assert.deepStrictEqual(first, { ok: true, state: { invite: false, bought: false, freeMonth: '', freeUsed: 0, singles: 0, lifetime: null, packs: [] } });
  const save = (key, tpl) => main({ action: 'consume', items: [{ key, tpl }] });

  const a1 = await save('s1:1:polaroid', 'polaroid');
  assert.ok(a1.ok); assert.strictEqual(a1.state.freeUsed, 1); assert.strictEqual(a1.state.freeMonth, '2026-09');
  const again = await save('s1:1:polaroid', 'polaroid');
  assert.ok(again.ok); assert.strictEqual(again.state.freeUsed, 1, 'same key is not charged twice');
  for (let i = 2; i <= 10; i += 1) assert.ok((await save(`s1:${i}:polaroid`, 'polaroid')).ok);
  const a11 = await save('s1:11:polaroid', 'polaroid');
  assert.strictEqual(a11.ok, false); assert.strictEqual(a11.code, 'insufficient'); assert.strictEqual(a11.state.freeUsed, 10);
  // 已计费的 key 额度用完后仍可重试
  assert.ok((await save('s1:2:polaroid', 'polaroid')).ok);
  for (const bad of [[], [{ key: '' }], [{ tpl: 'polaroid' }], null, Array.from({ length: 30 }, (_, i) => ({ key: `k${i}`, tpl: 'polaroid' }))]) {
    assert.strictEqual((await main({ action: 'consume', items: bad })).code, 'bad_request');
  }
  assert.strictEqual((await main({ action: 'consume', keys: ['legacy'] })).code, 'bad_request', 'old payload shape is rejected');
});

test('api: only the free template uses the free quota; other templates need paid quota', async () => {
  const { main, fake } = setup();
  const save = (key, tpl) => main({ action: 'consume', items: [{ key, tpl }] });
  for (const tpl of ['magazine', 'arch', 'unknown-template', '']) {
    const r = await save(`k-${tpl}`, tpl);
    assert.strictEqual(r.ok, false, `${tpl || 'empty'} template`); assert.strictEqual(r.code, 'insufficient');
  }
  assert.strictEqual(fake.dump().users['openid-a'].freeUsed, 0, 'refused saves cost nothing');

  // 同一张照片换模板再保存会重新计费：免费的拍立得不能“洗”成付费模板
  const order = await main({ action: 'createOrder', kind: 'single' });
  await main(notify(order.orderId, 129));
  assert.ok((await save('photo1:polaroid', 'polaroid')).ok);
  assert.strictEqual((await save('photo1:magazine', 'magazine')).ok, true, 'single credit covers the paid template');
  assert.strictEqual((await save('photo1:arch', 'arch')).code, 'insufficient');
  const st = (await main({ action: 'getEntitlement' })).state;
  assert.deepStrictEqual([st.freeUsed, st.singles], [1, 0]);
});

test('api: a multi-item consume is all-or-nothing and spends free quota first', async () => {
  const { main, fake } = setup();
  const order = await main({ action: 'createOrder', kind: 'plan', planId: 'month' });
  await main(notify(order.orderId, 1490));
  fake.patch('users', 'openid-a', { freeMonth: '2026-09', freeUsed: 9 });
  const r = await main({ action: 'consume', items: [{ key: 'a', tpl: 'polaroid' }, { key: 'b', tpl: 'polaroid' }, { key: 'c', tpl: 'magazine' }] });
  assert.ok(r.ok);
  assert.deepStrictEqual([r.state.freeUsed, r.state.packs[0].used], [10, 2]);

  const none = setup();
  const refused = await none.main({ action: 'consume', items: [{ key: 'x', tpl: 'polaroid' }, { key: 'y', tpl: 'magazine' }] });
  assert.strictEqual(refused.code, 'insufficient');
  assert.strictEqual(none.fake.dump().users['openid-a'].freeUsed, 0, 'nothing charged when one item cannot be covered');
});

test('api: the free quota resets on the first of each month (Beijing time)', async () => {
  let clock = Date.UTC(2026, 8, 30, 15, 0, 0);
  const { main } = setup({}, () => clock);
  for (let i = 0; i < 10; i += 1) assert.ok((await main({ action: 'consume', items: [{ key: `a${i}`, tpl: 'polaroid' }] })).ok);
  assert.strictEqual((await main({ action: 'consume', items: [{ key: 'a10', tpl: 'polaroid' }] })).code, 'insufficient');
  clock = Date.UTC(2026, 8, 30, 16, 0, 0);
  const r = await main({ action: 'consume', items: [{ key: 'b0', tpl: 'polaroid' }] });
  assert.ok(r.ok); assert.deepStrictEqual([r.state.freeMonth, r.state.freeUsed], ['2026-10', 1]);
});

test('api: requests need a wx identity and a known action', async () => {
  const { main, fake } = setup();
  assert.strictEqual((await main({ action: 'nope' })).code, 'bad_request');
  assert.strictEqual((await main({})).code, 'bad_request');
  fake.setOpenid('');
  assert.strictEqual((await main({ action: 'getEntitlement' })).code, 'unauthorized');
});

test('api: createOrder prices come from the server catalog', async () => {
  const { main, fake } = setup();
  assert.strictEqual((await main({ action: 'createOrder', kind: 'plan', planId: 'lifetime' })).code, 'bad_request', 'lifetime is its own kind');
  assert.strictEqual((await main({ action: 'createOrder', kind: 'gift' })).code, 'bad_request');

  const noMch = setup({ SUB_MCH_ID: '' });
  assert.strictEqual((await noMch.main({ action: 'createOrder', kind: 'single' })).code, 'not_configured');

  const r = await main({ action: 'createOrder', kind: 'plan', planId: 'month', totalFee: 1, price: 1 });
  assert.ok(r.ok); assert.ok(/^GP[0-9A-Z]{1,30}$/.test(r.orderId) && r.orderId.length <= 32);
  assert.strictEqual(r.payment.package, `prepay_id=${r.orderId}`);
  const call = fake.calls.unifiedOrder[0];
  assert.strictEqual(call.totalFee, 1490);
  assert.strictEqual(call.outTradeNo, r.orderId);
  assert.strictEqual(call.subMchId, '1900000001');
  assert.strictEqual(call.functionName, 'api');
  assert.strictEqual(call.envId, 'env-test');
  assert.strictEqual(call.tradeType, 'JSAPI');
  const order = fake.dump().orders[r.orderId];
  assert.strictEqual(order.status, 'pending'); assert.strictEqual(order.openid, 'openid-a'); assert.strictEqual(order.totalFee, 1490);

  fake.setUnifiedOrder(async () => ({ returnCode: 'SUCCESS', resultCode: 'FAIL', errCodeDes: 'no auth' }));
  const failed = await main({ action: 'createOrder', kind: 'single' });
  assert.strictEqual(failed.ok, false); assert.strictEqual(failed.code, 'pay_unavailable');
  assert.ok(Object.values(fake.dump().orders).some((o) => o.status === 'failed' && o.failReason === 'no auth'));
});

test('api: payment notification grants a pack exactly once', async () => {
  const { main, fake } = setup();
  const { orderId } = await main({ action: 'createOrder', kind: 'plan', planId: 'month' });
  assert.strictEqual((await main({ action: 'syncOrder', orderId })).status, 'pending');

  assert.deepStrictEqual(await main(notify(orderId, 1490)), { errcode: 0, errmsg: 'OK' });
  assert.deepStrictEqual(await main(notify(orderId, 1490)), { errcode: 0, errmsg: 'OK' }, 'duplicate notice');
  const r = await main({ action: 'syncOrder', orderId });
  assert.strictEqual(r.status, 'paid');
  assert.strictEqual(r.state.bought, true);
  assert.strictEqual(r.state.packs.length, 1, 'no double grant');
  assert.deepStrictEqual([r.state.packs[0].planId, r.state.packs[0].quota, r.state.packs[0].used], ['month', 120, 0]);
  assert.strictEqual(r.state.packs[0].until, NOW + 30 * serverQuota.DAY);
  assert.strictEqual(fake.dump().orders[orderId].transactionId, `wx-${orderId}`);
  assert.strictEqual(fake.dump().users['openid-a'].packs[0].orderId, orderId);
});

test('api: notifications with a wrong amount, unknown order or failure grant nothing', async () => {
  const { main, fake } = setup();
  const { orderId } = await main({ action: 'createOrder', kind: 'plan', planId: 'year' });
  assert.deepStrictEqual(await main(notify(orderId, 1)), { errcode: 0, errmsg: 'OK' });
  assert.strictEqual(fake.dump().orders[orderId].status, 'pending');
  assert.strictEqual(fake.dump().users['openid-a'].packs.length, 0);
  assert.strictEqual((await main(notify('GPNOSUCH', 100))).errcode, 0);
  assert.strictEqual((await main({ returnCode: 'FAIL', outTradeNo: orderId })).errmsg, 'ignored');
  assert.strictEqual((await main({ returnCode: 'SUCCESS', resultCode: 'FAIL', outTradeNo: orderId })).errmsg, 'ignored');
  assert.strictEqual(fake.dump().users['openid-a'].packs.length, 0);
});

test('api: single unlock adds one save, spent last and without membership perks', async () => {
  const { main } = setup();
  const { orderId } = await main({ action: 'createOrder', kind: 'single' });
  await main(notify(orderId, 129));
  const month = await main({ action: 'createOrder', kind: 'plan', planId: 'month' });
  await main(notify(month.orderId, 1490));
  let state = (await main({ action: 'getEntitlement' })).state;
  assert.strictEqual(state.singles, 1); assert.strictEqual(state.bought, true);

  for (const k of ['a', 'b']) await main({ action: 'consume', items: [{ key: k, tpl: 'polaroid' }] });
  state = (await main({ action: 'getEntitlement' })).state;
  assert.deepStrictEqual([state.freeUsed, state.singles, state.packs[0].used], [2, 1, 0], 'free polaroid quota first');
  state = (await main({ action: 'consume', items: [{ key: 'c', tpl: 'magazine' }] })).state;
  assert.deepStrictEqual([state.singles, state.packs[0].used], [1, 1], 'pack before the single credit');
  assert.ok((await consumeMany(main, 'bulk', 119, 'magazine')).ok);
  state = (await main({ action: 'consume', items: [{ key: 'd', tpl: 'magazine' }] })).state;
  assert.deepStrictEqual([state.singles, state.packs[0].used], [0, 120], 'single credit is used once packs are empty');

  const onlySingle = setup();
  const o = await onlySingle.main({ action: 'createOrder', kind: 'single' });
  await onlySingle.main(notify(o.orderId, 129));
  assert.strictEqual((await onlySingle.main({ action: 'getEntitlement' })).state.bought, false, 'single does not make a member');
});

test('api: lifetime purchase grants a monthly quota that resets, and can only be bought once', async () => {
  let clock = NOW;
  const { main, fake } = setup({}, () => clock);
  const order = await main({ action: 'createOrder', kind: 'lifetime' });
  assert.ok(order.ok);
  assert.strictEqual(fake.calls.unifiedOrder[0].totalFee, 29900);
  assert.strictEqual(fake.dump().orders[order.orderId].kind, 'lifetime');
  await main(notify(order.orderId, 1490));
  assert.strictEqual((await main({ action: 'getEntitlement' })).state.lifetime, null, 'wrong amount grants nothing');
  await main(notify(order.orderId, 29900));
  await main(notify(order.orderId, 29900));
  let state = (await main({ action: 'getEntitlement' })).state;
  assert.deepStrictEqual(state.lifetime, { planId: 'lifetime', quota: 120, month: '2026-09', used: 0 });
  assert.strictEqual(state.bought, true); assert.deepStrictEqual(state.packs, []);

  const again = await main({ action: 'createOrder', kind: 'lifetime' });
  assert.deepStrictEqual([again.ok, again.code], [false, 'already_owned']);

  assert.ok((await consumeMany(main, 'a', 120, 'magazine')).ok);
  assert.strictEqual((await consumeMany(main, 'b', 1, 'magazine')).code, 'insufficient', 'monthly limit reached');
  clock = Date.UTC(2026, 9, 1, 0, 30);
  state = (await consumeMany(main, 'c', 5, 'magazine')).state;
  assert.deepStrictEqual([state.lifetime.month, state.lifetime.used], ['2026-10', 5], 'new month, fresh quota, nothing carried over');
  clock = Date.UTC(2030, 0, 15);
  assert.ok((await consumeMany(main, 'd', 1, 'magazine')).ok, 'lifetime never expires');
});

test('api: paying twice for a lifetime plan keeps the existing record', async () => {
  const { main } = setup();
  const first = await main({ action: 'createOrder', kind: 'lifetime' });
  const second = await main({ action: 'createOrder', kind: 'lifetime' });
  await main(notify(first.orderId, 29900));
  await main({ action: 'consume', items: [{ key: 'x', tpl: 'magazine' }] });
  await main(notify(second.orderId, 29900));
  const st = (await main({ action: 'getEntitlement' })).state;
  assert.strictEqual(st.lifetime.used, 1, 'a duplicate payment does not reset the monthly usage');
  assert.strictEqual((await main({ action: 'syncOrder', orderId: second.orderId })).status, 'paid');
});

test('api: expired packs are ignored and cleared on the next purchase', async () => {
  let clock = NOW;
  const { main, fake } = setup({}, () => clock);
  const first = await main({ action: 'createOrder', kind: 'plan', planId: 'month' });
  await main(notify(first.orderId, 1490));
  clock += 31 * serverQuota.DAY;
  assert.strictEqual((await main({ action: 'consume', items: [{ key: 'a', tpl: 'magazine' }] })).code, 'insufficient', 'expired pack does not count');
  assert.ok((await main({ action: 'consume', items: [{ key: 'b', tpl: 'polaroid' }] })).ok, 'the free template still works');
  const second = await main({ action: 'createOrder', kind: 'plan', planId: 'year' });
  await main(notify(second.orderId, 10990));
  const packs = fake.dump().users['openid-a'].packs;
  assert.deepStrictEqual(packs.map((p) => p.planId), ['year']);
  assert.ok((await main({ action: 'consume', items: [{ key: 'c', tpl: 'magazine' }] })).ok);
});

test('api: syncOrder and getEntitlement reconcile a lost notification via queryOrder', async () => {
  const { main, fake } = setup();
  const { orderId } = await main({ action: 'createOrder', kind: 'plan', planId: 'month' });
  assert.strictEqual((await main({ action: 'syncOrder', orderId })).status, 'pending');
  assert.strictEqual(fake.calls.queryOrder[0].out_trade_no, orderId);
  assert.strictEqual(fake.calls.queryOrder[0].sub_mch_id, '1900000001');

  fake.setQueryOrder(async () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS', totalFee: 1490, transactionId: 'wx-q' }));
  const ent = await main({ action: 'getEntitlement' });
  assert.strictEqual(ent.state.packs.length, 1, 'pending order is settled when the app asks for entitlements');
  assert.strictEqual((await main({ action: 'syncOrder', orderId })).status, 'paid');
  assert.strictEqual((await main({ action: 'getEntitlement' })).state.packs.length, 1);

  // 查单出错或金额不符都不入账
  const b = await main({ action: 'createOrder', kind: 'plan', planId: 'year' });
  fake.setQueryOrder(async () => { throw new Error('network'); });
  assert.strictEqual((await main({ action: 'syncOrder', orderId: b.orderId })).status, 'pending');
  fake.setQueryOrder(async () => ({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', tradeState: 'SUCCESS', totalFee: 1 }));
  assert.strictEqual((await main({ action: 'syncOrder', orderId: b.orderId })).status, 'pending');
  assert.strictEqual((await main({ action: 'getEntitlement' })).state.packs.length, 1);
});

test('api: users cannot read other users orders', async () => {
  const { main, fake } = setup();
  const { orderId } = await main({ action: 'createOrder', kind: 'single' });
  fake.setOpenid('openid-b');
  assert.strictEqual((await main({ action: 'syncOrder', orderId })).code, 'not_found');
  assert.strictEqual((await main({ action: 'syncOrder', orderId: 'missing' })).code, 'not_found');
  assert.strictEqual((await main({ action: 'syncOrder' })).code, 'not_found');
  assert.strictEqual((await main({ action: 'getEntitlement' })).state.singles, 0);
});

test('api: invite codes live on the server, unlock without charging, and are rate limited', async () => {
  const { main, fake, advance } = setup();
  const bad = await main({ action: 'redeemInvite', code: 'nope' });
  assert.deepStrictEqual([bad.ok, bad.valid, bad.state.invite], [true, false, false]);
  assert.strictEqual((await main({ action: 'redeemInvite', code: '' })).valid, false);
  const ok = await main({ action: 'redeemInvite', code: '  GEO0930 ' });
  assert.deepStrictEqual([ok.valid, ok.state.invite], [true, true]);
  for (const k of ['a', 'b', 'c', 'd']) assert.ok((await main({ action: 'consume', items: [{ key: k, tpl: 'magazine' }] })).ok);
  assert.strictEqual(fake.dump().users['openid-a'].freeUsed, 0, 'invite members are not charged');

  const none = setup({ INVITE_CODES: '' });
  assert.strictEqual((await none.main({ action: 'redeemInvite', code: 'geo0930' })).valid, false, 'no codes configured');

  // 连续输错 10 次后暂时锁定，即使随后输入正确
  fake.setOpenid('openid-guess');
  for (let i = 0; i < 10; i += 1) await main({ action: 'redeemInvite', code: `guess${i}` });
  const locked = await main({ action: 'redeemInvite', code: 'geo0930' });
  assert.deepStrictEqual([locked.valid, locked.code], [false, 'too_many_attempts']);
  advance(61 * 60 * 1000);
  assert.strictEqual((await main({ action: 'redeemInvite', code: 'geo0930' })).valid, true);
});

test('api: only the most recent charged keys are kept', async () => {
  const { main, fake } = setup();
  await main({ action: 'redeemInvite', code: 'spare-code' });
  fake.patch('users', 'openid-a', { invite: false, freeUsed: 0, charged: Array.from({ length: 400 }, (_, i) => `old${i}`) });
  await main({ action: 'consume', items: [{ key: 'fresh', tpl: 'polaroid' }] });
  const charged = fake.dump().users['openid-a'].charged;
  assert.strictEqual(charged.length, 300); assert.strictEqual(charged[charged.length - 1], 'fresh');
});

/* ------------------ 小程序端 payment.js 与云函数联调 ------------------ */

function withCloudClient(fake, main, run) {
  const saved = { mode: config.payment.mode, confirm: config.payment.confirm, wx: global.wx };
  const requestPayment = { handler: null };
  config.payment.mode = 'cloud';
  config.payment.confirm = { tries: 3, delayMs: 0 };
  global.wx = {
    cloud: { callFunction: async ({ name, data }) => { assert.strictEqual(name, 'api'); return { result: await main(data) }; } },
    requestPayment(o) { Promise.resolve(requestPayment.handler ? requestPayment.handler(o) : null).then(() => o.success({}), o.fail); }
  };
  const restore = () => { config.payment.mode = saved.mode; config.payment.confirm = saved.confirm; global.wx = saved.wx; };
  return run(requestPayment).then((v) => { restore(); return v; }, (e) => { restore(); throw e; });
}

test('client: pay() confirms with the server before reporting success', async () => {
  const { main, fake } = setup();
  const payment = require('../utils/payment');
  await withCloudClient(fake, main, async (rp) => {
    assert.strictEqual(payment.isMock(), false);
    // 微信收银台成功后，回调到达云函数
    rp.handler = async (params) => { await main(notify(params.package.replace('prepay_id=', ''), 1490)); };
    const res = await payment.pay({ kind: 'plan', planId: 'month', title: '月度会员', priceText: '¥14.9' });
    assert.strictEqual(res.ok, true); assert.ok(!res.pending);
    assert.strictEqual(res.state.packs[0].quota, 120); assert.strictEqual(res.state.bought, true);
    assert.deepStrictEqual((await payment.fetchEntitlement()).packs.length, 1);
  });
});

test('client: pay() reports pending when the notification has not arrived, then entitlements catch up', async () => {
  const { main, fake } = setup();
  const payment = require('../utils/payment');
  await withCloudClient(fake, main, async (rp) => {
    let orderId = '';
    rp.handler = (params) => { orderId = params.package.replace('prepay_id=', ''); };
    const res = await payment.pay({ kind: 'single', title: '单张解锁', priceText: '¥1.29' });
    assert.deepStrictEqual([res.ok, res.pending, res.state], [true, true, undefined]);
    assert.strictEqual((await payment.fetchEntitlement()).singles, 0);
    await main(notify(orderId, 129));
    assert.strictEqual((await payment.fetchEntitlement()).singles, 1);
  });
});

test('client: cancel, server errors, charge and invite go through the cloud function', async () => {
  const { main, fake } = setup();
  const payment = require('../utils/payment');
  await withCloudClient(fake, main, async (rp) => {
    rp.handler = () => Promise.reject({ errMsg: 'requestPayment:fail cancel' });
    assert.deepStrictEqual(await payment.pay({ kind: 'single', title: 't', priceText: 'p' }), { ok: false });

    await assert.rejects(payment.pay({ kind: 'plan', planId: 'bogus', title: 't', priceText: 'p' }), (e) => e.code === 'bad_request');

    const c1 = await payment.charge('s:1', 'polaroid'); assert.strictEqual(c1.ok, true); assert.strictEqual(c1.state.freeUsed, 1);
    const other = await payment.charge('s:2', 'magazine'); assert.strictEqual(other.ok, false, 'free quota is for polaroid only');
    for (let i = 3; i <= 11; i += 1) await payment.charge(`s:${i}`, 'polaroid');
    const c12 = await payment.charge('s:12', 'polaroid'); assert.strictEqual(c12.ok, false); assert.strictEqual(c12.state.freeUsed, 10);

    assert.deepStrictEqual((await payment.redeemInvite('bad')).valid, false);
    const good = await payment.redeemInvite('geo0930');
    assert.strictEqual(good.valid, true); assert.strictEqual(good.state.invite, true);
    assert.strictEqual((await payment.charge('s:99', 'magazine')).ok, true, 'invite members can always save');
  });
});
