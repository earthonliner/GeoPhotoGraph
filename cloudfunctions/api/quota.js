/**
 * 额度规则（纯函数，不接触数据库）。与小程序端 utils/membership.js 的规则一致：
 * 保存一张无水印海报消耗 1 张，顺序为免费额度（仅免费模板，按北京时间自然月重置）→ 买断当月额度 →
 * 额度包（最早到期的先扣）→ 单张额度；邀请码会员不限量。
 */
const DAY = 24 * 60 * 60 * 1000;
const MONTH_OFFSET = 8 * 60 * 60 * 1000;

function cleanCount(n) {
  return Math.max(0, Math.floor(Number(n) || 0));
}

function cleanPack(p) {
  return {
    orderId: String((p && p.orderId) || ''),
    planId: String((p && p.planId) || ''),
    quota: cleanCount(p && p.quota),
    used: cleanCount(p && p.used),
    until: Number(p && p.until) || 0
  };
}

function cleanLifetime(l) {
  if (!l || typeof l !== 'object' || !l.planId) return null;
  return { orderId: String(l.orderId || ''), planId: String(l.planId), quota: cleanCount(l.quota), month: String(l.month || ''), used: cleanCount(l.used) };
}

function pad(n) {
  return n < 10 ? `0${n}` : `${n}`;
}

// 'YYYY-MM'，北京时间
function monthKey(now) {
  const d = new Date(now + MONTH_OFFSET);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`;
}

function newUser(now) {
  return {
    invite: false,
    bought: false,
    freeMonth: '',
    freeUsed: 0,
    singles: 0,
    lifetime: null,
    packs: [],
    charged: [],
    inviteFails: 0,
    inviteFailsSince: 0,
    createdAt: now
  };
}

function isFreeTemplate(free, tplId) {
  return (free.templates || []).indexOf(tplId) >= 0;
}

function activePacks(user, now) {
  return (user.packs || []).map(cleanPack).filter((p) => p.until > now && p.used < p.quota);
}

function freeRemaining(user, free, now) {
  const used = user.freeMonth === monthKey(now) ? cleanCount(user.freeUsed) : 0;
  return Math.max(0, cleanCount(free.monthly) - used);
}

function lifetimeRemaining(user, now) {
  const l = cleanLifetime(user.lifetime);
  if (!l) return 0;
  return Math.max(0, l.quota - (l.month === monthKey(now) ? l.used : 0));
}

// 付费额度（买断当月 + 额度包 + 单张）
function paidRemaining(user, now) {
  const packs = activePacks(user, now).reduce((sum, p) => sum + p.quota - p.used, 0);
  return lifetimeRemaining(user, now) + packs + cleanCount(user.singles);
}

// tplIds 是这次要保存的各张海报所用的模板。免费模板先用免费额度，其余（及免费额度不够的部分）用付费额度。
function available(user, tplIds, free, now) {
  if (user.invite) return true;
  const freeWanted = tplIds.filter((id) => isFreeTemplate(free, id)).length;
  const useFree = Math.min(freeWanted, freeRemaining(user, free, now));
  return tplIds.length - useFree <= paidRemaining(user, now);
}

// 扣减，返回新的 { freeMonth, freeUsed, singles, lifetime, packs }；调用方须先确认 available
function consume(user, tplIds, free, now) {
  const mk = monthKey(now);
  const freeWanted = tplIds.filter((id) => isFreeTemplate(free, id)).length;
  const useFree = Math.min(freeWanted, freeRemaining(user, free, now));
  let left = tplIds.length - useFree;

  let lifetime = cleanLifetime(user.lifetime);
  if (lifetime) {
    const used = lifetime.month === mk ? lifetime.used : 0;
    const take = Math.min(left, Math.max(0, lifetime.quota - used));
    lifetime = Object.assign({}, lifetime, { month: mk, used: used + take });
    left -= take;
  }

  const packs = (user.packs || []).map(cleanPack);
  const order = packs
    .map((p, i) => i)
    .filter((i) => packs[i].until > now && packs[i].used < packs[i].quota)
    .sort((x, y) => packs[x].until - packs[y].until);
  for (const i of order) {
    if (left <= 0) break;
    const take = Math.min(left, packs[i].quota - packs[i].used);
    packs[i].used += take;
    left -= take;
  }

  const singles = cleanCount(user.singles);
  const useSingles = Math.min(left, singles);
  const usedFree = user.freeMonth === mk ? cleanCount(user.freeUsed) : 0;
  return {
    freeMonth: useFree > 0 ? mk : user.freeMonth || '',
    freeUsed: useFree > 0 ? usedFree + useFree : cleanCount(user.freeUsed),
    singles: singles - useSingles,
    lifetime,
    packs
  };
}

// 月度 / 年度：新增一包额度（有效期从支付时起算），并清理已过期的包
function grantPlan(user, plan, orderId, now) {
  const pack = { orderId, planId: plan.id, quota: plan.quota, used: 0, until: now + plan.days * DAY };
  return { bought: true, packs: (user.packs || []).map(cleanPack).filter((p) => p.until > now).concat(pack) };
}

// 买断：只能有一份，重复支付不会覆盖已有记录（当月已用张数不会被重置）
function grantLifetime(user, plan, orderId, now) {
  if (cleanLifetime(user.lifetime)) return { bought: true };
  return { bought: true, lifetime: { orderId, planId: plan.id, quota: plan.monthly, month: monthKey(now), used: 0 } };
}

function grantSingle(user, single) {
  return { singles: cleanCount(user.singles) + single.quota };
}

// 退款后收回该订单发放的权益（额度包 / 买断记录 / 单张额度），bought 保持不变
function revokeOrder(user, order) {
  if (order.kind === 'plan') return { packs: (user.packs || []).map(cleanPack).filter((p) => p.orderId !== order._id) };
  if (order.kind === 'lifetime') {
    const l = cleanLifetime(user.lifetime);
    return l && l.orderId === order._id ? { lifetime: null } : {};
  }
  return { singles: Math.max(0, cleanCount(user.singles) - 1) };
}

// 返回给小程序的权益快照：不含 charged 等内部字段
function publicState(user, now) {
  const l = cleanLifetime(user.lifetime);
  return {
    invite: !!user.invite,
    bought: !!user.bought,
    freeMonth: String(user.freeMonth || ''),
    freeUsed: cleanCount(user.freeUsed),
    singles: cleanCount(user.singles),
    lifetime: l ? { planId: l.planId, quota: l.quota, month: l.month, used: l.used } : null,
    packs: (user.packs || []).map(cleanPack).filter((p) => p.until > now).map((p) => ({ planId: p.planId, quota: p.quota, used: p.used, until: p.until }))
  };
}

module.exports = {
  DAY,
  cleanCount,
  monthKey,
  newUser,
  activePacks,
  freeRemaining,
  lifetimeRemaining,
  paidRemaining,
  available,
  consume,
  grantPlan,
  grantLifetime,
  grantSingle,
  revokeOrder,
  publicState
};
