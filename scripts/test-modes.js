'use strict';

/**
 * 持仓模式回归测试 —— 桩替换 OKX 接口，只验证「判断」和「下单参数」
 *
 * 为什么必须有这个测试：
 * 方向判断错了不会报错，只会把钱亏掉。long_short_mode 下 pos 永远是正数，
 * 沿用 net_mode 的「靠符号推断」会把空单当多单，平仓单被反手、开仓单被放行。
 *
 *   node scripts/test-modes.js
 */

const path = require('path');
const assert = require('assert');

// ── 桩 ───────────────────────────────────────────────
const state = {
  order: null,
  positions: [],
  calls: [],
};

function stub(modPath, exports) {
  const resolved = require.resolve(modPath);
  require.cache[resolved] = {
    id: resolved,
    filename: resolved,
    loaded: true,
    exports,
  };
}

stub('../src/okx/trade', {
  getOrder: async () => state.order,
  getOrdersPending: async () => [],
  getOrdersHistory: async () => [],
  cancelOrder: async () => {
    throw Object.assign(new Error('该委托类型不可撤'), { sCode: '51403' });
  },
  placeOrder: async (params) => {
    state.calls.push(params);
    return { ordId: 'NEW' + state.calls.length, sCode: '0' };
  },
  closePosition: async () => ({}),
});

stub('../src/okx/account', {
  getPositions: async () => state.positions,
  getConfig: async () => ({ posMode: 'net_mode', isLongShort: false }),
  getBalance: async () => ({}),
});

stub('../src/okx/market', {
  getInstrument: async () => ({ ctVal: '1', lotSz: '0.01', minSz: '0.01' }),
});

// 测试期间别写日志文件
const origLog = require('../src/core/reverse').writeLog;
require('../src/core/reverse').writeLog = () => {};

const { reverseOrder } = require('../src/core/reverse');
const guard = require('../src/core/guard');

// ── 工具 ─────────────────────────────────────────────
const results = [];
async function run(name, { order, positions, posMode, expect }) {
  state.order = order;
  state.positions = positions;
  state.calls = [];

  let r;
  try {
    r = await reverseOrder({
      instId: order.instId,
      ordId: order.ordId,
      posMode,
      dryRun: false,
      opts: {},
    });
  } catch (e) {
    r = { ok: false, error: e.message };
  }

  const action = r.action || (r.skipped ? 'skip:' + r.skipped : 'error');
  const placed = state.calls.map(
    (c) =>
      `${c.side}${c.posSide ? '/' + c.posSide : ''} ${c.sz}${c.reduceOnly ? ' reduceOnly' : ''}`
  );

  let pass = true;
  let detail = '';

  if (expect.action && action !== expect.action) {
    pass = false;
    detail = `期望 action=${expect.action}，实际 ${action}`;
  }
  if (expect.placed) {
    const got = placed.join(' | ');
    const want = expect.placed.join(' | ');
    if (got !== want) {
      pass = false;
      detail = `期望下单 [${want}]，实际 [${got}]`;
    }
  }
  if (expect.reason && !String(r.reason || '').includes(expect.reason)) {
    pass = false;
    detail = `期望原因包含「${expect.reason}」，实际「${r.reason || ''}」`;
  }

  results.push({ name, pass, detail, action, placed });
  console.log(
    `${pass ? '  ✓' : '  ✗'} ${name}` +
      (pass ? '' : `\n      ${detail}`) +
      `\n      实际: ${action}${placed.length ? ' → ' + placed.join(' | ') : ''}`
  );
}

const H = 'long_short_mode';
const N = 'net_mode';

// 通用订单工厂
const mk = (o) => ({
  instId: 'DOGE-USDT-SWAP',
  ordId: 'ORD1',
  ordType: 'market',
  state: 'filled',
  side: 'buy',
  posSide: 'long',
  sz: '1',
  accFillSz: '1',
  avgPx: '0.08',
  tdMode: 'cross',
  ...o,
});

(async () => {
  console.log('\n═══ 双向持仓 long_short_mode ═══');

  // 1. 开多 1 张（原来空仓）→ 反向应开空 1 张
  await run('开多 → 反手开空', {
    order: mk({ side: 'buy', posSide: 'long', accFillSz: '1' }),
    positions: [{ instId: 'DOGE-USDT-SWAP', posSide: 'long', pos: '1' }],
    posMode: H,
    expect: { action: 'reversed', placed: ['sell/long 1 reduceOnly', 'sell/short 1'] },
  });

  // 2. 平多（sell + long）→ 必须放行，不能反手
  await run('平多（sell/long）→ 放行', {
    order: mk({ side: 'sell', posSide: 'long', accFillSz: '1' }),
    positions: [],
    posMode: H,
    expect: { action: 'pass' },
  });

  // 3. 开空（sell + short）→ 反向应开多
  await run('开空 → 反手开多', {
    order: mk({ side: 'sell', posSide: 'short', accFillSz: '1' }),
    positions: [{ instId: 'DOGE-USDT-SWAP', posSide: 'short', pos: '1' }],
    posMode: H,
    expect: { action: 'reversed', placed: ['buy/short 1 reduceOnly', 'buy/long 1'] },
  });

  // 4. 平空（buy + short）→ 放行
  await run('平空（buy/short）→ 放行', {
    order: mk({ side: 'buy', posSide: 'short', accFillSz: '1' }),
    positions: [],
    posMode: H,
    expect: { action: 'pass' },
  });

  // 5. 多空同时存在：平多仍然要放行（老逻辑会因为净持仓为正而判错）
  await run('多空双持时平多 → 放行', {
    order: mk({ side: 'sell', posSide: 'long', accFillSz: '1' }),
    positions: [
      { instId: 'DOGE-USDT-SWAP', posSide: 'long', pos: '0' },
      { instId: 'DOGE-USDT-SWAP', posSide: 'short', pos: '3' },
    ],
    posMode: H,
    expect: { action: 'pass' },
  });

  // 6. 多空双持时开空 → 反手（净持仓为负，老逻辑会误判为减仓）
  await run('多空双持时开空 → 反手', {
    order: mk({ side: 'sell', posSide: 'short', accFillSz: '2' }),
    positions: [
      { instId: 'DOGE-USDT-SWAP', posSide: 'long', pos: '5' },
      { instId: 'DOGE-USDT-SWAP', posSide: 'short', pos: '2' },
    ],
    posMode: H,
    expect: { action: 'reversed', placed: ['buy/short 2 reduceOnly', 'buy/long 2'] },
  });

  // 7. 挂单未成交（限价单被撤）→ 单笔 1 倍反向开
  await run('挂单未成交 → 单笔反向', {
    order: mk({ side: 'buy', posSide: 'long', ordType: 'limit', state: 'live', accFillSz: '0' }),
    positions: [],
    posMode: H,
    expect: { action: 'reversed', placed: ['sell/short 1'] },
  });

  console.log('\n═══ 净持仓 net_mode（回归，不能改坏）═══');

  // 8. 持多 0.11，卖 0.11 平仓 → 放行
  await run('净持仓：平多 → 放行', {
    order: mk({ side: 'sell', posSide: 'net', accFillSz: '0.11', sz: '0.11' }),
    positions: [{ instId: 'DOGE-USDT-SWAP', posSide: 'net', pos: '0' }],
    posMode: N,
    expect: { action: 'pass' },
  });

  // 9. 空仓 buy 1 → 2 倍反向
  await run('净持仓：开多 → sell 2 倍', {
    order: mk({ side: 'buy', posSide: 'net', accFillSz: '1' }),
    positions: [{ instId: 'DOGE-USDT-SWAP', posSide: 'net', pos: '1' }],
    posMode: N,
    expect: { action: 'reversed', placed: ['sell 2'] },
  });

  // 10. 持空 1，买 1 平 → 放行
  await run('净持仓：平空 → 放行', {
    order: mk({ side: 'buy', posSide: 'net', accFillSz: '1' }),
    positions: [{ instId: 'DOGE-USDT-SWAP', posSide: 'net', pos: '0' }],
    posMode: N,
    expect: { action: 'pass' },
  });

  const bad = results.filter((r) => !r.pass);
  console.log(`\n${results.length - bad.length}/${results.length} 通过\n`);
  require('../src/core/reverse').writeLog = origLog;
  process.exit(bad.length ? 1 : 0);
})();
