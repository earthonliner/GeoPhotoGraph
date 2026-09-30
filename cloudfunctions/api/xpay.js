/**
 * 微信小程序虚拟支付（xpay）服务端能力：签名、换取 session_key、查单。
 * iOS 走 Apple 支付、其他平台走微信支付，对小程序端是同一个接口 wx.requestVirtualPayment。
 *
 * 需要的环境变量（云函数 → 配置 → 环境变量，不要写进代码库）：
 *   XPAY_OFFER_ID    虚拟支付 OfferID（小程序后台 → 虚拟支付 → 基本配置）
 *   XPAY_APP_KEY     与 XPAY_ENV 对应的 AppKey（0 用现网 AppKey，1 用沙箱 AppKey）
 *   XPAY_ENV         0 现网（默认），1 沙箱。Apple 支付没有沙箱，iOS 只能用 0 测试
 *   WX_APPID / WX_APPSECRET  小程序 AppID 与 AppSecret，用于 code2Session 与 access_token
 */
const crypto = require('crypto');
const https = require('https');

const API_HOST = 'https://api.weixin.qq.com';
const TOKEN_SKEW = 5 * 60 * 1000;
const HTTP_TIMEOUT = 4000;

const hmac = (key, message) => crypto.createHmac('sha256', String(key)).update(String(message), 'utf8').digest('hex');

// 订单状态（query_order 返回的 order.status）：2 已支付待发货，3 发货中，4 已发货
const PAID_STATUS = [2, 3, 4];

function httpsJson({ method, url, body }) {
  return new Promise((resolve, reject) => {
    const req = https.request(url, { method, headers: body ? { 'Content-Type': 'application/json' } : {}, timeout: HTTP_TIMEOUT }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try {
          resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
        } catch (e) {
          reject(new Error('invalid json from weixin api'));
        }
      });
    });
    req.on('timeout', () => req.destroy(new Error('weixin api timeout')));
    req.on('error', reject);
    if (body) req.write(body);
    req.end();
  });
}

function createXpay({ env = {}, http = httpsJson, now = () => Date.now() } = {}) {
  const xpayEnv = Number(env.XPAY_ENV) === 1 ? 1 : 0;
  let token = null;

  const isConfigured = () => !!(env.XPAY_OFFER_ID && env.XPAY_APP_KEY && env.WX_APPID && env.WX_APPSECRET);

  async function accessToken(force) {
    if (!force && token && token.expiresAt > now()) return token.value;
    const r = await http({
      method: 'POST',
      url: `${API_HOST}/cgi-bin/stable_token`,
      body: JSON.stringify({ grant_type: 'client_credential', appid: env.WX_APPID, secret: env.WX_APPSECRET })
    });
    if (!r || !r.access_token) throw new Error(`stable_token failed: ${(r && (r.errmsg || r.errcode)) || 'empty'}`);
    token = { value: r.access_token, expiresAt: now() + Math.max(0, Number(r.expires_in || 7200) * 1000 - TOKEN_SKEW) };
    return token.value;
  }

  // 用 wx.login 的 code 换 session_key。必须核对 openid，避免拿别人的 code 给自己签名
  async function sessionKey(code, openid) {
    const qs = `appid=${encodeURIComponent(env.WX_APPID)}&secret=${encodeURIComponent(env.WX_APPSECRET)}&js_code=${encodeURIComponent(code)}&grant_type=authorization_code`;
    const r = await http({ method: 'GET', url: `${API_HOST}/sns/jscode2session?${qs}` });
    if (!r || !r.session_key || !r.openid) throw new Error(`code2Session failed: ${(r && (r.errmsg || r.errcode)) || 'empty'}`);
    if (openid && r.openid !== openid) throw new Error('code2Session openid mismatch');
    return r.session_key;
  }

  // 生成 wx.requestVirtualPayment 需要的参数。signData 必须与客户端原样传入的字符串完全一致
  function buildPayment({ orderId, productId, price, attach, sessionKey: key }) {
    const signData = JSON.stringify({
      offerId: String(env.XPAY_OFFER_ID),
      buyQuantity: 1,
      env: xpayEnv,
      currencyType: 'CNY',
      productId,
      goodsPrice: price,
      outTradeNo: orderId,
      attach: String(attach || productId)
    });
    return {
      mode: 'short_series_goods',
      signData,
      paySig: hmac(env.XPAY_APP_KEY, `requestVirtualPayment&${signData}`),
      signature: hmac(key, signData)
    };
  }

  // 查单：返回 { paid, refunded, totalFee, transactionId, raw }，查询失败抛错
  async function queryOrder(openid, orderId) {
    const body = JSON.stringify({ openid, env: xpayEnv, order_id: orderId });
    const paySig = hmac(env.XPAY_APP_KEY, `/xpay/query_order&${body}`);
    const call = async (force) => {
      const at = await accessToken(force);
      return http({
        method: 'POST',
        url: `${API_HOST}/xpay/query_order?access_token=${encodeURIComponent(at)}&pay_sig=${paySig}`,
        body
      });
    };
    let r = await call(false);
    // 40001 / 42001：access_token 失效，刷新后重试一次
    if (r && (r.errcode === 40001 || r.errcode === 42001 || r.errcode === 40014)) r = await call(true);
    if (!r || r.errcode) throw new Error(`query_order failed: ${(r && (r.errmsg || r.errcode)) || 'empty'}`);
    const o = r.order || {};
    const paid = PAID_STATUS.includes(o.status) && (o.order_type === undefined || o.order_type === 0 || o.order_type === 7);
    // 5 已退款，8 用户退款完成（iOS 由用户在 App Store 申请，Apple 批准后才到这一步）
    const refunded = [5, 8].includes(o.status);
    return { paid, refunded, totalFee: o.order_fee, transactionId: o.wx_order_id || o.wxpay_order_id || '', raw: o };
  }

  return { env: xpayEnv, isConfigured, buildPayment, sessionKey, queryOrder, accessToken };
}

module.exports = { createXpay, hmac, PAID_STATUS };
