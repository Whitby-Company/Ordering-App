const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/customers — list all customers, alphabetical
router.get('/', (req, res) => {
  const customers = db.prepare('SELECT id, name FROM customers ORDER BY name ASC').all();
  res.json(customers);
});

// POST /api/customers — add a new customer  { name }
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const info = db.prepare('INSERT INTO customers (name) VALUES (?)').run(name.trim());
    res.status(201).json({ id: info.lastInsertRowid, name: name.trim() });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A customer with that name already exists' });
    }
    throw err;
  }
});

module.exports = router;
