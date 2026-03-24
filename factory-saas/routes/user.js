'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const path    = require('path');

const { stmts, isSubscriptionActive, refreshSubStatus, subRemainingDays, db } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireActiveSubscription } = require('../middleware/subscription');
const { getClientIp, ipToSubnet } = require('../utils/network');
const config = require('../config');

// ── 页面 ─────────────────────────────────────────────────────

router.get('/dashboard', requireAuth, (req, res) => {
  if (req.user.is_super_admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ── 订阅管理 API ─────────────────────────────────────────────

// GET /api/user/subscriptions — 当前用户所有订阅
router.get('/api/user/subscriptions', requireAuth, (req, res) => {
  const subs = stmts.getSubsByUser.all(req.user.id).map(s => {
    refreshSubStatus(s);
    return {
      ...s,
      isActive:      isSubscriptionActive(s),
      remainingDays: subRemainingDays(s),
    };
  });
  res.json(subs);
});

// POST /api/user/subscriptions — 新增订阅（多厂区）
router.post('/api/user/subscriptions', requireAuth, (req, res) => {
  const { areaName } = req.body || {};
  const subId    = uuidv4();
  const now      = Date.now();
  const trialEnd = now + config.pricing.trialDays * 86400000;
  stmts.insertSub.run(subId, req.user.id, (areaName || '新厂区').trim().slice(0, 50), now, trialEnd, now);
  res.json({ success: true, subscriptionId: subId });
});

// PUT /api/user/subscriptions/:subId/area — 修改厂区名称
router.put('/api/user/subscriptions/:subId/area', requireAuth, (req, res) => {
  const sub = stmts.getSubById.get(req.params.subId);
  if (!sub || sub.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const name = (req.body.areaName || '').trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: 'EMPTY_NAME' });
  stmts.updateSubAreaName.run(name, sub.id);
  res.json({ success: true });
});

// POST /api/user/subscriptions/:subId/bind-ip — 绑定当前 WiFi IP
router.post('/api/user/subscriptions/:subId/bind-ip', requireAuth, (req, res) => {
  const sub = stmts.getSubById.get(req.params.subId);
  if (!sub || sub.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  refreshSubStatus(sub);
  if (!isSubscriptionActive(sub)) return res.status(402).json({ error: 'SUBSCRIPTION_EXPIRED' });

  const ip = getClientIp(req);
  const subnet = ipToSubnet(ip);
  if (!subnet) return res.status(400).json({ error: 'INVALID_IP', clientIp: ip });

  stmts.bindSubIp.run(subnet, sub.id);
  res.json({ success: true, wifiSubnet: subnet });
});

// POST /api/user/subscriptions/:subId/unbind-ip — 解绑（需超管确认，普通用户不能自己解绑）
router.post('/api/user/subscriptions/:subId/unbind-ip', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: '解绑 WiFi 需联系管理员' });
  }
  stmts.unbindSubIp.run(req.params.subId);
  res.json({ success: true });
});

// ── 支付流程 ─────────────────────────────────────────────────

// GET /api/user/payments — 当前用户支付记录
router.get('/api/user/payments', requireAuth, (req, res) => {
  const payments = stmts.getPaymentsByUser.all(req.user.id);
  res.json(payments);
});

// POST /api/user/payments — 提交支付申请
router.post('/api/user/payments', requireAuth, (req, res) => {
  const { subscriptionId, plan, txnId, notes } = req.body || {};
  if (!subscriptionId || !plan) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (!['monthly', 'yearly'].includes(plan)) return res.status(400).json({ error: 'INVALID_PLAN' });

  const sub = stmts.getSubById.get(subscriptionId);
  if (!sub || sub.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });

  const amountFen = plan === 'monthly' ? config.pricing.monthlyFen : config.pricing.yearlyFen;
  const payId = uuidv4();
  stmts.insertPayment.run(payId, req.user.id, subscriptionId, plan, amountFen, txnId || '', notes || '', Date.now());

  res.json({ success: true, paymentId: payId, amountFen, amountYuan: (amountFen / 100).toFixed(2) });
});

// GET /api/user/payment-info — 收款信息（供用户转账）
router.get('/api/user/payment-info', requireAuth, (req, res) => {
  res.json({
    alipay:     config.payment.alipay,
    wechat:     config.payment.wechat,
    bankName:   config.payment.bankName,
    bankAccount:config.payment.bankAccount,
    bankHolder: config.payment.bankHolder,
    prices: {
      monthly:     config.pricing.monthlyFen,
      yearly:      config.pricing.yearlyFen,
      monthlyYuan: (config.pricing.monthlyFen / 100).toFixed(2),
      yearlyYuan:  (config.pricing.yearlyFen  / 100).toFixed(2),
    },
  });
});

// GET /api/user/profile
router.get('/api/user/profile', requireAuth, (req, res) => {
  const u = req.user;
  res.json({ id: u.id, email: u.email, name: u.name, phone: u.phone, createdAt: u.created_at });
});

module.exports = router;
