/**
 * 在 Node 里运行 pages/index/index.js：Page() 捕获页面定义，setData 直接合并进 data，
 * wx 替身记录调用。每次 createPage() 都重新执行页面脚本，得到一个干净的页面实例。
 * 导出高清图（exportItem）与预览绘制（render）用替身代替，只验证页面流程。
 */
const fs = require('fs');
const path = require('path');

const PAGE_FILE = path.join(__dirname, '../../pages/index/index.js');
const SOURCE = fs.readFileSync(PAGE_FILE, 'utf8');
const req = (p) => require(path.resolve(path.dirname(PAGE_FILE), p));

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// 真机上 showModal 的按钮文字超过 4 个字符会直接走 fail，页面的 catch 会把它当成取消；
// 替身照样失败，同时记下来，由测试在 afterEach 里断言为空
const MODAL_BUTTON_MAX = 4;
const violations = [];

// 记录 2d 上下文的绘制调用；createImage 得到的图片在设置 src 后异步“加载完成”
function createCanvasNode(imageSize) {
  const ops = [];
  const ctx = new Proxy(
    {},
    {
      get: (target, key) => (key in target ? target[key] : (...args) => ops.push([key, ...args])),
      set: (target, key, value) => {
        target[key] = value;
        return true;
      }
    }
  );
  return {
    width: 300,
    height: 150,
    ops,
    getContext: () => ctx,
    createImage() {
      const img = { width: 0, height: 0 };
      Object.defineProperty(img, 'src', {
        set(value) {
          img.url = value;
          img.width = (imageSize && imageSize.w) || 1200;
          img.height = (imageSize && imageSize.h) || 1600;
          setTimeout(() => img.onload && img.onload(), 0);
        }
      });
      return img;
    }
  };
}

function createWx(overrides) {
  const calls = {
    toast: [],
    modal: [],
    sheet: [],
    save: [],
    chooseMedia: 0,
    snapshot: [],
    vibrate: [],
    keepScreenOn: [],
    navigate: [],
    openSetting: 0
  };
  const store = {};
  const nodes = {};
  const wx = {
    calls,
    store,
    nodes,
    files: ['a.jpg'],
    modalConfirm: true,
    sheetTap: 0,
    getWindowInfo: () => ({ windowWidth: 375, windowHeight: 724, screenHeight: 812, safeArea: { bottom: 778 }, pixelRatio: 3 }),
    getDeviceInfo: () => ({ platform: 'android' }),
    getEnterOptionsSync: () => ({ scene: 1001 }),
    getAccountInfoSync: () => ({ miniProgram: { envVersion: 'release', version: '1.0.0' } }),
    getStorageSync: (k) => store[k],
    setStorageSync: (k, v) => {
      store[k] = v;
    },
    showToast(o) {
      calls.toast.push(o.title);
    },
    showModal(o) {
      calls.modal.push(o);
      const long = ['confirmText', 'cancelText'].filter((k) => o[k] && o[k].length > MODAL_BUTTON_MAX);
      if (long.length) {
        violations.push(`showModal「${o.title}」${long.map((k) => `${k}=${o[k]}`).join(', ')}`);
        o.fail({ errMsg: `showModal:fail ${long[0]} length should not larger than ${MODAL_BUTTON_MAX} Chinese characters` });
        return;
      }
      o.success({ confirm: wx.modalConfirm });
    },
    showActionSheet(o) {
      calls.sheet.push(o.itemList);
      if (wx.sheetTap < 0) o.fail({ errMsg: 'showActionSheet:fail cancel' });
      else o.success({ tapIndex: wx.sheetTap });
    },
    chooseMedia(o) {
      calls.chooseMedia += 1;
      o.success({ tempFiles: wx.files.slice(0, o.count).map((f) => ({ tempFilePath: f })) });
    },
    getImageInfo(o) {
      o.success({ width: 1600, height: 1200 });
    },
    saveImageToPhotosAlbum(o) {
      calls.save.push(o.filePath);
      o.success({});
    },
    canvasToTempFilePath(o) {
      calls.snapshot.push(o);
      o.success({ tempFilePath: `snap-${calls.snapshot.length}.jpg` });
    },
    createSelectorQuery: () => ({
      select: (selector) => ({
        fields: () => ({ exec: (cb) => cb([nodes[selector] ? { node: nodes[selector] } : null]) })
      })
    }),
    vibrateShort(o) {
      calls.vibrate.push(o.type);
    },
    setKeepScreenOn(o) {
      calls.keepScreenOn.push(o.keepScreenOn);
    },
    navigateTo(o) {
      calls.navigate.push(o.url);
    },
    openSetting() {
      calls.openSetting += 1;
    },
    setNavigationBarTitle() {}
  };
  return Object.assign(wx, overrides);
}

function createPage(wx) {
  global.wx = wx;
  let def = null;
  new Function('require', 'Page', 'wx', SOURCE)(req, (d) => {
    def = d;
  }, wx);
  const page = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)) });
  page.setData = function setData(patch, cb) {
    Object.assign(this.data, patch);
    if (cb) cb();
  };
  page.renders = 0;
  page.render = async function render() {
    this.renders += 1;
  };
  page.exportItem = async (item) => `poster-${item.id}.jpg`;
  return page;
}

const tap = (dataset) => ({ currentTarget: { dataset } });

module.exports = { createWx, createPage, createCanvasNode, tap, sleep, violations };
