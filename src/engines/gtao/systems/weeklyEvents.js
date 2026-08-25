import { scrapeNewswireArticles, scrapeArticleBody } from '../../newswire/scraper.js';
import { translateToPortuguese } from '../../../utils/translate.js';
import { logger } from '../../../utils/logger.js';

/**
 * Os bônus/descontos/veículos da ATUALIZAÇÃO SEMANAL do GTA Online não
 * seguem um algoritmo de seed determinístico — eles são escolhidos
 * manualmente pela Rockstar e só se tornam públicos quando ela publica
 * o artigo semanal no Newswire (geralmente às terças/quintas).
 *
 * Esta função busca o artigo semanal mais recente no Newswire, lê o
 * conteúdo completo, traduz para PT-BR e monta os dados usados pelo
 * comando /yui-semanal e pelo scheduler automático.
 */

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

export async function fetchWeeklyEvent() {
  try {
    const articles = await scrapeNewswireArticles();

    if (!articles || articles.length === 0) {
      logger.warn('[GTAO] fetchWeeklyEvent(): nenhum artigo encontrado no Newswire.');
      return null;
    }

    // Os artigos vêm ordenados do mais recente para o mais antigo.
    const weeklyArticle = articles.find((a) => looksLikeWeeklyArticle(a.title));

    if (!weeklyArticle) {
      logger.info(
        '[GTAO] fetchWeeklyEvent(): nenhum artigo com cara de atualização semanal encontrado nos posts recentes.'
      );
      return null;
    }

    // Lê o corpo completo do artigo (a listagem só traz o título)
    const { paragraphs, heroImageUrl } = await scrapeArticleBody(weeklyArticle.url);

    if (!paragraphs || paragraphs.length === 0) {
      logger.warn('[GTAO] fetchWeeklyEvent(): artigo semanal encontrado, mas sem parágrafos legíveis.');
      return null;
    }

    // Traduz o título e cada parágrafo individualmente para PT-BR
    // (a API de tradução tem limite de tamanho por requisição).
    const translatedTitle = await translateToPortuguese(weeklyArticle.title);

    const translatedParagraphs = [];
    for (const paragraph of paragraphs.slice(0, 12)) {
      // eslint-disable-next-line no-await-in-loop
      translatedParagraphs.push(await translateToPortuguese(paragraph));
    }

    // Discord embed fields têm limite de 1024 caracteres — cortamos com folga.
    const fullSummary = translatedParagraphs.join('\n\n');
    const summary =
      fullSummary.length > 1000 ? `${fullSummary.slice(0, 1000).trim()}…` : fullSummary;

    const weeklyData = {
      title: translatedTitle,
      url: weeklyArticle.url,
      summary,
      thumbnailUrl: heroImageUrl || weeklyArticle.thumbnailUrl || '',
      publishedAt: weeklyArticle.publishedAt,
    };

    logger.info(`[GTAO] fetchWeeklyEvent(): artigo semanal capturado e traduzido — "${translatedTitle}"`);
    return weeklyData;
  } catch (error) {
    logger.error(`[GTAO] fetchWeeklyEvent(): erro inesperado: ${error.message}`);
    return null;
  }
}
