'use strict';

const { getOrdersPending, getOrdersHistory } = require('../okx/trade');
const { reverseOrder, log } = require('./reverse');
const guard = require('./guard');

/**
 * 致命错误：凭证 / 权限 / 白名单类问题，重试一万次也不会自己好。
 * 遇到就立刻停机并喊人，绝不能继续空转——空转等于「工具开着但其实瞎了」，
 * 用户以为有保护，实际上裸奔。
 */
const FATAL_CODES = new Set([
  '50101', // Key 与实盘/模拟盘环境不匹配
  '50102', // 时间戳过期（本机时间偏差）
  '50103', // 缺 KEY 头
  '50104', // 缺 PASSPHRASE 头
  '50105', // Passphrase 错误
  '50106', // 缺 SIGN 头
  '50107', // 时间戳不在有效期
  '50110', // IP 不在白名单
  '50111', // Key 无效
  '50113', // IP 不在白名单（另一码）
]);

function fatalCode(err) {
  const code = String((err && err.code) || '');
  return FATAL_CODES.has(code) ? code : null;
}

/** 从 OKX 的报错里挖出它看到的那个 IP —— 用户拿这个去填白名单 */
function extractIp(msg) {
  const m = /Your IP\s+([0-9]{1,3}(?:\.[0-9]{1,3}){3})/i.exec(String(msg || ''));
  return m ? m[1] : null;
}

/**
 * 订单监听器
 *
 * 轮询策略：每 intervalMs 拉一次 orders-pending + orders-history，
 * 用 ordId 集合做差分，识别「启动之后新出现的单」。
 *
 * 防循环：
 *  1. 启动时把已有订单全部记入 known，避免把历史单当新单
 *  2. clOrdId 以 RV 开头的单直接跳过
 *  3. reverseOrder 内部还有水位锁 + 冷却期
 */
class OrderWatcher {
  constructor({
    instIds = null, // null = 监听所有 SWAP
    intervalMs = 1500,
    limits = guard.DEFAULT_LIMITS,
    dryRun = false,
    opts = {},
    onEvent = null,
  } = {}) {
    this.instIds = instIds;
    this.intervalMs = intervalMs;
    this.limits = limits;
    this.dryRun = dryRun;
    this.opts = opts;
    this.onEvent = onEvent;

    this.known = new Set();
    this.running = false;
    this.timer = null;
    this.stats = { ticks: 0, detected: 0, reversed: 0, skipped: 0, errors: 0 };
    this.failStreak = 0; // 连续失败次数，用于退避
    this.startAt = null; // 启动时间，用于心跳
    this.lastBeatAt = 0;
  }

  emit(type, payload) {
    if (typeof this.onEvent === 'function') {
      try {
        this.onEvent({ type, at: new Date().toISOString(), ...payload });
      } catch {
        /* 回调异常不影响主循环 */
      }
    }
  }

  /** 启动时把存量订单全部标记为已知 */
  async prime() {
    const [pending, history] = await Promise.all([
      getOrdersPending({ instType: 'SWAP' }, this.opts),
      getOrdersHistory({ instType: 'SWAP', limit: 50 }, this.opts),
    ]);
    for (const o of [...pending, ...history]) {
      this.known.add(o.ordId);
    }
    log(`已加载存量订单 ${this.known.size} 张（这些不会被反手）`);
  }

  async tick() {
    this.stats.ticks += 1;

    const [pending, history] = await Promise.all([
      getOrdersPending({ instType: 'SWAP' }, this.opts),
      getOrdersHistory({ instType: 'SWAP', limit: 20 }, this.opts),
    ]);

    // 新单 = 出现在列表里但不在 known 集合中
    const fresh = [];
    for (const o of [...pending, ...history]) {
      if (!o || !o.ordId) continue;
      if (this.known.has(o.ordId)) continue;
      this.known.add(o.ordId);
      fresh.push(o);
    }

    // 控制 known 体积，避免长期运行内存膨胀
    if (this.known.size > 2000) {
      const arr = Array.from(this.known).slice(-1000);
      this.known = new Set(arr);
    }

    for (const o of fresh) {
      // 只处理配置范围内的品种
      if (this.instIds && this.instIds.length > 0 && !this.instIds.includes(o.instId)) {
        continue;
      }
      // 工具自己下的单，跳过
      if (guard.isOwnOrder(o)) {
        log(`跳过工具自身订单 ${o.ordId}（clOrdId=${o.clOrdId}）`);
        continue;
      }

      this.stats.detected += 1;
      log(`🔔 发现新订单 ${o.instId} ${o.side} ${o.sz} ${o.ordType} state=${o.state}`);
      this.emit('order-detected', { order: o });

      const gate = guard.canRun(o.instId, this.limits);
      if (!gate.ok) {
        this.stats.skipped += 1;
        log(`  闸门拦截: ${gate.reason}`);
        this.emit('skipped', { order: o, reason: gate.reason });
        continue;
      }

      try {
        const r = await reverseOrder({
          instId: o.instId,
          ordId: o.ordId,
          limits: this.limits,
          dryRun: this.dryRun,
          opts: this.opts,
        });

        if (r.ok && r.action === 'reversed') {
          this.stats.reversed += 1;
          log(`  ✓ 反手完成 ${o.instId} → ${r.side} ${r.sz} 张`);
        } else if (r.ok && r.action === 'pass') {
          this.stats.skipped += 1;
          log(`  ↷ 放行：${r.reason}`);
        } else if (r.ok) {
          this.stats.skipped += 1;
          log(`  ↷ 跳过：${r.reason || r.action}`);
        } else {
          this.stats.skipped += 1;
          log(`  ↷ 跳过：${r.reason || r.skipped}`);
        }
        this.emit('reversed', { order: o, result: r });
      } catch (e) {
        this.stats.errors += 1;
        log(`  ✗ 反手失败: ${e.message}`);
        this.emit('error', { order: o, error: e.message });
      }
    }
  }

  /** 致命错误：打一段清楚的说明，然后停机。继续空转只会假装在工作。 */
  die(err, code) {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    const ip = extractIp(err.message);
    const title =
      code === '50110' || code === '50113'
        ? 'IP 不在 API Key 白名单内 —— 工具无法连接'
        : '凭证验证失败 —— 工具无法连接';

    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  ✗ 已停止运行：${title}`);
    console.log('════════════════════════════════════════════════════════');
    console.log(`  OKX 返回：${err.message}`);
    if (ip) {
      console.log('');
      console.log(`  ★ OKX 看到你的出口 IP 是：${ip}`);
      console.log('    这个 IP 和你填在白名单里的不一样，所以被拒了。');
    }
    console.log('');
    console.log('  怎么修：');
    console.log('    1. 打开 https://www.okx.com/account/my-api');
    console.log('    2. 编辑这把 Key 的 IP 地址，把上面那个 IP 加进去');
    console.log('       （出口 IP 会变：家宽重新拨号会变，走代理时换节点也会变）');
    console.log('    3. 改完重新启动本工具');
    console.log('');
    console.log(`  在你修好之前，工具不会反手任何订单。`);
    console.log(`  本次运行：轮询 ${this.stats.ticks} 次，反手 ${this.stats.reversed} 次`);
    console.log('════════════════════════════════════════════════════════');
    console.log('');

    this.emit('fatal', { code, error: err.message, ip });
    process.exit(2);
  }

  /** 网络通道整个不通：重试几分钟也没用，停机说清楚，别空转 */
  dieProxy(err) {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;

    console.log('');
    console.log('════════════════════════════════════════════════════════');
    console.log('  ✗ 已停止运行：网络通道不通，连不上 OKX');
    console.log('════════════════════════════════════════════════════════');
    console.log(`  ${err.message}`);
    console.log('');
    console.log('  直连通道和代理都不通。');
    console.log('');
    console.log('  怎么修：');
    console.log('    1. 先确认这台电脑能正常打开网页');
    console.log('    2. 回到控制台，设置里的「网络通道」选「自动」，再点「重新检测」');
    console.log('    3. 如果所在网络封了境外服务器，填一个代理地址再启动');
    console.log('');
    console.log('  在你修好之前，工具不会反手任何订单。');
    console.log('════════════════════════════════════════════════════════');
    console.log('');

    this.emit('fatal', { code: 'PROXY_DOWN', error: err.message });
    process.exit(4);
  }

  async start() {
    if (this.running) return;
    this.running = true;
    this.startAt = Date.now();
    this.lastBeatAt = Date.now();

    log('监听器启动，加载存量订单…');
    // prime 必须成功：拿不到存量订单就没有基线，贸然开跑会把历史单全当新单反手一遍
    let primed = false;
    for (let attempt = 1; attempt <= 6 && !primed; attempt++) {
      try {
        await this.prime();
        primed = true;
      } catch (e) {
        const code = fatalCode(e);
        if (code) return this.die(e, code);
        if (/代理未启动|ECONNREFUSED/i.test(e.message)) return this.dieProxy(e);
        if (attempt === 6) {
          this.running = false;
          console.log('');
          console.log('════════════════════════════════════════════════════════');
          console.log('  ✗ 启动失败：拿不到账户订单，无法建立基线');
          console.log('════════════════════════════════════════════════════════');
          console.log(`  最后一次错误：${e.message}`);
          console.log('');
          console.log('  常见原因：');
          console.log('    · 本机网络断开');
          console.log('    · 当前网络封了境外服务器（直连和代理都不通）');
          console.log('    · OKX 正在维护');
          console.log('');
          console.log('  修好网络后重新启动即可，本次没有下任何单。');
          console.log('════════════════════════════════════════════════════════');
          console.log('');
          process.exit(3);
        }
        const wait = Math.min(3000 * attempt, 12000);
        log(`加载订单失败（第 ${attempt}/6 次）：${e.message}，${wait / 1000}s 后重试…`);
        await new Promise((r) => setTimeout(r, wait));
      }
    }
    log(`开始监听，轮询间隔 ${this.intervalMs}ms`);

    const loop = async () => {
      if (!this.running) return;
      let delay = this.intervalMs;

      try {
        await this.tick();
        if (this.failStreak > 0) {
          log(`连接已恢复（之前连续失败 ${this.failStreak} 次）`);
        }
        this.failStreak = 0;
        this.lastOkAt = Date.now();
      } catch (e) {
        // 凭证类问题：立刻停机，不要刷屏
        const code = fatalCode(e);
        if (code) return this.die(e, code);

        // 网络通道整个不通：不会自己好，停机说清楚，别在这里空转
        if (/代理未启动|ECONNREFUSED/i.test(e.message)) return this.dieProxy(e);

        // 网络类问题：指数退避，且只在关键节点打印，避免一个小时刷 7 万字
        this.failStreak += 1;
        this.stats.errors += 1;
        if (this.failStreak === 1) {
          log(`轮询异常: ${e.message}`);
          log('  网络或代理节点问题，正在自动重试（连续失败会降低重试频率）…');
        } else if (this.failStreak % 20 === 0) {
          const downMin = Math.round((Date.now() - (this.lastOkAt || this.startAt)) / 60000);
          log(`  ⚠ 仍无连接，已连续失败 ${this.failStreak} 次（断开约 ${downMin} 分钟）—— 这段时间不会反手任何单`);
        }
        delay = Math.min(this.intervalMs * Math.min(this.failStreak, 10), 15000);
      }

      // 心跳：每 5 分钟说一句「我还活着」，否则用户根本看不出工具是不是在工作
      if (Date.now() - this.lastBeatAt > 5 * 60 * 1000) {
        const mins = Math.round((Date.now() - this.startAt) / 60000);
        const s = this.stats;
        const state = this.failStreak > 0 ? `⚠ 无连接（连续失败 ${this.failStreak} 次）` : '正常';
        log(
          `♥ 在线 ${mins} 分钟 · ${state} · 轮询 ${s.ticks} 次 · 发现新单 ${s.detected} · 已反手 ${s.reversed} · 放行 ${s.skipped}`
        );
        this.lastBeatAt = Date.now();
      }

      if (this.running) {
        this.timer = setTimeout(loop, delay);
      }
    };
    await loop();
  }

  stop() {
    this.running = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    log('监听器已停止');
  }
}

module.exports = { OrderWatcher };
