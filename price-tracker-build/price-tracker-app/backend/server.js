const express = require('express');
const cookieParser = require('cookie-parser');
const path = require('path');
const db = require('./database');
const {
  hashPassword, verifyPassword, createSession, getSession,
  deleteSession, isRateLimited, recordLoginAttempt, requireAuth,
} = require('./auth');
const { scrapeAmazonSA, normalizeUrl } = require('./scraper');
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
  const items = db.prepare('SELECT * FROM items WHERE user_id = ? ORDER BY created_at DESC').all(req.user.id);
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
  const { name, input, target_price, notify_drop_percent } = req.body || {};
  if (!input?.trim()) return res.status(400).json({ error: 'Product URL or ASIN is required' });

  const normalized = normalizeUrl(input.trim());
  if (!normalized) return res.status(400).json({ error: 'Could not parse a valid Amazon SA URL or ASIN' });
  const { url, asin, store } = normalized;

  const existing = db.prepare('SELECT id FROM items WHERE user_id = ? AND url = ?').get(req.user.id, url);
  if (existing) return res.status(400).json({ error: 'This item is already being tracked' });

  let finalName = name?.trim() || null;
  let imageUrl = null;
  let scraped = null;
  try {
    scraped = await scrapeAmazonSA(url);
    if (!finalName && scraped.title) finalName = scraped.title;
    imageUrl = scraped.imageUrl || null;
  } catch (e) {
    console.error('[add-item] Initial scrape failed:', e.message);
  }

  if (!finalName) {
    return res.status(400).json({
      error: 'Could not auto-detect product name (scraping failed). Please enter a name manually.',
    });
  }

  const { lastInsertRowid } = db.prepare(`
    INSERT INTO items (user_id, name, url, asin, image_url, store, target_price, notify_drop_percent)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    req.user.id, finalName, url, asin, imageUrl, store,
    target_price ? parseFloat(target_price) : null,
    notify_drop_percent ? parseFloat(notify_drop_percent) : 5
  );

  if (scraped) {
    db.prepare(`
      INSERT INTO price_history (item_id, price, original_price, currency, seller_name, is_amazon_direct, is_prime, in_stock)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      lastInsertRowid,
      scraped.price, scraped.originalPrice, scraped.currency || 'SAR',
      scraped.sellerName, scraped.isAmazonDirect ? 1 : 0,
      scraped.isPrime ? 1 : 0, scraped.inStock ? 1 : 0
    );
    db.prepare("UPDATE items SET last_checked_at = datetime('now') WHERE id = ?").run(lastInsertRowid);
  }

  res.json(db.prepare('SELECT * FROM items WHERE id = ?').get(lastInsertRowid));
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

// ── SPA fallback ──────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  if (req.path.startsWith('/api')) {
    res.status(404).json({ error: 'Not found' });
  } else {
    res.sendFile(path.join(FRONTEND_DIR, 'index.html'));
  }
});

app.listen(PORT, () => {
  console.log(`Price Tracker running on port ${PORT}`);
  startScheduler();
});
