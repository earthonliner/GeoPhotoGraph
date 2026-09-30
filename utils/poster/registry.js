/**
 * 模板注册表：模板元数据（名称 / 分类 / 地图定位针位置）、取景区域与统一绘制入口 paintPoster。
 */
const {
  POSTER_W,
  POSTER_H,
  FOOTER_H,
  CENTER_PIN,
  tplMap,
  setTextAlpha,
  drawMapCredit
} = require('./core.js');
const { drawWatermark, drawBrandFooter, paintEmpty } = require('./overlay.js');

const FAMILIES = [
  require('./tpl-map.js'),
  require('./tpl-minimal.js'),
  require('./tpl-editorial.js'),
  require('./tpl-travel.js'),
  require('./tpl-culture.js')
];

// category：模板所属分类；hot：同时出现在“热门”分类里；map.pin：定位针在海报中的比例位置；
// credit：地图署名的位置与配色（默认右下角，见 DEFAULT_CREDIT）
const TEMPLATES = [
  { id: 'polaroid', name: '拍立得', category: 'classic', hot: true, map: tplMap({ x: 0.88, y: 0.5 }) },
  { id: 'split', name: '上下分割', category: 'classic', map: tplMap({ x: 0.5, y: 0.19 }), credit: { y: POSTER_H * 0.4 - 7 } },
  { id: 'medallion', name: '地图徽章', category: 'classic', map: tplMap({ x: 0.18, y: 0.846 }), credit: { tone: 'photo' } },
  { id: 'mat', name: '极简白卡', category: 'minimal', hot: true, map: tplMap(CENTER_PIN) },
  { id: 'bar', name: '底栏', category: 'minimal', hot: true, map: tplMap(CENTER_PIN) },
  { id: 'frame', name: '细框', category: 'minimal', hot: true, map: tplMap(CENTER_PIN), credit: { x: POSTER_W - 24, y: POSTER_H - 25, tone: 'photo' } },
  { id: 'rail', name: '侧栏', category: 'minimal', map: tplMap(CENTER_PIN), credit: { x: 10, align: 'left', tone: 'photo' } },
  { id: 'cinema', name: '影幕', category: 'minimal', map: tplMap(CENTER_PIN) },
  { id: 'coord', name: '坐标', category: 'minimal', map: tplMap(CENTER_PIN), credit: { tone: 'photo' } },
  { id: 'magazine', name: '杂志封面', category: 'editorial', hot: true, map: tplMap(CENTER_PIN), credit: { x: POSTER_W - 22, y: POSTER_H - 10, tone: 'photo' } },
  { id: 'glass', name: '玻璃卡片', category: 'editorial', hot: true, map: tplMap(CENTER_PIN), credit: { tone: 'photo' } },
  { id: 'typo', name: '巨字', category: 'editorial', map: tplMap(CENTER_PIN), credit: { tone: 'photo' } },
  { id: 'film', name: '胶片', category: 'retro', map: tplMap(CENTER_PIN), credit: { x: 332, y: 498, tone: 'dark' } },
  { id: 'postcard', name: '明信片', category: 'retro', map: tplMap(CENTER_PIN) },
  { id: 'gallery', name: '画廊展签', category: 'retro', map: tplMap({ x: 0.9, y: 0.28 }) }
];
const DEFAULT_CREDIT = { x: POSTER_W - 10, y: POSTER_H - 7, align: 'right', tone: 'map' };

const HOT_CATEGORY = 'hot';
const CATEGORIES = [
  { id: HOT_CATEGORY, name: '热门' },
  { id: 'minimal', name: '简约' },
  { id: 'classic', name: '经典' },
  { id: 'editorial', name: '杂志' },
  { id: 'retro', name: '复古' }
];

function templatesOf(categoryId) {
  return TEMPLATES.filter((t) => (categoryId === HOT_CATEGORY ? t.hot : t.category === categoryId));
}

const PAINTERS = Object.assign({}, ...FAMILIES.map((f) => f.painters));
// 支持取景调整（拖动 / 缩放）的模板及其照片区域；拍立得与画廊展签完整显示照片，不需要裁切
const CROP_REGIONS = Object.assign({}, ...FAMILIES.map((f) => f.crops));

/**
 * 统一入口：在任意 2D canvas 上绘制整张海报。
 * @param canvas  Canvas 2D 节点（其 width/height 已设置为物理像素）
 * @param assets  { photo, map, qr, mapLogo }（图片对象，map 为 null 时使用离线简约底图）；
 *                assets 为 null 时绘制占位
 * @param style   { theme, mapAlpha, photoAlpha, textAlpha, crop, watermark, footer }，透明度范围 0~1
 */
function paintPoster(canvas, tplId, assets, info, style) {
  const ctx = canvas.getContext('2d');
  const scale = canvas.width / POSTER_W;

  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.setTransform(scale, 0, 0, scale, 0, 0);

  if (!assets) {
    paintEmpty(ctx);
    if (style && style.footer) drawBrandFooter(ctx, POSTER_H, style, null);
    return;
  }
  const tpl = TEMPLATES.find((t) => t.id === tplId) || TEMPLATES[0];
  setTextAlpha(style.textAlpha);
  PAINTERS[tpl.id](ctx, scale, assets, info, tpl, style);
  setTextAlpha(1);
  if (assets.map) drawMapCredit(ctx, assets.mapLogo || null, Object.assign({}, DEFAULT_CREDIT, tpl.credit), style);
  if (style.watermark) drawWatermark(ctx);
  if (style.footer) drawBrandFooter(ctx, POSTER_H, style, assets.qr || null);
}

module.exports = {
  POSTER_W,
  POSTER_H,
  FOOTER_H,
  TEMPLATES,
  HOT_CATEGORY,
  CATEGORIES,
  templatesOf,
  PAINTERS,
  CROP_REGIONS,
  paintPoster
};
