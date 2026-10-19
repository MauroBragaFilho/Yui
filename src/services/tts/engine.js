/**
 * Motor de síntese (TTS): escolhe o provedor, aplica prazo e disjuntor, e devolve PCM.
 *
 *  - Cadeia: segue a ordem de `config.providers`. Nome sem provedor instalado
 *    (desconhecido, planejado como piper/edge, ou sem instância) é ignorado com 1 aviso.
 *  - Porta de privacidade: texto sensível OU `config.cloud` falso => só provedor LOCAL.
 *    Quem decide é o backend; a IA nunca escolhe. Provedor de nuvem nem é sondado
 *    nem aquecido enquanto a nuvem estiver desligada. Falha FECHADA: `sensitive` ausente
 *    em `synthesize()` conta como sensível; só `sensitive: false` explícito libera a nuvem.
 *  - Prazo frio/quente por provedor: quem sabe responde por `isWarm()` (o helper do SAPI
 *    dorme após 10 min parado e a próxima fala paga a partida a frio de novo).
 *  - Falha = exceção, prazo estourado, áudio vazio/curto (< 20 ms) ou formato inválido.
 *  - Disjuntor por provedor: 3 falhas em 2 min abrem por 60 s (local) ou 10 min (nuvem);
 *    depois entra 1 tentativa de meia-abertura.
 *  - "Sticky": o chamador cria um objeto `{}` por resposta. O provedor da 1ª síntese fala
 *    a resposta inteira; se ele cair no meio, devolve null (sem trocar de voz).
 *  - Mutex global: uma síntese por vez (RAM e CPU do PC são apertados). Quem espera
 *    respeita o `signal`.
 *
 * O módulo é puro: relógio, timers e logger entram por injeção; nada acontece ao
 * importar. Erros de provedor viram só um CÓDIGO (nunca a mensagem crua nem o texto),
 * para nada do que foi falado chegar a log, status ou stack trace.
 *
 * Piper e Edge ficaram para depois: o contrato de provedor já os comporta (`local:
 * false` passa pela porta de privacidade, testada com provedor de nuvem falso).
 */

import { getTtsConfig, KNOWN_PROVIDERS, PLANNED_PROVIDERS } from './config.js';

const SILENT_LOGGER = { info() {}, warn() {}, error() {}, debug() {} };

const MIN_AUDIO_MS = 20;
const MAX_TEXT_CHARS = 1000;
const LOG_THROTTLE_MS = 10 * 60_000;

const BREAKER_DEFAULTS = Object.freeze({
  threshold: 3,
  windowMs: 2 * 60_000,
  openLocalMs: 60_000,
  openCloudMs: 10 * 60_000,
});

/** Erro padrão de cancelamento (mesmo código que os provedores devem usar). */
export function abortError() {
  return Object.assign(new Error('aborted'), { code: 'ABORTED' });
}

/** Só o CÓDIGO do erro, em formato seguro. A mensagem pode conter texto falado ou saída de processo. */
function errCode(err) {
  try {
    const c = err?.code;
    if (typeof c === 'string' && /^[A-Z][A-Z0-9_]{1,39}$/.test(c)) return c;
  } catch { /* getter que lança */ }
  return 'PROVIDER_ERROR';
}

/** Tira o que não deve chegar ao sintetizador: chaves, colchetes, @ e controles. */
function sanitizeForSynthesis(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(/[{}[\]@]/g, ' ')
    .replace(/[\u0000-\u001F\u007F-\u009F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Confere o áudio devolvido. Devolve um código de erro ou null se está bom. */
function audioProblem(r) {
  if (!r || typeof r !== 'object') return 'EMPTY_AUDIO';
  const pcm = r.pcm;
  if (!(pcm instanceof Uint8Array) || pcm.length === 0) return 'EMPTY_AUDIO';
  const sampleRate = Number(r.sampleRate);
  const channels = Number(r.channels);
  if (!(sampleRate >= 8000 && sampleRate <= 192000) || !(channels === 1 || channels === 2)) return 'BAD_FORMAT';
  const ms = (pcm.length / (2 * channels * sampleRate)) * 1000;
  if (ms < MIN_AUDIO_MS) return 'TOO_SHORT';
  return null;
}

const toBuffer = (pcm) => (Buffer.isBuffer(pcm) ? pcm : Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength));

/**
 * @param {object}   o
 * @param {object[]|object} o.providers  instâncias de provedor (contrato do T1 3.4)
 * @param {object}   [o.config]          getTtsConfig(); padrão: getTtsConfig()
 * @param {object}   [o.logger]          { info, warn, error }; padrão: mudo
 * @param {function} [o.now]             relógio em ms (injetável)
 * @param {object}   [o.timers]          { setTimeout, clearTimeout } (injetáveis)
 */
export function createEngine({ providers = [], config, logger, now, timers } = {}) {
  const cfg = config || getTtsConfig();
  const clock = typeof now === 'function' ? now : () => Date.now();
  // Chama pelo objeto injetado (e não por referência solta) para não perder o `this` dele.
  const tm = {
    setTimeout: (...a) => (typeof timers?.setTimeout === 'function' ? timers.setTimeout(...a) : setTimeout(...a)),
    clearTimeout: (...a) => (typeof timers?.clearTimeout === 'function' ? timers.clearTimeout(...a) : clearTimeout(...a)),
  };
  const log = (level, msg) => {
    try { (logger || SILENT_LOGGER)[level]?.(msg); } catch { /* o log nunca derruba a fala */ }
  };
  const num = (v, def) => (Number.isFinite(Number(v)) && Number(v) > 0 ? Number(v) : def);

  const brk = {
    threshold: num(cfg.breakerThreshold, BREAKER_DEFAULTS.threshold),
    windowMs: num(cfg.breakerWindowMs, BREAKER_DEFAULTS.windowMs),
    openLocalMs: num(cfg.breakerOpenLocalMs, BREAKER_DEFAULTS.openLocalMs),
    openCloudMs: num(cfg.breakerOpenCloudMs, BREAKER_DEFAULTS.openCloudMs),
  };

  // ── Provedores e cadeia configurada ───────────────────────────────
  const list = Array.isArray(providers) ? providers : Object.values(providers || {});
  const byName = new Map();
  for (const p of list) {
    const name = typeof p?.name === 'string' ? p.name.trim().toLowerCase() : '';
    if (!name || typeof p.synth !== 'function') {
      log('warn', '[TTS] Provedor sem nome ou sem synth() ignorado.');
      continue;
    }
    if (!byName.has(name)) byName.set(name, p);
  }

  const wanted = Array.isArray(cfg.providers) && cfg.providers.length ? [...new Set(cfg.providers)] : [...byName.keys()];
  const configured = []; // provedores na ordem da configuração
  for (const name of wanted) {
    const p = byName.get(String(name).toLowerCase());
    if (p) {
      configured.push(p);
    } else if (PLANNED_PROVIDERS.includes(name)) {
      log('warn', `[TTS] Provedor "${name}" ainda não foi implementado nesta versão: ignorado.`);
    } else if (!KNOWN_PROVIDERS.includes(name)) {
      log('warn', `[TTS] Provedor "${name}" desconhecido: ignorado.`);
    } else {
      log('warn', `[TTS] Provedor "${name}" não foi iniciado: ignorado.`);
    }
  }

  /** Estado por provedor: sondagem, aquecimento, disjuntor e contadores. */
  const state = new Map();
  for (const p of configured) {
    state.set(p, {
      probe: { ok: null, detail: '' },
      warm: false,
      failures: [], // instantes das falhas recentes
      openUntil: 0,
      trial: false, // meia-abertura com tentativa em andamento
      ok: 0,
      fail: 0,
      lastError: null,
    });
  }

  const isLocal = (p) => p.local === true; // qualquer outra coisa conta como nuvem (falha fechada)

  // ── Log com freio (uma linha por causa a cada 10 min) ─────────────
  const lastLog = new Map();
  function logThrottled(key, level, msg) {
    const t = clock();
    const prev = lastLog.get(key);
    if (prev !== undefined && t - prev >= 0 && t - prev < LOG_THROTTLE_MS) return;
    lastLog.set(key, t);
    if (lastLog.size > 200) {
      for (const [k, at] of lastLog) if (t - at >= LOG_THROTTLE_MS) lastLog.delete(k);
    }
    log(level, msg);
  }

  // ── Privacidade ───────────────────────────────────────────────────
  /**
   * Provedores que podem receber este texto. Nuvem só com `config.cloud` ligado E
   * texto explicitamente não sensível. Provedor que a sondagem deu como indisponível sai.
   * @returns {object[]} instâncias de provedor, na ordem da configuração
   */
  function selectChain(opts) {
    const cloudOk = cfg.cloud === true && opts?.sensitive === false;
    return configured.filter((p) => (isLocal(p) || cloudOk) && state.get(p).probe.ok !== false);
  }

  // ── Disjuntor ─────────────────────────────────────────────────────
  /** @returns {'closed'|'half-open'|'open'} */
  function breakerState(p) {
    const s = state.get(p);
    const t = clock();
    if (s.openUntil === 0) return 'closed';
    return t < s.openUntil ? 'open' : 'half-open';
  }

  /** Pode tentar este provedor agora? Meia-abertura libera UMA tentativa. */
  function breakerAllow(p) {
    const st = breakerState(p);
    if (st === 'closed') return true;
    if (st === 'open') return false;
    const s = state.get(p);
    if (s.trial) return false;
    s.trial = true;
    return true;
  }

  function recordSuccess(p) {
    const s = state.get(p);
    const wasOpen = s.openUntil !== 0;
    s.ok += 1;
    s.warm = true;
    s.failures = [];
    s.openUntil = 0;
    s.trial = false;
    if (wasOpen) logThrottled(`close:${p.name}`, 'info', `[TTS] Provedor "${p.name}" voltou a responder (disjuntor fechado).`);
  }

  function recordFailure(p, code) {
    const s = state.get(p);
    const t = clock();
    s.fail += 1;
    s.lastError = code;
    const wasTrial = s.trial;
    s.trial = false;
    s.failures = s.failures.filter((at) => t - at < brk.windowMs);
    s.failures.push(t);
    logThrottled(`fail:${p.name}`, 'warn', `[TTS] Provedor "${p.name}" falhou (${code}).`);
    if (wasTrial || s.failures.length >= brk.threshold) {
      const ms = isLocal(p) ? brk.openLocalMs : brk.openCloudMs;
      s.openUntil = t + ms;
      logThrottled(`open:${p.name}`, 'warn',
        `[TTS] Disjuntor aberto para "${p.name}" por ${Math.round(ms / 1000)} s (${s.failures.length} falhas recentes).`);
    }
  }

  /** Tentativa abortada pelo chamador: não é culpa do provedor, só libera a meia-abertura. */
  function releaseTrial(p) {
    state.get(p).trial = false;
  }

  // ── Prazos ────────────────────────────────────────────────────────
  /**
   * O provedor está quente? Quem sabe responde por `isWarm()` (o SAPI, por exemplo, deixa o helper
   * dormir após 10 min parado e a fala seguinte paga a partida a frio de novo); sem isso vale o
   * último sucesso. Erro ao perguntar conta como frio: o prazo maior é o lado seguro.
   */
  function isWarm(p) {
    if (typeof p.isWarm === 'function') {
      try { return Boolean(p.isWarm()); } catch { return false; }
    }
    return state.get(p).warm;
  }

  function timeoutFor(p) {
    const name = p.name;
    const warmMs = num(cfg[`${name}TimeoutMs`], num(cfg.providerTimeoutMs, num(cfg.sapiTimeoutMs, 4000)));
    if (isWarm(p)) return warmMs;
    return Math.max(warmMs, num(cfg[`${name}ColdTimeoutMs`], num(cfg.providerColdTimeoutMs, num(cfg.sapiColdTimeoutMs, warmMs))));
  }

  // ── Execução com prazo e cancelamento ─────────────────────────────
  const inflight = new Set(); // AbortControllers das sínteses em andamento
  let disposed = false;

  /**
   * Roda `fn(signal)` com prazo. Resolve sempre (nunca rejeita):
   * { ok: true, value } ou { ok: false, code, aborted }.
   */
  function runBounded(fn, ms, outerSignal, validate) {
    return new Promise((resolve) => {
      let done = false;
      let handle = null;
      const ctrl = new AbortController();
      inflight.add(ctrl);

      const finish = (r) => {
        if (done) return;
        done = true;
        if (handle !== null) { try { tm.clearTimeout(handle); } catch { /* ignora */ } }
        try { outerSignal?.removeEventListener('abort', onOuter); } catch { /* ignora */ }
        inflight.delete(ctrl);
        resolve(r);
      };
      const onOuter = () => {
        try { ctrl.abort(); } catch { /* ignora */ }
        finish({ ok: false, code: 'ABORTED', aborted: true });
      };

      if (outerSignal?.aborted) { onOuter(); return; }
      outerSignal?.addEventListener?.('abort', onOuter, { once: true });

      try {
        handle = tm.setTimeout(() => {
          try { ctrl.abort(); } catch { /* ignora */ }
          finish({ ok: false, code: 'TIMEOUT', aborted: false });
        }, ms);
        if (handle && typeof handle.unref === 'function') handle.unref();
      } catch {
        finish({ ok: false, code: 'TIMER_ERROR', aborted: false });
        return;
      }

      let pending;
      try {
        pending = Promise.resolve(fn(ctrl.signal));
      } catch (err) {
        finish({ ok: false, code: errCode(err), aborted: false });
        return;
      }
      pending.then(
        (value) => {
          let problem = null;
          try { problem = validate ? validate(value) : null; } catch { problem = 'BAD_FORMAT'; }
          if (problem) finish({ ok: false, code: problem, aborted: false });
          else finish({ ok: true, value });
        },
        (err) => {
          const code = errCode(err);
          finish({ ok: false, code, aborted: code === 'ABORTED' && Boolean(outerSignal?.aborted) });
        },
      ).catch(() => {}); // rede de segurança: nada daqui vira "unhandledRejection"
    });
  }

  // ── Mutex global de síntese ───────────────────────────────────────
  let locked = false;
  const waiters = [];

  function makeRelease() {
    let used = false;
    return () => {
      if (used) return;
      used = true;
      const next = waiters.shift();
      if (next) {
        next.cleanup();
        next.resolve(makeRelease()); // passa a vez sem soltar a trava
      } else {
        locked = false;
      }
    };
  }

  /** Espera a vez. Resolve com a função de soltar, ou null se cancelou/encerrou. */
  function acquire(signal) {
    if (disposed || signal?.aborted) return Promise.resolve(null);
    if (!locked) {
      locked = true;
      return Promise.resolve(makeRelease());
    }
    return new Promise((resolve) => {
      const waiter = {
        resolve,
        cleanup: () => { try { signal?.removeEventListener('abort', onAbort); } catch { /* ignora */ } },
      };
      const onAbort = () => {
        const i = waiters.indexOf(waiter);
        if (i !== -1) waiters.splice(i, 1);
        waiter.cleanup();
        resolve(null);
      };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      waiters.push(waiter);
    });
  }

  // ── API ───────────────────────────────────────────────────────────

  /**
   * Sintetiza UMA frase. Nunca lança: devolve null se nada pôde falar.
   * @param {string} text
   * @param {{ sensitive?: boolean, signal?: AbortSignal, sticky?: object }} [opts]
   *        `sensitive` ausente conta como SENSÍVEL (padrão fechado): só quem afirma `false` pode usar a nuvem.
   * @returns {Promise<{ pcm: Buffer, sampleRate: number, channels: number, provider: string } | null>}
   */
  async function synthesize(text, { sensitive = true, signal, sticky } = {}) {
    try {
      if (disposed || signal?.aborted) return null;
      const clean = sanitizeForSynthesis(text);
      if (!clean) return null;
      if (clean.length > MAX_TEXT_CHARS) {
        logThrottled('too-long', 'warn', `[TTS] Frase com ${clean.length} caracteres recusada (limite ${MAX_TEXT_CHARS}).`);
        return null;
      }

      let chain = selectChain({ sensitive });
      const stuck = sticky && typeof sticky === 'object' ? sticky.provider : undefined;
      // Sticky: a resposta inteira usa o mesmo provedor. Se ele não está disponível, não troca de voz.
      if (stuck) chain = chain.filter((p) => p.name === stuck);
      if (!chain.length) {
        logThrottled('empty-chain', 'warn', '[TTS] Nenhum provedor disponível para esta síntese.');
        return null;
      }

      const release = await acquire(signal);
      if (!release) return null;
      let trialOwner = null; // provedor em meia-abertura que ESTA chamada está testando
      try {
        for (const p of chain) {
          if (disposed || signal?.aborted) return null;
          const halfOpen = breakerState(p) === 'half-open';
          if (!breakerAllow(p)) continue;
          if (halfOpen) trialOwner = p;

          const r = await runBounded((sig) => p.synth(clean, { signal: sig }), timeoutFor(p), signal, audioProblem);
          if (r.ok) {
            trialOwner = null;
            recordSuccess(p);
            if (sticky && typeof sticky === 'object' && !sticky.provider) sticky.provider = p.name;
            const v = r.value;
            return { pcm: toBuffer(v.pcm), sampleRate: Number(v.sampleRate), channels: Number(v.channels), provider: p.name };
          }
          if (r.aborted || disposed) return null; // o `finally` solta a meia-abertura
          trialOwner = null;
          recordFailure(p, r.code);
        }
        logThrottled('all-failed', 'warn', '[TTS] Todos os provedores falharam: a resposta segue só em texto.');
        return null;
      } finally {
        if (trialOwner) releaseTrial(trialOwner);
        release();
      }
    } catch (err) {
      logThrottled('engine-error', 'error', `[TTS] Erro inesperado no motor (${errCode(err)}).`);
      return null;
    }
  }

  /** Sonda cada provedor permitido (barato, sem rede). Nuvem desligada nem é tocada. */
  async function probeAll() {
    const out = [];
    for (const p of configured) {
      const s = state.get(p);
      if (!isLocal(p) && cfg.cloud !== true) {
        s.probe = { ok: null, detail: 'nuvem desligada' };
        out.push({ name: p.name, local: false, ok: false, skipped: true, detail: 'nuvem desligada' });
        continue;
      }
      let result;
      try {
        const ms = num(cfg.probeTimeoutMs, num(cfg.sapiColdTimeoutMs, 15000));
        const r = await runBounded(() => (typeof p.probe === 'function' ? p.probe() : { ok: true, detail: '' }), ms, undefined, null);
        const v = r.ok ? r.value : null;
        result = r.ok
          ? { ok: Boolean(v?.ok), detail: String(v?.detail ?? '').slice(0, 120) }
          : { ok: false, detail: `sondagem falhou (${r.code})` };
      } catch {
        result = { ok: false, detail: 'sondagem falhou' };
      }
      s.probe = result;
      if (!result.ok) logThrottled(`probe:${p.name}`, 'warn', `[TTS] Provedor "${p.name}" indisponível: ${result.detail}.`);
      out.push({ name: p.name, local: isLocal(p), ok: result.ok, detail: result.detail });
    }
    return out;
  }

  /** Sobe os helpers dos provedores que podem falar (ex.: ao entrar numa call com TTS ligado). */
  async function warmup() {
    for (const p of selectChain({ sensitive: false })) {
      if (disposed) return;
      if (typeof p.warmup !== 'function') continue;
      const ms = Math.max(timeoutFor(p), num(cfg.sapiColdTimeoutMs, 15000));
      const r = await runBounded(() => p.warmup(), ms, undefined, null);
      if (r.ok) state.get(p).warm = true;
      else logThrottled(`warmup:${p.name}`, 'warn', `[TTS] Aquecimento de "${p.name}" falhou (${r.code}).`);
    }
  }

  /** Encerra tudo: cancela sínteses, solta quem espera e fecha os provedores. */
  async function disposeAll() {
    disposed = true;
    for (const c of [...inflight]) { try { c.abort(); } catch { /* ignora */ } }
    while (waiters.length) {
      const w = waiters.shift();
      w.cleanup();
      w.resolve(null);
    }
    await Promise.allSettled(list.map(async (p) => {
      try { await p?.dispose?.(); } catch { /* ignora */ }
    }));
  }

  /** Estado para diagnóstico. NUNCA contém texto de fala, só nomes, contadores e códigos. */
  function getStatus() {
    const t = clock();
    return {
      cloudEnabled: cfg.cloud === true,
      disposed,
      chain: configured.map((p) => p.name),
      mutex: { busy: locked, waiting: waiters.length },
      providers: configured.map((p) => {
        const s = state.get(p);
        const bs = breakerState(p);
        return {
          name: p.name,
          local: isLocal(p),
          probe: { ok: s.probe.ok, detail: s.probe.detail },
          warm: isWarm(p),
          breaker: {
            state: bs,
            recentFailures: s.failures.filter((at) => t - at < brk.windowMs).length,
            remainingMs: bs === 'open' ? Math.max(0, s.openUntil - t) : 0,
          },
          successes: s.ok,
          failures: s.fail,
          lastError: s.lastError,
        };
      }),
    };
  }

  return { selectChain, synthesize, probeAll, warmup, disposeAll, getStatus };
}
