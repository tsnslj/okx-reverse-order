'use strict';

/**
 * 图形界面服务
 *
 * 只监听 127.0.0.1，不对外暴露。双击「启动.bat」会自动打开浏览器。
 *
 *   node src/ui/server.js              正常启动并自动开浏览器
 *   node src/ui/server.js --no-open    只起服务
 *   node src/ui/server.js --port 9000  指定端口
 */

// 必须放在任何业务模块 require 之前：允许在还没填凭证的情况下启动界面
process.env.OKX_ALLOW_EMPTY = '1';

const http = require('http');
const fs = require('fs');
const path = require('path');
const net = require('net');
const { spawn } = require('child_process');

const env = require('../env');
const { resetPool, currentProxy } = require('../okx/client');
const { getConfig, getPositions, getBalance } = require('../okx/account');
const { getOrdersPending } = require('../okx/trade');
const { detectBoth } = require('../net/ipcheck');
const guard = require('../core/guard');
const { Engine } = require('./engine');

const ROOT = path.join(__dirname, '..', '..');
const PAGE = path.join(__dirname, 'page.html');

const argv = process.argv.slice(2);
const hasFlag = (f) => argv.includes(f);
const argOf = (f, d) => {
  const i = argv.indexOf(f);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : d;
};

// ─────────────────────────── 引擎 + 事件广播 ───────────────────────────

const clients = new Set();

function broadcast(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of clients) {
    try {
      res.write(payload);
    } catch {
      clients.delete(res);
    }
  }
}

const engine = new Engine({
  onLine: (line) => broadcast('log', { line, at: Date.now() }),
  onState: (s) => broadcast('state', s),
});

// ─────────────────────────── 工具函数 ───────────────────────────

function mask(s) {
  if (!s) return '';
  if (s.length <= 8) return s[0] + '***';
  return `${s.slice(0, 6)}…${s.slice(-4)}`;
}

function configView() {
  return {
    apiKeyMasked: mask(env.apiKey),
    hasApiKey: !!env.apiKey,
    hasSecret: !!env.secretKey,
    hasPassphrase: !!env.passphrase,
    baseUrl: env.baseUrl,
    proxy: env.proxy,
    simulated: env.simulated,
    builderCode: env.builderCode,
    missing: env.missing,
    envFile: env.envFile,
  };
}

function json(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (c) => {
      data += c;
      if (data.length > 1e6) {
        reject(new Error('请求体过大'));
        req.destroy();
      }
    });
    req.on('end', () => {
      if (!data) return resolve({});
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('请求体不是合法 JSON'));
      }
    });
    req.on('error', reject);
  });
}

// ─────────────────────── 诊断：代理状态 + 报错翻译 ───────────────────────

/** 探测本机代理端口是否真的在监听（Clash 关了这是最常见的故障） */
function checkProxy() {
  const px = currentProxy();
  if (!px) return Promise.resolve({ configured: false, alive: false, host: '', port: 0 });
  return new Promise((resolve) => {
    const s = net.connect({ host: px.host, port: px.port });
    let done = false;
    const finish = (alive) => {
      if (done) return;
      done = true;
      try { s.destroy(); } catch {}
      resolve({ configured: true, alive, host: px.host, port: px.port });
    };
    s.setTimeout(1500);
    s.once('connect', () => finish(true));
    s.once('timeout', () => finish(false));
    s.once('error', () => finish(false));
  });
}

/**
 * 把技术报错翻译成「用户下一步该做什么」。
 * 图形界面里直接抛 ECONNREFUSED 等于什么都没说。
 */
function explainError(msg, proxyState) {
  const m = String(msg || '');

  if (/ECONNREFUSED/i.test(m)) {
    if (proxyState && proxyState.configured) {
      return {
        kind: 'proxy-down',
        hint: `代理没开：${proxyState.host}:${proxyState.port} 拒绝连接。先把 Clash 打开（确认端口是这个），然后点「重新检测」。`,
      };
    }
    return { kind: 'net', hint: '连接被拒绝，目标端口不通。检查代理地址是否填错。' };
  }

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
    return {
      kind: 'dns',
      hint: 'OKX 域名解析失败（国内网络会被污染）。必须配置代理，地址形如 http://127.0.0.1:7897。',
    };
  }

  const ipHit = m.match(/Your IP\s+(\d{1,3}(?:\.\d{1,3}){3})[^]*?whitelist/i);
  if (/50110/.test(m) || ipHit) {
    return {
      kind: 'whitelist',
      ip: ipHit ? ipHit[1] : '',
      hint: ipHit
        ? `IP 不在白名单：OKX 看到你的出口 IP 是 ${ipHit[1]}。去 OKX → 账户 → API 编辑这把 Key，把该 IP 加进去。`
        : 'IP 不在白名单：去 OKX → 账户 → API 编辑这把 Key，把当前出口 IP 加进去。',
    };
  }

  if (/50101/.test(m)) {
    return {
      kind: 'env-mismatch',
      hint: '这把 Key 和当前环境不匹配：模拟盘专用 Key 不能用于实盘，实盘 Key 也不能用于模拟盘。',
    };
  }

  if (/50113/.test(m) || /Invalid Sign/i.test(m)) {
    return { kind: 'sign', hint: '签名校验失败：Secret Key 或 Passphrase 填错了，检查后重新保存。' };
  }

  if (/请求超时|timeout|ETIMEDOUT|socket hang up/i.test(m)) {
    return { kind: 'timeout', hint: '请求超时：代理节点可能不通，换一个节点或稍后重试。' };
  }

  return { kind: 'unknown', hint: '' };
}

// ─────────────────────────── 路由 ───────────────────────────

async function handle(req, res) {
  const url = new URL(req.url, 'http://127.0.0.1');
  const p = url.pathname;

  if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
    const html = fs.readFileSync(PAGE);
    res.writeHead(200, {
      'Content-Type': 'text/html; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    return res.end(html);
  }

  if (req.method === 'GET' && p === '/api/bootstrap') {
    return json(res, 200, {
      config: configView(),
      engine: engine.status(),
      todayCount: guard.getTodayCount(),
      node: process.version,
      proxy: await checkProxy(),
      logs: engine.ring.slice(-200),
    });
  }

  // ---- 代理连通性（单独探测，供「重新检测」按钮用）----
  if (req.method === 'GET' && p === '/api/proxy') {
    return json(res, 200, await checkProxy());
  }

  // ---- 保存配置 ----
  if (req.method === 'POST' && p === '/api/config') {
    const b = await readBody(req);
    const patch = {};

    if (typeof b.apiKey === 'string' && b.apiKey.trim() && !b.apiKey.includes('…')) {
      patch.OKX_API_KEY = b.apiKey.trim();
    }
    if (typeof b.secretKey === 'string' && b.secretKey.trim()) {
      patch.OKX_SECRET_KEY = b.secretKey.trim();
    }
    if (typeof b.passphrase === 'string' && b.passphrase !== '') {
      patch.OKX_PASSPHRASE = b.passphrase;
    }
    if (typeof b.proxy === 'string') {
      const v = b.proxy.trim();
      if (v && !/^https?:\/\/[^\s]+$/.test(v)) {
        return json(res, 400, { ok: false, error: '代理格式应为 http://127.0.0.1:7897' });
      }
      patch.OKX_PROXY = v;
    }
    if (typeof b.builderCode === 'string') {
      const v = b.builderCode.trim();
      if (v && !/^[A-Za-z0-9]{1,16}$/.test(v)) {
        return json(res, 400, { ok: false, error: 'Builder Code 只能是 1-16 位字母数字' });
      }
      patch.OKX_BUILDER_CODE = v;
    }
    if (typeof b.simulated === 'boolean') {
      patch.OKX_SIMULATED = b.simulated ? '1' : '0';
    }
    if (typeof b.baseUrl === 'string' && b.baseUrl.trim()) {
      patch.OKX_BASE_URL = b.baseUrl.trim();
    }

    if (Object.keys(patch).length === 0) {
      return json(res, 400, { ok: false, error: '没有需要保存的内容' });
    }

    env.save(patch);
    resetPool(); // 代理可能改了，丢掉旧隧道

    broadcast('state', engine.status());
    return json(res, 200, { ok: true, config: configView() });
  }

  // ---- 测试连接 ----
  if (req.method === 'POST' && p === '/api/test') {
    const t0 = Date.now();
    try {
      const c = await getConfig({ simulated: env.simulated });
      const bal = await getBalance({ simulated: env.simulated }).catch(() => null);
      return json(res, 200, {
        ok: true,
        uid: c.uid,
        acctLv: c.acctLv,
        posMode: c.posMode,
        totalEq: bal ? bal.totalEq : null,
        ms: Date.now() - t0,
      });
    } catch (e) {
      const px = await checkProxy();
      const ex = explainError(e.message, px);
      return json(res, 200, {
        ok: false,
        error: e.message,
        kind: ex.kind,
        hint: ex.hint,
        ip: ex.ip || '',
        proxy: px,
        ms: Date.now() - t0,
      });
    }
  }

  // ---- IP 探测 ----
  if (req.method === 'GET' && p === '/api/ip') {
    const r = await detectBoth();
    return json(res, 200, r);
  }

  // ---- 账户 ----
  if (req.method === 'GET' && p === '/api/account') {
    if (!env.apiKey || !env.secretKey || !env.passphrase) {
      return json(res, 200, { configured: false });
    }
    try {
      const opts = { simulated: env.simulated };
      const [cfg, bal, pos, pending] = await Promise.all([
        getConfig(opts),
        getBalance(opts),
        getPositions({ instType: 'SWAP' }, opts),
        getOrdersPending({ instType: 'SWAP' }, opts).catch(() => []),
      ]);
      return json(res, 200, {
        configured: true,
        uid: cfg.uid,
        acctLv: cfg.acctLv,
        posMode: cfg.posMode,
        totalEq: bal.totalEq,
        availBal: bal.usdtAvailBal,
        positions: pos.map((x) => ({
          instId: x.instId,
          pos: x.pos,
          avgPx: x.avgPx,
          upl: x.upl,
          uplRatio: x.uplRatio,
          liqPx: x.liqPx,
          lever: x.lever,
          margin: x.margin,
        })),
        pending: pending.map((o) => ({
          instId: o.instId,
          side: o.side,
          sz: o.sz,
          px: o.px,
          ordType: o.ordType,
          ordId: o.ordId,
        })),
        todayCount: guard.getTodayCount(),
      });
    } catch (e) {
      const px = await checkProxy();
      const ex = explainError(e.message, px);
      return json(res, 200, {
        configured: true,
        ok: false,
        error: e.message,
        kind: ex.kind,
        hint: ex.hint,
        ip: ex.ip || '',
        proxy: px,
      });
    }
  }

  // ---- 引擎 ----
  if (p === '/api/engine' && req.method === 'GET') {
    return json(res, 200, { ...engine.status(), todayCount: guard.getTodayCount() });
  }

  if (p === '/api/engine/start' && req.method === 'POST') {
    const b = await readBody(req);
    if (env.missing.length) {
      return json(res, 400, {
        ok: false,
        error: `还缺 ${env.missing.join('、')}，先在设置里填完再启动`,
      });
    }
    const instIds = Array.isArray(b.instIds)
      ? b.instIds.map((s) => String(s).trim()).filter(Boolean)
      : null;
    const r = engine.start({
      live: b.live !== false,
      interval: Number(b.interval) || 1500,
      instIds,
    });
    return json(res, r.ok ? 200 : 400, r);
  }

  if (p === '/api/engine/stop' && req.method === 'POST') {
    const r = engine.stop();
    return json(res, r.ok ? 200 : 400, r);
  }

  // ---- SSE ----
  if (p === '/api/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    for (const line of engine.ring.slice(-200)) {
      res.write(`event: log\ndata: ${JSON.stringify({ line, at: Date.now() })}\n\n`);
    }
    res.write(`event: state\ndata: ${JSON.stringify(engine.status())}\n\n`);
    clients.add(res);

    const beat = setInterval(() => {
      try {
        res.write(': ping\n\n');
      } catch {
        /* ignore */
      }
    }, 25000);

    req.on('close', () => {
      clearInterval(beat);
      clients.delete(res);
    });
    return;
  }

  return json(res, 404, { error: '接口不存在' });
}

// ─────────────────────────── 启动 ───────────────────────────

function openBrowser(url) {
  try {
    spawn('cmd.exe', ['/c', 'start', '', url], {
      windowsHide: true,
      detached: true,
      stdio: 'ignore',
    }).unref();
  } catch {
    /* 打开失败就让用户手动点 */
  }
}

const server = http.createServer((req, res) => {
  handle(req, res).catch((e) => {
    if (!res.headersSent) json(res, 500, { ok: false, error: e.message });
  });
});

const basePort = Number(argOf('--port', 8787));
let port = basePort;

function listen(p) {
  server.once('error', (e) => {
    if (e.code === 'EADDRINUSE' && p < basePort + 12) {
      listen(p + 1);
    } else {
      console.error('启动失败:', e.message);
      process.exit(1);
    }
  });
  server.listen(p, '127.0.0.1', () => {
    const url = `http://127.0.0.1:${p}/`;
    console.log('');
    console.log('════════════════════════════════════════════════════');
    console.log('   反向开单器 · 图形界面');
    console.log('════════════════════════════════════════════════════');
    console.log(`   地址：${url}`);
    console.log(`   配置：${env.envFile}`);
    console.log(`   凭证：${env.missing.length ? '未配置（在界面里填）' : '已配置'}`);
    console.log('════════════════════════════════════════════════════');
    console.log('   关闭本窗口即停止服务（正在运行的引擎会一起停止）');
    console.log('');

    if (!hasFlag('--no-open')) openBrowser(url);
  });
}

listen(port);

// 窗口被关掉时，别把引擎留成孤儿进程
process.on('SIGINT', () => {
  if (engine.running) engine.stop();
  setTimeout(() => process.exit(0), 300);
});
process.on('exit', () => {
  if (engine.running) {
    try {
      engine.child.kill();
    } catch {
      /* ignore */
    }
  }
});
