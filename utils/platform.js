/**
 * 运行环境判断：平台、朋友圈单页模式、版本类型。
 * 接口不可用或调用失败时一律按“普通环境”处理，不影响主流程。
 */
const config = require('./config');

// 从朋友圈打开的单页模式：只能浏览，不能登录、调用云开发或支付
const SINGLE_PAGE_SCENE = 1154;

function platform() {
  try {
    const info = wx.getDeviceInfo ? wx.getDeviceInfo() : wx.getSystemInfoSync();
    return (info && info.platform) || '';
  } catch (e) {
    return '';
  }
}

// iOS 端只能通过虚拟支付（Apple 支付）售卖虚拟商品（会员 / 单张解锁），由 config.payment.iosPurchase 控制入口。
// 开发者工具的 platform 为 devtools，不受影响，方便调试
function canPurchase() {
  return platform() !== 'ios' || config.payment.iosPurchase === true;
}

function isSinglePageMode() {
  try {
    const opts = wx.getEnterOptionsSync ? wx.getEnterOptionsSync() : wx.getLaunchOptionsSync();
    return !!opts && opts.scene === SINGLE_PAGE_SCENE;
  } catch (e) {
    return false;
  }
}

// 'develop' | 'trial' | 'release'
function envVersion() {
  try {
    return wx.getAccountInfoSync().miniProgram.envVersion || 'release';
  } catch (e) {
    return 'release';
  }
}

// 开发版 / 体验版：用于只给开发者看的配置提示
function isDevBuild() {
  return envVersion() !== 'release';
}

// 线上版本号，如 '1.0.0'；只有正式版有值
function version() {
  try {
    return wx.getAccountInfoSync().miniProgram.version || '';
  } catch (e) {
    return '';
  }
}

module.exports = { SINGLE_PAGE_SCENE, platform, canPurchase, isSinglePageMode, envVersion, isDevBuild, version };
