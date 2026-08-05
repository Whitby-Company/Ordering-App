// seed.js — one-time script to load starter data.
// Run with: npm run seed
// Safe to re-run: uses INSERT OR IGNORE, so it won't duplicate rows or
// overwrite stock counts you've already changed through the app.

const db = require('./db');

const CUSTOMERS = [
  'Coastal Outfitters',
  'Summit Sports Co.',
  'Trailhead Supply',
  'Downtown Athletics',
  'Riverside Goods',
  'Peak Performance Retail',
];

const ITEMS = [
  { id: 'NK-AM90-10', brand: 'Nike', name: 'Air Max 90, Size 10', stock: 24 },
  { id: 'NK-AM90-11', brand: 'Nike', name: 'Air Max 90, Size 11', stock: 18 },
  { id: 'NK-DUNK-9', brand: 'Nike', name: 'Dunk Low, Size 9', stock: 6 },
  { id: 'NK-PGSSK', brand: 'Nike', name: 'Pegasus Sock, 3-Pack', stock: 40 },
  { id: 'AD-UB-10', brand: 'Adidas', name: 'Ultraboost, Size 10', stock: 15 },
  { id: 'AD-SST-9', brand: 'Adidas', name: 'Samba OG, Size 9', stock: 3 },
  { id: 'AD-SST-10', brand: 'Adidas', name: 'Samba OG, Size 10', stock: 22 },
  { id: 'AD-TRK', brand: 'Adidas', name: 'Firebird Track Jacket, M', stock: 12 },
  { id: 'PM-CLS-9', brand: 'Puma', name: 'Suede Classic, Size 9', stock: 9 },
  { id: 'PM-CLS-10', brand: 'Puma', name: 'Suede Classic, Size 10', stock: 5 },
  { id: 'PM-CAP', brand: 'Puma', name: 'Logo Cap, One Size', stock: 30 },
];

const insertCustomer = db.prepare('INSERT OR IGNORE INTO customers (name) VALUES (?)');
const insertItem = db.prepare(
  'INSERT OR IGNORE INTO items (id, brand, name, stock) VALUES (@id, @brand, @name, @stock)'
);

const run = db.transaction(() => {
  for (const name of CUSTOMERS) insertCustomer.run(name);
  for (const item of ITEMS) insertItem.run(item);
});

run();

console.log(`Seeded ${CUSTOMERS.length} customers and ${ITEMS.length} items.`);
