# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Price Tracker** is a self-hosted product price tracker for **Amazon Saudi Arabia** (amazon.sa) and **AliExpress**, designed to run on Unraid via Docker. Users add items by URL or ASIN, the app scrapes prices on a schedule, stores historical data, and sends Telegram notifications on price drops or restock events.

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
│   ├── scraper.js     # Amazon SA + AliExpress scrapers, normalizeUrl
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

**Scraper** (`scraper.js`): Two scrapers — `scrapeAmazonSA` and `scrapeAliExpress` — both use `axios` with rotating user agents and browser-like headers, retry 3× with backoff, and return `{ title, price, originalPrice, currency, sellerName, isAmazonDirect, isPrime, inStock, imageUrl }`.

- **Amazon SA**: tries JSON-LD structured data first, falls back to CSS selector parsing. Uses the English URL prefix (`/-/en/dp/ASIN`) for consistent content and Western numerals. CAPTCHA detection breaks the retry loop immediately.
- **AliExpress**: five cascading strategies in order — (1) JSON-LD, (2) `window.runParams` embedded JSON via stack-based brace extraction, (3) `__NEXT_DATA__` (Next.js), (4) `og:` meta tags + regex price scan, (5) page `<title>` + raw currency-string scan as last resort. For variant/SKU products, strategy 2 iterates `skuModule.skuPriceList` and takes the minimum sale price. Scrapes `www.aliexpress.com` in English, so prices are **USD** — the frontend shows an approximate SAR conversion (`× 3.75`). `isAmazonDirect` and `isPrime` are always `false` for AliExpress items.

**`normalizeUrl(input)`** in `scraper.js`: accepts a full amazon.sa URL, a bare 10-char ASIN, or any `aliexpress.com` URL. Returns `{ url, asin, store }` where `store` is `'amazon_sa'` or `'aliexpress'`. Amazon always normalises to `https://www.amazon.sa/-/en/dp/{ASIN}`; AliExpress normalises to `https://www.aliexpress.com/item/{id}.html` (strips all query params and locale subdomains).

**Scheduler** (`scheduler.js`): Uses `node-cron` with an interval stored in `settings.check_interval` (minutes). `restartScheduler()` rebuilds the cron expression when the interval changes. `checkItem()` routes to the correct scraper by `item.store`. Checks items sequentially with a **60-second delay between each item** to avoid rate limiting.

**Telegram notifications**: Bot token is read from `process.env.TELEGRAM_BOT_TOKEN` first, falling back to the `settings` table. Chat ID is always read from the `settings` table. Uses the Bot API directly via `fetch` with HTML-formatted messages. Notification message builders (`buildDropMsg`, `buildStockMsg`) are store-aware — AliExpress items show the AliExpress seller name instead of Amazon-specific text. Notifications fire when:
- Price drops by ≥ `items.notify_drop_percent` (default 5%), OR price hits `items.target_price`
- Item transitions from out-of-stock to in-stock (if enabled in settings)

**Frontend state**: Single `state` object with `user`, `items`, `checking` (Set of item IDs being checked). `renderDashboard()` rewrites `#app` on every data change. Sheets (bottom drawers) use CSS transforms; only one sheet open at a time. Chart.js instance stored in `state.sheetChart` and destroyed before reopening. `storeLabel(item)` and `storeColor(item)` drive store-specific display (Amazon orange `#ff9900` vs AliExpress red `#e62e04`).

**Seller detection**: `is_amazon_direct` in `price_history` is set to 1 when the merchant text contains "ships from and sold by amazon" or the seller name starts with "Amazon". Always 0 for AliExpress. Shown as a badge on each item card.

## SQLite timestamp gotcha

`datetime('now')` returns UTC as `YYYY-MM-DD HH:MM:SS` with no timezone indicator. JavaScript's `new Date()` treats such strings as **local time**, so always append `'Z'` before parsing:

```js
const ts = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
new Date(ts).getTime();
```

The `relativeTime()` helper in `frontend/index.html` already does this.

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Internal server port |
| `DATA_DIR` | `/data` | SQLite DB root |
| `TZ` | — | Timezone (docker-compose sets `Asia/Riyadh`) |
| `TELEGRAM_BOT_TOKEN` | — | Optional — takes priority over the value stored in the settings table |

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

To add Noon or another store:
1. Add a `scrapeNoon(url)` function to `scraper.js` (model after `scrapeAliExpress`)
2. Add store detection in `normalizeUrl()` based on domain
3. Import and route in `checkItem()` in `scheduler.js` by `item.store` (the routing pattern is already there)
4. Add `storeLabel`/`storeColor` cases in `frontend/index.html`
5. Update the Add Item sheet hint text and the history sheet link/label logic
