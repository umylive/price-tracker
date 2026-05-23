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
  const s = text.replace(/[٠-٩]/g, d => d.charCodeAt(0) - 0x0660)
                .replace(/[,،\s]/g, '');
  const m = s.match(/[\d]+\.?\d{0,2}/);
  return m ? parseFloat(m[0]) : null;
}

// ── Amazon SA ─────────────────────────────────────────────────────────────────

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

// ── AliExpress (Zenrows proxy) ────────────────────────────────────────────────

function extractBracedJson(html, marker) {
  const idx = html.indexOf(marker);
  if (idx === -1) return null;
  const start = html.indexOf('{', idx + marker.length);
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (esc) { esc = false; continue; }
    if (c === '\\' && inStr) { esc = true; continue; }
    if (c === '"') { inStr = !inStr; continue; }
    if (inStr) continue;
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

function parseAliRunParams(html) {
  const rp = extractBracedJson(html, 'window.runParams = ') ||
             extractBracedJson(html, 'window.runParams=');
  if (!rp) return null;

  const d = rp.data || rp;
  const title = (d.pageModule || {}).title || null;
  if (!title) return null;

  const priceModule = d.priceModule || {};
  const skuModule = d.skuModule || {};
  const imageModule = d.imageModule || {};
  const storeModule = d.storeModule || {};
  const quantityModule = d.quantityModule || {};
  const currency = priceModule.currencyCode || 'USD';

  let price = null;
  // For variant products, take minimum sale price across all SKUs
  if (Array.isArray(skuModule.skuPriceList) && skuModule.skuPriceList.length) {
    for (const sku of skuModule.skuPriceList) {
      const v = sku.skuVal || {};
      const p = v.actSkuCalPrice != null ? parseFloat(v.actSkuCalPrice)
              : v.skuActivityAmount?.value != null ? Number(v.skuActivityAmount.value)
              : v.skuAmount?.value != null ? Number(v.skuAmount.value) : null;
      if (p != null && !isNaN(p)) price = price == null ? p : Math.min(price, p);
    }
  }
  if (price == null) {
    price = priceModule.minActivityPrice?.value != null ? Number(priceModule.minActivityPrice.value)
          : priceModule.minAmount?.value != null ? Number(priceModule.minAmount.value)
          : parsePrice(priceModule.formatedPrice || '');
  }

  const origPrice = priceModule.maxAmount?.value != null ? Number(priceModule.maxAmount.value) : null;

  return {
    title,
    price: price != null && !isNaN(price) ? price : null,
    originalPrice: (origPrice != null && !isNaN(origPrice) && price != null && origPrice > price) ? origPrice : null,
    currency,
    sellerName: storeModule.storeName || null,
    isAmazonDirect: false,
    isPrime: false,
    inStock: (quantityModule.totalAvailQuantity ?? 1) > 0,
    imageUrl: imageModule.imagePathList?.[0] || imageModule.summImagePathList?.[0] || null,
  };
}

function parseAliNextData(html) {
  const m = html.match(/<script[^>]*id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  let nd;
  try { nd = JSON.parse(m[1]); } catch { return null; }

  const pp = nd?.props?.pageProps || {};
  const prod = pp.product || pp.itemInfo?.item || pp.data?.product || null;
  if (!prod) return null;

  const title = prod.title || prod.name || null;
  if (!title) return null;

  const rawPrice = prod.salePrice?.formattedPrice || prod.priceInfo?.price?.value || prod.price || null;
  const price = rawPrice != null ? parsePrice(String(rawPrice)) : null;

  return {
    title,
    price,
    originalPrice: null,
    currency: 'USD',
    sellerName: prod.store?.name || null,
    isAmazonDirect: false,
    isPrime: false,
    inStock: true,
    imageUrl: prod.images?.[0] || prod.imageUrl || null,
  };
}

function parseAliMeta($, html) {
  const title = $('meta[property="og:title"]').attr('content') ||
                $('title').first().text().replace(/\s*[-|–].*$/, '').trim() || null;
  if (!title) return null;

  const imageUrl = $('meta[property="og:image"]').attr('content') || null;
  const m = html.match(/US\s*\$\s*(\d+(?:\.\d{1,2})?)/i) ||
            html.match(/\$\s*(\d+(?:\.\d{1,2})?)/);
  const price = m ? parseFloat(m[1]) : null;

  return {
    title,
    price,
    originalPrice: null,
    currency: 'USD',
    sellerName: null,
    isAmazonDirect: false,
    isPrime: false,
    inStock: true,
    imageUrl,
  };
}

function parseAliScriptBlobs(html) {
  // Scan all inline scripts for any JSON object containing a product title and price.
  // Covers window.__STORE__, window.__INITIAL_STATE__, window._dux_, etc.
  const scriptRe = /<script[^>]*>([\s\S]*?)<\/script>/gi;
  let m;
  while ((m = scriptRe.exec(html)) !== null) {
    const src = m[1];
    if (!src.includes('productId') && !src.includes('itemId') && !src.includes('subject')) continue;
    // Try to extract any JSON object from the script that has a recognisable title field
    const jsonRe = /\{[\s\S]{50,}/g;
    let jm;
    while ((jm = jsonRe.exec(src)) !== null) {
      let obj;
      try {
        // Walk backwards until valid JSON
        for (let end = jm.index + jm[0].length; end <= src.length; end++) {
          try { obj = JSON.parse(src.slice(jm.index, end)); break; } catch {}
        }
      } catch {}
      if (!obj) continue;
      const flat = JSON.stringify(obj);
      if (!flat.includes('"subject"') && !flat.includes('"title"') && !flat.includes('"name"')) continue;
      const title = obj?.subject || obj?.title || obj?.name ||
                    obj?.data?.subject || obj?.data?.title ||
                    obj?.product?.subject || obj?.product?.title || null;
      if (!title || typeof title !== 'string' || title.length < 5) continue;
      const priceRaw = obj?.salePrice?.minPrice || obj?.price?.minPrice ||
                       obj?.data?.price?.minPrice || obj?.product?.salePrice ||
                       null;
      const price = priceRaw != null ? parsePrice(String(priceRaw)) : null;
      if (!price) continue;
      return {
        title,
        price,
        originalPrice: null,
        currency: 'USD',
        sellerName: obj?.sellerInfo?.storeName || obj?.storeInfo?.storeName || null,
        isAmazonDirect: false,
        isPrime: false,
        inStock: true,
        imageUrl: obj?.imageUrl || obj?.images?.[0] || null,
      };
    }
  }
  return null;
}

async function scrapeAliExpress(url) {
  console.log(`[aliexpress] fetching: ${url}`);
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 3000 * attempt));
    try {
      const { data: html, status } = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
        },
        timeout: 30000,
        maxRedirects: 5,
      });

      if (status !== 200) throw new Error(`HTTP ${status}`);

      const $ = cheerio.load(html);

      // Diagnose what we're working with
      const markers = {
        cf: html.includes('cf-browser-verification') || html.includes('Just a moment'),
        captcha: html.includes('captcha') || html.includes('_Captcha'),
        runParams: html.includes('window.runParams'),
        nextData: html.includes('__NEXT_DATA__'),
        ld: html.includes('"@type":"Product"') || html.includes('"@type": "Product"'),
        store: html.includes('window.__STORE__') || html.includes('window.__INITIAL_STATE__'),
        subject: html.includes('"subject"'),
        salePrice: html.includes('salePrice') || html.includes('sale_price'),
      };
      console.log(`[aliexpress] page ${html.length}b — ${JSON.stringify(markers)}`);

      if (markers.cf || markers.captcha) {
        throw new Error('Bot/CAPTCHA page detected — AliExpress blocked the request');
      }

      // Strategy 1: JSON-LD structured data
      const ld = parseJsonLd($);
      if (ld?.title && ld?.price != null) {
        console.log('[aliexpress] parsed via JSON-LD');
        return { ...ld, isAmazonDirect: false, isPrime: false };
      }

      // Strategy 2: window.runParams embedded JS object
      const rp = parseAliRunParams(html);
      if (rp?.title) { console.log('[aliexpress] parsed via runParams'); return rp; }

      // Strategy 3: __NEXT_DATA__ (Next.js SSR)
      const nd = parseAliNextData(html);
      if (nd?.title) { console.log('[aliexpress] parsed via NEXT_DATA'); return nd; }

      // Strategy 4: broader script blob scan (window.__STORE__ etc.)
      const sb = parseAliScriptBlobs(html);
      if (sb?.title) { console.log('[aliexpress] parsed via script blob'); return sb; }

      // Strategy 5: og: meta tags + regex price scan
      const meta = parseAliMeta($, html);
      if (meta?.title) { console.log('[aliexpress] parsed via og:meta'); return meta; }

      // Log a snippet to help diagnose unknown page structures
      console.log('[aliexpress] parse failed — page snippet:', html.slice(0, 500).replace(/\s+/g, ' '));
      throw new Error('Could not extract product data from AliExpress page');
    } catch (err) {
      lastError = err;
      if (err.message.includes('Bot/CAPTCHA')) break;
      console.error(`[aliexpress] attempt ${attempt + 1} failed: ${err.message}`);
    }
  }
  throw lastError || new Error('AliExpress scraping failed');
}

module.exports = { scrapeAmazonSA, scrapeAliExpress, normalizeUrl, extractASIN };
