/**
 * Cliente HTTP da API do GTACars.net (fonte independente de veículos).
 *
 * Responsabilidade EXCLUSIVA: comunicar-se com a API
 *   GET /api/vehicle-search?game=gta5&page=&perPage=&sort=&sortReverse=&q=
 * e retornar dados crus validados. Nenhuma lógica de negócio aqui.
 *
 * Comportamento:
 *   - paginação explícita (perPage restrito a [24,36,48,60] pela API);
 *   - retries com backoff curto para erros transitórios (429, 5xx,
 *     timeout, rede);
 *   - User-Agent identificando o Yui (o Cloudflare do site pode rejeitar
 *     UA padrão de biblioteca);
 *   - nunca loopa infinito (MAX_PAGES / MAX_RETRIES no teto).
 */

import axios from 'axios';
import { logger } from '../../../../utils/logger.js';

/** Base do site GTACars (usada para montar URLs de imagens e páginas). */
export const GTACARS_BASE = 'https://gtacars.net';

/** Base da API do GTACars (catálogo GTA 5). */
export const GTACars_API_URL = 'https://gtacars.net/api/vehicle-search';

/** GTA 5 = veículos do modo história + GTA Online (mesmo catálogo da página). */
export const GTACARS_GAME = 'gta5';

/** Valores de perPage aceitos pela API (o frontend do site usa os mesmos). */
export const PER_PAGE_OPTIONS = [24, 36, 48, 60];

export const DEFAULT_PER_PAGE = 60;
export const DEFAULT_SORT = 'alphabet';
export const TIMEOUT_MS = 15_000;
export const PAGE_DELAY_MS = 250;
export const MAX_RETRIES = 2;
export const MAX_PAGES = 40; // 24 * 40 cobre bem além de ~967 veículos

/** Erro tipado do cliente GTACars com metadados úteis para retry. */
export class GTACarsApiError extends Error {
  constructor(message, { status = null, code = null, retryable = false } = {}) {
    super(message);
    this.name = 'GTACarsApiError';
    this.status = status;
    this.code = code;
    this.retryable = retryable;
  }
}

const http = axios.create({
  baseURL: GTACars_API_URL,
  timeout: TIMEOUT_MS,
  headers: {
    // Identificação amigável do cliente; evita bloqueios por UA padrão
    // de biblioteca (axios/1.x) que o Cloudflare pode rejeitar.
    'User-Agent':
      'YuiBot/1.0 (Discord GTA Online assistant; +https://github.com/MauroBragaFilho/Yui)',
    Accept: 'application/json',
  },
});

/** Normaliza qualquer erro de axios em GTACarsApiError. */
function normalizeError(err) {
  if (err instanceof GTACarsApiError) return err;

  const status = err.response?.status ?? null;
  const code = err.code ?? null;
  const retryable =
    status === 408 ||
    status === 429 ||
    (status >= 500 && status <= 599) ||
    code === 'ECONNABORTED' ||
    code === 'ENOTFOUND' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT';

  return new GTACarsApiError(
    `Falha ao consultar GTACars (${status || code || err.message}): ${err.message}`,
    { status, code, retryable }
  );
}

/** Espera um tempo fixo (ms). */
function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Busca UMA página de veículos. Retorna o payload já validado:
 *   { count, vehicles, page, perPage, hasMore }
 * Lança GTACarsApiError em caso de falha (após retries quando cabível).
 */
export async function fetchPage({
  page = 1,
  perPage = DEFAULT_PER_PAGE,
  q = '',
  sort = DEFAULT_SORT,
  sortReverse = false,
  signal = null,
} = {}) {
  if (!PER_PAGE_OPTIONS.includes(perPage)) {
    // O frontend do site só aceita [24,36,48,60]; a API pode responder
    // 400 para outros valores — não vale a pena tentar.
    throw new GTACarsApiError(
      `perPage=${perPage} inválido para GTACars (permitidos: ${PER_PAGE_OPTIONS.join(', ')})`,
      { code: 'INVALID_PER_PAGE', retryable: false }
    );
  }

  let lastError = null;
  let attempts = 0;
  const maxAttempts = MAX_RETRIES + 1;

  while (attempts < maxAttempts) {
    attempts += 1;
    try {
      const { data } = await http.get('', {
        params: {
          game: GTACARS_GAME,
          page,
          perPage,
          sort,
          sortReverse: String(Boolean(sortReverse)),
          q,
        },
        signal,
      });

      if (!data || data.success !== true || !data.payload) {
        throw new GTACarsApiError('Resposta do GTACars sem payload válido', {
          code: 'BAD_RESPONSE',
          retryable: false,
        });
      }

      const { count = 0, vehicles = [] } = data.payload;
      return {
        success: true,
        count: Number(count) || 0,
        vehicles: Array.isArray(vehicles) ? vehicles : [],
        page: Number(page),
        perPage: Number(perPage),
        hasMore: Number(count) > Number(page) * Number(perPage),
      };
    } catch (err) {
      const error = normalizeError(err);
      lastError = error;
      // Erro não recuperável (403/400/JSON inválido): aborta na hora.
      if (!error.retryable) throw error;
      if (attempts < maxAttempts) {
        const wait = 500 * attempts; // 500ms, 1000ms
        logger.warn(
          `[GTACars] Tentativa ${attempts}/${maxAttempts} falhou (${error.status || error.code}); aguardando ${wait}ms e tentando de novo.`
        );
        await sleep(wait);
      }
    }
  }

  throw lastError || new GTACarsApiError('Falha desconhecida no cliente GTACars');
}

/**
 * Baixa a lista COMPLETA de veículos paginando até `count` total.
 * Retorna [{ ... }] com os objetos `vehicle` crus (sem o wrapper).
 * Aplica um pequeno atraso entre páginas para ser educado com o servidor.
 */
export async function fetchAllVehicles({
  perPage = DEFAULT_PER_PAGE,
  q = '',
  signal = null,
  onPage = null,
} = {}) {
  const vehicles = [];
  let total = null;
  let page = 1;

  while (page <= MAX_PAGES) {
    const res = await fetchPage({ page, perPage, q, signal });
    if (total === null) total = res.count;

    for (const entry of res.vehicles) {
      if (entry?.vehicle) vehicles.push(entry.vehicle);
    }

    if (onPage) onPage({ page, received: res.vehicles.length, total: total || vehicles.length });

    page += 1;
    const remaining = (total ?? Infinity) - (page - 1) * perPage;
    if (remaining <= 0 || res.vehicles.length < perPage) break;

    // Pequena folga entre requisições (respeito ao servidor).
    await sleep(PAGE_DELAY_MS);
  }

  if (total !== null && vehicles.length !== total) {
    logger.warn(
      `[GTACars] Coletadas ${vehicles.length} veículos, mas a API reportou ${total} (paginação pode ter mudado).`
    );
  }

  return vehicles;
}

export const gtacarsClient = { fetchPage, fetchAllVehicles };