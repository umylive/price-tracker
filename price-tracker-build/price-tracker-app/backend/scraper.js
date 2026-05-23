const axios = require('axios');
const cheerio = require('cheerio');
const crypto = require('crypto');

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
      let skuCurrency = null;
      for (const sku of d.skuModule.skuPriceList) {
        const sv = sku.skuVal;
        const p = sv?.skuActivityAmount?.value ?? sv?.skuAmount?.value ?? null;
        if (p != null) {
          const n = parseFloat(p);
          if (minPrice == null || n < minPrice) {
            minPrice = n;
            skuCurrency = sv?.skuActivityAmount?.currency ?? sv?.skuAmount?.currency ?? null;
          }
        }
      }
      if (minPrice != null) { price = minPrice; if (skuCurrency) { /* used below */ } }
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

function parseAliExpressHtml(html, $) {
  const title = $('meta[property="og:title"]').attr('content')?.replace(/\s*[-|]\s*AliExpress.*$/i, '').trim() ||
                $('h1').first().text().trim().replace(/\s*[-|]\s*AliExpress.*$/i, '') ||
                $('title').text().replace(/\s*[-|]\s*AliExpress.*$/i, '').trim() || null;
  if (!title) return null;

  // Full JSON parse of window.runParams is the most reliable approach
  const rp = tryParseRunParams(html);
  if (rp?.price != null || rp?.title) return { ...rp, title: rp.title || title };

  // Fallback: Facebook product meta tags (very reliable when present)
  let price = null;
  const fbPrice = $('meta[property="product:price:amount"]').attr('content');
  if (fbPrice) price = parseFloat(fbPrice) || null;

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

  // Fallback: __NEXT_DATA__ (Next.js embed — newer AliExpress pages)
  if (price == null) {
    try {
      const ndMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
      if (ndMatch) {
        const nd = JSON.parse(ndMatch[1]);
        const walk = (obj, depth = 0) => {
          if (depth > 10 || !obj || typeof obj !== 'object') return null;
          for (const key of ['salePrice', 'promotionPrice', 'price', 'discountPrice', 'activityPrice', 'currentPrice']) {
            if (typeof obj[key] === 'number') return obj[key];
            if (typeof obj[key] === 'string') { const p = parsePrice(obj[key]); if (p != null) return p; }
          }
          for (const v of Object.values(obj)) {
            const found = walk(v, depth + 1);
            if (found != null) return found;
          }
          return null;
        };
        const p = walk(nd);
        if (p != null) price = p;
      }
    } catch (_) {}
  }

  // Last resort: scan raw HTML for currency+price strings like "SAR 436.53" or "USD 89.99"
  // Collect all matches, take the minimum non-zero value (most likely the sale price)
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

  const imageUrl = $('meta[property="og:image"]').attr('content') ||
                   $('meta[name="twitter:image"]').attr('content') || null;

  const stockMatch = html.match(/"(?:totalAvail|avail)Quantity"\s*:\s*(\d+)/);
  const inStock = stockMatch ? parseInt(stockMatch[1]) > 0 : true;

  const sellerMatch = html.match(/"storeName"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let sellerName = null;
  if (sellerMatch) try { sellerName = JSON.parse('"' + sellerMatch[1] + '"'); } catch (_) { sellerName = sellerMatch[1]; }

  return { title, price, originalPrice, currency, sellerName, isAmazonDirect: false, isPrime: false, inStock, imageUrl };
}

// AliExpress Open Platform affiliate API — requires free account at portals.aliexpress.com
function aliExpressApiSign(params, secret) {
  const sorted = Object.keys(params).sort().map(k => `${k}${params[k]}`).join('');
  return crypto.createHash('md5').update(`${secret}${sorted}${secret}`, 'utf8').digest('hex').toUpperCase();
}

async function scrapeAliExpressApi(itemId, appKey, appSecret, trackingId) {
  const params = {
    method: 'aliexpress.affiliate.product.detail.get',
    app_key: appKey,
    timestamp: String(Date.now()),
    sign_method: 'md5',
    product_ids: String(itemId),
    target_currency: 'USD',
    target_language: 'EN',
    tracking_id: trackingId || 'default',
    fields: 'productId,productTitle,productMainImageUrl,originalPrice,salePrice,currency',
  };
  params.sign = aliExpressApiSign(params, appSecret);

  const { data, status } = await axios.get('https://api-sg.aliexpress.com/sync', {
    params,
    timeout: 15000,
  });
  if (status !== 200) throw new Error(`AliExpress API HTTP ${status}`);

  const resp = data?.aliexpress_affiliate_product_detail_get_response?.resp_result;
  if (!resp || resp.resp_code !== 200) {
    throw new Error(`AliExpress API: ${resp?.resp_msg || JSON.stringify(data)}`);
  }

  const product = resp.result?.products?.product?.[0];
  if (!product) throw new Error('No product in AliExpress API response');

  const price = parseFloat(product.sale_price) || null;
  const originalPrice = parseFloat(product.original_price) || null;

  return {
    title: product.product_title || null,
    price,
    originalPrice: originalPrice && originalPrice !== price ? originalPrice : null,
    currency: product.currency_code || product.currency || 'USD',
    sellerName: null,
    isAmazonDirect: false,
    isPrime: false,
    inStock: true,
    imageUrl: product.product_main_image_url || null,
  };
}

async function scrapeAliExpress(url, options = {}) {
  const itemId = extractAliExpressItemId(url);
  const { appKey, appSecret, trackingId } = options;
  let lastError;

  // Try the official affiliate API first when credentials are configured
  if (itemId && appKey && appSecret) {
    try {
      const result = await scrapeAliExpressApi(itemId, appKey, appSecret, trackingId);
      if (result.price != null || result.title) return result;
    } catch (e) {
      console.warn(`[aliexpress] API failed, falling back to HTML scraping: ${e.message}`);
    }
  }

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
    try {
      // Cookie locks AliExpress to global English site and prevents redirect to ar.aliexpress.com
      const { data, status } = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
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
          'Cookie': 'aep_usuc_f=site=glo&c_tp=USD&region=US&b_locale=en_US; intl_locale=en_US',
        },
        timeout: 25000,
        maxRedirects: 5,
      });

      if (status !== 200) throw new Error(`HTTP ${status}`);

      const $ = cheerio.load(data);

      if (data.includes('_captcha_') || data.includes('anti-hotlinking') ||
          ($('title').text().toLowerCase().includes('verify') && !$('meta[property="og:title"]').length)) {
        lastError = new Error('Bot/CAPTCHA detected — AliExpress blocked the request');
        break;
      }

      const result = parseJsonLd($) || parseAliExpressHtml(data, $);
      if (!result?.title) throw new Error('Could not parse product data from AliExpress page');
      // parseJsonLd defaults currency to SAR; override for AliExpress
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
  throw lastError || new Error('AliExpress scraping failed');
}

module.exports = { scrapeAmazonSA, scrapeAliExpress, scrapeAliExpressApi, normalizeUrl, extractASIN };
