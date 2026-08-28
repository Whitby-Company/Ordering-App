const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/brand-settings — returns { brand: { abbreviation }, ... }
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT brand, abbreviation FROM brand_settings').all();
  const map = {};
  for (const r of rows) map[r.brand] = { abbreviation: r.abbreviation || '' };
  res.json(map);
});

// PUT /api/brand-settings/:brand — set (or clear) a brand's abbreviation.
// body: { abbreviation: 'LOA' } — empty/absent clears it.
router.put('/:brand', (req, res) => {
  const brand = req.params.brand;
  const raw = req.body ? req.body.abbreviation : undefined;
  const abbr = (raw === undefined || raw === null) ? '' : String(raw).trim();

  if (abbr === '') {
    db.prepare('DELETE FROM brand_settings WHERE brand = ?').run(brand);
    return res.json({ brand, abbreviation: '' });
  }
  db.prepare(
    `INSERT INTO brand_settings (brand, abbreviation) VALUES (?, ?)
     ON CONFLICT(brand) DO UPDATE SET abbreviation = excluded.abbreviation`
  ).run(brand, abbr);
  res.json({ brand, abbreviation: abbr });
});

module.exports = router;
