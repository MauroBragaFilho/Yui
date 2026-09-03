import * as cheerio from 'cheerio';
import puppeteer from 'puppeteer';
import { logger } from '../../utils/logger.js';
import { CONSTANTS } from '../../config/constants.js';

const GRAPHQL_LIST_URL =
  'https://graph.rockstargames.com/?origin=https://www.rockstargames.com&operationName=NewswireList&variables=%7B%22tagIdHash%22%3Anull%2C%22page%22%3A1%2C%22metaUrl%22%3A%22%2Fnewswire%22%2C%22limit%22%3A20%2C%22locale%22%3A%22en_us%22%7D&extensions=%7B%22persistedQuery%22%3A%7B%22version%22%3A1%2C%22sha256Hash%22%3A%227ec00215aecc70de257b0719a1dfcfa84fe57fdc7bf5c10ec2e8f377defede58%22%7D%7D';

const GRAPHQL_POST_HASH = '555658813abe5acc8010de1a1feddd6fd8fddffbdc35d3723d4dc0fe4ded6810';

const FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36',
  'Accept': 'application/json, text/plain, */*',
  'Origin': 'https://www.rockstargames.com',
  'Referer': 'https://www.rockstargames.com/newswire',
};

/**
 * 1. Coleta a lista de artigos via API GraphQL pública oficial da Rockstar (Zero CPU / Zero Chromium)
 */
async function fetchNewswireListGraphQL() {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(GRAPHQL_LIST_URL, {
      headers: FETCH_HEADERS,
      signal: controller.signal,
    });

    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const results = json?.data?.posts?.results;

    if (!Array.isArray(results) || results.length === 0) return [];

    return results.slice(0, 15).map((item) => {
      const fullUrl = item.url.startsWith('http')
        ? item.url
        : `https://www.rockstargames.com${item.url}`;

      const primaryTag = item.primary_tags?.[0]?.name || 'Rockstar Games';
      const thumbnail =
        item.preview_images_parsed?.d16x9 ||
        item.preview_images_parsed?.square ||
        item.header_image ||
        '';

      return {
        id: item.id || fullUrl,
        title: (item.title || '').trim(),
        url: fullUrl,
        category: primaryTag,
        thumbnailUrl: thumbnail,
        publishedAt: item.created || new Date().toISOString(),
      };
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * 2. Coleta o corpo de um artigo via API GraphQL com fallback Cheerio (Zero CPU)
 */
async function fetchArticleBodyGraphQL(articleId) {
  const variables = encodeURIComponent(JSON.stringify({ locale: 'en_us', id_hash: articleId }));
  const extensions = encodeURIComponent(
    JSON.stringify({ persistedQuery: { version: 1, sha256Hash: GRAPHQL_POST_HASH } })
  );
  const url = `https://graph.rockstargames.com/?origin=https://www.rockstargames.com&operationName=NewswirePost&variables=${variables}&extensions=${extensions}`;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);

  try {
    const res = await fetch(url, { headers: FETCH_HEADERS, signal: controller.signal });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);

    const json = await res.json();
    const post = json?.data?.post;
    if (!post) return { paragraphs: [], heroImageUrl: '' };

    // Corpo do artigo. A Rockstar migrou o formato: antes vinha em
    // `post.content` (HTML); agora (2026+) vem em `post.tina.payload.content`
    // (blocos + `_memoq.content` com HTML). Montamos o HTML bruto unindo
    // todos os blocos de texto encontrados, com fallback para o legado.
    let rawContent = post.content || '';

    if (!rawContent && post.tina && post.tina.payload) {
      const blocksArray = post.tina.payload.content;
      const htmlParts = [];
      const collectHtml = (node) => {
        if (!node || typeof node !== 'object') return;
        if (node._template === 'HTMLElement') {
          const c = node?._memoq?.content;
          if (typeof c === 'string' && c.trim()) htmlParts.push(c.trim());
        }
        for (const k of Object.keys(node)) {
          const v = node[k];
          if (Array.isArray(v)) v.forEach(collectHtml);
          else if (v && typeof v === 'object') collectHtml(v);
        }
      };
      collectHtml(blocksArray);
      rawContent = htmlParts.join('\n');
    }

    const $ = cheerio.load(rawContent);
    const paragraphs = [];
    const seen = new Set();

    $('p').each((_, el) => {
      const text = $(el).text().trim();
      if (text.length > 20 && !seen.has(text)) {
        seen.add(text);
        paragraphs.push(text);
      }
    });

    // Hero image. Novo formato: `post.tina.payload.meta.preview_images`.
    // Legado: `post.posts_hero` / `post.header_image` / primeiro bloco.
    let heroImageUrl =
      post?.tina?.payload?.meta?.preview_images?.en_us?.['newswire-block-16x9'] ||
      post?.tina?.payload?.meta?.preview_images?.['newswire-block-16x9'] ||
      '';

    if (!heroImageUrl && rawContent) {
      const firstImg = $(rawContent).find('img').first();
      const src = firstImg.attr('src') || firstImg.attr('data-src') || '';
      if (src) heroImageUrl = src.startsWith('http') ? src : `https://www.rockstargames.com${src}`;
    }

    if (!heroImageUrl) {
      heroImageUrl =
        post?.posts_hero?.desktop || post?.posts_hero?.mobile || post?.header_image || '';
    }

    if (heroImageUrl && !/^https?:/.test(heroImageUrl)) {
      heroImageUrl = `https://www.rockstargames.com${heroImageUrl}`;
    }

    return { paragraphs, heroImageUrl };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Fallback Puppeteer Low-CPU caso a API GraphQL falhe ou mude hash
 */
async function scrapeNewswirePuppeteerFallback() {
  let browser = null;
  const articles = [];

  try {
    logger.info('[NewswireEngine] [Fallback Puppeteer] Iniciando Chromium Low-CPU...');

    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--no-first-run',
        '--no-zygote',
        '--disable-gpu',
        '--disable-extensions',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36'
    );
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['image', 'stylesheet', 'font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(CONSTANTS.ROCKSTAR_NEWSWIRE_URL, {
      waitUntil: 'networkidle2',
      timeout: 20000,
    });

    await page.waitForSelector('a[href*="/newswire/article/"]', { timeout: 10000 }).catch(() => null);

    const rawData = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const links = Array.from(document.querySelectorAll('a[href*="/newswire/article/"]'));
      return links.slice(0, 15).map((a) => {
        const href = a.getAttribute('href') || '';
        const titleEl = a.querySelector('h1, h2, h3, h4, h5, [class*="title"], [class*="heading"]');
        const imgEl = a.querySelector('img');
        const tagEl = a.querySelector('[class*="tag"], [class*="category"]');
        const timeEl = a.querySelector('time, [class*="date"]');

        const fullUrl = href.startsWith('http') ? href : `https://www.rockstargames.com${href}`;
        const parts = href.split('/article/')[1]?.split('/') || [];
        const articleId = parts[0] || fullUrl;

        return {
          id: articleId,
          title: (titleEl ? titleEl.textContent : a.textContent || '').trim(),
          url: fullUrl,
          category: tagEl ? tagEl.textContent.trim() : 'Rockstar Games',
          thumbnailUrl: imgEl ? imgEl.getAttribute('src') || imgEl.getAttribute('data-src') || '' : '',
          publishedAt: timeEl ? timeEl.getAttribute('datetime') || timeEl.textContent.trim() : new Date().toISOString(),
        };
      });
      /* eslint-enable no-undef */
    });

    for (const item of rawData) {
      if (item.url && item.title && !articles.some((a) => a.url === item.url)) {
        articles.push(item);
      }
    }
  } catch (err) {
    logger.error(`[NewswireEngine] [Fallback Puppeteer] Erro: ${err.message}`);
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (_) {}
    }
  }

  return articles;
}

export async function scrapeNewswireArticles() {
  logger.info('[NewswireEngine] Iniciando coleta de notícias via API GraphQL (alta velocidade, zero CPU)...');

  try {
    const articles = await fetchNewswireListGraphQL();
    if (articles && articles.length > 0) {
      logger.info(`[NewswireEngine] ✅ ${articles.length} notícias obtidas via API direta (sem abrir Chromium).`);
      return articles;
    }
  } catch (err) {
    logger.warn(`[NewswireEngine] API GraphQL falhou (${err.message}). Acionando fallback Puppeteer...`);
  }

  return await scrapeNewswirePuppeteerFallback();
}

export async function scrapeArticleBody(url) {
  logger.info(`[NewswireEngine] Lendo corpo do artigo: ${url}`);

  const parts = url.split('/article/')[1]?.split('/') || [];
  const articleId = parts[0];

  if (articleId) {
    try {
      const result = await fetchArticleBodyGraphQL(articleId);
      if (result.paragraphs && result.paragraphs.length > 0) {
        logger.info(`[NewswireEngine] ✅ Artigo lido via API: ${result.paragraphs.length} parágrafos.`);
        return result;
      }
    } catch (err) {
      logger.warn(`[NewswireEngine] Falha ao ler artigo via API (${err.message}). Tentando Puppeteer...`);
    }
  }

  return { paragraphs: [], heroImageUrl: '' };
}

export default {
  scrapeNewswireArticles,
  scrapeArticleBody,
};
