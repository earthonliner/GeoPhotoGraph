const exifParser = require('../../utils/exif-parser');
const mapService = require('../../utils/map-service');
const placeName = require('../../utils/place-name');
const themes = require('../../utils/themes');

const { hexToRgba } = themes;
const batchUtil = require('../../utils/batch');
const membership = require('../../utils/membership');
const payment = require('../../utils/payment');
const appConfig = require('../../utils/config');

/* ------------------------------------------------------------------ */
/* 常量与模板配置                                                       */
/* ------------------------------------------------------------------ */

// 海报逻辑尺寸 400 x 533.33（3:4）。所有绘制坐标基于逻辑单位，
// 预览按屏幕 dpr 缩放，导出按 3 倍缩放 => 1200 x 1600 px。
const POSTER_W = 400;
const POSTER_H = (POSTER_W * 4) / 3;
const EXPORT_SCALE = 3;
// 底端品牌栏（可选）拼接在海报下方，整张图高度 = POSTER_H + FOOTER_H
const FOOTER_H = 64;
const MAX_CROP_ZOOM = 4;
const MAX_BATCH = 9;
const FOOTER_KEY = 'geopics.footer';

const posterHeight = (footer) => POSTER_H + (footer ? FOOTER_H : 0);
const exportSizeText = (footer) => `${POSTER_W * EXPORT_SCALE} × ${Math.round(posterHeight(footer) * EXPORT_SCALE)}`;
// 界面强调色（iOS 系统蓝），用于系统弹窗按钮
const TINT = '#007AFF';

// 各模板中照片的取景区域（逻辑单位）；胶片 / 明信片的照片框固定，其余为整版或下半版
const FILM_PHOTO = { left: 68, top: 50, w: 264, h: 368 };
const POSTCARD_PHOTO = { left: 40, top: 46, w: 320, h: 236 };
const FULL_PHOTO = { left: 0, top: 0, w: POSTER_W, h: POSTER_H };
const MAT_PHOTO = { left: 28, top: 28, w: 344, h: 404 };
const BAR_H = 100;
const BAR_PHOTO = { left: 0, top: 0, w: POSTER_W, h: POSTER_H - BAR_H };
const RAIL_W = 64;
const RAIL_PHOTO = { left: 0, top: 0, w: POSTER_W - RAIL_W, h: POSTER_H };
const CINEMA_PHOTO = { left: 0, top: 116, w: POSTER_W, h: 260 };

// 支持取景调整（拖动 / 缩放）的模板；拍立得与画廊展签完整显示照片，不需要裁切
const CROP_REGIONS = {
  split: { left: 0, top: POSTER_H * 0.4, w: POSTER_W, h: POSTER_H * 0.6 },
  medallion: FULL_PHOTO,
  magazine: FULL_PHOTO,
  film: FILM_PHOTO,
  postcard: POSTCARD_PHOTO,
  glass: FULL_PHOTO,
  typo: FULL_PHOTO,
  mat: MAT_PHOTO,
  bar: BAR_PHOTO,
  frame: FULL_PHOTO,
  rail: RAIL_PHOTO,
  cinema: CINEMA_PHOTO,
  coord: FULL_PHOTO
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
const CENTER_PIN = { x: 0.5, y: 0.5 };
const tplMap = (pin) => Object.assign({ pin }, MAP_SIZE);

// category：模板所属分类；hot：同时出现在“热门”分类里
const TEMPLATES = [
  { id: 'polaroid', name: '拍立得', category: 'classic', hot: true, map: tplMap({ x: 0.88, y: 0.5 }) },
  { id: 'split', name: '上下分割', category: 'classic', map: tplMap({ x: 0.5, y: 0.19 }) },
  { id: 'medallion', name: '地图徽章', category: 'classic', map: tplMap({ x: 0.18, y: 0.846 }) },
  { id: 'mat', name: '极简白卡', category: 'minimal', hot: true, map: tplMap(CENTER_PIN) },
  { id: 'bar', name: '底栏', category: 'minimal', hot: true, map: tplMap(CENTER_PIN) },
  { id: 'frame', name: '细框', category: 'minimal', hot: true, map: tplMap(CENTER_PIN) },
  { id: 'rail', name: '侧栏', category: 'minimal', map: tplMap(CENTER_PIN) },
  { id: 'cinema', name: '影幕', category: 'minimal', map: tplMap(CENTER_PIN) },
  { id: 'coord', name: '坐标', category: 'minimal', map: tplMap(CENTER_PIN) },
  { id: 'magazine', name: '杂志封面', category: 'editorial', hot: true, map: tplMap(CENTER_PIN) },
  { id: 'glass', name: '玻璃卡片', category: 'editorial', hot: true, map: tplMap(CENTER_PIN) },
  { id: 'typo', name: '巨字', category: 'editorial', map: tplMap(CENTER_PIN) },
  { id: 'film', name: '胶片', category: 'retro', map: tplMap(CENTER_PIN) },
  { id: 'postcard', name: '明信片', category: 'retro', map: tplMap(CENTER_PIN) },
  { id: 'gallery', name: '画廊展签', category: 'retro', map: tplMap({ x: 0.9, y: 0.28 }) }
];

const HOT_CATEGORY = 'hot';
const CATEGORIES = [
  { id: HOT_CATEGORY, name: '热门' },
  { id: 'minimal', name: '简约' },
  { id: 'classic', name: '经典' },
  { id: 'editorial', name: '杂志' },
  { id: 'retro', name: '复古' }
];

function templatesOf(categoryId) {
  return TEMPLATES.filter((t) => (categoryId === HOT_CATEGORY ? t.hot : t.category === categoryId));
}


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
function drawSpacedText(ctx, text, x, y, spacing, align, mode) {
  const prevAlpha = ctx.globalAlpha;
  ctx.globalAlpha = prevAlpha * textAlpha;
  ctx.textAlign = 'left';
  const total = measureSpaced(ctx, text, spacing);
  let cursor = x;
  if (align === 'center') cursor = x - total / 2;
  else if (align === 'right') cursor = x - total;
  for (const ch of text) {
    if (mode !== 'stroke') ctx.fillText(ch, cursor, y);
    if (mode === 'stroke' || mode === 'both') ctx.strokeText(ch, cursor, y);
    cursor += ctx.measureText(ch).width + spacing;
  }
  ctx.globalAlpha = prevAlpha;
}

// 让大字地名自适应宽度：从 maxSize 开始逐步缩小
function fitFontSize(ctx, text, maxWidth, maxSize, minSize, weight, family, spacing, style) {
  let size = maxSize;
  // 名称特别长时允许比 minSize 再缩小一些，宁可小一点也不要超出边界
  const floor = Math.max(6, Math.floor(minSize * 0.6));
  while (size > floor) {
    setFont(ctx, size, weight, family, style);
    if (measureSpaced(ctx, text, spacing) <= maxWidth) break;
    size -= 1;
  }
  setFont(ctx, size, weight, family, style);
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

/* ------------------------------------------------------------------ */
/* 氛围模板：杂志封面 / 胶片 / 明信片 / 画廊展签 / 玻璃卡片 / 巨字            */
/* ------------------------------------------------------------------ */

function roundedRectPath(ctx, x, y, w, h, r) {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

/**
 * 以定位针为中心，从整张地图上截取 1:1 的一小块（迷你地图），并按主题上色。
 * 调用方可先设置圆角 / 圆形 clip。
 */
function drawMapWindow(ctx, mapImg, x, y, w, h, tpl, info, style) {
  const { theme } = style;
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.fillStyle = theme.dark ? '#000000' : '#ffffff';
  ctx.fillRect(x, y, w, h);
  ctx.globalAlpha = theme.dark ? 0.6 : 1;
  if (mapImg) {
    const k = mapImg.width / POSTER_W;
    const sw = Math.min(w * k, mapImg.width);
    const sh = Math.min(h * k, mapImg.height);
    const sx = clamp(mapImg.width * tpl.map.pin.x - sw / 2, 0, mapImg.width - sw);
    const sy = clamp(mapImg.height * tpl.map.pin.y - sh / 2, 0, mapImg.height - sh);
    ctx.drawImage(mapImg, sx, sy, sw, sh, x, y, w, h);
  } else {
    drawFallbackMap(ctx, x, y, w, h, info.seed, { x: 0.5, y: 0.5 }, theme.dark);
  }
  ctx.globalAlpha = 1;
  applyTint(ctx, theme, x, y, w, h);
  ctx.restore();
}

function photoText(style) {
  const onPhoto = style.photoAlpha >= 0.5;
  const ink = style.theme.ink;
  return {
    main: onPhoto ? '#ffffff' : ink,
    sub: onPhoto ? 'rgba(255,255,255,0.82)' : hexToRgba(ink, 0.8)
  };
}

// 全屏照片 + 上下暗角，杂志封面 / 玻璃卡片 / 巨字共用
function drawFullBleedPhoto(ctx, assets, style, topShade, bottomShade) {
  const W = POSTER_W;
  const H = POSTER_H;
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, 0, 0, W, H, style.crop);
    if (topShade) {
      const g = ctx.createLinearGradient(0, 0, 0, H * 0.4);
      g.addColorStop(0, `rgba(0,0,0,${topShade})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.fillStyle = g;
      ctx.fillRect(0, 0, W, H * 0.4);
    }
    if (bottomShade) {
      const g = ctx.createLinearGradient(0, H * 0.5, 0, H);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, `rgba(0,0,0,${bottomShade})`);
      ctx.fillStyle = g;
      ctx.fillRect(0, H * 0.5, W, H * 0.5);
    }
  });
}

// 杂志封面：超大衬线刊头 + 细线栏目 + 封面标语 + 迷你地图
function paintMagazine(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { main, sub } = photoText(style);

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  drawFullBleedPhoto(ctx, assets, style, 0.5, 0.62);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = main;
  const size = fitFontSize(ctx, info.place, W - 44, 96, 30, 700, SERIF, 3);
  const baseline = 30 + size * 0.8;
  drawSpacedText(ctx, info.place, W / 2, baseline, 3, 'center');

  ctx.strokeStyle = sub;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(22, baseline + 14);
  ctx.lineTo(W - 22, baseline + 14);
  ctx.stroke();
  ctx.fillStyle = sub;
  setFont(ctx, 8, 500, SANS);
  drawSpacedText(ctx, info.dateText, 22, baseline + 29, 1.6, 'left');
  drawSpacedText(ctx, info.coordText, W - 22, baseline + 29, 1.2, 'right');

  const mapSize = 92;
  const mx = W - 22 - mapSize;
  const my = H - 24 - mapSize;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.4)';
  ctx.shadowBlur = 14 * scale;
  ctx.shadowOffsetY = 4 * scale;
  ctx.fillStyle = '#ffffff';
  roundedRectPath(ctx, mx - 2.5, my - 2.5, mapSize + 5, mapSize + 5, 6);
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundedRectPath(ctx, mx, my, mapSize, mapSize, 4);
  ctx.clip();
  drawMapWindow(ctx, assets.map, mx, my, mapSize, mapSize, tpl, info, style);
  ctx.restore();

  ctx.fillStyle = sub;
  setFont(ctx, 7.5, 600, SANS);
  drawSpacedText(ctx, 'SPECIAL ISSUE', 22, H - 104, 3.2, 'left');
  ctx.fillStyle = main;
  setFont(ctx, 27, 400, SERIF, 'italic');
  drawSpacedText(ctx, 'Captured Moment,', 22, H - 70, 0.4, 'left');
  drawSpacedText(ctx, 'Lasting Place.', 22, H - 40, 0.4, 'left');
}

const FILM_STRIP = { x: 44, w: POSTER_W - 88 };
const FILM_AMBER = '#f2a03d';
const MONTH_INDEX = { JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, OCT: 10, NOV: 11, DEC: 12 };

// 相机背刻风格日期： '24 06 16
function filmDate(dateText) {
  const m = /^([A-Z]{3}) (\d{1,2}), (\d{4})$/.exec(dateText || '');
  if (!m || !MONTH_INDEX[m[1]]) return dateText || '';
  const pad = (n) => String(n).padStart(2, '0');
  return `'${m[3].slice(2)}  ${pad(MONTH_INDEX[m[1]])}  ${pad(Number(m[2]))}`;
}

// 胶片：暗房底色 + 35mm 片基与齿孔 + 琥珀色背刻日期
function paintFilm(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  ctx.fillStyle = 'rgba(9,8,7,0.88)';
  ctx.fillRect(0, 0, W, H);

  const sx = FILM_STRIP.x;
  const sw = FILM_STRIP.w;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.6)';
  ctx.shadowBlur = 18 * scale;
  ctx.fillStyle = '#17130f';
  ctx.fillRect(sx, 0, sw, H);
  ctx.restore();

  ctx.fillStyle = 'rgba(236,228,212,0.92)';
  for (let y = 9; y < H - 8; y += 21) {
    roundedRectPath(ctx, sx + 9, y, 9, 12, 2.2);
    ctx.fill();
    roundedRectPath(ctx, sx + sw - 18, y, 9, 12, 2.2);
    ctx.fill();
  }

  const p = FILM_PHOTO;
  ctx.fillStyle = '#000000';
  ctx.fillRect(p.left - 1, p.top - 1, p.w + 2, p.h + 2);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = FILM_AMBER;
  setFont(ctx, 7, 700, SANS);
  drawSpacedText(ctx, 'GEOPICS 400', p.left, 38, 1.8, 'left');
  drawSpacedText(ctx, '12A', p.left + p.w, 38, 1.8, 'right');

  const bottom = p.top + p.h;
  ctx.save();
  ctx.shadowColor = 'rgba(242,160,61,0.85)';
  ctx.shadowBlur = 5 * scale;
  ctx.fillStyle = FILM_AMBER;
  setFont(ctx, 15, 600, SANS);
  drawSpacedText(ctx, filmDate(info.dateText), p.left, bottom + 30, 2.2, 'left');
  ctx.restore();

  ctx.fillStyle = '#efe9dd';
  const maxW = p.w - 70;
  fitFontSize(ctx, info.place, maxW, 24, 12, 700, SANS, 3);
  drawSpacedText(ctx, info.place, p.left, bottom + 54, 3, 'left');
  ctx.fillStyle = 'rgba(239,233,221,0.6)';
  setFont(ctx, 7.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, p.left, bottom + 70, 1.2, 'left');

  const ms = 54;
  const mx = p.left + p.w - ms;
  const my = bottom + 14;
  ctx.save();
  roundedRectPath(ctx, mx, my, ms, ms, 3);
  ctx.clip();
  drawMapWindow(ctx, assets.map, mx, my, ms, ms, tpl, info, style);
  ctx.restore();
  ctx.strokeStyle = 'rgba(239,233,221,0.7)';
  ctx.lineWidth = 0.8;
  roundedRectPath(ctx, mx, my, ms, ms, 3);
  ctx.stroke();

  ctx.fillStyle = 'rgba(242,160,61,0.75)';
  setFont(ctx, 6, 500, SANS);
  drawSpacedText(ctx, TAGLINE, W / 2, H - 12, 1.8, 'center');
}

function drawPerforatedStamp(ctx, x, y, w, h, holeColor) {
  ctx.fillStyle = '#fffdf6';
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = holeColor;
  const step = 8;
  for (let px = x + step / 2; px < x + w; px += step) {
    ctx.beginPath();
    ctx.arc(px, y, 2.4, 0, Math.PI * 2);
    ctx.arc(px, y + h, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
  for (let py = y + step / 2; py < y + h; py += step) {
    ctx.beginPath();
    ctx.arc(x, py, 2.4, 0, Math.PI * 2);
    ctx.arc(x + w, py, 2.4, 0, Math.PI * 2);
    ctx.fill();
  }
}

// 明信片：纸张卡片 + 拍立得式照片 + 手写地址线 + 邮票 + 邮戳
function paintPostcard(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const paper = '#f7f1e3';

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);

  const cx = 22;
  const cy = 26;
  const cw = W - 44;
  const ch = H - 52;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 22 * scale;
  ctx.shadowOffsetY = 8 * scale;
  ctx.fillStyle = paper;
  roundedRectPath(ctx, cx, cy, cw, ch, 4);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(120,100,70,0.22)';
  ctx.lineWidth = 0.6;
  ctx.strokeRect(cx + 7, cy + 7, cw - 14, ch - 14);

  const p = POSTCARD_PHOTO;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(p.left - 4, p.top - 4, p.w + 8, p.h + 8);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  ctx.textBaseline = 'alphabetic';
  const ty = p.top + p.h + 24;
  ctx.fillStyle = '#8a7c66';
  setFont(ctx, 7.5, 600, SANS);
  drawSpacedText(ctx, 'GREETINGS FROM', p.left, ty, 3, 'left');
  ctx.fillStyle = '#2b2622';
  fitFontSize(ctx, info.place, 200, 36, 16, 700, SERIF, 1, 'italic');
  drawSpacedText(ctx, info.place, p.left, ty + 38, 1, 'left');

  ctx.save();
  ctx.strokeStyle = 'rgba(60,50,40,0.38)';
  ctx.lineWidth = 0.6;
  ctx.setLineDash([2, 3]);
  const lines = [ty + 62, ty + 84, ty + 106];
  lines.forEach((ly) => {
    ctx.beginPath();
    ctx.moveTo(p.left, ly);
    ctx.lineTo(p.left + 168, ly);
    ctx.stroke();
  });
  ctx.restore();
  ctx.fillStyle = '#5a4d3c';
  setFont(ctx, 9.5, 400, SERIF, 'italic');
  drawSpacedText(ctx, info.coordText, p.left + 2, lines[0] - 3, 0.6, 'left');
  drawSpacedText(ctx, info.dateText, p.left + 2, lines[1] - 3, 0.6, 'left');
  drawSpacedText(ctx, 'Wish you were here', p.left + 2, lines[2] - 3, 0.6, 'left');

  const stampW = 80;
  const stampH = 100;
  const sx = p.left + p.w - stampW;
  const sy = p.top + p.h + 14;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.18)';
  ctx.shadowBlur = 5 * scale;
  ctx.shadowOffsetY = 1.5 * scale;
  drawPerforatedStamp(ctx, sx, sy, stampW, stampH, paper);
  ctx.restore();
  drawPerforatedStamp(ctx, sx, sy, stampW, stampH, paper);
  ctx.save();
  ctx.beginPath();
  ctx.rect(sx + 7, sy + 7, stampW - 14, stampH - 32);
  ctx.clip();
  drawMapWindow(ctx, assets.map, sx + 7, sy + 7, stampW - 14, stampH - 32, tpl, info, style);
  ctx.restore();
  ctx.fillStyle = '#3a3a3a';
  setFont(ctx, 7.5, 800, SANS);
  drawSpacedText(ctx, 'GEOPICS', sx + stampW / 2, sy + stampH - 14, 2.2, 'center');
  setFont(ctx, 5.5, 500, SANS);
  ctx.fillStyle = '#8a8a86';
  drawSpacedText(ctx, 'AIR MAIL', sx + stampW / 2, sy + stampH - 6.5, 1.8, 'center');

  // 邮戳：斜置双圈 + 地名日期 + 波浪消印线
  const pmx = sx - 6;
  const pmy = sy + stampH - 26;
  ctx.save();
  ctx.translate(pmx, pmy);
  ctx.rotate((-12 * Math.PI) / 180);
  ctx.globalAlpha = 0.78;
  ctx.strokeStyle = '#30426e';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(0, 0, 30, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(0, 0, 25, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1.1;
  for (let i = -2; i <= 2; i++) {
    ctx.beginPath();
    for (let x = -100; x <= -33; x += 2) {
      const y = i * 5.5 + Math.sin(x / 4.2) * 2;
      if (x === -100) ctx.moveTo(x, y);
      else ctx.lineTo(x, y);
    }
    ctx.stroke();
  }
  ctx.fillStyle = '#30426e';
  fitFontSize(ctx, info.place, 40, 9, 5, 800, SANS, 0.8);
  drawSpacedText(ctx, info.place, 0, -2, 0.8, 'center');
  setFont(ctx, 5.5, 600, SANS);
  drawSpacedText(ctx, info.dateText, 0, 9, 0.5, 'center');
  ctx.restore();

  ctx.fillStyle = '#8a7c66';
  setFont(ctx, 7, 400, SERIF);
  drawSpacedText(ctx, TAGLINE, W / 2, cy + ch - 18, 2.2, 'center');
}

// 画廊展签：地图作墙面，黑框 + 白色卡纸 + 博物馆式说明牌
function paintGallery(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = hexToRgba(ink, 0.7);
  setFont(ctx, 7.5, 500, SERIF);
  drawSpacedText(ctx, 'PERMANENT COLLECTION', W / 2, 34, 3.4, 'center');

  const bandTop = 54;
  const bandH = 358;
  const mat = 24;
  const photo = fitInside(assets.photo, 240, 310);
  const fw = photo.w + mat * 2;
  const fh = photo.h + mat * 2;
  const fx = (W - fw) / 2;
  const fy = bandTop + (bandH - fh) / 2;

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.38)';
  ctx.shadowBlur = 28 * scale;
  ctx.shadowOffsetY = 12 * scale;
  ctx.fillStyle = '#181614';
  ctx.fillRect(fx - 4, fy - 4, fw + 8, fh + 8);
  ctx.restore();
  ctx.fillStyle = '#faf8f2';
  ctx.fillRect(fx, fy, fw, fh);
  ctx.strokeStyle = 'rgba(0,0,0,0.22)';
  ctx.lineWidth = 0.8;
  ctx.strokeRect(fx + mat - 1, fy + mat - 1, photo.w + 2, photo.h + 2);
  withAlpha(ctx, style.photoAlpha, () => {
    ctx.drawImage(assets.photo, fx + mat, fy + mat, photo.w, photo.h);
  });

  const pw = 176;
  const ph = 60;
  const px = fx + fw - pw;
  const py = bandTop + bandH + 22;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 8 * scale;
  ctx.shadowOffsetY = 2 * scale;
  ctx.fillStyle = '#fdfcf8';
  ctx.fillRect(px, py, pw, ph);
  ctx.restore();
  ctx.fillStyle = '#1a1a1a';
  fitFontSize(ctx, info.place, pw - 24, 11, 7, 800, SANS, 1.6);
  drawSpacedText(ctx, info.place, px + 12, py + 19, 1.6, 'left');
  ctx.fillStyle = '#555555';
  setFont(ctx, 8.5, 400, SERIF, 'italic');
  drawSpacedText(ctx, info.coordText, px + 12, py + 33, 0.4, 'left');
  ctx.fillStyle = '#8a8a86';
  setFont(ctx, 6.5, 500, SANS);
  drawSpacedText(ctx, `${info.dateText}  ·  ARCHIVAL PIGMENT PRINT`, px + 12, py + 48, 0.9, 'left');

  ctx.fillStyle = hexToRgba(ink, 0.7);
  setFont(ctx, 7.5, 400, SERIF);
  drawSpacedText(ctx, TAGLINE, W / 2, H - 20, 2.4, 'center');
}

// 玻璃卡片：全屏照片 + 底部半透明深色玻璃面板（含迷你地图）
function paintGlass(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  drawFullBleedPhoto(ctx, assets, style, 0.28, 0.25);

  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 8, 600, SANS);
  const chipText = info.dateText;
  const chipW = measureSpaced(ctx, chipText, 1.6) + 36;
  const chipX = 20;
  const chipY = 22;
  ctx.fillStyle = 'rgba(18,20,24,0.42)';
  roundedRectPath(ctx, chipX, chipY, chipW, 24, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.32)';
  ctx.lineWidth = 0.6;
  ctx.stroke();
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(chipX + 13, chipY + 12, 2.8, 0, Math.PI * 2);
  ctx.fill();
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  drawSpacedText(ctx, chipText, chipX + 23, chipY + 15.3, 1.6, 'left');

  const x = 20;
  const y = H - 176;
  const w = W - 40;
  const h = 156;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 24 * scale;
  ctx.shadowOffsetY = 8 * scale;
  const glass = ctx.createLinearGradient(x, y, x + w, y + h);
  glass.addColorStop(0, 'rgba(24,27,32,0.62)');
  glass.addColorStop(1, 'rgba(14,16,20,0.42)');
  ctx.fillStyle = glass;
  roundedRectPath(ctx, x, y, w, h, 22);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.28)';
  ctx.lineWidth = 0.8;
  roundedRectPath(ctx, x, y, w, h, 22);
  ctx.stroke();

  const ms = 128;
  const mx = x + 14;
  const my = y + 14;
  ctx.save();
  roundedRectPath(ctx, mx, my, ms, ms, 16);
  ctx.clip();
  drawMapWindow(ctx, assets.map, mx, my, ms, ms, tpl, info, style);
  ctx.restore();
  ctx.strokeStyle = 'rgba(255,255,255,0.5)';
  ctx.lineWidth = 0.8;
  roundedRectPath(ctx, mx, my, ms, ms, 16);
  ctx.stroke();

  const tx = mx + ms + 18;
  const tw = x + w - 16 - tx;
  ctx.fillStyle = 'rgba(255,255,255,0.6)';
  setFont(ctx, 6.5, 600, SANS);
  drawSpacedText(ctx, 'LOCATION', tx, y + 30, 3, 'left');
  ctx.fillStyle = '#ffffff';
  fitFontSize(ctx, info.place, tw, 32, 14, 800, SANS, 1.6);
  drawSpacedText(ctx, info.place, tx, y + 64, 1.6, 'left');
  ctx.strokeStyle = 'rgba(255,255,255,0.3)';
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  ctx.moveTo(tx, y + 78);
  ctx.lineTo(tx + tw, y + 78);
  ctx.stroke();
  ctx.fillStyle = 'rgba(255,255,255,0.86)';
  setFont(ctx, 8.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, tx, y + 98, 1, 'left');
  drawSpacedText(ctx, info.dateText, tx, y + 114, 1, 'left');
  ctx.fillStyle = 'rgba(255,255,255,0.55)';
  setFont(ctx, 6.5, 400, SERIF, 'italic');
  drawSpacedText(ctx, TAGLINE, tx, y + 140, 0.9, 'left');
}

// 巨字：全屏照片 + 镂空巨型地名 + 竖排标语 + 圆形迷你地图
function paintTypo(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const onPhoto = style.photoAlpha >= 0.5;
  const { main, sub } = photoText(style);

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  drawFullBleedPhoto(ctx, assets, style, 0.3, 0.42);
  withAlpha(ctx, style.photoAlpha, () => {
    ctx.fillStyle = 'rgba(0,0,0,0.16)';
    ctx.fillRect(0, 0, W, H);
  });

  ctx.textBaseline = 'alphabetic';
  ctx.lineJoin = 'round';
  const size = fitFontSize(ctx, info.place, W - 28, 140, 38, 900, SANS, 2);
  const baseline = H * 0.7;
  ctx.fillStyle = onPhoto ? 'rgba(255,255,255,0.14)' : hexToRgba(style.theme.ink, 0.12);
  ctx.strokeStyle = main;
  ctx.lineWidth = Math.max(0.9, size / 90);
  drawSpacedText(ctx, info.place, 14, baseline, 2, 'left', 'both');

  ctx.strokeStyle = sub;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(20, baseline + 18);
  ctx.lineTo(W - 20, baseline + 18);
  ctx.stroke();
  ctx.fillStyle = main;
  setFont(ctx, 8.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, 20, baseline + 36, 1.6, 'left');
  drawSpacedText(ctx, info.dateText, W - 20, baseline + 36, 1.6, 'right');

  const r = 30;
  const mx = 20 + r;
  const my = 22 + r;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.35)';
  ctx.shadowBlur = 12 * scale;
  ctx.shadowOffsetY = 3 * scale;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(mx, my, r + 2.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(mx, my, r, 0, Math.PI * 2);
  ctx.clip();
  drawMapWindow(ctx, assets.map, mx - r, my - r, r * 2, r * 2, tpl, info, style);
  ctx.restore();

  ctx.fillStyle = main;
  setFont(ctx, 9, 800, SANS);
  drawSpacedText(ctx, 'GEOPICS', W - 20, 40, 4.2, 'right');

  ctx.save();
  ctx.translate(W - 15, 190);
  ctx.rotate(-Math.PI / 2);
  ctx.fillStyle = sub;
  setFont(ctx, 6.5, 500, SERIF);
  drawSpacedText(ctx, TAGLINE, 0, 0, 3.2, 'center');
  ctx.restore();
}

/* ------------------------------------------------------------------ */
/* 简约模板（适合批量）：白卡 / 底栏 / 细框 / 侧栏 / 影幕 / 坐标            */
/* 版式固定、文字量少，照片方向与地名长短不同也能保持整批统一               */
/* ------------------------------------------------------------------ */

function splitCoord(info) {
  const parts = (info.coordText || '').split('  ');
  return { lat: parts[0] || '', lon: parts[1] || '' };
}

// 极简白卡：宽边留白，照片下方一行细字说明
function paintMat(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;
  const p = MAT_PHOTO;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  ctx.textBaseline = 'alphabetic';
  const baseline = p.top + p.h + 36;
  ctx.fillStyle = ink;
  setFont(ctx, 8.5, 500, SANS);
  const dateW = measureSpaced(ctx, info.dateText, 1.4);
  fitFontSize(ctx, info.place, W - p.left * 2 - dateW - 24, 17, 9, 700, SANS, 3);
  drawSpacedText(ctx, info.place, p.left, baseline, 3, 'left');
  setFont(ctx, 8.5, 500, SANS);
  ctx.fillStyle = hexToRgba(ink, 0.75);
  drawSpacedText(ctx, info.dateText, W - p.left, baseline, 1.4, 'right');

  ctx.strokeStyle = hexToRgba(ink, 0.25);
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(p.left, baseline + 14);
  ctx.lineTo(W - p.left, baseline + 14);
  ctx.stroke();

  ctx.fillStyle = hexToRgba(ink, 0.6);
  setFont(ctx, 7.5, 400, SANS);
  drawSpacedText(ctx, info.coordText, p.left, baseline + 31, 1.2, 'left');
}

// 底栏：照片通栏，底部一条主题色信息栏，右侧迷你地图
function paintBar(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;
  const p = BAR_PHOTO;
  const top = H - BAR_H;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  const ms = 60;
  const mx = W - 24 - ms;
  const my = top + (BAR_H - ms) / 2;
  ctx.save();
  roundedRectPath(ctx, mx, my, ms, ms, 6);
  ctx.clip();
  drawMapWindow(ctx, assets.map, mx, my, ms, ms, tpl, info, style);
  ctx.restore();
  ctx.strokeStyle = hexToRgba(ink, 0.3);
  ctx.lineWidth = 0.6;
  roundedRectPath(ctx, mx, my, ms, ms, 6);
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, mx - 16 - 24, 22, 11, 800, SANS, 2);
  drawSpacedText(ctx, info.place, 24, top + 42, 2, 'left');
  ctx.fillStyle = hexToRgba(ink, 0.72);
  setFont(ctx, 8, 500, SANS);
  drawSpacedText(ctx, info.coordText, 24, top + 62, 1.1, 'left');
  drawSpacedText(ctx, info.dateText, 24, top + 78, 1.1, 'left');
}

// 细框：整幅照片 + 内缩发丝线框，地名居中置于底部
function paintFrame(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { main, sub } = photoText(style);

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  drawFullBleedPhoto(ctx, assets, style, 0.2, 0.5);

  const inset = 16;
  ctx.strokeStyle = sub;
  ctx.lineWidth = 0.8;
  ctx.strokeRect(inset, inset, W - inset * 2, H - inset * 2);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = sub;
  setFont(ctx, 7.5, 500, SANS);
  drawSpacedText(ctx, info.dateText, W / 2, inset + 26, 4, 'center');

  ctx.fillStyle = main;
  fitFontSize(ctx, info.place, W - 96, 30, 13, 300, SANS, 8);
  drawSpacedText(ctx, info.place, W / 2, H - 78, 8, 'center');

  ctx.strokeStyle = sub;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(W / 2 - 14, H - 64);
  ctx.lineTo(W / 2 + 14, H - 64);
  ctx.stroke();

  ctx.fillStyle = sub;
  setFont(ctx, 7.5, 400, SANS);
  drawSpacedText(ctx, info.coordText, W / 2, H - 46, 2.4, 'center');
}

// 侧栏：左侧照片，右侧细长主题色栏，竖排地名从下往上阅读，顶部圆形迷你地图
function paintRail(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;
  const p = RAIL_PHOTO;
  const cx = W - RAIL_W / 2;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  const r = 17;
  const my = 42;
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, my, r, 0, Math.PI * 2);
  ctx.clip();
  drawMapWindow(ctx, assets.map, cx - r, my - r, r * 2, r * 2, tpl, info, style);
  ctx.restore();
  ctx.strokeStyle = hexToRgba(ink, 0.35);
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(cx, my, r, 0, Math.PI * 2);
  ctx.stroke();

  ctx.save();
  ctx.translate(cx - 3, H - 30);
  ctx.rotate(-Math.PI / 2);
  ctx.textBaseline = 'alphabetic';
  const maxW = H - 30 - (my + r + 24);
  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, maxW, 20, 10, 800, SANS, 3);
  drawSpacedText(ctx, info.place, 0, -4, 3, 'left');
  ctx.fillStyle = hexToRgba(ink, 0.72);
  setFont(ctx, 7.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, 0, 12, 1.2, 'left');
  drawSpacedText(ctx, info.dateText, 0, 24, 1.2, 'left');
  ctx.restore();
}

// 影幕：宽银幕画幅，上下留出主题色黑边，字幕式地名
function paintCinema(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;
  const p = CINEMA_PHOTO;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = hexToRgba(ink, 0.6);
  setFont(ctx, 7, 500, SANS);
  drawSpacedText(ctx, info.dateText, 24, p.top - 18, 3, 'left');
  drawSpacedText(ctx, 'LOCATION', W - 24, p.top - 18, 3.4, 'right');

  const bottom = p.top + p.h;
  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, W - 64, 34, 14, 300, SANS, 9);
  drawSpacedText(ctx, info.place, W / 2, bottom + 62, 9, 'center');
  ctx.fillStyle = hexToRgba(ink, 0.65);
  setFont(ctx, 7.5, 400, SANS);
  drawSpacedText(ctx, info.coordText, W / 2, bottom + 88, 2.6, 'center');
}

// 坐标：整幅照片 + 四角测绘标记，经纬度作为主视觉
function paintCoord(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { main, sub } = photoText(style);
  const { lat, lon } = splitCoord(info);

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  drawFullBleedPhoto(ctx, assets, style, 0.22, 0.62);

  const m = 20;
  const t = 12;
  ctx.strokeStyle = sub;
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  [[m, m, 1, 1], [W - m, m, -1, 1], [m, H - m, 1, -1], [W - m, H - m, -1, -1]].forEach(([x, y, dx, dy]) => {
    ctx.moveTo(x + dx * t, y);
    ctx.lineTo(x, y);
    ctx.lineTo(x, y + dy * t);
  });
  ctx.stroke();

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = sub;
  setFont(ctx, 7.5, 500, SANS);
  drawSpacedText(ctx, info.place, m + 10, m + 24, 3, 'left');
  drawSpacedText(ctx, info.dateText, W - m - 10, m + 24, 1.6, 'right');

  ctx.fillStyle = main;
  const size = fitFontSize(ctx, lon.length > lat.length ? lon : lat, W - 2 * (m + 10), 30, 14, 200, SANS, 2);
  drawSpacedText(ctx, lat, m + 10, H - m - 34 - size * 1.15, 2, 'left');
  drawSpacedText(ctx, lon, m + 10, H - m - 34, 2, 'left');
}

// 免费版水印：整幅斜向平铺，深浅双层描边，任何底色上都清晰可见
function drawWatermark(ctx) {
  const W = POSTER_W;
  const H = POSTER_H;
  const text = 'GEOPICS · PREVIEW';
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'center';
  setFont(ctx, 13, 700, SANS);
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 6);
  ctx.lineJoin = 'round';
  ctx.lineWidth = 1.6;
  const stepX = 320;
  const stepY = 170;
  const span = Math.ceil(Math.hypot(W, H) / 2 / stepY) + 1;
  for (let row = -span; row <= span; row += 1) {
    const offset = (row % 2) * (stepX / 2);
    for (let col = -2; col <= 2; col += 1) {
      const x = col * stepX + offset;
      const y = row * stepY;
      ctx.strokeStyle = 'rgba(0,0,0,0.12)';
      ctx.strokeText(text, x, y);
      ctx.fillStyle = 'rgba(255,255,255,0.34)';
      ctx.fillText(text, x, y);
    }
  }
  ctx.restore();
}

// GEOPICS 标志：地球经纬线 + 定位点
function drawLogoMark(ctx, cx, cy, r, color) {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.8;
  ctx.beginPath();
  ctx.ellipse(cx, cy, r * 0.42, r, 0, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(cx - r, cy);
  ctx.lineTo(cx + r, cy);
  ctx.stroke();
  ctx.beginPath();
  ctx.arc(cx + r * 0.62, cy - r * 0.62, r * 0.27, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

// 底端品牌栏：左侧标志与字标，右侧小程序码（没有码图时用文字提示）
function drawBrandFooter(ctx, y0, style, qr) {
  const W = POSTER_W;
  const dark = style.theme.dark;
  const bg = dark ? '#0f1012' : '#fbfaf7';
  const ink = dark ? '#f2f0ea' : '#161616';
  const sub = dark ? 'rgba(242,240,234,0.6)' : 'rgba(22,22,22,0.55)';

  ctx.save();
  ctx.fillStyle = bg;
  ctx.fillRect(0, y0, W, FOOTER_H);
  ctx.strokeStyle = dark ? 'rgba(255,255,255,0.1)' : 'rgba(0,0,0,0.08)';
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(0, y0 + 0.3);
  ctx.lineTo(W, y0 + 0.3);
  ctx.stroke();

  const cy = y0 + FOOTER_H / 2;
  ctx.textBaseline = 'alphabetic';

  if (qr) {
    // 有小程序码：标志与字标靠左两行排列，码图在右
    drawLogoMark(ctx, 34, cy, 11, ink);
    ctx.fillStyle = ink;
    setFont(ctx, 14, 800, SANS);
    drawSpacedText(ctx, 'GEOPICS', 54, cy + 1, 4, 'left');
    ctx.fillStyle = sub;
    setFont(ctx, 6.5, 500, SANS);
    drawSpacedText(ctx, appConfig.brand.tagline, 54, cy + 14, 2.4, 'left');

    const qs = 46;
    const qx = W - 22 - qs;
    const qy = y0 + (FOOTER_H - qs) / 2;
    ctx.fillStyle = '#ffffff';
    roundedRectPath(ctx, qx, qy, qs, qs, 4);
    ctx.fill();
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.14)' : 'rgba(0,0,0,0.1)';
    roundedRectPath(ctx, qx, qy, qs, qs, 4);
    ctx.stroke();
    ctx.drawImage(qr, qx + 3, qy + 3, qs - 6, qs - 6);
  } else {
    // 无码图：单行居中  ◯ GEOPICS | MAP YOUR MOMENT
    const markR = 9;
    const gap = 11;
    setFont(ctx, 13, 800, SANS);
    const nameW = measureSpaced(ctx, 'GEOPICS', 5);
    setFont(ctx, 6.5, 500, SANS);
    const tagW = measureSpaced(ctx, appConfig.brand.tagline, 2.8);
    const divider = 26;
    const total = markR * 2 + gap + nameW + divider + tagW;
    let x = (W - total) / 2;

    drawLogoMark(ctx, x + markR, cy, markR, ink);
    x += markR * 2 + gap;
    ctx.fillStyle = ink;
    setFont(ctx, 13, 800, SANS);
    drawSpacedText(ctx, 'GEOPICS', x, cy + 4.6, 5, 'left');
    x += nameW + divider / 2;
    ctx.strokeStyle = dark ? 'rgba(255,255,255,0.28)' : 'rgba(0,0,0,0.22)';
    ctx.lineWidth = 0.6;
    ctx.beginPath();
    ctx.moveTo(x, cy - 7);
    ctx.lineTo(x, cy + 7);
    ctx.stroke();
    x += divider / 2;
    ctx.fillStyle = sub;
    setFont(ctx, 6.5, 500, SANS);
    drawSpacedText(ctx, appConfig.brand.tagline, x, cy + 2.4, 2.8, 'left');
  }
  ctx.restore();
}

function paintEmpty(ctx) {
  const W = POSTER_W;
  const H = POSTER_H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(60,60,67,0.12)';
  ctx.lineWidth = 0.6;
  ctx.strokeRect(20, 20, W - 40, H - 40);
  ctx.fillStyle = '#1c1c1e';
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 30, 800, SANS);
  drawSpacedText(ctx, 'GEOPICS', W / 2, H / 2 - 6, 5, 'center');
  ctx.fillStyle = '#8e8e93';
  setFont(ctx, 9, 400, SERIF, 'italic');
  drawSpacedText(ctx, 'SELECT A PHOTO TO BEGIN', W / 2, H / 2 + 18, 2.4, 'center');
}

const PAINTERS = {
  polaroid: paintPolaroid,
  split: paintSplit,
  medallion: paintMedallion,
  magazine: paintMagazine,
  film: paintFilm,
  postcard: paintPostcard,
  gallery: paintGallery,
  glass: paintGlass,
  typo: paintTypo,
  mat: paintMat,
  bar: paintBar,
  frame: paintFrame,
  rail: paintRail,
  cinema: paintCinema,
  coord: paintCoord
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
    if (style && style.footer) drawBrandFooter(ctx, POSTER_H, style, null);
    return;
  }
  const tpl = TEMPLATES.find((t) => t.id === tplId) || TEMPLATES[0];
  textAlpha = style.textAlpha;
  PAINTERS[tpl.id](ctx, scale, assets, info, tpl, style);
  textAlpha = 1;
  if (style.watermark) drawWatermark(ctx);
  if (style.footer) drawBrandFooter(ctx, POSTER_H, style, assets.qr || null);
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

// 预览最宽与页面内容同宽，但有照片时带底栏的整张海报须在首屏完整露出。预留高度对应 wxss 中
// 大标题 118 + 模板栏 180 + 预览说明 60 + 底部工具栏 140 + 间距 32（rpx），改版式时需同步。
// 宽度按带底栏的高度计算且保持不变，开关底栏只改变预览高度
const PREVIEW_RESERVED_RPX = 118 + 180 + 60 + 140 + 32;
function previewWidth(win) {
  const rpx = win.windowWidth / 750;
  const full = Math.min(win.windowWidth - 64 * rpx, 440);
  if (!win.windowHeight) return Math.floor(full);
  const safeBottom = win.safeArea && win.screenHeight ? Math.max(0, win.screenHeight - win.safeArea.bottom) : 0;
  const fitH = win.windowHeight - PREVIEW_RESERVED_RPX * rpx - safeBottom;
  const fitW = (fitH * POSTER_W) / posterHeight(true);
  return Math.floor(Math.max(Math.min(full, fitW), full * 0.64));
}

// 随机模板：在当前分类内洗牌发牌，用完一轮再开始下一轮
function pickRandomTemplates(count, categoryId) {
  return batchUtil.pickRandomTemplates(templatesOf(categoryId).map((t) => t.id), count);
}

Page({
  data: {
    footerOn: true,
    exportSize: '',
    isMember: false,
    memberLabel: '',
    memberChip: '',
    currentLocked: true,
    lockBadges: false,
    paywallVisible: false,
    plans: appConfig.membership.plans.map((pl) => Object.assign({ priceText: membership.formatPrice(pl.price) }, pl)),
    singleOffer: Object.assign({ priceText: membership.formatPrice(appConfig.membership.single.price) }, appConfig.membership.single),
    inviteInput: '',
    inviteError: '',
    paywallNotice: '',
    packLines: [],
    mockPay: payment.isMock(),
    categories: CATEGORIES,
    catId: HOT_CATEGORY,
    visibleTemplates: templatesOf(HOT_CATEGORY),
    templateId: 'polaroid',
    hasPhoto: false,
    photoPath: '',
    coordText: '',
    dateText: '',
    dateValue: '',
    dateManual: false,
    dateToday: exifParser.toDateValue(new Date()),
    place: '',
    placeLang: 'en',
    placeLevel: 'city',
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
    hueColor: '#FF0000',
    padCursor: '',
    hueCursor: '',
    cropEnabled: false,
    cropZoom: 100,
    cropX: 0,
    cropY: 0,
    mapOpacity: 100,
    photoOpacity: 100,
    textOpacity: 100,
    batchMode: 'unique',
    maxBatch: MAX_BATCH,
    list: [],
    itemCount: 0,
    selectedCount: 0,
    currentId: 0,
    canvasStyle: '',
    busy: false,
    busyText: '',
    tokenMissing: !mapService.hasToken()
  },

  onLoad() {
    // 非 data 状态：与渲染无关，避免多余的 setData
    this.items = [];
    this.member = membership.load();
    this._afterUnlock = null;
    this._itemSeq = 0;
    this.poster = this.createItem('');
    this._hsv = themes.hexToHsv(themes.DEFAULT_CUSTOM_HEX);
    this._renderId = 0;
    this._searchId = 0;
    this._geoCache = {};
    this._searchTimer = null;
    this._placeTimer = null;
    this._imgCache = new Map();
    this._mapCache = {};
    this._mapWarned = false;

    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const cssW = previewWidth(win);
    let footerOn = true;
    try {
      footerOn = wx.getStorageSync(FOOTER_KEY) !== false;
    } catch (e) {
      footerOn = true;
    }
    const cssH = Math.round((cssW * posterHeight(footerOn)) / POSTER_W);
    this.cssSize = { w: cssW, h: cssH };
    this.dpr = Math.min(win.pixelRatio || 2, 3);
    this.setData(
      Object.assign(
        { footerOn, exportSize: exportSizeText(footerOn), canvasStyle: `width:${cssW}px;height:${cssH}px;` },
        this.pickerView(),
        this.memberView(),
        this.listView()
      )
    );
  },

  onReady() {
    this.initPreviewCanvas();
    this.observeLargeTitle();
  },

  onUnload() {
    if (this._titleObserver) this._titleObserver.disconnect();
  },

  // 仿 iOS 大标题：页面内的大标题滚出视野后，才在导航栏显示标题
  observeLargeTitle() {
    if (!this.createIntersectionObserver) return;
    let shown = false;
    this._titleObserver = this.createIntersectionObserver();
    this._titleObserver.relativeToViewport().observe('.large-title', (res) => {
      const show = res.intersectionRatio === 0;
      if (show === shown) return;
      shown = show;
      wx.setNavigationBarTitle({ title: show ? 'GeoPics' : '' });
    });
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

  // 底端品牌栏开关会改变海报高度：同步调整预览画布的尺寸
  applyPreviewSize() {
    const { w } = this.cssSize;
    const h = Math.round((w * posterHeight(this.data.footerOn)) / POSTER_W);
    this.cssSize = { w, h };
    if (this.preview) {
      this.preview.width = Math.round(w * this.dpr);
      this.preview.height = Math.round(h * this.dpr);
    }
    this.setData({ canvasStyle: `width:${w}px;height:${h}px;`, exportSize: exportSizeText(this.data.footerOn) });
  },

  onToggleFooter(e) {
    const on = !!e.detail.value;
    if (on === this.data.footerOn) return;
    try {
      wx.setStorageSync(FOOTER_KEY, on);
    } catch (err) {
      /* 偏好保存失败不影响使用 */
    }
    this.setData({ footerOn: on }, () => {
      this.applyPreviewSize();
      this.render();
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

  /* ---------------------------- 批量：条目模型 ---------------------------- */

  // 每张照片是一个独立条目；this.poster 始终指向“当前正在编辑 / 预览”的条目
  createItem(filePath, templateId) {
    return {
      id: ++this._itemSeq,
      photoPath: filePath,
      templateId: templateId || (this.poster && this.poster.templateId) || this.data.templateId,
      selected: true,
      unlocked: false,
      lat: null,
      lon: null,
      place: '',
      fallbackName: '',
      placeManual: false,
      coordText: '',
      dateText: '',
      dateValue: '',
      dateManual: false,
      autoDate: null,
      crops: {},
      photoSize: null,
      locId: 0
    };
  },

  listView() {
    const list = this.items.map((it) => {
      const tpl = TEMPLATES.find((t) => t.id === it.templateId);
      return {
        id: it.id,
        path: it.photoPath,
        selected: it.selected,
        current: it === this.poster,
        tplName: tpl ? tpl.name : '',
        noLoc: it.lat === null,
        locked: !this.isEntitled(it)
      };
    });
    return {
      list,
      itemCount: list.length,
      selectedCount: list.filter((x) => x.selected).length,
      currentId: this.poster.id,
      currentLocked: !this.isEntitled(this.poster),
      // 全部带水印时角标没有区分意义，只在部分照片已解锁时标出
      lockBadges: list.some((x) => x.locked) && list.some((x) => !x.locked)
    };
  },

  /* ---------------------------- 会员 / 水印 / 付费 ---------------------------- */

  // 这张照片已解锁（单张付费 / 已消耗过额度），或会员还有剩余额度 => 无水印且可下载
  isEntitled(item) {
    return !!item.unlocked || membership.remainingQuota(this.member) > 0;
  },

  memberView() {
    return {
      isMember: membership.remainingQuota(this.member) > 0,
      memberLabel: membership.label(this.member),
      memberChip: membership.chipLabel(this.member),
      packLines: membership.packLines(this.member, appConfig.membership.plans)
    };
  },

  // 一次下载要处理的照片中，哪些可以下载、哪些被额度 / 水印拦下
  splitByEntitlement(items) {
    let remaining = membership.remainingQuota(this.member);
    const allowed = [];
    const blocked = [];
    items.forEach((it) => {
      if (it.unlocked) {
        allowed.push(it);
      } else if (remaining > 0) {
        allowed.push(it);
        remaining -= 1;
      } else {
        blocked.push(it);
      }
    });
    return { allowed, blocked };
  },

  // 保存成功后扣减额度；该照片本次会话内再次保存不重复计费
  chargeItem(item) {
    if (item.unlocked) return;
    item.unlocked = true;
    if (this.member.invite) return;
    this.member = membership.consume(this.member, 1);
    membership.save(this.member);
  },

  // 权益变化后刷新标题栏 / 缩略图 / 预览水印
  refreshEntitlement() {
    this.setData(Object.assign(this.memberView(), this.listView()));
    this.render();
  },

  openPaywall(resume, notice) {
    this._afterUnlock = resume || null;
    this.setData(
      Object.assign(this.memberView(), { paywallVisible: true, paywallNotice: notice || '', inviteInput: '', inviteError: '' })
    );
  },

  onOpenPaywall() {
    this.openPaywall(null);
  },

  onPaywallClose() {
    this._afterUnlock = null;
    this.setData({ paywallVisible: false });
  },

  // 权益生效后关闭付费面板，并继续刚才被拦下的操作
  finishUnlock(toast) {
    const resume = this._afterUnlock;
    this._afterUnlock = null;
    this.setData({ paywallVisible: false });
    this.refreshEntitlement();
    wx.showToast({ title: toast, icon: 'success' });
    if (resume) setTimeout(resume, 400);
  },

  onInviteInput(e) {
    this.setData({ inviteInput: e.detail.value, inviteError: '' });
  },

  async onRedeemInvite() {
    const code = this.data.inviteInput;
    if (!code.trim()) {
      this.setData({ inviteError: '请输入邀请码' });
      return;
    }
    let valid = false;
    try {
      valid = await payment.verifyInvite(code);
    } catch (e) {
      this.setData({ inviteError: '校验失败，请稍后重试' });
      return;
    }
    if (!valid) {
      this.setData({ inviteError: '邀请码无效' });
      return;
    }
    this.member = Object.assign({}, this.member, { invite: true });
    membership.save(this.member);
    this.finishUnlock('邀请码已生效');
  },

  async onBuy(e) {
    if (this.data.busy) return;
    const { kind, id } = e.currentTarget.dataset;
    let order;
    let plan = null;
    if (kind === 'plan') {
      plan = appConfig.membership.plans.find((pl) => pl.id === id);
      if (!plan) return;
      order = { kind, planId: plan.id, title: plan.name, priceText: membership.formatPrice(plan.price) };
    } else {
      if (!this.data.hasPhoto) return;
      const single = appConfig.membership.single;
      order = { kind: 'single', title: single.name, priceText: membership.formatPrice(single.price) };
    }
    const target = this.poster;
    let result;
    try {
      result = await payment.pay(order);
    } catch (err) {
      console.error('pay failed', err);
      wx.showToast({ title: '支付失败，请重试', icon: 'none' });
      return;
    }
    if (!result || !result.ok) return;
    if (plan) {
      this.member = membership.addPack(this.member, plan);
      membership.save(this.member);
    } else {
      target.unlocked = true;
    }
    this.finishUnlock('已解锁');
  },

  // 把当前条目的状态整体同步到界面
  syncView(extra) {
    const p = this.poster;
    const crop = this.getCrop(p.templateId);
    this.setData(
      Object.assign(
        {
          hasPhoto: !!p.photoPath,
          photoPath: p.photoPath,
          templateId: p.templateId,
          hasLocation: p.lat !== null,
          coordText: p.coordText,
          place: p.place,
          placeManual: p.placeManual,
          dateText: p.dateText,
          dateValue: p.dateValue,
          dateManual: p.dateManual,
          cropEnabled: !!CROP_REGIONS[p.templateId],
          cropZoom: Math.round(crop.zoom * 100),
          cropX: Math.round(crop.x * 100),
          cropY: Math.round(crop.y * 100)
        },
        this.listView(),
        extra
      )
    );
  },

  // 条目数据变化后刷新界面；当前条目还需要重绘预览
  touch(item, redraw) {
    if (item === this.poster) {
      this.syncView();
      if (redraw) this.render();
    } else {
      this.setData(this.listView());
    }
  },

  /* ---------------------------- 批量：导入 / 切换 / 选择 ---------------------------- */

  onChoosePhoto() {
    return this.chooseAndImport(false);
  },

  onAddPhotos() {
    return this.chooseAndImport(true);
  },

  // 缩略图条末尾的 “+”：继续添加，或重新选择替换全部
  async onTapAddTile() {
    if (this.data.busy) return;
    const canAdd = this.items.length < MAX_BATCH;
    const replace = this.items.length > 1 ? '重新选择（替换全部）' : '重新选择照片';
    let tapIndex;
    try {
      ({ tapIndex } = await wxp('showActionSheet', { itemList: canAdd ? ['继续添加照片', replace] : [replace] }));
    } catch (e) {
      return;
    }
    if (canAdd && tapIndex === 0) await this.onAddPhotos();
    else await this.onChoosePhoto();
  },

  async chooseAndImport(append) {
    const remain = MAX_BATCH - (append ? this.items.length : 0);
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_BATCH} 张`, icon: 'none' });
      return;
    }
    let files;
    try {
      const res = await wxp('chooseMedia', {
        count: remain,
        mediaType: ['image'],
        // 必须原图：压缩后的图片会丢失 EXIF（含 GPS）
        sizeType: ['original'],
        sourceType: ['album']
      });
      files = res.tempFiles.map((f) => f.tempFilePath);
    } catch (e) {
      if (!isCancel(e)) wx.showToast({ title: '选择图片失败', icon: 'none' });
      return;
    }

    this.showBusy('读取并处理照片…');
    const baseTemplate = this.poster.templateId;
    const created = [];
    for (const filePath of files) {
      const item = this.createItem(filePath, baseTemplate);
      const exif = await exifParser.extractFromFile(filePath);
      item.autoDate = {
        text: exif.dateText || exifParser.formatDate(new Date()),
        value: exif.dateValue || exifParser.toDateValue(new Date())
      };
      item.dateText = item.autoDate.text;
      item.dateValue = item.autoDate.value;
      item.exif = exif;
      item.photoPath = await this.prepareImage(filePath);
      created.push(item);
    }

    this.items = append ? this.items.concat(created) : created;
    if (this.data.batchMode === 'random' && this.items.length > 1) {
      pickRandomTemplates(created.length, this.data.catId).forEach((id, i) => {
        created[i].templateId = id;
      });
    }
    this.poster = created[0];
    this._imgCache = new Map();
    this.ensureCategory();
    this.syncView();
    this.render();

    await Promise.all(
      created.map((item) => {
        const exif = item.exif;
        delete item.exif;
        if (exif.hasGps) return this.applyLocation(item, exif.latitude, exif.longitude, '');
        item.place = 'UNKNOWN';
        this.touch(item, true);
        return null;
      })
    );
    this.hideBusy();

    const missing = created.filter((it) => it.lat === null);
    if (!missing.length) return;
    if (created.length === 1) {
      const modal = await wxp('showModal', {
        title: '未读取到位置',
        content: '未读取到位置，请在地图上手动选择',
        confirmText: '去选择',
        cancelText: '暂不',
        confirmColor: TINT
      }).catch(() => ({ confirm: false }));
      if (modal.confirm) await this.onPickLocation();
    } else {
      wxp('showModal', {
        title: '部分照片未读取到位置',
        content: `有 ${missing.length} 张照片没有位置信息（缩略图上标有“无位置”），点选该照片后可手动选择位置。`,
        showCancel: false,
        confirmColor: TINT
      }).catch(() => {});
    }
  },

  // 原图像素过大时，部分机型的 canvas 只能解码出上半部分，下半部分变成竖向拖影。
  // 导入时先等比压缩到长边 maxSide 以内（EXIF 已在压缩前从原图读取）；失败则退回原图
  async prepareImage(filePath) {
    const { maxSide, quality } = appConfig.image;
    try {
      const info = await wxp('getImageInfo', { src: filePath });
      const long = Math.max(info.width, info.height);
      if (!(long > maxSide)) return filePath;
      const k = maxSide / long;
      const res = await wxp('compressImage', {
        src: filePath,
        quality,
        compressedWidth: Math.round(info.width * k),
        compressedHeight: Math.round(info.height * k)
      });
      return res.tempFilePath || filePath;
    } catch (e) {
      console.warn('prepare image failed, using original', e);
      return filePath;
    }
  },

  findItem(id) {
    return this.items.find((it) => it.id === Number(id));
  },

  onTapItem(e) {
    const item = this.findItem(e.currentTarget.dataset.id);
    if (!item || item === this.poster) return;
    this.poster = item;
    this.ensureCategory();
    this.syncView();
    this.render();
  },

  onToggleSelect(e) {
    const item = this.findItem(e.currentTarget.dataset.id);
    if (!item) return;
    item.selected = !item.selected;
    this.setData(this.listView());
  },

  onToggleSelectAll() {
    const all = this.items.every((it) => it.selected);
    this.items.forEach((it) => {
      it.selected = !all;
    });
    this.setData(this.listView());
  },

  onRemoveItem(e) {
    const item = this.findItem(e.currentTarget.dataset.id);
    if (!item) return;
    const idx = this.items.indexOf(item);
    this.items.splice(idx, 1);
    item.locId += 1;
    this._imgCache.delete(item.photoPath);
    if (item === this.poster) {
      this.poster = this.items[Math.min(idx, this.items.length - 1)] || this.createItem('', item.templateId);
      this.ensureCategory();
      this.syncView();
      this.render();
    } else {
      this.setData(this.listView());
    }
  },

  // 统一模板：全部使用同一个；随机：每张各不相同（用完一轮再开始下一轮）
  onBatchModeChange(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.batchMode) return;
    this.setData({ batchMode: mode }, () => {
      if (mode === 'random') this.reshuffle();
      else this.applyTemplateToAll(this.poster.templateId);
    });
  },

  // 当前照片的模板不在正在浏览的分类里时，切到它所属的分类，保证 Tab 上能看到选中项
  ensureCategory() {
    const tpl = TEMPLATES.find((t) => t.id === this.poster.templateId);
    if (!tpl || templatesOf(this.data.catId).some((t) => t.id === tpl.id)) return;
    this.setData({ catId: tpl.category, visibleTemplates: templatesOf(tpl.category) });
  },

  onTapCategory(e) {
    const catId = e.currentTarget.dataset.id;
    if (catId === this.data.catId) return;
    this.setData({ catId, visibleTemplates: templatesOf(catId) }, () => {
      // 随机模式的抽取范围就是当前分类
      if (this.data.batchMode === 'random' && this.items.length > 1) this.reshuffle();
    });
  },

  onReshuffle() {
    this.reshuffle();
  },

  reshuffle() {
    pickRandomTemplates(this.items.length, this.data.catId).forEach((id, i) => {
      this.items[i].templateId = id;
    });
    this.syncView();
    this.render();
  },

  applyTemplateToAll(templateId) {
    this.items.forEach((it) => {
      it.templateId = templateId;
    });
    this.poster.templateId = templateId;
    this.syncView();
    this.render();
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
    await this.applyLocation(this.poster, wgs.lat, wgs.lon, loc.name || '');
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
    await this.applyLocation(this.poster, hit.lat, hit.lon, hit.name);
    this.hideBusy();
  },

  /* ---------------------------- 地名：手动修改 / 语言切换 ---------------------------- */

  onPlaceInput(e) {
    const value = e.detail.value;
    this.poster.place = value;
    this.poster.placeManual = true;
    this.setData({ place: value, placeManual: true });
    clearTimeout(this._placeTimer);
    this._placeTimer = setTimeout(() => this.render(), 200);
  },

  // 把当前照片的地名统一应用到所有照片（坐标各自保留，并作废尚未返回的自动地名解析）。
  // 当前照片还没有可用地名时返回 false
  spreadPlace() {
    const text = (this.poster.place || '').trim();
    if (!text || text === 'LOCATING…') return false;
    this.items.forEach((it) => {
      it.locId += 1;
      it.place = text;
      it.placeManual = true;
    });
    return true;
  },

  spreadDate() {
    const { dateText, dateValue } = this.poster;
    if (!dateText) return false;
    this.items.forEach((it) => {
      Object.assign(it, { dateText, dateValue, dateManual: true });
    });
    return true;
  },

  onApplyPlaceToAll() {
    if (!this.spreadPlace()) {
      wx.showToast({ title: '请先填写地名', icon: 'none' });
      return;
    }
    this.syncView();
    this.render();
    wx.showToast({ title: `地名已应用到 ${this.items.length} 张`, icon: 'none' });
  },

  async onApplyToAllMenu() {
    let tapIndex;
    try {
      ({ tapIndex } = await wxp('showActionSheet', { itemList: ['地点和日期', '仅地点', '仅日期'] }));
    } catch (e) {
      return;
    }
    if (tapIndex === 1) return this.onApplyPlaceToAll();
    if (tapIndex === 2) return this.onApplyDateToAll();
    if (!this.spreadPlace()) {
      wx.showToast({ title: '请先填写地名', icon: 'none' });
      return;
    }
    this.spreadDate();
    this.syncView();
    this.render();
    wx.showToast({ title: `地点和日期已应用到 ${this.items.length} 张`, icon: 'none' });
  },

  onPlaceReset() {
    const item = this.poster;
    if (item.lat !== null) {
      this.resolvePlace(item, ++item.locId);
    } else {
      item.place = 'UNKNOWN';
      item.placeManual = false;
      this.touch(item, true);
    }
  },

  // 地名语言是全局设置：所有照片一起重新解析
  onPlaceLangChange(e) {
    const lang = e.currentTarget.dataset.lang;
    if (lang === this.data.placeLang) return;
    this.setData({ placeLang: lang }, () => {
      this.items.forEach((item) => {
        if (item.lat !== null) this.resolvePlace(item, ++item.locId);
      });
    });
  },

  // 地名范围：城市（默认）/ 详细。手动修改过的地名不受影响
  onPlaceLevelChange(e) {
    const level = e.currentTarget.dataset.level;
    if (level === this.data.placeLevel) return;
    this.setData({ placeLevel: level }, () => {
      this.items.forEach((item) => {
        if (item.lat !== null && !item.placeManual) this.resolvePlace(item, ++item.locId);
      });
    });
  },

  onTapTemplate(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.poster.templateId) return;
    // 统一模板模式下作用于全部照片；随机模式下只改当前这张
    if (this.data.batchMode === 'unique') {
      this.applyTemplateToAll(id);
    } else {
      this.poster.templateId = id;
      this.syncView();
      this.render();
    }
  },

  /* ---------------------------- 照片取景（拖动 / 缩放） ---------------------------- */

  getCrop(tplId) {
    return this.poster.crops[tplId] || DEFAULT_CROP;
  },

  setCrop(tplId, patch) {
    const cur = this.getCrop(tplId);
    this.poster.crops[tplId] = {
      zoom: clamp(patch.zoom === undefined ? cur.zoom : patch.zoom, 1, MAX_CROP_ZOOM),
      x: clamp(patch.x === undefined ? cur.x : patch.x, -1, 1),
      y: clamp(patch.y === undefined ? cur.y : patch.y, -1, 1)
    };
  },

  // 把当前模板的取景参数同步到滑块
  syncCropData() {
    const tplId = this.poster.templateId;
    const crop = this.getCrop(tplId);
    this.setData({
      cropEnabled: !!CROP_REGIONS[tplId],
      cropZoom: Math.round(crop.zoom * 100),
      cropX: Math.round(crop.x * 100),
      cropY: Math.round(crop.y * 100)
    });
  },

  onCropSlider(e) {
    const tplId = this.poster.templateId;
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (key === 'cropZoom') this.setCrop(tplId, { zoom: value / 100 });
    if (key === 'cropX') this.setCrop(tplId, { x: value / 100 });
    if (key === 'cropY') this.setCrop(tplId, { y: value / 100 });
    this.setData({ [key]: value });
    this.scheduleRender();
  },

  onResetCrop() {
    delete this.poster.crops[this.poster.templateId];
    this.syncCropData();
    this.render();
  },

  onCanvasTouchStart(e) {
    const tplId = this.poster.templateId;
    const region = CROP_REGIONS[tplId];
    if (!region || !this.poster.photoSize || !e.touches.length) return;

    const t = e.touches[0];
    // 仅在照片区域内拖动才调整取景，避免误触其他区域
    if (typeof t.y === 'number' && typeof t.x === 'number') {
      const k = POSTER_W / this.cssSize.w;
      const lx = t.x * k;
      const ly = t.y * k;
      if (lx < region.left || lx > region.left + region.w || ly < region.top || ly > region.top + region.h) {
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
    if (!g || !this.poster.photoSize) return;
    const region = CROP_REGIONS[g.tplId];
    const { w: iw, h: ih } = this.poster.photoSize;
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
    if (!hex) {
      this.setData({ customHexText: text });
      return;
    }
    const hsv = themes.hexToHsv(hex);
    // 灰色没有色相信息，保留当前色相，避免色相条跳回 0
    this._hsv = { h: hsv.s === 0 ? this._hsv.h : hsv.h, s: hsv.s, v: hsv.v };
    this.setData(this.customColorPatch(hex, text));
    this.scheduleRender();
  },

  /* ---------------------------- 调色盘（饱和度/明度 + 色相） ---------------------------- */

  pickerView() {
    const { h, s, v } = this._hsv;
    return {
      hueColor: themes.hsvToHex(h, 1, 1),
      padCursor: `left:${(s * 100).toFixed(2)}%;top:${((1 - v) * 100).toFixed(2)}%;`,
      hueCursor: `left:${((h / 360) * 100).toFixed(2)}%;`
    };
  },

  customColorPatch(hex, text) {
    return Object.assign(
      {
        customHex: hex,
        customHexText: text || hex,
        themes: this.data.themes.map((t) => (t.id === themes.CUSTOM_ID ? Object.assign({}, t, { tint: hex }) : t))
      },
      this.pickerView()
    );
  },

  measure(selector) {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .select(selector)
        .boundingClientRect((rect) => resolve(rect))
        .exec();
    });
  },

  applyHsv(patch) {
    this._hsv = Object.assign({}, this._hsv, patch);
    const { h, s, v } = this._hsv;
    this.setData(this.customColorPatch(themes.hsvToHex(h, s, v)));
    this.scheduleRender();
  },

  applyPadTouch(touch) {
    const rect = this._padRect;
    if (!rect || !rect.width || !rect.height) return;
    this.applyHsv({
      s: clamp((touch.clientX - rect.left) / rect.width, 0, 1),
      v: 1 - clamp((touch.clientY - rect.top) / rect.height, 0, 1)
    });
  },

  applyHueTouch(touch) {
    const rect = this._hueRect;
    if (!rect || !rect.width) return;
    this.applyHsv({ h: clamp((touch.clientX - rect.left) / rect.width, 0, 1) * 360 });
  },

  async onPadStart(e) {
    const touch = e.touches[0];
    this._padRect = await this.measure('#colorPad');
    this.applyPadTouch(touch);
  },

  onPadMove(e) {
    this.applyPadTouch(e.touches[0]);
  },

  async onHueStart(e) {
    const touch = e.touches[0];
    this._hueRect = await this.measure('#hueBar');
    this.applyHueTouch(touch);
  },

  onHueMove(e) {
    this.applyHueTouch(e.touches[0]);
  },

  /* ---------------------------- 日期 ---------------------------- */

  onDateChange(e) {
    const value = e.detail.value;
    const text = exifParser.formatDate(value);
    if (!text) return;
    Object.assign(this.poster, { dateText: text, dateValue: value, dateManual: true });
    this.touch(this.poster, true);
  },

  onApplyDateToAll() {
    if (!this.spreadDate()) {
      wx.showToast({ title: '请先选择日期', icon: 'none' });
      return;
    }
    this.syncView();
    this.render();
    wx.showToast({ title: `日期已应用到 ${this.items.length} 张`, icon: 'none' });
  },

  onDateReset() {
    const auto = this.poster.autoDate;
    if (!auto) return;
    Object.assign(this.poster, { dateText: auto.text, dateValue: auto.value, dateManual: false });
    this.touch(this.poster, true);
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

  async applyLocation(item, lat, lon, fallbackName) {
    const locId = ++item.locId;
    const coords = exifParser.formatCoordinates(lat, lon);
    item.lat = lat;
    item.lon = lon;
    item.fallbackName = fallbackName || '';
    item.coordText = coords.text;
    item.place = 'LOCATING…';
    item.placeManual = false;
    this.touch(item);
    await this.resolvePlace(item, locId);
  },

  // 按当前语言设置解析地名：服务商结果 -> 备用名（如选点名称）-> UNKNOWN。
  // 英文模式下若拿到的是汉字，短名转拼音、长名转首字母缩写。
  async resolvePlace(item, locId) {
    const { lat, lon, fallbackName } = item;
    const lang = this.data.placeLang;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)},${lang}`;

    let geo = this._geoCache[key];
    if (geo === undefined) {
      geo = await mapService.reverseGeocode(lat, lon, lang);
      if (geo) this._geoCache[key] = geo;
    }
    if (locId !== item.locId) return;

    // 默认只显示城市，避免地名过长超出海报边界；可切换为“详细”
    const composed = geo ? placeName.formatPlace(geo.parts || { city: geo.name }, this.data.placeLevel, lang) : '';
    item.place = composed || placeName.normalizePlaceName(fallbackName, lang) || 'UNKNOWN';
    item.placeManual = false;
    this.touch(item, true);
  },

  /* ---------------------------- 渲染 ---------------------------- */

  // 下载当前模板/缩放对应的静态地图，失败时返回 null（画布回退到本地底图）
  async ensureMapFile(item, tpl, dark) {
    const { lat, lon } = item;
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

  async loadAssets(canvas, cache, tpl, style, item) {
    const [photo, mapPath] = await Promise.all([
      cachedImage(canvas, cache, item.photoPath),
      this.ensureMapFile(item, tpl, style.theme.dark)
    ]);
    let map = null;
    if (mapPath) {
      try {
        map = await cachedImage(canvas, cache, mapPath);
      } catch (e) {
        map = null;
      }
    }
    let qr = null;
    if (style.footer && appConfig.brand.qrcode) {
      try {
        qr = await cachedImage(canvas, cache, appConfig.brand.qrcode);
      } catch (e) {
        qr = null;
      }
    }
    return { photo, map, qr };
  },

  // 配色与不透明度（0~1）为全局设置；取景按条目各自保存
  buildStyle(item) {
    const d = this.data;
    return {
      theme: themes.resolveTheme(d.mapColorId, d.customHex),
      mapAlpha: d.mapOpacity / 100,
      photoAlpha: d.photoOpacity / 100,
      textAlpha: d.textOpacity / 100,
      crop: item.crops[item.templateId] || DEFAULT_CROP,
      watermark: !this.isEntitled(item),
      footer: this.data.footerOn
    };
  },

  buildInfo(item) {
    const seed =
      item.lat === null ? 7 : Math.floor((item.lat + 90) * 1000) * 397 + Math.floor((item.lon + 180) * 1000);
    return {
      place: item.place || 'UNKNOWN',
      coordText: item.coordText || '-- ° --  -- ° --',
      dateText: item.dateText || '',
      seed
    };
  },

  async render() {
    if (!this.preview) return;
    const renderId = ++this._renderId;
    const canvas = this.preview;
    const item = this.poster;
    const tplId = item.templateId;
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    const style = this.buildStyle(item);

    if (!item.photoPath) {
      paintPoster(canvas, tplId, null, null, style);
      return;
    }

    // 预览只缓存当前照片，避免批量时大图常驻内存
    this.items.forEach((it) => {
      if (it.photoPath !== item.photoPath) this._imgCache.delete(it.photoPath);
    });

    let assets;
    try {
      assets = await this.loadAssets(canvas, this._imgCache, tpl, style, item);
    } catch (e) {
      console.error('load assets failed', e);
      wx.showToast({ title: '图片加载失败', icon: 'none' });
      return;
    }
    // 期间用户切换了模板/照片：丢弃过期结果
    if (renderId !== this._renderId) return;
    item.photoSize = { w: assets.photo.width, h: assets.photo.height };
    paintPoster(canvas, tplId, assets, this.buildInfo(item), style);
  },

  /* ---------------------------- 导出 ---------------------------- */

  // 渲染一张照片并导出为临时文件（1200 x 1600）
  async exportItem(item) {
    // 页面外的隐藏 canvas 作为离屏画布：物理尺寸 1200 x 1600（3 倍）
    const canvas = await this.queryCanvas('#exportCanvas');
    canvas.width = POSTER_W * EXPORT_SCALE;
    canvas.height = Math.round(posterHeight(this.data.footerOn) * EXPORT_SCALE);

    const tpl = TEMPLATES.find((t) => t.id === item.templateId);
    // 离屏画布不复用预览缓存，使用独立的 Image 对象
    const style = this.buildStyle(item);
    const assets = await this.loadAssets(canvas, null, tpl, style, item);
    paintPoster(canvas, item.templateId, assets, this.buildInfo(item), style);

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
    return tempFilePath;
  },

  // 无剩余额度且未解锁的照片不能下载：全部被拦下就弹出付费面板，部分被拦下则询问；
  // 购买 / 兑换成功后自动继续刚才的操作
  async requestSave(items, resume) {
    if (this.data.busy || !items.length) return;
    const { allowed, blocked } = this.splitByEntitlement(items);
    const bought = this.member.bought;
    const exhausted = bought
      ? '额度已用完或已到期，购买额外的月度或年度会员即可继续下载。'
      : '';
    if (!allowed.length) {
      this.openPaywall(resume, exhausted);
      return;
    }
    if (blocked.length) {
      const notice = bought
        ? `本次需下载 ${items.length} 张，剩余额度只够 ${allowed.length} 张。购买额外的月度或年度会员可继续下载其余 ${blocked.length} 张。`
        : `有 ${blocked.length} 张照片未解锁（带水印，无法下载）。`;
      const res = await wxp('showModal', {
        title: bought ? '会员额度不足' : '部分照片未解锁',
        content: `${notice}\n是否仅下载可下载的 ${allowed.length} 张？`,
        confirmText: `仅下载 ${allowed.length} 张`,
        cancelText: bought ? '购买额外会员' : '去解锁',
        confirmColor: TINT
      }).catch(() => ({ confirm: false }));
      if (!res.confirm) {
        this.openPaywall(resume, bought ? notice : '');
        return;
      }
    }
    return this.saveItems(allowed);
  },

  onSavePoster() {
    if (!this.data.hasPhoto) {
      wx.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    return this.requestSave([this.poster], () => this.onSavePoster());
  },

  onSaveSelected() {
    const picked = this.items.filter((it) => it.selected);
    if (!picked.length) {
      wx.showToast({ title: '请先勾选要下载的照片', icon: 'none' });
      return;
    }
    return this.requestSave(picked, () => this.onSaveSelected());
  },

  onSaveAll() {
    if (!this.items.length) {
      wx.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    return this.requestSave(this.items.slice(), () => this.onSaveAll());
  },

  // 工具栏的批量按钮：全部勾选时即“下载全部”，否则只下载勾选的照片
  onSaveBatch() {
    return this.data.selectedCount === this.items.length ? this.onSaveAll() : this.onSaveSelected();
  },

  // 逐张导出并保存到相册；相册权限被拒绝时立即终止，其余失败计入统计
  async saveItems(items) {
    if (this.data.busy || !items.length) return;
    const total = items.length;
    let ok = 0;
    let fail = 0;
    let denied = false;
    this.showBusy(total > 1 ? `导出 1/${total}…` : '生成高清海报…');

    for (let i = 0; i < total; i += 1) {
      if (total > 1) this.setData({ busyText: `导出 ${i + 1}/${total}…` });
      try {
        const filePath = await this.exportItem(items[i]);
        await wxp('saveImageToPhotosAlbum', { filePath });
        ok += 1;
        this.chargeItem(items[i]);
      } catch (e) {
        if (isCancel(e)) {
          break;
        }
        if (/auth/i.test(e.errMsg || '')) {
          denied = true;
          break;
        }
        console.error('export failed', e);
        fail += 1;
      }
    }
    this.hideBusy();
    if (ok) this.refreshEntitlement();

    if (denied) {
      const res = await wxp('showModal', {
        title: '需要相册权限',
        content: ok ? `已保存 ${ok} 张，请在设置中允许保存到相册后继续` : '请在设置中允许保存到相册后重试',
        confirmText: '去设置',
        confirmColor: TINT
      }).catch(() => ({ confirm: false }));
      if (res.confirm) wx.openSetting({});
      return;
    }
    if (!fail) {
      if (ok) wx.showToast({ title: ok > 1 ? `已保存 ${ok} 张` : '已保存到相册', icon: 'success' });
    } else if (!ok) {
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    } else {
      wxp('showModal', {
        title: '部分导出失败',
        content: `成功 ${ok} 张，失败 ${fail} 张，可重试失败的照片。`,
        showCancel: false,
        confirmColor: TINT
      }).catch(() => {});
    }
  }
});
