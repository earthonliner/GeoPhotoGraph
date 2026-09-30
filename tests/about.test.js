// 帮助与关于页：内容随平台（iOS 不出现价格）、支付模式与版本类型变化
const test = require('node:test');
const assert = require('node:assert');
const config = require('../utils/config');
const { createWx, createPage, tap } = require('./helpers/page-env');

const MODE = config.payment.mode;
test.afterEach(() => {
  config.payment.mode = MODE;
});

function load(overrides) {
  const wx = createWx(overrides);
  const page = createPage(wx, 'about');
  page.onLoad();
  return { wx, page };
}
const allText = (page) => JSON.stringify([page.data.steps, page.data.faqs, page.data.privacy]);
const answer = (page, q) => page.data.faqs.find((f) => f.q === q).a;

test('帮助页：安卓正式版列出价格、云端权益、隐私说明与版本号', () => {
  config.payment.mode = 'cloud';
  const { page } = load({ openPrivacyContract() {} });
  assert.strictEqual(page.data.version, '版本 1.0.0');
  assert.ok(page.data.steps[0].text.includes('一次最多 9 张'));
  assert.ok(
    answer(page, '会员怎么收费？').startsWith(
      '月度会员 ¥14.9，30 天内可保存 120 张；年度会员 ¥109.9，365 天内可保存 2000 张；也可以 ¥1.29 单独解锁当前这张。'
    )
  );
  assert.ok(answer(page, '免费额度怎么计算？').includes('每位用户有 2 张免费额度'));
  assert.ok(answer(page, '换手机后额度还在吗？').includes('云端'));
  assert.deepStrictEqual(page.data.privacy.map((p) => p.title), ['照片只在手机上处理', '位置与地名', '会员与额度']);
  assert.ok(page.data.privacy[1].text.includes('Mapbox'));
  assert.strictEqual(page.data.privacyContract, true);
  assert.ok(page.data.faqs.every((f) => !f.open));
});

test('帮助页：iOS 不出现价格与购买引导', () => {
  const { page } = load({ getDeviceInfo: () => ({ platform: 'ios' }) });
  assert.ok(!/¥|开通|购买|收费/.test(allText(page)));
  assert.ok(answer(page, '免费额度怎么计算？').endsWith('额度用完后，预览会带上水印。'));
});

test('帮助页：本地模式不提云端；开发版 / 体验版显示版本类型', () => {
  config.payment.mode = 'mock';
  const dev = load({ getAccountInfoSync: () => ({ miniProgram: { envVersion: 'develop', version: '' } }) }).page;
  assert.strictEqual(dev.data.version, '开发版');
  assert.ok(!/云端/.test(allText(dev)));
  assert.strictEqual(dev.data.privacy.length, 2);
  assert.strictEqual(load({ getAccountInfoSync: () => ({ miniProgram: { envVersion: 'trial' } }) }).page.data.version, '体验版');
  assert.strictEqual(load({ getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '' } }) }).page.data.version, '');
  assert.strictEqual(load({ getAccountInfoSync: undefined }).page.data.version, '');
});

test('帮助页：常见问题点按展开 / 收起；隐私保护指引打开失败时提示', () => {
  let opened = 0;
  const { wx, page } = load({
    openPrivacyContract(o) {
      opened += 1;
      o.fail({ errMsg: 'openPrivacyContract:fail' });
    }
  });
  page.onToggleFaq(tap({ index: 1 }));
  assert.deepStrictEqual(page.data.faqs.slice(0, 3).map((f) => f.open), [false, true, false]);
  page.onToggleFaq(tap({ index: 1 }));
  assert.strictEqual(page.data.faqs[1].open, false);
  page.onOpenPrivacyContract();
  assert.strictEqual(opened, 1);
  assert.deepStrictEqual(wx.calls.toast, ['暂时无法打开，请稍后重试']);
  assert.strictEqual(load({ openPrivacyContract: undefined }).page.data.privacyContract, false);
});
