'use strict';
/**
 * db/index.js — SQLite 数据库初始化与 Schema
 *
 * 表结构：
 *   users            — 租户账号（含超管标记）
 *   subscriptions    — 订阅（每个厂区一条，含 WiFi IP 绑定）
 *   payments         — 支付记录（人工确认流程）
 *   visitor_sessions — 访客会话（隶属于某个 subscription）
 */

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const config   = require('../config');

// 确保数据目录存在
const dbDir = path.dirname(config.db.path);
if (!fs.existsSync(dbDir)) fs.mkdirSync(dbDir, { recursive: true });

const db = new Database(config.db.path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

// ── Schema ────────────────────────────────────────────────────

db.exec(`
  -- 用户（租户）
  CREATE TABLE IF NOT EXISTS users (
    id            TEXT PRIMARY KEY,
    email         TEXT UNIQUE NOT NULL,
    password_hash TEXT NOT NULL,
    name          TEXT NOT NULL,
    phone         TEXT DEFAULT '',
    is_super_admin INTEGER NOT NULL DEFAULT 0,
    status        TEXT NOT NULL DEFAULT 'active',  -- active | suspended
    created_at    INTEGER NOT NULL,
    last_login_at INTEGER
  );

  -- 订阅（每个厂区一条）
  CREATE TABLE IF NOT EXISTS subscriptions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    area_name       TEXT NOT NULL DEFAULT '我的厂区',
    plan            TEXT NOT NULL DEFAULT 'trial',  -- trial | monthly | yearly
    status          TEXT NOT NULL DEFAULT 'trial',  -- trial | active | expired | cancelled
    trial_starts_at INTEGER NOT NULL,
    trial_ends_at   INTEGER NOT NULL,
    paid_starts_at  INTEGER,
    paid_ends_at    INTEGER,
    wifi_subnet     TEXT,          -- 绑定的 IP 前缀，如 "192.168.1"
    wifi_locked     INTEGER NOT NULL DEFAULT 0,  -- 0=未绑定 1=已绑定
    notes           TEXT DEFAULT '',
    created_at      INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 支付记录
  CREATE TABLE IF NOT EXISTS payments (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    subscription_id  TEXT NOT NULL,
    plan             TEXT NOT NULL,     -- monthly | yearly
    amount_fen       INTEGER NOT NULL,  -- 金额（分）
    status           TEXT NOT NULL DEFAULT 'pending',  -- pending | confirmed | rejected | refunded
    txn_id           TEXT DEFAULT '',   -- 用户填写的交易流水号
    notes            TEXT DEFAULT '',
    created_at       INTEGER NOT NULL,
    confirmed_at     INTEGER,
    confirmed_by     TEXT,              -- super admin user_id
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id)
  );

  -- 访客会话（隶属于某个 subscription）
  CREATE TABLE IF NOT EXISTS visitor_sessions (
    id              TEXT PRIMARY KEY,
    subscription_id TEXT NOT NULL,
    user_id         TEXT NOT NULL,
    data            TEXT NOT NULL,     -- JSON
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_payments_user_id      ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_visitor_sessions_sub  ON visitor_sessions(subscription_id);
  CREATE INDEX IF NOT EXISTS idx_visitor_sessions_uid  ON visitor_sessions(user_id);
`);

// ── 初始化超管账号 ────────────────────────────────────────────

function ensureSuperAdmin() {
  const existing = db.prepare('SELECT id FROM users WHERE is_super_admin = 1').get();
  if (existing) return;

  const id   = uuidv4();
  const hash = bcrypt.hashSync(config.superAdmin.password, 10);
  db.prepare(`
    INSERT INTO users (id, email, password_hash, name, is_super_admin, status, created_at)
    VALUES (?, ?, ?, ?, 1, 'active', ?)
  `).run(id, config.superAdmin.email, hash, config.superAdmin.name, Date.now());

  console.log(`[DB] 超管账号已创建：${config.superAdmin.email}`);
}

ensureSuperAdmin();

// ── Prepared Statements ───────────────────────────────────────

const stmts = {
  // users
  getUserById:    db.prepare('SELECT * FROM users WHERE id = ?'),
  getUserByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  insertUser:     db.prepare(`
    INSERT INTO users (id, email, password_hash, name, phone, status, created_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?)
  `),
  updateUserLogin: db.prepare('UPDATE users SET last_login_at = ? WHERE id = ?'),
  listUsers:       db.prepare('SELECT id, email, name, phone, is_super_admin, status, created_at, last_login_at FROM users ORDER BY created_at DESC'),
  updateUserStatus:db.prepare('UPDATE users SET status = ? WHERE id = ?'),

  // subscriptions
  getSubById:  db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
  getSubsByUser: db.prepare('SELECT * FROM subscriptions WHERE user_id = ? ORDER BY created_at DESC'),
  insertSub:   db.prepare(`
    INSERT INTO subscriptions
      (id, user_id, area_name, plan, status, trial_starts_at, trial_ends_at, wifi_subnet, wifi_locked, created_at)
    VALUES (?, ?, ?, 'trial', 'trial', ?, ?, NULL, 0, ?)
  `),
  updateSubPlan: db.prepare(`
    UPDATE subscriptions SET plan=?, status='active', paid_starts_at=?, paid_ends_at=? WHERE id=?
  `),
  updateSubStatus: db.prepare('UPDATE subscriptions SET status = ? WHERE id = ?'),
  bindSubIp:    db.prepare('UPDATE subscriptions SET wifi_subnet = ?, wifi_locked = 1 WHERE id = ?'),
  unbindSubIp:  db.prepare('UPDATE subscriptions SET wifi_subnet = NULL, wifi_locked = 0 WHERE id = ?'),
  updateSubAreaName: db.prepare('UPDATE subscriptions SET area_name = ? WHERE id = ?'),
  listAllSubs:  db.prepare('SELECT s.*, u.email, u.name as user_name FROM subscriptions s JOIN users u ON s.user_id = u.id ORDER BY s.created_at DESC'),

  // payments
  getPaymentById:  db.prepare('SELECT * FROM payments WHERE id = ?'),
  getPaymentsBySub: db.prepare('SELECT * FROM payments WHERE subscription_id = ? ORDER BY created_at DESC'),
  getPaymentsByUser: db.prepare('SELECT p.*, s.area_name FROM payments p JOIN subscriptions s ON p.subscription_id = s.id WHERE p.user_id = ? ORDER BY p.created_at DESC'),
  listPendingPayments: db.prepare(`
    SELECT p.*, u.email, u.name as user_name, s.area_name
    FROM payments p
    JOIN users u ON p.user_id = u.id
    JOIN subscriptions s ON p.subscription_id = s.id
    WHERE p.status = 'pending' ORDER BY p.created_at DESC
  `),
  insertPayment: db.prepare(`
    INSERT INTO payments (id, user_id, subscription_id, plan, amount_fen, status, txn_id, notes, created_at)
    VALUES (?, ?, ?, ?, ?, 'pending', ?, ?, ?)
  `),
  confirmPayment: db.prepare(`
    UPDATE payments SET status='confirmed', confirmed_at=?, confirmed_by=? WHERE id=?
  `),
  rejectPayment: db.prepare(`
    UPDATE payments SET status='rejected', confirmed_at=?, confirmed_by=?, notes=? WHERE id=?
  `),

  // visitor_sessions
  getVisitorSession: db.prepare('SELECT * FROM visitor_sessions WHERE id = ?'),
  getSessionsBySub:  db.prepare('SELECT * FROM visitor_sessions WHERE subscription_id = ? ORDER BY updated_at DESC'),
  upsertVisitorSession: db.prepare(`
    INSERT OR REPLACE INTO visitor_sessions (id, subscription_id, user_id, data, updated_at)
    VALUES (?, ?, ?, ?, ?)
  `),
  deleteVisitorSession: db.prepare('DELETE FROM visitor_sessions WHERE id = ?'),
  deleteExpiredSessions: db.prepare(`
    DELETE FROM visitor_sessions WHERE updated_at < ? AND json_extract(data, '$.status') = 'exited'
  `),
};

// ── 订阅有效性检查 ────────────────────────────────────────────

/**
 * 判断订阅当前是否有效（试用期内 OR 付费期内）
 */
function isSubscriptionActive(sub) {
  const now = Date.now();
  if (sub.status === 'cancelled' || sub.status === 'suspended') return false;
  if (sub.status === 'trial') return now <= sub.trial_ends_at;
  if (sub.status === 'active') return sub.paid_ends_at && now <= sub.paid_ends_at;
  return false;
}

/**
 * 检查并更新过期订阅状态（在每次查询订阅时调用）
 */
function refreshSubStatus(sub) {
  if (!isSubscriptionActive(sub) && sub.status !== 'cancelled') {
    db.prepare("UPDATE subscriptions SET status = 'expired' WHERE id = ?").run(sub.id);
    sub.status = 'expired';
  }
  return sub;
}

/**
 * 计算订阅剩余天数
 */
function subRemainingDays(sub) {
  const now = Date.now();
  if (sub.status === 'trial') return Math.max(0, Math.ceil((sub.trial_ends_at - now) / 86400000));
  if (sub.status === 'active' && sub.paid_ends_at) return Math.max(0, Math.ceil((sub.paid_ends_at - now) / 86400000));
  return 0;
}

module.exports = {
  db,
  stmts,
  isSubscriptionActive,
  refreshSubStatus,
  subRemainingDays,
};
