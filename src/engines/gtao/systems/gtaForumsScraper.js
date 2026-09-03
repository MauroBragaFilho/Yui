import puppeteer from 'puppeteer';
import { logger } from '../../../utils/logger.js';

const GTAFORUMS_SEARCH_URL =
  'https://gtaforums.com/search/?q=%22Weekly%20Event%20(%22&quick=1&updated_after=any&sortby=relevancy';

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
];

const REALISTIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function extractTopicsFromSearchPage() {
  return async function evaluateInPage() {
    /* eslint-disable no-undef */
    const links = Array.from(document.querySelectorAll('a[href*="/topic/"]'));
    const seen = new Set();
    const results = [];

    for (const a of links) {
      const title = (a.textContent || '').trim();
      const href = a.getAttribute('href') || '';
      if (!title || !href || seen.has(href)) continue;
      if (!/weekly event\s*\(/i.test(title)) continue;
      seen.add(href);

      const container = a.closest('li, .ipsDataItem, .cSearchResult, article') || a.parentElement;
      const timeEl = container ? container.querySelector('time') : null;
      const dateAttr = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent) : null;

      results.push({
        title,
        url: href.startsWith('http') ? href : `https://gtaforums.com${href}`,
        dateRaw: dateAttr || null,
      });
    }
    return results;
    /* eslint-enable no-undef */
  };
}

function extractFirstPostFromTopicPage() {
  return async function evaluateInPage() {
    /* eslint-disable no-undef */
    const firstPost =
      document.querySelector('[data-role="commentContent"]') ||
      document.querySelector('.ipsType_normal.ipsType_richText') ||
      document.querySelector('.cPost_contentWrap .ipsType_richText');

    if (!firstPost) {
      return { paragraphs: [], heroImageUrl: '' };
    }

    const paragraphs = Array.from(firstPost.querySelectorAll('p, li'))
      .map((el) => el.textContent.trim())
      .filter((t) => t.length > 10);

    const img = firstPost.querySelector('img');
    const heroImageUrl = img ? (img.getAttribute('src') || img.getAttribute('data-src') || '') : '';

    return { paragraphs, heroImageUrl };
    /* eslint-enable no-undef */
  };
}

export async function fetchWeeklyEventFromGtaForums() {
  let browser = null;

  try {
    logger.info('[GTAOEngine] Buscando evento semanal no GTAForums...');

    browser = await puppeteer.launch({ headless: 'new', args: PUPPETEER_ARGS });
    const page = await browser.newPage();
    await page.setUserAgent(REALISTIC_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(GTAFORUMS_SEARCH_URL, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('a[href*="/topic/"]', { timeout: 15000 }).catch(() => null);
    await new Promise((r) => setTimeout(r, 1000));

    const topics = await page.evaluate(extractTopicsFromSearchPage());

    if (!topics || topics.length === 0) {
      logger.warn('[GTAOEngine] GTAForums: nenhum tópico "Weekly Event (" encontrado (pode ser bloqueio anti-bot).');
      return null;
    }

    const target = topics[0];

    const topicPage = await browser.newPage();
    await topicPage.setUserAgent(REALISTIC_UA);
    await topicPage.goto(target.url, { waitUntil: 'networkidle2', timeout: 30000 });
    await topicPage.waitForSelector('body', { timeout: 10000 }).catch(() => null);

    const { paragraphs, heroImageUrl } = await topicPage.evaluate(extractFirstPostFromTopicPage());

    if (!paragraphs || paragraphs.length === 0) {
      logger.warn('[GTAOEngine] GTAForums: tópico encontrado mas sem conteúdo legível no primeiro post.');
      return null;
    }

    // Texto cru em inglês — a tradução para PT-BR é feita pela IA na
    // etapa de análise semanal (weeklyAnalysis.js).
    const fullText = paragraphs.slice(0, 15).join('\n\n');
    const summary = fullText.length > 1000 ? `${fullText.slice(0, 1000).trim()}…` : fullText;

    logger.info(`[GTAOEngine] GTAForums: evento semanal capturado — "${target.title}"`);

    return {
      title: target.title,
      url: target.url,
      summary,
      fullText,
      thumbnailUrl: heroImageUrl || '',
      publishedAt: target.dateRaw || new Date().toISOString(),
      source: 'gtaforums',
    };
  } catch (error) {
    logger.error(`[GTAOEngine] Erro ao buscar evento semanal no GTAForums: ${error.message}`);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        logger.warn(`[GTAOEngine] Falha ao encerrar browser (GTAForums): ${err.message}`);
      }
    }
  }
}