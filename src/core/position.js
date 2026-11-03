'use strict';

/**
 * 持仓模式适配层
 *
 * OKX 有两种合约持仓模式，语义完全不同，混淆会直接导致「多单当空单」这种事故：
 *
 *   net_mode（买卖模式）
 *     一个合约只有一个净持仓，买卖互相抵消。
 *     pos 带符号：+1 是多 1 张，-1 是空 1 张。
 *     1:1 反向 = 平仓归零，想翻仓必须 2 倍量。
 *
 *   long_short_mode（开平仓 / 双向持仓）
 *     多头和空头分开记账，可以同时存在。
 *     pos 永远是正数（该方向的张数），方向在 posSide 里：'long' | 'short'。
 *     平多 = sell + posSide=long；开空 = sell + posSide=short。
 *
 * 所以任何「靠 pos 的正负判断方向」的代码，在 long_short_mode 下必然出错：
 * 空单的 pos 也是正数，会被当成多单。
 */

const HEDGE = 'long_short_mode';

function isHedge(posMode) {
  return posMode === HEDGE;
}

/**
 * 计算某合约的「带符号净持仓」
 * @param {Array} positions /account/positions 返回的数组
 * @param {string} instId
 * @param {string} posMode
 * @returns {number} 正=净多，负=净空（张数）
 */
function signedNet(positions, instId, posMode) {
  const rows = (positions || []).filter((p) => p && p.instId === instId);
  if (!rows.length) return 0;

  if (!isHedge(posMode)) {
    // net_mode：只有一条，pos 自带符号
    return Number(rows[0].pos) || 0;
  }

  let net = 0;
  for (const p of rows) {
    const q = Math.abs(Number(p.pos) || 0);
    if (p.posSide === 'short') net -= q;
    else if (p.posSide === 'long') net += q;
    else net += Number(p.pos) || 0; // posSide 缺失时按带符号处理
  }
  return net;
}

/**
 * 取订单的方向归属
 * long_short_mode 的订单一定带 posSide；net_mode 是 'net' 或不返回
 * @returns {'long'|'short'|null}
 */
function orderPosSide(order) {
  const ps = order && order.posSide;
  if (ps === 'long' || ps === 'short') return ps;
  return null;
}

/**
 * 这张单是不是在减仓（平仓）
 *
 * long_short_mode 下不需要任何推断，看 (side, posSide) 组合即可：
 *   sell + long  → 平多
 *   buy  + short → 平空
 * 其余组合都是开仓/加仓。
 *
 * @param {{side:string, posSide?:string}} order
 * @param {string} posMode
 * @returns {boolean|null} null = 无法判断（交给调用方用净持仓推断兜底）
 */
function isReducingByPosSide(order, posMode) {
  if (!isHedge(posMode)) return null;
  const ps = orderPosSide(order);
  if (!ps) return null;
  if (ps === 'long') return order.side === 'sell';
  return order.side === 'buy'; // short
}

/** 方向 → 开仓该方向需要的 side */
function sideOfPosSide(posSide) {
  return posSide === 'long' ? 'buy' : 'sell';
}

/** 反方向 */
function flipPosSide(posSide) {
  return posSide === 'long' ? 'short' : 'long';
}

/**
 * 生成「平掉这笔成交」的下单参数（仅 long_short_mode 用）
 * @param {{side:string, posSide?:string}} order
 */
function closeParamsOf(order) {
  const ps = orderPosSide(order) || (order.side === 'buy' ? 'long' : 'short');
  return { side: ps === 'long' ? 'sell' : 'buy', posSide: ps, reduceOnly: true };
}

/**
 * 生成「反向开仓」的下单参数
 * @param {{side:string, posSide?:string}} order
 * @param {string} posMode
 * @param {number|string} sz
 */
function reverseParamsOf(order, posMode, sz) {
  if (!isHedge(posMode)) {
    return { side: order.side === 'buy' ? 'sell' : 'buy', sz };
  }
  const ps = orderPosSide(order) || (order.side === 'buy' ? 'long' : 'short');
  const target = flipPosSide(ps);
  return { side: sideOfPosSide(target), posSide: target, sz };
}

module.exports = {
  HEDGE,
  isHedge,
  signedNet,
  orderPosSide,
  isReducingByPosSide,
  sideOfPosSide,
  flipPosSide,
  closeParamsOf,
  reverseParamsOf,
};
