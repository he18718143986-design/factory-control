'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const router  = express.Router();

const { stmts, isSubscriptionActive, refreshSubStatus, db, logAudit } = require('../db');
const { requireSuperAdmin } = require('../middleware/auth');
const { adminWriteLimiter, paymentReviewLimiter, rebindReviewLimiter } = require('../middleware/rateLimit');
const { getClientIp, ipToSubnet, isValidIPv4 } = require('../utils/network');
const config = require('../config');

function inferResumeSubscriptionStatus(sub, now = Date.now()) {
  if (sub.trial_ends_at && now <= sub.trial_ends_at) {
    return { nextStatus: 'trial', graceEndsAt: null };
  }
  if (sub.paid_ends_at && now <= sub.paid_ends_at) {
    return { nextStatus: 'active', graceEndsAt: null };
  }
  if (config.subscription.enableGracePeriod && sub.paid_ends_at) {
    const graceEndsAt = sub.grace_ends_at || (sub.paid_ends_at + config.subscription.graceDays * 86400000);
    if (now <= graceEndsAt) {
      return { nextStatus: 'grace', graceEndsAt };
    }
  }
  return { nextStatus: 'expired', graceEndsAt: null };
}

function cleanStr(v, max = 120) {
  return String(v || '').trim().slice(0, max);
}

function normalizeMac(v) {
  const s = cleanStr(v, 32).replace(/-/g, ':').toLowerCase();
  if (!s) return '';
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) return '';
  return s;
}

function normalizeBindingFingerprint(raw, fallbackSubnet, fallbackIp) {
  const fp = raw && typeof raw === 'object' ? raw : {};
  const publicIp = cleanStr(fp.publicIp || fallbackIp || '', 64);
  const gatewayIp = cleanStr(fp.gatewayIp || '', 64);
  const subnet = cleanStr(fp.lanSubnet || fp.subnet || fallbackSubnet || '', 64)
    || (isValidIPv4(gatewayIp) ? ipToSubnet(gatewayIp) : '')
    || (isValidIPv4(publicIp) ? ipToSubnet(publicIp) : '');
  const confidenceRaw = Number(fp.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(100, Math.round(confidenceRaw))) : 0;
  return {
    lanSubnet: subnet,
    publicIp,
    ssid: cleanStr(fp.ssid || '', 80),
    bssid: normalizeMac(fp.bssid || ''),
    gatewayIp,
    gatewayMac: normalizeMac(fp.gatewayMac || ''),
    source: cleanStr(fp.source || 'rebind_approved', 40) || 'rebind_approved',
    confidence,
  };
}

function parseFingerprintJson(raw) {
  if (!raw) return {};
  if (typeof raw === 'object') return raw;
  try {
    const parsed = JSON.parse(String(raw));
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

// ── 超管页面 ─────────────────────────────────────────────────

router.get('/admin', requireSuperAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'admin.html'));
});

// ── 审计日志 ─────────────────────────────────────────────────

router.get('/api/admin/audit-logs', requireSuperAdmin, (req, res) => {
  const limit = Math.min(200, Math.max(1, Number(req.query.limit) || 50));
  const offset = Math.max(0, Number(req.query.offset) || 0);
  const action = String(req.query.action || '').trim();
  const siteId = String(req.query.siteId || '').trim();
  const actorUserId = String(req.query.actorUserId || '').trim();
  const q = String(req.query.q || '').trim();

  const filters = [];
  const params = { limit, offset };

  if (action) {
    filters.push('a.action = @action');
    params.action = action;
  }
  if (siteId) {
    filters.push('a.site_id = @siteId');
    params.siteId = siteId;
  }
  if (actorUserId) {
    filters.push('a.actor_user_id = @actorUserId');
    params.actorUserId = actorUserId;
  }
  if (q) {
    filters.push(`(
      a.action LIKE @q OR
      a.target_type LIKE @q OR
      a.target_id LIKE @q OR
      IFNULL(a.payload_json, '') LIKE @q OR
      IFNULL(u.email, '') LIKE @q OR
      IFNULL(u.name, '') LIKE @q OR
      IFNULL(s.name, '') LIKE @q
    )`);
    params.q = `%${q}%`;
  }

  const whereSql = filters.length ? `WHERE ${filters.join(' AND ')}` : '';
  const items = db.prepare(`
    SELECT
      a.*,
      u.email AS actor_email,
      u.name AS actor_name,
      s.name AS site_name
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    LEFT JOIN sites s ON s.id = a.site_id
    ${whereSql}
    ORDER BY a.created_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  const total = db.prepare(`
    SELECT COUNT(*) AS c
    FROM audit_logs a
    LEFT JOIN users u ON u.id = a.actor_user_id
    LEFT JOIN sites s ON s.id = a.site_id
    ${whereSql}
  `).get(params).c;

  res.json({
    items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  });
});

// ── 用户管理 ─────────────────────────────────────────────────

router.get('/api/admin/users', requireSuperAdmin, (req, res) => {
  const users = stmts.listUsers.all().map(u => {
    const subs = stmts.getSubsByUser.all(u.id).map(s => { refreshSubStatus(s); return s; });
    return { ...u, subscriptions: subs };
  });
  res.json(users);
});

router.post('/api/admin/users/:id/status', requireSuperAdmin, adminWriteLimiter, (req, res) => {
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
router.post('/api/admin/subscriptions/:id/activate', requireSuperAdmin, adminWriteLimiter, (req, res) => {
  const { plan, months } = req.body || {};
  if (!['monthly', 'yearly'].includes(plan)) return res.status(400).json({ error: 'INVALID_PLAN' });
  const sub = stmts.getSubById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });

  const now   = Date.now();
  const start = sub.status === 'active' && sub.paid_ends_at > now ? sub.paid_ends_at : now;
  const days  = plan === 'monthly' ? 30 * (months || 1) : 365;
  const end   = start + days * 86400000;

  stmts.updateSubPlan.run(plan, start, end, Date.now(), sub.id);
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: sub.site_id || null,
    action: 'SUBSCRIPTION_ACTIVATED',
    targetType: 'subscription',
    targetId: sub.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { plan, months: months || 1, paidStartsAt: start, paidEndsAt: end },
  });
  res.json({ success: true, paidStartsAt: start, paidEndsAt: end });
});

router.post('/api/admin/subscriptions/:id/unbind-ip', requireSuperAdmin, adminWriteLimiter, (req, res) => {
  const sub = stmts.getSubById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });
  stmts.unbindSubIp.run(req.params.id);
  if (sub.site_id) stmts.revokeSiteBindingsBySite.run(Date.now(), sub.site_id);
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: sub.site_id || null,
    action: 'SUBSCRIPTION_IP_UNBOUND',
    targetType: 'subscription',
    targetId: sub.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { subscriptionId: sub.id },
  });
  res.json({ success: true });
});

router.post('/api/admin/subscriptions/:id/cancel', requireSuperAdmin, adminWriteLimiter, (req, res) => {
  const sub = stmts.getSubById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });
  stmts.updateSubStatus.run('cancelled', 'cancelled', req.params.id);
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: sub.site_id || null,
    action: 'SUBSCRIPTION_CANCELLED',
    targetType: 'subscription',
    targetId: sub.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { status: 'cancelled' },
  });
  res.json({ success: true });
});

router.post('/api/admin/subscriptions/:id/suspend', requireSuperAdmin, adminWriteLimiter, (req, res) => {
  const sub = stmts.getSubById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });
  if (sub.status === 'cancelled') {
    return res.status(409).json({ error: 'CANNOT_SUSPEND_CANCELLED' });
  }
  if (sub.status === 'suspended') {
    return res.json({ success: true, idempotent: true, status: 'suspended' });
  }

  stmts.updateSubStatus.run('suspended', 'suspended', sub.id);
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: sub.site_id || null,
    action: 'SUBSCRIPTION_SUSPENDED',
    targetType: 'subscription',
    targetId: sub.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { fromStatus: sub.status, toStatus: 'suspended' },
  });
  res.json({ success: true, status: 'suspended' });
});

router.post('/api/admin/subscriptions/:id/resume', requireSuperAdmin, adminWriteLimiter, (req, res) => {
  const sub = stmts.getSubById.get(req.params.id);
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });
  if (sub.status === 'cancelled') return res.status(409).json({ error: 'CANNOT_RESUME_CANCELLED' });
  if (sub.status !== 'suspended') {
    return res.status(409).json({ error: 'INVALID_STATE', status: sub.status });
  }

  const now = Date.now();
  const { nextStatus, graceEndsAt } = inferResumeSubscriptionStatus(sub, now);
  const tx = db.transaction(() => {
    stmts.updateSubStatus.run(nextStatus, nextStatus, sub.id);
    if (nextStatus === 'grace') {
      db.prepare('UPDATE subscriptions SET grace_ends_at = ?, updated_at = ? WHERE id = ?').run(graceEndsAt, now, sub.id);
    } else if (nextStatus === 'active') {
      db.prepare('UPDATE subscriptions SET grace_ends_at = NULL, updated_at = ? WHERE id = ?').run(now, sub.id);
    }
  });
  tx();

  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: sub.site_id || null,
    action: 'SUBSCRIPTION_RESUMED',
    targetType: 'subscription',
    targetId: sub.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { fromStatus: 'suspended', toStatus: nextStatus, graceEndsAt: graceEndsAt || null },
  });
  res.json({ success: true, status: nextStatus, graceEndsAt: graceEndsAt || null });
});

// ── 网络重绑定审批 ───────────────────────────────────────────

router.get('/api/admin/network-rebind-requests', requireSuperAdmin, (req, res) => {
  const status = ((req.query.status || '').trim() || '');
  const allowed = new Set(['', 'pending_review', 'approved', 'rejected', 'cancelled']);
  if (!allowed.has(status)) return res.status(400).json({ error: 'INVALID_STATUS' });
  const rows = stmts.listRebindRequestsForAdmin.all(status, status).map(row => ({
    ...row,
    candidate_fingerprint: parseFingerprintJson(row.candidate_fingerprint_json),
    is_high_risk: Number(row.risk_score || 0) >= config.rebind.highRiskScore,
  }));
  res.json(rows);
});

router.post('/api/admin/network-rebind-requests/:id/approve', requireSuperAdmin, rebindReviewLimiter, (req, res) => {
  const request = stmts.getRebindRequestById.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'NOT_FOUND' });
  if (request.status !== 'pending_review') return res.status(409).json({ error: 'ALREADY_PROCESSED' });

  const site = stmts.getSiteById.get(request.site_id);
  if (!site) return res.status(404).json({ error: 'SITE_NOT_FOUND' });

  const note = (req.body?.note || '审批通过').trim().slice(0, 300);
  const requestFp = parseFingerprintJson(request.candidate_fingerprint_json || '{}');
  const overrideFpRaw = req.body?.bindingFingerprint && typeof req.body.bindingFingerprint === 'object'
    ? req.body.bindingFingerprint
    : null;
  const forceApprove = !!req.body?.forceApprove;
  const isHighRisk = Number(request.risk_score || 0) >= config.rebind.highRiskScore;
  if (isHighRisk && !forceApprove) {
    return res.status(409).json({
      error: 'HIGH_RISK_REQUIRES_FORCE_APPROVE',
      message: '该申请风险较高，请显式确认 forceApprove 后再通过',
      riskScore: request.risk_score || 0,
      threshold: config.rebind.highRiskScore,
    });
  }
  if (isHighRisk && note.length < config.rebind.minEvidenceForHighRisk) {
    return res.status(400).json({
      error: 'REVIEW_NOTE_REQUIRED',
      message: `高风险审批备注至少 ${config.rebind.minEvidenceForHighRisk} 字符`,
      riskScore: request.risk_score || 0,
    });
  }
  const candidate = normalizeBindingFingerprint(
    overrideFpRaw || requestFp,
    request.candidate_subnet,
    request.candidate_ip || ''
  );
  if (!candidate.lanSubnet) {
    return res.status(400).json({ error: 'INVALID_CANDIDATE_FINGERPRINT', message: '审批绑定缺少可用子网信息' });
  }
  if (!candidate.publicIp) candidate.publicIp = request.candidate_ip || '';
  const now = Date.now();

  const tx = db.transaction(() => {
    stmts.revokeSiteBindingsBySite.run(now, request.site_id);
    stmts.insertSiteBinding.run(
      uuidv4(),
      request.site_id,
      candidate.lanSubnet,
      candidate.publicIp || '',
      candidate.ssid,
      candidate.bssid,
      candidate.gatewayIp,
      candidate.gatewayMac,
      candidate.confidence,
      candidate.source,
      now,
      now,
      now,
      now
    );
    stmts.bindSubIpBySite.run(candidate.lanSubnet, request.site_id);
    stmts.updateRebindRequestApprove.run(note, req.user.id, now, now, request.id);
  });
  tx();
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: request.site_id,
    action: 'NETWORK_REBIND_APPROVED',
    targetType: 'network_rebind_request',
    targetId: request.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: {
      candidateSubnet: candidate.lanSubnet,
      candidateIp: candidate.publicIp || '',
      ssid: candidate.ssid,
      bssid: candidate.bssid,
      gatewayIp: candidate.gatewayIp,
      gatewayMac: candidate.gatewayMac,
      confidence: candidate.confidence,
      source: candidate.source,
      riskScore: request.risk_score || 0,
      evidence: request.evidence || '',
      forceApprove,
    },
  });

  res.json({
    success: true,
    requestId: request.id,
    status: 'approved',
    siteId: request.site_id,
    appliedFingerprint: candidate,
  });
});

router.post('/api/admin/network-rebind-requests/:id/reject', requireSuperAdmin, rebindReviewLimiter, (req, res) => {
  const request = stmts.getRebindRequestById.get(req.params.id);
  if (!request) return res.status(404).json({ error: 'NOT_FOUND' });
  if (request.status !== 'pending_review') return res.status(409).json({ error: 'ALREADY_PROCESSED' });

  const now = Date.now();
  const note = (req.body?.reason || req.body?.note || '审批拒绝').trim().slice(0, 300);
  stmts.updateRebindRequestReject.run(note, req.user.id, now, now, request.id);
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: request.site_id,
    action: 'NETWORK_REBIND_REJECTED',
    targetType: 'network_rebind_request',
    targetId: request.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: {
      reason: note,
      candidateSubnet: request.candidate_subnet,
      riskScore: request.risk_score || 0,
      evidence: request.evidence || '',
    },
  });
  res.json({ success: true, requestId: request.id, status: 'rejected' });
});

// ── 订单管理（P1-3） ─────────────────────────────────────────

router.get('/api/admin/orders', requireSuperAdmin, (req, res) => {
  const status = String(req.query.status || '').trim();
  const allowed = new Set(['', 'pending_payment', 'paid_pending_review', 'confirmed', 'rejected', 'cancelled', 'expired']);
  if (!allowed.has(status)) return res.status(400).json({ error: 'INVALID_STATUS' });
  const rows = stmts.listOrdersForAdmin.all(status, status);
  res.json(rows);
});

router.post('/api/admin/orders/:id/confirm', requireSuperAdmin, paymentReviewLimiter, (req, res) => {
  const orderId = req.params.id;
  const now = Date.now();
  try {
    const result = db.transaction(() => {
      const order = stmts.getOrderById.get(orderId);
      if (!order) return { notFound: true };
      if (order.status === 'confirmed') return { idempotent: true, order };
      if (order.status !== 'paid_pending_review') return { invalid: true, status: order.status };

      const sub = stmts.getSubById.get(order.subscription_id);
      if (!sub) return { subMissing: true };

      const start = sub.status === 'active' && sub.paid_ends_at > now ? sub.paid_ends_at : now;
      const end = start + Number(order.duration_days || 0) * 86400000;
      const plan = ['monthly', 'yearly'].includes(order.plan_code) ? order.plan_code : (order.duration_days >= 365 ? 'yearly' : 'monthly');

      stmts.updateSubPlan.run(plan, start, end, now, sub.id);
      const mark = stmts.markOrderConfirmed.run(now, req.user.id, now, order.id);
      if (mark.changes === 0) return { race: true };
      return { success: true, paidStartsAt: start, paidEndsAt: end, order };
    })();

    if (result.notFound) return res.status(404).json({ error: 'NOT_FOUND' });
    if (result.subMissing) return res.status(409).json({ error: 'SUBSCRIPTION_NOT_FOUND' });
    if (result.invalid) return res.status(409).json({ error: 'INVALID_ORDER_STATUS', status: result.status });
    if (result.race) return res.status(409).json({ error: 'ALREADY_PROCESSED' });
    if (result.idempotent) return res.json({ success: true, idempotent: true });

    logAudit({
      actorUserId: req.user.id,
      actorRole: 'super_admin',
      siteId: result.order.site_id || null,
      action: 'ORDER_CONFIRMED',
      targetType: 'order',
      targetId: orderId,
      ip: getClientIp(req),
      ua: req.get('user-agent') || '',
      payload: { paidStartsAt: result.paidStartsAt, paidEndsAt: result.paidEndsAt },
    });
    return res.json({ success: true, idempotent: false, paidStartsAt: result.paidStartsAt, paidEndsAt: result.paidEndsAt });
  } catch {
    return res.status(500).json({ error: 'INTERNAL_ERROR' });
  }
});

router.post('/api/admin/orders/:id/reject', requireSuperAdmin, paymentReviewLimiter, (req, res) => {
  const orderId = req.params.id;
  const reason = String(req.body?.reason || '').trim();
  const order = stmts.getOrderById.get(orderId);
  if (!order) return res.status(404).json({ error: 'NOT_FOUND' });
  if (order.status !== 'paid_pending_review') {
    return res.status(409).json({ error: 'INVALID_ORDER_STATUS', status: order.status });
  }
  const now = Date.now();
  const mark = stmts.markOrderRejected.run(reason, req.user.id, now, now, order.id);
  if (mark.changes === 0) {
    const latest = stmts.getOrderById.get(order.id);
    return res.status(409).json({ error: 'ALREADY_PROCESSED', status: latest?.status || 'unknown' });
  }
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    siteId: order.site_id || null,
    action: 'ORDER_REJECTED',
    targetType: 'order',
    targetId: order.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { reason },
  });
  return res.json({ success: true });
});

// ── 支付管理 ─────────────────────────────────────────────────

router.get('/api/admin/payments/pending', requireSuperAdmin, (req, res) => {
  // 只读兼容：从 orders 的 paid_pending_review 映射旧 payment 视图
  const rows = stmts.listOrdersForAdmin.all('paid_pending_review', 'paid_pending_review').map(o => ({
    id: o.id,
    user_id: o.user_id,
    subscription_id: o.subscription_id,
    email: o.email,
    user_name: o.user_name,
    area_name: o.site_name || o.area_name || '',
    plan: o.plan_code,
    amount_fen: o.amount_fen,
    txn_id: o.txn_id || '',
    notes: o.note || '',
    created_at: o.created_at,
    status: 'pending',
    source: 'orders',
    deprecated: true,
  }));
  res.set('X-API-Deprecated', 'true');
  res.set('X-API-Replacement', '/api/admin/orders?status=paid_pending_review');
  res.json(rows);
});

router.post('/api/admin/payments/:id/confirm', requireSuperAdmin, paymentReviewLimiter, (req, res) => {
  const paymentId = req.params.id;
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    action: 'PAYMENT_ENDPOINT_WRITE_DEPRECATED',
    targetType: 'payment',
    targetId: paymentId,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { method: 'POST', path: '/api/admin/payments/:id/confirm', replacement: '/api/admin/orders/:id/confirm' },
  });
  res.status(410).json({
    error: 'ENDPOINT_DEPRECATED',
    message: '旧支付写接口已下线，请改用订单审核接口',
    replacement: '/api/admin/orders/:id/confirm',
  });
});

router.post('/api/admin/payments/:id/reject', requireSuperAdmin, paymentReviewLimiter, (req, res) => {
  const paymentId = req.params.id;
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'super_admin',
    action: 'PAYMENT_ENDPOINT_WRITE_DEPRECATED',
    targetType: 'payment',
    targetId: paymentId,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { method: 'POST', path: '/api/admin/payments/:id/reject', replacement: '/api/admin/orders/:id/reject' },
  });
  res.status(410).json({
    error: 'ENDPOINT_DEPRECATED',
    message: '旧支付写接口已下线，请改用订单审核接口',
    replacement: '/api/admin/orders/:id/reject',
  });
});

// ── 系统统计 ─────────────────────────────────────────────────

router.get('/api/admin/stats', requireSuperAdmin, (req, res) => {
  const totalUsers    = db.prepare('SELECT COUNT(*) as c FROM users WHERE is_super_admin=0').get().c;
  const activeSubsCnt = db.prepare("SELECT COUNT(*) as c FROM subscriptions WHERE status IN ('trial','active')").get().c;
  const pendingPayCnt = db.prepare("SELECT COUNT(*) as c FROM orders WHERE status='paid_pending_review'").get().c;
  const revenueRow    = db.prepare("SELECT SUM(amount_fen) as s FROM orders WHERE status='confirmed'").get();
  const monthlyRevRow = db.prepare(`
    SELECT SUM(amount_fen) as s FROM orders
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
