/**
 * 额度规则（纯函数，不接触数据库）。与小程序端 utils/membership.js 的规则一致：
 * 保存一张无水印海报消耗 1 张，顺序为免费额度 → 单张额度 → 额度包（最早到期的先扣）；邀请码会员不限量。
 */
const DAY = 24 * 60 * 60 * 1000;

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

function newUser(now) {
  return { invite: false, bought: false, freeUsed: 0, singles: 0, packs: [], charged: [], inviteFails: 0, inviteFailsSince: 0, createdAt: now };
}

function activePacks(user, now) {
  return (user.packs || []).map(cleanPack).filter((p) => p.until > now && p.used < p.quota);
}

function freeRemaining(user, freeQuota) {
  return Math.max(0, cleanCount(freeQuota) - cleanCount(user.freeUsed));
}

function available(user, freeQuota, now) {
  if (user.invite) return Infinity;
  const packs = activePacks(user, now).reduce((sum, p) => sum + p.quota - p.used, 0);
  return freeRemaining(user, freeQuota) + cleanCount(user.singles) + packs;
}

// 消耗 n 张，返回新的 { freeUsed, singles, packs }；调用方须先确认 available >= n
function consume(user, n, freeQuota, now) {
  const useFree = Math.min(n, freeRemaining(user, freeQuota));
  const singles = cleanCount(user.singles);
  const useSingles = Math.min(n - useFree, singles);
  let left = n - useFree - useSingles;
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
  return { freeUsed: cleanCount(user.freeUsed) + useFree, singles: singles - useSingles, packs };
}

// 月度 / 年度：新增一包额度（有效期从支付时起算），并清理已过期的包
function grantPlan(user, plan, orderId, now) {
  const pack = { orderId, planId: plan.id, quota: plan.quota, used: 0, until: now + plan.days * DAY };
  return { bought: true, packs: (user.packs || []).map(cleanPack).filter((p) => p.until > now).concat(pack) };
}

function grantSingle(user, single) {
  return { singles: cleanCount(user.singles) + single.quota };
}

// 返回给小程序的权益快照：不含 charged 等内部字段
function publicState(user, now) {
  return {
    invite: !!user.invite,
    bought: !!user.bought,
    freeUsed: cleanCount(user.freeUsed),
    singles: cleanCount(user.singles),
    packs: (user.packs || []).map(cleanPack).filter((p) => p.until > now).map((p) => ({ planId: p.planId, quota: p.quota, used: p.used, until: p.until }))
  };
}

module.exports = { DAY, cleanCount, newUser, activePacks, freeRemaining, available, consume, grantPlan, grantSingle, publicState };
