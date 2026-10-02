/**
 * 商品目录（服务端为准）。价格单位：分。
 * 与小程序端 utils/config.js 的 membership 保持一致，tests/cloud.test.js 会校验两边没有漂移。
 */
module.exports = {
  // 免费版只有这些模板每月有免费额度（自然月，北京时间）
  free: { templates: ['polaroid'], monthly: 10 },
  plans: {
    month: { id: 'month', name: '月度会员', price: 1290, days: 30, quota: 60 },
    year: { id: 'year', name: '年度会员', price: 4990, days: 365, quota: 500 }
  },
  // 买断：长期有效，每自然月最多 monthly 张
  lifetime: { id: 'lifetime', name: '买断会员', price: 9900, monthly: 100 },
  // 海报包：一次性 quota 张，长期有效，不含批量（键名沿用 single）
  single: { name: '海报包', price: 990, quota: 10 },
  // 虚拟支付「道具管理」里的道具 ID。道具的价格必须与上面的 price 完全一致（iOS / Android 共用）
  productIds: { month: 'geopics_month', year: 'geopics_year', lifetime: 'geopics_lifetime', single: 'geopics_single' }
};
