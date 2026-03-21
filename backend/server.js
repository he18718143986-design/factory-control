/**
 * server.js — 厂区访客管控系统主服务  v2.1
 *
 * 启动：node server.js
 * 依赖：npm install
 *
 * 端口：3000（HTTP + WebSocket）
 * 管理后台：http://<局域网IP>:3000/admin.html
 *
 * ADB 配对流程（已修正）：
 *   1. 门卫新建会话 → 服务器生成随机 serviceName + password
 *   2. 渲染成二维码展示：WIFI:T:ADB;S:<name>;P:<pass>;;
 *   3. 访客扫码（手机「无线调试 → 使用二维码配对」）
 *   4. 手机启动配对服务，通过 mDNS 广播 _adb-tls-pairing._tcp
 *   5. 服务器 mDNS 监听到匹配的 serviceName → 执行 adb pair <ip>:<port> <pass>
 *   6. 本机 ADB Server 完成 SPAKE2 握手 → 设备进入 adb devices
 *   7. adb.js 轮询到新设备 → 与 APP 上报 IP 匹配 → 下发管控指令
 *   8. WebSocket 通知 APP → 显示「管控中」界面
 */

'use strict';

const express   = require('express');
const http      = require('http');
const WebSocket = require('ws');
const Database  = require('better-sqlite3');
const QRCode    = require('qrcode');
const { v4: uuidv4 } = require('uuid');
const os        = require('os');
const path      = require('path');
const fs        = require('fs');
const cors      = require('cors');

const mdns   = require('./mdns');
const adbMgr = require('./adb');

// ── 初始化 ────────────────────────────────────────────────────

const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
const PORT   = Number(process.env.PORT) || 3000;

function parseAreas(input) {
  if (!input) return [];
  if (Array.isArray(input)) {
    return input
      .map(v => String(v || '').trim())
      .filter(Boolean);
  }
  if (typeof input === 'string') {
    return input
      .split(',')
      .map(s => s.trim())
      .filter(Boolean);
  }
  // 兜底：避免配置类型异常导致启动崩溃
  return [String(input).trim()].filter(Boolean);
}

const configPath = path.join(__dirname, 'config.json');
let fileConfig = {};
try {
  if (fs.existsSync(configPath)) {
    fileConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  }
} catch (e) {
  console.warn('[config] 读取 config.json 失败：' + e.message);
}

const ENABLE_RECOVER_PAIRING = String(process.env.ENABLE_RECOVER_PAIRING || '').toLowerCase() === 'true';
const RECOVER_PAIRING_AREAS = parseAreas(process.env.RECOVER_PAIRING_AREAS || fileConfig.recoverPairingAreas);
const RECOVER_PAIRING_SESSION_TTL_MS = Number(process.env.RECOVER_PAIRING_SESSION_TTL_MS) || 10 * 60 * 1000;
const RETRY_CONNECT_COOLDOWN_MS = Number(process.env.RETRY_CONNECT_COOLDOWN_MS) || 8000;
const ADMIN_TOKEN = String(process.env.ADMIN_TOKEN || fileConfig.adminToken || '').trim();
const MAX_SESSION_LOGS = Number(process.env.MAX_SESSION_LOGS) || 200;
const SESSION_PERSIST_INTERVAL_MS = Number(process.env.SESSION_PERSIST_INTERVAL_MS) || 5000;

app.use(express.json());
app.use(cors());

// 管理后台页面认证（仅当配置 ADMIN_TOKEN）
app.get('/admin.html', (req, res) => {
  if (!ADMIN_TOKEN) {
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  const token = extractAdminToken(req);
  if (token && token === ADMIN_TOKEN) {
    res.setHeader(
      'Set-Cookie',
      `admin_token=${encodeURIComponent(token)}; Path=/; HttpOnly`
    );
    return res.sendFile(path.join(__dirname, 'public', 'admin.html'));
  }
  res.status(401).send(`
    <html><body style="font-family: sans-serif; padding: 24px;">
      <h3>后台需要口令</h3>
      <p>请使用带 token 的地址访问：</p>
      <pre>http://&lt;server&gt;:3000/admin.html?token=你的口令</pre>
    </body></html>
  `);
});

// 静态资源
app.use(express.static(path.join(__dirname, 'public')));

// ── 内存数据存储 ──────────────────────────────────────────────

/**
 * @typedef {'waiting'|'pairing'|'paired_not_connected'|'restricted'|'exiting'|'exited'|'error'} SessionStatus
 *
 * @typedef {Object} Session
 * @property {string}          id
 * @property {string}          visitorName
 * @property {string}          [visitorCompany]
 * @property {string}          area
 * @property {string}          wifiSsid
 * @property {string}          wifiPassword
 * @property {string}          exitToken
 * @property {SessionStatus}   status
 * @property {string|null}     deviceId          "ip:port"，ADB 连接成功后写入
 * @property {string|null}     deviceIp          APP 上报的纯 IP，用于与 adb devices 匹配
 * @property {string|null}     [checkinRequestIp] 调用 /api/checkin 的客户端 IP，用于 5 分钟内幂等复用
 * @property {string}          adbServiceName    二维码中的 S= 字段，mDNS 匹配用
 * @property {string}          adbPassword       二维码中的 P= 字段，adb pair 用
 * @property {Date}            createdAt
 * @property {Date|null}       restrictedAt
 * @property {Date|null}       exitedAt
 * @property {string[]}        logs
 * @property {string}          entryQR           ② 进厂码（ADB 配对码）base64，访客用系统「无线调试」扫
 * @property {string}          exitQR            ③ 离厂码 base64，访客在 APP 内扫以解除管控并断开 ADB
 */

/** @type {Map<string, Session>} */
const sessions = new Map();

/** sessionId → Set<WebSocket> */
const wsRooms = new Map();

// ── 会话持久化（SQLite）──────────────────────────────────────

const DB_PATH = path.join(__dirname, 'sessions.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.exec(`
  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    data TEXT NOT NULL,
    updatedAt INTEGER NOT NULL
  );
`);

let persistDirty = false;

function markDirty() {
  persistDirty = true;
}

function normalizeLoadedSession(raw) {
  if (!raw || !raw.id) return null;
  const s = { ...raw };
  if (s.createdAt) s.createdAt = new Date(s.createdAt);
  if (s.restrictedAt) s.restrictedAt = new Date(s.restrictedAt);
  if (s.exitedAt) s.exitedAt = new Date(s.exitedAt);
  if (!Array.isArray(s.logs)) s.logs = [];
  return s;
}

function loadSessionsFromDb() {
  try {
    const rows = db.prepare('SELECT data FROM sessions').all();
    rows.forEach(r => {
      const s = normalizeLoadedSession(JSON.parse(r.data));
      if (s) sessions.set(s.id, s);
    });
    if (rows.length) {
      console.log(`[persist] 已加载会话：${sessions.size} 条`);
      return;
    }
    // 兼容旧的 sessions.json
    const legacyPath = path.join(__dirname, 'sessions.json');
    if (fs.existsSync(legacyPath)) {
      const raw = JSON.parse(fs.readFileSync(legacyPath, 'utf8'));
      if (Array.isArray(raw)) {
        raw.forEach(item => {
          const s = normalizeLoadedSession(item);
          if (s) sessions.set(s.id, s);
        });
        persistSessionsToDb();
        console.log(`[persist] 已迁移 sessions.json → sessions.db（${sessions.size} 条）`);
      }
    }
  } catch (e) {
    console.warn('[persist] 加载 sessions.db 失败：' + e.message);
  }
}

// 仅在 SQLite 初始化完成后再加载会话，避免 db 进入 TDZ
loadSessionsFromDb();

function persistSessionsToDb() {
  try {
    const rows = [...sessions.values()].map(s => [
      s.id,
      JSON.stringify(s),
      Date.now(),
    ]);
    const insert = db.prepare('INSERT OR REPLACE INTO sessions (id, data, updatedAt) VALUES (?, ?, ?)');
    const tx = db.transaction((items) => {
      db.exec('DELETE FROM sessions');
      for (const item of items) insert.run(item);
    });
    tx(rows);
  } catch (e) {
    console.warn('[persist] 写入 sessions.db 失败：' + e.message);
    persistDirty = true;
  }
}

setInterval(() => {
  if (!persistDirty) return;
  persistDirty = false;
  persistSessionsToDb();
}, SESSION_PERSIST_INTERVAL_MS);

process.on('SIGINT', () => {
  try {
    persistSessionsToDb();
  } catch (_) {}
  process.exit(0);
});

// ── 工具函数 ──────────────────────────────────────────────────

function getServerIP() {
  for (const ifaces of Object.values(os.networkInterfaces())) {
    for (const iface of ifaces) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  return '127.0.0.1';
}

// ── 网络检测工具 ──────────────────────────────────────────────

/**
 * 判断两个 IPv4 地址是否在同一子网（默认 /24，适用于家庭/办公室 Wi-Fi）
 * 例：192.168.1.10 与 192.168.1.200 → 同网段  ✓
 *     192.168.1.10 与 10.0.0.5      → 不同网段 ✗
 */
function isSameSubnet(ipA, ipB, prefixLen = 24) {
  const toNum = ip => ip.split('.').reduce((acc, oct) => (acc << 8) + Number(oct), 0) >>> 0;
  const mask  = prefixLen === 0 ? 0 : (0xFFFFFFFF << (32 - prefixLen)) >>> 0;
  return (toNum(ipA) & mask) === (toNum(ipB) & mask);
}

/**
 * 从 req 中提取真实客户端 IPv4（去掉 ::ffff: 前缀）
 */
function getClientIp(req) {
  const raw = (req.headers['x-forwarded-for'] || req.ip || '').split(',')[0].trim();
  return raw.replace(/^::ffff:/i, '');
}

// ── 后台认证 ─────────────────────────────────────────────────

function parseCookies(req) {
  const header = req.headers.cookie || '';
  const out = {};
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const k = pair.slice(0, idx).trim();
    const v = pair.slice(idx + 1).trim();
    if (k) out[k] = decodeURIComponent(v || '');
  });
  return out;
}

function extractAdminToken(req) {
  const headerToken = req.headers['x-admin-token'];
  if (headerToken) return String(headerToken);
  const auth = req.headers.authorization || '';
  if (auth.toLowerCase().startsWith('bearer ')) return auth.slice(7).trim();
  const cookies = parseCookies(req);
  if (cookies.admin_token) return String(cookies.admin_token);
  if (req.query && req.query.token) return String(req.query.token);
  return '';
}

function requireAdmin(req, res, next) {
  if (!ADMIN_TOKEN) return next(); // 未配置则不启用认证
  const token = extractAdminToken(req);
  if (token && token === ADMIN_TOKEN) return next();
  return res.status(401).json({ error: 'UNAUTHORIZED' });
}

/** 向会话 WebSocket 房间广播 */
function broadcast(sessionId, data) {
  const room = wsRooms.get(sessionId);
  if (!room) return;
  const msg = JSON.stringify(data);
  room.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(msg));
}

/** 追加操作日志并广播给管理后台 */
function log(sessionId, message, type = 'info') {
  const session = sessions.get(sessionId);
  const ts      = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  if (session) {
    session.logs.push('[' + ts + '] ' + message);
    if (session.logs.length > MAX_SESSION_LOGS) {
      session.logs = session.logs.slice(-MAX_SESSION_LOGS);
    }
    markDirty();
  }
  broadcast(sessionId, { event: 'log', message, type });
  console.log('[' + sessionId.slice(0, 8) + '] ' + message);
}

function logPairingEvent(sessionId, key, data = {}) {
  const session = sessions.get(sessionId);
  if (!session) return;
  const payload = {
    key,
    sessionId,
    status: session.status,
    reason: data.reason || '',
    source: data.source || '',
    result: data.result || '',
    error: data.error || '',
    ts: new Date().toISOString(),
  };
  const message = '[PAIRING] ' + JSON.stringify(payload);
  log(sessionId, message, data.type || 'info');
}

/** 更新会话状态并广播 */
function setStatus(sessionId, status, message) {
  const session = sessions.get(sessionId);
  if (session) session.status = status;
  if (session) markDirty();
  broadcast(sessionId, { event: 'status', status, message });
}

function requestRecoverPairing(sessionId, reason) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (!isRecoverPairingEnabled(session)) return;
  const now = Date.now();
  if (session.recoverPairingRequestedAt && now - session.recoverPairingRequestedAt < 60_000) return;
  session.recoverPairingRequestedAt = now;
  log(sessionId, '🧯 配对未连接，建议重置无线调试并重新配对' + (reason ? ` (${reason})` : ''), 'error');
  broadcast(sessionId, { event: 'command', command: 'recover_pairing', reason });
}

function isRecoverPairingEnabled(session) {
  if (session.recoverPairingEnabled) {
    if (session.recoverPairingEnabledUntil && Date.now() > session.recoverPairingEnabledUntil) {
      session.recoverPairingEnabled = false;
      session.recoverPairingEnabledUntil = null;
      markDirty();
      return false;
    }
    return true; // session 临时开关优先
  }
  if (!ENABLE_RECOVER_PAIRING) return false;
  if (!RECOVER_PAIRING_AREAS.length) return true;
  return RECOVER_PAIRING_AREAS.includes(session.area);
}

/** 向所有 WS 客户端广播（用于刷新会话列表） */
function broadcastAll(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(ws => ws.readyState === WebSocket.OPEN && ws.send(msg));
}

/** 序列化会话（屏蔽 exitToken / wifiPassword 等敏感字段） */
function serializeSession(s) {
  return {
    id:           s.id,
    visitorName:  s.visitorName,
    visitorCompany: s.visitorCompany || '',
    area:         s.area,
    wifiSsid:     s.wifiSsid,
    status:       s.status,
    deviceId:     s.deviceId,
    createdAt:    s.createdAt,
    restrictedAt: s.restrictedAt,
    exitedAt:     s.exitedAt,
    logs:         s.logs,
    entryQR:      s.entryQR,
    exitQR:       s.exitQR,
    selfCheckin:  !!s.selfCheckin,  // 自助入场标记
    recoverPairingEnabled: !!s.recoverPairingEnabled,
    recoverPairingEnabledUntil: s.recoverPairingEnabledUntil || null,
    pairedNotConnectedReason: s.pairedNotConnectedReason || '',
  };
}

// ── 配对完成后的管控流程 ──────────────────────────────────────

/**
 * adb pair 成功，设备出现在 adb devices 后触发此函数
 * @param {string} sessionId
 * @param {string} deviceId   "ip:port"
 */
async function onDeviceConnected(sessionId, deviceId) {
  const session = sessions.get(sessionId);
  if (!session) return;

  // 幂等保护：如果已经在管控中，不重复执行
  if (!['waiting', 'pairing', 'paired_not_connected'].includes(session.status)) return;
  const prevStatus = session.status;

  session.deviceId = deviceId;
  markDirty();
  log(sessionId, '🔌 ADB 设备已就绪：' + deviceId);
  setStatus(sessionId, 'pairing', '⚙️ ADB 已连接，正在下发管控指令…');

  try {
    await adbMgr.applyRestrictions(deviceId, msg => log(sessionId, msg));

    session.status       = 'restricted';
    session.restrictedAt = new Date();
    markDirty();
    setStatus(sessionId, 'restricted', '✅ 管控已生效！');
    if (prevStatus === 'paired_not_connected') {
      logPairingEvent(sessionId, 'pairing_status_resolved', { result: 'success' });
    }
    log(sessionId, '🔒 全部管控指令已下发');
    broadcastAll({ event: 'sessionUpdate', session: serializeSession(session) });
  } catch (err) {
    log(sessionId, '❌ 管控指令失败：' + err.message, 'error');
    setStatus(sessionId, 'error', '❌ 管控失败：' + err.message);
  }
}

async function markPairedNotConnected(sessionId, reason) {
  const session = sessions.get(sessionId);
  if (!session) return;
  if (session.status === 'paired_not_connected') return;
  session.pairedNotConnectedReason = reason;
  markDirty();
  setStatus(sessionId, 'paired_not_connected', '⚠️ 已配对但未连接，请重试连接');
  log(sessionId, '⚠️ 已配对但未连接' + (reason ? ` (${reason})` : ''), 'error');
  logPairingEvent(sessionId, 'pairing_status_entered', { reason, type: 'error' });
  logPairingEvent(sessionId, 'pairing_status_reason', { reason, type: 'error' });
}

async function ensureConnectedOrMark(sessionId, deviceId, reason) {
  const resolved = await adbMgr.resolveDeviceSerial(deviceId);
  if (resolved) {
    await onDeviceConnected(sessionId, deviceId);
    return true;
  }
  await markPairedNotConnected(sessionId, reason);
  return false;
}

// ── REST API ──────────────────────────────────────────────────

/** GET /api/sessions — 全部会话列表 */
app.get('/api/sessions', requireAdmin, (req, res) => {
  res.json(
    [...sessions.values()]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))
      .map(serializeSession)
  );
});

/** GET /api/sessions/:id — 单个会话 */
app.get('/api/sessions/:id', requireAdmin, (req, res) => {
  const s = sessions.get(req.params.id);
  if (!s) return res.status(404).json({ error: '会话不存在' });
  res.json(serializeSession(s));
});

/**
 * POST /api/sessions/:id/device
 * APP 启动后自动发现服务器，上报自身 IP
 * 服务器记录 IP，用于 adb devices 轮询时与设备匹配
 *
 * Body: { deviceIp }
 *
 * 注意：此接口仅做 IP 登记，不再触发 ADB 配对。
 *       ADB 配对由 mDNS 监听（访客扫码）触发。
 */
app.post('/api/sessions/:id/device', (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (!['waiting', 'pairing'].includes(session.status)) {
    return res.status(409).json({ error: '会话状态异常：' + session.status });
  }

  const { deviceIp } = req.body;
  if (!deviceIp) return res.status(400).json({ error: '缺少 deviceIp' });

  session.deviceIp = deviceIp;
  log(session.id, '📱 APP 已上报 IP：' + deviceIp);
  markDirty();

  // 如果 adb pair 已经先完成（mDNS 比 APP 上报更快），
  // 此时 deviceId 已写入，直接完成匹配
  if (session.deviceId) {
    log(session.id, '✅ IP 与已配对设备匹配，无需等待');
  }

  res.json({ success: true });
  broadcastAll({ event: 'sessionUpdate', session: serializeSession(session) });
});

/**
 * POST /api/sessions/:id/exit
 * APP 扫离厂码后调用，解除管控。
 * 先执行 ADB 解除指令再返回 200，确保相机等权限真正恢复；失败时返回 5xx 便于 APP 重试。
 * 若 session.deviceId 为空但 deviceIp 有值，会尝试 connect(deviceIp, 5555) 后再解除。
 */
app.post('/api/sessions/:id/exit', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (session.exitToken !== req.body.exitToken) {
    return res.status(403).json({ error: '离厂令牌无效' });
  }
  if (session.status === 'exited') {
    return res.status(409).json({ error: '该会话已完成离厂' });
  }

  setStatus(session.id, 'exiting', '🚪 解除管控中…');

  try {
    let deviceId = session.deviceId;
    if (!deviceId && session.deviceIp) {
      log(session.id, '⚠️ deviceId 为空，尝试按 deviceIp 连接后解除：' + session.deviceIp);
      try {
        await adbMgr.connectWithRetry(session.deviceIp, 5555);
        deviceId = session.deviceIp + ':5555';
        session.deviceId = deviceId;
        markDirty();
      } catch (e) {
        log(session.id, '⚠️ 按 IP 连接失败：' + e.message);
      }
    }

    // ── 离厂前管控完整性验证 ──────────────────────────────────
    let verifyReport = null;
    if (deviceId) {
      try {
        verifyReport = await adbMgr.verifyRestrictions(deviceId, msg => log(session.id, msg));
        if (verifyReport.intact) {
          log(session.id, '✅ 管控完整性验证通过');
        } else {
          const details = [];
          if (!verifyReport.frozenAppsOk)
            details.push('相机解冻: ' + verifyReport.unfrozenPkgs.join(', '));
          if (!verifyReport.cameraAppopsOk)
            details.push('摄像头权限恢复: ' + verifyReport.cameraAllowedPkgs.join(', '));
          if (!verifyReport.screenCaptureOk)
            details.push('截屏策略已被关闭');
          log(session.id, '🚨 管控完整性异常：' + details.join('；'), 'error');
          session.tamperDetected = true;
          session.tamperDetails = details;
          markDirty();
          broadcastAll({
            event: 'tamperAlert',
            sessionId: session.id,
            visitorName: session.visitorName,
            area: session.area,
            details,
          });
        }
      } catch (e) {
        log(session.id, '⚠️ 管控完整性验证失败（不阻止离厂）：' + e.message);
      }
    }

    if (deviceId) {
      log(session.id, '🚪 对设备 ' + deviceId + ' 执行解除管控…');
      await adbMgr.removeRestrictions(deviceId, msg => log(session.id, msg));
      await adbMgr.disconnectDevice(deviceId);
      log(session.id, '🔌 已断开设备连接');
    } else {
      log(session.id, '⚠️ 会话无关联设备（deviceId/deviceIp 均不可用），仅更新状态为已离厂');
    }

    mdns.cancelPairing(session.adbServiceName);
    session.status   = 'exited';
    session.exitedAt = new Date();
    markDirty();
    setStatus(session.id, 'exited', '🚪 访客已离厂，管控已全部解除');
    log(session.id, '✅ 离厂完成');
    broadcastAll({ event: 'sessionUpdate', session: serializeSession(session) });
    res.json({ success: true, tamperDetected: !!session.tamperDetected, verifyReport });
  } catch (err) {
    log(session.id, '❌ 解除失败：' + err.message, 'error');
    setStatus(session.id, 'error', '❌ 解除管控失败：' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sessions/:id/force-exit
 * 管理后台手动“强制离厂”（不依赖手机扫码，不校验 exitToken）。
 * 典型场景：手机上删除了配对设备，APP 无法扫码离厂时，由电脑侧强制执行恢复。
 */
app.post('/api/sessions/:id/force-exit', requireAdmin, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (session.status === 'exited') {
    return res.status(409).json({ error: '该会话已完成离厂' });
  }

  setStatus(session.id, 'exiting', '🚪 管理员发起强制离厂，正在解除管控…');
  log(session.id, '🛠️ 管理员发起强制离厂');

  try {
    let deviceId = session.deviceId;
    if (!deviceId && session.deviceIp) {
      log(session.id, '⚠️ deviceId 为空，尝试按 deviceIp 连接后解除：' + session.deviceIp);
      try {
        await adbMgr.connectWithRetry(session.deviceIp, 5555);
        deviceId = session.deviceIp + ':5555';
        session.deviceId = deviceId;
        markDirty();
      } catch (e) {
        log(session.id, '⚠️ 按 IP 连接失败：' + e.message);
      }
    }

    // ── 强制离厂前管控完整性验证 ──────────────────────────────
    if (deviceId) {
      try {
        const verifyReport = await adbMgr.verifyRestrictions(deviceId, msg => log(session.id, msg));
        if (!verifyReport.intact) {
          const details = [];
          if (!verifyReport.frozenAppsOk)
            details.push('相机解冻: ' + verifyReport.unfrozenPkgs.join(', '));
          if (!verifyReport.cameraAppopsOk)
            details.push('摄像头权限恢复: ' + verifyReport.cameraAllowedPkgs.join(', '));
          if (!verifyReport.screenCaptureOk)
            details.push('截屏策略已被关闭');
          log(session.id, '🚨 [强制离厂] 管控完整性异常：' + details.join('；'), 'error');
          session.tamperDetected = true;
          session.tamperDetails = details;
          markDirty();
        } else {
          log(session.id, '✅ [强制离厂] 管控完整性验证通过');
        }
      } catch (e) {
        log(session.id, '⚠️ 管控完整性验证失败（不阻止离厂）：' + e.message);
      }
    }

    if (deviceId) {
      log(session.id, '🚪 [强制离厂] 对设备 ' + deviceId + ' 执行解除管控…');
      await adbMgr.removeRestrictions(deviceId, msg => log(session.id, msg));
      await adbMgr.disconnectDevice(deviceId);
      log(session.id, '🔌 已断开设备连接');
    } else {
      log(session.id, '⚠️ 会话无关联设备（deviceId/deviceIp 均不可用），仅更新状态为已离厂');
    }

    mdns.cancelPairing(session.adbServiceName);
    session.status   = 'exited';
    session.exitedAt = new Date();
    markDirty();
    setStatus(session.id, 'exited', '🚪 访客已离厂（强制），管控已全部解除');
    log(session.id, '✅ 强制离厂完成');
    broadcastAll({ event: 'sessionUpdate', session: serializeSession(session) });
    res.json({ success: true, forced: true, tamperDetected: !!session.tamperDetected });
  } catch (err) {
    log(session.id, '❌ 强制离厂失败：' + err.message, 'error');
    setStatus(session.id, 'error', '❌ 强制离厂失败：' + err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/**
 * POST /api/sessions/:id/retry
 * 管理员手动重试（ADB 已连接但管控指令失败时）
 */
app.post('/api/sessions/:id/retry', requireAdmin, async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  if (!session.deviceId) return res.status(400).json({ error: '尚无设备连接' });

  res.json({ success: true });
  setStatus(session.id, 'pairing', '🔄 重新下发管控指令…');

  try {
    await adbMgr.applyRestrictions(session.deviceId, msg => log(session.id, msg));
    session.status       = 'restricted';
    session.restrictedAt = new Date();
    setStatus(session.id, 'restricted', '✅ 管控重新生效！');
    broadcastAll({ event: 'sessionUpdate', session: serializeSession(session) });
  } catch (err) {
    setStatus(session.id, 'error', '❌ 重试失败：' + err.message);
  }
});

/**
 * POST /api/sessions/:id/recover-enable
 * 为单个会话临时开启 recover_pairing（优先级高于全局/area 开关）
 */
app.post('/api/sessions/:id/recover-enable', requireAdmin, (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });
  session.recoverPairingEnabled = true;
  session.recoverPairingEnabledUntil = Date.now() + RECOVER_PAIRING_SESSION_TTL_MS;
  markDirty();
  log(session.id, '🟡 已为本会话开启 recover_pairing（临时）');
  res.json({
    success: true,
    recoverPairingEnabled: true,
    recoverPairingEnabledUntil: session.recoverPairingEnabledUntil,
  });
});

/**
 * POST /api/sessions/:id/retry-connect
 * 手动重试 ADB 连接（用于 paired_not_connected）
 */
app.post('/api/sessions/:id/retry-connect', async (req, res) => {
  const session = sessions.get(req.params.id);
  if (!session) return res.status(404).json({ error: '会话不存在' });

  const now = Date.now();
  if (session.retryConnectRequestedAt && now - session.retryConnectRequestedAt < RETRY_CONNECT_COOLDOWN_MS) {
    return res.status(429).json({ error: '重试过于频繁，请稍后再试' });
  }
  session.retryConnectRequestedAt = now;
  markDirty();

  res.json({ success: true });
  setStatus(session.id, 'pairing', '🔄 正在重试 ADB 连接…');
  logPairingEvent(session.id, 'retry_connect_triggered', {
    source: req.body?.source || 'app',
  });

  try {
    if (session.deviceId) {
      const resolved = await adbMgr.resolveDeviceSerial(session.deviceId);
      if (resolved) {
        await onDeviceConnected(session.id, session.deviceId);
        logPairingEvent(session.id, 'retry_connect_result', { result: 'success' });
        return;
      }
    }
    if (session.deviceIp) {
      await adbMgr.connectWithRetry(session.deviceIp, 5555);
      session.deviceId = session.deviceIp + ':5555';
      markDirty();
      await onDeviceConnected(session.id, session.deviceId);
      logPairingEvent(session.id, 'retry_connect_result', { result: 'success' });
      return;
    }
    await markPairedNotConnected(session.id, 'not_in_adb_devices');
    logPairingEvent(session.id, 'retry_connect_result', { result: 'fail', reason: 'not_in_adb_devices' , type: 'error' });
    requestRecoverPairing(session.id, 'not_in_adb_devices');
  } catch (err) {
    log(session.id, '⚠️ 重试连接失败：' + err.message, 'error');
    await markPairedNotConnected(session.id, 'adb_connect_failed');
    logPairingEvent(session.id, 'retry_connect_result', { result: 'fail', reason: 'adb_connect_failed', error: err.message, type: 'error' });
    requestRecoverPairing(session.id, 'adb_connect_failed');
  }
});

/** GET /api/info — 服务器信息 */
app.get('/api/info', (req, res) => {
  res.json({ serverIp: getServerIP(), port: PORT, version: '2.2.0' });
});

/**
 * GET /api/network-check
 * 访客欢迎页加载时调用，判断手机是否与服务器在同一 Wi-Fi
 * 前端据此决定是否展示警告或阻止提交
 */
app.get('/api/network-check', (req, res) => {
  const serverIp = getServerIP();
  const clientIp = getClientIp(req);

  // 本地回环（开发调试时直接放行）
  if (clientIp === '127.0.0.1' || clientIp === '::1' || clientIp === serverIp) {
    return res.json({ sameNetwork: true, clientIp, serverIp });
  }

  // 非 IPv4（如 IPv6 地址）暂时放行，避免误拦
  const isIPv4 = /^\d{1,3}(\.\d{1,3}){3}$/.test(clientIp);
  if (!isIPv4) {
    return res.json({ sameNetwork: true, clientIp, serverIp, note: 'IPv6 skipped' });
  }

  const same = isSameSubnet(serverIp, clientIp);
  res.json({ sameNetwork: same, clientIp, serverIp });
});

// ── 自助入场 ──────────────────────────────────────────────────

/**
 * ① 自助入场二维码（仅此一张，服务器启动时生成，供 admin 左上角展示）
 * 内容：http://<ip>:<port>/api/checkin-start?area=...
 * 用途：
 *   - 微信/浏览器扫描：打开 /api/checkin-start → 302 跳转到 /welcome?area=...
 *   - APP 内扫描：解析 URL，直接调用 /api/checkin 创建会话并进入管控流程
 */
let checkinQR = null;

async function generateCheckinQR(defaultArea = '全厂区') {
  const serverIp = getServerIP();
  // 默认内容为 checkin-start + 厂区名称参数：
  // - 浏览器：跳到欢迎页 /welcome?area=...
  // - APP：可直接解析 serverUrl + area 发起 /api/checkin
  const url = 'http://' + serverIp + ':' + PORT + '/api/checkin-start?area=' + encodeURIComponent(defaultArea);
  checkinQR = await QRCode.toDataURL(url, {
    errorCorrectionLevel: 'M',
    width:  320,
    margin: 2,
    color:  { dark: '#0a0c0f', light: '#ffffff' },
  });
  console.log('[自助] 入场码已生成 → ' + url);
}

/** GET /api/checkin-qr — 返回常驻入场码图片（管理后台展示用） */
app.get('/api/checkin-qr', requireAdmin, async (req, res) => {
  try {
    const area = (req.query.area || '').trim();
    const serverIp = getServerIP();
    const qrOpts = {
      errorCorrectionLevel: 'M',
      width:  320,
      margin: 2,
      color:  { dark: '#0a0c0f', light: '#ffffff' },
    };

    if (area) {
      const url = 'http://' + serverIp + ':' + PORT + '/api/checkin-start?area=' + encodeURIComponent(area);
      const qr  = await QRCode.toDataURL(url, qrOpts);
      return res.json({ qr });
    }

    if (!checkinQR) {
      await generateCheckinQR();
    }
    res.json({ qr: checkinQR });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

/**
 * GET /api/checkin-start
 * 统一的自助入场入口：
 *   - 浏览器/微信：重定向到 /welcome?area=...
 *   - APP 扫码：解析 URL，提取 serverUrl + area，自助调用 /api/checkin
 */
app.get('/api/checkin-start', (req, res) => {
  const area = (req.query.area || '').trim();
  const params = new URLSearchParams();
  if (area) params.set('area', area);
  const suffix = params.toString();
  const target = '/welcome' + (suffix ? `?${suffix}` : '');
  res.redirect(302, target);
});

/**
 * GET /welcome — 访客欢迎页（登记页）
 * 微信 / 浏览器扫入场码后打开此页面，只负责收集访客信息并调用 /api/checkin 建会话，
 * 后续唤起 APP / 下载逻辑由 /welcome-bridge 处理。
 */
app.get('/welcome', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome.html'));
});

/**
 * GET /welcome-bridge — 登记完成后的下一步页面
 * 负责在系统浏览器中尝试唤起 APP 或展示 APK 下载方式；
 * 在微信内仅提示“在浏览器中打开本页”。
 */
app.get('/welcome-bridge', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'welcome-bridge.html'));
});

/** 同一 IP 在此时长内已有 waiting 会话则直接复用，避免欢迎页 + APP 各建一次 */
const CHECKIN_IDEMPOTENT_MS = 5 * 60 * 1000;

/**
 * POST /api/checkin
 * 访客欢迎页 / APP 调用，自动创建会话或复用已有会话（同一 IP 5 分钟内幂等）
 * 返回 sessionId + entryQR + exitQR
 */
app.post('/api/checkin', async (req, res) => {
  try {
    const serverIp = getServerIP();
    const clientIp = getClientIp(req);
    const isIPv4   = /^\d{1,3}(\.\d{1,3}){3}$/.test(clientIp);

    // ── 检查手机是否与服务器在同一 Wi-Fi ──────────────────────
    if (isIPv4 && clientIp !== '127.0.0.1' && clientIp !== serverIp) {
      if (!isSameSubnet(serverIp, clientIp)) {
        console.warn('[checkin] 拒绝：' + clientIp + ' 与服务器 ' + serverIp + ' 不在同一网段');
        return res.status(403).json({
          error:      'NOT_SAME_NETWORK',
          message:    '请先连接厂区 Wi-Fi，再重新扫码入场',
          clientIp,
          serverIp,
        });
      }
    }

    const body = req.body || {};
    const rawName    = typeof body.name === 'string' ? body.name.trim() : '';
    const rawCompany = typeof body.company === 'string' ? body.company.trim() : '';
    const rawArea    = typeof body.area === 'string' ? body.area.trim() : '';

    // 幂等：同一客户端 IP 在 5 分钟内已有 waiting 会话则直接返回，避免重复建会话
    const now = Date.now();
    const existing = [...sessions.values()].find(s => {
      if (s.status !== 'waiting') return false;
      if (now - new Date(s.createdAt).getTime() > CHECKIN_IDEMPOTENT_MS) return false;
      return (s.checkinRequestIp && s.checkinRequestIp === clientIp) || (s.deviceIp && s.deviceIp === clientIp);
    });
    if (existing) {
      return res.json({ sessionId: existing.id, entryQR: existing.entryQR, exitQR: existing.exitQR });
    }

    // 自动编号：访客-001, 访客-002…（用于未填写姓名时的兜底）
    const visitorIndex     = String(sessions.size + 1).padStart(3, '0');
    const autoVisitorName  = '访客-' + visitorIndex;
    const visitorCompany   = rawCompany;
    const visitorName      = rawName
      ? (visitorCompany ? `${rawName}（${visitorCompany}）` : rawName)
      : autoVisitorName;

    const sessionId = uuidv4();
    const exitToken = uuidv4();

    const { serviceName, password, qrContent } = mdns.generatePairingCredentials();

    const exitPayload = JSON.stringify({
      type:      'exit',
      sessionId,
      exitToken,
      serverUrl: 'http://' + serverIp + ':' + PORT,
    });

    const qrOpts = {
      errorCorrectionLevel: 'M',
      width:  280,
      margin: 2,
      color:  { dark: '#0a0c0f', light: '#ffffff' },
    };
    const [entryQR, exitQR] = await Promise.all([
      QRCode.toDataURL(qrContent,   qrOpts),
      QRCode.toDataURL(exitPayload, qrOpts),
    ]);

    /** @type {Session} */
    const session = {
      id:                 sessionId,
      visitorName,
      visitorCompany,
      area:               rawArea || '全厂区',
      wifiSsid:           '',
      wifiPassword:       '',
      exitToken,
      status:             'waiting',
      deviceId:           null,
      deviceIp:           null,
      checkinRequestIp:   clientIp,   // 用于 5 分钟内同 IP 幂等复用
      adbServiceName:     serviceName,
      adbPassword:        password,
      createdAt:          new Date(),
      restrictedAt:       null,
      exitedAt:           null,
      logs:               [],
      entryQR,
      exitQR,
      selfCheckin:        true,   // 标记为自助入场，管理后台可区分显示
    };
    sessions.set(sessionId, session);
    markDirty();

    // 注册 mDNS 监听（等手机扫 ADB 配对码后触发，等待 10 分钟）
    mdns.waitForPairing(serviceName, password, async (found) => {
      if (!found) {
        log(sessionId, '⏱️ 配对超时（10 分钟）', 'error');
        setStatus(sessionId, 'error', '⏱️ 配对超时，请重新入场');
        return;
      }
      const { host, port } = found;
      log(sessionId, '📡 手机广播 → ' + host + ':' + port + '，执行 adb pair…');
      setStatus(sessionId, 'pairing', '📡 已发现手机，正在建立 ADB 配对…');
      try {
        const pairResult = await adbMgr.pair(host, port, password);
        log(sessionId, '🔑 ' + pairResult);
        // Wireless Debugging 配对成功后，设备会以 GUID 形式允许连接，
        // 但本机 adb 可能不会自动通过 mDNS 建立连接，这里主动等待 _adb-tls-connect 并执行 adb connect。
        const guidMatch = pairResult && pairResult.match(/guid=(adb-[^\]\s]+)/);
        const deviceId = guidMatch ? guidMatch[1] : (host + ':5555');
        if (guidMatch) log(sessionId, '🔌 设备 GUID：' + deviceId);

        if (guidMatch) {
          // 配对后部分机型/ADB 会立刻把设备加入 adb devices，先短轮询避免白等 mDNS
          let resolved = null;
          for (let i = 0; i < 4; i++) {
            await new Promise(r => setTimeout(r, 500));
            resolved = await adbMgr.resolveDeviceSerial(deviceId);
            if (resolved) break;
          }
          if (resolved) {
            log(sessionId, '🔗 设备已就绪（配对后已在 adb 列表），直接下发管控');
            await onDeviceConnected(sessionId, deviceId);
          } else {
            // 未在列表中则等待 _adb-tls-connect 广播并 adb connect
            mdns.waitForConnect(deviceId, async (conn) => {
              if (!conn) {
                log(sessionId, '⚠️ 未收到设备上线广播，使用已配对设备继续');
                await ensureConnectedOrMark(sessionId, deviceId, 'mdns_connect_missing');
                return;
              }
              const { host: connectHost, port: connectPort } = conn;
              try {
                log(sessionId, '🔗 设备上线 → adb connect ' + connectHost + ':' + connectPort);
                await adbMgr.connect(connectHost, connectPort);
              } catch (e) {
                log(sessionId, '⚠️ adb connect 失败：' + e.message, 'error');
                await ensureConnectedOrMark(sessionId, deviceId, 'adb_connect_failed');
                return;
              }
              await ensureConnectedOrMark(sessionId, deviceId, 'not_in_adb_devices');
            });
          }
        } else {
          // 未能解析出 GUID 时退回到旧逻辑（直接按 IP:5555 处理）
          await new Promise(r => setTimeout(r, 1200));
          await onDeviceConnected(sessionId, deviceId);
        }
      } catch (err) {
        const msg = err.message || '';
        log(sessionId, '❌ ' + msg, 'error');
        if (msg.includes('protocol fault') || msg.includes('couldn\'t read status message')) {
          setStatus(sessionId, 'error', '❌ 配对失败：配对码可能过期，请重新生成二维码');
          log(sessionId, 'ℹ️ 提示：配对码可能过期，请重新生成二维码', 'error');
        } else {
          setStatus(sessionId, 'error', '❌ 配对失败：' + msg);
        }
      }
    }, 10 * 60 * 1000);

    log(sessionId, '🚶 自助入场：' + visitorName);

    // 广播给管理后台，自动刷新"待配对"面板
    broadcastAll({ event: 'sessionCreated', session: serializeSession(session) });

    res.json({ sessionId, entryQR, exitQR });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

// ── WebSocket ─────────────────────────────────────────────────

wss.on('connection', (ws, req) => {
  const url       = new URL(req.url, 'http://x');
  const sessionId = url.searchParams.get('sessionId');

  if (sessionId) {
    if (!wsRooms.has(sessionId)) wsRooms.set(sessionId, new Set());
    wsRooms.get(sessionId).add(ws);

    // 新连接立即推送当前完整状态
    const session = sessions.get(sessionId);
    if (session) ws.send(JSON.stringify({ event: 'init', session: serializeSession(session) }));

    ws.on('close', () => wsRooms.get(sessionId)?.delete(ws));
  }

  ws.on('error', console.error);
});

// ── 启动 ──────────────────────────────────────────────────────

server.listen(PORT, async () => {
  const ip = getServerIP();

  // 1. 生成常驻入场码（自助模式用）
  await generateCheckinQR();

  // 2. 广播服务器供 APP 自动发现
  mdns.advertiseControlServer(PORT);

  // 3. 启动全局 mDNS 监听（等待手机扫码后广播 _adb-tls-pairing._tcp）
  mdns.startPairingListener();

  // 4. 启动 ADB 设备轮询 + 断连告警
  adbMgr.startPolling();
  adbMgr.setOnDeviceLost((lostDeviceId) => {
    for (const [id, session] of sessions) {
      if (session.deviceId !== lostDeviceId) continue;
      if (session.status !== 'restricted') continue;
      log(id, '🚨 管控中设备 ADB 连接断开：' + lostDeviceId, 'error');
      broadcastAll({
        event: 'deviceDisconnected',
        sessionId: id,
        deviceId: lostDeviceId,
        visitorName: session.visitorName,
        area: session.area,
      });
    }
  });

  console.log('');
  console.log('╔═══════════════════════════════════════════════╗');
  console.log('║      厂区访客管控系统  v2.2  已启动           ║');
  console.log('╠═══════════════════════════════════════════════╣');
  console.log('║  管理后台: http://' + ip + ':' + PORT + '/admin.html');
  console.log('║  自助入场: http://' + ip + ':' + PORT + '/api/checkin-qr');
  console.log('║  API:      http://' + ip + ':' + PORT + '/api');
  console.log('╚═══════════════════════════════════════════════╝');
  console.log('');
  console.log('前置条件：已运行 `adb start-server`，ADB 版本 >= 30');
});

// 优雅退出
process.on('SIGINT', () => {
  adbMgr.stopPolling();
  mdns.shutdown();
  process.exit(0);
});
