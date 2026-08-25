import puppeteer from 'puppeteer';
import { logger } from '../../utils/logger.js';
import { CONSTANTS } from '../../config/constants.js';

function extractArticlesFromPage() {
  return async function evaluateInPage() {
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
  };
}

/**
 * Executa uma única tentativa de raspagem em uma página já aberta.
 * Isolado em função própria para permitir retry limpo em caso de
 * "detached Frame" (o site do Newswire às vezes faz um redirecionamento
 * client-side logo após o domcontentloaded, trocando o frame por baixo
 * dos panos bem no momento da leitura).
 */
async function scrapeOnce(page) {
  await page.goto(CONSTANTS.ROCKSTAR_NEWSWIRE_URL, {
    waitUntil: 'networkidle2',
    timeout: 30000,
  });

  // Espera explícita pelo container dos posts.
  await page.waitForSelector('a[href*="/newswire/article/"]', { timeout: 15000 }).catch(() => null);

  // Pequena folga extra para qualquer redirecionamento client-side
  // (ex: banner de cookies, seletor de idioma) terminar de assentar
  // antes de tentarmos ler o DOM.
  await new Promise((resolve) => setTimeout(resolve, 1500));

  return page.evaluate(extractArticlesFromPage());
}

/**
 * Abre um artigo específico do Newswire e extrai o corpo do texto (parágrafos)
 * e uma imagem de destaque, para casos em que precisamos do conteúdo completo
 * do artigo (ex: atualização semanal), e não só do título/resumo da listagem.
 */
function extractArticleBodyFromPage() {
  return async function evaluateInPage() {
    /* eslint-disable no-undef */
    const paragraphs = Array.from(
      document.querySelectorAll('article p, main p, [class*="body"] p, [class*="content"] p')
    )
      .map((p) => p.textContent.trim())
      .filter((t) => t.length > 20); // descarta legendas/lixo muito curto

    // Remove duplicados mantendo ordem
    const seen = new Set();
    const uniqueParagraphs = paragraphs.filter((p) => {
      if (seen.has(p)) return false;
      seen.add(p);
      return true;
    });

    const heroImg = document.querySelector('article img, main img, [class*="hero"] img');

    return {
      paragraphs: uniqueParagraphs,
      heroImageUrl: heroImg ? heroImg.getAttribute('src') || heroImg.getAttribute('data-src') || '' : '',
    };
    /* eslint-enable no-undef */
  };
}

export async function scrapeArticleBody(url) {
  let browser = null;

  try {
    logger.info(`[NewswireEngine] Abrindo artigo específico para leitura completa: ${url}`);

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
      ],
    });

    const page = await browser.newPage();
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    await page.goto(url, { waitUntil: 'networkidle2', timeout: 30000 });
    await page.waitForSelector('article p, main p', { timeout: 15000 }).catch(() => null);
    await new Promise((resolve) => setTimeout(resolve, 1000));

    const result = await page.evaluate(extractArticleBodyFromPage());
    logger.info(`[NewswireEngine] Artigo lido: ${result.paragraphs.length} parágrafo(s) extraído(s).`);
    return result;
  } catch (error) {
    logger.error(`[NewswireEngine] Erro ao ler artigo completo (${url}): ${error.message}`);
    return { paragraphs: [], heroImageUrl: '' };
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        logger.warn(`[NewswireEngine] Falha ao encerrar browser (leitura de artigo): ${err.message}`);
      }
    }
  }
}

export async function scrapeNewswireArticles() {
  let browser = null;
  const articles = [];

  try {
    logger.info('[NewswireEngine] Iniciando instância on-demand do Puppeteer...');

    // Flags de otimização para ambiente com pouca RAM (Oracle Cloud).
    // Removida a flag --single-process: é conhecida por causar
    // instabilidade ("detached Frame") no Chromium atual do Puppeteer.
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
      ],
    });

    const page = await browser.newPage();

    // Bloquear carregamento de imagens pesadas, fontes e mídia desnecessários
    await page.setRequestInterception(true);
    page.on('request', (req) => {
      const resourceType = req.resourceType();
      if (['font', 'media'].includes(resourceType)) {
        req.abort();
      } else {
        req.continue();
      }
    });

    let rawData;
    try {
      rawData = await scrapeOnce(page);
    } catch (firstError) {
      // Retry único: se o frame se soltou (redirecionamento client-side,
      // navegação lenta), tentamos mais uma vez do zero antes de desistir.
      logger.warn(
        `[NewswireEngine] Primeira tentativa falhou (${firstError.message}). Tentando novamente...`
      );
      const freshPage = await browser.newPage();
      await freshPage.setRequestInterception(true);
      freshPage.on('request', (req) => {
        const resourceType = req.resourceType();
        if (['font', 'media'].includes(resourceType)) {
          req.abort();
        } else {
          req.continue();
        }
      });
      rawData = await scrapeOnce(freshPage);
    }

    // Filtrar e normalizar entradas válidas
    for (const item of rawData) {
      if (item.url && item.title && !articles.some((a) => a.url === item.url)) {
        articles.push(item);
      }
    }

    logger.info(`[NewswireEngine] Coleta finalizada com sucesso. ${articles.length} artigos recentes identificados.`);
  } catch (error) {
    logger.error(`[NewswireEngine] Erro durante a raspagem do Newswire: ${error.message}`);
  } finally {
    // FECHAMENTO OBRIGATÓRIO DO BROWSER: Libera 100% da RAM alocada pelo Chromium imediatamente
    if (browser) {
      try {
        await browser.close();
        logger.info('[NewswireEngine] Processo do Chromium encerrado e memória liberada.');
      } catch (err) {
        logger.warn(`[NewswireEngine] Falha ao encerrar browser: ${err.message}`);
      }
    }
  }

  return articles;
}
