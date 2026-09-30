/**
 * api.weixin.qq.com 的内存替身（虚拟支付相关的三个接口）：
 *   POST /cgi-bin/stable_token   -> access_token
 *   GET  /sns/jscode2session     -> openid + session_key（按 sessions 表）
 *   POST /xpay/query_order       -> 校验 pay_sig 后按 orders 表返回订单（模拟微信侧的订单状态）
 * 同时提供签名算法的独立实现，测试用它核对云函数算出的 paySig / signature，而不是复用被测代码。
 */
const crypto = require('crypto');

const hmac = (key, msg) => crypto.createHmac('sha256', key).update(msg, 'utf8').digest('hex');

const APP = { WX_APPID: 'wx091f853ae9bf0925', WX_APPSECRET: 'secret-xyz', XPAY_OFFER_ID: '1450000001', XPAY_APP_KEY: 'app-key-prod' };

function createFakeXpay(options = {}) {
  const appKey = options.appKey || APP.XPAY_APP_KEY;
  const sessions = Object.assign({ 'code-a': { openid: 'openid-a', session_key: 'session-key-a==' } }, options.sessions);
  // 微信侧订单：order_id -> { status, order_fee, order_type, wx_order_id }
  const orders = {};
  const calls = { token: 0, session: 0, query: 0 };
  let tokenSeq = 0;
  let validToken = null;

  async function http({ method, url, body }) {
    const u = new URL(url);
    if (u.pathname === '/cgi-bin/stable_token') {
      calls.token += 1;
      const b = JSON.parse(body);
      if (b.appid !== APP.WX_APPID || b.secret !== APP.WX_APPSECRET) return { errcode: 40013, errmsg: 'invalid appid' };
      tokenSeq += 1;
      validToken = `token-${tokenSeq}`;
      return { access_token: validToken, expires_in: 7200 };
    }
    if (u.pathname === '/sns/jscode2session') {
      calls.session += 1;
      if (u.searchParams.get('secret') !== APP.WX_APPSECRET) return { errcode: 40125, errmsg: 'invalid appsecret' };
      const s = sessions[u.searchParams.get('js_code')];
      return s ? { openid: s.openid, session_key: s.session_key } : { errcode: 40029, errmsg: 'invalid code' };
    }
    if (u.pathname === '/xpay/query_order') {
      calls.query += 1;
      if (u.searchParams.get('access_token') !== validToken) return { errcode: 42001, errmsg: 'access_token expired' };
      if (u.searchParams.get('pay_sig') !== hmac(appKey, `/xpay/query_order&${body}`)) return { errcode: 268490003, errmsg: 'signature error' };
      const b = JSON.parse(body);
      const o = orders[b.order_id];
      if (!o) return { errcode: 268490002, errmsg: 'order not found' };
      return { errcode: 0, errmsg: '', order: Object.assign({ order_id: b.order_id, order_type: 0, wx_order_id: `VPO${b.order_id}` }, o) };
    }
    throw new Error(`unexpected request ${method} ${url}`);
  }

  return {
    http,
    orders,
    calls,
    // 让当前 access_token 失效，模拟 7200 秒过期
    expireToken: () => { validToken = null; },
    // 模拟用户在微信 / Apple 侧完成支付（status 2：已支付待发货）
    pay: (orderId, fee, extra) => { orders[orderId] = Object.assign({ status: 2, order_fee: fee }, extra); },
    // 模拟退款完成（iOS：Apple 批准；Android：开发者发起）
    refund: (orderId) => { orders[orderId].status = 8; }
  };
}

const VIRTUAL_ENV = { PAY_CHANNEL: 'virtual', INVITE_CODES: 'geo0930', XPAY_ENV: '0', ...APP };

module.exports = { createFakeXpay, hmac, APP, VIRTUAL_ENV };
