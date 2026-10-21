'use strict';

/**
 * 公网出口 IP 探测
 *
 * 两个视角，缺一不可：
 *  - 直连：本机不经代理上网时，外界看到的地址
 *  - 代理：走 OKX_PROXY 出去时，**OKX 实际看到的地址**（IP 白名单要填的就是这个）
 *
 * 大陆家庭宽带多为动态 IP，代理又会因为切换节点而变化，两者经常不一致，
 * 这正是「白名单明明填了却报 50110」的根因。
 */

const https = require('https');
const http = require('http');
const { createTunnel, proxyAgent, currentProxy } = require('../okx/client');

const SOURCES = [
  { url: 'https://myip.ipip.net/json', name: 'ipip.net', json: true, foreign: false },
  { url: 'https://api.ipify.org?format=json', name: 'ipify.org', json: true, foreign: true },
  { url: 'https://ifconfig.me/ip', name: 'ifconfig.me', json: false, foreign: true },
  { url: 'http://ip.3322.net', name: '3322.net', json: false, foreign: false },
];

/**
 * 探测源的顺序必须按模式区分：
 * Clash 之类工具的分流规则会把国内域名走直连（ipip.net 就是国内域名），
 * 用它查「代理出口 IP」只会得到家宽地址，看起来像代理没生效。
 * 查代理出口必须用境外域名，才会真正走节点。
 */
function sourcesFor(useProxy) {
  if (!useProxy) return SOURCES;
  const foreign = SOURCES.filter((s) => s.foreign);
  const local = SOURCES.filter((s) => !s.foreign);
  return [...foreign, ...local];
}

const IP_RE = /([0-9]{1,3}(?:\.[0-9]{1,3}){3})/;

function pickIp(body, isJson) {
  if (isJson) {
    try {
      const j = JSON.parse(body);
      const cand =
        (j.data && j.data.ip) || j.ip || j.query || j.origin || j.address || '';
      const m = IP_RE.exec(String(cand));
      if (m) return m[1];
    } catch {
      /* 落到正则兜底 */
    }
  }
  const m = IP_RE.exec(String(body));
  return m ? m[1] : null;
}

function fetchText(target, { useProxy, timeoutMs }) {
  return new Promise((resolve, reject) => {
    const url = new URL(target);
    const isHttps = url.protocol === 'https:';
    const lib = isHttps ? https : http;

    const go = (agent) => {
      const cleanup = () => {
        if (agent) {
          try {
            agent.destroy();
          } catch {
            /* ignore */
          }
        }
      };
      const req = lib.request(
        {
          hostname: url.hostname,
          port: url.port || (isHttps ? 443 : 80),
          path: url.pathname + url.search,
          method: 'GET',
          headers: { 'User-Agent': 'okx-reverse-order/0.1', Accept: '*/*' },
          timeout: timeoutMs,
          agent: agent || undefined,
        },
        (res) => {
          let data = '';
          res.setEncoding('utf8');
          res.on('data', (c) => (data += c));
          res.on('end', () => {
            cleanup();
            resolve({ status: res.statusCode, body: data });
          });
        }
      );
      req.on('timeout', () => {
        cleanup();
        req.destroy(new Error(`超时 ${timeoutMs}ms`));
      });
      req.on('error', (e) => {
        cleanup();
        reject(e);
      });
      req.end();
    };

    if (useProxy) {
      createTunnel(url.hostname, isHttps ? 443 : 80)
        .then((tunnel) => {
          const agent = proxyAgent(tunnel, url.hostname);
          go(agent);
        })
        .catch(reject);
    } else {
      go(null);
    }
  });
}

async function detectOne({ useProxy }) {
  if (useProxy && !currentProxy()) {
    return { ok: false, error: '未配置代理地址（OKX_PROXY 为空）', source: null };
  }

  let lastErr = '';
  for (const s of sourcesFor(useProxy)) {
    try {
      const { status, body } = await fetchText(s.url, {
        useProxy,
        timeoutMs: 8000,
      });
      if (status !== 200) {
        lastErr = `${s.name} 返回 HTTP ${status}`;
        continue;
      }
      const ip = pickIp(body, s.json);
      if (ip) return { ok: true, ip, source: s.name };
      lastErr = `${s.name} 返回内容里没有 IP`;
    } catch (e) {
      lastErr = `${s.name}: ${e.message}`;
    }
  }
  return { ok: false, error: lastErr || '全部探测源均失败', source: null };
}

/** 同时探测直连与代理两条出口 */
async function detectBoth() {
  const proxyOn = !!currentProxy();
  const [direct, proxy] = await Promise.all([
    detectOne({ useProxy: false }),
    detectOne({ useProxy: true }),
  ]);

  // 代理出口和直连出口相同 → 多半是代理没生效（或节点就是本地中转）
  const same = direct.ok && proxy.ok && direct.ip === proxy.ip;
  let hint = null;
  if (!proxyOn) {
    hint = '还没配置代理。大陆网络直连 OKX 会被 DNS 污染，建议在设置里填 http://127.0.0.1:7897';
  } else if (same) {
    hint = '代理出口与直连出口相同，代理可能没生效（检查 Clash 是否运行、端口是否正确）';
  }

  return {
    direct,
    proxy,
    proxyConfigured: proxyOn,
    same,
    hint,
    at: new Date().toISOString(),
  };
}

module.exports = { detectBoth, detectOne };
