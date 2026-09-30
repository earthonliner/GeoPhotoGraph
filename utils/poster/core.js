/**
 * 海报绘制的公共部分：尺寸常量、字体、逐字排版、裁切、地图底图与常用图形。
 * 所有坐标均为逻辑单位（海报 400 x 533.33），由 paintPoster 统一缩放。
 */
const { hexToRgba } = require('../themes.js');

// 海报逻辑尺寸 400 x 533.33（3:4）。所有绘制坐标基于逻辑单位
const POSTER_W = 400;
const POSTER_H = (POSTER_W * 4) / 3;
// 底端品牌栏（可选）拼接在海报下方，整张图高度 = POSTER_H + FOOTER_H
const FOOTER_H = 64;
const MAX_CROP_ZOOM = 4;

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
function setTextAlpha(alpha) {
  textAlpha = alpha;
}

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

function splitCoord(info) {
  const parts = (info.coordText || '').split('  ');
  return { lat: parts[0] || '', lon: parts[1] || '' };
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

module.exports = {
  POSTER_W,
  POSTER_H,
  FOOTER_H,
  MAX_CROP_ZOOM,
  SANS,
  SERIF,
  TAGLINE,
  MAP_SIZE,
  CENTER_PIN,
  tplMap,
  mulberry32,
  setFont,
  measureSpaced,
  drawSpacedText,
  fitFontSize,
  clamp,
  coverRect,
  drawImageCover,
  fitInside,
  drawFallbackMap,
  applyTint,
  drawMapRegion,
  withAlpha,
  roundedRectPath,
  drawMapWindow,
  photoText,
  drawFullBleedPhoto,
  splitCoord,
  drawPerforatedStamp,
  setTextAlpha
};
