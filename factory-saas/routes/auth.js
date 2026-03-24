'use strict';
const express = require('express');
const bcrypt  = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const { stmts }  = require('../db');
const { signToken, setAuthCookie, clearAuthCookie, requireAuth } = require('../middleware/auth');
const config = require('../config');

// GET /login
router.get('/login', (req, res) => res.sendFile(require('path').join(__dirname, '..', 'public', 'login.html')));

// GET /register
router.get('/register', (req, res) => res.sendFile(require('path').join(__dirname, '..', 'public', 'register.html')));

// POST /api/auth/login
router.post('/api/auth/login', (req, res) => {
  const { email, password } = req.body || {};
  if (!email || !password) return res.status(400).json({ error: 'MISSING_FIELDS' });

  const user = stmts.getUserByEmail.get(email.trim().toLowerCase());
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: 'INVALID_CREDENTIALS', message: '邮箱或密码错误' });
  }
  if (user.status === 'suspended') {
    return res.status(403).json({ error: 'SUSPENDED', message: '账号已被暂停，请联系客服' });
  }

  stmts.updateUserLogin.run(Date.now(), user.id);
  const token = signToken({ userId: user.id, isSuperAdmin: !!user.is_super_admin });
  setAuthCookie(res, token);

  res.json({
    success: true,
    user: { id: user.id, email: user.email, name: user.name, isSuperAdmin: !!user.is_super_admin },
    redirect: user.is_super_admin ? '/admin' : '/dashboard',
  });
});

// POST /api/auth/register
router.post('/api/auth/register', (req, res) => {
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

  // 自动创建首个订阅（7天试用）
  const subId    = uuidv4();
  const now      = Date.now();
  const trialEnd = now + config.pricing.trialDays * 86400000;
  stmts.insertSub.run(subId, userId, (areaName || '我的厂区').trim().slice(0, 50), now, trialEnd, now);

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
