// 海报绘制的无头测试：用记录调用的假 Canvas 跑遍所有模板与极端输入。
// 运行：node --test tests/*.test.js
const test = require('node:test');
const assert = require('node:assert');

const registry = require('../utils/poster/registry.js');
const core = require('../utils/poster/core.js');
const travel = require('../utils/poster/tpl-travel.js');
const mapTpl = require('../utils/poster/tpl-map.js');
const themes = require('../utils/themes.js');

const { TEMPLATES, CATEGORIES, HOT_CATEGORY, templatesOf, PAINTERS, CROP_REGIONS, paintPoster, POSTER_W, POSTER_H, FOOTER_H } = registry;

const COMPOSITE_OPS = ['source-over', 'multiply', 'screen', 'destination-out', 'source-atop'];
const FONT_RE = /^(normal|italic) \d{3} (\d+(?:\.\d+)?)px \S.*$/;

// 最小 2D 上下文：校验所有数值参数有限、字体串合法、save/restore 成对，并记录文字与图片
function fakeCanvas(width, height) {
  const problems = [];
  const texts = [];
  const images = [];
  let depth = 0;
  let font = 'normal 400 10px sans-serif';
  let op = 'source-over';
  let alpha = 1;
  const check = (name, args) => {
    args.forEach((a, i) => {
      if (typeof a === 'number' && !Number.isFinite(a)) problems.push(`${name} arg ${i} = ${a}`);
    });
  };
  const ctx = {
    fillStyle: '#000',
    strokeStyle: '#000',
    lineWidth: 1,
    lineCap: 'butt',
    lineJoin: 'miter',
    textAlign: 'left',
    textBaseline: 'alphabetic',
    shadowColor: 'rgba(0,0,0,0)',
    shadowBlur: 0,
    shadowOffsetX: 0,
    shadowOffsetY: 0,
    get font() {
      return font;
    },
    set font(v) {
      if (!FONT_RE.test(v)) problems.push(`bad font "${v}"`);
      font = v;
    },
    get globalCompositeOperation() {
      return op;
    },
    set globalCompositeOperation(v) {
      if (COMPOSITE_OPS.includes(v)) op = v;
    },
    get globalAlpha() {
      return alpha;
    },
    set globalAlpha(v) {
      if (!(v >= 0 && v <= 1)) problems.push(`globalAlpha ${v}`);
      alpha = v;
    },
    save() {
      depth += 1;
    },
    restore() {
      depth -= 1;
      if (depth < 0) problems.push('restore without save');
    },
    measureText(text) {
      const m = FONT_RE.exec(font);
      const size = m ? Number(m[2]) : 10;
      const w = Array.from(String(text)).reduce((s, ch) => s + (/[\u3000-\u9fff]/.test(ch) ? 1 : 0.6), 0);
      return { width: w * size };
    },
    fillText(text, ...rest) {
      check('fillText', rest);
      texts.push(String(text));
    },
    strokeText(text, ...rest) {
      check('strokeText', rest);
    },
    drawImage(img, ...rest) {
      check('drawImage', rest);
      if (!img || !(img.width > 0) || !(img.height > 0)) problems.push('drawImage with invalid image');
      images.push(img);
    },
    createLinearGradient(...args) {
      check('createLinearGradient', args);
      return { addColorStop() {} };
    },
    createRadialGradient(...args) {
      check('createRadialGradient', args);
      return { addColorStop() {} };
    },
    setLineDash() {}
  };
  ['setTransform', 'clearRect', 'fillRect', 'strokeRect', 'beginPath', 'closePath', 'moveTo', 'lineTo', 'arc', 'arcTo',
    'bezierCurveTo', 'quadraticCurveTo', 'ellipse', 'rect', 'clip', 'fill', 'stroke', 'translate', 'rotate', 'scale'].forEach((name) => {
    ctx[name] = (...args) => check(name, args);
  });
  return {
    width,
    height,
    getContext: () => ctx,
    result: () => ({ problems, texts, images, depth })
  };
}

const img = (w, h, tag) => ({ width: w, height: h, tag });
const PHOTOS = [img(4032, 3024, 'landscape'), img(3024, 4032, 'portrait'), img(1000, 1000, 'square'), img(6000, 300, 'strip')];
const MAP = img(1200, 1600, 'map');
const LOGO = img(322, 80, 'logo');
const QR = img(430, 430, 'qr');
const PLACES = ['ZERMATT', 'X', '', 'ST. WOLFGANG IM SALZKAMMERGUT', '杭州', '中关村软件园区', 'SÃO PAULO'];

function render(tplId, assets, info, style) {
  const H = POSTER_H + (style && style.footer ? FOOTER_H : 0);
  const canvas = fakeCanvas(POSTER_W * 3, Math.round(H * 3));
  paintPoster(canvas, tplId, assets, info, style);
  return canvas.result();
}

function baseInfo(over) {
  return Object.assign(
    { place: 'ZERMATT', coordText: '46.0207° N  7.7491° E', dateText: 'JUN 16, 2024', seed: 4242, lat: 46.0207, lon: 7.7491, zoom: 12 },
    over
  );
}

function baseStyle(over) {
  return Object.assign(
    { theme: themes.resolveTheme('paper'), mapAlpha: 1, photoAlpha: 1, textAlpha: 1, crop: { zoom: 1, x: 0, y: 0 }, watermark: false, footer: false },
    over
  );
}

test('模板元数据完整：唯一 id、绘制函数、分类、定位针与取景区域', () => {
  const ids = TEMPLATES.map((t) => t.id);
  assert.strictEqual(new Set(ids).size, ids.length);
  assert.ok(TEMPLATES.length >= 25);
  const catIds = CATEGORIES.map((c) => c.id);
  TEMPLATES.forEach((t) => {
    assert.strictEqual(typeof PAINTERS[t.id], 'function', t.id);
    assert.ok(catIds.includes(t.category) && t.category !== HOT_CATEGORY, t.id);
    assert.ok(t.name && t.map && t.map.width === 600 && t.map.height === 800, t.id);
    assert.ok(t.map.pin.x > 0 && t.map.pin.x < 1 && t.map.pin.y > 0 && t.map.pin.y < 1, t.id);
  });
  Object.keys(CROP_REGIONS).forEach((id) => {
    const r = CROP_REGIONS[id];
    assert.ok(ids.includes(id), id);
    assert.ok(r.left >= 0 && r.top >= 0 && r.w > 0 && r.h > 0, id);
    assert.ok(r.left + r.w <= POSTER_W + 1e-6 && r.top + r.h <= POSTER_H + 1e-6, id);
  });
  catIds.filter((c) => c !== HOT_CATEGORY).forEach((c) => assert.ok(templatesOf(c).length >= 3, c));
});

test('热门分类按 hot 排序且序号连续', () => {
  const hot = templatesOf(HOT_CATEGORY);
  assert.deepStrictEqual(hot.map((t) => t.hot), hot.map((t, i) => i + 1));
  assert.strictEqual(hot[0].id, 'polaroid');
});

test('所有模板在各种输入下绘制无异常、无 NaN、save/restore 成对', () => {
  const themesToTry = [themes.resolveTheme('paper'), themes.resolveTheme('midnight'), themes.resolveTheme('custom', '#6699CC')];
  let n = 0;
  TEMPLATES.forEach((t) => {
    PLACES.forEach((place, pi) => {
      const photo = PHOTOS[pi % PHOTOS.length];
      const theme = themesToTry[pi % themesToTry.length];
      [true, false].forEach((withMap) => {
        const noData = pi % 2 === 1;
        const info = baseInfo({
          place,
          dateText: noData ? '' : 'JUN 16, 2024',
          coordText: noData ? '-- ° --  -- ° --' : '46.0207° N  7.7491° E',
          lat: noData ? null : -33.8568,
          lon: noData ? null : 151.2153,
          seed: noData ? 7 : 123456789
        });
        const style = baseStyle({
          theme,
          mapAlpha: withMap ? 1 : 0,
          photoAlpha: pi % 3 === 0 ? 0.3 : 1,
          textAlpha: pi % 4 === 0 ? 0 : 1,
          crop: { zoom: 1 + (pi % 4), x: pi % 2 ? -1 : 1, y: 0.5 },
          watermark: pi % 2 === 0,
          footer: withMap
        });
        const assets = { photo, map: withMap ? MAP : null, qr: withMap ? QR : null, mapLogo: withMap ? LOGO : null };
        const r = render(t.id, assets, info, style);
        const where = `${t.id} / ${place || '(empty)'} / map=${withMap}`;
        assert.deepStrictEqual(r.problems, [], where);
        assert.strictEqual(r.depth, 0, `${where}: unbalanced save/restore`);
        assert.ok(!r.texts.some((s) => /undefined|NaN|null/.test(s)), `${where}: ${r.texts.join('')}`);
        assert.ok(r.images.includes(photo), `${where}: photo not drawn`);
        n++;
      });
    });
  });
  assert.ok(n >= TEMPLATES.length * PLACES.length * 2);
});

test('只有使用真实地图时才绘制 Mapbox 标志与署名', () => {
  TEMPLATES.forEach((t) => {
    const withMap = render(t.id, { photo: PHOTOS[0], map: MAP, mapLogo: LOGO }, baseInfo(), baseStyle());
    assert.ok(withMap.images.includes(LOGO), `${t.id}: logo missing`);
    assert.strictEqual(withMap.texts.filter((s) => s === '©').length, 2, `${t.id}: credit text`);
    const offline = render(t.id, { photo: PHOTOS[0], map: null, mapLogo: null }, baseInfo(), baseStyle());
    assert.ok(!offline.images.includes(LOGO), `${t.id}: logo without map`);
    assert.strictEqual(offline.texts.filter((s) => s === '©').length, 0, `${t.id}: credit without map`);
  });
});

test('空白占位海报（未选照片）', () => {
  const r = render('polaroid', null, null, { footer: true, theme: themes.resolveTheme('paper') });
  assert.deepStrictEqual(r.problems, []);
  assert.strictEqual(r.depth, 0);
  assert.ok(r.texts.length > 0);
});

test('日期解析与汉字日期', () => {
  assert.deepStrictEqual(core.dateParts('JUN 16, 2024'), { y: 2024, m: 6, d: 16 });
  assert.deepStrictEqual(core.dateParts('DEC 01, 1999'), { y: 1999, m: 12, d: 1 });
  assert.strictEqual(core.dateParts(''), null);
  assert.strictEqual(core.dateParts('2024-06-16'), null);
  assert.strictEqual(core.chineseDate({ y: 2024, m: 6, d: 16 }), '二〇二四年六月十六日');
  assert.strictEqual(core.chineseDate({ y: 2025, m: 10, d: 3 }), '二〇二五年十月三日');
  assert.strictEqual(core.chineseDate({ y: 2000, m: 12, d: 31 }), '二〇〇〇年十二月三十一日');
  assert.strictEqual(core.chineseDate({ y: 2021, m: 1, d: 20 }), '二〇二一年一月二十日');
});

test('护照机读区：ICAO 校验位、固定 44 字符、汉字地名转拼音', () => {
  assert.strictEqual(travel.mrzCheck('520727'), '3');
  assert.strictEqual(travel.mrzCheck('L898902C<'), '3');
  assert.strictEqual(travel.mrzCheck('690806'), '1');

  const [a1, a2] = travel.mrzLines(baseInfo());
  assert.strictEqual(a1, 'P<GEOZERMATT<<GEOPICS<<<<<<<<<<<<<<<<<<<<<<<');
  assert.strictEqual(a2.length, 44);
  assert.ok(/^[A-Z0-9<]{44}$/.test(a2));
  assert.ok(a2.includes('GEO240616'));
  assert.ok(a2.includes('460114N0074456E'));

  const [b1] = travel.mrzLines(baseInfo({ place: '杭州' }));
  assert.ok(b1.startsWith('P<GEOHANGZHOU<<GEOPICS'));
  const [c1, c2] = travel.mrzLines(baseInfo({ place: '', dateText: '', lat: null, lon: null }));
  assert.ok(c1.startsWith('P<GEOTRAVELER<<'));
  assert.ok(/^[A-Z0-9<]{44}$/.test(c2));
  const [d1] = travel.mrzLines(baseInfo({ place: 'ST. WOLFGANG IM SALZKAMMERGUT' }));
  assert.strictEqual(d1.length, 44);
  assert.ok(d1.startsWith('P<GEOST<WOLFGANG<IM<SALZKAMMERGUT<<GEOPICS'));
});

test('地图集比例尺取整且不超过上限', () => {
  const bar = mapTpl.scaleBar(0, 12, 84);
  assert.strictEqual(bar.label, '2 KM');
  assert.ok(bar.units > 60 && bar.units <= 84);
  const alps = mapTpl.scaleBar(46.02, 12, 84);
  assert.strictEqual(alps.label, '1 KM');
  const street = mapTpl.scaleBar(31.2, 17, 84);
  assert.ok(/ M$/.test(street.label) && street.units <= 84);
});
