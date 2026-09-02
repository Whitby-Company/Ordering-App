// seed.js — loads the real customer & item lists (from QuickBooks exports)
// and REPLACES whatever is currently in the customers/items tables.
//
// Run with: npm run seed
//
// This wipes existing customers, items, and any orders/order_lines that
// reference them (orders reference customers and items by id, so they
// can't be kept once those rows are replaced). Safe to re-run any time
// you want to reload from seed-data.json — it always starts from a clean
// slate rather than merging.

const db = require('./db');
const data = require('./seed-data.json');

const insertCustomer = db.prepare('INSERT INTO customers (name, active) VALUES (@name, @active)');
const insertItem = db.prepare(
  'INSERT INTO items (id, brand, name, stock, price, pack, packLabel, imageUrl, active) VALUES (@id, @brand, @name, @stock, @price, @pack, @packLabel, @imageUrl, @active)'
);

const run = db.transaction(() => {
  db.exec('DELETE FROM order_lines');
  db.exec('DELETE FROM orders');
  db.exec('DELETE FROM items');
  db.exec('DELETE FROM customers');

  for (const c of data.customers) {
    insertCustomer.run({ name: c.name, active: c.active === false ? 0 : 1 });
  }
  for (const item of data.items) {
    insertItem.run({
      ...item,
      pack: item.pack || 1,
      packLabel: item.packLabel || null,
      imageUrl: item.imageUrl || null,
      active: item.active === false ? 0 : 1,
    });
  }
});

run();

// Now that customers exist, fill in their built-in ship-to addresses.
if (typeof db.seedShipToOnce === 'function') db.seedShipToOnce();
// Roll out the per-store catalog defaults (mark active items default, activate customers).
if (typeof db.seedCatalogOnce === 'function') db.seedCatalogOnce();

const activeItems = data.items.filter(i => i.active !== false).length;
const activeCustomers = data.customers.filter(c => c.active !== false).length;
console.log(
  `Reset and seeded ${data.customers.length} customers (${activeCustomers} active) ` +
  `and ${data.items.length} items (${activeItems} active).`
);
console.log('Note: any previous orders were cleared since they referenced the old data.');
