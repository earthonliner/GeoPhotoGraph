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
