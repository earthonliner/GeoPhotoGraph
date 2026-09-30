// 地图为主的模板：拍立得 / 上下分割 / 地图徽章 / 定位针 / 地图集
const { hexToRgba } = require('../themes.js');
const {
  POSTER_W,
  POSTER_H,
  SANS,
  SERIF,
  TAGLINE,
  mulberry32,
  setFont,
  drawSpacedText,
  fitFontSize,
  drawImageCover,
  fitInside,
  drawPin,
  drawMapRegion,
  withAlpha,
  pad2
} = require('./core.js');

const PIN_PHOTO = { left: 36, top: 116, w: 228, h: 214 };
const ATLAS_FRAME = { x: 32, y: 50, w: 336, h: 336 };
const ATLAS_PHOTO = { left: 32, top: 404, w: 140, h: 104 };

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

// 定位针：地图全屏，照片作为带白边的标注卡片，虚线引向放大的定位针与脉冲圈
function paintPin(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { theme } = style;
  const ink = theme.ink;
  const p = PIN_PHOTO;
  const px = W * tpl.map.pin.x;
  const py = H * tpl.map.pin.y;
  const b = 6;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, W - 48, 44, 20, 800, SANS, 1.5);
  drawSpacedText(ctx, info.place, 24, 64, 1.5, 'left');
  ctx.fillStyle = hexToRgba(ink, 0.7);
  setFont(ctx, 8.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, 24, 84, 1.2, 'left');
  drawSpacedText(ctx, info.dateText, W - 24, 84, 1.2, 'right');

  ctx.fillStyle = hexToRgba(ink, 0.1);
  ctx.beginPath();
  ctx.arc(px, py, 18, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = 0.8;
  [[18, 0.45], [32, 0.26], [48, 0.12]].forEach(([r, a]) => {
    ctx.strokeStyle = hexToRgba(ink, a);
    ctx.beginPath();
    ctx.arc(px, py, r, 0, Math.PI * 2);
    ctx.stroke();
  });

  // 引线：卡片右下角 -> 定位针外圈
  const lx = p.left + p.w + b;
  const ly = p.top + p.h + b;
  const ang = Math.atan2(py - ly, px - lx);
  ctx.save();
  ctx.strokeStyle = hexToRgba(ink, 0.7);
  ctx.lineWidth = 0.8;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(lx, ly);
  ctx.lineTo(px - Math.cos(ang) * 20, py - Math.sin(ang) * 20);
  ctx.stroke();
  ctx.restore();

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 18 * scale;
  ctx.shadowOffsetY = 6 * scale;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(p.left - b, p.top - b, p.w + b * 2, p.h + b * 2);
  ctx.restore();
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.arc(lx, ly, 2.2, 0, Math.PI * 2);
  ctx.fill();

  // 放大的定位针盖住地图自带的小号标记
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 6 * scale;
  ctx.shadowOffsetY = 2 * scale;
  drawPin(ctx, px, py, 2.5, ink, theme.tint);
  ctx.restore();

  ctx.fillStyle = hexToRgba(ink, 0.6);
  setFont(ctx, 6.5, 600, SANS);
  drawSpacedText(ctx, 'YOU WERE HERE', 24, H - 44, 3, 'left');
  ctx.fillStyle = ink;
  setFont(ctx, 13, 400, SERIF, 'italic');
  drawSpacedText(ctx, 'Captured moment, lasting place.', 24, H - 24, 0.3, 'left');
}

// 比例尺：静态图 1 逻辑单位 = 1.5 个地图像素；Mapbox 512px 瓦片下每像素米数 = 78271.517·cos(lat) / 2^zoom
const SCALE_STEPS = [10, 20, 50, 100, 200, 500, 1000, 2000, 5000, 10000, 20000, 50000, 100000, 200000, 500000];
function scaleBar(lat, zoom, maxUnits) {
  const mpu = (1.5 * 78271.517 * Math.cos((lat * Math.PI) / 180)) / Math.pow(2, zoom);
  let meters = 0;
  SCALE_STEPS.forEach((s) => {
    if (s / mpu <= maxUnits) meters = s;
  });
  if (!meters) return null;
  return { units: meters / mpu, label: meters >= 1000 ? `${meters / 1000} KM` : `${meters} M` };
}

// 地图集：平涂主题色页面，带经纬网格与字母编号的方形图版，下方照片与图注、比例尺、指北针
function paintAtlas(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { theme } = style;
  const ink = theme.ink;
  const f = ATLAS_FRAME;
  const p = ATLAS_PHOTO;
  const n = 4;

  ctx.fillStyle = theme.tint;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(f.x, f.y, f.w, f.h);
  ctx.clip();
  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  ctx.restore();

  ctx.strokeStyle = hexToRgba(ink, 0.2);
  ctx.lineWidth = 0.5;
  ctx.beginPath();
  for (let i = 1; i < n; i++) {
    const gx = f.x + (f.w * i) / n;
    const gy = f.y + (f.h * i) / n;
    ctx.moveTo(gx, f.y);
    ctx.lineTo(gx, f.y + f.h);
    ctx.moveTo(f.x, gy);
    ctx.lineTo(f.x + f.w, gy);
  }
  ctx.stroke();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.5;
  ctx.strokeRect(f.x, f.y, f.w, f.h);
  ctx.lineWidth = 1.2;
  ctx.strokeRect(f.x - 3.5, f.y - 3.5, f.w + 7, f.h + 7);

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = hexToRgba(ink, 0.62);
  setFont(ctx, 6.5, 600, SANS);
  for (let i = 0; i < n; i++) {
    const cx = f.x + (f.w * (i + 0.5)) / n;
    const cy = f.y + (f.h * (i + 0.5)) / n + 2.3;
    drawSpacedText(ctx, 'ABCD'[i], cx, f.y - 10, 0, 'center');
    drawSpacedText(ctx, String(i + 1), f.x - 12, cy, 0, 'center');
    drawSpacedText(ctx, String(i + 1), f.x + f.w + 12, cy, 0, 'center');
  }
  setFont(ctx, 6, 600, SANS);
  drawSpacedText(ctx, 'GEOPICS WORLD ATLAS', f.x, 22, 2.6, 'left');
  drawSpacedText(ctx, `PLATE ${pad2(1 + Math.floor(mulberry32(info.seed)() * 96))}`, f.x + f.w, 22, 2.6, 'right');

  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });
  ctx.strokeStyle = hexToRgba(ink, 0.35);
  ctx.lineWidth = 0.5;
  ctx.strokeRect(p.left, p.top, p.w, p.h);

  const tx = p.left + p.w + 16;
  const tw = f.x + f.w - tx;
  ctx.fillStyle = hexToRgba(ink, 0.55);
  setFont(ctx, 6, 600, SANS);
  drawSpacedText(ctx, 'LOCATION', tx, p.top + 10, 2.6, 'left');
  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, tw, 26, 12, 700, SERIF, 0.8);
  drawSpacedText(ctx, info.place, tx, p.top + 36, 0.8, 'left');
  ctx.fillStyle = hexToRgba(ink, 0.72);
  setFont(ctx, 7.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, tx, p.top + 54, 1, 'left');
  drawSpacedText(ctx, info.dateText, tx, p.top + 68, 1, 'left');

  // 只有真实地图才有可信的比例尺
  const bar = assets.map && typeof info.lat === 'number' && info.zoom ? scaleBar(info.lat, info.zoom, 84) : null;
  const by = p.top + p.h - 8;
  if (bar) {
    const seg = bar.units / 4;
    ctx.lineWidth = 0.6;
    ctx.strokeStyle = ink;
    for (let i = 0; i < 4; i++) {
      ctx.fillStyle = i % 2 ? theme.tint : ink;
      ctx.fillRect(tx + seg * i, by, seg, 3);
    }
    ctx.strokeRect(tx, by, bar.units, 3);
    ctx.fillStyle = hexToRgba(ink, 0.72);
    setFont(ctx, 5.5, 600, SANS);
    drawSpacedText(ctx, '0', tx, by - 4, 0, 'center');
    drawSpacedText(ctx, bar.label, tx + bar.units, by - 4, 0.6, 'center');
  }

  const nx = f.x + f.w - 8;
  const ny = by + 3;
  ctx.fillStyle = ink;
  ctx.beginPath();
  ctx.moveTo(nx, ny - 18);
  ctx.lineTo(nx + 5, ny);
  ctx.lineTo(nx, ny - 4);
  ctx.closePath();
  ctx.fill();
  ctx.strokeStyle = ink;
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(nx, ny - 18);
  ctx.lineTo(nx - 5, ny);
  ctx.lineTo(nx, ny - 4);
  ctx.closePath();
  ctx.stroke();
  setFont(ctx, 6.5, 700, SANS);
  drawSpacedText(ctx, 'N', nx, ny - 22, 0, 'center');
}

module.exports = {
  painters: {
    polaroid: paintPolaroid,
    split: paintSplit,
    medallion: paintMedallion,
    pin: paintPin,
    atlas: paintAtlas
  },
  crops: {
    split: { left: 0, top: POSTER_H * 0.4, w: POSTER_W, h: POSTER_H * 0.6 },
    medallion: { left: 0, top: 0, w: POSTER_W, h: POSTER_H },
    pin: PIN_PHOTO,
    atlas: ATLAS_PHOTO
  },
  scaleBar
};
