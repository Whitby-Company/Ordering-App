// db.js — SQLite database connection and schema.
//
// DB_PATH controls where the database file lives on disk.
// Locally it defaults to ./data.db. On a host like Render, point this at a
// persistent disk mount (e.g. /data/data.db) so the data survives restarts
// and deploys — see README.md for details.

const path = require('path');
const Database = require('better-sqlite3');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data.db');
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS customers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS items (
    id TEXT PRIMARY KEY,          -- SKU, e.g. 'ACL:NIBB4OZ'
    brand TEXT NOT NULL,
    name TEXT NOT NULL,
    stock INTEGER NOT NULL DEFAULT 0,
    price REAL NOT NULL DEFAULT 0,   -- price per single "each", not per case
    pack INTEGER NOT NULL DEFAULT 1, -- number of "eaches" per case/pack ordered
    packLabel TEXT,                   -- display string, e.g. '12/7.5oz'
    imageUrl TEXT,                    -- optional product photo URL
    upc TEXT,                         -- optional UPC / barcode for check-in
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE IF NOT EXISTS orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id INTEGER NOT NULL REFERENCES customers(id),
    delivery_date TEXT NOT NULL,   -- ISO date, e.g. '2026-08-14'
    submitted_at TEXT NOT NULL,    -- ISO datetime
    status TEXT DEFAULT 'submitted', -- 'pending' (draft) or 'submitted'
    submitted_by TEXT,             -- name of whoever placed the order (per-device)
    notes TEXT,                    -- optional order notes / special instructions
    processed INTEGER NOT NULL DEFAULT 0,  -- 1 once entered into QuickBooks
    processed_at TEXT,             -- ISO datetime it was marked processed
    FOREIGN KEY (customer_id) REFERENCES customers(id)
  );

  CREATE TABLE IF NOT EXISTS order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id INTEGER NOT NULL REFERENCES orders(id),
    item_id TEXT NOT NULL REFERENCES items(id),
    qty INTEGER NOT NULL,
    FOREIGN KEY (order_id) REFERENCES orders(id),
    FOREIGN KEY (item_id) REFERENCES items(id)
  );

  CREATE TABLE IF NOT EXISTS brand_colors (
    brand TEXT PRIMARY KEY,
    color TEXT NOT NULL          -- hex color, e.g. '#2B5D50'
  );

  CREATE TABLE IF NOT EXISTS print_order (
    item_id TEXT PRIMARY KEY,    -- SKU
    position INTEGER NOT NULL    -- 0-based sort position for printouts
  );
`);

// Migration: older deployments created these tables before the `price`
// and `active` columns existed. CREATE TABLE IF NOT EXISTS above won't add
// them to an existing table, so add them here if missing. Safe to run every
// startup — it's a no-op once the columns exist. New items/customers default
// to active=1 (visible) so nothing disappears from the app unexpectedly.
const itemColumns = db.prepare("PRAGMA table_info(items)").all().map(c => c.name);
if (!itemColumns.includes('price')) {
  db.exec('ALTER TABLE items ADD COLUMN price REAL NOT NULL DEFAULT 0');
}
if (!itemColumns.includes('active')) {
  db.exec('ALTER TABLE items ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}
if (!itemColumns.includes('pack')) {
  db.exec('ALTER TABLE items ADD COLUMN pack INTEGER NOT NULL DEFAULT 1');
}
if (!itemColumns.includes('packLabel')) {
  db.exec('ALTER TABLE items ADD COLUMN packLabel TEXT');
}
if (!itemColumns.includes('imageUrl')) {
  db.exec('ALTER TABLE items ADD COLUMN imageUrl TEXT');
}
if (!itemColumns.includes('upc')) {
  db.exec('ALTER TABLE items ADD COLUMN upc TEXT');
}
const customerColumns = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
if (!customerColumns.includes('active')) {
  db.exec('ALTER TABLE customers ADD COLUMN active INTEGER NOT NULL DEFAULT 1');
}
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
if (!orderColumns.includes('notes')) {
  db.exec('ALTER TABLE orders ADD COLUMN notes TEXT');
}
if (!orderColumns.includes('processed')) {
  db.exec('ALTER TABLE orders ADD COLUMN processed INTEGER NOT NULL DEFAULT 0');
}
if (!orderColumns.includes('processed_at')) {
  db.exec('ALTER TABLE orders ADD COLUMN processed_at TEXT');
}
if (!orderColumns.includes('submitted_by')) {
  db.exec('ALTER TABLE orders ADD COLUMN submitted_by TEXT');
}
if (!orderColumns.includes('status')) {
  db.exec("ALTER TABLE orders ADD COLUMN status TEXT DEFAULT 'submitted'");
  db.exec("UPDATE orders SET status = 'submitted' WHERE status IS NULL");
}

module.exports = db;
