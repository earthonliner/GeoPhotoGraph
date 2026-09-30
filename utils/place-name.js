/**
 * place-name.js
 *
 * 海报地名规范化：
 * - 中文模式：原样输出（拉丁字母转大写）
 * - 英文模式：地图服务商没有英文名而返回了汉字时，
 *     短地名（汉字数 <= SHORT_LIMIT）转拼音，如 北京 -> BEIJING
 *     长地名转拼音首字母缩写，如 中关村软件园 -> ZGCRJY
 */

const PINYIN_DATA = require('./pinyin-data');

const SHORT_LIMIT = 4;
const CJK_RE = /[\u4e00-\u9fa5]/;

// 多音字 / 地名特例（单字取最常用读音会读错的词），音节以空格分隔
const WORD_OVERRIDES = {
  重庆: 'chong qing',
  厦门: 'xia men',
  西藏: 'xi zang',
  蚌埠: 'beng bu',
  朝阳: 'chao yang',
  六安: 'lu an',
  亳州: 'bo zhou',
  都江堰: 'du jiang yan',
  番禺: 'pan yu',
  长安: 'chang an',
  阆中: 'lang zhong',
  那曲: 'na qu',
  单县: 'shan xian',
  哈尔滨: 'ha er bin',
  呼和浩特: 'hu he hao te',
  乌鲁木齐: 'wu lu mu qi',
  秘鲁: 'bi lu'
};
const OVERRIDE_KEYS = Object.keys(WORD_OVERRIDES).sort((a, b) => b.length - a.length);

// 行政区划后缀：名字较长时去掉，避免 "杭州市" 变成 HANGZHOUSHI
const ADMIN_SUFFIX_RE = /[市县区省镇乡]$/;

let charMap = null;

function getCharMap() {
  if (charMap) return charMap;
  charMap = {};
  PINYIN_DATA.split(';').forEach((group) => {
    const idx = group.indexOf(':');
    const py = group.slice(0, idx).replace(/v/g, 'ü');
    const chars = group.slice(idx + 1);
    for (const ch of chars) charMap[ch] = py;
  });
  return charMap;
}

function containsCjk(text) {
  return CJK_RE.test(String(text || ''));
}

/**
 * 切分为 token：汉字 -> { py }，其他字符 -> { ch }
 */
function tokenize(text) {
  const map = getCharMap();
  const chars = Array.from(text);
  const tokens = [];
  let i = 0;
  while (i < chars.length) {
    const rest = chars.slice(i).join('');
    const key = OVERRIDE_KEYS.find((k) => rest.indexOf(k) === 0);
    if (key) {
      WORD_OVERRIDES[key].split(' ').forEach((py) => tokens.push({ py }));
      i += Array.from(key).length;
      continue;
    }
    const ch = chars[i];
    if (CJK_RE.test(ch)) {
      // 成都 / 京都：词尾的 "都" 读 du
      const isLast = i === chars.length - 1;
      const py = isLast && ch === '都' ? 'du' : map[ch];
      tokens.push(py ? { py } : { ch });
    } else {
      tokens.push({ ch });
    }
    i += 1;
  }
  return tokens;
}

/**
 * 汉字地名 -> 英文字母地名（大写）。
 * 汉字数 <= 4 用完整拼音（无声调、无空格），否则用首字母缩写。
 */
function toLatinName(text) {
  let source = String(text || '').trim();
  const cjkCount = Array.from(source).filter((c) => CJK_RE.test(c)).length;
  if (cjkCount > 2 && ADMIN_SUFFIX_RE.test(source)) source = source.replace(ADMIN_SUFFIX_RE, '');

  const tokens = tokenize(source);
  const cjkTokens = tokens.filter((t) => t.py).length;
  const useFull = cjkTokens <= SHORT_LIMIT;
  const out = tokens
    .map((t) => {
      if (!t.py) return t.ch;
      const py = t.py.replace(/ü/g, 'u');
      return useFull ? py : py[0];
    })
    .join('');
  return out.replace(/\s+/g, ' ').trim().toUpperCase();
}

/**
 * @param {string} name 地图服务返回或用户提供的地名
 * @param {'en'|'zh'} lang 用户选择的地名语言
 */
function normalizePlaceName(name, lang) {
  const text = String(name || '').trim();
  if (!text) return '';
  if (lang === 'zh') return text.toUpperCase();
  return containsCjk(text) ? toLatinName(text) : text.toUpperCase();
}

module.exports = {
  SHORT_LIMIT,
  containsCjk,
  toLatinName,
  normalizePlaceName
};
