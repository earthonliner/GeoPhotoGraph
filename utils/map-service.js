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
 * dark=true 时使用 darkStyleId。
 * 与固定居中的模板不同，这里允许通过 pin={x,y} 指定定位针在图中的比例位置，
 * 此时中心点会被平移，pin 覆盖层仍使用真实经纬度。
 * 自带的标志与署名角标会随模板裁切被遮挡，因此关闭（attribution / logo=false），
 * 改由海报在固定位置绘制 Mapbox 标志与“© Mapbox © OpenStreetMap”（见 poster/core.js drawMapCredit）。
 *
 * @returns {string} 未配置 token 时返回空字符串
 */
function buildStaticMapUrl(opts) {
  if (!hasToken()) return '';
  const { lat, lon, zoom = 12, pin, retina = true, dark = false } = opts;
  const width = Math.max(1, Math.min(MAX_STATIC_SIZE, Math.round(opts.width)));
  const height = Math.max(1, Math.min(MAX_STATIC_SIZE, Math.round(opts.height)));
  const { token, username } = config.mapbox;
  const styleId = dark ? config.mapbox.darkStyleId : config.mapbox.styleId;

  const center = pin ? centerForPinAt(lat, lon, zoom, width, height, pin.x, pin.y) : { lat, lon };
  const marker = `pin-s+000(${lon.toFixed(6)},${lat.toFixed(6)})`;
  const view = `${center.lon.toFixed(6)},${center.lat.toFixed(6)},${zoom},0`;

  return (
    `https://api.mapbox.com/styles/v1/${username}/${styleId}/static/${marker}/${view}/` +
    `${width}x${height}${retina ? '@2x' : ''}?attribution=false&logo=false&access_token=${token}`
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
const GEOCODE_TYPES = PLACE_PRIORITY.concat(['neighborhood']);

// 'en' -> 英文；'zh' -> 简体中文。Mapbox 在目标语言缺失时会回退为当地语言。
function mapboxLanguage(lang) {
  return lang === 'zh' ? 'zh-Hans' : 'en';
}

function geocodingRequest(path, query) {
  const params = Object.keys(query)
    .map((k) => `${k}=${encodeURIComponent(query[k])}`)
    .join('&');
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${path}.json?${params}&access_token=${config.mapbox.token}`;
  return new Promise((resolve) => {
    wx.request({
      url,
      timeout: config.request.timeout,
      success: (res) => resolve(res.statusCode === 200 ? (res.data && res.data.features) || [] : []),
      fail: () => resolve([])
    });
  });
}

function pickPlaceFeature(features) {
  for (const type of PLACE_PRIORITY) {
    const hit = features.find((f) => (f.place_type || []).indexOf(type) >= 0);
    if (hit) return hit;
  }
  return null;
}

/**
 * 经纬度 -> 地名（未做大小写 / 拼音处理，交给 place-name.js）
 * @param {'en'|'zh'} lang
 * @returns {Promise<{name:string, country:string}|null>} 失败或无 token 时为 null
 */
async function reverseGeocode(lat, lon, lang) {
  if (!hasToken()) return null;
  const features = await geocodingRequest(`${lon.toFixed(6)},${lat.toFixed(6)}`, {
    types: GEOCODE_TYPES.join(','),
    language: mapboxLanguage(lang)
  });
  const picked = pickPlaceFeature(features);
  if (!picked) return null;

  // 各层级的名称：先取顶层结果，缺失的再从所选结果的 context 中补全
  const parts = {};
  const typeKey = { place: 'city', locality: 'locality', district: 'district', region: 'region', country: 'country', neighborhood: 'neighborhood' };
  features.forEach((f) => {
    (f.place_type || []).forEach((t) => {
      if (typeKey[t] && !parts[typeKey[t]]) parts[typeKey[t]] = String(f.text || '');
    });
  });
  (picked.context || []).forEach((c) => {
    const t = String(c.id || '').split('.')[0];
    if (typeKey[t] && !parts[typeKey[t]]) parts[typeKey[t]] = String(c.text || '');
  });
  const country = (picked.context || []).find((c) => /^country/.test(c.id || ''));
  return {
    // name 为“城市级”名称（向后兼容）；更细的层级见 parts，由 place-name.formatPlace 组合
    name: String(picked.text || ''),
    country: country ? String(country.text || '') : parts.country || '',
    parts
  };
}

/**
 * 全球地点搜索（Mapbox 正向地理编码），用于替代仅覆盖国内的 wx.chooseLocation。
 * @returns {Promise<Array<{name:string, address:string, lat:number, lon:number}>>}
 */
async function searchPlaces(keyword, lang) {
  const q = String(keyword || '').trim();
  if (!hasToken() || !q) return [];
  const features = await geocodingRequest(encodeURIComponent(q), {
    autocomplete: 'true',
    limit: 8,
    language: mapboxLanguage(lang)
  });
  return features
    .filter((f) => Array.isArray(f.center) && f.center.length === 2)
    .map((f) => ({
      name: String(f.text || ''),
      address: String(f.place_name || ''),
      lon: f.center[0],
      lat: f.center[1]
    }));
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
  searchPlaces,
  mapboxLanguage,
  gcj02ToWgs84,
  centerForPinAt
};
