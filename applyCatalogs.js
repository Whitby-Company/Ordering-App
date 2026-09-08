// Shared logic to load the QuickBooks-derived per-store catalogs and prices into
// the customer_catalog table. Used by both the /apply-catalogs and
// /apply-price-list endpoints AND by seed.js, so a database reset re-populates
// customer-specific pricing automatically (no manual endpoint runs needed).

const { normalizeName } = require('./shiptoSeed');

// Load each store's catalog items + per-each prices from the QB history.
function applyCatalogs(db) {
  const { CUSTOMER_CATALOGS } = require('./customerCatalogs');
  const customers = db.prepare('SELECT id, name FROM customers').all();
  const custByNorm = new Map();
  for (const c of customers) custByNorm.set(normalizeName(c.name), c);
  const items = db.prepare('SELECT id, pack FROM items').all();
  const normId = s => String(s).trim().toLowerCase();
  const itemByNorm = new Map();
  for (const it of items) itemByNorm.set(normId(it.id), it);
  const matchItem = sku => {
    const cands = [sku, sku.toLowerCase().endsWith('c') ? sku.slice(0, -1) : sku + 'c'];
    for (const v of cands) { const hit = itemByNorm.get(normId(v)); if (hit) return hit; }
    return null;
  };
  const perEach = (unit, unitPrice, pack) => {
    if (unitPrice == null) return null;
    const p = Number(pack) || 1;
    if (unit === 'ea') return unitPrice;
    if (unit === 'cs') return p ? unitPrice / p : null;
    return null;
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
      clearCat.run(cust.id);
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
  return report;
}

// Overwrite each store's catalog prices from the confirmed price list at their
// mapped level (or base when unmapped). Only touches items already in the store's
// catalog, so run applyCatalogs() first.
function applyPriceList(db) {
  const { PRICE_LIST } = require('./customerPriceList');
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
  return report;
}

module.exports = { applyCatalogs, applyPriceList };
