'use strict';

const fs = require('fs');
const path = require('path');

const { getPositions } = require('../okx/account');
const { getOrder, cancelOrder, placeOrder } = require('../okx/trade');
const { getInstrument } = require('../okx/market');
const guard = require('./guard');

const LOG_DIR = path.join(__dirname, '..', '..', 'logs');

function writeLog(entry) {
  try {
    if (!fs.existsSync(LOG_DIR)) fs.mkdirSync(LOG_DIR, { recursive: true });
    const file = path.join(LOG_DIR, `${new Date().toISOString().slice(0, 10)}.log`);
    fs.appendFileSync(file, JSON.stringify(entry) + '\n');
  } catch {
    /* 日志失败不影响主流程 */
  }
}

function log(msg, extra) {
  const ts = new Date().toISOString().slice(11, 23);
  console.log(`  [${ts}] ${msg}${extra ? ' ' + JSON.stringify(extra) : ''}`);
}

/** 轮询订单直到终态（应对 51410 撤单在途） */
async function waitFinalState({ instId, ordId }, maxTries = 6, gapMs = 400, opts = {}) {
  for (let i = 0; i < maxTries; i++) {
    const o = await getOrder({ instId, ordId }, opts);
    if (!o) return null;
    if (['filled', 'canceled', 'mmp_canceled'].includes(o.state)) return o;
    await new Promise((r) => setTimeout(r, gapMs));
  }
  return getOrder({ instId, ordId }, opts);
}

/**
 * 反手一张订单
 *
 * 语义（对齐用户需求）：
 *  - 限价单未成交 → 撤掉 → 反向下单 1:1
 *  - 已成交/市价单 → 平掉已成交量 → 反向开等量 → 等于净持仓翻转
 *
 * @param {object} p
 * @param {string} p.instId
 * @param {string} [p.ordId]
 * @param {string} [p.clOrdId]
 * @param {object} [p.limits]
 * @param {boolean} [p.dryRun]  true 时只算不下单
 * @param {object} [p.opts]     透传给 client（如 {simulated:true}）
 */
async function reverseOrder({ instId, ordId, clOrdId, limits = guard.DEFAULT_LIMITS, dryRun = false, opts = {} }) {
  const startedAt = Date.now();

  // ── 1. 取订单 ─────────────────────────────
  const order = await getOrder({ instId, ordId, clOrdId }, opts);
  if (!order) throw new Error(`订单不存在: ${instId} ${ordId || clOrdId}`);

  if (guard.isOwnOrder(order)) {
    return { ok: false, skipped: 'own-order', reason: '这是工具自己下的单，跳过（防循环）', order };
  }

  // ── 2. 闸门 ───────────────────────────────
  const gate = guard.canRun(instId, limits);
  if (!gate.ok) {
    return { ok: false, skipped: 'guard', reason: gate.reason, order };
  }

  guard.lock(instId);
  const trace = {
    at: new Date().toISOString(),
    instId,
    ordId: order.ordId,
    clOrdId: order.clOrdId,
    ordType: order.ordType,
    side: order.side,
    sz: order.sz,
    state: order.state,
    accFillSz: order.accFillSz,
    dryRun,
  };

  try {
    // ── 3. 当前持仓（决定是否放行平仓单） ──
    const positions = await getPositions({ instType: 'SWAP', instId }, opts);
    const posItem = positions.find((p) => p.instId === instId);
    const netPos = posItem ? Number(posItem.pos) : 0;
    trace.netPosAfter = netPos;

    // 轮询有延迟，读到的是「成交后」持仓；反推成交前持仓再判断是否减仓
    const filledNow = Math.abs(Number(order.accFillSz || 0));
    const signedFill = order.side === 'buy' ? filledNow : -filledNow;
    const posBefore = netPos - signedFill;
    trace.posBefore = posBefore;

    // 平仓放行：成交前有仓位且方向相反 → 用户是在平/减仓，不动它
    if (guard.isReducingOrder(order, netPos, filledNow)) {
      trace.result = 'pass-reduce';
      writeLog(trace);
      return {
        ok: true,
        action: 'pass',
        reason: `平仓/减仓放行（成交前持仓 ${posBefore}，订单 ${order.side} ${order.sz}）`,
        order,
      };
    }

    // ── 4. 尝试撤单 ─────────────────────────
    let filled = Number(order.accFillSz || 0);
    let cancelled = false;
    let orderFinal = order;

    if (order.ordType === 'market' || order.state === 'filled') {
      log('市价单/已成交，无法撤单，走「平仓 + 反开」');
    } else if (order.state === 'live' || order.state === 'partially_filled') {
      try {
        await cancelOrder({ instId, ordId: order.ordId }, opts);
        cancelled = true;
        log('撤单成功');
        orderFinal = await waitFinalState({ instId, ordId: order.ordId }, 3, 300, opts) || order;
        filled = Number(orderFinal.accFillSz || filled);
      } catch (e) {
        const sc = String(e.sCode || '');
        if (sc === '51400' || sc === '51405') {
          log(`撤单失败 [${sc}] 订单已成交，改走「平仓 + 反开」`);
          orderFinal = await getOrder({ instId, ordId: order.ordId }, opts) || order;
          filled = Number(orderFinal.accFillSz || filled);
        } else if (sc === '51410') {
          log('撤单在途（51410），等待终态');
          orderFinal = await waitFinalState({ instId, ordId: order.ordId }, 6, 400, opts) || order;
          filled = Number(orderFinal.accFillSz || filled);
          cancelled = orderFinal.state === 'canceled';
        } else if (sc === '51403' || sc === '51413') {
          log(`该委托类型不可撤 [${sc}]，走「平仓 + 反开」`);
        } else {
          throw e;
        }
      }
    } else if (order.state === 'canceled' || order.state === 'mmp_canceled') {
      if (filled <= 0) {
        trace.result = 'already-canceled';
        writeLog(trace);
        return { ok: true, action: 'pass', reason: '订单已撤销且无成交，无需反手', order };
      }
    }

    // ── 5. 计算反向量 ───────────────────────
    // 成交部分需要「先抵消再反开」= 2 倍；未成交部分只需反向下单 = 1 倍
    const reverseSide = order.side === 'buy' ? 'sell' : 'buy';
    let reverseSz;
    if (filled > 0) {
      reverseSz = guard.scaleSz(String(filled), 2);
    } else {
      reverseSz = String(order.sz);
    }

    const refPx =
      Number(order.avgPx) > 0
        ? Number(order.avgPx)
        : Number(order.px) > 0
        ? Number(order.px)
        : 0;

    // 名义价值 = 张数 × 合约面值(ctVal) × 价格
    const inst = await getInstrument(instId, opts);
    trace.ctVal = inst.ctVal;

    if (refPx > 0) {
      const notionalCheck = guard.checkNotional(reverseSz, refPx, inst.ctVal, limits);
      trace.notional = notionalCheck.notional;
      if (!notionalCheck.ok) {
        trace.result = 'blocked-notional';
        trace.reason = notionalCheck.reason;
        writeLog(trace);
        return { ok: false, skipped: 'notional', reason: notionalCheck.reason, order };
      }
    }

    trace.reverseSide = reverseSide;
    trace.reverseSz = reverseSz;
    trace.filled = filled;
    trace.cancelled = cancelled;

    log(
      `→ 反向 ${reverseSide} ${reverseSz} 张` +
        (filled > 0 ? `（成交 ${filled} 张 ×2）` : `（原单 ${order.sz} ×1）`)
    );

    if (dryRun) {
      trace.result = 'dry-run';
      writeLog(trace);
      return {
        ok: true,
        action: 'dry-run',
        reverseSide,
        reverseSz,
        reason: '演练模式，未真正下单',
        order,
      };
    }

    // ── 6. 下反向单 ─────────────────────────
    const newClOrdId = guard.newClOrdId();
    const placed = await placeOrder(
      {
        instId,
        tdMode: order.tdMode || 'cross',
        side: reverseSide,
        ordType: 'market',
        sz: reverseSz,
        clOrdId: newClOrdId,
      },
      opts
    );

    guard.bumpCounter();

    trace.result = 'placed';
    trace.placedOrdId = placed.ordId;
    trace.placedClOrdId = newClOrdId;
    trace.costMs = Date.now() - startedAt;
    writeLog(trace);

    log(`✓ 已下反向单 ordId=${placed.ordId}，耗时 ${Date.now() - startedAt}ms`);

    return {
      ok: true,
      action: 'reversed',
      ordId: placed.ordId,
      clOrdId: newClOrdId,
      side: reverseSide,
      sz: reverseSz,
      cancelled,
      filled,
      order,
    };
  } catch (e) {
    trace.result = 'error';
    trace.error = e.message;
    writeLog(trace);
    throw e;
  } finally {
    guard.unlock(instId, limits);
  }
}

module.exports = { reverseOrder, writeLog, log };
