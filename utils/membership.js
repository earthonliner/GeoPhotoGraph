/**
 * 会员与额度。规则：
 * - 免费版：只有 config.membership.free.templates 中的模板（拍立得）每月有 free.monthly 张免费额度，
 *   按自然月（北京时间）计算，次月 1 日重置；其余模板预览带水印、不能下载，付费后才去水印并可下载。
 * - 付费额度三种：额度包（月度 / 年度，有效期内共 quota 张）、买断（永久有效，每自然月 monthly 张，不累计）、
 *   单张额度（一次性，长期有效）。邀请码会员不限量。
 * - 批量导入与批量下载只对会员开放：邀请码、买断、有效期内的月度 / 年度。只买单张不含批量。
 * - 保存一张无水印海报消耗 1 张，顺序：免费额度（仅免费模板）→ 买断当月额度 → 额度包（最早到期的先扣）→ 单张额度。
 * - 计费粒度是“一张照片 + 一个模板”：同一张照片同一模板再次保存不重复计费，换模板再保存则重新计费。
 *
 * 注意：本地缓存与客户端校验只能防君子。正式收费请在服务端保存权益并校验（cloud 模式），
 * 服务端规则见 cloudfunctions/api/quota.js，两处必须保持一致，见 README「会员」一节。
 */
const config = require('./config');

const KEY = 'geopics.membership';
const DAY = 24 * 60 * 60 * 1000;
// 额度按北京时间的自然月重置，与手机所在时区无关
const MONTH_OFFSET = 8 * 60 * 60 * 1000;

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

function cleanLifetime(l) {
  if (!l || typeof l !== 'object' || !l.planId) return null;
  return { planId: String(l.planId), quota: cleanCount(l.quota), month: String(l.month || ''), used: cleanCount(l.used) };
}

// 把本地缓存 / 服务端返回的对象整理成标准状态，缺失或异常字段按默认值处理
function normalize(raw) {
  const state = raw && typeof raw === 'object' ? raw : {};
  return {
    invite: !!state.invite,
    bought: !!state.bought,
    freeMonth: String(state.freeMonth || ''),
    freeUsed: cleanCount(state.freeUsed),
    singles: cleanCount(state.singles),
    lifetime: cleanLifetime(state.lifetime),
    packs: Array.isArray(state.packs) ? state.packs.map(cleanPack) : []
  };
}

function load(storage) {
  return normalize((storage || defaultStorage()).get(KEY));
}

function save(state, storage) {
  (storage || defaultStorage()).set(KEY, normalize(state));
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

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

// 'YYYY-MM'，北京时间
function monthKey(now) {
  const d = new Date(now0(now) + MONTH_OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function isFreeTemplate(tplId) {
  return config.membership.free.templates.indexOf(tplId) >= 0;
}

// 未过期且还有剩余额度的额度包，按到期时间从早到晚
function activePacks(state, now) {
  const t = now0(now);
  return state.packs
    .filter((p) => p.until > t && p.used < p.quota)
    .sort((a, b) => a.until - b.until);
}

function packsRemaining(state, now) {
  return activePacks(state, now).reduce((sum, p) => sum + (p.quota - p.used), 0);
}

// 本月免费模板还能免费保存的张数
function freeRemaining(state, now) {
  const used = state.freeMonth === monthKey(now) ? cleanCount(state.freeUsed) : 0;
  return Math.max(0, cleanCount(config.membership.free.monthly) - used);
}

function hasLifetime(state) {
  return !!state.lifetime;
}

// 买断会员本月还剩的张数
function lifetimeRemaining(state, now) {
  const l = state.lifetime;
  if (!l) return 0;
  const used = l.month === monthKey(now) ? l.used : 0;
  return Math.max(0, l.quota - used);
}

// 已购买、尚未使用的单张额度
function singlesRemaining(state) {
  return cleanCount(state.singles);
}

// 付费额度（买断当月 + 额度包 + 单张），与模板无关；邀请码不限量
function paidRemaining(state, now) {
  if (state.invite) return Infinity;
  return lifetimeRemaining(state, now) + packsRemaining(state, now) + singlesRemaining(state);
}

// 会员：邀请码、买断、或有效期内的月度 / 年度（额度用完也算，只是暂时不能下载）
function isMember(state, now) {
  const t = now0(now);
  return !!state.invite || hasLifetime(state) || state.packs.some((p) => p.until > t);
}

// 批量导入与批量下载只对会员开放，只买单张不含批量
function batchAllowed(state, now) {
  return isMember(state, now);
}

// 给定模板当前还能保存的无水印张数：付费额度 + （免费模板的）本月免费额度
function availableQuota(state, tplId, now) {
  if (state.invite) return Infinity;
  return paidRemaining(state, now) + (isFreeTemplate(tplId) ? freeRemaining(state, now) : 0);
}

function clone(state, patch) {
  return Object.assign(normalize(state), patch);
}

// 购买额度包：每次购买都是新的一包（有效期从购买时起算），可叠加
function addPack(state, plan, now) {
  const t = now0(now);
  const pack = { planId: plan.id, quota: plan.quota, used: 0, until: t + plan.days * DAY };
  return clone(state, { bought: true, packs: state.packs.filter((p) => p.until > t).concat(pack) });
}

// 买断只能买一次，重复调用不改变已有的买断记录
function addLifetime(state, plan, now) {
  if (state.lifetime) return clone(state, {});
  return clone(state, { bought: true, lifetime: { planId: plan.id, quota: plan.monthly, month: monthKey(now), used: 0 } });
}

function addSingle(state) {
  return clone(state, { singles: singlesRemaining(state) + 1 });
}

// 消耗：tplIds 里每个模板 id 对应一张。先用免费额度（仅免费模板），再依次扣买断当月、最早到期的包、单张额度。
// 调用方须先确认额度足够
function consume(state, tplIds, now) {
  if (state.invite) return state;
  const t = now0(now);
  const mk = monthKey(t);
  const freeWanted = tplIds.filter(isFreeTemplate).length;
  const useFree = Math.min(freeWanted, freeRemaining(state, t));
  let left = tplIds.length - useFree;

  let lifetime = state.lifetime;
  if (lifetime) {
    const used = lifetime.month === mk ? lifetime.used : 0;
    const take = Math.min(left, Math.max(0, lifetime.quota - used));
    lifetime = Object.assign({}, lifetime, { month: mk, used: used + take });
    left -= take;
  }

  const packs = state.packs.map(cleanPack);
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

  const useSingles = Math.min(left, singlesRemaining(state));
  const usedFree = state.freeMonth === mk ? cleanCount(state.freeUsed) : 0;
  return clone(state, {
    freeMonth: useFree > 0 ? mk : state.freeMonth,
    freeUsed: useFree > 0 ? usedFree + useFree : state.freeUsed,
    singles: singlesRemaining(state) - useSingles,
    lifetime,
    packs
  });
}

function formatDate(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

// 付费面板顶部的状态文案。purchasable 为 false（当前平台不提供购买）时不带购买引导
function label(state, now, purchasable = true) {
  if (state.invite) return '会员 · 邀请码';
  const t = now0(now);
  const cta = (text) => (purchasable ? ` · ${text}` : '');
  const paid = paidRemaining(state, t);
  if (isMember(state, t)) {
    if (paid > 0) return `会员 · 剩余 ${paid} 张`;
    return hasLifetime(state) ? '会员 · 本月额度已用完' : `额度已用完${cta('续购')}`;
  }
  const singles = singlesRemaining(state);
  if (singles > 0) return `剩余 ${singles} 张${cta('开通会员')}`;
  if (state.bought) return `会员已到期${cta('续购')}`;
  const free = freeRemaining(state, t);
  if (free > 0) return `拍立得本月免费剩余 ${free} 张${cta('开通会员')}`;
  return `本月免费额度已用完${cta('开通会员')}`;
}

// 大标题旁胶囊按钮上的短文案
function chipLabel(state, now, purchasable = true) {
  if (state.invite) return '会员';
  const t = now0(now);
  const paid = paidRemaining(state, t);
  if (isMember(state, t)) {
    if (paid > 0) return `会员 · ${paid} 张`;
    if (hasLifetime(state)) return '会员 · 已用完';
    return purchasable ? '续购会员' : '额度已用完';
  }
  const singles = singlesRemaining(state);
  if (singles > 0) return `剩余 ${singles} 张`;
  if (state.bought) return purchasable ? '续购会员' : '额度已用完';
  const free = freeRemaining(state, t);
  if (free > 0) return `免费 · ${free} 张`;
  return purchasable ? '开通会员' : '额度已用完';
}

// 付费面板中的额度明细，按消耗顺序
function packLines(state, plans, now) {
  const t = now0(now);
  const lines = [];
  if (state.lifetime) {
    const l = config.membership.lifetime;
    const name = l && l.id === state.lifetime.planId ? l.name : '买断会员';
    lines.push(`${name} 本月剩余 ${lifetimeRemaining(state, t)}/${state.lifetime.quota} 张 · 每月 1 日重置`);
  }
  activePacks(state, t).forEach((p) => {
    const plan = (plans || config.membership.plans).find((x) => x.id === p.planId);
    lines.push(`${plan ? plan.name : '会员'} 剩余 ${p.quota - p.used}/${p.quota} 张 · ${formatDate(p.until)} 到期`);
  });
  if (singlesRemaining(state) > 0) lines.push(`${config.membership.single.name} 剩余 ${singlesRemaining(state)} 张`);
  return lines;
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
  monthKey,
  isFreeTemplate,
  activePacks,
  packsRemaining,
  freeRemaining,
  hasLifetime,
  lifetimeRemaining,
  singlesRemaining,
  paidRemaining,
  isMember,
  batchAllowed,
  availableQuota,
  addPack,
  addLifetime,
  addSingle,
  consume,
  label,
  chipLabel,
  packLines,
  formatPrice,
  formatDate,
  normalizeCode,
  DAY
};
