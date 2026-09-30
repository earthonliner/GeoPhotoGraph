// 运行：node --test tests/
const test = require('node:test');
const assert = require('node:assert');

const exif = require('../utils/exif-parser');
const config = require('../utils/config');
const mapService = require('../utils/map-service');

// 构造一个带 GPS / DateTimeOriginal / Orientation 的最小 JPEG（大端 TIFF）
function buildJpeg({ lat, lon, latRef = 'N', lonRef = 'E', date = '2024:06:16 10:22:33' }) {
  const parts = [];
  const tiff = [];
  const u16 = (v) => [(v >> 8) & 0xff, v & 0xff];
  const u32 = (v) => [(v >>> 24) & 0xff, (v >> 16) & 0xff, (v >> 8) & 0xff, v & 0xff];
  const entry = (tag, type, count, valueBytes) => [...u16(tag), ...u16(type), ...u32(count), ...valueBytes];
  const rational = (n, d) => [...u32(n), ...u32(d)];
  const dms = (v) => {
    const d = Math.floor(v);
    const m = Math.floor((v - d) * 60);
    const s = Math.round(((v - d) * 60 - m) * 60 * 10000);
    return [...rational(d, 1), ...rational(m, 1), ...rational(s, 10000)];
  };

  // 布局：header(8) | IFD0(2+3*12+4=42) | ExifIFD(2+12+4=18) | GPS IFD(2+4*12+4=54) | data
  const ifd0Off = 8;
  const exifOff = ifd0Off + 42;
  const gpsOff = exifOff + 18;
  const dataOff = gpsOff + 54;
  const dateBytes = [...Buffer.from(date + '\0', 'ascii')];
  const latData = dms(lat);
  const lonData = dms(lon);
  const dateOff = dataOff;
  const latOff = dateOff + dateBytes.length;
  const lonOff = latOff + latData.length;

  tiff.push(0x4d, 0x4d, 0, 42, ...u32(ifd0Off));
  tiff.push(
    ...u16(3),
    ...entry(0x0112, 3, 1, [...u16(6), 0, 0]),
    ...entry(0x8769, 4, 1, u32(exifOff)),
    ...entry(0x8825, 4, 1, u32(gpsOff)),
    ...u32(0)
  );
  tiff.push(...u16(1), ...entry(0x9003, 2, dateBytes.length, u32(dateOff)), ...u32(0));
  tiff.push(
    ...u16(4),
    ...entry(0x0001, 2, 2, [latRef.charCodeAt(0), 0, 0, 0]),
    ...entry(0x0002, 5, 3, u32(latOff)),
    ...entry(0x0003, 2, 2, [lonRef.charCodeAt(0), 0, 0, 0]),
    ...entry(0x0004, 5, 3, u32(lonOff)),
    ...u32(0)
  );
  tiff.push(...dateBytes, ...latData, ...lonData);

  const app1 = [0x45, 0x78, 0x69, 0x66, 0, 0, ...tiff];
  parts.push(0xff, 0xd8);
  // 先放一个 APP0，验证 marker 遍历
  parts.push(0xff, 0xe0, 0, 4, 0, 0);
  parts.push(0xff, 0xe1, ...u16(app1.length + 2), ...app1);
  parts.push(0xff, 0xda, 0, 2, 0xff, 0xd9);
  return Uint8Array.from(parts).buffer;
}

test('parseExif reads GPS, date and orientation', () => {
  const r = exif.parseExif(buildJpeg({ lat: 46.0192, lon: 7.7459 }));
  assert.ok(Math.abs(r.latitude - 46.0192) < 1e-4);
  assert.ok(Math.abs(r.longitude - 7.7459) < 1e-4);
  assert.strictEqual(r.dateTimeOriginal, '2024:06:16 10:22:33');
  assert.strictEqual(r.orientation, 6);
});

test('parseExif applies S / W references', () => {
  const r = exif.parseExif(buildJpeg({ lat: 33.8688, lon: 151.2093, latRef: 'S', lonRef: 'W' }));
  assert.ok(r.latitude < 0 && r.longitude < 0);
});

test('parseExif returns null for non-exif data', () => {
  assert.strictEqual(exif.parseExif(Uint8Array.from([0xff, 0xd8, 0xff, 0xd9]).buffer), null);
  assert.strictEqual(exif.parseExif(new ArrayBuffer(0)), null);
});

test('formatters', () => {
  assert.strictEqual(exif.formatCoordinates(46.0192, 7.7459).text, '46.0192° N  7.7459° E');
  assert.strictEqual(exif.formatCoordinates(-33.5, -70.25, 2).text, '33.50° S  70.25° W');
  assert.strictEqual(exif.formatDate('2024:06:16 10:22:33'), 'JUN 16, 2024');
  assert.strictEqual(exif.formatDate('garbage'), '');
});

test('static map url', () => {
  assert.strictEqual(mapService.buildStaticMapUrl({ lat: 1, lon: 2, width: 100, height: 100 }), '');
  config.mapbox.token = 'pk.test';
  const url = mapService.buildStaticMapUrl({ lat: 46.0192, lon: 7.7459, zoom: 12, width: 600, height: 800 });
  assert.strictEqual(
    url,
    'https://api.mapbox.com/styles/v1/mapbox/light-v11/static/pin-s+000(7.745900,46.019200)/7.745900,46.019200,12,0/600x800@2x?access_token=pk.test'
  );
});

test('pin offset shifts the center but keeps the pin coordinate', () => {
  config.mapbox.token = 'pk.test';
  const url = mapService.buildStaticMapUrl({
    lat: 46.0192,
    lon: 7.7459,
    zoom: 12,
    width: 600,
    height: 800,
    pin: { x: 0.88, y: 0.5 }
  });
  assert.ok(url.includes('pin-s+000(7.745900,46.019200)'));
  const center = /\/(-?[\d.]+),(-?[\d.]+),12,0\//.exec(url);
  // 定位针在偏右位置 => 地图中心应位于目标点以西（经度更小）
  assert.ok(Number(center[1]) < 7.7459);
  assert.ok(Math.abs(Number(center[2]) - 46.0192) < 1e-6);
});

test('gcj02ToWgs84 only shifts inside China', () => {
  const abroad = mapService.gcj02ToWgs84(46.0192, 7.7459);
  assert.deepStrictEqual(abroad, { lat: 46.0192, lon: 7.7459 });
  const cn = mapService.gcj02ToWgs84(39.9087, 116.3975);
  assert.ok(Math.abs(cn.lat - 39.9087) > 1e-4 && Math.abs(cn.lat - 39.9087) < 0.01);
});

const placeName = require('../utils/place-name');

test('place-name: short CJK names become pinyin, long names become initials', () => {
  assert.strictEqual(placeName.normalizePlaceName('北京', 'en'), 'BEIJING');
  assert.strictEqual(placeName.normalizePlaceName('杭州市', 'en'), 'HANGZHOU');
  assert.strictEqual(placeName.normalizePlaceName('成都', 'en'), 'CHENGDU');
  assert.strictEqual(placeName.normalizePlaceName('重庆', 'en'), 'CHONGQING');
  assert.strictEqual(placeName.normalizePlaceName('厦门', 'en'), 'XIAMEN');
  assert.strictEqual(placeName.normalizePlaceName('中关村软件园', 'en'), 'ZGCRJY');
  assert.strictEqual(placeName.normalizePlaceName('中国科学技术大学', 'en'), 'ZGKXJSDX');
});

test('place-name: latin names are uppercased, zh mode keeps CJK', () => {
  assert.strictEqual(placeName.normalizePlaceName('Zermatt', 'en'), 'ZERMATT');
  assert.strictEqual(placeName.normalizePlaceName('Hong Kong', 'en'), 'HONG KONG');
  assert.strictEqual(placeName.normalizePlaceName('杭州', 'zh'), '杭州');
  assert.strictEqual(placeName.normalizePlaceName('', 'en'), '');
});

test('map-service: reverse geocode / search use requested language', async () => {
  config.mapbox.token = 'pk.test';
  const urls = [];
  global.wx = {
    request({ url, success }) {
      urls.push(decodeURIComponent(url));
      if (url.includes('/mapbox.places/7.')) {
        success({
          statusCode: 200,
          data: { features: [{ place_type: ['country'], text: 'Switzerland' }, { place_type: ['place'], text: 'Zermatt', context: [{ id: 'country.1', text: 'Switzerland' }] }] }
        });
      } else {
        success({ statusCode: 200, data: { features: [{ text: 'Matterhorn', place_name: 'Matterhorn, Zermatt', center: [7.65, 45.97] }, { text: 'bad' }] } });
      }
    }
  };
  const geo = await mapService.reverseGeocode(46.0192, 7.7459, 'zh');
  assert.deepStrictEqual(geo, { name: 'Zermatt', country: 'Switzerland' });
  assert.ok(urls[0].includes('language=zh-Hans'));
  const list = await mapService.searchPlaces('Matterhorn', 'en');
  assert.deepStrictEqual(list, [{ name: 'Matterhorn', address: 'Matterhorn, Zermatt', lon: 7.65, lat: 45.97 }]);
  assert.ok(urls[1].includes('language=en'));
  delete global.wx;
});

const themes = require('../utils/themes');

test('themes: parseHex accepts 3/6 digit hex with or without #', () => {
  assert.strictEqual(themes.parseHex('#e8dfd0'), '#E8DFD0');
  assert.strictEqual(themes.parseHex('abc'), '#AABBCC');
  assert.strictEqual(themes.parseHex(' #123456 '), '#123456');
  assert.strictEqual(themes.parseHex('#12345'), null);
  assert.strictEqual(themes.parseHex('zzzzzz'), null);
  assert.strictEqual(themes.parseHex(''), null);
});

test('themes: presets and custom colors resolve dark/light and ink', () => {
  const paper = themes.resolveTheme('paper');
  assert.strictEqual(paper.dark, false);
  assert.strictEqual(paper.ink, '#141414');
  const midnight = themes.resolveTheme('midnight');
  assert.strictEqual(midnight.dark, true);
  assert.strictEqual(midnight.ink, '#F3EFE6');
  assert.strictEqual(themes.resolveTheme('custom', '#102030').dark, true);
  assert.strictEqual(themes.resolveTheme('custom', '#F0E0D0').dark, false);
  assert.strictEqual(themes.resolveTheme('custom', 'nope').tint, themes.DEFAULT_CUSTOM_HEX);
  assert.strictEqual(themes.hexToRgba('#FF8000', 0.5), 'rgba(255,128,0,0.5)');
});

test('static map url uses dark style for dark themes', () => {
  config.mapbox.token = 'pk.test';
  const light = mapService.buildStaticMapUrl({ lat: 1, lon: 2, width: 100, height: 100 });
  const dark = mapService.buildStaticMapUrl({ lat: 1, lon: 2, width: 100, height: 100, dark: true });
  assert.ok(light.includes('/light-v11/'));
  assert.ok(dark.includes('/dark-v11/'));
});

test('themes: hsv <-> hex round trip', () => {
  assert.strictEqual(themes.hsvToHex(0, 1, 1), '#FF0000');
  assert.strictEqual(themes.hsvToHex(120, 1, 1), '#00FF00');
  assert.strictEqual(themes.hsvToHex(240, 1, 1), '#0000FF');
  assert.strictEqual(themes.hsvToHex(0, 0, 1), '#FFFFFF');
  assert.strictEqual(themes.hsvToHex(0, 0, 0), '#000000');
  assert.strictEqual(themes.hsvToHex(360, 1, 1), '#FF0000');
  for (const hex of ['#E8DFD0', '#0F1B2D', '#2B1218', '#6699CC', '#808080']) {
    const { h, s, v } = themes.hexToHsv(hex);
    assert.strictEqual(themes.hsvToHex(h, s, v), hex);
  }
});

test('exif-parser: toDateValue for the date picker', () => {
  assert.strictEqual(exif.toDateValue('2024:06:16 10:22:33'), '2024-06-16');
  assert.strictEqual(exif.toDateValue(new Date(2024, 0, 5)), '2024-01-05');
  assert.strictEqual(exif.toDateValue('2024:13:40 00:00:00'), '');
  assert.strictEqual(exif.toDateValue(''), '');
  assert.strictEqual(exif.formatDate('2024-01-05'), 'JAN 05, 2024');
});

test('batch: random templates cycle through every template before repeating', () => {
  const ids = ['a', 'b', 'c', 'd'];
  const picked = require('../utils/batch').pickRandomTemplates(ids, 4);
  assert.deepStrictEqual(picked.slice().sort(), ids);

  const nine = require('../utils/batch').pickRandomTemplates(ids, 9);
  assert.strictEqual(nine.length, 9);
  assert.deepStrictEqual(nine.slice(0, 4).slice().sort(), ids);
  assert.deepStrictEqual(nine.slice(4, 8).slice().sort(), ids);
  for (let i = 1; i < nine.length; i += 1) assert.notStrictEqual(nine[i], nine[i - 1]);
});

test('batch: deterministic with a seeded random function and handles edge cases', () => {
  const { pickRandomTemplates } = require('../utils/batch');
  const seq = [0.1, 0.9, 0.5, 0.3];
  let n = 0;
  const rand = () => seq[n++ % seq.length];
  const a = pickRandomTemplates(['x', 'y', 'z'], 3, rand);
  n = 0;
  assert.deepStrictEqual(pickRandomTemplates(['x', 'y', 'z'], 3, rand), a);
  assert.deepStrictEqual(pickRandomTemplates(['only'], 3), ['only', 'only', 'only']);
  assert.deepStrictEqual(pickRandomTemplates(['a', 'b'], 0), []);
});

test('membership: invite code is case-insensitive and unlimited', () => {
  const m = require('../utils/membership');
  config.membership.inviteCodes = ['geo0930'];
  assert.ok(m.isValidInvite('geo0930'));
  assert.ok(m.isValidInvite('  GEO0930 '));
  assert.ok(!m.isValidInvite('geo0931'));
  assert.ok(!m.isValidInvite(''));
  const invited = { invite: true, bought: false, packs: [] };
  assert.strictEqual(m.remainingQuota(invited), Infinity);
  assert.strictEqual(m.consume(invited, 5), invited);
  assert.strictEqual(m.label(invited), '会员 · 邀请码');
});

test('membership: plans, prices and quota packs', () => {
  const m = require('../utils/membership');
  const { plans, single } = config.membership;
  const month = plans.find((p) => p.id === 'month');
  const year = plans.find((p) => p.id === 'year');
  assert.deepStrictEqual([single.price, month.price, year.price], [129, 1490, 10990]);
  assert.deepStrictEqual([month.quota, year.quota], [120, 2000]);
  assert.deepStrictEqual([m.formatPrice(129), m.formatPrice(1490), m.formatPrice(10990), m.formatPrice(1900)], ['¥1.29', '¥14.9', '¥109.9', '¥19']);

  const now = Date.UTC(2026, 8, 30);
  const free = { invite: false, bought: false, packs: [] };
  assert.strictEqual(m.remainingQuota(free, now), 0);
  assert.strictEqual(m.label(free, now), '免费版 · 开通会员');

  const s1 = m.addPack(free, month, now);
  assert.strictEqual(m.remainingQuota(s1, now), 120);
  assert.strictEqual(m.label(s1, now), '会员 · 剩余 120 张');
  // 有效期
  assert.strictEqual(m.remainingQuota(s1, now + 29 * m.DAY), 120);
  assert.strictEqual(m.remainingQuota(s1, now + 31 * m.DAY), 0);
  assert.strictEqual(m.label(s1, now + 31 * m.DAY), '额度已用完 · 续购');

  // 消耗额度
  const s2 = m.consume(s1, 20, now);
  assert.strictEqual(m.remainingQuota(s2, now), 100);
  assert.strictEqual(s1.packs[0].used, 0, 'consume does not mutate');
  const s3 = m.consume(s2, 100, now);
  assert.strictEqual(m.remainingQuota(s3, now), 0);
  assert.strictEqual(m.label(s3, now), '额度已用完 · 续购');
  assert.strictEqual(m.remainingQuota(m.consume(s3, 5, now), now), 0);

  // 额外购买：叠加，优先扣最早到期的包
  const s4 = m.addPack(m.addPack(s2, year, now + 5 * m.DAY), month, now + 10 * m.DAY);
  assert.strictEqual(m.remainingQuota(s4, now + 10 * m.DAY), 100 + 2000 + 120);
  const s5 = m.consume(s4, 110, now + 10 * m.DAY);
  const byPlan = (st, id, i) => st.packs.filter((p) => p.planId === id)[i || 0];
  assert.strictEqual(byPlan(s5, 'month', 0).used, 120, 'earliest expiring pack is used first');
  assert.strictEqual(byPlan(s5, 'year').used, 0);
  assert.strictEqual(byPlan(s5, 'month', 1).used, 10, 'then the next earliest');
  assert.strictEqual(m.remainingQuota(s5, now + 10 * m.DAY), 2000 + 110);
  // 过期的包在下次购买时被清理
  assert.strictEqual(m.addPack(s1, year, now + 40 * m.DAY).packs.length, 1);
  assert.ok(m.packLines(s2, plans, now)[0].startsWith('月度会员 剩余 100/120 张'));
});

test('membership: state persists through storage and ignores garbage', () => {
  const m = require('../utils/membership');
  const data = {};
  const storage = { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
  assert.deepStrictEqual(m.load(storage), { invite: false, bought: false, packs: [] });
  const state = { invite: true, bought: true, packs: [{ planId: 'month', quota: 120, used: 3, until: 999 }] };
  m.save(state, storage);
  assert.deepStrictEqual(m.load(storage), state);
  data['geopics.membership'] = 'oops';
  assert.deepStrictEqual(m.load(storage), { invite: false, bought: false, packs: [] });
  data['geopics.membership'] = { invite: false, until: 123 };
  assert.deepStrictEqual(m.load(storage), { invite: false, bought: false, packs: [] });
});
