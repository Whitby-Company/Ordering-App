const express = require('express');
const db = require('../db');

const router = express.Router();

// GET /api/customers — list customers, alphabetical.
// By default only active customers are returned (what the ordering app
// and customer picker should see). Pass ?includeInactive=true to get
// everyone, e.g. for the office management view.
router.get('/', (req, res) => {
  const { includeInactive } = req.query;
  const sql = includeInactive === 'true'
    ? 'SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName, shipto_line1 as shipToLine1, shipto_line2 as shipToLine2, shipto_city as shipToCity, shipto_state as shipToState, shipto_zip as shipToZip, shipto_phone as shipToPhone, billto_line1 as billToLine1, billto_line2 as billToLine2, billto_city as billToCity, billto_state as billToState, billto_zip as billToZip, catalog_on as catalogOn, include_default as includeDefault, show_on_mobile as showOnMobile, terms FROM customers ORDER BY name ASC'
    : 'SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName, shipto_line1 as shipToLine1, shipto_line2 as shipToLine2, shipto_city as shipToCity, shipto_state as shipToState, shipto_zip as shipToZip, shipto_phone as shipToPhone, billto_line1 as billToLine1, billto_line2 as billToLine2, billto_city as billToCity, billto_state as billToState, billto_zip as billToZip, catalog_on as catalogOn, include_default as includeDefault, show_on_mobile as showOnMobile, terms FROM customers WHERE active = 1 ORDER BY name ASC';
  const customers = db.prepare(sql).all();
  res.json(customers);
});

// POST /api/customers/reseed-shipto — (re)apply the built-in store ship-to
// addresses, matching customers by normalized name. Returns which store names
// matched and which didn't, so mismatches are visible. Pass {"overwrite":true}
// to replace existing ship-to values too (default only fills empty ones).
router.post('/reseed-shipto', (req, res) => {
  const overwrite = !!(req.body && req.body.overwrite);
  try {
    const result = db.applyShipToSeed({ overwrite });
    res.json({ ok: true, overwrite, matchedCount: result.matched.length, ...result });
  } catch (err) {
    res.status(500).json({ error: err.message || 'Could not reseed ship-to addresses' });
  }
});

// POST /api/customers — add a new customer  { name }
router.post('/', (req, res) => {
  const { name } = req.body;
  if (!name || !name.trim()) {
    return res.status(400).json({ error: 'name is required' });
  }
  try {
    const info = db.prepare('INSERT INTO customers (name) VALUES (?)').run(name.trim());
    res.status(201).json({ id: info.lastInsertRowid, name: name.trim(), active: 1 });
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A customer with that name already exists' });
    }
    throw err;
  }
});

// PATCH /api/customers/:id — update a customer. Accepts { active } to toggle
// active/inactive and/or { name } to rename. At least one must be provided.
router.patch('/:id', (req, res) => {
  const { active, name, deliveryDay, abbreviation, shortName, showOnMobile, terms } = req.body;
  const SHIPTO_FIELDS = { shipToLine1: 'shipto_line1', shipToLine2: 'shipto_line2', shipToCity: 'shipto_city', shipToState: 'shipto_state', shipToZip: 'shipto_zip', shipToPhone: 'shipto_phone', billToLine1: 'billto_line1', billToLine2: 'billto_line2', billToCity: 'billto_city', billToState: 'billto_state', billToZip: 'billto_zip' };
  const hasActive = typeof active === 'boolean';
  const hasMobile = typeof showOnMobile === 'boolean';
  const hasName = typeof name === 'string';
  // deliveryDay: integer 0-6 to set a usual day, or null to clear it.
  const hasDay = deliveryDay === null || (typeof deliveryDay === 'number' && Number.isInteger(deliveryDay) && deliveryDay >= 0 && deliveryDay <= 6);
  const dayProvided = 'deliveryDay' in req.body;
  const abbrProvided = 'abbreviation' in req.body;
  const shortProvided = 'shortName' in req.body;
  const shipToProvided = Object.keys(SHIPTO_FIELDS).some(k => k in req.body);
  if (!hasActive && !hasMobile && !hasName && !dayProvided && !abbrProvided && !shortProvided && !shipToProvided && terms === undefined) {
    return res.status(400).json({ error: 'Provide active, showOnMobile, name, deliveryDay, abbreviation, shortName, and/or ship-to fields' });
  }
  if (dayProvided && !hasDay) {
    return res.status(400).json({ error: 'deliveryDay must be an integer 0-6 (Sun-Sat) or null' });
  }
  if (hasName && !name.trim()) {
    return res.status(400).json({ error: 'name cannot be empty' });
  }

  const existing = db.prepare('SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });

  // Normalize text: trim, and store empty as NULL.
  const normText = v => { const t = (v === null || v === undefined) ? '' : String(v).trim(); return t === '' ? null : t; };

  const updates = [];
  const params = [];
  if (hasActive) { updates.push('active = ?'); params.push(active ? 1 : 0); }
  if (hasMobile) { updates.push('show_on_mobile = ?'); params.push(showOnMobile ? 1 : 0); }
  if (terms !== undefined) { updates.push('terms = ?'); params.push((typeof terms === 'string' && terms.trim()) ? terms.trim() : null); }
  if (hasName) { updates.push('name = ?'); params.push(name.trim()); }
  if (dayProvided) { updates.push('delivery_day = ?'); params.push(deliveryDay === null ? null : deliveryDay); }
  if (abbrProvided) { updates.push('abbreviation = ?'); params.push(normText(abbreviation)); }
  if (shortProvided) { updates.push('short_name = ?'); params.push(normText(shortName)); }
  for (const [apiKey, col] of Object.entries(SHIPTO_FIELDS)) {
    if (apiKey in req.body) { updates.push(`${col} = ?`); params.push(normText(req.body[apiKey])); }
  }
  params.push(req.params.id);

  try {
    db.prepare(`UPDATE customers SET ${updates.join(', ')} WHERE id = ?`).run(...params);
  } catch (err) {
    if (err.code === 'SQLITE_CONSTRAINT_UNIQUE') {
      return res.status(409).json({ error: 'A customer with that name already exists' });
    }
    throw err;
  }

  const fresh = db.prepare('SELECT id, name, active, delivery_day as deliveryDay, abbreviation, short_name as shortName, shipto_line1 as shipToLine1, shipto_line2 as shipToLine2, shipto_city as shipToCity, shipto_state as shipToState, shipto_zip as shipToZip, shipto_phone as shipToPhone, billto_line1 as billToLine1, billto_line2 as billToLine2, billto_city as billToCity, billto_state as billToState, billto_zip as billToZip, catalog_on as catalogOn, include_default as includeDefault, show_on_mobile as showOnMobile, terms FROM customers WHERE id = ?').get(req.params.id);
  res.json({ ...fresh, active: !!fresh.active });
});

// POST /api/customers/apply-addresses — apply the built-in QuickBooks-exported
// bill-to / ship-to addresses to matching customers (by normalized name).
// Overwrites existing bill-to/ship-to so the app matches QuickBooks. Preserves
// the ship-to phone already stored (QB export doesn't include it here).
// POST /api/customers/set-times-billto — set the bill-to on every "Times ..."
// store to the central Times Supermarket address. One-time bulk action.
// GET /api/customers/address-audit — list active customers missing a bill-to
// or ship-to address, so gaps are easy to spot.
// POST /api/customers/apply-terms — set each customer's payment terms from the
// QuickBooks customer export bundle.
router.post('/apply-terms', (req, res) => {
  const { CUSTOMER_TERMS } = require('../customerTerms');
  const { normalizeName } = require('../shiptoSeed');
  const customers = db.prepare('SELECT id, name FROM customers').all();
  const byNorm = new Map(customers.map(c => [normalizeName(c.name), c]));
  const upd = db.prepare('UPDATE customers SET terms = ? WHERE id = ?');
  let updated = 0; const unmatched = [];
  const tx = db.transaction(() => {
    for (const [name, terms] of Object.entries(CUSTOMER_TERMS)) {
      const c = byNorm.get(normalizeName(name));
      if (!c) { unmatched.push(name); continue; }
      upd.run(terms, c.id); updated++;
    }
  });
  tx();
  res.json({ ok: true, updated, unmatched });
});

router.get('/address-audit', (req, res) => {
  const rows = db.prepare(
    `SELECT id, name, active,
            billto_line1 as b1, billto_city as bc, billto_state as bs, billto_zip as bz,
            shipto_line1 as s1, shipto_city as sc, shipto_state as ss, shipto_zip as sz
     FROM customers ORDER BY name`
  ).all();
  const has = (...vals) => vals.some(v => v != null && String(v).trim() !== '');
  const missingBill = [], missingShip = [], missingBoth = [];
  for (const r of rows) {
    if (!r.active) continue;
    const hasBill = has(r.b1) || has(r.bc, r.bs, r.bz);
    const hasShip = has(r.s1) || has(r.sc, r.ss, r.sz);
    if (!hasBill && !hasShip) missingBoth.push(r.name);
    else { if (!hasBill) missingBill.push(r.name); if (!hasShip) missingShip.push(r.name); }
  }
  res.json({
    activeCustomers: rows.filter(r => r.active).length,
    missingBillToCount: missingBill.length + missingBoth.length,
    missingShipToCount: missingShip.length + missingBoth.length,
    missingBoth, missingBillTo: missingBill, missingShipTo: missingShip,
  });
});

router.post('/set-times-billto', (req, res) => {
  const stores = db.prepare("SELECT id, name FROM customers WHERE name LIKE 'Times%'").all();
  const upd = db.prepare(
    `UPDATE customers SET billto_line1=?, billto_line2=?, billto_city=?, billto_state=?, billto_zip=? WHERE id=?`
  );
  for (const s of stores) upd.run('Times Supermarket', '801 Kaheka St.', 'Honolulu', 'HI', '96814', s.id);
  res.json({ ok: true, updated: stores.length, stores: stores.map(s => s.name) });
});

router.post('/apply-addresses', (req, res) => {
  const { CUSTOMER_ADDRESSES } = require('../customerAddresses');
  const { normalizeName } = require('../shiptoSeed');
  const customers = db.prepare('SELECT id, name FROM customers').all();
  const byNorm = new Map();
  for (const c of customers) byNorm.set(normalizeName(c.name), c);
  const upd = db.prepare(
    `UPDATE customers SET
       billto_line1=?, billto_line2=?, billto_city=?, billto_state=?, billto_zip=?,
       shipto_line1=?, shipto_line2=?, shipto_city=?, shipto_state=?, shipto_zip=?
     WHERE id=?`
  );
  const matched = [], unmatched = [];
  for (const rec of CUSTOMER_ADDRESSES) {
    const c = byNorm.get(normalizeName(rec.name));
    if (!c) { unmatched.push(rec.name); continue; }
    const b = rec.bill || {}, s = rec.ship || {};
    upd.run(
      b.line1 || null, b.line2 || null, b.city || null, b.state || null, b.zip || null,
      s.line1 || null, s.line2 || null, s.city || null, s.state || null, s.zip || null,
      c.id
    );
    matched.push(rec.name);
  }
  res.json({ ok: true, matchedCount: matched.length, matched, unmatched });
});

// Compute a customer's effective catalog item ids:
// (default items if include_default) + explicit adds - explicit removes.
function effectiveCatalogIds(customerId) {
  const cust = db.prepare('SELECT catalog_on, include_default FROM customers WHERE id = ?').get(customerId);
  if (!cust) return null;
  const set = new Set();
  if (cust.include_default) {
    for (const r of db.prepare('SELECT id FROM items WHERE is_default = 1 AND active = 1').all()) set.add(r.id);
  }
  const overrides = db.prepare('SELECT item_id, present, price, unit FROM customer_catalog WHERE customer_id = ?').all(customerId);
  for (const o of overrides) { if (o.present) set.add(o.item_id); else set.delete(o.item_id); }
  return { catalogOn: !!cust.catalog_on, includeDefault: !!cust.include_default, itemIds: [...set] };
}

// GET /api/customers/:id/catalog — the store's catalog state + effective item ids.
router.get('/:id/catalog', (req, res) => {
  const result = effectiveCatalogIds(req.params.id);
  if (!result) return res.status(404).json({ error: 'Customer not found' });
  const overrides = db.prepare('SELECT item_id, present, price, unit FROM customer_catalog WHERE customer_id = ?').all(req.params.id);
  res.json({ ...result, overrides });
});

// PATCH /api/customers/:id/catalog — set catalog_on and/or include_default.
router.patch('/:id/catalog', (req, res) => {
  const { catalogOn, includeDefault } = req.body;
  const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  const sets = [], params = [];
  if (typeof catalogOn === 'boolean') { sets.push('catalog_on = ?'); params.push(catalogOn ? 1 : 0); }
  if (typeof includeDefault === 'boolean') { sets.push('include_default = ?'); params.push(includeDefault ? 1 : 0); }
  if (!sets.length) return res.status(400).json({ error: 'Provide catalogOn and/or includeDefault (boolean)' });
  params.push(req.params.id);
  db.prepare(`UPDATE customers SET ${sets.join(', ')} WHERE id = ?`).run(...params);
  res.json(effectiveCatalogIds(req.params.id));
});

// PUT /api/customers/:id/catalog/items — set overrides for a set of items.
// body: { add: [ids], remove: [ids], clear: [ids] } — clear removes the override
// (item reverts to default behavior).
router.put('/:id/catalog/items', (req, res) => {
  const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(req.params.id);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  const cid = Number(req.params.id);
  const { add = [], remove = [], clear = [] } = req.body || {};
  const up = db.prepare('INSERT INTO customer_catalog (customer_id, item_id, present) VALUES (?,?,?) ON CONFLICT(customer_id, item_id) DO UPDATE SET present = excluded.present');
  const del = db.prepare('DELETE FROM customer_catalog WHERE customer_id = ? AND item_id = ?');
  const tx = db.transaction(() => {
    for (const id of add) up.run(cid, id, 1);
    for (const id of remove) up.run(cid, id, 0);
    for (const id of clear) del.run(cid, id);
  });
  tx();
  res.json(effectiveCatalogIds(cid));
});

// POST /api/customers/apply-catalogs — load the QuickBooks-derived per-store
// catalogs + prices. For each matched customer: catalog_on=1, include_default=0,
// and add each matched item as an override with a per-each price (converted from
// the line's unit using the live item's pack). Reports matched/unmatched.
router.post('/apply-catalogs', (req, res) => {
  const { CUSTOMER_CATALOGS } = require('../customerCatalogs');
  const { normalizeName } = require('../shiptoSeed');

  // Lookup helpers against the LIVE data.
  const customers = db.prepare('SELECT id, name FROM customers').all();
  const custByNorm = new Map();
  for (const c of customers) custByNorm.set(normalizeName(c.name), c);
  const items = db.prepare('SELECT id, pack FROM items').all();
  const itemById = new Map();
  const normId = s => String(s).trim().toLowerCase();
  const itemByNorm = new Map();
  for (const it of items) { itemById.set(it.id, it); itemByNorm.set(normId(it.id), it); }
  const matchItem = sku => {
    const cands = [sku, sku.toLowerCase().endsWith('c') ? sku.slice(0, -1) : sku + 'c'];
    for (const v of cands) { const hit = itemByNorm.get(normId(v)); if (hit) return hit; }
    return null;
  };
  // Convert a line's unit price to per-each using the item's pack.
  const perEach = (unit, unitPrice, pack) => {
    if (unitPrice == null) return null;
    const p = Number(pack) || 1;
    if (unit === 'ea') return unitPrice;
    if (unit === 'cs') return p ? unitPrice / p : null;
    return null; // bx/plt/lbs: leave price unset -> base price used
  };

  const setCat = db.prepare('UPDATE customers SET catalog_on = 1, include_default = 0 WHERE id = ?');
  const clearCat = db.prepare('DELETE FROM customer_catalog WHERE customer_id = ?');
  const addCat = db.prepare('INSERT INTO customer_catalog (customer_id, item_id, present, price) VALUES (?,?,1,?) ON CONFLICT(customer_id, item_id) DO UPDATE SET present=1, price=excluded.price');

  const report = { customersMatched: 0, customersUnmatched: [], itemsAdded: 0, itemsUnmatched: 0, pricesSet: 0 };
  const unmatchedSkus = new Set();

  const tx = db.transaction(() => {
    for (const [name, entries] of Object.entries(CUSTOMER_CATALOGS)) {
      const cust = custByNorm.get(normalizeName(name));
      if (!cust) { report.customersUnmatched.push(name); continue; }
      report.customersMatched++;
      setCat.run(cust.id);
      clearCat.run(cust.id); // rebuild from the QB history
      for (const e of entries) {
        const it = matchItem(e.sku);
        if (!it) { report.itemsUnmatched++; unmatchedSkus.add(e.sku); continue; }
        const price = perEach(e.unit, e.unitPrice, it.pack);
        const rounded = price == null ? null : Math.round(price * 10000) / 10000;
        addCat.run(cust.id, it.id, rounded);
        report.itemsAdded++;
        if (rounded != null) report.pricesSet++;
      }
    }
  });
  tx();
  report.unmatchedSkuSample = [...unmatchedSkus].slice(0, 40);
  res.json({ ok: true, ...report });
});

// PUT /api/customers/:id/catalog/price — set (or clear) a customer's per-each
// price for an item. Ensures the item is in the catalog (present=1). price=null
// clears the custom price (reverts to base). 
router.put('/:id/catalog/price', (req, res) => {
  const cid = Number(req.params.id);
  const { itemId, price } = req.body || {};
  if (!itemId) return res.status(400).json({ error: 'itemId required' });
  const existing = db.prepare('SELECT id FROM customers WHERE id = ?').get(cid);
  if (!existing) return res.status(404).json({ error: 'Customer not found' });
  const p = (price === '' || price === null || price === undefined) ? null : Number(price);
  if (p !== null && (Number.isNaN(p) || p < 0)) return res.status(400).json({ error: 'price must be a non-negative number or null' });
  db.prepare(
    `INSERT INTO customer_catalog (customer_id, item_id, present, price) VALUES (?,?,1,?)
     ON CONFLICT(customer_id, item_id) DO UPDATE SET price = excluded.price, present = 1`
  ).run(cid, itemId, p);
  res.json({ ok: true, itemId, price: p });
});

// POST /api/customers/apply-price-list — overwrite each store's catalog prices
// from the confirmed price list, using their mapped price level (or the base
// sell price when unmapped). Only touches items already in the store's catalog.
router.post('/apply-price-list', (req, res) => {
  const { PRICE_LIST } = require('../customerPriceList');
  const { normalizeName } = require('../shiptoSeed');
  const levelIdx = new Map(PRICE_LIST.levels.map((c, i) => [c, String(i)]));

  const customers = db.prepare('SELECT id, name FROM customers').all();
  const custByNorm = new Map(customers.map(c => [normalizeName(c.name), c]));
  const items = db.prepare('SELECT id FROM items').all();
  const validIds = new Set(items.map(i => i.id));
  const normId = s => String(s).trim().toLowerCase();
  const idByNorm = new Map(items.map(i => [normId(i.id), i.id]));
  const resolveSku = sku => {
    if (validIds.has(sku)) return sku;
    const alt = sku.toLowerCase().endsWith('c') ? sku.slice(0, -1) : sku + 'c';
    return idByNorm.get(normId(sku)) || idByNorm.get(normId(alt)) || null;
  };
  // price for an item id at a given level column (or base if no level price)
  const priceFor = (itemId, levelCol) => {
    // find the source SKU whose resolved id equals this itemId
    // (build a reverse index once)
    return null; // replaced below by prebuilt map
  };

  // Prebuild: resolvedItemId -> { base, byLevelIdx }
  const priceByItem = new Map();
  for (const [sku, d] of Object.entries(PRICE_LIST.prices)) {
    const id = resolveSku(sku);
    if (!id) continue;
    if (!priceByItem.has(id)) priceByItem.set(id, { base: d.b, lv: d.l || {} });
    else {
      const cur = priceByItem.get(id);
      if (cur.base == null && d.b != null) cur.base = d.b;
      Object.assign(cur.lv, d.l || {});
    }
  }

  const getCatalogItems = db.prepare('SELECT item_id FROM customer_catalog WHERE customer_id = ? AND present = 1');
  const setPrice = db.prepare('UPDATE customer_catalog SET price = ? WHERE customer_id = ? AND item_id = ?');

  const report = { customersUpdated: 0, pricesSet: 0, usedBase: 0, noPrice: 0, unmappedCustomers: [] };
  const tx = db.transaction(() => {
    for (const [name, levelCol] of Object.entries(PRICE_LIST.mapping)) {
      const cust = custByNorm.get(normalizeName(name));
      if (!cust) continue;
      const lidx = levelCol ? levelIdx.get(levelCol) : null;
      let any = false;
      for (const row of getCatalogItems.all(cust.id)) {
        const pd = priceByItem.get(row.item_id);
        if (!pd) { report.noPrice++; continue; }
        let price = (lidx != null && pd.lv[lidx] != null) ? pd.lv[lidx] : pd.base;
        if (lidx != null && pd.lv[lidx] == null) report.usedBase++;
        if (!levelCol) report.usedBase++;
        if (price == null) { report.noPrice++; continue; }
        setPrice.run(price, cust.id, row.item_id);
        report.pricesSet++; any = true;
      }
      if (!levelCol) report.unmappedCustomers.push(name);
      if (any) report.customersUpdated++;
    }
  });
  tx();
  res.json({ ok: true, ...report });
});

// GET /api/customers/verify-price-list — check that each store's catalog prices
// match the price list for their level. Reports any mismatches.
router.get('/verify-price-list', (req, res) => {
  const { PRICE_LIST } = require('../customerPriceList');
  const { normalizeName } = require('../shiptoSeed');
  const levelIdx = new Map(PRICE_LIST.levels.map((c, i) => [c, String(i)]));
  const customers = db.prepare('SELECT id, name FROM customers').all();
  const custByNorm = new Map(customers.map(c => [normalizeName(c.name), c]));
  const items = db.prepare('SELECT id FROM items').all();
  const validIds = new Set(items.map(i => i.id));
  const normId = s => String(s).trim().toLowerCase();
  const idByNorm = new Map(items.map(i => [normId(i.id), i.id]));
  const resolveSku = sku => validIds.has(sku) ? sku : (idByNorm.get(normId(sku)) || idByNorm.get(normId(sku.toLowerCase().endsWith('c') ? sku.slice(0, -1) : sku + 'c')) || null);
  const priceByItem = new Map();
  for (const [sku, d] of Object.entries(PRICE_LIST.prices)) {
    const id = resolveSku(sku); if (!id) continue;
    if (!priceByItem.has(id)) priceByItem.set(id, { base: d.b, lv: d.l || {} });
    else { const cur = priceByItem.get(id); if (cur.base == null && d.b != null) cur.base = d.b; Object.assign(cur.lv, d.l || {}); }
  }
  const getCat = db.prepare('SELECT item_id, price FROM customer_catalog WHERE customer_id = ? AND present = 1');
  let checked = 0, matches = 0;
  const mismatches = [];
  for (const [name, levelCol] of Object.entries(PRICE_LIST.mapping)) {
    const cust = custByNorm.get(normalizeName(name)); if (!cust) continue;
    const lidx = levelCol ? levelIdx.get(levelCol) : null;
    for (const row of getCat.all(cust.id)) {
      const pd = priceByItem.get(row.item_id); if (!pd) continue;
      const expected = (lidx != null && pd.lv[lidx] != null) ? pd.lv[lidx] : pd.base;
      if (expected == null) continue;
      checked++;
      if (row.price != null && Math.abs(row.price - expected) < 0.005) matches++;
      else if (mismatches.length < 200) mismatches.push({ customer: name, item: row.item_id, appPrice: row.price, listPrice: expected });
    }
  }
  res.json({ checked, matches, mismatchCount: checked - matches, mismatches });
});

module.exports = router;