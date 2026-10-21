'use strict';

const { get } = require('./client');

/**
 * 账户配置 —— 关键是 posMode
 * posMode: long_short_mode(开平仓模式) | net_mode(买卖模式)
 * acctLv: 1现货 2合约 3跨币种保证金 4组合保证金
 */
async function getConfig(opts = {}) {
  const res = await get('/api/v5/account/config', opts);
  const c = res.data && res.data[0];
  if (!c) throw new Error('account/config 返回空数据');
  return {
    uid: c.uid,
    acctLv: c.acctLv,
    posMode: c.posMode,
    acctStpMode: c.acctStpMode,
    isLongShort: c.posMode === 'long_short_mode',
  };
}

/** 持仓 */
async function getPositions({ instType = 'SWAP', instId } = {}, opts = {}) {
  let p = `/api/v5/account/positions?instType=${encodeURIComponent(instType)}`;
  if (instId) p += `&instId=${encodeURIComponent(instId)}`;
  const res = await get(p, opts);
  return res.data || [];
}

/** 账户余额（只看总权益和 USDT） */
async function getBalance(opts = {}) {
  const res = await get('/api/v5/account/balance', opts);
  const d = res.data && res.data[0];
  if (!d) throw new Error('balance 返回空数据');
  const usdt = (d.details || []).find((x) => x.ccy === 'USDT');
  return {
    totalEq: d.totalEq,
    adjEq: d.adjEq,
    usdtAvailBal: usdt ? usdt.availBal : null,
    usdtEq: usdt ? usdt.eq : null,
  };
}

module.exports = { getConfig, getPositions, getBalance };
