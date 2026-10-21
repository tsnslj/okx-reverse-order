'use strict';

/**
 * 直连层 —— 不需要任何代理软件的 OKX 接入
 *
 * 背景：国内网络对 okx.com 做了两层封锁
 *   1. DNS 污染      www.okx.com → awscn.okpool.top → 169.254.0.2（假地址）
 *   2. SNI 阻断      即使拿到真实 IP，TLS 握手里 servername=www.okx.com 会被 RST
 *
 * 突破口：OKX 有备用域名 okx.cab，指向同一批服务器，且没被封锁
 *   - 解析 okx.cab 拿到真实 IP（AWS 香港 16.162.171.65 等）
 *   - TLS 的 SNI 用 okx.cab（不在黑名单，握手正常通过）
 *   - HTTP 的 Host 头写 www.okx.com（CDN 据此路由到正确的 API 站点）
 *   - 证书是 OKX 自己的 *.okx.cab，严格校验同样通过，不存在中间人风险
 *
 * 这样新用户什么都不用配，打开就能连。
 */

const dns = require('dns').promises;
const https = require('https');
const tls = require('tls');
const fs = require('fs');
const path = require('path');

/** 用于「拿真实 IP」的引导域名：它们指向和 okx.com 相同的服务器，但没被污染 */
const BOOTSTRAP_DOMAINS = ['okx.cab'];

/** 兜底种子 IP：万一 okx.cab 哪天也被污染了，这几个还能用（会定期刷新） */
const SEED_IPS = ['16.162.171.65', '43.198.253.66', '18.163.157.45'];

/** TLS 握手的 SNI —— 必须是没被阻断的名字 */
const SNI = 'okx.cab';

/** HTTP Host 头 —— 必须是 OKX API 的真实域名 */
const HOST_HEADER = 'www.okx.com';

const IP_TTL_MS = 30 * 60 * 1000;

/** IP 池落盘，第二次启动直接复用，省掉 5 秒探测 */
const CACHE_FILE = path.join(__dirname, '..', '..', 'data', 'ip-pool.json');

let cache = {
  ips: [],
  fetchedAt: 0,
  alive: [],       // 实测可用的 IP，按延迟升序
  aliveAt: 0,
};

function readDiskCache() {
  try {
    const j = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (Array.isArray(j.alive) && j.alive.length) return j;
  } catch {
    /* 没有缓存或格式坏了都无所谓 */
  }
  return null;
}

function writeDiskCache(alive) {
  try {
    fs.mkdirSync(path.dirname(CACHE_FILE), { recursive: true });
    fs.writeFileSync(
      CACHE_FILE,
      JSON.stringify({ alive, savedAt: Date.now() }, null, 2),
      'utf8'
    );
  } catch {
    /* 落盘失败不影响主流程 */
  }
}

function log(...args) {
  if (process.env.OKX_QUIET === '1') return;
  console.log(...args);
}

/** 从引导域名解析真实 IP（并发多个域名，合并去重） */
async function resolveIps() {
  const found = new Set();
  await Promise.all(
    BOOTSTRAP_DOMAINS.map(async (d) => {
      try {
        const list = await dns.resolve4(d);
        list.forEach((ip) => found.add(ip));
      } catch {
        /* 单个域名失败不影响整体 */
      }
    })
  );
  return [...found];
}

/**
 * 探测单个 IP 是否能完成 TLS 握手并拿到有效响应
 * @returns {Promise<{ip:string, ms:number}|null>}
 */
function probeIp(ip, timeoutMs = 5000) {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const req = https.request(
      {
        host: ip,
        servername: SNI,
        path: '/api/v5/public/time',
        method: 'GET',
        timeout: timeoutMs,
        headers: { Host: HOST_HEADER, Accept: 'application/json' },
        // 独立 Agent：探测不污染主连接池
        agent: new https.Agent({ keepAlive: false, servername: SNI }),
      },
      (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => {
          const ok = res.statusCode === 200 && /"code"\s*:\s*"0"/.test(body);
          resolve(ok ? { ip, ms: Date.now() - t0 } : null);
        });
      }
    );
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
    req.on('error', () => resolve(null));
    req.end();
  });
}

/**
 * 拿到一组实测可用的 IP，按延迟升序
 * @param {boolean} force 强制刷新缓存
 */
async function getAliveIps(force = false) {
  const now = Date.now();
  if (!force && cache.alive.length && now - cache.aliveAt < IP_TTL_MS) {
    return cache.alive;
  }

  // 上一次跑通了什么 IP 记在磁盘上，开机直接复用，不用再探测 5 秒
  if (!force && !cache.alive.length) {
    const disk = readDiskCache();
    if (disk && now - disk.savedAt < IP_TTL_MS) {
      cache.alive = disk.alive;
      cache.aliveAt = disk.savedAt;
      return cache.alive;
    }
  }

  let candidates = cache.ips;
  if (force || !candidates.length || now - cache.fetchedAt > IP_TTL_MS) {
    const resolved = await resolveIps();
    candidates = resolved.length ? resolved : SEED_IPS;
    cache.ips = candidates;
    cache.fetchedAt = now;
  }

  // 全部并发探测，取通的
  const results = await Promise.all(candidates.map((ip) => probeIp(ip)));
  const alive = results.filter(Boolean).sort((a, b) => a.ms - b.ms);

  if (alive.length) {
    cache.alive = alive;
    cache.aliveAt = now;
    writeDiskCache(alive);
    return alive;
  }

  // 解析出的都不通：退回种子 IP 再试一轮
  if (candidates !== SEED_IPS) {
    const seedResults = await Promise.all(SEED_IPS.map((ip) => probeIp(ip)));
    const seedAlive = seedResults.filter(Boolean).sort((a, b) => a.ms - b.ms);
    if (seedAlive.length) {
      cache.ips = SEED_IPS;
      cache.alive = seedAlive;
      cache.aliveAt = now;
      writeDiskCache(seedAlive);
      return seedAlive;
    }
  }

  return [];
}

/**
 * 主连接池：复用一条 TLS 长连接，避免每次请求都握手
 * 换 IP 或连接断开时自动重建
 */
let pool = null;

function buildAgent(ip) {
  const agent = new https.Agent({
    keepAlive: true,
    maxSockets: 2,
    maxFreeSockets: 2,
    servername: SNI,
  });
  // 覆写连接建立过程：连 IP，但 SNI 用 okx.cab
  agent.createConnection = (opts, cb) => {
    const sock = tls.connect({
      host: ip,
      port: 443,
      servername: SNI,
      ALPNProtocols: ['http/1.1'],
      rejectUnauthorized: true,
    });
    sock.setNoDelay(true);
    sock.setKeepAlive(true, 30000);
    sock.once('secureConnect', () => {
      if (cb) cb(null, sock);
    });
    sock.once('error', (e) => {
      if (cb) cb(e);
    });
    return sock;
  };
  return agent;
}

/**
 * 取一个可用于请求的直连 Agent，必要时自动挑选最快 IP
 */
async function getDirectAgent() {
  if (pool && !pool.dead) {
    return pool.agent;
  }

  const alive = await getAliveIps();
  if (!alive.length) {
    throw new Error(
      '直连通道不可用：解析不到 OKX 服务器地址，且种子 IP 无响应。' +
        '请检查本机是否能正常上网（试着打开任意网页）。'
    );
  }

  const agent = buildAgent(alive[0].ip);
  pool = { agent, ip: alive[0].ip, dead: false, ms: alive[0].ms };
  log(`[直连] 使用 ${alive[0].ip}（握手 ${alive[0].ms}ms）`);
  return agent;
}

/** 标记当前连接失效，下次请求重新挑 IP */
function markPoolDead() {
  if (pool) {
    pool.dead = true;
    try {
      pool.agent.destroy();
    } catch {
      /* ignore */
    }
    pool = null;
  }
  // 用过的 IP 挂了，缓存也不能再信，下次重新探测
  cache.alive = [];
  cache.aliveAt = 0;
}

/** 主动清空全部缓存（切换网络后调用） */
function resetDirect() {
  markPoolDead();
  cache = { ips: [], fetchedAt: 0, alive: [], aliveAt: 0 };
}

/** 网络自检：返回给人看的结论 */
async function diagnose() {
  const t0 = Date.now();
  const alive = await getAliveIps(true);
  if (!alive.length) {
    return { ok: false, mode: 'direct', ms: Date.now() - t0, ips: [], message: '直连不通' };
  }
  return {
    ok: true,
    mode: 'direct',
    ms: alive[0].ms,
    ips: alive.map((a) => a.ip),
    primary: alive[0].ip,
    message: `直连可用（${alive[0].ms}ms）`,
  };
}

module.exports = {
  SNI,
  HOST_HEADER,
  SEED_IPS,
  BOOTSTRAP_DOMAINS,
  getDirectAgent,
  getAliveIps,
  markPoolDead,
  resetDirect,
  probeIp,
  diagnose,
  directState: () => ({
    ip: pool ? pool.ip : null,
    ips: cache.alive.map((a) => a.ip),
    sni: SNI,
    host: HOST_HEADER,
  }),
};
