const cron = require('node-cron');
const db = require('./database');
const { scrapeAmazonSA, scrapeAliExpress } = require('./scraper');

let currentTask = null;

async function sendTelegram(botToken, chatId, message) {
  if (!botToken || !chatId) return false;
  try {
    const res = await fetch(`https://api.telegram.org/bot${botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: message,
        parse_mode: 'HTML',
        disable_web_page_preview: false,
      }),
    });
    const json = await res.json();
    if (!json.ok) console.error('[telegram] Error:', json.description);
    return !!json.ok;
  } catch (e) {
    console.error('[telegram] Send error:', e.message);
    return false;
  }
}

async function checkItem(item) {
  console.log(`[check] ${item.name}`);
  let scraped;
  try {
    scraped = item.store === 'aliexpress'
      ? await scrapeAliExpress(item.url)
      : await scrapeAmazonSA(item.url);
  } catch (err) {
    db.prepare("INSERT INTO price_history (item_id, error, in_stock) VALUES (?, ?, 0)").run(item.id, err.message);
    db.prepare("UPDATE items SET last_checked_at = datetime('now') WHERE id = ?").run(item.id);
    console.error(`  [error] ${err.message}`);
    return;
  }

  const prev = db.prepare(
    'SELECT * FROM price_history WHERE item_id = ? AND error IS NULL ORDER BY checked_at DESC LIMIT 1'
  ).get(item.id);

  db.prepare(`
    INSERT INTO price_history (item_id, price, original_price, currency, seller_name, is_amazon_direct, is_prime, in_stock)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    item.id,
    scraped.price,
    scraped.originalPrice,
    scraped.currency || 'SAR',
    scraped.sellerName,
    scraped.isAmazonDirect ? 1 : 0,
    scraped.isPrime ? 1 : 0,
    scraped.inStock ? 1 : 0
  );

  if (scraped.imageUrl && !item.image_url) {
    db.prepare('UPDATE items SET image_url = ? WHERE id = ?').run(scraped.imageUrl, item.id);
  }
  db.prepare("UPDATE items SET last_checked_at = datetime('now') WHERE id = ?").run(item.id);

  console.log(`  [ok] ${scraped.currency || 'SAR'} ${scraped.price} | seller: ${scraped.sellerName} | inStock: ${scraped.inStock}`);

  const settings = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => { settings[r.key] = r.value; });
  const botToken = process.env.TELEGRAM_BOT_TOKEN || settings.telegram_bot_token;
  const chatId = process.env.TELEGRAM_CHAT_ID || settings.telegram_chat_id;
  if (!botToken || !chatId) return;

  // Price drop notification
  if (settings.notify_price_drop === '1' && scraped.price != null && prev?.price != null && scraped.price < prev.price) {
    const dropPct = ((prev.price - scraped.price) / prev.price) * 100;
    const threshold = parseFloat(item.notify_drop_percent) || 5;
    const hitTarget = item.target_price != null && scraped.price <= item.target_price;
    if (dropPct >= threshold || hitTarget) {
      const msg = buildDropMsg(item, scraped, prev.price, dropPct);
      if (await sendTelegram(botToken, chatId, msg)) {
        db.prepare('INSERT INTO notifications (item_id, type, message, price) VALUES (?, ?, ?, ?)').run(item.id, 'price_drop', msg, scraped.price);
      }
    }
  }

  // Back in stock notification
  if (settings.notify_back_in_stock === '1' && scraped.inStock && prev && !prev.in_stock) {
    const msg = buildStockMsg(item, scraped);
    if (await sendTelegram(botToken, chatId, msg)) {
      db.prepare('INSERT INTO notifications (item_id, type, message, price) VALUES (?, ?, ?, ?)').run(item.id, 'back_in_stock', msg, scraped.price);
    }
  }
}

function buildDropMsg(item, scraped, prevPrice, dropPct) {
  const cur = scraped.currency || 'SAR';
  const seller = scraped.isAmazonDirect
    ? '✅ Sold by <b>Amazon SA</b> directly'
    : `🏪 Seller: ${scraped.sellerName || 'Third-party seller'}`;
  const prime = scraped.isPrime ? '\n⚡ Prime eligible' : '';
  const target = item.target_price != null && scraped.price <= item.target_price
    ? '\n🎯 <b>Hit your target price!</b>' : '';
  const orig = scraped.originalPrice && scraped.originalPrice > scraped.price
    ? `\n🏷 List price: ${cur} ${scraped.originalPrice.toFixed(2)}` : '';
  return [
    '📉 <b>Price Drop Alert!</b>',
    '',
    `📦 ${item.name}`,
    `💰 Now: <b>${cur} ${scraped.price.toFixed(2)}</b>`,
    `📊 Was: ${cur} ${prevPrice.toFixed(2)} (↓${dropPct.toFixed(1)}%)${orig}`,
    seller + prime + target,
    '',
    `🔗 ${item.url}`,
  ].join('\n');
}

function buildStockMsg(item, scraped) {
  const seller = scraped.isAmazonDirect
    ? '✅ Sold by <b>Amazon SA</b> directly'
    : `🏪 Seller: ${scraped.sellerName || 'Third-party seller'}`;
  const priceStr = scraped.price != null ? `${scraped.currency || 'SAR'} ${scraped.price.toFixed(2)}` : 'N/A';
  return [
    '✅ <b>Back in Stock!</b>',
    '',
    `📦 ${item.name}`,
    `💰 Price: <b>${priceStr}</b>`,
    seller,
    '',
    `🔗 ${item.url}`,
  ].join('\n');
}

async function runAllChecks() {
  const items = db.prepare('SELECT * FROM items WHERE active = 1').all();
  console.log(`[scheduler] Checking ${items.length} active items`);
  for (const item of items) {
    await checkItem(item);
    // 1-minute delay between items to avoid rate limiting
    await new Promise(r => setTimeout(r, 60000));
  }
  console.log('[scheduler] Done');
}

function buildCronExpr(minutes) {
  if (minutes < 60) return `*/${minutes} * * * *`;
  const hours = Math.floor(minutes / 60);
  return `0 */${hours} * * *`;
}

function startScheduler() {
  const row = db.prepare("SELECT value FROM settings WHERE key = 'check_interval'").get();
  const minutes = parseInt(row?.value || '60', 10);
  const expr = buildCronExpr(minutes);

  if (currentTask) { currentTask.stop(); currentTask = null; }
  currentTask = cron.schedule(expr, runAllChecks);
  console.log(`[scheduler] Started — every ${minutes}min (${expr})`);
}

function restartScheduler() {
  startScheduler();
}

module.exports = { startScheduler, restartScheduler, runAllChecks, checkItem, sendTelegram };
