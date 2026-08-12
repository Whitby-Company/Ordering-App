const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/print-order — returns the ordered list of SKUs: ["AZLBA:53500", ...]
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT item_id FROM print_order ORDER BY position ASC').all();
  res.json(rows.map(r => r.item_id));
});

// PUT /api/print-order — replace the whole sequence.
// body: { skus: ["AZLBA:53500", "AT:1400c", ...] }  (already in desired order)
// Only SKUs that exist in items are stored; returns how many were saved/skipped.
router.put('/', (req, res) => {
  const { skus } = req.body;
  if (!Array.isArray(skus)) {
    return res.status(400).json({ error: 'skus must be an array of SKU strings' });
  }

  // Validate against real items so a typo can't poison the sort table.
  const validIds = new Set(db.prepare('SELECT id FROM items').all().map(r => r.id));

  const seen = new Set();
  const toStore = [];
  const skipped = [];
  for (const raw of skus) {
    const sku = String(raw).trim();
    if (!sku) continue;
    if (!validIds.has(sku)) { skipped.push(sku); continue; }
    if (seen.has(sku)) continue; // dedupe, keep first occurrence
    seen.add(sku);
    toStore.push(sku);
  }

  const replace = db.transaction(() => {
    db.prepare('DELETE FROM print_order').run();
    const insert = db.prepare('INSERT INTO print_order (item_id, position) VALUES (?, ?)');
    toStore.forEach((sku, i) => insert.run(sku, i));
  });
  replace();

  res.json({ saved: toStore.length, skipped: skipped.length, skippedSkus: skipped });
});

module.exports = router;
