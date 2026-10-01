/**
 * 内容安全（小程序端）。检测都在云函数 api 里完成（cloudfunctions/api/security.js），这里只负责：
 *   文本：isTextSafe(text)，同一段文本的结果缓存在内存里；
 *   图片：submitImage(filePath) 把缩小后的副本传到云存储并提交检测，得到 traceId；imageStatus(traceId) 查询结果。
 * 只有 payment.mode = 'cloud' 且 security.enabled 时才会检测；检测服务不可用（断网、频率限制等）一律放行，
 * 不能因为检测服务的问题让用户无法使用。违规时页面只提示“内容含违规信息”。
 */
const config = require('./config');

const CHECK_SIDE = 720;
const CHECK_QUALITY = 60;

function wxp(method, options) {
  return new Promise((resolve, reject) => {
    wx[method](Object.assign({}, options, { success: resolve, fail: reject }));
  });
}

function enabled() {
  return !!config.security && config.security.enabled !== false && config.payment.mode === 'cloud' && !!wx.cloud;
}

async function call(action, data) {
  const res = await wx.cloud.callFunction({ name: config.payment.cloud.api, data: Object.assign({ action }, data) });
  const result = res && res.result;
  if (!result || typeof result !== 'object') throw new Error(`${action} failed`);
  return result;
}

const verdicts = new Map();

// 已有结果时返回 true / false，没检测过返回 undefined
function cachedVerdict(text) {
  return verdicts.get(String(text || '').trim());
}

async function isTextSafe(text) {
  const key = String(text || '').trim();
  if (!key || !enabled()) return true;
  if (verdicts.has(key)) return verdicts.get(key);
  try {
    const r = await call('checkText', { text: key });
    if (!r.ok) return true;
    const safe = r.safe !== false;
    if (!r.skipped) verdicts.set(key, safe);
    return safe;
  } catch (e) {
    console.warn('text check unavailable', e);
    return true;
  }
}

// 检测只需要小图：缩小到长边 720px，减少上传量
async function smallCopy(filePath) {
  try {
    const info = await wxp('getImageInfo', { src: filePath });
    const long = Math.max(info.width, info.height);
    const k = long > CHECK_SIDE ? CHECK_SIDE / long : 1;
    const res = await wxp('compressImage', {
      src: filePath,
      quality: CHECK_QUALITY,
      compressedWidth: Math.round(info.width * k),
      compressedHeight: Math.round(info.height * k)
    });
    return res.tempFilePath || filePath;
  } catch (e) {
    return filePath;
  }
}

async function submitImage(filePath) {
  if (!enabled() || !filePath) return '';
  let fileID = '';
  try {
    const src = await smallCopy(filePath);
    const cloudPath = `seccheck/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.jpg`;
    ({ fileID } = await wx.cloud.uploadFile({ cloudPath, filePath: src }));
    const r = await call('checkImage', { fileID });
    return r.ok && r.traceId ? r.traceId : '';
  } catch (e) {
    console.warn('image check unavailable', e);
    if (fileID && wx.cloud.deleteFile) wx.cloud.deleteFile({ fileList: [fileID] }).catch(() => {});
    return '';
  }
}

// 'pending' | 'pass' | 'risky' | 'unknown'
async function imageStatus(traceId) {
  try {
    const r = await call('imageResult', { traceId });
    return r.ok && r.status ? r.status : 'unknown';
  } catch (e) {
    return 'unknown';
  }
}

function clearCache() {
  verdicts.clear();
}

module.exports = { enabled, isTextSafe, cachedVerdict, submitImage, imageStatus, clearCache };
