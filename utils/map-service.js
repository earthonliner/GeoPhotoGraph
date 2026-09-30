/**
 * map-service.js
 *
 * - Mapbox 逆地理编码（经纬度 -> 大写英文地名）
 * - Mapbox Static Images API URL 拼接（黑白极简样式 + 定位针）
 * - 静态图下载
 * - GCJ-02 -> WGS-84（wx.chooseLocation 返回的是 GCJ-02，Mapbox 使用 WGS-84）
 */

const config = require('./config');

const MAX_STATIC_SIZE = 1280; // Static Images API 单边上限（@2x 前）
const MAX_LAT = 85.051129;

function hasToken() {
  return !!(config.mapbox && config.mapbox.token);
}

/* ------------------------------------------------------------------ */
/* Web Mercator                                                         */
/* ------------------------------------------------------------------ */

// Mapbox GL 的 zoom 对应 512px 瓦片，世界宽度 = 512 * 2^zoom
function project(lat, lon, zoom) {
  const size = 512 * Math.pow(2, zoom);
  const s = Math.sin((Math.max(-MAX_LAT, Math.min(MAX_LAT, lat)) * Math.PI) / 180);
  return {
    x: ((lon + 180) / 360) * size,
    y: (0.5 - Math.log((1 + s) / (1 - s)) / (4 * Math.PI)) * size
  };
}

function unproject(x, y, zoom) {
  const size = 512 * Math.pow(2, zoom);
  const lon = (x / size) * 360 - 180;
  const n = Math.PI - (2 * Math.PI * y) / size;
  const lat = (180 / Math.PI) * Math.atan(0.5 * (Math.exp(n) - Math.exp(-n)));
  return { lat, lon };
}

/**
 * 计算地图中心点，使目标坐标落在图片 (fx, fy) 比例位置（0~1）。
 * 用于让定位针避开被照片遮挡的区域。
 */
function centerForPinAt(lat, lon, zoom, width, height, fx, fy) {
  const p = project(lat, lon, zoom);
  return unproject(p.x + width * (0.5 - fx), p.y + height * (0.5 - fy), zoom);
}

/* ------------------------------------------------------------------ */
/* Static Images API                                                    */
/* ------------------------------------------------------------------ */

/**
 * 拼接 Mapbox Static Images URL：
 * https://api.mapbox.com/styles/v1/{username}/{style_id}/static/pin-s+000({lon},{lat})/{lon},{lat},{zoom},0/{width}x{height}@2x?access_token={token}
 *
 * 与固定居中的模板不同，这里允许通过 pin={x,y} 指定定位针在图中的比例位置，
 * 此时中心点会被平移，pin 覆盖层仍使用真实经纬度。
 *
 * @returns {string} 未配置 token 时返回空字符串
 */
function buildStaticMapUrl(opts) {
  if (!hasToken()) return '';
  const { lat, lon, zoom = 12, pin, retina = true } = opts;
  const width = Math.max(1, Math.min(MAX_STATIC_SIZE, Math.round(opts.width)));
  const height = Math.max(1, Math.min(MAX_STATIC_SIZE, Math.round(opts.height)));
  const { token, username, styleId } = config.mapbox;

  const center = pin ? centerForPinAt(lat, lon, zoom, width, height, pin.x, pin.y) : { lat, lon };
  const marker = `pin-s+000(${lon.toFixed(6)},${lat.toFixed(6)})`;
  const view = `${center.lon.toFixed(6)},${center.lat.toFixed(6)},${zoom},0`;

  return (
    `https://api.mapbox.com/styles/v1/${username}/${styleId}/static/${marker}/${view}/` +
    `${width}x${height}${retina ? '@2x' : ''}?access_token=${token}`
  );
}

function downloadImage(url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      timeout: config.request.timeout,
      success: (res) => {
        if (res.statusCode === 200 && res.tempFilePath) resolve(res.tempFilePath);
        else reject(new Error(`map download failed: ${res.statusCode}`));
      },
      fail: reject
    });
  });
}

/* ------------------------------------------------------------------ */
/* 逆地理编码                                                           */
/* ------------------------------------------------------------------ */

const PLACE_PRIORITY = ['place', 'locality', 'district', 'region', 'country'];

/**
 * 经纬度 -> 大写英文地名，如 ZERMATT / HONG KONG / FRANKFURT
 * @returns {Promise<{name:string, country:string}|null>} 失败或无 token 时为 null
 */
function reverseGeocode(lat, lon) {
  if (!hasToken()) return Promise.resolve(null);
  const { token, language } = config.mapbox;
  const url =
    `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon.toFixed(6)},${lat.toFixed(6)}.json` +
    `?types=${PLACE_PRIORITY.join(',')}&language=${language}&access_token=${token}`;

  return new Promise((resolve) => {
    wx.request({
      url,
      timeout: config.request.timeout,
      success: (res) => {
        const features = (res.data && res.data.features) || [];
        let picked = null;
        for (const type of PLACE_PRIORITY) {
          picked = features.find((f) => (f.place_type || []).indexOf(type) >= 0);
          if (picked) break;
        }
        if (!picked) return resolve(null);
        const ctx = picked.context || [];
        const country = ctx.find((c) => /^country/.test(c.id || ''));
        resolve({
          name: String(picked.text_en || picked.text || '').toUpperCase(),
          country: country ? String(country.text_en || country.text).toUpperCase() : ''
        });
      },
      fail: () => resolve(null)
    });
  });
}

/* ------------------------------------------------------------------ */
/* GCJ-02 -> WGS-84                                                     */
/* ------------------------------------------------------------------ */

const PI = Math.PI;
const A = 6378245.0;
const EE = 0.00669342162296594323;

function inChina(lat, lon) {
  return lon >= 72.004 && lon <= 137.8347 && lat >= 0.8293 && lat <= 55.8271;
}

function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(y * PI) + 40.0 * Math.sin((y / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((160.0 * Math.sin((y / 12.0) * PI) + 320 * Math.sin((y * PI) / 30.0)) * 2.0) / 3.0;
  return ret;
}

function transformLon(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += ((20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0) / 3.0;
  ret += ((20.0 * Math.sin(x * PI) + 40.0 * Math.sin((x / 3.0) * PI)) * 2.0) / 3.0;
  ret += ((150.0 * Math.sin((x / 12.0) * PI) + 300.0 * Math.sin((x / 30.0) * PI)) * 2.0) / 3.0;
  return ret;
}

function gcj02ToWgs84(lat, lon) {
  if (!inChina(lat, lon)) return { lat, lon };
  let dLat = transformLat(lon - 105.0, lat - 35.0);
  let dLon = transformLon(lon - 105.0, lat - 35.0);
  const radLat = (lat / 180.0) * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / (((A * (1 - EE)) / (magic * sqrtMagic)) * PI);
  dLon = (dLon * 180.0) / ((A / sqrtMagic) * Math.cos(radLat) * PI);
  return { lat: lat - dLat, lon: lon - dLon };
}

module.exports = {
  hasToken,
  buildStaticMapUrl,
  downloadImage,
  reverseGeocode,
  gcj02ToWgs84,
  centerForPinAt
};
