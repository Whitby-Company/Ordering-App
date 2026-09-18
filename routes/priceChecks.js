const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');

// GET /api/price-checks?itemId=&location=&q= — list, most recent first.
// Joined with item name/brand for display. q filters by item name/brand or
// retail location (loose match).
router.get('/', (req, res) => {
  const { itemId, location, q } = req.query;
  let sql = `SELECT pc.id, pc.item_id AS itemId, i.name AS itemName, i.brand,
                    pc.retail_location AS retailLocation, pc.base_price AS basePrice,
                    pc.promo_price AS promoPrice, pc.photo_url AS photoUrl, pc.notes,
                    pc.checked_by AS checkedBy, pc.checked_at AS checkedAt
               FROM price_checks pc LEFT JOIN items i ON i.id = pc.item_id
              WHERE 1=1`;
  const params = [];
  if (itemId) { sql += ' AND pc.item_id = ?'; params.push(itemId); }
  if (location) { sql += ' AND pc.retail_location = ?'; params.push(location); }
  if (q) {
    sql += ' AND (i.name LIKE ? OR i.brand LIKE ? OR pc.retail_location LIKE ?)';
    const like = `%${q}%`;
    params.push(like, like, like);
  }
  sql += ' ORDER BY pc.checked_at DESC, pc.id DESC';
  res.json(db.prepare(sql).all(...params));
});

// GET /api/price-checks/locations — distinct retail location names seen so
// far, most-recently-used first, for autocomplete convenience.
router.get('/locations', (req, res) => {
  const rows = db.prepare(
    `SELECT retail_location AS location, MAX(checked_at) AS lastUsed, COUNT(*) AS checkCount
       FROM price_checks GROUP BY retail_location ORDER BY lastUsed DESC`
  ).all();
  res.json(rows);
});

// POST /api/price-checks — log a new price check.
// body: { itemId, retailLocation, basePrice, promoPrice, notes, checkedBy }
router.post('/', (req, res) => {
  const { itemId, retailLocation, basePrice, promoPrice, notes, checkedBy } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId is required' });
  if (!retailLocation || !retailLocation.trim()) return res.status(400).json({ error: 'retailLocation is required' });
  const item = db.prepare('SELECT id FROM items WHERE id = ?').get(itemId);
  if (!item) return res.status(404).json({ error: 'Item not found' });

  const now = new Date().toISOString();
  const info = db.prepare(
    `INSERT INTO price_checks (item_id, retail_location, base_price, promo_price, notes, checked_by, checked_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    itemId, retailLocation.trim(),
    basePrice === '' || basePrice == null ? null : Number(basePrice),
    promoPrice === '' || promoPrice == null ? null : Number(promoPrice),
    notes ? String(notes).trim() : null,
    checkedBy || null,
    now
  );
  res.status(201).json({ id: info.lastInsertRowid, checkedAt: now });
});

// POST /api/price-checks/:id/photo — attach a photo (base64), same
// disk-storage pattern as item photos. body: { imageData, ext }
router.post('/:id/photo', (req, res) => {
  const { imageData, ext } = req.body || {};
  if (!imageData) return res.status(400).json({ error: 'imageData is required' });
  const pc = db.prepare('SELECT id FROM price_checks WHERE id = ?').get(req.params.id);
  if (!pc) return res.status(404).json({ error: 'Price check not found' });

  const safeExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const base64 = imageData.includes(',') ? imageData.split(',').pop() : imageData;
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) throw new Error('empty');
  } catch (err) {
    return res.status(400).json({ error: 'imageData could not be decoded as base64' });
  }
  if (buffer.length > 8 * 1024 * 1024) return res.status(400).json({ error: 'Image too large (max 8MB)' });

  const filename = `pricecheck-${req.params.id}-${crypto.randomBytes(4).toString('hex')}.${safeExt}`;
  const imagesDir = req.app.get('imagesDir');
  fs.writeFileSync(path.join(imagesDir, filename), buffer);

  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  const photoUrl = `${proto}://${req.get('host')}/images/${filename}`;
  db.prepare('UPDATE price_checks SET photo_url = ? WHERE id = ?').run(photoUrl, req.params.id);
  res.json({ id: req.params.id, photoUrl });
});

// DELETE /api/price-checks/:id — remove a mistaken entry.
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM price_checks WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Price check not found' });
  res.json({ ok: true });
});

module.exports = router;
