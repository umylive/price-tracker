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

function normalizeUrl(input) {
  if (!input) return null;
  const trimmed = input.trim();
  if (trimmed.includes('aliexpress.com')) return null;
  // IKEA SA
  if (trimmed.includes('ikea.com')) {
    const m = trimmed.match(/ikea\.com\/sa\/(?:en|ar)\/p\/([^/?#]+)\/?/i);
    if (m) {
      const slug = m[1];
      return { url: `https://www.ikea.com/sa/en/p/${slug}/`, asin: null, store: 'ikea_sa' };
    }
    return null;
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
        hasOtherSellers: false,
        otherSellersPrice: null,
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
    $('#buybox').text() + ' ' +
    $('#shipsFromSoldBy_feature_div').text() + ' ' +
    $('#sellerProfileTriggerId').text()
  ).toLowerCase();
  const sellerEl =
    $('#sellerProfileTriggerId').first().text().trim() ||
    $('#tabular-buybox-truncate-0 .tabular-buybox-text').first().text().trim() ||
    $('#merchant-info a').first().text().trim() ||
    $('#tabular-buybox-container .tabular-buybox-text').first().text().trim();
  const sellerName = sellerEl || null;
  const isAmazonDirect =
    /ships from.*sold by amazon/i.test(merchantText) ||
    /dispatched.*sold by amazon/i.test(merchantText) ||
    /sold by.*amazon\.sa/i.test(merchantText) ||
    /fulfilled by amazon/i.test(merchantText) ||
    /\bamazon\.sa\b/i.test(merchantText) ||
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

  // Detect other sellers when main listing is out of stock
  let hasOtherSellers = false;
  let otherSellersPrice = null;
  if (!inStock) {
    const olpText = $('#olp_feature_div').text() + ' ' + $('#mbc-main').text() + ' ' + $('#moreBuyingChoices_feature_div').text();
    const priceMatch = olpText.match(/SAR\s*([\d,]+\.?\d*)/i);
    if (priceMatch) {
      otherSellersPrice = parsePrice(priceMatch[1]);
      hasOtherSellers = !!otherSellersPrice;
    }
  }

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
    hasOtherSellers,
    otherSellersPrice,
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
      if (!result || !result.title) {
        result = parseCssSelectors($);
      } else if (!result.sellerName) {
        // JSON-LD had title/price but no seller — supplement from CSS selectors
        const css = parseCssSelectors($);
        if (css) {
          result.sellerName = css.sellerName;
          result.isAmazonDirect = css.isAmazonDirect;
          result.isPrime = result.isPrime || css.isPrime;
          if (result.inStock == null) result.inStock = css.inStock;
          if (result.imageUrl == null) result.imageUrl = css.imageUrl;
          result.hasOtherSellers = css.hasOtherSellers;
          result.otherSellersPrice = css.otherSellersPrice;
        }
      }
      if (!result || !result.title) throw new Error('Could not parse product data from page');

      return result;
    } catch (err) {
      lastError = err;
      if (err.message.includes('CAPTCHA') || err.message.includes('Bot/CAPTCHA')) break;
    }
  }
  throw lastError || new Error('Scraping failed');
}

function safeParseFloat(v) {
  const n = parseFloat(String(v ?? '').replace(/[,،\s]/g, ''));
  return Number.isFinite(n) && n > 0 ? n : null;
}

function parseIkeaNextData(html) {
  // IKEA uses Next.js; product data is embedded in __NEXT_DATA__
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try {
    const nd = JSON.parse(m[1]);
    const props = nd?.props?.pageProps;
    if (!props) return null;
    const product = props.product || props.initialData?.product ||
                    props.data?.product || props.pageData?.product;
    if (!product) return null;
    const title = product.name || product.productTitle || product.title;
    if (!title) return null;

    let price = null;
    const pd = product.price || product.salesPrice;
    if (pd != null) {
      if (typeof pd === 'number') price = pd;
      else if (typeof pd === 'object') price = pd.currentPrice ?? pd.value ?? pd.price ?? null;
      else price = safeParseFloat(pd);
    }
    if (!Number.isFinite(price) || price <= 0) price = null;

    const media = product.mainImage?.url || product.images?.[0]?.url ||
                  product.media?.[0]?.sources?.[0]?.url || null;
    const inStock = product.availability !== 'OUT_OF_STOCK' &&
                    product.inStock !== false && product.buyable !== false;
    return {
      title,
      price,
      originalPrice: null,
      currency: 'SAR',
      sellerName: 'IKEA',
      isAmazonDirect: false,
      isPrime: false,
      inStock: !!inStock,
      imageUrl: media,
      hasOtherSellers: false,
      otherSellersPrice: null,
    };
  } catch (_) { return null; }
}

function parseIkeaCssSelectors($, html) {
  const title =
    $('h1.pip-header-section__title--big').text().trim() ||
    $('[class*="pip-header-section__title"]').first().text().trim() ||
    $('meta[property="og:title"]').attr('content')?.trim() ||
    $('h1').first().text().trim();
  if (!title || title.length < 3) return null;

  let price = null;
  const intEl = $([
    '.pip-price-package__main .pip-price__integer',
    '.pip-temp-price-module__price .pip-price__integer',
    '.range-revamp-price__integer',
  ].join(', ')).first().text().replace(/[^\d]/g, '');
  const decEl = $([
    '.pip-price-package__main .pip-price__decimals',
    '.pip-temp-price-module__price .pip-price__decimals',
    '.range-revamp-price__decimals',
  ].join(', ')).first().text().replace(/[^\d]/g, '');
  if (intEl) price = safeParseFloat(intEl + '.' + (decEl ? decEl.substring(0, 2) : '00'));

  if (!price) {
    for (const sel of [
      '[class*="pip-price"][class*="integer"]',
      '.pip-price__integer',
      '[data-price]',
    ]) {
      const t = $(sel).first().attr('data-price') || $(sel).first().text().trim();
      if (t) { price = safeParseFloat(t); if (price) break; }
    }
  }

  let originalPrice = null;
  const origInt = $([
    '.pip-price-package__previous .pip-price__integer',
    '.pip-price__previous-price .pip-price__integer',
  ].join(', ')).first().text().replace(/[^\d]/g, '');
  if (origInt) {
    const origDec = $('.pip-price-package__previous .pip-price__decimals').first().text().replace(/[^\d]/g, '');
    originalPrice = safeParseFloat(origInt + '.' + (origDec ? origDec.substring(0, 2) : '00'));
  }

  const outEl = $('[class*="out-of-stock"], [class*="not-available"], [class*="outOfStock"]');
  const hasBuyBtn = $('[class*="add-to-bag"], [class*="buy-button"], button[class*="buy"]').length > 0;
  const inStock = outEl.length === 0 && (hasBuyBtn || $('[class*="buy-module"]').length > 0);

  const imageUrl =
    $('meta[property="og:image"]').attr('content') ||
    $('img[class*="pip-media-grid__image"]').first().attr('src') ||
    $('img[class*="pip-aspect-ratio-image__image"]').first().attr('src') ||
    $('[class*="pip-media-grid"] img').first().attr('src') || null;

  return {
    title,
    price,
    originalPrice: originalPrice && originalPrice !== price ? originalPrice : null,
    currency: 'SAR',
    sellerName: 'IKEA',
    isAmazonDirect: false,
    isPrime: false,
    inStock,
    imageUrl,
    hasOtherSellers: false,
    otherSellersPrice: null,
  };
}

async function scrapeIkea(url) {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await new Promise(r => setTimeout(r, 2000 * attempt));
    try {
      const { data, status } = await axios.get(url, {
        headers: {
          'User-Agent': getRandomUA(),
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
          'Accept-Language': 'en-SA,en;q=0.9',
          'Accept-Encoding': 'gzip, deflate, br',
          'Connection': 'keep-alive',
          'Upgrade-Insecure-Requests': '1',
          'Sec-Fetch-Dest': 'document',
          'Sec-Fetch-Mode': 'navigate',
          'Sec-Fetch-Site': 'none',
          'Cache-Control': 'max-age=0',
          'Referer': 'https://www.ikea.com/sa/en/',
        },
        timeout: 25000,
        maxRedirects: 5,
      });

      if (status !== 200) throw new Error(`HTTP ${status}`);

      const $ = cheerio.load(data);

      // 1) Try __NEXT_DATA__ (IKEA is a Next.js app)
      let result = parseIkeaNextData(data);

      // 2) Fall back to JSON-LD
      if (!result || !result.title) {
        result = parseJsonLd($);
        if (result) {
          result.sellerName = 'IKEA';
          result.isAmazonDirect = false;
          result.currency = 'SAR';
        }
      }

      // 3) Fall back to CSS selectors
      if (!result || !result.title) {
        result = parseIkeaCssSelectors($, data);
      }

      if (!result || !result.title) throw new Error('Could not parse IKEA product data — page may be JS-rendered or blocked');

      // Always try og:image as fallback — parseIkeaNextData may return null imageUrl
      if (!result.imageUrl) {
        result.imageUrl =
          $('meta[property="og:image"]').attr('content') ||
          $('img[class*="pip-media-grid__image"]').first().attr('src') ||
          $('img[class*="pip-aspect-ratio-image__image"]').first().attr('src') ||
          $('[class*="pip-media-grid"] img').first().attr('src') || null;
      }

      // Ensure all price fields are safe numbers (no NaN/Infinity)
      result.price = Number.isFinite(result.price) && result.price > 0 ? result.price : null;
      result.originalPrice = Number.isFinite(result.originalPrice) && result.originalPrice > 0 ? result.originalPrice : null;
      result.sellerName = 'IKEA';
      result.isAmazonDirect = false;
      result.currency = 'SAR';
      result.hasOtherSellers = false;
      result.otherSellersPrice = null;
      return result;
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error('IKEA scraping failed');
}

module.exports = { scrapeAmazonSA, scrapeIkea, normalizeUrl, extractASIN };
