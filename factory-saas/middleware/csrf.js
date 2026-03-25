'use strict';

const crypto = require('crypto');
const config = require('../config');

const CSRF_COOKIE = 'csrf_token';
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function generateCsrfToken() {
  return crypto.randomBytes(24).toString('hex');
}

function csrfCookieOptions() {
  return {
    httpOnly: false, // 前端需要读取并写入 X-CSRF-Token 头
    secure: config.isProd,
    sameSite: 'Strict',
    path: '/',
    maxAge: 7 * 24 * 60 * 60 * 1000,
  };
}

function ensureCsrfToken(req, res, next) {
  let token = req.cookies?.[CSRF_COOKIE];
  if (!token) {
    token = generateCsrfToken();
    res.cookie(CSRF_COOKIE, token, csrfCookieOptions());
  }
  req.csrfToken = token;
  next();
}

function csrfProtection(req, res, next) {
  const method = String(req.method || 'GET').toUpperCase();
  if (SAFE_METHODS.has(method)) return next();

  const cookieToken = req.cookies?.[CSRF_COOKIE];
  const headerToken = req.get('X-CSRF-Token');
  if (!cookieToken || !headerToken || cookieToken !== headerToken) {
    return res.status(403).json({ error: 'CSRF_INVALID', message: 'CSRF 校验失败' });
  }
  return next();
}

module.exports = { ensureCsrfToken, csrfProtection };

