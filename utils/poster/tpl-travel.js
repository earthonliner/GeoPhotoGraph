// 旅行：明信片
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
  drawMapRegion,
  withAlpha,
  roundedRectPath,
  drawMapWindow,
  drawPerforatedStamp
} = require('./core.js');

const POSTCARD_PHOTO = { left: 40, top: 46, w: 320, h: 236 };

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

module.exports = {
  painters: {
    postcard: paintPostcard
  },
  crops: {
    postcard: POSTCARD_PHOTO
  }
};
