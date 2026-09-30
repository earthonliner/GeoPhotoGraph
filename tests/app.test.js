// 小程序结构：app.json 里的页面文件齐全，WXML 绑定的事件都有处理函数，跳转目标都已注册
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const { createWx, createPage } = require('./helpers/page-env');

const ROOT = path.join(__dirname, '..');
const APP = JSON.parse(fs.readFileSync(path.join(ROOT, 'app.json'), 'utf8'));
const read = (file) => fs.readFileSync(path.join(ROOT, file), 'utf8');

test('app.json：每个页面的 js / json / wxml / wxss 都存在，json 可解析', () => {
  assert.ok(APP.pages.includes('pages/about/about'));
  for (const p of APP.pages) {
    for (const ext of ['js', 'json', 'wxml', 'wxss']) {
      assert.ok(fs.existsSync(path.join(ROOT, `${p}.${ext}`)), `${p}.${ext}`);
    }
    JSON.parse(read(`${p}.json`));
  }
});

test('WXML 中绑定的事件处理函数都定义在页面上', () => {
  for (const p of APP.pages) {
    const page = createPage(createWx(), path.basename(p));
    const wxml = read(`${p}.wxml`);
    const names = [...wxml.matchAll(/\s(?:bind|catch|capture-bind|capture-catch|mut-bind):?[a-z]+="([^"{}]+)"/g)].map((m) => m[1]);
    assert.ok(names.length > 0, p);
    for (const name of new Set(names)) assert.strictEqual(typeof page[name], 'function', `${p}: ${name}`);
  }
});

test('app.js：cloud 模式启动时初始化云开发，朋友圈单页模式与本地模式不初始化', () => {
  const config = require('../utils/config');
  const mode = config.payment.mode;
  const launch = (scene) => {
    const inits = [];
    const wx = createWx({ getEnterOptionsSync: () => ({ scene }), cloud: { init: (o) => inits.push(o) } });
    global.wx = wx;
    let app = null;
    new Function('require', 'App', 'wx', read('app.js'))((p) => require(path.join(ROOT, p)), (def) => {
      app = def;
    }, wx);
    app.onLaunch();
    return inits;
  };
  try {
    config.payment.mode = 'cloud';
    assert.deepStrictEqual(launch(1001), [{ env: config.payment.cloud.env, traceUser: true }]);
    assert.deepStrictEqual(launch(1154), []);
    config.payment.mode = 'mock';
    assert.deepStrictEqual(launch(1001), []);
  } finally {
    config.payment.mode = mode;
  }
});

test('代码里跳转的页面都已在 app.json 注册', () => {
  for (const p of APP.pages) {
    const urls = [...read(`${p}.js`).matchAll(/url:\s*'\/(pages\/[\w/]+)'/g)].map((m) => m[1]);
    for (const url of urls) assert.ok(APP.pages.includes(url), `${p} -> ${url}`);
  }
});
