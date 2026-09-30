/**
 * 全局配置。
 *
 * 使用前请在 Mapbox 账号中创建 Public Token (pk.xxx)，并在小程序后台
 * 「开发管理 → 开发设置 → 服务器域名」中把 https://api.mapbox.com
 * 加入 request 合法域名与 downloadFile 合法域名。
 *
 * token 为空时：不会请求地图与逆地理编码，海报使用本地绘制的极简底图，
 * 地名显示为经纬度占位，便于本地无网络调试。
 */
// 在此填入 Mapbox Public Token（pk.…）。注意不要提交真实 token 到公开仓库。
const MAPBOX_TOKEN = '';

module.exports = {
  mapbox: {
    token: MAPBOX_TOKEN,
    // 推荐在 Mapbox Studio 中 Duplicate「Monochrome / Light」得到自己的黑白极简样式
    username: 'mapbox',
    styleId: 'light-v11',
    // 深色主题使用的底图样式（画布上再叠加主题色）
    darkStyleId: 'dark-v11'
  },
  request: {
    timeout: 10000
  },
  image: {
    // 参与绘制的照片长边上限（像素）。手机原图（12MP~48MP）直接放进 canvas 时，
    // 部分机型会只解码出上半部分，下半部分呈现为最后一行像素的竖向拖影，
    // 因此导入时会先把超限的照片等比压缩到这个尺寸内；位置 / 日期仍从原图读取
    maxSide: 2560,
    quality: 92
  },
  brand: {
    // 海报底端品牌栏：GEOPICS 标识 + 小程序码。
    // qrcode 填入小程序码图片路径（在小程序后台「设置 → 基本设置 / 开发管理」下载，放到 assets/ 下），
    // 例如 '/assets/miniprogram-code.png'；留空或文件不存在时，底栏只显示居中的 GEOPICS 标志与字标
    qrcode: '',
    tagline: 'MAP YOUR MOMENT'
  },
  membership: {
    // 邀请码（不区分大小写）。仅在客户端校验，正式上线请改为服务端校验（见 README「会员」）
    inviteCodes: ['geo0930'],
    // price 单位：分；quota 为有效期内可下载的无水印海报张数，可多次购买叠加
    plans: [
      { id: 'month', name: '月度会员', desc: '120 张 / 月，30 天内有效', price: 1490, days: 30, quota: 120 },
      { id: 'year', name: '年度会员', desc: '2000 张 / 年，365 天内有效', price: 10990, days: 365, quota: 2000 }
    ],
    single: { name: '单张解锁', desc: '仅解锁当前这张照片', price: 129 }
  },
  payment: {
    // 'mock'：开发调试，弹窗确认后直接视为支付成功（不产生任何扣款）
    // 'cloud'：走云函数下单 + wx.requestPayment，见 utils/payment.js
    mode: 'mock',
    cloud: { createOrder: 'createOrder', verifyInvite: 'verifyInvite' }
  }
};
