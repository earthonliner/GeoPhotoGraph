// 首页流程：在 Node 中运行真实页面脚本（wx 为替身，见 helpers/page-env.js）
const test = require('node:test');
const assert = require('node:assert');
const config = require('../utils/config');
const exifParser = require('../utils/exif-parser');
const mapService = require('../utils/map-service');
const platform = require('../utils/platform');
const { createHandler } = require('../cloudfunctions/api/handler');
const { createFakeCloud } = require('./helpers/fake-cloud');
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
  Object.assign(config.payment, JSON.parse(JSON.stringify(ORIGINAL.payment)), { mode: 'mock' });
  Object.assign(config.membership, JSON.parse(JSON.stringify(ORIGINAL.membership)));
  mapService.hasToken = () => false;
});
test.afterEach(() => {
  assert.deepStrictEqual(violations.splice(0), [], 'showModal 按钮文字不能超过 4 个字符');
});

const FREE_OUT = { invite: false, bought: false, freeUsed: 2, packs: [] };

// cloud 模式：页面 + payment.js + 云函数（内存数据库）。offlineAfter 次扣额度之后模拟断网
function cloudSetup(overrides) {
  config.payment.mode = 'cloud';
  config.payment.confirm = { tries: 2, delayMs: 0 };
  const fake = createFakeCloud();
  const main = createHandler({ cloud: fake.cloud, env: { SUB_MCH_ID: '1', INVITE_CODES: 'geo0930' } });
  const env = { fake, main, actions: [], pay: 'notify', offlineAfter: Infinity };
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
        requestPayment(o) {
          if (env.pay === 'cancel') return o.fail({ errMsg: 'requestPayment:fail cancel' });
          const id = o.package.replace('prepay_id=', '');
          const fee = fake.dump().orders[id].totalFee;
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

test('免费额度：两张以内无水印可下载，用完后出现水印并拦截', async () => {
  const wx = createWx();
  wx.files = ['a.jpg', 'k.jpg', 'x.jpg'];
  const page = createPage(wx);
  page.onLoad();
  assert.strictEqual(page.data.memberChip, '免费 · 2 张');
  await page.onChoosePhoto();
  assert.strictEqual(page.data.itemCount, 3);
  assert.ok(page.data.list.every((x) => !x.locked));
  assert.strictEqual(page.buildStyle(page.poster).watermark, false);

  await page.onSavePoster();
  assert.deepStrictEqual(wx.calls.save, [`poster-${page.items[0].id}.jpg`]);
  assert.strictEqual(page.member.freeUsed, 1);
  assert.strictEqual(wx.store['geopics.membership'].freeUsed, 1);

  // 第 1 张已解锁、第 2 张用掉最后 1 张免费额度、第 3 张被拦下：询问后仅下载可下载的
  await page.onSaveAll();
  assert.strictEqual(wx.calls.modal[0].title, '部分照片未解锁');
  assert.ok(wx.calls.modal[0].content.includes('免费额度只够 2 张'));
  assert.ok(wx.calls.modal[0].content.endsWith('是否仅下载可下载的 2 张？'));
  assert.deepStrictEqual([wx.calls.modal[0].confirmText, wx.calls.modal[0].cancelText], ['仅下载', '去解锁']);
  assert.strictEqual(wx.calls.save.length, 3);
  assert.deepStrictEqual(page.data.list.map((x) => x.locked), [false, false, true]);
  assert.strictEqual(page.buildStyle(page.items[2]).watermark, true);
  assert.strictEqual(page.data.memberChip, '开通会员');

  page.onTapItem(tap({ id: page.items[2].id }));
  await page.onSavePoster();
  assert.ok(page.data.paywallVisible);
  assert.ok(page.data.paywallNotice.startsWith('2 张免费额度已用完。开通会员'));
  assert.strictEqual(wx.calls.save.length, 3);
});

test('本地模式购买：单张只解锁当前，会员额度可叠加，解锁后继续刚才的保存', async () => {
  const wx = createWx();
  wx.files = ['a.jpg', 'k.jpg', 'x.jpg'];
  wx.store['geopics.membership'] = FREE_OUT;
  const page = createPage(wx);
  page.onLoad();
  await page.onChoosePhoto();
  assert.ok(page.data.currentLocked);

  await page.onSavePoster();
  assert.ok(page.data.paywallVisible);
  await page.onBuy(tap({ kind: 'single' }));
  await sleep(450);
  assert.ok(!page.data.paywallVisible);
  assert.deepStrictEqual(page.data.list.map((x) => x.locked), [false, true, true]);
  assert.deepStrictEqual(wx.calls.save, [`poster-${page.items[0].id}.jpg`]);

  // 取消模拟支付：什么都不发生
  wx.modalConfirm = false;
  await page.onOpenPaywall();
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  assert.strictEqual(page.member.packs.length, 0);
  assert.ok(page.data.paywallVisible);
  page.onPaywallClose();

  wx.modalConfirm = true;
  wx.calls.save.length = 0;
  await page.onSaveAll();
  assert.strictEqual(wx.calls.modal.pop().title, '部分照片未解锁');
  assert.strictEqual(wx.calls.save.length, 1);
  wx.modalConfirm = false;
  await page.onSaveAll();
  assert.ok(page.data.paywallVisible, '选择“去解锁”打开付费面板');
  wx.modalConfirm = true;
  wx.calls.save.length = 0;
  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  await sleep(450);
  assert.strictEqual(page.data.memberLabel, '会员 · 剩余 118 张');
  assert.strictEqual(wx.calls.save.length, 3);
  await page.onSaveAll();
  assert.strictEqual(page.member.packs[0].used, 2, '同一张照片再次保存不重复计费');

  const relock = (used) => {
    page.member.packs[0].used = used;
    page.items.forEach((it) => {
      it.unlocked = false;
    });
    page.refreshEntitlement();
  };
  relock(119);
  wx.modalConfirm = false;
  await page.onSaveAll();
  const short = wx.calls.modal.pop();
  assert.strictEqual(short.title, '会员额度不足');
  assert.ok(short.content.startsWith('本次需下载 3 张，剩余额度只够 1 张。'));
  assert.deepStrictEqual([short.confirmText, short.cancelText], ['仅下载', '购买会员']);
  assert.ok(page.data.paywallVisible);
  page.onPaywallClose();
  wx.modalConfirm = true;

  relock(120);
  assert.strictEqual(page.data.memberChip, '续购会员');
  await page.onSavePoster();
  assert.ok(page.data.paywallNotice.includes('购买额外的月度或年度会员'));
  await page.onBuy(tap({ kind: 'plan', id: 'year' }));
  await sleep(450);
  assert.strictEqual(page.member.packs.length, 2);
  assert.strictEqual(page.data.memberLabel, '会员 · 剩余 1999 张');
});

test('本地模式邀请码：忽略大小写与空格，错误时提示', async () => {
  config.membership.inviteCodes = ['geo0930'];
  const wx = createWx();
  wx.store['geopics.membership'] = FREE_OUT;
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
  assert.strictEqual(page.data.freeLeft, 2);
  await page.onChoosePhoto();
  await page.onSavePoster();
  await page.onSavePoster();
  assert.strictEqual(env.wx.calls.save.length, 2);
  assert.strictEqual(env.fake.dump().users['openid-a'].freeUsed, 1, '同一张不重复扣');
  await page.onSaveAll();
  assert.strictEqual(env.wx.calls.modal.pop().title, '部分照片未解锁');
  assert.strictEqual(env.wx.calls.save.length, 4);
  assert.strictEqual(env.fake.dump().users['openid-a'].freeUsed, 2);

  // 本地被改成“还有额度”：服务端拒绝，不出图并打开付费面板
  page.member = { invite: false, bought: false, freeUsed: 0, singles: 0, packs: [] };
  page.onTapItem(tap({ id: page.items[2].id }));
  env.wx.calls.save.length = 0;
  await page.onSavePoster();
  assert.strictEqual(env.wx.calls.save.length, 0);
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(page.data.paywallNotice, '额度不足，购买会员后即可继续下载。');
  assert.strictEqual(page.member.freeUsed, 2, '以服务端快照为准');

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

  // 回调迟迟未到：不在本地发放，提示确认中；之后回到页面立即同步
  env.pay = 'none';
  const before = page.member.singles;
  await page.onOpenPaywall();
  await page.onBuy(tap({ kind: 'single' }));
  assert.ok(env.wx.calls.toast.includes('支付结果确认中，稍后自动到账'));
  assert.strictEqual(page.member.singles, before);
  const pending = Object.values(env.fake.dump().orders).find((o) => o.status === 'pending' && o.kind === 'single');
  await env.main({ returnCode: 'SUCCESS', resultCode: 'SUCCESS', outTradeNo: pending._id, totalFee: 129, transactionId: 'wx-late' });
  await page.onShow();
  assert.strictEqual(page.member.singles, before + 1);
  clearTimeout(page._syncTimer);

  await page.onOpenPaywall();
  page.onInviteInput({ detail: { value: ' GEO0930' } });
  await page.onRedeemInvite();
  assert.strictEqual(env.fake.dump().users['openid-a'].invite, true);
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

test('iOS：不展示价格与购买入口，文案不含购买引导，邀请码照常可用', async () => {
  config.membership.inviteCodes = ['geo0930'];
  const wx = createWx({ getDeviceInfo: () => ({ platform: 'ios' }) });
  wx.store['geopics.membership'] = { invite: false, bought: false, freeUsed: 1, packs: [] };
  wx.files = ['a.jpg', 'k.jpg'];
  const page = createPage(wx);
  page.onLoad();
  assert.strictEqual(page.data.canPurchase, false);
  assert.strictEqual(page.data.memberChip, '免费 · 1 张');
  assert.strictEqual(page.data.memberLabel, '免费额度剩余 1 张');
  await page.onChoosePhoto();

  wx.modalConfirm = false;
  await page.onSaveAll();
  const ask = wx.calls.modal.pop();
  assert.deepStrictEqual([ask.confirmText, ask.cancelText], ['仅下载', '取消']);
  assert.ok(!/开通|购买/.test(ask.content));
  assert.ok(!page.data.paywallVisible, 'iOS 上取消后不弹付费面板');

  wx.modalConfirm = true;
  await page.onSaveAll();
  assert.strictEqual(wx.calls.save.length, 1);
  assert.strictEqual(page.data.memberChip, '额度已用完');
  assert.strictEqual(page.data.memberLabel, '免费额度已用完');
  page.onTapItem(tap({ id: page.items[1].id }));
  await page.onSavePoster();
  assert.ok(page.data.paywallVisible);
  assert.strictEqual(page.data.paywallNotice, '2 张免费额度已用完。');

  await page.onBuy(tap({ kind: 'plan', id: 'month' }));
  await page.onBuy(tap({ kind: 'single' }));
  assert.ok(!wx.calls.modal.some((m) => m.title === '测试支付'));
  assert.strictEqual(page.member.packs.length, 0);

  page.onInviteInput({ detail: { value: 'geo0930' } });
  await page.onRedeemInvite();
  await sleep(450);
  assert.strictEqual(page.data.memberChip, '会员');
  assert.strictEqual(wx.calls.save.length, 2, '兑换后继续保存');

  page.member = { invite: false, bought: true, freeUsed: 2, packs: [{ planId: 'month', quota: 120, used: 120, until: Date.now() + 86400000 }] };
  page.refreshEntitlement();
  assert.strictEqual(page.data.memberChip, '额度已用完');
  assert.strictEqual(page.data.memberLabel, '额度已用完');
});

test('平台判断：仅 iOS 默认关闭购买，可通过配置打开；接口异常时按普通环境处理', () => {
  const run = (wx) => {
    global.wx = wx;
    return platform.canPurchase();
  };
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
  assert.strictEqual(manual.title, 'GEOPICS · 把照片与它发生的地方，做成一张海报', '手动输入的地名不进标题');
  assert.strictEqual((await manual.promise).title, manual.title);
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
  const [month, year] = page.data.plans;
  assert.strictEqual(month.unitText, '约 ¥0.12/张');
  assert.strictEqual(year.unitText, '约 ¥0.05/张');
  assert.deepStrictEqual([month.best, year.best], [false, true]);
  assert.deepStrictEqual([month.priceText, year.priceText], ['¥14.9', '¥109.9']);
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
