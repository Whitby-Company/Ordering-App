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

// PATCH /api/customers/:id — update a customer. Accepts { active } to toggle
// active/inactive and/or { name } to rename. At least one must be provided.
router.patch('/:id', (req, res) => {
  const { active, name } = req.body;
  const hasActive = typeof active === 'boolean';
  const hasName = typeof name === 'string';
  if (!hasActive && !hasName) {
    return res.status(400).json({ error: 'Provide active (boolean) and/or name (string)' });
  }
  if (hasName && !name.trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }

  const existing = db.prepare('SELECT id, name, active FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });

  const updates = [];
  const params = [];
  if (hasActive) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (hasName) { updates.push('name = ?'); params.push(name.trim()); }
  params.push(req.params.id);

  try {
    db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A customer with that name already exists' });
    }
    throw err;
  }

  res.json({
    id: Number(req.params.id),
    name: hasName ? name.trim() : existing.name,
    active: hasActive ? active : !!existing.active,
  });
});

module.exports = router;
