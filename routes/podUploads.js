const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const db = require('../db');

// GET /api/pod-uploads — list all, most recent first.
router.get('/', (req, res) => {
  res.json(db.prepare(
    `SELECT id, reference, file_url AS fileUrl, file_type AS fileType, uploaded_by AS uploadedBy, uploaded_at AS uploadedAt
       FROM pod_uploads ORDER BY uploaded_at DESC, id DESC`
  ).all());
});

// POST /api/pod-uploads — upload a signed proof-of-delivery/invoice document.
// body: { reference, imageData (base64), ext, uploadedBy }
router.post('/', (req, res) => {
  const { reference, imageData, ext, uploadedBy } = req.body || {};
  if (!reference || !reference.trim()) return res.status(400).json({ error: 'reference is required' });
  if (!imageData) return res.status(400).json({ error: 'imageData is required' });

  const safeExt = (ext || 'jpg').replace(/[^a-z0-9]/gi, '').toLowerCase() || 'jpg';
  const base64 = imageData.includes(',') ? imageData.split(',').pop() : imageData;
  let buffer;
  try {
    buffer = Buffer.from(base64, 'base64');
    if (buffer.length === 0) throw new Error('empty');
  } catch (err) {
    return res.status(400).json({ error: 'imageData could not be decoded as base64' });
  }
  if (buffer.length > 15 * 1024 * 1024) return res.status(400).json({ error: 'File too large (max 15MB)' });

  const filename = `pod-${Date.now()}-${crypto.randomBytes(4).toString('hex')}.${safeExt}`;
  const imagesDir = req.app.get('imagesDir');
  fs.writeFileSync(path.join(imagesDir, filename), buffer);

  const proto = (req.get('x-forwarded-proto') || req.protocol).split(',')[0].trim();
  const fileUrl = `${proto}://${req.get('host')}/images/${filename}`;
  const now = new Date().toISOString();
  const fileType = safeExt === 'pdf' ? 'pdf' : 'image';
  const info = db.prepare(
    `INSERT INTO pod_uploads (reference, file_url, file_type, uploaded_by, uploaded_at) VALUES (?, ?, ?, ?, ?)`
  ).run(reference.trim(), fileUrl, fileType, uploadedBy || null, now);
  res.status(201).json({ id: info.lastInsertRowid, reference: reference.trim(), fileUrl, fileType, uploadedAt: now });
});

// DELETE /api/pod-uploads/:id — remove a mistaken entry.
router.delete('/:id', (req, res) => {
  const info = db.prepare('DELETE FROM pod_uploads WHERE id = ?').run(req.params.id);
  if (info.changes === 0) return res.status(404).json({ error: 'Not found' });
  res.json({ ok: true });
});

module.exports = router;
