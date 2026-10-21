'use strict';

const { get } = require('./client');

/** 合约信息缓存（面值/精度不会频繁变，进程内缓存即可） */
const cache = new Map();

/**
 * 获取永续合约元信息
 * ctVal 是合约面值：ETH-USDT-SWAP 是 0.1 ETH，BTC-USDT-SWAP 是 0.01 BTC
 * 名义价值 = 张数 × ctVal × 价格
 */
async function getInstrument(instId, opts = {}) {
  if (cache.has(instId)) return cache.get(instId);

  const r = await get(
    `/api/v5/public/instruments?instType=SWAP&instId=${encodeURIComponent(instId)}`,
    opts
  );
  const d = (r.data || [])[0];
  if (!d) throw new Error(`未找到合约: ${instId}`);

  const info = {
    instId: d.instId,
    ctVal: Number(d.ctVal),
    ctValCcy: d.ctValCcy,
    lotSz: Number(d.lotSz),
    minSz: Number(d.minSz),
    ctType: d.ctType,
    settleCcy: d.settleCcy,
  };
  cache.set(instId, info);
  return info;
}

function clearInstrumentCache() {
  cache.clear();
}

module.exports = { getInstrument, clearInstrumentCache };
