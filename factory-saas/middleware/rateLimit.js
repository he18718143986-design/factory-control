'use strict';
const config = require('../config');
const { getClientIp } = require('../utils/network');

const map = new Map();

setInterval(() => {
  const now = Date.now();
  for (const [ip, e] of map) { if (now > e.resetAt) map.delete(ip); }
}, 5 * 60 * 1000);

function rateLimit(req, res, next) {
  const ip  = getClientIp(req);
  const now = Date.now();
  let e = map.get(ip);
  if (!e || now > e.resetAt) {
    e = { count: 0, resetAt: now + config.rateLimit.windowMs };
    map.set(ip, e);
  }
  if (++e.count > config.rateLimit.max) {
    return res.status(429).json({ error: 'RATE_LIMITED', message: '请求过于频繁，请稍后再试' });
  }
  next();
}

module.exports = { rateLimit };
