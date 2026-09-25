const express = require('express');
const db = require('../db');

const router = express.Router();

// Tracking-only for now: a promo never touches how an order is priced. It's
// just an organized record of what deals exist, which item(s) and
// customer(s) they cover, and when -- so staff have one searchable place to
// see them instead of scattered notes. If pricing integration is added
// later, this is the same data an order-time check would read from; nothing
// here needs to change shape for that.

function loadPromoExtras(promoIds) {
  if (!promoIds.length) return { itemsByPromo: {}, customersByPromo: {} };
  const placeholders = promoIds.map(() => '?').join(',');
  const itemRows = db.prepare(
    `SELECT pi.promo_id AS promoId, i.id AS itemId, i.name AS itemName, i.brand AS brand, i.price AS price
       FROM promo_items pi JOIN items i ON i.id = pi.item_id
      WHERE pi.promo_id IN (${placeholders})`
  ).all(...promoIds);
  const custRows = db.prepare(
    `SELECT pc.promo_id AS promoId, c.id AS customerId, c.name AS customerName
       FROM promo_customers pc JOIN customers c ON c.id = pc.customer_id
      WHERE pc.promo_id IN (${placeholders})`
  ).all(...promoIds);
  const itemsByPromo = {}, customersByPromo = {};
  for (const r of itemRows) (itemsByPromo[r.promoId] || (itemsByPromo[r.promoId] = [])).push({ id: r.itemId, name: r.itemName, brand: r.brand, price: r.price });
  for (const r of custRows) (customersByPromo[r.promoId] || (customersByPromo[r.promoId] = [])).push({ id: r.customerId, name: r.customerName });
  return { itemsByPromo, customersByPromo };
}

// GET /api/promos — list, newest first. Optional filters:
//   ?itemId=      only promos covering this item
//   ?customerId=  only promos covering this customer (or flagged all-customers)
//   ?status=      active | upcoming | expired (by today's HST date vs start/end)
//   ?q=           search by name
router.get('/', (req, res) => {
  const { itemId, customerId, status, q } = req.query;
  const clauses = [];
  const params = [];
  if (itemId) {
    clauses.push('p.id IN (SELECT promo_id FROM promo_items WHERE item_id = ?)');
    params.push(itemId);
  }
  if (customerId) {
    clauses.push('(p.applies_to_all_customers = 1 OR p.id IN (SELECT promo_id FROM promo_customers WHERE customer_id = ?))');
    params.push(Number(customerId));
  }
  if (status === 'active') {
    const today = db.todayHST();
    clauses.push('p.start_date <= ? AND p.end_date >= ?');
    params.push(today, today);
  } else if (status === 'upcoming') {
    clauses.push('p.start_date > ?');
    params.push(db.todayHST());
  } else if (status === 'expired') {
    clauses.push('p.end_date < ?');
    params.push(db.todayHST());
  }
  if (q && q.trim()) {
    clauses.push('p.name LIKE ?');
    params.push(`%${q.trim()}%`);
  }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const promos = db.prepare(
    `SELECT id, name, amount_type AS amountType, amount, start_date AS startDate, end_date AS endDate,
            applies_to_all_customers AS appliesToAllCustomers, notes, created_by AS createdBy, created_at AS createdAt
       FROM promos p ${where} ORDER BY created_at DESC`
  ).all(...params);
  const { itemsByPromo, customersByPromo } = loadPromoExtras(promos.map(p => p.id));
  const result = promos.map(p => ({
    ...p,
    appliesToAllCustomers: !!p.appliesToAllCustomers,
    items: itemsByPromo[p.id] || [],
    customers: p.appliesToAllCustomers ? [] : (customersByPromo[p.id] || []),
  }));
  res.json(result);
});

// POST /api/promos — create. Body: { name, itemIds: [...], appliesToAllCustomers,
// customerIds: [...] (ignored if appliesToAllCustomers), amountType, amount,
// startDate, endDate, notes, createdBy }
router.post('/', (req, res) => {
  const { name, itemIds, appliesToAllCustomers, customerIds, amountType, amount, startDate, endDate, notes, createdBy } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A promo needs a name.' });
  if (!Array.isArray(itemIds) || itemIds.length === 0) return res.status(400).json({ error: 'Pick at least one item.' });
  if (!['flat_per_box', 'flat_per_each', 'percent'].includes(amountType)) return res.status(400).json({ error: 'amountType must be flat_per_box, flat_per_each, or percent.' });
  if (amount == null || isNaN(Number(amount))) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) return res.status(400).json({ error: 'Start and end date are required.' });
  if (endDate < startDate) return res.status(400).json({ error: 'End date is before the start date.' });
  const allCust = !!appliesToAllCustomers;
  if (!allCust && (!Array.isArray(customerIds) || customerIds.length === 0)) {
    return res.status(400).json({ error: 'Pick at least one customer, or mark this promo for all customers.' });
  }

  const insertPromo = db.prepare(
    `INSERT INTO promos (name, amount_type, amount, start_date, end_date, applies_to_all_customers, notes, created_by, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  );
  const insertItem = db.prepare('INSERT OR IGNORE INTO promo_items (promo_id, item_id) VALUES (?, ?)');
  const insertCust = db.prepare('INSERT OR IGNORE INTO promo_customers (promo_id, customer_id) VALUES (?, ?)');

  const promoId = db.transaction(() => {
    const info = insertPromo.run(
      String(name).trim(), amountType, Number(amount), startDate, endDate,
      allCust ? 1 : 0, notes ? String(notes) : null, createdBy || null, new Date().toISOString()
    );
    const id = info.lastInsertRowid;
    for (const itemId of itemIds) insertItem.run(id, itemId);
    if (!allCust) for (const custId of customerIds) insertCust.run(id, Number(custId));
    return id;
  })();

  res.status(201).json({ id: promoId });
});

// PATCH /api/promos/:id — same body shape as POST; replaces the item/customer lists.
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM promos WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Promo not found.' });

  const { name, itemIds, appliesToAllCustomers, customerIds, amountType, amount, startDate, endDate, notes } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'A promo needs a name.' });
  if (!Array.isArray(itemIds) || itemIds.length === 0) return res.status(400).json({ error: 'Pick at least one item.' });
  if (!['flat_per_box', 'flat_per_each', 'percent'].includes(amountType)) return res.status(400).json({ error: 'amountType must be flat_per_box, flat_per_each, or percent.' });
  if (amount == null || isNaN(Number(amount))) return res.status(400).json({ error: 'Enter a valid amount.' });
  if (!/^\d{4}-\d{2}-\d{2}$/.test(startDate || '') || !/^\d{4}-\d{2}-\d{2}$/.test(endDate || '')) return res.status(400).json({ error: 'Start and end date are required.' });
  if (endDate < startDate) return res.status(400).json({ error: 'End date is before the start date.' });
  const allCust = !!appliesToAllCustomers;
  if (!allCust && (!Array.isArray(customerIds) || customerIds.length === 0)) {
    return res.status(400).json({ error: 'Pick at least one customer, or mark this promo for all customers.' });
  }

  const updatePromo = db.prepare(
    `UPDATE promos SET name = ?, amount_type = ?, amount = ?, start_date = ?, end_date = ?,
            applies_to_all_customers = ?, notes = ? WHERE id = ?`
  );
  const deleteItems = db.prepare('DELETE FROM promo_items WHERE promo_id = ?');
  const deleteCusts = db.prepare('DELETE FROM promo_customers WHERE promo_id = ?');
  const insertItem = db.prepare('INSERT OR IGNORE INTO promo_items (promo_id, item_id) VALUES (?, ?)');
  const insertCust = db.prepare('INSERT OR IGNORE INTO promo_customers (promo_id, customer_id) VALUES (?, ?)');

  db.transaction(() => {
    updatePromo.run(String(name).trim(), amountType, Number(amount), startDate, endDate, allCust ? 1 : 0, notes ? String(notes) : null, id);
    deleteItems.run(id);
    for (const itemId of itemIds) insertItem.run(id, itemId);
    deleteCusts.run(id);
    if (!allCust) for (const custId of customerIds) insertCust.run(id, Number(custId));
  })();

  res.json({ ok: true });
});

// DELETE /api/promos/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM promos WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Promo not found.' });
  db.transaction(() => {
    db.prepare('DELETE FROM promo_items WHERE promo_id = ?').run(id);
    db.prepare('DELETE FROM promo_customers WHERE promo_id = ?').run(id);
    db.prepare('DELETE FROM promos WHERE id = ?').run(id);
  })();
  res.json({ ok: true });
});

module.exports = router;
