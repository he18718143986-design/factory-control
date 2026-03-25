'use strict';
/**
 * sessions/store.js — 内存 + SQLite 双层会话存储
 * sessions Map 按 subscriptionId 分组：subSessions.get(subId) → Map<sessionId, session>
 */

const { stmts }   = require('../db');
const { normalizeLoadedSession } = require('./serialize');
const config = require('../config');

// subscriptionId → Map<sessionId, session>
const subSessions = new Map();
// sessionId → subscriptionId (快速反查)
const sessionToSub = new Map();

let dirty = false;
function markDirty() { dirty = true; }

function persistOne(session) {
  try {
    stmts.upsertVisitorSession.run(
      session.id,
      session.subscriptionId,
      session.userId || '',
      JSON.stringify(session),
      Date.now()
    );
  } catch (e) {
    console.warn('[store] persistOne error:', e.message);
    dirty = true;
  }
}

// ── CRUD ────────────────────────────────────────────────────

function getSession(sessionId) {
  const subId = sessionToSub.get(sessionId);
  return subId ? subSessions.get(subId)?.get(sessionId) : null;
}

function getSessions(subscriptionId) {
  return subSessions.get(subscriptionId) || new Map();
}

function setSession(session, options = {}) {
  const subId = session.subscriptionId;
  if (!subSessions.has(subId)) subSessions.set(subId, new Map());
  subSessions.get(subId).set(session.id, session);
  sessionToSub.set(session.id, subId);
  if (!options.skipPersist) persistOne(session);
  markDirty();
}

function deleteSession(sessionId) {
  const subId = sessionToSub.get(sessionId);
  if (subId) {
    subSessions.get(subId)?.delete(sessionId);
    sessionToSub.delete(sessionId);
    stmts.deleteVisitorSession.run(sessionId);
  }
}

// ── 持久化 ───────────────────────────────────────────────────

function persist() {
  try {
    const tx = stmts.db ? null : null;   // stmts.db not exported; use db directly
    const { db } = require('../db');
    const upsert = db.prepare(`
      INSERT OR REPLACE INTO visitor_sessions (id, subscription_id, user_id, data, updated_at)
      VALUES (?, ?, ?, ?, ?)
    `);
    const persistAll = db.transaction(() => {
      for (const [, sessions] of subSessions) {
        for (const [, s] of sessions) {
          upsert.run(s.id, s.subscriptionId, s.userId || '', JSON.stringify(s), Date.now());
        }
      }
    });
    persistAll();
  } catch (e) {
    console.warn('[store] persist error:', e.message);
    dirty = true;
  }
}

setInterval(() => {
  if (!dirty) return;
  dirty = false;
  persist();
}, config.timing.persistIntervalMs);

// ── 启动加载 ─────────────────────────────────────────────────

function loadFromDb() {
  try {
    const { db } = require('../db');
    const rows = db.prepare('SELECT * FROM visitor_sessions').all();
    let fixed = 0;
    rows.forEach(row => {
      const s = normalizeLoadedSession(JSON.parse(row.data));
      if (!s) return;
      s.subscriptionId = row.subscription_id;
      s.userId         = row.user_id;
      // 服务重启后未完成配对的会话修复
      if (s.status === 'waiting' || s.status === 'pairing') {
        s.pairedNotConnectedReason = 'server_restart';
        s.status = s.deviceIp ? 'paired_not_connected' : 'error';
        fixed++;
      }
      setSession(s, { skipPersist: true });
    });
    if (fixed) { console.log(`[store] 重启修复 ${fixed} 个未完成会话`); persist(); }
    console.log(`[store] 已加载 ${rows.length} 个访客会话`);
  } catch (e) {
    console.warn('[store] loadFromDb error:', e.message);
  }
}

loadFromDb();

process.on('SIGINT',  () => { persist(); process.exit(0); });
process.on('SIGTERM', () => { persist(); process.exit(0); });

module.exports = { getSession, getSessions, setSession, deleteSession, markDirty, persist };
