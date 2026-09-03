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
if (!itemColumns.includes('contains')) {
  // JSON array of contained sub-items for shipper products, each
  // { qty, name, upc } — printed under the item on the invoice.
  db.exec('ALTER TABLE items ADD COLUMN contains TEXT');
}
if (!itemColumns.includes('is_default')) {
  // 1 = item is part of the default catalog (the base set most stores carry).
  db.exec('ALTER TABLE items ADD COLUMN is_default INTEGER NOT NULL DEFAULT 0');
}
// Case ordering unit: case_size = boxes per case (NULL if the item has no case
// unit); case_price = per-each price when ordered by the case (bulk).
if (!itemColumns.includes('case_size')) {
  db.exec('ALTER TABLE items ADD COLUMN case_size INTEGER');
}
if (!itemColumns.includes('case_price')) {
  db.exec('ALTER TABLE items ADD COLUMN case_price REAL');
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
for (const col of ['shipto_line1', 'shipto_line2', 'shipto_city', 'shipto_state', 'shipto_zip', 'shipto_phone']) {
  if (!customerColumns.includes(col)) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  }
}
// Bill-to address (used on the printed invoice's BILL TO block).
for (const col of ['billto_line1', 'billto_line2', 'billto_city', 'billto_state', 'billto_zip']) {
  if (!customerColumns.includes(col)) {
    db.exec(`ALTER TABLE customers ADD COLUMN ${col} TEXT`);
  }
}
// Per-store catalog: catalog_on = whether this customer has a catalog set up
// (0 = shows nothing in the field until configured); include_default = whether
// the default catalog is part of their effective catalog.
if (!customerColumns.includes('catalog_on')) {
  db.exec('ALTER TABLE customers ADD COLUMN catalog_on INTEGER NOT NULL DEFAULT 0');
}
if (!customerColumns.includes('include_default')) {
  db.exec('ALTER TABLE customers ADD COLUMN include_default INTEGER NOT NULL DEFAULT 1');
}
// Whether this customer shows in the mobile field-rep customer picker.
// Defaults to 1 (on) so existing customers keep showing on mobile.
if (!customerColumns.includes('show_on_mobile')) {
  db.exec('ALTER TABLE customers ADD COLUMN show_on_mobile INTEGER NOT NULL DEFAULT 1');
}
const orderColumns = db.prepare("PRAGMA table_info(orders)").all().map(c => c.name);
// Snapshot the per-each price on each order line so historical invoices don't
// change if a customer's price changes later.
const orderLineColumns = db.prepare("PRAGMA table_info(order_lines)").all().map(c => c.name);
if (!orderLineColumns.includes('price')) {
  db.exec('ALTER TABLE order_lines ADD COLUMN price REAL');
}
// Which unit this line was ordered in ('box' | 'case') and the effective pack
// (eaches per ordered unit) — snapshotted so history is stable.
if (!orderLineColumns.includes('unit')) {
  db.exec("ALTER TABLE order_lines ADD COLUMN unit TEXT");
}
if (!orderLineColumns.includes('pack')) {
  db.exec('ALTER TABLE order_lines ADD COLUMN pack INTEGER');
}
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

// Invoice numbering: invoice # = order.id + invoice_offset. Default keeps the
// historical +30000 behavior until an admin sets a starting number.
function getInvoiceOffset() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'invoice_offset'").get();
  return row ? Number(row.value) : 30000;
}
function setInvoiceStart(nextNumber) {
  // next order id is max(id)+1 (or 1 if none); offset so it prints nextNumber.
  const max = db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM orders').get().m;
  const nextId = max + 1;
  const offset = Number(nextNumber) - nextId;
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('invoice_offset', ?)").run(String(offset));
  return { offset, nextId, nextNumber: Number(nextNumber) };
}

// Per-store catalog overrides. present=1 -> add this item to the store's
// catalog; present=0 -> remove it (even if it's in the default set).
db.exec(`CREATE TABLE IF NOT EXISTS customer_catalog (
  customer_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  present INTEGER NOT NULL,
  price REAL,                    -- per-each price for this customer (NULL = use item base price)
  PRIMARY KEY (customer_id, item_id)
)`);
// Migration-safe: add columns if the table pre-existed without them.
{
  const cc = db.prepare("PRAGMA table_info(customer_catalog)").all().map(c => c.name);
  if (!cc.includes('price')) db.exec('ALTER TABLE customer_catalog ADD COLUMN price REAL');
  // The store's default ordering unit for this item ('box' | 'case').
  if (!cc.includes('unit')) db.exec("ALTER TABLE customer_catalog ADD COLUMN unit TEXT");
}

// One-time catalog rollout: mark all currently-active items as default, and
// turn the catalog on for all currently-active customers (so existing field
// customers keep seeing the full set). New items/customers stay off default /
// catalog-off until configured.
function seedCatalogOnce() {
  const FLAG = 'catalog_seed_v1';
  if (db.prepare('SELECT value FROM meta WHERE key = ?').get(FLAG)) return;
  try {
    const itemCount = db.prepare('SELECT COUNT(*) n FROM items WHERE active = 1').get().n;
    const custCount = db.prepare('SELECT COUNT(*) n FROM customers WHERE active = 1').get().n;
    // Don't lock the flag against an empty DB (e.g. during initial seeding).
    if (itemCount === 0 && custCount === 0) return;
    db.prepare('UPDATE items SET is_default = 1 WHERE active = 1').run();
    const r = db.prepare('UPDATE customers SET catalog_on = 1, include_default = 1 WHERE active = 1').run();
    db.prepare('INSERT OR REPLACE INTO meta (key, value) VALUES (?, ?)').run(FLAG, String(r.changes));
    console.log(`Catalog seed: activated ${r.changes} customer(s); default set = ${itemCount} active items.`);
  } catch (err) {
    console.error('Catalog seed skipped:', err.message);
  }
}
seedCatalogOnce();

// Apply the built-in ship-to addresses, matching customers by normalized name.
// Returns { matched: [...names], unmatched: [...names] }. By default only fills
// customers that don't already have a ship-to (so it won't clobber edits);
// pass { overwrite: true } to re-apply to everyone.
function applyShipToSeed({ overwrite = false } = {}) {
  const { SHIPTO_SEED, normalizeName } = require('./shiptoSeed');
  const customers = db.prepare('SELECT id, name, shipto_line1, shipto_phone FROM customers').all();
  const byNorm = new Map();
  for (const c of customers) byNorm.set(normalizeName(c.name), c);
  const updAddr = db.prepare('UPDATE customers SET shipto_line1=?, shipto_line2=?, shipto_city=?, shipto_state=?, shipto_zip=? WHERE id=?');
  const updPhone = db.prepare('UPDATE customers SET shipto_phone=? WHERE id=?');
  const matched = [];
  const unmatched = [];
  for (const s of SHIPTO_SEED) {
    const c = byNorm.get(normalizeName(s.name));
    if (!c) { unmatched.push(s.name); continue; }
    matched.push(s.name);
    // Fill address if empty (or always, when overwriting).
    if (overwrite || !c.shipto_line1) updAddr.run(s.line1, s.line2, s.city, s.state, s.zip, c.id);
    // Fill phone if empty (or always, when overwriting) — backfills existing rows.
    if (overwrite || !c.shipto_phone) updPhone.run(s.phone || null, c.id);
  }
  return { matched, unmatched };
}

// One-time seed on startup (guarded by a meta flag so it never overwrites edits).
function seedShipToOnce() {
  const FLAG = 'shipto_seed_v2';
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
module.exports.seedCatalogOnce = seedCatalogOnce;
module.exports.getInvoiceOffset = getInvoiceOffset;
module.exports.setInvoiceStart = setInvoiceStart;
