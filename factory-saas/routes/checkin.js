'use strict';
const express = require('express');
const QRCode  = require('qrcode');
const crypto  = require('crypto');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const router  = express.Router();

const { stmts, canIssueQr, refreshSubStatus } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireSiteIssueEligible, enforceNetworkBinding, checkNetworkBindingForSubscription } = require('../middleware/subscription');
const { rateLimit } = require('../middleware/rateLimit');
const { getServerIP, getClientIp, isSameSubnet, isValidIPv4 } = require('../utils/network');
const { getSessions, setSession, markDirty } = require('../sessions/store');
const { serializeSession } = require('../sessions/serialize');
const { broadcastToSub } = require('../broadcast/ws');
const { registerPairingListener } = require('../pairing/flow');
const mdns   = require('../mdns');
const config = require('../config');

const QR_OPTS = { errorCorrectionLevel: 'M', width: 280, margin: 2, color: { dark: '#0a0c0f', light: '#ffffff' } };
const IDEMPOTENT_MS = 5 * 60 * 1000;
const CHECKIN_TOKEN_TTL_MS = 10 * 60 * 1000;

function b64urlEncode(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(input) {
  const normalized = String(input || '').replace(/-/g, '+').replace(/_/g, '/');
  const pad = normalized.length % 4;
  const withPad = normalized + (pad ? '='.repeat(4 - pad) : '');
  return Buffer.from(withPad, 'base64').toString('utf8');
}

function signCheckinPayload(payloadObj) {
  const payload = b64urlEncode(JSON.stringify(payloadObj));
  const sig = crypto.createHmac('sha256', config.jwt.secret).update(payload).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
  return `${payload}.${sig}`;
}

function verifyCheckinToken(token) {
  const [payloadPart, sigPart] = String(token || '').split('.');
  if (!payloadPart || !sigPart) return { ok: false, error: 'CHECKIN_TOKEN_INVALID' };
  const expectedSig = crypto.createHmac('sha256', config.jwt.secret).update(payloadPart).digest();
  let providedSig;
  try {
    providedSig = Buffer.from(sigPart.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  } catch {
    return { ok: false, error: 'CHECKIN_TOKEN_INVALID' };
  }
  if (providedSig.length !== expectedSig.length || !crypto.timingSafeEqual(providedSig, expectedSig)) {
    return { ok: false, error: 'CHECKIN_TOKEN_INVALID' };
  }
  let payload;
  try {
    payload = JSON.parse(b64urlDecode(payloadPart));
  } catch {
    return { ok: false, error: 'CHECKIN_TOKEN_INVALID' };
  }
  if (!payload || payload.v !== 1 || !payload.siteId) {
    return { ok: false, error: 'CHECKIN_TOKEN_INVALID' };
  }
  const now = Date.now();
  if (!payload.exp || now > Number(payload.exp)) {
    return { ok: false, error: 'CHECKIN_TOKEN_EXPIRED' };
  }
  return { ok: true, payload };
}

// GET /api/checkin-qr?siteId=&area=
router.get('/api/checkin-qr', requireAuth, requireSiteIssueEligible, enforceNetworkBinding, async (req, res) => {
  try {
    const sub  = req.subscription;
    const area = (req.query.area || sub.area_name || '').trim();
    const ip   = getServerIP();
    const siteId = sub.site_id || '';
    const checkinToken = signCheckinPayload({
      v: 1,
      siteId,
      area,
      iat: Date.now(),
      exp: Date.now() + CHECKIN_TOKEN_TTL_MS,
      nonce: uuidv4(),
    });
    const url  = `http://${ip}:${config.port}/api/checkin-start?siteId=${encodeURIComponent(siteId)}&area=${encodeURIComponent(area)}&t=${encodeURIComponent(checkinToken)}`;
    const qr   = await QRCode.toDataURL(url, { ...QR_OPTS, width: 320 });
    res.json({ qr, url, siteId, subscriptionId: sub.id, checkinToken });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/checkin-start', (req, res) => {
  const p = new URLSearchParams();
  if (req.query.siteId) p.set('siteId', req.query.siteId);
  if (req.query.area)  p.set('area',  req.query.area);
  if (req.query.t) p.set('t', req.query.t);
  res.redirect(302, '/welcome?' + p.toString());
});

router.get('/welcome',        (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'welcome.html')));
router.get('/welcome-bridge', (_req, res) => res.sendFile(path.join(__dirname, '..', 'public', 'welcome-bridge.html')));

router.get('/api/network-check', (req, res) => {
  const serverIp = getServerIP();
  const clientIp = getClientIp(req);
  if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === serverIp)
    return res.json({ sameNetwork: true, clientIp, serverIp });
  if (!isValidIPv4(clientIp)) return res.json({ sameNetwork: true, clientIp, serverIp });
  res.json({ sameNetwork: isSameSubnet(serverIp, clientIp), clientIp, serverIp });
});

router.post('/api/checkin', rateLimit, async (req, res) => {
  try {
    const serverIp = getServerIP();
    const clientIp = getClientIp(req);
    const isIPv4   = isValidIPv4(clientIp);

    if (isIPv4 && clientIp !== '127.0.0.1' && clientIp !== serverIp) {
      if (!isSameSubnet(serverIp, clientIp))
        return res.status(403).json({ error: 'NOT_SAME_NETWORK', message: '请先连接厂区 Wi-Fi 再入场' });
    }

    const { name, company, area, siteId, checkinToken } = req.body || {};
    if (!checkinToken) return res.status(400).json({ error: 'MISSING_CHECKIN_TOKEN' });
    const tokenVerified = verifyCheckinToken(checkinToken);
    if (!tokenVerified.ok) return res.status(403).json({ error: tokenVerified.error });
    const tokenSiteId = String(tokenVerified.payload.siteId || '');
    const tokenArea = String(tokenVerified.payload.area || '');
    if (siteId && siteId !== tokenSiteId) {
      return res.status(403).json({ error: 'CHECKIN_SITE_MISMATCH' });
    }
    if (!tokenSiteId) return res.status(400).json({ error: 'MISSING_SITE_ID' });

    const sub = stmts.getSubBySiteId.get(tokenSiteId);
    if (!sub) return res.status(404).json({ error: 'SUBSCRIPTION_NOT_FOUND' });
    refreshSubStatus(sub);
    if (!canIssueQr(sub)) {
      return res.status(402).json({
        error: 'SUBSCRIPTION_NOT_ELIGIBLE_FOR_ISSUE',
        status: sub.status,
        message: '该厂区当前状态不允许生成新二维码，请联系管理员续费或恢复',
      });
    }

    const binding = checkNetworkBindingForSubscription(sub, req);
    if (!binding.ok) {
      return res.status(binding.status || 403).json({
        error: binding.code || 'NETWORK_NOT_ALLOWED',
        message: binding.message || '当前网络不允许入场',
      });
    }

    const sessions = getSessions(sub.id);
    const now = Date.now();
    for (const [, s] of sessions) {
      if (s.status !== 'waiting') continue;
      if (now - new Date(s.createdAt).getTime() > IDEMPOTENT_MS) continue;
      if (s.checkinRequestIp === clientIp) return res.json({ sessionId: s.id, entryQR: s.entryQR, exitQR: s.exitQR });
    }

    const rawName = typeof name === 'string' ? name.trim().slice(0, 50) : '';
    const rawCo   = typeof company === 'string' ? company.trim().slice(0, 100) : '';
    const idx     = sessions.size + 1;
    const visitorName = rawName ? (rawCo ? `${rawName}（${rawCo}）` : rawName) : `访客-${String(idx).padStart(3,'0')}`;

    const sessionId = uuidv4();
    const exitToken = uuidv4();
    const { serviceName, password, qrContent } = mdns.generatePairingCredentials();
    const exitPayload = JSON.stringify({ type:'exit', sessionId, exitToken, serverUrl:`http://${serverIp}:${config.port}` });

    const [entryQR, exitQR] = await Promise.all([
      QRCode.toDataURL(qrContent,   QR_OPTS),
      QRCode.toDataURL(exitPayload, QR_OPTS),
    ]);

    const session = {
      id: sessionId, subscriptionId: sub.id, userId: sub.user_id,
      visitorName, visitorCompany: rawCo,
      area: area || tokenArea || sub.area_name || '全厂区',
      wifiSsid: '', wifiPassword: '', exitToken,
      status: 'waiting', deviceId: null, deviceIp: null,
      checkinRequestIp: clientIp, adbServiceName: serviceName, adbPassword: password,
      createdAt: new Date(), restrictedAt: null, exitedAt: null,
      logs: [], entryQR, exitQR, selfCheckin: true,
    };

    setSession(session);
    registerPairingListener(sessionId, serviceName, password);

    const ts = new Date().toLocaleTimeString('zh-CN', { hour12: false });
    session.logs.push(`[${ts}] 🚶 自助入场：${visitorName}`);
    markDirty();

    broadcastToSub(sub.id, { event: 'sessionCreated', session: serializeSession(session) });
    res.json({ sessionId, entryQR, exitQR });
  } catch (err) {
    console.error('[checkin]', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
