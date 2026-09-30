/**
 * 商品目录（服务端为准）。价格单位：分。
 * 与小程序端 utils/config.js 的 membership 保持一致，tests/cloud.test.js 会校验两边没有漂移。
 */
module.exports = {
  // 免费版只有这些模板每月有免费额度（自然月，北京时间）
  free: { templates: ['polaroid'], monthly: 10 },
  plans: {
    month: { id: 'month', name: '月度会员', price: 1490, days: 30, quota: 120 },
    year: { id: 'year', name: '年度会员', price: 10990, days: 365, quota: 2000 }
  },
  // 买断：永久有效，每自然月 monthly 张
  lifetime: { id: 'lifetime', name: '买断会员', price: 29900, monthly: 120 },
  single: { name: '单张解锁', price: 129, quota: 1 }
};
