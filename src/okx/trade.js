'use strict';

const { get, post } = require('./client');
const env = require('../env');

/**
 * AI Builder 归因码
 * 直接调用 OpenAPI 时字段名是 tag（不是 aiBuilderCode），长度 1-16 位字母数字
 */
const BUILDER_TAG = env.builderCode;

// OKX 要求 tag 为 1-16 位字母数字，格式不对时不发送，避免整笔订单被拒
const TAG_VALID = /^[A-Za-z0-9]{1,16}$/.test(BUILDER_TAG);
if (BUILDER_TAG && !TAG_VALID) {
  console.warn(`  ⚠ OKX_BUILDER_CODE "${BUILDER_TAG}" 格式非法（需 1-16 位字母数字），已禁用归因`);
}

function withBuilderTag(body) {
  if (!BUILDER_TAG || !TAG_VALID) return body;
  // 已显式指定 tag 时不覆盖
  if (body.tag) return body;
  return { ...body, tag: BUILDER_TAG };
}

/** 挂单列表 */
async function getOrdersPending({ instType = 'SWAP', instId } = {}, opts = {}) {
  let p = `/api/v5/trade/orders-pending?instType=${encodeURIComponent(instType)}&limit=100`;
  if (instId) p += `&instId=${encodeURIComponent(instId)}`;
  const res = await get(p, opts);
  return res.data || [];
}

/** 单笔订单详情（判断真实状态用） */
async function getOrder({ instId, ordId, clOrdId }, opts = {}) {
  let p = `/api/v5/trade/order?instId=${encodeURIComponent(instId)}`;
  if (ordId) p += `&ordId=${encodeURIComponent(ordId)}`;
  else if (clOrdId) p += `&clOrdId=${encodeURIComponent(clOrdId)}`;
  const res = await get(p, opts);
  return (res.data || [])[0] || null;
}

/** 最近订单（含已成交），用于监听新单 */
async function getOrdersHistory({ instType = 'SWAP', instId, limit = 20 } = {}, opts = {}) {
  let p = `/api/v5/trade/orders-history?instType=${encodeURIComponent(instType)}&limit=${limit}`;
  if (instId) p += `&instId=${encodeURIComponent(instId)}`;
  const res = await get(p, opts);
  return res.data || [];
}

/**
 * 下单
 * net_mode（买卖模式）下不要传 posSide
 * 若配置了 AI Builder Code，自动写入 tag 完成归因
 */
async function placeOrder(params, opts = {}) {
  const res = await post('/api/v5/trade/order', withBuilderTag(params), opts);
  const d = (res.data || [])[0];
  if (!d) throw new Error('下单返回空数据');
  if (d.sCode && d.sCode !== '0') {
    const err = new Error(`下单失败 [${d.sCode}] ${d.sMsg || ''}`);
    err.sCode = d.sCode;
    throw err;
  }
  return d;
}

/** 撤单 */
async function cancelOrder({ instId, ordId, clOrdId }, opts = {}) {
  const body = { instId };
  if (ordId) body.ordId = ordId;
  if (clOrdId) body.clOrdId = clOrdId;

  const res = await post('/api/v5/trade/cancel-order', body, opts);
  const d = (res.data || [])[0];
  if (!d) throw new Error('撤单返回空数据');
  if (d.sCode && d.sCode !== '0') {
    const err = new Error(`撤单失败 [${d.sCode}] ${d.sMsg || ''}`);
    err.sCode = d.sCode;
    throw err;
  }
  return d;
}

/** 市价全平 */
async function closePosition({ instId, mgnMode, posSide }, opts = {}) {
  const body = { instId, mgnMode };
  if (posSide) body.posSide = posSide;
  const res = await post('/api/v5/trade/close-position', body, opts);
  const d = (res.data || [])[0];
  if (!d) throw new Error('平仓返回空数据');
  return d;
}

module.exports = {
  getOrdersPending,
  getOrder,
  getOrdersHistory,
  placeOrder,
  cancelOrder,
  closePosition,
};
