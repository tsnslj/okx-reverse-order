'use strict';

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');
const COUNTER_FILE = path.join(DATA_DIR, 'counter.json');

/** 工具自己下的单，clOrdId 一律以此开头 */
const RV_PREFIX = 'RV';

/**
 * 限额配置 —— 按用户要求已全部放开（不做金额/次数/频率限制）
 * 需要收紧时用命令行参数覆盖，例如 --maxNotional 100 --maxPerDay 50
 *
 * 保留项：busy 互斥锁（防同一品种并发反手导致重复下单），这不是风控而是正确性保障
 */
const DEFAULT_LIMITS = {
  maxNotionalUSDT: Infinity, // 单笔名义价值上限：不限制
  maxReversePerDay: Infinity, // 每日反手次数上限：不限制
  cooldownSec: 0, // 同品种冷却：无
};

// ── 运行时状态（进程内） ─────────────────────────────
const busy = new Map(); // instId -> true
const cooldownUntil = new Map(); // instId -> timestamp
const lastActionAt = new Map(); // instId -> timestamp

// ── 工具痕迹 ─────────────────────────────────────────

function newClOrdId() {
  const ts = Date.now().toString(36).slice(-8).toUpperCase();
  const rnd = Math.random().toString(36).slice(2, 4).toUpperCase();
  return (RV_PREFIX + ts + rnd).slice(0, 30);
}

function isOwnOrder(order) {
  if (!order) return false;
  return String(order.clOrdId || '').startsWith(RV_PREFIX);
}

// ── 日计数 ───────────────────────────────────────────

function todayKey() {
  return new Date().toISOString().slice(0, 10);
}

function readCounter() {
  try {
    if (!fs.existsSync(COUNTER_FILE)) return { date: todayKey(), count: 0 };
    const c = JSON.parse(fs.readFileSync(COUNTER_FILE, 'utf8'));
    if (c.date !== todayKey()) return { date: todayKey(), count: 0 };
    return c;
  } catch {
    return { date: todayKey(), count: 0 };
  }
}

function bumpCounter() {
  const c = readCounter();
  c.count += 1;
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  fs.writeFileSync(COUNTER_FILE, JSON.stringify(c, null, 2));
  return c;
}

function getTodayCount() {
  return readCounter().count;
}

// ── 闸门 ─────────────────────────────────────────────

/** 执行前检查，返回 { ok, reason } */
function canRun(instId, limits = DEFAULT_LIMITS) {
  if (busy.get(instId)) {
    return { ok: false, reason: `${instId} 正在反手中，跳过（防并发）` };
  }
  const until = cooldownUntil.get(instId) || 0;
  if (Date.now() < until) {
    const left = Math.ceil((until - Date.now()) / 1000);
    return { ok: false, reason: `${instId} 冷却中，还剩 ${left}s` };
  }
  const c = readCounter();
  if (c.count >= limits.maxReversePerDay) {
    return { ok: false, reason: `已达每日反手上限 ${limits.maxReversePerDay} 次，今日熔断` };
  }
  return { ok: true };
}

function lock(instId) {
  busy.set(instId, true);
}

function unlock(instId, limits = DEFAULT_LIMITS) {
  busy.delete(instId);
  lastActionAt.set(instId, Date.now());
  cooldownUntil.set(instId, Date.now() + limits.cooldownSec * 1000);
}

/**
 * 名义价值校验
 * 名义价值 = 张数 × 合约面值(ctVal) × 价格
 */
function checkNotional(sz, price, ctVal, limits = DEFAULT_LIMITS) {
  const notional = Math.abs(Number(sz) * Number(ctVal) * Number(price));
  if (!Number.isFinite(notional) || notional <= 0) {
    return { ok: false, reason: '无法计算名义价值' };
  }
  if (notional > limits.maxNotionalUSDT) {
    return {
      ok: false,
      reason: `名义价值 ${notional.toFixed(2)} USDT 超过上限 ${limits.maxNotionalUSDT} USDT`,
    };
  }
  return { ok: true, notional };
}

/**
 * 判断一张订单属于「增仓」还是「减仓」
 *
 * 关键：必须用「成交前的持仓」判断，而不是「当前持仓」。
 * 因为轮询有 1.5s+ 延迟，监听到订单时它通常已经成交，当前持仓已是成交后的状态。
 * 反推公式：成交前持仓 = 当前净持仓 - 本单成交量（买为正、卖为负）
 *
 * 例：持多 0.11，卖出 0.11 平仓 → 读到当前持仓 0，成交量 0.11
 *     → 成交前 = 0 - (-0.11) = 0.11 > 0，方向相反 → 判定为减仓，放行 ✓
 *
 * @param {{side:'buy'|'sell'}} order
 * @param {number} netPosNow 当前净持仓（正=多，负=空）
 * @param {number|string} [filled] 本单已成交量
 */
function isReducingOrder(order, netPosNow, filled = 0) {
  const fill = Math.abs(Number(filled) || 0);
  const signedFill = order.side === 'buy' ? fill : -fill;
  const posBefore = (Number(netPosNow) || 0) - signedFill;

  const EPS = 1e-9;
  if (Math.abs(posBefore) < EPS) return false; // 成交前空仓 → 一定是开仓

  const orderDir = order.side === 'buy' ? 1 : -1;
  const posDir = posBefore > 0 ? 1 : -1;
  return orderDir !== posDir; // 方向与成交前持仓相反 = 减仓
}

/** 按原单小数位缩放数量，保证精度合法 */
function scaleSz(sz, factor) {
  const s = String(sz);
  const dot = s.indexOf('.');
  const decimals = dot === -1 ? 0 : s.length - dot - 1;
  return (Number(s) * factor).toFixed(decimals);
}

module.exports = {
  RV_PREFIX,
  DEFAULT_LIMITS,
  newClOrdId,
  isOwnOrder,
  canRun,
  lock,
  unlock,
  checkNotional,
  isReducingOrder,
  scaleSz,
  getTodayCount,
  bumpCounter,
};
