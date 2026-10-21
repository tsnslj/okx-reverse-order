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
const { resetPool, currentProxy, networkMode } = require('../okx/client');
const { getConfig, getPositions, getBalance } = require('../okx/account');
const { getOrdersPending } = require('../okx/trade');
const { detectBoth, detectOne } = require('../net/ipcheck');
const direct = require('../net/direct');
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
    networkMode: networkMode(),
    simulated: env.simulated,
    builderCode: env.builderCode,
    missing: env.missing,
    envFile: env.envFile,
  };
}

/**
 * OKX 实际看到的出口 IP
 * 直连模式下就是家宽公网 IP；走代理时是代理节点 IP
 */
async function okxVisibleIp() {
  const viaProxy = networkMode() === 'proxy' && !!currentProxy();
  const r = await detectOne({ useProxy: viaProxy });
  return { ...r, viaProxy };
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
        hint: `代理没开：${proxyState.host}:${proxyState.port} 拒绝连接。把代理软件打开，或者把网络模式改回「自动」用直连通道。`,
      };
    }
    return { kind: 'net', hint: '连接被拒绝，目标端口不通。检查本机网络是否正常。' };
  }

  if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(m)) {
    return {
      kind: 'dns',
      hint: '域名解析失败。本机网络可能断开了，检查能不能打开网页后点「重新检测」。',
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

  if (/50111/.test(m) || /Invalid OK-ACCESS-KEY/i.test(m)) {
    return {
      kind: 'bad-key',
      hint: 'API Key 无效：可能复制时少了字符、这把 Key 已被删除，或者填成了另一个环境（实盘/模拟盘）的 Key。',
    };
  }

  if (/50105/.test(m) || /Passphrase/i.test(m)) {
    return {
      kind: 'bad-pass',
      hint: 'Passphrase 不对：这是创建 Key 时你自己设的密码，OKX 后台查不到。实在想不起来只能重建一把 Key。',
    };
  }

  if (/50103|50104|50106/.test(m)) {
    return { kind: 'bad-key', hint: '请求头缺少必要字段，重新保存一次 API 凭证试试。' };
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

  // ─────────── 首次配置向导 ───────────
  //
  // 新用户拿到程序后不用碰命令行、不用装代理：
  // 打开页面 → 自动检测网络 → 填三个输入框 → 一键验证 → 完成

  if (req.method === 'GET' && p === '/api/setup') {
    const hasKeys = env.missing.length === 0;
    // 用缓存判断网络，别让首屏等好几秒
    const alive = await direct.getAliveIps().catch(() => []);
    const netOk = alive.length > 0;

    let ip = '';
    if (hasKeys || netOk) {
      const r = await okxVisibleIp().catch(() => null);
      if (r && r.ok) ip = r.ip;
    }

    return json(res, 200, {
      needSetup: !hasKeys || env.setupDone === false,
      hasKeys,
      missing: env.missing,
      networkOk: netOk,
      networkMs: alive.length ? alive[0].ms : 0,
      networkMode: networkMode(),
      proxyConfigured: !!currentProxy(),
      ip,
      directState: direct.directState(),
      config: configView(),
    });
  }

  // 强制重新检测网络通道
  if (req.method === 'POST' && p === '/api/setup/network') {
    direct.resetDirect();
    resetPool();
    const t0 = Date.now();
    const net = await direct.diagnose().catch((e) => ({ ok: false, message: e.message }));
    const px = await checkProxy();
    return json(res, 200, {
      ok: net.ok,
      network: net,
      proxy: px,
      ms: Date.now() - t0,
      hint: net.ok
        ? `已连上 OKX 服务器（直连，${net.ms}ms），不需要任何代理软件。`
        : px.alive
        ? '直连不通，但检测到本机有代理在运行，已自动切到代理通道。'
        : '直连不通，也没检测到代理。检查一下本机是否能正常上网。',
    });
  }

  // 一键验证：走完整链路，返回失败原因和下一步该做什么
  if (req.method === 'POST' && p === '/api/setup/verify') {
    const t0 = Date.now();
    const px = await checkProxy();
    try {
      const c = await getConfig({ simulated: env.simulated });
      const bal = await getBalance({ simulated: env.simulated }).catch(() => null);
      const ipr = await okxVisibleIp().catch(() => null);
      return json(res, 200, {
        ok: true,
        uid: c.uid,
        acctLv: c.acctLv,
        posMode: c.posMode,
        totalEq: bal ? bal.totalEq : null,
        ip: ipr && ipr.ok ? ipr.ip : '',
        ms: Date.now() - t0,
      });
    } catch (e) {
      const ex = explainError(e.message, px);
      const ipr = await okxVisibleIp().catch(() => null);
      return json(res, 200, {
        ok: false,
        error: e.message,
        kind: ex.kind,
        hint: ex.hint,
        ip: ex.ip || (ipr && ipr.ok ? ipr.ip : ''),
        ms: Date.now() - t0,
      });
    }
  }

  // 向导完成，写进配置，下次启动直接进主界面
  if (req.method === 'POST' && p === '/api/setup/done') {
    env.save({ OKX_SETUP_DONE: '1' });
    return json(res, 200, { ok: true });
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
      if (v && !/^(https?|socks5?):\/\/[^\s]+$/.test(v)) {
        return json(res, 400, { ok: false, error: '代理格式应为 http://127.0.0.1:7897' });
      }
      patch.OKX_PROXY = v;
    }
    if (typeof b.networkMode === 'string') {
      const v = b.networkMode.toLowerCase();
      if (!['auto', 'direct', 'proxy'].includes(v)) {
        return json(res, 400, { ok: false, error: '网络模式只能是 auto / direct / proxy' });
      }
      patch.OKX_NETWORK = v;
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
    direct.resetDirect(); // 网络模式可能改了，直连缓存也清掉

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
