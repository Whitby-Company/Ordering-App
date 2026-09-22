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
            pl.qty_ordered AS qtyOrdered, pl.qty_received AS qtyReceived, pl.qty_short AS qtyShort,
            pl.qty_damaged AS qtyDamaged, pl.received_date AS receivedDate
       FROM po_lines pl LEFT JOIN items i ON i.id = pl.item_id
      WHERE pl.po_id = ? ORDER BY pl.id`
  ).all(id);
  return po;
}

// Recompute a PO's status from its lines. "Accounted for" = received + short
// + damaged, since short/damaged quantities are just as final as received
// ones (they're never coming, but the line is done either way).
function refreshStatus(id) {
  const po = db.prepare('SELECT status FROM purchase_orders WHERE id = ?').get(id);
  if (!po || po.status === 'cancelled') return;
  const lines = db.prepare('SELECT qty_ordered, qty_received, qty_short, qty_damaged FROM po_lines WHERE po_id = ?').all(id);
  const totalOrdered = lines.reduce((s, l) => s + l.qty_ordered, 0);
  const totalReceived = lines.reduce((s, l) => s + l.qty_received, 0);
  const totalAccounted = lines.reduce((s, l) => s + l.qty_received + (l.qty_short || 0) + (l.qty_damaged || 0), 0);
  let status = 'open';
  if (totalReceived > 0 && totalAccounted < totalOrdered) status = 'partial';
  else if (totalOrdered > 0 && totalAccounted >= totalOrdered) status = 'received';
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
    // Case totals: boxes / case_size for items that have one (rounded to 1 decimal).
    const cagg = db.prepare(
      `SELECT COALESCE(SUM(CASE WHEN i.case_size > 0 THEN CAST(pl.qty_ordered AS REAL) / i.case_size ELSE 0 END), 0) AS orderedCases,
              COALESCE(SUM(CASE WHEN i.case_size > 0 THEN CAST(pl.qty_received AS REAL) / i.case_size ELSE 0 END), 0) AS receivedCases
         FROM po_lines pl LEFT JOIN items i ON i.id = pl.item_id WHERE pl.po_id = ?`
    ).get(po.id);
    return {
      ...po, itemCount: agg.items, totalOrdered: agg.ordered, totalReceived: agg.received,
      totalOrderedCases: Math.round(cagg.orderedCases * 10) / 10,
      totalReceivedCases: Math.round(cagg.receivedCases * 10) / 10,
    };
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
      // qty_ordered is stored in inventory BOXES. The uploader already converts
      // cases → boxes (× case_size) before sending, so use qty directly.
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
  const po = db.prepare('SELECT id, status, reference FROM purchase_orders WHERE id = ?').get(id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'PO is cancelled' });
  const lines = db.prepare('SELECT id, item_id, qty_ordered, qty_received FROM po_lines WHERE po_id = ?').all(id);
  const byItem = new Map(lines.map(l => [l.item_id, l]));
  const receipts = (req.body && req.body.all)
    ? lines.map(l => ({ itemId: l.item_id, qty: l.qty_ordered - l.qty_received })).filter(r => r.qty > 0)
    : ((req.body && req.body.receipts) || []);
  const receivedDate = /^\d{4}-\d{2}-\d{2}$/.test((req.body && req.body.receivedDate) || '') ? req.body.receivedDate : new Date().toISOString().slice(0, 10);

  const setRecv = db.prepare('UPDATE po_lines SET qty_received = qty_received + ?, received_date = ? WHERE id = ?');
  const logStock = db.prepare(`INSERT INTO stock_log (item_id, old_stock, new_stock, delta, changed_by, reason, changed_at)
                               VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const who = (req.body && req.body.receivedBy) ? String(req.body.receivedBy) : null;
  const poRef = po.reference || po.id;
  const touched = [];
  let received = 0;
  const tx = db.transaction(() => {
    for (const r of receipts) {
      const line = byItem.get(r.itemId);
      // qty is in inventory BOXES (the UI converts cases → boxes before sending).
      const qty = Number(r.qty) || 0;
      if (!line || qty <= 0) continue;
      const remaining = line.qty_ordered - line.qty_received;
      const take = Math.min(qty, remaining);
      if (take <= 0) continue;
      setRecv.run(take, receivedDate, line.id);
      touched.push(r.itemId);
      received += take;
    }
  });
  tx();
  // Stock is computed from baselines + dated movements (the received_date now
  // counts toward on-hand). Sync the cached on-hand + log the receipt.
  db.syncStock(touched);
  const now = new Date().toISOString();
  for (const itemId of touched) {
    const cur = db.prepare('SELECT stock FROM items WHERE id = ?').get(itemId);
    logStock.run(itemId, cur ? cur.stock : 0, cur ? cur.stock : 0, 0, who, `Received PO ${poRef} (${receivedDate})`, now);
  }
  refreshStatus(id);
  res.json({ ok: true, received, receivedDate, po: getPO(id) });
});

// POST /api/purchase-orders/:id/close-short — mark the PO done, recording the
// still-outstanding quantity per line as short and/or damaged (either way,
// it never becomes usable stock). body: { damaged: { [lineId]: qty } }
// (optional) — however much of a line's outstanding qty is specified as
// damaged there; the remainder of that line's outstanding is recorded as
// short (genuinely missing). Omit entirely for the old all-short behavior.
router.post('/:id/close-short', (req, res) => {
  const id = Number(req.params.id);
  const po = db.prepare('SELECT id, status FROM purchase_orders WHERE id = ?').get(id);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'PO is cancelled' });
  const lines = db.prepare('SELECT id, qty_ordered, qty_received, qty_short, qty_damaged FROM po_lines WHERE po_id = ?').all(id);
  const damagedInput = (req.body && req.body.damaged) || {};
  const setLine = db.prepare('UPDATE po_lines SET qty_short = ?, qty_damaged = ? WHERE id = ?');
  let totalShort = 0, totalDamaged = 0;
  const tx = db.transaction(() => {
    for (const l of lines) {
      const outstanding = l.qty_ordered - l.qty_received - (l.qty_short || 0) - (l.qty_damaged || 0);
      if (outstanding <= 0) continue;
      const damagedRequested = Number(damagedInput[l.id]) || 0;
      const damaged = Math.max(0, Math.min(damagedRequested, outstanding));
      const short = outstanding - damaged;
      setLine.run((l.qty_short || 0) + short, (l.qty_damaged || 0) + damaged, l.id);
      totalShort += short; totalDamaged += damaged;
    }
    // Closed short = considered received/complete (no more expected).
    db.prepare("UPDATE purchase_orders SET status = 'received' WHERE id = ?").run(id);
  });
  tx();
  res.json({ ok: true, totalShort, totalDamaged, po: getPO(id) });
});

// PATCH /api/purchase-orders/:poId/lines/:lineId — directly correct a line's
// received quantity, received date, short quantity, and/or damaged quantity,
// e.g. fixing a receiving mistake found after the fact. Unlike POST
// /:id/receive (which only adds to what's already received and is meant for
// the normal receiving flow), this sets values outright and works even
// after the PO is fully 'received'.
//
// Applies the resulting quantity DELTA straight to items.stock, rather than
// going through db.syncStock()/computeStock(): that function falls back to
// treating an item's *current* cached stock as its baseline when no real
// stock_baseline row exists, which makes it non-idempotent -- calling it a
// second time after a correction (or after any second receipt of the same
// item) adds the received amount on top of itself instead of replacing it.
// That's a pre-existing issue in the stock computation, not introduced
// here; applying an exact delta sidesteps it for this endpoint specifically
// without touching that shared code path.
router.patch('/:poId/lines/:lineId', (req, res) => {
  const { poId, lineId } = req.params;
  const po = db.prepare('SELECT id, reference, status FROM purchase_orders WHERE id = ?').get(poId);
  if (!po) return res.status(404).json({ error: 'Purchase order not found' });
  if (po.status === 'cancelled') return res.status(400).json({ error: 'PO is cancelled' });
  const line = db.prepare('SELECT id, item_id, qty_ordered, qty_received FROM po_lines WHERE id = ? AND po_id = ?').get(lineId, poId);
  if (!line) return res.status(404).json({ error: 'Line not found on this PO' });

  const { qtyReceived, receivedDate, qtyShort, qtyDamaged, changedBy } = req.body || {};
  const updates = [];
  const params = [];
  let qtyDelta = 0;
  if (qtyReceived !== undefined) {
    const q = Number(qtyReceived);
    if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: 'qtyReceived must be a non-negative number' });
    qtyDelta = q - line.qty_received; // in boxes, same unit items.stock is tracked in
    updates.push('qty_received = ?'); params.push(q);
  }
  if (receivedDate !== undefined) {
    if (receivedDate !== null && !/^\d{4}-\d{2}-\d{2}$/.test(receivedDate)) return res.status(400).json({ error: 'receivedDate must be YYYY-MM-DD' });
    updates.push('received_date = ?'); params.push(receivedDate);
  }
  if (qtyShort !== undefined) {
    const q = Number(qtyShort);
    if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: 'qtyShort must be a non-negative number' });
    updates.push('qty_short = ?'); params.push(q);
  }
  if (qtyDamaged !== undefined) {
    const q = Number(qtyDamaged);
    if (!Number.isFinite(q) || q < 0) return res.status(400).json({ error: 'qtyDamaged must be a non-negative number' });
    updates.push('qty_damaged = ?'); params.push(q);
  }
  if (updates.length === 0) return res.status(400).json({ error: 'Nothing to update — provide qtyReceived, receivedDate, qtyShort, and/or qtyDamaged' });

  const before = db.prepare('SELECT stock FROM items WHERE id = ?').get(line.item_id);
  const oldStock = before ? before.stock : 0;
  const newStock = oldStock + qtyDelta;
  const tx = db.transaction(() => {
    params.push(lineId);
    db.prepare(`UPDATE po_lines SET ${updates.join(', ')} WHERE id = ?`).run(...params);
    if (qtyDelta !== 0) db.prepare('UPDATE items SET stock = ? WHERE id = ?').run(newStock, line.item_id);
  });
  tx();
  // Only recalculate the PO's overall status when the received quantity
  // itself changed. Editing just qtyShort/qtyDamaged is a standalone
  // correction (e.g. noting damage while more is still expected to arrive)
  // and shouldn't silently flip the PO to "received" (hiding the normal
  // receiving controls) just because the numbers happen to add up, nor
  // reopen an already-closed PO back to "partial".
  if (qtyReceived !== undefined) refreshStatus(Number(poId));

  if (qtyDelta !== 0) {
    const who = changedBy ? String(changedBy) : null;
    db.prepare(
      `INSERT INTO stock_log (item_id, old_stock, new_stock, delta, changed_by, reason, changed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(line.item_id, oldStock, newStock, qtyDelta, who, `Corrected received qty on PO ${po.reference || po.id}`, new Date().toISOString());
  }

  res.json({ ok: true, po: getPO(poId) });
});

module.exports = router;
