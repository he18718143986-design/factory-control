'use strict';
/**
 * db/index.js — SQLite 数据库初始化与 Schema
 *
 * 表结构：
 *   users            — 租户账号（含超管标记）
 *   sites            — 厂区主表（计费与管控单元）
 *   subscriptions    — 订阅（绑定 site_id）
 *   payments         — 支付记录（人工确认流程）
 *   visitor_sessions — 访客会话（隶属于某个 subscription）
 */

const Database = require('better-sqlite3');
const bcrypt   = require('bcryptjs');
const { v4: uuidv4 } = require('uuid');
const path     = require('path');
const fs       = require('fs');
const config   = require('../config');
const { runMigrations } = require('./migrations');

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

  -- 厂区
  CREATE TABLE IF NOT EXISTS sites (
    id            TEXT PRIMARY KEY,
    user_id       TEXT NOT NULL,
    name          TEXT NOT NULL,
    address       TEXT DEFAULT '',
    status        TEXT NOT NULL DEFAULT 'active',  -- active | disabled
    created_at    INTEGER NOT NULL,
    updated_at    INTEGER NOT NULL,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 订阅（每个厂区一条）
  CREATE TABLE IF NOT EXISTS subscriptions (
    id              TEXT PRIMARY KEY,
    user_id         TEXT NOT NULL,
    site_id         TEXT,
    area_name       TEXT NOT NULL DEFAULT '我的厂区',
    plan            TEXT NOT NULL DEFAULT 'trial',  -- trial | monthly | yearly
    status          TEXT NOT NULL DEFAULT 'trial',  -- trial | active | grace | expired | suspended | cancelled
    trial_starts_at INTEGER NOT NULL,
    trial_ends_at   INTEGER NOT NULL,
    paid_starts_at  INTEGER,
    paid_ends_at    INTEGER,
    grace_ends_at   INTEGER,
    cancelled_at    INTEGER,
    wifi_subnet     TEXT,          -- 绑定的 IP 前缀，如 "192.168.1"
    wifi_locked     INTEGER NOT NULL DEFAULT 0,  -- 0=未绑定 1=已绑定
    notes           TEXT DEFAULT '',
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER,
    FOREIGN KEY (user_id) REFERENCES users(id)
  );

  -- 厂区网络绑定（可多条）
  CREATE TABLE IF NOT EXISTS site_network_bindings (
    id              TEXT PRIMARY KEY,
    site_id         TEXT NOT NULL,
    status          TEXT NOT NULL DEFAULT 'active',   -- active | revoked
    lan_subnet      TEXT,                             -- 兼容当前实现：存 /24 前缀，例如 192.168.1
    public_ip       TEXT DEFAULT '',
    ssid            TEXT DEFAULT '',
    bssid           TEXT DEFAULT '',
    gateway_ip      TEXT DEFAULT '',
    gateway_mac     TEXT DEFAULT '',
    confidence      INTEGER NOT NULL DEFAULT 0,
    source          TEXT NOT NULL DEFAULT 'unknown',
    first_seen_at   INTEGER NOT NULL,
    last_seen_at    INTEGER NOT NULL,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );

  -- 网络重绑定申请
  CREATE TABLE IF NOT EXISTS network_rebind_requests (
    id                TEXT PRIMARY KEY,
    site_id           TEXT NOT NULL,
    requested_by      TEXT NOT NULL,
    candidate_subnet  TEXT NOT NULL,
    candidate_ip      TEXT DEFAULT '',
    candidate_fingerprint_json TEXT DEFAULT '{}',
    evidence          TEXT DEFAULT '',
    risk_score        INTEGER NOT NULL DEFAULT 0,
    reason            TEXT DEFAULT '',
    status            TEXT NOT NULL DEFAULT 'pending_review', -- pending_review | approved | rejected | cancelled
    review_note       TEXT DEFAULT '',
    reviewed_by       TEXT,
    reviewed_at       INTEGER,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (requested_by) REFERENCES users(id),
    FOREIGN KEY (reviewed_by) REFERENCES users(id)
  );

  -- 审计日志
  CREATE TABLE IF NOT EXISTS audit_logs (
    id             TEXT PRIMARY KEY,
    actor_user_id  TEXT,
    actor_role     TEXT NOT NULL,
    site_id        TEXT,
    action         TEXT NOT NULL,
    target_type    TEXT NOT NULL,
    target_id      TEXT NOT NULL,
    ip             TEXT DEFAULT '',
    ua             TEXT DEFAULT '',
    payload_json   TEXT DEFAULT '{}',
    created_at     INTEGER NOT NULL,
    FOREIGN KEY (actor_user_id) REFERENCES users(id),
    FOREIGN KEY (site_id) REFERENCES sites(id)
  );

  -- 套餐
  CREATE TABLE IF NOT EXISTS plans (
    id             TEXT PRIMARY KEY,
    code           TEXT UNIQUE NOT NULL,   -- monthly | yearly
    name           TEXT NOT NULL,
    duration_days  INTEGER NOT NULL,
    amount_fen     INTEGER NOT NULL,
    status         TEXT NOT NULL DEFAULT 'active',  -- active | inactive
    sort_order     INTEGER NOT NULL DEFAULT 0,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
  );

  -- 订单（支付与订阅续期的主流程）
  CREATE TABLE IF NOT EXISTS orders (
    id               TEXT PRIMARY KEY,
    user_id          TEXT NOT NULL,
    site_id          TEXT NOT NULL,
    subscription_id  TEXT NOT NULL,
    plan_code        TEXT NOT NULL,
    duration_days    INTEGER NOT NULL,
    amount_fen       INTEGER NOT NULL,
    status           TEXT NOT NULL DEFAULT 'pending_payment', -- pending_payment | paid_pending_review | confirmed | rejected | cancelled | expired
    idempotency_key  TEXT DEFAULT '',
    txn_id           TEXT DEFAULT '',
    note             TEXT DEFAULT '',
    reject_reason    TEXT DEFAULT '',
    created_at       INTEGER NOT NULL,
    updated_at       INTEGER NOT NULL,
    paid_at          INTEGER,
    confirmed_at     INTEGER,
    confirmed_by     TEXT,
    FOREIGN KEY (user_id) REFERENCES users(id),
    FOREIGN KEY (site_id) REFERENCES sites(id),
    FOREIGN KEY (subscription_id) REFERENCES subscriptions(id),
    FOREIGN KEY (confirmed_by) REFERENCES users(id)
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

  CREATE INDEX IF NOT EXISTS idx_sites_user_id         ON sites(user_id);
  CREATE INDEX IF NOT EXISTS idx_subscriptions_user_id ON subscriptions(user_id);
  CREATE INDEX IF NOT EXISTS idx_site_bindings_site_status ON site_network_bindings(site_id, status);
  CREATE INDEX IF NOT EXISTS idx_site_bindings_lan_subnet  ON site_network_bindings(lan_subnet);
  CREATE INDEX IF NOT EXISTS idx_site_bindings_bssid       ON site_network_bindings(bssid);
  CREATE INDEX IF NOT EXISTS idx_site_bindings_gateway_mac ON site_network_bindings(gateway_mac);
  CREATE INDEX IF NOT EXISTS idx_rebind_site_status ON network_rebind_requests(site_id, status);
  CREATE INDEX IF NOT EXISTS idx_rebind_created_at  ON network_rebind_requests(created_at);
  CREATE INDEX IF NOT EXISTS idx_rebind_risk_score  ON network_rebind_requests(risk_score, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_actor      ON audit_logs(actor_user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_audit_site       ON audit_logs(site_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_plans_status_sort ON plans(status, sort_order);
  CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_site_created ON orders(site_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_subscription ON orders(subscription_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_orders_user_idempotency ON orders(user_id, idempotency_key, created_at);
  CREATE INDEX IF NOT EXISTS idx_payments_user_id      ON payments(user_id);
  CREATE INDEX IF NOT EXISTS idx_visitor_sessions_sub  ON visitor_sessions(subscription_id);
  CREATE INDEX IF NOT EXISTS idx_visitor_sessions_uid  ON visitor_sessions(user_id);
`);

const migrationResult = runMigrations(db, { autoApply: config.db.autoMigrate });
if (!config.db.autoMigrate && migrationResult.pending.length) {
  const versions = migrationResult.pending.map(m => `v${m.version}`).join(', ');
  throw new Error(`PENDING_MIGRATIONS: ${versions}. 请先执行: npm run db:migrate`);
}
if (migrationResult.applied.length) {
  const appliedNames = migrationResult.applied.map(m => `v${m.version}:${m.name}`).join(', ');
  console.log(`[DB] 已应用迁移: ${appliedNames}`);
}

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

  // sites
  getSiteById: db.prepare('SELECT * FROM sites WHERE id = ?'),
  getSitesByUser: db.prepare('SELECT * FROM sites WHERE user_id = ? ORDER BY created_at DESC'),
  insertSite: db.prepare(`
    INSERT INTO sites (id, user_id, name, address, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'active', ?, ?)
  `),
  updateSiteName: db.prepare('UPDATE sites SET name = ?, updated_at = ? WHERE id = ?'),

  // subscriptions
  getSubById:  db.prepare('SELECT * FROM subscriptions WHERE id = ?'),
  getSubBySiteId: db.prepare('SELECT * FROM subscriptions WHERE site_id = ? ORDER BY created_at DESC LIMIT 1'),
  getSubsByUser: db.prepare(`
    SELECT s.*, si.name AS site_name, si.status AS site_status
    FROM subscriptions s
    LEFT JOIN sites si ON si.id = s.site_id
    WHERE s.user_id = ?
    ORDER BY s.created_at DESC
  `),
  insertSub:   db.prepare(`
    INSERT INTO subscriptions
      (id, user_id, site_id, area_name, plan, status, trial_starts_at, trial_ends_at, wifi_subnet, wifi_locked, created_at, updated_at)
    VALUES (?, ?, ?, ?, 'trial', 'trial', ?, ?, NULL, 0, ?, ?)
  `),
  updateSubPlan: db.prepare(`
    UPDATE subscriptions
    SET plan=?, status='active', paid_starts_at=?, paid_ends_at=?, grace_ends_at=NULL, cancelled_at=NULL, updated_at=?
    WHERE id=?
  `),
  updateSubStatus: db.prepare(`
    UPDATE subscriptions
    SET
      status = ?,
      cancelled_at = CASE
        WHEN ? = 'cancelled' THEN COALESCE(cancelled_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
        ELSE NULL
      END,
      updated_at = CAST(strftime('%s','now') AS INTEGER) * 1000
    WHERE id = ?
  `),
  bindSubIp:    db.prepare('UPDATE subscriptions SET wifi_subnet = ?, wifi_locked = 1 WHERE id = ?'),
  bindSubIpBySite: db.prepare('UPDATE subscriptions SET wifi_subnet = ?, wifi_locked = 1 WHERE site_id = ?'),
  unbindSubIp:  db.prepare('UPDATE subscriptions SET wifi_subnet = NULL, wifi_locked = 0 WHERE id = ?'),
  updateSubAreaName: db.prepare('UPDATE subscriptions SET area_name = ? WHERE id = ?'),
  listAllSubs:  db.prepare(`
    SELECT s.*, u.email, u.name as user_name, si.name AS site_name, si.status AS site_status
    FROM subscriptions s
    JOIN users u ON s.user_id = u.id
    LEFT JOIN sites si ON s.site_id = si.id
    ORDER BY s.created_at DESC
  `),
  listActiveSiteBindings: db.prepare(`
    SELECT * FROM site_network_bindings
    WHERE site_id = ? AND status = 'active'
    ORDER BY created_at DESC
  `),
  getSiteBindingBySubnet: db.prepare(`
    SELECT * FROM site_network_bindings
    WHERE site_id = ? AND status = 'active' AND lan_subnet = ?
    LIMIT 1
  `),
  insertSiteBinding: db.prepare(`
    INSERT INTO site_network_bindings
      (id, site_id, status, lan_subnet, public_ip, ssid, bssid, gateway_ip, gateway_mac, confidence, source, first_seen_at, last_seen_at, created_at, updated_at)
    VALUES
      (?, ?, 'active', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),
  touchSiteBindingSeenAt: db.prepare(`
    UPDATE site_network_bindings
    SET last_seen_at = ?, updated_at = ?
    WHERE id = ?
  `),
  revokeSiteBindingsBySite: db.prepare(`
    UPDATE site_network_bindings
    SET status = 'revoked', updated_at = ?
    WHERE site_id = ? AND status = 'active'
  `),
  getRebindRequestById: db.prepare('SELECT * FROM network_rebind_requests WHERE id = ?'),
  listRebindRequestsBySite: db.prepare(`
    SELECT r.*, u.email AS requested_by_email, su.name AS site_name
    FROM network_rebind_requests r
    JOIN users u ON u.id = r.requested_by
    JOIN sites su ON su.id = r.site_id
    WHERE r.site_id = ?
    ORDER BY r.created_at DESC
  `),
  listRebindRequestsForAdmin: db.prepare(`
    SELECT r.*, u.email AS requested_by_email, su.name AS site_name, owner.email AS owner_email
    FROM network_rebind_requests r
    JOIN users u ON u.id = r.requested_by
    JOIN sites su ON su.id = r.site_id
    JOIN users owner ON owner.id = su.user_id
    WHERE (? = '' OR r.status = ?)
    ORDER BY r.created_at DESC
  `),
  insertRebindRequest: db.prepare(`
    INSERT INTO network_rebind_requests
      (id, site_id, requested_by, candidate_subnet, candidate_ip, candidate_fingerprint_json, evidence, risk_score, reason, status, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending_review', ?, ?)
  `),
  getPendingRebindBySiteAndSubnet: db.prepare(`
    SELECT * FROM network_rebind_requests
    WHERE site_id = ? AND candidate_subnet = ? AND status = 'pending_review'
    LIMIT 1
  `),
  updateRebindRequestApprove: db.prepare(`
    UPDATE network_rebind_requests
    SET status = 'approved', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ?
  `),
  updateRebindRequestReject: db.prepare(`
    UPDATE network_rebind_requests
    SET status = 'rejected', review_note = ?, reviewed_by = ?, reviewed_at = ?, updated_at = ?
    WHERE id = ?
  `),
  insertAuditLog: db.prepare(`
    INSERT INTO audit_logs
      (id, actor_user_id, actor_role, site_id, action, target_type, target_id, ip, ua, payload_json, created_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `),

  // plans
  listActivePlans: db.prepare(`
    SELECT code, name, duration_days, amount_fen, sort_order
    FROM plans
    WHERE status = 'active'
    ORDER BY sort_order ASC, created_at ASC
  `),
  getPlanByCode: db.prepare(`
    SELECT * FROM plans WHERE code = ? LIMIT 1
  `),
  upsertPlanByCode: db.prepare(`
    INSERT INTO plans (id, code, name, duration_days, amount_fen, status, sort_order, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
    ON CONFLICT(code) DO UPDATE SET
      name=excluded.name,
      duration_days=excluded.duration_days,
      amount_fen=excluded.amount_fen,
      status='active',
      sort_order=excluded.sort_order,
      updated_at=excluded.updated_at
  `),

  // orders
  getOrderById: db.prepare('SELECT * FROM orders WHERE id = ?'),
  getOrderByUserAndIdempotency: db.prepare(`
    SELECT * FROM orders
    WHERE user_id = ? AND idempotency_key = ? AND idempotency_key != ''
    ORDER BY created_at DESC
    LIMIT 1
  `),
  listOrdersByUser: db.prepare(`
    SELECT o.*, s.area_name, si.name AS site_name
    FROM orders o
    JOIN subscriptions s ON s.id = o.subscription_id
    LEFT JOIN sites si ON si.id = o.site_id
    WHERE o.user_id = ?
    ORDER BY o.created_at DESC
  `),
  listOrdersForAdmin: db.prepare(`
    SELECT o.*, u.email, u.name AS user_name, s.area_name, si.name AS site_name
    FROM orders o
    JOIN users u ON u.id = o.user_id
    JOIN subscriptions s ON s.id = o.subscription_id
    LEFT JOIN sites si ON si.id = o.site_id
    WHERE (? = '' OR o.status = ?)
    ORDER BY o.created_at DESC
  `),
  insertOrder: db.prepare(`
    INSERT INTO orders
      (id, user_id, site_id, subscription_id, plan_code, duration_days, amount_fen, status, idempotency_key, txn_id, note, reject_reason, created_at, updated_at)
    VALUES
      (?, ?, ?, ?, ?, ?, ?, 'pending_payment', ?, '', '', '', ?, ?)
  `),
  markOrderPaidPendingReview: db.prepare(`
    UPDATE orders
    SET status='paid_pending_review', txn_id=?, note=?, paid_at=?, updated_at=?
    WHERE id=? AND status='pending_payment'
  `),
  markOrderConfirmed: db.prepare(`
    UPDATE orders
    SET status='confirmed', confirmed_at=?, confirmed_by=?, updated_at=?
    WHERE id=? AND status='paid_pending_review'
  `),
  markOrderRejected: db.prepare(`
    UPDATE orders
    SET status='rejected', reject_reason=?, confirmed_by=?, confirmed_at=?, updated_at=?
    WHERE id=? AND status='paid_pending_review'
  `),

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
  confirmPaymentIfPending: db.prepare(`
    UPDATE payments
    SET status='confirmed', confirmed_at=?, confirmed_by=?
    WHERE id=? AND status='pending'
  `),
  rejectPayment: db.prepare(`
    UPDATE payments SET status='rejected', confirmed_at=?, confirmed_by=?, notes=? WHERE id=?
  `),
  rejectPaymentIfPending: db.prepare(`
    UPDATE payments
    SET status='rejected', confirmed_at=?, confirmed_by=?, notes=?
    WHERE id=? AND status='pending'
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

function ensureDefaultPlans() {
  const now = Date.now();
  stmts.upsertPlanByCode.run(uuidv4(), 'monthly', '月度套餐', 30, config.pricing.monthlyFen, 10, now, now);
  stmts.upsertPlanByCode.run(uuidv4(), 'yearly', '年度套餐', 365, config.pricing.yearlyFen, 20, now, now);
}

ensureDefaultPlans();

// ── 订阅有效性检查 ────────────────────────────────────────────

function getSubscriptionPolicy(overrides = {}) {
  return {
    enableGracePeriod: config.subscription.enableGracePeriod,
    graceDays: config.subscription.graceDays,
    allowIssueInGrace: config.subscription.allowIssueInGrace,
    ...overrides,
  };
}

function getSubscriptionLifecycleState(sub, now = Date.now(), policyOverrides = {}) {
  if (!sub) return 'expired';
  const policy = getSubscriptionPolicy(policyOverrides);

  if (sub.status === 'cancelled') return 'cancelled';
  if (sub.status === 'suspended') return 'suspended';

  if (sub.status === 'trial') {
    return now <= Number(sub.trial_ends_at || 0) ? 'trial' : 'expired';
  }

  const paidEndsAt = Number(sub.paid_ends_at || 0);
  if (sub.status === 'active') {
    if (paidEndsAt && now <= paidEndsAt) return 'active';
    if (policy.enableGracePeriod) {
      const graceEndsAt = Number(sub.grace_ends_at || (paidEndsAt ? paidEndsAt + policy.graceDays * 86400000 : 0));
      if (graceEndsAt && now <= graceEndsAt) return 'grace';
    }
    return 'expired';
  }

  if (sub.status === 'grace') {
    const graceEndsAt = Number(sub.grace_ends_at || (paidEndsAt ? paidEndsAt + policy.graceDays * 86400000 : 0));
    return graceEndsAt && now <= graceEndsAt ? 'grace' : 'expired';
  }

  return sub.status || 'expired';
}

function canIssueQr(sub, policyOverrides = {}) {
  const state = getSubscriptionLifecycleState(sub, Date.now(), policyOverrides);
  const policy = getSubscriptionPolicy(policyOverrides);
  if (state === 'trial' || state === 'active') return true;
  if (state === 'grace') return !!policy.allowIssueInGrace;
  return false;
}

function canViewHistory(sub) {
  return !!sub;
}

function canSubmitPayment(sub) {
  const state = getSubscriptionLifecycleState(sub);
  return ['trial', 'active', 'grace', 'expired'].includes(state);
}

function canRequestNetworkRebind(sub) {
  const state = getSubscriptionLifecycleState(sub);
  return ['trial', 'active', 'grace', 'expired'].includes(state);
}

function getGraceEndsAt(sub, policyOverrides = {}) {
  const policy = getSubscriptionPolicy(policyOverrides);
  const paidEndsAt = Number(sub?.paid_ends_at || 0);
  if (!policy.enableGracePeriod || !paidEndsAt) return null;
  return paidEndsAt + policy.graceDays * 86400000;
}

/**
 * 兼容层：当前仍给旧逻辑使用，语义收敛到“是否允许发码”
 */
function isSubscriptionActive(sub, policyOverrides = {}) {
  return canIssueQr(sub, policyOverrides);
}

/**
 * 检查并更新过期订阅状态（在每次查询订阅时调用）
 */
function refreshSubStatus(sub, policyOverrides = {}) {
  if (!sub) return sub;
  const nextState = getSubscriptionLifecycleState(sub, Date.now(), policyOverrides);
  if (nextState === sub.status) return sub;

  const nextGraceEndsAt = nextState === 'grace'
    ? (Number(sub.grace_ends_at || 0) || getGraceEndsAt(sub, policyOverrides))
    : sub.grace_ends_at || null;
  const now = Date.now();

  db.prepare(`
    UPDATE subscriptions
    SET status = ?, grace_ends_at = ?, updated_at = ?
    WHERE id = ?
  `).run(nextState, nextGraceEndsAt, now, sub.id);

  sub.status = nextState;
  sub.grace_ends_at = nextGraceEndsAt;
  sub.updated_at = now;
  return sub;
}

/**
 * 计算订阅剩余天数
 */
function subRemainingDays(sub, policyOverrides = {}) {
  const now = Date.now();
  const state = getSubscriptionLifecycleState(sub, now, policyOverrides);
  if (state === 'trial') return Math.max(0, Math.ceil((Number(sub.trial_ends_at || 0) - now) / 86400000));
  if (state === 'active' && sub.paid_ends_at) return Math.max(0, Math.ceil((Number(sub.paid_ends_at) - now) / 86400000));
  if (state === 'grace') {
    const graceEndsAt = Number(sub.grace_ends_at || getGraceEndsAt(sub, policyOverrides) || 0);
    return Math.max(0, Math.ceil((graceEndsAt - now) / 86400000));
  }
  return 0;
}

function logAudit({
  actorUserId = null,
  actorRole = 'user',
  siteId = null,
  action,
  targetType = 'unknown',
  targetId = 'unknown',
  ip = '',
  ua = '',
  payload = {},
}) {
  if (!action) return;
  let payloadJson = '{}';
  try { payloadJson = JSON.stringify(payload || {}); } catch {}
  stmts.insertAuditLog.run(
    uuidv4(),
    actorUserId || null,
    actorRole || 'user',
    siteId || null,
    String(action),
    String(targetType),
    String(targetId),
    String(ip || ''),
    String(ua || ''),
    payloadJson,
    Date.now()
  );
}

const createSiteWithTrialSubscription = db.transaction(({ userId, siteName, address = '', trialDays }) => {
  const now = Date.now();
  const siteId = uuidv4();
  const subId = uuidv4();
  const normalizedSiteName = (siteName || '新厂区').trim().slice(0, 50) || '新厂区';
  const trialEnd = now + trialDays * 86400000;

  stmts.insertSite.run(siteId, userId, normalizedSiteName, (address || '').trim().slice(0, 200), now, now);
  stmts.insertSub.run(subId, userId, siteId, normalizedSiteName, now, trialEnd, now, now);

  return { siteId, subscriptionId: subId, trialStartsAt: now, trialEndsAt: trialEnd };
});

module.exports = {
  db,
  stmts,
  getSubscriptionLifecycleState,
  canIssueQr,
  canViewHistory,
  canSubmitPayment,
  canRequestNetworkRebind,
  isSubscriptionActive,
  refreshSubStatus,
  subRemainingDays,
  createSiteWithTrialSubscription,
  logAudit,
};
