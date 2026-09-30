const config = require('./utils/config');

App({
  onLaunch() {
    if (config.payment.mode === 'cloud') {
      if (wx.cloud) wx.cloud.init({ env: config.payment.cloud.env || undefined, traceUser: true });
      else console.error('当前基础库不支持云开发，请升级基础库');
    }
  }
});
