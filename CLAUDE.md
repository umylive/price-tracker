# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Price Tracker** is a self-hosted product price tracker for Amazon Saudi Arabia (amazon.sa), designed to run on Unraid via Docker. Users add items by URL or ASIN, the app scrapes prices on a schedule, stores historical data, and sends Telegram notifications on price drops or restock events.

## Running the App

```bash
cd price-tracker-build/price-tracker-app
docker-compose up -d --build   # build and start
docker-compose down            # stop
docker logs price-tracker      # check logs
docker restart price-tracker   # restart
```

App is accessible at `http://localhost:8766` (host port mapped to internal 3000).

For local backend-only development:
```bash
cd price-tracker-build/price-tracker-app/backend
DATA_DIR=../../../data node server.js
```

No test suite, no linter. The only npm script is `start`.

## Deployment

Deployed to Unraid by pulling from GHCR:
```
ghcr.io/umylive/price-tracker:latest
```
Every push to `main` touching `price-tracker-build/**` or `.github/workflows/docker-build.yml` triggers the workflow, which builds `linux/amd64` and pushes three tags (`latest`, short SHA, timestamp) via `docker/metadata-action`. Layer caching (`type=gha`) is enabled. Also manually triggerable via `workflow_dispatch` — use this if the build doesn't fire on the first push to a new repo (a known GitHub quirk).

## Architecture

```
price-tracker-build/price-tracker-app/
├── backend/
│   ├── server.js      # All Express routes
│   ├── database.js    # SQLite schema, WAL mode, session cleanup
│   ├── auth.js        # bcrypt, session cookies, rate limiting
│   ├── scraper.js     # Amazon SA scraper (axios + cheerio)
│   └── scheduler.js   # node-cron price check loop + Telegram sender
├── frontend/
│   ├── index.html     # Entire SPA — vanilla JS, Chart.js from CDN
│   ├── sw.js          # Service worker (stale-while-revalidate, no API cache)
│   └── manifest.json  # PWA manifest
├── Dockerfile         # node:20-alpine + tini
└── docker-compose.yml # port 8766→3000, volume /mnt/user/appdata/price-tracker:/data
```

**DB driver**: `better-sqlite3` — synchronous. All `db.prepare(...).get/all/run()` calls are blocking.

## Key Architectural Patterns

**Auth**: Cookie-based sessions (30-day, httpOnly). First user to `/api/auth/register` becomes admin; registration then closes.

**Scraper** (`scraper.js`): Fetches Amazon SA product pages via `axios` with rotating user agents and browser-like headers. Tries JSON-LD structured data first (most reliable), falls back to CSS selector parsing. Retries 3× with backoff. Returns `{ title, price, originalPrice, currency, sellerName, isAmazonDirect, isPrime, inStock, imageUrl }`. Use the English URL prefix (`/-/en/dp/ASIN`) to get consistent English content and Western numerals. CAPTCHA detection breaks the retry loop immediately.

**Scheduler** (`scheduler.js`): Uses `node-cron` with an interval stored in `settings.check_interval` (minutes). `restartScheduler()` rebuilds the cron expression when the interval changes. Checks items sequentially with a 3–5s random delay between each to avoid rate limiting.

**Telegram notifications**: Uses the Bot API directly via `fetch`. Sends HTML-formatted messages. Notifications are sent when:
- Price drops by ≥ `items.notify_drop_percent` (default 5%), OR
- Price hits or goes below `items.target_price`
- Item transitions from out-of-stock to in-stock (if enabled in settings)

**ASIN normalization**: `normalizeUrl(input)` in `scraper.js` accepts a full amazon.sa URL or a bare 10-char ASIN and always returns a canonical `https://www.amazon.sa/-/en/dp/{ASIN}` URL.

**Frontend state**: Single `state` object with `user`, `items`, `checking` (Set of item IDs being checked). `renderDashboard()` rewrites `#app` on every data change. Sheets (bottom drawers) use CSS transforms; only one sheet open at a time. Chart.js instance stored in `state.sheetChart` and destroyed before reopening.

**Seller detection**: `is_amazon_direct` in `price_history` is set to 1 when the merchant text contains "ships from and sold by amazon" or the seller name starts with "Amazon". Shown as a badge on each item card.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Internal server port |
| `DATA_DIR` | `/data` | SQLite DB root |
| `TZ` | — | Timezone (docker-compose sets `Asia/Riyadh`) |

## Database Schema

- `users` → `items` (user_id FK) → `price_history` (item_id FK)
- `items` → `notifications` (item_id FK)
- `sessions`, `login_attempts` — auth only
- `settings` — key/value store: `telegram_bot_token`, `telegram_chat_id`, `check_interval`, `notify_price_drop`, `notify_back_in_stock`

## API Surface

**Auth**: `GET /api/auth/status`, `POST /api/auth/register|login|logout`

**Items**: `GET /api/items`, `POST /api/items`, `PUT /api/items/:id`, `DELETE /api/items/:id`

**Checks**: `POST /api/items/:id/check` (manual), `POST /api/settings/check-all` (all active, background)

**History**: `GET /api/items/:id/history?limit=200`

**Settings**: `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/test-telegram`

**Notifications**: `GET /api/notifications`

## Adding More Stores

To add Noon or AliExpress later:
1. Add a `scrapeNoon(url)` / `scrapeAliExpress(url)` function to `scraper.js`
2. Add store detection in `normalizeUrl()` based on domain
3. Add the store name to the `items.store` column values
4. Update `checkItem()` in `scheduler.js` to route to the right scraper by `item.store`
5. Update the frontend Add Item sheet to hint about supported stores
