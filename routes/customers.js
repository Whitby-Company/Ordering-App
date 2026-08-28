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
    ? 'SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName, shipto_line1 as shipToLine1, shipto_line2 as shipToLine2, shipto_city as shipToCity, shipto_state as shipToState, shipto_zip as shipToZip FROM customers ORDER BY name ASC'
    : 'SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName, shipto_line1 as shipToLine1, shipto_line2 as shipToLine2, shipto_city as shipToCity, shipto_state as shipToState, shipto_zip as shipToZip FROM customers WHERE active = 1 ORDER BY name ASC';
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
  const { active, name, deliveryDay, abbreviation, shortName } = req.body;
  const SHIPTO_FIELDS = { shipToLine1: 'shipto_line1', shipToLine2: 'shipto_line2', shipToCity: 'shipto_city', shipToState: 'shipto_state', shipToZip: 'shipto_zip' };
  const hasActive = typeof active === 'boolean';
  const hasName = typeof name === 'string';
  // deliveryDay: integer 0-6 to set a usual day, or null to clear it.
  const hasDay = deliveryDay === null || (typeof deliveryDay === 'number' && Number.isInteger(deliveryDay) && deliveryDay >= 0 && deliveryDay <= 6);
  const dayProvided = 'deliveryDay' in req.body;
  const abbrProvided = 'abbreviation' in req.body;
  const shortProvided = 'shortName' in req.body;
  const shipToProvided = Object.keys(SHIPTO_FIELDS).some(k => k in req.body);
  if (!hasActive && !hasName && !dayProvided && !abbrProvided && !shortProvided && !shipToProvided) {
    return res.status(400).json({ error: 'Provide active, name, deliveryDay, abbreviation, shortName, and/or ship-to fields' });
  }
  if (dayProvided && !hasDay) {
    return res.status(400).json({ error: 'deliveryDay must be an integer 0-6 (Sun-Sat) or null' });
  }
  if (hasName && !name.trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }

  const existing = db.prepare('SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });

  // Normalize text: trim, and store empty as NULL.
  const normText = v => { const t = (v === null || v === undefined) ? '' : String(v).trim(); return t === '' ? null : t; };

  const updates = [];
  const params = [];
  if (hasActive) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (hasName) { updates.push('name = ?'); params.push(name.trim()); }
  if (dayProvided) { updates.push('delivery_day = ?'); params.push(deliveryDay === null ? null : deliveryDay); }
  if (abbrProvided) { updates.push('abbreviation = ?'); params.push(normText(abbreviation)); }
  if (shortProvided) { updates.push('short_name = ?'); params.push(normText(shortName)); }
  for (const [apiKey, col] of Object.entries(SHIPTO_FIELDS)) {
    if (apiKey in req.body) { updates.push(`${col} = ?`); params.push(normText(req.body[apiKey])); }
  }
  params.push(req.params.id);

  try {
    db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A customer with that name already exists' });
    }
    throw err;
  }

  const fresh = db.prepare('SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName, shipto_line1 as shipToLine1, shipto_line2 as shipToLine2, shipto_city as shipToCity, shipto_state as shipToState, shipto_zip as shipToZip FROM customers WHERE id = ?').get(req.params.id);
  res.json({ ...fresh, active: !!fresh.active });
});

module.exports = router;
