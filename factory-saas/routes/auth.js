'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const { stmts, createSiteWithTrialSubscription, logAudit }  = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const { loginLimiter, registerLimiter } = require('../middleware/rateLimit');
const { getClientIp } = require('../utils/network');
const config = require('../config');

// GET /account (account management page)
router.get('/account', require('../middleware/auth').requireAuth, (req, res) => {
  if (req.user.is_super_admin) return res.redirect('/admin');
  res.sendFile(require('path').join(__dirname, '..', 'public', 'account.html'));
});

// GET /login
router.get('/login', (req, res) => res.sendFile(require('path').join(__dirname, '..', 'public', 'login.html')));

// GET /register
router.get('/register', (req, res) => res.sendFile(require('path').join(__dirname, '..', 'public', 'register.html')));

// POST /api/auth/login
router.post('/api/auth/login', loginLimiter, (req, res) => {
  const { email, password } = req.body || {};
  const emailLc = String(email || '').trim().toLowerCase();
  const ip = getClientIp(req);
  const ua = req.get('user-agent') || '';
  if (!email || !password) return res.status(400).json({ error: 'MISSING_FIELDS' });

  const user = stmts.getUserByEmail.get(emailLc);
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    logAudit({
      actorRole: 'anonymous',
      action: 'AUTH_LOGIN_FAILED',
      targetType: 'user',
      targetId: emailLc || 'unknown',
      ip,
      ua,
      payload: { reason: 'invalid_credentials' },
    });
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' });
  }
  if (user.status === 'suspended') {
    logAudit({
      actorUserId: user.id,
      actorRole: user.is_super_admin ? 'super_admin' : 'user',
      action: 'AUTH_LOGIN_BLOCKED',
      targetType: 'user',
      targetId: user.id,
      ip,
      ua,
      payload: { reason: 'suspended' },
    });
    return res.status(403).json({ error: 'SUSPENDED', message: '账号已被暂停，请联系客服' });
  }

  stmts.updateUserLogin.run(Date.now(), user.id);
  const token = signToken({ userId: user.id, isSuperAdmin: !!user.is_super_admin });
  setAuthCookie(res, token);
  logAudit({
    actorUserId: user.id,
    actorRole: user.is_super_admin ? 'super_admin' : 'user',
    action: 'AUTH_LOGIN_SUCCESS',
    targetType: 'user',
    targetId: user.id,
    ip,
    ua,
    payload: { email: user.email },
  });

  res.json({
    success: true,
    user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: !!user.is_super_admin },
    redirect: user.is_super_admin ? '/admin' : '/dashboard',
  });
});

// POST /api/auth/register
router.post('/api/auth/register', registerLimiter, (req, res) => {
  const { email, password, name, areaName } = req.body || {};
  if (!email || !password || !name) {
    return res.status(400).json({ error: 'MISSING_FIELDS', message: '姓名、邮箱和密码均为必填' });
  }
  if (password.length < 8) {
    return res.status(400).json({ error: 'WEAK_PASSWORD', message: '密码至少 8 位' });
  }

  const emailLc = email.trim().toLowerCase();
  if (stmts.getUserByEmail.get(emailLc)) {
    return res.status(409).json({ error: 'EMAIL_TAKEN', message: '该邮箱已注册' });
  }

  const userId = uuidv4();
  const hash   = bcrypt.hashSync(password, 10);
  stmts.insertUser.run(userId, emailLc, hash, name.trim().slice(0, 50), '', Date.now());

  // 自动创建首个厂区 + 试用订阅（7天）
  createSiteWithTrialSubscription({
    userId,
    siteName: areaName || '我的厂区',
    trialDays: config.pricing.trialDays,
  });

  const token = signToken({ userId, isSuperAdmin: false });
  setAuthCookie(res, token);
  res.json({ success: true, redirect: '/dashboard' });
});

// POST /api/auth/logout
router.post('/api/auth/logout', (req, res) => {
  clearAuthCookie(res);
  res.json({ success: true });
});

// GET /api/auth/me
router.get('/api/auth/me', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, email: u.email, name: u.name, isSuperAdmin: !!u.is_super_admin });
});

module.exports = router;
