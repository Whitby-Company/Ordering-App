const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/customers — list customers, alphabetical.
// By default only active customers are returned (what the ordering app
// and customer picker should see). Pass ?includeInactive=true to get
// everyone, e.g. for the office management view.
router.get('/', (req, res) => {
    const { includeInactive } = req.query;
    const sql = includeInactive === 'true'
      ? 'SELECT id, name, active FROM customers ORDER BY name ASC'
          : 'SELECT id, name, active FROM customers WHERE active = 1 ORDER BY name ASC';
    const customers = db.prepare(sql).all();
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
          res.status(201).json({ id: info.lastInsertRowid, name: name.trim(), active: 1 });
    } catch (err) {
          if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
                  return res.status(409).json({ error: 'A customer with that name already exists' });
          }
          throw err;
    }
});

// PATCH /api/customers/:id — toggle active/inactive  { active }
router.patch('/:id', (req, res) => {
    const { active } = req.body;
    if (typeof active !== 'boolean') {
          return res.status(400).json({ error: 'active must be true or false' });
    }
    const info = db.prepare('UPDATE customers SET active = ? WHERE id = ?').run(active ? 1 : 0, req.params.id);
    if (info.changes === 0) return res.status(404).json({ error: 'Customer not found' });
    res.json({ id: Number(req.params.id), active });
});

module.exports = router;
