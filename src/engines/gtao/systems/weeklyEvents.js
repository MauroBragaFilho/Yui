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
 * comando /gta-semanal, pelo /yui-resumo-semanal e pelo scheduler
 * automático.
 */

const WEEKLY_TITLE_KEYWORDS = [
  'bonus',
  'bonuses',
  'podium',
  'prize ride',
  'discount',
  'discounts',
  'now available in gta online',
  'gta$',
  'twitch prime',
  'prime gaming',
  'reward',
  'rewards',
  'triple',
  'double',
  '2x',
  '3x',
  'this week',
  'this week in',
  'weekly',
  'week in gta online',
  'gta+ member',
  'gta+ members',
  'free this week',
  'gta online this week',
  'races',
  'time trial',
];

/**
 * Verifica se um artigo tem "cara" de atualização semanal, seja pelo
 * título (lista de palavras-chave conhecidas) ou pela categoria oficial
 * do post ("GTA Online" / "GTA V"), que costuma acompanhar esses artigos
 * mesmo quando o título é bem genérico (ex: "Take in Triple Rewards...").
 */
function looksLikeWeeklyArticle(title, category) {
  const lower = (title || '').toLowerCase();
  const lowerCategory = (category || '').toLowerCase();
  if (WEEKLY_TITLE_KEYWORDS.some((kw) => lower.includes(kw))) return true;
  return lowerCategory.includes('gta online') || lowerCategory.includes('gta v');
}

export async function fetchWeeklyEvent() {
  try {
    const articles = await scrapeNewswireArticles();

    if (!articles || articles.length === 0) {
      logger.warn('[GTAO] fetchWeeklyEvent(): nenhum artigo encontrado no Newswire.');
      return null;
    }

    // Os artigos vêm ordenados do mais recente para o mais antigo.
    let weeklyArticle = articles.find((a) => looksLikeWeeklyArticle(a.title, a.category));

    // Fallback: se nenhum título/categoria bateu com as keywords conhecidas,
    // assume o artigo mais recente. A Rockstar publica a atualização semanal
    // quase sempre como o post mais novo do Newswire nas quintas-feiras, e
    // os títulos variam demais para depender só de uma lista fixa de termos.
    if (!weeklyArticle) {
      logger.warn(
        `[GTAO] fetchWeeklyEvent(): nenhum título reconhecido pelas keywords. Usando fallback (artigo mais recente): "${articles[0].title}"`
      );
      weeklyArticle = articles[0];
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

    // Texto completo (usado pela análise da IA) e versão cortada (usada no
    // embed do Discord, que tem limite de 1024 caracteres por campo).
    const fullSummary = translatedParagraphs.join('\n\n');
    const summary =
      fullSummary.length > 1000 ? `${fullSummary.slice(0, 1000).trim()}…` : fullSummary;

    const weeklyData = {
      title: translatedTitle,
      url: weeklyArticle.url,
      summary,
      fullText: fullSummary,
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
