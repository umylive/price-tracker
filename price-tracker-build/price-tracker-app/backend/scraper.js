const axios = require('axios');
const cheerio = require('cheerio');

const USER_AGENTS = [
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/123.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:125.0) Gecko/20100101 Firefox/125.0',
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
];

function getRandomUA() {
  return USER_AGENTS[Math.floor(Math.random() * USER_AGENTS.length)];
}

function extractASIN(input) {
  if (!input) return null;
  const s = input.trim();
  if (/^[A-Z0-9]{10}$/i.test(s)) return s.toUpperCase();
  const m = s.match(/\/dp\/([A-Z0-9]{10})/i) ||
            s.match(/\/gp\/product\/([A-Z0-9]{10})/i) ||
            s.match(/[?&]asin=([A-Z0-9]{10})/i);
  return m ? m[1].toUpperCase() : null;
}

function extractAliExpressItemId(input) {
  if (!input) return null;
  const m = input.match(/\/(?:item|i)\/(\d+)(?:\.html|[/?]|$)/i);
  return m ? m[1] : null;
}

function normalizeUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.includes('aliexpress.com')) {
    const itemId = extractAliExpressItemId(trimmed);
    if (itemId) return { url: `https://www.aliexpress.com/item/${itemId}.html`, asin: null, store: 'aliexpress' };
    return { url: trimmed, asin: null, store: 'aliexpress' };
  }
  const asin = extractASIN(trimmed);
  if (asin) return { url: `https://www.amazon.sa/-/en/dp/${asin}`, asin, store: 'amazon_sa' };
  if (trimmed.includes('amazon.sa')) return { url: trimmed, asin: null, store: 'amazon_sa' };
  return null;
}

function parsePrice(text) {
  if (!text) return null;
  // Convert Arabic-Indic numerals to ASCII digits
  const s = text.replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
                .replace(/[,،\s]/g, '');
  const m = s.match(/[\d]+\.?\d{0,2}/);
  return m ? parseFloat(m[0]) : null;
}

function parseJsonLd($) {
  let result = null;
  $('script[type="application/ld+json"]').each((_, el) => {
    if (result) return;
    try {
      const raw = $(el).html();
      if (!raw) return;
      const data = JSON.parse(raw);
      const arr = Array.isArray(data) ? data : [data];
      const product = arr.find(d => d['@type'] === 'Product');
      if (!product) return;

      const offersRaw = product.offers || product.Offers;
      const offer = Array.isArray(offersRaw) ? offersRaw[0] : offersRaw;
      const sellerName = offer?.seller?.name || null;

      result = {
        title: product.name || null,
        price: offer ? parsePrice(String(offer.price ?? '')) : null,
        originalPrice: null,
        currency: offer?.priceCurrency || 'SAR',
        sellerName,
        isAmazonDirect: sellerName ? /^amazon/i.test(sellerName) : false,
        isPrime: false,
        inStock: offer?.availability ? offer.availability.toLowerCase().includes('instock') : true,
        imageUrl: Array.isArray(product.image) ? product.image[0] : (product.image || null),
      };
    } catch (_) {}
  });
  return result;
}

function parseCssSelectors($) {
  const title = $('#productTitle').text().trim() ||
                $('h1.product-title-word-break').text().trim();
  if (!title) return null;

  let price = null;
  for (const sel of [
    '.priceToPay .a-offscreen',
    '.apexPriceToPay .a-offscreen',
    '#priceblock_ourprice',
    '#priceblock_dealprice',
    '#price_inside_buybox',
    '#apex_offerDisplay_desktop .a-price .a-offscreen',
    '.a-price[data-a-color="price"] .a-offscreen',
    '.reinventPricePriceToPayMargin .a-offscreen',
  ]) {
    const t = $(sel).first().text().trim();
    if (t) { price = parsePrice(t); break; }
  }

  let originalPrice = null;
  for (const sel of [
    '.basisPrice .a-offscreen',
    '#priceblock_listprice',
    '.priceBlockStrikePriceString',
    '.a-price[data-a-color="secondary"] .a-offscreen',
    '.a-text-strike',
  ]) {
    const t = $(sel).first().text().trim();
    if (t) { originalPrice = parsePrice(t); if (originalPrice) break; }
  }

  const merchantText = (
    $('#merchant-info').text() + ' ' +
    $('#tabular-buybox').text() + ' ' +
    $('#buybox').text()
  ).toLowerCase();
  const sellerEl = $('#sellerProfileTriggerId').first().text().trim() ||
                   $('#tabular-buybox-truncate-0 .tabular-buybox-text').first().text().trim();
  const sellerName = sellerEl || null;
  const isAmazonDirect =
    /ships from and sold by amazon/i.test(merchantText) ||
    /sold by amazon\.sa/i.test(merchantText) ||
    /sold by: amazon\.sa/i.test(merchantText) ||
    (sellerName && /^amazon/i.test(sellerName));

  const isPrime =
    $('#isPrimeBadge_feature_div').length > 0 ||
    $('[id*="prime"] .a-icon-prime').length > 0 ||
    $('#buybox .a-icon-prime').length > 0;

  const availText = ($('#availability').text() + $('#outOfStock').text()).toLowerCase();
  const inStock =
    !availText.includes('unavailable') &&
    !availText.includes('out of stock') &&
    !availText.includes('غير متوفر') &&
    !$('#outOfStock').length;

  const imageUrl =
    $('#landingImage').attr('data-old-hires') ||
    $('#landingImage').attr('src') ||
    $('#imgBlkFront').attr('src') ||
    $('#main-image').attr('src') || null;

  return {
    title,
    price,
    originalPrice: originalPrice !== price ? originalPrice : null,
    currency: 'SAR',
    sellerName: sellerName || (isAmazonDirect ? 'Amazon.sa' : null),
    isAmazonDirect,
    isPrime,
    inStock,
    imageUrl,
  };
}

async function scrapeAmazonSA(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
    try {
      const { data, status } = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-SA,en;q=0.9,ar;q=0.8',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
        },
        timeout: 20000,
        maxRedirects: 5,
      });

      if (status !== 200) throw new Error(`HTTP ${status}`);

      const $ = cheerio.load(data);

      if (
        $('#captchacharacters').length ||
        data.includes('Enter the characters you see below') ||
        data.includes('Robot Check') ||
        data.includes('api-services-support@amazon.com')
      ) {
        lastError = new Error('Bot/CAPTCHA detected — Amazon blocked the request');
        break;
      }

      let result = parseJsonLd($);
      if (!result || !result.title) result = parseCssSelectors($);
      if (!result || !result.title) throw new Error('Could not parse product data from page');

      return result;
    } catch (err) {
      lastError = err;
      if (err.message.includes('CAPTCHA') || err.message.includes('Bot/CAPTCHA')) break;
    }
  }
  throw lastError || new Error('Scraping failed');
}

function tryParseRunParams(html) {
  // AliExpress assigns runParams in several ways across versions
  let idx = html.indexOf('window.runParams');
  if (idx === -1) idx = html.indexOf('"runParams"');
  if (idx === -1) return null;
  const startBrace = html.indexOf('{', idx);
  if (startBrace === -1) return null;

  // Stack-based brace matching to extract the full JSON object
  let depth = 0, inString = false, escape = false;
  let i = startBrace;
  const limit = Math.min(html.length, startBrace + 800000);
  for (; i < limit; i++) {
    const c = html[i];
    if (escape) { escape = false; continue; }
    if (c === '\\' && inString) { escape = true; continue; }
    if (c === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (c === '{') depth++;
    else if (c === '}') { if (--depth === 0) break; }
  }
  if (depth !== 0) return null;

  try {
    const rp = JSON.parse(html.substring(startBrace, i + 1));
    const d = rp.data || rp;
    const pm = d.priceModule || d.webItemDetail?.priceModule || {};

    let price = pm.minActivityAmount?.value ?? pm.minAmount?.value ?? null;
    if (price == null && pm.formatedActivityPrice) price = parsePrice(pm.formatedActivityPrice);
    if (price == null && pm.formatedPrice) price = parsePrice(pm.formatedPrice);
    if (price == null && pm.activityAmount?.value != null) price = parseFloat(pm.activityAmount.value);

    // skuModule: iterate all variants (color/size options), take minimum sale price
    if (price == null && d.skuModule?.skuPriceList?.length) {
      let minPrice = null;
      for (const sku of d.skuModule.skuPriceList) {
        const sv = sku.skuVal;
        const p = sv?.skuActivityAmount?.value ?? sv?.skuAmount?.value ?? null;
        if (p != null) {
          const n = parseFloat(p);
          if (minPrice == null || n < minPrice) minPrice = n;
        }
      }
      if (minPrice != null) price = minPrice;
    }

    const currency = pm.minActivityAmount?.currency ?? pm.minAmount?.currency ?? pm.activityAmount?.currency ??
      (d.skuModule?.skuPriceList?.[0]?.skuVal?.skuActivityAmount?.currency) ?? 'USD';

    let originalPrice = pm.maxAmount?.value != null ? parseFloat(pm.maxAmount.value) : null;
    if (originalPrice != null && originalPrice === parseFloat(price)) originalPrice = null;

    const title = d.titleModule?.subject || null;

    let sellerName = d.storeModule?.storeName || null;
    if (sellerName) try { sellerName = JSON.parse('"' + sellerName + '"'); } catch (_) {}

    const inStock = (d.stockModule?.availQuantity ?? 1) > 0;

    const paths = d.imageModule?.imagePathList || [];
    const imageUrl = paths[0] ? (paths[0].startsWith('//') ? 'https:' + paths[0] : paths[0]) : null;

    if (!title && price == null) return null;
    return { title, price: price != null ? parseFloat(price) : null, originalPrice, currency, sellerName, isAmazonDirect: false, isPrime: false, inStock, imageUrl };
  } catch (_) {
    return null;
  }
}

// Handles newer AliExpress page formats that embed data in _init_data_, __INITIAL_STATE__, etc.
function tryParseInitData(html) {
  const markers = ['var _init_data_', 'window._init_data_', 'window.__INITIAL_STATE__', 'var __INITIAL_STATE__', 'window.pageConfig'];
  for (const marker of markers) {
    const idx = html.indexOf(marker);
    if (idx === -1) continue;
    const startBrace = html.indexOf('{', idx);
    if (startBrace === -1) continue;

    let depth = 0, inStr = false, esc = false, i = startBrace;
    const limit = Math.min(html.length, startBrace + 800000);
    for (; i < limit; i++) {
      const c = html[i];
      if (esc) { esc = false; continue; }
      if (c === '\\' && inStr) { esc = true; continue; }
      if (c === '"') { inStr = !inStr; continue; }
      if (inStr) continue;
      if (c === '{') depth++;
      else if (c === '}') { if (--depth === 0) break; }
    }
    if (depth !== 0) continue;

    try {
      const obj = JSON.parse(html.substring(startBrace, i + 1));
      const d = obj.data || obj;
      const pm = d.priceModule || d.productInfo?.priceModule || d.webItemDetail?.priceModule || {};

      let price = pm.minActivityAmount?.value ?? pm.minAmount?.value ?? null;
      if (price == null && pm.formatedActivityPrice) price = parsePrice(pm.formatedActivityPrice);
      if (price == null && pm.formatedPrice) price = parsePrice(pm.formatedPrice);
      if (price == null && pm.activityAmount?.value != null) price = parseFloat(pm.activityAmount.value);
      if (price == null && d.skuModule?.skuPriceList?.length) {
        let minPrice = null;
        for (const sku of d.skuModule.skuPriceList) {
          const sv = sku.skuVal;
          const p = sv?.skuActivityAmount?.value ?? sv?.skuAmount?.value ?? null;
          if (p != null) { const n = parseFloat(p); if (minPrice == null || n < minPrice) minPrice = n; }
        }
        if (minPrice != null) price = minPrice;
      }

      const title = d.titleModule?.subject || d.productInfo?.subject || d.subject || null;
      if (!title && price == null) continue;

      const currency = pm.minActivityAmount?.currency ?? pm.minAmount?.currency ?? pm.activityAmount?.currency ?? 'USD';
      let originalPrice = pm.maxAmount?.value != null ? parseFloat(pm.maxAmount.value) : null;
      if (originalPrice != null && originalPrice === parseFloat(price)) originalPrice = null;
      let sellerName = d.storeModule?.storeName || null;
      if (sellerName) try { sellerName = JSON.parse('"' + sellerName + '"'); } catch (_) {}
      const inStock = (d.stockModule?.availQuantity ?? 1) > 0;
      const paths = d.imageModule?.imagePathList || [];
      const imageUrl = paths[0] ? (paths[0].startsWith('//') ? 'https:' + paths[0] : paths[0]) : null;
      return { title, price: price != null ? parseFloat(price) : null, originalPrice, currency, sellerName, isAmazonDirect: false, isPrime: false, inStock, imageUrl };
    } catch (_) {}
  }
  return null;
}

function parseAliExpressHtml(html, $) {
  // Try structured JS globals first — these survive React shell pages
  const rp = tryParseRunParams(html);
  const ogTitle = $('meta[property="og:title"]').attr('content')?.replace(/\s*[-|]\s*AliExpress.*$/i, '').trim() || null;
  if (rp?.price != null || rp?.title) return { ...rp, title: rp.title || ogTitle };

  const initData = tryParseInitData(html);
  if (initData?.price != null || initData?.title) return { ...initData, title: initData.title || ogTitle };

  // Build title from HTML meta/DOM — reject generic/error page titles
  let title = ogTitle ||
              $('h1').first().text().trim().replace(/\s*[-|]\s*AliExpress.*$/i, '') ||
              $('title').text().replace(/\s*[-|]\s*AliExpress.*$/i, '').trim() || null;
  if (title && /^(aliexpress(\.com)?|shopping cart|checkout|sign in|log in|404|verify)$/i.test(title)) title = null;

  // __NEXT_DATA__ — extract both title and price (much more comprehensive than before)
  let ndPrice = null, ndCurrency = 'USD', ndImage = null, ndTitle = null;
  try {
    const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (ndMatch) {
      const nd = JSON.parse(ndMatch[1]);
      const walk = (obj, depth = 0) => {
        if (depth > 12 || !obj || typeof obj !== 'object') return;
        if (!ndTitle) {
          for (const k of ['subject', 'productTitle', 'itemTitle', 'title', 'name']) {
            if (typeof obj[k] === 'string' && obj[k].length > 5 && !obj[k].startsWith('http')) {
              const t = obj[k].replace(/\s*[-|]\s*AliExpress.*$/i, '').trim();
              if (t && !/^(aliexpress|error|404)$/i.test(t)) { ndTitle = t; break; }
            }
          }
        }
        if (ndPrice == null) {
          for (const k of ['actPrice', 'salePrice', 'promotionPrice', 'discountPrice', 'activityPrice', 'currentPrice', 'minActPrice', 'price']) {
            if (typeof obj[k] === 'number' && obj[k] > 0) { ndPrice = obj[k]; break; }
            if (typeof obj[k] === 'string') { const p = parsePrice(obj[k]); if (p != null && p > 0) { ndPrice = p; break; } }
            if (obj[k] && typeof obj[k] === 'object') {
              const v = obj[k].value ?? obj[k].amount ?? null;
              if (v != null) { const p = parseFloat(v); if (p > 0) { ndPrice = p; break; } }
            }
          }
        }
        if (!ndImage) {
          const img = obj.imageUrl || obj.mainImgUrl || obj.imgUrl || null;
          if (typeof img === 'string' && img.startsWith('http')) ndImage = img;
        }
        for (const v of Object.values(obj)) walk(v, depth + 1);
      };
      walk(nd);
      if (!title && ndTitle) title = ndTitle;
      if (ndPrice != null && title) {
        return {
          title, price: ndPrice, originalPrice: null, currency: ndCurrency, sellerName: null,
          isAmazonDirect: false, isPrime: false, inStock: true,
          imageUrl: ndImage || $('meta[property="og:image"]').attr('content') || null,
        };
      }
    }
  } catch (_) {}

  if (!title) return null;

  // Fallback: Facebook product meta tags
  let price = ndPrice;
  if (price == null) {
    const fbPrice = $('meta[property="product:price:amount"]').attr('content');
    if (fbPrice) price = parseFloat(fbPrice) || null;
  }

  // Fallback: microdata
  if (price == null) {
    const mp = $('meta[itemprop="price"]').attr('content') || $('[itemprop="price"]').attr('content');
    if (mp) price = parseFloat(mp) || null;
  }

  // Fallback: regex patterns from embedded JS (ordered most-to-least reliable)
  if (price == null) {
    for (const pat of [
      /"formatedActivityPrice"\s*:\s*"([^"]+)"/,
      /"formatedPrice"\s*:\s*"([^"]+)"/,
      /"activityAmount"\s*:[^}]*"formatedAmount"\s*:\s*"([^"]+)"/,
      /"minAmount"\s*:[^}]*"formatedAmount"\s*:\s*"([^"]+)"/,
      /"skuAmount"\s*:[^}]*"formatedAmount"\s*:\s*"([^"]+)"/,
      /"tradeAmount"\s*:[^}]*"formatedAmount"\s*:\s*"([^"]+)"/,
      /"salePrice"\s*:\s*"([^"]+)"/,
      /"minPrice"\s*:\s*"([^"]+)"/,
      /"promotionPrice"\s*:\s*"([\d.,]+)"/,
      /"discountedPrice"\s*:\s*"([\d.,]+)"/,
      /"currentPrice"\s*:\s*"([\d.,]+)"/,
      /"finalPrice"\s*:\s*"?([\d.,]+)"?/,
      /"displayPrice"\s*:\s*"([^"]+)"/,
      /"price"\s*:\s*"((?:SAR|USD|EUR)\s*\+?[\d.,]+)"/,
    ]) {
      const m = html.match(pat);
      if (m) { const p = parsePrice(m[1]); if (p != null) { price = p; break; } }
    }
  }

  // Last resort: scan raw HTML for currency+price strings
  if (price == null) {
    const scanPat = /["'\s>]((?:SAR|USD|EUR|GBP|AED)\s*\+?\s*[\d,]+\.?\d*)/g;
    let m2; const candidates = [];
    while ((m2 = scanPat.exec(html)) !== null) {
      const p = parsePrice(m2[1]);
      if (p != null && p > 0) candidates.push(p);
    }
    if (candidates.length) price = Math.min(...candidates);
  }

  let originalPrice = null;
  const origMatch = html.match(/"formatedOriginalPrice"\s*:\s*"([^"]+)"/) ||
                    html.match(/"originalPriceStr"\s*:\s*"([^"]+)"/) ||
                    html.match(/"maxAmount"\s*:[^}]*"formatedAmount"\s*:\s*"([^"]+)"/);
  if (origMatch) { const op = parsePrice(origMatch[1]); if (op != null && op !== price) originalPrice = op; }

  let currency = $('meta[property="product:price:currency"]').attr('content') ||
                 $('meta[itemprop="priceCurrency"]').attr('content') || 'USD';
  const currMatch = html.match(/"priceCurrency"\s*:\s*"([A-Z]{3})"/) ||
                    html.match(/"currency"\s*:\s*"([A-Z]{3})"/);
  if (currMatch) currency = currMatch[1];

  const imageUrl = ndImage || $('meta[property="og:image"]').attr('content') ||
                   $('meta[name="twitter:image"]').attr('content') || null;

  const stockMatch = html.match(/"(?:totalAvail|avail)Quantity"\s*:\s*(\d+)/);
  const inStock = stockMatch ? parseInt(stockMatch[1]) > 0 : true;

  const sellerMatch = html.match(/"storeName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let sellerName = null;
  if (sellerMatch) try { sellerName = JSON.parse('"' + sellerMatch[1] + '"'); } catch (_) { sellerName = sellerMatch[1]; }

  return { title, price, originalPrice, currency, sellerName, isAmazonDirect: false, isPrime: false, inStock, imageUrl };
}

// Try the Next.js data API — returns JSON directly if the page uses SSR/SSG
async function tryAliExpressNextDataApi(itemId, html, ua, cookie) {
  const m = html.match(/"buildId"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const buildId = m[1];
  try {
    console.log(`[aliexpress] trying Next.js data API (buildId: ${buildId.slice(0, 8)}…)`);
    const resp = await axios.get(
      `https://www.aliexpress.com/_next/data/${buildId}/item/${itemId}.html.json`,
      {
        headers: {
          'User-Agent': ua,
          'Accept': 'application/json',
          'Accept-Language': 'en-US,en;q=0.9',
          'Referer': `https://www.aliexpress.com/item/${itemId}.html`,
          'Cookie': cookie,
          'X-Nextjs-Data': '1',
        },
        timeout: 15000,
      }
    );
    if (resp.status !== 200 || typeof resp.data !== 'object') return null;
    // Walk the response tree and apply the same extraction as tryParseRunParams / tryParseInitData
    const search = (obj, depth = 0) => {
      if (depth > 10 || !obj || typeof obj !== 'object') return null;
      const d = obj.data || obj;
      const pm = d.priceModule || d.webItemDetail?.priceModule || {};
      let price = pm.minActivityAmount?.value ?? pm.minAmount?.value ?? null;
      if (price == null && pm.formatedActivityPrice) price = parsePrice(pm.formatedActivityPrice);
      if (price == null && pm.formatedPrice) price = parsePrice(pm.formatedPrice);
      if (price == null && d.skuModule?.skuPriceList?.length) {
        let minPrice = null;
        for (const sku of d.skuModule.skuPriceList) {
          const sv = sku.skuVal;
          const p = sv?.skuActivityAmount?.value ?? sv?.skuAmount?.value ?? null;
          if (p != null) { const n = parseFloat(p); if (minPrice == null || n < minPrice) minPrice = n; }
        }
        if (minPrice != null) price = minPrice;
      }
      const title = d.titleModule?.subject || null;
      if (title || price != null) {
        const currency = pm.minActivityAmount?.currency ?? pm.minAmount?.currency ?? 'USD';
        return { title, price: price != null ? parseFloat(price) : null, originalPrice: null, currency, sellerName: null, isAmazonDirect: false, isPrime: false, inStock: true, imageUrl: null };
      }
      for (const v of Object.values(obj)) {
        if (v && typeof v === 'object') { const r = search(v, depth + 1); if (r) return r; }
      }
      return null;
    };
    const result = search(resp.data);
    if (result) console.log('[aliexpress] Next.js data API succeeded');
    return result;
  } catch (e) {
    console.log(`[aliexpress] Next.js data API failed: ${e.message}`);
    return null;
  }
}

async function warmupAliExpressSession(ua) {
  const staticCookies = 'aep_usuc_f=site=glo&c_tp=USD&region=US&b_locale=en_US; intl_locale=en_US';
  try {
    const resp = await axios.get('https://www.aliexpress.com/', {
      headers: {
        'User-Agent': ua,
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
        'Connection': 'keep-alive',
        'Upgrade-Insecure-Requests': '1',
        'Sec-Fetch-Dest': 'document',
        'Sec-Fetch-Mode': 'navigate',
        'Sec-Fetch-Site': 'none',
        'Cookie': staticCookies,
      },
      timeout: 15000,
      maxRedirects: 5,
    });
    const setCookies = resp.headers['set-cookie'] || [];
    // Extract name=value pairs from each Set-Cookie header (drop Path, Domain, etc.)
    const pairs = setCookies.map(c => c.split(';')[0]).filter(Boolean);
    // Append our locale overrides so they take priority
    pairs.push('aep_usuc_f=site=glo&c_tp=USD&region=US&b_locale=en_US');
    pairs.push('intl_locale=en_US');
    console.log(`[aliexpress] session warm-up OK, got ${setCookies.length} cookies from homepage`);
    return pairs.join('; ');
  } catch (e) {
    console.warn(`[aliexpress] session warm-up failed (${e.message}), using static cookies`);
    return staticCookies;
  }
}

async function scrapeAliExpress(url) {
  const itemId = extractAliExpressItemId(url);
  let lastError;
  let lastHtml = null;

  const ua = getRandomUA();
  const sessionCookie = await warmupAliExpressSession(ua);
  await new Promise(r => setTimeout(r, 1500));

  const desktopHeaders = {
    'User-Agent': ua,
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Accept-Language': 'en-US,en;q=0.9',
    'Accept-Encoding': 'gzip, deflate, br',
    'Connection': 'keep-alive',
    'Cache-Control': 'no-cache',
    'Referer': 'https://www.aliexpress.com/',
    'Sec-Fetch-Dest': 'document',
    'Sec-Fetch-Mode': 'navigate',
    'Sec-Fetch-Site': 'same-origin',
    'Upgrade-Insecure-Requests': '1',
    'Cookie': sessionCookie,
  };

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
    try {
      const { data, status } = await axios.get(url, { headers: desktopHeaders, timeout: 25000, maxRedirects: 5 });
      if (status !== 200) throw new Error(`HTTP ${status}`);

      lastHtml = data;
      const $ = cheerio.load(data);
      const pageTitle = $('title').text().trim();
      const hasOgTitle = !!$('meta[property="og:title"]').length;
      console.log(`[aliexpress] attempt ${attempt + 1}: ${data.length} bytes | title: "${pageTitle}" | og:title: ${hasOgTitle} | runParams: ${data.includes('window.runParams')} | __NEXT_DATA__: ${data.includes('__NEXT_DATA__')} | _init_data_: ${data.includes('_init_data_')}`);

      if (data.includes('_captcha_') || data.includes('anti-hotlinking') ||
          (pageTitle.toLowerCase().includes('verify') && !hasOgTitle)) {
        lastError = new Error('Bot/CAPTCHA detected — AliExpress blocked the request');
        break;
      }

      const result = parseJsonLd($) || parseAliExpressHtml(data, $);
      if (!result?.title) throw new Error('Could not parse product data from AliExpress page');
      if (result.currency === 'SAR' && !data.includes('"priceCurrency":"SAR"') &&
          !data.includes('"currency":"SAR"') && !$('meta[itemprop="priceCurrency"][content="SAR"]').length) {
        result.currency = 'USD';
      }
      return result;
    } catch (err) {
      lastError = err;
      if (err.message.includes('CAPTCHA') || err.message.includes('Bot/CAPTCHA')) break;
    }
  }

  // Fallback 1: Next.js data API (works when AliExpress uses SSR and we got the HTML shell)
  if (itemId && lastHtml) {
    const ndResult = await tryAliExpressNextDataApi(itemId, lastHtml, ua, sessionCookie);
    if (ndResult?.title) return ndResult;
  }

  // Fallback 2: Mobile site often uses SSR with more data in the initial HTML
  if (itemId) {
    try {
      const mobileUrl = `https://m.aliexpress.com/item/${itemId}.html`;
      console.log('[aliexpress] trying mobile URL');
      const mResp = await axios.get(mobileUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Referer': 'https://m.aliexpress.com/',
          'Cookie': sessionCookie,
        },
        timeout: 20000,
        maxRedirects: 5,
      });
      if (mResp.status === 200) {
        const m$ = cheerio.load(mResp.data);
        const mResult = parseJsonLd(m$) || parseAliExpressHtml(mResp.data, m$);
        if (mResult?.title) {
          console.log('[aliexpress] mobile URL succeeded');
          if (mResult.currency === 'SAR' && !mResp.data.includes('"priceCurrency":"SAR"')) mResult.currency = 'USD';
          return mResult;
        }
        // Also try Next.js data API with mobile HTML if it has a different buildId
        if (itemId) {
          const mNd = await tryAliExpressNextDataApi(itemId, mResp.data, ua, sessionCookie);
          if (mNd?.title) { console.log('[aliexpress] mobile Next.js data API succeeded'); return mNd; }
        }
      }
    } catch (e) {
      console.log(`[aliexpress] mobile fallback failed: ${e.message}`);
    }
  }

  throw lastError || new Error('AliExpress scraping failed');
}

module.exports = { scrapeAmazonSA, scrapeAliExpress, normalizeUrl, extractASIN };
