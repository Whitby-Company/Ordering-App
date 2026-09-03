// Consolidate box+case SKU pairs into a single item.
// For each "BRAND:code" (box) that has a matching "BRAND:codec" (case):
//   - set box.case_size = casePack / boxPack (boxes per case)
//   - set box.case_price = case per-each price
//   - move each store's case-catalog entry onto the box item with unit='case'
//     (keeping their price); mark box catalog entries unit='box'
//   - deactivate the case item and remove it from catalogs (kept for history)
// Runs as a dry-run (preview) unless apply=true.
function consolidate(db, { apply = false } = {}) {
  const items = db.prepare('SELECT id, name, brand, pack, price, active FROM items').all();
  const byId = new Map(items.map(i => [i.id, i]));

  const pairs = [];
  const skipped = [];
  for (const it of items) {
    if (!it.id.includes(':')) continue;
    const [brand, code] = it.id.split(':');
    if (!code.toLowerCase().endsWith('c')) continue;
    const baseId = `${brand}:${code.slice(0, -1)}`;
    const box = byId.get(baseId);
    if (!box) continue; // lone-c item, not a pair — leave it alone
    const caseItem = it;
    const bp = Number(box.pack) || 0;
    const cp = Number(caseItem.pack) || 0;
    if (!bp || !cp || cp % bp !== 0) { skipped.push({ box: baseId, case: caseItem.id, reason: 'bad pack ratio' }); continue; }
    pairs.push({ boxId: baseId, boxPack: bp, boxPrice: box.price, caseId: caseItem.id, casePack: cp, casePrice: caseItem.price, caseSize: cp / bp, name: box.name });
  }

  const report = { pairs: pairs.length, skipped, applied: apply, changes: [] };

  if (apply) {
    const setBox = db.prepare('UPDATE items SET case_size = ?, case_price = ? WHERE id = ?');
    const deactivate = db.prepare('UPDATE items SET active = 0 WHERE id = ?');
    const boxUnit = db.prepare("UPDATE customer_catalog SET unit = 'box' WHERE item_id = ? AND (unit IS NULL)");
    const moveCase = db.prepare(
      `INSERT INTO customer_catalog (customer_id, item_id, present, price, unit)
       VALUES (?, ?, 1, ?, 'case')
       ON CONFLICT(customer_id, item_id) DO UPDATE SET present = 1, unit = 'case',
         price = COALESCE(customer_catalog.price, excluded.price)`
    );
    const caseEntries = db.prepare('SELECT customer_id, price FROM customer_catalog WHERE item_id = ? AND present = 1');
    const delCase = db.prepare('DELETE FROM customer_catalog WHERE item_id = ?');

    const tx = db.transaction(() => {
      for (const p of pairs) {
        setBox.run(p.caseSize, p.casePrice, p.boxId);
        boxUnit.run(p.boxId);
        // move each store that carried the case SKU onto the box item as 'case'
        for (const e of caseEntries.all(p.caseId)) {
          moveCase.run(e.customer_id, p.boxId, e.price);
        }
        delCase.run(p.caseId);   // remove case SKU from all catalogs
        deactivate.run(p.caseId); // retire the case item (kept for history)
        report.changes.push({ boxId: p.boxId, caseId: p.caseId, caseSize: p.caseSize });
      }
    });
    tx();
  } else {
    report.changes = pairs.map(p => ({ boxId: p.boxId, caseId: p.caseId, name: p.name, boxPack: p.boxPack, casePack: p.casePack, caseSize: p.caseSize, boxPrice: p.boxPrice, casePrice: p.casePrice }));
  }

  return report;
}

module.exports = { consolidate };
