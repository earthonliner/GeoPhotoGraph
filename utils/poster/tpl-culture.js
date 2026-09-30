// 人文：胶片 / 画廊展签
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
  withAlpha,
  roundedRectPath,
  drawMapWindow
} = require('./core.js');

// 胶片画幅与片基（逻辑单位）
const FILM_PHOTO = { left: 68, top: 50, w: 264, h: 368 };
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

module.exports = {
  painters: {
    film: paintFilm,
    gallery: paintGallery
  },
  crops: {
    film: FILM_PHOTO
  }
};
