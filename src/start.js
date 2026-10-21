'use strict';

/**
 * 主程序 —— 常开全自动反手
 *
 *   node src/start.js              演练模式（只检测，不下单）
 *   node src/start.js --live       真实执行
 *   node src/start.js --live --instIds ETH-USDT-SWAP,BTC-USDT-SWAP
 *   node src/start.js --live --interval 1200 --maxNotional 30
 *
 * 关闭工具 = Ctrl+C，此时不再反手。
 */

const env = require('./env');
const { OrderWatcher } = require('./core/watcher');
const guard = require('./core/guard');
const { log } = require('./core/reverse');

function parseArgs(argv) {
  const out = { live: false, instIds: null, interval: 1500 };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--live') out.live = true;
    else if (a === '--sim') out.sim = true;
    else if (a === '--instIds') out.instIds = String(argv[++i] || '').split(',').map((s) => s.trim()).filter(Boolean);
    else if (a === '--interval') out.interval = Number(argv[++i]);
    else if (a === '--maxNotional') out.maxNotional = Number(argv[++i]);
    else if (a === '--maxPerDay') out.maxPerDay = Number(argv[++i]);
  }
  return out;
}

/** 无穷大显示为「不限」 */
function fmtLimit(v, unit) {
  return v === Infinity || !Number.isFinite(v) ? '不限' : `${v}${unit}`;
}

(async () => {
  const args = parseArgs(process.argv.slice(2));

  const limits = { ...guard.DEFAULT_LIMITS };
  if (args.maxNotional) limits.maxNotionalUSDT = args.maxNotional;
  if (args.maxPerDay) limits.maxReversePerDay = args.maxPerDay;

  const dryRun = !args.live;

  console.log('');
  console.log('════════════════════════════════════════════════════');
  console.log('   OKX 反手工具 · 常开监听');
  console.log('════════════════════════════════════════════════════');
  console.log(`  模式        : ${args.sim ? '模拟盘' : '实盘'} / ${dryRun ? '演练（不下单）' : '★ 真实执行'}`);
  console.log(`  监听品种    : ${args.instIds ? args.instIds.join(', ') : '全部 U 本位永续'}`);
  console.log(`  轮询间隔    : ${args.interval}ms`);
  console.log(`  单笔名义上限: ${fmtLimit(limits.maxNotionalUSDT, ' USDT')}`);
  console.log(`  每日上限    : ${fmtLimit(limits.maxReversePerDay, ' 次')}（今日已用 ${guard.getTodayCount()} 次）`);
  console.log(`  冷却期      : ${limits.cooldownSec ? limits.cooldownSec + 's' : '无'}`);
  const code = env.builderCode;
  console.log(`  AI Builder  : ${code ? code + '（已写入下单 tag）' : '⚠ 未配置 OKX_BUILDER_CODE，本次交易无归因'}`);
  console.log('════════════════════════════════════════════════════');
  if (dryRun) {
    console.log('  ⚠ 当前为演练模式：只检测、不下单');
    console.log('    确认无误后加 --live 才会真正反手');
  } else {
    console.log('  ⚠ 真实执行模式：检测到你下单后会立即反手');
    console.log('    按 Ctrl+C 停止');
  }
  console.log('');

  const watcher = new OrderWatcher({
    instIds: args.instIds,
    intervalMs: args.interval,
    limits,
    dryRun,
    opts: { simulated: !!args.sim },
    onEvent: (e) => {
      if (e.type === 'error') {
        console.log(`  [事件] 错误: ${e.error}`);
      }
    },
  });

  process.on('SIGINT', () => {
    console.log('');
    log('收到 Ctrl+C，正在停止…');
    watcher.stop();
    const s = watcher.stats;
    console.log('');
    console.log('  本次运行统计:');
    console.log(`    轮询次数: ${s.ticks}`);
    console.log(`    发现新单: ${s.detected}`);
    console.log(`    执行反手: ${s.reversed}`);
    console.log(`    跳过    : ${s.skipped}`);
    console.log(`    错误    : ${s.errors}`);
    console.log('');
    process.exit(0);
  });

  await watcher.start();
})();
