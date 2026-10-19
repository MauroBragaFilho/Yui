import * as cheerio from 'cheerio';
import { inspectResults as inspectDuckDuckGo } from '../core/dev/web-search.js';
import { getDefaultBudget } from './budget.js';

/**
 * Pesquisa na web com vários provedores em cadeia (o primeiro que responder vence).
 *
 *   brave → tavily → searxng → duckduckgo → bing
 *
 * - brave:      API oficial (BRAVE_API_KEY). Os Termos da Brave PROÍBEM guardar/cachear os resultados.
 * - tavily:     API feita para IA (TAVILY_API_KEY), plano gratuito mensal.
 * - searxng:    seu próprio servidor (SEARXNG_URL), sem chave e sem limite.
 * - duckduckgo: página HTML pública, sem chave (pode ser limitada).
 * - bing:       leitura da página (scraping), só como último recurso: quebra quando o layout muda.
 *
 * Ordem e conjunto: YUI_SEARCH_PROVIDERS="brave,tavily,searxng,duckduckgo,bing".
 * Provedor sem chave/endereço é pulado.
 *
 * Robustez:
 *  - todo pedido tem prazo (inclusive a leitura do corpo) e o corpo tem limite de tamanho (2 MB);
 *  - a cadeia inteira tem um prazo global (YUI_SEARCH_DEADLINE_MS, padrão 12 s);
 *  - bloqueio leve (HTTP 202, página de desafio/"anomaly", página sem resultados nem marcação) NÃO é
 *    "sem resultados": o provedor descansa com recuo exponencial (1, 2, 4, 8... até 30 min);
 *  - cota esgotada (402, 432, 433, 429 de cota) descansa muito mais (1 h) que limite de taxa (429 comum);
 *    Retry-After / X-RateLimit-Reset são respeitados;
 *  - limite por usuário e teto mensal por provedor (budget.js) valem ANTES de chamar o provedor;
 *  - consulta sensível (sensitive: true) nunca sai para terceiros.
 */

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36';
const DEFAULT_ORDER = ['brave', 'tavily', 'searxng', 'duckduckgo', 'bing'];
const KEYLESS = new Set(['searxng', 'duckduckgo', 'bing']); // sem chave: 401/403/429 aqui significam "bloqueado"

const TIMEOUT_MS = 8000; // por provedor
const DEFAULT_DEADLINE_MS = 12_000; // da cadeia inteira
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_BODY_BYTES = 16 * 1024;
const MAX_CACHE_ENTRIES = 200;

const MINUTE = 60_000;
const BACKOFF_BASE_MS = MINUTE; // 1, 2, 4, 8... min
const BACKOFF_MAX_MS = 30 * MINUTE;
const QUOTA_REST_MS = 60 * MINUTE;
const AUTH_REST_MS = 30 * MINUTE;
const TRANSIENT_BASE_MS = 30_000;
const TRANSIENT_MAX_MS = 5 * MINUTE;
const MAX_RETRY_AFTER_MS = 24 * 60 * MINUTE;

const rest = new Map(); // provedor -> { until, failures, kind }
const inflight = new Map(); // consulta idêntica em andamento -> Promise
const cache = new Map(); // consulta -> { at, value } (só se YUI_SEARCH_CACHE_TTL_MIN > 0 e nunca para a Brave)

class SearchError extends Error {
  /** kind: blocked | rate | quota | auth | timeout | network | aborted | server | parse | toolarge */
  constructor(message, { status = 0, kind = 'network', retryAfterMs = 0 } = {}) {
    super(message);
    this.status = status;
    this.kind = kind;
    this.retryAfterMs = retryAfterMs;
  }
}

const clip = (s, n) => String(s ?? '').replace(/\s+/g, ' ').trim().slice(0, n);

/** Chave só vale com 10+ caracteres (texto-modelo como "opcional" não conta). */
export function keyOf(env, name) {
  const v = String(env[name] ?? '').trim();
  return v.length >= 10 ? v : '';
}

// ---------------------------------------------------------------------------------------------
// Leitura de respostas
// ---------------------------------------------------------------------------------------------

const header = (headers, name) => {
  try {
    return headers?.get?.(name) ?? null;
  } catch {
    return null;
  }
};

function clampMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return 0;
  return Math.min(MAX_RETRY_AFTER_MS, Math.max(1000, Math.round(ms)));
}

/** Quanto o servidor pede para esperar (Retry-After, ou X-RateLimit-Reset da Brave), em ms. 0 = não informado. */
function retryAfterFrom(headers, kind, nowMs) {
  const ra = header(headers, 'retry-after');
  if (ra) {
    const secs = Number(ra);
    if (Number.isFinite(secs)) return clampMs(secs * 1000);
    const date = Date.parse(ra);
    if (!Number.isNaN(date)) return clampMs(date - nowMs);
  }
  const reset = header(headers, 'x-ratelimit-reset');
  if (reset) {
    const nums = String(reset).split(',').map((s) => Number(s.trim())).filter(Number.isFinite);
    if (nums.length) {
      const pick = kind === 'quota' ? Math.max(...nums) : Math.min(...nums);
      return clampMs((pick > 1e9 ? pick - nowMs / 1000 : pick) * 1000);
    }
  }
  return 0;
}

function toSearchError(err, signal) {
  if (err instanceof SearchError) return err;
  const reason = signal?.aborted ? signal.reason : null;
  if (err?.name === 'TimeoutError' || reason?.name === 'TimeoutError') return new SearchError('tempo esgotado', { kind: 'timeout' });
  if (err?.name === 'AbortError' || signal?.aborted) return new SearchError('cancelado', { kind: 'aborted' });
  return new SearchError(String(err?.cause?.code || err?.message || 'falha de rede').slice(0, 120), { kind: 'network' });
}

function raceAbort(promise, signal) {
  if (!signal) return promise;
  return new Promise((resolve, reject) => {
    const onAbort = () => reject(signal.reason ?? new Error('cancelado'));
    if (signal.aborted) return onAbort();
    signal.addEventListener('abort', onAbort, { once: true });
    promise.then(
      (v) => {
        signal.removeEventListener('abort', onAbort);
        resolve(v);
      },
      (e) => {
        signal.removeEventListener('abort', onAbort);
        reject(e);
      },
    );
    return undefined;
  });
}

/** Lê o corpo como texto COM prazo (o mesmo signal do pedido) e limite de tamanho. */
async function readBodyText(res, signal, maxBytes, { truncate = false } = {}) {
  const body = res.body;
  if (body && typeof body.getReader === 'function') {
    const reader = body.getReader();
    const chunks = [];
    let total = 0;
    const onAbort = () => {
      reader.cancel().catch(() => {});
    };
    signal?.addEventListener('abort', onAbort, { once: true });
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.byteLength;
        if (total > maxBytes) {
          await reader.cancel().catch(() => {});
          if (!truncate) throw new SearchError('resposta grande demais', { kind: 'toolarge' });
          chunks.push(value.subarray(0, value.byteLength - (total - maxBytes)));
          break;
        }
        chunks.push(value);
      }
    } finally {
      signal?.removeEventListener('abort', onAbort);
    }
    if (signal?.aborted) throw signal.reason ?? new Error('cancelado');
    return Buffer.concat(chunks).toString('utf8');
  }
  // Resposta sem stream legível (dublê de teste): lê tudo, mas ainda respeita o prazo.
  const text = String(await raceAbort(typeof res.text === 'function' ? res.text() : Promise.resolve(''), signal));
  if (text.length > maxBytes) {
    if (!truncate) throw new SearchError('resposta grande demais', { kind: 'toolarge' });
    return text.slice(0, maxBytes);
  }
  return text;
}

/**
 * 429: limite de TAXA (curto) ou de COTA (longo)? Primeiro pelo código estruturado do corpo
 * (Brave: error.code RATE_LIMITED | QUOTA_LIMITED e error.meta.component rate_limiter | quota_limiter);
 * só então por palavras, sem "exceed" nem "usage limit" soltos: "Request rate limit exceeded for plan"
 * é limite de taxa (1 req/s) e não pode virar 24 h de descanso.
 */
function classify429(body) {
  const text = String(body ?? '');
  let data = null;
  try {
    data = JSON.parse(text);
  } catch {
    // corpo que não é JSON: cai para as palavras
  }
  const codes = [data?.error?.code, data?.code, data?.error?.meta?.component, data?.meta?.component]
    .filter((v) => typeof v === 'string')
    .join(' ');
  if (/quota/i.test(codes)) return 'quota';
  if (/rate/i.test(codes)) return 'rate';
  if (/rate[ _-]?limit|too many requests|slow down/i.test(text) && !/quota/i.test(text)) return 'rate';
  return /quota|plan limit|monthly (limit|cap)|out of (searches|credits)/i.test(text) ? 'quota' : 'rate';
}

function classifyHttp(status, headers, body, nowMs) {
  let kind = 'server';
  if (status === 401 || status === 403) kind = 'auth';
  else if (status === 402 || status === 432 || status === 433) kind = 'quota'; // 432/433: limite de plano/PayGo da Tavily
  else if (status === 429) kind = classify429(body);
  else if (status === 408 || status === 425) kind = 'rate';
  return new SearchError(`HTTP ${status}`, { status, kind, retryAfterMs: retryAfterFrom(headers, kind, nowMs) });
}

/** Faz o pedido e devolve { status, headers, body } com o corpo JÁ lido dentro do prazo. */
async function request(ctx, url, options = {}) {
  const { fetchImpl, signal, now } = ctx;
  let res;
  try {
    res = await fetchImpl(url, { ...options, signal });
  } catch (err) {
    throw toSearchError(err, signal);
  }
  const status = Number(res?.status ?? 0);
  if (!res?.ok) {
    let body = '';
    try {
      body = await readBodyText(res, signal, MAX_ERROR_BODY_BYTES, { truncate: true });
    } catch {
      // o corpo do erro é só uma dica para distinguir cota de taxa
    }
    throw classifyHttp(status, res?.headers, body, now);
  }
  try {
    return { status, headers: res.headers, body: await readBodyText(res, signal, MAX_BODY_BYTES) };
  } catch (err) {
    throw toSearchError(err, signal);
  }
}

function parseJson(body) {
  try {
    return JSON.parse(body);
  } catch {
    throw new SearchError('resposta inválida', { kind: 'parse' });
  }
}

const CHALLENGE = /anomaly|captcha|unusual traffic|are you a (human|robot)|verify you are (a )?human|verifique que voc[eê] [eé] humano|challenge-form/i;

// ---------------------------------------------------------------------------------------------
// Provedores
// ---------------------------------------------------------------------------------------------

const PROVIDERS = {
  brave: {
    available: (env) => Boolean(keyOf(env, 'BRAVE_API_KEY')),
    async search(query, ctx) {
      const { env, max } = ctx;
      const url = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${max}&search_lang=pt-br`;
      const { status, body } = await request(ctx, url, { headers: { Accept: 'application/json', 'X-Subscription-Token': keyOf(env, 'BRAVE_API_KEY') } });
      const data = parseJson(body);
      return { status, results: (data?.web?.results ?? []).map((r) => ({ title: clip(r.title, 160), url: r.url, snippet: clip(r.description, 300) })) };
    },
  },
  tavily: {
    available: (env) => Boolean(keyOf(env, 'TAVILY_API_KEY')),
    async search(query, ctx) {
      const { env, max } = ctx;
      const { status, body } = await request(ctx, 'https://api.tavily.com/search', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${keyOf(env, 'TAVILY_API_KEY')}` },
        body: JSON.stringify({ query, max_results: max, search_depth: 'basic' }),
      });
      const data = parseJson(body);
      return { status, results: (data?.results ?? []).map((r) => ({ title: clip(r.title, 160), url: r.url, snippet: clip(r.content, 300) })) };
    },
  },
  searxng: {
    available: (env) => /^https?:\/\//i.test(String(env.SEARXNG_URL ?? '').trim()),
    async search(query, ctx) {
      const { env, max } = ctx;
      const base = String(env.SEARXNG_URL).trim().replace(/\/+$/, '');
      const { status, body } = await request(ctx, `${base}/search?q=${encodeURIComponent(query)}&format=json&language=pt-BR`, { headers: { Accept: 'application/json' } });
      const data = parseJson(body);
      return { status, results: (data?.results ?? []).slice(0, max).map((r) => ({ title: clip(r.title, 160), url: r.url, snippet: clip(r.content, 300) })) };
    },
  },
  duckduckgo: {
    available: () => true,
    async search(query, ctx) {
      const { max } = ctx;
      const { status, body } = await request(ctx, `https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.5' } });
      if (status === 202) throw new SearchError('bloqueio leve (HTTP 202)', { status, kind: 'blocked' });
      const page = inspectDuckDuckGo(body, max);
      if (page.results.length) return { status, results: page.results };
      if (CHALLENGE.test(body)) throw new SearchError('bloqueio leve (página de desafio)', { status, kind: 'blocked' });
      if (page.markup || page.noResults) return { status, results: [] }; // página de busca de verdade, sem resultados orgânicos
      throw new SearchError('bloqueio leve (resposta sem resultados nem marcação de busca)', { status, kind: 'blocked' });
    },
  },
  bing: {
    available: () => true,
    async search(query, ctx) {
      const { max } = ctx;
      const { status, body } = await request(ctx, `https://www.bing.com/search?q=${encodeURIComponent(query)}`, {
        headers: { 'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1', 'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7', Cookie: 'SRCHHPGUSR=SRCHLANG=pt' },
      });
      const $ = cheerio.load(body);
      const results = [];
      $('.b_focusText, .l_ec, .b_paractl').each((_, el) => {
        const text = clip($(el).text(), 300);
        if (text.length > 10 && results.length < 1) results.push({ title: 'RESPOSTA RÁPIDA', url: '#quick-answer', snippet: text });
      });
      $('.b_algo').each((_, el) => {
        if (results.length >= max) return false;
        const title = clip($(el).find('h2').text(), 160);
        const url = $(el).find('a').attr('href');
        const snippet = clip($(el).find('.b_caption p').text() || $(el).find('.b_snippet').text(), 300);
        if (title && /^https?:\/\//i.test(url || '')) results.push({ title, url, snippet });
        return undefined;
      });
      if (!results.length && CHALLENGE.test(body)) throw new SearchError('bloqueio leve (página de desafio)', { status, kind: 'blocked' });
      return { status, results };
    },
  },
};

/** O provedor está configurado (chave de 10+ caracteres ou endereço válido)? Ignora YUI_SEARCH_PROVIDERS. */
export function providerConfigured(name, env = process.env) {
  return Boolean(PROVIDERS[name]?.available(env));
}

/** Provedores a tentar, na ordem, só os configurados. */
export function activeProviders(env = process.env) {
  const wanted = String(env.YUI_SEARCH_PROVIDERS ?? '').split(',').map((s) => s.trim().toLowerCase()).filter((s) => PROVIDERS[s]);
  const order = wanted.length ? [...new Set(wanted)] : DEFAULT_ORDER;
  return order.filter((name) => PROVIDERS[name].available(env));
}

// ---------------------------------------------------------------------------------------------
// Descanso (recuo exponencial) por provedor
// ---------------------------------------------------------------------------------------------

/** Provedores sem chave tratam 401/403/429 como bloqueio; timeout e erro de rede viram "transitório". */
function effectiveKind(name, kind) {
  if (KEYLESS.has(name) && (kind === 'auth' || kind === 'rate' || kind === 'quota')) return 'blocked';
  if (kind === 'timeout' || kind === 'network' || kind === 'server' || kind === 'parse' || kind === 'toolarge') return 'transient';
  return kind;
}

function noteFailure(name, err, nowMs) {
  const kind = effectiveKind(name, err.kind);
  if (!['blocked', 'rate', 'quota', 'auth', 'transient'].includes(kind)) return;
  const prev = rest.get(name);
  const failures = prev && prev.kind === kind ? prev.failures + 1 : 1;
  let ms;
  if (kind === 'quota') ms = err.retryAfterMs || QUOTA_REST_MS;
  else if (kind === 'auth') ms = err.retryAfterMs || AUTH_REST_MS;
  else if (kind === 'transient') ms = Math.min(TRANSIENT_MAX_MS, TRANSIENT_BASE_MS * 2 ** (failures - 1));
  else ms = err.retryAfterMs || Math.min(BACKOFF_MAX_MS, BACKOFF_BASE_MS * 2 ** (failures - 1)); // blocked / rate: 1, 2, 4, 8... min
  rest.set(name, { until: nowMs + ms, failures, kind });
}

export function resetCooldowns() {
  rest.clear();
  inflight.clear();
  cache.clear();
}

// ---------------------------------------------------------------------------------------------
// Log (sem o texto da consulta)
// ---------------------------------------------------------------------------------------------

let loggerPromise = null;
function defaultLog(level, message) {
  // Carregado só no primeiro uso: importar este módulo não cria arquivos de log.
  loggerPromise ??= import('../utils/logger.js').then((m) => m.logger).catch(() => null);
  loggerPromise.then((l) => l?.[level]?.(message));
}

/** Tira o texto da consulta de qualquer mensagem (erros de rede podem repetir a URL). */
function redact(message, query) {
  let s = String(message ?? '');
  for (const needle of [query, encodeURIComponent(query), query.replace(/ /g, '+')]) {
    if (needle && needle.length > 2) s = s.split(needle).join('[consulta]');
  }
  return s.slice(0, 120);
}

// ---------------------------------------------------------------------------------------------
// Cadeia
// ---------------------------------------------------------------------------------------------

/**
 * Sinal que aborta após `ms` (motivo: TimeoutError). Não usa AbortSignal.timeout porque o timer dele é
 * "unref": sozinho ele não segura o processo (um script/teste que só espera o prazo encerraria antes).
 */
function timeoutSignal(ms) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(new DOMException('tempo esgotado', 'TimeoutError')), ms);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function intOption(value, fallback, min, max) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.min(max, Math.max(min, Math.floor(n))) : fallback;
}

async function runChain({ q, max, env, fetchImpl, chain, now, budget, emit, providerTimeoutMs }) {
  const errors = [];
  for (const name of activeProviders(env)) {
    if (chain.aborted) {
      errors.push(chain.reason?.name === 'TimeoutError' ? 'prazo total esgotado' : 'cancelado');
      break;
    }
    const nowMs = now();
    const state = rest.get(name);
    if (state && state.until > nowMs) {
      errors.push(`${name}: descansando`);
      continue;
    }
    const cap = budget.canUseProvider(name, env, nowMs);
    if (!cap.ok) {
      errors.push(`${name}: cota mensal atingida`);
      continue;
    }
    budget.recordProvider(name, nowMs);

    const providerTimer = timeoutSignal(providerTimeoutMs);
    const signal = AbortSignal.any([chain, providerTimer.signal]);
    const started = Date.now();
    try {
      const { status, results: raw } = await PROVIDERS[name].search(q, { env, fetchImpl, max, signal, now: nowMs });
      const results = raw.filter((r) => r.url && r.title).slice(0, max + 1);
      emit('info', `[Search] provider=${name} status=${status} ms=${Date.now() - started} results=${results.length}`);
      rest.delete(name);
      if (results.length) return { provider: name, results, errors };
      errors.push(`${name}: sem resultados`);
    } catch (err) {
      const e = toSearchError(err, signal);
      const message = redact(e.message, q);
      errors.push(`${name}: ${message}`);
      emit('warn', `[Search] provider=${name} status=${e.status} ms=${Date.now() - started} falhou: ${message}`);
      // Prazo da cadeia/cancelamento não é culpa do provedor.
      if (!chain.aborted) noteFailure(name, e, nowMs);
    } finally {
      providerTimer.clear();
    }
  }
  return { provider: null, results: [], errors };
}

/**
 * Pesquisa na web pela cadeia de provedores.
 *
 * @param {string} query
 * @param {object} [opts]
 * @param {number} [opts.max=5]            resultados desejados
 * @param {string|number} [opts.userId]    quem pediu (limite por usuário; sem userId não há limite por usuário)
 * @param {boolean} [opts.sensitive=false] conversa sensível: NÃO pesquisa (a consulta sairia para terceiros)
 * @param {AbortSignal} [opts.signal]      cancelamento externo
 * Injeção para teste: env, fetchImpl, now, budget, logger, deadlineMs, providerTimeoutMs.
 * @returns {Promise<{ provider: string|null, results: Array<{title,url,snippet}>, errors: string[], limited?: 'user', retryAfterMs?: number, cached?: boolean }>}
 */
export async function searchWeb(query, {
  max = 5,
  env = process.env,
  fetchImpl = (...a) => fetch(...a),
  userId = null,
  sensitive = false,
  signal = null,
  now = () => Date.now(),
  budget = null,
  logger = null,
  deadlineMs = undefined,
  providerTimeoutMs = TIMEOUT_MS,
} = {}) {
  if (sensitive === true) return { provider: null, results: [], errors: ['sensitive'] };
  const q = clip(query, 300);
  if (!q) return { provider: null, results: [], errors: [] };
  const wanted = intOption(max, 5, 1, 20);
  const emit = (level, message) => (logger ? logger[level]?.(message) : defaultLog(level, message));
  const key = `${q.toLowerCase()}|${wanted}|${activeProviders(env).join(',')}`;

  // Cache opcional (desligado por padrão; nunca guarda resultado da Brave: os Termos proíbem).
  const ttlMs = Math.max(0, Number(env.YUI_SEARCH_CACHE_TTL_MIN) || 0) * MINUTE;
  if (ttlMs > 0) {
    const hit = cache.get(key);
    if (hit && now() - hit.at < ttlMs) return { ...hit.value, results: hit.value.results.map((r) => ({ ...r })), errors: [], cached: true };
    if (hit) cache.delete(key);
  }

  const bud = budget ?? getDefaultBudget();
  const turn = bud.takeUser(userId, env, now());
  if (!turn.ok) {
    emit('warn', `[Search] limite por usuário atingido (${turn.limit}/hora)`);
    return { provider: null, results: [], errors: ['limite de buscas por usuário atingido'], limited: 'user', retryAfterMs: turn.retryAfterMs };
  }

  // Buscas idênticas e simultâneas compartilham a mesma chamada.
  if (inflight.has(key)) {
    const shared = await inflight.get(key);
    return { ...shared, results: shared.results.map((r) => ({ ...r })), errors: [...shared.errors] };
  }

  const deadline = intOption(deadlineMs ?? env.YUI_SEARCH_DEADLINE_MS, DEFAULT_DEADLINE_MS, 500, 120_000);
  const deadlineTimer = timeoutSignal(deadline);
  const chain = AbortSignal.any([deadlineTimer.signal, ...(signal ? [signal] : [])]);
  const job = (async () => {
    try {
      const out = await runChain({ q, max: wanted, env, fetchImpl, chain, now, budget: bud, emit, providerTimeoutMs });
      if (!out.results.length) emit('warn', `[Search] sem resultados (${out.errors.join('; ') || 'nenhum provedor ativo'})`);
      if (ttlMs > 0 && out.results.length && out.provider !== 'brave') {
        cache.set(key, { at: now(), value: out });
        while (cache.size > MAX_CACHE_ENTRIES) cache.delete(cache.keys().next().value);
      }
      return out;
    } catch (err) {
      emit('warn', `[Search] erro inesperado: ${redact(err?.message, q)}`);
      return { provider: null, results: [], errors: ['erro inesperado na busca'] };
    } finally {
      deadlineTimer.clear();
      inflight.delete(key);
    }
  })();
  inflight.set(key, job);
  return job;
}
