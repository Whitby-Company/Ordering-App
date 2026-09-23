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
// Landed cost per each (Net after discount + Taiyo 6% + Oahu freight), from the
// pricing sheet. Used for the margin report. Neighbor-island freight is layered
// on separately later.
if (!itemColumns.includes('cost')) {
  db.exec('ALTER TABLE items ADD COLUMN cost REAL');
}
// Pure NET cost per BOX (before Taiyo's handling fee, before freight) — used
// to calculate what's owed to Taiyo (the warehouse partner) as a % handling
// fee. Deliberately separate from `cost` above, which is already a blended
// Net+Taiyo+freight landed figure that can't be decomposed back into its
// parts, and separate from `taiyo_cost` below, which is an unrelated
// per-CASE figure for items Taiyo actually owns.
if (!itemColumns.includes('net_cost')) {
  db.exec('ALTER TABLE items ADD COLUMN net_cost REAL');
}
// Taiyo (warehouse partner) cost per CASE — for items Taiyo owns. When set (>0),
// the item is treated as Taiyo-owned and appears in the Taiyo report, where we
// owe Taiyo (cases sold × taiyo_cost).
if (!itemColumns.includes('taiyo_cost')) {
  db.exec('ALTER TABLE items ADD COLUMN taiyo_cost REAL');
}
// Free-text note per item (e.g. "backordered until March").
if (!itemColumns.includes('notes')) {
  db.exec('ALTER TABLE items ADD COLUMN notes TEXT');
}
// Audit trail of stock changes: who changed an item's stock, from -> to, when.
// Remembered manual matches from order-file uploads: a file's item key
// (code/upc/description) -> the item the user chose. Lets recurring mismatches
// (e.g. Bar None on 7-Eleven orders) auto-match next time.
db.exec(`CREATE TABLE IF NOT EXISTS import_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  source TEXT,
  file_key TEXT NOT NULL,
  item_id TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE(source, file_key)
)`);

db.exec(`CREATE TABLE IF NOT EXISTS stock_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  old_stock INTEGER,
  new_stock INTEGER,
  delta INTEGER,
  changed_by TEXT,
  reason TEXT,
  changed_at TEXT NOT NULL
)`);
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
// Payment terms shown on the invoice (e.g. "1% 10 Net 11", "Net 30").
if (!customerColumns.includes('terms')) {
  db.exec('ALTER TABLE customers ADD COLUMN terms TEXT');
}
// This customer is a distributor: orders default to case units.
if (!customerColumns.includes('is_distributor')) {
  db.exec('ALTER TABLE customers ADD COLUMN is_distributor INTEGER NOT NULL DEFAULT 0');
}
// Sort this customer's invoice/print-sheet lines by the inventory print order
// (default 0 = keep entry order).
if (!customerColumns.includes('use_print_order')) {
  db.exec('ALTER TABLE customers ADD COLUMN use_print_order INTEGER NOT NULL DEFAULT 0');
}
// Hide the barcode column on this customer's invoice (e.g. distributors).
if (!customerColumns.includes('hide_barcodes')) {
  db.exec('ALTER TABLE customers ADD COLUMN hide_barcodes INTEGER NOT NULL DEFAULT 0');
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
// The amount actually requested by the customer/rep, when it differs from
// `qty` (what will actually ship/be billed) — e.g. mobile ordered more than
// was available and the line got capped to what's in stock. NULL means
// "requested = qty", i.e. no shortfall.
if (!orderLineColumns.includes('requested_qty')) {
  db.exec('ALTER TABLE order_lines ADD COLUMN requested_qty INTEGER');
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
// When the order was last edited after creation (blank = never edited).
if (!orderColumns.includes('edited_at')) {
  db.exec('ALTER TABLE orders ADD COLUMN edited_at TEXT');
}
// A manually-set custom status label (e.g. "invoiced", "shipped", "on hold").
if (!orderColumns.includes('custom_status')) {
  db.exec('ALTER TABLE orders ADD COLUMN custom_status TEXT');
}
// Custom PO number override for the order (blank = use the auto MMDDYY-abbrev).
if (!orderColumns.includes('po_number')) {
  db.exec('ALTER TABLE orders ADD COLUMN po_number TEXT');
}
// Custom invoice number override (blank = auto id + offset).
if (!orderColumns.includes('invoice_number')) {
  db.exec('ALTER TABLE orders ADD COLUMN invoice_number INTEGER');
}
if (!orderColumns.includes('voided')) {
  db.exec('ALTER TABLE orders ADD COLUMN voided INTEGER NOT NULL DEFAULT 0');
}
// When the Taiyo PDF was last "dropped" (saved) for this order.
if (!orderColumns.includes('taiyo_dropped_at')) {
  db.exec('ALTER TABLE orders ADD COLUMN taiyo_dropped_at TEXT');
}
// Whether this invoice has been moved to "Taiyo Storage" (archived from the
// Taiyo page's Current list after printing).
if (!orderColumns.includes('taiyo_stored')) {
  db.exec('ALTER TABLE orders ADD COLUMN taiyo_stored INTEGER NOT NULL DEFAULT 0');
}
// Whether this order has been exported to QuickBooks (batched import).
if (!orderColumns.includes('exported')) {
  db.exec('ALTER TABLE orders ADD COLUMN exported INTEGER NOT NULL DEFAULT 0');
  db.exec('ALTER TABLE orders ADD COLUMN exported_at TEXT');
}
// Shared "ready for QuickBooks import" flag — persists so one user can mark
// orders ready and another does the batch import later.
if (!orderColumns.includes('ready_for_import')) {
  db.exec('ALTER TABLE orders ADD COLUMN ready_for_import INTEGER NOT NULL DEFAULT 0');
}
// Manually excludes this order from the Taiyo 6% handling-fee report — for
// invoices Taiyo shouldn't actually be paid a fee on (e.g. one that was
// never stored at their warehouse), decided per-invoice by office staff
// rather than inferred from any other flag.
if (!orderColumns.includes('taiyo_fee_excluded')) {
  db.exec('ALTER TABLE orders ADD COLUMN taiyo_fee_excluded INTEGER NOT NULL DEFAULT 0');
}

// Small key/value table for one-time migrations / flags.
db.exec('CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT)');
db.exec(`CREATE TABLE IF NOT EXISTS saved_reports (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL DEFAULT 'item-sales',
  config TEXT NOT NULL,
  created_at TEXT
)`);

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

// The invoice-number FLOOR — the lowest number the sequence starts from.
function getInvoiceFloor() {
  const row = db.prepare("SELECT value FROM meta WHERE key = 'invoice_floor'").get();
  return row ? Number(row.value) : 26000;
}
function setInvoiceFloor(n) {
  db.prepare("INSERT OR REPLACE INTO meta (key, value) VALUES ('invoice_floor', ?)").run(String(Number(n)));
  return getInvoiceFloor();
}

// Next available invoice number = the lowest number at/above the floor that no
// submitted order currently uses. This fills gaps left when a number is freed
// (e.g. an order's number was changed to something lower), so numbers stay
// contiguous with no skips. Excludes a given order id (for re-assignment).
function nextInvoiceNumber(excludeOrderId = null) {
  const floor = getInvoiceFloor();
  const offset = getInvoiceOffset();
  // Invoice numbers always go UP: the next number is one above the highest
  // effective number in use (explicit invoice_number, or id + offset), and never
  // below the floor. Gaps (from voids/renumbers) are NOT refilled — a new
  // invoice never gets a lower number than an existing one.
  const rows = db.prepare(
    "SELECT id, invoice_number AS inv FROM orders WHERE status != 'pending'"
  ).all();
  let maxUsed = floor - 1;
  for (const r of rows) {
    if (excludeOrderId != null && r.id === excludeOrderId) continue;
    const eff = (r.inv != null && r.inv !== '') ? Number(r.inv) : (r.id + offset);
    if (Number.isFinite(eff) && eff > maxUsed) maxUsed = eff;
  }
  return maxUsed + 1;
}

// Per-store catalog overrides. present=1 -> add this item to the store's
// catalog; present=0 -> remove it (even if it's in the default set).
// Purchase orders (incoming stock from suppliers) and their lines. "Incoming"
// per item = SUM(qty_ordered - qty_received) across non-cancelled PO lines.
db.exec(`CREATE TABLE IF NOT EXISTS purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier TEXT,
  reference TEXT,
  order_date TEXT,
  expected_date TEXT,
  status TEXT NOT NULL DEFAULT 'open',   -- open | partial | received | cancelled
  notes TEXT,
  created_at TEXT
)`);
db.exec(`CREATE TABLE IF NOT EXISTS po_lines (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  po_id INTEGER NOT NULL,
  item_id TEXT NOT NULL,
  qty_ordered INTEGER NOT NULL DEFAULT 0,
  qty_received INTEGER NOT NULL DEFAULT 0
)`);
// Track short/damaged quantity when a PO is closed short (rest never arrived).
{
  const poLineCols = db.prepare('PRAGMA table_info(po_lines)').all().map(c => c.name);
  if (!poLineCols.includes('qty_short')) db.exec('ALTER TABLE po_lines ADD COLUMN qty_short INTEGER NOT NULL DEFAULT 0');
  // received_date: the physical date stock arrived (for date-based on-hand). This
  // lets you back-date a receipt so it flows into on-hand as of that date.
  if (!poLineCols.includes('received_date')) db.exec('ALTER TABLE po_lines ADD COLUMN received_date TEXT');
  // qty_damaged: split out from qty_short — units that physically arrived but
  // were unusable, as distinct from units that never showed up at all
  // (useful later for supplier claims/insurance, which need that split).
  if (!poLineCols.includes('qty_damaged')) db.exec('ALTER TABLE po_lines ADD COLUMN qty_damaged INTEGER NOT NULL DEFAULT 0');
}

// Competitive/retail price checks — logged when someone scans an item at a
// retail account we DON'T service, to track what price it's selling at
// there. retail_location is free-text (not a customers-table row) since
// these are explicitly NOT our own accounts.
db.exec(`CREATE TABLE IF NOT EXISTS price_checks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  retail_location TEXT NOT NULL,
  base_price REAL,
  promo_price REAL,
  photo_url TEXT,
  notes TEXT,
  checked_by TEXT,
  checked_at TEXT NOT NULL
)`);

// Taiyo warehouse page's "Taiyo Out" tab: a simple log of uploaded signed
// proof-of-delivery / invoice documents. Not linked to a specific order row
// -- reference is whatever the uploader types (invoice #, customer, etc.) to
// identify it later. The list is empty until something is uploaded.
db.exec(`CREATE TABLE IF NOT EXISTS pod_uploads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  reference TEXT NOT NULL,
  file_url TEXT NOT NULL,
  file_type TEXT,
  uploaded_by TEXT,
  uploaded_at TEXT NOT NULL
)`);

// Dated physical-count baselines. Each row = "on as_of_date, this item physically
// had `count` boxes on hand". On-hand and available stock are COMPUTED from the
// latest baseline plus dated movements (PO receipts by received_date, orders by
// delivery_date) — the stored items.stock is kept in sync for compatibility.
db.exec(`CREATE TABLE IF NOT EXISTS stock_baseline (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  item_id TEXT NOT NULL,
  count REAL NOT NULL,
  as_of_date TEXT NOT NULL,      -- ISO date the count was taken
  created_by TEXT,
  created_at TEXT
)`);
db.exec('CREATE INDEX IF NOT EXISTS idx_stock_baseline_item ON stock_baseline(item_id, as_of_date)');

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
module.exports.getInvoiceFloor = getInvoiceFloor;
module.exports.setInvoiceFloor = setInvoiceFloor;
module.exports.nextInvoiceNumber = nextInvoiceNumber;

// ---- Date-based stock model ----
// The business runs in Hawaii (HST, UTC-10, no daylight saving), but the
// server itself runs on UTC — so `new Date()` alone answers "what day is it
// in Hawaii?" wrong for roughly 10 hours out of every 24 (from about 2pm
// HST until midnight HST, the server's own clock has already rolled over
// into the next calendar day). Every "what's today?" fallback below uses
// this instead of a bare `new Date().toISOString()`, so a physical count or
// receipt logged in the afternoon or evening in Hawaii gets today's actual
// Hawaii date, not tomorrow's UTC date.
function todayHST() {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Pacific/Honolulu', year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date());
}
module.exports.todayHST = todayHST;

// Compute on-hand and available stock for items from the latest physical-count
// baseline plus dated movements:
//   on-hand(today)  = baseline.count
//                     + PO receipts with received_date in (baseline.date, today]
//                     - order boxes with delivery_date in (baseline.date, today]
//   available       = on-hand - order boxes with delivery_date > today (future)
// Boxes: a case line consumes qty * case_size boxes; a box line consumes qty.
// Items with no baseline fall back to items.stock as their on-hand (legacy).
function computeStock(opts = {}) {
  const today = opts.today || todayHST();
  const items = db.prepare('SELECT id, stock, case_size AS caseSize FROM items').all();
  const csById = {};
  for (const it of items) csById[it.id] = Number(it.caseSize) > 0 ? Number(it.caseSize) : 1;

  // Latest baseline per item (most recent as_of_date).
  const baselines = db.prepare(
    `SELECT b.item_id AS itemId, b.count, b.as_of_date AS asOf
       FROM stock_baseline b
       JOIN (SELECT item_id, MAX(as_of_date) AS mx FROM stock_baseline GROUP BY item_id) m
         ON m.item_id = b.item_id AND m.mx = b.as_of_date`
  ).all();
  const baseByItem = {};
  for (const b of baselines) baseByItem[b.itemId] = b;

  // Order movements: submitted orders, boxes per item, keyed by whether the
  // delivery date is after the item's baseline and before/after today.
  const orderLines = db.prepare(
    `SELECT ol.item_id AS itemId, ol.qty, ol.unit, o.delivery_date AS deliveryDate
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
      WHERE o.status = 'submitted'`
  ).all();
  // PO receipts by received_date.
  const receipts = db.prepare(
    `SELECT item_id AS itemId, qty_received AS qty, received_date AS rd
       FROM po_lines WHERE qty_received > 0`
  ).all();

  const result = {};
  for (const it of items) {
    const base = baseByItem[it.id];
    const baseDate = base ? base.asOf : null;
    const baseCount = base ? Number(base.count) : Number(it.stock) || 0;
    let shippedSinceBase = 0;   // delivered in [baseDate, today]
    let futureBoxes = 0;        // delivered > today
    for (const l of orderLines) {
      if (l.itemId !== it.id) continue;
      const boxes = (Number(l.qty) || 0) * (l.unit === 'case' ? csById[it.id] : 1);
      const d = l.deliveryDate;
      if (!d) continue;
      if (d > today) futureBoxes += boxes;
      else if (!baseDate || d >= baseDate) shippedSinceBase += boxes;
    }
    let receivedSinceBase = 0;
    for (const r of receipts) {
      if (r.itemId !== it.id) continue;
      const d = r.rd;
      if (!d) continue; // undated receipts don't affect the dated model
      if (d <= today && (!baseDate || d >= baseDate)) receivedSinceBase += Number(r.qty) || 0;
    }
    const onHand = baseCount + receivedSinceBase - shippedSinceBase;
    const available = onHand - futureBoxes;
    result[it.id] = { onHand, available, futureBoxes, baseDate, baseCount, hasBaseline: !!base };
  }
  return result;
}
module.exports.computeStock = computeStock;

// Sync the stored items.stock to the computed ON-HAND for the given item ids
// (or all items if none given). Call this after any order/PO change so the
// stored stock never drifts from the date-based computation — the computed
// values are the source of truth; items.stock is just a cached on-hand.
function syncStock(itemIds = null) {
  const computed = computeStock();
  const upd = db.prepare('UPDATE items SET stock = ? WHERE id = ?');
  const tx = db.transaction((ids) => {
    const list = ids && ids.length ? ids : Object.keys(computed);
    for (const id of list) {
      if (computed[id]) upd.run(computed[id].onHand, id);
    }
  });
  tx(itemIds);
}
module.exports.syncStock = syncStock;
