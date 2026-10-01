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

// 是否显示价格与购买入口。purchaseEnabled 是总开关（关闭时所有平台都只有免费额度与邀请码）；
// iOS 只能通过虚拟支付（Apple 支付）售卖虚拟商品，另由 iosPurchase 控制。
// 开发者工具的 platform 为 devtools，不受 iOS 开关影响，方便调试
function canPurchase() {
  if (config.payment.purchaseEnabled === false) return false;
  return platform() !== 'ios' || config.payment.iosPurchase === true;
}

// 付费面板里代替购买入口的说明
function purchaseNote() {
  if (canPurchase()) return '';
  return config.payment.purchaseEnabled === false ? '会员购买暂未开放，目前可使用每月免费额度和邀请码' : '由于相关规范，iOS 暂不支持在小程序内购买';
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

module.exports = { SINGLE_PAGE_SCENE, platform, canPurchase, purchaseNote, isSinglePageMode, envVersion, isDevBuild, version };
