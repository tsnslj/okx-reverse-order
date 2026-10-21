'use strict';

const fs = require('fs');
const path = require('path');

const ENV_FILE = path.join(__dirname, '..', '.env');

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

const raw = loadEnvFile(ENV_FILE);

const config = {
  apiKey: raw.OKX_API_KEY || '',
  secretKey: raw.OKX_SECRET_KEY || '',
  passphrase: raw.OKX_PASSPHRASE || '',
  baseUrl: raw.OKX_BASE_URL || 'https://www.okx.com',
  simulated: raw.OKX_SIMULATED === '1',
  proxy: raw.OKX_PROXY || '',
  // AI Builder Program 归因码：直接调 OpenAPI 时写入下单请求的 tag 字段
  builderCode: (raw.OKX_BUILDER_CODE || '').trim(),
};

const missing = ['apiKey', 'secretKey', 'passphrase'].filter((k) => !config[k]);
if (missing.length > 0) {
  const line = '═'.repeat(56);
  console.error(`
${line}
  还没有配置 OKX API 凭证
${line}

  缺少：${missing.join(', ')}

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
${line}
`);
  process.exit(1);
}

module.exports = config;
