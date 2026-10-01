// 首页流程：在 Node 中运行真实页面脚本（wx 为替身，见 helpers/page-env.js）
const test = require('node:test');
const assert = require('node:assert');
const config = require('../utils/config');
const exifParser = require('../utils/exif-parser');
const mapService = require('../utils/map-service');
const membership = require('../utils/membership');
const platform = require('../utils/platform');
const { createHandler } = require('../cloudfunctions/api/handler');
const { createFakeCloud } = require('./helpers/fake-cloud');
const { createFakeXpay, VIRTUAL_ENV } = require('./helpers/fake-xpay');
const { createWx, createPage, createCanvasNode, tap, sleep, violations } = require('./helpers/page-env');

const EXIF = {
  'b.jpg': { hasGps: false, dateText: 'APR 02, 2025', dateValue: '2025-04-02' },
  'k.jpg': { hasGps: true, latitude: 35.0116, longitude: 135.7681, dateText: 'SEP 21, 2023', dateValue: '2023-09-21' }
};
const ZERMATT = { hasGps: true, latitude: 46.0207, longitude: 7.7491, dateText: 'JUN 16, 2024', dateValue: '2024-06-16' };
exifParser.extractFromFile = async (file) => EXIF[file] || ZERMATT;
mapService.reverseGeocode = async (lat) => {
  const city = lat > 40 ? 'Zermatt' : 'Kyoto';
  return { name: city, parts: { city } };
};

const ORIGINAL = JSON.parse(JSON.stringify({ payment: config.payment, membership: config.membership }));
test.beforeEach(() => {
  Object.assign(config.payment, JSON.parse(JSON.stringify(ORIGINAL.payment)), { mode: 'mock', purchaseEnabled: true });
  Object.assign(config.membership, JSON.parse(JSON.stringify(ORIGINAL.membership)));
  mapService.hasToken = () => false;
});
test.afterEach(() => {
  assert.deepStrictEqual(violations.splice(0), [], 'showModal 按钮文字不能超过 4 个字符');
});

const MONTH = () => membership.monthKey(Date.now());
const inDays = (n) => Date.now() + n * 86400000;
// 本月免费额度已用完的免费用户；月度会员（已用 used 张）
const freeOut = () => ({ invite: false, bought: false, freeMonth: MONTH(), freeUsed: 10, packs: [] });
const monthMember = (used = 0) => ({ bought: true, packs: [{ planId: 'month', quota: 120, used, until: inDays(30) }] });
const BATCH_NOTICE = '批量导入与批量下载只对月度、年度、买断会员和邀请码开放，单张解锁不含批量。';

// cloud 模式：页面 + payment.js + 云函数（内存数据库）。offlineAfter 次扣额度之后模拟断网
// virtual 为 true 时走虚拟支付（wx.requestVirtualPayment），否则走云支付
function cloudSetup(overrides, virtual) {
  config.payment.mode = 'cloud';
  config.payment.confirm = { tries: 2, delayMs: 0 };
  const fake = createFakeCloud();
  const xp = createFakeXpay();
  const main = virtual
    ? createHandler({ cloud: fake.cloud, env: VIRTUAL_ENV, http: xp.http })
    : createHandler({ cloud: fake.cloud, env: { PAY_CHANNEL: 'jsapi', SUB_MCH_ID: '1', INVITE_CODES: 'geo0930' } });
  const env = { fake, xp, main, actions: [], pay: 'notify', offlineAfter: Infinity };
  let consumed = 0;
  env.wx = createWx(
    Object.assign(
      {
        cloud: {
          callFunction: async ({ data }) => {
            env.actions.push(data.action);
            if (data.action === 'consume' && consumed++ >= env.offlineAfter) {
              throw { errMsg: 'cloud.callFunction:fail request:fail' };
            }
            return { result: await main(data) };
          }
        },
        login: (o) => o.success({ code: 'code-a' }),
        getAppBaseInfo: () => ({ version: '8.0.68' }),
        requestVirtualPayment(o) {
          if (env.pay === 'cancel') return o.fail({ errMsg: 'requestVirtualPayment:fail cancel' });
          const d = JSON.parse(o.signData);
          if (env.pay !== 'notify') return o.success({});
          xp.pay(d.outTradeNo, d.goodsPrice);
          return main({ Event: 'xpay_goods_deliver_notify', OpenId: 'openid-a', OutTradeNo: d.outTradeNo, Env: 0 }).then(() => o.success({}));
        },
        requestPayment(o) {
          if (env.pay === 'cancel') return o.fail({ errMsg: 'requestPayment:fail cancel' });
          const id = o.package.replace('prepay_id=', '');
          const fee = fake.dump().orders[id].totalFee;
          if (env.pay === 'notify') fake.ledger[id] = fee;
          const notified =
            env.pay === 'notify'
              ? main({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: id, totalFee: fee, transactionId: `wx-${id}` })
              : Promise.resolve();
          return notified.then(() => o.success({}));
        }
      },
      overrides
    )
  );
  env.count = (action) => env.actions.filter((a) => a === action).length;
  return env;
}

test('预览：首屏放得下带底栏的整张海报，底栏开关只改高度并记住偏好', () => {
  const wx = createWx();
  const page = createPage(wx);
  page.onLoad();
  assert.strictEqual(page.cssSize.w, 284);
  assert.strictEqual(page.data.exportSize, '1200 × 1792');
  page.preview = { width: 0, height: 0 };
  page.onToggleFooter({ detail: { value: false } });
  assert.strictEqual(page.cssSize.w, 284);
  assert.strictEqual(page.data.exportSize, '1200 × 1600');
  assert.strictEqual(page.preview.height, Math.round(page.cssSize.h * page.dpr));
  assert.strictEqual(page.data.canvasStyle, `width:${page.cssSize.w}px;height:${page.cssSize.h}px;`);
  assert.strictEqual(wx.store['geopics.footer'], false);
  const again = createPage(wx);
  again.onLoad();
  assert.strictEqual(again.data.footerOn, false);

  const se = createPage(createWx({ getWindowInfo: () => ({ windowWidth: 375, windowHeight: 603, screenHeight: 667, safeArea: { bottom: 667 }, pixelRatio: 2 }) }));
  se.onLoad();
  assert.strictEqual(se.cssSize.w, 226);
});

test('免费版：只有拍立得每月 10 张免费，其余模板带水印且不能下载', async () => {
  const wx = createWx();
  wx.files = ['a.jpg', 'k.jpg', 'x.jpg'];
  const page = createPage(wx);
  page.onLoad();
  assert.strictEqual(page.data.memberChip, '免费 · 10 张');
  assert.strictEqual(page.data.batchOk, false);
  await page.onChoosePhoto();
  assert.deepStrictEqual(wx.calls.chooseCounts, [1], '非会员一次只能选 1 张');
  assert.strictEqual(page.data.itemCount, 1);

  // 拍立得：无水印，提示剩余免费张数
  assert.strictEqual(page.poster.templateId, 'polaroid');
  assert.strictEqual(page.data.currentLocked, false);
  assert.strictEqual(page.buildStyle(page.poster).watermark, false);
  assert.strictEqual(page.data.stageNote, '拍立得本月免费剩余 10 张，每保存一张消耗 1 张');

  // 其余模板：带水印、不能下载
  page.onTapTemplate(tap({ id: 'arch' }));
  assert.strictEqual(page.data.currentLocked, true);
  assert.strictEqual(page.buildStyle(page.poster).watermark, true);
  assert.strictEqual(page.data.stageNote, '「拱窗」模板预览带水印、不能下载；拍立得本月还可免费保存 10 张');
  await page.onSavePoster();
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(
    page.data.paywallNotice,
    '该模板预览带水印、不能下载，付费后才可保存。拍立得模板本月还可免费保存 10 张。开通会员即可继续下载。'
  );
  assert.strictEqual(wx.calls.save.length, 0);
  page.onPaywallClose();

  // 回到拍立得保存：消耗 1 张，同一张照片再次保存不重复计费
  page.onTapTemplate(tap({ id: 'polaroid' }));
  await page.onSavePoster();
  await page.onSavePoster();
  assert.deepStrictEqual(wx.calls.save, [`poster-${page.poster.id}.jpg`, `poster-${page.poster.id}.jpg`]);
  assert.strictEqual(page.member.freeUsed, 1);
  assert.strictEqual(wx.store['geopics.membership'].freeUsed, 1);
  assert.strictEqual(wx.store['geopics.membership'].freeMonth, MONTH());
  assert.strictEqual(page.data.memberChip, '免费 · 9 张');

  // 换模板要重新计费：拍立得保存过不代表其他模板也解锁
  page.onTapTemplate(tap({ id: 'arch' }));
  assert.strictEqual(page.data.currentLocked, true);
  page.onTapTemplate(tap({ id: 'polaroid' }));
  assert.strictEqual(page.data.currentLocked, false);

  // 用完后拍立得也带水印，提示下月重置；到了新的一月自动恢复
  page.member = Object.assign(membership.normalize(freeOut()));
  page.onTapTemplate(tap({ id: 'mat' }));
  page.onTapTemplate(tap({ id: 'polaroid' }));
  page.items[0].unlocked = {};
  page.refreshEntitlement();
  assert.strictEqual(page.data.currentLocked, true);
  assert.strictEqual(page.data.stageNote, '本月拍立得免费额度已用完，预览带水印');
  assert.strictEqual(page.data.memberChip, '开通会员');
  await page.onSavePoster();
  assert.strictEqual(page.data.paywallNotice, '本月 10 张拍立得免费额度已用完，下月 1 日重置。开通会员即可继续下载。');
  page.onPaywallClose();
  page.member.freeMonth = '2020-01';
  page.refreshEntitlement();
  assert.strictEqual(page.data.currentLocked, false);
  assert.strictEqual(page.data.memberChip, '免费 · 10 张');
});

test('本地模式购买：单张可用于任意模板，会员额度叠加，买断只能买一次，购买后继续刚才的保存', async () => {
  const wx = createWx();
  wx.files = ['a.jpg', 'k.jpg', 'x.jpg'];
  wx.store['geopics.membership'] = freeOut();
  const page = createPage(wx);
  page.onLoad();
  await page.onChoosePhoto();
  assert.ok(page.data.currentLocked);
  assert.deepStrictEqual(page.data.plans.map((x) => [x.kind, x.id]), [['plan', 'month'], ['plan', 'year'], ['lifetime', 'lifetime']]);

  // 取消模拟支付：什么都不发生
  await page.onSavePoster();
  assert.ok(page.data.paywallVisible);
  wx.modalConfirm = false;
  await page.onBuy(tap({ kind: 'single' }));
  assert.strictEqual(page.member.singles, 0);
  assert.ok(page.data.paywallVisible);
  wx.modalConfirm = true;

  // 单张解锁后自动继续保存，用掉这一张额度；不含批量
  await page.onBuy(tap({ kind: 'single' }));
  await sleep(450);
  assert.ok(!page.data.paywallVisible);
  assert.deepStrictEqual(wx.calls.save, [`poster-${page.poster.id}.jpg`]);
  assert.strictEqual(page.member.singles, 0);
  assert.strictEqual(page.data.batchOk, false);
  assert.strictEqual(page.data.currentLocked, false, '已保存的这张在该模板下保持解锁');
  page.onTapTemplate(tap({ id: 'arch' }));
  assert.strictEqual(page.data.currentLocked, true);

  // 月度会员：叠加额度、开放批量
  await page.onOpenPaywall();
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  await sleep(450);
  assert.strictEqual(page.data.batchOk, true);
  assert.strictEqual(page.data.memberChip, '会员 · 120 张');
  assert.strictEqual(page.data.currentLocked, false, '会员额度适用于所有模板');
  await page.onSavePoster();
  assert.strictEqual(wx.calls.save.length, 2);
  assert.strictEqual(page.data.memberChip, '会员 · 119 张');

  // 买断：只能买一次，买过后不再出现在档位里
  await page.onOpenPaywall();
  await page.onBuy(tap({ kind: 'lifetime', id: 'lifetime' }));
  await sleep(450);
  assert.strictEqual(page.member.lifetime.quota, 120);
  assert.strictEqual(page.member.lifetime.month, MONTH());
  assert.strictEqual(page.data.plans.length, 2);
  assert.ok(page.data.packLines.some((l) => l.startsWith('买断会员 本月剩余')));
  const before = JSON.stringify(page.member.lifetime);
  await page.onBuy(tap({ kind: 'lifetime', id: 'lifetime' }));
  assert.strictEqual(JSON.stringify(page.member.lifetime), before);
  assert.ok(wx.store['geopics.membership'].lifetime, '买断记录写入缓存');
});

test('批量：导入与下载只对月度、年度、买断和邀请码开放，只买单张不含批量', async () => {
  const wx = createWx();
  wx.files = ['a.jpg', 'b.jpg', 'k.jpg'];
  wx.store['geopics.membership'] = freeOut();
  const page = createPage(wx);
  page.onLoad();
  await page.onChoosePhoto();
  assert.deepStrictEqual(wx.calls.chooseCounts, [1]);
  assert.strictEqual(page.data.itemCount, 1);

  // “+”：只能重新选择；批量导入入口说明这是会员功能
  wx.sheetTap = 1;
  await page.onTapAddTile();
  assert.deepStrictEqual(wx.calls.sheet.pop(), ['重新选择照片', '批量导入（会员功能）']);
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(page.data.paywallNotice, BATCH_NOTICE);
  assert.strictEqual(wx.calls.chooseMedia, 1);

  // 只买单张不含批量：买完没有继续导入，面板关闭
  await page.onBuy(tap({ kind: 'single' }));
  await sleep(450);
  assert.strictEqual(page.member.singles, 1);
  assert.strictEqual(page.data.batchOk, false);
  assert.strictEqual(wx.calls.chooseMedia, 1, '单张解锁不会打开批量选图');
  assert.strictEqual(page.data.itemCount, 1);

  // 直接走“继续添加”也会被拦下
  await page.onAddPhotos();
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(wx.calls.chooseMedia, 1);

  // 购买月度会员后继续刚才的批量导入：还能再选 8 张
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  await sleep(450);
  assert.strictEqual(page.data.batchOk, true);
  assert.strictEqual(wx.calls.chooseMedia, 2);
  assert.strictEqual(wx.calls.chooseCounts[1], 8);
  assert.strictEqual(page.data.itemCount, 4);

  // 会员在使用期间到期：已导入的照片保留，但批量下载被拦下，单张下载不受影响
  page.member = membership.normalize(freeOut());
  page.member.singles = 0;
  page.refreshEntitlement();
  assert.strictEqual(page.data.batchOk, false);
  wx.calls.save.length = 0;
  await page.onSaveBatch();
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(page.data.paywallNotice, BATCH_NOTICE);
  assert.strictEqual(wx.calls.save.length, 0);
  page.onPaywallClose();
  page.member = membership.normalize({ packs: [{ planId: 'month', quota: 120, used: 0, until: Date.now() - 1000 }] });
  assert.strictEqual(membership.batchAllowed(page.member), false, '过期的额度包不算会员');
  page.member = membership.normalize(monthMember());
  page.refreshEntitlement();
  await page.onSaveBatch();
  assert.strictEqual(wx.calls.save.length, 4);
});

test('批量：邀请码与买断会员开放批量，随机模板可抽到付费模板', async () => {
  for (const state of [{ invite: true }, { bought: true, lifetime: { planId: 'lifetime', quota: 120, month: MONTH(), used: 0 } }]) {
    const wx = createWx();
    wx.files = ['a.jpg', 'b.jpg', 'k.jpg'];
    wx.store['geopics.membership'] = state;
    const page = createPage(wx);
    page.onLoad();
    assert.strictEqual(page.data.batchOk, true);
    await page.onChoosePhoto();
    assert.deepStrictEqual(wx.calls.chooseCounts, [9]);
    assert.strictEqual(page.data.itemCount, 3);
    await page.onSaveAll();
    assert.strictEqual(wx.calls.save.length, 3);
  }
});

test('买断：月度额度用完后拦下并提示下月重置，新的一月自动恢复', async () => {
  const wx = createWx();
  wx.files = ['a.jpg'];
  wx.store['geopics.membership'] = { bought: true, freeMonth: MONTH(), freeUsed: 10, lifetime: { planId: 'lifetime', quota: 120, month: MONTH(), used: 120 } };
  const page = createPage(wx);
  page.onLoad();
  await page.onChoosePhoto();
  assert.strictEqual(page.data.memberChip, '会员 · 已用完');
  assert.strictEqual(page.data.memberLabel, '会员 · 本月额度已用完');
  assert.strictEqual(page.data.batchOk, true, '买断会员始终可批量导入');
  assert.strictEqual(page.data.currentLocked, true);
  assert.strictEqual(page.data.stageNote, '额度已用完，预览带水印');
  await page.onSavePoster();
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(page.data.paywallNotice, '本月额度已用完，下月 1 日重置。购买额外的月度或年度会员即可继续下载。');
  page.onPaywallClose();

  page.member.lifetime.month = '2020-01';
  page.refreshEntitlement();
  assert.strictEqual(page.data.currentLocked, false);
  assert.strictEqual(page.data.memberChip, '会员 · 120 张');
});

test('部分下载：会员额度不足时询问，只下载额度内的照片', async () => {
  const wx = createWx();
  wx.files = ['a.jpg', 'k.jpg', 'x.jpg'];
  wx.store['geopics.membership'] = Object.assign(monthMember(119), { freeMonth: MONTH(), freeUsed: 10 });
  const page = createPage(wx);
  page.onLoad();
  await page.onChoosePhoto();
  wx.modalConfirm = false;
  await page.onSaveAll();
  const short = wx.calls.modal.pop();
  assert.strictEqual(short.title, '会员额度不足');
  assert.ok(short.content.startsWith('本次需下载 3 张，剩余额度只够 1 张。'));
  assert.ok(short.content.endsWith('是否仅下载可下载的 1 张？'));
  assert.deepStrictEqual([short.confirmText, short.cancelText], ['仅下载', '购买会员']);
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(wx.calls.save.length, 0);
  page.onPaywallClose();

  wx.modalConfirm = true;
  await page.onSaveAll();
  assert.strictEqual(wx.calls.save.length, 1);
  assert.strictEqual(page.member.packs[0].used, 120);
  assert.strictEqual(page.data.memberChip, '续购会员');

  // 额度和有效期都用完：直接提示，购买额外会员后继续
  page.items.forEach((it) => { it.unlocked = {}; });
  page.refreshEntitlement();
  wx.calls.save.length = 0;
  await page.onSavePoster();
  assert.ok(page.data.paywallNotice.includes('购买额外的月度或年度会员'));
  await page.onBuy(tap({ kind: 'plan', id: 'year' }));
  await sleep(450);
  assert.strictEqual(page.member.packs.length, 2);
  assert.strictEqual(page.data.memberLabel, '会员 · 剩余 1999 张');
  assert.strictEqual(wx.calls.save.length, 1, '购买后继续保存');
});

test('本地模式邀请码：忽略大小写与空格，错误时提示', async () => {
  config.membership.inviteCodes = ['geo0930'];
  const wx = createWx();
  wx.store['geopics.membership'] = freeOut();
  const page = createPage(wx);
  page.onLoad();
  await page.onOpenPaywall();
  await page.onRedeemInvite();
  assert.strictEqual(page.data.inviteError, '请输入邀请码');
  page.onInviteInput({ detail: { value: 'nope' } });
  await page.onRedeemInvite();
  assert.strictEqual(page.data.inviteError, '邀请码无效');
  page.onInviteInput({ detail: { value: '  GEO0930 ' } });
  await page.onRedeemInvite();
  assert.strictEqual(page.data.memberLabel, '会员 · 邀请码');
  assert.ok(!page.data.paywallVisible);
  assert.strictEqual(wx.store['geopics.membership'].invite, true);
});

test('cloud：导出前由服务端扣额度，本地篡改会被纠正，支付以服务端确认为准', async () => {
  const env = cloudSetup();
  env.wx.files = ['a.jpg', 'k.jpg', 'x.jpg', 'y.jpg'];
  const page = createPage(env.wx);
  page.onLoad();
  await page.onShow();
  assert.strictEqual(page.data.memberChip, '免费 · 10 张');
  await page.onChoosePhoto();
  assert.strictEqual(page.data.itemCount, 1, '非会员一次一张');
  await page.onSavePoster();
  await page.onSavePoster();
  assert.strictEqual(env.wx.calls.save.length, 2);
  assert.strictEqual(env.fake.dump().users['openid-a'].freeUsed, 1, '同一张同一模板不重复扣');
  assert.strictEqual(page.data.memberChip, '免费 · 9 张');

  // 本地被改成“有单张额度”：非免费模板保存时服务端拒绝，不出图并打开付费面板，以服务端快照为准
  page.onTapTemplate(tap({ id: 'arch' }));
  assert.ok(page.data.currentLocked);
  page.member = membership.normalize({ singles: 5 });
  page.refreshEntitlement();
  assert.ok(!page.data.currentLocked);
  env.wx.calls.save.length = 0;
  await page.onSavePoster();
  assert.strictEqual(env.wx.calls.save.length, 0);
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(page.data.paywallNotice, '额度不足，购买会员后即可继续下载。');
  assert.strictEqual(page.member.singles, 0);
  assert.strictEqual(page.member.freeUsed, 1, '以服务端快照为准');
  assert.ok(page.data.currentLocked);

  env.pay = 'cancel';
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  assert.strictEqual(page.member.packs.length, 0);

  env.pay = 'notify';
  env.wx.calls.save.length = 0;
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  await sleep(450);
  assert.ok(!page.data.paywallVisible);
  assert.strictEqual(page.member.packs[0].quota, 120);
  assert.strictEqual(env.wx.calls.save.length, 1, '购买后继续保存');
  assert.strictEqual(env.fake.dump().users['openid-a'].packs[0].used, 1);
  assert.strictEqual(page.data.batchOk, true);

  // 回调迟迟未到：不在本地发放，提示确认中；之后回到页面立即同步
  env.pay = 'none';
  const before = page.member.singles;
  await page.onOpenPaywall();
  await page.onBuy(tap({ kind: 'single' }));
  assert.ok(env.wx.calls.toast.includes('支付结果确认中，稍后自动到账'));
  assert.strictEqual(page.member.singles, before);
  const pending = Object.values(env.fake.dump().orders).find((o) => o.status === 'pending' && o.kind === 'single');
  env.fake.ledger[pending._id] = 129;
  await env.main({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: pending._id, totalFee: 129, transactionId: 'wx-late' });
  await page.onShow();
  assert.strictEqual(page.member.singles, before + 1);
  clearTimeout(page._syncTimer);

  await page.onOpenPaywall();
  page.onInviteInput({ detail: { value: ' GEO0930' } });
  await page.onRedeemInvite();
  assert.strictEqual(env.fake.dump().users['openid-a'].invite, true);
});

test('iOS：虚拟支付通道下可以购买，Apple 支付完成后由服务端确认入账', async () => {
  const env = cloudSetup({ getDeviceInfo: () => ({ platform: 'ios' }) }, true);
  env.wx.files = ['a.jpg', 'k.jpg'];
  const page = createPage(env.wx);
  page.onLoad();
  await page.onShow();
  assert.strictEqual(page.data.canPurchase, true);
  assert.deepStrictEqual(page.data.plans.map((x) => x.kind), ['plan', 'plan', 'lifetime']);

  env.pay = 'cancel';
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  assert.strictEqual(page.member.packs.length, 0);
  assert.ok(!env.wx.calls.toast.includes('支付失败，请重试'));

  env.pay = 'notify';
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  await sleep(450);
  assert.strictEqual(page.member.packs[0].quota, 120);
  assert.strictEqual(page.data.memberChip, '会员 · 120 张');
  const paid = Object.values(env.fake.dump().orders).filter((o) => o.status === 'paid');
  assert.deepStrictEqual(paid.map((o) => [o.channel, o.productId]), [['virtual', 'geopics_month']]);

  // 苹果 / 微信侧确认稍慢：提示确认中，之后回到小程序由服务端查单补发
  env.pay = 'none';
  await page.onBuy(tap({ kind: 'lifetime', id: 'lifetime' }));
  assert.ok(env.wx.calls.toast.includes('支付结果确认中，稍后自动到账'));
  assert.ok(!page.member.lifetime);
  clearTimeout(page._syncTimer);
  const pending = Object.values(env.fake.dump().orders).find((o) => o.status === 'pending' && o.kind === 'lifetime');
  env.xp.pay(pending._id, 29900);
  await page.onShow();
  assert.strictEqual(page.member.lifetime.planId, 'lifetime');
  clearTimeout(page._syncTimer);
});

test('iOS：旧版微信会提示升级，不发起支付', async () => {
  const env = cloudSetup({ getDeviceInfo: () => ({ platform: 'ios' }), getAppBaseInfo: () => ({ version: '8.0.50' }) }, true);
  env.wx.files = ['a.jpg'];
  const page = createPage(env.wx);
  page.onLoad();
  await page.onShow();
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  assert.ok(env.wx.calls.modal.some((m) => m.title === '需要更新微信'));
  assert.strictEqual(page.member.packs.length, 0);
});

test('cloud：买断由服务端入账，重复购买被拒绝并同步已有权益', async () => {
  const env = cloudSetup();
  const page = createPage(env.wx);
  page.onLoad();
  await page.onShow();
  assert.deepStrictEqual(page.data.plans.map((x) => x.kind), ['plan', 'plan', 'lifetime']);
  await page.onBuy(tap({ kind: 'lifetime', id: 'lifetime' }));
  await sleep(450);
  assert.deepStrictEqual(env.fake.dump().users['openid-a'].lifetime.quota, 120);
  assert.strictEqual(page.member.lifetime.planId, 'lifetime');
  assert.strictEqual(page.data.batchOk, true);
  assert.deepStrictEqual(page.data.plans.map((x) => x.kind), ['plan', 'plan']);
  assert.strictEqual(page.data.memberChip, '会员 · 120 张');

  // 另一台设备上已买过、本机缓存还不知道：服务端拒绝，页面提示并同步
  page.member = membership.normalize({});
  page.refreshEntitlement();
  assert.strictEqual(page.data.plans.length, 3);
  await page.onBuy(tap({ kind: 'lifetime', id: 'lifetime' }));
  await sleep(0);
  assert.ok(env.wx.calls.toast.includes('已拥有买断会员'));
  assert.strictEqual(Object.values(env.fake.dump().orders).filter((o) => o.kind === 'lifetime').length, 1, '没有再下单');
  assert.ok(page.member.lifetime, '已同步到云端的买断记录');
  assert.strictEqual(page.data.plans.length, 2);
});

test('cloud：回到页面时同步权益有最短间隔', async () => {
  const env = cloudSetup();
  const page = createPage(env.wx);
  page.onLoad();
  await page.onShow();
  await page.onShow();
  assert.strictEqual(env.count('getEntitlement'), 1);
  page._syncedAt -= 31 * 1000;
  await page.onShow();
  assert.strictEqual(env.count('getEntitlement'), 2);
  await page.syncMember(true);
  assert.strictEqual(env.count('getEntitlement'), 3);
});

test('cloud：扣额度时网络异常立即停止批量，并提示已保存张数', async () => {
  const env = cloudSetup();
  env.offlineAfter = 1;
  env.wx.files = ['a.jpg', 'k.jpg'];
  env.wx.store['geopics.membership'] = { invite: true };
  const page = createPage(env.wx);
  page.onLoad();
  await page.onChoosePhoto();
  await page.onSaveAll();
  assert.strictEqual(env.wx.calls.save.length, 1);
  assert.strictEqual(env.count('consume'), 2);
  const modal = env.wx.calls.modal.pop();
  assert.strictEqual(modal.title, '网络异常');
  assert.ok(modal.content.startsWith('已保存 1 张。'));
  assert.ok(!page.data.busy);
  assert.deepStrictEqual(env.wx.calls.keepScreenOn, [true, false]);
});

test('iOS：关闭购买入口（iosPurchase=false）时不展示价格，文案不含购买引导，邀请码照常可用', async () => {
  config.payment.iosPurchase = false;
  config.membership.inviteCodes = ['geo0930'];
  const wx = createWx({ getDeviceInfo: () => ({ platform: 'ios' }) });
  wx.store['geopics.membership'] = Object.assign(freeOut(), { freeUsed: 1 });
  wx.files = ['a.jpg', 'k.jpg', 'x.jpg'];
  const page = createPage(wx);
  page.onLoad();
  assert.strictEqual(page.data.canPurchase, false);
  assert.strictEqual(page.data.memberChip, '免费 · 9 张');
  assert.strictEqual(page.data.memberLabel, '拍立得本月免费剩余 9 张');
  await page.onChoosePhoto();
  assert.strictEqual(page.data.itemCount, 1);
  page.onTapTemplate(tap({ id: 'arch' }));
  assert.ok(!/开通|购买|¥/.test(page.data.stageNote), page.data.stageNote);

  // 非免费模板：提示不带购买引导，面板里没有价格与购买入口
  await page.onSavePoster();
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(page.data.paywallNotice, '该模板预览带水印、不能下载，付费后才可保存。拍立得模板本月还可免费保存 9 张。');
  assert.ok(!/开通|购买|¥/.test(page.data.paywallNotice));
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  await page.onBuy(tap({ kind: 'lifetime', id: 'lifetime' }));
  await page.onBuy(tap({ kind: 'single' }));
  assert.ok(!wx.calls.modal.some((m) => m.title === '测试支付'));
  assert.strictEqual(page.member.packs.length, 0);
  assert.ok(!page.member.lifetime && page.member.singles === 0);
  page.onPaywallClose();

  // 批量入口同样只说明是会员功能
  wx.sheetTap = 1;
  await page.onTapAddTile();
  assert.strictEqual(page.data.paywallNotice, '批量导入与批量下载仅对会员开放，已有会员权益或邀请码的用户可以使用。');
  assert.ok(!/开通|购买|¥|买断|月度|年度/.test(page.data.paywallNotice));
  page.onPaywallClose();

  // 免费额度用完：拍立得也被拦下
  page.onTapTemplate(tap({ id: 'polaroid' }));
  page.member = membership.normalize(freeOut());
  page.refreshEntitlement();
  assert.strictEqual(page.data.memberChip, '额度已用完');
  assert.strictEqual(page.data.memberLabel, '本月免费额度已用完');
  await page.onSavePoster();
  assert.strictEqual(page.data.paywallNotice, '本月 10 张拍立得免费额度已用完，下月 1 日重置。');

  // 兑换邀请码后继续保存
  page.onInviteInput({ detail: { value: 'geo0930' } });
  await page.onRedeemInvite();
  await sleep(450);
  assert.strictEqual(page.data.memberChip, '会员');
  assert.strictEqual(wx.calls.save.length, 1, '兑换后继续保存');

  // 已有会员额度（例如在安卓上购买的）：部分下载的询问不带购买引导
  page.member = membership.normalize(Object.assign(monthMember(119), { freeMonth: MONTH(), freeUsed: 10 }));
  page.items.forEach((it) => { it.unlocked = {}; });
  page.refreshEntitlement();
  await page.onChoosePhoto();
  assert.strictEqual(page.data.itemCount, 3);
  wx.modalConfirm = false;
  await page.onSaveAll();
  const ask = wx.calls.modal.pop();
  assert.deepStrictEqual([ask.confirmText, ask.cancelText], ['仅下载', '取消']);
  assert.ok(!/开通|购买/.test(ask.content));
  assert.ok(!page.data.paywallVisible, 'iOS 上取消后不弹付费面板');

  page.member = membership.normalize(monthMember(120));
  page.refreshEntitlement();
  assert.strictEqual(page.data.memberChip, '额度已用完');
  assert.strictEqual(page.data.memberLabel, '额度已用完');
});

test('购买总开关关闭（上线前默认）：所有平台只有免费额度与邀请码，没有价格与购买入口', async () => {
  assert.strictEqual(ORIGINAL.payment.purchaseEnabled, false, '提交的配置默认不开放购买');
  config.payment.purchaseEnabled = false;
  config.membership.inviteCodes = ['geo0930'];
  for (const name of ['android', 'ios', 'devtools']) {
    const wx = createWx({ getDeviceInfo: () => ({ platform: name }) });
    wx.store['geopics.membership'] = freeOut();
    const page = createPage(wx);
    page.onLoad();
    assert.strictEqual(page.data.canPurchase, false, name);
    assert.strictEqual(page.data.purchaseNote, '会员购买暂未开放，目前可使用每月免费额度和邀请码', name);
    assert.ok(!/开通|购买|¥/.test(page.data.memberLabel + page.data.memberChip + page.data.stageNote), name);
    await page.onBuy(tap({ kind: 'plan', id: 'month' }));
    await page.onBuy(tap({ kind: 'single' }));
    assert.ok(!wx.calls.modal.some((m) => m.title === '测试支付'), name);
    assert.strictEqual(page.member.packs.length, 0);
    page.onTapTemplate(tap({ id: 'arch' }));
    await page.onOpenPaywall();
    assert.ok(page.data.paywallVisible);
    assert.ok(!/开通|购买|¥/.test(page.data.paywallNotice), page.data.paywallNotice);
  }
  global.wx = createWx({ getDeviceInfo: () => ({ platform: 'android' }) });
  assert.strictEqual(platform.purchaseNote(), '会员购买暂未开放，目前可使用每月免费额度和邀请码');
  config.payment.purchaseEnabled = true;
  assert.strictEqual(platform.purchaseNote(), '');
  config.payment.iosPurchase = false;
  global.wx = createWx({ getDeviceInfo: () => ({ platform: 'ios' }) });
  assert.strictEqual(platform.purchaseNote(), '由于相关规范，iOS 暂不支持在小程序内购买');
});

test('平台判断：iOS 购买入口由 iosPurchase 控制；接口异常时按普通环境处理', () => {
  const run = (wx) => {
    global.wx = wx;
    return platform.canPurchase();
  };
  assert.strictEqual(config.payment.iosPurchase, true, 'iOS purchases are on by default with virtual payment');
  assert.strictEqual(run(createWx({ getDeviceInfo: () => ({ platform: 'ios' }) })), true);
  config.payment.iosPurchase = false;
  assert.strictEqual(run(createWx({ getDeviceInfo: () => ({ platform: 'ios' }) })), false);
  for (const name of ['android', 'devtools', 'windows', 'mac', 'ohos']) {
    assert.strictEqual(run(createWx({ getDeviceInfo: () => ({ platform: name }) })), true, name);
  }
  assert.strictEqual(run(createWx({ getDeviceInfo: undefined, getSystemInfoSync: () => ({ platform: 'ios' }) })), false);
  assert.strictEqual(run(createWx({ getDeviceInfo: () => { throw new Error('x'); } })), true);
  config.payment.iosPurchase = true;
  assert.strictEqual(run(createWx({ getDeviceInfo: () => ({ platform: 'ios' }) })), true);

  global.wx = createWx({ getEnterOptionsSync: undefined, getLaunchOptionsSync: () => ({ scene: 1154 }) });
  assert.strictEqual(platform.isSinglePageMode(), true);
  global.wx = createWx({ getEnterOptionsSync: () => { throw new Error('x'); } });
  assert.strictEqual(platform.isSinglePageMode(), false);
  global.wx = createWx({ getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) });
  assert.strictEqual(platform.isDevBuild(), true);
  global.wx = createWx({ getAccountInfoSync: undefined });
  assert.strictEqual(platform.envVersion(), 'release');
});

test('朋友圈单页模式：只展示示例，不选图、不调用云开发', async () => {
  const env = cloudSetup({ getEnterOptionsSync: () => ({ scene: 1154 }) });
  const page = createPage(env.wx);
  page.onLoad();
  await page.onShow();
  assert.ok(page.data.singlePage);
  assert.deepStrictEqual(env.actions, []);
  await page.onTapPreview();
  await page.onChoosePhoto();
  assert.strictEqual(env.wx.calls.chooseMedia, 0);
  assert.deepStrictEqual(env.wx.calls.toast, ['请点击下方「前往小程序」后使用', '请点击下方「前往小程序」后使用']);
});

test('转发：标题带地名，卡片图把整张预览居中放进 5:4，失败或导出中时退回默认内容', async () => {
  const wx = createWx();
  const exportCanvas = createCanvasNode({ w: 852, h: 1272 });
  wx.nodes['#exportCanvas'] = exportCanvas;
  const page = createPage(wx);
  page.onLoad();
  page.preview = { width: 852, height: 1272 };

  const empty = page.onShareAppMessage();
  assert.strictEqual(empty.title, 'GEOPICS · 把照片与它发生的地方，做成一张海报');
  assert.strictEqual(empty.path, '/pages/index/index');
  const card = await empty.promise;
  assert.strictEqual(card.imageUrl, 'snap-2.jpg');
  assert.strictEqual(wx.calls.snapshot[0].canvas, page.preview);
  assert.strictEqual(wx.calls.snapshot[0].destWidth, 852);
  assert.deepStrictEqual([exportCanvas.width, exportCanvas.height], [750, 600]);
  assert.deepStrictEqual([wx.calls.snapshot[1].destWidth, wx.calls.snapshot[1].destHeight], [750, 600]);
  const draw = exportCanvas.ops.find((op) => op[0] === 'drawImage');
  assert.deepStrictEqual(draw.slice(2), [204, 44, 343, 512]);

  await page.onChoosePhoto();
  assert.strictEqual(page.onShareAppMessage().title, '「ZERMATT」· 用 GEOPICS 做的地图海报');
  assert.deepStrictEqual(page.onShareTimeline(), { title: '「ZERMATT」· 用 GEOPICS 做的地图海报' });
  page.poster.place = 'UNKNOWN';
  assert.strictEqual(page.onShareTimeline().title, 'GEOPICS · 把照片与它发生的地方，做成一张海报');
  page.onPlaceInput({ detail: { value: 'MY TRIP' } });
  const manual = page.onShareAppMessage();
  assert.strictEqual(manual.title, '「MY TRIP」· 用 GEOPICS 做的地图海报', '手动输入的地名同样进标题');
  assert.strictEqual((await manual.promise).title, manual.title);
  assert.strictEqual(page.onShareTimeline().title, manual.title);
  page.onPlaceReset();
  await sleep(0);
  assert.strictEqual(page.onShareTimeline().title, '「ZERMATT」· 用 GEOPICS 做的地图海报');

  // 弹层打开时 canvas 被截图顶替：直接使用那张截图
  wx.calls.snapshot.length = 0;
  page.setData({ previewCovered: true, coverImage: 'cover.jpg' });
  assert.ok((await page.onShareAppMessage().promise).imageUrl);
  assert.strictEqual(wx.calls.snapshot.length, 1);
  assert.strictEqual(wx.calls.snapshot[0].canvas, exportCanvas);
  page.setData({ previewCovered: false, coverImage: '' });

  page.setData({ busy: true });
  assert.strictEqual((await page.onShareAppMessage().promise).imageUrl, undefined);
  page.setData({ busy: false });
  wx.canvasToTempFilePath = (o) => o.fail({ errMsg: 'canvasToTempFilePath:fail' });
  const fallback = await page.onShareAppMessage().promise;
  assert.strictEqual(fallback.imageUrl, undefined);
  assert.strictEqual(fallback.title, '「ZERMATT」· 用 GEOPICS 做的地图海报');
  assert.strictEqual(fallback.path, '/pages/index/index');
});

test('隐私：拒绝隐私保护指引与拒绝相册权限分别提示', async () => {
  const wx = createWx();
  const page = createPage(wx);
  page.onLoad();
  const deny = { errno: 104, errMsg: 'chooseMedia:fail privacy permission is not authorized' };
  wx.chooseMedia = (o) => o.fail(deny);
  await page.onChoosePhoto();
  wx.chooseMedia = (o) => o.fail({ errMsg: 'chooseMedia:fail cancel' });
  await page.onChoosePhoto();
  wx.chooseMedia = (o) => o.fail({ errMsg: 'chooseMedia:fail internal error' });
  await page.onChoosePhoto();
  assert.deepStrictEqual(wx.calls.toast, ['需同意隐私保护指引后才能选择照片', '选择照片失败，请重试']);

  wx.chooseMedia = (o) => o.success({ tempFiles: [{ tempFilePath: 'a.jpg' }, { tempFilePath: 'k.jpg' }] });
  await page.onChoosePhoto();
  let saves = 0;
  wx.saveImageToPhotosAlbum = (o) => {
    saves += 1;
    if (saves === 1) o.success({});
    else o.fail({ errno: 104, errMsg: 'saveImageToPhotosAlbum:fail privacy permission is not authorized' });
  };
  await page.onSaveAll();
  const privacy = wx.calls.modal.pop();
  assert.strictEqual(privacy.title, '无法保存到相册');
  assert.ok(privacy.content.startsWith('已保存 1 张。'));
  assert.strictEqual(wx.calls.openSetting, 0);
  assert.strictEqual(page.member.freeUsed, 1, '只为保存成功的照片扣额度');

  wx.saveImageToPhotosAlbum = (o) => o.fail({ errMsg: 'saveImageToPhotosAlbum:fail auth deny' });
  page.onTapItem(tap({ id: page.items[1].id }));
  await page.onSavePoster();
  assert.strictEqual(wx.calls.modal.pop().title, '需要相册权限');
  assert.strictEqual(wx.calls.openSetting, 1);

  wx.chooseLocation = (o) => o.fail({ errno: 104, errMsg: 'chooseLocation:fail privacy permission is not authorized' });
  await page.onPickLocation();
  assert.strictEqual(wx.calls.toast.pop(), '需同意隐私保护指引后才能地图选点');
});

test('导入与导出：显示逐张进度，批量导出期间保持屏幕常亮', async () => {
  mapService.hasToken = () => true;
  const wx = createWx();
  wx.files = ['a.jpg', 'b.jpg', 'k.jpg'];
  wx.store['geopics.membership'] = { invite: true, bought: false, freeUsed: 0, packs: [] };
  const page = createPage(wx);
  page.onLoad();
  const texts = [];
  const setData = page.setData;
  page.setData = function (patch, cb) {
    if (patch.busyText) texts.push(patch.busyText);
    return setData.call(this, patch, cb);
  };
  await page.onChoosePhoto();
  assert.deepStrictEqual(texts, ['读取照片 1/3…', '读取照片 2/3…', '读取照片 3/3…', '获取地名…']);
  assert.deepStrictEqual(page.items.map((it) => it.place), ['ZERMATT', 'UNKNOWN', 'KYOTO']);
  assert.ok(wx.calls.modal[0].content.includes('有 1 张照片没有位置信息'));

  texts.length = 0;
  await page.onSaveAll();
  assert.deepStrictEqual(texts, ['导出 1/3…', '导出 2/3…', '导出 3/3…']);
  assert.deepStrictEqual(wx.calls.keepScreenOn, [true, false]);
  assert.strictEqual(wx.calls.toast.pop(), '已保存 3 张');
  await page.onSavePoster();
  assert.deepStrictEqual(wx.calls.keepScreenOn, [true, false], '单张保存不改变屏幕常亮');
});

test('交互细节：空白预览点按选图，切换模板有轻触反馈，帮助页入口', async () => {
  const wx = createWx();
  const page = createPage(wx);
  page.onLoad();
  page.setData({ busy: true });
  await page.onTapPreview();
  assert.strictEqual(wx.calls.chooseMedia, 0);
  page.setData({ busy: false });
  await page.onTapPreview();
  assert.strictEqual(wx.calls.chooseMedia, 1);
  assert.ok(page.data.hasPhoto);
  await page.onTapPreview();
  assert.strictEqual(wx.calls.chooseMedia, 1, '有照片时点按预览不再选图');

  page.onTapTemplate(tap({ id: 'arch' }));
  page.onTapTemplate(tap({ id: 'arch' }));
  assert.deepStrictEqual(wx.calls.vibrate, ['light']);
  assert.strictEqual(page.poster.templateId, 'arch');
  assert.strictEqual(page.data.catId, 'hot');
  page.onTapTemplate(tap({ id: 'swiss' }));
  page.onTapItem(tap({ id: page.items[0].id }));
  page.ensureCategory();
  assert.strictEqual(page.data.catId, 'editorial', '选中的模板不在当前分类时切到它所属的分类');

  page.onOpenAbout();
  assert.deepStrictEqual(wx.calls.navigate, ['/pages/about/about']);
});

test('开发提示：只在开发版 / 体验版且未配置 token 时显示', () => {
  const load = (envVersion, token) => {
    mapService.hasToken = () => token;
    const page = createPage(createWx({ getAccountInfoSync: () => ({ miniProgram: { envVersion } }) }));
    page.onLoad();
    return page.data.tokenMissing;
  };
  assert.strictEqual(load('develop', false), true);
  assert.strictEqual(load('trial', false), true);
  assert.strictEqual(load('release', false), false);
  assert.strictEqual(load('develop', true), false);
});

test('付费面板：会员档位标出单张均价，均价最低的一档高亮', () => {
  const page = createPage(createWx());
  const [month, year, lifetime] = page.data.plans;
  assert.strictEqual(month.unitText, '约 ¥0.12/张');
  assert.strictEqual(year.unitText, '约 ¥0.05/张');
  assert.deepStrictEqual([month.best, year.best, lifetime.best], [false, true, false]);
  assert.deepStrictEqual([month.priceText, year.priceText, lifetime.priceText], ['¥14.9', '¥109.9', '¥299']);
  assert.deepStrictEqual([lifetime.kind, lifetime.unitText, lifetime.desc], ['lifetime', '永久有效', '一次买断，永久有效，每月 120 张']);
});

test('弹层：打开前用截图顶替原生 canvas，全部关闭后恢复并重绘', async () => {
  const wx = createWx();
  const page = createPage(wx);
  page.onLoad();
  await page.onChoosePhoto();
  page.preview = { width: 10, height: 10 };
  const renders = page.renders;
  await page.onOpenPaywall();
  assert.ok(page.data.paywallVisible && page.data.previewCovered);
  assert.strictEqual(page.data.coverImage, 'snap-1.jpg');
  mapService.hasToken = () => true;
  await page.onPickLocation();
  assert.ok(page.data.searchVisible);
  page.onPaywallClose();
  assert.ok(page.data.previewCovered, '搜索面板仍打开');
  page.onSearchClose();
  assert.ok(!page.data.previewCovered && page.data.coverImage === '');
  assert.strictEqual(page.renders, renders + 1);

  wx.canvasToTempFilePath = (o) => o.fail({ errMsg: 'fail' });
  await page.onOpenPaywall();
  assert.ok(page.data.previewCovered);
  assert.strictEqual(page.data.coverImage, '');
  page.finishUnlock('ok');
  assert.ok(!page.data.previewCovered);
});

test('批量编辑：地点和日期可统一应用到全部照片，“+” 可继续添加或替换', async () => {
  const wx = createWx();
  wx.files = ['a.jpg', 'b.jpg', 'k.jpg'];
  wx.store['geopics.membership'] = { invite: true };
  const page = createPage(wx);
  page.onLoad();
  await page.onChoosePhoto();
  page.onPlaceInput({ detail: { value: 'TRIP' } });
  page.onDateChange({ detail: { value: '2021-05-06' } });
  wx.sheetTap = -1;
  await page.onApplyToAllMenu();
  assert.strictEqual(page.items[1].place, 'UNKNOWN');
  wx.sheetTap = 1;
  await page.onApplyToAllMenu();
  assert.ok(page.items.every((it) => it.place === 'TRIP'));
  assert.strictEqual(page.items[1].dateText, 'APR 02, 2025');
  wx.sheetTap = 0;
  await page.onApplyToAllMenu();
  assert.ok(page.items.every((it) => it.dateText === 'MAY 06, 2021' && it.dateManual));
  assert.strictEqual(wx.calls.toast.pop(), '地点和日期已应用到 3 张');
  page.onDateReset();
  assert.strictEqual(page.poster.dateText, 'JUN 16, 2024');

  wx.sheetTap = 0;
  wx.files = ['d.jpg', 'e.jpg'];
  await page.onTapAddTile();
  assert.deepStrictEqual(wx.calls.sheet.pop(), ['继续添加照片', '重新选择（替换全部）']);
  assert.strictEqual(page.data.itemCount, 5);
  wx.sheetTap = 1;
  wx.files = ['x.jpg'];
  await page.onTapAddTile();
  assert.strictEqual(page.data.itemCount, 1);
  wx.files = Array.from({ length: 12 }, (_, i) => `n${i}.jpg`);
  await page.onChoosePhoto();
  assert.strictEqual(page.data.itemCount, 9);
  wx.sheetTap = 0;
  wx.files = ['z.jpg'];
  await page.onTapAddTile();
  assert.deepStrictEqual(wx.calls.sheet.pop(), ['重新选择（替换全部）']);
  assert.strictEqual(page.data.itemCount, 1);
});
