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
const MAPBOX_TOKEN = require('./config.local').mapboxToken || '';

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
    // 每位用户的免费额度（张）：保存一张无水印海报消耗 1 张，用完后预览恢复水印且不可下载
    freeQuota: 2,
    // price 单位：分；quota 为有效期内可下载的无水印海报张数，可多次购买叠加
    plans: [
      { id: 'month', name: '月度会员', desc: '120 张 / 月，30 天内有效', price: 1490, days: 30, quota: 120 },
      { id: 'year', name: '年度会员', desc: '2000 张 / 年，365 天内有效', price: 10990, days: 365, quota: 2000 }
    ],
    single: { name: '单张解锁', desc: '仅解锁当前这张照片', price: 129 }
  },
  payment: {
    // 'mock'：开发调试，弹窗确认后直接视为支付成功（不产生任何扣款），权益只存本地
    // 'cloud'：微信云开发 + 云支付。下单、入账、额度扣减、邀请码都在云函数 api 里完成，
    //          小程序端只保存服务端返回的权益快照。部署步骤见 README「接入微信支付」
    mode: 'cloud',
    // iOS 端是否显示购买入口。平台规范不允许 iOS 小程序内直接售卖虚拟商品，默认关闭：
    // iOS 只展示已有权益、免费额度与邀请码兑换。接入合规的 iOS 支付方案后再改为 true
    iosPurchase: false,
    // env：云开发环境 ID；api：云函数名
    cloud: { env: 'cloud1-d0gjjjk1y3ed016f0', api: 'api' },
    // 支付完成后向服务端确认到账的次数与间隔（回调可能稍有延迟）
    confirm: { tries: 6, delayMs: 1000 }
  }
};
