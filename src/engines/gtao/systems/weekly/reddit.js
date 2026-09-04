import { logger } from '../../../../utils/logger.js';
import { config } from '../../../../config/index.js';
import { getCookies, refreshCookies } from './reddit-cookies.js';

/**
 * Cliente isolado de acesso ao Reddit para o Weekly do GTA Online.
 *
 * Responsabilidade EXCLUSIVA:
 *  - Fazer a requisição HTTP ao Reddit.
 *  - Buscar os posts "Weekly Bonuses and Discounts".
 *  - Validar a resposta e os itens.
 *  - Selecionar o post mais recente válido.
 *  - Normalizar os dados brutos para um formato estável.
 *
 * O restante do sistema (parser/service/discord) NÃO depende da estrutura
 * original retornada pelo Reddit — apenas da interface normalizada fornecida
 * por este módulo (getLatestWeekly / searchWeeklyPosts).
 *
 * Esta camada está preparada para uma futura migração do .json público para
 * a API oficial do Reddit (OAuth), caso necessário: basta trocar a origem do
 * fetch dentro de `searchWeeklyPosts` mantendo a mesma saída normalizada.
 */

const SEARCH_URL =
  'https://www.reddit.com/r/gtaonline/search.json' +
  '?q=title:%22Weekly%20Bonuses%20and%20Discounts%22' +
  '&restrict_sr=1&sort=new&limit=5';

const TITLE_KEYWORDS = ['weekly bonuses and discounts'];

// Timeout das requisições HTTP (ms). Evita que o bot trave esperando o Reddit.
const DEFAULT_TIMEOUT_MS = 15000;

// Limite de requisições por ciclo: como a chamada já limita a `limit=5`,
// somente 1 requisição é feita por execução. A constante existe para manter
// o controle centralizado caso o futuro migre para mais chamadas.
const MAX_REQUESTS_PER_CYCLE = 3;

/**
 * Verifica se o título corresponde ao post semanal esperado.
 * Tolerante a variações de capitalização e/ou marcação extra no título.
 */
export function isWeeklyPostTitle(title) {
  const lower = (title || '').toLowerCase();
  return TITLE_KEYWORDS.some((kw) => lower.includes(kw));
}

/**
 * Valida estaticamente (sem rede) se um item bruto do Reddit é um post
 * Weekly minimamente utilizável.
 */
export function isValidWeeklyItem(item) {
  if (!item) return false;
  if (!item.id || !item.title) return false;
  if (!isWeeklyPostTitle(item.title)) return false;
  return true;
}

/**
 * Normaliza um item bruto do Reddit para a interface estável usada no
 * resto do sistema. Não valida — apenas projeta os campos existentes.
 */
export function normalizePost(item) {
  const base = `https://www.reddit.com${item.permalink || ''}`;
  return {
    id: item.id,
    title: (item.title || '').trim(),
    author: item.author || '',
    createdUtc: typeof item.created_utc === 'number' ? item.created_utc : null,
    permalink: item.permalink || '',
    url: item.url || base,
    selftext: (item.selftext || '').trim(),
  };
}

/**
 * Valida a resposta HTTP bruta, retornando os children em caso de sucesso.
 * Lança erros claros para 403/429/timeout/JSON inválido para que o
 * chamador decida como tratar sem derrubar o processo.
 */
async function parseResponse(res) {
  if (res.status === 429) {
    const retryAfter = res.headers.get('retry-after') || null;
    const err = new Error('Reddit rate limit (429)');
    err.code = 'REDDIT_RATE_LIMIT';
    err.retryAfter = retryAfter;
    throw err;
  }

  if (res.status === 403) {
    const err = new Error('Reddit bloqueou a requisição (403 Forbidden)');
    err.code = 'REDDIT_FORBIDDEN';
    throw err;
  }

  if (!res.ok) {
    const err = new Error(`Reddit respondeu HTTP ${res.status}`);
    err.code = 'REDDIT_HTTP_ERROR';
    err.status = res.status;
    throw err;
  }

  let json;
  try {
    json = await res.json();
  } catch (parseErr) {
    const err = new Error(`Reddit retornou JSON inválido: ${parseErr.message}`);
    err.code = 'REDDIT_INVALID_JSON';
    throw err;
  }

  const children = json?.data?.children;
  if (!Array.isArray(children)) {
    const err = new Error('Reddit retornou resposta sem lista de posts');
    err.code = 'REDDIT_INVALID_PAYLOAD';
    throw err;
  }

  return children;
}

/**
 * Executa um único fetch ao Reddit com os cookies atuais.
 * Retorna a Response bruta; o chamador decide como tratar.
 */
async function rawFetch(cookieStr) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), DEFAULT_TIMEOUT_MS);

  try {
    return await fetch(SEARCH_URL, {
      headers: {
        'User-Agent': config.weekly.userAgent,
        'Accept': 'application/json',
        'Accept-Language': 'en-US,en;q=0.9',
        'Cookie': cookieStr,
      },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Busca os posts Weekly mais recentes no r/gtaonline e retorna a lista
 * normalizada (já filtrada por título válido), ordenada da mais nova para
 * a mais antiga.
 *
 * Fluxo de cookies:
 *   1. Obtém cookies (cache/Puppeteer).
 *   2. Faz o fetch com esses cookies.
 *   3. Se retornar 403 → renova cookies via Puppeteer → retry UMA vez.
 */
export async function searchWeeklyPosts() {
  const userAgent = config.weekly.userAgent ||
    'nodejs:yui-gta-bot:1.0 (by /u/your_reddit_username)';

  try {
    logger.info('[Weekly] Consultando Reddit (r/gtaonline) por Weekly Bonuses and Discounts...');

    // 1ª tentativa com cookies do cache.
    let cookieStr = await getCookies();
    let res = await rawFetch(cookieStr);

    // Se 403, renova cookies e tenta uma vez mais.
    if (res.status === 403) {
      logger.warn('[Weekly] Reddit retornou 403; renovando cookies...');
      cookieStr = await refreshCookies();
      res = await rawFetch(cookieStr);
    }

    const children = await parseResponse(res);

    const normalized = [];
    for (const child of children) {
      const data = child?.data;
      if (!data) continue;
      if (!isValidWeeklyItem(data)) continue;
      normalized.push(normalizePost(data));
    }

    // Garante ordenação por data de criação (mais recente primeiro),
    // independente da ordem vinda do Reddit. Criados nulos vão para o fim.
    normalized.sort((a, b) => {
      const ac = a.createdUtc ?? 0;
      const bc = b.createdUtc ?? 0;
      return bc - ac;
    });

    logger.info(`[Weekly] ${normalized.length} post(s) Weekly válido(s) encontrado(s) no Reddit.`);
    return normalized;
  } catch (error) {
    if (error.name === 'AbortError') {
      const err = new Error('Timeout ao consultar o Reddit');
      err.code = 'REDDIT_TIMEOUT';
      logger.warn(`[Weekly] ${err.message}`);
      throw err;
    }
    logger.warn(`[Weekly] Erro ao consultar Reddit: ${error.message}`);
    throw error;
  }
}

/**
 * Retorna o post Weekly mais recente válido, ou null quando não há nenhum.
 */
export async function getLatestWeekly() {
  const posts = await searchWeeklyPosts();
  return posts.length > 0 ? posts[0] : null;
}

export default {
  getLatestWeekly,
  searchWeeklyPosts,
  isWeeklyPostTitle,
  isValidWeeklyItem,
  normalizePost,
  MAX_REQUESTS_PER_CYCLE,
};

