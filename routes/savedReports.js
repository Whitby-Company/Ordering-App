const express = require('express');
const db = require('../db');
const router = express.Router();

// GET /api/saved-reports?kind=item-sales — list saved reports.
router.get('/', (req, res) => {
  const kind = req.query.kind;
  const rows = kind
    ? db.prepare('SELECT id, name, kind, config, created_at AS createdAt FROM saved_reports WHERE kind = ? ORDER BY name').all(kind)
    : db.prepare('SELECT id, name, kind, config, created_at AS createdAt FROM saved_reports ORDER BY name').all();
  res.json(rows.map(r => ({ ...r, config: safeParse(r.config) })));
});

// POST /api/saved-reports — { name, kind, config } — create (or replace same-name).
router.post('/', (req, res) => {
  const name = (req.body && req.body.name || '').trim();
  const kind = (req.body && req.body.kind || 'item-sales').trim();
  const config = req.body && req.body.config;
  if (!name || config == null) return res.status(400).json({ error: 'name and config required' });
  const existing = db.prepare('SELECT id FROM saved_reports WHERE name = ? AND kind = ?').get(name, kind);
  const cfg = JSON.stringify(config);
  if (existing) {
    db.prepare('UPDATE saved_reports SET config = ?, created_at = ? WHERE id = ?').run(cfg, new Date().toISOString(), existing.id);
    return res.json({ ok: true, id: existing.id, updated: true });
  }
  const r = db.prepare('INSERT INTO saved_reports (name, kind, config, created_at) VALUES (?,?,?,?)').run(name, kind, cfg, new Date().toISOString());
  res.json({ ok: true, id: r.lastInsertRowid });
});

// DELETE /api/saved-reports/:id
router.delete('/:id', (req, res) => {
  db.prepare('DELETE FROM saved_reports WHERE id = ?').run(Number(req.params.id));
  res.json({ ok: true });
});

function safeParse(s) { try { return JSON.parse(s); } catch { return null; } }

module.exports = router;
