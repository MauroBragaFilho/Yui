/**
 * Provedor OMNIROUTE (voz pelo gateway do dono, NUVEM) para o TTS da Yui.
 *
 * O que faz: manda o texto da fala ao OmniRoute (POST {base}/audio/speech, o protocolo de fala compatível com a OpenAI) e recebe o áudio.
 * Hoje a voz é a Leda do Gemini TTS (modelo `google/gemini-3.8-flash-tts`); o OmniRoute usa as chaves do Google que o dono conectou nele.
 * O provedor é GENÉRICO: o modelo e a voz vêm só de YUI_TTS_OMNIROUTE_MODELO e YUI_TTS_OMNIROUTE_VOZ (a voz é só repassada, o prefixo do modelo
 * não é presumido). Só a instrução de estilo em inglês e as marcas do Gemini (<short pause>, <long pause>, <laugh>, <sigh>) dependem do modelo:
 * entram com um modelo "gemini" ou quando YUI_TTS_OMNIROUTE_ESTILO está definida; senão o texto vai puro.
 *
 * Onde estão o endereço e a chave: NÃO há configuração nova. São os do provedor "omniroute" que a Yui JÁ usa para a IA (YUI_GATEWAY_CUSTOM, montado
 * a partir do .env e do painel: src/core/aiSettings.js). O endereço de fala é o da IA sem o "/chat/completions", mais "/audio/speech". Sem esse provedor
 * (ou desligado no Gateway) a porta do provedor fica FECHADA e o motor segue para o próximo da ordem. A chave vai SÓ no cabeçalho Authorization
 * (nunca em URL, corpo, log, erro nem status) e o redirecionamento é recusado (a chave não segue para outro endereço).
 *
 * Privacidade: `local: false`. A porta é PRÓPRIA (veja engine.js): YUI_TTS_OMNIROUTE liga o provedor (sem precisar de YUI_TTS_CLOUD) e texto sensível
 * só passa com YUI_TTS_OMNIROUTE_SENSIVEL=true (padrão desligado: cai no provedor local). Texto sensível também nunca entra no cache. Quando a exceção
 * é USADA fica um contador e uma linha de palavras fixas ("fala sensível enviada ao OmniRoute", com um número), sem o texto, trecho, tamanho ou hash.
 * Credenciais, tokens e senhas nunca vão à síntese (secretGuard.js: o mascaramento de segredos da Yui + formatos de chave): o motor manda esse texto só ao
 * provedor local e, para quem chama o provedor direto, ele mesmo recusa (OMNIROUTE_SECRET) e conta o evento.
 *
 * Prazos: o motor passa o prazo de cada fala (`timeoutMs`): YUI_TTS_OMNIROUTE_TIMEOUT_MS com o provedor quente, YUI_TTS_OMNIROUTE_COLD_TIMEOUT_MS (maior) quando
 * ele está frio (`isWarm()`: sem fala bem-sucedida há YUI_TTS_OMNIROUTE_WARM_MINUTES), sempre limitado ao orçamento de nuvem do motor. `warmup()` (ao entrar na
 * call) e `keepWarm()` (a cada YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES na call) só fazem um GET /models leve, com a mesma rota e a mesma chave, para manter o
 * processo do OmniRoute residente; falham em silêncio.
 * Uma tentativa só, com prazo curto. Qualquer falha (rede, 401/429/5xx, corpo vazio, áudio inválido ou mudo, tempo) vira
 * uma exceção só com CÓDIGO (OMNIROUTE_*): o motor tenta o próximo provedor, sem erro para a pessoa. Uma linha de log por falha, só com números e o
 * código: nunca o texto falado, a chave, o endereço nem a mensagem crua de rede.
 *
 * Áudio: WAV (PCM 16 bits, o que o Gemini devolve) é lido em JS puro; MP3 é convertido pelo ffmpeg (spawn com array, ambiente mínimo). O formato é
 * escolhido pelo Content-Type (sem ele, pelos primeiros bytes). Teto diário de chamadas (YUI_TTS_OMNIROUTE_TETO_DIA) e cache de RAM das falas
 * repetidas (poucas dezenas, validade curta). Sem efeito colateral ao importar.
 */
import crypto from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import { parseWav } from '../audio.js';
import { findSecret } from '../secretGuard.js';
import { loadProviders } from '../../../gateway/providers.js';
import {
  DEFAULT_OMNIROUTE_MODEL,
  DEFAULT_OMNIROUTE_STYLE,
  DEFAULT_OMNIROUTE_VOICE,
  isGeminiTtsModel,
  safeOmnirouteModel,
  safeOmnirouteVoice,
} from '../config.js';

/** O id do provedor de IA da Yui que aponta para o OmniRoute (aiSettings TEMPLATES). */
export const OMNIROUTE_PROVIDER_ID = 'omniroute';
/** Tamanho máximo do texto de UMA chamada (a Yui já corta cada frase bem antes disso). */
export const MAX_TEXT_CHARS = 500;
const MAX_BODY_BYTES = 8 * 1024 * 1024;
const MAX_PCM_BYTES = 20 * 1024 * 1024;
const FALLBACK_SAMPLE_RATE = 24000; // a taxa da saída do ffmpeg (MP3 -> PCM)
const SILENT_PEAK = 66; // ~ -54 dBFS: abaixo disso o áudio é "nada" (o mesmo piso do audio.js)
const CACHE_MAX_ENTRIES = 40;
const CACHE_MAX_BYTES = 12 * 1024 * 1024;
const CACHE_TTL_MS = 10 * 60_000;
const LATENCY_SAMPLES = 50;

function failure(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function abortedError() {
  const err = new Error('síntese abortada');
  err.name = 'AbortError';
  err.code = 'ABORTED';
  return err;
}

// ── Preparação do texto ───────────────────────────────────────────────────────────────────────────────────────────────────────

const MARK_RE = /<\s*(short pause|long pause|laugh|sigh)\s*>/gi;
const INVISIBLE_RE = /[\u0000-\u001F\u007F-\u009F\u200B-\u200F\u202A-\u202E\u2066-\u2069\uFEFF]/g;
const EMOJI_RE = /[\p{Extended_Pictographic}\p{Regional_Indicator}\u200D\uFE0E\uFE0F\u20E3\u{1F3FB}-\u{1F3FF}\u{E0020}-\u{E007F}]/gu;

/**
 * Prepara o texto para a fala: tira Markdown, emoji, links, menções e etiquetas; mantém as 4 marcas do Gemini (`keepMarks`); corta em fim de frase
 * quando passa de `maxChars`. O texto que a Yui já normalizou passa quase igual (isto é a segunda rede, para o provedor nunca receber lixo).
 * @returns {{ text: string, cut: boolean, tooLong: boolean }}  `text` vazio = nada a falar (`tooLong`: a 1ª frase sozinha passa do limite)
 */
export function prepareOmnirouteText(raw, { maxChars = MAX_TEXT_CHARS, keepMarks = true } = {}) {
  let t = typeof raw === 'string' ? raw.normalize('NFC') : '';
  t = t.replace(/```[\s\S]*?```/g, ' ').replace(/`+/g, '');
  // linhas: títulos, citações, listas
  t = t.replace(/^[ \t]{0,3}#{1,6}[ \t]+/gm, '').replace(/^[ \t]*>+[ \t]?/gm, '').replace(/^[ \t]*[-*+•][ \t]+/gm, '').replace(/^[ \t]*\d{1,3}[.)][ \t]+/gm, '');
  // [texto](link) e ![alt](imagem): fica o texto
  t = t.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1');
  // Discord: emoji personalizado, menções de usuário/cargo/canal, hora, @everyone/@here, @nome
  t = t.replace(/<a?:\w+:\d+>/g, ' ').replace(/<(?:@[!&]?|#)\d+>/g, ' ').replace(/<t:\d+(?::[A-Za-z])?>/g, ' ');
  t = t.replace(/@(?:everyone|here)\b/gi, ' ').replace(/@[\p{L}\p{N}_.]+/gu, ' ');
  // links soltos
  t = t.replace(/\b(?:https?|ftp):\/\/\S+/gi, ' ').replace(/\bwww\.\S+/gi, ' ');
  // as marcas do Gemini viram marcadores (só com `keepMarks`) para sobreviverem à limpeza das etiquetas
  const marks = [];
  t = t.replace(MARK_RE, (_all, name) => {
    if (!keepMarks) return ' ';
    marks.push(name.toLowerCase().replace(/\s+/g, ' '));
    return ` \uE000${marks.length - 1}\uE001 `;
  });
  // qualquer outra etiqueta (<b>, </x>, <algo>) e os < > que sobrarem
  t = t.replace(/<\/?[A-Za-z][^<>]{0,80}>/g, ' ').replace(/[<>]/g, ' ');
  // marcas de Markdown e colchetes
  t = t.replace(/[*~#]/g, '').replace(/[_|[\]{}]/g, ' ');
  t = t.replace(EMOJI_RE, '').replace(INVISIBLE_RE, ' ').replace(/\s+/g, ' ').trim();
  // devolve as marcas
  t = t.replace(/\uE000(\d+)\uE001/g, (_all, i) => `<${marks[Number(i)] ?? ''}>`).replace(/<>/g, '').replace(/\s+/g, ' ').trim();

  if (!/[\p{L}\p{N}]/u.test(t.replace(MARK_RE, ' '))) return { text: '', cut: false, tooLong: false };
  if (t.length <= maxChars) return { text: t, cut: false, tooLong: false };

  // passou do limite: corta no último fim de frase que cabe (nunca no meio de uma frase)
  let end = -1;
  for (const m of t.matchAll(/[.!?…]+(?=\s|$)/g)) {
    const stop = m.index + m[0].length;
    if (stop <= maxChars) end = stop;
    else break;
  }
  if (end <= 0) return { text: '', cut: false, tooLong: true };
  return { text: t.slice(0, end).trim(), cut: true, tooLong: false };
}

/** O corpo `input` da chamada: a instrução de estilo (se houver), dois-pontos e o texto. */
export function composeInput(style, text) {
  const s = String(style ?? '').replace(/[\s:]+$/, '');
  return s ? `${s}: ${text}` : text;
}

// ── Rota (endereço e chave do provedor "omniroute" da IA) ─────────────────────────────────────────────────────────────────────────

/**
 * Lê o provedor "omniroute" que a Yui usa para a IA e deriva a rota de fala. Nunca lança.
 * @returns {{ ok: true, url: string, key: string } | { ok: false, code: string }}
 */
export function resolveOmnirouteRoute(env = process.env) {
  let providers;
  try { providers = loadProviders(env).providers; } catch { return { ok: false, code: 'OMNIROUTE_CONFIG' }; }
  const p = Array.isArray(providers) ? providers.find((x) => x.id === OMNIROUTE_PROVIDER_ID) : null;
  if (!p) return { ok: false, code: 'OMNIROUTE_NOT_CONFIGURED' };
  const m = /^(https?:\/\/.+?)\/chat\/completions\/?$/i.exec(String(p.endpoint ?? ''));
  if (!m) return { ok: false, code: 'OMNIROUTE_ENDPOINT' };
  return { ok: true, url: `${m[1]}/audio/speech`, key: p.noAuth ? '' : String(p.keys?.[0] ?? '') };
}

// ── Áudio ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** wav, mp3 ou null: pelo Content-Type; sem ele (ou genérico), pelos primeiros bytes. */
export function detectAudioFormat(contentType, buf) {
  const ct = String(contentType ?? '').toLowerCase();
  if (/audio\/(?:x-)?wav|audio\/wave|audio\/vnd\.wave/.test(ct)) return 'wav';
  if (/audio\/mpeg|audio\/mp3|audio\/x-mpeg/.test(ct)) return 'mp3';
  if (ct && !/octet-stream|binary/.test(ct) && !/^audio\//.test(ct)) return null; // json, texto, html...: não é áudio
  if (buf.length >= 12 && buf.toString('latin1', 0, 4) === 'RIFF' && buf.toString('latin1', 8, 12) === 'WAVE') return 'wav';
  if (buf.length >= 3 && (buf.toString('latin1', 0, 3) === 'ID3' || (buf[0] === 0xff && (buf[1] & 0xe0) === 0xe0))) return 'mp3';
  return null;
}

/** O pico (|amostra|) de um PCM s16le. */
function peakOf(pcm) {
  let peak = 0;
  for (let i = 0; i + 1 < pcm.length; i += 2) {
    const a = Math.abs(pcm.readInt16LE(i));
    if (a > peak) peak = a;
  }
  return peak;
}

/**
 * @param {object} [o]
 * @param {object} [o.config]    getTtsConfig(): omniroute, omnirouteModel, omnirouteVoice, omnirouteStyle, omnirouteSensitive, omnirouteDailyCap, omnirouteTimeoutMs
 * @param {object} [o.env]       de onde vem o provedor "omniroute" da IA (padrão process.env; lido a cada fala)
 * @param {function} [o.fetchImpl]  injetável (testes)
 * @param {function} [o.spawn]      injetável (testes): spawn(file, args, opts), só para MP3
 * @param {() => (string|Promise<string>)} [o.getFfmpeg]  caminho do ffmpeg (injetável)
 */
export function createOmnirouteProvider({ config = {}, env = process.env, logger = null, now = Date.now, fetchImpl = null, spawn = nodeSpawn, getFfmpeg = null } = {}) {
  const log = (level, msg) => { try { logger?.[level]?.(msg); } catch { /* o log nunca derruba a fala */ } };
  const doFetch = fetchImpl || ((...a) => fetch(...a));
  const model = safeOmnirouteModel(config.omnirouteModel, DEFAULT_OMNIROUTE_MODEL);
  const voice = safeOmnirouteVoice(config.omnirouteVoice, DEFAULT_OMNIROUTE_VOICE);
  const gemini = isGeminiTtsModel(model);
  // null = não definida: o estilo padrão vale só para modelo do Gemini; texto (mesmo vazio = "nenhum") vale para qualquer modelo
  const styleSet = typeof config.omnirouteStyle === 'string';
  const style = styleSet ? config.omnirouteStyle : (gemini ? DEFAULT_OMNIROUTE_STYLE : '');
  const keepMarks = gemini || (styleSet && style !== '');
  const cap = Number.isFinite(config.omnirouteDailyCap) && config.omnirouteDailyCap >= 1 ? Math.floor(config.omnirouteDailyCap) : 400;
  const timeoutMs = Number.isFinite(config.omnirouteTimeoutMs) && config.omnirouteTimeoutMs >= 100 ? config.omnirouteTimeoutMs : 10_000;
  // o prazo daqui vence um pouco antes do prazo do motor (o mesmo valor), para o código do erro ser o nosso (a configuração real nunca fica abaixo de 2 s)
  const requestMsFor = (ms) => Math.max(50, ms - Math.min(300, Math.round(ms / 10)));
  const requestMs = requestMsFor(timeoutMs);
  // O prazo FRIO e a janela do "quente": o motor passa o prazo que vale para ESTA fala em `synth(text, { timeoutMs })`; o daqui acompanha esse prazo
  // (sem isso o prazo curto do provedor venceria o prazo frio do motor). Quente = houve fala bem-sucedida pela rede há menos de `warmMs`.
  const coldMs = Number.isFinite(config.omnirouteColdTimeoutMs) && config.omnirouteColdTimeoutMs >= 100 ? Math.max(timeoutMs, config.omnirouteColdTimeoutMs) : timeoutMs;
  const warmMs = (Number.isFinite(config.omnirouteWarmMinutes) && config.omnirouteWarmMinutes >= 1 ? config.omnirouteWarmMinutes : 5) * 60_000;
  const keepaliveMs = (Number.isFinite(config.omnirouteKeepaliveMinutes) && config.omnirouteKeepaliveMinutes >= 0 ? config.omnirouteKeepaliveMinutes : 0) * 60_000;
  let lastOkAt = null; // fala bem-sucedida pela rede (o cache não conta)
  let lastTouchAt = null; // fala ou toque (GET /models) bem-sucedido
  const switchOn = () => config.omniroute === true;
  const allowSensitive = () => config.omnirouteSensitive === true;

  // ── teto diário (por dia do relógio da máquina; contador só em memória) ─────────────────────────
  let usage = { day: '', used: 0 };
  const stats = { ok: 0, fail: 0, hits: 0, misses: 0, latencies: [], sensitiveSent: 0, secretBlocked: 0 };
  function rollDay() {
    const d = new Date(now());
    const day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    if (usage.day !== day) usage = { day, used: 0 };
  }
  const capReached = () => { rollDay(); return usage.used >= cap; };
  function takeQuota() {
    rollDay();
    if (usage.used >= cap) throw failure('OMNIROUTE_TETO', 'teto diário de falas pelo OmniRoute');
    usage.used += 1;
    if (usage.used === cap) log('info', `[TTS] OmniRoute: teto diário de ${cap} falas atingido; o próximo provedor da ordem assume até amanhã.`);
  }

  // ── cache de RAM das falas repetidas ────────────────────────────────────────────────────────────
  const cache = new Map(); // chave -> { audio, at } (a ordem de inserção é a ordem de uso)
  let cacheBytes = 0;
  const keyOf = (input) => crypto.createHash('sha256').update(`${model}\u0000${voice}\u0000${input}`).digest('hex');
  function cacheGet(key) {
    const hit = cache.get(key);
    if (!hit) return null;
    if (now() - hit.at > CACHE_TTL_MS || now() < hit.at) {
      cache.delete(key);
      cacheBytes -= hit.audio.pcm.length;
      return null;
    }
    cache.delete(key);
    cache.set(key, hit); // usado agora: vai para o fim
    return hit.audio;
  }
  function cacheSet(key, audio) {
    const size = audio.pcm.length;
    if (size > CACHE_MAX_BYTES) return;
    const old = cache.get(key);
    if (old) { cacheBytes -= old.audio.pcm.length; cache.delete(key); }
    while (cache.size >= CACHE_MAX_ENTRIES || cacheBytes + size > CACHE_MAX_BYTES) {
      const [oldestKey, oldest] = cache.entries().next().value;
      cache.delete(oldestKey);
      cacheBytes -= oldest.audio.pcm.length;
    }
    cache.set(key, { audio, at: now() });
    cacheBytes += size;
  }

  // ── a chamada ───────────────────────────────────────────────────────────────────────────────────
  /** POST ao OmniRoute com UM prazo e o cancelamento do motor. Devolve { buf, contentType } ou lança com código. */
  async function post(route, body, signal, info, reqMs = requestMs) {
    if (signal?.aborted) throw abortedError();
    const ctl = new AbortController();
    let timedOut = false;
    const onAbort = () => ctl.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => { timedOut = true; ctl.abort(); }, reqMs); // sempre limpo no `finally` (não segura o processo)
    const headers = { 'Content-Type': 'application/json', Accept: 'audio/wav, audio/mpeg;q=0.9' };
    if (route.key) headers.Authorization = `Bearer ${route.key}`;
    const lost = () => {
      if (signal?.aborted) return abortedError();
      return failure(timedOut ? 'OMNIROUTE_TIMEOUT' : 'OMNIROUTE_NETWORK', timedOut ? 'o OmniRoute não respondeu a tempo' : 'sem resposta do OmniRoute');
    };
    try {
      let res;
      try {
        res = await doFetch(route.url, { method: 'POST', headers, body, redirect: 'error', signal: ctl.signal });
      } catch { throw lost(); }
      info.status = res.status;
      if (!res.ok) {
        try { await res.body?.cancel?.(); } catch { /* ok */ }
        const code = res.status === 401 || res.status === 403 ? 'OMNIROUTE_AUTH' : res.status === 429 ? 'OMNIROUTE_RATE' : 'OMNIROUTE_HTTP';
        throw failure(code, `o OmniRoute respondeu ${res.status}`);
      }
      const declared = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        try { await res.body?.cancel?.(); } catch { /* ok */ }
        throw failure('OMNIROUTE_TOO_BIG', 'áudio grande demais');
      }
      let buf;
      try { buf = Buffer.from(await res.arrayBuffer()); } catch { throw lost(); }
      info.networkMs = now() - info.t0;
      if (buf.length > MAX_BODY_BYTES) throw failure('OMNIROUTE_TOO_BIG', 'áudio grande demais');
      return { buf, contentType: res.headers?.get?.('content-type') ?? '' };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  /**
   * Toque leve para manter o processo do OmniRoute na memória (GET {base}/models, a mesma rota e a mesma chave da fala; a chave só no cabeçalho).
   * Não gasta o teto diário, não fala nada e NUNCA lança: devolve true só se o OmniRoute respondeu 2xx.
   * Sem `force`, não toca se uma fala ou um toque deu certo há menos da metade do intervalo (a fala já o manteve acordado).
   */
  async function touch({ signal, force = false } = {}) {
    try {
      if (!switchOn() || signal?.aborted) return false;
      if (keepaliveMs <= 0) return false; // YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES=0 (o padrão): nenhuma sondagem, nem a da entrada na call
      const route = resolveOmnirouteRoute(env);
      if (!route.ok) return false;
      const t = now();
      if (!force && lastTouchAt !== null && t >= lastTouchAt && t - lastTouchAt < keepaliveMs / 2) return false;
      const ctl = new AbortController();
      const onAbort = () => ctl.abort();
      signal?.addEventListener?.('abort', onAbort, { once: true });
      const timer = setTimeout(() => ctl.abort(), requestMsFor(coldMs));
      try {
        const headers = { Accept: 'application/json' };
        if (route.key) headers.Authorization = `Bearer ${route.key}`;
        const res = await doFetch(route.url.replace(/\/audio\/speech$/, '/models'), { method: 'GET', headers, redirect: 'error', signal: ctl.signal });
        try { await res.body?.cancel?.(); } catch { /* ok */ }
        if (!res.ok) return false;
        lastTouchAt = now();
        return true;
      } finally {
        clearTimeout(timer);
        signal?.removeEventListener?.('abort', onAbort);
      }
    } catch {
      return false; // em silêncio: o toque nunca atrapalha a call nem a fala
    }
  }

  /** MP3 -> PCM s16le 24 kHz mono, com o ffmpeg (ambiente mínimo, sem shell). */
  async function mp3ToPcm(mp3, signal) {
    let exe;
    try {
      exe = getFfmpeg ? await getFfmpeg() : (await import('../../../utils/binaries.js')).getFfmpegPath();
    } catch { throw failure('OMNIROUTE_FFMPEG', 'ffmpeg indisponível'); }
    return await new Promise((resolve, reject) => {
      if (signal?.aborted) return reject(abortedError());
      let child;
      try {
        child = spawn(exe, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-f', 's16le', '-acodec', 'pcm_s16le', '-ar', String(FALLBACK_SAMPLE_RATE), '-ac', '1', 'pipe:1'], {
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'ignore'],
          env: { SystemRoot: process.env.SystemRoot || 'C:\\Windows', PATH: process.env.SystemRoot ? `${process.env.SystemRoot}\\System32` : '' },
        });
      } catch { return reject(failure('OMNIROUTE_FFMPEG', 'ffmpeg indisponível')); }
      const chunks = [];
      let bytes = 0;
      let settled = false;
      const done = (fn, v) => { if (settled) return; settled = true; signal?.removeEventListener?.('abort', onAbort); fn(v); };
      const onAbort = () => { try { child.kill(); } catch { /* ok */ } done(reject, abortedError()); };
      signal?.addEventListener?.('abort', onAbort, { once: true });
      child.stdout.on('data', (d) => {
        bytes += d.length;
        if (bytes > MAX_PCM_BYTES) { try { child.kill(); } catch { /* ok */ } return done(reject, failure('OMNIROUTE_FFMPEG', 'conversão grande demais')); }
        chunks.push(d);
      });
      child.on('error', () => done(reject, failure('OMNIROUTE_FFMPEG', 'ffmpeg indisponível')));
      child.on('close', (code) => (code === 0 && bytes > 0 ? done(resolve, Buffer.concat(chunks)) : done(reject, failure('OMNIROUTE_FFMPEG', 'falha ao converter o áudio'))));
      child.stdin.on('error', () => { /* o close trata */ });
      child.stdin.end(mp3);
    });
  }

  /** O corpo da resposta -> { pcm, sampleRate, channels } ou lança OMNIROUTE_EMPTY / BAD_AUDIO / SILENT / FFMPEG. */
  async function decode(buf, contentType, signal) {
    if (!buf.length) throw failure('OMNIROUTE_EMPTY', 'o OmniRoute não devolveu áudio');
    const format = detectAudioFormat(contentType, buf);
    let audio;
    if (format === 'wav') {
      try { audio = parseWav(buf); } catch { throw failure('OMNIROUTE_BAD_AUDIO', 'WAV inválido'); }
    } else if (format === 'mp3') {
      audio = { pcm: await mp3ToPcm(buf, signal), sampleRate: FALLBACK_SAMPLE_RATE, channels: 1 };
    } else {
      throw failure('OMNIROUTE_BAD_AUDIO', 'formato de áudio desconhecido');
    }
    if (!(audio.sampleRate >= 8000 && audio.sampleRate <= 192000) || !(audio.channels === 1 || audio.channels === 2)) throw failure('OMNIROUTE_BAD_AUDIO', 'formato de áudio fora do esperado');
    if (!audio.pcm.length) throw failure('OMNIROUTE_EMPTY', 'áudio sem amostras');
    if (peakOf(audio.pcm) < SILENT_PEAK) throw failure('OMNIROUTE_SILENT', 'áudio mudo');
    return { audio: { pcm: audio.pcm, sampleRate: audio.sampleRate, channels: audio.channels }, format };
  }

  return {
    name: 'omniroute',
    local: false,

    /** A porta PRÓPRIA (lida pelo motor a cada seleção): ligado, sem estourar o teto e com o provedor "omniroute" da IA cadastrado. */
    gate: {
      enabled: () => switchOn() && !capReached() && resolveOmnirouteRoute(env).ok,
      allowsSensitive: allowSensitive,
    },

    /** Sem rede e sem fixar nada: a rota da IA é conferida a cada fala (o painel pode mudá-la sem reiniciar). */
    async probe() {
      if (!switchOn()) return { ok: false, detail: 'YUI_TTS_OMNIROUTE desligado' };
      return { ok: true, detail: `OmniRoute ${model}, voz ${voice} (nuvem; a rota da IA é conferida a cada fala; rede só na 1ª fala)` };
    },

    /** Ao entrar na call: um toque leve (GET /models) para o OmniRoute acordar antes da 1ª fala. Nada residente aqui; nunca lança. */
    async warmup() { await touch({ force: true }); },

    /** De tempos em tempos enquanto a Yui está na call (o motor chama; ver `keepWarm` em engine.js). true = o OmniRoute respondeu. */
    async keepWarm() { return touch({}); },

    /**
     * Quente = houve fala bem-sucedida pela rede há menos de `omnirouteWarmMinutes` (o cache não conta). Passado esse tempo volta a ser frio e o motor
     * dá o prazo frio na próxima fala (o OmniRoute do notebook com HDD tem a memória paginada para o disco). Um toque (GET /models) NÃO esquenta a
     * fala: o prazo frio continua valendo até uma fala de verdade dar certo.
     */
    isWarm() {
      if (lastOkAt === null) return false;
      const t = now();
      return t >= lastOkAt && t - lastOkAt < warmMs;
    },

    async synth(text, { signal, sensitive = true, timeoutMs: askedMs } = {}) {
      const t0 = now();
      const info = { t0, status: null, networkMs: null };
      try {
        // Nenhuma credencial, token ou senha vai à síntese (o motor já manda esse texto só ao provedor local; aqui é a segunda trava, para quem chama direto)
        if (findSecret(text, env)) {
          stats.secretBlocked += 1;
          throw failure('OMNIROUTE_SECRET', 'texto com cara de segredo não é enviado');
        }
        const prepared = prepareOmnirouteText(text, { maxChars: MAX_TEXT_CHARS, keepMarks });
        if (!prepared.text) throw failure(prepared.tooLong ? 'OMNIROUTE_TOO_LONG' : 'OMNIROUTE_EMPTY', prepared.tooLong ? 'frase longa demais para uma fala' : 'texto vazio');
        const input = composeInput(style, prepared.text);
        const useCache = sensitive === false;
        const key = useCache ? keyOf(input) : '';
        if (useCache) {
          const hit = cacheGet(key);
          if (hit) {
            stats.hits += 1;
            log('info', `[TTS] OmniRoute: cache caracteres=${prepared.text.length} ms_total=${now() - t0}`);
            return { pcm: hit.pcm, sampleRate: hit.sampleRate, channels: hit.channels };
          }
          stats.misses += 1;
        }
        const route = resolveOmnirouteRoute(env);
        if (!route.ok) throw failure('OMNIROUTE_CONFIG', 'provedor omniroute da IA não está cadastrado');
        takeQuota();
        // A EXCEÇÃO da fala sensível (YUI_TTS_OMNIROUTE_SENSIVEL=true) fica registrada: um contador e uma linha de palavras fixas e um número (nunca o texto,
        // nenhum trecho dele, o tamanho nem um hash). Conta o que foi despachado, mesmo que a chamada falhe depois.
        if (sensitive !== false) {
          stats.sensitiveSent += 1;
          log('info', `[TTS] OmniRoute: fala sensível enviada ao OmniRoute (total=${stats.sensitiveSent}).`);
        }
        const body = JSON.stringify({ model, input, voice, response_format: 'wav' });
        const reqMs = Number.isFinite(askedMs) && askedMs >= 100 ? requestMsFor(askedMs) : requestMs;
        const { buf, contentType } = await post(route, body, signal, info, reqMs);
        const { audio, format } = await decode(buf, contentType, signal);
        if (useCache) cacheSet(key, audio);
        const total = now() - t0;
        stats.ok += 1;
        lastOkAt = now();
        lastTouchAt = lastOkAt;
        stats.latencies.push(total);
        if (stats.latencies.length > LATENCY_SAMPLES) stats.latencies.shift();
        // (fala sensível: nem o tamanho do texto vai ao log)
        log('info', `[TTS] OmniRoute: caracteres=${sensitive === false ? prepared.text.length : '-'} bytes=${buf.length} formato=${format} ms_rede=${info.networkMs ?? '-'} ms_total=${total} cache=nao`);
        return audio;
      } catch (err) {
        if (err?.code !== 'ABORTED') {
          if (err?.code !== 'OMNIROUTE_SECRET') stats.fail += 1; // segredo barrado não é falha do provedor
          const code = typeof err?.code === 'string' && /^OMNIROUTE_[A-Z_]{2,30}$/.test(err.code) ? err.code : 'OMNIROUTE_ERROR';
          log('warn', `[TTS] OmniRoute: falha codigo=${code} status=${info.status ?? '-'} ms=${now() - t0}`);
        }
        throw err;
      }
    },

    async dispose() { cache.clear(); cacheBytes = 0; },

    /** Só para teste/status: contadores e latências (nunca o texto, a chave nem o endereço). */
    getUsage() {
      rollDay();
      const l = stats.latencies;
      return {
        day: usage.day, used: usage.used, cap,
        ok: stats.ok, fail: stats.fail, sensitiveSent: stats.sensitiveSent, secretBlocked: stats.secretBlocked, cacheHits: stats.hits, cacheMisses: stats.misses, cacheEntries: cache.size, cacheBytes,
        lastMs: l.length ? l[l.length - 1] : null, avgMs: l.length ? Math.round(l.reduce((a, b) => a + b, 0) / l.length) : null, maxMs: l.length ? Math.max(...l) : null,
      };
    },
  };
}
