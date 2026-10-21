'use strict';

const { getOrdersPending, getOrdersHistory } = require('../okx/trade');
const { reverseOrder, log } = require('./reverse');
const guard = require('./guard');

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

  async start() {
    if (this.running) return;
    this.running = true;

    log('监听器启动，加载存量订单…');
    await this.prime();
    log(`开始监听，轮询间隔 ${this.intervalMs}ms`);

    const loop = async () => {
      if (!this.running) return;
      try {
        await this.tick();
      } catch (e) {
        this.stats.errors += 1;
        log(`轮询异常: ${e.message}`);
      }
      if (this.running) {
        this.timer = setTimeout(loop, this.intervalMs);
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
