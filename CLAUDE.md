# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

**Price Tracker** is a self-hosted price tracker for **Amazon Saudi Arabia** (amazon.sa), designed to run on Unraid via Docker. Users add items by URL or ASIN, the app scrapes prices on a schedule, stores historical data, sends Telegram notifications on price drops or restock events, and tracks purchase savings.

## Running the App

```bash
cd price-tracker-build/price-tracker-app
docker compose up -d --build   # build and start  (use "docker compose", not "docker-compose")
docker compose down            # stop
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

Every push to `main` touching `price-tracker-build/**` or `.github/workflows/docker-build.yml` triggers the workflow, which builds `linux/amd64` and pushes three tags (`latest`, short SHA, timestamp) to `ghcr.io/umylive/price-tracker`. Layer caching (`type=gha`) is enabled. Also manually triggerable via `workflow_dispatch`.

## Architecture

```
price-tracker-build/price-tracker-app/
├── backend/
│   ├── server.js      # All Express routes
│   ├── database.js    # SQLite schema, WAL mode, migrations, session cleanup
│   ├── auth.js        # bcrypt, session cookies, rate limiting
│   ├── scraper.js     # Amazon SA scraper + normalizeUrl
│   └── scheduler.js   # node-cron price check loop + Telegram sender
├── frontend/
│   ├── index.html     # Entire SPA — vanilla JS, Chart.js from CDN
│   ├── sw.js          # Service worker (stale-while-revalidate, no API cache)
│   └── manifest.json  # PWA manifest
├── Dockerfile         # node:20-alpine + tini + python3/make/g++ (for better-sqlite3)
└── docker-compose.yml # port 8766→3000, volume /mnt/user/appdata/price-tracker:/data
```

**DB driver**: `better-sqlite3` — synchronous. All `db.prepare(...).get/all/run()` calls are blocking; never use `await` for DB calls.

## Key Architectural Patterns

**Auth**: Cookie-based sessions (30-day, httpOnly), stored in the `sessions` table. First user to `/api/auth/register` becomes admin; registration then closes. Rate limiting: 5 failures → 15-min lockout per username+IP.

**Scraper** (`scraper.js`): `scrapeAmazonSA` uses `axios` with rotating user agents, retries 3× with backoff, and returns `{ title, price, originalPrice, currency, sellerName, isAmazonDirect, isPrime, inStock, imageUrl, hasOtherSellers, otherSellersPrice }`. Tries JSON-LD first; if JSON-LD has a title but **no seller**, the scraper runs `parseCssSelectors` a second time and merges in the seller/prime/stock/image fields — because JSON-LD frequently omits seller info. Full CSS fallback is used only when JSON-LD has no title. Uses the English URL prefix (`/-/en/dp/ASIN`) for consistent content. CAPTCHA detection breaks the retry loop immediately. `parsePrice()` strips Arabic-Indic digits so both numeral systems work. When `inStock` is false, `parseCssSelectors` additionally scans `#olp_feature_div` and `#mbc-main` to detect other sellers and their price.

**`normalizeUrl(input)`**: accepts a full amazon.sa URL or bare 10-char ASIN. Returns `{ url, asin, store: 'amazon_sa' }` normalised to `https://www.amazon.sa/-/en/dp/{ASIN}`, or `null` for unrecognised input.

**Scheduler** (`scheduler.js`): Single `node-cron` task with interval from `settings.check_interval` (minutes). Items run sequentially with a **60-second delay** between each. `runAllChecks()` serves the "Check All Now" button. All paths are try/catch-wrapped to prevent FK errors (item deleted mid-check) from crashing the process.

**Telegram notifications**: Bot token from `process.env.TELEGRAM_BOT_TOKEN` first, falling back to the `settings` table. Fires on price drop ≥ `items.notify_drop_percent` (default 5%), target price hit, or back-in-stock transition.

**Frontend state** (`index.html`): Single `state` object — `{ user, items, purchasedItems, checking, sheetChart, sort, groupBy, view }`. `renderDashboard()` rewrites `#app` on every data change. `state.view` is `'main'` or `'purchased'`; switching to `'purchased'` calls `loadPurchasedItems()` which populates `state.purchasedItems` then re-renders. Sheets (bottom drawers) use CSS transforms; only one open at a time. Chart.js instance stored in `state.sheetChart` and destroyed before reopening.

**Purchased items flow**: When a user clicks "Bought" on a card and saves a price+date, `POST /api/items/:id/purchases` inserts a `purchases` row **and** sets `items.is_purchased = 1`. `GET /api/items` filters `WHERE is_purchased = 0`, so the item disappears from the main tracking list. `GET /api/purchased-items` returns items where `is_purchased = 1`, joined with their latest purchase and all-time price stats. `PUT /api/purchased-items/:id/restore` resets `is_purchased = 0`.

**Category grouping** (`detectCategory` in `index.html`): Keyword-regex on item name returns a category string (Mobile Phones, Tablets, Laptops & PCs, Chairs & Seating, Furniture, TVs & Monitors, Audio, Cameras, Home Appliances, Kitchen, Gaming, Tech Accessories, etc.). Used by the "Category" group-by option in the sort/group bar. Groups only appear for categories that have actual items.

**Card highlight logic** (`renderCard`): Three CSS classes applied based on price data — `.highlight-low` (blue, new all-time low: current price ≤ lowestPrice and prevPrice > lowestPrice), `.highlight-sale` (orange, Amazon shows crossed-out original_price), `.highlight-drop` (green, current price ≥5% below historical peak). The `changeHtml` badge shows **`-X% off`** when `original_price > currentPrice` (Amazon's stated discount from the list price); otherwise falls back to `↓ X.X% from peak`. A separate **`List: SAR X,XXX`** line (muted, strikethrough) appears below the current price when `original_price` is present. The prev-check strikethrough (`card-was`) is suppressed when a list price is already shown. Seller badge shows the actual `seller_name` for all sellers including Amazon entities (not hardcoded as "Amazon SA").

**Stats bar** (7 tiles): Items Tracked, In Stock, On Sale, Price Drops (≥5% below peak), New All-Time Low (current = all-time low, just dropped there), At Target, Portfolio Value.

**Seller detection**: `is_amazon_direct` in `price_history` is set to 1 when any of these match in the combined text of `#merchant-info`, `#tabular-buybox`, `#buybox`, `#shipsFromSoldBy_feature_div`, `#sellerProfileTriggerId`: "ships from/dispatched and sold by amazon", "sold by amazon.sa", "fulfilled by amazon", bare "amazon.sa". Seller element selectors also include `#merchant-info a` and `#tabular-buybox-container .tabular-buybox-text`. When `isAmazonDirect = true` but no seller element text is found, `sellerName` is set to `'Amazon.sa'` in the return value. `has_other_sellers` / `other_sellers_price` are scraped when the main listing is OOS and other-seller sections are present. Chart colours: blue for Amazon direct, orange for third-party.

## Critical Frontend Gotcha: Template Literals

`frontend/index.html` is one large `<script>` block. **Raw backtick characters inside any `innerHTML = \`...\`` template literal will terminate the string early**, causing a blank blue screen. Always use HTML entities (e.g. `&#x2193;` instead of `↓` when building strings by concatenation) or restructure — never put a bare `` ` `` inside a template literal string value. Note: nested template literals in JS source (inside `${}`) are valid and safe; the problem is only literal backtick characters in *values* embedded in strings.

## SQLite Timestamp Gotcha

`datetime('now')` returns UTC as `YYYY-MM-DD HH:MM:SS` with no timezone indicator. JavaScript's `new Date()` treats such strings as **local time**, so always append `'Z'` before parsing:

```js
const ts = iso.includes('T') ? iso : iso.replace(' ', 'T') + 'Z';
new Date(ts).getTime();
```

`relativeTime()` and `fmtDate()` in `frontend/index.html` already handle this. `fmtDate()` also handles bare `YYYY-MM-DD` strings (from `<input type="date">`) by extracting parts directly to avoid timezone shifting.

## Database Schema

```
users → items (user_id FK CASCADE)
          ├── price_history (item_id FK CASCADE)
          ├── notifications (item_id FK CASCADE)
          └── purchases     (item_id FK CASCADE)
sessions, login_attempts — auth only
settings — key/value: telegram_bot_token, telegram_chat_id, check_interval, notify_price_drop, notify_back_in_stock
```

**items** key columns: `active`, `is_purchased` (0 = tracking, 1 = bought/hidden from main list), `target_price`, `notify_drop_percent`, `asin`, `store`.

**price_history** key columns: `price`, `original_price`, `currency`, `seller_name`, `is_amazon_direct`, `is_prime`, `in_stock`, `has_other_sellers`, `other_sellers_price`, `error`, `checked_at`.

**purchases**: `item_id`, `purchased_price`, `currency`, `purchased_at`, `notes`.

All columns added after initial release are done as `ALTER TABLE` migrations in `database.js` (checked with `PRAGMA table_info` before running). `foreign_keys = ON` is set at startup.

## API Response Shapes

`GET /api/items` (excludes `is_purchased = 1`) returns each item enriched with:
- `latest` — most recent `price_history` row where `error IS NULL`
- `prevPrice` — second-most-recent non-error price
- `lowestPrice`, `highestPrice` — all-time stats
- `lastError` — most recent error string

`GET /api/purchased-items` returns items where `is_purchased = 1`, each enriched with the most recent `purchases` row fields (`purchased_price`, `currency`, `purchased_at`, `notes`) plus `highest_price` and `lowest_price`.

`GET /api/notifications` joins `notifications` with `items`, adding `item_name` and `item_url`.

## API Surface

**Auth**: `GET /api/auth/status`, `POST /api/auth/register|login|logout`

**Items**: `GET /api/items`, `POST /api/items`, `PUT /api/items/:id`, `DELETE /api/items/:id`

**Checks**: `POST /api/items/:id/check`, `POST /api/settings/check-all`

**History**: `GET /api/items/:id/history?limit=200`

**Purchases**: `POST /api/items/:id/purchases`, `DELETE /api/purchases/:id`

**Purchased items**: `GET /api/purchased-items`, `PUT /api/purchased-items/:id/restore`

**Settings**: `GET /api/settings`, `PUT /api/settings`, `POST /api/settings/test-telegram`

**Notifications**: `GET /api/notifications`

All non-`/api` routes serve `frontend/index.html` (SPA fallback).

## Environment Variables

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | Internal server port |
| `DATA_DIR` | `/data` | SQLite DB root |
| `TZ` | — | Timezone (docker-compose sets `Asia/Riyadh`) |
| `TELEGRAM_BOT_TOKEN` | — | Takes priority over the value stored in settings table |

## Adding Another Store

1. Add a `scrapeNoon(url)` function to `scraper.js` (model after `scrapeAmazonSA`), returning the same shape including `hasOtherSellers`/`otherSellersPrice`
2. Add domain detection in `normalizeUrl()` returning `{ url, asin: null, store: 'noon' }`
3. Route by `item.store` in `checkItem()` in `scheduler.js`
4. Update `storeLabel(item)` and `storeColor(item)` in `frontend/index.html`
5. Update `detectCategory()` if the store surfaces different product types
