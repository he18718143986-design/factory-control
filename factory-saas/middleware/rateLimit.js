'use strict';
const config = require('../config');
const { getClientIp } = require('../utils/network');

const buckets = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [k, e] of buckets) { if (now > e.resetAt) buckets.delete(k); }
}, 5 * 60 * 1000);

function createRateLimiter({
  name = 'default',
  max = 10,
  windowMs = 60 * 1000,
  message = '请求过于频繁，请稍后再试',
  keyFn = (req) => getClientIp(req),
}) {
  return function rateLimiter(req, res, next) {
    const rawKey = keyFn(req) || getClientIp(req) || 'unknown';
    const key = `${name}:${rawKey}`;
    const now = Date.now();
    let e = buckets.get(key);
    if (!e || now > e.resetAt) {
      e = { count: 0, resetAt: now + windowMs };
      buckets.set(key, e);
    }
    e.count += 1;

    const remaining = Math.max(0, max - e.count);
    res.setHeader('X-RateLimit-Limit', String(max));
    res.setHeader('X-RateLimit-Remaining', String(remaining));
    res.setHeader('X-RateLimit-Reset', String(Math.ceil(e.resetAt / 1000)));

    if (e.count > max) {
      const retryAfter = Math.max(1, Math.ceil((e.resetAt - now) / 1000));
      res.setHeader('Retry-After', String(retryAfter));
      return res.status(429).json({ error: 'RATE_LIMITED', message });
    }
    return next();
  };
}

const rateLimit = createRateLimiter({
  name: 'checkin',
  max: config.rateLimit.checkin.max,
  windowMs: config.rateLimit.checkin.windowMs,
});

const loginLimiter = createRateLimiter({
  name: 'login',
  max: config.rateLimit.login.max,
  windowMs: config.rateLimit.login.windowMs,
  message: '登录尝试过于频繁，请稍后再试',
  keyFn: (req) => `${getClientIp(req)}:${String(req.body?.email || '').trim().toLowerCase() || 'no-email'}`,
});

const registerLimiter = createRateLimiter({
  name: 'register',
  max: config.rateLimit.register.max,
  windowMs: config.rateLimit.register.windowMs,
  message: '注册请求过于频繁，请稍后再试',
  keyFn: (req) => `${getClientIp(req)}:${String(req.body?.email || '').trim().toLowerCase() || 'no-email'}`,
});

const adminWriteLimiter = createRateLimiter({
  name: 'admin-write',
  max: config.rateLimit.adminWrite.max,
  windowMs: config.rateLimit.adminWrite.windowMs,
  message: '管理操作过于频繁，请稍后再试',
});

const paymentReviewLimiter = createRateLimiter({
  name: 'payment-review',
  max: config.rateLimit.paymentReview.max,
  windowMs: config.rateLimit.paymentReview.windowMs,
  message: '支付审核操作过于频繁，请稍后再试',
});

const rebindReviewLimiter = createRateLimiter({
  name: 'rebind-review',
  max: config.rateLimit.rebindReview.max,
  windowMs: config.rateLimit.rebindReview.windowMs,
  message: '网络重绑审批过于频繁，请稍后再试',
});

function rateLimitLegacy(req, res, next) {
  // 兼容旧导出名
  return rateLimit(req, res, next);
}

module.exports = {
  createRateLimiter,
  rateLimit: rateLimitLegacy,
  loginLimiter,
  registerLimiter,
  adminWriteLimiter,
  paymentReviewLimiter,
  rebindReviewLimiter,
};
