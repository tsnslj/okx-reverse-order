'use strict';

const crypto = require('crypto');

/**
 * OKX V5 签名
 * sign = Base64( HMAC-SHA256( secretKey, timestamp + METHOD + requestPath + body ) )
 *
 * @param {string} secretKey
 * @param {string} timestamp   ISO 8601，如 2026-10-21T06:18:46.123Z
 * @param {string} method      GET / POST
 * @param {string} requestPath 含 query string，如 /api/v5/account/positions?instId=BTC-USDT-SWAP
 * @param {string} body        原始 JSON 字符串；GET 传空串
 */
function sign(secretKey, timestamp, method, requestPath, body = '') {
  const prehash = `${timestamp}${method.toUpperCase()}${requestPath}${body}`;
  return crypto
    .createHmac('sha256', secretKey)
    .update(prehash)
    .digest('base64');
}

module.exports = { sign };
