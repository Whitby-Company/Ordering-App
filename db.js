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

  CREATE TABLE IF NOT EXISTS brand_settings (
    brand TEXT PRIMARY KEY,
    abbreviation TEXT            -- short code used in the invoice memo, e.g. "LOA"
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
if (!customerColumns.includes('delivery_day')) {
  // Usual delivery day of week: 0=Sunday .. 6=Saturday, NULL = no default.
  db.exec('ALTER TABLE customers ADD COLUMN delivery_day INTEGER');
}
if (!customerColumns.includes('abbreviation')) {
  // Short code used in the Transaction Pro PO number, e.g. "T2".
  db.exec('ALTER TABLE customers ADD COLUMN abbreviation TEXT');
}
if (!customerColumns.includes('short_name')) {
  // Short store name used in the invoice Memo, e.g. "Kahala".
  db.exec('ALTER TABLE customers ADD COLUMN short_name TEXT');
}
// Ship-to address (feeds the ShipTo columns in the Transaction Pro export).
for (const col of ['shipto_line1', 'shipto_line2', 'shipto_city', 'shipto_state', 'shipto_zip']) {
  if (!customerColumns.includes(col)) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  }
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

// Small key/value table for one-time migrations / flags.
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');

// Apply the built-in ship-to addresses, matching customers by normalized name.
// Returns { matched: [...names], unmatched: [...names] }. By default only fills
// customers that don't already have a ship-to (so it won't clobber edits);
// pass { overwrite: true } to re-apply to everyone.
function applyShipToSeed({ overwrite = false } = {}) {
  const { SHIPTO_SEED, normalizeName } = require('./shiptoSeed');
  const customers = db.prepare('SELECT id, name, shipto_line1 FROM customers').all();
  const byNorm = new Map();
  for (const c of customers) byNorm.set(normalizeName(c.name), c);
  const upd = db.prepare(
    overwrite
      ? `UPDATE customers SET shipto_line1=?, shipto_line2=?, shipto_city=?, shipto_state=?, shipto_zip=? WHERE id=?`
      : `UPDATE customers SET shipto_line1=?, shipto_line2=?, shipto_city=?, shipto_state=?, shipto_zip=? WHERE id=? AND (shipto_line1 IS NULL OR shipto_line1='')`
  );
  const matched = [];
  const unmatched = [];
  for (const s of SHIPTO_SEED) {
    const c = byNorm.get(normalizeName(s.name));
    if (c) { upd.run(s.line1, s.line2, s.city, s.state, s.zip, c.id); matched.push(s.name); }
    else unmatched.push(s.name);
  }
  return { matched, unmatched };
}

// One-time seed on startup (guarded by a meta flag so it never overwrites edits).
function seedShipToOnce() {
  const FLAG = 'shipto_seed_v1';
  const done = db.prepare('SELECT value FROM meta WHERE key = ?').get(FLAG);
  if (done) return;
  try {
    const { matched } = applyShipToSeed({ overwrite: false });
    // Only lock the flag once we've actually matched customers, so an early run
    // against an empty table (e.g. during seeding) doesn't disable it forever.
    if (matched.length > 0) {
      db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FLAG, String(matched.length));
      console.log(`Ship-to seed: filled ${matched.length} customer(s).`);
    }
  } catch (err) {
    console.error('Ship-to seed skipped:', err.message);
  }
}
seedShipToOnce();

module.exports = db;
module.exports.seedShipToOnce = seedShipToOnce;
module.exports.applyShipToSeed = applyShipToSeed;
