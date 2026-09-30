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

// 与 Mapbox pin-s 相近的水滴形定位针，(x, y) 为针尖
function drawPin(ctx, x, y, size, fill, core) {
  const r = 4.4 * size;
  const cy = y - 8.4 * size;
  const phi = Math.acos(r / (y - cy));
  ctx.fillStyle = fill;
  ctx.beginPath();
  ctx.arc(x, cy, r, Math.PI / 2 + phi, Math.PI * 2.5 - phi);
  ctx.lineTo(x, y);
  ctx.closePath();
  ctx.fill();
  ctx.fillStyle = core;
  ctx.beginPath();
  ctx.arc(x, cy, 1.7 * size, 0, Math.PI * 2);
  ctx.fill();
}

const CITY_LIGHT = { land: '#ebeae6', park: '#dde3d6', water: '#d0d7dc', street: 'rgba(255,255,255,0.92)', casing: 'rgba(0,0,0,0.08)', road: '#ffffff' };
const CITY_DARK = { land: '#1f2023', park: '#1d2420', water: '#111214', street: 'rgba(255,255,255,0.1)', casing: 'rgba(0,0,0,0.4)', road: 'rgba(255,255,255,0.24)' };

// 一片旋转的街网：路段间距带随机抖动、偶尔缺一条，约每四条有一条较宽的次干道
function strokeStreetGrid(ctx, rand, cx, cy, angle, spacing) {
  const L = 800;
  const minor = [];
  const secondary = [];
  let n = 0;
  for (let off = -L / 2; off <= L / 2; off += spacing * (0.7 + rand() * 0.6)) {
    if (rand() < 0.1) continue;
    (n++ % 4 === 2 ? secondary : minor).push([-L / 2, off, L / 2, off]);
  }
  for (let off = -L / 2; off <= L / 2; off += spacing * (0.9 + rand() * 1.1)) {
    if (rand() < 0.1) continue;
    (n++ % 4 === 1 ? secondary : minor).push([off, -L / 2, off, L / 2]);
  }
  ctx.save();
  ctx.translate(cx, cy);
  ctx.rotate(angle);
  [[minor, 0.8], [secondary, 1.5]].forEach(([lines, width]) => {
    ctx.lineWidth = width;
    ctx.beginPath();
    lines.forEach((l) => {
      ctx.moveTo(l[0], l[1]);
      ctx.lineTo(l[2], l[3]);
    });
    ctx.stroke();
  });
  ctx.restore();
}

// 在海报坐标系（含四周 60 的外延，供迷你地图取景）里生成城市示意：河流 / 海岸、两片不同走向的街区、公园、干道
function drawCity(ctx, seed, pal) {
  const rand = mulberry32(seed);
  const W = POSTER_W;
  const H = POSTER_H;
  const M = 60;
  ctx.fillStyle = pal.land;
  ctx.fillRect(-M, -M, W + M * 2, H + M * 2);

  // 河道中心线：左右贯穿，两岸各一片街区
  const y0 = H * (0.3 + rand() * 0.4);
  const y1 = H * (0.3 + rand() * 0.4);
  const c1 = { x: W * 0.35, y: y0 + (rand() - 0.5) * H * 0.5 };
  const c2 = { x: W * 0.65, y: y1 + (rand() - 0.5) * H * 0.5 };
  const river = (p) => {
    p.moveTo(-M, y0);
    p.bezierCurveTo(c1.x, c1.y, c2.x, c2.y, W + M, y1);
  };
  const coast = rand() < 0.3;
  const angleA = (rand() - 0.5) * 0.9;
  const angleB = angleA + (rand() < 0.5 ? 0.35 : -0.35) + (rand() - 0.5) * 0.3;

  ctx.lineCap = 'butt';
  ctx.strokeStyle = pal.street;
  [[-M, angleA, 14 + rand() * 6], [H + M, angleB, 16 + rand() * 8]].forEach(([edge, angle, spacing]) => {
    ctx.save();
    ctx.beginPath();
    river(ctx);
    ctx.lineTo(W + M, edge);
    ctx.lineTo(-M, edge);
    ctx.closePath();
    ctx.clip();
    strokeStreetGrid(ctx, rand, W * rand(), H * rand(), angle, spacing);
    ctx.restore();
  });

  ctx.fillStyle = pal.park;
  for (let i = 0; i < 3; i++) {
    const pw = 34 + rand() * 46;
    const ph = 26 + rand() * 40;
    ctx.save();
    ctx.translate(W * (0.1 + rand() * 0.8), H * (0.08 + rand() * 0.84));
    ctx.rotate(i % 2 ? angleA : angleB);
    roundedRectPath(ctx, -pw / 2, -ph / 2, pw, ph, 5);
    ctx.fill();
    ctx.restore();
  }

  // 水面：河流，或以海岸线为界的一侧海面
  ctx.fillStyle = pal.water;
  ctx.strokeStyle = pal.water;
  ctx.beginPath();
  river(ctx);
  if (coast) {
    ctx.lineTo(W + M, H + M);
    ctx.lineTo(-M, H + M);
    ctx.closePath();
    ctx.fill();
  } else {
    ctx.lineWidth = 16 + rand() * 12;
    ctx.stroke();
  }

  // 干道：一纵一横一斜，带浅色描边，跨河处即桥
  ctx.lineCap = 'round';
  const roads = [
    [W * rand(), -M, W * rand(), H * 0.5, W * rand(), H * 0.5, W * rand(), H + M],
    [-M, H * rand(), W * 0.5, H * rand(), W * 0.5, H * rand(), W + M, H * rand()],
    [-M, -M + rand() * H * 0.4, W * 0.4, H * 0.4, W * 0.6, H * 0.6, W + M, H * (0.6 + rand() * 0.4)]
  ];
  [[pal.casing, 3.8], [pal.road, 2.4]].forEach(([color, width]) => {
    ctx.strokeStyle = color;
    ctx.lineWidth = width;
    roads.forEach((r, i) => {
      if (coast && i === 1) return;
      ctx.beginPath();
      ctx.moveTo(r[0], r[1]);
      ctx.bezierCurveTo(r[2], r[3], r[4], r[5], r[6], r[7]);
      ctx.stroke();
    });
  });
}

/**
 * 无 token / 下载失败 / 照片没有位置时的离线底图：按种子生成的城市街区示意，同一位置结果稳定，
 * 配色接近 Mapbox light / dark，叠加主题色后与真实地图观感一致。
 * focus 为空时把整张示意图铺满区域；传入时（迷你地图）按 1:1 比例截取 focus 周围的一小块。
 */
function drawFallbackMap(ctx, x, y, w, h, seed, pin, dark, focus) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  if (focus) {
    ctx.translate(x + w / 2 - POSTER_W * focus.x, y + h / 2 - POSTER_H * focus.y);
  } else {
    ctx.translate(x, y);
    ctx.scale(w / POSTER_W, h / POSTER_H);
  }
  drawCity(ctx, seed, dark ? CITY_DARK : CITY_LIGHT);
  if (pin) drawPin(ctx, POSTER_W * pin.x, POSTER_H * pin.y, 1, dark ? '#f2f2f2' : '#141414', dark ? '#1f2023' : '#ebeae6');
  ctx.restore();
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
    drawFallbackMap(ctx, x, y, w, h, info.seed, tpl.map.pin, theme.dark, tpl.map.pin);
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

// Mapbox 要求静态 / 印刷地图附带其标志与文字署名。静态图自带的角标会随各模板的裁切被遮挡或截断，
// 因此请求时关闭，改由模板在固定位置绘制；署名不受文字不透明度影响，离线简约底图不需要署名
const CREDIT_TEXT = '© Mapbox © OpenStreetMap';
const LOGO_RATIO = 80.47 / 20.02;

function creditColor(tone, style) {
  const ink = style.theme.ink;
  if (tone === 'photo') return style.photoAlpha >= 0.5 ? 'rgba(255,255,255,0.8)' : hexToRgba(ink, 0.62);
  if (tone === 'paper') return 'rgba(43,38,34,0.6)';
  if (tone === 'dark') return 'rgba(255,255,255,0.58)';
  return hexToRgba(ink, 0.62);
}

/**
 * @param logo  Mapbox 标志图片（可为 null，只绘制文字）
 * @param spot  { x, y: 文字基线, align: left|center|right, tone: map|photo|paper|dark, rotate? }
 */
function drawMapCredit(ctx, logo, spot, style) {
  const size = 5.2;
  const logoH = 6.6;
  const logoW = logo ? logoH * LOGO_RATIO : 0;
  const gap = logo ? 3.5 : 0;
  ctx.save();
  ctx.translate(spot.x, spot.y);
  if (spot.rotate) ctx.rotate(spot.rotate);
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, size, 500, SANS);
  const total = logoW + gap + measureSpaced(ctx, CREDIT_TEXT, 0.3);
  let x = 0;
  if (spot.align === 'right') x = -total;
  else if (spot.align === 'center') x = -total / 2;
  if (logo) ctx.drawImage(logo, x, -size * 0.36 - logoH / 2, logoW, logoH);
  ctx.fillStyle = creditColor(spot.tone, style);
  drawSpacedText(ctx, CREDIT_TEXT, x + logoW + gap, 0, 0.3, 'left');
  ctx.restore();
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
  drawPin,
  drawFallbackMap,
  applyTint,
  drawMapRegion,
  withAlpha,
  roundedRectPath,
  drawMapWindow,
  photoText,
  drawFullBleedPhoto,
  splitCoord,
  drawMapCredit,
  drawPerforatedStamp,
  setTextAlpha
};
