const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/orders — list all orders, newest first, with line items nested
router.get('/', (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt, o.notes,
              c.id as customerId, c.name as customer
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ORDER BY o.id DESC`
    )
    .all();

  const lineStmt = db.prepare(
    `SELECT ol.item_id as id, i.name, i.brand, i.price, i.pack, ol.qty
     FROM order_lines ol
     JOIN items i ON i.id = ol.item_id
     WHERE ol.order_id = ?`
  );

  const withLines = orders.map(o => ({
    ...o,
    lines: lineStmt.all(o.id),
  }));

  res.json(withLines);
});

// POST /api/orders — create an order and decrement stock atomically
// body: { customerId, deliveryDate, lines: [{ itemId, qty }, ...] }
router.post('/', (req, res) => {
  const { customerId, deliveryDate, lines, notes } = req.body;

  if (!customerId || !deliveryDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'customerId, deliveryDate, and at least one line are required' });
  }

  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  // Validate every line and check stock BEFORE writing anything.
  const getItem = db.prepare('SELECT id, name, brand, stock, price, pack FROM items WHERE id = ?');
  const resolvedLines = [];
  for (const line of lines) {
    const item = getItem.get(line.itemId);
    if (!item) return res.status(404).json({ error: `Item "${line.itemId}" not found` });
    const qty = Number(line.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: `Invalid quantity for "${item.name}"` });
    if (qty > item.stock) {
      return res.status(409).json({
        error: `Not enough stock for "${item.name}" — ${item.stock} available, ${qty} requested`,
      });
    }
    resolvedLines.push({ item, qty });
  }

  const insertOrder = db.prepare(
    'INSERT INTO orders (customer_id, delivery_date, submitted_at, notes) VALUES (?, ?, ?, ?)'
  );
  const insertLine = db.prepare('INSERT INTO order_lines (order_id, item_id, qty) VALUES (?, ?, ?)');
  const decrementStock = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ?');

  const submittedAt = new Date().toISOString();
  const cleanNotes = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null;

  const createOrder = db.transaction(() => {
    const orderInfo = insertOrder.run(customerId, deliveryDate, submittedAt, cleanNotes);
    const orderId = orderInfo.lastInsertRowid;
    for (const { item, qty } of resolvedLines) {
      insertLine.run(orderId, item.id, qty);
      decrementStock.run(qty, item.id);
    }
    return orderId;
  });

  const orderId = createOrder();

  res.status(201).json({
    id: orderId,
    customer: customer.name,
    customerId,
    deliveryDate,
    submittedAt,
    notes: cleanNotes,
    lines: resolvedLines.map(({ item, qty }) => ({ id: item.id, name: item.name, brand: item.brand, price: item.price, pack: item.pack, qty })),
  });
});

// PATCH /api/orders/:id — edit an existing order's customer, delivery date,
// and/or line items. Reconciles stock by the NET difference per item (an
// item whose qty increases consumes more stock; a decrease or removal
// returns stock), all in one transaction.
// body: { customerId, deliveryDate, lines: [{ itemId, qty }, ...] }
router.patch('/:id', (req, res) => {
  const orderId = req.params.id;
  const { customerId, deliveryDate, lines, notes } = req.body;

  if (!customerId || !deliveryDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'customerId, deliveryDate, and at least one line are required' });
  }

  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const oldLines = db.prepare('SELECT item_id, qty FROM order_lines WHERE order_id = ?').all(orderId);
  const oldQtyByItem = {};
  for (const l of oldLines) oldQtyByItem[l.item_id] = l.qty;

  const getItem = db.prepare('SELECT id, name, brand, stock, price, pack FROM items WHERE id = ?');
  const newQtyByItem = {};
  const resolvedLines = [];
  for (const line of lines) {
    const item = getItem.get(line.itemId);
    if (!item) return res.status(404).json({ error: `Item "${line.itemId}" not found` });
    const qty = Number(line.qty);
    if (!qty || qty <= 0) return res.status(400).json({ error: `Invalid quantity for "${item.name}"` });
    newQtyByItem[line.itemId] = qty;
    resolvedLines.push({ item, qty });
  }

  // Only items whose quantity is INCREASING need a stock check — the
  // increase can't exceed what's currently available (current stock
  // already excludes what this order originally reserved).
  for (const { item, qty } of resolvedLines) {
    const oldQty = oldQtyByItem[item.id] || 0;
    const increase = qty - oldQty;
    if (increase > 0 && increase > item.stock) {
      return res.status(409).json({
        error: `Not enough stock for "${item.name}" — ${item.stock} available, ${increase} more needed`,
      });
    }
  }

  const adjustStock = db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?');
  const deleteLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const insertLine = db.prepare('INSERT INTO order_lines (order_id, item_id, qty) VALUES (?, ?, ?)');
  const updateOrder = db.prepare('UPDATE orders SET customer_id = ?, delivery_date = ?, notes = ? WHERE id = ?');

  const cleanNotes = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null;
  const run = db.transaction(() => {
    const touchedItems = new Set([...Object.keys(oldQtyByItem), ...Object.keys(newQtyByItem)]);
    for (const itemId of touchedItems) {
      const oldQty = oldQtyByItem[itemId] || 0;
      const newQty = newQtyByItem[itemId] || 0;
      const delta = oldQty - newQty; // positive = return stock, negative = consume more
      if (delta !== 0) adjustStock.run(delta, itemId);
    }
    deleteLines.run(orderId);
    for (const { item, qty } of resolvedLines) insertLine.run(orderId, item.id, qty);
    updateOrder.run(customerId, deliveryDate, cleanNotes, orderId);
  });
  run();

  const updated = db.prepare(
    `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt, o.notes,
            c.id as customerId, c.name as customer
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(orderId);
  const newLines = db.prepare(
    `SELECT ol.item_id as id, i.name, i.brand, i.price, i.pack, ol.qty
     FROM order_lines ol JOIN items i ON i.id = ol.item_id WHERE ol.order_id = ?`
  ).all(orderId);

  res.json({ ...updated, lines: newLines });
});

// DELETE /api/orders/:id — cancel an order and return its reserved stock
router.delete('/:id', (req, res) => {
  const orderId = req.params.id;
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const lines = db.prepare('SELECT item_id, qty FROM order_lines WHERE order_id = ?').all(orderId);
  const adjustStock = db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?');
  const deleteLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const deleteOrder = db.prepare('DELETE FROM orders WHERE id = ?');

  const run = db.transaction(() => {
    for (const l of lines) adjustStock.run(l.qty, l.item_id);
    deleteLines.run(orderId);
    deleteOrder.run(orderId);
  });
  run();

  res.json({ id: Number(orderId), deleted: true });
});

module.exports = router;
