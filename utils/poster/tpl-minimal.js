// 简约模板（适合批量）：白卡 / 底栏 / 细框 / 侧栏 / 影幕 / 坐标。
// 版式固定、文字量少，照片方向与地名长短不同也能保持整批统一
const { hexToRgba } = require('../themes.js');
const {
  POSTER_W,
  POSTER_H,
  SANS,
  setFont,
  measureSpaced,
  drawSpacedText,
  fitFontSize,
  drawImageCover,
  drawMapRegion,
  withAlpha,
  roundedRectPath,
  drawMapWindow,
  photoText,
  drawFullBleedPhoto,
  splitCoord
} = require('./core.js');

// 各模板的照片区域（逻辑单位），同时用作取景调整的范围
const FULL_PHOTO = { left: 0, top: 0, w: POSTER_W, h: POSTER_H };
const MAT_PHOTO = { left: 28, top: 28, w: 344, h: 404 };
const BAR_H = 100;
const BAR_PHOTO = { left: 0, top: 0, w: POSTER_W, h: POSTER_H - BAR_H };
const RAIL_W = 64;
const RAIL_PHOTO = { left: 0, top: 0, w: POSTER_W - RAIL_W, h: POSTER_H };
const CINEMA_PHOTO = { left: 0, top: 116, w: POSTER_W, h: 260 };

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

module.exports = {
  painters: {
    mat: paintMat,
    bar: paintBar,
    frame: paintFrame,
    rail: paintRail,
    cinema: paintCinema,
    coord: paintCoord
  },
  crops: {
    mat: MAT_PHOTO,
    bar: BAR_PHOTO,
    frame: FULL_PHOTO,
    rail: RAIL_PHOTO,
    cinema: CINEMA_PHOTO,
    coord: FULL_PHOTO
  }
};
