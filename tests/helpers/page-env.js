/**
 * 在 Node 里运行页面脚本（pages/<name>/<name>.js）：Page() 捕获页面定义，setData 按路径写入 data，
 * wx 替身记录调用。每次 createPage() 都重新执行页面脚本，得到一个干净的页面实例。
 * 首页的导出高清图（exportItem）与预览绘制（render）用替身代替，只验证页面流程。
 */
const fs = require('fs');
const path = require('path');

const PAGES_DIR = path.join(__dirname, '../../pages');
const sources = {};

// 与真实 setData 一致，支持 'list[0].open' 这样的路径
function applyPatch(data, patch) {
  for (const key of Object.keys(patch)) {
    const parts = key.match(/[^.[\]]+/g);
    let obj = data;
    for (let i = 0; i < parts.length - 1; i += 1) {
      if (obj[parts[i]] === undefined || obj[parts[i]] === null) obj[parts[i]] = /^\d+$/.test(parts[i + 1]) ? [] : {};
      obj = obj[parts[i]];
    }
    obj[parts[parts.length - 1]] = patch[key];
  }
}

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
    chooseMessageFile: [],
    chooseCounts: [],
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
      calls.chooseCounts.push(o.count);
      o.success({ tempFiles: wx.files.slice(0, o.count).map((f) => ({ tempFilePath: f })) });
    },
    chooseMessageFile(o) {
      calls.chooseMessageFile.push({ count: o.count, type: o.type });
      o.success({ tempFiles: wx.files.slice(0, o.count).map((f) => ({ path: f, name: f })) });
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

function createPage(wx, name = 'index') {
  global.wx = wx;
  const file = path.join(PAGES_DIR, name, `${name}.js`);
  if (!sources[name]) sources[name] = fs.readFileSync(file, 'utf8');
  const req = (p) => require(path.resolve(path.dirname(file), p));
  let def = null;
  new Function('require', 'Page', 'wx', sources[name])(req, (d) => {
    def = d;
  }, wx);
  const page = Object.assign({}, def, { data: JSON.parse(JSON.stringify(def.data)) });
  page.setData = function setData(patch, cb) {
    applyPatch(this.data, patch);
    if (cb) cb();
  };
  if (name === 'index') {
    page.renders = 0;
    // 需要真实绘制流程的测试可以换回 realRender
    page.realRender = page.render;
    page.render = async function render() {
      this.renders += 1;
    };
    page.exportItem = async (item) => `poster-${item.id}.jpg`;
  }
  return page;
}

const tap = (dataset) => ({ currentTarget: { dataset } });

module.exports = { createWx, createPage, createCanvasNode, tap, sleep, violations };
