import { scrapeNewswireArticles, scrapeArticleBody } from '../../newswire/scraper.js';
import { fetchWeeklyEventFromReddit } from './redditWeeklyScraper.js';
import { translateToPortuguese } from '../../../utils/translate.js';
import { logger } from '../../../utils/logger.js';

// Deixe 'false': Reddit é a fonte principal, Newswire é fallback (não apagado).
const NEWSWIRE_AS_PRIMARY = false;

const WEEKLY_TITLE_KEYWORDS = [
  'bonus',
  'bonuses',
  'podium',
  'prize ride',
  'discount',
  'now available in gta online',
  'gta$',
  'twitch prime',
  'prime gaming',
];

function looksLikeWeeklyArticle(title) {
  const lower = (title || '').toLowerCase();
  return WEEKLY_TITLE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * FONTE DE FALLBACK (Rockstar Newswire). Mantida intacta — só é chamada
 * se o Reddit falhar (fora do ar, bloqueio, post ainda não publicado, etc).
 */
async function fetchWeeklyEventFromNewswire() {
  try {
    const articles = await scrapeNewswireArticles();

    if (!articles || articles.length === 0) {
      logger.warn('[GTAO] fetchWeeklyEventFromNewswire(): nenhum artigo encontrado no Newswire.');
      return null;
    }

    const weeklyArticle = articles.find((a) => looksLikeWeeklyArticle(a.title));

    if (!weeklyArticle) {
      logger.info('[GTAO] fetchWeeklyEventFromNewswire(): nenhum artigo com cara de atualização semanal encontrado.');
      return null;
    }

    const { paragraphs, heroImageUrl } = await scrapeArticleBody(weeklyArticle.url);

    if (!paragraphs || paragraphs.length === 0) {
      logger.warn('[GTAO] fetchWeeklyEventFromNewswire(): artigo encontrado, mas sem parágrafos legíveis.');
      return null;
    }

    const translatedTitle = await translateToPortuguese(weeklyArticle.title);

    const translatedParagraphs = [];
    for (const paragraph of paragraphs.slice(0, 12)) {
      // eslint-disable-next-line no-await-in-loop
      translatedParagraphs.push(await translateToPortuguese(paragraph));
    }

    const fullSummary = translatedParagraphs.join('\n\n');
    const summary = fullSummary.length > 1000 ? `${fullSummary.slice(0, 1000).trim()}…` : fullSummary;

    const weeklyData = {
      title: translatedTitle,
      url: weeklyArticle.url,
      summary,
      thumbnailUrl: heroImageUrl || weeklyArticle.thumbnailUrl || '',
      publishedAt: weeklyArticle.publishedAt,
      source: 'newswire',
    };

    logger.info(`[GTAO] fetchWeeklyEventFromNewswire(): artigo semanal capturado — "${translatedTitle}"`);
    return weeklyData;
  } catch (error) {
    logger.error(`[GTAO] fetchWeeklyEventFromNewswire(): erro inesperado: ${error.message}`);
    return null;
  }
}

/**
 * Ponto de entrada usado pelo resto do bot (comando /yui-semanal, scheduler,
 * e o cache em `gtaoRepository.saveWeekly`). Ordem de prioridade:
 *   1. Reddit r/gtaonline (fonte principal — posta geralmente na quarta-feira)
 *   2. Rockstar Newswire (fallback, mantido no código, não deletado)
 */
export async function fetchWeeklyEvent() {
  if (NEWSWIRE_AS_PRIMARY) {
    return fetchWeeklyEventFromNewswire();
  }

  const fromReddit = await fetchWeeklyEventFromReddit();
  if (fromReddit) return fromReddit;

  logger.warn('[GTAO] Reddit indisponível ou sem post novo — caindo para o fallback do Newswire.');
  return fetchWeeklyEventFromNewswire();
}

export { fetchWeeklyEventFromNewswire };
