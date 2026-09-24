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
  let sql = 'SELECT id, brand, name, stock, price, pack, packLabel, imageUrl, upc, active, contains, is_default as isDefault, case_size as caseSize, case_price as casePrice, cost, net_cost as netCost, taiyo_cost as taiyoCost, notes FROM items WHERE 1=1';
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

  const computed = db.computeStock();
  const items = db.prepare(sql).all(...params).map(it => {
    let contains = [];
    if (it.contains) { try { contains = JSON.parse(it.contains) || []; } catch { contains = []; } }
    const c = computed[it.id];
    // The main `stock` number the app uses everywhere (mobile, plain column,
    // order entry, warnings) is AVAILABLE (on-hand − future orders) = what's
    // left to sell. onHand and available are also exposed for the Today's view.
    const onHand = c ? c.onHand : it.stock;
    const available = c ? c.available : it.stock;
    return {
      ...it, contains,
      stock: available,   // <- default stock = available (after allocation)
      onHand,
      available,
      futureBoxes: c ? c.futureBoxes : 0,
      hasBaseline: c ? c.hasBaseline : false,
    };
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

// PATCH /api/items/:id/rename — change an item's SKU/item number (the part
// after the brand prefix, e.g. "ACL:NIBB4OZ" -> "ACL:NIBB4OZ2"). The item id
// is the primary key AND is referenced by item_id columns across several
// other tables (orders, purchase orders, stock history, catalogs, print
// order, import matching) with no FK cascade configured — so a rename has
// to update every one of those in the same transaction, or those rows would
// silently point at a SKU that no longer exists.
// body: { code } — just the part after the brand prefix; the existing
// prefix (whatever precedes the first ":") is kept as-is.
router.patch('/:id/rename', (req, res) => {
  const oldId = req.params.id;
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(oldId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const rawCode = (req.body && req.body.code != null) ? String(req.body.code).trim() : '';
  if (!rawCode) return res.status(400).json({ error: 'Provide the new item number (code)' });

  const colonIdx = oldId.indexOf(':');
  const prefix = colonIdx >= 0 ? oldId.slice(0, colonIdx) : null;
  const newId = prefix != null ? `${prefix}:${rawCode}` : rawCode;

  if (newId === oldId) return res.json({ ok: true, id: newId, unchanged: true });

  const clash = db.prepare('SELECT id FROM items WHERE id = ?').get(newId);
  if (clash) return res.status(409).json({ error: `An item with SKU "${newId}" already exists` });

  const tx = db.transaction(() => {
    // FK enforcement is ON, so a straight sequential rename would violate a
    // constraint mid-transaction (a child row briefly pointing at an id that
    // doesn't exist yet, or the old id after items.id has already moved).
    // Deferring checks until commit lets every table update in any order and
    // only validates that everything lines up once it's all done.
    db.pragma('defer_foreign_keys = ON');
    db.prepare('UPDATE items SET id = ? WHERE id = ?').run(newId, oldId);
    db.prepare('UPDATE order_lines SET item_id = ? WHERE item_id = ?').run(newId, oldId);
    db.prepare('UPDATE po_lines SET item_id = ? WHERE item_id = ?').run(newId, oldId);
    db.prepare('UPDATE stock_log SET item_id = ? WHERE item_id = ?').run(newId, oldId);
    db.prepare('UPDATE stock_baseline SET item_id = ? WHERE item_id = ?').run(newId, oldId);
    db.prepare('UPDATE customer_catalog SET item_id = ? WHERE item_id = ?').run(newId, oldId);
    db.prepare('UPDATE import_map SET item_id = ? WHERE item_id = ?').run(newId, oldId);
    // print_order.item_id is itself a primary key — drop any pre-existing
    // (orphaned) row at the destination id first so the update can't collide.
    db.prepare('DELETE FROM print_order WHERE item_id = ?').run(newId);
    db.prepare('UPDATE print_order SET item_id = ? WHERE item_id = ?').run(newId, oldId);
  });
  try {
    tx();
  } catch (err) {
    return res.status(500).json({ error: 'Rename failed: ' + (err.message || err) });
  }
  res.json({ ok: true, id: newId });
});

// PATCH /api/items/:id — edit stock, name, brand, pack, and/or toggle active
// body: { stock?, name?, brand?, pack?, active? }
// (Stock corrections here are for fixing mistakes — normal stock changes
// should happen via orders.)
router.patch('/:id', (req, res) => {
  const { stock, name, brand, pack, packLabel, imageUrl, upc, price, active, contains, isDefault, cost, netCost, notes, caseSize, taiyoCost, changedBy, reason } = req.body;
  if (stock === undefined && name === undefined && brand === undefined && pack === undefined && packLabel === undefined && imageUrl === undefined && upc === undefined && price === undefined && active === undefined && contains === undefined && isDefault === undefined && cost === undefined && netCost === undefined && taiyoCost === undefined && notes === undefined && caseSize === undefined) {
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
  if (taiyoCost !== undefined) { updates.push('taiyo_cost = ?'); params.push(taiyoCost == null || taiyoCost === '' || Number(taiyoCost) <= 0 ? null : Number(taiyoCost)); }
  if (packLabel !== undefined) { updates.push('packLabel = ?'); params.push(packLabel.trim() || null); }
  if (imageUrl !== undefined) { updates.push('imageUrl = ?'); params.push(imageUrl.trim() || null); }
  if (upc !== undefined) { updates.push('upc = ?'); params.push((upc == null ? '' : String(upc)).trim() || null); }
  if (price !== undefined) { updates.push('price = ?'); params.push(Number(price)); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (isDefault !== undefined) { updates.push('is_default = ?'); params.push(isDefault ? 1 : 0); }
  if (cost !== undefined) { updates.push('cost = ?'); params.push(cost === '' || cost === null ? null : Number(cost)); }
  if (netCost !== undefined) { updates.push('net_cost = ?'); params.push(netCost === '' || netCost === null ? null : Number(netCost)); }
  if (notes !== undefined) { updates.push('notes = ?'); params.push((typeof notes === 'string' && notes.trim()) ? notes.trim() : null); }
  if (contains !== undefined) {
    // Normalize to an array of {qty, name, upc, itemId?}; store as JSON (null
    // if empty). itemId links back to a real catalog item when the row was
    // picked from search; omitted for a manually-typed row (something not
    // set up as its own item yet) — kept so the UI can tell the two apart on
    // reload instead of everything looking manually-typed.
    let arr = [];
    if (Array.isArray(contains)) {
      arr = contains
        .map(x => ({ qty: Number(x.qty) || 0, name: String(x.name || '').trim(), upc: String(x.upc || '').trim(), ...(x.itemId ? { itemId: String(x.itemId) } : {}) }))
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
    // Also set a dated BASELINE as of today so the edit STICKS (the date-based
    // model computes on-hand from the latest baseline — without this, the next
    // order recalculation would overwrite a direct stock edit). Editing stock =
    // "on hand is now this", i.e. a physical count as of today.
    const today = db.todayHST();
    db.prepare('INSERT INTO stock_baseline (item_id, count, as_of_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(req.params.id, Number(stock), today,
        (typeof changedBy === 'string' && changedBy.trim()) ? changedBy.trim() : 'Stock edit',
        new Date().toISOString());
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
// e.g. from a CSV re-upload. body: { updates: [{ id, stock?, price? }, ...], changedBy? }
// Runs as a single transaction; unknown ids are reported back, not errored on.
// A stock change is logged to stock_log AND given a dated baseline (same as a
// single-item manual edit) so it shows up in the item's history and actually
// sticks as the new on-hand anchor -- without the baseline, the date-based
// model would have no record this happened and could silently recompute past
// it on the next order or PO sync.
router.post('/bulk-update', (req, res) => {
  const { updates, changedBy } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates must be a non-empty array' });
  }
  const by = (typeof changedBy === 'string' && changedBy.trim()) ? changedBy.trim() : 'CSV import';
  const today = db.todayHST();
  const now = new Date().toISOString();

  const getItem = db.prepare('SELECT id, stock FROM items WHERE id = ?');
  const updateStock = db.prepare('UPDATE items SET stock = ? WHERE id = ?');
  const updatePrice = db.prepare('UPDATE items SET price = ? WHERE id = ?');
  const updateBoth = db.prepare('UPDATE items SET stock = ?, price = ? WHERE id = ?');
  const logStock = db.prepare(
    `INSERT INTO stock_log (item_id, old_stock, new_stock, delta, changed_by, reason, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  );
  const insBaseline = db.prepare(
    'INSERT INTO stock_baseline (item_id, count, as_of_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)'
  );

  const notFound = [];
  let updated = 0;

  const run = db.transaction(() => {
    for (const u of updates) {
      if (!u || !u.id) continue;
      const item = getItem.get(u.id);
      if (!item) { notFound.push(u.id); continue; }

      const hasStock = u.stock !== undefined && u.stock !== null && u.stock !== '' && !Number.isNaN(Number(u.stock));
      const hasPrice = u.price !== undefined && u.price !== null && u.price !== '' && !Number.isNaN(Number(u.price));
      const newStock = hasStock ? Number(u.stock) : null;
      const stockChanged = hasStock && newStock !== Number(item.stock);

      if (hasStock && hasPrice) updateBoth.run(newStock, Number(u.price), u.id);
      else if (hasStock) updateStock.run(newStock, u.id);
      else if (hasPrice) updatePrice.run(Number(u.price), u.id);
      if (hasStock || hasPrice) updated++;

      if (stockChanged) {
        logStock.run(u.id, item.stock, newStock, newStock - Number(item.stock), by, 'CSV import', now);
        insBaseline.run(u.id, newStock, today, by, now);
      }
    }
  });
  run();

  res.json({ updated, notFound, totalRows: updates.length });
});

// POST /api/items/bulk-net-cost — set the Taiyo net-cost (per each) for many
// items at once, e.g. from a pricing sheet. body: { updates: [{ id, netCost }] }
// Runs as a single transaction; unknown ids are reported back, not errored on.
router.post('/bulk-net-cost', (req, res) => {
  const { updates } = req.body;
  if (!Array.isArray(updates) || updates.length === 0) {
    return res.status(400).json({ error: 'updates must be a non-empty array' });
  }
  const getItem = db.prepare('SELECT id FROM items WHERE id = ?');
  const updateNetCost = db.prepare('UPDATE items SET net_cost = ? WHERE id = ?');
  const notFound = [];
  let updated = 0;
  const run = db.transaction(() => {
    for (const u of updates) {
      if (!u || !u.id) continue;
      if (!getItem.get(u.id)) { notFound.push(u.id); continue; }
      const hasNetCost = u.netCost !== undefined && u.netCost !== null && u.netCost !== '' && !Number.isNaN(Number(u.netCost));
      if (hasNetCost) { updateNetCost.run(Number(u.netCost), u.id); updated++; }
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

// POST /api/items/fix-changed-by { from, to, preview? } — bulk-renames a
// changedBy/createdBy value across stock_log and stock_baseline (e.g. a
// device's stored name that had extra text baked into it, showing up on
// every entry that device ever made). preview: true reports counts without
// writing anything.
router.post('/fix-changed-by', (req, res) => {
  const { from, to, preview } = req.body || {};
  if (!from || !to) return res.status(400).json({ error: 'from and to are required' });
  const logCount = db.prepare('SELECT COUNT(*) n FROM stock_log WHERE changed_by = ?').get(from).n;
  const baselineCount = db.prepare('SELECT COUNT(*) n FROM stock_baseline WHERE created_by = ?').get(from).n;
  if (!preview) {
    const tx = db.transaction(() => {
      db.prepare('UPDATE stock_log SET changed_by = ? WHERE changed_by = ?').run(to, from);
      db.prepare('UPDATE stock_baseline SET created_by = ? WHERE created_by = ?').run(to, from);
    });
    tx();
  }
  res.json({ ok: true, preview: !!preview, logUpdated: logCount, baselinesUpdated: baselineCount });
});

// POST /api/items/fix-orphaned-baseline-dates { preview? } — finds
// stock_baseline rows whose as_of_date doesn't match any stock_log entry for
// the same item/count, but whose created_at is within a few seconds of a
// stock_log entry's changed_at for the same item/count (i.e. the same
// backend action wrote both records, just with an inconsistent date) --
// this mismatch is what makes the item history view treat them as two
// separate events (an unrecognized "bulk correction" row plus a synthetic
// baseline row) instead of one. Sets the baseline's as_of_date to match the
// stock_log entry's actual date. preview: true reports what would change
// without writing anything.
router.get('/orphaned-baseline-dates', (req, res) => {
  res.json(findOrphanedBaselineDates());
});
router.post('/fix-orphaned-baseline-dates', (req, res) => {
  const { preview } = req.body || {};
  const fixes = findOrphanedBaselineDates();
  if (!preview && fixes.length) {
    const upd = db.prepare('UPDATE stock_baseline SET as_of_date = ? WHERE item_id = ? AND as_of_date = ? AND count = ? AND created_by = ? AND created_at = ?');
    const tx = db.transaction(() => {
      for (const f of fixes) upd.run(f.correctDate, f.itemId, f.oldDate, f.count, f.createdBy, f.createdAt);
    });
    tx();
  }
  res.json({ ok: true, preview: !!preview, fixed: fixes.length, fixes });
});
function findOrphanedBaselineDates() {
  const baselines = db.prepare('SELECT item_id AS itemId, count, as_of_date AS asOfDate, created_by AS createdBy, created_at AS createdAt FROM stock_baseline').all();
  const logs = db.prepare('SELECT item_id AS itemId, new_stock AS newStock, changed_at AS changedAt FROM stock_log').all();
  const logsByItem = {};
  for (const l of logs) (logsByItem[l.itemId] || (logsByItem[l.itemId] = [])).push(l);
  const fixes = [];
  for (const b of baselines) {
    const candidates = logsByItem[b.itemId] || [];
    // Already matches a log entry by date+count -- not orphaned, leave alone.
    if (candidates.some(l => l.newStock === b.count && String(l.changedAt).slice(0, 10) === b.asOfDate)) continue;
    // Same action, inconsistent date: same count, timestamps within 5s of each other, but a different date.
    const match = candidates.find(l => {
      if (l.newStock !== b.count) return false;
      const dt = Math.abs(new Date(l.changedAt).getTime() - new Date(b.createdAt).getTime());
      return dt < 5000 && String(l.changedAt).slice(0, 10) !== b.asOfDate;
    });
    if (match) {
      fixes.push({ itemId: b.itemId, count: b.count, createdBy: b.createdBy, createdAt: b.createdAt, oldDate: b.asOfDate, correctDate: String(match.changedAt).slice(0, 10) });
    }
  }
  return fixes;
}


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

// POST /api/items/resync-stock — set the stored `stock` field = computed on-hand
// for every item, so the plain Stock column and the computed on-hand never drift.
router.post('/resync-stock', (req, res) => {
  db.syncStock(); // syncs all items' stored stock to computed on-hand
  res.json({ ok: true });
});

// POST /api/items/rebaseline-to-stock — CLEAN RESET of the date-based model.
// Sets every item's baseline = its current stored `stock`, dated today. Because
// the baseline date is today, computeStock returns exactly the stored stock as
// on-hand (no past orders re-subtracted) — fixing any double-subtraction from
// items that had no baseline. Future orders then correctly reduce "available".
// Body: { preview: true } to see the count without writing.
router.post('/rebaseline-to-stock', (req, res) => {
  const dryRun = !!(req.body && req.body.preview);
  const today = db.todayHST();
  const items = db.prepare('SELECT id, stock FROM items').all();
  const ins = db.prepare('INSERT INTO stock_baseline (item_id, count, as_of_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  let n = 0;
  if (!dryRun) {
    const tx = db.transaction(() => {
      for (const it of items) { ins.run(it.id, Number(it.stock) || 0, today, 'Rebaseline', now); n++; }
    });
    tx();
  } else {
    n = items.length;
  }
  res.json({ ok: true, preview: dryRun, asOfDate: today, itemsBaselined: n });
});

// POST /api/items/seed-baselines — create a starting baseline for every item
// from its CURRENT stock, as of `asOfDate` (default today). Run once to migrate
// into the date-based model. Skips items that already have a baseline on/after
// that date. Body: { asOfDate, preview }.
router.post('/seed-baselines', (req, res) => {
  const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.asOfDate) || '') ? req.body.asOfDate : db.todayHST();
  const dryRun = !!(req.body && req.body.preview);
  const reseed = !!(req.body && req.body.reseed);
  // If re-seeding, clear the previous Migration baselines for this date first so
  // the corrected (future-added-back) values replace the old wrong ones.
  if (reseed && !dryRun) {
    db.prepare("DELETE FROM stock_baseline WHERE created_by = 'Migration' AND as_of_date = ?").run(asOfDate);
  }
  const items = db.prepare('SELECT id, stock, case_size AS caseSize FROM items').all();
  // When reseeding, treat existing Migration baselines as replaceable — so the
  // preview shows the corrected values and the apply clears+reinserts them.
  const existing = reseed ? [] : db.prepare('SELECT DISTINCT item_id FROM stock_baseline WHERE as_of_date >= ?').all(asOfDate).map(r => r.item_id);
  const has = new Set(existing);
  // The OLD model deducted stock at submit time for ALL orders, including
  // future-dated ones. But those items are still PHYSICALLY on the shelf (not
  // shipped). So the true on-hand baseline = current stock + future-order boxes.
  const today = asOfDate;
  const futureBoxes = {};
  const orderLines = db.prepare(
    `SELECT ol.item_id AS itemId, ol.qty, ol.unit, i.case_size AS caseSize, o.delivery_date AS d
       FROM order_lines ol JOIN orders o ON o.id = ol.order_id LEFT JOIN items i ON i.id = ol.item_id
      WHERE o.status = 'submitted' AND o.delivery_date > ?`
  ).all(today);
  for (const l of orderLines) {
    const cs = Number(l.caseSize) > 0 ? Number(l.caseSize) : 1;
    futureBoxes[l.itemId] = (futureBoxes[l.itemId] || 0) + (Number(l.qty) || 0) * (l.unit === 'case' ? cs : 1);
  }
  const ins = db.prepare('INSERT INTO stock_baseline (item_id, count, as_of_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)');
  const now = new Date().toISOString();
  let seeded = 0;
  const sample = [];
  if (!dryRun) {
    const tx = db.transaction(() => {
      for (const it of items) {
        if (has.has(it.id)) continue;
        const baselineCount = (Number(it.stock) || 0) + (futureBoxes[it.id] || 0);
        ins.run(it.id, baselineCount, asOfDate, 'Migration', now);
        seeded++;
      }
    });
    tx();
  } else {
    for (const it of items) {
      if (has.has(it.id)) continue;
      seeded++;
      if ((futureBoxes[it.id] || 0) > 0 && sample.length < 10) {
        sample.push({ id: it.id, oldStock: it.stock, futureAddedBack: futureBoxes[it.id], newBaseline: (Number(it.stock) || 0) + futureBoxes[it.id] });
      }
    }
  }
  res.json({ ok: true, preview: dryRun, asOfDate, itemsTotal: items.length, seeded, sample });
});

// POST /api/items/:id/baseline — record a physical count as a dated baseline.
// This is the on-hand truth as of `asOfDate` (default today). On-hand/available
// are then computed from it + movements. Also updates items.stock (= on-hand now)
// for compatibility, and logs the change.
router.post('/:id/baseline', (req, res) => {
  const id = req.params.id;
  const item = db.prepare('SELECT id, name, stock FROM items WHERE id = ?').get(id);
  if (!item) return res.status(404).json({ error: 'Item not found' });
  const count = Number(req.body && req.body.count);
  if (!Number.isFinite(count)) return res.status(400).json({ error: 'count (boxes) required' });
  const asOfDate = /^\d{4}-\d{2}-\d{2}$/.test(req.body.asOfDate || '') ? req.body.asOfDate : db.todayHST();
  const by = (typeof req.body.changedBy === 'string' && req.body.changedBy.trim()) ? req.body.changedBy.trim() : null;
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    db.prepare('INSERT INTO stock_baseline (item_id, count, as_of_date, created_by, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, count, asOfDate, by, now);
  });
  tx();
  // Recompute on-hand now and sync items.stock so legacy reads stay consistent.
  const c = db.computeStock()[id];
  const onHandNow = c ? c.onHand : count;
  if (Number(item.stock) !== onHandNow) {
    db.prepare('UPDATE items SET stock = ? WHERE id = ?').run(onHandNow, id);
    db.prepare(`INSERT INTO stock_log (item_id, old_stock, new_stock, delta, changed_by, reason, changed_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(id, item.stock, onHandNow, onHandNow - Number(item.stock), by, `Physical count ${asOfDate}`, now);
  }
  res.json({ ok: true, id, asOfDate, count, onHand: onHandNow, available: c ? c.available : onHandNow });
});

// GET /api/items/:id/stock-log — this item's stock-change history (physical
// counts, PO receipts, manual edits, redo), newest first. Also returns any PO
// lines received for this item so the UI can show incoming stock per item,
// and the item's real dated baselines (stock_baseline) so callers can tell
// which log entries are an actual reset point for the on-hand calculation
// (physical counts / direct stock edits) vs. ones that aren't (e.g. the
// bulk "Inventory redo" tool only writes a log entry, not a baseline).
router.get('/:id/stock-log', (req, res) => {
  const id = req.params.id;
  const log = db.prepare(
    `SELECT id, old_stock AS oldStock, new_stock AS newStock, delta, changed_by AS changedBy,
            reason, changed_at AS changedAt
       FROM stock_log WHERE item_id = ? ORDER BY changed_at DESC, id DESC`
  ).all(id);
  const pos = db.prepare(
    `SELECT pl.qty_ordered AS qtyOrdered, pl.qty_received AS qtyReceived, pl.received_date AS receivedDate,
            po.reference, po.supplier, po.order_date AS orderDate, po.expected_date AS expectedDate, po.status
       FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
      WHERE pl.item_id = ? AND po.status != 'cancelled'
      ORDER BY COALESCE(pl.received_date, po.expected_date, po.order_date) DESC`
  ).all(id);
  const baselines = db.prepare(
    `SELECT count, as_of_date AS asOfDate, created_by AS createdBy, created_at AS createdAt
       FROM stock_baseline WHERE item_id = ? ORDER BY as_of_date DESC`
  ).all(id);
  res.json({ log, purchaseOrders: pos, baselines });
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

// POST /api/items/cleanup-shipment-log-entries — one-time removal of
// stock_log rows created by a since-reverted feature that logged each
// order's on-hand impact as a separate "Shipped on order #..." entry. These
// duplicate what the ledger already shows via the orders themselves, making
// history look doubled. Pass ?dryRun=true to preview the count/sample
// before deleting anything.
router.post('/cleanup-shipment-log-entries', (req, res) => {
  const dryRun = req.query.dryRun === 'true';
  const rows = db.prepare(
    `SELECT id, item_id, changed_at, reason FROM stock_log WHERE reason LIKE 'Shipped on order #%'`
  ).all();
  if (!dryRun && rows.length > 0) {
    const del = db.prepare('DELETE FROM stock_log WHERE id = ?');
    const tx = db.transaction(() => { for (const r of rows) del.run(r.id); });
    tx();
  }
  res.json({ dryRun, found: rows.length, deleted: dryRun ? 0 : rows.length, sample: rows.slice(0, 10) });
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
