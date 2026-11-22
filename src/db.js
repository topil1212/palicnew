import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS state (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS changes (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, key TEXT NOT NULL,
  old_value TEXT, new_value TEXT, actor TEXT
);
CREATE TABLE IF NOT EXISTS watch (
  mint TEXT PRIMARY KEY, symbol TEXT NOT NULL, zona REAL, target REAL,
  target_price REAL NOT NULL, created_ms INTEGER NOT NULL, expires_ms INTEGER NOT NULL,
  last_check_ms INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS positions (
  id INTEGER PRIMARY KEY AUTOINCREMENT, mint TEXT NOT NULL, symbol TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  entry_ms INTEGER NOT NULL, entry_price REAL NOT NULL, size_sol REAL NOT NULL,
  tp_price REAL NOT NULL, sl_price REAL NOT NULL, sl_initial REAL NOT NULL,
  zona REAL, target REAL, rr REAL, peak_price REAL, breakeven_done INTEGER NOT NULL DEFAULT 0,
  exit_ms INTEGER, exit_price REAL, exit_reason TEXT, pnl_pct REAL, pnl_sol REAL
);
CREATE INDEX IF NOT EXISTS idx_positions_status ON positions (status);
CREATE TABLE IF NOT EXISTS events (
  id INTEGER PRIMARY KEY AUTOINCREMENT, ts INTEGER NOT NULL, kind TEXT NOT NULL, mint TEXT, detail TEXT
);
`;

// Kolom yang ditambahkan setelah versi pertama; aman dijalankan berulang pada database lama.
const COLUMNS = [
  ['positions', 'last_price', 'REAL'],
  ['positions', 'last_price_ms', 'INTEGER'],
  ['positions', 'trough_price', 'REAL'],
  ['positions', 'entry_mcap', 'REAL'],
  ['positions', 'execution_mode', "TEXT NOT NULL DEFAULT 'dry_run'"],
  ['positions', 'snapshot_json', 'TEXT'],
  ['positions', 'entry_signature', 'TEXT'],
  ['positions', 'exit_signature', 'TEXT'],
  ['positions', 'token_amount', 'TEXT'],
  ['positions', 'strategy', "TEXT NOT NULL DEFAULT 'p6'"],
  ['positions', 'hold_ms', 'INTEGER'],
  ['positions', 'dead_exit_ms', 'INTEGER'],
  ['positions', 'dead_exit_pct', 'REAL'],
  ['watch', 'info_json', 'TEXT'],
  ['changes', 'rolled_back_by', 'INTEGER'],
];

function ensureColumns(db) {
  for (const [table, column, ddl] of COLUMNS) {
    const have = db.prepare(`PRAGMA table_info(${table})`).all().map((r) => r.name);
    if (!have.includes(column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${ddl}`);
  }
}

export function openDb(path = ':memory:') {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA journal_mode = WAL; PRAGMA busy_timeout = 5000;');
  db.exec(SCHEMA);
  ensureColumns(db);
  return db;
}

export function getState(db, key, fallback = null) {
  const row = db.prepare('SELECT value FROM state WHERE key = ?').get(key);
  return row ? row.value : fallback;
}

export function setState(db, key, value) {
  db.prepare('INSERT INTO state (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(key, String(value));
}

// detail boleh string atau objek (disimpan sebagai JSON) — Mini App membaca objeknya untuk umpan aktivitas.
export function logEvent(db, kind, mint = null, detail = '', now = Date.now()) {
  const text = typeof detail === 'string' ? detail : JSON.stringify(detail);
  db.prepare('INSERT INTO events (ts, kind, mint, detail) VALUES (?, ?, ?, ?)').run(now, kind, mint, text.slice(0, 2000));
}
