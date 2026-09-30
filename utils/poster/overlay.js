// 叠加层：免费版水印、底端品牌栏、空白占位
const appConfig = require('../config.js');
const {
  POSTER_W,
  POSTER_H,
  FOOTER_H,
  SANS,
  SERIF,
  setFont,
  measureSpaced,
  drawSpacedText,
  roundedRectPath
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

function paintEmpty(ctx) {
  const W = POSTER_W;
  const H = POSTER_H;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, W, H);
  ctx.strokeStyle = 'rgba(60,60,67,0.12)';
  ctx.lineWidth = 0.6;
  ctx.strokeRect(20, 20, W - 40, H - 40);
  ctx.fillStyle = '#1c1c1e';
  ctx.textBaseline = 'alphabetic';
  setFont(ctx, 30, 800, SANS);
  drawSpacedText(ctx, 'GEOPICS', W / 2, H / 2 - 6, 5, 'center');
  ctx.fillStyle = '#8e8e93';
  setFont(ctx, 9, 400, SERIF, 'italic');
  drawSpacedText(ctx, 'SELECT A PHOTO TO BEGIN', W / 2, H / 2 + 18, 2.4, 'center');
}

module.exports = { drawWatermark, drawLogoMark, drawBrandFooter, paintEmpty };
