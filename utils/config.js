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
mapbox_token = ''
module.exports = {
  mapbox: {
    token: mapbox_token,
    // 推荐在 Mapbox Studio 中 Duplicate「Monochrome / Light」得到自己的黑白极简样式
    username: 'mapbox',
    styleId: 'light-v11'
  },
  request: {
    timeout: 10000
  }
};
