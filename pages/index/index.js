const exifParser = require('../../utils/exif-parser');
const mapService = require('../../utils/map-service');
const placeName = require('../../utils/place-name');
const themes = require('../../utils/themes');

const { hexToRgba } = themes;

/* ------------------------------------------------------------------ */
/* 常量与模板配置                                                       */
/* ------------------------------------------------------------------ */

// 海报逻辑尺寸 400 x 533.33（3:4）。所有绘制坐标基于逻辑单位，
// 预览按屏幕 dpr 缩放，导出按 3 倍缩放 => 1200 x 1600 px。
const POSTER_W = 400;
const POSTER_H = (POSTER_W * 4) / 3;
const EXPORT_SCALE = 3;
const MAX_CROP_ZOOM = 4;

// 支持取景调整（拖动 / 缩放）的模板及其照片区域（逻辑单位）
const CROP_REGIONS = {
  split: { top: POSTER_H * 0.4, w: POSTER_W, h: POSTER_H * 0.6 },
  medallion: { top: 0, w: POSTER_W, h: POSTER_H }
};
const DEFAULT_CROP = { zoom: 1, x: 0, y: 0 };

const SANS = '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Microsoft YaHei", sans-serif';
const SERIF = 'Georgia, "Times New Roman", "Songti SC", serif';
const TAGLINE = 'CAPTURED MOMENT · LASTING PLACE';

/**
 * 所有模板都请求整张海报比例（3:4）的地图，作为最底层背景，
 * 这样照片降低不透明度时可以与地图自然融合。
 * pin: 定位针在海报中的比例位置，用于避开被照片遮挡的区域（徽章模板中即圆心）
 */
const MAP_SIZE = { width: 600, height: 800 };
const TEMPLATES = [
  { id: 'polaroid', name: '拍立得', map: Object.assign({ pin: { x: 0.88, y: 0.5 } }, MAP_SIZE) },
  { id: 'split', name: '上下分割', map: Object.assign({ pin: { x: 0.5, y: 0.19 } }, MAP_SIZE) },
  { id: 'medallion', name: '地图徽章', map: Object.assign({ pin: { x: 0.18, y: 0.846 } }, MAP_SIZE) }
];

/* ------------------------------------------------------------------ */
/* 通用工具                                                             */
/* ------------------------------------------------------------------ */

function wxp(method, options) {
  return new Promise((resolve, reject) => {
    wx[method](Object.assign({}, options, { success: resolve, fail: reject }));
  });
}

function isCancel(err) {
  return !!(err && /cancel/i.test(err.errMsg || ''));
}

function loadImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// 图片对象与创建它的 canvas 绑定，因此缓存按 canvas 分开维护
function cachedImage(canvas, cache, src) {
  if (cache && cache.has(src)) return Promise.resolve(cache.get(src));
  return loadImage(canvas, src).then((img) => {
    if (cache) cache.set(src, img);
    return img;
  });
}

function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a += 0x6d2b79f5;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/* ------------------------------------------------------------------ */
/* Canvas 绘图基础函数（坐标均为逻辑单位）                                 */
/* ------------------------------------------------------------------ */

function setFont(ctx, size, weight, family, style) {
  ctx.font = `${style || 'normal'} ${weight || 400} ${size}px ${family || SANS}`;
}

function measureSpaced(ctx, text, spacing) {
  let w = 0;
  for (const ch of text) w += ctx.measureText(ch).width + spacing;
  return Math.max(0, w - spacing);
}

// 当前海报的文字不透明度（paintPoster 内同步设置）
let textAlpha = 1;

// 小程序 Canvas 2D 不保证支持 letterSpacing，这里逐字绘制实现字距
function drawSpacedText(ctx, text, x, y, spacing, align) {
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * textAlpha;
  ctx.textAlign = 'left';
  const total = measureSpaced(ctx, text, spacing);
  let cursor = x;
  if (align === 'center') cursor = x - total / 2;
  else if (align === 'right') cursor = x - total;
  for (const ch of text) {
    ctx.fillText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
  ctx.globalAlpha = prevAlpha;
}

// 让大字地名自适应宽度：从 maxSize 开始逐步缩小
function fitFontSize(ctx, text, maxWidth, maxSize, minSize, weight, family, spacing) {
  let size = maxSize;
  while (size > minSize) {
    setFont(ctx, size, weight, family);
    if (measureSpaced(ctx, text, spacing) <= maxWidth) break;
    size -= 1;
  }
  setFont(ctx, size, weight, family);
  return size;
}

const clamp = (v, min, max) => Math.min(max, Math.max(min, v));

/**
 * 计算 cover 裁切区域。crop = { zoom: 1~4, x: -1~1, y: -1~1 }：
 * zoom 在“刚好铺满”的基础上放大；x / y 为取景窗口在可移动范围内的归一化位置
 * （-1 = 最左 / 最上，0 = 居中，1 = 最右 / 最下），保证窗口永远不会越出图片。
 */
function coverRect(iw, ih, w, h, crop) {
  const zoom = clamp((crop && crop.zoom) || 1, 1, MAX_CROP_ZOOM);
  const r = Math.max(w / iw, h / ih) * zoom;
  const sw = w / r;
  const sh = h / r;
  const cx = iw / 2 + clamp((crop && crop.x) || 0, -1, 1) * ((iw - sw) / 2);
  const cy = ih / 2 + clamp((crop && crop.y) || 0, -1, 1) * ((ih - sh) / 2);
  return { sx: cx - sw / 2, sy: cy - sh / 2, sw, sh };
}

function drawImageCover(ctx, img, x, y, w, h, crop) {
  const c = coverRect(img.width, img.height, w, h, crop);
  ctx.drawImage(img, c.sx, c.sy, c.sw, c.sh, x, y, w, h);
}

function fitInside(img, maxW, maxH) {
  const r = Math.min(maxW / img.width, maxH / img.height);
  return { w: img.width * r, h: img.height * r };
}

// 无 token / 下载失败时的本地极简底图（按坐标做伪随机，同一位置结果稳定）
function drawFallbackMap(ctx, x, y, w, h, seed, pin, dark) {
  const rand = mulberry32(seed);
  ctx.fillStyle = dark ? '#1c1d1f' : '#ecebe7';
  ctx.fillRect(x, y, w, h);

  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.06)' : 'rgba(0,0,0,0.05)';
  ctx.lineWidth = 0.6;
  const step = 24;
  ctx.beginPath();
  for (let gx = x; gx <= x + w; gx += step) {
    ctx.moveTo(gx, y);
    ctx.lineTo(gx, y + h);
  }
  for (let gy = y; gy <= y + h; gy += step) {
    ctx.moveTo(x, gy);
    ctx.lineTo(x + w, gy);
  }
  ctx.stroke();

  ctx.fillStyle = dark ? '#2a2c31' : '#dedde9';
  ctx.globalAlpha = 0.45;
  ctx.beginPath();
  ctx.ellipse(x + w * (0.15 + rand() * 0.3), y + h * (0.6 + rand() * 0.3), w * 0.28, h * 0.12, rand(), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalAlpha = 1;

  ctx.lineCap = 'round';
  for (let i = 0; i < 16; i++) {
    const major = i % 4 === 0;
    ctx.strokeStyle = dark
      ? major ? 'rgba(255,255,255,0.32)' : 'rgba(255,255,255,0.14)'
      : major ? '#ffffff' : 'rgba(255,255,255,0.75)';
    ctx.lineWidth = major ? 3.2 : 1.4;
    ctx.beginPath();
    const sx = x + rand() * w;
    const sy = y + rand() * h;
    ctx.moveTo(sx, sy);
    ctx.bezierCurveTo(
      x + rand() * w,
      y + rand() * h,
      x + rand() * w,
      y + rand() * h,
      x + rand() * w,
      y + rand() * h
    );
    ctx.stroke();
  }

  if (pin) {
    const px = x + w * pin.x;
    const py = y + h * pin.y;
    ctx.fillStyle = dark ? '#111111' : '#ffffff';
    ctx.beginPath();
    ctx.arc(px, py, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dark ? '#ffffff' : '#111111';
    ctx.beginPath();
    ctx.arc(px, py, 3.6, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 用主题色给灰阶地图上色；设备不支持混合模式时退化为半透明色罩
function applyTint(ctx, theme, x, y, w, h) {
  const op = theme.dark ? 'screen' : 'multiply';
  ctx.save();
  ctx.globalCompositeOperation = op;
  if (ctx.globalCompositeOperation !== op) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.globalAlpha = 0.55;
  }
  ctx.fillStyle = theme.tint;
  ctx.fillRect(x, y, w, h);
  ctx.restore();
}

/**
 * 绘制带主题色与不透明度的地图区域。
 * 浅色：白底 -> 地图(alpha) -> multiply 主题色；深色：黑底 -> 地图(alpha) -> screen 主题色。
 * alpha=0 时恰为纯主题色。
 */
function drawMapRegion(ctx, mapImg, x, y, w, h, tpl, info, style) {
  const { theme } = style;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();

  ctx.fillStyle = theme.dark ? '#000000' : '#ffffff';
  ctx.fillRect(x, y, w, h);

  // 深色地图再压暗一档，避免 screen 叠加后主题色被“洗灰”
  ctx.globalAlpha = theme.dark ? style.mapAlpha * 0.6 : style.mapAlpha;
  if (mapImg) drawImageCover(ctx, mapImg, x, y, w, h);
  else drawFallbackMap(ctx, x, y, w, h, info.seed, tpl.map.pin, theme.dark);
  ctx.globalAlpha = 1;

  applyTint(ctx, theme, x, y, w, h);
  ctx.restore();
}

// 照片按不透明度绘制，低不透明度时会与下方的地图 / 主题色融合
function withAlpha(ctx, alpha, draw) {
  ctx.save();
  ctx.globalAlpha = alpha;
  draw();
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 三种海报样式                                                         */
/* ------------------------------------------------------------------ */

// 样式 A：地图全屏背景 + 拍立得相框（白边 + 投影）
function paintPolaroid(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);

  // 顶部：大字地名 + 坐标 / 日期
  ctx.fillStyle = ink;
  ctx.textBaseline = 'alphabetic';
  fitFontSize(ctx, info.place, W - 48, 46, 22, 800, SANS, 2);
  drawSpacedText(ctx, info.place, 24, 62, 2, 'left');

  ctx.fillStyle = hexToRgba(ink, 0.72);
  setFont(ctx, 8.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, 24, 82, 1.2, 'left');
  drawSpacedText(ctx, info.dateText, W - 24, 82, 1.2, 'right');

  // 拍立得相框
  const pad = 12;
  const bottom = 44;
  const photo = fitInside(assets.photo, 252, 300);
  const frameW = photo.w + pad * 2;
  const frameH = photo.h + pad + bottom;
  const areaTop = 100;
  const areaBottom = H - 40;
  const fx = (W - frameW) / 2;
  const fy = areaTop + (areaBottom - areaTop - frameH) / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.32)';
  ctx.shadowBlur = 26 * scale;
  ctx.shadowOffsetX = 0;
  ctx.shadowOffsetY = 10 * scale;
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(fx, fy, frameW, frameH);
  ctx.restore();

  withAlpha(ctx, style.photoAlpha, () => {
    ctx.drawImage(assets.photo, fx + pad, fy + pad, photo.w, photo.h);
  });
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 0.5;
  ctx.strokeRect(fx + pad, fy + pad, photo.w, photo.h);

  // 相框底边小字（相框本身是浅色，文字固定深色）
  const stripY = fy + pad + photo.h + 27;
  ctx.fillStyle = '#2a2a2a';
  setFont(ctx, 9.5, 400, SERIF, 'italic');
  drawSpacedText(ctx, info.place, fx + pad, stripY, 1, 'left');
  setFont(ctx, 8, 500, SANS);
  ctx.fillStyle = '#777777';
  drawSpacedText(ctx, info.dateText, fx + frameW - pad, stripY, 1, 'right');

  // 底部标语
  ctx.fillStyle = hexToRgba(ink, 0.85);
  setFont(ctx, 8, 400, SERIF);
  drawSpacedText(ctx, TAGLINE, W / 2, H - 20, 2.4, 'center');
}

// 样式 B：上 40% 地图 + 大字地名，下 60% 照片
function paintSplit(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const mapH = H * 0.4;
  const ink = style.theme.ink;

  // 地图铺满整张海报，照片不透明度 < 1 时下半部分会透出地图
  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, 0, mapH, W, H - mapH, style.crop);
  });

  ctx.fillStyle = hexToRgba(ink, 0.75);
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 8.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, 22, 30, 1.2, 'left');
  drawSpacedText(ctx, info.dateText, W - 22, 30, 1.2, 'right');

  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, W - 44, 66, 26, 800, SANS, 3);
  drawSpacedText(ctx, info.place, 22, mapH - 22, 3, 'left');

  ctx.fillStyle = style.photoAlpha >= 0.5 ? 'rgba(255,255,255,0.9)' : hexToRgba(ink, 0.8);
  setFont(ctx, 7.5, 400, SERIF);
  drawSpacedText(ctx, TAGLINE, W / 2, H - 16, 2.2, 'center');
}

// 样式 C：照片全屏 + 底部渐变 + 圆形地图徽章
function paintMedallion(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;
  const onPhoto = style.photoAlpha >= 0.5;
  const textColor = onPhoto ? '#ffffff' : ink;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);

  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, 0, 0, W, H, style.crop);
    const gradTop = H * 0.52;
    const grad = ctx.createLinearGradient(0, gradTop, 0, H);
    grad.addColorStop(0, 'rgba(0,0,0,0)');
    grad.addColorStop(1, 'rgba(0,0,0,0.72)');
    ctx.fillStyle = grad;
    ctx.fillRect(0, gradTop, W, H - gradTop);
  });

  // 徽章圆心与地图中的定位针位置一致（见 TEMPLATES）
  const r = 48;
  const cx = W * tpl.map.pin.x;
  const cy = H * tpl.map.pin.y;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 14 * scale;
  ctx.shadowOffsetY = 4 * scale;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, r + 3, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();

  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, Object.assign({}, style, { mapAlpha: 1 }));
  ctx.restore();

  const tx = cx + r + 18;
  const maxW = W - tx - 24;
  ctx.fillStyle = textColor;
  ctx.textBaseline = 'alphabetic';
  fitFontSize(ctx, info.place, maxW, 40, 18, 800, SANS, 2);
  drawSpacedText(ctx, info.place, tx, cy - 2, 2, 'left');

  ctx.fillStyle = onPhoto ? 'rgba(255,255,255,0.85)' : hexToRgba(ink, 0.8);
  setFont(ctx, 8.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, tx, cy + 18, 1.1, 'left');
  drawSpacedText(ctx, info.dateText, tx, cy + 34, 1.1, 'left');

  ctx.fillStyle = onPhoto ? 'rgba(255,255,255,0.8)' : hexToRgba(ink, 0.7);
  setFont(ctx, 7.5, 400, SERIF);
  drawSpacedText(ctx, TAGLINE, W / 2, H - 14, 2.2, 'center');
}

function paintEmpty(ctx) {
  const W = POSTER_W;
  const H = POSTER_H;
  ctx.fillStyle = '#efeeea';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 0.6;
  ctx.strokeRect(20, 20, W - 40, H - 40);
  ctx.fillStyle = '#1a1a1a';
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 30, 800, SANS);
  drawSpacedText(ctx, 'GEOPICS', W / 2, H / 2 - 6, 5, 'center');
  ctx.fillStyle = '#8a8a86';
  setFont(ctx, 9, 400, SERIF, 'italic');
  drawSpacedText(ctx, 'SELECT A PHOTO TO BEGIN', W / 2, H / 2 + 18, 2.4, 'center');
}

const PAINTERS = {
  polaroid: paintPolaroid,
  split: paintSplit,
  medallion: paintMedallion
};

/**
 * 统一入口：在任意 2D canvas 上绘制整张海报。
 * @param canvas  Canvas 2D 节点（其 width/height 已设置为物理像素）
 * @param assets  { photo: Image, map: Image|null } 为 null 时绘制占位
 * @param style   { theme, mapAlpha, photoAlpha, textAlpha }，透明度范围 0~1
 */
function paintPoster(canvas, tplId, assets, info, style) {
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / POSTER_W;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  if (!assets) {
    paintEmpty(ctx);
    return;
  }
  const tpl = TEMPLATES.find((t) => t.id === tplId) || TEMPLATES[0];
  textAlpha = style.textAlpha;
  PAINTERS[tpl.id](ctx, scale, assets, info, tpl, style);
  textAlpha = 1;
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

Page({
  data: {
    templates: TEMPLATES,
    templateId: 'polaroid',
    hasPhoto: false,
    photoPath: '',
    coordText: '',
    dateText: '',
    place: '',
    placeLang: 'en',
    placeManual: false,
    hasLocation: false,
    searchVisible: false,
    searchKeyword: '',
    searchResults: [],
    searching: false,
    searchEmpty: false,
    zoom: 12,
    themes: themes.THEMES.concat([{ id: themes.CUSTOM_ID, name: '自定义', tint: themes.DEFAULT_CUSTOM_HEX }]),
    mapColorId: themes.DEFAULT_THEME_ID,
    customHex: themes.DEFAULT_CUSTOM_HEX,
    customHexText: themes.DEFAULT_CUSTOM_HEX,
    cropEnabled: false,
    cropZoom: 100,
    cropX: 0,
    cropY: 0,
    mapOpacity: 100,
    photoOpacity: 100,
    textOpacity: 100,
    canvasStyle: '',
    busy: false,
    busyText: '',
    tokenMissing: !mapService.hasToken()
  },

  onLoad() {
    // 非 data 状态：与渲染无关，避免多余的 setData
    this.poster = {
      photoPath: '',
      lat: null,
      lon: null,
      place: '',
      fallbackName: '',
      coordText: '',
      dateText: ''
    };
    this._renderId = 0;
    this.crops = {};
    this._photoSize = null;
    this._locId = 0;
    this._searchId = 0;
    this._geoCache = {};
    this._searchTimer = null;
    this._placeTimer = null;
    this._imgCache = new Map();
    this._mapCache = {};
    this._mapWarned = false;

    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const cssW = Math.floor(Math.min(win.windowWidth - 48, 440));
    const cssH = Math.round((cssW * 4) / 3);
    this.cssSize = { w: cssW, h: cssH };
    this.dpr = Math.min(win.pixelRatio || 2, 3);
    this.setData({ canvasStyle: `width:${cssW}px;height:${cssH}px;` });
  },

  onReady() {
    this.initPreviewCanvas();
  },

  /* ---------------------------- canvas 初始化 ---------------------------- */

  queryCanvas(selector) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .select(selector)
        .fields({ node: true, size: true })
        .exec((res) => {
          if (res && res[0] && res[0].node) resolve(res[0].node);
          else reject(new Error(`canvas ${selector} not found`));
        });
    });
  },

  async initPreviewCanvas() {
    try {
      const canvas = await this.queryCanvas('#posterCanvas');
      canvas.width = Math.round(this.cssSize.w * this.dpr);
      canvas.height = Math.round(this.cssSize.h * this.dpr);
      this.preview = canvas;
      this.render();
    } catch (e) {
      console.error('init canvas failed', e);
    }
  },

  /* ---------------------------- 交互事件 ---------------------------- */

  showBusy(text) {
    this.setData({ busy: true, busyText: text || '' });
  },

  hideBusy() {
    this.setData({ busy: false, busyText: '' });
  },

  async onChoosePhoto() {
    let filePath;
    try {
      const res = await wxp('chooseMedia', {
        count: 1,
        mediaType: ['image'],
        // 必须原图：压缩后的图片会丢失 EXIF（含 GPS）
        sizeType: ['original'],
        sourceType: ['album']
      });
      filePath = res.tempFiles[0].tempFilePath;
    } catch (e) {
      if (!isCancel(e)) wx.showToast({ title: '选择图片失败', icon: 'none' });
      return;
    }

    this.showBusy('读取照片信息…');
    this._locId += 1;
    this._imgCache = new Map();
    this.crops = {};
    this._photoSize = null;
    this.poster = {
      photoPath: filePath,
      lat: null,
      lon: null,
      place: '',
      fallbackName: '',
      coordText: '',
      dateText: ''
    };

    const exif = await exifParser.extractFromFile(filePath);
    this.poster.dateText = exif.dateText || exifParser.formatDate(new Date());

    this.setData({
      hasPhoto: true,
      photoPath: filePath,
      hasLocation: false,
      coordText: '',
      dateText: this.poster.dateText,
      place: '',
      placeManual: false,
      cropZoom: 100,
      cropX: 0,
      cropY: 0
    });

    if (exif.hasGps) {
      await this.applyLocation(exif.latitude, exif.longitude, '');
      this.hideBusy();
      return;
    }

    this.hideBusy();
    this.poster.place = 'UNKNOWN';
    this.setData({ place: 'UNKNOWN' });
    this.render();

    const modal = await wxp('showModal', {
      title: '未读取到位置',
      content: '未读取到位置，请在地图上手动选择',
      confirmText: '去选择',
      cancelText: '暂不',
      confirmColor: '#111111'
    }).catch(() => ({ confirm: false }));
    if (modal.confirm) await this.onPickLocation();
  },

  async onPickLocation() {
    if (!this.data.hasPhoto) {
      wx.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    // wx.chooseLocation 使用腾讯地图，海外无法定位；配置了 Mapbox 时提供全球搜索
    if (!mapService.hasToken()) {
      await this.pickWithWechatMap();
      return;
    }
    let tapIndex;
    try {
      ({ tapIndex } = await wxp('showActionSheet', {
        itemList: ['搜索地点（全球）', '地图选点（微信地图，仅国内）']
      }));
    } catch (e) {
      return;
    }
    if (tapIndex === 0) {
      this.setData({ searchVisible: true, searchKeyword: '', searchResults: [], searching: false, searchEmpty: false });
    } else {
      await this.pickWithWechatMap();
    }
  },

  async pickWithWechatMap() {
    let loc;
    try {
      loc = await wxp('chooseLocation', {});
    } catch (e) {
      if (!isCancel(e)) wx.showToast({ title: '无法打开地图选点', icon: 'none' });
      return;
    }
    if (!loc || typeof loc.latitude !== 'number') return;

    // chooseLocation 返回 GCJ-02，需转换为 WGS-84 才能与 Mapbox 对齐
    const wgs = mapService.gcj02ToWgs84(loc.latitude, loc.longitude);
    this.showBusy('生成海报…');
    await this.applyLocation(wgs.lat, wgs.lon, loc.name || '');
    this.hideBusy();
  },

  /* ---------------------------- 全球地点搜索 ---------------------------- */

  noop() {},

  onSearchClose() {
    this._searchId += 1;
    clearTimeout(this._searchTimer);
    this.setData({ searchVisible: false, searching: false });
  },

  onSearchInput(e) {
    const keyword = e.detail.value;
    this.setData({ searchKeyword: keyword });
    clearTimeout(this._searchTimer);
    if (!keyword.trim()) {
      this._searchId += 1;
      this.setData({ searchResults: [], searching: false, searchEmpty: false });
      return;
    }
    this._searchTimer = setTimeout(() => this.runSearch(keyword), 350);
  },

  onSearchConfirm(e) {
    clearTimeout(this._searchTimer);
    this.runSearch(e.detail.value);
  },

  async runSearch(keyword) {
    if (!keyword.trim()) return;
    const searchId = ++this._searchId;
    this.setData({ searching: true, searchEmpty: false });
    const results = await mapService.searchPlaces(keyword, this.data.placeLang);
    if (searchId !== this._searchId) return;
    this.setData({ searching: false, searchResults: results, searchEmpty: results.length === 0 });
  },

  async onSelectResult(e) {
    const hit = this.data.searchResults[e.currentTarget.dataset.index];
    if (!hit) return;
    this.onSearchClose();
    this.showBusy('生成海报…');
    await this.applyLocation(hit.lat, hit.lon, hit.name);
    this.hideBusy();
  },

  /* ---------------------------- 地名：手动修改 / 语言切换 ---------------------------- */

  onPlaceInput(e) {
    const value = e.detail.value;
    this.poster.place = value;
    this.setData({ place: value, placeManual: true });
    clearTimeout(this._placeTimer);
    this._placeTimer = setTimeout(() => this.render(), 200);
  },

  onPlaceReset() {
    if (this.data.hasLocation) {
      this.resolvePlace(++this._locId);
    } else {
      this.poster.place = 'UNKNOWN';
      this.setData({ place: 'UNKNOWN', placeManual: false });
      this.render();
    }
  },

  onPlaceLangChange(e) {
    const lang = e.currentTarget.dataset.lang;
    if (lang === this.data.placeLang) return;
    this.setData({ placeLang: lang }, () => {
      if (this.data.hasLocation) this.resolvePlace(++this._locId);
    });
  },

  onTapTemplate(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.templateId) return;
    this.setData({ templateId: id }, () => {
      this.syncCropData();
      this.render();
    });
  },

  /* ---------------------------- 照片取景（拖动 / 缩放） ---------------------------- */

  getCrop(tplId) {
    return this.crops[tplId] || DEFAULT_CROP;
  },

  setCrop(tplId, patch) {
    const cur = this.getCrop(tplId);
    this.crops[tplId] = {
      zoom: clamp(patch.zoom === undefined ? cur.zoom : patch.zoom, 1, MAX_CROP_ZOOM),
      x: clamp(patch.x === undefined ? cur.x : patch.x, -1, 1),
      y: clamp(patch.y === undefined ? cur.y : patch.y, -1, 1)
    };
  },

  // 把当前模板的取景参数同步到滑块
  syncCropData() {
    const tplId = this.data.templateId;
    const crop = this.getCrop(tplId);
    this.setData({
      cropEnabled: !!CROP_REGIONS[tplId],
      cropZoom: Math.round(crop.zoom * 100),
      cropX: Math.round(crop.x * 100),
      cropY: Math.round(crop.y * 100)
    });
  },

  onCropSlider(e) {
    const tplId = this.data.templateId;
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (key === 'cropZoom') this.setCrop(tplId, { zoom: value / 100 });
    if (key === 'cropX') this.setCrop(tplId, { x: value / 100 });
    if (key === 'cropY') this.setCrop(tplId, { y: value / 100 });
    this.setData({ [key]: value });
    this.scheduleRender();
  },

  onResetCrop() {
    delete this.crops[this.data.templateId];
    this.syncCropData();
    this.render();
  },

  onCanvasTouchStart(e) {
    const tplId = this.data.templateId;
    const region = CROP_REGIONS[tplId];
    if (!region || !this._photoSize || !e.touches.length) return;

    const t = e.touches[0];
    // 拼接图仅在照片区域内拖动才调整取景，避免误触地图区
    if (typeof t.y === 'number') {
      const logicalY = (t.y * POSTER_W) / this.cssSize.w;
      if (logicalY < region.top || logicalY > region.top + region.h) {
        this._gesture = null;
        return;
      }
    }
    const crop = this.getCrop(tplId);
    this._gesture = { tplId, start: crop, x: t.clientX, y: t.clientY, dist: 0 };
    if (e.touches.length >= 2) this._gesture.dist = this.touchDistance(e.touches);
  },

  onCanvasTouchMove(e) {
    const g = this._gesture;
    if (!g || !this._photoSize) return;
    const region = CROP_REGIONS[g.tplId];
    const { w: iw, h: ih } = this._photoSize;
    const k = POSTER_W / this.cssSize.w;

    // 双指缩放
    if (e.touches.length >= 2) {
      const dist = this.touchDistance(e.touches);
      if (!g.dist) {
        g.dist = dist;
        g.start = this.getCrop(g.tplId);
      } else if (dist > 0) {
        this.setCrop(g.tplId, { zoom: g.start.zoom * (dist / g.dist) });
        this.scheduleRender();
      }
      return;
    }

    // 单指拖动：手指向右 => 取景窗口向左移动
    const t = e.touches[0];
    const cover = Math.max(region.w / iw, region.h / ih) * g.start.zoom;
    const sw = region.w / cover;
    const sh = region.h / cover;
    const slackX = (iw - sw) / 2;
    const slackY = (ih - sh) / 2;
    const dx = (t.clientX - g.x) * k;
    const dy = (t.clientY - g.y) * k;
    this.setCrop(g.tplId, {
      x: slackX > 0.5 ? g.start.x - (dx * (sw / region.w)) / slackX : g.start.x,
      y: slackY > 0.5 ? g.start.y - (dy * (sh / region.h)) / slackY : g.start.y
    });
    this.scheduleRender();
  },

  onCanvasTouchEnd(e) {
    if (!this._gesture) return;
    if (e.touches && e.touches.length === 1) {
      // 双指抬起一根：以剩余手指重新作为拖动起点
      const t = e.touches[0];
      this._gesture = { tplId: this._gesture.tplId, start: this.getCrop(this._gesture.tplId), x: t.clientX, y: t.clientY, dist: 0 };
      return;
    }
    this._gesture = null;
    this.syncCropData();
  },

  touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  },

  /* ---------------------------- 地图配色 / 不透明度 ---------------------------- */

  onTapTheme(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.mapColorId) return;
    this.setData({ mapColorId: id }, () => this.render());
  },

  onCustomHexInput(e) {
    const text = e.detail.value;
    const hex = themes.parseHex(text);
    const patch = { customHexText: text };
    if (hex) {
      patch.customHex = hex;
      patch.themes = this.data.themes.map((t) => (t.id === themes.CUSTOM_ID ? Object.assign({}, t, { tint: hex }) : t));
    }
    this.setData(patch, () => {
      if (hex) this.scheduleRender();
    });
  },

  onOpacityChanging(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value });
    this.scheduleRender();
  },

  onOpacityChange(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value }, () => this.render());
  },

  onResetOpacity() {
    this.setData({ mapOpacity: 100, photoOpacity: 100, textOpacity: 100 }, () => this.render());
  },

  // 拖动滑块时合并高频更新，避免每一帧都重绘
  scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this.render();
    }, 40);
  },

  onZoomChanging(e) {
    this.setData({ zoom: e.detail.value });
  },

  onZoomChange(e) {
    this.setData({ zoom: e.detail.value }, () => this.render());
  },

  /* ---------------------------- 位置与地名 ---------------------------- */

  async applyLocation(lat, lon, fallbackName) {
    const locId = ++this._locId;
    const coords = exifParser.formatCoordinates(lat, lon);
    this.poster.lat = lat;
    this.poster.lon = lon;
    this.poster.fallbackName = fallbackName || '';
    this.poster.coordText = coords.text;
    this.poster.place = 'LOCATING…';
    this.setData({ hasLocation: true, coordText: coords.text, place: this.poster.place, placeManual: false });
    await this.resolvePlace(locId);
  },

  // 按当前语言设置解析地名：服务商结果 -> 备用名（如选点名称）-> UNKNOWN。
  // 英文模式下若拿到的是汉字，短名转拼音、长名转首字母缩写。
  async resolvePlace(locId) {
    const { lat, lon, fallbackName } = this.poster;
    const lang = this.data.placeLang;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)},${lang}`;

    let geo = this._geoCache[key];
    if (geo === undefined) {
      geo = await mapService.reverseGeocode(lat, lon, lang);
      if (geo) this._geoCache[key] = geo;
    }
    if (locId !== this._locId) return;

    const place = placeName.normalizePlaceName((geo && geo.name) || fallbackName, lang) || 'UNKNOWN';
    this.poster.place = place;
    this.setData({ place, placeManual: false });
    await this.render();
  },

  /* ---------------------------- 渲染 ---------------------------- */

  // 下载当前模板/缩放对应的静态地图，失败时返回 null（画布回退到本地底图）
  async ensureMapFile(tpl, dark) {
    const { lat, lon } = this.poster;
    if (lat === null || lon === null) return null;
    const url = mapService.buildStaticMapUrl({
      lat,
      lon,
      zoom: this.data.zoom,
      width: tpl.map.width,
      height: tpl.map.height,
      pin: tpl.map.pin,
      dark
    });
    if (!url) return null;
    if (this._mapCache[url]) return this._mapCache[url];
    try {
      const path = await mapService.downloadImage(url);
      this._mapCache[url] = path;
      return path;
    } catch (e) {
      console.warn('map download failed', e);
      if (!this._mapWarned) {
        this._mapWarned = true;
        wx.showToast({ title: '地图加载失败，已使用简约底图', icon: 'none' });
      }
      return null;
    }
  },

  async loadAssets(canvas, cache, tpl, style) {
    const [photo, mapPath] = await Promise.all([
      cachedImage(canvas, cache, this.poster.photoPath),
      this.ensureMapFile(tpl, style.theme.dark)
    ]);
    let map = null;
    if (mapPath) {
      try {
        map = await cachedImage(canvas, cache, mapPath);
      } catch (e) {
        map = null;
      }
    }
    return { photo, map };
  },

  // 当前配色与不透明度（0~1）
  buildStyle() {
    const d = this.data;
    return {
      theme: themes.resolveTheme(d.mapColorId, d.customHex),
      mapAlpha: d.mapOpacity / 100,
      photoAlpha: d.photoOpacity / 100,
      textAlpha: d.textOpacity / 100,
      crop: this.getCrop(d.templateId)
    };
  },

  buildInfo() {
    const p = this.poster;
    const seed =
      p.lat === null ? 7 : Math.floor((p.lat + 90) * 1000) * 397 + Math.floor((p.lon + 180) * 1000);
    return {
      place: p.place || 'UNKNOWN',
      coordText: p.coordText || '-- ° --  -- ° --',
      dateText: p.dateText || '',
      seed
    };
  },

  async render() {
    if (!this.preview) return;
    const renderId = ++this._renderId;
    const canvas = this.preview;
    const tplId = this.data.templateId;
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    const style = this.buildStyle();

    if (!this.poster.photoPath) {
      paintPoster(canvas, tplId, null, null, style);
      return;
    }

    let assets;
    try {
      assets = await this.loadAssets(canvas, this._imgCache, tpl, style);
    } catch (e) {
      console.error('load assets failed', e);
      wx.showToast({ title: '图片加载失败', icon: 'none' });
      return;
    }
    // 期间用户切换了模板/照片：丢弃过期结果
    if (renderId !== this._renderId) return;
    this._photoSize = { w: assets.photo.width, h: assets.photo.height };
    paintPoster(canvas, tplId, assets, this.buildInfo(), style);
  },

  /* ---------------------------- 导出 ---------------------------- */

  async onSavePoster() {
    if (!this.data.hasPhoto) {
      wx.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    if (this.data.busy) return;
    this.showBusy('生成高清海报…');

    try {
      // 页面外的隐藏 canvas 作为离屏画布：物理尺寸 1200 x 1600（3 倍）
      const canvas = await this.queryCanvas('#exportCanvas');
      canvas.width = POSTER_W * EXPORT_SCALE;
      canvas.height = Math.round(POSTER_H * EXPORT_SCALE);

      const tplId = this.data.templateId;
      const tpl = TEMPLATES.find((t) => t.id === tplId);
      // 离屏画布不复用预览缓存，使用独立的 Image 对象
      const style = this.buildStyle();
      const assets = await this.loadAssets(canvas, null, tpl, style);
      paintPoster(canvas, tplId, assets, this.buildInfo(), style);

      const { tempFilePath } = await wxp('canvasToTempFilePath', {
        canvas,
        x: 0,
        y: 0,
        width: canvas.width,
        height: canvas.height,
        destWidth: canvas.width,
        destHeight: canvas.height,
        fileType: 'jpg',
        quality: 1
      });

      await this.saveToAlbum(tempFilePath);
    } catch (e) {
      console.error('export failed', e);
      if (!isCancel(e)) wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    } finally {
      this.hideBusy();
    }
  },

  async saveToAlbum(filePath) {
    try {
      await wxp('saveImageToPhotosAlbum', { filePath });
      wx.showToast({ title: '已保存到相册', icon: 'success' });
    } catch (e) {
      if (isCancel(e)) return;
      if (/auth/i.test(e.errMsg || '')) {
        const res = await wxp('showModal', {
          title: '需要相册权限',
          content: '请在设置中允许保存到相册后重试',
          confirmText: '去设置',
          confirmColor: '#111111'
        }).catch(() => ({ confirm: false }));
        if (res.confirm) wx.openSetting({});
        return;
      }
      throw e;
    }
  }
});
