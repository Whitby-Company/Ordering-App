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
              o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status, o.po_number as poNumber, o.invoice_number as invoiceNumber, o.exported, o.exported_at as exportedAt, o.ready_for_import as readyForImport,
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
              o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status, o.po_number as poNumber, o.invoice_number as invoiceNumber, o.exported, o.exported_at as exportedAt, o.ready_for_import as readyForImport,
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
// POST /api/orders/set-ready { ids: [], ready: bool } — shared ready-for-import flag.
router.post('/set-ready', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  const ready = (req.body && req.body.ready) ? 1 : 0;
  if (ids.length === 0) return res.status(400).json({ error: 'Provide ids: []' });
  const upd = db.prepare('UPDATE orders SET ready_for_import = ? WHERE id = ?');
  const tx = db.transaction(() => { for (const id of ids) upd.run(ready, id); });
  tx();
  res.json({ ok: true, updated: ids.length, ready: !!ready });
});
// POST /api/orders/mark-exported { ids: [] } — flag orders exported + clear ready.
router.post('/mark-exported', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'Provide ids: []' });
  const now = new Date().toISOString();
  const upd = db.prepare('UPDATE orders SET exported = 1, exported_at = ?, ready_for_import = 0 WHERE id = ?');
  const tx = db.transaction(() => { for (const id of ids) upd.run(now, id); });
  tx();
  res.json({ ok: true, marked: ids.length });
});
// POST /api/orders/unmark-exported { ids: [] } — clear the exported flag.
router.post('/unmark-exported', (req, res) => {
  const ids = Array.isArray(req.body && req.body.ids) ? req.body.ids.map(n => parseInt(n, 10)).filter(Boolean) : [];
  if (ids.length === 0) return res.status(400).json({ error: 'Provide ids: []' });
  const upd = db.prepare('UPDATE orders SET exported = 0, exported_at = NULL WHERE id = ?');
  const tx = db.transaction(() => { for (const id of ids) upd.run(id); });
  tx();
  res.json({ ok: true, unmarked: ids.length });
});

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
            o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status, o.po_number as poNumber, o.invoice_number as invoiceNumber, o.exported, o.exported_at as exportedAt, o.ready_for_import as readyForImport,
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
            o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status, o.po_number as poNumber, o.invoice_number as invoiceNumber, o.exported, o.exported_at as exportedAt, o.ready_for_import as readyForImport,
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
    // Price: the store's catalog price (a per-each price) if set for this item;
    // otherwise the item's base price for the unit (case_price for case, price for
    // box). The catalog price is per-each, so it applies to either unit.
    let price;
    if (cat && cat.price != null) price = cat.price;
    else price = unit === 'case' ? (item.case_price != null ? item.case_price : item.price) : item.price;
    // Stock is tracked in eaches at the box level; qty of this unit uses `pack` eaches.
    resolvedLines.push({ item, qty, unit, pack, price });
  }

  const insertOrder = db.prepare(
    'INSERT INTO orders (customer_id, delivery_date, submitted_at, notes, submitted_by, status, po_number, invoice_number) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
  );
  const insertLine = db.prepare('INSERT INTO order_lines (order_id, item_id, qty, price, unit, pack) VALUES (?, ?, ?, ?, ?, ?)');
  const decrementStock = db.prepare('UPDATE items SET stock = stock - ? WHERE id = ?');

  const submittedAt = new Date().toISOString();
  const cleanNotes = (typeof notes === 'string' && notes.trim()) ? notes.trim() : null;
  const cleanSubmittedBy = (typeof req.body.submittedBy === 'string' && req.body.submittedBy.trim()) ? req.body.submittedBy.trim() : null;
  const status = isPending ? 'pending' : 'submitted';

  const cleanPo = (typeof req.body.poNumber === 'string' && req.body.poNumber.trim()) ? req.body.poNumber.trim() : null;
  const invNum = Number(req.body.invoiceNumber);
  const cleanInv = Number.isFinite(invNum) && invNum > 0 ? Math.round(invNum) : null;
  const createOrder = db.transaction(() => {
    const orderInfo = insertOrder.run(customerId, deliveryDate, submittedAt, cleanNotes, cleanSubmittedBy, status, cleanPo, cleanInv);
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
    lines: resolvedLines.map(({ item, qty, price, unit, pack }) => ({ id: item.id, name: item.name, brand: item.brand, price, pack, unit, qty })),
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
              o.processed, o.processed_at as processedAt, o.submitted_by as submittedBy, o.status, o.po_number as poNumber, o.invoice_number as invoiceNumber, o.exported, o.exported_at as exportedAt, o.ready_for_import as readyForImport,
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

// GET /api/orders/invoice-audit — check invoice-number integrity for submitted
// orders: the sequence range, any gaps (missing numbers), and any duplicates.
// Invoice # = explicit invoice_number if set, else order id + offset.
router.get('/invoice-audit', (req, res) => {
  const offset = db.getInvoiceOffset();
  const orders = db.prepare(
    `SELECT o.id, o.invoice_number AS invoiceNumber, o.status, o.submitted_at AS submittedAt,
            c.name AS customer
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.status != 'pending'`
  ).all();
  // Map invoice number -> list of orders that have it.
  const byNum = new Map();
  for (const o of orders) {
    const num = (o.invoiceNumber != null && o.invoiceNumber !== '') ? Number(o.invoiceNumber) : (o.id + offset);
    if (!byNum.has(num)) byNum.set(num, []);
    byNum.get(num).push({ id: o.id, customer: o.customer, submittedAt: o.submittedAt });
  }
  const nums = [...byNum.keys()].filter(n => Number.isFinite(n)).sort((a, b) => a - b);
  const min = nums.length ? nums[0] : null;
  const max = nums.length ? nums[nums.length - 1] : null;
  // Gaps: numbers missing between min and max.
  const present = new Set(nums);
  const gaps = [];
  if (min != null && max != null && max - min < 100000) {
    for (let n = min; n <= max; n++) if (!present.has(n)) gaps.push(n);
  }
  // Duplicates: numbers assigned to more than one order.
  const duplicates = [];
  for (const [num, list] of byNum) if (list.length > 1) duplicates.push({ number: num, orders: list });
  duplicates.sort((a, b) => a.number - b.number);
  res.json({
    offset,
    count: orders.length,
    range: { min, max },
    nextNumber: max != null ? max + 1 : (offset + 1),
    gapCount: gaps.length,
    gaps: gaps.slice(0, 500),
    duplicateCount: duplicates.length,
    duplicates,
  });
});

// POST /api/orders/invoice-reconcile — compare the app's invoice numbers against
// a list of QuickBooks invoice numbers (from a QB export). Body: { qbNumbers: [..] }.
// Reports: in both, only in app, only in QB, and gaps in the combined sequence.
router.post('/invoice-reconcile', (req, res) => {
  const qbList = (req.body && req.body.qbNumbers) || [];
  const offset = db.getInvoiceOffset();
  const orders = db.prepare(
    `SELECT o.id, o.invoice_number AS invoiceNumber, c.name AS customer
       FROM orders o LEFT JOIN customers c ON c.id = o.customer_id
      WHERE o.status != 'pending'`
  ).all();
  // App order subtotal (lines × pack × price, NO tax) per order id. The
  // QuickBooks export totals do not include tax, so we compare tax-free subtotals.
  const lineSums = db.prepare(
    `SELECT ol.order_id AS orderId,
            SUM(ol.qty * COALESCE(ol.pack, i.pack, 1) * COALESCE(ol.price, i.price, 0)) AS subtotal
       FROM order_lines ol LEFT JOIN items i ON i.id = ol.item_id
      GROUP BY ol.order_id`
  ).all();
  const subtotalByOrder = new Map(lineSums.map(r => [r.orderId, r.subtotal || 0]));
  const appTotalById = new Map();
  const appNums = new Map(); // number -> { customer, appTotal }
  for (const o of orders) {
    const num = (o.invoiceNumber != null && o.invoiceNumber !== '') ? Number(o.invoiceNumber) : (o.id + offset);
    const sub = Math.round((subtotalByOrder.get(o.id) || 0) * 100) / 100; // subtotal, no tax
    if (Number.isFinite(num)) { appNums.set(num, o.customer); appTotalById.set(num, sub); }
  }
  const qbNums = new Map(); // number -> whatever meta was passed (customer/date/total)
  for (const q of qbList) {
    const num = Number(typeof q === 'object' ? q.number : q);
    if (Number.isFinite(num)) qbNums.set(num, typeof q === 'object' ? q : {});
  }

  const inBoth = [], onlyApp = [], onlyQb = [];
  let totalMismatchCount = 0;
  for (const [num, customer] of appNums) {
    if (qbNums.has(num)) {
      const meta = qbNums.get(num) || {};
      const appTotal = appTotalById.get(num);
      const qbTotal = meta.total != null ? Number(meta.total) : null;
      const diff = (appTotal != null && qbTotal != null) ? Math.round((appTotal - qbTotal) * 100) / 100 : null;
      const totalsMatch = diff != null ? Math.abs(diff) <= 0.02 : null; // within 2¢ = match
      if (totalsMatch === false) totalMismatchCount++;
      inBoth.push({ number: num, customer: meta.customer || customer, date: meta.date || '', qbTotal, appTotal, diff, totalsMatch });
    } else {
      onlyApp.push({ number: num, customer });
    }
  }
  for (const [num, meta] of qbNums) {
    if (!appNums.has(num)) onlyQb.push({ number: num, ...meta });
  }
  onlyApp.sort((a, b) => a.number - b.number);
  onlyQb.sort((a, b) => a.number - b.number);
  inBoth.sort((a, b) => a.number - b.number);

  // --- Suggested matches: differently-numbered invoices that look like the same
  // invoice (same customer + total), with item overlap as a confidence signal. ---
  // Pull item names for the app orders that didn't number-match.
  const normName = s => new Set(String(s || '').toLowerCase().split(/[^a-z0-9]+/).filter(w => w.length > 2));
  // Map app invoice number -> { orderId, itemWords:Set, total }
  const appByNum = new Map();
  for (const o of orders) {
    const num = (o.invoiceNumber != null && o.invoiceNumber !== '') ? Number(o.invoiceNumber) : (o.id + offset);
    appByNum.set(num, o.id);
  }
  const onlyAppNums = new Set(onlyApp.map(a => a.number));
  const itemNamesByOrder = new Map();
  if (onlyAppNums.size) {
    const rows2 = db.prepare(
      `SELECT ol.order_id AS orderId, i.name AS name FROM order_lines ol LEFT JOIN items i ON i.id = ol.item_id`
    ).all();
    for (const r of rows2) {
      if (!itemNamesByOrder.has(r.orderId)) itemNamesByOrder.set(r.orderId, []);
      if (r.name) itemNamesByOrder.get(r.orderId).push(r.name);
    }
  }
  // Build QB memo word-sets for only-QB invoices.
  const qbOnly = onlyQb.map(q => ({ ...q, memoWords: (q.memos || []).map(normName) }));
  const suggestions = [];
  for (const a of onlyApp) {
    const orderId = appByNum.get(a.number);
    const appTotal = appTotalById.get(a.number);
    if (appTotal == null) continue;
    const appItemWords = (itemNamesByOrder.get(orderId) || []).map(normName);
    // Candidate QB invoices: same customer (loose) + total within tax tolerance.
    for (const q of qbOnly) {
      if (q.qMatched) continue;
      const custMatch = a.customer && q.customer && (a.customer.toLowerCase().includes(q.customer.toLowerCase().slice(0, 6)) || q.customer.toLowerCase().includes(a.customer.toLowerCase().slice(0, 6)));
      const qbTotal = q.total != null ? Number(q.total) : null;
      if (qbTotal == null) continue;
      const totalClose = Math.abs(appTotal - qbTotal) <= 0.02;
      if (!totalClose) continue; // total must match; customer is a bonus, not required
      // Item overlap: fraction of app items whose words appear in some QB memo.
      let hit = 0;
      for (const aw of appItemWords) {
        for (const qw of q.memoWords) {
          let common = 0; for (const w of aw) if (qw.has(w)) common++;
          if (aw.size && common / aw.size >= 0.5) { hit++; break; }
        }
      }
      const itemScore = appItemWords.length ? hit / appItemWords.length : null;
      // Only suggest if there's SOME item overlap OR the customer matches — avoids
      // pairing unrelated invoices that merely share a dollar total.
      if (!custMatch && (itemScore == null || itemScore < 0.3)) continue;
      suggestions.push({
        appNumber: a.number, qbNumber: q.number, customer: a.customer,
        appTotal, qbTotal, appItems: appItemWords.length, itemsMatched: hit,
        itemScore: itemScore != null ? Math.round(itemScore * 100) : null,
        customerMatch: custMatch,
      });
    }
  }
  // Prefer the best suggestion per app invoice (highest item score).
  suggestions.sort((a, b) => (b.itemScore || 0) - (a.itemScore || 0));

  // --- Comprehensive content match: for EVERY app invoice, find its best QB
  // content match (customer + total, scored by item overlap), and note whether
  // the invoice numbers also agree. ---
  // Item names for ALL orders (not just unmatched ones).
  const allItemNames = new Map();
  {
    const rows3 = db.prepare(
      `SELECT ol.order_id AS orderId, i.name AS name FROM order_lines ol LEFT JOIN items i ON i.id = ol.item_id`
    ).all();
    for (const r of rows3) {
      if (!allItemNames.has(r.orderId)) allItemNames.set(r.orderId, []);
      if (r.name) allItemNames.get(r.orderId).push(r.name);
    }
  }
  // QB invoices with memo word-sets (all of them).
  const qbAll = [...qbNums.entries()].map(([num, meta]) => ({
    number: num, customer: meta.customer || '', date: meta.date || '',
    total: meta.total != null ? Number(meta.total) : null,
    memoWords: (meta.memos || []).map(normName),
  }));
  const contentMatches = [];
  for (const [num, orderId] of appByNum) {
    const appTotal = appTotalById.get(num);
    if (appTotal == null) continue;
    const appCustomer = appNums.get(num) || '';
    const appItemWords = (allItemNames.get(orderId) || []).map(normName);
    let best = null;
    for (const q of qbAll) {
      if (q.total == null) continue;
      const totalClose = Math.abs(appTotal - q.total) <= 0.02;
      if (!totalClose) continue;
      const custMatch = appCustomer && q.customer && (appCustomer.toLowerCase().includes(q.customer.toLowerCase().slice(0, 6)) || q.customer.toLowerCase().includes(appCustomer.toLowerCase().slice(0, 6)));
      // Item overlap score.
      let hit = 0;
      for (const aw of appItemWords) {
        for (const qw of q.memoWords) {
          let common = 0; for (const w of aw) if (qw.has(w)) common++;
          if (aw.size && common / aw.size >= 0.5) { hit++; break; }
        }
      }
      const itemScore = appItemWords.length ? hit / appItemWords.length : 0;
      // Rank: exact-number match wins; otherwise item overlap is the primary
      // signal (customer is only a small tiebreaker, so matches still work when
      // the customer name differs between the app and QuickBooks).
      const rank = (q.number === num ? 10000 : 0) + itemScore * 1000 + (custMatch ? 50 : 0);
      if (!best || rank > best.rank) best = { q, custMatch, hit, itemScore, rank };
    }
    contentMatches.push({
      appNumber: num,
      customer: appCustomer,
      appTotal,
      qbNumber: best ? best.q.number : null,
      qbCustomer: best ? best.q.customer : null,
      qbTotal: best ? best.q.total : null,
      numbersAgree: best ? best.q.number === num : null,
      customerMatch: best ? best.custMatch : null,
      appItems: appItemWords.length,
      itemsMatched: best ? best.hit : 0,
      itemScore: best ? Math.round(best.itemScore * 100) : null,
      hasMatch: !!best,
    });
  }
  contentMatches.sort((a, b) => a.appNumber - b.appNumber);

  // Gaps across the COMBINED set (numbers used by neither, within the overall range).
  const all = [...appNums.keys(), ...qbNums.keys()];
  const min = all.length ? Math.min(...all) : null;
  const max = all.length ? Math.max(...all) : null;
  const used = new Set(all);
  const gaps = [];
  if (min != null && max != null && max - min < 100000) {
    for (let n = min; n <= max; n++) if (!used.has(n)) gaps.push(n);
  }

  res.json({
    appCount: appNums.size,
    qbCount: qbNums.size,
    inBothCount: inBoth.length,
    inBoth: inBoth.slice(0, 2000),
    totalMismatchCount,
    onlyAppCount: onlyApp.length,
    onlyQbCount: onlyQb.length,
    onlyApp: onlyApp.slice(0, 1000),
    onlyQb: onlyQb.slice(0, 1000),
    suggestions: suggestions.slice(0, 500),
    suggestionCount: suggestions.length,
    contentMatches: contentMatches.slice(0, 3000),
    contentMatchCount: contentMatches.length,
    range: { min, max },
    gapCount: gaps.length,
    gaps: gaps.slice(0, 1000),
  });
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
