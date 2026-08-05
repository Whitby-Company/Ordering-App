const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/items — list all items (current live inventory)
// Optional query params: ?brand=Nike  ?lowStockMax=5
router.get('/', (req, res) => {
  const { brand, lowStockMax } = req.query;
  let sql = 'SELECT id, brand, name, stock FROM items WHERE 1=1';
  const params = [];

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

// GET /api/items/brands — distinct brand list with item counts
router.get('/brands', (req, res) => {
  const rows = db
    .prepare('SELECT brand, COUNT(*) as itemCount FROM items GROUP BY brand ORDER BY brand ASC')
    .all();
  res.json(rows);
});

// POST /api/items — add a new item  { id, brand, name, stock }
router.post('/', (req, res) => {
  const { id, brand, name, stock } = req.body;
  if (!id || !brand || !name) {
    return res.status(400).json({ error: 'id, brand, and name are required' });
  }
  try {
    db.prepare('INSERT INTO items (id, brand, name, stock) VALUES (?, ?, ?, ?)').run(
      id,
      brand,
      name,
      Number(stock) || 0
    );
    res.status(201).json({ id, brand, name, stock: Number(stock) || 0 });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_PRIMARYKEY') {
      return res.status(409).json({ error: `An item with SKU "${id}" already exists` });
    }
    throw err;
  }
});

// PATCH /api/items/:id — manually adjust stock  { stock }
// (For corrections — normal stock changes should happen via orders.)
router.patch('/:id', (req, res) => {
  const { stock } = req.body;
  if (stock === undefined || Number.isNaN(Number(stock))) {
    return res.status(400).json({ error: 'stock must be a number' });
  }
  const info = db.prepare('UPDATE items SET stock = ? WHERE id = ?').run(Number(stock), req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Item not found' });
  res.json({ id: req.params.id, stock: Number(stock) });
});

module.exports = router;
