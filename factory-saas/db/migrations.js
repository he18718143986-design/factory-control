'use strict';

const { v4: uuidv4 } = require('uuid');

function hasColumn(db, table, column) {
  const rows = db.prepare(`PRAGMA table_info(${table})`).all();
  return rows.some(r => r.name === column);
}

const migrations = [
  {
    version: 1,
    name: 'subscriptions_add_site_id_and_backfill_sites',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS sites (
          id            TEXT PRIMARY KEY,
          user_id       TEXT NOT NULL,
          name          TEXT NOT NULL,
          address       TEXT DEFAULT '',
          status        TEXT NOT NULL DEFAULT 'active',
          created_at    INTEGER NOT NULL,
          updated_at    INTEGER NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_sites_user_id ON sites(user_id);
      `);

      if (!hasColumn(db, 'subscriptions', 'site_id')) {
        db.prepare('ALTER TABLE subscriptions ADD COLUMN site_id TEXT').run();
      }
      db.exec('CREATE INDEX IF NOT EXISTS idx_subscriptions_site_id ON subscriptions(site_id)');

      const rows = db.prepare(`
        SELECT id, user_id, area_name, created_at
        FROM subscriptions
        WHERE site_id IS NULL OR site_id = ''
      `).all();
      if (!rows.length) return;

      const insertSite = db.prepare(`
        INSERT INTO sites (id, user_id, name, address, status, created_at, updated_at)
        VALUES (?, ?, ?, '', 'active', ?, ?)
      `);
      const updateSub = db.prepare('UPDATE subscriptions SET site_id = ? WHERE id = ?');
      const tx = db.transaction(items => {
        for (const row of items) {
          const siteId = uuidv4();
          const createdAt = row.created_at || Date.now();
          const siteName = (row.area_name || '我的厂区').slice(0, 50);
          insertSite.run(siteId, row.user_id, siteName, createdAt, Date.now());
          updateSub.run(siteId, row.id);
        }
      });
      tx(rows);
    },
  },
  {
    version: 2,
    name: 'create_site_network_bindings_and_migrate_legacy_wifi',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS site_network_bindings (
          id              TEXT PRIMARY KEY,
          site_id         TEXT NOT NULL,
          status          TEXT NOT NULL DEFAULT 'active',
          lan_subnet      TEXT,
          public_ip       TEXT DEFAULT '',
          first_seen_at   INTEGER NOT NULL,
          last_seen_at    INTEGER NOT NULL,
          created_at      INTEGER NOT NULL,
          updated_at      INTEGER NOT NULL,
          FOREIGN KEY (site_id) REFERENCES sites(id)
        );
        CREATE INDEX IF NOT EXISTS idx_site_bindings_site_status ON site_network_bindings(site_id, status);
        CREATE INDEX IF NOT EXISTS idx_site_bindings_lan_subnet  ON site_network_bindings(lan_subnet);
      `);

      const rows = db.prepare(`
        SELECT s.site_id, s.wifi_subnet
        FROM subscriptions s
        WHERE s.site_id IS NOT NULL
          AND s.site_id != ''
          AND s.wifi_locked = 1
          AND s.wifi_subnet IS NOT NULL
          AND s.wifi_subnet != ''
      `).all();
      if (!rows.length) return;

      const exists = db.prepare(`
        SELECT id FROM site_network_bindings
        WHERE site_id = ? AND status = 'active' AND lan_subnet = ?
        LIMIT 1
      `);
      const insert = db.prepare(`
        INSERT INTO site_network_bindings
          (id, site_id, status, lan_subnet, public_ip, first_seen_at, last_seen_at, created_at, updated_at)
        VALUES
          (?, ?, 'active', ?, '', ?, ?, ?, ?)
      `);
      const now = Date.now();
      const tx = db.transaction(items => {
        for (const row of items) {
          if (exists.get(row.site_id, row.wifi_subnet)) continue;
          insert.run(uuidv4(), row.site_id, row.wifi_subnet, now, now, now, now);
        }
      });
      tx(rows);
    },
  },
  {
    version: 3,
    name: 'create_network_rebind_requests',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS network_rebind_requests (
          id                TEXT PRIMARY KEY,
          site_id           TEXT NOT NULL,
          requested_by      TEXT NOT NULL,
          candidate_subnet  TEXT NOT NULL,
          candidate_ip      TEXT DEFAULT '',
          reason            TEXT DEFAULT '',
          status            TEXT NOT NULL DEFAULT 'pending_review',
          review_note       TEXT DEFAULT '',
          reviewed_by       TEXT,
          reviewed_at       INTEGER,
          created_at        INTEGER NOT NULL,
          updated_at        INTEGER NOT NULL,
          FOREIGN KEY (site_id) REFERENCES sites(id),
          FOREIGN KEY (requested_by) REFERENCES users(id),
          FOREIGN KEY (reviewed_by) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_rebind_site_status ON network_rebind_requests(site_id, status);
        CREATE INDEX IF NOT EXISTS idx_rebind_created_at  ON network_rebind_requests(created_at);
      `);
    },
  },
  {
    version: 4,
    name: 'create_audit_logs',
    up(db) {
      db.exec(`
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
        CREATE INDEX IF NOT EXISTS idx_audit_created_at ON audit_logs(created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_actor      ON audit_logs(actor_user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_audit_site       ON audit_logs(site_id, created_at);
      `);
    },
  },
  {
    version: 5,
    name: 'subscriptions_add_state_machine_fields',
    up(db) {
      if (!hasColumn(db, 'subscriptions', 'grace_ends_at')) {
        db.prepare('ALTER TABLE subscriptions ADD COLUMN grace_ends_at INTEGER').run();
      }
      if (!hasColumn(db, 'subscriptions', 'cancelled_at')) {
        db.prepare('ALTER TABLE subscriptions ADD COLUMN cancelled_at INTEGER').run();
      }
      if (!hasColumn(db, 'subscriptions', 'updated_at')) {
        db.prepare('ALTER TABLE subscriptions ADD COLUMN updated_at INTEGER').run();
      }

      db.exec(`
        UPDATE subscriptions
        SET updated_at = COALESCE(updated_at, created_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
        WHERE updated_at IS NULL OR updated_at = 0;

        UPDATE subscriptions
        SET cancelled_at = COALESCE(cancelled_at, updated_at, created_at, CAST(strftime('%s','now') AS INTEGER) * 1000)
        WHERE status = 'cancelled' AND (cancelled_at IS NULL OR cancelled_at = 0);
      `);
    },
  },
  {
    version: 6,
    name: 'create_plans_and_orders',
    up(db) {
      db.exec(`
        CREATE TABLE IF NOT EXISTS plans (
          id             TEXT PRIMARY KEY,
          code           TEXT UNIQUE NOT NULL,
          name           TEXT NOT NULL,
          duration_days  INTEGER NOT NULL,
          amount_fen     INTEGER NOT NULL,
          status         TEXT NOT NULL DEFAULT 'active',
          sort_order     INTEGER NOT NULL DEFAULT 0,
          created_at     INTEGER NOT NULL,
          updated_at     INTEGER NOT NULL
        );

        CREATE TABLE IF NOT EXISTS orders (
          id               TEXT PRIMARY KEY,
          user_id          TEXT NOT NULL,
          site_id          TEXT NOT NULL,
          subscription_id  TEXT NOT NULL,
          plan_code        TEXT NOT NULL,
          duration_days    INTEGER NOT NULL,
          amount_fen       INTEGER NOT NULL,
          status           TEXT NOT NULL DEFAULT 'pending_payment',
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

        CREATE INDEX IF NOT EXISTS idx_plans_status_sort ON plans(status, sort_order);
        CREATE INDEX IF NOT EXISTS idx_orders_user_created ON orders(user_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_site_created ON orders(site_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_status_created ON orders(status, created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_subscription ON orders(subscription_id, created_at);
        CREATE INDEX IF NOT EXISTS idx_orders_user_idempotency ON orders(user_id, idempotency_key, created_at);
      `);

      const now = Date.now();
      const upsertPlan = db.prepare(`
        INSERT INTO plans (id, code, name, duration_days, amount_fen, status, sort_order, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)
        ON CONFLICT(code) DO UPDATE SET
          name=excluded.name,
          duration_days=excluded.duration_days,
          amount_fen=excluded.amount_fen,
          status='active',
          sort_order=excluded.sort_order,
          updated_at=excluded.updated_at
      `);
      upsertPlan.run(uuidv4(), 'monthly', '月度套餐', 30, 9900, 10, now, now);
      upsertPlan.run(uuidv4(), 'yearly', '年度套餐', 365, 99900, 20, now, now);
    },
  },
  {
    version: 7,
    name: 'network_fingerprint_fields_upgrade',
    up(db) {
      // site_network_bindings 扩展字段
      if (!hasColumn(db, 'site_network_bindings', 'ssid')) {
        db.prepare('ALTER TABLE site_network_bindings ADD COLUMN ssid TEXT DEFAULT \'\'').run();
      }
      if (!hasColumn(db, 'site_network_bindings', 'bssid')) {
        db.prepare('ALTER TABLE site_network_bindings ADD COLUMN bssid TEXT DEFAULT \'\'').run();
      }
      if (!hasColumn(db, 'site_network_bindings', 'gateway_ip')) {
        db.prepare('ALTER TABLE site_network_bindings ADD COLUMN gateway_ip TEXT DEFAULT \'\'').run();
      }
      if (!hasColumn(db, 'site_network_bindings', 'gateway_mac')) {
        db.prepare('ALTER TABLE site_network_bindings ADD COLUMN gateway_mac TEXT DEFAULT \'\'').run();
      }
      if (!hasColumn(db, 'site_network_bindings', 'confidence')) {
        db.prepare('ALTER TABLE site_network_bindings ADD COLUMN confidence INTEGER NOT NULL DEFAULT 0').run();
      }
      if (!hasColumn(db, 'site_network_bindings', 'source')) {
        db.prepare('ALTER TABLE site_network_bindings ADD COLUMN source TEXT NOT NULL DEFAULT \'unknown\'').run();
      }

      // network_rebind_requests 扩展字段
      if (!hasColumn(db, 'network_rebind_requests', 'candidate_fingerprint_json')) {
        db.prepare('ALTER TABLE network_rebind_requests ADD COLUMN candidate_fingerprint_json TEXT DEFAULT \'{}\'').run();
      }
      if (!hasColumn(db, 'network_rebind_requests', 'evidence')) {
        db.prepare('ALTER TABLE network_rebind_requests ADD COLUMN evidence TEXT DEFAULT \'\'').run();
      }
      if (!hasColumn(db, 'network_rebind_requests', 'risk_score')) {
        db.prepare('ALTER TABLE network_rebind_requests ADD COLUMN risk_score INTEGER NOT NULL DEFAULT 0').run();
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_site_bindings_bssid ON site_network_bindings(bssid);
        CREATE INDEX IF NOT EXISTS idx_site_bindings_gateway_mac ON site_network_bindings(gateway_mac);
        CREATE INDEX IF NOT EXISTS idx_rebind_risk_score ON network_rebind_requests(risk_score, created_at);
      `);
    },
  },
];

function ensureMigrationTable(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version    INTEGER PRIMARY KEY,
      name       TEXT NOT NULL,
      applied_at INTEGER NOT NULL
    );
  `);
}

function getAppliedSet(db) {
  return new Set(db.prepare('SELECT version FROM schema_migrations').all().map(r => r.version));
}

function getPendingMigrations(db) {
  ensureMigrationTable(db);
  const applied = getAppliedSet(db);
  return migrations.filter(m => !applied.has(m.version));
}

function runMigrations(db, { autoApply = true } = {}) {
  ensureMigrationTable(db);
  const pending = getPendingMigrations(db);
  if (!pending.length) return { applied: [], pending: [] };
  if (!autoApply) return { applied: [], pending: pending.map(m => ({ version: m.version, name: m.name })) };

  const insertVersion = db.prepare(`
    INSERT INTO schema_migrations (version, name, applied_at)
    VALUES (?, ?, ?)
  `);

  const applied = [];
  for (const m of pending) {
    const tx = db.transaction(() => {
      m.up(db);
      insertVersion.run(m.version, m.name, Date.now());
    });
    tx();
    applied.push({ version: m.version, name: m.name });
  }
  return { applied, pending: [] };
}

module.exports = { migrations, getPendingMigrations, runMigrations };
