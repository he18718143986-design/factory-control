'use strict';
const express = require('express');
const QRCode  = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const router  = express.Router();

const { stmts, db, isSubscriptionActive, refreshSubStatus } = require('../db');
const { requireAuth }  = require('../middleware/auth');
const adbMgr = require('../adb');
const mdns   = require('../mdns');
const { getSession, getSessions, setSession, deleteSession, markDirty } = require('../sessions/store');
const { serializeSession } = require('../sessions/serialize');
const { broadcastToSub, broadcast } = require('../broadcast/ws');
const { log, setStatus, broadcastUpdate,
        onDeviceConnected, markPairedNotConnected,
        registerPairingListener } = require('../pairing/flow');
const { getServerIP, getClientIp } = require('../utils/network');
const config = require('../config');

const QR_OPTS = { errorCorrectionLevel: 'M', width: 280, margin: 2, color: { dark: '#0a0c0f', light: '#ffffff' } };

function normalizeTs(input) {
  if (!input && input !== 0) return null;
  if (typeof input === 'number' && Number.isFinite(input)) return input;
  const s = String(input).trim();
  if (!s) return null;
  if (/^\d+$/.test(s)) return Number(s);
  const t = Date.parse(s);
  return Number.isFinite(t) ? t : null;
}

function parseHistoryFilters(req) {
  const siteId = String(req.query.siteId || '').trim();
  const statusRaw = String(req.query.status || 'exited').trim();
  const allowedStatus = new Set(['all', 'waiting', 'pairing', 'paired_not_connected', 'restricted', 'exiting', 'exited', 'error']);
  const safeStatus = allowedStatus.has(statusRaw) ? statusRaw : 'exited';
  const status = safeStatus === 'all' ? '' : safeStatus;
  const q = String(req.query.q || '').trim().slice(0, 80);
  const from = normalizeTs(req.query.from);
  const to = normalizeTs(req.query.to);
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 100));
  const offset = Math.min(100000, Math.max(0, Number(req.query.offset) || 0));
  return { siteId, status, q, from, to, limit, offset };
}

function parseVisitorSessionRow(row) {
  try {
    const raw = JSON.parse(row.data);
    const session = { ...raw, subscriptionId: row.subscription_id, userId: row.user_id };
    const out = serializeSession(session);
    out.siteId = row.site_id;
    out.areaName = row.area_name || '';
    out.updatedAt = row.updated_at;
    return out;
  } catch {
    return null;
  }
}

function buildHistoryCsv(items) {
  const csvVal = v => `"${String(v || '').replace(/"/g, '""')}"`;
  const cols = ['会话ID', '厂区ID', '姓名', '公司/单位', '区域', '状态', '设备ID', '设备IP', '登记时间', '管控生效', '离厂时间', '更新时间'];
  const rows = items.map(s => [
    csvVal(s.id),
    csvVal(s.siteId || ''),
    csvVal(s.visitorName),
    csvVal(s.visitorCompany),
    csvVal(s.area),
    csvVal(s.status),
    csvVal(s.deviceId),
    csvVal(s.deviceIp),
    csvVal(s.createdAt ? new Date(s.createdAt).toLocaleString('zh-CN', { hour12: false }) : ''),
    csvVal(s.restrictedAt ? new Date(s.restrictedAt).toLocaleString('zh-CN', { hour12: false }) : ''),
    csvVal(s.exitedAt ? new Date(s.exitedAt).toLocaleString('zh-CN', { hour12: false }) : ''),
    csvVal(s.updatedAt ? new Date(s.updatedAt).toLocaleString('zh-CN', { hour12: false }) : ''),
  ].join(','));
  return '\uFEFF' + cols.join(',') + '\n' + rows.join('\n');
}

// ── 会话列表 ─────────────────────────────────────────────────

// GET /api/sessions?siteId=xxx — 某厂区的所有访客会话
router.get('/api/sessions', requireAuth, (req, res) => {
  const siteId = req.query.siteId;
  if (!siteId) return res.status(400).json({ error: 'MISSING_SITE_ID' });

  const sub = stmts.getSubBySiteId.get(siteId);
  if (!sub || (sub.user_id !== req.user.id && !req.user.is_super_admin)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const sessions = [...getSessions(sub.id).values()]
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
    .map(serializeSession);
  res.json(sessions);
});

// GET /api/history/sessions?siteId=...&status=exited|all&q=&from=&to=&limit=&offset=
router.get('/api/history/sessions', requireAuth, (req, res) => {
  const { siteId, status, q, from, to, limit, offset } = parseHistoryFilters(req);
  if (!siteId) return res.status(400).json({ error: 'MISSING_SITE_ID' });

  const sub = stmts.getSubBySiteId.get(siteId);
  if (!sub) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  if (!req.user.is_super_admin && sub.user_id !== req.user.id) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const filters = ['s.site_id = @siteId'];
  const params = { siteId, limit, offset };
  if (!req.user.is_super_admin) {
    filters.push('s.user_id = @userId');
    params.userId = req.user.id;
  }
  if (status) {
    filters.push(`json_extract(vs.data, '$.status') = @status`);
    params.status = status;
  }
  if (q) {
    filters.push(`(
      json_extract(vs.data, '$.visitorName') LIKE @qLike OR
      json_extract(vs.data, '$.visitorCompany') LIKE @qLike OR
      json_extract(vs.data, '$.deviceId') LIKE @qLike OR
      json_extract(vs.data, '$.area') LIKE @qLike OR
      vs.id LIKE @qLike
    )`);
    params.qLike = `%${q}%`;
  }
  if (from) {
    filters.push('vs.updated_at >= @from');
    params.from = from;
  }
  if (to) {
    filters.push('vs.updated_at <= @to');
    params.to = to;
  }
  const whereSql = filters.join(' AND ');

  const rows = db.prepare(`
    SELECT
      vs.id,
      vs.subscription_id,
      vs.user_id,
      vs.data,
      vs.updated_at,
      s.site_id,
      s.area_name
    FROM visitor_sessions vs
    JOIN subscriptions s ON s.id = vs.subscription_id
    WHERE ${whereSql}
    ORDER BY vs.updated_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  const total = db.prepare(`
    SELECT COUNT(*) AS c
    FROM visitor_sessions vs
    JOIN subscriptions s ON s.id = vs.subscription_id
    WHERE ${whereSql}
  `).get(params).c;

  const items = rows.map(parseVisitorSessionRow).filter(Boolean);
  return res.json({
    items,
    total,
    limit,
    offset,
    hasMore: offset + items.length < total,
  });
});

// GET /api/history/sessions/export?siteId=...&status=exited|all&q=&from=&to=
router.get('/api/history/sessions/export', requireAuth, (req, res) => {
  const { siteId, status, q, from, to } = parseHistoryFilters(req);
  if (!siteId) return res.status(400).json({ error: 'MISSING_SITE_ID' });

  const sub = stmts.getSubBySiteId.get(siteId);
  if (!sub) return res.status(404).json({ error: 'SITE_NOT_FOUND' });
  if (!req.user.is_super_admin && sub.user_id !== req.user.id) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }

  const filters = ['s.site_id = @siteId'];
  const params = { siteId, limit: 5000, offset: 0 };
  if (!req.user.is_super_admin) {
    filters.push('s.user_id = @userId');
    params.userId = req.user.id;
  }
  if (status) {
    filters.push(`json_extract(vs.data, '$.status') = @status`);
    params.status = status;
  }
  if (q) {
    filters.push(`(
      json_extract(vs.data, '$.visitorName') LIKE @qLike OR
      json_extract(vs.data, '$.visitorCompany') LIKE @qLike OR
      json_extract(vs.data, '$.deviceId') LIKE @qLike OR
      json_extract(vs.data, '$.area') LIKE @qLike OR
      vs.id LIKE @qLike
    )`);
    params.qLike = `%${q}%`;
  }
  if (from) {
    filters.push('vs.updated_at >= @from');
    params.from = from;
  }
  if (to) {
    filters.push('vs.updated_at <= @to');
    params.to = to;
  }
  const whereSql = filters.join(' AND ');

  const rows = db.prepare(`
    SELECT
      vs.id,
      vs.subscription_id,
      vs.user_id,
      vs.data,
      vs.updated_at,
      s.site_id,
      s.area_name
    FROM visitor_sessions vs
    JOIN subscriptions s ON s.id = vs.subscription_id
    WHERE ${whereSql}
    ORDER BY vs.updated_at DESC
    LIMIT @limit OFFSET @offset
  `).all(params);

  const items = rows.map(parseVisitorSessionRow).filter(Boolean);
  const csv = buildHistoryCsv(items);
  const day = new Date().toISOString().slice(0, 10);
  const filename = `visitor_history_${siteId}_${day}.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename=\"${filename}\"`);
  return res.send(csv);
});

// ── APP 上报 IP ───────────────────────────────────────────────

router.post('/api/sessions/:id/device', (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'NOT_FOUND' });
  if (!['waiting', 'pairing'].includes(session.status)) {
    return res.status(409).json({ error: 'INVALID_STATUS' });
  }
  const { deviceIp } = req.body;
  if (!deviceIp) return res.status(400).json({ error: 'MISSING_DEVICE_IP' });
  session.deviceIp = deviceIp;
  markDirty();
  log(session, `📱 APP 已上报 IP：${deviceIp}`);
  broadcastToSub(session.subscriptionId, { event: 'sessionUpdate', session: serializeSession(session) });
  res.json({ success: true });
});

// ── 离厂 ─────────────────────────────────────────────────────

router.post('/api/sessions/:id/exit', async (req, res) => {
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'NOT_FOUND' });
  if (session.exitToken !== req.body.exitToken) return res.status(403).json({ error: 'INVALID_TOKEN' });
  if (session.status === 'exited') return res.status(409).json({ error: 'ALREADY_EXITED' });

  setStatus(session, 'exiting', '🚪 解除管控中…');
  broadcastUpdate(session);

  try {
    let deviceId = session.deviceId;
    if (!deviceId && session.deviceIp) {
      try {
        await adbMgr.connectWithRetry(session.deviceIp, 5555);
        deviceId = session.deviceIp + ':5555';
        session.deviceId = deviceId; markDirty();
      } catch (e) { log(session, '⚠️ 按 IP 连接失败：' + e.message); }
    }

    // 管控完整性验证
    let verifyReport = null;
    if (deviceId) {
      try {
        verifyReport = await adbMgr.verifyRestrictions(deviceId, msg => log(session, msg));
        if (!verifyReport.intact) {
          const details = [];
          if (!verifyReport.frozenAppsOk)    details.push('相机解冻: ' + verifyReport.unfrozenPkgs.join(', '));
          if (!verifyReport.cameraAppopsOk)  details.push('摄像头权限恢复: ' + verifyReport.cameraAllowedPkgs.join(', '));
          if (!verifyReport.screenCaptureOk) details.push('截屏策略已被关闭');
          log(session, '🚨 管控完整性异常：' + details.join('；'), 'error');
          session.tamperDetected = true;
          session.tamperDetails  = details; markDirty();
          broadcastToSub(session.subscriptionId, {
            event: 'tamperAlert', sessionId: session.id,
            visitorName: session.visitorName, area: session.area, details,
          });
        }
      } catch (e) { log(session, '⚠️ 完整性验证失败（不阻止离厂）：' + e.message); }
    }

    if (deviceId) {
      log(session, `🚪 对设备 ${deviceId} 执行解除管控…`);
      await adbMgr.removeRestrictions(deviceId, msg => log(session, msg));
      await adbMgr.disconnectDevice(deviceId);
      log(session, '🔌 已断开设备连接');
    } else {
      log(session, '🚨 设备不可达，管控指令未能解除！', 'error');
      broadcastToSub(session.subscriptionId, {
        event: 'exitWithoutDevice', sessionId: session.id,
        visitorName: session.visitorName, area: session.area,
      });
    }

    mdns.cancelPairing(session.adbServiceName);
    session.status   = 'exited';
    session.exitedAt = new Date(); markDirty();
    setStatus(session, 'exited', '🚪 访客已离厂，管控已全部解除');
    log(session, '✅ 离厂完成');
    broadcastUpdate(session);
    res.json({ success: true, tamperDetected: !!session.tamperDetected, verifyReport });
  } catch (err) {
    log(session, '❌ 解除失败：' + err.message, 'error');
    setStatus(session, 'error', '❌ 解除管控失败：' + err.message);
    broadcastUpdate(session);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ── 管理员操作（需要订阅归属验证）──────────────────────────

function requireSessionOwner(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'UNAUTHORIZED' });
  const session = getSession(req.params.id);
  if (!session) return res.status(404).json({ error: 'NOT_FOUND' });
  const sub = stmts.getSubById.get(session.subscriptionId);
  if (!sub || (sub.user_id !== req.user.id && !req.user.is_super_admin)) {
    return res.status(403).json({ error: 'FORBIDDEN' });
  }
  req.session = session;
  next();
}

// 强制离厂
router.post('/api/sessions/:id/force-exit', requireAuth, requireSessionOwner, async (req, res) => {
  const session = req.session;
  if (session.status === 'exited') return res.status(409).json({ error: 'ALREADY_EXITED' });

  setStatus(session, 'exiting', '🚪 管理员强制离厂…');
  broadcastUpdate(session);
  log(session, '🛠️ 管理员发起强制离厂');

  try {
    let deviceId = session.deviceId;
    if (!deviceId && session.deviceIp) {
      try {
        await adbMgr.connectWithRetry(session.deviceIp, 5555);
        deviceId = session.deviceIp + ':5555';
        session.deviceId = deviceId; markDirty();
      } catch (e) { log(session, '⚠️ IP 连接失败：' + e.message); }
    }
    if (deviceId) {
      await adbMgr.removeRestrictions(deviceId, msg => log(session, msg));
      await adbMgr.disconnectDevice(deviceId);
    } else {
      log(session, '🚨 [强制离厂] 设备不可达，管控未解除', 'error');
    }
    mdns.cancelPairing(session.adbServiceName);
    session.status   = 'exited';
    session.exitedAt = new Date(); markDirty();
    setStatus(session, 'exited', '🚪 访客已离厂（强制）');
    log(session, '✅ 强制离厂完成');
    broadcastUpdate(session);
    res.json({ success: true });
  } catch (err) {
    log(session, '❌ 强制离厂失败：' + err.message, 'error');
    setStatus(session, 'error', '❌ 强制离厂失败');
    broadcastUpdate(session);
    res.status(500).json({ error: err.message });
  }
});

// 重试管控
router.post('/api/sessions/:id/retry', requireAuth, requireSessionOwner, async (req, res) => {
  const session = req.session;
  if (!session.deviceId) return res.status(400).json({ error: 'NO_DEVICE' });
  res.json({ success: true });
  setStatus(session, 'pairing', '🔄 重新下发管控指令…');
  try {
    const retryWarns = [];
    await adbMgr.applyRestrictions(session.deviceId, msg => {
      log(session, msg);
      if (/DPM\/wm 截屏禁用不可用/.test(msg))  retryWarns.push('截屏降级');
      if (/SystemUI 重启失败/.test(msg))        retryWarns.push('控制中心需下拉生效');
    });
    session.status = 'restricted'; session.restrictedAt = new Date(); markDirty();
    setStatus(session, 'restricted', '✅ 管控重新生效！');
    if (retryWarns.length) broadcastToSub(session.subscriptionId, {
      event: 'restrictionDegraded', sessionId: session.id,
      visitorName: session.visitorName, area: session.area, warnings: retryWarns,
    });
    broadcastUpdate(session);
  } catch (err) {
    setStatus(session, 'error', '❌ 重试失败：' + err.message);
    broadcastUpdate(session);
  }
});

// 重试连接
router.post('/api/sessions/:id/retry-connect', requireAuth, requireSessionOwner, async (req, res) => {
  const session = req.session;
  const now = Date.now();
  if (session.retryConnectRequestedAt && now - session.retryConnectRequestedAt < config.timing.retryConnectMs) {
    return res.status(429).json({ error: 'TOO_FREQUENT' });
  }
  session.retryConnectRequestedAt = now; markDirty();

  const isReconnect = session.pairedNotConnectedReason === 'device_disconnected';
  setStatus(session, 'pairing', isReconnect ? '🔄 正在重新连接断开的设备…' : '🔄 正在重试 ADB 连接…');
  broadcastUpdate(session);
  res.json({ success: true });

  try {
    if (session.deviceId) {
      const resolved = await adbMgr.resolveDeviceSerial(session.deviceId);
      if (resolved) { await onDeviceConnected(session.id, session.deviceId); return; }
    }
    if (session.deviceIp) {
      await adbMgr.connectWithRetry(session.deviceIp, 5555);
      session.deviceId = session.deviceIp + ':5555'; markDirty();
      await onDeviceConnected(session.id, session.deviceId);
      return;
    }
    await markPairedNotConnected(session.id, 'not_in_adb_devices');
  } catch (err) {
    log(session, '⚠️ 重试连接失败：' + err.message, 'error');
    await markPairedNotConnected(session.id, 'adb_connect_failed');
  }
});

// 重新生成配对码
router.post('/api/sessions/:id/regenerate-pairing', requireAuth, requireSessionOwner, async (req, res) => {
  const session = req.session;
  if (['restricted', 'exiting', 'exited'].includes(session.status)) {
    return res.status(409).json({ error: 'INVALID_STATUS' });
  }
  try {
    if (session.adbServiceName) mdns.cancelPairing(session.adbServiceName);
    const { serviceName, password, qrContent } = mdns.generatePairingCredentials();
    const newEntryQR = await QRCode.toDataURL(qrContent, QR_OPTS);
    session.adbServiceName = serviceName;
    session.adbPassword    = password;
    session.entryQR        = newEntryQR;
    session.status         = 'waiting';
    session.deviceId       = null; markDirty();
    log(session, '🔄 管理员重新生成配对码，等待访客重新扫码…');
    setStatus(session, 'waiting', '⏳ 等待访客扫新配对码…');
    broadcastUpdate(session);
    res.json({ success: true, entryQR: newEntryQR });
    registerPairingListener(session.id, serviceName, password);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 开启 recover pairing
router.post('/api/sessions/:id/recover-enable', requireAuth, requireSessionOwner, (req, res) => {
  const session = req.session;
  session.recoverPairingEnabled      = true;
  session.recoverPairingEnabledUntil = Date.now() + 10 * 60 * 1000; markDirty();
  log(session, '🟡 已为本会话开启 recover_pairing（临时）');
  res.json({ success: true, recoverPairingEnabledUntil: session.recoverPairingEnabledUntil });
});

module.exports = router;
