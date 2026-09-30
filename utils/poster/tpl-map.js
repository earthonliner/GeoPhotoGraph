// 地图为主的模板：拍立得 / 上下分割 / 地图徽章
const { hexToRgba } = require('../themes.js');
const {
  POSTER_W,
  POSTER_H,
  SANS,
  SERIF,
  TAGLINE,
  setFont,
  drawSpacedText,
  fitFontSize,
  drawImageCover,
  fitInside,
  drawMapRegion,
  withAlpha
} = require('./core.js');

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

module.exports = {
  painters: {
    polaroid: paintPolaroid,
    split: paintSplit,
    medallion: paintMedallion
  },
  crops: {
    split: { left: 0, top: POSTER_H * 0.4, w: POSTER_W, h: POSTER_H * 0.6 },
    medallion: { left: 0, top: 0, w: POSTER_W, h: POSTER_H }
  }
};
