const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DATA_DIR = process.env.DATA_DIR || '/data';
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(path.join(DATA_DIR, 'price-tracker.db'));

db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(`
  CREATE TABLE IF NOT EXISTS users (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL UNIQUE,
    password_hash TEXT NOT NULL,
    is_admin INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS sessions (
    id TEXT PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    expires_at TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS login_attempts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    username TEXT NOT NULL,
    ip TEXT NOT NULL,
    attempted_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
    name TEXT NOT NULL,
    url TEXT NOT NULL,
    asin TEXT,
    image_url TEXT,
    store TEXT NOT NULL DEFAULT 'amazon_sa',
    target_price REAL,
    notify_drop_percent REAL DEFAULT 5,
    active INTEGER NOT NULL DEFAULT 1,
    last_checked_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS price_history (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    price REAL,
    original_price REAL,
    currency TEXT NOT NULL DEFAULT 'SAR',
    seller_name TEXT,
    is_amazon_direct INTEGER DEFAULT 0,
    is_prime INTEGER DEFAULT 0,
    in_stock INTEGER DEFAULT 1,
    error TEXT,
    checked_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    message TEXT NOT NULL,
    price REAL,
    sent_at TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS settings (
    key TEXT PRIMARY KEY,
    value TEXT
  );

  CREATE TABLE IF NOT EXISTS purchases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    item_id INTEGER NOT NULL REFERENCES items(id) ON DELETE CASCADE,
    purchased_price REAL NOT NULL,
    currency TEXT NOT NULL DEFAULT 'SAR',
    purchased_at TEXT NOT NULL DEFAULT (datetime('now')),
    notes TEXT
  );
`);

const insertSetting = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
insertSetting.run('telegram_bot_token', '');
insertSetting.run('telegram_chat_id', '');
insertSetting.run('check_interval', '60');
insertSetting.run('notify_price_drop', '1');
insertSetting.run('notify_back_in_stock', '1');

// Migrations
const hasCurrencyCol = db.prepare("PRAGMA table_info(notifications)").all().some(c => c.name === 'currency');
if (!hasCurrencyCol) {
  db.exec("ALTER TABLE notifications ADD COLUMN currency TEXT DEFAULT 'SAR'");
}
const hasPurchasedCol = db.prepare("PRAGMA table_info(items)").all().some(c => c.name === 'is_purchased');
if (!hasPurchasedCol) {
  db.exec("ALTER TABLE items ADD COLUMN is_purchased INTEGER NOT NULL DEFAULT 0");
}
const hasOtherSellersCol = db.prepare("PRAGMA table_info(price_history)").all().some(c => c.name === 'has_other_sellers');
if (!hasOtherSellersCol) {
  db.exec("ALTER TABLE price_history ADD COLUMN has_other_sellers INTEGER DEFAULT 0");
  db.exec("ALTER TABLE price_history ADD COLUMN other_sellers_price REAL");
}

function cleanupSessions() {
  db.prepare("DELETE FROM sessions WHERE expires_at < datetime('now')").run();
  db.prepare("DELETE FROM login_attempts WHERE attempted_at < datetime('now', '-1 day')").run();
}

cleanupSessions();
setInterval(cleanupSessions, 3600 * 1000);

module.exports = db;
