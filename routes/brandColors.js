const express = require('express');
const db = require('../db');

const router = express.Router();

// Basic hex-color validation: #RGB or #RRGGBB
function isValidHex(color) {
  return typeof color === 'string' && /^#([0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(color.trim());
}

// GET /api/brand-colors — returns { brand: color, ... } for all customized brands
router.get('/', (req, res) => {
  const rows = db.prepare('SELECT brand, color FROM brand_colors').all();
  const map = {};
  for (const r of rows) map[r.brand] = r.color;
  res.json(map);
});

// PUT /api/brand-colors/:brand — set (or clear) a brand's color.
// body: { color: '#RRGGBB' }  — send an empty/absent color to reset to default.
router.put('/:brand', (req, res) => {
  const brand = req.params.brand;
  const { color } = req.body;

  if (color === undefined || color === null || color === '') {
    db.prepare('DELETE FROM brand_colors WHERE brand = ?').run(brand);
    return res.json({ brand, color: null });
  }
  if (!isValidHex(color)) {
    return res.status(400).json({ error: 'color must be a hex value like #2B5D50' });
  }
  const clean = color.trim();
  db.prepare(
    `INSERT INTO brand_colors (brand, color) VALUES (?, ?)
     ON CONFLICT(brand) DO UPDATE SET color = excluded.color`
  ).run(brand, clean);
  res.json({ brand, color: clean });
});

module.exports = router;
