/**
 * Fachada do TTS (a Yui falando e respondendo na call de voz).
 *
 * É a ÚNICA porta que o resto do bot usa. Costura os módulos de src/services/tts/:
 *
 *   texto da IA -> decideSpeak (contexto) -> checkSpeakableText (texto BRUTO)
 *     -> normalizeForSpeech -> checkSpeakableText (texto FINAL, com a transcrição)
 *     -> prepareSpeech (modo + frases) -> fila do servidor (output.js)
 *     -> por frase: engine.synthesize -> toDiscordPcm -> player
 *
 * Regras que explicam o código:
 *  - NADA aqui lança nem bloqueia. `initTts` e `speakVoiceReply` engolem qualquer erro
 *    (o texto já está no chat; falhar na fala nunca pode derrubar a resposta).
 *  - `speakVoiceReply` é síncrona e dispara-e-esquece: até a fila tudo é síncrono (portões,
 *    normalização, divisão em frases); a síntese acontece depois, dentro de `job.synth`,
 *    chamado pelo gerenciador, que já trata a rejeição de cada frase.
 *  - O módulo não importa llmHandler/voiceHandler: tudo que depende do Discord entra por
 *    `deps` (síncronas; falha, ausência ou promessa = nega). Isso evita o ciclo de imports.
 *  - Privacidade nos logs: SÓ metadados (servidor, usuário, provedor, contagens, ms, razão).
 *    Nunca o texto falado, a transcrição, a `message` de um erro nem saída de processo.
 *  - Importar este arquivo não abre processo, timer, banco nem pasta de logs. O logger do
 *    projeto só é carregado na primeira mensagem (e `overrides.logger` o substitui nos testes).
 *  - Nenhum processo pesado sobe no boot: o SAPI só é sondado "por fora" (o powershell.exe
 *    existe?). O helper residente (~150 MB) nasce na 1ª fala ou em `warmupTts()`.
 *
 * Piper e Edge (nuvem) ficaram para depois (T1b §1): hoje só existe o provedor `sapi`.
 *
 * Contrato de `deps` (todas SÍNCRONAS): isEnabled(guildId), isBanned(userId, guildId),
 * isBot(userId, guildId) (só `false` EXATO prova humano; `undefined`/`null`/desconhecido = bot),
 * isRadioActive(guildId), isAiCallActive(guildId),
 * isUserInSameVoice(guildId, userId), canSpeakInChannel(guildId), containsForbidden(text),
 * matchesTrigger(text), resolveName(guildId, id[, kind]) e isOpusAvailable(). Opcional:
 * isStageChannel(guildId, connection).
 */

import { existsSync } from 'node:fs';
import { getTtsConfig } from './config.js';
import { normalizeForSpeech } from './normalize.js';
import { FIXED_PHRASES, prepareSpeech } from './segment.js';
import { pcmDurationMs, toDiscordPcm } from './audio.js';
import { createEngine } from './engine.js';
import { createSapiProvider, getPowerShellPath } from './providers/sapi.js';
import { createEdgeProvider } from './providers/edge.js';
import { createAzureProvider } from './providers/azure.js';
import { checkSpeakableText, createLimiter, decideSpeak, findPii, isBlockedSpeech } from './policy.js';
import { createSpeakerManager } from './output.js';

// Helpers puros que o voiceHandler/llmHandler usam mesmo com o TTS desligado.
export {
  echoesInput,
  isParrotRequest,
  isStopCommand,
  looksLikeToolJson,
  wakeWordInFirstWords,
} from './policy.js';

/** Teto do cache de PCM das frases fixas (só RAM). */
const FIXED_CACHE_MAX_BYTES = 20 * 1024 * 1024;
/** A voz Maria fala ~12 caracteres por segundo: serve para estimar o gasto do orçamento. */
const CHARS_PER_SECOND = 12;
/** Recusas esperadas e frequentes (TTS desligado no servidor etc.) não enchem o log. */
const QUIET_REASONS = new Set(['tts-off', 'not-voice', 'guild-disabled']);
const QUIET_LOG_MS = 10 * 60_000;
const MAX_REASON_KEYS = 50;
const FIXED_TEXTS = new Set(Object.values(FIXED_PHRASES));
/** Fins de resposta que indicam problema (o resto — fim normal, interrupção, troca — é só informação). */
const FAILURE_REASONS = new Set([
  'synth-failed',
  'synth-timeout',
  'next-sentence-timeout',
  'no-connection',
  'not-ready',
  'buffering-timeout',
  'error',
]);

const NOOP = () => {};

// ── Utilidades ────────────────────────────────────────────────────────

/** Etiqueta segura para log: só caracteres simples e curta (IDs, razões, códigos). */
function tag(value, fallback = 'desconhecido') {
  const s = String(value ?? '').replace(/[^A-Za-z0-9_.:-]/g, '').slice(0, 40);
  return s || fallback;
}

/** Código/nome do erro, nunca a mensagem (pode carregar texto falado ou saída de processo). */
function errTag(err) {
  try {
    return tag(err?.code || err?.name, 'ERRO');
  } catch {
    return 'ERRO';
  }
}

/**
 * Chama uma dependência SÍNCRONA. Falha (ausente, lançou ou devolveu promessa) vem como
 * `{ failed: true }`: uma promessa seria sempre "verdadeira" e liberaria a fala por engano.
 */
function syncCall(fn, ...args) {
  if (typeof fn !== 'function') return { failed: true };
  try {
    const value = fn(...args);
    if (value && typeof value.then === 'function') {
      try { value.then(null, NOOP); } catch { /* ignora */ }
      return { failed: true };
    }
    return { value };
  } catch {
    return { failed: true };
  }
}

function abortError() {
  return Object.assign(new Error('aborted'), { code: 'ABORTED' });
}

/** Logger padrão: carrega o logger do projeto na 1ª mensagem (ele cria a pasta de logs). */
function createLazyLogger() {
  let loaded = null;
  const emit = (level) => (msg) => {
    loaded ??= import('../../utils/logger.js').then((m) => m.logger).catch(() => null);
    loaded.then((l) => l?.[level]?.(msg)).catch(NOOP);
  };
  return { info: emit('info'), warn: emit('warn'), error: emit('error'), debug: emit('debug') };
}

/**
 * Logger injetado, blindado: um método ausente ou que lança nunca derruba a fala nem o boot.
 * Sem logger (ou com algo que não é objeto), usa o do projeto, carregado sob demanda.
 */
function safeLogger(candidate) {
  if (!candidate || typeof candidate !== 'object') return createLazyLogger();
  const wrap = (level) => (msg) => {
    try { candidate[level]?.(msg); } catch { /* o log nunca derruba nada */ }
  };
  return { info: wrap('info'), warn: wrap('warn'), error: wrap('error'), debug: wrap('debug') };
}

/**
 * O nome de uma menção (apelido de terceiros) pode ser falado? Fica de fora o que a lista de bloqueio pega
 * mesmo disfarçado ("pu.ta", "p u t a", "pu<ZWSP>ta"), a lista do banHandler, a palavra de ativação (a Yui
 * falando o próprio nome aciona o microfone de novo) e dado pessoal. Dependência ausente, que lança ou
 * assíncrona = nega. Negar só omite o nome da frase; a resposta continua.
 */
function mentionNameSpeakable(name, deps) {
  const compact = name.normalize('NFKC').replace(/[^\p{L}\p{N}]/gu, '');
  if (!compact) return true; // só símbolos: o normalizador descarta
  if (isBlockedSpeech(name) || isBlockedSpeech(compact) || findPii(name)) return false;
  const denied = (fn, ...args) => {
    const r = syncCall(fn, ...args);
    return r.failed || Boolean(r.value);
  };
  return !(denied(deps.containsForbidden, name) || denied(deps.containsForbidden, compact) || denied(deps.matchesTrigger, name));
}

/** Procura o nome de uma menção no cache do cliente (sem rede). Só se `deps.resolveName` faltar. */
function clientNameLookup(client) {
  return (guildId, id, kind) => {
    const guild = client?.guilds?.cache?.get?.(guildId);
    if (!guild) return null;
    if (kind === 'role') return guild.roles?.cache?.get?.(id)?.name ?? null;
    if (kind === 'channel') return guild.channels?.cache?.get?.(id)?.name ?? null;
    const member = guild.members?.cache?.get?.(id);
    return member?.displayName ?? member?.user?.globalName ?? member?.user?.username ?? null;
  };
}

// ── Cache LRU de PCM das frases fixas ─────────────────────────────────

/**
 * Cache LRU em RAM. Guarda o PCM já no formato do Discord das frases fixas ("O resto está
 * no chat." etc.), que se repetem e custam uma síntese cada. Os Buffers guardados NÃO podem
 * ser alterados por quem os recebe (o stream do player lê por `subarray`, sem copiar).
 */
export function createPcmCache(maxBytes = FIXED_CACHE_MAX_BYTES) {
  const map = new Map(); // a ordem de inserção é a ordem de uso (o mais antigo vem primeiro)
  let bytes = 0;
  let hits = 0;
  let misses = 0;
  return {
    get(key) {
      const pcm = map.get(key);
      if (!pcm) {
        misses += 1;
        return null;
      }
      map.delete(key);
      map.set(key, pcm); // usado agora: vai para o fim
      hits += 1;
      return pcm;
    },
    set(key, pcm) {
      if (!Buffer.isBuffer(pcm) || pcm.length === 0 || pcm.length > maxBytes) return false;
      const old = map.get(key);
      if (old) {
        bytes -= old.length;
        map.delete(key);
      }
      map.set(key, pcm);
      bytes += pcm.length;
      while (bytes > maxBytes && map.size > 1) {
        const [oldestKey, oldest] = map.entries().next().value;
        map.delete(oldestKey);
        bytes -= oldest.length;
      }
      return true;
    },
    clear() {
      map.clear();
      bytes = 0;
    },
    stats() {
      return { entries: map.size, bytes, maxBytes, hits, misses };
    },
  };
}

// ── Estado do módulo ──────────────────────────────────────────────────

/** Instância ativa (null = TTS desligado ou ainda não iniciado). */
let tts = null;
let lastInit = { enabled: false, reason: 'not-initialized' };

function newCounters() {
  // Mapas sem protótipo: a chave vem de uma razão de texto, e "__proto__" não pode ter efeito.
  return {
    requests: 0,
    accepted: 0,
    spoken: 0,
    skipped: Object.create(null),
    finished: Object.create(null),
    interrupts: 0,
    errors: 0,
  };
}

function bump(map, key) {
  const k = Object.hasOwn(map, key) || Object.keys(map).length < MAX_REASON_KEYS ? key : 'other';
  map[k] = (map[k] || 0) + 1;
}

// ── Provedores ────────────────────────────────────────────────────────

/**
 * O `probe()` do SAPI sobe o PowerShell (~1 s, ~150 MB) e o deixaria vivo por minutos. No boot
 * só conferimos o que é barato; a voz pt-BR é conferida na 1ª fala (ou em warmupTts()), e um
 * `SAPI_NOVOICE` vira falha normal do disjuntor.
 */
function withBootProbe(provider, env) {
  return {
    ...provider,
    async probe() {
      if (process.platform !== 'win32') return { ok: false, detail: 'o SAPI só existe no Windows' };
      let exe = false;
      try { exe = existsSync(getPowerShellPath(env)); } catch { /* conta como ausente */ }
      return exe
        ? { ok: true, detail: 'powershell.exe presente (voz conferida na 1ª fala)' }
        : { ok: false, detail: 'powershell.exe não encontrado' };
    },
  };
}

function buildProviders(cfg, overrides, log, now) {
  if (Array.isArray(overrides.providers)) {
    // Injetados (testes): a cadeia segue a ordem deles, salvo configuração explícita.
    if (!overrides.config?.providers) {
      cfg.providers = overrides.providers
        .map((p) => String(p?.name ?? '').trim().toLowerCase())
        .filter(Boolean);
    }
    return overrides.providers;
  }
  const out = [];
  for (const name of cfg.providers) {
    // Nomes ainda não implementados (piper, edge) e desconhecidos o engine avisa.
    if (name === 'sapi') {
      const sapi = createSapiProvider({ spawn: overrides.spawn, config: cfg, logger: log, now });
      out.push(withBootProbe(sapi, process.env));
    } else if (name === 'azure') {
      out.push(createAzureProvider({ config: cfg, env: process.env, logger: log, now }));
    } else if (name === 'edge') {
      // Nuvem: o motor só a usa com YUI_TTS_CLOUD=true e texto não sensível (porta de privacidade do engine.js).
      out.push(createEdgeProvider({ config: cfg, logger: log, now }));
    }
  }
  return out;
}

// ── Inicialização ─────────────────────────────────────────────────────

/**
 * Liga o TTS. Nunca lança nem rejeita; o chamador pode não esperar a promessa
 * (`void initTts(...)`) sem atrasar o boot. A instância fica pronta ANTES da sondagem.
 *
 * @param {object} [o]
 * @param {object} [o.client]    cliente do Discord (só para resolver nomes de menção, se faltar deps.resolveName)
 * @param {object} [o.deps]      dependências síncronas (ver cabeçalho)
 * @param {object} [o.overrides] injeção para testes: env, config, providers, manager, logger, now, timers, spawn, voice
 * @returns {Promise<{ enabled: boolean, reason?: string, providers?: object[] }>}
 */
export async function initTts(options) {
  // Argumentos lidos aqui dentro (e não na assinatura): `initTts(null)` não pode lançar.
  const opts = options && typeof options === 'object' ? options : {};
  const client = opts.client ?? null;
  const ov = opts.overrides && typeof opts.overrides === 'object' ? opts.overrides : {};
  const log = safeLogger(ov.logger);
  let created = null;
  try {
    if (tts) {
      log.info('[TTS] initTts chamado de novo: a instância ativa foi mantida.');
      return { enabled: true, reason: 'already-initialized' };
    }
    const cfg = { ...getTtsConfig(ov.env ?? process.env), ...(ov.config || {}) };
    if (!cfg.enabled) {
      log.info('[TTS] Desligado (YUI_TTS_ENABLED=false): nenhum processo será iniciado.');
      lastInit = { enabled: false, reason: 'disabled' };
      return { enabled: false, reason: 'disabled' };
    }

    const d = opts.deps && typeof opts.deps === 'object' ? opts.deps : {};
    const opus = syncCall(d.isOpusAvailable);
    if (opus.failed || !opus.value) {
      log.warn('[TTS] Desligado: o codificador Opus não está disponível (sem ele a Yui não consegue falar).');
      lastInit = { enabled: false, reason: 'no-opus' };
      return { enabled: false, reason: 'no-opus' };
    }

    // O MESMO @discordjs/voice (ESM) que o voiceHandler usa para entrar na call: ele guarda as conexões num registro
    // próprio, e a cópia CJS (que o output.js pegaria por `require`) tem OUTRO registro. Sem isto o getVoiceConnection
    // do gerenciador voltaria sempre vazio ("no-connection") e a Yui responderia no chat sem nunca falar.
    // Carregado antes de qualquer processo/objeto nascer; se falhar, o catch abaixo desliga o TTS com 1 linha de log.
    // (o await abre uma janela: confere de novo se outra chamada não ligou o TTS nesse meio tempo)
    const voiceLib = ov.manager ? null : (ov.voice ?? await import('@discordjs/voice'));
    if (tts) {
      log.info('[TTS] initTts chamado de novo: a instância ativa foi mantida.');
      return { enabled: true, reason: 'already-initialized' };
    }

    const now = typeof ov.now === 'function' ? ov.now : () => Date.now();
    const providers = buildProviders(cfg, ov, log, now);
    const engine = createEngine({ providers, config: cfg, logger: log, now, timers: ov.timers });
    if (engine.getStatus().chain.length === 0) {
      log.warn('[TTS] Desligado: nenhum provedor de voz implementado na configuração (YUI_TTS_PROVIDERS).');
      await engine.disposeAll();
      lastInit = { enabled: false, reason: 'no-providers' };
      return { enabled: false, reason: 'no-providers' };
    }

    const isRadioActive = (guildId) => {
      const r = syncCall(d.isRadioActive, guildId);
      return r.failed ? true : Boolean(r.value); // na dúvida o rádio manda (a música nunca é coberta)
    };
    const manager = ov.manager || createSpeakerManager({
      logger: log,
      config: cfg,
      voice: voiceLib,
      now: ov.now,
      timers: ov.timers,
      isRadioActive,
      isStageChannel: typeof d.isStageChannel === 'function' ? (g, conn) => d.isStageChannel(g, conn) : undefined,
    });

    const clientLookup = clientNameLookup(client);
    const runtime = {
      cfg,
      deps: d,
      log,
      now,
      engine,
      manager,
      // Relógio monotônico em produção (mexer na hora do PC não pode travar os limites); testes injetam o deles.
      limiter: createLimiter({ config: cfg, now: typeof ov.now === 'function' ? ov.now : undefined }),
      cache: createPcmCache(),
      counters: newCounters(),
      quietLogAt: new Map(),
      warming: null,
      resolveName(guildId, id, kind) {
        // Lida a cada chamada: `deps` é um objeto vivo (o integrador pode trocar uma função).
        const r = syncCall(typeof d.resolveName === 'function' ? d.resolveName : clientLookup, guildId, id, kind);
        const name = !r.failed && typeof r.value === 'string' ? r.value : null;
        return name !== null && mentionNameSpeakable(name, d) ? name : null;
      },
    };
    created = runtime;
    tts = runtime; // pronta para falar já; a sondagem abaixo só tira da cadeia quem falhar

    const probes = await engine.probeAll();
    if (tts !== runtime) return { enabled: false, reason: 'shutdown' }; // encerrada durante a sondagem
    const summary = probes.map((p) => ({ name: tag(p.name), ok: Boolean(p.ok), detail: String(p.detail ?? '').slice(0, 120) }));
    for (const p of summary) {
      log.info(`[TTS] Provedor "${p.name}": ${p.ok ? 'disponível' : 'indisponível'} (${p.detail.replace(/[\r\n]+/g, ' ')}).`);
    }
    if (!summary.some((p) => p.ok)) {
      log.warn('[TTS] Nenhum provedor disponível: a Yui seguirá só em texto até algum voltar.');
    }
    log.info(
      `[TTS] Pronto: provedores=${cfg.providers.map((n) => tag(n)).join(',')}, nuvem=${cfg.cloud ? 'ligada' : 'desligada'}, ` +
        `limite=${cfg.maxChars} caracteres/${cfg.maxSentences} frases/${cfg.maxSeconds}s.`,
    );
    lastInit = { enabled: true, reason: 'ready' };
    return { enabled: true, providers: summary };
  } catch (err) {
    log.error(`[TTS] Falha ao iniciar (${errTag(err)}): TTS desligado.`);
    lastInit = { enabled: false, reason: 'init-error' };
    const broken = created;
    if (broken && tts === broken) {
      tts = null;
      try { broken.manager.disposeAll?.('init-error'); } catch { /* ignora */ }
      try { await broken.engine.disposeAll(); } catch { /* ignora */ }
    }
    return { enabled: false, reason: 'init-error' };
  }
}

/**
 * Sobe os helpers dos provedores (ex.: ao entrar numa call de servidor com `voice_tts` ligado),
 * para a 1ª fala não pagar a partida a frio do SAPI. Nunca rejeita. Chamadas simultâneas
 * dividem a mesma execução.
 * @returns {Promise<boolean>} true se o aquecimento rodou sem erro
 */
export async function warmupTts() {
  const t = tts;
  if (!t) return false;
  try {
    // Provedores (SAPI) e codificador Opus: a partida a frio do Opus trava o laço de eventos por ~100 ms,
    // melhor pagar isso ao entrar na call do que no meio da 1ª fala (e do áudio das outras calls).
    t.warming ??= Promise.all([
      t.engine.warmup(),
      Promise.resolve(t.manager.warmup?.()).catch(() => false),
    ]).finally(() => { t.warming = null; });
    await t.warming;
    return true;
  } catch (err) {
    t.log.warn(`[TTS] Falha ao aquecer (${errTag(err)}).`);
    return false;
  }
}

/**
 * Encerra tudo: cancela a fala, descarta os servidores, fecha os provedores e limpa o cache.
 * Serve ao desligamento do bot e aos testes. Nunca rejeita.
 */
export async function shutdownTts() {
  const t = tts;
  if (!t) return false;
  tts = null;
  lastInit = { enabled: false, reason: 'shutdown' };
  try { t.manager.disposeAll?.('shutdown'); } catch { /* ignora */ }
  try { await t.engine.disposeAll(); } catch { /* ignora */ }
  t.cache.clear();
  return true;
}

// ── Fala ──────────────────────────────────────────────────────────────

function skip(t, reason, guildId, userId) {
  const r = tag(reason, 'error');
  bump(t.counters.skipped, r);
  try {
    if (QUIET_REASONS.has(r)) {
      const at = t.now();
      const prev = t.quietLogAt.get(r);
      if (prev !== undefined && at - prev >= 0 && at - prev < QUIET_LOG_MS) return { ok: false, reason: r };
      t.quietLogAt.set(r, at);
    }
    t.log.info(`[TTS] Sem fala: servidor=${tag(guildId, '-')} usuario=${tag(userId, '-')} motivo=${r}`);
  } catch { /* o log nunca derruba a fala */ }
  return { ok: false, reason: r };
}

/**
 * Monta a execução de UMA resposta: sintetiza frase a frase (a ordem importa para o corte por
 * duração e para o provedor "sticky"), usa o cache nas frases fixas e mede os tempos.
 */
function createRun(t, { guildId, userId, sentences, mode, chars, requestedAt, sensitive }) {
  const { cfg, engine, cache, deps, log } = t;
  const sticky = {}; // o engine grava o provedor da 1ª síntese: a resposta inteira usa a mesma voz
  const tasks = [];
  const st = { spentMs: 0, synthMs: 0, firstReadyAt: null, dead: false, cut: false, provider: null };

  /** PCM Discord da frase, do cache (só fixas) ou do engine. null = não deu para falar. */
  async function pcmFor(text, fixed, signal) {
    const primary = sticky.provider || engine.selectChain({ sensitive })[0]?.name;
    if (fixed && primary) {
      const hit = cache.get(`${primary}|${text}`);
      if (hit) {
        sticky.provider ||= primary;
        st.provider = primary;
        return hit;
      }
    }
    const t0 = t.now();
    const res = await engine.synthesize(text, { sensitive, signal, sticky });
    if (!res) return null;
    let pcm;
    try {
      pcm = toDiscordPcm(res);
    } catch (err) {
      log.warn(`[TTS] Áudio do provedor "${tag(res.provider)}" recusado (${errTag(err)}).`);
      return null;
    }
    if (!pcm.length) return null; // só silêncio: conta como "o provedor não falou"
    st.synthMs += t.now() - t0;
    st.provider = res.provider;
    if (fixed) cache.set(`${res.provider}|${text}`, pcm);
    return pcm;
  }

  async function work(index, signal) {
    // Em ordem: o corte por duração precisa da soma das frases anteriores. O engine já
    // serializa a síntese, então esperar a anterior não custa tempo.
    if (index > 0) await (tasks[index - 1] ?? Promise.resolve()).catch(NOOP);
    if (signal?.aborted) throw abortError();
    if (st.dead) return null; // alguma frase anterior falhou ou foi cortada: para por aqui
    const text = sentences[index];
    if (typeof text !== 'string' || !text) return null;

    const fixed = FIXED_TEXTS.has(text);
    let pcm = await pcmFor(text, fixed, signal);
    if (!pcm) {
      st.dead = true;
      if (signal?.aborted) throw abortError();
      return null;
    }
    // Estourou o tempo: nunca corta no meio da frase. Esta vira "O resto está no chat." e as
    // seguintes não tocam. A 1ª frase sempre toca; as fixas (curtas) nunca são cortadas.
    if (!fixed && index > 0 && st.spentMs + pcmDurationMs(pcm) > cfg.maxSeconds * 1000) {
      st.dead = true;
      st.cut = true;
      pcm = await pcmFor(FIXED_PHRASES.rest, true, signal);
      if (!pcm) {
        if (signal?.aborted) throw abortError();
        return null;
      }
    }
    st.spentMs += pcmDurationMs(pcm);
    st.firstReadyAt ??= t.now();
    return pcm;
  }

  const ms = (a, b) => (Number.isFinite(a) && Number.isFinite(b) ? Math.max(0, Math.round(a - b)) : '-');

  return {
    synth: (index, signal) => (tasks[index] ??= work(index, signal)),

    /**
     * Antes de CADA frase (a fala pode começar até 30 s depois do pedido): o interruptor do servidor
     * continua ligado, o rádio continua parado, e quem pediu não foi banido nem saiu da call?
     */
    canSpeak() {
      if (tts !== t) return false;
      const enabled = syncCall(deps.isEnabled, guildId);
      if (enabled.failed || !enabled.value) return false;
      const radio = syncCall(deps.isRadioActive, guildId);
      if (radio.failed || radio.value) return false;
      const banned = syncCall(deps.isBanned, userId, guildId);
      if (banned.failed || banned.value) return false;
      const inCall = syncCall(deps.isUserInSameVoice, guildId, userId);
      return !inCall.failed && Boolean(inCall.value);
    },

    onFinish(info) {
      try {
        const reason = st.cut && info.reason === 'synth-failed' ? 'cut-duration' : tag(info.reason);
        bump(t.counters.finished, reason);
        if (info.sentencesPlayed > 0) t.counters.spoken += 1;
        log[FAILURE_REASONS.has(reason) ? 'warn' : 'info'](
          `[TTS] Fala: servidor=${tag(guildId, '-')} usuario=${tag(userId, '-')} provedor=${tag(st.provider, '-')} ` +
            `modo=${mode} frases=${info.sentencesPlayed}/${info.sentencesTotal} caracteres=${chars} ` +
            `ms_pedido_ate_pronto=${ms(st.firstReadyAt, requestedAt)} ms_sintese=${Math.round(st.synthMs)} ` +
            `ms_primeiro_som=${ms(info.firstSoundAt, requestedAt)} motivo=${reason}`,
        );
      } catch { /* o log nunca derruba a fala */ }
    },
  };
}

function speak(t, req) {
  const { cfg, deps } = t;
  t.counters.requests += 1;
  const r = req && typeof req === 'object' ? req : {};
  const guildId = r.guildId == null ? '' : String(r.guildId);
  const userId = r.userId == null ? '' : String(r.userId);

  // 1. Portões de contexto (interruptor, banido, rádio, prazo, limites...).
  const decision = decideSpeak(r, deps, {
    limiter: t.limiter,
    now: t.now,
    cfg,
    hasProviders: t.engine.selectChain({ sensitive: false }).length > 0,
  });
  if (!decision.ok) return skip(t, decision.reason, guildId, userId);

  // 1b. A transcrição do pedido é OBRIGATÓRIA: sem ela o anti-papagaio (eco da entrada) fica cego, e um
  //     integrador que esquecesse o campo desligaria a proteção sem aviso. Falha fechada.
  if (typeof r.transcript !== 'string' || !r.transcript.trim()) return skip(t, 'no-transcript', guildId, userId);

  // 2. Texto BRUTO da IA: dado pessoal e palavras bloqueadas valem antes de qualquer limpeza.
  const raw = typeof r.text === 'string' ? r.text : '';
  const rawCheck = checkSpeakableText(raw, deps);
  if (!rawCheck.ok) return skip(t, rawCheck.reason, guildId, userId);

  // 3. Normalização. O nome de uma menção só aparece AGORA, por isso o texto FINAL é conferido de novo.
  const norm = normalizeForSpeech(raw, { resolveMention: (id, kind) => t.resolveName(guildId, id, kind) });
  const hasWords = /[\p{L}\p{N}]/u.test(norm.text);
  const pointerOnly = !hasWords && (norm.flags.hadCode || norm.flags.hadList || norm.flags.hadLink);
  if (hasWords) {
    // requireReadable: texto que a voz pt-BR não lê (japonês, russo, árabe...) volta como áudio vazio e
    // contaria como falha do provedor; três pedidos assim em 2 min derrubariam a fala de TODOS por 60 s.
    const finalCheck = checkSpeakableText(norm.text, deps, { transcript: r.transcript, requireReadable: true });
    if (!finalCheck.ok) return skip(t, finalCheck.reason, guildId, userId);
  } else if (!pointerOnly) {
    return skip(t, 'not-speakable', guildId, userId);
  }
  // (só código/lista/link: não sobra texto, mas a frase fixa "Mandei os detalhes no chat." é segura)

  const speech = prepareSpeech(norm, cfg);
  if (speech.mode === 'none' || speech.sentences.length === 0) return skip(t, 'nothing-to-say', guildId, userId);

  const sentences = speech.sentences;
  const chars = sentences.reduce((sum, s) => sum + s.length, 0);
  const requestedAt = Number(r.requestedAt);
  const run = createRun(t, {
    guildId,
    userId,
    sentences,
    mode: speech.mode,
    chars,
    requestedAt,
    sensitive: r.sensitive === false ? false : true,
  });

  const queued = t.manager.enqueue(guildId, {
    userId,
    requestedAt,
    count: sentences.length,
    synth: run.synth,
    canSpeak: run.canSpeak,
    onFinish: run.onFinish,
  });
  if (!queued || queued.ok !== true) return skip(t, queued?.reason ?? 'error', guildId, userId);

  // O limite conta quando a fala entra na fila (e não só quando termina): dois pedidos seguidos
  // do mesmo usuário esbarram no intervalo mínimo mesmo com a 1ª resposta ainda sendo sintetizada.
  const seconds = Math.min(cfg.maxSeconds, Math.max(1, Math.ceil(chars / CHARS_PER_SECOND)));
  t.limiter.recordSpeech(guildId, userId, seconds);
  t.counters.accepted += 1;
  return { ok: true, reason: 'queued', mode: speech.mode, sentences: sentences.length };
}

/**
 * Fala a resposta da IA na call de voz. SÍNCRONA, nunca lança, dispara-e-esquece.
 *
 * @param {{ guildId: string, userId: string, text: string, sensitive: boolean, requestedAt: number,
 *           fromVoice: boolean, transcript: string }} req
 *   `fromVoice` só pode ser true quando o pedido nasceu na call (o voiceHandler marca);
 *   `sensitive` precisa ser exatamente `false` (conteúdo pessoal nunca é falado numa call pública);
 *   `transcript` (o que a pessoa disse) é OBRIGATÓRIO e não vazio: sem ele a resposta não é falada
 *   (razão `no-transcript`), pois é com ele que o anti-papagaio compara a resposta.
 * @returns {{ ok: boolean, reason: string, mode?: string, sentences?: number }}
 *   ok=true: entrou na fila (a síntese continua em segundo plano); ok=false: `reason` diz o porquê.
 */
export function speakVoiceReply(req) {
  const t = tts;
  if (!t) return { ok: false, reason: 'tts-off' };
  try {
    return speak(t, req);
  } catch (err) {
    try {
      t.counters.errors += 1;
      t.log.error(`[TTS] Erro inesperado ao preparar a fala (${errTag(err)}).`);
    } catch { /* ignora */ }
    return { ok: false, reason: 'error' };
  }
}

// ── Controle da fala (delegam ao gerenciador; nunca lançam) ───────────

/** Interrompe a fala do servidor (barge-in, rádio, /sair, interruptor desligado...). */
export function interruptSpeech(guildId, reason = 'interrupted') {
  const t = tts;
  if (!t) return false;
  try {
    const stopped = t.manager.interrupt(String(guildId ?? ''), reason);
    if (stopped) t.counters.interrupts += 1;
    return Boolean(stopped);
  } catch {
    return false;
  }
}

/**
 * Descarta fila, player e janelas de eco do servidor (saiu da call, conexão caiu). O histórico
 * de conversa de voz NÃO é daqui: quem o limpa é o llmHandler.
 */
export function disposeGuild(guildId) {
  const t = tts;
  if (!t) return false;
  try {
    return Boolean(t.manager.dispose(String(guildId ?? ''), 'disposed'));
  } catch {
    return false;
  }
}

/** A Yui está no meio de uma resposta falada neste servidor? */
export function isSpeaking(guildId) {
  const t = tts;
  if (!t) return false;
  try {
    return Boolean(t.manager.isSpeaking(String(guildId ?? '')));
  } catch {
    return false;
  }
}

/** [startMs, endMs] cruza a fala da Yui (mais a margem anti-eco)? Usado para descartar áudio antes do STT. */
export function overlapsSpeech(guildId, startMs, endMs) {
  const t = tts;
  if (!t) return false;
  try {
    return Boolean(t.manager.overlapsSpeech(String(guildId ?? ''), startMs, endMs));
  } catch {
    return false;
  }
}

/** Alimenta o barge-in: `userId` começou (true) ou parou (false) de falar. Idempotente. */
export function noteHumanSpeaking(guildId, userId, speaking) {
  const t = tts;
  if (!t) return;
  try {
    t.manager.noteHumanSpeaking(String(guildId ?? ''), userId, Boolean(speaking));
  } catch { /* ignora */ }
}

const OFF_REASON_TEXT = Object.freeze({
  'not-initialized': 'ainda não iniciou',
  disabled: 'desligada em YUI_TTS_ENABLED',
  'no-opus': 'sem o codificador Opus',
  'no-providers': 'nenhum provedor de voz disponível na configuração',
  'init-error': 'falhou ao iniciar (veja o log)',
  shutdown: 'encerrada',
  ready: 'pronta',
});

/** Motivo (código de getTtsStatus().reason) em português, para /yui-status e para o painel. Código desconhecido = texto genérico. */
export function describeTtsReason(reason) {
  return Object.hasOwn(OFF_REASON_TEXT, reason) ? OFF_REASON_TEXT[reason] : 'motivo desconhecido';
}

/**
 * Diagnóstico para /status: provedores, disjuntores, fila e contadores. Nunca contém texto.
 * Por padrão a saída traz só CONTAGENS: a lista por servidor (com os IDs de todos eles) só sai com
 * `{ detailed: true }`, para quem chama garantir que quem lê é o dono do bot.
 */
export function getTtsStatus(options) {
  const t = tts;
  if (!t) return { initialized: false, enabled: false, reason: lastInit.reason };
  try {
    const c = t.counters;
    const out = t.manager.getStatus();
    const output = options?.detailed === true
      ? out
      : {
        count: out.count,
        speaking: out.guilds.filter((g) => g.speaking).length,
        queued: out.guilds.reduce((sum, g) => sum + (Number(g.queued) || 0), 0),
      };
    return {
      initialized: true,
      enabled: true,
      config: {
        providers: [...t.cfg.providers],
        cloud: t.cfg.cloud,
        maxChars: t.cfg.maxChars,
        maxSentences: t.cfg.maxSentences,
        maxSeconds: t.cfg.maxSeconds,
        bargeIn: t.cfg.bargeIn,
      },
      engine: t.engine.getStatus(),
      output,
      fixedCache: t.cache.stats(),
      counters: {
        requests: c.requests,
        accepted: c.accepted,
        spoken: c.spoken,
        interrupts: c.interrupts,
        errors: c.errors,
        skipped: { ...c.skipped },
        finished: { ...c.finished },
      },
    };
  } catch {
    return { initialized: true, enabled: true, error: true };
  }
}
