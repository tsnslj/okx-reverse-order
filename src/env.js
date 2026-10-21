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
  throw new Error(
    `缺少凭证: ${missing.join(', ')}。请检查 ${ENV_FILE}`
  );
}

module.exports = config;
