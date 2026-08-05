const express = require('express');
const cors = require('cors');

const customersRouter = require('./routes/customers');
const itemsRouter = require('./routes/items');
const ordersRouter = require('./routes/orders');

const app = express();
app.use(cors());
app.use(express.json());

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
