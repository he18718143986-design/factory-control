'use strict';
const express = require('express');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();
const path    = require('path');

const { stmts, isSubscriptionActive, refreshSubStatus, subRemainingDays, createSiteWithTrialSubscription, canSubmitPayment, canRequestNetworkRebind, logAudit } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { getClientIp, ipToSubnet, isValidIPv4 } = require('../utils/network');
const config = require('../config');

function cleanStr(v, max = 120) {
  return String(v || '').trim().slice(0, max);
}

function normalizeMac(v) {
  const s = cleanStr(v, 32).replace(/-/g, ':').toLowerCase();
  if (!s) return '';
  if (!/^[0-9a-f]{2}(:[0-9a-f]{2}){5}$/.test(s)) return '';
  return s;
}

function normalizeCandidateFingerprint(raw, fallbackIp) {
  const fp = raw && typeof raw === 'object' ? raw : {};
  const publicIp = cleanStr(fp.publicIp || fallbackIp || '', 64);
  const gatewayIp = cleanStr(fp.gatewayIp || '', 64);
  const subnet =
    cleanStr(fp.lanSubnet || fp.subnet || '', 64) ||
    (isValidIPv4(gatewayIp) ? ipToSubnet(gatewayIp) : '') ||
    (isValidIPv4(publicIp) ? ipToSubnet(publicIp) : '');

  const confidenceRaw = Number(fp.confidence);
  const confidence = Number.isFinite(confidenceRaw) ? Math.max(0, Math.min(100, Math.round(confidenceRaw))) : 0;

  return {
    lanSubnet: subnet,
    publicIp,
    ssid: cleanStr(fp.ssid || '', 80),
    bssid: normalizeMac(fp.bssid || ''),
    gatewayIp,
    gatewayMac: normalizeMac(fp.gatewayMac || ''),
    source: cleanStr(fp.source || 'user_reported', 40) || 'user_reported',
    confidence,
  };
}

function inferRebindRiskScore({ fingerprint, activeBinding }) {
  let score = 20;
  if (!fingerprint.bssid && !fingerprint.gatewayMac) score += 25;
  if (!fingerprint.ssid) score += 10;
  if (fingerprint.confidence > 0 && fingerprint.confidence < 50) score += 15;
  if (activeBinding && activeBinding.lan_subnet && fingerprint.lanSubnet && activeBinding.lan_subnet !== fingerprint.lanSubnet) {
    score += 25;
  }
  return Math.max(0, Math.min(100, score));
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

// ── 页面 ─────────────────────────────────────────────────────

router.get('/dashboard', requireAuth, (req, res) => {
  if (req.user.is_super_admin) return res.redirect('/admin');
  res.sendFile(path.join(__dirname, '..', 'public', 'dashboard.html'));
});

// ── 订阅管理 API ─────────────────────────────────────────────

// GET /api/sites — 当前用户厂区列表
router.get('/api/sites', requireAuth, (req, res) => {
  const sites = stmts.getSitesByUser.all(req.user.id).map(site => {
    const sub = stmts.getSubBySiteId.get(site.id);
    if (!sub) return { ...site, subscription: null };
    refreshSubStatus(sub);
    return {
      ...site,
      subscription: {
        ...sub,
        isActive: isSubscriptionActive(sub),
        remainingDays: subRemainingDays(sub),
      },
    };
  });
  res.json(sites);
});

// POST /api/sites — 创建厂区（自动创建试用订阅）
router.post('/api/sites', requireAuth, (req, res) => {
  const { name, address } = req.body || {};
  const created = createSiteWithTrialSubscription({
    userId: req.user.id,
    siteName: name || '新厂区',
    address: address || '',
    trialDays: config.pricing.trialDays,
  });
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'user',
    siteId: created.siteId,
    action: 'SITE_CREATED',
    targetType: 'site',
    targetId: created.siteId,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: {
      name: cleanStr(name || '新厂区', 50),
      address: cleanStr(address || '', 120),
      subscriptionId: created.subscriptionId,
      trialEndsAt: created.trialEndsAt,
    },
  });
  res.json({ success: true, siteId: created.siteId, subscriptionId: created.subscriptionId });
});

// GET /api/sites/:siteId/network-rebind-requests — 厂区网络重绑申请历史
router.get('/api/sites/:siteId/network-rebind-requests', requireAuth, (req, res) => {
  const site = stmts.getSiteById.get(req.params.siteId);
  if (!site || site.user_id !== req.user.id) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  const rows = stmts.listRebindRequestsBySite.all(site.id).map(row => ({
    ...row,
    candidate_fingerprint: parseFingerprintJson(row.candidate_fingerprint_json),
    is_high_risk: Number(row.risk_score || 0) >= config.rebind.highRiskScore,
  }));
  res.json(rows);
});

// POST /api/sites/:siteId/network-rebind-requests — 发起网络重绑申请
router.post('/api/sites/:siteId/network-rebind-requests', requireAuth, (req, res) => {
  const site = stmts.getSiteById.get(req.params.siteId);
  if (!site || site.user_id !== req.user.id) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  const sub = stmts.getSubBySiteId.get(site.id);
  if (!sub) return res.status(404).json({ error: 'SUBSCRIPTION_NOT_FOUND' });
  refreshSubStatus(sub);
  if (!canRequestNetworkRebind(sub)) {
    return res.status(409).json({
      error: 'SUBSCRIPTION_NOT_ELIGIBLE_FOR_REBIND',
      status: sub.status,
      message: '当前订阅状态不允许发起网络重绑申请',
    });
  }

  const { candidateSubnet, reason, evidence, candidateFingerprint } = req.body || {};
  const clientIp = getClientIp(req);
  const fingerprint = normalizeCandidateFingerprint(candidateFingerprint, clientIp);
  const subnet = cleanStr(candidateSubnet || fingerprint.lanSubnet || ipToSubnet(clientIp) || '', 64);
  if (!subnet) return res.status(400).json({ error: 'INVALID_SUBNET', message: '无法识别候选网络' });
  fingerprint.lanSubnet = subnet;
  if (!fingerprint.publicIp) fingerprint.publicIp = clientIp || '';

  const pending = stmts.getPendingRebindBySiteAndSubnet.get(site.id, subnet);
  if (pending) {
    return res.status(409).json({ error: 'PENDING_REQUEST_EXISTS', requestId: pending.id });
  }

  const activeBinding = stmts.listActiveSiteBindings.all(site.id)[0];
  const riskScore = inferRebindRiskScore({ fingerprint, activeBinding });
  const evidenceText = cleanStr(evidence || '', 500);
  if (riskScore >= config.rebind.highRiskScore && evidenceText.length < config.rebind.minEvidenceForHighRisk) {
    return res.status(400).json({
      error: 'REBIND_EVIDENCE_REQUIRED',
      message: `高风险重绑申请至少需要 ${config.rebind.minEvidenceForHighRisk} 字符证据说明`,
      riskScore,
    });
  }
  const now = Date.now();
  const requestId = uuidv4();
  stmts.insertRebindRequest.run(
    requestId,
    site.id,
    req.user.id,
    subnet,
    fingerprint.publicIp || clientIp || '',
    JSON.stringify(fingerprint),
    evidenceText,
    riskScore,
    (reason || '').trim().slice(0, 300),
    now,
    now
  );
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'user',
    siteId: site.id,
    action: 'NETWORK_REBIND_REQUESTED',
    targetType: 'network_rebind_request',
    targetId: requestId,
    ip: clientIp,
    ua: req.get('user-agent') || '',
    payload: {
      candidateSubnet: subnet,
      candidateIp: fingerprint.publicIp || clientIp || '',
      reason: cleanStr(reason || '', 300),
      evidence: evidenceText,
      riskScore,
      fingerprint,
    },
  });

  res.json({
    success: true,
    requestId,
    status: 'pending_review',
    candidateSubnet: subnet,
    riskScore,
    candidateFingerprint: fingerprint,
  });
});

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
  // 兼容旧前端入口：底层已切换为 site + subscription 一起创建
  const { areaName } = req.body || {};
  const created = createSiteWithTrialSubscription({
    userId: req.user.id,
    siteName: areaName || '新厂区',
    trialDays: config.pricing.trialDays,
  });
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'user',
    siteId: created.siteId,
    action: 'SITE_CREATED',
    targetType: 'site',
    targetId: created.siteId,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: {
      source: 'legacy_subscription_create',
      name: cleanStr(areaName || '新厂区', 50),
      subscriptionId: created.subscriptionId,
      trialEndsAt: created.trialEndsAt,
    },
  });
  res.json({ success: true, siteId: created.siteId, subscriptionId: created.subscriptionId });
});

// PUT /api/user/subscriptions/:subId/area — 修改厂区名称
router.put('/api/user/subscriptions/:subId/area', requireAuth, (req, res) => {
  const sub = stmts.getSubById.get(req.params.subId);
  if (!sub || sub.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  const name = (req.body.areaName || '').trim().slice(0, 50);
  if (!name) return res.status(400).json({ error: 'EMPTY_NAME' });
  stmts.updateSubAreaName.run(name, sub.id);
  if (sub.site_id) {
    stmts.updateSiteName.run(name, Date.now(), sub.site_id);
  }
  res.json({ success: true });
});

// POST /api/user/subscriptions/:subId/bind-ip — 绑定当前 WiFi IP
router.post('/api/user/subscriptions/:subId/bind-ip', requireAuth, (req, res) => {
  const sub = stmts.getSubById.get(req.params.subId);
  if (!sub || sub.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  refreshSubStatus(sub);
  if (!canRequestNetworkRebind(sub)) {
    return res.status(409).json({
      error: 'SUBSCRIPTION_NOT_ELIGIBLE_FOR_REBIND',
      status: sub.status,
    });
  }

  const ip = getClientIp(req);
  const subnet = ipToSubnet(ip);
  if (!subnet) return res.status(400).json({ error: 'INVALID_IP', clientIp: ip });

  stmts.bindSubIp.run(subnet, sub.id);
  if (sub.site_id) {
    const now = Date.now();
    const existing = stmts.getSiteBindingBySubnet.get(sub.site_id, subnet);
    if (existing) {
      stmts.touchSiteBindingSeenAt.run(now, now, existing.id);
    } else {
      stmts.insertSiteBinding.run(uuidv4(), sub.site_id, subnet, ip, '', '', '', '', 90, 'legacy_bind_ip', now, now, now, now);
    }
  }
  res.json({ success: true, wifiSubnet: subnet });
});

// POST /api/user/subscriptions/:subId/unbind-ip — 解绑（需超管确认，普通用户不能自己解绑）
router.post('/api/user/subscriptions/:subId/unbind-ip', requireAuth, (req, res) => {
  if (!req.user.is_super_admin) {
    return res.status(403).json({ error: 'FORBIDDEN', message: '解绑 WiFi 需联系管理员' });
  }
  const sub = stmts.getSubById.get(req.params.subId);
  if (!sub) return res.status(404).json({ error: 'NOT_FOUND' });
  stmts.unbindSubIp.run(req.params.subId);
  if (sub.site_id) stmts.revokeSiteBindingsBySite.run(Date.now(), sub.site_id);
  res.json({ success: true });
});

// ── 支付流程 ─────────────────────────────────────────────────

// GET /api/plans — 可选套餐（订单流）
router.get('/api/plans', requireAuth, (_req, res) => {
  const plans = stmts.listActivePlans.all().map(p => ({
    code: p.code,
    name: p.name,
    durationDays: p.duration_days,
    amountFen: p.amount_fen,
    amountYuan: (p.amount_fen / 100).toFixed(2),
    sortOrder: p.sort_order,
  }));
  res.json(plans);
});

// GET /api/orders — 当前用户订单列表
router.get('/api/orders', requireAuth, (req, res) => {
  const orders = stmts.listOrdersByUser.all(req.user.id);
  res.json(orders);
});

// POST /api/orders — 创建订单
router.post('/api/orders', requireAuth, (req, res) => {
  const { siteId, planCode } = req.body || {};
  if (!siteId || !planCode) return res.status(400).json({ error: 'MISSING_FIELDS' });

  const site = stmts.getSiteById.get(siteId);
  if (!site || site.user_id !== req.user.id) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  const sub = stmts.getSubBySiteId.get(siteId);
  if (!sub) return res.status(404).json({ error: 'SUBSCRIPTION_NOT_FOUND' });
  refreshSubStatus(sub);
  if (!canSubmitPayment(sub)) {
    return res.status(409).json({
      error: 'SUBSCRIPTION_NOT_ELIGIBLE_FOR_PAYMENT',
      status: sub.status,
    });
  }

  const plan = stmts.getPlanByCode.get(String(planCode).trim());
  if (!plan || plan.status !== 'active') return res.status(400).json({ error: 'INVALID_PLAN' });

  const idempotencyKey = String(req.get('Idempotency-Key') || '').trim();
  if (idempotencyKey) {
    const existing = stmts.getOrderByUserAndIdempotency.get(req.user.id, idempotencyKey);
    if (existing) return res.json({ success: true, idempotent: true, order: existing });
  }

  const now = Date.now();
  const orderId = uuidv4();
  stmts.insertOrder.run(
    orderId,
    req.user.id,
    site.id,
    sub.id,
    plan.code,
    plan.duration_days,
    plan.amount_fen,
    idempotencyKey,
    now,
    now
  );
  const created = stmts.getOrderById.get(orderId);
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'user',
    siteId: site.id,
    action: 'ORDER_CREATED',
    targetType: 'order',
    targetId: orderId,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: {
      planCode: plan.code,
      durationDays: plan.duration_days,
      amountFen: plan.amount_fen,
      idempotencyKey: idempotencyKey || '',
    },
  });
  res.json({ success: true, idempotent: false, order: created });
});

// POST /api/orders/:id/pay — 用户提交支付凭证
router.post('/api/orders/:id/pay', requireAuth, (req, res) => {
  const { txnId, note } = req.body || {};
  const order = stmts.getOrderById.get(req.params.id);
  if (!order || order.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  if (order.status !== 'pending_payment') {
    return res.status(409).json({ error: 'INVALID_ORDER_STATUS', status: order.status });
  }
  const now = Date.now();
  const mark = stmts.markOrderPaidPendingReview.run(String(txnId || '').trim(), String(note || '').trim(), now, now, order.id);
  if (mark.changes === 0) {
    const latest = stmts.getOrderById.get(order.id);
    return res.status(409).json({ error: 'ORDER_ALREADY_UPDATED', status: latest?.status || 'unknown' });
  }
  const updated = stmts.getOrderById.get(order.id);
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'user',
    siteId: order.site_id || null,
    action: 'ORDER_PAYMENT_SUBMITTED',
    targetType: 'order',
    targetId: order.id,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: {
      txnId: String(txnId || '').trim(),
      status: 'paid_pending_review',
    },
  });
  res.json({ success: true, order: updated });
});

// GET /api/user/payments — 当前用户支付记录
router.get('/api/user/payments', requireAuth, (req, res) => {
  const orders = stmts.listOrdersByUser.all(req.user.id).map(o => ({
    id: o.id,
    subscription_id: o.subscription_id,
    plan: o.plan_code,
    amount_fen: o.amount_fen,
    status: o.status,
    txn_id: o.txn_id,
    notes: o.note || '',
    created_at: o.created_at,
    area_name: o.site_name || o.area_name || '',
    source: 'orders',
  }));
  res.json(orders);
});

// POST /api/user/payments — 提交支付申请
router.post('/api/user/payments', requireAuth, (req, res) => {
  // 兼容旧前端入口：内部改走 orders 链路
  const { subscriptionId, plan, txnId, notes } = req.body || {};
  if (!subscriptionId || !plan) return res.status(400).json({ error: 'MISSING_FIELDS' });
  if (!['monthly', 'yearly'].includes(plan)) return res.status(400).json({ error: 'INVALID_PLAN' });

  const sub = stmts.getSubById.get(subscriptionId);
  if (!sub || sub.user_id !== req.user.id) return res.status(404).json({ error: 'NOT_FOUND' });
  refreshSubStatus(sub);
  if (!canSubmitPayment(sub)) {
    return res.status(409).json({
      error: 'SUBSCRIPTION_NOT_ELIGIBLE_FOR_PAYMENT',
      status: sub.status,
      message: '当前订阅状态不允许提交支付申请',
    });
  }

  const mappedPlanCode = plan === 'yearly' ? 'yearly' : 'monthly';
  const planRow = stmts.getPlanByCode.get(mappedPlanCode);
  const amountFen = planRow?.amount_fen || (plan === 'monthly' ? config.pricing.monthlyFen : config.pricing.yearlyFen);
  const durationDays = planRow?.duration_days || (plan === 'monthly' ? 30 : 365);
  const now = Date.now();

  const orderId = uuidv4();
  stmts.insertOrder.run(
    orderId,
    req.user.id,
    sub.site_id || null,
    sub.id,
    mappedPlanCode,
    durationDays,
    amountFen,
    '',
    now,
    now
  );
  stmts.markOrderPaidPendingReview.run(String(txnId || '').trim(), String(notes || '').trim(), now, now, orderId);

  logAudit({
    actorUserId: req.user.id,
    actorRole: 'user',
    siteId: sub.site_id || null,
    action: 'ORDER_CREATED',
    targetType: 'order',
    targetId: orderId,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { planCode: mappedPlanCode, durationDays, amountFen, source: 'legacy_payment_api' },
  });
  logAudit({
    actorUserId: req.user.id,
    actorRole: 'user',
    siteId: sub.site_id || null,
    action: 'ORDER_PAYMENT_SUBMITTED',
    targetType: 'order',
    targetId: orderId,
    ip: getClientIp(req),
    ua: req.get('user-agent') || '',
    payload: { txnId: String(txnId || '').trim(), status: 'paid_pending_review', source: 'legacy_payment_api' },
  });

  res.json({
    success: true,
    paymentId: orderId,
    orderId,
    amountFen,
    amountYuan: (amountFen / 100).toFixed(2),
    status: 'paid_pending_review',
  });
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
