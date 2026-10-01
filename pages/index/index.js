const exifParser = require('../../utils/exif-parser');
const mapService = require('../../utils/map-service');
const placeName = require('../../utils/place-name');
const themes = require('../../utils/themes');
const batchUtil = require('../../utils/batch');
const membership = require('../../utils/membership');
const payment = require('../../utils/payment');
const platform = require('../../utils/platform');
const appConfig = require('../../utils/config');
const { POSTER_W, POSTER_H, FOOTER_H, MAX_CROP_ZOOM, clamp } = require('../../utils/poster/core.js');
const {
  TEMPLATES,
  HOT_CATEGORY,
  CATEGORIES,
  templatesOf,
  CROP_REGIONS,
  paintPoster
} = require('../../utils/poster/registry.js');

// 预览按屏幕 dpr 缩放，导出按 3 倍缩放 => 1200 x 1600 px
const EXPORT_SCALE = 3;
const { MAX_BATCH } = batchUtil;
const FOOTER_KEY = 'geopics.footer';
// 手动选过的地点：微信常去掉照片里的定位，下一张照片可以一键选用
const RECENT_KEY = 'geopics.recentPlaces';
const RECENT_MAX = 3;

const posterHeight = (footer) => POSTER_H + (footer ? FOOTER_H : 0);
const exportSizeText = (footer) => `${POSTER_W * EXPORT_SCALE} × ${Math.round(posterHeight(footer) * EXPORT_SCALE)}`;
// 界面强调色（iOS 系统蓝），用于系统弹窗按钮
const TINT = '#007AFF';
// 使用真实地图时海报上绘制的 Mapbox 标志（署名要求）
const MAPBOX_LOGO = '/assets/mapbox-logo.png';
// 回到页面时向服务端同步权益的最短间隔：选图、定位等系统界面返回也会触发 onShow
const SYNC_INTERVAL = 30 * 1000;
// 批量导入与批量下载只对月度、年度、买断会员和邀请码开放（不提供购买的平台，文案里不带购买引导）
const BATCH_NOTICE = '批量导入与批量下载只对月度、年度、买断会员和邀请码开放，单张解锁不含批量。';
const BATCH_NOTICE_IOS = '批量导入与批量下载仅对会员开放，已有会员权益或邀请码的用户可以使用。';
const SHARE_TITLE = 'GEOPICS · 把照片与它发生的地方，做成一张海报';
// 转发卡片按 5:4 显示
const SHARE_W = 750;
const SHARE_H = 600;
const SHARE_PAD = 44;

const DEFAULT_CROP = { zoom: 1, x: 0, y: 0 };

function loadRecentPlaces() {
  try {
    const list = wx.getStorageSync(RECENT_KEY);
    if (!Array.isArray(list)) return [];
    return list.filter((p) => p && p.name && typeof p.lat === 'number' && typeof p.lon === 'number').slice(0, RECENT_MAX);
  } catch (e) {
    return [];
  }
}

/* ------------------------------------------------------------------ */
/* 通用工具                                                             */
/* ------------------------------------------------------------------ */

function wxp(method, options) {
  return new Promise((resolve, reject) => {
    wx[method](Object.assign({}, options, { success: resolve, fail: reject }));
  });
}

function isCancel(err) {
  return !!(err && /cancel/i.test(err.errMsg || ''));
}

// 用户拒绝了隐私保护指引（104），或接口未在指引中声明（112）。
// 须先于相册权限判断：拒绝隐私授权的 errMsg 同样包含 “auth”
function isPrivacyDenied(err) {
  return !!err && (err.errno === 104 || err.errno === 112 || /privacy/i.test(err.errMsg || ''));
}

function tick() {
  if (wx.vibrateShort) wx.vibrateShort({ type: 'light', fail() {} });
}

function keepScreenOn(on) {
  if (wx.setKeepScreenOn) wx.setKeepScreenOn({ keepScreenOn: on, fail() {} });
}

function loadImage(canvas, src) {
  return new Promise((resolve, reject) => {
    const img = canvas.createImage();
    img.onload = () => resolve(img);
    img.onerror = (e) => reject(e);
    img.src = src;
  });
}

// 图片对象与创建它的 canvas 绑定，因此缓存按 canvas 分开维护
function cachedImage(canvas, cache, src) {
  if (cache && cache.has(src)) return Promise.resolve(cache.get(src));
  return loadImage(canvas, src).then((img) => {
    if (cache) cache.set(src, img);
    return img;
  });
}

/* ------------------------------------------------------------------ */
/* Page                                                                 */
/* ------------------------------------------------------------------ */

// 预览最宽与页面内容同宽，但有照片时带底栏的整张海报须在首屏完整露出。预留高度对应 wxss 中
// 大标题 118 + 模板栏 180 + 预览说明 60 + 底部工具栏 140 + 间距 32（rpx），改版式时需同步。
// 宽度按带底栏的高度计算且保持不变，开关底栏只改变预览高度
const PREVIEW_RESERVED_RPX = 118 + 180 + 60 + 140 + 32;
function previewWidth(win) {
  const rpx = win.windowWidth / 750;
  const full = Math.min(win.windowWidth - 64 * rpx, 440);
  if (!win.windowHeight) return Math.floor(full);
  const safeBottom = win.safeArea && win.screenHeight ? Math.max(0, win.screenHeight - win.safeArea.bottom) : 0;
  const fitH = win.windowHeight - PREVIEW_RESERVED_RPX * rpx - safeBottom;
  const fitW = (fitH * POSTER_W) / posterHeight(true);
  return Math.floor(Math.max(Math.min(full, fitW), full * 0.64));
}

// 随机模板：在当前分类内洗牌发牌，用完一轮再开始下一轮
function pickRandomTemplates(count, categoryId) {
  return batchUtil.pickRandomTemplates(templatesOf(categoryId).map((t) => t.id), count);
}

// 模板 Tab 只需要 id 与名称，避免把地图参数等整份元数据塞进 setData
function templateTabs(categoryId) {
  return templatesOf(categoryId).map((t) => ({ id: t.id, name: t.name }));
}

// 会员档位：月度 / 年度附上单张均价并标出均价最低的一档；买断只能买一次，已拥有时不再出现
function planOffers(state) {
  const plans = appConfig.membership.plans;
  const unit = (pl) => pl.price / pl.quota;
  const best = Math.min(...plans.map(unit));
  const rows = plans.map((pl) =>
    Object.assign({}, pl, {
      kind: 'plan',
      priceText: membership.formatPrice(pl.price),
      unitText: `约 ¥${(unit(pl) / 100).toFixed(2)}/张`,
      best: plans.length > 1 && unit(pl) === best
    })
  );
  const lifetime = appConfig.membership.lifetime;
  if (lifetime && !(state && membership.hasLifetime(state))) {
    rows.push(Object.assign({}, lifetime, { kind: 'lifetime', priceText: membership.formatPrice(lifetime.price), unitText: '永久有效', best: false }));
  }
  return rows;
}

Page({
  data: {
    footerOn: true,
    exportSize: '',
    isMember: false,
    batchOk: false,
    stageNote: '',
    previewCovered: false,
    coverImage: '',
    memberLabel: '',
    memberChip: '',
    currentLocked: true,
    lockBadges: false,
    paywallVisible: false,
    plans: planOffers(),
    singleOffer: Object.assign({ priceText: membership.formatPrice(appConfig.membership.single.price) }, appConfig.membership.single),
    inviteInput: '',
    inviteError: '',
    paywallNotice: '',
    packLines: [],
    mockPay: payment.isMock(),
    canPurchase: true,
    purchaseNote: '',
    singlePage: false,
    categories: CATEGORIES,
    catId: HOT_CATEGORY,
    visibleTemplates: templateTabs(HOT_CATEGORY),
    templateId: 'polaroid',
    hasPhoto: false,
    photoPath: '',
    coordText: '',
    dateText: '',
    dateValue: '',
    dateManual: false,
    dateToday: exifParser.toDateValue(new Date()),
    place: '',
    placeLang: 'en',
    placeLevel: 'city',
    placeManual: false,
    hasLocation: false,
    searchVisible: false,
    searchKeyword: '',
    searchResults: [],
    searching: false,
    searchEmpty: false,
    zoom: 12,
    themes: themes.THEMES.concat([{ id: themes.CUSTOM_ID, name: '自定义', tint: themes.DEFAULT_CUSTOM_HEX }]),
    mapColorId: themes.DEFAULT_THEME_ID,
    customHex: themes.DEFAULT_CUSTOM_HEX,
    customHexText: themes.DEFAULT_CUSTOM_HEX,
    hueColor: '#FF0000',
    padCursor: '',
    hueCursor: '',
    cropEnabled: false,
    cropZoom: 100,
    cropX: 0,
    cropY: 0,
    mapOpacity: 100,
    photoOpacity: 100,
    textOpacity: 100,
    batchMode: 'unique',
    maxBatch: MAX_BATCH,
    list: [],
    itemCount: 0,
    selectedCount: 0,
    currentId: 0,
    canvasStyle: '',
    busy: false,
    busyText: '',
    tokenMissing: false
  },

  onLoad() {
    this.canPurchase = platform.canPurchase();
    this.singlePage = platform.isSinglePageMode();
    // 非 data 状态：与渲染无关，避免多余的 setData
    this.items = [];
    this.member = membership.load();
    this._sessionId = Date.now().toString(36) + Math.floor(Math.random() * 1296).toString(36);
    this._afterUnlock = null;
    this._itemSeq = 0;
    this.poster = this.createItem('');
    this._hsv = themes.hexToHsv(themes.DEFAULT_CUSTOM_HEX);
    this._renderId = 0;
    this._searchId = 0;
    this._geoCache = {};
    this.recentPlaces = loadRecentPlaces();
    this._searchTimer = null;
    this._placeTimer = null;
    this._imgCache = new Map();
    this._mapCache = {};
    this._mapWarned = false;

    const win = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const cssW = previewWidth(win);
    let footerOn = true;
    try {
      footerOn = wx.getStorageSync(FOOTER_KEY) !== false;
    } catch (e) {
      footerOn = true;
    }
    const cssH = Math.round((cssW * posterHeight(footerOn)) / POSTER_W);
    this.cssSize = { w: cssW, h: cssH };
    this.dpr = Math.min(win.pixelRatio || 2, 3);
    this.setData(
      Object.assign(
        {
          footerOn,
          exportSize: exportSizeText(footerOn),
          canvasStyle: `width:${cssW}px;height:${cssH}px;`,
          canPurchase: this.canPurchase,
          purchaseNote: platform.purchaseNote(),
          singlePage: this.singlePage,
          // 只提示开发者：正式版缺少 token 时静默使用本地底图
          tokenMissing: !mapService.hasToken() && platform.isDevBuild()
        },
        this.pickerView(),
        this.memberView(),
        this.listView()
      )
    );
  },

  onReady() {
    this.initPreviewCanvas();
    this.observeLargeTitle();
  },

  onShow() {
    return this.syncMember();
  },

  onOpenAbout() {
    wx.navigateTo({ url: '/pages/about/about' });
  },

  onUnload() {
    if (this._titleObserver) this._titleObserver.disconnect();
    clearTimeout(this._syncTimer);
  },

  // 仿 iOS 大标题：页面内的大标题滚出视野后，才在导航栏显示标题
  observeLargeTitle() {
    if (!this.createIntersectionObserver) return;
    let shown = false;
    this._titleObserver = this.createIntersectionObserver();
    this._titleObserver.relativeToViewport().observe('.large-title', (res) => {
      const show = res.intersectionRatio === 0;
      if (show === shown) return;
      shown = show;
      wx.setNavigationBarTitle({ title: show ? 'GEOPICS' : '' });
    });
  },

  /* ---------------------------- canvas 初始化 ---------------------------- */

  queryCanvas(selector) {
    return new Promise((resolve, reject) => {
      wx.createSelectorQuery()
        .select(selector)
        .fields({ node: true, size: true })
        .exec((res) => {
          if (res && res[0] && res[0].node) resolve(res[0].node);
          else reject(new Error(`canvas ${selector} not found`));
        });
    });
  },

  // 底端品牌栏开关会改变海报高度：同步调整预览画布的尺寸
  applyPreviewSize() {
    const { w } = this.cssSize;
    const h = Math.round((w * posterHeight(this.data.footerOn)) / POSTER_W);
    this.cssSize = { w, h };
    if (this.preview) {
      this.preview.width = Math.round(w * this.dpr);
      this.preview.height = Math.round(h * this.dpr);
    }
    this.setData({ canvasStyle: `width:${w}px;height:${h}px;`, exportSize: exportSizeText(this.data.footerOn) });
  },

  onToggleFooter(e) {
    const on = !!e.detail.value;
    if (on === this.data.footerOn) return;
    try {
      wx.setStorageSync(FOOTER_KEY, on);
    } catch (err) {
      /* 偏好保存失败不影响使用 */
    }
    this.setData({ footerOn: on }, () => {
      this.applyPreviewSize();
      this.render();
    });
  },

  async initPreviewCanvas() {
    try {
      const canvas = await this.queryCanvas('#posterCanvas');
      canvas.width = Math.round(this.cssSize.w * this.dpr);
      canvas.height = Math.round(this.cssSize.h * this.dpr);
      this.preview = canvas;
      this.render();
    } catch (e) {
      console.error('init canvas failed', e);
    }
  },

  /* ---------------------------- 交互事件 ---------------------------- */

  showBusy(text) {
    this.setData({ busy: true, busyText: text || '' });
  },

  hideBusy() {
    this.setData({ busy: false, busyText: '' });
  },

  /* ---------------------------- 批量：条目模型 ---------------------------- */

  // 每张照片是一个独立条目；this.poster 始终指向“当前正在编辑 / 预览”的条目
  createItem(filePath, templateId) {
    return {
      id: ++this._itemSeq,
      photoPath: filePath,
      templateId: templateId || (this.poster && this.poster.templateId) || this.data.templateId,
      selected: true,
      // 已保存过（已计费）的模板：同一张照片同一模板再次保存不重复计费
      unlocked: {},
      lat: null,
      lon: null,
      place: '',
      fallbackName: '',
      placeManual: false,
      coordText: '',
      dateText: '',
      dateValue: '',
      dateManual: false,
      autoDate: null,
      crops: {},
      photoSize: null,
      locId: 0
    };
  },

  listView() {
    const list = this.items.map((it) => {
      const tpl = TEMPLATES.find((t) => t.id === it.templateId);
      return {
        id: it.id,
        path: it.photoPath,
        selected: it.selected,
        current: it === this.poster,
        tplName: tpl ? tpl.name : '',
        noLoc: it.lat === null,
        locked: !this.isEntitled(it)
      };
    });
    return {
      list,
      itemCount: list.length,
      selectedCount: list.filter((x) => x.selected).length,
      currentId: this.poster.id,
      currentLocked: !this.isEntitled(this.poster),
      stageNote: this.stageNote(),
      // 全部带水印时角标没有区分意义，只在部分照片已解锁时标出
      lockBadges: list.some((x) => x.locked) && list.some((x) => !x.locked)
    };
  },

  /* ---------------------------- 会员 / 水印 / 付费 ---------------------------- */

  // 这张照片在当前模板下已保存过（已计费），或还有可用额度 => 无水印且可下载。
  // 免费额度只适用于免费模板（拍立得），其余模板必须有付费额度
  isEntitled(item) {
    return !!item.unlocked[item.templateId] || membership.availableQuota(this.member, item.templateId) > 0;
  },

  // 预览下方的一行提示：带水印的原因，或免费模板的剩余免费张数
  stageNote() {
    const p = this.poster;
    if (!p.photoPath) return '';
    const now = Date.now();
    const free = membership.freeRemaining(this.member, now);
    const isFree = membership.isFreeTemplate(p.templateId);
    if (this.isEntitled(p)) {
      const paid = membership.paidRemaining(this.member, now) > 0;
      return isFree && free > 0 && !paid ? `拍立得本月免费剩余 ${free} 张，每保存一张消耗 1 张` : '';
    }
    if (membership.isMember(this.member, now)) return '额度已用完，预览带水印';
    if (isFree) return '本月拍立得免费额度已用完，预览带水印';
    const tpl = TEMPLATES.find((t) => t.id === p.templateId);
    const name = tpl ? `「${tpl.name}」` : '该';
    return `${name}模板预览带水印、不能下载${free > 0 ? `；拍立得本月还可免费保存 ${free} 张` : ''}`;
  },

  memberView() {
    const now = Date.now();
    return {
      isMember: membership.isMember(this.member, now),
      batchOk: membership.batchAllowed(this.member, now),
      memberLabel: membership.label(this.member, now, this.canPurchase),
      memberChip: membership.chipLabel(this.member, now, this.canPurchase),
      packLines: membership.packLines(this.member, appConfig.membership.plans, now),
      plans: planOffers(this.member)
    };
  },

  // 一次下载要处理的照片中，哪些可以下载、哪些被额度 / 水印拦下。
  // 免费模板的照片先用免费额度，其余照片（及免费额度不够的部分）共用付费额度
  splitByEntitlement(items) {
    const now = Date.now();
    let free = membership.freeRemaining(this.member, now);
    let paid = membership.paidRemaining(this.member, now);
    const ok = new Set(items.filter((it) => it.unlocked[it.templateId]));
    const need = items.filter((it) => !ok.has(it));
    need.forEach((it) => {
      if (membership.isFreeTemplate(it.templateId) && free > 0) {
        free -= 1;
        ok.add(it);
      }
    });
    need.forEach((it) => {
      if (!ok.has(it) && paid > 0) {
        paid -= 1;
        ok.add(it);
      }
    });
    return { allowed: items.filter((it) => ok.has(it)), blocked: items.filter((it) => !ok.has(it)) };
  },

  // 批量导入与批量下载只对会员开放：未开通时弹出付费面板说明，返回 false
  requireBatch(resume) {
    if (membership.batchAllowed(this.member)) return true;
    this.openPaywall(resume, this.canPurchase ? BATCH_NOTICE : BATCH_NOTICE_IOS);
    return false;
  },

  // 扣减额度；同一张照片同一模板本次会话内再次保存不重复计费。
  // cloud 模式在导出前向服务端扣（额度不足会抛出 code 为 insufficient 的错误），本地模式在保存成功后扣
  async chargeItem(item) {
    const tpl = item.templateId;
    if (item.unlocked[tpl]) return;
    if (!payment.isMock()) {
      const r = await payment.charge(`${this._sessionId}:${item.id}:${tpl}`, tpl);
      this.adoptMember(r.state, true);
      if (!r.ok) {
        const err = new Error('insufficient quota');
        err.code = 'insufficient';
        throw err;
      }
      item.unlocked[tpl] = true;
      return;
    }
    item.unlocked[tpl] = true;
    if (this.member.invite) return;
    this.member = membership.consume(this.member, [tpl]);
    membership.save(this.member);
  },

  // cloud 模式下权益以服务端为准：回到页面时拉取（间隔 SYNC_INTERVAL，force 时立即），
  // 并顺带让服务端补偿入账未收到回调的订单。朋友圈单页模式不能调用云开发，跳过
  async syncMember(force) {
    if (payment.isMock() || this.singlePage || this._syncing) return;
    if (!force && Date.now() - (this._syncedAt || 0) < SYNC_INTERVAL) return;
    this._syncing = true;
    try {
      this.adoptMember(await payment.fetchEntitlement());
    } catch (e) {
      console.error('sync entitlement failed', e);
    }
    this._syncing = false;
  },

  // 采用服务端返回的权益快照（本地缓存仅用于下次启动时先显示）。silent 时不重绘，由调用方稍后统一刷新
  adoptMember(state, silent) {
    this.member = membership.normalize(state);
    this._syncedAt = Date.now();
    membership.save(this.member);
    if (!silent && this.poster) this.refreshEntitlement();
  },

  // 权益变化后刷新标题栏 / 缩略图 / 预览水印
  refreshEntitlement() {
    this.setData(Object.assign(this.memberView(), this.listView()));
    this.render();
  },

  // 原生 canvas 的层级高于普通节点，会盖在弹层上方：弹层出现前先把预览截成图片顶替，并隐藏 canvas
  async coverPreview() {
    if (this.data.previewCovered) return;
    let coverImage = '';
    if (this.preview) {
      try {
        ({ tempFilePath: coverImage } = await wxp('canvasToTempFilePath', {
          canvas: this.preview,
          fileType: 'jpg',
          quality: 0.92
        }));
      } catch (e) {
        console.error('snapshot preview failed', e);
      }
    }
    this.setData({ previewCovered: true, coverImage });
  },

  // 弹层都关闭后恢复 canvas 并重绘（隐藏期间的绘制不一定生效）
  uncoverPreview() {
    if (!this.data.previewCovered || this.data.paywallVisible || this.data.searchVisible) return;
    this.setData({ previewCovered: false, coverImage: '' });
    this.render();
  },

  async openPaywall(resume, notice) {
    this._afterUnlock = resume || null;
    await this.coverPreview();
    this.setData(
      Object.assign(this.memberView(), { paywallVisible: true, paywallNotice: notice || '', inviteInput: '', inviteError: '' })
    );
  },

  onOpenPaywall() {
    return this.openPaywall(null);
  },

  onPaywallClose() {
    this._afterUnlock = null;
    this.setData({ paywallVisible: false });
    this.uncoverPreview();
  },

  // 权益生效后关闭付费面板，并继续刚才被拦下的操作
  finishUnlock(toast) {
    const resume = this._afterUnlock;
    this._afterUnlock = null;
    this.setData({ paywallVisible: false });
    this.uncoverPreview();
    this.refreshEntitlement();
    wx.showToast({ title: toast, icon: 'success' });
    if (resume) setTimeout(resume, 400);
  },

  onInviteInput(e) {
    this.setData({ inviteInput: e.detail.value, inviteError: '' });
  },

  async onRedeemInvite() {
    const code = this.data.inviteInput;
    if (!code.trim()) {
      this.setData({ inviteError: '请输入邀请码' });
      return;
    }
    let res;
    try {
      res = await payment.redeemInvite(code);
    } catch (e) {
      this.setData({ inviteError: '校验失败，请稍后重试' });
      return;
    }
    if (!res.valid) {
      this.setData({ inviteError: res.tooMany ? '尝试次数过多，请稍后再试' : '邀请码无效' });
      return;
    }
    if (res.state) this.adoptMember(res.state, true);
    else this.member = Object.assign({}, this.member, { invite: true });
    membership.save(this.member);
    this.finishUnlock('邀请码已生效');
  },

  async onBuy(e) {
    if (this.data.busy || !this.canPurchase) return;
    const { kind, id } = e.currentTarget.dataset;
    let order;
    let plan = null;
    if (kind === 'plan') {
      plan = appConfig.membership.plans.find((pl) => pl.id === id);
      if (!plan) return;
      order = { kind, planId: plan.id, title: plan.name, priceText: membership.formatPrice(plan.price) };
    } else if (kind === 'lifetime') {
      plan = appConfig.membership.lifetime;
      if (!plan || membership.hasLifetime(this.member)) return;
      order = { kind, title: plan.name, priceText: membership.formatPrice(plan.price) };
    } else {
      if (!this.data.hasPhoto) return;
      const single = appConfig.membership.single;
      order = { kind: 'single', title: single.name, priceText: membership.formatPrice(single.price) };
    }
    let result;
    try {
      result = await payment.pay(order);
    } catch (err) {
      console.error('pay failed', err);
      if (err && err.code === 'already_owned') {
        wx.showToast({ title: '已拥有买断会员', icon: 'none' });
        this.syncMember(true);
        return;
      }
      wx.showToast({ title: '支付失败，请重试', icon: 'none' });
      return;
    }
    if (!result || !result.ok) return;
    if (result.pending) {
      // 已付款但服务端尚未确认：不在本地发放权益，稍后自动同步；在此之前回到页面也会立即同步
      wx.showToast({ title: '支付结果确认中，稍后自动到账', icon: 'none' });
      this._syncedAt = 0;
      clearTimeout(this._syncTimer);
      this._syncTimer = setTimeout(() => this.syncMember(true), 8000);
      return;
    }
    if (result.state) {
      this.adoptMember(result.state, true);
    } else {
      if (kind === 'plan') this.member = membership.addPack(this.member, plan);
      else if (kind === 'lifetime') this.member = membership.addLifetime(this.member, plan);
      else this.member = membership.addSingle(this.member);
      membership.save(this.member);
    }
    this.finishUnlock('已解锁');
  },

  // 把当前条目的状态整体同步到界面
  syncView(extra) {
    const p = this.poster;
    const crop = this.getCrop(p.templateId);
    this.setData(
      Object.assign(
        {
          hasPhoto: !!p.photoPath,
          photoPath: p.photoPath,
          templateId: p.templateId,
          hasLocation: p.lat !== null,
          coordText: p.coordText,
          place: p.place,
          placeManual: p.placeManual,
          dateText: p.dateText,
          dateValue: p.dateValue,
          dateManual: p.dateManual,
          cropEnabled: !!CROP_REGIONS[p.templateId],
          cropZoom: Math.round(crop.zoom * 100),
          cropX: Math.round(crop.x * 100),
          cropY: Math.round(crop.y * 100)
        },
        this.listView(),
        extra
      )
    );
  },

  // 条目数据变化后刷新界面；当前条目还需要重绘预览
  touch(item, redraw) {
    if (item === this.poster) {
      this.syncView();
      if (redraw) this.render();
    } else {
      this.setData(this.listView());
    }
  },

  /* ---------------------------- 批量：导入 / 切换 / 选择 ---------------------------- */

  onChoosePhoto() {
    return this.chooseAndImport(false);
  },

  onAddPhotos() {
    return this.chooseAndImport(true);
  },

  // 空白预览上画着“添加照片”，点按即可选图；有照片时预览只响应取景手势
  onTapPreview() {
    if (this.data.hasPhoto || this.data.busy) return;
    return this.onChoosePhoto();
  },

  // 缩略图条末尾的 “+”：继续添加，或重新选择替换全部
  async onTapAddTile() {
    if (this.data.busy) return;
    const batch = membership.batchAllowed(this.member);
    const canAdd = this.items.length < MAX_BATCH;
    const replace = this.items.length > 1 ? '重新选择（替换全部）' : '重新选择照片';
    // 非会员只能一张一张做：第二项说明批量是会员功能
    const actions = [];
    if (batch && canAdd) actions.push(['继续添加照片', () => this.onAddPhotos()]);
    actions.push([replace, () => this.onChoosePhoto()]);
    if (!batch) actions.push(['批量导入（会员功能）', () => this.requireBatch(() => this.resumeAddPhotos())]);
    if (batch && canAdd) actions.push(['从聊天记录添加', () => this.chooseAndImport(true, 'chat')]);
    else actions.push(['从聊天记录选择', () => this.chooseAndImport(false, 'chat')]);
    let tapIndex;
    try {
      ({ tapIndex } = await wxp('showActionSheet', { itemList: actions.map((a) => a[0]) }));
    } catch (e) {
      return;
    }
    await actions[tapIndex][1]();
  },

  // 购买会员后继续刚才想做的批量导入；买的若是单张（不含批量）则不再打扰
  resumeAddPhotos() {
    if (membership.batchAllowed(this.member)) return this.onAddPhotos();
    return null;
  },

  async chooseAndImport(append, source = 'album') {
    if (this.singlePage) {
      wx.showToast({ title: '请点击下方「前往小程序」后使用', icon: 'none' });
      return;
    }
    const batch = membership.batchAllowed(this.member);
    if (append && !batch) {
      this.requireBatch(() => this.resumeAddPhotos());
      return;
    }
    const remain = batch ? MAX_BATCH - (append ? this.items.length : 0) : 1;
    if (remain <= 0) {
      wx.showToast({ title: `最多 ${MAX_BATCH} 张`, icon: 'none' });
      return;
    }
    let files;
    try {
      if (source === 'chat') {
        const res = await wxp('chooseMessageFile', { count: remain, type: 'image' });
        files = res.tempFiles.map((f) => f.path);
      } else {
        const res = await wxp('chooseMedia', {
          count: remain,
          mediaType: ['image'],
          // 必须原图：压缩后的图片会丢失 EXIF（含 GPS）
          sizeType: ['original'],
          sourceType: ['album']
        });
        files = res.tempFiles.map((f) => f.tempFilePath);
      }
    } catch (e) {
      if (isCancel(e)) return;
      console.error('choose media failed', e);
      wx.showToast({ title: isPrivacyDenied(e) ? '需同意隐私保护指引后才能选择照片' : '选择照片失败，请重试', icon: 'none' });
      return;
    }
    if (!files.length) return;

    const total = files.length;
    const progress = (i) => (total > 1 ? `读取照片 ${i + 1}/${total}…` : '读取并处理照片…');
    this.showBusy(progress(0));
    const baseTemplate = this.poster.templateId;
    const created = [];
    for (let i = 0; i < total; i += 1) {
      const filePath = files[i];
      if (i > 0) this.setData({ busyText: progress(i) });
      const item = this.createItem(filePath, baseTemplate);
      const exif = await exifParser.extractFromFile(filePath);
      item.autoDate = {
        text: exif.dateText || exifParser.formatDate(new Date()),
        value: exif.dateValue || exifParser.toDateValue(new Date())
      };
      item.dateText = item.autoDate.text;
      item.dateValue = item.autoDate.value;
      item.exif = exif;
      item.photoPath = await this.prepareImage(filePath);
      created.push(item);
    }

    this.items = append ? this.items.concat(created) : created;
    if (this.data.batchMode === 'random' && this.items.length > 1) {
      pickRandomTemplates(created.length, this.data.catId).forEach((id, i) => {
        created[i].templateId = id;
      });
    }
    this.poster = created[0];
    this._imgCache = new Map();
    this.ensureCategory();
    this.syncView();
    this.render();

    if (mapService.hasToken() && created.some((it) => it.exif.hasGps)) this.setData({ busyText: '获取地名…' });
    await Promise.all(
      created.map((item) => {
        const exif = item.exif;
        delete item.exif;
        if (exif.hasGps) return this.applyLocation(item, exif.latitude, exif.longitude, '');
        item.place = 'UNKNOWN';
        this.touch(item, true);
        return null;
      })
    );
    this.hideBusy();

    const missing = created.filter((it) => it.lat === null);
    if (!missing.length) return;
    await this.promptMissingLocation(created, missing);
  },

  // 微信出于隐私保护，选图时常会去掉照片里的定位（iOS 上几乎总是如此），读不到并不是照片或解析的问题。
  // 直接引导选择一次地点；多张时选好后可一起用于其余无位置的照片
  async promptMissingLocation(created, missing) {
    const single = created.length === 1;
    const all = missing.length === created.length;
    const who = single ? '这张照片' : all ? `这 ${missing.length} 张照片` : `有 ${missing.length} 张照片（缩略图上标有“无位置”）`;
    const modal = await wxp('showModal', {
      title: single || all ? '未读取到位置' : '部分照片未读取到位置',
      content: `${who}没有读到定位信息，微信出于隐私保护常会去掉照片里的位置。选择一次拍摄地点即可${missing.length > 1 ? '，并可同时用于其他照片' : ''}。`,
      confirmText: '选择地点',
      cancelText: '暂不',
      confirmColor: TINT
    }).catch(() => ({ confirm: false }));
    if (!modal.confirm) return;
    if (this.poster.lat !== null) {
      this.poster = missing[0];
      this.ensureCategory();
      this.syncView();
      this.render();
    }
    await this.onPickLocation();
  },

  // 原图像素过大时，部分机型的 canvas 只能解码出上半部分，下半部分变成竖向拖影。
  // 导入时先等比压缩到长边 maxSide 以内（EXIF 已在压缩前从原图读取）；失败则退回原图
  async prepareImage(filePath) {
    const { maxSide, quality } = appConfig.image;
    try {
      const info = await wxp('getImageInfo', { src: filePath });
      const long = Math.max(info.width, info.height);
      if (!(long > maxSide)) return filePath;
      const k = maxSide / long;
      const res = await wxp('compressImage', {
        src: filePath,
        quality,
        compressedWidth: Math.round(info.width * k),
        compressedHeight: Math.round(info.height * k)
      });
      return res.tempFilePath || filePath;
    } catch (e) {
      console.warn('prepare image failed, using original', e);
      return filePath;
    }
  },

  findItem(id) {
    return this.items.find((it) => it.id === Number(id));
  },

  onTapItem(e) {
    const item = this.findItem(e.currentTarget.dataset.id);
    if (!item || item === this.poster) return;
    this.poster = item;
    this.ensureCategory();
    this.syncView();
    this.render();
  },

  onToggleSelect(e) {
    const item = this.findItem(e.currentTarget.dataset.id);
    if (!item) return;
    item.selected = !item.selected;
    this.setData(this.listView());
  },

  onToggleSelectAll() {
    const all = this.items.every((it) => it.selected);
    this.items.forEach((it) => {
      it.selected = !all;
    });
    this.setData(this.listView());
  },

  onRemoveItem(e) {
    const item = this.findItem(e.currentTarget.dataset.id);
    if (!item) return;
    const idx = this.items.indexOf(item);
    this.items.splice(idx, 1);
    item.locId += 1;
    this._imgCache.delete(item.photoPath);
    if (item === this.poster) {
      this.poster = this.items[Math.min(idx, this.items.length - 1)] || this.createItem('', item.templateId);
      this.ensureCategory();
      this.syncView();
      this.render();
    } else {
      this.setData(this.listView());
    }
  },

  // 统一模板：全部使用同一个；随机：每张各不相同（用完一轮再开始下一轮）
  onBatchModeChange(e) {
    const mode = e.currentTarget.dataset.mode;
    if (mode === this.data.batchMode) return;
    this.setData({ batchMode: mode }, () => {
      if (mode === 'random') this.reshuffle();
      else this.applyTemplateToAll(this.poster.templateId);
    });
  },

  // 当前照片的模板不在正在浏览的分类里时，切到它所属的分类，保证 Tab 上能看到选中项
  ensureCategory() {
    const tpl = TEMPLATES.find((t) => t.id === this.poster.templateId);
    if (!tpl || templatesOf(this.data.catId).some((t) => t.id === tpl.id)) return;
    this.setData({ catId: tpl.category, visibleTemplates: templateTabs(tpl.category) });
  },

  onTapCategory(e) {
    const catId = e.currentTarget.dataset.id;
    if (catId === this.data.catId) return;
    this.setData({ catId, visibleTemplates: templateTabs(catId) }, () => {
      // 随机模式的抽取范围就是当前分类
      if (this.data.batchMode === 'random' && this.items.length > 1) this.reshuffle();
    });
  },

  onReshuffle() {
    this.reshuffle();
  },

  reshuffle() {
    pickRandomTemplates(this.items.length, this.data.catId).forEach((id, i) => {
      this.items[i].templateId = id;
    });
    this.syncView();
    this.render();
  },

  applyTemplateToAll(templateId) {
    this.items.forEach((it) => {
      it.templateId = templateId;
    });
    this.poster.templateId = templateId;
    this.syncView();
    this.render();
  },

  async onPickLocation() {
    if (!this.data.hasPhoto) {
      wx.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    const actions = this.recentPlaces.map((p) => [`最近：${p.name}`, () => this.applyManualLocation(p.lat, p.lon, p.name)]);
    // wx.chooseLocation 使用腾讯地图，海外无法定位；配置了 Mapbox 时提供全球搜索
    if (mapService.hasToken()) {
      actions.push(['搜索地点（全球）', () => this.openSearch()]);
      actions.push(['地图选点（微信地图，仅国内）', () => this.pickWithWechatMap()]);
    } else {
      actions.push(['地图选点（微信地图）', () => this.pickWithWechatMap()]);
    }
    if (actions.length === 1) {
      await actions[0][1]();
      return;
    }
    let tapIndex;
    try {
      ({ tapIndex } = await wxp('showActionSheet', { itemList: actions.map((a) => a[0]) }));
    } catch (e) {
      return;
    }
    await actions[tapIndex][1]();
  },

  async openSearch() {
    await this.coverPreview();
    this.setData({ searchVisible: true, searchKeyword: '', searchResults: [], searching: false, searchEmpty: false });
  },

  async pickWithWechatMap() {
    let loc;
    try {
      loc = await wxp('chooseLocation', {});
    } catch (e) {
      if (isCancel(e)) return;
      console.error('choose location failed', e);
      wx.showToast({ title: isPrivacyDenied(e) ? '需同意隐私保护指引后才能地图选点' : '无法打开地图选点', icon: 'none' });
      return;
    }
    if (!loc || typeof loc.latitude !== 'number') return;

    // chooseLocation 返回 GCJ-02，需转换为 WGS-84 才能与 Mapbox 对齐
    const wgs = mapService.gcj02ToWgs84(loc.latitude, loc.longitude);
    await this.applyManualLocation(wgs.lat, wgs.lon, loc.name || '', loc.name || loc.address);
  },

  // 手动选定的地点：记入“最近”，并询问是否一起用于其余没有位置的照片（手动改过地名的除外）
  async applyManualLocation(lat, lon, name, label) {
    const target = this.poster;
    this.rememberPlace(lat, lon, label || name);
    this.showBusy('生成海报…');
    await this.applyLocation(target, lat, lon, name);
    this.hideBusy();
    const rest = this.items.filter((it) => it !== target && it.lat === null && !it.placeManual);
    if (!rest.length) return;
    const modal = await wxp('showModal', {
      title: '同时用于其他照片？',
      content: `还有 ${rest.length} 张照片没有位置，可以一起使用这个地点，之后仍可逐张修改。`,
      confirmText: '一起使用',
      cancelText: '仅这张',
      confirmColor: TINT
    }).catch(() => ({ confirm: false }));
    if (!modal.confirm) return;
    await Promise.all(rest.map((it) => this.applyLocation(it, lat, lon, name)));
    wx.showToast({ title: `已应用到 ${rest.length + 1} 张`, icon: 'none' });
  },

  rememberPlace(lat, lon, name) {
    const label = (name || '').trim() || exifParser.formatCoordinates(lat, lon).text;
    const same = (p) => p.name === label || (Math.abs(p.lat - lat) < 1e-3 && Math.abs(p.lon - lon) < 1e-3);
    this.recentPlaces = [{ name: label, lat, lon }].concat(this.recentPlaces.filter((p) => !same(p))).slice(0, RECENT_MAX);
    try {
      wx.setStorageSync(RECENT_KEY, this.recentPlaces);
    } catch (e) {
      /* 保存失败只影响下次的“最近”列表 */
    }
  },

  /* ---------------------------- 全球地点搜索 ---------------------------- */

  noop() {},

  onSearchClose() {
    this._searchId += 1;
    clearTimeout(this._searchTimer);
    this.setData({ searchVisible: false, searching: false });
    this.uncoverPreview();
  },

  onSearchInput(e) {
    const keyword = e.detail.value;
    this.setData({ searchKeyword: keyword });
    clearTimeout(this._searchTimer);
    if (!keyword.trim()) {
      this._searchId += 1;
      this.setData({ searchResults: [], searching: false, searchEmpty: false });
      return;
    }
    this._searchTimer = setTimeout(() => this.runSearch(keyword), 350);
  },

  onSearchConfirm(e) {
    clearTimeout(this._searchTimer);
    this.runSearch(e.detail.value);
  },

  async runSearch(keyword) {
    if (!keyword.trim()) return;
    const searchId = ++this._searchId;
    this.setData({ searching: true, searchEmpty: false });
    const results = await mapService.searchPlaces(keyword, this.data.placeLang);
    if (searchId !== this._searchId) return;
    this.setData({ searching: false, searchResults: results, searchEmpty: results.length === 0 });
  },

  async onSelectResult(e) {
    const hit = this.data.searchResults[e.currentTarget.dataset.index];
    if (!hit) return;
    this.onSearchClose();
    await this.applyManualLocation(hit.lat, hit.lon, hit.name);
  },

  /* ---------------------------- 地名：手动修改 / 语言切换 ---------------------------- */

  onPlaceInput(e) {
    const value = e.detail.value;
    this.poster.place = value;
    this.poster.placeManual = true;
    this.setData({ place: value, placeManual: true });
    clearTimeout(this._placeTimer);
    this._placeTimer = setTimeout(() => this.render(), 200);
  },

  // 把当前照片的地名统一应用到所有照片（坐标各自保留，并作废尚未返回的自动地名解析）。
  // 当前照片还没有可用地名时返回 false
  spreadPlace() {
    const text = (this.poster.place || '').trim();
    if (!text || text === 'LOCATING…') return false;
    this.items.forEach((it) => {
      it.locId += 1;
      it.place = text;
      it.placeManual = true;
    });
    return true;
  },

  spreadDate() {
    const { dateText, dateValue } = this.poster;
    if (!dateText) return false;
    this.items.forEach((it) => {
      Object.assign(it, { dateText, dateValue, dateManual: true });
    });
    return true;
  },

  onApplyPlaceToAll() {
    if (!this.spreadPlace()) {
      wx.showToast({ title: '请先填写地名', icon: 'none' });
      return;
    }
    this.syncView();
    this.render();
    wx.showToast({ title: `地名已应用到 ${this.items.length} 张`, icon: 'none' });
  },

  async onApplyToAllMenu() {
    let tapIndex;
    try {
      ({ tapIndex } = await wxp('showActionSheet', { itemList: ['地点和日期', '仅地点', '仅日期'] }));
    } catch (e) {
      return;
    }
    if (tapIndex === 1) return this.onApplyPlaceToAll();
    if (tapIndex === 2) return this.onApplyDateToAll();
    if (!this.spreadPlace()) {
      wx.showToast({ title: '请先填写地名', icon: 'none' });
      return;
    }
    this.spreadDate();
    this.syncView();
    this.render();
    wx.showToast({ title: `地点和日期已应用到 ${this.items.length} 张`, icon: 'none' });
  },

  onPlaceReset() {
    const item = this.poster;
    if (item.lat !== null) {
      this.resolvePlace(item, ++item.locId);
    } else {
      item.place = 'UNKNOWN';
      item.placeManual = false;
      this.touch(item, true);
    }
  },

  // 地名语言是全局设置：所有照片一起重新解析
  onPlaceLangChange(e) {
    const lang = e.currentTarget.dataset.lang;
    if (lang === this.data.placeLang) return;
    this.setData({ placeLang: lang }, () => {
      this.items.forEach((item) => {
        if (item.lat !== null) this.resolvePlace(item, ++item.locId);
      });
    });
  },

  // 地名范围：城市（默认）/ 详细。手动修改过的地名不受影响
  onPlaceLevelChange(e) {
    const level = e.currentTarget.dataset.level;
    if (level === this.data.placeLevel) return;
    this.setData({ placeLevel: level }, () => {
      this.items.forEach((item) => {
        if (item.lat !== null && !item.placeManual) this.resolvePlace(item, ++item.locId);
      });
    });
  },

  onTapTemplate(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.poster.templateId) return;
    tick();
    // 统一模板模式下作用于全部照片；随机模式下只改当前这张
    if (this.data.batchMode === 'unique') {
      this.applyTemplateToAll(id);
    } else {
      this.poster.templateId = id;
      this.syncView();
      this.render();
    }
  },

  /* ---------------------------- 照片取景（拖动 / 缩放） ---------------------------- */

  getCrop(tplId) {
    return this.poster.crops[tplId] || DEFAULT_CROP;
  },

  setCrop(tplId, patch) {
    const cur = this.getCrop(tplId);
    this.poster.crops[tplId] = {
      zoom: clamp(patch.zoom === undefined ? cur.zoom : patch.zoom, 1, MAX_CROP_ZOOM),
      x: clamp(patch.x === undefined ? cur.x : patch.x, -1, 1),
      y: clamp(patch.y === undefined ? cur.y : patch.y, -1, 1)
    };
  },

  // 把当前模板的取景参数同步到滑块
  syncCropData() {
    const tplId = this.poster.templateId;
    const crop = this.getCrop(tplId);
    this.setData({
      cropEnabled: !!CROP_REGIONS[tplId],
      cropZoom: Math.round(crop.zoom * 100),
      cropX: Math.round(crop.x * 100),
      cropY: Math.round(crop.y * 100)
    });
  },

  onCropSlider(e) {
    const tplId = this.poster.templateId;
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    if (key === 'cropZoom') this.setCrop(tplId, { zoom: value / 100 });
    if (key === 'cropX') this.setCrop(tplId, { x: value / 100 });
    if (key === 'cropY') this.setCrop(tplId, { y: value / 100 });
    this.setData({ [key]: value });
    this.scheduleRender();
  },

  onResetCrop() {
    delete this.poster.crops[this.poster.templateId];
    this.syncCropData();
    this.render();
  },

  onCanvasTouchStart(e) {
    const tplId = this.poster.templateId;
    const region = CROP_REGIONS[tplId];
    if (!region || !this.poster.photoSize || !e.touches.length) return;

    const t = e.touches[0];
    // 仅在照片区域内拖动才调整取景，避免误触其他区域
    if (typeof t.y === 'number' && typeof t.x === 'number') {
      const k = POSTER_W / this.cssSize.w;
      const lx = t.x * k;
      const ly = t.y * k;
      if (lx < region.left || lx > region.left + region.w || ly < region.top || ly > region.top + region.h) {
        this._gesture = null;
        return;
      }
    }
    const crop = this.getCrop(tplId);
    this._gesture = { tplId, start: crop, x: t.clientX, y: t.clientY, dist: 0 };
    if (e.touches.length >= 2) this._gesture.dist = this.touchDistance(e.touches);
  },

  onCanvasTouchMove(e) {
    const g = this._gesture;
    if (!g || !this.poster.photoSize) return;
    const region = CROP_REGIONS[g.tplId];
    const { w: iw, h: ih } = this.poster.photoSize;
    const k = POSTER_W / this.cssSize.w;

    // 双指缩放
    if (e.touches.length >= 2) {
      const dist = this.touchDistance(e.touches);
      if (!g.dist) {
        g.dist = dist;
        g.start = this.getCrop(g.tplId);
      } else if (dist > 0) {
        this.setCrop(g.tplId, { zoom: g.start.zoom * (dist / g.dist) });
        this.scheduleRender();
      }
      return;
    }

    // 单指拖动：手指向右 => 取景窗口向左移动
    const t = e.touches[0];
    const cover = Math.max(region.w / iw, region.h / ih) * g.start.zoom;
    const sw = region.w / cover;
    const sh = region.h / cover;
    const slackX = (iw - sw) / 2;
    const slackY = (ih - sh) / 2;
    const dx = (t.clientX - g.x) * k;
    const dy = (t.clientY - g.y) * k;
    this.setCrop(g.tplId, {
      x: slackX > 0.5 ? g.start.x - (dx * (sw / region.w)) / slackX : g.start.x,
      y: slackY > 0.5 ? g.start.y - (dy * (sh / region.h)) / slackY : g.start.y
    });
    this.scheduleRender();
  },

  onCanvasTouchEnd(e) {
    if (!this._gesture) return;
    if (e.touches && e.touches.length === 1) {
      // 双指抬起一根：以剩余手指重新作为拖动起点
      const t = e.touches[0];
      this._gesture = { tplId: this._gesture.tplId, start: this.getCrop(this._gesture.tplId), x: t.clientX, y: t.clientY, dist: 0 };
      return;
    }
    this._gesture = null;
    this.syncCropData();
  },

  touchDistance(touches) {
    const dx = touches[0].clientX - touches[1].clientX;
    const dy = touches[0].clientY - touches[1].clientY;
    return Math.sqrt(dx * dx + dy * dy);
  },

  /* ---------------------------- 地图配色 / 不透明度 ---------------------------- */

  onTapTheme(e) {
    const id = e.currentTarget.dataset.id;
    if (id === this.data.mapColorId) return;
    this.setData({ mapColorId: id }, () => this.render());
  },

  onCustomHexInput(e) {
    const text = e.detail.value;
    const hex = themes.parseHex(text);
    if (!hex) {
      this.setData({ customHexText: text });
      return;
    }
    const hsv = themes.hexToHsv(hex);
    // 灰色没有色相信息，保留当前色相，避免色相条跳回 0
    this._hsv = { h: hsv.s === 0 ? this._hsv.h : hsv.h, s: hsv.s, v: hsv.v };
    this.setData(this.customColorPatch(hex, text));
    this.scheduleRender();
  },

  /* ---------------------------- 调色盘（饱和度/明度 + 色相） ---------------------------- */

  pickerView() {
    const { h, s, v } = this._hsv;
    return {
      hueColor: themes.hsvToHex(h, 1, 1),
      padCursor: `left:${(s * 100).toFixed(2)}%;top:${((1 - v) * 100).toFixed(2)}%;`,
      hueCursor: `left:${((h / 360) * 100).toFixed(2)}%;`
    };
  },

  customColorPatch(hex, text) {
    return Object.assign(
      {
        customHex: hex,
        customHexText: text || hex,
        themes: this.data.themes.map((t) => (t.id === themes.CUSTOM_ID ? Object.assign({}, t, { tint: hex }) : t))
      },
      this.pickerView()
    );
  },

  measure(selector) {
    return new Promise((resolve) => {
      wx.createSelectorQuery()
        .select(selector)
        .boundingClientRect((rect) => resolve(rect))
        .exec();
    });
  },

  applyHsv(patch) {
    this._hsv = Object.assign({}, this._hsv, patch);
    const { h, s, v } = this._hsv;
    this.setData(this.customColorPatch(themes.hsvToHex(h, s, v)));
    this.scheduleRender();
  },

  applyPadTouch(touch) {
    const rect = this._padRect;
    if (!rect || !rect.width || !rect.height) return;
    this.applyHsv({
      s: clamp((touch.clientX - rect.left) / rect.width, 0, 1),
      v: 1 - clamp((touch.clientY - rect.top) / rect.height, 0, 1)
    });
  },

  applyHueTouch(touch) {
    const rect = this._hueRect;
    if (!rect || !rect.width) return;
    this.applyHsv({ h: clamp((touch.clientX - rect.left) / rect.width, 0, 1) * 360 });
  },

  async onPadStart(e) {
    const touch = e.touches[0];
    this._padRect = await this.measure('#colorPad');
    this.applyPadTouch(touch);
  },

  onPadMove(e) {
    this.applyPadTouch(e.touches[0]);
  },

  async onHueStart(e) {
    const touch = e.touches[0];
    this._hueRect = await this.measure('#hueBar');
    this.applyHueTouch(touch);
  },

  onHueMove(e) {
    this.applyHueTouch(e.touches[0]);
  },

  /* ---------------------------- 日期 ---------------------------- */

  onDateChange(e) {
    const value = e.detail.value;
    const text = exifParser.formatDate(value);
    if (!text) return;
    Object.assign(this.poster, { dateText: text, dateValue: value, dateManual: true });
    this.touch(this.poster, true);
  },

  onApplyDateToAll() {
    if (!this.spreadDate()) {
      wx.showToast({ title: '请先选择日期', icon: 'none' });
      return;
    }
    this.syncView();
    this.render();
    wx.showToast({ title: `日期已应用到 ${this.items.length} 张`, icon: 'none' });
  },

  onDateReset() {
    const auto = this.poster.autoDate;
    if (!auto) return;
    Object.assign(this.poster, { dateText: auto.text, dateValue: auto.value, dateManual: false });
    this.touch(this.poster, true);
  },

  onOpacityChanging(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value });
    this.scheduleRender();
  },

  onOpacityChange(e) {
    this.setData({ [e.currentTarget.dataset.key]: e.detail.value }, () => this.render());
  },

  onResetOpacity() {
    this.setData({ mapOpacity: 100, photoOpacity: 100, textOpacity: 100 }, () => this.render());
  },

  // 拖动滑块时合并高频更新，避免每一帧都重绘
  scheduleRender() {
    if (this._renderTimer) return;
    this._renderTimer = setTimeout(() => {
      this._renderTimer = null;
      this.render();
    }, 40);
  },

  onZoomChanging(e) {
    this.setData({ zoom: e.detail.value });
  },

  onZoomChange(e) {
    this.setData({ zoom: e.detail.value }, () => this.render());
  },

  /* ---------------------------- 位置与地名 ---------------------------- */

  async applyLocation(item, lat, lon, fallbackName) {
    const locId = ++item.locId;
    const coords = exifParser.formatCoordinates(lat, lon);
    item.lat = lat;
    item.lon = lon;
    item.fallbackName = fallbackName || '';
    item.coordText = coords.text;
    item.place = 'LOCATING…';
    item.placeManual = false;
    this.touch(item);
    await this.resolvePlace(item, locId);
  },

  // 按当前语言设置解析地名：服务商结果 -> 备用名（如选点名称）-> UNKNOWN。
  // 英文模式下若拿到的是汉字，短名转拼音、长名转首字母缩写。
  async resolvePlace(item, locId) {
    const { lat, lon, fallbackName } = item;
    const lang = this.data.placeLang;
    const key = `${lat.toFixed(4)},${lon.toFixed(4)},${lang}`;

    let geo = this._geoCache[key];
    if (geo === undefined) {
      geo = await mapService.reverseGeocode(lat, lon, lang);
      if (geo) this._geoCache[key] = geo;
    }
    if (locId !== item.locId) return;

    // 默认只显示城市，避免地名过长超出海报边界；可切换为“详细”
    const composed = geo ? placeName.formatPlace(geo.parts || { city: geo.name }, this.data.placeLevel, lang) : '';
    item.place = composed || placeName.normalizePlaceName(fallbackName, lang) || 'UNKNOWN';
    item.placeManual = false;
    this.touch(item, true);
  },

  /* ---------------------------- 渲染 ---------------------------- */

  // 下载当前模板/缩放对应的静态地图，失败时返回 null（画布回退到本地底图）
  async ensureMapFile(item, tpl, dark) {
    const { lat, lon } = item;
    if (lat === null || lon === null) return null;
    const url = mapService.buildStaticMapUrl({
      lat,
      lon,
      zoom: this.data.zoom,
      width: tpl.map.width,
      height: tpl.map.height,
      pin: tpl.map.pin,
      dark
    });
    if (!url) return null;
    if (this._mapCache[url]) return this._mapCache[url];
    try {
      const path = await mapService.downloadImage(url);
      this._mapCache[url] = path;
      return path;
    } catch (e) {
      console.warn('map download failed', e);
      if (!this._mapWarned) {
        this._mapWarned = true;
        wx.showToast({ title: '地图加载失败，已使用简约底图', icon: 'none' });
      }
      return null;
    }
  },

  async loadAssets(canvas, cache, tpl, style, item) {
    const [photo, mapPath] = await Promise.all([
      cachedImage(canvas, cache, item.photoPath),
      this.ensureMapFile(item, tpl, style.theme.dark)
    ]);
    let map = null;
    if (mapPath) {
      try {
        map = await cachedImage(canvas, cache, mapPath);
      } catch (e) {
        map = null;
      }
    }
    let qr = null;
    if (style.footer && appConfig.brand.qrcode) {
      try {
        qr = await cachedImage(canvas, cache, appConfig.brand.qrcode);
      } catch (e) {
        qr = null;
      }
    }
    let mapLogo = null;
    if (map) {
      try {
        mapLogo = await cachedImage(canvas, cache, MAPBOX_LOGO);
      } catch (e) {
        mapLogo = null;
      }
    }
    return { photo, map, qr, mapLogo };
  },

  // 配色与不透明度（0~1）为全局设置；取景按条目各自保存
  buildStyle(item) {
    const d = this.data;
    return {
      theme: themes.resolveTheme(d.mapColorId, d.customHex),
      mapAlpha: d.mapOpacity / 100,
      photoAlpha: d.photoOpacity / 100,
      textAlpha: d.textOpacity / 100,
      crop: item.crops[item.templateId] || DEFAULT_CROP,
      watermark: !this.isEntitled(item),
      footer: this.data.footerOn
    };
  },

  buildInfo(item) {
    const seed =
      item.lat === null ? 7 : Math.floor((item.lat + 90) * 1000) * 397 + Math.floor((item.lon + 180) * 1000);
    return {
      place: item.place || 'UNKNOWN',
      coordText: item.coordText || '-- ° --  -- ° --',
      dateText: item.dateText || '',
      seed,
      lat: item.lat,
      lon: item.lon,
      zoom: this.data.zoom
    };
  },

  async render() {
    if (!this.preview) return;
    const renderId = ++this._renderId;
    const canvas = this.preview;
    const item = this.poster;
    const tplId = item.templateId;
    const tpl = TEMPLATES.find((t) => t.id === tplId);
    const style = this.buildStyle(item);

    if (!item.photoPath) {
      paintPoster(canvas, tplId, null, null, style);
      return;
    }

    // 预览只缓存当前照片，避免批量时大图常驻内存
    this.items.forEach((it) => {
      if (it.photoPath !== item.photoPath) this._imgCache.delete(it.photoPath);
    });

    let assets;
    try {
      assets = await this.loadAssets(canvas, this._imgCache, tpl, style, item);
    } catch (e) {
      console.error('load assets failed', e);
      wx.showToast({ title: '图片加载失败', icon: 'none' });
      return;
    }
    // 期间用户切换了模板/照片：丢弃过期结果
    if (renderId !== this._renderId) return;
    item.photoSize = { w: assets.photo.width, h: assets.photo.height };
    paintPoster(canvas, tplId, assets, this.buildInfo(item), style);
  },

  /* ---------------------------- 转发 ---------------------------- */

  // 标题带上当前地名（包括用户手动输入的）
  shareTitle() {
    const place = this.data.hasPhoto ? (this.poster.place || '').trim() : '';
    if (!place || place === 'UNKNOWN' || place === 'LOCATING…') return SHARE_TITLE;
    return `「${place}」· 用 GEOPICS 做的地图海报`;
  },

  // 转发卡片按 5:4 显示，直接用 3:4 的预览会被裁掉上下：把整张预览居中放到 5:4 的底图上。
  // 3 秒内没生成完时，微信使用不带 imageUrl 的默认内容
  onShareAppMessage() {
    const share = { title: this.shareTitle(), path: '/pages/index/index' };
    const promise = this.composeShareImage()
      .catch((e) => {
        console.warn('compose share image failed', e);
        return '';
      })
      .then((imageUrl) => (imageUrl ? Object.assign({ imageUrl }, share) : share));
    return Object.assign({ promise }, share);
  },

  // 朋友圈只能同步返回，使用默认的小程序图标
  onShareTimeline() {
    return { title: this.shareTitle() };
  },

  async composeShareImage() {
    // 导出时离屏画布正在使用
    if (!this.preview || this.data.busy) return '';
    let snapshot = this.data.coverImage;
    if (!snapshot) {
      const { width, height } = this.preview;
      ({ tempFilePath: snapshot } = await wxp('canvasToTempFilePath', {
        canvas: this.preview,
        x: 0,
        y: 0,
        width,
        height,
        destWidth: width,
        destHeight: height,
        fileType: 'jpg',
        quality: 0.92
      }));
    }
    const canvas = await this.queryCanvas('#exportCanvas');
    canvas.width = SHARE_W;
    canvas.height = SHARE_H;
    const ctx = canvas.getContext('2d');
    const img = await loadImage(canvas, snapshot);
    ctx.fillStyle = '#F2F2F7';
    ctx.fillRect(0, 0, SHARE_W, SHARE_H);
    const h = SHARE_H - SHARE_PAD * 2;
    const w = Math.round((h * img.width) / img.height);
    const x = Math.round((SHARE_W - w) / 2);
    ctx.save();
    ctx.shadowColor = 'rgba(0, 0, 0, 0.16)';
    ctx.shadowBlur = 32;
    ctx.shadowOffsetY = 10;
    ctx.fillStyle = '#FFFFFF';
    ctx.fillRect(x, SHARE_PAD, w, h);
    ctx.restore();
    ctx.drawImage(img, x, SHARE_PAD, w, h);
    const { tempFilePath } = await wxp('canvasToTempFilePath', {
      canvas,
      x: 0,
      y: 0,
      width: SHARE_W,
      height: SHARE_H,
      destWidth: SHARE_W,
      destHeight: SHARE_H,
      fileType: 'jpg',
      quality: 0.9
    });
    return tempFilePath;
  },

  /* ---------------------------- 导出 ---------------------------- */

  // 渲染一张照片并导出为临时文件（1200 x 1600）
  async exportItem(item) {
    // 页面外的隐藏 canvas 作为离屏画布：物理尺寸 1200 x 1600（3 倍）
    const canvas = await this.queryCanvas('#exportCanvas');
    canvas.width = POSTER_W * EXPORT_SCALE;
    canvas.height = Math.round(posterHeight(this.data.footerOn) * EXPORT_SCALE);

    const tpl = TEMPLATES.find((t) => t.id === item.templateId);
    // 离屏画布不复用预览缓存，使用独立的 Image 对象
    const style = this.buildStyle(item);
    const assets = await this.loadAssets(canvas, null, tpl, style, item);
    paintPoster(canvas, item.templateId, assets, this.buildInfo(item), style);

    const { tempFilePath } = await wxp('canvasToTempFilePath', {
      canvas,
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      destWidth: canvas.width,
      destHeight: canvas.height,
      fileType: 'jpg',
      quality: 1
    });
    return tempFilePath;
  },

  // 被拦下的原因与购买引导。allowedCount 为这次仍可下载的张数
  blockedNotice(blocked, total, allowedCount) {
    const now = Date.now();
    const buy = this.canPurchase;
    const member = membership.isMember(this.member, now) || this.member.bought;
    const onlyFree = blocked.every((it) => membership.isFreeTemplate(it.templateId));
    const free = membership.freeRemaining(this.member, now);
    let text;
    if (allowedCount > 0) {
      text = member
        ? `本次需下载 ${total} 张，剩余额度只够 ${allowedCount} 张。`
        : `额度只够 ${allowedCount} 张，其余 ${blocked.length} 张带水印，无法下载。`;
      if (buy) text += member ? `购买额外的月度或年度会员可继续下载其余 ${blocked.length} 张。` : '开通会员可继续下载。';
      return text;
    }
    if (member) {
      text = membership.hasLifetime(this.member) ? '本月额度已用完，下月 1 日重置。' : '额度已用完或已到期。';
    } else if (onlyFree) {
      text = `本月 ${appConfig.membership.free.monthly} 张拍立得免费额度已用完，下月 1 日重置。`;
    } else {
      text = `该模板预览带水印、不能下载，付费后才可保存。${free > 0 ? `拍立得模板本月还可免费保存 ${free} 张。` : ''}`;
    }
    if (buy) text += member ? '购买额外的月度或年度会员即可继续下载。' : '开通会员即可继续下载。';
    return text;
  },

  // 没有可用额度且未保存过的照片不能下载：全部被拦下就弹出付费面板，部分被拦下则询问；
  // 购买 / 兑换成功后自动继续刚才的操作
  async requestSave(items, resume) {
    if (this.data.busy || !items.length) return;
    const { allowed, blocked } = this.splitByEntitlement(items);
    const member = membership.isMember(this.member) || this.member.bought;
    const buy = this.canPurchase;
    const notice = blocked.length ? this.blockedNotice(blocked, items.length, allowed.length) : '';
    if (!allowed.length) {
      await this.openPaywall(resume, notice);
      return;
    }
    if (blocked.length) {
      // 按钮文字最多 4 个字符，超出时 showModal 直接失败，张数只能放在正文里
      const res = await wxp('showModal', {
        title: member ? '会员额度不足' : '部分照片未解锁',
        content: `${notice}\n是否仅下载可下载的 ${allowed.length} 张？`,
        confirmText: '仅下载',
        cancelText: buy ? (member ? '购买会员' : '去解锁') : '取消',
        confirmColor: TINT
      }).catch(() => ({ confirm: false }));
      if (!res.confirm) {
        if (buy) await this.openPaywall(resume, notice);
        return;
      }
    }
    return this.saveItems(allowed);
  },

  onSavePoster() {
    if (!this.data.hasPhoto) {
      wx.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    return this.requestSave([this.poster], () => this.onSavePoster());
  },

  onSaveSelected() {
    const picked = this.items.filter((it) => it.selected);
    if (!picked.length) {
      wx.showToast({ title: '请先勾选要下载的照片', icon: 'none' });
      return;
    }
    return this.requestSave(picked, () => this.onSaveSelected());
  },

  onSaveAll() {
    if (!this.items.length) {
      wx.showToast({ title: '请先选择照片', icon: 'none' });
      return;
    }
    return this.requestSave(this.items.slice(), () => this.onSaveAll());
  },

  // 工具栏的批量按钮：全部勾选时即“下载全部”，否则只下载勾选的照片
  onSaveBatch() {
    if (!this.requireBatch(() => this.onSaveBatch())) return;
    return this.data.selectedCount === this.items.length ? this.onSaveAll() : this.onSaveSelected();
  },

  // 逐张导出并保存到相册。额度不足、扣额度时网络异常、未同意隐私指引、相册权限被拒绝时立即终止，
  // 其余失败计入统计
  async saveItems(items) {
    if (this.data.busy || !items.length) return;
    const total = items.length;
    let ok = 0;
    let fail = 0;
    let stop = '';
    const upfront = !payment.isMock();
    const progress = (i) => (total > 1 ? `导出 ${i + 1}/${total}…` : '生成高清海报…');
    this.showBusy(progress(0));
    if (total > 1) keepScreenOn(true);

    for (let i = 0; i < total && !stop; i += 1) {
      if (i > 0) this.setData({ busyText: progress(i) });
      if (upfront) {
        try {
          await this.chargeItem(items[i]);
        } catch (e) {
          if (!(e && e.code === 'insufficient')) console.error('charge failed', e);
          stop = e && e.code === 'insufficient' ? 'short' : 'offline';
          break;
        }
      }
      try {
        const filePath = await this.exportItem(items[i]);
        await wxp('saveImageToPhotosAlbum', { filePath });
        ok += 1;
        if (!upfront) await this.chargeItem(items[i]);
      } catch (e) {
        if (isCancel(e)) stop = 'cancel';
        else if (isPrivacyDenied(e)) stop = 'privacy';
        else if (/auth/i.test((e && e.errMsg) || '')) stop = 'denied';
        else {
          console.error('export failed', e);
          fail += 1;
        }
      }
    }
    if (total > 1) keepScreenOn(false);
    this.hideBusy();
    const short = stop === 'short';
    if (ok || short) this.refreshEntitlement();
    if (short) {
      // 服务端认定额度不足（本地快照过期或被篡改）：购买 / 兑换成功后继续下载没保存的照片
      const rest = items.filter((it) => !it.unlocked[it.templateId]);
      const resume = () => this.requestSave(rest, resume);
      const saved = ok ? `已保存 ${ok} 张，剩余额度不足` : '额度不足';
      const upsell = !this.canPurchase ? '。' : ok ? '，购买会员后可继续下载其余照片。' : '，购买会员后即可继续下载。';
      await this.openPaywall(resume, saved + upsell);
      return;
    }

    const saved = ok ? `已保存 ${ok} 张。` : '';
    if (stop === 'offline') {
      wxp('showModal', {
        title: '网络异常',
        content: `${saved}暂时无法连接服务器校验额度，${ok ? '其余照片未保存，' : ''}请检查网络后重试。`,
        showCancel: false,
        confirmColor: TINT
      }).catch(() => {});
      return;
    }
    if (stop === 'privacy') {
      wxp('showModal', {
        title: '无法保存到相册',
        content: `${saved}需同意《隐私保护指引》后才能保存到相册，请重试并在弹窗中选择同意。`,
        showCancel: false,
        confirmColor: TINT
      }).catch(() => {});
      return;
    }
    if (stop === 'denied') {
      const res = await wxp('showModal', {
        title: '需要相册权限',
        content: ok ? `已保存 ${ok} 张，请在设置中允许保存到相册后继续` : '请在设置中允许保存到相册后重试',
        confirmText: '去设置',
        confirmColor: TINT
      }).catch(() => ({ confirm: false }));
      if (res.confirm) wx.openSetting({});
      return;
    }
    if (!fail) {
      if (ok) wx.showToast({ title: ok > 1 ? `已保存 ${ok} 张` : '已保存到相册', icon: 'success' });
    } else if (!ok) {
      wx.showToast({ title: '导出失败，请重试', icon: 'none' });
    } else {
      wxp('showModal', {
        title: '部分导出失败',
        content: `成功 ${ok} 张，失败 ${fail} 张，可重试失败的照片。`,
        showCancel: false,
        confirmColor: TINT
      }).catch(() => {});
    }
  }
});
