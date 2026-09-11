const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('../db');

const router = express.Router();

// GET /api/items — list items (current live inventory).
// By default only active items are returned (what the ordering app and
// inventory browser should see). Pass ?includeInactive=true for everyone,
// e.g. for the office management view.
// Optional query params: ?brand=Oberto  ?lowStockMax=5  ?includeInactive=true
router.get('/', (req, res) => {
  const { brand, lowStockMax, includeInactive } = req.query;
  let sql = 'SELECT id, brand, name, stock, price, pack, packLabel, imageUrl, upc, active, contains, is_default as isDefault, case_size as caseSize, case_price as casePrice, cost, notes FROM items WHERE 1=1';
  const params = [];

  if (includeInactive !== 'true') {
    sql += ' AND active = 1';
  }
  if (brand) {
    sql += ' AND brand = ?';
    params.push(brand);
  }
  if (lowStockMax) {
    sql += ' AND stock <= ?';
    params.push(Number(lowStockMax));
  }
  sql += ' ORDER BY brand ASC, name ASC';

  const items = db.prepare(sql).all(...params).map(it => {
    let contains = [];
    if (it.contains) { try { contains = JSON.parse(it.contains) || []; } catch { contains = []; } }
    return { ...it, contains };
  });
  res.json(items);
});

// GET /api/items/brands — distinct brand list with item counts (active items only)
router.get('/brands', (req, res) => {
  const rows = db
    .prepare('SELECT brand, COUNT(*) as itemCount FROM items WHERE active = 1 GROUP BY brand ORDER BY brand ASC')
    .all();
  res.json(rows);
});

// POST /api/items — add a new item  { id, brand, name, stock, price }
router.post('/', (req, res) => {
  let { id, brand, name, stock, price, code, pack, packLabel, caseSize, casePrice, upc, cost, active } = req.body;
  // Allow passing a bare code + brand instead of a full id — build "BRAND:code".
  if (!id && code && brand) id = `${brand}:${String(code).trim()}`;
  if (!id || !brand || !name) {
    return res.status(400).json({ error: 'brand, name, and a code (or full id) are required' });
  }
  try {
    db.prepare(
      `INSERT INTO items (id, brand, name, stock, price, pack, packLabel, case_size, case_price, upc, cost, active)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id, brand, name,
      Number(stock) || 0,
      Number(price) || 0,
      pack != null && pack !== '' ? Number(pack) : 1,
      packLabel || null,
      caseSize != null && caseSize !== '' && Number(caseSize) > 0 ? Number(caseSize) : null,
      casePrice != null && casePrice !== '' ? Number(casePrice) : null,
      upc || null,
      cost != null && cost !== '' ? Number(cost) : null,
      active === false ? 0 : 1
    );
    res.status(201).json({ id, brand, name, stock: Number(stock) || 0, price: Number(price) || 0, active: active === false ? 0 : 1 });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ error: `An item with SKU "${id}" already exists` });
    }
    throw err;
  }
});

// PATCH /api/items/:id — edit stock, name, brand, pack, and/or toggle active
// body: { stock?, name?, brand?, pack?, active? }
// (Stock corrections here are for fixing mistakes — normal stock changes
// should happen via orders.)
router.patch('/:id', (req, res) => {
  const { stock, name, brand, pack, packLabel, imageUrl, upc, price, active, contains, isDefault, cost, notes, caseSize, changedBy, reason } = req.body;
  if (stock === undefined && name === undefined && brand === undefined && pack === undefined && packLabel === undefined && imageUrl === undefined && upc === undefined && price === undefined && active === undefined && contains === undefined && isDefault === undefined && cost === undefined && notes === undefined && caseSize === undefined) {
    return res.status(400).json({ error: 'At least one field must be provided' });
  }
  if (stock !== undefined && Number.isNaN(Number(stock))) {
    return res.status(400).json({ error: 'stock must be a number' });
  }
  if (pack !== undefined && (Number.isNaN(Number(pack)) || Number(pack) < 1)) {
    return res.status(400).json({ error: 'pack must be a number of 1 or more' });
  }
  if (price !== undefined && (Number.isNaN(Number(price)) || Number(price) < 0)) {
    return res.status(400).json({ error: 'price must be a number of 0 or more' });
  }
  if (name !== undefined && !name.trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }
  if (brand !== undefined && !brand.trim()) {
    return res.status(400).json({ error: 'brand cannot be empty' });
  }
  if (active !== undefined && typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be true or false' });
  }

  const updates = [];
  const params = [];
  if (stock !== undefined) { updates.push('stock = ?'); params.push(Number(stock)); }
  if (name !== undefined) { updates.push('name = ?'); params.push(name.trim()); }
  if (brand !== undefined) { updates.push('brand = ?'); params.push(brand.trim()); }
  if (pack !== undefined) { updates.push('pack = ?'); params.push(Number(pack)); }
  if (caseSize !== undefined) { updates.push('case_size = ?'); params.push(caseSize == null || caseSize === '' || Number(caseSize) <= 0 ? null : Number(caseSize)); }
  if (packLabel !== undefined) { updates.push('packLabel = ?'); params.push(packLabel.trim() || null); }
  if (imageUrl !== undefined) { updates.push('imageUrl = ?'); params.push(imageUrl.trim() || null); }
  if (upc !== undefined) { updates.push('upc = ?'); params.push((upc == null ? '' : String(upc)).trim() || null); }
  if (price !== undefined) { updates.push('price = ?'); params.push(Number(price)); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (isDefault !== undefined) { updates.push('is_default = ?'); params.push(isDefault ? 1 : 0); }
  if (cost !== undefined) { updates.push('cost = ?'); params.push(cost === '' || cost === null ? null : Number(cost)); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push((typeof notes === 'string' && notes.trim()) ? notes.trim() : null); }
  if (contains !== undefined) {
    // Normalize to an array of {qty, name, upc}; store as JSON (null if empty).
    let arr = [];
    if (Array.isArray(contains)) {
      arr = contains
        .map(x => ({ qty: Number(x.qty) || 0, name: String(x.name || '').trim(), upc: String(x.upc || '').trim() }))
        .filter(x => x.name || x.upc || x.qty);
    }
    updates.push('contains = ?'); params.push(arr.length ? JSON.stringify(arr) : null);
  }
  params.push(req.params.id);

  // Capture the old stock before updating so we can log the change.
  let oldStock = null;
  if (stock !== undefined) {
    const cur = db.prepare('SELECT stock FROM items WHERE id = ?').get(req.params.id);
    oldStock = cur ? cur.stock : null;
  }

  const info = db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });

  // Record the stock change in the audit trail (only when stock actually changed).
  if (stock !== undefined && Number(stock) !== oldStock) {
    db.prepare(`INSERT INTO stock_log (item_id, old_stock, new_stock, delta, changed_by, reason, changed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      req.params.id, oldStock, Number(stock), Number(stock) - (oldStock || 0),
      (typeof changedBy === 'string' && changedBy.trim()) ? changedBy.trim() : null,
      (typeof reason === 'string' && reason.trim()) ? reason.trim() : null,
      new Date().toISOString()
    );
  }

  const result = { id: req.params.id };
  if (stock !== undefined) result.stock = Number(stock);
  if (name !== undefined) result.name = name.trim();
  if (brand !== undefined) result.brand = brand.trim();
  if (pack !== undefined) result.pack = Number(pack);
  if (packLabel !== undefined) result.packLabel = packLabel.trim() || null;
  if (imageUrl !== undefined) result.imageUrl = imageUrl.trim() || null;
  if (upc !== undefined) result.upc = (upc == null ? '' : String(upc)).trim() || null;
  if (price !== undefined) result.price = Number(price);
  if (active !== undefined) result.active = active;
  if (contains !== undefined) {
    const row = db.prepare('SELECT contains FROM items WHERE id = ?').get(req.params.id);
    try { result.contains = row && row.contains ? JSON.parse(row.contains) : []; } catch { result.contains = []; }
  }
  res.json(result);
});

// PATCH /api/items/brand/:brand — bulk toggle active, OR rename every item in
// a brand at once  { active? , rename? }
router.patch('/brand/:brand', (req, res) => {
  const { active, rename } = req.body;
  if (active === undefined && rename === undefined) {
    return res.status(400).json({ error: 'active and/or rename must be provided' });
  }
  if (active !== undefined && typeof active !== 'boolean') {
    return res.status(400).json({ error: 'active must be true or false' });
  }
  if (rename !== undefined && !rename.trim()) {
    return res.status(400).json({ error: 'rename cannot be empty' });
  }

  let itemsUpdated = 0;
  if (active !== undefined) {
    const info = db.prepare('UPDATE items SET active = ? WHERE brand = ?').run(active ? 1 : 0, req.params.brand);
    itemsUpdated = info.changes;
  }
  if (rename !== undefined) {
    const info = db.prepare('UPDATE items SET brand = ? WHERE brand = ?').run(rename.trim(), req.params.brand);
    itemsUpdated = info.changes;
  }
  res.json({ brand: rename !== undefined ? rename.trim() : req.params.brand, active, itemsUpdated });
});

// POST /api/items/bulk-update — apply stock/price updates to many items at once,
// e.g. from a CSV re-upload. body: { updates: [{ id, stock?, price? }, ...] }
// Runs as a single transaction; unknown ids are reported back, not errored on.
router.post('/bulk-update', (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates must be a non-empty array' });
  }

  const getItem = db.prepare('SELECT id FROM items WHERE id = ?');
  const updateStock = db.prepare('UPDATE items SET stock = ? WHERE id = ?');
  const updatePrice = db.prepare('UPDATE items SET price = ? WHERE id = ?');
  const updateBoth = db.prepare('UPDATE items SET stock = ?, price = ? WHERE id = ?');

  const notFound = [];
  let updated = 0;

  const run = db.transaction(() => {
    for (const u of updates) {
      if (!u || !u.id) continue;
      if (!getItem.get(u.id)) { notFound.push(u.id); continue; }

      const hasStock = u.stock !== undefined && u.stock !== null && u.stock !== '' && !Number.isNaN(Number(u.stock));
      const hasPrice = u.price !== undefined && u.price !== null && u.price !== '' && !Number.isNaN(Number(u.price));

      if (hasStock && hasPrice) {
        updateBoth.run(Number(u.stock), Number(u.price), u.id);
        updated++;
      } else if (hasStock) {
        updateStock.run(Number(u.stock), u.id);
        updated++;
      } else if (hasPrice) {
        updatePrice.run(Number(u.price), u.id);
        updated++;
      }
    }
  });
  run();

  res.json({ updated, notFound, totalRows: updates.length });
});

// POST /api/items/bulk-upc — set UPCs for many items at once, matched by SKU.
// body: { updates: [{ id, upc }, ...] }. Blank upc clears it. Unknown ids
// are reported back rather than erroring the whole batch.
router.post('/bulk-upc', (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates must be a non-empty array' });
  }

  const getItem = db.prepare('SELECT id FROM items WHERE id = ?');
  const setUpc = db.prepare('UPDATE items SET upc = ? WHERE id = ?');

  const notFound = [];
  let updated = 0;

  const run = db.transaction(() => {
    for (const u of updates) {
      if (!u || !u.id) continue;
      if (!getItem.get(u.id)) { notFound.push(u.id); continue; }
      const upc = (u.upc == null ? '' : String(u.upc)).trim() || null;
      setUpc.run(upc, u.id);
      updated++;
    }
  });
  run();

  res.json({ updated, notFound, totalRows: updates.length });
});

// POST /api/items/:id/image — upload a product photo directly (base64),
// save it to the persistent disk, and set the item's imageUrl to point at it.
// body: { imageData: '<base64, with or without a data: prefix>', ext: 'png' }
router.post('/:id/image', (req, res) => {
  const { imageData, ext } = req.body;
  if (!imageData) return res.status(400).json({ error: 'imageData is required' });

  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(req.params.id);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const safeExt = (ext || 'png').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'png';
  const base64 = imageData.includes(',') ? imageData.split(',').pop() : imageData;
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) throw new Error('empty');
  } catch (err) {
    return res.status(400).json({ error: 'imageData could not be decoded as base64' });
  }
  if (buffer.length > 8 * 1024 * 1024) {
    return res.status(400).json({ error: 'Image too large (max 8MB)' });
  }

  const safeId = req.params.id.replace(/[^a-z0-9]/gi, '_');
  const filename = `${safeId}-${crypto.randomBytes(4).toString('hex')}.${safeExt}`;
  const imagesDir = req.app.get('imagesDir');
  fs.writeFileSync(path.join(imagesDir, filename), buffer);

  // Render (and most hosts) terminate TLS at a proxy and forward as http
  // internally, so req.protocol is 'http'. Honor X-Forwarded-Proto so the
  // stored URL is https and won't be blocked as mixed content on an https page.
  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  const imageUrl = `${proto}://${req.get('host')}/images/${filename}`;
  db.prepare('UPDATE items SET imageUrl = ? WHERE id = ?').run(imageUrl, req.params.id);

  res.json({ id: req.params.id, imageUrl });
});

// POST /api/items/apply-costs — load landed costs from the pricing sheet bundle.
router.post('/apply-costs', (req, res) => {
  const { ITEM_COSTS } = require('../itemCosts');
  const valid = new Set(db.prepare('SELECT id FROM items').all().map(i => i.id));
  const normId = s => String(s).trim().toLowerCase();
  const idByNorm = new Map(db.prepare('SELECT id FROM items').all().map(i => [normId(i.id), i.id]));
  const upd = db.prepare('UPDATE items SET cost = ? WHERE id = ?');
  let updated = 0, skipped = 0;
  const tx = db.transaction(() => {
    for (const [id, cost] of Object.entries(ITEM_COSTS)) {
      let target = valid.has(id) ? id : idByNorm.get(normId(id));
      if (!target) { skipped++; continue; }
      upd.run(cost, target); updated++;
    }
  });
  tx();
  res.json({ ok: true, updated, skipped });
});

// POST /api/items/activate-all — make every inactive item active again.
// Returns how many were changed. (One-time bulk action.)
router.post('/activate-all', (req, res) => {
  const r = db.prepare('UPDATE items SET active = 1 WHERE active = 0').run();
  res.json({ ok: true, activated: r.changes });
});

// POST /api/items/fix-box-packs — one-time correction of box packs that were
// stored as 1 (they hold multiple eaches). Loacker bars 12/box, Oberto 8/box.
router.post('/fix-box-packs', (req, res) => {
  const fixes = {
    'Loacker:10643': 12, 'Loacker:10646': 12, 'Loacker:10671': 12, 'Loacker:10674': 12,
    'Loacker:10675': 12, 'Loacker:13501': 12, 'Loacker:12581': 12, 'Loacker:12586': 12,
    'Loacker:12587': 12, 'Oberto:3356': 8, 'Oberto:3358': 8,
  };
  const upd = db.prepare('UPDATE items SET pack = ? WHERE id = ?');
  const applied = [];
  for (const [id, pack] of Object.entries(fixes)) {
    const r = upd.run(pack, id);
    if (r.changes) applied.push({ id, pack });
  }
  res.json({ ok: true, updated: applied.length, applied });
});

// GET /api/items/consolidate-preview — dry run of the box+case merge.
router.get('/consolidate-preview', (req, res) => {
  const { consolidate } = require('../consolidate');
  res.json(consolidate(db, { apply: false }));
});
// POST /api/items/consolidate — actually merge box+case pairs (destructive).
router.post('/consolidate', (req, res) => {
  const { consolidate } = require('../consolidate');
  res.json(consolidate(db, { apply: true }));
});

// GET /api/items/import-map — all remembered upload matches (file key -> item).
router.get('/import-map', (req, res) => {
  const rows = db.prepare('SELECT source, file_key AS fileKey, item_id AS itemId FROM import_map').all();
  res.json(rows);
});
// POST /api/items/import-map { source, fileKey, itemId } — remember a match.
router.post('/import-map', (req, res) => {
  const { source, fileKey, itemId } = req.body || {};
  if (!fileKey || !itemId) return res.status(400).json({ error: 'fileKey and itemId are required' });
  db.prepare(`INSERT INTO import_map (source, file_key, item_id, created_at)
              VALUES (?, ?, ?, ?)
              ON CONFLICT(source, file_key) DO UPDATE SET item_id = excluded.item_id, created_at = excluded.created_at`)
    .run(source || null, String(fileKey), String(itemId), new Date().toISOString());
  res.json({ ok: true });
});

// DELETE /api/items/stock-log/:logId — remove a stock-change entry. If it's the
// item's MOST RECENT change, also revert the item's stock to that entry's old
// value (safe undo). For older entries, only the record is deleted (reverting
// would clobber later changes). Returns { reverted, newStock }.
router.delete('/stock-log/:logId', (req, res) => {
  const logId = parseInt(req.params.logId, 10);
  if (!logId) return res.status(400).json({ error: 'Invalid log id' });
  const entry = db.prepare('SELECT * FROM stock_log WHERE id = ?').get(logId);
  if (!entry) return res.status(404).json({ error: 'Log entry not found' });
  // Is this the most recent change for that item?
  const latest = db.prepare('SELECT id FROM stock_log WHERE item_id = ? ORDER BY id DESC LIMIT 1').get(entry.item_id);
  const isLatest = latest && latest.id === logId;
  let reverted = false, newStock = null;
  const tx = db.transaction(() => {
    if (isLatest && entry.old_stock != null) {
      db.prepare('UPDATE items SET stock = ? WHERE id = ?').run(entry.old_stock, entry.item_id);
      reverted = true; newStock = entry.old_stock;
    } else {
      const cur = db.prepare('SELECT stock FROM items WHERE id = ?').get(entry.item_id);
      newStock = cur ? cur.stock : null;
    }
    db.prepare('DELETE FROM stock_log WHERE id = ?').run(logId);
  });
  tx();
  res.json({ ok: true, reverted, newStock, isLatest });
});

// POST /api/items/:id/stock-log — add a history entry WITHOUT changing stock.
// For recording a past change that wasn't logged (e.g. a PO received before
// receipt-logging existed). Uses the item's current stock as new_stock; old_stock
// = current - delta so the entry reads correctly. Body: { delta, reason, changedBy }.
router.post('/:id/stock-log', (req, res) => {
  const itemId = req.params.id;
  const { delta, reason, changedBy, newStock: newStockOverride } = req.body || {};
  const d = Number(delta);
  if (!Number.isFinite(d)) return res.status(400).json({ error: 'delta must be a number' });
  const item = db.prepare('SELECT stock FROM items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const newStock = newStockOverride != null ? Number(newStockOverride) : item.stock;
  const oldStock = newStock - d;
  db.prepare(`INSERT INTO stock_log (item_id, old_stock, new_stock, delta, changed_by, reason, changed_at)
              VALUES (?, ?, ?, ?, ?, ?, ?)`)
    .run(itemId, oldStock, newStock, d, changedBy || null, reason || null, new Date().toISOString());
  res.json({ ok: true, itemId, oldStock, newStock, delta: d });
});

// GET /api/items/export-inventory — full inventory CSV (id, name, brand, stock,
// pack, case_size, etc.) for a snapshot / reconciliation.
router.get('/export-inventory', (req, res) => {
  const rows = db.prepare(
    `SELECT id, brand, name, stock, pack, packLabel, case_size AS caseSize,
            price, case_price AS casePrice, cost, active
       FROM items ORDER BY brand, name`
  ).all();
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['Item #', 'Full ID', 'Brand', 'Item', 'Stock (boxes)', 'Pack', 'Pack label', 'Case size', 'Price', 'Case price', 'Cost', 'Active'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id.split(':').pop(), r.id, r.brand || '', r.name || '', r.stock,
      r.pack || '', r.packLabel || '', r.caseSize || '', r.price != null ? r.price : '',
      r.casePrice != null ? r.casePrice : '', r.cost != null ? r.cost : '', r.active ? 'yes' : 'no',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="inventory-snapshot.csv"');
  res.send(lines.join('\n'));
});

// GET /api/items/:id/stock-check — reconcile an item's stock: current stored
// stock vs. correct box consumption from all its orders + logged additions.
// GET /api/items/consumed-since?date=YYYY-MM-DD — for EVERY item, the total
// boxes consumed by submitted orders whose delivery date is on/after `date`.
// Used to reconcile against an inventory snapshot from that date.
router.get('/consumed-since', (req, res) => {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : '2026-09-01';
  const rows = db.prepare(
    `SELECT ol.item_id AS itemId, i.case_size AS caseSize, ol.qty, ol.unit
       FROM order_lines ol
       JOIN orders o ON o.id = ol.order_id
       LEFT JOIN items i ON i.id = ol.item_id
      WHERE o.status = 'submitted' AND o.delivery_date >= ?`
  ).all(date);
  const byItem = {};
  for (const r of rows) {
    const cs = Number(r.caseSize) > 0 ? Number(r.caseSize) : 1;
    const boxes = (Number(r.qty) || 0) * (r.unit === 'case' ? cs : 1);
    byItem[r.itemId] = (byItem[r.itemId] || 0) + boxes;
  }
  res.json({ since: date, itemCount: Object.keys(byItem).length, consumed: byItem });
});

router.get('/:id/stock-check', (req, res) => {
  const itemId = req.params.id;
  const item = db.prepare('SELECT id, name, stock, pack, case_size AS caseSize FROM items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const cs = Number(item.caseSize) > 0 ? Number(item.caseSize) : 1;
  const lines = db.prepare(
    `SELECT o.id AS orderId, o.delivery_date AS deliveryDate, c.name AS customer, ol.qty, ol.unit
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id
       LEFT JOIN customers c ON c.id = o.customer_id
      WHERE ol.item_id = ? AND o.status = 'submitted' ORDER BY o.id`
  ).all(itemId);
  let totalBoxesConsumed = 0;
  const orders = lines.map(l => {
    const boxes = (Number(l.qty) || 0) * (l.unit === 'case' ? cs : 1);
    totalBoxesConsumed += boxes;
    return { orderId: l.orderId, customer: l.customer, qty: l.qty, unit: l.unit, boxesConsumed: boxes };
  });
  const logs = db.prepare(
    `SELECT old_stock AS oldStock, new_stock AS newStock, delta, reason, changed_at AS changedAt
       FROM stock_log WHERE item_id = ? ORDER BY id`
  ).all(itemId);
  const totalLoggedAdded = logs.reduce((s, l) => s + (l.delta > 0 ? l.delta : 0), 0);
  res.json({
    itemId, name: item.name, currentStock: item.stock, pack: item.pack, caseSize: item.caseSize || null,
    totalBoxesConsumed, orderCount: orders.length, orders, loggedChanges: logs, totalLoggedAdded,
  });
});

// GET /api/items/export-stock-log — the FULL stock change history (no limit),
// oldest first, so stock can be reconstructed/audited.
router.get('/export-stock-log', (req, res) => {
  const rows = db.prepare(
    `SELECT sl.id, sl.item_id AS itemId, i.name AS item, i.brand,
            sl.old_stock AS oldStock, sl.new_stock AS newStock, sl.delta,
            sl.changed_by AS changedBy, sl.reason, sl.changed_at AS changedAt
       FROM stock_log sl LEFT JOIN items i ON i.id = sl.item_id
      ORDER BY sl.id ASC`
  ).all();
  const esc = v => { const s = v == null ? '' : String(v); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const header = ['Log ID', 'Item #', 'Full ID', 'Item', 'Brand', 'Old stock', 'New stock', 'Change', 'Who', 'Reason', 'When'];
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push([
      r.id, r.itemId ? r.itemId.split(':').pop() : '', r.itemId || '', r.item || '', r.brand || '',
      r.oldStock, r.newStock, r.delta, r.changedBy || '', r.reason || '', r.changedAt || '',
    ].map(esc).join(','));
  }
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="stock-history-full.csv"');
  res.send(lines.join('\n'));
});

// GET /api/items/stock-log/recent — the whole recent trail across items.
router.get('/stock-log/recent', (req, res) => {
  const rows = db.prepare(
    `SELECT sl.id, sl.item_id AS itemId, i.name AS item, i.brand,
            sl.old_stock AS oldStock, sl.new_stock AS newStock, sl.delta,
            sl.changed_by AS changedBy, sl.reason, sl.changed_at AS changedAt
       FROM stock_log sl LEFT JOIN items i ON i.id = sl.item_id
      ORDER BY sl.id DESC LIMIT 300`
  ).all();
  res.json(rows);
});
// GET /api/items/:id/stock-log — change history for one item (newest first).
router.get('/:id/stock-log', (req, res) => {
  const rows = db.prepare(
    `SELECT id, old_stock AS oldStock, new_stock AS newStock, delta,
            changed_by AS changedBy, reason, changed_at AS changedAt
       FROM stock_log WHERE item_id = ? ORDER BY id DESC LIMIT 200`
  ).all(req.params.id);
  res.json(rows);
});

// DELETE /api/items/:id — delete an item, but ONLY if it has no order history
// (refuses otherwise, so historical invoices never break). Also clears its
// catalog entries and stock log. Intended for retiring duplicate/unused items.
router.delete('/:id', (req, res) => {
  const id = req.params.id;
  const item = db.prepare('SELECT id, name FROM items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const lineCount = db.prepare('SELECT COUNT(*) n FROM order_lines WHERE item_id = ?').get(id).n;
  if (lineCount > 0) {
    return res.status(409).json({ error: `"${item.name}" is on ${lineCount} order line(s) and can't be deleted (would break invoices). Make it inactive instead.`, lineCount });
  }
  const poCount = db.prepare("SELECT COUNT(*) n FROM po_lines WHERE item_id = ?").get(id).n;
  if (poCount > 0) {
    return res.status(409).json({ error: `"${item.name}" is on ${poCount} purchase-order line(s) and can't be deleted.`, poCount });
  }
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM customer_catalog WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM stock_log WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM print_order WHERE item_id = ?').run(id);
    db.prepare('DELETE FROM items WHERE id = ?').run(id);
  });
  tx();
  res.json({ ok: true, deleted: id });
});

// POST /api/items/reset-stock-value — set every item currently at exactly `from`
// (default 100) to `to` (default 0). For clearing a placeholder reset value.
// Body: { from, to, preview }. Logs each change to stock history.
router.post('/reset-stock-value', (req, res) => {
  const from = req.body && req.body.from != null ? Number(req.body.from) : 100;
  const to = req.body && req.body.to != null ? Number(req.body.to) : 0;
  const dryRun = !!(req.body && req.body.preview);
  const items = db.prepare('SELECT id, name, stock FROM items WHERE stock = ?').all(from);
  const setStock = db.prepare('UPDATE items SET stock = ? WHERE id = ?');
  const logChange = db.prepare(
    `INSERT INTO stock_log (item_id, old_stock, new_stock, delta, changed_by, reason, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const now = new Date().toISOString();
  let changed = 0;
  if (!dryRun) {
    const tx = db.transaction(() => {
      for (const it of items) {
        setStock.run(to, it.id);
        logChange.run(it.id, from, to, to - from, 'Reset placeholder', `Reset ${from} -> ${to}`, now);
        changed++;
      }
    });
    tx();
  }
  res.json({ preview: dryRun, matched: items.length, changed: dryRun ? 0 : changed, from, to });
});

module.exports = router;
