const express = require('express');
const db = require('../db');
const { buildIIF, buildIIFExperimental } = require('../iif');
const { buildTP } = require('../tp');

const router = express.Router();

// GET /api/orders — list all orders, newest first, with line items nested
router.get('/', (req, res) => {
  const orders = db
    .prepare(
      `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt, o.notes,
              o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status,
              c.id as customerId, c.name as customer
       FROM orders o
       JOIN customers c ON c.id = o.customer_id
       ORDER BY o.id DESC`
    )
    .all();

  const lineStmt = db.prepare(
    `SELECT ol.item_id as id, i.name, i.brand, COALESCE(ol.price, i.price) as price, COALESCE(ol.pack, i.pack) as pack, ol.unit, i.upc, ol.qty
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

// GET /api/orders/:id/iif — download a QuickBooks Desktop IIF invoice file
// for a single order. GET /api/orders/iif?ids=1,2,3 exports several at once.
function fetchOrdersForIIF(ids) {
  const lineStmt = db.prepare(
    `SELECT ol.item_id as id, i.name, i.brand, COALESCE(ol.price, i.price) as price, COALESCE(ol.pack, i.pack) as pack, ol.unit, i.upc, ol.qty
     FROM order_lines ol JOIN items i ON i.id = ol.item_id
     WHERE ol.order_id = ?`
  );
  const orderStmt = db.prepare(
    `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt, o.notes,
              o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status,
            c.name as customer, c.abbreviation as abbreviation, c.short_name as shortName,
            c.shipto_line1 as shipToLine1, c.shipto_line2 as shipToLine2, c.shipto_city as shipToCity,
            c.shipto_state as shipToState, c.shipto_zip as shipToZip, c.shipto_phone as shipToPhone
     FROM orders o JOIN customers c ON c.id = o.customer_id
     WHERE o.id = ?`
  );
  const out = [];
  for (const id of ids) {
    const order = orderStmt.get(id);
    if (order) out.push({ ...order, lines: lineStmt.all(id) });
  }
  return out;
}

// { brandName: abbreviation } for brands that have one set.
function brandAbbrevMap() {
  const rows = db.prepare('SELECT brand, abbreviation FROM brand_settings').all();
  const map = {};
  for (const r of rows) if (r.abbreviation) map[r.brand] = r.abbreviation;
  return map;
}

router.get('/iif', (req, res) => {
  const raw = String(req.query.ids || '').trim();
  const ids = raw ? raw.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'Provide ?ids=1,2,3' });
  const orders = fetchOrdersForIIF(ids);
  if (orders.length === 0) return res.status(404).json({ error: 'No matching orders found' });
  const iif = buildIIF(orders);
  const filename = orders.length === 1 ? `order-${orders[0].id}.iif` : `orders-${orders.length}.iif`;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(iif);
});

router.get('/:id/iif', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid order id' });
  const orders = fetchOrdersForIIF([id]);
  if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });
  const experimental = req.query.experimental === '1' || req.query.experimental === 'true';
  const iif = experimental ? buildIIFExperimental(orders) : buildIIF(orders);
  const suffix = experimental ? '-experimental' : '';
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="order-${id}${suffix}.iif"`);
  res.send(iif);
});

// GET /api/orders/:id/tp — download a Transaction Pro Importer CSV for one
// order. GET /api/orders/tp?ids=1,2,3 exports several at once.
router.get('/tp', (req, res) => {
  const raw = String(req.query.ids || '').trim();
  const ids = raw ? raw.split(',').map(s => parseInt(s.trim(), 10)).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'Provide ?ids=1,2,3' });
  const orders = fetchOrdersForIIF(ids);
  if (orders.length === 0) return res.status(404).json({ error: 'No matching orders found' });
  const csv = buildTP(orders, brandAbbrevMap(), db.getInvoiceOffset());
  const filename = orders.length === 1 ? `order-${orders[0].id}-TP.csv` : `orders-${orders.length}-TP.csv`;
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
  res.send(csv);
});

router.get('/:id/tp', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid order id' });
  const orders = fetchOrdersForIIF([id]);
  if (orders.length === 0) return res.status(404).json({ error: 'Order not found' });
  const csv = buildTP(orders, brandAbbrevMap(), db.getInvoiceOffset());
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', `attachment; filename="order-${id}-TP.csv"`);
  res.send(csv);
});

// PATCH /api/orders/:id/processed — mark an order processed (entered into
// QuickBooks) or un-processed. body: { processed: true|false }
router.patch('/:id/processed', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid order id' });
  const order = db.prepare('SELECT id FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const processed = req.body.processed ? 1 : 0;
  const processedAt = processed ? new Date().toISOString() : null;
  db.prepare('UPDATE orders SET processed = ?, processed_at = ? WHERE id = ?').run(processed, processedAt, id);

  const updated = db.prepare(
    `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt, o.notes,
            o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status,
            c.id as customerId, c.name as customer
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(id);
  res.json(updated);
});

// PATCH /api/orders/:id/submit — finalize a pending order. Checks stock for
// its lines, decrements it, and flips status to 'submitted'. No-op (409) if
// the order isn't pending.
router.patch('/:id/submit', (req, res) => {
  const id = parseInt(req.params.id, 10);
  if (!id) return res.status(400).json({ error: 'Invalid order id' });
  const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  if (order.status !== 'pending') return res.status(409).json({ error: 'Order is not pending' });

  const lines = db.prepare(
    `SELECT ol.item_id, ol.qty, i.name, i.stock FROM order_lines ol
     JOIN items i ON i.id = ol.item_id WHERE ol.order_id = ?`
  ).all(id);
  // Stock may go negative (orders are placed before restock), so no cap here.
  const decrementStock = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ?');
  const submittedAt = new Date().toISOString();
  const run = db.transaction(() => {
    for (const l of lines) decrementStock.run(l.qty, l.item_id);
    db.prepare("UPDATE orders SET status = 'submitted', submitted_at = ? WHERE id = ?").run(submittedAt, id);
  });
  run();

  const updated = db.prepare(
    `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt, o.notes,
            o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status,
            c.id as customerId, c.name as customer
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(id);
  res.json(updated);
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

  const isPending = req.body.status === 'pending';

  // Validate every line. For a normal (submitted) order we also check stock;
  // a pending draft doesn't reserve stock, so we skip the stock check.
  const getItem = db.prepare('SELECT id, name, brand, stock, price, pack, case_size, case_price FROM items WHERE id = ?');
  // The store's default unit for an item (from its catalog), fallback 'box'.
  const custUnitStmt = db.prepare('SELECT unit, price FROM customer_catalog WHERE customer_id = ? AND item_id = ?');
  const resolvedLines = [];
  for (const line of lines) {
    const item = getItem.get(line.itemId);
    if (!item) return res.status(404).json({ error: `Item "${line.itemId}" not found` });
    const qty = Number(line.qty);
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: `Invalid quantity for "${item.name}"` });
    // Ordering unit: explicit on the line, else the store's catalog default, else box.
    const cat = custUnitStmt.get(customerId, item.id);
    let unit = (line.unit === 'case' || line.unit === 'box') ? line.unit : (cat && cat.unit ? cat.unit : 'box');
    if (unit === 'case' && !item.case_size) unit = 'box'; // item has no case unit
    // Effective pack (eaches per ordered unit) and per-each price for this unit.
    const pack = unit === 'case' ? (item.pack * item.case_size) : item.pack;
    // Price: the store's catalog price if this is their default unit; otherwise
    // the item's base price for the unit (case_price for case, price for box).
    let price;
    if (cat && cat.price != null && (cat.unit || 'box') === unit) price = cat.price;
    else price = unit === 'case' ? (item.case_price != null ? item.case_price : item.price) : item.price;
    // Stock is tracked in eaches at the box level; qty of this unit uses `pack` eaches.
    resolvedLines.push({ item, qty, unit, pack, price });
  }

  const insertOrder = db.prepare(
    'INSERT INTO orders (customer_id, delivery_date, submitted_at, notes, submitted_by, status) VALUES (?, ?, ?, ?, ?, ?)'
  );
  const insertLine = db.prepare('INSERT INTO order_lines (order_id, item_id, qty, price, unit, pack) VALUES (?, ?, ?, ?, ?, ?)');
  const decrementStock = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ?');

  const submittedAt = new Date().toISOString();
  const cleanNotes = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null;
  const cleanSubmittedBy = (typeof req.body.submittedBy === 'string' && req.body.submittedBy.trim()) ? req.body.submittedBy.trim() : null;
  const status = isPending ? 'pending' : 'submitted';

  const createOrder = db.transaction(() => {
    const orderInfo = insertOrder.run(customerId, deliveryDate, submittedAt, cleanNotes, cleanSubmittedBy, status);
    const orderId = orderInfo.lastInsertRowid;
    for (const { item, qty, unit, pack, price } of resolvedLines) {
      insertLine.run(orderId, item.id, qty, price, unit, pack);
      // Stock is counted in boxes; a case order consumes qty * case_size boxes.
      if (!isPending) {
        const boxes = qty * (unit === 'case' ? (item.case_size || 1) : 1);
        decrementStock.run(boxes, item.id);
      }
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
    submittedBy: cleanSubmittedBy,
    status,
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

  const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const isPending = order.status === 'pending';

  const customer = db.prepare('SELECT id, name FROM customers WHERE id = ?').get(customerId);
  if (!customer) return res.status(404).json({ error: 'Customer not found' });

  const oldLines = db.prepare('SELECT item_id, qty FROM order_lines WHERE order_id = ?').all(orderId);
  const oldQtyByItem = {};
  for (const l of oldLines) oldQtyByItem[l.item_id] = l.qty;

  const getItem = db.prepare('SELECT id, name, brand, stock, price, pack, case_size, case_price FROM items WHERE id = ?');
  const newQtyByItem = {};
  const resolvedLines = [];
  for (const line of lines) {
    const item = getItem.get(line.itemId);
    if (!item) return res.status(404).json({ error: `Item "${line.itemId}" not found` });
    const qty = Number(line.qty);
    // qty 0 is allowed (see POST) — an item on the order with no quantity, e.g.
    // to print its UPC for check-in. Reject negatives / non-numbers only.
    if (!Number.isFinite(qty) || qty < 0) return res.status(400).json({ error: `Invalid quantity for "${item.name}"` });
    newQtyByItem[line.itemId] = qty;
    resolvedLines.push({ item, qty });
  }

  // Only items whose quantity is INCREASING need a stock check — the
  // increase can't exceed what's currently available (current stock
  // already excludes what this order originally reserved). Pending orders
  // haven't reserved any stock, so no check applies to them.
  // Stock may go negative (orders placed before restock), so no cap on edits.

  const adjustStock = db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?');
  const deleteLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const insertLine = db.prepare('INSERT INTO order_lines (order_id, item_id, qty, price) VALUES (?, ?, ?, ?)');
  const updateOrder = db.prepare('UPDATE orders SET customer_id = ?, delivery_date = ?, notes = ? WHERE id = ?');
  const custPriceStmt = db.prepare('SELECT price FROM customer_catalog WHERE customer_id = ? AND item_id = ?');
  const priceFor = (item) => { const r = custPriceStmt.get(customerId, item.id); return (r && r.price != null) ? r.price : item.price; };

  const cleanNotes = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null;
  const run = db.transaction(() => {
    if (!isPending) {
      const touchedItems = new Set([...Object.keys(oldQtyByItem), ...Object.keys(newQtyByItem)]);
      for (const itemId of touchedItems) {
        const oldQty = oldQtyByItem[itemId] || 0;
        const newQty = newQtyByItem[itemId] || 0;
        const delta = oldQty - newQty; // positive = return stock, negative = consume more
        if (delta !== 0) adjustStock.run(delta, itemId);
      }
    }
    deleteLines.run(orderId);
    for (const { item, qty } of resolvedLines) insertLine.run(orderId, item.id, qty, priceFor(item));
    updateOrder.run(customerId, deliveryDate, cleanNotes, orderId);
  });
  run();

  const updated = db.prepare(
    `SELECT o.id, o.delivery_date as deliveryDate, o.submitted_at as submittedAt, o.notes,
              o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status,
            c.id as customerId, c.name as customer
     FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(orderId);
  const newLines = db.prepare(
    `SELECT ol.item_id as id, i.name, i.brand, COALESCE(ol.price, i.price) as price, COALESCE(ol.pack, i.pack) as pack, ol.unit, i.upc, ol.qty
     FROM order_lines ol JOIN items i ON i.id = ol.item_id WHERE ol.order_id = ?`
  ).all(orderId);

  res.json({ ...updated, lines: newLines });
});

// DELETE /api/orders/:id — cancel an order and return its reserved stock
router.delete('/:id', (req, res) => {
  const orderId = req.params.id;
  const order = db.prepare('SELECT id, status FROM orders WHERE id = ?').get(orderId);
  if (!order) return res.status(404).json({ error: 'Order not found' });

  const lines = db.prepare('SELECT item_id, qty FROM order_lines WHERE order_id = ?').all(orderId);
  const adjustStock = db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?');
  const deleteLines = db.prepare('DELETE FROM order_lines WHERE order_id = ?');
  const deleteOrder = db.prepare('DELETE FROM orders WHERE id = ?');

  const run = db.transaction(() => {
    // Only submitted orders reserved stock, so only they return it on delete.
    if (order.status !== 'pending') {
      for (const l of lines) adjustStock.run(l.qty, l.item_id);
    }
    deleteLines.run(orderId);
    deleteOrder.run(orderId);
  });
  run();

  res.json({ id: Number(orderId), deleted: true });
});

// GET /api/orders/invoice-offset — the current offset (invoice # = id + offset).
router.get('/invoice-offset', (req, res) => {
  res.json({ offset: db.getInvoiceOffset() });
});
// POST /api/orders/invoice-start — set numbering so the next order = {next}.
router.post('/invoice-start', (req, res) => {
  const next = Number(req.body && req.body.next);
  if (!Number.isFinite(next) || next < 1) return res.status(400).json({ error: 'Provide next (a positive number)' });
  res.json({ ok: true, ...db.setInvoiceStart(next) });
});

// GET /api/orders/ordered-report?from=YYYY-MM-DD&to=YYYY-MM-DD
// Sum of quantities/eaches per item across orders SUBMITTED in the date range
// (inclusive). Handy for "what went out on these days".
router.get('/ordered-report', (req, res) => {
  const from = String(req.query.from || '').slice(0, 10);
  const to = String(req.query.to || from).slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Provide from (and optional to) as YYYY-MM-DD' });
  }
  // submitted_at is an ISO timestamp; compare its date part.
  const rows = db.prepare(
    `SELECT i.id AS itemId, i.name, i.brand,
            SUM(ol.qty) AS qty,
            SUM(ol.qty * COALESCE(ol.pack, i.pack, 1)) AS eaches,
            COUNT(DISTINCT o.id) AS orders
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
       JOIN items i ON i.id = ol.item_id
      WHERE substr(o.submitted_at, 1, 10) BETWEEN ? AND ?
        AND o.status = 'submitted'
      GROUP BY i.id
      HAVING SUM(ol.qty) > 0
      ORDER BY i.brand, i.name`
  ).all(from, to);
  const orderCount = db.prepare(
    `SELECT COUNT(*) n FROM orders WHERE substr(submitted_at,1,10) BETWEEN ? AND ? AND status='submitted'`
  ).get(from, to).n;
  res.json({ from, to, orders: orderCount, itemCount: rows.length, items: rows });
});

// POST /api/orders/subtract-ordered { from, to, apply }
// Subtract the quantities ORDERED (submitted) in the date range from item stock.
// Stock is counted in boxes; a case line subtracts qty * case_size boxes.
// apply=false (default) is a dry run that only reports what would change.
router.post('/subtract-ordered', (req, res) => {
  const from = String((req.body && req.body.from) || '').slice(0, 10);
  const to = String((req.body && req.body.to) || from).slice(0, 10);
  const apply = !!(req.body && req.body.apply);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(from) || !/^\d{4}-\d{2}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Provide from (and optional to) as YYYY-MM-DD' });
  }
  // boxes ordered per item in range (case lines count as qty * case_size boxes)
  const rows = db.prepare(
    `SELECT i.id AS itemId, i.name, i.brand, i.stock AS currentStock,
            SUM(ol.qty * CASE WHEN ol.unit = 'case' THEN COALESCE(i.case_size,1) ELSE 1 END) AS boxesOrdered
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
       JOIN items i ON i.id = ol.item_id
      WHERE substr(o.submitted_at,1,10) BETWEEN ? AND ?
        AND o.status = 'submitted'
      GROUP BY i.id
      HAVING SUM(ol.qty) > 0
      ORDER BY i.brand, i.name`
  ).all(from, to);

  const changes = rows.map(r => ({
    itemId: r.itemId, name: r.name, brand: r.brand,
    from: r.currentStock, subtract: r.boxesOrdered,
    to: r.currentStock - r.boxesOrdered,
    goesNegative: (r.currentStock - r.boxesOrdered) < 0,
  }));

  if (apply) {
    const upd = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ?');
    const tx = db.transaction(() => { for (const c of changes) upd.run(c.subtract, c.itemId); });
    tx();
  }
  res.json({
    from, to, applied: apply, itemCount: changes.length,
    wouldGoNegative: changes.filter(c => c.goesNegative).length,
    changes,
  });
});

// GET /api/orders/sales-by-month?from=YYYY-MM&to=YYYY-MM
// Per-item sales broken out by month (by DELIVERY date) across the range.
// Returns months + rows: { itemId, name, brand, byMonth: {YYYY-MM: {qty, eaches, dollars}}, total }.
router.get('/sales-by-month', (req, res) => {
  const from = String(req.query.from || '').slice(0, 7); // YYYY-MM
  const to = String(req.query.to || from).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Provide from (and optional to) as YYYY-MM' });
  }
  // list of month keys in range
  const months = [];
  { let [y, m] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
    while (y < ty || (y === ty && m <= tm)) { months.push(`${y}-${String(m).padStart(2, '0')}`); m++; if (m > 12) { m = 1; y++; } if (months.length > 240) break; } }

  const rows = db.prepare(
    `SELECT i.id AS itemId, i.name, i.brand,
            substr(o.delivery_date, 1, 7) AS ym,
            SUM(ol.qty) AS qty,
            SUM(ol.qty * COALESCE(ol.pack, i.pack, 1)) AS eaches,
            SUM(ol.qty * COALESCE(ol.pack, i.pack, 1) * COALESCE(ol.price, i.price, 0)) AS dollars
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
       JOIN items i ON i.id = ol.item_id
      WHERE o.status = 'submitted'
        AND substr(o.delivery_date, 1, 7) BETWEEN ? AND ?
      GROUP BY i.id, ym
      HAVING SUM(ol.qty) > 0`
  ).all(from, to);

  const byItem = new Map();
  for (const r of rows) {
    if (!byItem.has(r.itemId)) byItem.set(r.itemId, { itemId: r.itemId, name: r.name, brand: r.brand, byMonth: {}, totalQty: 0, totalEaches: 0, totalDollars: 0 });
    const it = byItem.get(r.itemId);
    it.byMonth[r.ym] = { qty: r.qty, eaches: r.eaches, dollars: Math.round(r.dollars * 100) / 100 };
    it.totalQty += r.qty; it.totalEaches += r.eaches; it.totalDollars += r.dollars;
  }
  const items = [...byItem.values()].map(it => ({ ...it, totalDollars: Math.round(it.totalDollars * 100) / 100 }))
    .sort((a, b) => (a.brand || '').localeCompare(b.brand || '') || a.name.localeCompare(b.name));

  res.json({ from, to, months, itemCount: items.length, items });
});

// GET /api/orders/margin-report?from=YYYY-MM&to=YYYY-MM
// Per customer + item: units, sell $, cost $ (landed), margin $ and % over a
// delivery-date range. Cost = item.cost (landed w/Taiyo) per each.
router.get('/margin-report', (req, res) => {
  const from = String(req.query.from || '').slice(0, 7);
  const to = String(req.query.to || from).slice(0, 7);
  if (!/^\d{4}-\d{2}$/.test(from) || !/^\d{4}-\d{2}$/.test(to)) {
    return res.status(400).json({ error: 'Provide from (and optional to) as YYYY-MM' });
  }
  const rows = db.prepare(
    `SELECT c.name AS customer, i.id AS itemId, i.name AS item, i.brand,
            SUM(ol.qty) AS qty,
            SUM(ol.qty * COALESCE(ol.pack, i.pack, 1)) AS eaches,
            SUM(ol.qty * COALESCE(ol.pack, i.pack, 1) * COALESCE(ol.price, i.price, 0)) AS sell,
            SUM(ol.qty * COALESCE(ol.pack, i.pack, 1) * i.cost) AS cost,
            i.cost AS unitCost
       FROM orders o
       JOIN order_lines ol ON ol.order_id = o.id
       JOIN items i ON i.id = ol.item_id
       JOIN customers c ON c.id = o.customer_id
      WHERE o.status = 'submitted'
        AND substr(o.delivery_date, 1, 7) BETWEEN ? AND ?
      GROUP BY c.id, i.id
      HAVING SUM(ol.qty) > 0
      ORDER BY c.name, i.brand, i.name`
  ).all(from, to);

  const items = rows.map(r => {
    const sell = Math.round((r.sell || 0) * 100) / 100;
    const cost = r.cost == null ? null : Math.round(r.cost * 100) / 100;
    const marginD = cost == null ? null : Math.round((sell - cost) * 100) / 100;
    const marginPct = (cost == null || sell === 0) ? null : Math.round((marginD / sell) * 1000) / 10;
    return { customer: r.customer, itemId: r.itemId, item: r.item, brand: r.brand, eaches: r.eaches, sell, cost, unitCost: r.unitCost, marginD, marginPct, noCost: r.unitCost == null };
  });
  const withCost = items.filter(x => x.cost != null);
  const totalSell = Math.round(items.reduce((s, x) => s + x.sell, 0) * 100) / 100;
  const totalCost = Math.round(withCost.reduce((s, x) => s + x.cost, 0) * 100) / 100;
  const totalMargin = Math.round((withCost.reduce((s, x) => s + x.sell, 0) - totalCost) * 100) / 100;
  const totalMarginPct = withCost.length ? Math.round((totalMargin / withCost.reduce((s, x) => s + x.sell, 0)) * 1000) / 10 : null;

  res.json({ from, to, rows: items.length, missingCost: items.filter(x => x.noCost).length,
    totals: { sell: totalSell, cost: totalCost, marginD: totalMargin, marginPct: totalMarginPct }, items });
});

// GET /api/orders/:id/margin — per-item margin + total profit for one order.
router.get('/:id/margin', (req, res) => {
  const order = db.prepare(
    `SELECT o.id, o.delivery_date AS deliveryDate, o.submitted_at AS submittedAt, o.status,
            c.name AS customer
       FROM orders o JOIN customers c ON c.id = o.customer_id WHERE o.id = ?`
  ).get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Order not found' });
  const lines = db.prepare(
    `SELECT ol.item_id AS itemId, i.name AS item, i.brand,
            ol.qty, COALESCE(ol.pack, i.pack, 1) AS pack, ol.unit,
            COALESCE(ol.price, i.price, 0) AS priceEa, i.cost AS costEa
       FROM order_lines ol JOIN items i ON i.id = ol.item_id
      WHERE ol.order_id = ?`
  ).all(req.params.id);

  let totSell = 0, totCost = 0, missingCost = 0;
  const items = lines.filter(l => l.qty > 0).map(l => {
    const eaches = l.qty * l.pack;
    const sell = Math.round(eaches * l.priceEa * 100) / 100;
    const cost = l.costEa == null ? null : Math.round(eaches * l.costEa * 100) / 100;
    const marginD = cost == null ? null : Math.round((sell - cost) * 100) / 100;
    const marginPct = (cost == null || sell === 0) ? null : Math.round((marginD / sell) * 1000) / 10;
    totSell += sell; if (cost != null) totCost += cost; if (l.costEa == null) missingCost++;
    return { itemId: l.itemId, item: l.item, brand: l.brand, qty: l.qty, unit: l.unit || 'box', eaches, priceEa: l.priceEa, costEa: l.costEa, sell, cost, marginD, marginPct };
  });
  totSell = Math.round(totSell * 100) / 100; totCost = Math.round(totCost * 100) / 100;
  const profit = Math.round((totSell - totCost) * 100) / 100;
  const marginPct = totSell ? Math.round((profit / totSell) * 1000) / 10 : null;
  res.json({ order, missingCost, totals: { sell: totSell, cost: totCost, profit, marginPct }, items });
});

module.exports = router;
