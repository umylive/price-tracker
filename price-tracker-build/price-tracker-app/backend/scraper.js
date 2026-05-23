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

function extractAliExpressId(input) {
  const m = input.match(/\/item\/(\d+)/);
  return m ? m[1] : null;
}

function normalizeUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.includes('aliexpress.com')) {
    const id = extractAliExpressId(trimmed);
    if (!id) return null;
    return { url: `https://www.aliexpress.com/item/${id}.html`, asin: null, store: 'aliexpress' };
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

// ── AliExpress scraper ────────────────────────────────────────────────────────

// Cache homepage cookies for 5 min so each product check doesn't need a warm-up request
let _aliCookies = '';
let _aliCookiesAt = 0;

async function fetchAliCookies() {
  if (_aliCookies && Date.now() - _aliCookiesAt < 300_000) return _aliCookies;
  try {
    const res = await axios.get('https://www.aliexpress.com/', {
      headers: {
        'User-Agent': getRandomUA(),
        'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'Accept-Language': 'en-US,en;q=0.9',
        'Accept-Encoding': 'gzip, deflate, br',
      },
      timeout: 12000,
      maxRedirects: 3,
    });
    const raw = res.headers['set-cookie'];
    if (raw) { _aliCookies = raw.map(c => c.split(';')[0]).join('; '); _aliCookiesAt = Date.now(); }
  } catch (_) {}
  return _aliCookies;
}

// Try multiple known window variable names AliExpress has used across versions
function extractWindowVar(html) {
  for (const name of ['runParams', '__INITIAL_STATE__', '_init_data_', 'g_page_pc_detail', '__aer_data', 'AER_DATA']) {
    const idx = html.indexOf(`window.${name}`);
    if (idx === -1) continue;
    const start = html.indexOf('{', idx);
    if (start === -1) continue;
    let depth = 0;
    for (let i = start; i < html.length; i++) {
      if (html[i] === '{') depth++;
      else if (html[i] === '}') {
        depth--;
        if (depth === 0) {
          try { return { name, data: JSON.parse(html.slice(start, i + 1)) }; }
          catch (_) { break; }
        }
      }
    }
  }
  return null;
}

function parseRunParamsData({ data: rp } = {}) {
  const d = rp?.data || rp;
  const title = d?.titleModule?.subject || null;
  if (!title) return null;

  let price = null, originalPrice = null, currency = 'USD';

  const skuList = d?.skuModule?.skuPriceList;
  if (Array.isArray(skuList) && skuList.length > 0) {
    let minSale = Infinity, minOrig = Infinity, foundCur = 'USD';
    for (const sku of skuList) {
      const sv = sku?.skuVal;
      const saleVal = sv?.skuActivityAmount?.value ?? sv?.skuAmount?.value;
      const origVal = sv?.skuAmount?.value;
      foundCur = sv?.skuActivityAmount?.currency || sv?.skuAmount?.currency || 'USD';
      if (saleVal != null) { const n = parseFloat(saleVal); if (!isNaN(n) && n > 0 && n < minSale) minSale = n; }
      if (origVal != null) { const n = parseFloat(origVal); if (!isNaN(n) && n > 0 && n < minOrig) minOrig = n; }
    }
    currency = foundCur;
    price = minSale !== Infinity ? minSale : null;
    originalPrice = (minOrig !== Infinity && price != null && minOrig > price) ? minOrig : null;
  }

  if (price == null) {
    const pm = d?.priceModule;
    if (pm) {
      const saleAmt = pm?.minActivityAmount;
      const regAmt = pm?.minAmount;
      price = saleAmt?.value != null ? parseFloat(saleAmt.value) : (regAmt?.value != null ? parseFloat(regAmt.value) : null);
      currency = saleAmt?.currency || regAmt?.currency || 'USD';
      const regPrice = regAmt?.value != null ? parseFloat(regAmt.value) : null;
      if (regPrice && price != null && regPrice > price) originalPrice = regPrice;
    }
  }

  const imagePaths = d?.imageModule?.imagePathList;
  const imageUrl = Array.isArray(imagePaths) && imagePaths.length > 0
    ? (imagePaths[0].startsWith('//') ? 'https:' + imagePaths[0] : imagePaths[0])
    : null;
  const qty = d?.quantityModule?.totalAvailQuantity;
  const inStock = qty == null ? true : qty > 0;
  const sellerName = d?.storeModule?.storeName || null;

  return {
    title,
    price: (isNaN(price) || price == null) ? null : price,
    originalPrice: (isNaN(originalPrice) || originalPrice == null) ? null : originalPrice,
    currency,
    sellerName,
    isAmazonDirect: false,
    isPrime: false,
    inStock,
    imageUrl,
  };
}

function parseAliNextData($) {
  const script = $('script#__NEXT_DATA__').text();
  if (!script) return null;
  try {
    const nd = JSON.parse(script);
    const props = nd?.props?.pageProps;
    if (!props) return null;
    const product = props?.product
      || props?.data?.product
      || props?.initialData?.data?.productInfo
      || props?.ssrData?.product
      || props?.data?.data;
    if (!product) return null;
    const title = product?.title || product?.name || null;
    if (!title) return null;
    const priceVal = product?.price?.salePrice?.value
      || product?.salePrice?.value
      || product?.price?.value
      || product?.prices?.salePrice?.minPrice
      || product?.priceInfo?.salePrice?.minPrice;
    const price = priceVal ? (parseFloat(priceVal) || null) : null;
    const currency = product?.price?.salePrice?.currency || product?.salePrice?.currency || product?.price?.currency || 'USD';
    const imageUrl = product?.images?.[0] || product?.mainImage || null;
    return { title, price: isNaN(price) ? null : price, originalPrice: null, currency, sellerName: null, isAmazonDirect: false, isPrime: false, inStock: true, imageUrl };
  } catch (_) { return null; }
}

function parseAliMeta($, html) {
  const title =
    $('meta[property="og:title"]').attr('content') ||
    $('meta[name="title"]').attr('content') ||
    $('h1').first().text().trim() || null;
  if (!title) return null;
  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  let price = null, currency = 'USD';
  const patterns = [
    // Structured JSON fields in embedded scripts
    [/"minActivityAmount"\s*:\s*\{[^}]*?"value"\s*:\s*"([\d.]+)"/, 'USD'],
    [/"activityAmount"\s*:\s*\{[^}]*?"value"\s*:\s*"([\d.]+)"/, 'USD'],
    [/"minAmount"\s*:\s*\{[^}]*?"value"\s*:\s*"([\d.]+)"/, 'USD'],
    [/"skuActivityAmount"\s*:\s*\{[^}]*?"value"\s*:\s*"([\d.]+)"/, 'USD'],
    [/"skuAmount"\s*:\s*\{[^}]*?"value"\s*:\s*"([\d.]+)"/, 'USD'],
    // Formatted price strings
    [/"formatedActivityPrice"\s*:\s*"US\s*\$([\d,.]+)"/, 'USD'],
    [/"formatedPrice"\s*:\s*"US\s*\$([\d,.]+)"/, 'USD'],
    [/"salePrice"\s*:\s*"US\s*\$([\d,.]+)"/, 'USD'],
    // Raw currency in page text
    [/US\s*\$\s*([\d,]+\.?\d*)/i, 'USD'],
    [/SAR\s+([\d,]+\.?\d*)/i, 'SAR'],
  ];
  for (const [re, cur] of patterns) {
    const m = html.match(re);
    if (m) { const n = parseFloat(m[1].replace(/,/g, '')); if (!isNaN(n) && n > 0) { price = n; currency = cur; break; } }
  }
  return { title, price, originalPrice: null, currency, sellerName: null, isAmazonDirect: false, isPrime: false, inStock: true, imageUrl };
}

function rawCurrencyScan(html) {
  for (const [re, cur] of [
    [/SAR\s+([\d,]+\.?\d*)/g, 'SAR'],
    [/([\d,]+\.?\d*)\s*SAR/g, 'SAR'],
    [/US\s*\$\s*([\d,]+\.?\d*)/g, 'USD'],
  ]) {
    const vals = [...html.matchAll(re)]
      .map(m => parseFloat((m[1] || m[2]).replace(/,/g, '')))
      .filter(n => !isNaN(n) && n > 0.5 && n < 100000);
    if (vals.length > 0) return { price: Math.min(...vals), currency: cur };
  }
  return null;
}

// Generic recursive price finder — last resort when structure is unknown
function findPriceInData(obj, depth = 0) {
  if (depth > 8 || !obj || typeof obj !== 'object') return null;
  const priceKeys = ['minActivityAmount', 'skuActivityAmount', 'salePrice', 'activityPrice',
                     'minAmount', 'skuAmount', 'price', 'amount', 'value'];
  for (const key of priceKeys) {
    if (obj[key] == null) continue;
    const v = obj[key];
    if (typeof v === 'number' && v > 0 && v < 100000) return v;
    if (typeof v === 'string') { const n = parseFloat(v); if (!isNaN(n) && n > 0 && n < 100000) return n; }
    if (typeof v === 'object' && v.value != null) {
      const n = parseFloat(v.value);
      if (!isNaN(n) && n > 0 && n < 100000) return n;
    }
  }
  for (const val of Object.values(obj)) {
    if (val && typeof val === 'object') {
      const found = findPriceInData(val, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

// ── AliExpress Affiliate API ──────────────────────────────────────────────────
// Signature: MD5( appSecret + sortedKey1Val1Key2Val2... + appSecret ), uppercase
function signAliRequest(params, appSecret) {
  let str = appSecret;
  for (const key of Object.keys(params).sort()) str += key + String(params[key]);
  str += appSecret;
  return crypto.createHash('md5').update(str, 'utf8').digest('hex').toUpperCase();
}

function parseAliApiProduct(p) {
  const price = parseFloat(p.sale_price);
  const origPrice = parseFloat(p.original_price);
  return {
    title: p.product_title || null,
    price: isNaN(price) ? null : price,
    originalPrice: (!isNaN(origPrice) && origPrice > price) ? origPrice : null,
    currency: p.sale_price_currency || 'SAR',
    sellerName: p.shop_name || null,
    isAmazonDirect: false,
    isPrime: false,
    inStock: !isNaN(price) && price > 0,
    imageUrl: p.product_main_image_url || null,
  };
}

async function aliApiCall(params, appKey, appSecret) {
  params.app_key = appKey;
  params.timestamp = new Date().toISOString().replace('T', ' ').slice(0, 19);
  params.sign_method = 'md5';
  params.v = '2.0';
  params.sign = signAliRequest(params, appSecret);

  const { data } = await axios.post(
    'https://api-sg.aliexpress.com/sync',
    new URLSearchParams(params).toString(),
    { headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=utf-8' }, timeout: 15000 }
  );
  console.log(`[aliexpress] ${params.method} response:`, JSON.stringify(data).slice(0, 600));
  return data;
}

async function scrapeAliExpressAPI(productUrl, appKey, appSecret) {
  const itemId = productUrl.match(/\/item\/(\d+)/)?.[1];

  // Method 1: productdetail.get (works only for affiliate-enrolled products)
  try {
    const data = await aliApiCall({
      method: 'aliexpress.affiliate.productdetail.get',
      product_urls: productUrl,
      target_currency: 'SAR',
      target_language: 'EN',
      fields: 'product_id,product_title,sale_price,original_price,sale_price_currency,product_main_image_url,shop_name',
    }, appKey, appSecret);

    if (data?.error_response) throw new Error(data.error_response.msg || JSON.stringify(data.error_response));

    let resp = data?.aliexpress_affiliate_productdetail_get_response?.resp_result;
    if (resp) {
      if (typeof resp === 'string') { try { resp = JSON.parse(resp); } catch (_) {} }
      if (String(resp.resp_code) === '200') {
        const products = resp.result?.products?.product;
        if (Array.isArray(products) && products.length > 0) {
          console.log('[aliexpress] affiliate API productdetail.get OK');
          return parseAliApiProduct(products[0]);
        }
      }
    }
    console.log('[aliexpress] productdetail.get returned no products (not in affiliate catalog) — trying product.query');
  } catch (e) {
    console.error('[aliexpress] productdetail.get error:', e.message);
  }

  // Method 2: product.query — search affiliate catalog by product ID keyword
  if (itemId) {
    try {
      const data = await aliApiCall({
        method: 'aliexpress.affiliate.product.query',
        keywords: itemId,
        target_currency: 'SAR',
        target_language: 'EN',
        page_no: '1',
        page_size: '5',
        fields: 'product_id,product_title,sale_price,original_price,sale_price_currency,product_main_image_url,shop_name,product_detail_url',
      }, appKey, appSecret);

      if (data?.error_response) throw new Error(data.error_response.msg || JSON.stringify(data.error_response));

      let resp = data?.aliexpress_affiliate_product_query_response?.resp_result;
      if (resp) {
        if (typeof resp === 'string') { try { resp = JSON.parse(resp); } catch (_) {} }
        if (String(resp.resp_code) === '200') {
          const products = resp.result?.products?.product;
          if (Array.isArray(products) && products.length > 0) {
            const match = products.find(p => p.product_detail_url?.includes(itemId)) || products[0];
            console.log('[aliexpress] affiliate API product.query OK');
            return parseAliApiProduct(match);
          }
        }
      }
      console.log('[aliexpress] product.query returned no results — product not in affiliate catalog');
    } catch (e) {
      console.error('[aliexpress] product.query error:', e.message);
    }
  }

  throw new Error('Product not found in AliExpress affiliate catalog');
}

async function tryFetchAli(url, cookies, lang = 'en-US,en;q=0.9') {
  const { data, status } = await axios.get(url, {
    headers: {
      'User-Agent': getRandomUA(),
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
      'Accept-Language': lang,
      'Accept-Encoding': 'gzip, deflate, br',
      'Connection': 'keep-alive',
      'Referer': 'https://www.aliexpress.com/',
      'Upgrade-Insecure-Requests': '1',
      'Sec-Fetch-Dest': 'document',
      'Sec-Fetch-Mode': 'navigate',
      'Sec-Fetch-Site': 'same-origin',
      'Cache-Control': 'no-cache',
      ...(cookies ? { Cookie: cookies } : {}),
    },
    timeout: 25000,
    maxRedirects: 5,
  });
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return data;
}

function parseAliHtml(html) {
  const $ = cheerio.load(html);
  let bestTitle = null, bestImage = null;

  // Strategy 1: JSON-LD
  const jsonLd = parseJsonLd($);
  if (jsonLd?.title && jsonLd?.price) {
    console.log('[aliexpress] price via JSON-LD');
    return { ...jsonLd, currency: jsonLd.currency || 'USD', isAmazonDirect: false, isPrime: false };
  }
  if (jsonLd?.title) { bestTitle = jsonLd.title; bestImage = jsonLd.imageUrl || null; }

  // Strategy 2: any embedded window var (runParams, __INITIAL_STATE__, etc.)
  const winVar = extractWindowVar(html);
  if (winVar) {
    const result = parseRunParamsData(winVar);
    if (result?.title && result?.price != null) { console.log(`[aliexpress] price via window.${winVar.name}`); return result; }
    // Even if no price, use title/image from it and also try generic walker
    if (result?.title) { bestTitle = bestTitle || result.title; bestImage = bestImage || result.imageUrl; }
    if (!result?.price) {
      const genericPrice = findPriceInData(winVar.data);
      if (genericPrice && (result?.title || bestTitle)) {
        console.log(`[aliexpress] price via generic walk of window.${winVar.name}`);
        const cur = winVar.data?.data?.priceModule?.minAmount?.currency || 'USD';
        return {
          title: result?.title || bestTitle,
          price: genericPrice,
          originalPrice: null,
          currency: cur,
          sellerName: result?.sellerName || null,
          isAmazonDirect: false,
          isPrime: false,
          inStock: result?.inStock ?? true,
          imageUrl: result?.imageUrl || bestImage || null,
        };
      }
    }
  }

  // Strategy 3: __NEXT_DATA__
  const nextResult = parseAliNextData($);
  if (nextResult?.title && nextResult?.price != null) { console.log('[aliexpress] price via __NEXT_DATA__'); return nextResult; }
  if (nextResult?.title) { bestTitle = bestTitle || nextResult.title; bestImage = bestImage || nextResult.imageUrl; }

  // Strategy 4: meta tags + regex
  const metaResult = parseAliMeta($, html);
  if (metaResult?.title && metaResult?.price != null) { console.log('[aliexpress] price via meta/regex'); return metaResult; }
  if (metaResult?.title) { bestTitle = bestTitle || metaResult.title; bestImage = bestImage || metaResult.imageUrl; }

  // Strategy 5: raw currency scan with best title accumulated
  const finalTitle = bestTitle || $('title').text().replace(/\s*\|.*$|\s*-\s*AliExpress.*$/i, '').trim() || null;
  const raw = rawCurrencyScan(html);
  if (finalTitle && raw) {
    console.log('[aliexpress] price via raw currency scan');
    return {
      title: finalTitle, price: raw.price, originalPrice: null, currency: raw.currency,
      sellerName: null, isAmazonDirect: false, isPrime: false, inStock: true,
      imageUrl: bestImage || $('meta[property="og:image"]').attr('content') || null,
    };
  }

  console.log(`[aliexpress] all strategies failed — title=${!!finalTitle} price=none (page may be bot-blocked)`);
  return null;
}

async function scrapeAliExpress(url, appKey, appSecret) {
  // 1. Try affiliate API first — reliable, no bot risk
  const key = appKey || process.env.ALIEXPRESS_APP_KEY;
  const secret = appSecret || process.env.ALIEXPRESS_APP_SECRET;
  if (key && secret) {
    try {
      const result = await scrapeAliExpressAPI(url, key, secret);
      if (result?.title && result?.price != null) {
        console.log(`[aliexpress] affiliate API OK: ${result.currency} ${result.price}`);
        return result;
      }
    } catch (err) {
      console.error(`[aliexpress] affiliate API error, falling back to HTML: ${err.message}`);
    }
  }

  // 2. Fall back to HTML scraping — warm up session cookies first
  const cookies = await fetchAliCookies();

  // Try: English www → Arabic ar (which shows SAR prices and may have different SSR)
  const itemId = url.match(/\/item\/(\d+)/)?.[1];
  const urlsToTry = [
    { u: url, lang: 'en-US,en;q=0.9' },
    ...(itemId ? [{ u: `https://ar.aliexpress.com/item/${itemId}.html`, lang: 'ar-SA,ar;q=0.9,en;q=0.8' }] : []),
  ];

  let lastError;
  for (const { u, lang } of urlsToTry) {
    for (let attempt = 0; attempt < 2; attempt++) {
      if (attempt > 0) await new Promise(r => setTimeout(r, 4000));
      try {
        const html = await tryFetchAli(u, cookies, lang);
        const result = parseAliHtml(html);
        if (result?.title && result?.price != null) return result;
        // Got title but no price — continue to next URL variant
        lastError = new Error('Could not parse AliExpress product data from page');
      } catch (err) {
        lastError = err;
        console.error(`[aliexpress] fetch error (${u}): ${err.message}`);
      }
    }
  }
  throw lastError || new Error('AliExpress scraping failed');
}

module.exports = { scrapeAmazonSA, scrapeAliExpress, scrapeAliExpressAPI, normalizeUrl, extractASIN };
