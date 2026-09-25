const express = require('express');
const db = require('../db');

const router = express.Router();

// Stock holds: set stock aside for an ad or anything else upcoming, without it
// being a sale. A hold reduces AVAILABLE only (see computeStock in db.js);
// the boxes stay physically on hand. Holds are deliberately separate from
// orders so they never pick up an invoice number, hit QuickBooks export, or
// appear in any sales report.

function loadLines(holdIds) {
  if (!holdIds.length) return {};
  const ph = holdIds.map(() => '?').join(',');
  const rows = db.prepare(
    `SELECT hl.hold_id AS holdId, hl.item_id AS itemId, hl.qty, hl.unit,
            i.name AS itemName, i.brand, i.case_size AS caseSize
       FROM hold_lines hl LEFT JOIN items i ON i.id = hl.item_id
      WHERE hl.hold_id IN (${ph}) ORDER BY i.name`
  ).all(...holdIds);
  const byHold = {};
  for (const r of rows) (byHold[r.holdId] || (byHold[r.holdId] = [])).push(r);
  return byHold;
}

// An active hold stops holding stock once its end date passes. That's judged
// by date at read time rather than by a scheduled job flipping the status, so
// the same rule applies here and in computeStock without them drifting apart.
function effectiveStatus(h, today) {
  if (h.status !== 'active') return h.status;
  if (h.endDate && h.endDate < today) return 'expired';
  return 'active';
}

// GET /api/holds?status=active|released|converted|expired|all
router.get('/', (req, res) => {
  const today = db.todayHST();
  const rows = db.prepare(
    `SELECT h.id, h.name, h.customer_id AS customerId, c.name AS customerName,
            h.end_date AS endDate, h.notes, h.status, h.converted_order_id AS convertedOrderId,
            h.created_by AS createdBy, h.created_at AS createdAt, h.released_at AS releasedAt
       FROM holds h LEFT JOIN customers c ON c.id = h.customer_id
      ORDER BY h.created_at DESC`
  ).all();
  const byHold = loadLines(rows.map(r => r.id));
  let out = rows.map(h => {
    const lines = byHold[h.id] || [];
    const boxes = lines.reduce((s, l) => {
      const cs = Number(l.caseSize) > 0 ? Number(l.caseSize) : 1;
      return s + (Number(l.qty) || 0) * (l.unit === 'case' ? cs : 1);
    }, 0);
    return { ...h, effectiveStatus: effectiveStatus(h, today), lines, totalBoxes: boxes };
  });
  const want = req.query.status;
  if (want && want !== 'all') out = out.filter(h => h.effectiveStatus === want);
  res.json(out);
});

// POST /api/holds — body: { name, customerId?, endDate?, notes?, createdBy?,
//                           lines: [{ itemId, qty, unit }] }
router.post('/', (req, res) => {
  const { name, customerId, endDate, notes, createdBy, lines } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Give this hold a name.' });
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'Add at least one item to hold.' });
  for (const l of lines) {
    if (!l || !l.itemId) return res.status(400).json({ error: 'Every line needs an item.' });
    if (!(Number(l.qty) > 0)) return res.status(400).json({ error: 'Every line needs a quantity above zero.' });
  }
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return res.status(400).json({ error: 'End date must be YYYY-MM-DD.' });
  if (customerId != null && customerId !== '') {
    const c = db.prepare('SELECT id FROM customers WHERE id = ?').get(Number(customerId));
    if (!c) return res.status(404).json({ error: 'Customer not found.' });
  }

  const insHold = db.prepare(
    `INSERT INTO holds (name, customer_id, end_date, notes, status, created_by, created_at)
     VALUES (?, ?, ?, ?, 'active', ?, ?)`
  );
  const insLine = db.prepare('INSERT INTO hold_lines (hold_id, item_id, qty, unit) VALUES (?, ?, ?, ?)');
  const id = db.transaction(() => {
    const info = insHold.run(
      String(name).trim(),
      customerId == null || customerId === '' ? null : Number(customerId),
      endDate || null,
      notes ? String(notes).trim() : null,
      createdBy || null,
      new Date().toISOString()
    );
    for (const l of lines) {
      insLine.run(info.lastInsertRowid, l.itemId, Number(l.qty), l.unit === 'case' ? 'case' : 'box');
    }
    return info.lastInsertRowid;
  })();
  db.syncStock();
  res.status(201).json({ id });
});

// PATCH /api/holds/:id — edit an existing hold (replaces its lines).
router.patch('/:id', (req, res) => {
  const id = Number(req.params.id);
  const existing = db.prepare('SELECT id, status FROM holds WHERE id = ?').get(id);
  if (!existing) return res.status(404).json({ error: 'Hold not found.' });
  if (existing.status !== 'active') return res.status(400).json({ error: 'Only an active hold can be edited.' });

  const { name, customerId, endDate, notes, lines } = req.body || {};
  if (!name || !String(name).trim()) return res.status(400).json({ error: 'Give this hold a name.' });
  if (!Array.isArray(lines) || lines.length === 0) return res.status(400).json({ error: 'Add at least one item to hold.' });
  for (const l of lines) {
    if (!l || !l.itemId) return res.status(400).json({ error: 'Every line needs an item.' });
    if (!(Number(l.qty) > 0)) return res.status(400).json({ error: 'Every line needs a quantity above zero.' });
  }
  if (endDate && !/^\d{4}-\d{2}-\d{2}$/.test(endDate)) return res.status(400).json({ error: 'End date must be YYYY-MM-DD.' });

  const insLine = db.prepare('INSERT INTO hold_lines (hold_id, item_id, qty, unit) VALUES (?, ?, ?, ?)');
  db.transaction(() => {
    db.prepare('UPDATE holds SET name = ?, customer_id = ?, end_date = ?, notes = ? WHERE id = ?').run(
      String(name).trim(),
      customerId == null || customerId === '' ? null : Number(customerId),
      endDate || null,
      notes ? String(notes).trim() : null,
      id
    );
    db.prepare('DELETE FROM hold_lines WHERE hold_id = ?').run(id);
    for (const l of lines) insLine.run(id, l.itemId, Number(l.qty), l.unit === 'case' ? 'case' : 'box');
  })();
  db.syncStock();
  res.json({ ok: true });
});

// POST /api/holds/:id/release — stop holding this stock. Optionally records
// the order it turned into, when the release happened because the hold was
// converted into a real order (the order itself is created through the normal
// order flow, so it gets invoice numbering and everything else as usual).
router.post('/:id/release', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id, status FROM holds WHERE id = ?').get(id);
  if (!h) return res.status(404).json({ error: 'Hold not found.' });
  if (h.status !== 'active') return res.status(400).json({ error: 'This hold is not active.' });
  const orderId = req.body && req.body.orderId != null ? Number(req.body.orderId) : null;
  db.prepare('UPDATE holds SET status = ?, converted_order_id = ?, released_at = ? WHERE id = ?')
    .run(orderId ? 'converted' : 'released', orderId || null, new Date().toISOString(), id);
  db.syncStock();
  res.json({ ok: true });
});

// POST /api/holds/:id/reactivate — undo a release that shouldn't have happened.
router.post('/:id/reactivate', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id, status FROM holds WHERE id = ?').get(id);
  if (!h) return res.status(404).json({ error: 'Hold not found.' });
  if (h.status === 'active') return res.status(400).json({ error: 'This hold is already active.' });
  db.prepare("UPDATE holds SET status = 'active', converted_order_id = NULL, released_at = NULL WHERE id = ?").run(id);
  db.syncStock();
  res.json({ ok: true });
});

// DELETE /api/holds/:id
router.delete('/:id', (req, res) => {
  const id = Number(req.params.id);
  const h = db.prepare('SELECT id FROM holds WHERE id = ?').get(id);
  if (!h) return res.status(404).json({ error: 'Hold not found.' });
  db.transaction(() => {
    db.prepare('DELETE FROM hold_lines WHERE hold_id = ?').run(id);
    db.prepare('DELETE FROM holds WHERE id = ?').run(id);
  })();
  db.syncStock();
  res.json({ ok: true });
});

module.exports = router;
