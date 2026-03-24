'use strict';
const express = require('express');
const path    = require('path');
const router  = express.Router();

const { stmts, isSubscriptionActive, refreshSubStatus, db } = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const config = require('../config');

// ── 超管页面 ─────────────────────────────────────────────────

router.get('/admin', requireSuperAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ── 用户管理 ─────────────────────────────────────────────────

router.get('/api/admin/users', requireSuperAdmin, (req, res) => {
  const users = stmts.listUsers.all().map(u => {
    const subs = stmts.getSubsByUser.all(u.id).map(s => { refreshSubStatus(s); return s; });
    return { ...u, subscriptions: subs };
  });
  res.json(users);
});

router.post('/api/admin/users/:id/status', requireSuperAdmin, (req, res) => {
  const { status } = req.body || {};
  if (!['active', 'suspended'].includes(status)) return res.status(400).json({ error: 'INVALID_STATUS' });
  stmts.updateUserStatus.run(status, req.params.id);
  res.json({ success: true });
});

// ── 订阅管理 ─────────────────────────────────────────────────

router.get('/api/admin/subscriptions', requireSuperAdmin, (req, res) => {
  const subs = stmts.listAllSubs.all().map(s => {
    refreshSubStatus(s);
    return { ...s, isActive: isSubscriptionActive(s) };
  });
  res.json(subs);
});

// 手动修改订阅方案（管理员直接激活，不经支付流程）
router.post('/api/admin/subscriptions/:id/activate', requireSuperAdmin, (req, res) => {
  const { plan, months } = req.body || {};
  if (!['monthly', 'yearly'].includes(plan)) return res.status(400).json({ error: 'INVALID_PLAN' });
  const sub = stmts.getSubById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });

  const now   = Date.now();
  const start = sub.status === 'active' && sub.paid_ends_at > now ? sub.paid_ends_at : now;
  const days  = plan === 'monthly' ? 30 * (months || 1) : 365;
  const end   = start + days * 86400000;

  stmts.updateSubPlan.run(plan, start, end, sub.id);
  res.json({ success: true, paidStartsAt: start, paidEndsAt: end });
});

router.post('/api/admin/subscriptions/:id/unbind-ip', requireSuperAdmin, (req, res) => {
  stmts.unbindSubIp.run(req.params.id);
  res.json({ success: true });
});

router.post('/api/admin/subscriptions/:id/cancel', requireSuperAdmin, (req, res) => {
  stmts.updateSubStatus.run('cancelled', req.params.id);
  res.json({ success: true });
});

// ── 支付管理 ─────────────────────────────────────────────────

router.get('/api/admin/payments/pending', requireSuperAdmin, (req, res) => {
  res.json(stmts.listPendingPayments.all());
});

router.post('/api/admin/payments/:id/confirm', requireSuperAdmin, (req, res) => {
  const payment = stmts.getPaymentById.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'NOT_FOUND' });
  if (payment.status !== 'pending') return res.status(409).json({ error: 'ALREADY_PROCESSED' });

  // 确认支付并激活订阅
  stmts.confirmPayment.run(Date.now(), req.user.id, payment.id);

  const sub   = stmts.getSubById.get(payment.subscription_id);
  const now   = Date.now();
  const start = sub && sub.status === 'active' && sub.paid_ends_at > now ? sub.paid_ends_at : now;
  const days  = payment.plan === 'monthly' ? 30 : 365;
  const end   = start + days * 86400000;
  stmts.updateSubPlan.run(payment.plan, start, end, payment.subscription_id);

  res.json({ success: true });
});

router.post('/api/admin/payments/:id/reject', requireSuperAdmin, (req, res) => {
  const { reason } = req.body || {};
  const payment = stmts.getPaymentById.get(req.params.id);
  if (!payment) return res.status(404).json({ error: 'NOT_FOUND' });
  stmts.rejectPayment.run(Date.now(), req.user.id, reason || '', payment.id);
  res.json({ success: true });
});

// ── 系统统计 ─────────────────────────────────────────────────

router.get('/api/admin/stats', requireSuperAdmin, (req, res) => {
  const totalUsers    = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_super_admin=0').get().c;
  const activeSubsCnt = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status IN ('trial','active')").get().c;
  const pendingPayCnt = db.prepare("SELECT COUNT(*) as c FROM payments WHERE status='pending'").get().c;
  const revenueRow    = db.prepare("SELECT SUM(amount_fen) as s FROM payments WHERE status='confirmed'").get();
  const monthlyRevRow = db.prepare(`
    SELECT SUM(amount_fen) as s FROM payments
    WHERE status='confirmed' AND confirmed_at > ?
  `).get(Date.now() - 30 * 86400000);

  res.json({
    totalUsers,
    activeSubsCnt,
    pendingPayCnt,
    totalRevenueFen:   revenueRow.s || 0,
    monthlyRevenueFen: monthlyRevRow.s || 0,
  });
});

module.exports = router;
