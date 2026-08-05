# Inventory & Order API

The backend for the mobile order-entry app: customers, live inventory, and
orders. Submitting an order decrements stock automatically, in one atomic
transaction — two people can't accidentally oversell the same item.

## What's here

- `server.js` — the Express app
- `db.js` — SQLite schema (customers, items, orders, order_lines)
- `seed.js` — loads starter customers/items (run once)
- `routes/` — the three route groups: customers, items, orders

## Run it locally (optional, to try before deploying)

```
npm install
npm run seed      # loads starter customers + items, safe to re-run
npm start         # starts the API on http://localhost:3001
```

Quick check it's alive: open `http://localhost:3001/api/health` — should
return `{"ok":true}`.

## API summary

| Method | Path | What it does |
|---|---|---|
| GET | `/api/customers` | List all customers |
| POST | `/api/customers` | Add a customer `{ name }` |
| GET | `/api/items` | List items (optional `?brand=Nike`, `?lowStockMax=5`) |
| GET | `/api/items/brands` | Brand list with item counts |
| POST | `/api/items` | Add an item `{ id, brand, name, stock }` |
| PATCH | `/api/items/:id` | Manually correct stock `{ stock }` |
| GET | `/api/orders` | List all orders with line items, newest first |
| POST | `/api/orders` | Submit an order — decrements stock |

## Deploying to Render (recommended, free/cheap tier)

1. **Push this folder to a GitHub repo.** (Render deploys from GitHub.) If
   you don't already use GitHub, create a free account at github.com, make a
   new repository, and upload this `inventory-backend` folder to it.

2. **Create a Render account** at render.com (free).

3. **New → Web Service**, connect the GitHub repo you just created.

4. Render will detect it's a Node app. Set:
   - **Build command:** `npm install`
   - **Start command:** `npm start`

5. **Add a persistent disk** (Settings → Disks → Add Disk). This is the
   important part — without it, your database resets every time you deploy
   or the service restarts.
   - Mount path: `/data`
   - Size: 1 GB is more than enough for years of this data

6. **Add an environment variable:** `DB_PATH` = `/data/data.db`
   (This tells the app to store the database on the persistent disk instead
   of the default location, which Render wipes on redeploy.)

7. Deploy. Once it's live, open a terminal from Render's dashboard (Shell
   tab) and run `npm run seed` once, to load the starter customers/items.

8. Render gives you a URL like `https://your-app-name.onrender.com` — that's
   your API's address. The frontend will need this URL to talk to it (next
   step).

**Cost:** Render's free web service tier works, but spins down when idle
and takes ~30-60 seconds to wake up on the next request — noticeable but
not broken. The $7/month "Starter" tier keeps it always-on if that delay
would bother your sales team mid-order. The persistent disk itself is a
few cents/month for 1GB.

## What's next

This API is ready, but the frontend prototype isn't calling it yet — it's
still using fake in-memory data. The next step is wiring the React app up
to these endpoints so orders, inventory, and customers are real and shared
across your whole team.
