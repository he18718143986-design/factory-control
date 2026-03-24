'use strict';
const express = require('express');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const path    = require('path');
const router  = express.Router();

const { stmts, isSubscriptionActive, refreshSubStatus } = require('../db');
const { requireAuth } = require('../middleware/auth');
const { requireActiveSubscription } = require('../middleware/subscription');
const { rateLimit } = require('../middleware/rateLimit');
const { getServerIP, getClientIp, isSameSubnet, isValidIPv4, ipToSubnet } = require('../utils/network');
const { getSessions, setSession, markDirty } = require('../sessions/store');
const { serializeSession } = require('../sessions/serialize');
const { broadcastToSub } = require('../broadcast/ws');
const { registerPairingListener } = require('../pairing/flow');
const mdns   = require('../mdns');
const config = require('../config');

const QR_OPTS = { errorCorrectionLevel: 'M', width: 280, margin: 2, color: { dark: '#0a0c0f', light: '#ffffff' } };
const IDEMPOTENT_MS = 5 * 60 * 1000;

// GET /api/checkin-qr?subId=&area=
router.get('/api/checkin-qr', requireAuth, requireActiveSubscription, async (req, res) => {
  try {
    const sub  = req.subscription;
    const area = (req.query.area || sub.area_name || '').trim();
    const ip   = getServerIP();
    const url  = `http://${ip}:${config.port}/api/checkin-start?subId=${sub.id}&area=${encodeURIComponent(area)}`;
    const qr   = await QRCode.toDataURL(url, { ...QR_OPTS, width: 320 });
    res.json({ qr, url });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

router.get('/api/checkin-start', (req, res) => {
  const p = new URLSearchParams();
  if (req.query.subId) p.set('subId', req.query.subId);
  if (req.query.area)  p.set('area',  req.query.area);
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

    const { name, company, area, subId } = req.body || {};
    if (!subId) return res.status(400).json({ error: 'MISSING_SUB_ID' });

    const sub = stmts.getSubById.get(subId);
    if (!sub) return res.status(404).json({ error: 'SUBSCRIPTION_NOT_FOUND' });
    refreshSubStatus(sub);
    if (!isSubscriptionActive(sub))
      return res.status(402).json({ error: 'SUBSCRIPTION_EXPIRED', message: '该厂区订阅已过期，请联系管理员续费' });

    const clientSubnet = ipToSubnet(clientIp);
    if (isIPv4 && clientIp !== '127.0.0.1' && clientSubnet) {
      if (!sub.wifi_locked || !sub.wifi_subnet) {
        stmts.bindSubIp.run(clientSubnet, sub.id);
      } else if (clientSubnet !== sub.wifi_subnet) {
        return res.status(403).json({
          error: 'IP_BINDING_MISMATCH',
          message: `此厂区已绑定到 ${sub.wifi_subnet}.x 网络，当前 IP 不在该网段`,
        });
      }
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
      area: area || sub.area_name || '全厂区',
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
