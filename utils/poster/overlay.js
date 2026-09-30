// 叠加层：免费版水印、底端品牌栏、空白占位
const appConfig = require('../config.js');
const {
  POSTER_W,
  POSTER_H,
  FOOTER_H,
  SANS,
  SERIF,
  TAGLINE,
  setFont,
  measureSpaced,
  drawSpacedText,
  roundedRectPath,
  drawMapRegion
} = require('./core.js');

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

const EMPTY_THEME = { tint: '#F3F1EC', dark: false, ink: '#141414' };
const EMPTY_PIN = { x: 0.86, y: 0.5 };

// 还没选照片时的示例海报：离线城市底图 + 拍立得相框占位，点按预览即可选择照片
function paintEmpty(ctx, scale) {
  const W = POSTER_W;
  const H = POSTER_H;
  const ink = EMPTY_THEME.ink;
  drawMapRegion(ctx, null, 0, 0, W, H, { map: { pin: EMPTY_PIN } }, { seed: 20240616 }, { theme: EMPTY_THEME, mapAlpha: 0.8 });

  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = ink;
  setFont(ctx, 46, 800, SANS);
  drawSpacedText(ctx, 'YOUR PLACE', 24, 62, 2, 'left');
  ctx.fillStyle = 'rgba(20,20,20,0.6)';
  setFont(ctx, 8.5, 500, SANS);
  drawSpacedText(ctx, 'GPS FROM YOUR PHOTO', 24, 82, 1.2, 'left');
  drawSpacedText(ctx, 'DATE TAKEN', W - 24, 82, 1.2, 'right');

  const fw = 276;
  const fh = 316;
  const fx = (W - fw) / 2;
  const fy = 112;
  const pad = 12;
  const pw = fw - pad * 2;
  const ph = fh - pad - 44;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.22)';
  ctx.shadowBlur = 22 * scale;
  ctx.shadowOffsetY = 8 * scale;
  ctx.fillStyle = '#fbfaf7';
  ctx.fillRect(fx, fy, fw, fh);
  ctx.restore();

  // 照片占位：浅色天空 + 线描山峦与太阳
  const px = fx + pad;
  const py = fy + pad;
  const sky = ctx.createLinearGradient(0, py, 0, py + ph);
  sky.addColorStop(0, '#e6ebee');
  sky.addColorStop(1, '#f3efe8');
  ctx.fillStyle = sky;
  ctx.fillRect(px, py, pw, ph);
  ctx.save();
  ctx.beginPath();
  ctx.rect(px, py, pw, ph);
  ctx.clip();
  ctx.strokeStyle = 'rgba(60,60,67,0.2)';
  ctx.lineWidth = 1.2;
  ctx.lineJoin = 'round';
  ctx.beginPath();
  ctx.arc(px + pw * 0.72, py + ph * 0.3, 16, 0, Math.PI * 2);
  ctx.stroke();
  ctx.beginPath();
  ctx.moveTo(px, py + ph * 0.8);
  ctx.lineTo(px + pw * 0.22, py + ph * 0.52);
  ctx.lineTo(px + pw * 0.36, py + ph * 0.66);
  ctx.lineTo(px + pw * 0.56, py + ph * 0.42);
  ctx.lineTo(px + pw * 0.8, py + ph * 0.7);
  ctx.lineTo(px + pw, py + ph * 0.58);
  ctx.stroke();
  ctx.restore();

  // 中央“添加”按钮
  const cx = px + pw / 2;
  const cy = py + ph / 2 + 6;
  ctx.save();
  ctx.shadowColor = 'rgba(0,0,0,0.16)';
  ctx.shadowBlur = 10 * scale;
  ctx.shadowOffsetY = 3 * scale;
  ctx.fillStyle = '#ffffff';
  ctx.beginPath();
  ctx.arc(cx, cy, 20, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
  ctx.strokeStyle = '#1c1c1e';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx - 7, cy);
  ctx.lineTo(cx + 7, cy);
  ctx.moveTo(cx, cy - 7);
  ctx.lineTo(cx, cy + 7);
  ctx.stroke();

  const stripY = py + ph + 27;
  ctx.fillStyle = '#2a2a2a';
  setFont(ctx, 10, 400, SERIF, 'italic');
  drawSpacedText(ctx, 'Select a photo to begin', px, stripY, 0.4, 'left');
  ctx.fillStyle = '#777777';
  setFont(ctx, 8, 700, SANS);
  drawSpacedText(ctx, 'GEOPICS', fx + fw - pad, stripY, 1.6, 'right');

  ctx.fillStyle = 'rgba(20,20,20,0.8)';
  setFont(ctx, 8, 400, SERIF);
  drawSpacedText(ctx, TAGLINE, W / 2, H - 20, 2.4, 'center');
}

module.exports = { drawWatermark, drawLogoMark, drawBrandFooter, paintEmpty };
