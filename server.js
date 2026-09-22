const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const db = require('./db');

const customersRouter = require('./routes/customers');
const itemsRouter = require('./routes/items');
const ordersRouter = require('./routes/orders');
const purchaseOrdersRouter = require('./routes/purchaseOrders');
const savedReportsRouter = require('./routes/savedReports');
const brandColorsRouter = require('./routes/brandColors');
const brandSettingsRouter = require('./routes/brandSettings');
const printOrderRouter = require('./routes/printOrder');
const priceChecksRouter = require('./routes/priceChecks');
const podUploadsRouter = require('./routes/podUploads');

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
app.use('/api/purchase-orders', purchaseOrdersRouter);
app.use('/api/saved-reports', savedReportsRouter);
app.use('/api/brand-colors', brandColorsRouter);
app.use('/api/brand-settings', brandSettingsRouter);
app.use('/api/price-checks', priceChecksRouter);
app.use('/api/pod-uploads', podUploadsRouter);
app.use('/api/print-order', printOrderRouter);

// Basic error handler so uncaught errors return JSON, not an HTML crash page
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Something went wrong on the server' });
});

const PORT = process.env.PORT || 3001;
app.listen(PORT, () => {
  console.log(`Inventory/order API running on port ${PORT}`);
});

// Permanently record any order shipments whose delivery date has arrived,
// so on-hand stock is a real recorded log rather than something recomputed
// live. Run once immediately (catches up anything missed while the server
// was down) and then on a timer, since there's no external scheduled-job
// infrastructure for this app to hook a midnight rollover into.
function runShipmentRollover() {
  try {
    const result = db.rollForwardShipments();
    if (result.processed > 0) console.log(`Rolled forward ${result.processed} shipment(s) to stock_log`);
  } catch (err) {
    console.error('Shipment rollover failed:', err);
  }
}
runShipmentRollover();
setInterval(runShipmentRollover, 30 * 60 * 1000); // every 30 minutes
