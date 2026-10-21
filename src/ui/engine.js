'use strict';

const { spawn } = require('child_process');
const path = require('path');

const ROOT = path.join(__dirname, '..', '..');
const ENTRY = path.join(ROOT, 'src', 'start.js');

/**
 * 反手引擎进程管理
 *
 * 图形界面本身只做展示与转发，真正的反手跑在独立子进程里：
 *  - 界面崩了、刷新了，引擎照常工作
 *  - 引擎的 stdout 全量回流到界面，日志和命令行一模一样
 *  - 停止时先礼后兵：先 kill，3 秒还没退就 taskkill /T /F
 */
class Engine {
  constructor({ onLine, onState } = {}) {
    this.child = null;
    this.startedAt = null;
    this.lastArgs = null;
    this.ring = [];
    this.onLine = onLine || (() => {});
    this.onState = onState || (() => {});
    this.buf = { out: '', err: '' };
  }

  get running() {
    return !!(this.child && this.child.exitCode === null && !this.child.killed);
  }

  status() {
    return {
      running: this.running,
      pid: this.child ? this.child.pid : null,
      startedAt: this.startedAt,
      args: this.lastArgs,
      uptimeSec: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
    };
  }

  push(line) {
    this.ring.push(line);
    if (this.ring.length > 800) this.ring.shift();
    try {
      this.onLine(line);
    } catch {
      /* 前端断线不影响引擎 */
    }
  }

  /** 按行切分，避免把半行推给界面 */
  feed(stream, chunk) {
    const key = stream;
    this.buf[key] += chunk.toString('utf8');
    const parts = this.buf[key].split(/\r?\n/);
    this.buf[key] = parts.pop();
    for (const p of parts) {
      if (p.trim() !== '') this.push(p);
    }
  }

  start({ live = true, interval = 1500, instIds = null, maxNotional = null } = {}) {
    if (this.running) return { ok: false, error: '引擎已在运行中' };

    const args = [ENTRY];
    if (live) args.push('--live');
    if (interval) args.push('--interval', String(interval));
    if (instIds && instIds.length) args.push('--instIds', instIds.join(','));
    if (maxNotional) args.push('--maxNotional', String(maxNotional));

    // 图形界面是软加载模式，子进程必须恢复成「缺凭证就报错退出」
    const env = { ...process.env };
    delete env.OKX_ALLOW_EMPTY;

    this.ring = [];
    this.buf = { out: '', err: '' };
    this.push(
      `──── 启动引擎 ${new Date().toLocaleTimeString('zh-CN')} ── ${
        live ? '实盘' : '演练'
      } / 间隔 ${interval}ms / ${instIds && instIds.length ? instIds.join(',') : '全部 U 本位永续'} ────`
    );

    let child;
    try {
      child = spawn(process.execPath, args, {
        cwd: ROOT,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (e) {
      return { ok: false, error: `启动失败: ${e.message}` };
    }

    this.child = child;
    this.startedAt = Date.now();
    this.lastArgs = { live, interval, instIds };

    child.stdout.on('data', (c) => this.feed('out', c));
    child.stderr.on('data', (c) => this.feed('err', c));

    child.on('error', (e) => {
      this.push(`✗ 进程错误: ${e.message}`);
    });

    child.on('exit', (code, signal) => {
      if (this.buf.out.trim()) this.push(this.buf.out.trim());
      if (this.buf.err.trim()) this.push(this.buf.err.trim());
      this.buf = { out: '', err: '' };
      this.push(
        `──── 引擎已退出（code=${code}${signal ? ', signal=' + signal : ''}）${new Date().toLocaleTimeString(
          'zh-CN'
        )} ────`
      );
      this.child = null;
      this.startedAt = null;
      this.onState(this.status());
    });

    this.onState(this.status());
    return { ok: true, pid: child.pid };
  }

  stop() {
    if (!this.running) return { ok: false, error: '引擎没有在运行' };

    const child = this.child;
    const pid = child.pid;
    this.push('正在停止引擎…');

    try {
      child.kill();
    } catch {
      /* ignore */
    }

    // Windows 下 kill 有时打不断，兜底强杀整棵进程树
    const timer = setTimeout(() => {
      if (this.child && this.child.pid === pid) {
        this.push('进程未响应，执行强制结束…');
        try {
          spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
        } catch {
          /* ignore */
        }
      }
    }, 3000);
    if (timer.unref) timer.unref();

    return { ok: true };
  }
}

module.exports = { Engine };
