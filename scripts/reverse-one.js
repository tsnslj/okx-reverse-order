'use strict';

/**
 * 手动反手单张订单
 *
 *   node scripts/reverse-one.js --instId ETH-USDT-SWAP --ordId 123456
 *   node scripts/reverse-one.js --instId ETH-USDT-SWAP --last
 *   node scripts/reverse-one.js --instId ETH-USDT-SWAP --last --live     ← 真正下单
 *   node scripts/reverse-one.js --instId ETH-USDT-SWAP --last --sim      ← 模拟盘
 *
 * 默认演练（dry-run），不加 --live 不会下任何单。
 */

const { reverseOrder } = require('../src/core/reverse');
const { getOrdersHistory } = require('../src/okx/trade');
const guard = require('../src/core/guard');

function parseArgs(argv) {
  const out = { live: false, sim: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--sim') out.sim = true;
    else if (a === '--last') out.last = true;
    else if (a === '--instId') out.instId = argv[++i];
    else if (a === '--ordId') out.ordId = argv[++i];
    else if (a === '--clOrdId') out.clOrdId = argv[++i];
    else if (a === '--maxNotional') out.maxNotional = Number(argv[++i]);
  }
  return out;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  if (!args.instId) {
    console.error('缺少 --instId，例如 --instId ETH-USDT-SWAP');
    process.exit(1);
  }

  const opts = { simulated: args.sim };
  const dryRun = !args.live;

  console.log('');
  console.log('════════════════════════════════════════');
  console.log(`  反手执行  ${args.instId}`);
  console.log(`  模式: ${args.sim ? '模拟盘' : '实盘'} / ${dryRun ? '演练（不下单）' : '★ 真实下单'}`);
  console.log(`  今日已反手: ${guard.getTodayCount()} 次`);
  console.log('════════════════════════════════════════');

  let ordId = args.ordId;
  let clOrdId = args.clOrdId;

  if (args.last && !ordId && !clOrdId) {
    const hist = await getOrdersHistory({ instType: 'SWAP', instId: args.instId, limit: 20 }, opts);
    const candidate = hist.find((o) => !guard.isOwnOrder(o));
    if (!candidate) {
      console.log('  未找到可反手的订单（最近 20 条全是工具自己下的）');
      process.exit(0);
    }
    ordId = candidate.ordId;
    console.log(`  使用最近一单: ordId=${candidate.ordId} ${candidate.side} ${candidate.sz} ${candidate.ordType} state=${candidate.state}`);
  }

  if (!ordId && !clOrdId) {
    console.error('需要 --ordId / --clOrdId / --last 之一');
    process.exit(1);
  }

  const limits = { ...guard.DEFAULT_LIMITS };
  if (args.maxNotional) limits.maxNotionalUSDT = args.maxNotional;

  try {
    const r = await reverseOrder({
      instId: args.instId,
      ordId,
      clOrdId,
      limits,
      dryRun,
      opts,
    });
    console.log('');
    console.log('  结果:', JSON.stringify(r.ok ? { action: r.action, side: r.side, sz: r.sz, ordId: r.ordId, reason: r.reason } : { skipped: r.skipped, reason: r.reason }));
    console.log('');
  } catch (e) {
    console.error('  执行失败:', e.message);
    process.exit(1);
  }
})();
