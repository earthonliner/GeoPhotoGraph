// 内容安全：云函数 checkText / checkImage / imageResult 与 wxa_media_check 推送（security.js）
const test = require('node:test');
const assert = require('node:assert');
const { createHandler } = require('../cloudfunctions/api/handler');
const { createFakeCloud } = require('./helpers/fake-cloud');

const NOW = Date.UTC(2026, 9, 1, 8, 0, 0);
const FILE = 'cloud://env.abc/seccheck/1-abc.jpg';

function setup(options) {
  const fake = createFakeCloud(Object.assign({ files: { [FILE]: 1 } }, options));
  let t = NOW;
  const main = createHandler({ cloud: fake.cloud, env: {}, now: () => t });
  return { fake, main, advance: (ms) => { t += ms; } };
}

test('文本：正常内容通过，调用 msgSecCheck 2.0（带 openid、scene、version）', async () => {
  const { fake, main } = setup();
  assert.deepStrictEqual(await main({ action: 'checkText', text: '  Kyoto  ' }), { ok: true, safe: true });
  assert.deepStrictEqual(fake.calls.msgSecCheck, [{ openid: 'openid-a', scene: 4, version: 2, content: 'Kyoto' }]);
  assert.deepStrictEqual(await main({ action: 'checkText', text: '   ' }), { ok: true, safe: true });
  assert.strictEqual(fake.calls.msgSecCheck.length, 1, '空文本不调用');
  await main({ action: 'checkText', text: 'x'.repeat(500) });
  assert.strictEqual(fake.calls.msgSecCheck[1].content.length, 200);
});

test('文本：suggest = risky 判为违规；1.0 的 87014 也判违规；检测服务出错时放行', async () => {
  const { fake, main } = setup();
  fake.setMsgSecCheck(async () => ({ errCode: 0, result: { suggest: 'risky', label: 20001 } }));
  assert.deepStrictEqual(await main({ action: 'checkText', text: 'bad' }), { ok: true, safe: false });
  fake.setMsgSecCheck(async () => ({ errCode: 0, result: { suggest: 'review', label: 100 } }));
  assert.strictEqual((await main({ action: 'checkText', text: 'maybe' })).safe, true);
  fake.setMsgSecCheck(async () => { throw { errCode: 87014, errMsg: 'risky content' }; });
  assert.strictEqual((await main({ action: 'checkText', text: 'bad' })).safe, false);
  fake.setMsgSecCheck(async () => { throw { errCode: 45009, errMsg: 'reach max api daily quota limit' }; });
  assert.deepStrictEqual(await main({ action: 'checkText', text: 'ok' }), { ok: true, safe: true, skipped: true });
});

test('图片：提交检测 -> pending -> 推送 pass -> 副本被删除', async () => {
  const { fake, main } = setup();
  const sub = await main({ action: 'checkImage', fileID: FILE });
  assert.deepStrictEqual(sub, { ok: true, traceId: 'trace-1' });
  const call = fake.calls.mediaCheckAsync[0];
  assert.strictEqual(call.openid, 'openid-a');
  assert.deepStrictEqual([call.scene, call.version, call.media_type], [4, 2, 2]);
  assert.ok(call.media_url.startsWith('https://tmp.example/'));
  assert.deepStrictEqual(await main({ action: 'imageResult', traceId: 'trace-1' }), { ok: true, status: 'pending' });
  assert.strictEqual(fake.calls.deleteFile.length, 0, '结果出来前不删');

  const ack = await main({ Event: 'wxa_media_check', MsgType: 'event', trace_id: 'trace-1', result: { suggest: 'pass', label: 100 } });
  assert.strictEqual(ack, 'success');
  assert.deepStrictEqual(await main({ action: 'imageResult', traceId: 'trace-1' }), { ok: true, status: 'pass' });
  assert.deepStrictEqual(fake.calls.deleteFile, [FILE]);
  assert.strictEqual(fake.dump().seccheck['trace-1'].fileID, '');
});

test('图片：推送 risky；他人不能查询；推送先于登记到达时仍能收尾', async () => {
  const { fake, main } = setup();
  await main({ action: 'checkImage', fileID: FILE });
  await main({ Event: 'wxa_media_check', trace_id: 'trace-1', result: { suggest: 'risky', label: 20002 } });
  assert.strictEqual((await main({ action: 'imageResult', traceId: 'trace-1' })).status, 'risky');
  fake.setOpenid('openid-b');
  assert.strictEqual((await main({ action: 'imageResult', traceId: 'trace-1' })).status, 'unknown');
  assert.strictEqual((await main({ action: 'imageResult', traceId: 'nope' })).status, 'unknown');

  // 推送先到：先记结果，随后的登记发现已有结果，直接删除副本
  const second = setup({ files: { [FILE]: 1 } });
  second.fake.setMediaCheckAsync(async () => {
    await second.main({ Event: 'wxa_media_check', trace_id: 'early', result: { suggest: 'risky' } });
    return { errCode: 0, traceId: 'early' };
  });
  second.fake.setOpenid('openid-a');
  const res = await second.main({ action: 'checkImage', fileID: FILE });
  assert.strictEqual(res.traceId, 'early');
  assert.deepStrictEqual(second.fake.calls.deleteFile, [FILE]);
  assert.strictEqual(second.fake.dump().seccheck.early.status, 'risky');
});

test('图片：检测服务出错时放行并删除副本；非法 fileID 被拒绝；detail 里的 risky 也算违规', async () => {
  const { fake, main } = setup();
  fake.setMediaCheckAsync(async () => { throw { errCode: 45009, errMsg: 'quota' }; });
  assert.deepStrictEqual(await main({ action: 'checkImage', fileID: FILE }), { ok: true, skipped: true });
  assert.deepStrictEqual(fake.calls.deleteFile, [FILE]);
  assert.deepStrictEqual(await main({ action: 'checkImage', fileID: 'https://evil.example/a.jpg' }), { ok: false, code: 'bad_request' });
  assert.deepStrictEqual(await main({ action: 'checkImage', fileID: 'cloud://env.abc/other/a.jpg' }), { ok: false, code: 'bad_request' });

  fake.setMediaCheckAsync(null);
  fake.files[FILE] = 1;
  await main({ action: 'checkImage', fileID: FILE });
  await main({ Event: 'wxa_media_check', trace_id: 'trace-2', detail: [{ strategy: 'content_model', suggest: 'risky' }] });
  assert.strictEqual((await main({ action: 'imageResult', traceId: 'trace-2' })).status, 'risky');
});

test('图片：超过一天没有结果的副本在下一次提交时清理', async () => {
  const { fake, main, advance } = setup();
  await main({ action: 'checkImage', fileID: FILE });
  advance(25 * 60 * 60 * 1000);
  fake.files['cloud://env.abc/seccheck/2-def.jpg'] = 1;
  await main({ action: 'checkImage', fileID: 'cloud://env.abc/seccheck/2-def.jpg' });
  await new Promise((r) => setTimeout(r, 10));
  assert.ok(fake.calls.deleteFile.includes(FILE));
  assert.strictEqual(fake.dump().seccheck['trace-1'].status, 'expired');
});
