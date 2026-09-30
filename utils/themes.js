/**
 * themes.js
 *
 * 地图配色：Mapbox 返回的是灰阶底图，配色在 Canvas 上通过混合模式完成。
 *   浅色主题：白底 + 地图，再用 multiply 叠加主题色 -> 地图陆地呈主题色，道路/文字保持深色细节
 *   深色主题：黑底 + dark 样式地图，再用 screen 叠加主题色 -> 地图叠在主题色之上
 * 两种算法在地图不透明度为 0 时都恰好得到纯主题色，因此不透明度滑块可平滑过渡。
 *
 * 推荐色板刻意选用低饱和、偏灰的色相，避免“塑料感”，更接近印刷品/胶片的质感。
 */

const THEMES = [
  { id: 'paper', name: '纸白', tint: '#F3F1EC' },
  { id: 'sand', name: '沙丘', tint: '#E5D8C3' },
  { id: 'sage', name: '鼠尾草', tint: '#D3DBCC' },
  { id: 'mist', name: '雾蓝', tint: '#D2DCE6' },
  { id: 'blush', name: '裸粉', tint: '#EAD5CF' },
  { id: 'lilac', name: '灰紫', tint: '#D9D3E0' },
  { id: 'midnight', name: '午夜蓝', tint: '#0F1B2D', dark: true },
  { id: 'forest', name: '墨绿', tint: '#10241C', dark: true },
  { id: 'espresso', name: '咖啡', tint: '#2A1D17', dark: true },
  { id: 'burgundy', name: '酒红', tint: '#2B1218', dark: true },
  { id: 'graphite', name: '石墨', tint: '#1B1C1F', dark: true }
];

const DEFAULT_THEME_ID = THEMES[0].id;
const CUSTOM_ID = 'custom';
const DEFAULT_CUSTOM_HEX = '#E8DFD0';

const INK_ON_LIGHT = '#141414';
const INK_ON_DARK = '#F3EFE6';

/**
 * 解析用户输入的颜色："#e8dfd0" / "E8DFD0" / "#eee" -> "#E8DFD0"，非法返回 null
 */
function parseHex(input) {
  let s = String(input || '').trim().replace(/^#/, '');
  if (/^[0-9a-fA-F]{3}$/.test(s)) s = s.replace(/(.)/g, '$1$1');
  if (!/^[0-9a-fA-F]{6}$/.test(s)) return null;
  return `#${s.toUpperCase()}`;
}

function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return { r: (n >> 16) & 255, g: (n >> 8) & 255, b: n & 255 };
}

function hexToRgba(hex, alpha) {
  const { r, g, b } = hexToRgb(hex);
  return `rgba(${r},${g},${b},${alpha})`;
}

// 感知亮度 0~1
function luminance(hex) {
  const { r, g, b } = hexToRgb(hex);
  return (0.299 * r + 0.587 * g + 0.114 * b) / 255;
}

/**
 * HSV -> "#RRGGBB"。h: 0~360，s / v: 0~1
 */
function hsvToHex(h, s, v) {
  const hh = (((h % 360) + 360) % 360) / 60;
  const c = v * s;
  const x = c * (1 - Math.abs((hh % 2) - 1));
  const m = v - c;
  let rgb;
  if (hh < 1) rgb = [c, x, 0];
  else if (hh < 2) rgb = [x, c, 0];
  else if (hh < 3) rgb = [0, c, x];
  else if (hh < 4) rgb = [0, x, c];
  else if (hh < 5) rgb = [x, 0, c];
  else rgb = [c, 0, x];
  const to = (n) => Math.round((n + m) * 255).toString(16).padStart(2, '0');
  return `#${to(rgb[0])}${to(rgb[1])}${to(rgb[2])}`.toUpperCase();
}

/**
 * "#RRGGBB" -> { h: 0~360, s: 0~1, v: 0~1 }
 */
function hexToHsv(hex) {
  const { r, g, b } = hexToRgb(hex);
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const d = max - Math.min(rn, gn, bn);
  let h = 0;
  if (d) {
    if (max === rn) h = ((gn - bn) / d) % 6;
    else if (max === gn) h = (bn - rn) / d + 2;
    else h = (rn - gn) / d + 4;
    h *= 60;
    if (h < 0) h += 360;
  }
  return { h, s: max ? d / max : 0, v: max };
}

/**
 * @param {string} id 预设 id 或 'custom'
 * @param {string} customHex 自定义颜色（id 为 custom 时使用）
 * @returns {{id:string, name:string, tint:string, dark:boolean, ink:string}}
 */
function resolveTheme(id, customHex) {
  let theme = THEMES.find((t) => t.id === id);
  if (!theme) {
    const tint = parseHex(customHex) || DEFAULT_CUSTOM_HEX;
    theme = { id: CUSTOM_ID, name: '自定义', tint, dark: luminance(tint) < 0.42 };
  }
  return {
    id: theme.id,
    name: theme.name,
    tint: theme.tint,
    dark: !!theme.dark,
    ink: theme.dark ? INK_ON_DARK : INK_ON_LIGHT
  };
}

module.exports = {
  THEMES,
  DEFAULT_THEME_ID,
  CUSTOM_ID,
  DEFAULT_CUSTOM_HEX,
  parseHex,
  hexToRgba,
  hsvToHex,
  hexToHsv,
  luminance,
  resolveTheme
};
