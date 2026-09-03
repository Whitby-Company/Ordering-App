const express = require('express');
const router = express.Router();
const db = require('../db');

// Build a full PO object (with lines + item names) for responses.
function getPO(id) {
  const po = db.prepare(
    `SELECT id, supplier, reference, order_date AS orderDate, expected_date AS expectedDate,
            status, notes, created_at AS createdAt FROM purchase_orders WHERE id = ?`
  ).get(id);
  if (!po) return null;
  po.lines = db.prepare(
    `SELECT pl.id, pl.item_id AS itemId, i.name AS item, i.brand,
            pl.qty_ordered AS qtyOrdered, pl.qty_received AS qtyReceived
       FROM po_lines pl LEFT JOIN items i ON i.id = pl.item_id
      WHERE pl.po_id = ? ORDER BY pl.id`
  ).all(id);
  return po;
}

// Recompute a PO's status from its lines.
function refreshStatus(id) {
  const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id);
  if (!po || po.status === 'cancelled') return;
  const lines = db.prepare('SELECT qty_ordered, qty_received FROM po_lines WHERE po_id = ?').all(id);
  const totalOrdered = lines.reduce((s, l) => s + l.qty_ordered, 0);
  const totalReceived = lines.reduce((s, l) => s + l.qty_received, 0);
  let status = 'open';
  if (totalReceived > 0 && totalReceived < totalOrdered) status = 'partial';
  else if (totalOrdered > 0 && totalReceived >= totalOrdered) status = 'received';
  db.prepare('UPDATE purchase_orders SET status = ? WHERE id = ?').run(status, id);
}

// GET /api/purchase-orders — list (optionally ?status=open|partial|received|cancelled)
router.get('/', (req, res) => {
  const { status } = req.query;
  let sql = `SELECT id, supplier, reference, order_date AS orderDate, expected_date AS expectedDate, status, notes
             FROM purchase_orders`;
  const params = [];
  if (status) { sql += ' WHERE status = ?'; params.push(status); }
  sql += ' ORDER BY COALESCE(expected_date, order_date, created_at) DESC, id DESC';
  const pos = db.prepare(sql).all(...params).map(po => {
    const agg = db.prepare('SELECT COUNT(*) items, COALESCE(SUM(qty_ordered),0) ordered, COALESCE(SUM(qty_received),0) received FROM po_lines WHERE po_id = ?').get(po.id);
    return { ...po, itemCount: agg.items, totalOrdered: agg.ordered, totalReceived: agg.received };
  });
  res.json(pos);
});

// GET /api/purchase-orders/incoming — incoming (on-order, not yet received) per item.
router.get('/incoming', (req, res) => {
  const rows = db.prepare(
    `SELECT pl.item_id AS itemId, SUM(pl.qty_ordered - pl.qty_received) AS incoming
       FROM po_lines pl JOIN purchase_orders po ON po.id = pl.po_id
      WHERE po.status IN ('open','partial')
      GROUP BY pl.item_id HAVING SUM(pl.qty_ordered - pl.qty_received) > 0`
  ).all();
  const map = {};
  for (const r of rows) map[r.itemId] = r.incoming;
  res.json(map);
});

// GET /api/purchase-orders/:id
router.get('/:id', (req, res) => {
  const po = getPO(req.params.id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  res.json(po);
});

// POST /api/purchase-orders — create { supplier, reference, orderDate, expectedDate, notes, lines:[{itemId, qty}] }
router.post('/', (req, res) => {
  const { supplier, reference, orderDate, expectedDate, notes, lines } = req.body || {};
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'Provide at least one line' });
  const now = new Date().toISOString();
  const insPO = db.prepare(`INSERT INTO purchase_orders (supplier, reference, order_date, expected_date, status, notes, created_at)
                            VALUES (?,?,?,?, 'open', ?, ?)`);
  const insLine = db.prepare('INSERT INTO po_lines (po_id, item_id, qty_ordered) VALUES (?,?,?)');
  let id;
  const tx = db.transaction(() => {
    const r = insPO.run(supplier || null, reference || null, orderDate || null, expectedDate || null, notes || null, now);
    id = r.lastInsertRowid;
    for (const l of lines) {
      const qty = Number(l.qty) || 0;
      if (!l.itemId || qty <= 0) continue;
      insLine.run(id, l.itemId, qty);
    }
  });
  tx();
  res.status(201).json(getPO(id));
});

// PATCH /api/purchase-orders/:id — edit header fields and/or replace lines.
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id FROM purchase_orders WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Purchase order not found' });
  const { supplier, reference, orderDate, expectedDate, notes, status, lines } = req.body || {};
  const sets = [], params = [];
  if (supplier !== undefined) { sets.push('supplier = ?'); params.push(supplier || null); }
  if (reference !== undefined) { sets.push('reference = ?'); params.push(reference || null); }
  if (orderDate !== undefined) { sets.push('order_date = ?'); params.push(orderDate || null); }
  if (expectedDate !== undefined) { sets.push('expected_date = ?'); params.push(expectedDate || null); }
  if (notes !== undefined) { sets.push('notes = ?'); params.push(notes || null); }
  if (status !== undefined) { sets.push('status = ?'); params.push(status); }
  const tx = db.transaction(() => {
    if (sets.length) { params.push(id); db.prepare(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`).run(...params); }
    if (Array.isArray(lines)) {
      // Replace lines but preserve received amounts by item where possible.
      const prevRecv = {};
      for (const l of db.prepare('SELECT item_id, qty_received FROM po_lines WHERE po_id = ?').all(id)) prevRecv[l.item_id] = l.qty_received;
      db.prepare('DELETE FROM po_lines WHERE po_id = ?').run(id);
      const insLine = db.prepare('INSERT INTO po_lines (po_id, item_id, qty_ordered, qty_received) VALUES (?,?,?,?)');
      for (const l of lines) {
        const qty = Number(l.qty) || 0;
        if (!l.itemId || qty <= 0) continue;
        insLine.run(id, l.itemId, qty, Math.min(prevRecv[l.itemId] || 0, qty));
      }
    }
  });
  tx();
  if (status === undefined) refreshStatus(id);
  res.json(getPO(id));
});

// POST /api/purchase-orders/:id/receive — receive stock into inventory.
// body: { receipts: [{ itemId, qty }] }  (qty = how many just arrived)
//   or  { all: true } to receive everything outstanding.
router.post('/:id/receive', (req, res) => {
  const id = Number(req.params.id);
  const po = db.prepare('SELECT id, status FROM purchase_orders WHERE id = ?').get(id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'PO is cancelled' });
  const lines = db.prepare('SELECT id, item_id, qty_ordered, qty_received FROM po_lines WHERE po_id = ?').all(id);
  const byItem = new Map(lines.map(l => [l.item_id, l]));
  const receipts = (req.body && req.body.all)
    ? lines.map(l => ({ itemId: l.item_id, qty: l.qty_ordered - l.qty_received })).filter(r => r.qty > 0)
    : ((req.body && req.body.receipts) || []);

  const addStock = db.prepare('UPDATE items SET stock = stock + ? WHERE id = ?');
  const setRecv = db.prepare('UPDATE po_lines SET qty_received = qty_received + ? WHERE id = ?');
  let received = 0;
  const tx = db.transaction(() => {
    for (const r of receipts) {
      const line = byItem.get(r.itemId);
      const qty = Number(r.qty) || 0;
      if (!line || qty <= 0) continue;
      const remaining = line.qty_ordered - line.qty_received;
      const take = Math.min(qty, remaining);
      if (take <= 0) continue;
      setRecv.run(take, line.id);
      addStock.run(take, r.itemId); // incoming -> on-hand
      received += take;
    }
  });
  tx();
  refreshStatus(id);
  res.json({ ok: true, received, po: getPO(id) });
});

module.exports = router;
