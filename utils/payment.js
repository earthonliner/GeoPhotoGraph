/**
 * 支付与权益适配层。页面只关心 pay / charge / redeemInvite / fetchEntitlement。
 *
 * mode = 'mock'：开发调试用，弹窗确认后视为支付成功，不产生任何扣款；权益由页面写本地缓存。
 * mode = 'cloud'：微信云开发，全部走云函数 config.payment.cloud.api（cloudfunctions/api）：
 *   wx.login 取 code -> createOrder 下单 -> 按云函数返回的通道拉起收银台
 *     virtual（默认，云函数 PAY_CHANNEL）：wx.requestVirtualPayment，iOS 走 Apple 支付，其他平台走微信支付
 *     jsapi：wx.requestPayment（云支付，不含 iOS）
 *   -> syncOrder 向服务端确认到账（以服务端为准，支付接口成功只表示用户完成了支付流程）；权益快照由服务端返回。
 */
const config = require('./config');
const membership = require('./membership');

// iOS 端微信 8.0.68 起支持虚拟支付（Apple 支付）
const IOS_MIN_WECHAT = '8.0.68';

function wxp(method, options) {
  return new Promise((resolve, reject) => {
    wx[method](Object.assign({}, options, { success: resolve, fail: reject }));
  });
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function isMock() {
  return config.payment.mode !== 'cloud';
}

async function callApi(action, data) {
  if (!wx.cloud) throw new Error('cloud not enabled');
  const res = await wx.cloud.callFunction({
    name: config.payment.cloud.api,
    data: Object.assign({ action }, data)
  });
  const result = res && res.result;
  if (!result || typeof result !== 'object') throw new Error(`${action} failed`);
  return result;
}

function apiError(result, fallback) {
  const err = new Error((result && (result.message || result.code)) || fallback);
  err.code = result && result.code;
  return err;
}

async function payMock(order) {
  const res = await wxp('showModal', {
    title: '测试支付',
    content: `当前为测试支付模式，不会真实扣款。\n确认模拟支付 ${order.title}（${order.priceText}）？`,
    confirmText: '模拟支付',
    confirmColor: '#007AFF'
  });
  return { ok: !!res.confirm };
}

function versionAtLeast(version, min) {
  const a = String(version || '').split('.').map((n) => parseInt(n, 10) || 0);
  const b = min.split('.').map((n) => parseInt(n, 10) || 0);
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) > (b[i] || 0);
  }
  return true;
}

// 虚拟支付对微信版本有要求。不满足时提示用户升级，返回 false（不发起支付）
async function virtualSupported() {
  let info = {};
  try {
    info = (wx.getAppBaseInfo ? wx.getAppBaseInfo() : wx.getSystemInfoSync()) || {};
  } catch (e) {
    info = {};
  }
  let device = {};
  try {
    device = (wx.getDeviceInfo ? wx.getDeviceInfo() : info) || {};
  } catch (e) {
    device = {};
  }
  const apiOk = typeof wx.requestVirtualPayment === 'function' && (!wx.canIUse || wx.canIUse('requestVirtualPayment'));
  const iosOk = device.platform !== 'ios' || !info.version || versionAtLeast(info.version, IOS_MIN_WECHAT);
  if (apiOk && iosOk) return true;
  await wxp('showModal', { title: '需要更新微信', content: '请将微信更新至最新版后再进行支付。', showCancel: false, confirmText: '知道了' });
  return false;
}

async function wxLogin() {
  try {
    const res = await wxp('login', {});
    return (res && res.code) || '';
  } catch (e) {
    return '';
  }
}

async function payCloud(order) {
  const code = await wxLogin();
  const created = await callApi('createOrder', { kind: order.kind, planId: order.planId, code });
  if (!created.ok || !(created.virtual || created.payment)) throw apiError(created, 'createOrder failed');
  if (created.virtual) {
    if (!(await virtualSupported())) return { ok: false, unsupported: true };
    const v = created.virtual;
    await wxp('requestVirtualPayment', { mode: v.mode, signData: v.signData, paySig: v.paySig, signature: v.signature });
  } else {
    await wxp('requestPayment', created.payment);
  }

  const { tries, delayMs } = config.payment.confirm;
  for (let i = 0; i < tries; i += 1) {
    const r = await callApi('syncOrder', { orderId: created.orderId });
    if (r.ok && r.status === 'paid') return { ok: true, orderId: created.orderId, state: membership.normalize(r.state) };
    if (r.ok && r.status === 'failed') throw apiError(r, 'order failed');
    if (i < tries - 1) await sleep(delayMs);
  }
  // 用户已付款但服务端还没收到微信的通知（iOS 的 Apple 支付可能更慢）：稍后由 getEntitlement 补偿入账
  return { ok: true, pending: true, orderId: created.orderId };
}

/**
 * @param order { kind: 'plan'|'lifetime'|'single', planId?, title, priceText }
 * @returns Promise<{ ok, state?, pending? }>  用户取消返回 ok:false，其余错误抛出
 */
async function pay(order) {
  try {
    return isMock() ? await payMock(order) : await payCloud(order);
  } catch (e) {
    if (/cancel/i.test((e && e.errMsg) || '')) return { ok: false };
    throw e;
  }
}

// 从服务端拉取权益快照（仅 cloud 模式）
async function fetchEntitlement() {
  const r = await callApi('getEntitlement');
  if (!r.ok) throw apiError(r, 'getEntitlement failed');
  return membership.normalize(r.state);
}

// 保存前向服务端扣 1 张额度（cloud 模式）。key 相同只计费一次；tpl 是海报所用的模板，免费模板先用免费额度。
// 额度不足时 ok 为 false
async function charge(key, tpl) {
  const r = await callApi('consume', { items: [{ key, tpl }] });
  if (!r.ok && r.code !== 'insufficient') throw apiError(r, 'consume failed');
  return { ok: !!r.ok, state: membership.normalize(r.state) };
}

// 兑换邀请码：mock 本地比对；cloud 由服务端校验并记录，返回最新权益
async function redeemInvite(code) {
  if (isMock()) return { valid: membership.isValidInvite(code) };
  const r = await callApi('redeemInvite', { code });
  if (!r.ok) throw apiError(r, 'redeemInvite failed');
  return { valid: !!r.valid, tooMany: r.code === 'too_many_attempts', state: membership.normalize(r.state) };
}

module.exports = { pay, charge, redeemInvite, fetchEntitlement, isMock };
