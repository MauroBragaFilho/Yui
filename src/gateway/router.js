/**
 * Roteador do Yui Gateway (o "cérebro" estilo OmniRoute).
 *
 * Recebe uma requisição no formato OpenAI /chat/completions e tenta os
 * provedores configurados, em ordem, até um responder. Recursos:
 *
 *  - Failover automático (erro de rede, timeout, 5xx, 429, resposta vazia...).
 *  - Rodízio de chaves dentro de cada provedor; chave com 429/401 entra em
 *    "cooldown" e o provedor segue com as outras.
 *  - Disjuntor por modelo: falhas seguidas aumentam o tempo de descanso
 *    (30 s, 1 min, 2 min... até 15 min); um sucesso zera.
 *  - Erros "do cliente" (400/422) não punem o provedor.
 *  - Modelos virtuais: `auto`, `smart`, `fast`, combos seus e `provedor/modelo`.
 *  - Conversas sensíveis (contexto pessoal) NUNCA vão a provedores anônimos.
 *  - Nada de prompt ou chave em log/erro: mensagens passam por `scrub`.
 *  - Checagem rápida de vida (só provedor com `checagemRapida: true`: os próprios fora desta máquina): um GET curto antes de tentar; sem
 *    resposta, o provedor inteiro é pulado em vez de segurar o pedido até o prazo da tentativa.
 */

export class GatewayError extends Error {
  constructor(status, message, extra = {}) {
    super(message);
    this.name = 'GatewayError';
    this.status = status;
    Object.assign(this, extra);
  }
}

class UpstreamError extends Error {
  constructor(status, message, { retryAfter = null, kind = null } = {}) {
    super(message);
    this.name = 'UpstreamError';
    this.status = status; // undefined = erro de rede/timeout
    this.retryAfter = retryAfter;
    this.kind = kind;     // força a classificação (ex.: 'empty')
  }
}

const SEC = 1000;
const MIN = 60 * SEC;
const COOLDOWN = {
  transientBase: 30 * SEC,
  transientMax: 15 * MIN,
  rate: 60 * SEC,
  auth: 10 * MIN,
  credit: 30 * MIN,
  model: 30 * MIN,
  empty: 15 * SEC,
};

/** Checagem rápida de vida: prazo do GET, validade do "vivo" e do "fora" (o "fora" dobra a cada falha seguida, até o teto). */
const CHECAGEM = { timeout: 2500, vivo: 30 * SEC, foraBase: 30 * SEC, foraMax: 2 * MIN };

const PASS_THROUGH = [
  'temperature', 'max_tokens', 'top_p', 'stop', 'tools', 'tool_choice',
  'response_format', 'presence_penalty', 'frequency_penalty', 'seed', 'user',
];

/** Esconde chaves e tokens em qualquer texto que possa ir para log ou resposta. */
export function makeScrubber(secrets = []) {
  const known = secrets.filter((s) => s && s.length >= 8);
  return (text) => {
    let out = String(text ?? '');
    for (const s of known) out = out.split(s).join('***');
    return out
      .replace(/\b(?:sk|gsk|hf|rk|pk)[-_][A-Za-z0-9_-]{16,}/g, '***')
      .replace(/\bAIza[0-9A-Za-z_-]{20,}/g, '***')
      .replace(/Bearer\s+[A-Za-z0-9._-]{12,}/gi, 'Bearer ***')
      .slice(0, 300);
  };
}

/** Classifica um erro do provedor para decidir quem "descansa". */
export function classify(err) {
  if (err.kind) return err.kind;
  const s = err.status;
  const msg = String(err.message || '');
  if (s === undefined || s === null) return 'transient'; // rede/timeout
  if (s === 429) return 'rate';
  if (s === 401 || s === 403) return 'auth';
  if (s === 402) return 'credit';
  if (s === 404) return 'model';
  if (s === 400 && /api key|invalid.*(key|token)|unauthori[sz]ed|permission/i.test(msg)) return 'auth';
  if (s === 400 || s === 413 || s === 422) return 'client';
  return 'transient'; // 408, 425, 5xx e o resto
}

export function createRouter({
  providers = [],
  combos = {},
  fetchImpl = (...args) => fetch(...args),
  now = () => Date.now(),
  attemptTimeoutMs = 25_000,
  deadlineMs = 60_000,
  maxAttempts = 4,
  maxTokensCap = 8192,
} = {}) {
  const scrub = makeScrubber(providers.flatMap((p) => p.keys || []));

  // ── alvos (provedor × modelo) ──
  const targets = [];
  for (const p of providers) {
    p.models.forEach((m, order) => targets.push({ id: `${p.id}/${m.id}`, provider: p, model: m, order }));
  }
  const providerById = new Map(providers.map((p) => [p.id, p]));

  // ── estado de saúde ──
  const health = new Map();          // alvo.id -> { failures, cooldownUntil, ok, fail, lastError, lastOkAt }
  const providerCooldown = new Map(); // provedor.id -> until
  const providerFailures = new Map(); // provedor.id -> falhas seguidas (rede/5xx) para o descanso progressivo
  const keyCooldown = new Map();      // `${provedor}#${i}` -> until
  const rotation = new Map();         // provedor.id -> próximo índice de chave
  const totals = { requests: 0, ok: 0, failed: 0 };
  const checagens = new Map();        // provedor.id -> { vivo, ate, falhas, emVoo }

  const h = (id) => {
    if (!health.has(id)) health.set(id, { failures: 0, cooldownUntil: 0, ok: 0, fail: 0, lastError: null, lastStatus: null, lastOkAt: 0 });
    return health.get(id);
  };
  const keyUntil = (p, i) => keyCooldown.get(`${p.id}#${i}`) || 0;

  const keysAvailable = (p) => (p.noAuth ? [null] : p.keys.map((_, i) => i).filter((i) => keyUntil(p, i) <= now()));

  function targetAvailable(t) {
    const t0 = now();
    if (h(t.id).cooldownUntil > t0) return false;
    if ((providerCooldown.get(t.provider.id) || 0) > t0) return false;
    return keysAvailable(t.provider).length > 0;
  }

  /** Segundos até algum dos candidatos voltar a ficar disponível. */
  function secondsUntilAvailable(candidates) {
    const t0 = now();
    let best = Infinity;
    for (const t of candidates) {
      const keys = t.provider.noAuth ? [0] : t.provider.keys.map((_, i) => keyUntil(t.provider, i));
      const keyWait = t.provider.noAuth ? 0 : Math.min(...keys) - t0;
      const wait = Math.max(h(t.id).cooldownUntil - t0, (providerCooldown.get(t.provider.id) || 0) - t0, keyWait, 0);
      best = Math.min(best, wait);
    }
    return Number.isFinite(best) ? Math.max(1, Math.ceil(best / SEC)) : 60;
  }

  /** Chaves disponíveis do provedor, começando pela próxima do rodízio. */
  function keyOrder(p) {
    if (p.noAuth) return [null];
    const avail = keysAvailable(p);
    if (!avail.length) return [];
    const start = rotation.get(p.id) || 0;
    rotation.set(p.id, (start + 1) % p.keys.length);
    const sorted = [...avail].sort((a, b) => ((a - start + p.keys.length) % p.keys.length) - ((b - start + p.keys.length) % p.keys.length));
    return sorted;
  }

  // ── resolução do nome do modelo ──
  function resolveOne(ref) {
    const exact = targets.find((t) => t.id === ref);
    if (exact) return [exact];
    const prov = providerById.get(ref);
    if (prov) return targets.filter((t) => t.provider.id === prov.id);
    for (const p of providers) {
      if (ref.startsWith(`${p.id}/`)) {
        const modelId = ref.slice(p.id.length + 1);
        if (modelId) return [{ id: ref, provider: p, model: { id: modelId, tier: 'smart' }, order: 99, adhoc: true }];
      }
    }
    return [];
  }

  function resolve(name, { sensitive = false } = {}) {
    const requested = String(name ?? '').trim() || 'auto';
    const lower = requested.toLowerCase();
    let list;
    if (lower === 'auto') list = targets.slice();
    else if (lower === 'smart' || lower === 'fast') {
      const tier = targets.filter((t) => t.model.tier === lower);
      list = tier.length ? tier : targets.slice();
    } else if (combos[lower]) {
      list = combos[lower].flatMap(resolveOne);
    } else {
      list = resolveOne(requested);
    }
    // sem repetição, preservando a ordem
    const seen = new Set();
    list = list.filter((t) => (seen.has(t.id) ? false : (seen.add(t.id), true)));
    if (!list.length) throw new GatewayError(404, `Modelo "${requested}" desconhecido. Use auto, smart, fast, um combo ou provedor/modelo.`);
    if (sensitive) {
      const privateOnly = list.filter((t) => !t.provider.anonymous);
      if (!privateOnly.length) throw new GatewayError(503, 'Conversa sensível: nenhum provedor privado disponível para este modelo.', { retryAfter: 60 });
      list = privateOnly;
    }
    return list;
  }

  // ── penalidades ──
  function markSuccess(t) {
    const st = h(t.id);
    providerFailures.set(t.provider.id, 0);
    providerCooldown.delete(t.provider.id);
    st.failures = 0;
    st.cooldownUntil = 0;
    st.ok += 1;
    st.lastOkAt = now();
    st.lastError = null;
    st.lastStatus = null;
  }

  function penalize(t, keyIdx, err, kind) {
    const st = h(t.id);
    st.fail += 1;
    st.lastError = scrub(err.message);
    st.lastStatus = Number.isInteger(err.status) ? err.status : null; // o código HTTP do último erro (o diagnóstico mostra só ele e o tipo, nunca o texto)
    const until = (ms) => now() + ms;
    if (kind === 'rate') {
      if (keyIdx !== null) keyCooldown.set(`${t.provider.id}#${keyIdx}`, until(err.retryAfter ? err.retryAfter * SEC : COOLDOWN.rate));
      else st.cooldownUntil = until(err.retryAfter ? err.retryAfter * SEC : COOLDOWN.rate);
    } else if (kind === 'auth') {
      if (keyIdx !== null) keyCooldown.set(`${t.provider.id}#${keyIdx}`, until(COOLDOWN.auth));
      else st.cooldownUntil = until(COOLDOWN.auth);
    } else if (kind === 'credit') {
      providerCooldown.set(t.provider.id, until(COOLDOWN.credit));
    } else if (kind === 'model') {
      st.cooldownUntil = until(COOLDOWN.model);
    } else if (kind === 'empty') {
      // Resposta vazia costuma ser falta de orçamento de tokens (modelos que "pensam"): descanso curto SÓ desse modelo.
      st.cooldownUntil = until(COOLDOWN.empty);
    } else if (kind === 'transient') {
      // Falha de rede/servidor: o PROVEDOR inteiro descansa, com tempo crescente (30 s, 1 min, 2 min... até 15 min).
      const n = (providerFailures.get(t.provider.id) || 0) + 1;
      providerFailures.set(t.provider.id, n);
      providerCooldown.set(t.provider.id, until(Math.min(COOLDOWN.transientMax, COOLDOWN.transientBase * 2 ** (n - 1))));
    }
    // 'client': sem penalidade
  }

  // ── checagem rápida de vida ──
  /**
   * GET em {base}/models SEM chave e sem os cabeçalhos do provedor. Qualquer resposta HTTP (200, 401, 404, redirecionamento) = vivo;
   * só falha de conexão ou prazo = fora. O redirecionamento não é seguido.
   */
  async function sondar(p) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CHECAGEM.timeout);
    try {
      const base = /^(.*)\/chat\/completions\/?$/i.exec(p.endpoint);
      const url = base ? `${base[1]}/models` : new URL('/', p.endpoint).href;
      const res = await fetchImpl(url, { method: 'GET', headers: { Accept: 'application/json' }, redirect: 'manual', signal: controller.signal });
      try { await res.body?.cancel?.(); } catch { /* corpo já fechado */ }
      return true;
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  /** O provedor responde? Usa o resultado recente; pedidos simultâneos esperam a MESMA checagem. */
  function estaVivo(p) {
    let c = checagens.get(p.id);
    if (!c) checagens.set(p.id, (c = { vivo: true, ate: 0, falhas: 0, emVoo: null }));
    if (c.emVoo) return c.emVoo;
    if (now() < c.ate) return Promise.resolve(c.vivo);
    c.emVoo = sondar(p).then((vivo) => {
      c.vivo = vivo;
      c.falhas = vivo ? 0 : c.falhas + 1;
      c.ate = now() + (vivo ? CHECAGEM.vivo : Math.min(CHECAGEM.foraMax, CHECAGEM.foraBase * 2 ** (c.falhas - 1)));
      c.emVoo = null;
      return vivo;
    });
    return c.emVoo;
  }

  // ── chamada ao provedor ──
  function buildPayload(t, request, stream, opts = {}) {
    const payload = { model: t.model.id, messages: request.messages, stream: Boolean(stream) };
    for (const k of PASS_THROUGH) if (request[k] !== undefined && request[k] !== null) payload[k] = request[k];
    // Limite POR PROVEDOR (etapa 6, só quando quem chama pede: o cérebro, por core/ai/limitesTokens.js): cada alvo recebe o limite do SEU
    // provedor (configuração, capacidade e teto global). Sem `maxTokensFor`, o de sempre: o max_tokens do pedido, até o maxTokensCap.
    if (typeof opts.maxTokensFor === 'function') {
      let n = null;
      try { n = Number(opts.maxTokensFor(t.provider)); } catch { n = null; }
      if (Number.isInteger(n) && n > 0) payload.max_tokens = n;
    }
    if (payload.max_tokens === undefined || payload.max_tokens > maxTokensCap) payload.max_tokens = Math.min(payload.max_tokens ?? 1024, maxTokensCap);
    for (const d of t.provider.dropParams || []) delete payload[d];
    return payload;
  }

  async function callUpstream(t, keyIdx, payload, stream, timeoutMs) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const headers = { 'Content-Type': 'application/json', Accept: stream ? 'text/event-stream' : 'application/json', ...(t.provider.headers || {}) };
    if (keyIdx !== null) headers.Authorization = `Bearer ${t.provider.keys[keyIdx]}`;
    try {
      let res;
      try {
        res = await fetchImpl(t.provider.endpoint, { method: 'POST', headers, body: JSON.stringify(payload), signal: controller.signal });
      } catch (e) {
        throw new UpstreamError(undefined, controller.signal.aborted ? 'tempo esgotado' : `falha de rede: ${e.message}`);
      }
      if (!res.ok) {
        let detail = '';
        try {
          const text = await res.text();
          try { const j = JSON.parse(text); detail = j?.error?.message || j?.message || text; } catch { detail = text; }
        } catch { /* corpo ilegível */ }
        const ra = Number(res.headers?.get?.('retry-after'));
        throw new UpstreamError(res.status, detail || `HTTP ${res.status}`, { retryAfter: Number.isFinite(ra) && ra > 0 ? Math.min(ra, 900) : null });
      }

      if (stream) {
        const reader = res.body.getReader();
        let first;
        try {
          first = await reader.read();
        } catch (e) {
          throw new UpstreamError(undefined, controller.signal.aborted ? 'tempo esgotado' : `falha no stream: ${e.message}`);
        }
        if (first.done || !first.value?.length) throw new UpstreamError(502, 'stream vazio');
        return { stream: { reader, first: first.value } };
      }

      let json;
      try {
        json = JSON.parse(await res.text());
      } catch {
        throw new UpstreamError(502, 'resposta inválida (não é JSON)');
      }
      const msg = json?.choices?.[0]?.message;
      const hasText = typeof msg?.content === 'string' && msg.content.trim().length > 0;
      const hasTools = Array.isArray(msg?.tool_calls) && msg.tool_calls.length > 0;
      if (!hasText && !hasTools) {
        const why = json?.choices?.[0]?.finish_reason === 'length' ? 'resposta vazia (limite de tokens atingido)' : 'resposta vazia';
        throw new UpstreamError(502, why, { kind: 'empty' });
      }
      return { json };
    } finally {
      clearTimeout(timer);
    }
  }

  // ── laço de tentativas (usado por chat e chatStream) ──
  async function run(request, opts, stream) {
    if (!Array.isArray(request?.messages) || !request.messages.length) throw new GatewayError(400, 'O campo "messages" é obrigatório.');
    totals.requests += 1;
    const started = now();
    const candidates = resolve(request.model, opts);
    const available = candidates.filter(targetAvailable);
    if (!available.length) {
      totals.failed += 1;
      throw new GatewayError(503, 'Nenhum provedor disponível no momento.', { retryAfter: secondsUntilAvailable(candidates), attempts: [] });
    }

    const log = [];
    const skipProviders = new Set(); // provedor que falhou como um todo: não tenta outros modelos dele nesta requisição
    let tried = 0;
    // A checagem não conta como tentativa. Os alvos pulados por ela vão para o FIM da fila: se nenhum outro responder, são tentados assim mesmo
    // (um falso "fora", por exemplo um servidor lento para acordar, nunca deixa o pedido sem resposta só por causa da checagem).
    const fila = [...available];
    const pulados = [];
    let ultimoRecurso = false;
    const juntarPulados = (i) => {
      if (i === fila.length - 1 && !ultimoRecurso && pulados.length) {
        ultimoRecurso = true;
        fila.push(...pulados);
      }
    };
    for (let i = 0; i < fila.length; i += 1) {
      const target = fila[i];
      if (tried >= maxAttempts || now() - started >= deadlineMs) break;
      if (skipProviders.has(target.provider.id)) { juntarPulados(i); continue; }
      if (target.provider.checagemRapida && !ultimoRecurso && !(await estaVivo(target.provider))) {
        pulados.push(target);
        juntarPulados(i);
        continue;
      }
      let lastKind = null;
      for (const keyIdx of keyOrder(target.provider)) {
        if (tried >= maxAttempts || now() - started >= deadlineMs) break;
        tried += 1;
        const t0 = now();
        const timeout = Math.max(1000, Math.min(attemptTimeoutMs, deadlineMs - (t0 - started)));
        try {
          const payload = buildPayload(target, request, stream, opts);
          const out = await callUpstream(target, keyIdx, payload, stream, timeout);
          markSuccess(target);
          totals.ok += 1;
          return { ...out, target, attempts: tried, latencyMs: now() - t0, log, maxTokens: payload.max_tokens };
        } catch (err) {
          const kind = classify(err);
          penalize(target, keyIdx, err, kind);
          log.push({ provider: target.provider.id, model: target.model.id, status: err.status ?? null, kind, message: scrub(err.message) });
          lastKind = kind;
          if (kind === 'transient' || kind === 'credit') skipProviders.add(target.provider.id);
          // o "vivo" guardado já não vale: vence o cache (sem apagar a contagem de falhas nem uma checagem em voo)
          if (kind === 'transient') { const c = checagens.get(target.provider.id); if (c && !c.emVoo) c.ate = 0; }
          if (kind === 'rate' || kind === 'auth') continue; // tenta outra chave do mesmo provedor
          break; // próximo alvo
        }
      }
      // acabaram as chaves por limite/autenticação: o provedor está fora por enquanto
      if (lastKind === 'rate' || lastKind === 'auth') skipProviders.add(target.provider.id);
      juntarPulados(i);
    }

    totals.failed += 1;
    if (log.length && log.every((l) => l.kind === 'client')) {
      throw new GatewayError(log[log.length - 1].status || 400, log[log.length - 1].message, { attempts: log });
    }
    throw new GatewayError(502, 'Todos os provedores falharam.', { attempts: log });
  }

  /** Resposta completa. `opts.sensitive` exclui provedores anônimos. */
  async function chat(request, opts = {}) {
    const out = await run(request, opts, false);
    const json = out.json;
    // Resposta cortada pelo limite de tokens: repassa o aviso (só quando acontece; o finish_reason já segue em choices[0]).
    const cut = /^(length|max_tokens)$/i.test(String(json?.choices?.[0]?.finish_reason ?? ''));
    json.x_gateway = { provider: out.target.provider.id, model: out.target.model.id, attempts: out.attempts, latency_ms: out.latencyMs, ...(cut ? { finish_reason: 'length', truncated: true } : {}), ...(typeof opts.maxTokensFor === 'function' ? { max_tokens: out.maxTokens } : {}) };
    return json;
  }

  /** Para o servidor HTTP: devolve o leitor do stream já validado (1º trecho lido). */
  async function chatStream(request, opts = {}) {
    const out = await run(request, opts, true);
    return { reader: out.stream.reader, first: out.stream.first, provider: out.target.provider.id, model: out.target.model.id, attempts: out.attempts };
  }

  function models() {
    const base = ['auto', 'smart', 'fast', ...Object.keys(combos)].map((id) => ({ id, object: 'model', owned_by: 'yui-gateway', virtual: true }));
    return [...base, ...targets.map((t) => ({ id: t.id, object: 'model', owned_by: t.provider.id, virtual: false, tier: t.model.tier }))];
  }

  /** Estado para o painel (nunca inclui chaves). */
  function status() {
    const t0 = now();
    const secs = (until) => Math.max(0, Math.ceil((until - t0) / SEC));
    return {
      totals: { ...totals },
      combos: Object.keys(combos),
      providers: providers.map((p) => ({
        id: p.id,
        label: p.label,
        anonymous: Boolean(p.anonymous),
        priority: p.priority,
        keys: p.noAuth ? 0 : p.keys.length,
        keysCoolingDown: p.noAuth ? 0 : p.keys.filter((_, i) => keyUntil(p, i) > t0).length,
        cooldownSeconds: secs(providerCooldown.get(p.id) || 0),
        // a checagem rápida de vida (só provedor próprio remoto): sem endereço nem segredo
        ...(p.checagemRapida && checagens.has(p.id) ? { checagem: { vivo: checagens.get(p.id).vivo, falhas: checagens.get(p.id).falhas, validaPorSegundos: secs(checagens.get(p.id).ate) } } : {}),
        targets: targets.filter((t) => t.provider.id === p.id).map((t) => {
          const st = h(t.id);
          return {
            id: t.id, model: t.model.id, tier: t.model.tier,
            available: targetAvailable(t),
            cooldownSeconds: secs(Math.max(st.cooldownUntil, providerCooldown.get(p.id) || 0)),
            failures: providerFailures.get(p.id) || 0, ok: st.ok, fail: st.fail,
            lastError: st.lastError,
            lastStatus: st.lastStatus,
            lastOkSecondsAgo: st.lastOkAt ? Math.round((t0 - st.lastOkAt) / SEC) : null,
          };
        }),
      })),
    };
  }

  /** Zera o estado de saúde (útil para testes e para o painel). */
  function reset() {
    health.clear();
    providerCooldown.clear();
    providerFailures.clear();
    keyCooldown.clear();
    checagens.clear();
  }

  return {
    chat,
    chatStream,
    models,
    status,
    reset,
    resolve,
    hasTargets: () => targets.length > 0,
    anyAvailable: () => targets.some(targetAvailable),
    scrub,
  };
}
