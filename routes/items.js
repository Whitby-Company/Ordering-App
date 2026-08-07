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
    let sql = 'SELECT id, brand, name, stock, price, active FROM items WHERE 1=1';
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

// PATCH /api/items/:id — adjust stock and/or toggle active  { stock?, active? }
// (For corrections — normal stock changes should happen via orders.)
router.patch('/:id', (req, res) => {
    const { stock, active } = req.body;
    if (stock === undefined && active === undefined) {
          return res.status(400).json({ error: 'stock and/or active must be provided' });
    }
    if (stock !== undefined && Number.isNaN(Number(stock))) {
          return res.status(400).json({ error: 'stock must be a number' });
    }
    if (active !== undefined && typeof active !== 'boolean') {
          return res.status(400).json({ error: 'active must be true or false' });
    }

               const updates = [];
    const params = [];
    if (stock !== undefined) { updates.push('stock = ?'); params.push(Number(stock)); }
    if (active !== undefined) { updates.push('active = ?'); params.push(active ? 1 : 0); }
    params.push(req.params.id);

               const info = db.prepare(`UPDATE items SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });

               const result = { id: req.params.id };
    if (stock !== undefined) result.stock = Number(stock);
    if (active !== undefined) result.active = active;
    res.json(result);
});

// PATCH /api/items/brand/:brand — bulk toggle active for every item in a brand  { active }
router.patch('/brand/:brand', (req, res) => {
    const { active } = req.body;
    if (typeof active !== 'boolean') {
          return res.status(400).json({ error: 'active must be true or false' });
    }
    const info = db.prepare('UPDATE items SET active = ? WHERE brand = ?').run(active ? 1 : 0, req.params.brand);
    res.json({ brand: req.params.brand, active, itemsUpdated: info.changes });
});

module.exports = router;
