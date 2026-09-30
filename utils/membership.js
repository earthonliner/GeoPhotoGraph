/**
 * 会员状态：邀请码 / 时长会员，存储在本地缓存。
 * 单张付费只对当前会话中的那张照片生效，由页面在内存里记录（item.unlocked）。
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

function load(storage) {
  const raw = (storage || defaultStorage()).get(KEY);
  const state = raw && typeof raw === 'object' ? raw : {};
  return { invite: !!state.invite, until: Number(state.until) || 0 };
}

function save(state, storage) {
  (storage || defaultStorage()).set(KEY, { invite: !!state.invite, until: state.until || 0 });
}

function normalizeCode(code) {
  return String(code || '').trim().toLowerCase();
}

function isValidInvite(code, codes) {
  const c = normalizeCode(code);
  return !!c && (codes || config.membership.inviteCodes).some((x) => normalizeCode(x) === c);
}

// 当前是否享有会员权益（邀请码永久有效，时长会员看到期时间）
function isActive(state, now) {
  return !!state.invite || state.until > (now === undefined ? Date.now() : now);
}

// 购买时长会员：在现有到期时间之后顺延
function extend(state, days, now) {
  const t = now === undefined ? Date.now() : now;
  return { invite: state.invite, until: Math.max(state.until, t) + days * DAY };
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
  const t = now === undefined ? Date.now() : now;
  if (state.until > t) return `会员 · ${formatDate(state.until)} 到期`;
  if (state.invite) return '会员 · 邀请码';
  return '免费版 · 开通会员';
}

function formatPrice(cents) {
  const yuan = cents / 100;
  return `¥${Number.isInteger(yuan) ? yuan : yuan.toFixed(2)}`;
}

module.exports = { load, save, isValidInvite, isActive, extend, label, formatPrice, formatDate, normalizeCode, DAY };
