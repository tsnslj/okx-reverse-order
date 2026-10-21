'use strict';

/**
 * 开发期自测：验证监听器遇到致命错误会停机、遇到网络错误会退避。
 * 用桩替换 trade 模块，不发任何真实请求。
 *
 *   node scripts/dev-test-guard.js fatal     白名单错误 → 应打印说明并 exit 2
 *   node scripts/dev-test-guard.js transient 网络错误  → 应只打一次日志并退避
 */

const path = require('path');

const tradePath = require.resolve('../src/okx/trade');
const mode = process.argv[2] || 'fatal';

let historyCalls = 0;

const stub = {
  getOrdersPending: async () => [],
  getOrdersHistory: async () => {
    historyCalls += 1;
    if (mode === 'fatal') {
      if (historyCalls === 1) return []; // prime 成功
      const e = new Error(
        "[50110] Your IP 203.10.99.10 is not included in your API key's a521867c-895b IP whitelist."
      );
      e.code = '50110';
      throw e;
    }
    if (mode === 'netloop') {
      if (historyCalls === 1) return []; // prime 成功，之后轮询全部失败
      throw new Error('请求超时（20000ms）');
    }
    // transient：模拟网络抖动，永远失败
    throw new Error('Client network socket disconnected before secure TLS connection was established');
  },
  getOrder: async () => ({}),
  cancelOrder: async () => ({}),
  placeOrder: async () => ({}),
};

require.cache[tradePath] = {
  id: tradePath,
  filename: tradePath,
  loaded: true,
  exports: stub,
};

const { OrderWatcher } = require('../src/core/watcher');

const w = new OrderWatcher({ dryRun: true, intervalMs: 100 });

const t0 = Date.now();
setTimeout(() => {
  console.log('');
  console.log(`测试结束：跑了 ${((Date.now() - t0) / 1000).toFixed(1)}s`);
  console.log(`  轮询次数 : ${w.stats.ticks}`);
  console.log(`  连续失败 : ${w.failStreak}`);
  console.log(`  仍在运行 : ${w.running}`);
  const expect = mode === 'fatal' ? '应已停机（上面应有说明文字）' : '应仍在运行，但日志只打了一次';
  console.log(`  期望     : ${expect}`);
  process.exit(0);
}, mode === 'fatal' ? 3000 : 15000);

w.start().catch((e) => {
  console.log('异常逃逸到外层（不应该）:', e.message);
  process.exit(1);
});
