'use strict';
/**
 * middleware/auth.js — JWT 认证中间件
 */

const jwt    = require('jsonwebtoken');
const config = require('../config');
const { stmts } = require('../db');

function signToken(payload) {
  return jwt.sign(payload, config.jwt.secret, { expiresIn: config.jwt.expiresIn });
}

function setAuthCookie(res, token) {
  res.cookie('token', token, {
    httpOnly: true,
    secure:   config.isProd,
    sameSite: 'Strict',
    maxAge:   7 * 24 * 60 * 60 * 1000,   // 7 天
  });
}

function clearAuthCookie(res) {
  res.clearCookie('token', { httpOnly: true, secure: config.isProd, sameSite: 'Strict' });
}

/**
 * requireAuth — 要求已登录
 */
function requireAuth(req, res, next) {
  const token = req.cookies?.token;
  if (!token) {
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
  try {
    const payload = jwt.verify(token, config.jwt.secret);
    const user    = stmts.getUserById.get(payload.userId);
    if (!user || user.status === 'suspended') {
      clearAuthCookie(res);
      if (req.accepts('html')) return res.redirect('/login');
      return res.status(401).json({ error: 'UNAUTHORIZED' });
    }
    req.user = user;
    // 刷新 token
    const newToken = signToken({ userId: user.id, isSuperAdmin: !!user.is_super_admin });
    setAuthCookie(res, newToken);
    next();
  } catch {
    clearAuthCookie(res);
    if (req.accepts('html')) return res.redirect('/login');
    return res.status(401).json({ error: 'UNAUTHORIZED' });
  }
}

/**
 * requireSuperAdmin — 要求超管权限
 */
function requireSuperAdmin(req, res, next) {
  requireAuth(req, res, () => {
    if (!req.user.is_super_admin) {
      return res.status(403).json({ error: 'FORBIDDEN' });
    }
    next();
  });
}

module.exports = { signToken, setAuthCookie, clearAuthCookie, requireAuth, requireSuperAdmin };
