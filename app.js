const config = require('./utils/config');
const platform = require('./utils/platform');

App({
  onLaunch() {
    // 朋友圈单页模式不能使用云开发，页面也不会调用
    if (config.payment.mode === 'cloud' && !platform.isSinglePageMode()) {
      if (wx.cloud) wx.cloud.init({ env: config.payment.cloud.env || undefined, traceUser: true });
      else console.error('当前基础库不支持云开发，请升级基础库');
    }
  }
});
