// 杂志风格：杂志封面 / 玻璃卡片 / 巨字
const { hexToRgba } = require('../themes.js');
const {
  POSTER_W,
  POSTER_H,
  SANS,
  SERIF,
  TAGLINE,
  setFont,
  measureSpaced,
  drawSpacedText,
  fitFontSize,
  drawMapRegion,
  withAlpha,
  roundedRectPath,
  drawMapWindow,
  photoText,
  drawFullBleedPhoto
} = require('./core.js');

const FULL_PHOTO = { left: 0, top: 0, w: POSTER_W, h: POSTER_H };

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

module.exports = {
  painters: {
    magazine: paintMagazine,
    glass: paintGlass,
    typo: paintTypo
  },
  crops: {
    magazine: FULL_PHOTO,
    glass: FULL_PHOTO,
    typo: FULL_PHOTO
  }
};
