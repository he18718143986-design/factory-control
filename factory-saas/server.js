'use strict';
/**
 * server.js — 厂区管控 SaaS 主入口
 * 职责：HTTP 服务器 + WebSocket + 启动序列
 */

// ── 全局错误兜底（防止进程崩溃）────────────────────────────
process.on('uncaughtException',  err => console.error('[FATAL] uncaughtException:', err));
process.on('unhandledRejection', err => console.error('[FATAL] unhandledRejection:', err));

const express     = require('express');
const http        = require('http');
const WebSocket   = require('ws');
const cors        = require('cors');
const cookieParser = require('cookie-parser');
const path        = require('path');

const config = require('./config');
const { ensureCsrfToken, csrfProtection } = require('./middleware/csrf');

// ── 初始化 HTTP 服务器 ────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ server });
app.disable('x-powered-by');
app.set('trust proxy', config.http.trustProxy);

// ── 广播模块初始化 ────────────────────────────────────────────
const wsHub = require('./broadcast/ws');
wsHub.init(wss);

// ── 中间件 ───────────────────────────────────────────────────
app.use(express.json({ limit: '200kb' }));
app.use(cookieParser());
app.use(ensureCsrfToken);

app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('Content-Security-Policy', config.security.csp);
  if (config.isProd && config.http.enableHsts) {
    res.setHeader('Strict-Transport-Security', `max-age=${config.http.hstsMaxAge}; includeSubDomains`);
  }
  next();
});

function isOriginAllowed(origin) {
  if (!origin) return true; // non-browser / same-origin navigation
  if (!config.isProd) return true;
  const allowed = config.http.allowedOrigins;
  if (!allowed.length) return false;
  if (allowed.includes('*')) return true;
  return allowed.includes(origin);
}

app.use(cors({
  origin: (origin, cb) => {
    if (isOriginAllowed(origin)) return cb(null, true);
    return cb(new Error('CORS_NOT_ALLOWED'));
  },
  credentials: true,
}));
app.use(csrfProtection);

// 静态资源
app.use(express.static(path.join(__dirname, 'public')));

// ── 路由挂载 ─────────────────────────────────────────────────
app.use(require('./routes/auth'));
app.use(require('./routes/user'));
app.use(require('./routes/admin'));
app.use(require('./routes/checkin'));
app.use(require('./routes/device'));

// ── 根路由重定向 ─────────────────────────────────────────────
app.get('/', (req, res) => res.redirect('/login'));

// ── 统一错误处理（避免泄露堆栈）───────────────────────────────
app.use((err, req, res, next) => {
  if (!err) return next();
  if (res.headersSent) return next(err);
  if (err.message === 'CORS_NOT_ALLOWED') {
    return res.status(403).json({ error: 'CORS_FORBIDDEN' });
  }
  if (!config.isProd) {
    return res.status(500).json({ error: 'INTERNAL_ERROR', message: err.message });
  }
  return res.status(500).json({ error: 'INTERNAL_ERROR' });
});

// ── WebSocket 连接处理 ────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const url  = new URL(req.url, 'http://x');
  const sid  = url.searchParams.get('sessionId');
  const siteId = url.searchParams.get('siteId');

  ws.siteId = siteId || null;
  ws.subscriptionId = null;

  if (siteId) {
    const { stmts } = require('./db');
    const sub = stmts.getSubBySiteId.get(siteId);
    ws.subscriptionId = sub?.id || null;
  }

  if (sid) {
    wsHub.joinRoom(sid, ws);
    // 推送当前完整状态
    const { getSession } = require('./sessions/store');
    const { serializeSession } = require('./sessions/serialize');
    const session = getSession(sid);
    if (session) ws.send(JSON.stringify({ event: 'init', session: serializeSession(session) }));
    ws.on('close', () => wsHub.leaveRoom(sid, ws));
  }

  ws.on('error', err => console.error('[WS]', err.message));
});

// ── ADB 设备轮询 + 断连检测 ───────────────────────────────────
const adbMgr = require('./adb');
const { getSession } = require('./sessions/store');
const { serializeSession } = require('./sessions/serialize');
const { broadcastToSub } = require('./broadcast/ws');
const { setStatus: flowSetStatus, log: flowLog } = require('./pairing/flow');
const { markDirty } = require('./sessions/store');

adbMgr.startPolling();
adbMgr.setOnDeviceLost((lostDeviceId) => {
  // 找到所有使用该设备 ID 且处于 restricted/pairing 状态的会话
  const { stmts, db } = require('./db');
  const rows = db.prepare("SELECT id, subscription_id FROM visitor_sessions WHERE json_extract(data,'$.deviceId') = ?").all(lostDeviceId);
  rows.forEach(row => {
    const session = getSession(row.id);
    if (!session) return;
    if (!['restricted', 'pairing'].includes(session.status)) return;
    flowLog(session, '🚨 管控中设备 ADB 连接断开：' + lostDeviceId, 'error');
    broadcastToSub(session.subscriptionId, {
      event: 'deviceDisconnected',
      sessionId: session.id, deviceId: lostDeviceId,
      visitorName: session.visitorName, area: session.area,
    });
    session.pairedNotConnectedReason = 'device_disconnected';
    session.status = 'paired_not_connected';
    markDirty();
    flowSetStatus(session, 'paired_not_connected', '⚠️ ADB 连接断开，请让访客确认 WiFi 后点击重试');
    broadcastToSub(session.subscriptionId, { event: 'sessionUpdate', session: serializeSession(session) });
  });
});

// ── 生命周期定时检查 ─────────────────────────────────────────
require('./sessions/lifecycle').start();

// ── mDNS 启动 ────────────────────────────────────────────────
const mdns = require('./mdns');
mdns.advertiseControlServer(config.port);
mdns.startPairingListener();

// ── IP 变更检测 ──────────────────────────────────────────────
const { getServerIP } = require('./utils/network');
let lastIP = getServerIP();
setInterval(() => {
  const ip = getServerIP();
  if (ip !== lastIP) { lastIP = ip; console.log('[IP] 服务器 IP 变更：' + ip); }
}, 30000);

// ── ADB 版本检查 ─────────────────────────────────────────────
async function checkAdb() {
  try {
    const { exec } = require('child_process');
    const out = await new Promise((res, rej) => exec('adb version', { timeout: 5000 }, (e, s) => e ? rej(e) : res(s)));
    const m = out.match(/(\d+\.\d+\.\d+)/);
    console.log('[ADB] 版本：' + (m ? m[1] : out.trim()));
  } catch { console.warn('[ADB] ⚠️ adb 未安装或不可用'); }
}

// ── 端口冲突 ─────────────────────────────────────────────────
server.on('error', err => {
  if (err.code === 'EADDRINUSE') {
    console.error(`\n❌ 端口 ${config.port} 已被占用\n`);
    process.exit(1);
  }
  throw err;
});

// ── 优雅停机 ─────────────────────────────────────────────────
function gracefulShutdown(sig) {
  console.log(`\n[${sig}] 正在优雅关闭…`);
  require('./sessions/store').persist();
  adbMgr.stopPolling();
  mdns.shutdown();
  server.close(() => { console.log('服务器已关闭'); process.exit(0); });
  setTimeout(() => process.exit(1), 8000);
}
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));

// ── 启动 ─────────────────────────────────────────────────────
server.listen(config.port, async () => {
  const ip = getServerIP();
  await checkAdb();

  console.log('');
  console.log('╔════════════════════════════════════════════════════╗');
  console.log('║     厂区访客管控 SaaS  v2.0  已启动               ║');
  console.log('╠════════════════════════════════════════════════════╣');
  console.log(`║  登录页:   http://${ip}:${config.port}/login`);
  console.log(`║  超管后台: http://${ip}:${config.port}/admin`);
  console.log(`║  用户控制台: http://${ip}:${config.port}/dashboard`);
  console.log('╚════════════════════════════════════════════════════╝');
  console.log('');
});
