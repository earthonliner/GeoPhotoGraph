// 人文：胶片 / 画廊展签 / 月洞窗 / 东方竖排 / 手账
const { hexToRgba } = require('../themes.js');
const { containsCjk } = require('../place-name.js');
const {
  POSTER_W,
  POSTER_H,
  SANS,
  SERIF,
  MONO,
  TAGLINE,
  setFont,
  measureSpaced,
  drawSpacedText,
  fitFontSize,
  drawImageCover,
  fitInside,
  drawMapRegion,
  withAlpha,
  roundedRectPath,
  drawMapWindow,
  dateParts,
  pad2,
  chineseDate,
  drawArcText,
  drawVerticalText
} = require('./core.js');

// 胶片画幅与片基（逻辑单位）
const FILM_PHOTO = { left: 68, top: 50, w: 264, h: 368 };
const FILM_STRIP = { x: 44, w: POSTER_W - 88 };
const FILM_AMBER = '#f2a03d';
const MOON = { cx: 200, cy: 228, r: 144 };
const MOON_PHOTO = { left: MOON.cx - MOON.r, top: MOON.cy - MOON.r, w: MOON.r * 2, h: MOON.r * 2 };
const ORIENTAL_PHOTO = { left: 28, top: 40, w: 236, h: 396 };
const SEAL_RED = '#B8322A';
const JOURNAL_PHOTO = { left: 76, top: 72, w: 244, h: 276 };
const JOURNAL_TILT = (-3 * Math.PI) / 180;
const STAMP_RED = '#C0392B';
const STAMP_RED_ON_DARK = '#E8796C';

// 相机背刻风格日期： '24 06 16
function filmDate(dateText) {
  const d = dateParts(dateText);
  if (!d) return dateText || '';
  return `'${String(d.y).slice(2)}  ${pad2(d.m)}  ${pad2(d.d)}`;
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

// 月洞窗：圆形取景，外环上沿弧形排布地名（上）与坐标（下），下方衬线斜体日期
function paintMoon(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = style.theme.ink;
  const { cx, cy, r } = MOON;
  const inner = r + 7;
  const outer = r + 31;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  ctx.save();
  ctx.beginPath();
  ctx.arc(cx, cy, r, 0, Math.PI * 2);
  ctx.clip();
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, cx - r, cy - r, r * 2, r * 2, style.crop);
  });
  ctx.restore();

  // 外环铺一层主题色，弧形文字不受地图纹理干扰
  ctx.fillStyle = hexToRgba(style.theme.tint, 0.88);
  ctx.beginPath();
  ctx.arc(cx, cy, outer, 0, Math.PI * 2);
  ctx.arc(cx, cy, r, 0, Math.PI * 2, true);
  ctx.fill();

  ctx.strokeStyle = hexToRgba(ink, 0.5);
  ctx.lineWidth = 0.6;
  [inner, outer].forEach((rr) => {
    ctx.beginPath();
    ctx.arc(cx, cy, rr, 0, Math.PI * 2);
    ctx.stroke();
  });
  ctx.fillStyle = ink;
  [0, Math.PI].forEach((a) => {
    ctx.beginPath();
    ctx.arc(cx + Math.cos(a) * (inner + 12), cy + Math.sin(a) * (inner + 12), 1.6, 0, Math.PI * 2);
    ctx.fill();
  });

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  const band = outer - inner;
  const size = fitFontSize(ctx, info.place, (inner + 8) * 2.3, 11, 7, 700, SANS, 4.5);
  drawArcText(ctx, info.place, cx, cy, inner + (band - size * 0.72) / 2, -Math.PI / 2, 4.5);
  ctx.fillStyle = hexToRgba(ink, 0.72);
  setFont(ctx, 7.5, 500, SANS);
  drawArcText(ctx, info.coordText, cx, cy, inner + (band + 7.5 * 0.72) / 2, Math.PI / 2, 2, true);

  const below = cy + outer;
  ctx.fillStyle = ink;
  setFont(ctx, 17, 400, SERIF, 'italic');
  drawSpacedText(ctx, info.dateText, W / 2, below + 44, 0.6, 'center');
  ctx.fillStyle = hexToRgba(ink, 0.7);
  setFont(ctx, 7, 400, SERIF);
  drawSpacedText(ctx, TAGLINE, W / 2, H - 24, 2.4, 'center');
}

// 东方竖排：宣纸感底色，左侧长幅照片，右侧竖排地名与汉字日期，朱红印章
function paintOriental(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { theme } = style;
  const ink = theme.ink;
  const p = ORIENTAL_PHOTO;
  const right = p.left + p.w;
  const nameX = (right + W - 20) / 2 + 12;
  const top = p.top + 22;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  ctx.fillStyle = hexToRgba(theme.tint, 0.72);
  ctx.fillRect(0, 0, W, H);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  let nameBottom;
  if (containsCjk(info.place)) {
    const count = Array.from(info.place).filter((ch) => ch.trim()).length;
    const size = Math.max(16, Math.min(40, Math.floor(300 / count) - 8));
    setFont(ctx, size, 700, SERIF);
    drawVerticalText(ctx, info.place, nameX, top + size * 0.88, size + 8);
    nameBottom = top + count * (size + 8) - 8;
  } else {
    // 拉丁字母地名顺时针旋转 90°，从上往下读
    const size = fitFontSize(ctx, info.place, 300, 32, 14, 600, SERIF, 4);
    ctx.save();
    ctx.translate(nameX - size * 0.36, top);
    ctx.rotate(Math.PI / 2);
    drawSpacedText(ctx, info.place, 0, 0, 4, 'left');
    ctx.restore();
    nameBottom = top + measureSpaced(ctx, info.place, 4);
  }

  const d = dateParts(info.dateText);
  if (d) {
    ctx.fillStyle = hexToRgba(ink, 0.7);
    setFont(ctx, 11, 400, SERIF);
    drawVerticalText(ctx, chineseDate(d), right + 20, top + 10, 15);
  }

  const sw = 22;
  const sh = 42;
  const sx = nameX - sw / 2;
  const sy = Math.min(nameBottom + 18, p.top + p.h - sh);
  ctx.fillStyle = SEAL_RED;
  roundedRectPath(ctx, sx, sy, sw, sh, 2);
  ctx.fill();
  ctx.fillStyle = '#FBF3EA';
  setFont(ctx, 13, 700, SERIF);
  drawVerticalText(ctx, '留影', nameX, sy + 18, 16);

  const by = p.top + p.h + 34;
  ctx.fillStyle = hexToRgba(ink, 0.25);
  ctx.fillRect(p.left, by - 18, W - p.left * 2, 0.6);
  ctx.fillStyle = hexToRgba(ink, 0.65);
  setFont(ctx, 7.5, 500, SANS);
  drawSpacedText(ctx, info.coordText, p.left, by, 1.6, 'left');
  drawSpacedText(ctx, info.dateText, W - p.left, by, 1.6, 'right');
  setFont(ctx, 6.5, 400, SERIF);
  ctx.fillStyle = hexToRgba(ink, 0.5);
  drawSpacedText(ctx, TAGLINE, p.left, by + 18, 2.2, 'left');
}

function drawTape(ctx, x, y, angle) {
  ctx.save();
  ctx.translate(x, y);
  ctx.rotate(angle);
  ctx.fillStyle = 'rgba(232,201,160,0.8)';
  ctx.fillRect(-32, -9, 64, 18);
  ctx.fillStyle = 'rgba(255,255,255,0.25)';
  for (let i = -28; i < 32; i += 8) ctx.fillRect(i, -9, 3, 18);
  ctx.restore();
}

// 手账：点阵纸 + 胶带固定的斜放照片，圆形地图贴纸，手写感斜体地名与红色日期章
function paintJournal(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { theme } = style;
  const ink = theme.ink;
  const p = JOURNAL_PHOTO;
  const pcx = p.left + p.w / 2;
  const pcy = p.top + p.h / 2;
  const b = 8;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  ctx.fillStyle = hexToRgba(theme.tint, 0.84);
  ctx.fillRect(0, 0, W, H);
  ctx.fillStyle = hexToRgba(ink, 0.16);
  ctx.beginPath();
  for (let y = 16; y < H; y += 16) {
    for (let x = 16; x < W; x += 16) {
      ctx.moveTo(x + 0.75, y);
      ctx.arc(x, y, 0.75, 0, Math.PI * 2);
    }
  }
  ctx.fill();

  ctx.save();
  ctx.translate(pcx, pcy);
  ctx.rotate(JOURNAL_TILT);
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.24)';
  ctx.shadowBlur = 14 * scale;
  ctx.shadowOffsetY = 5 * scale;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(-p.w / 2 - b, -p.h / 2 - b, p.w + b * 2, p.h + b * 2);
  ctx.restore();
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, -p.w / 2, -p.h / 2, p.w, p.h, style.crop);
  });
  ctx.restore();

  const corner = (sx, sy) => {
    const x = sx * (p.w / 2 + b);
    const y = sy * (p.h / 2 + b);
    return {
      x: pcx + x * Math.cos(JOURNAL_TILT) - y * Math.sin(JOURNAL_TILT),
      y: pcy + x * Math.sin(JOURNAL_TILT) + y * Math.cos(JOURNAL_TILT)
    };
  };
  const tl = corner(-1, -1);
  const tr = corner(1, -1);
  drawTape(ctx, tl.x + 6, tl.y + 4, (-38 * Math.PI) / 180);
  drawTape(ctx, tr.x - 6, tr.y + 4, (36 * Math.PI) / 180);

  const r = 38;
  const mx = W - 76;
  const my = p.top + p.h + 20;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 10 * scale;
  ctx.shadowOffsetY = 3 * scale;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(mx, my, r + 4, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.save();
  ctx.beginPath();
  ctx.arc(mx, my, r, 0, Math.PI * 2);
  ctx.clip();
  drawMapWindow(ctx, assets.map, mx - r, my - r, r * 2, r * 2, tpl, info, style);
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  ctx.save();
  ctx.translate(34, 438);
  ctx.rotate((-2 * Math.PI) / 180);
  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, mx - r - 34 - 22, 34, 14, 700, SERIF, 0.6, 'italic');
  drawSpacedText(ctx, info.place, 0, 0, 0.6, 'left');
  ctx.fillStyle = hexToRgba(ink, 0.65);
  setFont(ctx, 9.5, 400, SERIF, 'italic');
  drawSpacedText(ctx, info.coordText, 2, 22, 0.4, 'left');
  ctx.restore();

  const d = dateParts(info.dateText);
  if (d) {
    const text = `${d.y} · ${pad2(d.m)} · ${pad2(d.d)}`;
    const red = theme.dark ? STAMP_RED_ON_DARK : STAMP_RED;
    ctx.save();
    ctx.translate(40, 484);
    ctx.rotate((-6 * Math.PI) / 180);
    ctx.globalAlpha = 0.85;
    setFont(ctx, 9.5, 700, MONO);
    const tw = measureSpaced(ctx, text, 1);
    ctx.strokeStyle = red;
    ctx.lineWidth = 1.2;
    roundedRectPath(ctx, 0, -14, tw + 16, 21, 3);
    ctx.stroke();
    ctx.fillStyle = red;
    drawSpacedText(ctx, text, 8, 0, 1, 'left');
    ctx.restore();
  }
}

module.exports = {
  painters: {
    film: paintFilm,
    gallery: paintGallery,
    moon: paintMoon,
    oriental: paintOriental,
    journal: paintJournal
  },
  crops: {
    film: FILM_PHOTO,
    moon: MOON_PHOTO,
    oriental: ORIENTAL_PHOTO,
    journal: JOURNAL_PHOTO
  }
};
