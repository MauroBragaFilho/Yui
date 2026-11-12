import { scrapeNewswireArticles, scrapeArticleBody } from '../../newswire/scraper.js';
import { translateToPortuguese } from '../../../utils/translate.js';
import { logger } from '../../../utils/logger.js';

/**
 * Os bônus/descontos/veículos da ATUALIZAÇÃO SEMANAL do GTA Online não
 * seguem um algoritmo de seed determinístico: são escolhidos manualmente
 * pela Rockstar e só ficam públicos quando ela publica o artigo semanal no
 * Newswire (geralmente às terças/quintas).
 *
 * O Newswire é a fonte oficial e responde pela API direta (sem Chrome). O
 * Reddit continua sendo a fonte padrão (dados estruturados), mas bloqueia o
 * acesso automatizado em boa parte do tempo (feed RSS e busca dão 403); por
 * isso o Newswire também serve de reserva quando o Reddit não responde.
 */

const GTA_ONLINE_CATEGORY = /gta online/i;
// Pistas fortes de "artigo da semana" e pistas médias de conteúdo semanal.
const STRONG_HINTS = [/\bthis week(?:['’]s)?\b/i, /\bweek['’]s\b/i, /\bweekly\b/i];
const MEDIUM_HINTS = [
  /\bbonus(?:es)?\b/i, /\bdiscounts?\b/i, /\b(?:double|triple|2x|3x)\b/i, /\bevent\b/i, /\bpodium\b/i,
  /\bprize ride\b/i, /\btime trials?\b/i, /\bheist\b/i, /\bchallenges?\b/i, /\bnow available\b/i,
];
// Brinde avulso do GTA+ ("GTA+ Members Can Now Claim a Free ..."): é novidade, mas NÃO é o artigo semanal.
const FREEBIE_HINT = /\bgta\+/i;
const FREEBIE_ACTION = /\b(?:claim|free|grab)\b/i;

export const WEEKLY_MIN_SCORE = 4;

/** Pontuação de "isto é o artigo do evento semanal" (função pura). Categoria fora de GTA Online nunca pontua. */
export function scoreWeeklyArticle(title, category) {
  if (!GTA_ONLINE_CATEGORY.test(String(category ?? ''))) return -Infinity;
  const t = String(title ?? '');
  let score = 2; // categoria GTA Online
  if (STRONG_HINTS.some((re) => re.test(t))) score += 5;
  score += Math.min(6, MEDIUM_HINTS.filter((re) => re.test(t)).length * 2);
  if (FREEBIE_HINT.test(t) && FREEBIE_ACTION.test(t)) score -= 6;
  return score;
}

/**
 * Escolhe o artigo semanal da lista do Newswire (vem do mais novo para o mais antigo).
 * Ganha a MAIOR pontuação (empate: o mais novo); só entram artigos de até `maxAgeDays` dias; sem pontuação mínima devolve null
 * (melhor não ter dado do que mostrar o artigo errado, como o do brinde do GTA+ que é mais novo que o do evento).
 */
export function pickWeeklyArticle(articles, { now = Date.now(), maxAgeDays = 10 } = {}) {
  let best = null;
  let bestScore = -Infinity;
  for (const a of Array.isArray(articles) ? articles : []) {
    const score = scoreWeeklyArticle(a?.title, a?.category);
    if (score < WEEKLY_MIN_SCORE) continue;
    const when = Date.parse(String(a?.publishedAt ?? ''));
    if (Number.isFinite(when) && now - when > maxAgeDays * 86_400_000) continue;
    if (score > bestScore) { best = a; bestScore = score; } // `>` mantém o mais novo nos empates
  }
  return best;
}

/**
 * Busca e monta os dados do evento semanal a partir do Rockstar Newswire (fonte oficial; também a reserva quando o Reddit falha).
 */
export async function fetchWeeklyEventFromNewswire() {
  try {
    const articles = await scrapeNewswireArticles();

    if (!articles || articles.length === 0) {
      logger.warn('[GTAO] fetchWeeklyEventFromNewswire(): nenhum artigo encontrado no Newswire.');
      return null;
    }

    // Escolha por pontuação (não por recência): um brinde do GTA+ publicado depois do artigo da semana não pode tomar o lugar dele.
    const weeklyArticle = pickWeeklyArticle(articles);
    if (!weeklyArticle) {
      logger.warn('[GTAO] fetchWeeklyEventFromNewswire(): nenhum artigo do evento semanal reconhecido nos últimos 10 dias; sem dado do semanal.');
      return null;
    }

    // Lê o corpo completo do artigo (a listagem só traz o título)
    const { paragraphs, heroImageUrl } = await scrapeArticleBody(weeklyArticle.url);

    if (!paragraphs || paragraphs.length === 0) {
      logger.warn('[GTAO] fetchWeeklyEventFromNewswire(): artigo semanal encontrado, mas sem parágrafos legíveis.');
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
      source: 'newswire',
    };

    logger.info(`[GTAO] fetchWeeklyEventFromNewswire(): artigo semanal capturado e traduzido — "${translatedTitle}"`);
    return weeklyData;
  } catch (error) {
    logger.error(`[GTAO] fetchWeeklyEventFromNewswire(): erro inesperado: ${error.message}`);
    return null;
  }
}

/**
 * Ponto de entrada da fonte Newswire usado pelo motor (collectWeekly com source 'newswire').
 */
export async function fetchWeeklyEvent() {
  return fetchWeeklyEventFromNewswire();
}
