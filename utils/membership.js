/**
 * 会员状态：邀请码（不限量）+ 额度包（月度 / 年度会员）。
 * 每次购买得到一个独立的额度包 { planId, quota, used, until }，多次购买可叠加，
 * 每保存一张无水印高清海报消耗 1 个额度；额度用完或到期即失效。
 * 每位用户另有 config.membership.freeQuota 张免费额度（freeUsed 记录已用张数），优先于额度包消耗；
 * 免费额度用完后才显示水印。
 * 单张付费：本地（mock）模式只对当前会话中的那张照片生效，由页面在内存里记录（item.unlocked）；
 * 云端模式由服务端记为一次性的“单张额度”（singles），任意一张照片保存时消耗 1 次，长期有效。
 *
 * 注意：本地缓存与客户端校验只能防君子。正式收费请在服务端保存权益并校验，
 * 见 README「会员」一节。
 */
const config = require('./config');

const KEY = 'geopics.membership';
const DAY = 24 * 60 * 60 * 1000;

function defaultStorage() {
  return {
    get: (k) => {
      try {
        return wx.getStorageSync(k);
      } catch (e) {
        return null;
      }
    },
    set: (k, v) => {
      try {
        wx.setStorageSync(k, v);
      } catch (e) {
        /* 缓存写入失败时仅本次会话有效 */
      }
    }
  };
}

function cleanCount(n) {
  return Math.max(0, Math.floor(Number(n) || 0));
}

function cleanPack(p) {
  return {
    planId: String((p && p.planId) || ''),
    quota: Math.max(0, Number(p && p.quota) || 0),
    used: Math.max(0, Number(p && p.used) || 0),
    until: Number(p && p.until) || 0
  };
}

// 把本地缓存 / 服务端返回的对象整理成标准状态，缺失或异常字段按默认值处理
function normalize(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    invite: !!state.invite,
    bought: !!state.bought,
    freeUsed: cleanCount(state.freeUsed),
    singles: cleanCount(state.singles),
    packs: Array.isArray(state.packs) ? state.packs.map(cleanPack) : []
  };
}

function load(storage) {
  return normalize((storage || defaultStorage()).get(KEY));
}

function save(state, storage) {
  (storage || defaultStorage()).set(KEY, {
    invite: !!state.invite,
    bought: !!state.bought,
    freeUsed: cleanCount(state.freeUsed),
    singles: cleanCount(state.singles),
    packs: state.packs.map(cleanPack)
  });
}

function normalizeCode(code) {
  return String(code || '').trim().toLowerCase();
}

function isValidInvite(code, codes) {
  const c = normalizeCode(code);
  return !!c && (codes || config.membership.inviteCodes).some((x) => normalizeCode(x) === c);
}

function now0(now) {
  return now === undefined ? Date.now() : now;
}

// 未过期且还有剩余额度的额度包，按到期时间从早到晚
function activePacks(state, now) {
  const t = now0(now);
  return state.packs
    .filter((p) => p.until > t && p.used < p.quota)
    .sort((a, b) => a.until - b.until);
}

// 剩余可下载张数；邀请码会员不限量
function remainingQuota(state, now) {
  if (state.invite) return Infinity;
  return activePacks(state, now).reduce((sum, p) => sum + (p.quota - p.used), 0);
}

// 剩余免费张数
function freeRemaining(state) {
  return Math.max(0, cleanCount(config.membership.freeQuota) - cleanCount(state.freeUsed));
}

// 已购买、尚未使用的单张额度
function singlesRemaining(state) {
  return cleanCount(state.singles);
}

// 当前还能保存的无水印张数：邀请码不限量，否则为免费额度 + 单张额度 + 额度包
function availableQuota(state, now) {
  if (state.invite) return Infinity;
  return freeRemaining(state) + singlesRemaining(state) + remainingQuota(state, now);
}

// 购买额度包：每次购买都是新的一包（有效期从购买时起算），可叠加
function addPack(state, plan, now) {
  const t = now0(now);
  const pack = { planId: plan.id, quota: plan.quota, used: 0, until: t + plan.days * DAY };
  return {
    invite: state.invite,
    bought: true,
    freeUsed: cleanCount(state.freeUsed),
    singles: cleanCount(state.singles),
    packs: state.packs.filter((p) => p.until > t).concat(pack)
  };
}

// 消耗 n 个额度：先用免费额度，再用单张额度，最后扣最早到期的包
function consume(state, n, now) {
  if (state.invite) return state;
  const useFree = Math.min(n, freeRemaining(state));
  const useSingles = Math.min(n - useFree, singlesRemaining(state));
  let left = n - useFree - useSingles;
  const packs = state.packs.map(cleanPack);
  const t = now0(now);
  const order = packs
    .map((p, i) => i)
    .filter((i) => packs[i].until > t && packs[i].used < packs[i].quota)
    .sort((x, y) => packs[x].until - packs[y].until);
  for (const i of order) {
    if (left <= 0) break;
    const take = Math.min(left, packs[i].quota - packs[i].used);
    packs[i].used += take;
    left -= take;
  }
  return {
    invite: state.invite,
    bought: state.bought,
    freeUsed: cleanCount(state.freeUsed) + useFree,
    singles: singlesRemaining(state) - useSingles,
    packs
  };
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 展示在标题栏的短文案
function label(state, now) {
  if (state.invite) return '会员 · 邀请码';
  if (remainingQuota(state, now) > 0) return `会员 · 剩余 ${availableQuota(state, now)} 张`;
  if (state.bought) return '额度已用完 · 续购';
  const free = freeRemaining(state);
  const singles = singlesRemaining(state);
  if (free + singles > 0) return `${singles > 0 ? '剩余' : '免费额度剩余'} ${free + singles} 张 · 开通会员`;
  return '免费额度已用完 · 开通会员';
}

// 大标题旁胶囊按钮上的短文案
function chipLabel(state, now) {
  if (state.invite) return '会员';
  if (remainingQuota(state, now) > 0) return `会员 · ${availableQuota(state, now)} 张`;
  if (state.bought) return '续购会员';
  const free = freeRemaining(state);
  const singles = singlesRemaining(state);
  if (singles > 0) return `剩余 ${free + singles} 张`;
  return free > 0 ? `免费 · ${free} 张` : '开通会员';
}

// 付费面板中的额度明细
function packLines(state, plans, now) {
  const lines = singlesRemaining(state) > 0 ? [`${config.membership.single.name} 剩余 ${singlesRemaining(state)} 张`] : [];
  return lines.concat(activePacks(state, now).map((p) => {
    const plan = (plans || config.membership.plans).find((x) => x.id === p.planId);
    return `${plan ? plan.name : '会员'} 剩余 ${p.quota - p.used}/${p.quota} 张 · ${formatDate(p.until)} 到期`;
  }));
}

// 分 -> 元，去掉多余的 0：1490 -> ¥14.9，10990 -> ¥109.9，129 -> ¥1.29，1900 -> ¥19
function formatPrice(cents) {
  return `¥${+(cents / 100).toFixed(2)}`;
}

module.exports = {
  normalize,
  load,
  save,
  isValidInvite,
  activePacks,
  remainingQuota,
  freeRemaining,
  singlesRemaining,
  availableQuota,
  addPack,
  consume,
  label,
  chipLabel,
  packLines,
  formatPrice,
  formatDate,
  normalizeCode,
  DAY
};
