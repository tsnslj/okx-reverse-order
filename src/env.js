'use strict';

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

/**
 * 配置文件加载
 *
 * 两种运行形态：
 *  1. 命令行 / 引擎进程 —— 缺凭证就打印引导并退出
 *  2. 图形界面服务 —— 设 OKX_ALLOW_EMPTY=1，缺凭证也照常启动，让用户在界面里填
 */

function loadEnvFile(file) {
  const out = {};
  if (!fs.existsSync(file)) return out;

  const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;

    // 只按第一个 "=" 切分，保证 passphrase 里的特殊字符不被打散
    const i = t.indexOf('=');
    if (i === -1) continue;

    const key = t.slice(0, i).trim();
    let value = t.slice(i + 1).trim();

    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    out[key] = value;
  }
  return out;
}

function build(raw) {
  return {
    apiKey: raw.OKX_API_KEY || '',
    secretKey: raw.OKX_SECRET_KEY || '',
    passphrase: raw.OKX_PASSPHRASE || '',
    baseUrl: raw.OKX_BASE_URL || 'https://www.okx.com',
    simulated: raw.OKX_SIMULATED === '1',
    proxy: raw.OKX_PROXY || '',
    // 网络通道：auto=先直连不通再走代理 | direct=只直连 | proxy=只走代理
    networkMode: (raw.OKX_NETWORK || 'auto').toLowerCase(),
    // AI Builder Program 归因码：直接调 OpenAPI 时写入下单请求的 tag 字段
    builderCode: (raw.OKX_BUILDER_CODE || '').trim(),
    // 首次配置向导是否已完成（完成后启动直接进主界面）
    setupDone: raw.OKX_SETUP_DONE === '1',
  };
}

const config = build(loadEnvFile(ENV_FILE));

/** 缺哪些必填项 */
function missingKeys(c = config) {
  return ['apiKey', 'secretKey', 'passphrase'].filter((k) => !c[k]);
}

config.missing = missingKeys();
config.envFile = ENV_FILE;

/**
 * 从磁盘重新读取（改完配置不用重启服务）
 * 就地修改导出的对象，这样 client.js 里持有的引用也是最新的
 */
config.reload = function reload() {
  const fresh = build(loadEnvFile(ENV_FILE));
  for (const k of Object.keys(fresh)) config[k] = fresh[k];
  config.missing = missingKeys();
  return config;
};

/** 把若干键写回 .env，保留原有注释与顺序 */
config.save = function save(patch) {
  const lines = fs.existsSync(ENV_FILE)
    ? fs.readFileSync(ENV_FILE, 'utf8').split(/\r?\n/)
    : [];

  const seen = new Set();
  const out = lines.map((line) => {
    const t = line.trim();
    if (!t || t.startsWith('#')) return line;
    const i = t.indexOf('=');
    if (i === -1) return line;
    const key = t.slice(0, i).trim();
    if (!(key in patch)) return line;
    seen.add(key);
    return `${key}=${patch[key]}`;
  });

  for (const [k, v] of Object.entries(patch)) {
    if (!seen.has(k)) out.push(`${k}=${v}`);
  }

  // 去掉尾部多余空行，统一以单个换行收尾
  while (out.length && out[out.length - 1].trim() === '') out.pop();
  fs.writeFileSync(ENV_FILE, out.join('\n') + '\n', 'utf8');

  return config.reload();
};

const SOFT = process.env.OKX_ALLOW_EMPTY === '1';

if (config.missing.length > 0 && !SOFT) {
  const line = '═'.repeat(56);
  console.error(`
${line}
  还没有配置 OKX API 凭证
${line}

  缺少：${config.missing.join(', ')}

  第 1 步  创建 API Key
           打开 https://www.okx.com/account/my-api
           权限只勾「读取」+「交易」，绝对不要勾「提币」
           务必填写 IP 白名单，否则带交易权限的 Key 会在 14 天后自动失效

  第 2 步  把配置模板复制一份
           PowerShell : Copy-Item .env.example .env
           macOS/Linux: cp .env.example .env

  第 3 步  用文本编辑器打开 .env，填这三行
           OKX_API_KEY=你的 Key
           OKX_SECRET_KEY=你的 Secret
           OKX_PASSPHRASE=创建 Key 时你自己设的密码（OKX 后台查不到）

  配置文件位置：
  ${ENV_FILE}

  填写完成后再运行一次。建议先跑只读体检：
  node scripts/p0-check.js --live

  或者直接双击「启动.bat」用图形界面配置。
${line}
`);
  process.exit(1);
}

module.exports = config;
