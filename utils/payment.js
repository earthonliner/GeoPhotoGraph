/**
 * 支付适配层。页面只关心 pay(order) 是否成功。
 *
 * mode = 'mock'：开发调试用，弹窗确认后视为支付成功，不产生任何扣款。
 * mode = 'cloud'：约定一个云函数 createOrder，入参 { kind: 'plan'|'single', planId }，
 *   返回 { orderId, payment }，其中 payment 为 wx.requestPayment 所需参数
 *   （timeStamp / nonceStr / package / signType / paySign），
 *   服务端应在支付回调后记录权益，并提供 verifyInvite 等接口做权益校验。
 */
const config = require('./config');
const membership = require('./membership');

function wxp(method, options) {
  return new Promise((resolve, reject) => {
    wx[method](Object.assign({}, options, { success: resolve, fail: reject }));
  });
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

async function payCloud(order) {
  if (!wx.cloud) throw new Error('cloud not enabled');
  const res = await wx.cloud.callFunction({
    name: config.payment.cloud.createOrder,
    data: { kind: order.kind, planId: order.planId }
  });
  const result = res && res.result;
  if (!result || !result.payment) throw new Error('createOrder failed');
  await wxp('requestPayment', result.payment);
  return { ok: true, orderId: result.orderId };
}

/**
 * @param order { kind: 'plan'|'single', planId?, title, priceText }
 * @returns Promise<{ ok: boolean }>  用户取消返回 ok:false，其余错误抛出
 */
async function pay(order) {
  try {
    return config.payment.mode === 'cloud' ? await payCloud(order) : await payMock(order);
  } catch (e) {
    if (/cancel/i.test((e && e.errMsg) || '')) return { ok: false };
    throw e;
  }
}

// 邀请码校验：mock 模式本地比对；cloud 模式交给云函数 verifyInvite（返回 { valid }）
async function verifyInvite(code) {
  if (config.payment.mode !== 'cloud') return membership.isValidInvite(code);
  if (!wx.cloud) throw new Error('cloud not enabled');
  const res = await wx.cloud.callFunction({ name: config.payment.cloud.verifyInvite, data: { code } });
  return !!(res && res.result && res.result.valid);
}

function isMock() {
  return config.payment.mode !== 'cloud';
}

module.exports = { pay, verifyInvite, isMock };
