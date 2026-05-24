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

module.exports = { scrapeAmazonSA, normalizeUrl, extractASIN };
