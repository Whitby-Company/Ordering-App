const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/orders — list all orders, newest first, with line items nested
router.get('/', (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt,
              c.id as customerId, c.name as customer
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ORDER BY o.id DESC`
    )
    .all();

  const lineStmt = db.prepare(
    `SELECT ol.item_id as id, i.name, i.brand, i.price, ol.qty
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
  const { customerId, deliveryDate, lines } = req.body;

  if (!customerId || !deliveryDate || !Array.isArray(lines) || lines.length === 0) {
    return res.status(400).json({ error: 'customerId, deliveryDate, and at least one line are required' });
  }

  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  // Validate every line and check stock BEFORE writing anything.
  const getItem = db.prepare('SELECT id, name, brand, stock, price FROM items WHERE id = ?');
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
    'INSERT INTO orders (customer_id, delivery_date, submitted_at) VALUES (?, ?, ?)'
  );
  const insertLine = db.prepare('INSERT INTO order_lines (order_id, item_id, qty) VALUES (?, ?, ?)');
  const decrementStock = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ?');

  const submittedAt = new Date().toISOString();

  const createOrder = db.transaction(() => {
    const orderInfo = insertOrder.run(customerId, deliveryDate, submittedAt);
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
    lines: resolvedLines.map(({ item, qty }) => ({ id: item.id, name: item.name, brand: item.brand, price: item.price, qty })),
  });
});

module.exports = router;
