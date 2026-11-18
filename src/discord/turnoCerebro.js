// A conversa do Discord respondida pelo CÉREBRO (etapa 5, docs/ETAPA3_DONOS_E_CONTRATO.md §8). Lado do BOT.
// Só vale com YUI_CEREBRO_EXTERNO=true: o canalCerebro.js instala o canal aqui (setChatRemote). Sem a chave nada daqui é usado e o
// llmHandler segue exatamente como antes (isChatRemote() é false).
//
// O que o bot faz (só canal: manda FATOS, nunca decide escopo de memória nem de contexto):
//  - cada pedido da fila do llmHandler (menção, DM, conversa espontânea, voz; o rádio fica no bot) vira um TURNO, identificado pelo id da
//    mensagem do Discord. O turno corre dentro do AsyncLocalStorage do contexto (runWithContext), no lugar do alvo do contexto por horas;
//  - cada chamada à IA dentro do turno (a principal, a "resposta final" da pesquisa, os comentários das ferramentas, a síntese...) vira um
//    PASSO `chat.turn`, com a chave de idempotência `chat.turn:<id da mensagem>:<passo>`. O cérebro monta o prompt (persona, memória,
//    histórico, oferta das ferramentas) e devolve o texto; quando o modelo escolhe uma ferramenta, o texto é o JSON da ação e quem a executa é
//    o bot, como sempre (as ferramentas precisam do Discord);
//  - no fim do turno, o que aconteceu (a linha do histórico e a do contexto que o código do llmHandler já calcula) vai num `chat.commit`
//    (chave `chat.commit:<id da mensagem>`). O cérebro decide ONDE gravar (contexto por horas ou histórico em RAM) e grava UMA vez;
//  - cérebro fora: espera a volta por até YUI_CHAT_ESPERA_CEREBRO_MS (padrão 15 s, cobre um religamento) e repete o passo com a MESMA chave;
//    depois disso responde CEREBRO_UNAVAILABLE_TEXT na hora, sem prender a fila (enquanto o cérebro continuar fora, os pedidos seguintes nem
//    esperam). O commit que não saiu fica guardado em RAM (no máximo 50, por 10 min) e sai na reconexão, antes do próximo passo.
//
// Etapa 6 (a pesquisa no cérebro): o turno também PESQUISA pelo cérebro (`research`: o research.turn, chave `research.turn:<id>:<n>`) e o
// /yui inteiro vai num pedido só (`yui`: o chat.yui, chave `chat.yui:<id>`). O progresso da pesquisa volta como evento research.progress
// com a chave do pedido e vai SÓ para a função de progresso daquele pedido (a mensagem "Processando..." daquele turno); evento com chave
// desconhecida (de um pedido que já terminou ou de outro processo) é ignorado. A repetição depois de uma queda usa a MESMA chave: o cache
// do canal no cérebro devolve o resultado da busca que já está rodando, sem buscar de novo.
// Etapa 7 (os comentários fora da fila): o comentário do /steam_jogo e do /converter_moeda vai ao cérebro num pedido próprio (chat.comentario,
// chave `chat.comentario:<id da interação>`), FORA da fila e fora de qualquer turno: pedirComentario.
// O log nunca recebe o texto da conversa: só o método, o passo e códigos.
import crypto from 'node:crypto';
import { logger as defaultLogger } from '../utils/logger.js';

export const CEREBRO_UNAVAILABLE = 'CEREBRO_INDISPONIVEL';
export const CEREBRO_UNAVAILABLE_TEXT = '⚠️ A Yui está indisponível agora: o cérebro dela não respondeu. Tenta de novo daqui a pouco.';

/** Códigos do canal que significam "o cérebro não está lá" (e não um erro do pedido em si). */
const UNAVAILABLE_CODES = new Set(['NOT_CONNECTED', 'CONNECTION_LOST', 'TIMEOUT', 'CLOSED', 'SECRET_UNAVAILABLE', 'BUSY']);
/** Caiu no meio: vale esperar a reconexão e repetir o MESMO passo (mesma chave). */
const RETRY_CODES = new Set(['NOT_CONNECTED', 'CONNECTION_LOST']);
const MAX_PENDING_COMMITS = 50;
const PENDING_TTL_MS = 10 * 60_000;
const TURN_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;

let channel = null;
let logger = defaultLogger;
let unavailableSince = null;
let stopState = null;
let stopProgress = null;
const pendingCommits = [];
let flushing = null;
/** Progresso da pesquisa: chave do pedido -> função de progresso do turno que fez o pedido (e de nenhum outro). */
const progressRoutes = new Map();
const counters = { turns: 0, steps: 0, commits: 0, pendingSent: 0, pendingDropped: 0, unavailable: 0, retries: 0, researches: 0, yui: 0, progress: 0, progressIgnored: 0, comentarios: 0, comentariosSemCerebro: 0, comentariosRepetidos: 0 };
const PROGRESS_LINE_MAX = 200;

function envMs(name, fallback, min, max, env = process.env) {
  const raw = String(env[name] ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) ? Math.min(max, Math.max(min, Math.round(n))) : fallback;
}
/** Quanto o turno espera o cérebro voltar (religamento) antes de responder "indisponível". */
export const cerebroWaitMs = (env = process.env) => envMs('YUI_CHAT_ESPERA_CEREBRO_MS', 15_000, 0, 120_000, env);
/** Prazo de um passo (a IA pode demorar: troca de provedor, continuação). O cérebro usa o mesmo prazo no handler. */
export const chatTurnTimeoutMs = (env = process.env) => envMs('YUI_CHAT_TURN_TIMEOUT_MS', 300_000, 1_000, 900_000, env);
/** Prazo total da pesquisa (YUI_RESEARCH_DEADLINE_MS: 60 s, de 20 a 180 s). O pedido espera isto + folga (o cérebro corta antes). */
const researchDeadlineMs = (env = process.env) => envMs('YUI_RESEARCH_DEADLINE_MS', 60_000, 20_000, 180_000, env);
/** O que o bot espera pelo research.turn e pelo chat.yui (um pouco mais que o prazo do handler no cérebro: o cérebro responde antes). */
export const researchRequestTimeoutMs = (env = process.env) => researchDeadlineMs(env) + 20_000;
export const yuiRequestTimeoutMs = (env = process.env) => Math.min(14 * 60_000 + 10_000, 2 * (chatTurnTimeoutMs(env) + 2_000) + researchDeadlineMs(env) + 15_000);

/** Linha de progresso que chegou do cérebro: só texto curto, uma linha de subtexto ("-# ..."); qualquer outra coisa é ignorada. */
function progressLineFrom(payload) {
  const linha = String(payload?.linha ?? '').replace(/[\r\n]+/g, ' ').trim().slice(0, PROGRESS_LINE_MAX);
  return /^-# \S/.test(linha) ? linha : null;
}

/** Entrega o evento research.progress à função do pedido daquela chave (nunca a outro turno). */
function routeProgress(payload) {
  const fn = progressRoutes.get(String(payload?.chave ?? ''));
  const linha = progressLineFrom(payload);
  if (!fn || !linha) { counters.progressIgnored += 1; return false; }
  counters.progress += 1;
  try { fn(linha); } catch { /* o progresso nunca derruba o turno */ }
  return true;
}
/** Para teste: entrega um evento de progresso como se tivesse vindo do cérebro. */
export const routeProgressForTest = routeProgress;

/**
 * Liga (cliente do canal, papel bot) ou desliga (null) a conversa pelo cérebro. Só o bot com o cérebro separado chama isto.
 * @param {{request: Function, onState?: Function, ready?: Function, connected?: boolean}|null} client
 */
export function setChatRemote(client, { logger: log = defaultLogger } = {}) {
  try { stopState?.(); } catch { /* */ }
  try { stopProgress?.(); } catch { /* */ }
  stopState = null;
  stopProgress = null;
  channel = client && typeof client.request === 'function' ? client : null;
  logger = log;
  pendingCommits.length = 0;
  progressRoutes.clear();
  comentariosAbertos.clear();
  // Progresso da pesquisa (etapa 6): o cérebro manda a linha com a chave do pedido; ela vai só para o turno daquele pedido.
  if (channel && typeof channel.on === 'function') stopProgress = channel.on('research.progress', (payload) => { routeProgress(payload); });
  unavailableSince = channel && channel.connected ? null : Date.now();
  if (channel && typeof channel.onState === 'function') {
    stopState = channel.onState(({ state }) => {
      if (state === 'open') {
        unavailableSince = null;
        flushPendingCommits().catch(() => {});
      } else if (unavailableSince === null) {
        unavailableSince = Date.now();
      }
    });
  }
}

/** A conversa deste processo é respondida pelo cérebro (YUI_CEREBRO_EXTERNO=true)? */
export function isChatRemote() {
  return channel !== null;
}

/** O alvo do AsyncLocalStorage é um turno do cérebro? */
export function isRemoteTurn(target) {
  return Boolean(target && target.remoto === true && typeof target.generate === 'function');
}

function unavailable(cause, why) {
  counters.unavailable += 1;
  const err = new Error(`Cérebro indisponível (${why}).`);
  err.code = CEREBRO_UNAVAILABLE;
  err.cause = cause ?? null;
  return err;
}

/** O erro é "o cérebro não respondeu" (a fila responde CEREBRO_UNAVAILABLE_TEXT)? */
export function isCerebroUnavailable(err) {
  return err?.code === CEREBRO_UNAVAILABLE;
}

/** Espera o canal ficar pronto, só durante a janela de religamento; depois dela, recusa na hora (a fila não fica presa). */
async function ensureAvailable(env = process.env) {
  if (!channel) throw unavailable(null, 'sem canal');
  if (channel.connected) return;
  const since = unavailableSince ?? Date.now();
  if (unavailableSince === null) unavailableSince = since;
  const left = cerebroWaitMs(env) - (Date.now() - since);
  if (left <= 0 || typeof channel.ready !== 'function') throw unavailable(null, 'fora do ar');
  try {
    await channel.ready(left);
  } catch (err) {
    throw unavailable(err, 'não voltou a tempo');
  }
}

/** Pede ao cérebro; caiu no meio = espera a volta e repete UMA vez com a mesma chave. */
async function askCerebro(method, params, { idem, timeoutMs } = {}) {
  for (let attempt = 0; ; attempt += 1) {
    await ensureAvailable();
    try {
      return await channel.request(method, params, { idem, ...(timeoutMs ? { timeoutMs } : {}) });
    } catch (err) {
      if (attempt === 0 && RETRY_CODES.has(err?.code)) {
        counters.retries += 1;
        if (unavailableSince === null) unavailableSince = Date.now();
        logger.warn?.(`[Cérebro] ${method}: a conexão caiu no meio (${err.code}); esperando o cérebro voltar para repetir com a mesma chave.`);
        continue;
      }
      if (UNAVAILABLE_CODES.has(err?.code)) throw unavailable(err, err.code);
      // Cérebro de uma versão sem a conversa (ex.: atualizado só um dos dois): para quem conversa, é o mesmo que indisponível.
      if (err?.code === 'METHOD_NOT_FOUND' || err?.code === 'METHOD_NOT_ALLOWED') throw unavailable(err, err.code);
      throw err;
    }
  }
}

/** Manda os commits que ficaram para trás (na ordem). Um por vez; o que falhar fica para a próxima. Nunca lança. */
export function flushPendingCommits() {
  if (flushing) return flushing;
  const run = (async () => {
    await null; // nunca termina de forma síncrona (a marca "mandando" abaixo precisa existir antes do fim)
    while (pendingCommits.length && channel?.connected) {
      const item = pendingCommits[0];
      if (Date.now() - item.at > PENDING_TTL_MS) {
        pendingCommits.shift();
        counters.pendingDropped += 1;
        logger.warn?.('[Cérebro] Um turno ficou sem gravar no contexto (o cérebro ficou fora por mais de 10 min).');
        continue;
      }
      try {
        await channel.request('chat.commit', item.params, { idem: item.idem, timeoutMs: 30_000 });
        pendingCommits.shift();
        counters.pendingSent += 1;
      } catch (err) {
        if (UNAVAILABLE_CODES.has(err?.code)) return; // continua guardado
        pendingCommits.shift(); // recusado pelo cérebro (pedido inválido): não adianta repetir
        logger.warn?.(`[Cérebro] Commit de turno recusado pelo cérebro (${err?.code ?? 'erro'}).`);
      }
    }
  })().catch(() => {}).finally(() => { if (flushing === run) flushing = null; });
  flushing = run;
  return run;
}

function normalizeTurnId(raw, fallbackParts) {
  const id = String(raw ?? '').trim();
  if (TURN_ID_RE.test(id)) return id;
  const base = id || fallbackParts.join(':');
  return `h${crypto.createHash('sha256').update(base).digest('hex').slice(0, 32)}`;
}

/**
 * Um turno da conversa (um pedido da fila). `facts` são só dados do Discord:
 *  { turn: { id, at }, ctx: { platform, userId, guildId, channelId, isDM, isBlocked }, call: { type, entry, mentionsBot, hasBotName,
 *    repliesToBot, thirdParty, voice, voiceInteraction, voiceItem, chatter, contextOptIn, record }, ownText, memoryQuery,
 *    channel: { serverPrompt, channelSettings, radioBlock, toolsActive, toolsDisabled } }
 * O objeto devolvido também serve de "alvo" para as funções de contexto do llmHandler (active, record, userText, committed).
 */
export function createRemoteTurn(facts) {
  counters.turns += 1;
  const turnId = normalizeTurnId(facts?.turn?.id, [facts?.ctx?.userId ?? '', String(Date.now()), crypto.randomUUID()]);
  const at = Number.isFinite(Number(facts?.turn?.at)) && Number(facts.turn.at) > 0 ? Math.round(Number(facts.turn.at)) : Date.now();
  const base = {
    turn: { id: turnId, at },
    ctx: facts.ctx,
    call: facts.call,
    ownText: typeof facts.ownText === 'string' && facts.ownText.trim() ? facts.ownText : null,
  };
  const history = [];
  let contextLine = null;
  let step = 0;
  let researchSeq = 0;
  let finished = false;
  /** Um pedido de pesquisa (research.turn ou chat.yui) com o progresso daquele pedido ligado só a ele. */
  async function withProgress(method, params, idem, progress, timeoutMs) {
    if (typeof progress === 'function') progressRoutes.set(idem, progress);
    try {
      return await askCerebro(method, params, { idem, timeoutMs });
    } finally {
      if (progressRoutes.get(idem) === progress) progressRoutes.delete(idem);
    }
  }
  const turn = {
    remoto: true,
    // interface de "alvo" do contexto por horas (llmHandler.commitContext/recordContextTurn): quem decide se grava e onde é o cérebro
    active: true,
    record: facts?.call?.record !== false && Boolean(base.ownText),
    userText: base.ownText,
    committed: false,
    key: null,
    turnId,
    get steps() { return step; },
    /** Uma linha do histórico em RAM (o que o llmHandler poria no buffer do canal). */
    noteHistory(role, content) {
      if ((role !== 'user' && role !== 'assistant') || typeof content !== 'string' || !content.trim()) return;
      if (history.length < 20) history.push({ role, content: content.slice(0, 2000) });
    },
    /** A fala da Yui para o contexto por horas (uma por turno; o llmHandler já filtrou pesquisa na web e marcador de ferramenta). */
    noteContext(text) {
      if (contextLine !== null) return false;
      contextLine = String(text ?? '').slice(0, 4000);
      return true;
    },
    /**
     * Um passo: uma chamada à IA. `options` diz o que este passo pede (sem ferramentas, sem histórico, com persona, com memória, voz falada...).
     * Devolve { text, model, failed }. Lança erro CEREBRO_UNAVAILABLE se o cérebro não responder.
     */
    async generate(prompt, options = {}) {
      step += 1;
      counters.steps += 1;
      await flushPendingCommits();
      const params = {
        ...base,
        memoryQuery: String(facts.memoryQuery ?? '').slice(0, 4000),
        channel: facts.channel,
        step,
        prompt: String(prompt ?? ''),
        options,
      };
      const timeoutMs = chatTurnTimeoutMs();
      const out = await askCerebro('chat.turn', params, { idem: `chat.turn:${turnId}:${step}`, timeoutMs: timeoutMs + 5_000 });
      return {
        text: String(out?.text ?? ''), model: typeof out?.model === 'string' ? out.model : null, failed: out?.failed === true,
        // etapa 6: a busca automática do passo rodou no cérebro (usedSearch) ou foi tentada e não deu certo (searchFailure)
        usedSearch: out?.usedSearch === true, searchFailure: typeof out?.searchFailure === 'string' ? out.searchFailure : '',
        searchRetryAfterMs: Number(out?.searchRetryAfterMs) || 0,
      };
    },
    /**
     * A PESQUISA deste turno pelo cérebro (etapa 6: buscas, escolha das fontes, leitura, síntese e organização são dele). `pedido`:
     * { question (só a fala do autor), query, intent } ou, no ramo antigo (YUI_RESEARCH_ENABLED=false), { antigo: true, query, prompt, voz }.
     * `progress(linha)`: a mensagem "Processando..." deste turno. Devolve { ok, kind, text, private, historyLine, usedSearch, sources }.
     * Lança CEREBRO_UNAVAILABLE se o cérebro não responder.
     */
    async research(pedido = {}, { progress = null } = {}) {
      step += 1;
      researchSeq += 1;
      counters.researches += 1;
      await flushPendingCommits();
      const params = { ...base, channel: facts.channel, pedido };
      const out = await withProgress('research.turn', params, `research.turn:${turnId}:${researchSeq}`, progress, researchRequestTimeoutMs());
      return {
        ok: out?.ok === true, kind: typeof out?.kind === 'string' ? out.kind : 'failed', text: String(out?.text ?? ''),
        private: out?.private === true, historyLine: typeof out?.historyLine === 'string' ? out.historyLine : null,
        usedSearch: out?.usedSearch !== false, sources: Array.isArray(out?.sources) ? out.sources : [],
      };
    },
    /**
     * O /yui inteiro pelo cérebro (depois das pré-rotas do bot): Porta A, a resposta com a busca automática, Portas C e D e a nova resposta
     * com a mesma web. `contexto`: os dados que o bot junta à pergunta (GTA, veículos, base de conhecimento). Devolve
     * { text, researched, usedSearch, model, failed }. Lança CEREBRO_UNAVAILABLE se o cérebro não responder.
     */
    async yui({ pergunta, contexto = '' } = {}, { progress = null } = {}) {
      step += 1;
      counters.yui += 1;
      await flushPendingCommits();
      const params = { ...base, channel: facts.channel, pergunta: String(pergunta ?? ''), contexto: String(contexto ?? '') };
      const out = await withProgress('chat.yui', params, `chat.yui:${turnId}`, progress, yuiRequestTimeoutMs());
      return {
        text: String(out?.text ?? ''), researched: out?.researched === true, usedSearch: out?.usedSearch === true,
        model: typeof out?.model === 'string' ? out.model : null, failed: out?.failed === true,
      };
    },
    /** Fim do turno: o commit (uma vez). Nunca lança; o que não sair agora fica para a reconexão. */
    async finish() {
      if (finished) return;
      finished = true;
      if (step === 0 && history.length === 0 && contextLine === null) return; // nada passou pelo cérebro (pré-rotas, ban, voz recusada...)
      const params = { ...base, history, contextLine };
      const idem = `chat.commit:${turnId}`;
      counters.commits += 1;
      try {
        await flushPendingCommits();
        if (!channel?.connected) throw unavailable(null, 'fora do ar');
        await channel.request('chat.commit', params, { idem, timeoutMs: 30_000 });
      } catch (err) {
        if (isCerebroUnavailable(err) || UNAVAILABLE_CODES.has(err?.code)) {
          pendingCommits.push({ idem, params, at: Date.now() });
          while (pendingCommits.length > MAX_PENDING_COMMITS) { pendingCommits.shift(); counters.pendingDropped += 1; }
          logger.warn?.('[Cérebro] O fim do turno não chegou ao cérebro agora; guardado para mandar quando ele voltar.');
        } else {
          logger.warn?.(`[Cérebro] O cérebro recusou o fim do turno (${err?.code ?? 'erro'}).`);
        }
      }
    },
    /** O turno não vai ao cérebro (ex.: o cérebro ficou indisponível no meio): nada a gravar. */
    discard() { finished = true; },
  };
  return turn;
}

// ── Etapa 7: os COMENTÁRIOS fora da fila (o /steam_jogo e o /converter_moeda) pelo cérebro ─────────────────────────────────────────────
/** Quanto o bot espera o comentário (YUI_COMENTARIO_PRAZO_MS: padrão 45 s, de 5 s a 5 min). Sem resposta a tempo, o embed sai sem comentário. */
export const comentarioTimeoutMs = (env = process.env) => envMs('YUI_COMENTARIO_PRAZO_MS', 45_000, 5_000, 300_000, env);
/** Comentários em andamento por interação (uma interação = um pedido só, mesmo que o evento chegue duas vezes). Só no modo separado. */
const comentariosAbertos = new Map();
const COMENTARIO_TTL_MS = 15 * 60_000; // a vida de uma interação adiada no Discord

/**
 * O comentário curto da Yui embaixo do embed (chat.comentario, chave `chat.comentario:<id da interação>`). `facts`: os fatos da interação
 * ({ turn: { id, at }, ctx, call, channel }); `tipo` e `dados`: os do core/ai/promptComentario.js (o bot nunca manda texto livre para a IA).
 * Cérebro fora: espera a volta na mesma janela do chat.turn e repete com a MESMA chave; se não voltar, devolve sem comentário (o embed sai
 * sozinho). A mesma interação pedida de novo enquanto a primeira roda (ou depois, por 15 min) recebe o MESMO resultado: um pedido só.
 * Devolve { text, failed, indisponivel? }. Nunca lança por indisponibilidade do cérebro.
 */
export function pedirComentario(facts, tipo, dados) {
  const turnId = normalizeTurnId(facts?.turn?.id, [facts?.ctx?.userId ?? '', String(Date.now()), crypto.randomUUID()]);
  const agora = Date.now();
  for (const [k, v] of comentariosAbertos) if (agora - v.at > COMENTARIO_TTL_MS) comentariosAbertos.delete(k);
  const aberto = comentariosAbertos.get(turnId);
  if (aberto) { counters.comentariosRepetidos += 1; return aberto.p; }
  counters.comentarios += 1;
  const at = Number.isFinite(Number(facts?.turn?.at)) && Number(facts.turn.at) > 0 ? Math.round(Number(facts.turn.at)) : agora;
  const params = { turn: { id: turnId, at }, ctx: facts.ctx, call: facts.call, ownText: null, memoryQuery: '', channel: facts.channel, tipo, dados };
  const timeoutMs = comentarioTimeoutMs();
  const p = (async () => {
    try {
      const out = await askCerebro('chat.comentario', params, { idem: `chat.comentario:${turnId}`, timeoutMs });
      return { text: String(out?.text ?? ''), failed: out?.failed === true, recusado: typeof out?.recusado === 'string' ? out.recusado : null };
    } catch (err) {
      if (isCerebroUnavailable(err)) { counters.comentariosSemCerebro += 1; return { text: '', failed: true, indisponivel: true }; }
      logger.warn?.(`[Cérebro] chat.comentario recusado (${err?.code ?? 'erro'}); o embed sai sem comentário.`);
      return { text: '', failed: true };
    }
  })();
  comentariosAbertos.set(turnId, { p, at: agora });
  return p;
}

/** Saída da voz de um servidor (o histórico em RAM da voz é do cérebro). Sem efeito fora do modo separado. Nunca lança. */
export function forgetVoiceInCerebro(guildId) {
  if (!channel || !guildId) return false;
  try {
    channel.request('chat.forgetVoice', { guildId: String(guildId) }, { idem: `chat.forgetVoice:${guildId}:${Date.now()}:${crypto.randomUUID().slice(0, 8)}` }).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Só números (saúde do bot e testes). */
export function chatRemoteStats() {
  return { ...counters, remote: channel !== null, connected: Boolean(channel?.connected), pendingCommits: pendingCommits.length, unavailableSince, progressRoutes: progressRoutes.size, comentariosAbertos: comentariosAbertos.size };
}
