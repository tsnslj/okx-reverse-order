'use strict';

/**
 * P0 体检脚本 —— 全部只读，不会下任何单
 *
 * 用法:
 *   node scripts/p0-check.js          # 实盘 + 模拟盘都查
 *   node scripts/p0-check.js --live   # 只查实盘
 *   node scripts/p0-check.js --sim    # 只查模拟盘
 */

const env = require('../src/env');
const { getConfig, getPositions, getBalance } = require('../src/okx/account');
const { getOrdersPending } = require('../src/okx/trade');

const args = process.argv.slice(2);
const onlyLive = args.includes('--live');
const onlySim = args.includes('--sim');

const ACCT_LV = {
  '1': '现货模式',
  '2': '合约模式',
  '3': '跨币种保证金模式',
  '4': '组合保证金模式',
};

function line(ch = '─', n = 64) {
  return ch.repeat(n);
}

async function probe(label, simulated) {
  const opts = { simulated };
  console.log('\n' + line('═'));
  console.log(`  ${label}   (x-simulated-trading: ${simulated ? '1' : '0'})`);
  console.log(line('═'));

  let cfg;
  try {
    cfg = await getConfig(opts);
  } catch (e) {
    console.log(`  ✗ 连接失败: ${e.message}`);
    return { ok: false, label, simulated, error: e.message };
  }

  console.log(`  ✓ 连接成功`);
  console.log(`  UID            : ${cfg.uid}`);
  console.log(`  账户模式       : ${cfg.acctLv} — ${ACCT_LV[cfg.acctLv] || '未知'}`);
  console.log(`  持仓模式       : ${cfg.posMode} — ${cfg.isLongShort ? '开平仓模式（可锁仓）' : '买卖模式（净持仓）'}`);
  console.log(`  自成交保护     : ${cfg.acctStpMode}`);

  if (cfg.isLongShort) {
    console.log(
      `  ➜ 判定: 等量反向 = 多空同时持有（锁仓）。语义正确。`
    );
  } else {
    console.log(
      `  ➜ 判定: 等量反向 = 平仓归零，拿不到反向持仓。需改账户模式，或工具内部按 2 倍量执行。`
    );
  }

  try {
    const bal = await getBalance(opts);
    console.log(`\n  总权益(totalEq) : ${bal.totalEq}`);
    console.log(`  调整后权益      : ${bal.adjEq}`);
    console.log(`  USDT 可用       : ${bal.usdtAvailBal}`);
  } catch (e) {
    console.log(`  ✗ 余额查询失败: ${e.message}`);
  }

  try {
    const pos = await getPositions({ instType: 'SWAP' }, opts);
    console.log(`\n  当前永续持仓 (${pos.length} 条):`);
    if (pos.length === 0) {
      console.log('    （无持仓）');
    } else {
      for (const p of pos) {
        const upl = Number(p.upl || 0);
        console.log(
          `    ${p.instId.padEnd(20)} ${String(p.posSide).padEnd(6)} 张数=${String(p.pos).padEnd(8)} 均价=${p.avgPx} 未实现=${upl >= 0 ? '+' : ''}${upl}`
        );
      }
    }
  } catch (e) {
    console.log(`  ✗ 持仓查询失败: ${e.message}`);
  }

  try {
    const pending = await getOrdersPending({ instType: 'SWAP' }, opts);
    console.log(`\n  当前永续挂单 (${pending.length} 条):`);
    if (pending.length === 0) {
      console.log('    （无挂单）');
    } else {
      for (const o of pending) {
        console.log(
          `    ${(o.instId || '').padEnd(20)} ${o.side}/${o.posSide} ${o.ordType} 价=${o.px} 量=${o.sz} 已成=${o.accFillSz} state=${o.state}`
        );
      }
    }
  } catch (e) {
    console.log(`  ✗ 挂单查询失败: ${e.message}`);
  }

  return { ok: true, label, simulated, cfg };
}

(async () => {
  console.log('\nOKX 反手工具 · P0 体检（只读，不下单）');
  console.log(`本机时间: ${new Date().toISOString()}`);
  console.log(`基础域名: ${env.baseUrl}`);

  const results = [];
  if (!onlySim) results.push(await probe('【实盘账户】', false));
  if (!onlyLive) results.push(await probe('【模拟盘账户】', true));

  console.log('\n' + line('═'));
  console.log('  汇总');
  console.log(line('═'));
  for (const r of results) {
    console.log(`  ${r.ok ? '✓' : '✗'} ${r.label}  ${r.ok ? '正常' : r.error}`);
  }
  console.log('');
})();
