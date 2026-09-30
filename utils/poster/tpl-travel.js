// 旅行：明信片 / 登机牌 / 护照页 / 航空信封
const { hexToRgba } = require('../themes.js');
const { containsCjk, toLatinName } = require('../place-name.js');
const {
  POSTER_W,
  POSTER_H,
  SANS,
  SERIF,
  MONO,
  TAGLINE,
  mulberry32,
  setFont,
  drawSpacedText,
  fitFontSize,
  drawImageCover,
  drawMapRegion,
  withAlpha,
  roundedRectPath,
  drawMapWindow,
  drawPerforatedStamp,
  dateParts,
  pad2,
  drawArcText,
  drawBarcode,
  perforatedPath
} = require('./core.js');
const { drawLogoMark } = require('./overlay.js');

const POSTCARD_PHOTO = { left: 40, top: 46, w: 320, h: 236 };
const BOARD_CARD = { x: 28, y: 34, w: 344, h: 466, r: 14 };
const BOARD_PHOTO = { left: 44, top: 74, w: 312, h: 196 };
const BOARD_TEAR = 404;
const PASS_PHOTO = { left: 28, top: 60, w: 344, h: 232 };
const AIR_PHOTO = { left: 20, top: 20, w: POSTER_W - 40, h: POSTER_H - 40 };
const AIR_RED = '#C8102E';
const AIR_BLUE = '#1F3F8F';
const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];
const CARD_INK = '#1B1B1B';
const CARD_SUB = '#8A8A86';

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

// 票根形卡片：圆角矩形，撕线两端各咬出一个半圆缺口
function ticketPath(ctx, c, tearY, notch) {
  const { x, y, w, h, r } = c;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.arcTo(x + w, y, x + w, y + r, r);
  ctx.lineTo(x + w, tearY - notch);
  ctx.arc(x + w, tearY, notch, -Math.PI / 2, Math.PI / 2, true);
  ctx.lineTo(x + w, y + h - r);
  ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
  ctx.lineTo(x + r, y + h);
  ctx.arcTo(x, y + h, x, y + h - r, r);
  ctx.lineTo(x, tearY + notch);
  ctx.arc(x, tearY, notch, Math.PI / 2, -Math.PI / 2, true);
  ctx.lineTo(x, y + r);
  ctx.arcTo(x, y, x + r, y, r);
  ctx.closePath();
}

function drawField(ctx, label, value, x, y, size) {
  ctx.fillStyle = CARD_SUB;
  setFont(ctx, 5.8, 700, SANS);
  drawSpacedText(ctx, label, x, y, 1.6, 'left');
  ctx.fillStyle = CARD_INK;
  setFont(ctx, size || 10, 700, SANS);
  drawSpacedText(ctx, value, x, y + 15, 0.6, 'left');
}

// 登机牌：地图上的票券卡片，航班号取自日期、登机口与座位由地点决定，票根含迷你地图与条形码
function paintBoarding(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const c = BOARD_CARD;
  const p = BOARD_PHOTO;
  const d = dateParts(info.dateText);
  const rand = mulberry32(info.seed);
  const flight = `GP ${d ? pad2(d.m) + pad2(d.d) : '0520'}`;
  const gate = `${'ABCDE'[Math.floor(rand() * 5)]}${1 + Math.floor(rand() * 32)}`;
  const seat = `${1 + Math.floor(rand() * 40)}${'ACDF'[Math.floor(rand() * 4)]}`;
  const x0 = p.left;
  const x1 = p.left + p.w;

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);

  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 24 * scale;
  ctx.shadowOffsetY = 8 * scale;
  ctx.fillStyle = '#FBFAF6';
  ticketPath(ctx, c, BOARD_TEAR, 10);
  ctx.fill();
  ctx.restore();

  ctx.textBaseline = 'alphabetic';
  drawLogoMark(ctx, x0 + 7, 53, 7, CARD_INK);
  ctx.fillStyle = CARD_INK;
  setFont(ctx, 9.5, 800, SANS);
  drawSpacedText(ctx, 'GEOPICS AIR', x0 + 21, 56.5, 2.4, 'left');
  ctx.fillStyle = CARD_SUB;
  setFont(ctx, 6.5, 700, SANS);
  drawSpacedText(ctx, 'BOARDING PASS', x1, 56, 3, 'right');

  ctx.save();
  roundedRectPath(ctx, p.left, p.top, p.w, p.h, 6);
  ctx.clip();
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(p.left, p.top, p.w, p.h);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });
  ctx.restore();

  const y = p.top + p.h + 24;
  ctx.fillStyle = CARD_SUB;
  setFont(ctx, 5.8, 700, SANS);
  drawSpacedText(ctx, 'DESTINATION', x0, y, 1.6, 'left');
  ctx.fillStyle = CARD_INK;
  fitFontSize(ctx, info.place, p.w, 36, 16, 800, SANS, 1);
  drawSpacedText(ctx, info.place, x0 - 1, y + 36, 1, 'left');

  const fy = y + 60;
  const fields = [
    ['DATE', info.dateText || '—', 0],
    ['FLIGHT', flight, 0.37],
    ['GATE', gate, 0.62],
    ['SEAT', seat, 0.82]
  ];
  fields.forEach(([label, value, at]) => drawField(ctx, label, value, x0 + p.w * at, fy));

  ctx.save();
  ctx.strokeStyle = 'rgba(0,0,0,0.2)';
  ctx.lineWidth = 0.8;
  ctx.setLineDash([3, 3]);
  ctx.beginPath();
  ctx.moveTo(c.x + 16, BOARD_TEAR);
  ctx.lineTo(c.x + c.w - 16, BOARD_TEAR);
  ctx.stroke();
  ctx.restore();

  const sy = BOARD_TEAR + 16;
  const ms = 64;
  ctx.save();
  roundedRectPath(ctx, x0, sy, ms, ms, 6);
  ctx.clip();
  drawMapWindow(ctx, assets.map, x0, sy, ms, ms, tpl, info, style);
  ctx.restore();

  const cx = x0 + ms + 14;
  ctx.fillStyle = CARD_SUB;
  setFont(ctx, 5.8, 700, SANS);
  drawSpacedText(ctx, 'COORDINATES', cx, sy + 10, 1.6, 'left');
  ctx.fillStyle = CARD_INK;
  setFont(ctx, 8.5, 600, SANS);
  const coords = (info.coordText || '').split('  ');
  drawSpacedText(ctx, coords[0] || '', cx, sy + 26, 0.6, 'left');
  drawSpacedText(ctx, coords[1] || '', cx, sy + 40, 0.6, 'left');
  ctx.fillStyle = CARD_SUB;
  setFont(ctx, 5.8, 600, SANS);
  drawSpacedText(ctx, 'MAP YOUR MOMENT', cx, sy + 60, 1.6, 'left');

  const bw = 104;
  drawBarcode(ctx, x1 - bw, sy + 2, bw, 44, info.seed, CARD_INK);
  ctx.fillStyle = CARD_SUB;
  setFont(ctx, 5.8, 600, SANS);
  drawSpacedText(ctx, `${flight.replace(' ', '')} · ${seat} · ${gate}`, x1 - bw / 2, sy + 60, 1.2, 'center');
}

// ICAO 9303 校验位：权重 7 / 3 / 1 循环，字母 A=10 … Z=35，填充符 < 为 0
function mrzCheck(text) {
  const weights = [7, 3, 1];
  let sum = 0;
  Array.from(text).forEach((ch, i) => {
    let v = 0;
    if (ch >= '0' && ch <= '9') v = Number(ch);
    else if (ch >= 'A' && ch <= 'Z') v = ch.charCodeAt(0) - 55;
    sum += v * weights[i % 3];
  });
  return String(sum % 10);
}

function mrzDms(value, degDigits, pos, neg) {
  const a = Math.abs(value);
  const deg = Math.floor(a);
  const min = Math.floor((a - deg) * 60);
  const sec = Math.floor(((a - deg) * 60 - min) * 60);
  return `${String(deg).padStart(degDigits, '0')}${pad2(min)}${pad2(sec)}${value >= 0 ? pos : neg}`;
}

// 护照机读区两行（各 44 字符）：P<GEO + 地名<<GEOPICS；坐标（度分秒）+ 日期 YYMMDD + 校验位
function mrzLines(info) {
  const raw = containsCjk(info.place) ? toLatinName(info.place) : String(info.place || '');
  const name = raw.toUpperCase().replace(/[^A-Z]+/g, '<').replace(/^<+|<+$/g, '') || 'TRAVELER';
  const line1 = `P<GEO${name}<<GEOPICS`.padEnd(44, '<').slice(0, 44);
  const coord =
    typeof info.lat === 'number' && typeof info.lon === 'number'
      ? `${mrzDms(info.lat, 2, 'N', 'S')}${mrzDms(info.lon, 3, 'E', 'W')}`
      : '<'.repeat(15);
  const d = dateParts(info.dateText);
  const date = d ? `${String(d.y).slice(2)}${pad2(d.m)}${pad2(d.d)}` : '<<<<<<';
  const serial = `GP${String(info.seed % 10000000).padStart(7, '0')}`;
  const body = `${serial}${mrzCheck(serial)}GEO${date}${mrzCheck(date)}${coord}`;
  const line2 = `${body}${mrzCheck(body)}`.padEnd(44, '<').slice(0, 44);
  return [line1, line2];
}

// 护照页：主题色底纹 + 细纹防伪波浪线，照片、字段、斜置入境章与底部机读区
function paintPassport(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const { theme } = style;
  const ink = theme.ink;
  const p = PASS_PHOTO;
  const stamp = theme.dark ? '#9DB4E6' : '#2D4A8A';

  drawMapRegion(ctx, assets.map, 0, 0, W, H, tpl, info, style);
  ctx.fillStyle = hexToRgba(theme.tint, 0.6);
  ctx.fillRect(0, 0, W, H);

  ctx.strokeStyle = hexToRgba(ink, 0.1);
  ctx.lineWidth = 0.5;
  for (let k = -2; k < 36; k++) {
    [0, Math.PI].forEach((phase) => {
      ctx.beginPath();
      for (let x = 0; x <= W; x += 4) {
        const yy = k * 15 + Math.sin(x / 26 + k * 0.5 + phase) * 7;
        if (x === 0) ctx.moveTo(x, yy);
        else ctx.lineTo(x, yy);
      }
      ctx.stroke();
    });
  }

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  setFont(ctx, 11, 800, SANS);
  drawSpacedText(ctx, 'PASSPORT', p.left, 42, 3.2, 'left');
  ctx.fillStyle = hexToRgba(ink, 0.62);
  setFont(ctx, 9, 500, SANS);
  drawSpacedText(ctx, '护照 · PASSEPORT', p.left + 94, 41.5, 1.4, 'left');
  setFont(ctx, 6.5, 700, SANS);
  drawSpacedText(ctx, 'TYPE P · GEO', p.left + p.w, 41.5, 2, 'right');

  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });
  ctx.strokeStyle = hexToRgba(ink, 0.25);
  ctx.lineWidth = 0.5;
  ctx.strokeRect(p.left, p.top, p.w, p.h);

  const fx = p.left;
  let fy = p.top + p.h + 26;
  const label = (text, y) => {
    ctx.fillStyle = hexToRgba(ink, 0.55);
    setFont(ctx, 5.8, 700, SANS);
    drawSpacedText(ctx, text, fx, y, 1.4, 'left');
  };
  label('PLACE OF ENTRY / 入境地点', fy);
  ctx.fillStyle = ink;
  fitFontSize(ctx, info.place, 212, 24, 12, 800, SANS, 1.2);
  drawSpacedText(ctx, info.place, fx, fy + 24, 1.2, 'left');
  fy += 46;
  label('DATE OF ENTRY / 入境日期', fy);
  ctx.fillStyle = ink;
  setFont(ctx, 10, 600, SANS);
  drawSpacedText(ctx, info.dateText || '—', fx, fy + 16, 1, 'left');
  fy += 36;
  label('COORDINATES / 坐标', fy);
  ctx.fillStyle = ink;
  setFont(ctx, 9, 600, SANS);
  drawSpacedText(ctx, info.coordText, fx, fy + 15, 0.8, 'left');

  // 入境章：双圈 + 弧形文字 + 中央地名日期
  const d = dateParts(info.dateText);
  ctx.save();
  ctx.translate(304, p.top + p.h + 76);
  ctx.rotate((-14 * Math.PI) / 180);
  ctx.globalAlpha = 0.82;
  ctx.strokeStyle = stamp;
  ctx.fillStyle = stamp;
  ctx.lineWidth = 1.8;
  ctx.beginPath();
  ctx.arc(0, 0, 46, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.7;
  ctx.beginPath();
  ctx.arc(0, 0, 33, 0, Math.PI * 2);
  ctx.stroke();
  setFont(ctx, 6.5, 800, SANS);
  drawArcText(ctx, 'ARRIVAL · 入境', 0, 0, 36.5, -Math.PI / 2, 1.8);
  drawArcText(ctx, 'GEOPICS IMMIGRATION', 0, 0, 42.5, Math.PI / 2, 1.2, true);
  ctx.fillStyle = stamp;
  fitFontSize(ctx, info.place, 52, 12, 6, 800, SANS, 0.6);
  drawSpacedText(ctx, info.place, 0, 1, 0.6, 'center');
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.moveTo(-22, 6);
  ctx.lineTo(22, 6);
  ctx.stroke();
  setFont(ctx, 6.5, 700, SANS);
  drawSpacedText(ctx, d ? `${pad2(d.d)} ${MONTHS[d.m - 1]} ${d.y}` : '', 0, 16, 0.6, 'center');
  ctx.restore();

  const [l1, l2] = mrzLines(info);
  ctx.fillStyle = hexToRgba(ink, 0.85);
  fitFontSize(ctx, l1, W - p.left * 2, 11, 7, 500, MONO, 1.2);
  drawSpacedText(ctx, l1, p.left, H - 58, 1.2, 'left');
  drawSpacedText(ctx, l2, p.left, H - 38, 1.2, 'left');
}

// 航空信封：红蓝斜纹边框内铺满照片，右上角齿孔邮票（迷你地图）与邮戳，左下角寄件标签
function paintAirmail(ctx, scale, assets, info, tpl, style) {
  const W = POSTER_W;
  const H = POSTER_H;
  const p = AIR_PHOTO;
  const paper = '#FBF8F1';
  const band = 12;

  ctx.fillStyle = paper;
  ctx.fillRect(0, 0, W, H);
  ctx.save();
  ctx.beginPath();
  ctx.rect(0, 0, W, H);
  ctx.clip();
  ctx.translate(W / 2, H / 2);
  ctx.rotate(-Math.PI / 4);
  const L = Math.hypot(W, H);
  for (let s = -L / 2, i = 0; s < L / 2; s += 21, i++) {
    ctx.fillStyle = i % 2 ? AIR_BLUE : AIR_RED;
    ctx.fillRect(s, -L / 2, 14, L);
  }
  ctx.restore();
  ctx.fillStyle = paper;
  ctx.fillRect(band, band, W - band * 2, H - band * 2);

  drawMapRegion(ctx, assets.map, p.left, p.top, p.w, p.h, tpl, info, style);
  withAlpha(ctx, style.photoAlpha, () => {
    drawImageCover(ctx, assets.photo, p.left, p.top, p.w, p.h, style.crop);
  });

  const sw = 68;
  const sh = 84;
  const sx = p.left + p.w - 16 - sw;
  const sy = p.top + 16;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.3)';
  ctx.shadowBlur = 8 * scale;
  ctx.shadowOffsetY = 2 * scale;
  ctx.fillStyle = '#FFFDF6';
  perforatedPath(ctx, sx, sy, sw, sh, 2.3, 7.5);
  ctx.fill();
  ctx.restore();
  const inset = 7;
  drawMapWindow(ctx, assets.map, sx + inset, sy + inset, sw - inset * 2, sh - inset * 2 - 16, tpl, info, style);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = '#3a3a3a';
  setFont(ctx, 7, 800, SANS);
  drawSpacedText(ctx, 'GEOPICS', sx + sw / 2, sy + sh - 12, 2, 'center');
  ctx.fillStyle = AIR_RED;
  setFont(ctx, 5, 700, SANS);
  drawSpacedText(ctx, 'PAR AVION', sx + sw / 2, sy + sh - 5.5, 1.4, 'center');

  // 邮戳只压住邮票左边缘，不遮挡票面文字
  ctx.save();
  ctx.translate(sx - 18, sy + sh * 0.62);
  ctx.rotate((-12 * Math.PI) / 180);
  ctx.globalAlpha = 0.75;
  ctx.strokeStyle = '#222222';
  ctx.fillStyle = '#222222';
  ctx.lineWidth = 1.3;
  ctx.beginPath();
  ctx.arc(0, 0, 24, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 0.6;
  ctx.beginPath();
  ctx.arc(0, 0, 19.5, 0, Math.PI * 2);
  ctx.stroke();
  fitFontSize(ctx, info.place, 30, 7, 4.5, 800, SANS, 0.5);
  drawSpacedText(ctx, info.place, 0, -1, 0.5, 'center');
  setFont(ctx, 4.8, 700, SANS);
  drawSpacedText(ctx, info.dateText, 0, 8, 0.3, 'center');
  ctx.restore();

  const lw = 222;
  const lh = 106;
  const lx = p.left + 16;
  const ly = p.top + p.h - 28 - lh;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.25)';
  ctx.shadowBlur = 12 * scale;
  ctx.shadowOffsetY = 3 * scale;
  ctx.fillStyle = '#FFFDF6';
  roundedRectPath(ctx, lx, ly, lw, lh, 3);
  ctx.fill();
  ctx.restore();

  ctx.fillStyle = AIR_BLUE;
  setFont(ctx, 9, 800, SANS);
  drawSpacedText(ctx, 'PAR AVION', lx + 14, ly + 22, 2.2, 'left');
  ctx.fillStyle = AIR_RED;
  setFont(ctx, 6, 700, SANS);
  drawSpacedText(ctx, 'BY AIR MAIL', lx + lw - 14, ly + 21.5, 1.8, 'right');
  ctx.fillStyle = 'rgba(0,0,0,0.12)';
  ctx.fillRect(lx + 14, ly + 30, lw - 28, 0.6);

  ctx.fillStyle = '#2b2622';
  fitFontSize(ctx, info.place, lw - 28, 24, 12, 700, SERIF, 0.8, 'italic');
  drawSpacedText(ctx, info.place, lx + 14, ly + 57, 0.8, 'left');
  ctx.save();
  ctx.strokeStyle = 'rgba(60,50,40,0.35)';
  ctx.lineWidth = 0.6;
  ctx.setLineDash([2, 3]);
  [ly + 77, ly + 95].forEach((y) => {
    ctx.beginPath();
    ctx.moveTo(lx + 14, y);
    ctx.lineTo(lx + lw - 14, y);
    ctx.stroke();
  });
  ctx.restore();
  ctx.fillStyle = '#5a4d3c';
  setFont(ctx, 8.5, 400, SERIF, 'italic');
  drawSpacedText(ctx, info.dateText, lx + 15, ly + 74, 0.5, 'left');
  drawSpacedText(ctx, info.coordText, lx + 15, ly + 92, 0.5, 'left');
}

module.exports = {
  painters: {
    postcard: paintPostcard,
    boarding: paintBoarding,
    passport: paintPassport,
    airmail: paintAirmail
  },
  crops: {
    postcard: POSTCARD_PHOTO,
    boarding: BOARD_PHOTO,
    passport: PASS_PHOTO,
    airmail: AIR_PHOTO
  },
  mrzLines,
  mrzCheck
};
