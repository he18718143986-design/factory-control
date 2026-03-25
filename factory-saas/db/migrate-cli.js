'use strict';

const Database = require('better-sqlite3');
const config = require('../config');
const { runMigrations, getPendingMigrations } = require('./migrations');

const db = new Database(config.db.path);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

try {
  const pending = getPendingMigrations(db);
  if (!pending.length) {
    console.log('[migrate] no pending migrations');
    process.exit(0);
  }

  const result = runMigrations(db, { autoApply: true });
  result.applied.forEach(m => console.log(`[migrate] applied v${m.version} ${m.name}`));
  console.log(`[migrate] done, applied ${result.applied.length} migration(s)`);
  process.exit(0);
} catch (err) {
  console.error('[migrate] failed:', err.message);
  process.exit(1);
}

