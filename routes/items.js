const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/items — list items (current live inventory).
// By default only active items are returned (what the ordering app and
// inventory browser should see). Pass ?includeInactive=true for everyone,
// e.g. for the office management view.
// Optional query params: ?brand=Oberto  ?lowStockMax=5  ?includeInactive=true
router.get('/', (req, res) => {
  const { brand, lowStockMax, includeInactive } = req.query;
  let sql = 'SELECT id, brand, name, stock, price, pack, packLabel, active FROM items WHERE 1=1';
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

  const items = db.prepare(sql).all(...params);
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
  const { id, brand, name, stock, price } = req.body;
  if (!id || !brand || !name) {
    return res.status(400).json({ error: 'id, brand, and name are required' });
  }
  try {
    db.prepare('INSERT INTO items (id, brand, name, stock, price) VALUES (?, ?, ?, ?, ?)').run(
      id,
      brand,
      name,
      Number(stock) || 0,
      Number(price) || 0
    );
    res.status(201).json({ id, brand, name, stock: Number(stock) || 0, price: Number(price) || 0, active: 1 });
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
  const { stock, name, brand, pack, price, active } = req.body;
  if (stock === undefined && name === undefined && brand === undefined && pack === undefined && price === undefined && active === undefined) {
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
  if (price !== undefined) { updates.push('price = ?'); params.push(Number(price)); }
  if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  params.push(req.params.id);

  const info = db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });

  const result = { id: req.params.id };
  if (stock !== undefined) result.stock = Number(stock);
  if (name !== undefined) result.name = name.trim();
  if (brand !== undefined) result.brand = brand.trim();
  if (pack !== undefined) result.pack = Number(pack);
  if (price !== undefined) result.price = Number(price);
  if (active !== undefined) result.active = active;
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

module.exports = router;
