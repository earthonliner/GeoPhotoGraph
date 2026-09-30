/**
 * exif-parser.js
 *
 * 纯 JS、基于 ArrayBuffer/DataView 的 EXIF 解析器（不依赖 DOM / Image，可在小程序运行）。
 * exif-js 依赖 <img>/XMLHttpRequest，在小程序里无法直接使用，因此这里实现了同等能力的
 * 最小子集：GPSLatitude / GPSLongitude / DateTimeOriginal / Orientation / Make / Model。
 *
 * 支持：JPEG (APP1 Exif)；HEIC/HEIF 等容器通过扫描 "Exif\0\0" 头做兜底。
 */

const MONTHS = ['JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN', 'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC'];

// TIFF 数据类型 -> 单元素字节数
const TYPE_SIZE = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8 };

const TAG = {
  MAKE: 0x010f,
  MODEL: 0x0110,
  ORIENTATION: 0x0112,
  DATETIME: 0x0132,
  EXIF_IFD: 0x8769,
  GPS_IFD: 0x8825,
  DATETIME_ORIGINAL: 0x9003,
  DATETIME_DIGITIZED: 0x9004,
  GPS_LAT_REF: 0x0001,
  GPS_LAT: 0x0002,
  GPS_LON_REF: 0x0003,
  GPS_LON: 0x0004
};

/* ------------------------------------------------------------------ */
/* 文件读取                                                             */
/* ------------------------------------------------------------------ */

// EXIF 位于文件头部，只读前 512KB，避免把几十 MB 的原图整个读入内存
const HEAD_BYTES = 512 * 1024;

function readFileBuffer(filePath, length) {
  const fs = wx.getFileSystemManager();
  return new Promise((resolve, reject) => {
    const readAll = () =>
      fs.readFile({
        filePath,
        success: (res) => resolve(res.data),
        fail: reject
      });
    if (!length) return readAll();
    fs.readFile({
      filePath,
      position: 0,
      length,
      success: (res) => resolve(res.data),
      // 低版本基础库不支持 position/length，回退为整文件读取
      fail: readAll
    });
  });
}

/* ------------------------------------------------------------------ */
/* TIFF / IFD 解析                                                      */
/* ------------------------------------------------------------------ */

function findExifStart(view) {
  const len = view.byteLength;
  if (len < 4) return -1;

  // JPEG: FFD8 后依次遍历 marker，找到 APP1 "Exif\0\0"
  if (view.getUint16(0) === 0xffd8) {
    let offset = 2;
    while (offset + 4 <= len) {
      if (view.getUint8(offset) !== 0xff) {
        offset += 1;
        continue;
      }
      const marker = view.getUint8(offset + 1);
      if (marker === 0xff) {
        offset += 1;
        continue;
      }
      if (marker === 0xd8 || marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) {
        offset += 2;
        continue;
      }
      if (marker === 0xda || marker === 0xd9) break;
      const size = view.getUint16(offset + 2);
      if (marker === 0xe1 && offset + 10 <= len && isExifHeader(view, offset + 4)) {
        return offset + 10;
      }
      offset += 2 + size;
    }
    return -1;
  }

  // 其他容器（如 HEIC）：扫描 "Exif\0\0" 后紧跟 TIFF 头
  const scanEnd = Math.min(len - 10, 256 * 1024);
  for (let i = 0; i < scanEnd; i++) {
    if (view.getUint8(i) === 0x45 && isExifHeader(view, i)) {
      const bom = view.getUint16(i + 6);
      if (bom === 0x4949 || bom === 0x4d4d) return i + 6;
    }
  }
  return -1;
}

function isExifHeader(view, offset) {
  return (
    view.getUint8(offset) === 0x45 && // E
    view.getUint8(offset + 1) === 0x78 && // x
    view.getUint8(offset + 2) === 0x69 && // i
    view.getUint8(offset + 3) === 0x66 && // f
    view.getUint8(offset + 4) === 0 &&
    view.getUint8(offset + 5) === 0
  );
}

function readIfdTags(view, tiffStart, dirOffset, le) {
  const tags = {};
  const len = view.byteLength;
  const dirStart = tiffStart + dirOffset;
  if (dirStart + 2 > len) return tags;

  const count = view.getUint16(dirStart, le);
  for (let i = 0; i < count; i++) {
    const entry = dirStart + 2 + i * 12;
    if (entry + 12 > len) break;

    const tag = view.getUint16(entry, le);
    const type = view.getUint16(entry + 2, le);
    const n = view.getUint32(entry + 4, le);
    const unit = TYPE_SIZE[type];
    if (!unit || n > 4096) continue;

    const total = unit * n;
    const valueOffset = total <= 4 ? entry + 8 : tiffStart + view.getUint32(entry + 8, le);
    if (valueOffset + total > len) continue;

    tags[tag] = readValue(view, type, n, valueOffset, le);
  }
  return tags;
}

function readValue(view, type, n, offset, le) {
  if (type === 2) {
    let s = '';
    for (let i = 0; i < n; i++) {
      const c = view.getUint8(offset + i);
      if (c === 0) break;
      s += String.fromCharCode(c);
    }
    return s;
  }
  const out = [];
  for (let i = 0; i < n; i++) {
    switch (type) {
      case 1:
      case 7:
        out.push(view.getUint8(offset + i));
        break;
      case 3:
        out.push(view.getUint16(offset + i * 2, le));
        break;
      case 4:
        out.push(view.getUint32(offset + i * 4, le));
        break;
      case 9:
        out.push(view.getInt32(offset + i * 4, le));
        break;
      case 5: {
        const num = view.getUint32(offset + i * 8, le);
        const den = view.getUint32(offset + i * 8 + 4, le);
        out.push(den ? num / den : 0);
        break;
      }
      case 10: {
        const num = view.getInt32(offset + i * 8, le);
        const den = view.getInt32(offset + i * 8 + 4, le);
        out.push(den ? num / den : 0);
        break;
      }
      default:
        break;
    }
  }
  return n === 1 ? out[0] : out;
}

/* ------------------------------------------------------------------ */
/* 坐标 / 日期转换与格式化                                              */
/* ------------------------------------------------------------------ */

/**
 * 度分秒 (DMS) -> 十进制度 (DD)
 * @param {number[]} dms [度, 分, 秒]
 * @param {string} ref 'N' | 'S' | 'E' | 'W'
 */
function dmsToDecimal(dms, ref) {
  if (!Array.isArray(dms) || dms.length < 3) return NaN;
  const value = dms[0] + dms[1] / 60 + dms[2] / 3600;
  return ref === 'S' || ref === 'W' ? -value : value;
}

/**
 * 十进制经纬度 -> 展示文案，如 "46.0192° N  7.7459° E"
 */
function formatCoordinates(lat, lon, digits) {
  const d = digits === undefined ? 4 : digits;
  const latText = `${Math.abs(lat).toFixed(d)}° ${lat >= 0 ? 'N' : 'S'}`;
  const lonText = `${Math.abs(lon).toFixed(d)}° ${lon >= 0 ? 'E' : 'W'}`;
  return { lat: latText, lon: lonText, text: `${latText}  ${lonText}` };
}

/**
 * "2024:06:16 10:22:33" | Date -> "JUN 16, 2024"
 */
function formatDate(input) {
  let year;
  let month;
  let day;
  if (input instanceof Date) {
    year = input.getFullYear();
    month = input.getMonth() + 1;
    day = input.getDate();
  } else {
    const m = /(\d{4})[:\-/](\d{1,2})[:\-/](\d{1,2})/.exec(String(input || ''));
    if (!m) return '';
    year = Number(m[1]);
    month = Number(m[2]);
    day = Number(m[3]);
  }
  if (!(month >= 1 && month <= 12) || !(day >= 1 && day <= 31)) return '';
  return `${MONTHS[month - 1]} ${String(day).padStart(2, '0')}, ${year}`;
}

/* ------------------------------------------------------------------ */
/* 对外接口                                                             */
/* ------------------------------------------------------------------ */

/**
 * 解析 ArrayBuffer 中的 EXIF。
 * @returns {{latitude:number|null, longitude:number|null, dateTimeOriginal:string|null,
 *            orientation:number|null, make:string|null, model:string|null}|null}
 */
function parseExif(buffer) {
  if (!buffer || !buffer.byteLength) return null;
  const view = new DataView(buffer);

  let tiffStart;
  try {
    tiffStart = findExifStart(view);
  } catch (e) {
    return null;
  }
  if (tiffStart < 0 || tiffStart + 8 > view.byteLength) return null;

  try {
    const bom = view.getUint16(tiffStart);
    const le = bom === 0x4949;
    if (!le && bom !== 0x4d4d) return null;
    if (view.getUint16(tiffStart + 2, le) !== 42) return null;

    const ifd0 = readIfdTags(view, tiffStart, view.getUint32(tiffStart + 4, le), le);
    const exif = typeof ifd0[TAG.EXIF_IFD] === 'number' ? readIfdTags(view, tiffStart, ifd0[TAG.EXIF_IFD], le) : {};
    const gps = typeof ifd0[TAG.GPS_IFD] === 'number' ? readIfdTags(view, tiffStart, ifd0[TAG.GPS_IFD], le) : {};

    let latitude = dmsToDecimal(gps[TAG.GPS_LAT], gps[TAG.GPS_LAT_REF]);
    let longitude = dmsToDecimal(gps[TAG.GPS_LON], gps[TAG.GPS_LON_REF]);
    const validGps =
      Number.isFinite(latitude) &&
      Number.isFinite(longitude) &&
      Math.abs(latitude) <= 90 &&
      Math.abs(longitude) <= 180 &&
      // 部分相机在无定位时写入 0,0
      !(latitude === 0 && longitude === 0);
    if (!validGps) {
      latitude = null;
      longitude = null;
    }

    return {
      latitude,
      longitude,
      dateTimeOriginal: exif[TAG.DATETIME_ORIGINAL] || exif[TAG.DATETIME_DIGITIZED] || ifd0[TAG.DATETIME] || null,
      orientation: typeof ifd0[TAG.ORIENTATION] === 'number' ? ifd0[TAG.ORIENTATION] : null,
      make: ifd0[TAG.MAKE] || null,
      model: ifd0[TAG.MODEL] || null
    };
  } catch (e) {
    return null;
  }
}

/**
 * 从本地图片文件提取 EXIF 并格式化。永不 reject：解析失败时 hasGps=false。
 * @param {string} filePath wx.chooseMedia 返回的 tempFilePath
 */
async function extractFromFile(filePath) {
  let exif = null;
  try {
    const buffer = await readFileBuffer(filePath, HEAD_BYTES);
    exif = parseExif(buffer);
  } catch (e) {
    exif = null;
  }

  const hasGps = !!(exif && exif.latitude !== null && exif.longitude !== null);
  const coords = hasGps ? formatCoordinates(exif.latitude, exif.longitude) : null;

  return {
    hasGps,
    latitude: hasGps ? exif.latitude : null,
    longitude: hasGps ? exif.longitude : null,
    coordText: coords ? coords.text : '',
    dateText: exif && exif.dateTimeOriginal ? formatDate(exif.dateTimeOriginal) : '',
    orientation: exif ? exif.orientation : null,
    raw: exif
  };
}

module.exports = {
  parseExif,
  extractFromFile,
  dmsToDecimal,
  formatCoordinates,
  formatDate
};
