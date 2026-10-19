/**
 * Política da fala (TTS): decide SE a Yui pode falar, nunca COMO.
 *
 * Duas camadas, ambas FALHANDO FECHADO (qualquer dúvida, exceção ou dependência
 * assíncrona = não fala; o texto já está no chat):
 *
 *  - decideSpeak: portões de CONTEXTO (interruptor do servidor, banido, rádio, prazo,
 *    limites de uso...). Não olha o texto.
 *  - checkSpeakableText: portões de CONTEÚDO (erro/sistema, dados pessoais, palavras
 *    bloqueadas, gatilho, JSON de ferramenta, eco da entrada). O chamador usa a função
 *    no texto BRUTO da IA e de novo no texto FINAL (depois de resolver menções).
 *
 * Tudo aqui só impede de FALAR. Nada aqui bane, grava ou avisa ninguém.
 *
 * O módulo é puro: sem timers, sem processos, sem banco, sem logger (não há o que
 * registrar além da razão devolvida). O relógio entra por injeção. A única leitura de
 * disco é a lista de bloqueio, feita sob demanda (e com reserva embutida se falhar).
 * Nenhuma regex abaixo tem repetição ambígua (que case o mesmo trecho de duas formas) e todo
 * texto é cortado em MAX_SCAN_CHARS antes de ser examinado (proteção contra ReDoS).
 */

import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { getTtsConfig } from './config.js';

/** Teto de caracteres examinados por função. Texto maior que isso nunca é falado. */
const MAX_SCAN_CHARS = 20_000;

const MINUTE_MS = 60_000;
const BUDGET_WINDOW_MS = 10 * MINUTE_MS;

const ZERO_WIDTH = /[\u200B-\u200F\u202A-\u202E\u2060-\u2064\u00AD\u180E\uFEFF]/g;

// ── Utilidades de normalização ────────────────────────────────────────

// Letras cirílicas/gregas parecidas com as latinas: o NFKC não as converte.
const HOMOGLYPHS = {
  'а': 'a', 'в': 'b', 'е': 'e', 'ё': 'e', 'к': 'k', 'м': 'm', 'н': 'h', 'о': 'o', 'р': 'p',
  'с': 'c', 'т': 't', 'у': 'y', 'х': 'x', 'і': 'i', 'ј': 'j', 'ѕ': 's',
  'α': 'a', 'β': 'b', 'ε': 'e', 'ι': 'i', 'κ': 'k', 'ν': 'v', 'ο': 'o', 'ρ': 'p', 'τ': 't',
  'υ': 'u', 'χ': 'x',
};

/**
 * Mais de 4 marcas combinantes seguidas nunca aparecem em texto de verdade (acento tem 1 ou 2); são
 * "zalgo". `String.prototype.normalize` é quadrático com marcas fora de ordem (20 mil delas
 * travavam o laço de eventos por mais de 1 s), então cortamos o excesso ANTES de normalizar.
 */
const MARK_RUN = /(\p{M}{4})\p{M}+/gu;
const squeezeMarks = (s) => s.replace(MARK_RUN, '$1');

/** Minúsculas, sem acento, sem caracteres invisíveis, sem letras "disfarçadas". */
export function foldText(text) {
  return squeezeMarks(String(text ?? ''))
    .normalize('NFKC')
    .replace(ZERO_WIDTH, '')
    .toLowerCase()
    .replace(/[\u0370-\u03ff\u0400-\u04ff]/g, (c) => HOMOGLYPHS[c] ?? c)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '');
}

/** Só letras e números, em minúsculas, separados por um espaço. */
function words(text) {
  return foldText(String(text ?? '').slice(0, MAX_SCAN_CHARS)).match(/[a-z0-9]+/g) || [];
}

const deny = (reason) => ({ ok: false, reason });
const allow = () => ({ ok: true, reason: 'ok' });

const FAIL = Symbol('falha');

/**
 * Chama uma dependência. Devolve FAIL se ela não existe, lança ou devolve uma
 * promessa (as dependências são SÍNCRONAS; uma promessa é sempre "verdadeira" e
 * liberaria a fala por engano, então conta como falha).
 */
function safeCall(fn, ...args) {
  if (typeof fn !== 'function') return FAIL;
  try {
    const r = fn(...args);
    if (r && typeof r.then === 'function') {
      try { r.then(null, () => {}); } catch { /* ignora */ }
      return FAIL;
    }
    return r;
  } catch {
    return FAIL;
  }
}

/** Permissão: só passa se a dependência respondeu "sim" (falha e ausência não passam). */
const yes = (v) => v !== FAIL && Boolean(v);
/** Restrição: vale se a dependência respondeu "sim" OU falhou (na dúvida, nega). */
const hit = (v) => v === FAIL || Boolean(v);

// ── Limites de uso ────────────────────────────────────────────────────

const MAX_TRACKED_KEYS = 5000;
const MAX_ENTRIES_PER_KEY = 1000;

/**
 * Relógio padrão do limitador: monotônico. Com `Date.now()`, atrasar o relógio do PC em X minutos deixava
 * as falas "no futuro" valendo por cerca de X e travava o limite sem ninguém ter abusado. Só a DURAÇÃO
 * importa aqui (o prazo do pedido, que usa a hora de parede, é conferido em decideSpeak).
 */
function monotonicNow() {
  return performance.now();
}

/**
 * Limitador por usuário, por servidor, global e por orçamento de segundos falados.
 * `check` só consulta; quem fala de verdade chama `recordSpeech` (assim um pedido
 * negado ou descartado não gasta cota). Entradas velhas são descartadas aos poucos
 * e os mapas têm teto, para a memória não crescer sem limite.
 */
export function createLimiter({ config, now = monotonicNow } = {}) {
  const cfg = config || getTtsConfig();
  const users = new Map(); // "guild:user" -> { last, times: number[] }
  const guilds = new Map(); // guild -> { times: number[], spent: { t, s }[] }
  let globalTimes = [];
  let lastSweep = 0;

  const recent = (arr, t, windowMs) => {
    // Remove do início o que já saiu da janela (o array está em ordem de tempo).
    let i = 0;
    while (i < arr.length && t - arr[i] >= windowMs) i++;
    return i ? arr.slice(i) : arr;
  };
  const recentSpent = (arr, t) => {
    let i = 0;
    while (i < arr.length && t - arr[i].t >= BUDGET_WINDOW_MS) i++;
    return i ? arr.slice(i) : arr;
  };
  const cap = (arr) => (arr.length > MAX_ENTRIES_PER_KEY ? arr.slice(arr.length - MAX_ENTRIES_PER_KEY) : arr);

  function sweep(t) {
    if (t - lastSweep < MINUTE_MS && users.size <= MAX_TRACKED_KEYS && guilds.size <= MAX_TRACKED_KEYS) return;
    lastSweep = t;
    for (const [k, u] of users) {
      u.times = recent(u.times, t, MINUTE_MS);
      if (!u.times.length && t - u.last >= MINUTE_MS) users.delete(k);
    }
    for (const [k, g] of guilds) {
      g.times = recent(g.times, t, MINUTE_MS);
      g.spent = recentSpent(g.spent, t);
      if (!g.times.length && !g.spent.length) guilds.delete(k);
    }
    globalTimes = recent(globalTimes, t, MINUTE_MS);
    // Último recurso: se ainda passar do teto, descarta os mais antigos (ordem de inserção).
    for (const map of [users, guilds]) {
      while (map.size > MAX_TRACKED_KEYS) map.delete(map.keys().next().value);
    }
  }

  return {
    check(guildId, userId) {
      try {
        const t = now();
        sweep(t);
        const u = users.get(`${guildId}:${userId}`);
        if (u) {
          const dt = t - u.last;
          if (cfg.userGapSeconds > 0 && dt >= 0 && dt < cfg.userGapSeconds * 1000) return deny('rate-user-gap');
          if (recent(u.times, t, MINUTE_MS).length >= cfg.userPerMin) return deny('rate-user');
        }
        const g = guilds.get(String(guildId));
        if (g) {
          if (recent(g.times, t, MINUTE_MS).length >= cfg.guildPerMin) return deny('rate-guild');
        }
        if (recent(globalTimes, t, MINUTE_MS).length >= cfg.globalPerMin) return deny('rate-global');
        if (g) {
          const spent = recentSpent(g.spent, t).reduce((sum, e) => sum + e.s, 0);
          if (spent >= cfg.guildSecondsPer10Min) return deny('rate-budget');
        }
        return allow();
      } catch {
        return deny('error');
      }
    },

    /** Registra uma fala que de fato aconteceu (ou que vai acontecer). */
    recordSpeech(guildId, userId, seconds = 0) {
      try {
        const t = now();
        const s = Number.isFinite(Number(seconds)) ? Math.min(600, Math.max(0, Number(seconds))) : 0;
        const uKey = `${guildId}:${userId}`;
        const u = users.get(uKey) || { last: t, times: [] };
        u.times = cap([...recent(u.times, t, MINUTE_MS), t]);
        u.last = t;
        users.set(uKey, u);

        const gKey = String(guildId);
        const g = guilds.get(gKey) || { times: [], spent: [] };
        g.times = cap([...recent(g.times, t, MINUTE_MS), t]);
        g.spent = cap([...recentSpent(g.spent, t), { t, s }]);
        guilds.set(gKey, g);

        globalTimes = cap([...recent(globalTimes, t, MINUTE_MS), t]);
        sweep(t);
      } catch { /* o limitador nunca derruba a fala */ }
    },

    reset() {
      users.clear();
      guilds.clear();
      globalTimes = [];
      lastSweep = 0;
    },

    /** Só para diagnóstico e testes: quantas chaves estão sendo acompanhadas. */
    size() {
      return { users: users.size, guilds: guilds.size, global: globalTimes.length };
    },
  };
}

// ── Portões de contexto ───────────────────────────────────────────────

/**
 * Decide se esta resposta pode ser falada AGORA, olhando só o contexto.
 * Ordem dos portões (a primeira razão que falhar é a devolvida):
 * tts-off, not-voice, guild-disabled, no-connection, bot-user, banned, user-not-in-call,
 * radio-active, sensitive, stale, rate-user-gap, rate-user, rate-guild, rate-global,
 * rate-budget, no-speak-permission. ("queue-full" é decidido pelo output, não aqui.)
 *
 * @param {object} req   { guildId, userId, text, sensitive, requestedAt, fromVoice }
 * @param {object} deps  funções SÍNCRONAS (ver contrato); falha, ausência ou promessa = nega
 * @param {object} state { limiter, now, cfg }
 * @returns {{ ok: boolean, reason: string }}
 */
export function decideSpeak(req, deps, state) {
  try {
    if (!req || typeof req !== 'object') return deny('bad-request');
    const d = deps && typeof deps === 'object' ? deps : {};
    const st = state && typeof state === 'object' ? state : {};
    const cfg = st.cfg || getTtsConfig();
    const t = typeof st.now === 'function' ? st.now() : Date.now();

    // 1. Chave mestra, módulo com provedor e codificador Opus.
    if (cfg.enabled !== true || st.hasProviders === false) return deny('tts-off');
    if (!yes(safeCall(d.isOpusAvailable))) return deny('tts-off');

    // 2. Só resposta a pedido feito por VOZ (o voiceHandler é quem marca).
    if (req.fromVoice !== true) return deny('not-voice');

    const guildId = req.guildId == null ? '' : String(req.guildId);
    const userId = req.userId == null ? '' : String(req.userId);
    if (!guildId || !userId) return deny('bad-request');

    // 3. Interruptor do servidor (reavaliado antes de cada frase pelo chamador).
    if (!yes(safeCall(d.isEnabled, guildId))) return deny('guild-disabled');

    // 4. Conexão de voz pronta com a call de IA registrada.
    if (!yes(safeCall(d.isAiCallActive, guildId))) return deny('no-connection');

    // 5. Solicitante: humano (desconhecido conta como bot), não banido, na mesma call.
    //    Só `false` EXATO prova que é humano: `undefined`/`null` (membro desconhecido, ex.:
    //    `members.get(id)?.user.bot`) não libera a fala.
    if (safeCall(d.isBot, userId, guildId) !== false) return deny('bot-user');
    if (hit(safeCall(d.isBanned, userId, guildId))) return deny('banned');
    if (!yes(safeCall(d.isUserInSameVoice, guildId, userId))) return deny('user-not-in-call');

    // 6. Rádio ativo: a v1 nunca fala por cima da música.
    if (hit(safeCall(d.isRadioActive, guildId))) return deny('radio-active');

    // 7. A call é pública: conteúdo pessoal nunca é falado. Qualquer coisa que não
    //    seja exatamente `false` conta como sensível (falha fechada).
    if (req.sensitive !== false) return deny('sensitive');

    // 8. Prazo: pedido velho (ou com data inválida/no futuro) não é falado.
    const requestedAt = Number(req.requestedAt);
    if (!Number.isFinite(requestedAt)) return deny('stale');
    const age = t - requestedAt;
    if (age > cfg.staleSeconds * 1000 || age < -5000) return deny('stale');

    // 9. Limites de uso.
    if (!st.limiter || typeof st.limiter.check !== 'function') return deny('error');
    const lim = st.limiter.check(guildId, userId);
    if (!lim || lim.ok !== true) return deny(lim && typeof lim.reason === 'string' ? lim.reason : 'error');

    // 10. A Yui precisa poder falar naquele canal (Falar, sem silêncio do servidor).
    if (!yes(safeCall(d.canSpeakInChannel, guildId))) return deny('no-speak-permission');

    return allow();
  } catch {
    return deny('error');
  }
}

// ── Palavras bloqueadas ───────────────────────────────────────────────

const LEET = { 0: 'o', 3: 'e', 4: 'a', 5: 's', 7: 't', 8: 'b', 9: 'g', '@': 'a', $: 's', '!': 'i', '|': 'i' };
const SYMS = new Set(['@', '$', '!', '|']);
const TOKEN_RE = /[a-z0-9@$!|]+/g;

/** Letras repetidas viram uma só ("porrrra" -> "pora"); vale dos dois lados da comparação. */
const collapse = (s) => s.replace(/([a-z])\1+/g, '$1');

function cleanToken(raw, oneAs) {
  // Tira símbolos das pontas à mão (regex com "+$" seria quadrática em cadeias longas).
  let a = 0;
  let b = raw.length;
  while (a < b && SYMS.has(raw[a])) a++;
  while (b > a && SYMS.has(raw[b - 1])) b--;
  let t = raw.slice(a, b);
  if (!t) return '';
  if (/[a-z]/.test(t)) {
    // "Leet" só dentro de palavras; número puro (ex.: 1488) não é mexido.
    t = t.replace(/[0134578@$!|9]/g, (c) => (c === '1' ? oneAs : LEET[c]));
  } else {
    t = t.replace(/[@$!|]/g, '');
  }
  return collapse(t);
}

function makeVariant(rawTokens, oneAs) {
  const tokens = [];
  for (const r of rawTokens) {
    const t = cleanToken(r, oneAs);
    if (t) tokens.push(t);
  }
  // Letras soltas em sequência ("p . u . t . a") viram uma "corrida" para casar por trecho.
  const runs = [];
  let cur = [];
  const flush = () => {
    if (cur.length >= 3) runs.push(collapse(cur.join('').slice(0, 64)));
    cur = [];
  };
  for (const t of tokens) {
    if (/^[a-z]$/.test(t)) cur.push(t);
    else flush();
  }
  flush();
  // Texto "colado" (sem espaços, letras repetidas fundidas) e onde cada palavra começa nele:
  // assim "pu ta" casa com "puta", mas "disputaria" NÃO casa com "putaria" (o trecho
  // achado precisa começar no começo de uma palavra).
  let squashed = '';
  let last = '';
  const starts = new Set();
  for (const t of tokens) {
    starts.add(squashed.length);
    for (const ch of t) {
      if (ch === last && ch >= 'a' && ch <= 'z') continue;
      squashed += ch;
      last = ch;
    }
  }
  return {
    tokens,
    set: new Set(tokens),
    spaced: ` ${tokens.join(' ')} `,
    squashed,
    starts,
    runs,
  };
}

/** Uma variante por leitura possível do dígito 1 (i ou l). */
function buildVariants(text) {
  const base = foldText(String(text ?? '').slice(0, MAX_SCAN_CHARS));
  const raw = base.match(TOKEN_RE) || [];
  const variants = [makeVariant(raw, 'i')];
  if (raw.some((t) => t.includes('1') && /[a-z]/.test(t))) variants.push(makeVariant(raw, 'l'));
  return variants;
}

function compileList(entries) {
  const words = new Set(); // uma palavra: casa como palavra inteira
  const phrases = new Set(); // várias palavras: casa como sequência de palavras
  const longSquashed = new Set(); // colados, para evasão por espaçamento ("pu ta")
  const runSquashed = new Set(); // para corridas de letras soltas
  for (const entry of entries) {
    if (typeof entry !== 'string' || !entry.trim()) continue;
    const { tokens, squashed } = buildVariants(entry)[0];
    if (!tokens.length || squashed.length < 2) continue;
    if (/^\d+$/.test(squashed) && squashed.length < 3) continue; // evita "18" bloquear tudo
    if (tokens.length === 1) words.add(tokens[0]);
    else phrases.add(tokens.join(' '));
    // Colar palavras curtas dá falso positivo ("esse mata" ~ "se mata"): frases só colam com 9+ letras.
    const minSquash = tokens.length === 1 ? 6 : 9;
    if (squashed.length >= minSquash) longSquashed.add(squashed);
    if (squashed.length >= 3) runSquashed.add(squashed);
  }
  return { words, phrases, longSquashed, runSquashed };
}

function variantMatches(v, list) {
  for (const w of list.words) if (v.set.has(w)) return true;
  for (const p of list.phrases) if (v.spaced.includes(` ${p} `)) return true;
  for (const s of list.longSquashed) {
    let from = 0;
    for (let i = v.squashed.indexOf(s, from); i !== -1; i = v.squashed.indexOf(s, from)) {
      if (v.starts.has(i)) return true;
      from = i + 1;
    }
  }
  for (const run of v.runs) for (const s of list.runSquashed) if (run.includes(s)) return true;
  return false;
}

const FALLBACK_BLOCKLIST = ['porra', 'caralho', 'buceta', 'puta', 'fdp', 'filho da puta'];

let cachedBlocklist = null;
const extraCache = new WeakMap();

/** Lê blocklist.pt-BR.json uma vez (cache). Arquivo ausente ou inválido: lista mínima embutida. */
export function loadBlocklist() {
  if (cachedBlocklist) return cachedBlocklist;
  let entries = FALLBACK_BLOCKLIST;
  try {
    const raw = fs.readFileSync(fileURLToPath(new URL('./blocklist.pt-BR.json', import.meta.url)), 'utf8');
    const j = JSON.parse(raw);
    const list = [...(Array.isArray(j.palavras) ? j.palavras : []), ...(Array.isArray(j.frases) ? j.frases : [])];
    if (list.length) entries = list;
  } catch { /* usa a reserva */ }
  cachedBlocklist = compileList(entries);
  return cachedBlocklist;
}

/** Só para testes: descarta o cache da lista. */
export function resetBlocklistCache() {
  cachedBlocklist = null;
}

/**
 * Só para testes: usa esta lista no lugar do arquivo (null volta a ler o arquivo). Assim os testes não
 * quebram quando o dono edita blocklist.pt-BR.json, que é justamente para ser editado.
 */
export function setBlocklistForTests(entries) {
  cachedBlocklist = Array.isArray(entries) ? compileList(entries) : null;
}

/**
 * true se o texto tem palavra/frase da lista de bloqueio, mesmo disfarçada (acento,
 * leet, letras repetidas ou separadas, caracteres invisíveis).
 * @param {string} text
 * @param {{ extra?: string[] }} [opts] termos adicionais (ex.: lista do banHandler)
 */
export function isBlockedSpeech(text, opts) {
  if (typeof text !== 'string' || !text) return false;
  const extra = opts && typeof opts === 'object' ? opts.extra : undefined;
  const variants = buildVariants(text);
  const own = loadBlocklist();
  let extraList = null;
  if (Array.isArray(extra) && extra.length) {
    extraList = extraCache.get(extra);
    if (!extraList) {
      extraList = compileList(extra);
      extraCache.set(extra, extraList);
    }
  }
  return variants.some((v) => variantMatches(v, own) || (extraList !== null && variantMatches(v, extraList)));
}

/** Texto "achatado" (sem acento, leet desfeito) para passar a detectores externos. */
function foldedForExternal(text) {
  return buildVariants(text)[0].tokens.join(' ');
}

// ── Dados pessoais ────────────────────────────────────────────────────

const DISCORD_TOKEN_RE = /<(?:@[!&]?|#|a?:\w{1,32}:|t:)\d{1,25}(?::[a-zA-Z])?>/g;
const URL_RE = /(?:https?:\/\/|www\.)\S{1,2000}/gi;
const EMAIL_RE = /[\w.%+-]{1,64}\s{0,2}@\s{0,2}[\w-]{1,63}(?:\.[\w-]{2,63}){1,5}/;
// "joao@gmail" sem o ".com": o provedor conhecido logo depois do @ já basta para ser e-mail.
const EMAIL_PROVIDER_RE = /[\w.%+-]{1,64}\s{0,2}@\s{0,2}(?:gmail|hotmail|outlook|yahoo|icloud|uol|bol|proton|protonmail|live|msn)\b/i;
const CNPJ_RE = /(?<!\d)\d{2}[. ]?\d{3}[. ]?\d{3}[/ ]?\d{4}[- ]?\d{2}(?!\d)/;
const CPF_RE = /(?<!\d)\d{3}[. ]?\d{3}[. ]?\d{3}[- ]?\d{2}(?!\d)/;
const PHONE_DDD_RE = /(?<!\d)(?:\+?55[ .-]?)?\(?\d{2}\)?[ .-]?9?\d{4}[ .-]?\d{4}(?!\d)/;
// Sem DDD: 9xxxx-xxxx (celular) e xxxx-xxxx / xxxx xxxx (fixo ou celular antigo); par de anos ("2019-2020") não conta.
const PHONE_LOCAL_RE = /(?<!\d)(?:9\d{4}[ -]\d{4}|(?!(?:19|20)\d{2}[ -](?:19|20)\d{2})[2-9]\d{3}[ -]\d{4})(?!\d)/;
const IPV4_OCTET = '(?:25[0-5]|2[0-4]\\d|1\\d\\d|[1-9]?\\d)';
const IPV4_RE = new RegExp(`(?<![\\d.])(?:${IPV4_OCTET}\\.){3}${IPV4_OCTET}(?![\\d])`);
const CARD_RE = /(?<!\d)\d{4}[ -]\d{4}[ -]\d{4}[ -]\d{1,7}(?!\d)/;
// Endereço e documento: CEP (01310-100) e RG (12.345.678-9). Só com a pontuação, para não pegar número solto.
const CEP_RE = /(?<![\d-])\d{5}-\d{3}(?![\d-])/;
const RG_RE = /(?<![\d.])\d{1,2}\.\d{3}\.\d{3}-[\dxX](?!\d)/;
// "sua senha é Hunter2", "PIN: 4821", "cvv = 123": rótulo de segredo seguido de um valor que tem dígito.
const SECRET_LABEL_RE = /\b(?:senha|password|passcode|pin|cvv|cvc)\b[^.\n]{0,25}?(?:\s(?:é|eh|is)\s|\s?[:=]\s?)\S*\d/i;
const DIGITS_RE = /\d{9,}/;
const TOKEN_LONG_RE = /[A-Za-z0-9_-]{24,}/g;
// Prefixos de chave conhecidos (OpenAI/Stripe, GitHub, Slack, AWS, Google, GitLab): valem mesmo sem dígito.
const KNOWN_KEY_RE = /\b(?:(?:sk|pk|rk)[-_][A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{16,}|xox[abprs]-[A-Za-z0-9-]{10,}|AKIA[0-9A-Z]{12,}|AIza[0-9A-Za-z_-]{20,}|glpat-[A-Za-z0-9_-]{16,})/;
const SPOKEN_EMAIL_RE = /\barroba\b[\s\S]{0,40}?\b(?:ponto|dot|com|gmail|hotmail|outlook|yahoo|icloud|uol|bol|proton|live|msn)\b/;
// Ofuscado: "joao [at] gmail [dot] com" e "joao em gmail ponto com".
const OBFUSCATED_EMAIL_RE = /\bat\b[\s\S]{0,40}?\b(?:dot|ponto)\b|\b(?:gmail|hotmail|outlook|yahoo|icloud|uol|proton|live|msn)\s+(?:ponto|dot)\s+com\b/;

const NUMERAL_WORDS = new Set([
  'zero', 'um', 'uma', 'dois', 'duas', 'tres', 'quatro', 'cinco', 'seis', 'meia', 'sete', 'oito', 'nove',
  'dez', 'onze', 'doze', 'treze', 'catorze', 'quatorze', 'quinze', 'dezesseis', 'dezasseis', 'dezessete',
  'dezassete', 'dezoito', 'dezenove', 'dezanove', 'vinte', 'trinta', 'quarenta', 'cinquenta', 'sessenta',
  'setenta', 'oitenta', 'noventa', 'cem', 'cento', 'duzentos', 'duzentas', 'trezentos', 'trezentas',
  'quatrocentos', 'quatrocentas', 'quinhentos', 'quinhentas', 'seiscentos', 'seiscentas', 'setecentos',
  'setecentas', 'oitocentos', 'oitocentas', 'novecentos', 'novecentas',
]);
// "mil", "milhão"... só dão a ordem de grandeza: não contam como dígito, mas também não quebram a sequência.
const SCALE_WORDS = new Set(['mil', 'milhao', 'milhoes', 'bilhao', 'bilhoes', 'trilhao', 'trilhoes']);

/**
 * Uma sequência de 24+ caracteres é segredo? "hahaha..." e palavra comprida não; chave tem
 * dígito ou, se for só letras, muitas trocas minúscula->maiúscula (nome em camelCase tem poucas).
 */
function looksLikeSecret(s) {
  if (new Set(s).size < 6) return false;
  if (/\d/.test(s)) return true;
  if (/^[a-z-]+$/.test(s)) return false;
  let jumps = 0;
  for (let i = 1; i < s.length; i++) {
    if (s[i] >= 'A' && s[i] <= 'Z' && s[i - 1] >= 'a' && s[i - 1] <= 'z') jumps++;
  }
  return jumps >= 6;
}

/**
 * Sequência de numerais falados ("cinco cinco um um...") ou dígitos soltos de um em um:
 * 9 ou mais seguidos é número de telefone/documento ditado (um número escrito por extenso
 * gasta no máximo 3 palavras por grupo de 3 dígitos, então 9 palavras equivalem a 9+ dígitos).
 * "e", "mil"/"milhão" e "ponto" entre eles não contam nem quebram a sequência; 3 "ponto"
 * entre numerais lembram um IP ditado.
 */
function hasNumeralRun(folded) {
  const toks = folded.match(/[a-z]+|\d+/g) || [];
  let run = 0;
  let pontos = 0;
  let dashAt = -1; // tamanho da sequência quando um "traço" apareceu no meio dela
  for (const tok of toks) {
    const isDigit = tok.charCodeAt(0) <= 57;
    if (isDigit ? tok.length === 1 : NUMERAL_WORDS.has(tok)) {
      run += 1;
      if (run >= 9) return true;
      // Telefone sem DDD ditado: "nove nove nove nove traço oito oito oito oito" (4 + 4).
      if (dashAt >= 0 && run - dashAt >= 3 && run >= 7) return true;
    } else if (run > 0 && (tok === 'e' || SCALE_WORDS.has(tok))) {
      // conector ou escala: não conta nem quebra
    } else if (run >= 3 && (tok === 'traco' || tok === 'hifen')) {
      dashAt = run; // o traço também não quebra a sequência
    } else if (run > 0 && tok === 'ponto') {
      pontos += 1;
      if (pontos >= 3) return true;
    } else {
      run = 0;
      pontos = 0;
      dashAt = -1;
    }
  }
  return false;
}

/**
 * Procura dado pessoal. Devolve o TIPO achado ('email', 'phone', 'cpf', 'cnpj', 'ip',
 * 'card', 'cep', 'rg', 'secret', 'token', 'digits', 'numerals') ou null. Menções/emoji do Discord e URLs são
 * ignorados (IDs e links nunca são lidos em voz alta; o texto final já vem sem eles).
 */
export function findPii(text) {
  if (typeof text !== 'string' || !text) return null;
  const base = squeezeMarks(text.slice(0, MAX_SCAN_CHARS)).normalize('NFKC').replace(ZERO_WIDTH, '').replace(DISCORD_TOKEN_RE, ' ');
  if (EMAIL_RE.test(base) || EMAIL_PROVIDER_RE.test(base)) return 'email';
  const m = base.replace(URL_RE, ' ');
  if (CNPJ_RE.test(m)) return 'cnpj';
  if (CPF_RE.test(m)) return 'cpf';
  if (PHONE_DDD_RE.test(m) || PHONE_LOCAL_RE.test(m)) return 'phone';
  if (IPV4_RE.test(m)) return 'ip';
  if (CARD_RE.test(m)) return 'card';
  if (CEP_RE.test(m)) return 'cep';
  if (RG_RE.test(m)) return 'rg';
  if (SECRET_LABEL_RE.test(m)) return 'secret';
  if (DIGITS_RE.test(m)) return 'digits';
  if (KNOWN_KEY_RE.test(m)) return 'token';
  for (const hit of m.matchAll(TOKEN_LONG_RE)) {
    if (looksLikeSecret(hit[0])) return 'token';
  }
  const folded = foldText(m);
  if (SPOKEN_EMAIL_RE.test(folded) || OBFUSCATED_EMAIL_RE.test(folded)) return 'email';
  if (hasNumeralRun(folded)) return 'numerals';
  return null;
}

/** true se o texto parece conter dado pessoal (e-mail, telefone, CPF, CNPJ, IP, token, número longo). */
export function hasPii(text) {
  return findPii(text) !== null;
}

// ── Texto de sistema / erro ───────────────────────────────────────────

const SYSTEM_LEADERS = ['⚠', '❌', '⏳', '⚡', '🛑', '🚨', '🚫', '⛔', '❗', '⌛'];
const SYSTEM_PHRASES = [
  'limites de processamento atingidos',
  'sua solicitacao esta na fila',
  'processando sua solicitacao',
];
// Cabeçalho de bloco do prompt vazado: "[MODO VOZ]", "[REGRAS DE FERRAMENTAS (TOOLS)]", "[ANTI-LOOP DE CONTEXTO]".
// Maiúsculas e com mais de uma palavra (ou parênteses/hífen): "[SPOILER]" e "[NSFW]" não casam.
const SYSTEM_HEADER_RE = /\[\p{Lu}[\p{Lu}\p{N}]*[ (-][\p{Lu}\p{N} ()_/.:-]{3,60}\]/u;
const SYSTEM_START_RE = /^(?:ocorreu um erro|houve um erro|erro(?::| - )|falha ao |nao consegui (?:processar|completar))/;

/** true para mensagens de erro, fila ou aviso do sistema (não são "resposta da Yui"). */
export function isSystemText(text) {
  if (typeof text !== 'string') return false;
  const head = text.slice(0, 400).replace(/\uFE0F/g, '');
  let i = 0;
  // Pula espaços e marcações de Markdown no começo ("**⚠️", "> ❌", "-# ...").
  while (i < head.length && /[\s*_~>#-]/.test(head[i])) i++;
  const lead = head.slice(i, i + 4);
  if (SYSTEM_LEADERS.some((e) => lead.startsWith(e))) return true;
  if (SYSTEM_HEADER_RE.test(text.slice(0, 2000))) return true;
  const folded = foldText(text.slice(0, 2000));
  if (SYSTEM_PHRASES.some((p) => folded.includes(p))) return true;
  return SYSTEM_START_RE.test(folded.trimStart());
}

// ── Ferramentas, eco, papagaio, parada, gatilho ───────────────────────

const TOOL_KEYS = ['tool', 'tool_name', 'toolname', 'tool_calls', 'tool_call', 'function_call', 'action', 'tool_input'];
const ARG_KEYS = ['args', 'arguments', 'parameters', 'params', 'input', 'action_input'];

function objectLooksLikeToolCall(o) {
  if (!o || typeof o !== 'object') return false;
  if (Array.isArray(o)) return o.slice(0, 20).some(objectLooksLikeToolCall);
  const keys = Object.keys(o).map((k) => k.toLowerCase());
  if (keys.some((k) => TOOL_KEYS.includes(k) && k !== 'action')) return true;
  const hasName = keys.includes('name') || keys.includes('function') || keys.includes('action');
  return hasName && keys.some((k) => ARG_KEYS.includes(k));
}

/**
 * true se o texto é (ou contém) uma chamada de ferramenta em vez de uma resposta:
 * JSON {"tool":...}, `default_api.nome(...)`, "[Tool Use: ...]". Isso NUNCA deve ser falado.
 */
export function looksLikeToolJson(text) {
  if (typeof text !== 'string' || !text) return false;
  const t = squeezeMarks(text.slice(0, MAX_SCAN_CHARS)).normalize('NFKC').replace(ZERO_WIDTH, '');
  if (/\bdefault_api\s*\.\s*\w+\s*\(/i.test(t)) return true;
  if (/\[\s*tool[\s_-]*(?:use|call)\s*:/i.test(t)) return true;
  // Espaços limitados ({0,20}): com `\s*` solto, "<" + 20 mil espaços custava centenas de ms.
  if (/<\s{0,20}\/?\s{0,20}(?:tool_call|tool_use|function_call)\b/i.test(t)) return true;
  // Marcadores que o llmHandler também reconhece como chamada de ferramenta (<ctrl42>call:..., tool_code).
  if (/<ctrl\d{1,4}>|\btool_code\b/i.test(t)) return true;
  // Chave de ferramenta entre aspas duplas OU simples ("tool": ..., 'action_input': ...).
  if (/["'](?:tool|tool_name|tool_calls?|function_call|action_input|tool_input)["']\s*:/i.test(t)) return true;
  // Chave sem aspas no começo de linha ou depois de "{" (YAML e objeto JS: `tool: x`, `{ tool: "x" }`).
  if (/(?:^|[\n{])[ \t]*(?:tool|tool_name|action_input|tool_input)[ \t]*:[ \t]*\S/i.test(t)) return true;
  if (/["'](?:args|arguments|parameters)["']\s*:\s*[{[]/i.test(t) && /["'](?:name|tool|function)["']\s*:/i.test(t)) return true;
  // O texto INTEIRO é uma chamada `nome_da_funcao(chave=...)`, com ou sem `print(`/`default_api.` (snake_case:
  // palavra comum seguida de parênteses, como "Beleza (haha)", não conta).
  // (já sem espaços nas pontas: `\)\)?$` não tem ambiguidade e a regex continua linear.)
  const trimmed = t.trim();
  if (/^(?:print\s*\(\s*)?[a-z][a-z0-9]*(?:_[a-z0-9]+)+\s*\((?:\s*[a-z_][a-z0-9_]*\s*=[\s\S]{0,4000}|\s{0,20})\)\)?$/i.test(trimmed)) return true;
  // (a cerca final é cortada à mão: `/\s*```$/` é quadrática em texto com um trecho longo de espaços)
  let s = trimmed.replace(/^```(?:json)?\s*/i, '');
  if (s.endsWith('```')) s = s.slice(0, -3).trimEnd();
  if ((s.startsWith('{') && s.endsWith('}')) || (s.startsWith('[') && s.endsWith(']'))) {
    try {
      return objectLooksLikeToolCall(JSON.parse(s));
    } catch { /* não é JSON válido */ }
  }
  return false;
}

/**
 * true se o texto é JSON / dado estruturado (objeto, lista, ou pares "chave": valor) em vez de uma frase. Um modelo que devolve o
 * JSON de uma resposta (`{"response": "..."`, `{"foo":"bar"}`, `["a","b"]`), inclusive truncado, não pode ter isso lido em voz alta
 * ("response dois-pontos Oi..."). O JSON de FERRAMENTA já é barrado à parte (looksLikeToolJson); este cobre o genérico.
 * Frase normal com chaves ("O conjunto {um, dois} é finito.") ou colchetes ("[Risos]") não casa: só vale o começo do texto e
 * pares com aspas na chave.
 */
export function looksLikeStructuredText(text) {
  if (typeof text !== 'string' || !text) return false;
  const head = text.slice(0, MAX_SCAN_CHARS);
  const t = head.trimStart().replace(/^```[a-z]*\s{0,20}/i, '');
  if (t.startsWith('{')) return true;
  if (/^\[\s{0,20}[{"'[\]]/.test(t)) return true;
  // Pares "chave": valor em qualquer ponto (sem \s* solto na frente: linear).
  return /["'][A-Za-z_][\w -]{0,40}["']\s{0,5}:\s{0,5}(?:["'{[]|-?\d|true\b|false\b|null\b)/.test(head);
}

// Palavras "de ligação" e de pergunta: não contam como conteúdo ao medir o eco.
const ECHO_STOP = new Set((
  'a o as os um uma uns umas de da do das dos em no na nos nas por para pra pelo pela com sem sob sobre e ou mas ' +
  'que se ja nao sim eh ai la ca aqui ali isso isto aquilo esse essa esses essas este esta estes estas aquele aquela ' +
  'ele ela eles elas eu tu voce voces vc me te lhe meu minha seu sua nosso mais menos muito muita pouco bem mal so ' +
  'tambem entao assim como qual quais quem quando onde porque quanto quanta quantos quantas ser sou eram foi sao ' +
  'estou estao estava ter tem tinha tenho ha vai vou vao fazer faz pode podia posso poder deve diga fala fale falar ' +
  'repita repete dizer diz yui favor tipo coisa ne ok'
).split(' '));

/**
 * Anti-papagaio: true se a resposta repete a entrada (a Yui seria usada como
 * alto-falante). Dois critérios:
 *  - 5 ou mais palavras seguidas da transcrição aparecem na resposta; ou
 *  - transcrição com 6+ palavras e ao menos 4 palavras de conteúdo (sem "de/que/qual..."),
 *    40% ou mais delas reaparecem na resposta E a resposta é feita sobretudo delas
 *    (60% ou mais das suas palavras de conteúdo vêm da entrada). A segunda metade evita
 *    silenciar resposta normal que só cita o assunto ("ganhou a copa de 2022 ... Argentina").
 * Pergunta curta respondida com as mesmas palavras do tema ("capital da Austrália")
 * também não dispara: só se conta palavra de conteúdo e só em transcrição longa.
 */
export function echoesInput(transcript, response) {
  if (typeof transcript !== 'string' || typeof response !== 'string') return false;
  const t = words(transcript).slice(0, 400);
  const r = words(response).slice(0, 400);
  if (t.length < 5 || r.length < 3) return false;

  if (r.length >= 5) {
    const grams = new Set();
    for (let i = 0; i + 5 <= t.length; i++) grams.add(t.slice(i, i + 5).join(' '));
    for (let j = 0; j + 5 <= r.length; j++) if (grams.has(r.slice(j, j + 5).join(' '))) return true;
  }

  if (t.length >= 6) {
    const content = new Set(t.filter((w) => w.length >= 3 && !ECHO_STOP.has(w)));
    if (content.size >= 4) {
      const rs = new Set(r);
      let hit = 0;
      for (const w of content) if (rs.has(w)) hit++;
      const respContent = new Set(r.filter((w) => w.length >= 3 && !ECHO_STOP.has(w)));
      let fromInput = 0;
      for (const w of respContent) if (content.has(w)) fromInput++;
      if (hit / content.size >= 0.4 && respContent.size >= 3 && fromInput / respContent.size >= 0.6) return true;
    }
  }
  return false;
}

// Base do T1 3.8 item 3b: ^(repita|repete|fala|diga|diz)\b.{0,25}(depois de mim|exatamente|o seguinte),
// ampliada com outros verbos, "por favor/pode" na frente e "repita comigo". O trecho entre o
// verbo e a frase-chave é curto e limitado ({0,25}), então a regex é linear.
// "yui" (e "ei yui") na frente: a transcrição chega com a palavra de ativação.
const PARROT_LEAD = '^(?:(?:por favor|pode|poderia|voce pode|vc pode|agora|entao|ei|ola|oi|yui)[ ,]+)*';
const PARROT_VERBS = 'repita|repete|repetir|fala|fale|falar|diga|diz|dizer|leia|le|ler|escreva|soletre|grite|gritar|pronuncie|pronunciar|responda|responde|responder';
const PARROT_KEYS = 'depois de mim|exatamente|o seguinte|palavra por palavra|em voz alta|com a frase|literalmente|o que eu (?:disser|falar|digo|falo|escrever)';
const PARROT_RE = new RegExp(`${PARROT_LEAD}(?:${PARROT_VERBS})\\b.{0,25}?(?:${PARROT_KEYS})`);
// "diz que o Pedro é um idiota": mandar a Yui dizer uma afirmação inteira. "diga que horas são" e "diga que sim" não casam.
const PARROT_THAT_RE = new RegExp(`${PARROT_LEAD}(?:fala|fale|diga|diz|dizer|grite)\\s+que\\s+(?:o|a|os|as|eu|ele|ela|voce|vc|todos)\\b`);
// Gritar é sempre papagaio ("grite: AAA"); "pronuncie a frase abaixo" também ("pronuncie paralelepípedo" é pedido de pronúncia).
const PARROT_SHOUT_RE = new RegExp(`${PARROT_LEAD}(?:(?:grite|gritar)\\b|(?:pronuncie|pronunciar)\\b.{0,20}?(?:frase|abaixo|seguinte))`);
// "fale comigo" é conversa; só "repita comigo" é papagaio.
const PARROT_WITH_ME_RE = new RegExp(`${PARROT_LEAD}(?:repita|repete|repetir)\\s+comigo\\b`);

/**
 * "Repita depois de mim..." e variações: pedido para usar a Yui de papagaio. Regra
 * determinística (sem IA); o chamador responde um texto fixo e não chama a IA.
 */
export function isParrotRequest(text) {
  if (typeof text !== 'string' || !text) return false;
  const norm = foldText(text.slice(0, 300)).replace(/[^a-z0-9]+/g, ' ').trim();
  return PARROT_RE.test(norm) || PARROT_THAT_RE.test(norm) || PARROT_SHOUT_RE.test(norm) || PARROT_WITH_ME_RE.test(norm);
}

const STOP_RE = /^(?:yui\s+)?(para|pare|chega|cala|silencio)\b/;
// Depois de "para"/"chega" estas palavras mostram que NÃO é ordem ("para que serve", "chega mais perto").
const STOP_NOT_COMMAND = {
  para: new Set(['que', 'quem', 'onde', 'quando', 'qual', 'quais', 'quanto', 'quantos', 'quantas', 'mim', 'ti', 'si', 'nos',
    'cada', 'todo', 'todos', 'toda', 'todas', 'ele', 'ela', 'eles', 'elas', 'o', 'a', 'os', 'as', 'um', 'uma', 'ver', 'ser',
    'fazer', 'saber', 'entender', 'voce', 'voces', 'vc']),
  chega: new Set(['mais', 'perto', 'aqui', 'la', 'pra', 'para', 'cedo', 'tarde', 'ate', 'em', 'no', 'na']),
};

/**
 * Comando de parada por voz ("Yui, para", "chega", "silêncio", "cala a boca"). Roda
 * sobre o texto normalizado (minúsculas, sem acento, sem pontuação). Exige que o resto
 * da frase seja curto (até 6 palavras), para não confundir com pergunta.
 */
export function isStopCommand(text) {
  if (typeof text !== 'string' || !text) return false;
  const norm = foldText(text.slice(0, 300)).replace(/[^a-z0-9]+/g, ' ').trim();
  const m = STOP_RE.exec(norm);
  if (!m) return false;
  const tail = norm.slice(m[0].length).trim();
  const tailWords = tail ? tail.split(' ') : [];
  if (tailWords.length > 6) return false;
  const blocked = STOP_NOT_COMMAND[m[1]];
  return !(blocked && tailWords.length && blocked.has(tailWords[0]));
}

/**
 * A palavra de ativação está nas `n` primeiras palavras da transcrição? Para a resposta
 * ser FALADA ela precisa abrir a frase; se só aparece mais adiante, responde-se em texto.
 * `triggerRegex` pode ter flag g/y: aqui é copiada sem elas (lastIndex não vaza entre chamadas).
 */
export function wakeWordInFirstWords(transcript, triggerRegex, n = 3) {
  try {
    if (typeof transcript !== 'string' || !(triggerRegex instanceof RegExp)) return false;
    const count = Math.max(1, Math.floor(Number(n)) || 3);
    const head = transcript.slice(0, 300).trim().split(/\s+/).slice(0, count).join(' ').toLowerCase();
    if (!head) return false;
    const re = new RegExp(triggerRegex.source, triggerRegex.flags.replace(/[gy]/g, ''));
    return re.test(head);
  } catch {
    return false;
  }
}

// ── Portões de conteúdo ───────────────────────────────────────────────

// Letras que a voz pt-BR do SAPI lê: as do alfabeto básico e as do Latin-1 (á, ç, ã, õ, ü...), menos Ð Ø Þ ð ø þ.
// Medido: texto feito SÓ de japonês, cirílico, grego, árabe, símbolos IPA, dígrafos como "ǆ" ou de letras latinas
// raras (ā, š, ž, ł, ø, ...) volta como áudio VAZIO, e áudio vazio conta como falha do provedor (3 em 2 min abrem o
// disjuntor por 60 s para todos os servidores). Com ao menos uma letra legível o SAPI fala e pula o resto.
const READABLE_LETTER = /[A-Za-z\u00C0-\u00CF\u00D1-\u00D6\u00D9-\u00DD\u00DF-\u00EF\u00F1-\u00F6\u00F9-\u00FD\u00FF]/g;

/**
 * Pelo menos metade das letras do texto é lida pela voz? Texto sem letras também não é "legível".
 * Mistura ("Yui diz こんにちは mundo") passa: o SAPI pula o que não sabe e fala o resto.
 */
export function isReadableText(text) {
  if (typeof text !== 'string') return false;
  const letters = (text.match(/\p{L}/gu) || []).length;
  if (letters === 0) return false;
  const readable = (text.match(READABLE_LETTER) || []).length;
  return readable * 2 >= letters;
}

/**
 * Pode ESTE texto ser falado? Razões: not-speakable, system-text, pii, blocked-word,
 * self-trigger, tool-json, json-text, echo-of-input. Dependência ausente, que lança ou assíncrona
 * = nega (falha fechada). A lista de bloqueio só impede de falar; nada aqui bane.
 *
 * @param {string} text
 * @param {object} deps  { containsForbidden(text), matchesTrigger(text) } síncronas
 * @param {{ transcript?: string, requireReadable?: boolean }} [opts]
 *        requireReadable: só para o texto FINAL (já normalizado); nega se a maior parte das letras
 *        não é do alfabeto que a voz pt-BR lê.
 */
export function checkSpeakableText(rawText, deps, opts) {
  try {
    const transcript = opts && typeof opts === 'object' ? opts.transcript : undefined;
    const d = deps && typeof deps === 'object' ? deps : {};
    if (typeof rawText !== 'string' || rawText.length > MAX_SCAN_CHARS || !/[\p{L}\p{N}]/u.test(rawText)) {
      return deny('not-speakable');
    }
    // Tudo abaixo trabalha com o texto sem o excesso de marcas combinantes ("zalgo").
    const text = squeezeMarks(rawText);
    // Texto final: a voz precisa conseguir LER o que sobrou (sem isso o SAPI devolve áudio vazio).
    if (opts && typeof opts === 'object' && opts.requireReadable === true && !isReadableText(text)) {
      return deny('not-speakable');
    }
    if (isSystemText(text)) return deny('system-text');
    if (hasPii(text)) return deny('pii');

    if (isBlockedSpeech(text)) return deny('blocked-word');
    // A lista do banHandler olha o texto cru e o "achatado" (pega "p0rn", "p o r n").
    for (const probe of [text, foldedForExternal(text)]) {
      if (hit(safeCall(d.containsForbidden, probe))) return deny('blocked-word');
    }

    // Texto que acionaria a Yui de novo (eco do próprio áudio no microfone) não é falado.
    if (hit(safeCall(d.matchesTrigger, text))) return deny('self-trigger');

    if (looksLikeToolJson(text)) return deny('tool-json');
    if (looksLikeStructuredText(text)) return deny('json-text');

    if (typeof transcript === 'string' && transcript.trim() && echoesInput(transcript, text)) {
      return deny('echo-of-input');
    }
    return allow();
  } catch {
    return deny('error');
  }
}
