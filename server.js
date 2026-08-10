const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');

const customersRouter = require('./routes/customers');
const itemsRouter = require('./routes/items');
const ordersRouter = require('./routes/orders');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' })); // raised for base64 product photo uploads

// Uploaded product photos live on the same persistent disk as the database
// (set IMAGES_DIR next to DB_PATH in production, e.g. /data/images) so they
// survive restarts/redeploys, and are served back out at /images/<file>.
const IMAGES_DIR = process.env.IMAGES_DIR || path.join(__dirname, 'data-images');
fs.mkdirSync(IMAGES_DIR, { recursive: true });
app.use('/images', express.static(IMAGES_DIR));
app.set('imagesDir', IMAGES_DIR);

app.get('/api/health', (req, res) => res.json({ ok: true }));

app.use('/api/customers', customersRouter);
app.use('/api/items', itemsRouter);
app.use('/api/orders', ordersRouter);

// Basic error handler so uncaught errors return JSON, not an HTML crash page
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Inventory/order API running on port ${PORT}`);
});
