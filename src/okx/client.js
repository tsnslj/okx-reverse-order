'use strict';

const https = require('https');
const net = require('net');
const tls = require('tls');
const { URL } = require('url');
const { sign } = require('./sign');
const env = require('../env');

/** 常见错误码的中文提示，命中时直接说人话 */
const ERROR_HINTS = {
  '50101': 'API Key 与当前环境不匹配（实盘/模拟盘搞反了？）',
  '50102': '请求时间戳过期，检查本机时间是否准确',
  '50103': '缺少 OK-ACCESS-KEY 请求头',
  '50104': '缺少 OK-ACCESS-PASSPHRASE 请求头',
  '50105': 'Passphrase 错误',
  '50106': '缺少 OK-ACCESS-SIGN 请求头',
  '50107': '请求时间戳不在有效期内（本机时间偏差过大）',
  '50110': 'IP 不在白名单内（去 OKX 更新 API Key 的 IP 地址）',
  '50111': 'API Key 无效（可能已过期或被删除）',
  '50113': 'IP 不在白名单内（去 OKX 更新 API Key 的 IP 地址）',
  '51000': '参数错误',
  '51008': '可用余额不足',
  '51169': '没有该方向的持仓，无法平仓/减仓',
  '51205': '该账户模式不支持只减仓（reduceOnly）',
  '51400': '订单已完成/已撤销/不存在，撤单失败',
  '51403': '该委托类型不支持撤单（市价单必然是此结果）',
  '51405': '当前没有未成交的订单',
  '51410': '订单撤销中或结算中，稍后重试',
  '51413': '接口不支持该委托类型的撤单',
  '51603': '查询的订单不存在',
};

/**
 * 代理配置惰性读取 —— 图形界面里改了代理地址后无需重启服务
 * 每次读 env.proxy，值与缓存不同才重新解析
 */
let proxyCache = { raw: null, cfg: null };

function currentProxy() {
  const raw = env.proxy || '';
  if (proxyCache.raw === raw) return proxyCache.cfg;

  let cfg = null;
  if (raw) {
    try {
      const u = new URL(raw);
      cfg = {
        host: u.hostname,
        port: Number(u.port || (u.protocol === 'https:' ? 443 : 80)),
        auth:
          u.username
            ? 'Basic ' +
              Buffer.from(
                `${decodeURIComponent(u.username)}:${decodeURIComponent(u.password || '')}`
              ).toString('base64')
            : null,
      };
    } catch {
      cfg = null;
    }
  }
  proxyCache = { raw, cfg };
  return cfg;
}

/** 通过 HTTP 代理建立 CONNECT 隧道，返回裸 socket */
function createTunnel(targetHost, targetPort) {
  const proxyCfg = currentProxy();
  return new Promise((resolve, reject) => {
    if (!proxyCfg) return reject(new Error('未配置代理地址'));
    const socket = net.connect({
      host: proxyCfg.host,
      port: proxyCfg.port,
    });
    socket.setNoDelay(true);
    socket.setTimeout(20000);

    socket.once('connect', () => {
      const authLine = proxyCfg.auth ? `Proxy-Authorization: ${proxyCfg.auth}\r\n` : '';
      socket.write(
        `CONNECT ${targetHost}:${targetPort} HTTP/1.1\r\n` +
          `Host: ${targetHost}:${targetPort}\r\n` +
          authLine +
          `Proxy-Connection: Keep-Alive\r\n\r\n`
      );
    });

    let buf = Buffer.alloc(0);
    const onData = (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const idx = buf.indexOf('\r\n\r\n');
      if (idx === -1) return;

      socket.removeListener('data', onData);
      const head = buf.slice(0, idx).toString('latin1');
      const rest = buf.slice(idx + 4);

      if (!/^HTTP\/1\.[01] 200/.test(head)) {
        socket.destroy();
        const status = head.split('\r\n')[0] || '未知响应';
        return reject(
          new Error(
            `代理隧道建立失败: ${status}（检查 Clash 是否在运行、节点是否可用）`
          )
        );
      }
      if (rest.length > 0) socket.unshift(rest);
      socket.setTimeout(0);
      resolve(socket);
    };

    socket.on('data', onData);
    socket.once('error', (e) =>
      reject(new Error(`代理连接失败 ${proxyCfg.host}:${proxyCfg.port} — ${e.message}`))
    );
    socket.once('timeout', () =>
      socket.destroy(new Error('代理连接超时（20s）'))
    );
  });
}

/** 包一个已建好的隧道 socket，返回能用它的 https.Agent */
function proxyAgent(tunnel, servername) {
  const agent = new https.Agent({ keepAlive: true, maxSockets: 1, maxFreeSockets: 1 });
  agent.createConnection = (opts, cb) => {
    const sock = tls.connect(
      { socket: tunnel, servername, ALPNProtocols: ['http/1.1'] }
    );
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
 * 连接池：复用同一条隧道，避免每次请求都重做 TCP + TLS 握手
 * （不复用时单次约 3.3s，复用后应降到几百毫秒）
 */
let connPool = null;

async function getProxyAgent(hostname) {
  if (
    connPool &&
    connPool.hostname === hostname &&
    connPool.tunnel &&
    !connPool.tunnel.destroyed
  ) {
    return connPool.agent;
  }

  const tunnel = await createTunnel(hostname, 443);
  const agent = proxyAgent(tunnel, hostname);

  connPool = { hostname, agent, tunnel };
  tunnel.once('close', () => {
    if (connPool && connPool.tunnel === tunnel) connPool = null;
  });

  return agent;
}

/** 主动断开连接池（切换环境或出错时用） */
function resetPool() {
  if (connPool) {
    try {
      connPool.agent.destroy();
      connPool.tunnel.destroy();
    } catch {
      /* ignore */
    }
    connPool = null;
  }
}

/**
 * 发起一个已签名的 OKX 请求
 * @param {string} method
 * @param {string} requestPath 含 query
 * @param {object|null} body   POST 用
 * @param {{simulated?: boolean, timeoutMs?: number}} [options]
 */
async function request(method, requestPath, body = null, options = {}) {
  const simulated =
    options.simulated === undefined ? env.simulated : options.simulated;
  const timeoutMs = options.timeoutMs || 20000;

  const timestamp = new Date().toISOString();
  const bodyStr = body ? JSON.stringify(body) : '';
  const signature = sign(env.secretKey, timestamp, method, requestPath, bodyStr);

  const url = new URL(env.baseUrl + requestPath);

  const headers = {
    'OK-ACCESS-KEY': env.apiKey,
    'OK-ACCESS-SIGN': signature,
    'OK-ACCESS-TIMESTAMP': timestamp,
    'OK-ACCESS-PASSPHRASE': env.passphrase,
    'Content-Type': 'application/json',
  };
  if (simulated) headers['x-simulated-trading'] = '1';
  if (bodyStr) headers['Content-Length'] = Buffer.byteLength(bodyStr);

  // 有代理就取复用连接；没代理就直连
  const agent = currentProxy() ? await getProxyAgent(url.hostname) : null;

  return new Promise((resolve, reject) => {
    const reqOptions = {
      hostname: url.hostname,
      port: url.port || 443,
      path: url.pathname + url.search,
      method: method.toUpperCase(),
      headers,
      timeout: timeoutMs,
    };

    if (agent) {
      reqOptions.agent = agent;
    }

    const req = https.request(reqOptions, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json;
        try {
          json = JSON.parse(data);
        } catch {
          return reject(
            new Error(`非 JSON 响应 (HTTP ${res.statusCode}): ${data.slice(0, 300)}`)
          );
        }

        const code = String(json.code ?? '');
        if (code !== '0' && code !== '') {
          const hint = ERROR_HINTS[code] || '';
          const msg = json.msg || '未知错误';
          const err = new Error(`[${code}] ${msg}${hint ? ' — ' + hint : ''}`);
          err.code = code;
          err.payload = json;
          return reject(err);
        }
        resolve(json);
      });
    });

    req.on('timeout', () => req.destroy(new Error(`请求超时（${timeoutMs}ms）`)));
    req.on('error', (e) => reject(e));

    if (bodyStr) req.write(bodyStr);
    req.end();
  });
}

const get = (p, o) => request('GET', p, null, o);
const post = (p, b, o) => request('POST', p, b, o);

module.exports = {
  request,
  get,
  post,
  ERROR_HINTS,
  currentProxy,
  resetPool,
  createTunnel,
  proxyAgent,
  /** 兼容旧调用：读一次当前代理配置 */
  get proxyCfg() {
    return currentProxy();
  },
};
