const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./database');
const {
  hashPassword, verifyPassword, createSession, getSession,
  deleteSession, isRateLimited, recordLoginAttempt, requireAuth,
} = require('./auth');
const { scrapeAmazonSA, scrapeIkea, normalizeUrl } = require('./scraper');
const { startScheduler, restartScheduler, runAllChecks, checkItem, sendTelegram } = require('./scheduler');

const getSetting = k => db.prepare('SELECT value FROM settings WHERE key = ?').get(k)?.value || '';

const app = express();
const PORT = process.env.PORT || 3000;
const FRONTEND_DIR = path.join(__dirname, '..', 'frontend');

app.use(express.json());
app.use(cookieParser());
app.use(express.static(FRONTEND_DIR));

// ── Auth ──────────────────────────────────────────────────────────────────────

app.get('/api/auth/status', (req, res) => {
  const sessionId = req.cookies?.session;
  if (!sessionId) return res.json({ loggedIn: false });
  const session = getSession(sessionId);
  if (!session) return res.json({ loggedIn: false });
  res.json({ loggedIn: true, username: session.username, isAdmin: !!session.is_admin });
});

app.post('/api/auth/register', async (req, res) => {
  const count = db.prepare('SELECT COUNT(*) as c FROM users').get().c;
  if (count > 0) return res.status(403).json({ error: 'Registration is closed' });
  const { username, password } = req.body || {};
  if (!username?.trim() || !password) return res.status(400).json({ error: 'Username and password required' });
  if (password.length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });
  try {
    const hash = await hashPassword(password);
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO users (username, password_hash, is_admin) VALUES (?, ?, 1)'
    ).run(username.trim(), hash);
    const sessionId = createSession(lastInsertRowid);
    res.cookie('session', sessionId, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
    res.json({ ok: true, username: username.trim() });
  } catch (e) {
    if (e.message.includes('UNIQUE')) return res.status(400).json({ error: 'Username already taken' });
    console.error(e);
    res.status(500).json({ error: 'Server error' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const { username, password } = req.body || {};
  const ip = req.ip;
  if (!username || !password) return res.status(400).json({ error: 'Username and password required' });
  if (isRateLimited(username, ip)) {
    return res.status(429).json({ error: 'Too many failed attempts. Try again in 15 minutes.' });
  }
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username.trim());
  if (!user || !(await verifyPassword(password, user.password_hash))) {
    recordLoginAttempt(username, ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }
  const sessionId = createSession(user.id);
  res.cookie('session', sessionId, { httpOnly: true, maxAge: 30 * 24 * 3600 * 1000, sameSite: 'lax' });
  res.json({ ok: true, username: user.username });
});

app.post('/api/auth/logout', (req, res) => {
  const sessionId = req.cookies?.session;
  if (sessionId) deleteSession(sessionId);
  res.clearCookie('session');
  res.json({ ok: true });
});

// ── Items ─────────────────────────────────────────────────────────────────────

app.get('/api/items', requireAuth, (req, res) => {
  const items = db.prepare('SELECT * FROM items WHERE user_id = ? AND is_purchased = 0 ORDER BY created_at DESC').all(req.user.id);
  const result = items.map(item => {
    const latest = db.prepare(
      'SELECT * FROM price_history WHERE item_id = ? AND error IS NULL ORDER BY checked_at DESC LIMIT 1'
    ).get(item.id);
    const prev = db.prepare(
      'SELECT price FROM price_history WHERE item_id = ? AND error IS NULL AND price IS NOT NULL ORDER BY checked_at DESC LIMIT 1 OFFSET 1'
    ).get(item.id);
    const stats = db.prepare(
      'SELECT MIN(price) as lowest, MAX(price) as highest FROM price_history WHERE item_id = ? AND price IS NOT NULL AND error IS NULL'
    ).get(item.id);
    const lastError = db.prepare(
      'SELECT error FROM price_history WHERE item_id = ? AND error IS NOT NULL ORDER BY checked_at DESC LIMIT 1'
    ).get(item.id);
    return {
      ...item,
      latest: latest || null,
      prevPrice: prev?.price ?? null,
      lowestPrice: stats?.lowest ?? null,
      highestPrice: stats?.highest ?? null,
      lastError: lastError?.error ?? null,
    };
  });
  res.json(result);
});

app.post('/api/items', requireAuth, async (req, res) => {
  try {
    const { name, input, target_price, notify_drop_percent } = req.body || {};
    if (!input?.trim()) return res.status(400).json({ error: 'Product URL or ASIN is required' });

    const normalized = normalizeUrl(input.trim());
    if (!normalized) return res.status(400).json({ error: 'Could not parse a valid Amazon SA URL/ASIN or IKEA SA URL' });
    const { url, asin, store } = normalized;

    const activeExisting = db.prepare('SELECT id FROM items WHERE user_id = ? AND url = ? AND is_purchased = 0').get(req.user.id, url);
    if (activeExisting) return res.status(400).json({ error: 'This item is already being tracked' });

    let finalName = name?.trim() || null;
    let imageUrl = null;
    let scraped = null;
    try {
      scraped = store === 'ikea_sa' ? await scrapeIkea(url) : await scrapeAmazonSA(url);
      if (!finalName && scraped.title) finalName = scraped.title;
      imageUrl = scraped.imageUrl || null;
    } catch (e) {
      console.error('[add-item] Initial scrape failed:', e.message);
    }

    if (!finalName) {
      return res.status(400).json({
        error: 'Could not auto-detect product name (scraping failed). Please provide a name manually.',
      });
    }

    const safeNum = v => { const n = parseFloat(v); return Number.isFinite(n) ? n : null; };

    // If the item exists as a purchased item, restore it to tracking and add fresh price row
    const purchasedExisting = db.prepare('SELECT * FROM items WHERE user_id = ? AND url = ? AND is_purchased = 1').get(req.user.id, url);
    if (purchasedExisting) {
      db.prepare("UPDATE items SET is_purchased = 0, active = 1 WHERE id = ?").run(purchasedExisting.id);
      if (scraped) {
        const phRow = {
          item_id: purchasedExisting.id,
          price: safeNum(scraped.price),
          original_price: safeNum(scraped.originalPrice),
          currency: scraped.currency || 'SAR',
          seller_name: scraped.sellerName || null,
          is_amazon_direct: scraped.isAmazonDirect ? 1 : 0,
          is_prime: scraped.isPrime ? 1 : 0,
          in_stock: scraped.inStock ? 1 : 0,
          has_other_sellers: scraped.hasOtherSellers ? 1 : 0,
          other_sellers_price: safeNum(scraped.otherSellersPrice),
        };
        db.prepare(
          'INSERT INTO price_history (item_id, price, original_price, currency, seller_name, is_amazon_direct, is_prime, in_stock, has_other_sellers, other_sellers_price) VALUES (@item_id, @price, @original_price, @currency, @seller_name, @is_amazon_direct, @is_prime, @in_stock, @has_other_sellers, @other_sellers_price)'
        ).run(phRow);
        if (imageUrl && !purchasedExisting.image_url) {
          db.prepare('UPDATE items SET image_url = ? WHERE id = ?').run(imageUrl, purchasedExisting.id);
        }
        db.prepare("UPDATE items SET last_checked_at = datetime('now') WHERE id = ?").run(purchasedExisting.id);
      }
      console.log('[add-item] restored purchased item id:', purchasedExisting.id);
      return res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(purchasedExisting.id));
    }

    const itemRow = {
      user_id: req.user.id,
      name: finalName,
      url: url,
      asin: asin != null ? String(asin) : null,
      image_url: imageUrl != null ? String(imageUrl) : null,
      store: store,
      target_price: target_price != null ? safeNum(target_price) : null,
      notify_drop_percent: notify_drop_percent != null ? (safeNum(notify_drop_percent) ?? 5) : 5,
    };
    console.log('[add-item] inserting:', JSON.stringify(itemRow));
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO items (user_id, name, url, asin, image_url, store, target_price, notify_drop_percent) VALUES (@user_id, @name, @url, @asin, @image_url, @store, @target_price, @notify_drop_percent)'
    ).run(itemRow);

    if (scraped) {
      const phRow = {
        item_id: lastInsertRowid,
        price: safeNum(scraped.price),
        original_price: safeNum(scraped.originalPrice),
        currency: scraped.currency || 'SAR',
        seller_name: scraped.sellerName || null,
        is_amazon_direct: scraped.isAmazonDirect ? 1 : 0,
        is_prime: scraped.isPrime ? 1 : 0,
        in_stock: scraped.inStock ? 1 : 0,
        has_other_sellers: scraped.hasOtherSellers ? 1 : 0,
        other_sellers_price: safeNum(scraped.otherSellersPrice),
      };
      db.prepare(
        'INSERT INTO price_history (item_id, price, original_price, currency, seller_name, is_amazon_direct, is_prime, in_stock, has_other_sellers, other_sellers_price) VALUES (@item_id, @price, @original_price, @currency, @seller_name, @is_amazon_direct, @is_prime, @in_stock, @has_other_sellers, @other_sellers_price)'
      ).run(phRow);
      db.prepare("UPDATE items SET last_checked_at = datetime('now') WHERE id = ?").run(lastInsertRowid);
    }

    res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(lastInsertRowid));
  } catch (err) {
    console.error('[add-item] Error:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to add item: ' + err.message });
  }
});

app.put('/api/items/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const { name, target_price, notify_drop_percent, active } = req.body;
  db.prepare(`
    UPDATE items SET name = ?, target_price = ?, notify_drop_percent = ?, active = ? WHERE id = ?
  `).run(
    name ?? item.name,
    target_price !== undefined ? (target_price ? parseFloat(target_price) : null) : item.target_price,
    notify_drop_percent !== undefined ? parseFloat(notify_drop_percent) : item.notify_drop_percent,
    active !== undefined ? (active ? 1 : 0) : item.active,
    item.id
  );
  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(item.id));
});

app.delete('/api/items/:id', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM items WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

app.post('/api/items/:id/check', requireAuth, async (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  try {
    await checkItem(item);
    const latest = db.prepare(
      'SELECT * FROM price_history WHERE item_id = ? ORDER BY checked_at DESC LIMIT 1'
    ).get(item.id);
    res.json({ ok: true, latest });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.get('/api/items/:id/history', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const limit = Math.min(parseInt(req.query.limit) || 200, 500);
  const history = db.prepare(
    'SELECT * FROM price_history WHERE item_id = ? ORDER BY checked_at ASC LIMIT ?'
  ).all(item.id, limit);
  res.json({ item, history });
});

// ── Settings ──────────────────────────────────────────────────────────────────

app.get('/api/settings', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT key, value FROM settings').all();
  const settings = {};
  rows.forEach(r => {
    if (r.key === 'telegram_bot_token' && r.value && r.value.length > 8) {
      settings[r.key] = r.value.slice(0, 4) + '...' + r.value.slice(-4);
    } else {
      settings[r.key] = r.value;
    }
  });
  settings.telegram_via_env = !!process.env.TELEGRAM_BOT_TOKEN;
  res.json(settings);
});

app.put('/api/settings', requireAuth, (req, res) => {
  const allowed = ['telegram_bot_token', 'telegram_chat_id', 'check_interval', 'notify_price_drop', 'notify_back_in_stock']
    .filter(k => !(k === 'telegram_bot_token' && process.env.TELEGRAM_BOT_TOKEN));
  const update = db.prepare('UPDATE settings SET value = ? WHERE key = ?');
  const batch = db.transaction(updates => {
    for (const [key, value] of updates) {
      if (allowed.includes(key)) update.run(String(value), key);
    }
  });
  batch(Object.entries(req.body));
  if ('check_interval' in req.body) restartScheduler();
  res.json({ ok: true });
});

app.post('/api/settings/test-telegram', requireAuth, async (req, res) => {
  const token = process.env.TELEGRAM_BOT_TOKEN || getSetting('telegram_bot_token');
  const chatId = getSetting('telegram_chat_id');
  if (!token || !chatId) return res.status(400).json({ error: 'Telegram bot token and chat ID are not configured' });
  const ok = await sendTelegram(token, chatId,
    '✅ <b>Price Tracker — Test Notification</b>\n\nYour Telegram notifications are working correctly!'
  );
  if (ok) res.json({ ok: true });
  else res.status(500).json({ error: 'Failed to send. Check your bot token and chat ID.' });
});

app.post('/api/settings/check-all', requireAuth, async (req, res) => {
  res.json({ ok: true, message: 'Price check started in background' });
  runAllChecks().catch(e => console.error('[manual check-all]', e.message));
});

// ── Notifications ─────────────────────────────────────────────────────────────

app.get('/api/notifications', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT n.*, i.name as item_name, i.url as item_url
    FROM notifications n
    JOIN items i ON n.item_id = i.id
    WHERE i.user_id = ?
    ORDER BY n.sent_at DESC
    LIMIT 100
  `).all(req.user.id);
  res.json(rows);
});

// ── Purchased Items ───────────────────────────────────────────────────────────

app.get('/api/purchased-items', requireAuth, (req, res) => {
  // Show any item that has a purchase record, regardless of is_purchased status
  const items = db.prepare(`
    SELECT DISTINCT items.* FROM items
    INNER JOIN purchases ON purchases.item_id = items.id
    WHERE items.user_id = ?
    ORDER BY items.created_at DESC
  `).all(req.user.id);
  const result = items.map(item => {
    const purchase = db.prepare('SELECT * FROM purchases WHERE item_id = ? ORDER BY purchased_at DESC LIMIT 1').get(item.id);
    const stats = db.prepare('SELECT MIN(price) as lowest, MAX(price) as highest FROM price_history WHERE item_id = ? AND price IS NOT NULL AND error IS NULL').get(item.id);
    return {
      ...item,
      purchased_price: purchase?.purchased_price ?? null,
      currency: purchase?.currency ?? 'SAR',
      purchased_at: purchase?.purchased_at ?? null,
      notes: purchase?.notes ?? null,
      highest_price: stats?.highest ?? null,
      lowest_price: stats?.lowest ?? null,
    };
  });
  res.json(result);
});

app.put('/api/purchased-items/:id/restore', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  db.prepare('UPDATE items SET is_purchased = 0, active = 1 WHERE id = ?').run(item.id);
  res.json({ ok: true });
});

// ── Purchases ─────────────────────────────────────────────────────────────────

app.get('/api/purchases', requireAuth, (req, res) => {
  const rows = db.prepare(`
    SELECT p.*, i.name as item_name, i.url as item_url, i.image_url as item_image_url,
           (SELECT MAX(ph.price) FROM price_history ph WHERE ph.item_id = p.item_id AND ph.error IS NULL) as highest_price,
           (SELECT MIN(ph.price) FROM price_history ph WHERE ph.item_id = p.item_id AND ph.error IS NULL) as lowest_price
    FROM purchases p
    JOIN items i ON p.item_id = i.id
    WHERE i.user_id = ?
    ORDER BY p.purchased_at DESC
  `).all(req.user.id);
  res.json(rows);
});

app.post('/api/items/:id/purchases', requireAuth, (req, res) => {
  const item = db.prepare('SELECT * FROM items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!item) return res.status(404).json({ error: 'Not found' });
  const { purchased_price, currency, purchased_at, notes } = req.body || {};
  if (!purchased_price || isNaN(parseFloat(purchased_price))) {
    return res.status(400).json({ error: 'Purchase price is required' });
  }
  const { lastInsertRowid } = db.prepare(`
    INSERT INTO purchases (item_id, purchased_price, currency, purchased_at, notes)
    VALUES (?, ?, ?, COALESCE(?, datetime('now')), ?)
  `).run(item.id, parseFloat(purchased_price), currency || 'SAR', purchased_at || null, notes || null);
  db.prepare('UPDATE items SET is_purchased = 1 WHERE id = ?').run(item.id);
  res.json(db.prepare('SELECT * FROM purchases WHERE id = ?').get(lastInsertRowid));
});

app.delete('/api/purchases/:id', requireAuth, (req, res) => {
  const row = db.prepare(`
    SELECT p.* FROM purchases p JOIN items i ON p.item_id = i.id WHERE p.id = ? AND i.user_id = ?
  `).get(req.params.id, req.user.id);
  if (!row) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM purchases WHERE id = ?').run(row.id);
  res.json({ ok: true });
});

// ── Wishlist ──────────────────────────────────────────────────────────────────

function enrichWishlistItem(wi) {
  const item = db.prepare('SELECT * FROM items WHERE id = ?').get(wi.item_id);
  if (!item) return null;
  const latest = db.prepare(
    'SELECT * FROM price_history WHERE item_id = ? AND error IS NULL ORDER BY checked_at DESC LIMIT 1'
  ).get(item.id);
  const stats = db.prepare(
    'SELECT MIN(price) as lowest, MAX(price) as highest FROM price_history WHERE item_id = ? AND price IS NOT NULL AND error IS NULL'
  ).get(item.id);
  return {
    wishlist_id: wi.id,
    quantity: wi.quantity,
    created_at: wi.created_at,
    ...item,
    latest: latest || null,
    lowestPrice: stats?.lowest ?? null,
    highestPrice: stats?.highest ?? null,
  };
}

app.get('/api/wishlist', requireAuth, (req, res) => {
  const rows = db.prepare('SELECT * FROM wishlist_items WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
  res.json(rows.map(enrichWishlistItem).filter(Boolean));
});

app.post('/api/wishlist', requireAuth, async (req, res) => {
  try {
  const { item_id, input, name, quantity } = req.body || {};
  const qty = Math.max(1, parseInt(quantity) || 1);

  // If item_id provided — add existing tracked item to wishlist
  if (item_id) {
    const item = db.prepare('SELECT id FROM items WHERE id = ? AND user_id = ?').get(item_id, req.user.id);
    if (!item) return res.status(404).json({ error: 'Item not found' });
    const existing = db.prepare('SELECT id FROM wishlist_items WHERE user_id = ? AND item_id = ?').get(req.user.id, item_id);
    if (existing) {
      db.prepare('UPDATE wishlist_items SET quantity = ? WHERE id = ?').run(qty, existing.id);
      return res.json(enrichWishlistItem(db.prepare('SELECT * FROM wishlist_items WHERE id = ?').get(existing.id)));
    }
    const { lastInsertRowid } = db.prepare(
      'INSERT INTO wishlist_items (user_id, item_id, quantity) VALUES (?, ?, ?)'
    ).run(req.user.id, item_id, qty);
    return res.json(enrichWishlistItem(db.prepare('SELECT * FROM wishlist_items WHERE id = ?').get(lastInsertRowid)));
  }

  // Otherwise create/find tracked item from URL/ASIN, then add to wishlist
  if (!input?.trim()) return res.status(400).json({ error: 'item_id or input URL/ASIN is required' });
  const normalized = normalizeUrl(input.trim());
  if (!normalized) return res.status(400).json({ error: 'Could not parse a valid Amazon SA URL/ASIN or IKEA SA URL' });
  const { url, asin, store } = normalized;

  // Reuse existing item for this user if already tracked
  let trackedItem = db.prepare('SELECT * FROM items WHERE user_id = ? AND url = ?').get(req.user.id, url);
  if (!trackedItem) {
    let finalName = name?.trim() || null;
    let imageUrl = null;
    let scraped = null;
    try {
      scraped = store === 'ikea_sa' ? await scrapeIkea(url) : await scrapeAmazonSA(url);
      if (!finalName && scraped.title) finalName = scraped.title;
      imageUrl = scraped.imageUrl || null;
    } catch (e) {
      console.error('[wishlist add] scrape failed:', e.message);
    }
    if (!finalName) return res.status(400).json({ error: 'Could not auto-detect product name. Please provide a name.' });

    const safeNum = v => (v != null && Number.isFinite(v) ? v : null);
    const { lastInsertRowid: itemId } = db.prepare(
      'INSERT INTO items (user_id, name, url, asin, image_url, store) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(req.user.id, finalName, url, asin || null, imageUrl || null, store);
    if (scraped) {
      db.prepare(
        'INSERT INTO price_history (item_id, price, original_price, currency, seller_name, is_amazon_direct, is_prime, in_stock, has_other_sellers, other_sellers_price) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)'
      ).run(itemId, safeNum(scraped.price), safeNum(scraped.originalPrice), scraped.currency || 'SAR', scraped.sellerName || null,
        scraped.isAmazonDirect ? 1 : 0, scraped.isPrime ? 1 : 0, scraped.inStock ? 1 : 0,
        scraped.hasOtherSellers ? 1 : 0, safeNum(scraped.otherSellersPrice));
      db.prepare("UPDATE items SET last_checked_at = datetime('now') WHERE id = ?").run(itemId);
    }
    trackedItem = db.prepare('SELECT * FROM items WHERE id = ?').get(itemId);
  }

  const existing = db.prepare('SELECT id FROM wishlist_items WHERE user_id = ? AND item_id = ?').get(req.user.id, trackedItem.id);
  if (existing) {
    db.prepare('UPDATE wishlist_items SET quantity = ? WHERE id = ?').run(qty, existing.id);
    return res.json(enrichWishlistItem(db.prepare('SELECT * FROM wishlist_items WHERE id = ?').get(existing.id)));
  }
  const { lastInsertRowid } = db.prepare(
    'INSERT INTO wishlist_items (user_id, item_id, quantity) VALUES (?, ?, ?)'
  ).run(req.user.id, trackedItem.id, qty);
  res.json(enrichWishlistItem(db.prepare('SELECT * FROM wishlist_items WHERE id = ?').get(lastInsertRowid)));
  } catch (err) {
    console.error('[wishlist add] Error:', err.message, err.stack);
    if (!res.headersSent) res.status(500).json({ error: 'Failed to add to wishlist: ' + err.message });
  }
});

app.put('/api/wishlist/:id', requireAuth, (req, res) => {
  const wi = db.prepare('SELECT * FROM wishlist_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!wi) return res.status(404).json({ error: 'Not found' });
  const qty = Math.max(1, parseInt(req.body?.quantity) || wi.quantity);
  db.prepare('UPDATE wishlist_items SET quantity = ? WHERE id = ?').run(qty, wi.id);
  res.json(enrichWishlistItem(db.prepare('SELECT * FROM wishlist_items WHERE id = ?').get(wi.id)));
});

app.delete('/api/wishlist/:id', requireAuth, (req, res) => {
  const wi = db.prepare('SELECT * FROM wishlist_items WHERE id = ? AND user_id = ?').get(req.params.id, req.user.id);
  if (!wi) return res.status(404).json({ error: 'Not found' });
  db.prepare('DELETE FROM wishlist_items WHERE id = ?').run(wi.id);
  res.json({ ok: true });
});

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  }
});

// ── Global error handler ──────────────────────────────────────────────────────
app.use((err, req, res, next) => {
  console.error('[express error]', err.message, err.stack);
  if (!res.headersSent) res.status(500).json({ error: err.message || 'Internal server error' });
});

// Prevent unhandled rejections from crashing the process
process.on('unhandledRejection', (reason) => {
  console.error('[unhandledRejection]', reason);
});

app.listen(PORT, () => {
  console.log(`Price Tracker running on port ${PORT}`);
  startScheduler();
});
