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
// Mapbox Public Token（pk.…）。仓库是公开的，GitHub 会拦截含 token 的提交，
// 所以真实 token 写在同目录的 config.local.js 里（本地文件，不要提交）。
// 在 Mapbox 账号里为 token 设置 URL 限制，仅允许 https://servicewechat.com/ 开头的来源。
// 文件缺失时不让整个小程序起不来，只是退回无 token 的本地底图。
function readLocalToken() {
  try {
    return require('./config.local').mapboxToken || '';
  } catch (e) {
    return '';
  }
}
const MAPBOX_TOKEN = readLocalToken();

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
    qrcode: '/assets/miniprogram-code.png',
    tagline: 'MAP YOUR MOMENT'
  },
  membership: {
    // 邀请码（不区分大小写）。仅 mock 模式在客户端校验；cloud 模式下邀请码在云函数环境变量
    // INVITE_CODES 里配置并由服务端校验，这里保持为空，避免码被打进小程序包
    inviteCodes: [],
    // 免费版：只有 templates 中的模板每月有免费额度（自然月，按北京时间，次月 1 日重置），
    // 保存一张消耗 1 张；其余模板预览带水印、不能下载，付费后才可去水印并下载
    free: { templates: ['polaroid'], monthly: 10 },
    // price 单位：分；quota 为有效期内可下载的无水印海报张数，可多次购买叠加。
    // 月度 / 年度 / 买断 / 邀请码开放批量导入与批量下载，单张解锁不含批量
    plans: [
      { id: 'month', name: '月度会员', desc: '120 张 / 月，30 天内有效', price: 1490, days: 30, quota: 120 },
      { id: 'year', name: '年度会员', desc: '2000 张 / 年，365 天内有效', price: 10990, days: 365, quota: 2000 }
    ],
    // 买断：一次付费，永久有效，但每月额度有限（monthly 张 / 自然月，不累计）
    lifetime: { id: 'lifetime', name: '买断会员', desc: '一次买断，永久有效，每月 120 张', price: 29900, monthly: 120 },
    single: { name: '单张解锁', desc: '解锁一张无水印高清图，任意模板，不含批量', price: 129 }
  },
  payment: {
    // 'mock'：开发调试，弹窗确认后直接视为支付成功（不产生任何扣款），权益只存本地
    // 'cloud'：微信云开发。下单、入账、额度扣减、邀请码都在云函数 api 里完成，
    //          小程序端只保存服务端返回的权益快照。部署步骤见 README「接入微信支付」
    mode: 'cloud',
    // 总开关：是否开放购买（会员 / 单张解锁）。false 时所有平台都不显示价格与购买入口，
    // 只保留每月免费额度和邀请码兑换。虚拟支付尚未开通的上线版保持 false；
    // 开通并在真机验证后改为 true
    purchaseEnabled: false,
    // iOS 端是否显示购买入口（仅在 purchaseEnabled 为 true 时有意义）。云函数使用虚拟支付（PAY_CHANNEL 默认值 virtual）时，iOS 会走 Apple 支付，
    // 合规，保持 true。云函数改用 jsapi（云支付）时必须改为 false：
    // 此时 iOS 只展示已有权益、免费额度与邀请码兑换
    iosPurchase: true,
    // env：云开发环境 ID；api：云函数名
    cloud: { env: 'cloud1-d0gjjjk1y3ed016f0', api: 'api' },
    // 支付完成后向服务端确认到账的次数与间隔（回调可能稍有延迟）
    confirm: { tries: 6, delayMs: 1000 }
  }
};
