// 运行：node --test tests/*.test.js
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
  config.mapbox.token = '';
  assert.strictEqual(mapService.buildStaticMapUrl({ lat: 1, lon: 2, width: 100, height: 100 }), '');
  config.mapbox.token = 'pk.test';
  const url = mapService.buildStaticMapUrl({ lat: 46.0192, lon: 7.7459, zoom: 12, width: 600, height: 800 });
  assert.strictEqual(
    url,
    'https://api.mapbox.com/styles/v1/mapbox/light-v11/static/pin-s+000(7.745900,46.019200)/7.745900,46.019200,12,0/600x800@2x?attribution=false&logo=false&access_token=pk.test'
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
  assert.deepStrictEqual(geo, { name: 'Zermatt', country: 'Switzerland', parts: { country: 'Switzerland', city: 'Zermatt' } });
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

const POLAROID = 'polaroid';
const OTHER = 'magazine';

test('membership: invite code is case-insensitive and unlimited', () => {
  const m = require('../utils/membership');
  config.membership.inviteCodes = ['geo0930'];
  assert.ok(m.isValidInvite('geo0930'));
  assert.ok(m.isValidInvite('  GEO0930 '));
  assert.ok(!m.isValidInvite('geo0931'));
  assert.ok(!m.isValidInvite(''));
  const invited = m.normalize({ invite: true });
  assert.strictEqual(m.paidRemaining(invited), Infinity);
  assert.strictEqual(m.availableQuota(invited, OTHER), Infinity);
  assert.strictEqual(m.consume(invited, [OTHER, POLAROID]), invited);
  assert.strictEqual(m.label(invited), '会员 · 邀请码');
  assert.ok(m.isMember(invited) && m.batchAllowed(invited));
});

test('membership: catalogue, prices and formatting', () => {
  const m = require('../utils/membership');
  const { plans, single, lifetime, free } = config.membership;
  const month = plans.find((p) => p.id === 'month');
  const year = plans.find((p) => p.id === 'year');
  assert.deepStrictEqual([single.price, month.price, year.price, lifetime.price], [129, 1490, 10990, 29900]);
  assert.deepStrictEqual([month.quota, year.quota, lifetime.monthly], [120, 2000, 120]);
  assert.deepStrictEqual(free, { templates: ['polaroid'], monthly: 10 });
  assert.deepStrictEqual([m.formatPrice(129), m.formatPrice(1490), m.formatPrice(10990), m.formatPrice(1900)], ['¥1.29', '¥14.9', '¥109.9', '¥19']);
  const { TEMPLATES } = require('../utils/poster/registry');
  free.templates.forEach((id) => assert.ok(TEMPLATES.some((t) => t.id === id), `free template ${id} exists`));
});

test('membership: free tier covers polaroid only, 10 a month in Beijing time', () => {
  const m = require('../utils/membership');
  const now = Date.UTC(2026, 8, 30, 10);
  const fresh = m.load({ get: () => null, set() {} });
  assert.strictEqual(m.monthKey(now), '2026-09');
  assert.strictEqual(m.freeRemaining(fresh, now), 10);
  assert.strictEqual(m.availableQuota(fresh, POLAROID, now), 10);
  assert.strictEqual(m.availableQuota(fresh, OTHER, now), 0, 'other templates stay watermarked without payment');
  assert.ok(!m.isMember(fresh, now) && !m.batchAllowed(fresh, now));
  assert.strictEqual(m.label(fresh, now), '拍立得本月免费剩余 10 张 · 开通会员');
  assert.strictEqual(m.chipLabel(fresh, now), '免费 · 10 张');

  let st = m.consume(fresh, Array(4).fill(POLAROID), now);
  assert.strictEqual(m.freeRemaining(st, now), 6);
  assert.strictEqual(fresh.freeUsed, 0, 'consume does not mutate');
  st = m.consume(st, Array(9).fill(POLAROID), now);
  assert.strictEqual(m.freeRemaining(st, now), 0);
  assert.strictEqual(m.availableQuota(st, POLAROID, now), 0);
  assert.strictEqual(m.label(st, now), '本月免费额度已用完 · 开通会员');
  assert.strictEqual(m.label(st, now, false), '本月免费额度已用完', 'no purchase prompt where purchases are unavailable');
  assert.strictEqual(m.chipLabel(st, now), '开通会员');
  assert.strictEqual(m.chipLabel(st, now, false), '额度已用完');

  // 北京时间次月 1 日 00:00 重置，与手机时区无关
  assert.strictEqual(m.freeRemaining(st, Date.UTC(2026, 8, 30, 15, 59, 59)), 0);
  assert.strictEqual(m.monthKey(Date.UTC(2026, 8, 30, 16, 0, 0)), '2026-10');
  assert.strictEqual(m.freeRemaining(st, Date.UTC(2026, 8, 30, 16, 0, 0)), 10);
  assert.strictEqual(m.monthKey(Date.UTC(2026, 11, 31, 16)), '2027-01');

  // 换月后再消耗，计数从 0 开始
  const next = Date.UTC(2026, 9, 2);
  const after = m.consume(st, [POLAROID], next);
  assert.strictEqual(after.freeMonth, '2026-10');
  assert.strictEqual(m.freeRemaining(after, next), 9);

  // 非免费模板不消耗免费额度
  const other = m.consume(fresh, [OTHER], now);
  assert.strictEqual(m.freeRemaining(other, now), 10);
});

test('membership: quota packs stack, expire and are spent earliest-first', () => {
  const m = require('../utils/membership');
  const { plans } = config.membership;
  const month = plans.find((p) => p.id === 'month');
  const year = plans.find((p) => p.id === 'year');
  const now = Date.UTC(2026, 8, 30, 10);
  const none = m.normalize({});

  const s1 = m.addPack(none, month, now);
  assert.strictEqual(m.packsRemaining(s1, now), 120);
  assert.ok(m.isMember(s1, now) && m.batchAllowed(s1, now));
  assert.strictEqual(m.label(s1, now), '会员 · 剩余 120 张');
  assert.strictEqual(m.availableQuota(s1, OTHER, now), 120, 'paid quota works for every template');
  assert.strictEqual(m.availableQuota(s1, POLAROID, now), 130, 'polaroid also has the monthly free quota');
  assert.strictEqual(m.packsRemaining(s1, now + 29 * m.DAY), 120);
  assert.strictEqual(m.packsRemaining(s1, now + 31 * m.DAY), 0);
  assert.ok(!m.isMember(s1, now + 31 * m.DAY), 'expired pack is no longer a membership');
  assert.strictEqual(m.label(s1, now + 31 * m.DAY), '会员已到期 · 续购');

  const s2 = m.consume(s1, Array(20).fill(OTHER), now);
  assert.strictEqual(m.packsRemaining(s2, now), 100);
  assert.strictEqual(s1.packs[0].used, 0, 'consume does not mutate');
  const s3 = m.consume(s2, Array(100).fill(OTHER), now);
  assert.strictEqual(m.packsRemaining(s3, now), 0);
  assert.ok(m.isMember(s3, now), 'a used-up pack is still a membership until it expires');
  assert.strictEqual(m.label(s3, now), '额度已用完 · 续购');
  assert.strictEqual(m.chipLabel(s3, now), '续购会员');

  const s4 = m.addPack(m.addPack(s2, year, now + 5 * m.DAY), month, now + 10 * m.DAY);
  const t10 = now + 10 * m.DAY;
  assert.strictEqual(m.packsRemaining(s4, t10), 100 + 2000 + 120);
  const s5 = m.consume(s4, Array(110).fill(OTHER), t10);
  const byPlan = (st, id, i) => st.packs.filter((p) => p.planId === id)[i || 0];
  assert.strictEqual(byPlan(s5, 'month', 0).used, 120, 'earliest expiring pack is used first');
  assert.strictEqual(byPlan(s5, 'year').used, 0);
  assert.strictEqual(byPlan(s5, 'month', 1).used, 10);
  assert.strictEqual(m.addPack(s1, year, now + 40 * m.DAY).packs.length, 1, 'expired packs are dropped on the next purchase');
  assert.ok(m.packLines(s2, plans, now)[0].startsWith('月度会员 剩余 100/120 张'));
});

test('membership: lifetime plan has a monthly limit that resets each month', () => {
  const m = require('../utils/membership');
  const { lifetime } = config.membership;
  const now = Date.UTC(2026, 8, 30, 10);
  const none = m.normalize({});

  const s1 = m.addLifetime(none, lifetime, now);
  assert.ok(m.hasLifetime(s1) && s1.bought);
  assert.ok(m.isMember(s1, now + 3650 * m.DAY), 'never expires');
  assert.ok(m.batchAllowed(s1, now + 3650 * m.DAY));
  assert.strictEqual(m.lifetimeRemaining(s1, now), 120);
  assert.strictEqual(m.label(s1, now), '会员 · 剩余 120 张');
  assert.strictEqual(m.chipLabel(s1, now), '会员 · 120 张');
  assert.deepStrictEqual(m.addLifetime(s1, lifetime, now + 40 * m.DAY).lifetime, s1.lifetime, 'buying twice keeps the original record');

  const used = m.consume(s1, Array(118).fill(OTHER), now);
  assert.strictEqual(m.lifetimeRemaining(used, now), 2);
  assert.ok(m.packLines(used, [], now)[0].startsWith('买断会员 本月剩余 2/120 张'));
  const out = m.consume(used, Array(2).fill(OTHER), now);
  assert.strictEqual(m.lifetimeRemaining(out, now), 0);
  assert.strictEqual(m.paidRemaining(out, now), 0);
  assert.strictEqual(m.label(out, now), '会员 · 本月额度已用完');
  assert.strictEqual(m.chipLabel(out, now), '会员 · 已用完');
  assert.strictEqual(m.availableQuota(out, OTHER, now), 0);
  assert.strictEqual(m.availableQuota(out, POLAROID, now), 10, 'free polaroid quota still applies');

  const nextMonth = Date.UTC(2026, 9, 1, 1);
  assert.strictEqual(m.lifetimeRemaining(out, nextMonth), 120, 'resets on the 1st, not carried over');
  const again = m.consume(out, [OTHER], nextMonth);
  assert.strictEqual(m.lifetimeRemaining(again, nextMonth), 119);
  assert.strictEqual(again.lifetime.month, '2026-10');
});

test('membership: spending order is free, lifetime month, earliest pack, then singles', () => {
  const m = require('../utils/membership');
  const { plans, lifetime } = config.membership;
  const month = plans.find((p) => p.id === 'month');
  const now = Date.UTC(2026, 8, 30, 10);
  let st = m.addSingle(m.addPack(m.addLifetime(m.normalize({}), lifetime, now), month, now));
  assert.strictEqual(m.singlesRemaining(st), 1);
  assert.strictEqual(m.paidRemaining(st, now), 120 + 120 + 1);

  const tpls = [POLAROID, POLAROID, OTHER].concat(Array(120).fill(OTHER));
  st = m.consume(st, tpls, now);
  assert.strictEqual(st.freeUsed, 2);
  assert.strictEqual(m.lifetimeRemaining(st, now), 0, 'the monthly lifetime quota is spent before packs');
  assert.strictEqual(st.packs[0].used, 121 - 120, 'overflow goes to the pack');
  assert.strictEqual(m.singlesRemaining(st), 1, 'single quota is kept for last');

  // 单张额度可用于任何模板，用后清零
  const single = m.consume(m.addSingle(m.normalize({})), [OTHER], now);
  assert.strictEqual(m.singlesRemaining(single), 0);
  // 只买单张不含批量
  const onlySingle = m.addSingle(m.normalize({}));
  assert.ok(!m.isMember(onlySingle, now) && !m.batchAllowed(onlySingle, now));
  assert.strictEqual(m.availableQuota(onlySingle, OTHER, now), 1);
  assert.strictEqual(m.chipLabel(onlySingle, now), '剩余 1 张');
  assert.strictEqual(m.label(onlySingle, now, false), '剩余 1 张');
});

test('membership: state persists through storage and ignores garbage', () => {
  const m = require('../utils/membership');
  const data = {};
  const storage = { get: (k) => data[k], set: (k, v) => { data[k] = v; } };
  const blank = { invite: false, bought: false, freeMonth: '', freeUsed: 0, singles: 0, lifetime: null, packs: [] };
  assert.deepStrictEqual(m.load(storage), blank);
  const state = {
    invite: true,
    bought: true,
    freeMonth: '2026-09',
    freeUsed: 1,
    singles: 2,
    lifetime: { planId: 'lifetime', quota: 120, month: '2026-09', used: 4 },
    packs: [{ planId: 'month', quota: 120, used: 3, until: 999 }]
  };
  m.save(state, storage);
  assert.deepStrictEqual(m.load(storage), state);
  data['geopics.membership'] = 'oops';
  assert.deepStrictEqual(m.load(storage), blank);
  data['geopics.membership'] = { invite: false, until: 123, lifetime: 'yes', freeUsed: 'x' };
  assert.deepStrictEqual(m.load(storage), blank);
  // 旧版本缓存里的 freeUsed 没有月份，按新的一月处理
  data['geopics.membership'] = { freeUsed: 2 };
  assert.strictEqual(m.freeRemaining(m.load(storage), Date.UTC(2026, 8, 30)), 10);
  assert.strictEqual(m.load({ get: () => ({ freeUsed: -3 }) }).freeUsed, 0);
});

test('place-name: long city names drop German/English qualifiers', () => {
  const pn = require('../utils/place-name');
  assert.strictEqual(pn.shortenCityName('St. Wolfgang im Salzkammergut'), 'St. Wolfgang');
  assert.strictEqual(pn.shortenCityName('Frankfurt am Main'), 'Frankfurt');
  assert.strictEqual(pn.shortenCityName('Newcastle upon Tyne'), 'Newcastle');
  assert.strictEqual(pn.shortenCityName('Rothenburg ob der Tauber'), 'Rothenburg');
  // 短名、无限定词的长名、汉字名保持原样
  assert.strictEqual(pn.shortenCityName('Weil am Rhein'), 'Weil am Rhein');
  assert.strictEqual(pn.shortenCityName('San Francisco Bay Area'), 'San Francisco Bay Area');
  assert.strictEqual(pn.shortenCityName('杭州市西湖区'), '杭州市西湖区');
});

test('place-name: formatPlace shows city only by default, region on demand', () => {
  const pn = require('../utils/place-name');
  const parts = { city: 'St. Wolfgang im Salzkammergut', locality: 'Ried', district: 'Gmunden', region: 'Upper Austria', country: 'Austria' };
  assert.strictEqual(pn.formatPlace(parts, 'city', 'en'), 'ST. WOLFGANG');
  assert.strictEqual(pn.formatPlace(parts, 'detail', 'en'), 'RIED, ST. WOLFGANG');
  // 没有城市时依次退到 locality / district / region / country
  assert.strictEqual(pn.formatPlace({ locality: 'Hallstatt', region: 'Upper Austria' }, 'city', 'en'), 'HALLSTATT');
  assert.strictEqual(pn.formatPlace({ district: 'Gmunden', country: 'Austria' }, 'city', 'en'), 'GMUNDEN');
  assert.strictEqual(pn.formatPlace({ country: 'Austria' }, 'city', 'en'), 'AUSTRIA');
  assert.strictEqual(pn.formatPlace({}, 'city', 'en'), '');
  // 详细层级与城市相同则不重复
  assert.strictEqual(pn.formatPlace({ city: 'Zermatt', locality: 'Zermatt' }, 'detail', 'en'), 'ZERMATT');
  // 中文：城市 + 区域；英文模式下汉字按既有规则转拼音 / 首字母
  assert.strictEqual(pn.formatPlace({ city: '杭州市', district: '西湖区' }, 'detail', 'zh'), '杭州市西湖区');
  assert.strictEqual(pn.formatPlace({ city: '杭州市', district: '西湖区' }, 'city', 'en'), 'HANGZHOU');
  assert.strictEqual(pn.formatPlace({ city: '北京市', district: '朝阳区' }, 'detail', 'en'), 'CHAOYANG, BEIJING');
});
