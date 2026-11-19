// A conversa do Discord no CÉREBRO (etapa 5, docs/ETAPA3_DONOS_E_CONTRATO.md §8): chat.turn, chat.commit e chat.forgetVoice (cérebro <- bot).
//
// O cérebro é o DONO do contexto por horas (memory-context*.db, desde a etapa 3) e da MONTAGEM do histórico: o bot manda só os fatos do
// Discord (quem, onde, DM ou servidor, ids, a fala do autor, o texto montado para o modelo, a configuração do canal) e o cérebro decide:
//  - o papel, o tipo de canal e o escopo da memória (contextFromWire: as mesmas regras de sempre; a voz é sempre escopo público);
//  - se o turno usa o contexto por horas e qual fio (resolveContextTarget + isDirectCall, as mesmas regras do llmHandler.contextTargetFor):
//    o do Braga em DM ou canal privado vai para o arquivo PESSOAL, separado; o dos outros, para o público; a voz nunca entra;
//  - o histórico que vai ao modelo (o fio do contexto, ou o histórico em RAM do canal, como o buffer antigo do bot) e a memória (recall);
//  - a persona, o prompt de sistema e a oferta das ferramentas (core/ai/promptConversa.js: o MESMO texto do processo único);
//  - onde gravar a troca no fim do turno, UMA vez.
// O texto devolvido pode ser o JSON de uma ferramenta: quem executa é o bot (as ferramentas precisam do Discord).
//
// Garantias:
//  - idempotência: chat.turn leva a chave `chat.turn:<id da mensagem>:<passo>` e chat.commit `chat.commit:<id da mensagem>` (cache do canal);
//    além disso o commit é conferido aqui (turnos já gravados, por id) e, no contexto por horas, pelo PRÓPRIO banco: a troca não entra de novo
//    se o fio já tem a fala do usuário com o mesmo instante e o mesmo texto (vale depois de um reinício do cérebro). A gravação é uma transação
//    só (a fala e a resposta juntas): reinício durante a gravação deixa a troca inteira ou nenhuma;
//  - ordem: os pedidos de uma mesma conversa são atendidos um por vez, na ordem de chegada (fila por conversa); conversas diferentes correm
//    em paralelo e nunca dividem histórico (cada pedido monta o seu, sem estado compartilhado);
//  - IA fora: devolve o aviso de sempre ("Limites de Processamento Atingidos"), que o contexto reconhece como erro da IA.
//
// Etapa 6 (a pesquisa no cérebro, docs/RELATORIO_ETAPA6_PESQUISA.md):
//  - BUSCA AUTOMÁTICA no passo (options.allowSearch + searchPrompt, a fala do próprio autor): a mesma do generateResponse do bot
//    (smartSearchDetailed: porta, pergunta limpa, otimizador, buscador, leitura, contexto marcado como dado não confiável), agora AQUI.
//    Nunca em conversa sensível nem com search_web desligada no servidor; YUI_CEREBRO_BUSCA_AUTOMATICA=false desliga. A web do turno fica
//    guardada (só em RAM, 30 min) para a nova resposta "com a mesma web" (options.reuseWeb) sem pesquisar de novo;
//  - LIMITES POR PROVEDOR: toda chamada à IA leva tokensPorProvedor (core/ai/limitesTokens.js), e não o AI_MAX_TOKENS único;
//  - turno com PESQUISA (busca automática, research.turn ou /yui que pesquisou) nunca entra no contexto por horas: o commit desse turno
//    ignora a linha do contexto, mesmo se o bot a mandar (defesa em profundidade; o bot já não manda).
//
// Ajustes da Liz (§11 do relatório da etapa 6):
//  - a busca automática do passo grava cada busca e cada página no DIÁRIO da retomada (src/cerebro/pesquisaRetomada.js), pela chave do pedido:
//    depois de um reinício do cérebro, a repetição do mesmo passo reaproveita a web já achada, sem buscar de novo;
//  - `searchDecided` (o /yui do cérebro já decidiu pelo contexto que a pergunta pede fonte): a busca não exige a palavra-gatilho;
//  - o limite de tokens leva o ajuste do PAINEL do Discord (o fato do canal `maxTokens` que o bot manda).
// Etapa 11 (docs/RELATORIO_ETAPA11_CLIMA_E_INTENCAO.md): duas decisões por CÓDIGO sobre a fala do PRÓPRIO autor, só na chamada principal do turno e só em
// chamada dirigida à Yui (nunca espontânea, voz nem log de terceiros):
//  - o CLIMA é ferramenta própria (src/core/tools/clima.js): o pedido de clima consulta o Open-Meteo AQUI (só o cérebro chama a rede; só o NOME do local
//    sai), injeta os dados num bloco CERCADO como dado externo não confiável e o modelo responde na persona da Yui. Falha, cota ou local não achado:
//    UMA frase fixa da Yui, sem chamar a IA (o modelo nunca inventa o tempo). Sem cidade: a padrão (YUI_CLIMA_CIDADE_PADRAO) ou "De qual cidade?";
//  - a PESQUISA POR INTENÇÃO (src/cerebro/intencaoBusca.js): a pergunta que pede dado externo atual ("quem ganhou o jogo ontem?") passa pela MESMA busca
//    automática de sempre (autoSearch: cota, porta de saída, dono da cota, diário da retomada e falha fechada), com o contexto "já decidiu"
//    (searchDecided). Na conversa PRIVADA só com a chave, o YUI_PRIVATE_SEARCH liberando a pessoa e a consulta limpa pelo scrubQuery; sai com `privado: true`.
// O log nunca recebe o texto da conversa: só o passo, contagens e códigos.
import { setTimeout as delay } from 'node:timers/promises';
import { buildPersonaPrompt } from '../core/persona.js';
import { buildMemoryBlock } from '../core/discordAdapter.js';
import * as defaultAi from '../core/ai/manager.js';
import {
  buildConversationSystemPrompt, toolsDefinitionFromNames, loadMcpTools, searchOfferedFor, LIMITS_REACHED_TEXT,
} from '../core/ai/promptConversa.js';
import {
  contextEnabled, resolveContextTarget, isDirectCall, initContextStore, readContextTurns, recordContextExchangeOnce, isUnsafeForContext,
} from '../core/context/contextStore.js';
import { ChannelError } from '../core/channel/protocol.js';
import { smartSearchDetailed, createWebContextMemo, fetchPageContent } from '../core/ai/searchManager.js';
import { searchWeb } from '../search/providers.js';
import { limitesDoCanal } from '../core/ai/limitesTokens.js';
import { webSearchGate, buildWebContextPrompt } from '../core/ai/llmSafety.js';
import { searchFailureNote } from '../core/ai/searchIntent.js';
import { forbiddenKeywords as FORBIDDEN_KEYWORDS } from '../core/forbiddenKeywords.js';
import { alertOwner } from '../core/alerts.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { contextFromWire } from './metodos.js';
// Perfis de IA (etapa 9): o cérebro escolhe o perfil de cada chamada (seletor determinístico); o OmniRoute escolhe o provedor.
import { selecionarPerfil, campoPerfil, MARCADOR_DE_IMAGEM } from './seletorPerfil.js';
import { TEXTO_PRIVADA_REENVIAR } from './pesquisaRetomada.js';
// Google (etapa 15, somente leitura, desligado): a pré-rota por código só do dono (agenda, tarefas e e-mails travado). Sem YUI_GOOGLE devolve null e nada muda.
import { preRotaGoogle } from '../integrations/google/index.js';
// Etapa 11: o clima como ferramenta própria e a pesquisa por intenção.
import { createClimaService, climaConfig, detectarPedidoDeClima, interpretarRespostaDeCidade, montarPromptDeClima, textoDeFalhaDoClima, TEXTO_CLIMA_SEM_CIDADE } from '../core/tools/clima.js';
import { avaliarPesquisaPorIntencao } from './intencaoBusca.js';
import { cotaDaBusca } from './cotaDaBusca.js';
import { comAvisoDeIndisponivel } from '../search/indisponivel.js';

const TURN_ID_RE = /^[A-Za-z0-9_.:-]{1,80}$/;
const TOOL_NAME_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_HISTORY = 10;
const DEFAULT_MAX_HISTORY_KEYS = 500;
const COMMITTED_MAX = 5000;
const COMMITTED_TTL_MS = 6 * 60 * 60 * 1000;
const OPEN_TTL_MS = 30 * 60_000;
const WEB_TTL_MS = 30 * 60_000;
const WEB_MAX = 200;
const RESEARCHED_TTL_MS = COMMITTED_TTL_MS;

/** A busca automática do passo (a do generateResponse do bot) está ligada no cérebro? YUI_CEREBRO_BUSCA_AUTOMATICA (padrão: true). */
export function autoSearchEnabled(env = process.env) {
  return !['false', '0', 'off', 'nao', 'não', 'no'].includes(String(env.YUI_CEREBRO_BUSCA_AUTOMATICA ?? '').trim().toLowerCase());
}

const bad = (message) => new ChannelError('BAD_PARAMS', message);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');
const optStr = (v, max) => (typeof v === 'string' && v.trim() ? v.slice(0, max) : null);
const bool = (v) => v === true;

/** Prazo do handler do chat.turn (o mesmo do bot: YUI_CHAT_TURN_TIMEOUT_MS, padrão 5 min). */
export function chatTurnHandlerTimeoutMs(env = process.env) {
  const n = Number(String(env.YUI_CHAT_TURN_TIMEOUT_MS ?? '').trim());
  return Number.isFinite(n) && n >= 1000 ? Math.min(900_000, Math.round(n)) + 2_000 : 302_000;
}

function maxHistoryKeys(env = process.env) {
  const n = Number.parseInt(String(env?.YUI_HISTORY_MAX_CHANNELS ?? ''), 10);
  return Number.isFinite(n) && n >= 10 ? Math.min(n, 100000) : DEFAULT_MAX_HISTORY_KEYS;
}

/** Só para teste (NODE_ENV=test): pausa antes ou depois de gravar a troca, para o teste derrubar o cérebro nesse instante. */
function recordPauseForTest(env = process.env) {
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'test') return null;
  const m = /^(antes|depois):(\d{1,6})$/.exec(String(env.YUI_TESTE_CHAT_PAUSA_GRAVACAO ?? '').trim());
  return m ? { when: m[1], ms: Number(m[2]) } : null;
}

/** Os fatos do turno (o que o bot mandou), conferidos. Lança BAD_PARAMS. */
export function turnFactsFromWire(p, meta = {}) {
  if (!p || typeof p !== 'object') throw bad('Turno ausente.');
  const turnId = String(p.turn?.id ?? '');
  if (!TURN_ID_RE.test(turnId)) throw bad('Id do turno inválido.');
  const at = Number(p.turn?.at);
  if (!Number.isFinite(at) || at <= 0 || at > Date.now() + 5 * 60_000) throw bad('Instante do turno inválido.');
  const c = p.call && typeof p.call === 'object' ? p.call : {};
  const call = {
    entry: c.entry === 'yui' ? 'yui' : 'fila',
    type: c.type === 'mention' ? 'mention' : 'slash',
    record: c.record !== false,
    mentionsBot: bool(c.mentionsBot), hasBotName: bool(c.hasBotName), repliesToBot: bool(c.repliesToBot),
    thirdParty: bool(c.thirdParty), voice: bool(c.voice), voiceInteraction: bool(c.voiceInteraction), voiceItem: bool(c.voiceItem),
    chatter: bool(c.chatter), contextOptIn: bool(c.contextOptIn),
  };
  // O contexto é remontado com as regras do cérebro (papel, tipo de canal, escopo). A voz é sempre pública (sem canal: nada pessoal por voz).
  const wire = p.ctx && typeof p.ctx === 'object' ? p.ctx : null;
  const ctx = contextFromWire(wire ? { ...wire, channelId: call.voiceItem ? null : wire.channelId } : null, meta);
  const realChannelId = wire?.channelId && /^\d{5,25}$/.test(String(wire.channelId)) ? String(wire.channelId) : null;
  return {
    turnId, at: Math.round(at), call, ctx, realChannelId,
    ownText: optStr(p.ownText, 8000),
    memoryQuery: str(p.memoryQuery, 4000),
  };
}

export function channelFactsFromWire(ch) {
  const c = ch && typeof ch === 'object' ? ch : {};
  const names = (list) => (Array.isArray(list) ? list.filter((n) => typeof n === 'string' && TOOL_NAME_RE.test(n)).slice(0, 200) : []);
  let channelSettings = null;
  if (typeof c.channelSettings === 'string') channelSettings = c.channelSettings.slice(0, 4000);
  else if (c.channelSettings && typeof c.channelSettings === 'object') {
    channelSettings = { instruction: optStr(c.channelSettings.instruction, 4000), mood: optStr(c.channelSettings.mood, 1000) };
  }
  return {
    serverPrompt: optStr(c.serverPrompt, 20_000),
    channelSettings,
    radioBlock: str(c.radioBlock, 4000),
    toolsActive: names(c.toolsActive),
    toolsDisabled: names(c.toolsDisabled),
    // etapa 6 (ajustes da Liz): os ajustes de max_tokens do painel do Discord (só provedores da cadeia, de 64 a 8192)
    maxTokens: limitesDoCanal(c.maxTokens),
  };
}

function stepOptionsFromWire(o) {
  const x = o && typeof o === 'object' ? o : {};
  const deadlineAt = Number(x.deadlineAt);
  return {
    noTools: bool(x.noTools), noHistory: bool(x.noHistory), persona: bool(x.persona), memory: bool(x.memory), thirdParty: bool(x.thirdParty),
    voicePersona: bool(x.voicePersona), attachment: bool(x.attachment), chatter: bool(x.chatter), main: bool(x.main),
    // etapa 6: a busca automática (só a fala do próprio autor vai ao buscador) e a nova resposta com a web já achada neste turno
    allowSearch: bool(x.allowSearch), searchPrompt: optStr(x.searchPrompt, 2000), reuseWeb: bool(x.reuseWeb),
    // ajustes da Liz: o /yui do cérebro já decidiu pelo contexto que a pergunta pede fonte (a busca não exige a palavra-gatilho)
    searchDecided: bool(x.searchDecided),
    // etapa 9: o turno traz uma imagem anexada (o perfil "visao"); o bot de hoje ainda não manda (a imagem chega como descrição em texto, e o seletor reconhece o bloco)
    image: bool(x.image),
    deadlineAt: Number.isFinite(deadlineAt) && deadlineAt > 0 ? deadlineAt : null,
    guildName: optStr(x.guildName, 200), channelName: optStr(x.channelName, 200),
  };
}

const footerless = (text) => String(text ?? '').replace(/\n-# .*$/gm, '').trim().toLowerCase();

/** O pedido de limite por provedor da IA: `{ canal }` com os ajustes do painel do Discord, ou `true` (só a configuração do cérebro). */
export function pedidoDeLimiteDoCanal(channel) {
  const canal = limitesDoCanal(channel?.maxTokens);
  return Object.keys(canal).length ? { canal } : true;
}

/**
 * O cérebro da conversa. Tudo injetável para teste.
 * @param {{ ai?: object, env?: object, logger?: object, now?: () => number, memoryBlock?: Function, persona?: Function, tools?: () => object[],
 *           context?: { enabled?: Function, init?: Function, read?: Function, recordOnce?: Function },
 *           retomada?: ReturnType<import('./pesquisaRetomada.js').createRetomadaDePesquisa>|null }} [deps]
 *   `retomada`: o diário da retomada da pesquisa (a busca automática do passo grava nele; null = sem diário)
 */
export function createChatBrain(deps = {}) {
  const ai = deps.ai ?? defaultAi;
  const retomada = deps.retomada ?? null;
  // Etapa 16 (proatividade): os monitores do dono ("me avisa quando..."), pré-rota por código em src/cerebro/monitores (null = desligados: nada muda).
  const monitores = deps.monitores ?? null;
  // Busca automática: os buscadores e o leitor de páginas de verdade, ou os dublês do teste (src/cerebro/buscaFalsa.js).
  const busca = deps.busca ?? {};
  const keywords = Array.isArray(deps.forbiddenKeywords) ? deps.forbiddenKeywords : FORBIDDEN_KEYWORDS;
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? defaultLogger;
  const now = deps.now ?? Date.now;
  // O clima (etapa 11): só o cérebro chama a rede. Injetável para teste (`deps.clima`: o serviço, com o fetch e o servidor falsos).
  const clima = deps.clima ?? createClimaService({ env, logger });
  // A cota de busca só é LIDA (a reserva da pesquisa por intenção); injetável para teste.
  const budgetDaBusca = deps.budget ?? null;
  // A política da pesquisa por intenção (injetável só para teste: a falha fechada com uma política que lança).
  const avaliarIntencao = deps.avaliarIntencao ?? avaliarPesquisaPorIntencao;
  // O seletor de perfil (etapa 9): injetável para teste. Sem perfil configurado devolve null e a chamada de IA fica idêntica à de antes.
  const escolherPerfil = deps.selecionarPerfil ?? ((t) => selecionarPerfil(t, { env }));
  // A pré-rota do Google (etapa 15): injetável para teste. Sem YUI_GOOGLE devolve null.
  const rotearGoogle = deps.google ?? ((a) => preRotaGoogle({ ...a, env }));
  const memoryBlockFor = deps.memoryBlock ?? ((ctx, query) => buildMemoryBlock(ctx, query));
  const personaFor = deps.persona ?? ((ctx) => buildPersonaPrompt(ctx));
  let toolsCache = null;
  const allTools = deps.tools ?? (() => { if (!toolsCache) toolsCache = loadMcpTools(); return toolsCache; });
  const context = {
    enabled: deps.context?.enabled ?? (() => contextEnabled(env)),
    init: deps.context?.init ?? (() => initContextStore()),
    read: deps.context?.read ?? ((target, opts) => readContextTurns(target, opts)),
    recordOnce: deps.context?.recordOnce ?? ((target, payload) => recordContextExchangeOnce(target, payload)),
  };

  /** Histórico em RAM por canal (ou pela chave da voz), como o buffer antigo do bot: Map para descartar o fio mais antigo. */
  const ramHistory = new Map();
  /** Turnos já gravados (por id), para um commit repetido não gravar de novo. */
  const committed = new Map();
  /** Turnos abertos (com passo e sem commit): só para a saúde. */
  const open = new Map();
  /** Fila por conversa: os pedidos de uma conversa são atendidos um por vez, na ordem em que chegam. */
  const queues = new Map();
  const counters = { steps: 0, commits: 0, repeatedCommits: 0, duplicatesBlocked: 0, aiFailures: 0, regenerated: 0, contextRecorded: 0, historyRecorded: 0, autoSearches: 0, autoSearchUsed: 0, researchedContextBlocked: 0,
    // etapa 11 (só números): a pesquisa por intenção (decidida, sem cota para uma busca que ninguém pediu) e o clima (pedidos, respondidos, falhas)
    intencaoBusca: 0, intencaoSemCota: 0, intencaoErro: 0, climaPedidos: 0, climaRespondidos: 0, climaFalhas: 0, climaPerguntouCidade: 0 };
  /** Turnos que pesquisaram (por id): a troca deles nunca entra no contexto por horas. */
  const researched = new Map();
  /** A web achada pela busca automática de cada turno (só em RAM, por WEB_TTL_MS): a nova resposta "com a mesma web" não pesquisa de novo. */
  const webByTurn = new Map();
  function marcarPesquisado(turnId) {
    if (!turnId) return;
    researched.set(String(turnId), now());
  }
  function guardarWeb(turnId, context) {
    webByTurn.delete(turnId);
    webByTurn.set(turnId, { context, at: now() });
    while (webByTurn.size > WEB_MAX) webByTurn.delete(webByTurn.keys().next().value);
  }
  function webDoTurno(turnId) {
    const w = webByTurn.get(turnId);
    if (!w || now() - w.at > WEB_TTL_MS) return null;
    return w.context;
  }

  function inOrder(key, fn) {
    const previous = queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(fn);
    const tail = current.catch(() => {});
    queues.set(key, tail);
    tail.then(() => { if (queues.get(key) === tail) queues.delete(key); });
    return current;
  }

  function sweep() {
    const t = now();
    for (const [id, at] of committed) { if (t - at <= COMMITTED_TTL_MS && committed.size <= COMMITTED_MAX) break; committed.delete(id); }
    for (const [id, o] of open) if (t - o.at > OPEN_TTL_MS) open.delete(id);
    for (const [id, at] of researched) { if (t - at <= RESEARCHED_TTL_MS && researched.size <= COMMITTED_MAX) break; researched.delete(id); }
    for (const [id, w] of webByTurn) { if (t - w.at <= WEB_TTL_MS) break; webByTurn.delete(id); }
  }

  /**
   * As decisões do cérebro para um turno: o alvo do contexto por horas (ou null), a chave do histórico em RAM e a da fila da conversa.
   * São as regras do llmHandler.contextTargetFor (fila) e do /yui (ask.js), agora aplicadas aqui.
   */
  function decide(f) {
    const { ctx, call } = f;
    const guildId = ctx.guildId ?? null;
    const userId = ctx.userId;
    let target = null;
    if (context.enabled() && !call.voice && !call.voiceItem) {
      try {
        if (call.entry === 'yui') {
          const t = resolveContextTarget({ userId, channelId: f.realChannelId, guildId, personal: ctx.memoryScope === 'personal', record: call.record, userText: f.ownText, env });
          target = t.active ? t : null;
        } else if (isDirectCall({
          type: call.type, isDM: !guildId, mentionsBot: call.mentionsBot, hasBotName: call.hasBotName, repliesToBot: call.repliesToBot,
          thirdPartyPrompt: call.thirdParty, radioMode: false, isVoice: call.voiceInteraction, optIn: call.contextOptIn,
        })) {
          const t = resolveContextTarget({ userId, channelId: f.realChannelId, guildId, personal: ctx.memoryScope === 'personal', record: Boolean(f.ownText), userText: f.ownText, env });
          target = t.active ? t : null;
        }
      } catch (err) {
        logger.warn?.(`[Conversa] não consegui decidir o contexto deste turno (segue sem ele): ${String(err?.message ?? err).slice(0, 100)}`);
        target = null;
      }
    }
    const ramKey = call.voiceItem && guildId ? `voice:${guildId}:${userId}` : `canal:${f.realChannelId ?? `dm:${userId}`}`;
    return { target, ramKey, lockKey: target ? `ctx:${target.key}` : ramKey };
  }

  function readHistory(target, ramKey, sensitive) {
    if (target) {
      try { return context.read(target, { sensitive }); } catch { return []; }
    }
    return (ramHistory.get(ramKey) || []).map(({ role, content }) => ({ role, content }));
  }

  function addRam(key, role, content) {
    let list = ramHistory.get(key) || [];
    ramHistory.delete(key); // reinserir: o fio mexido por último fica no fim
    list.push({ role, content });
    if (list.length > MAX_HISTORY) list = list.slice(-MAX_HISTORY);
    ramHistory.set(key, list);
    const cap = maxHistoryKeys(env);
    while (ramHistory.size > cap) ramHistory.delete(ramHistory.keys().next().value);
  }

  // tokensPorProvedor (etapa 6): o tamanho da resposta segue o limite de cada provedor, com o teto global (core/ai/limitesTokens.js) e o
  // ajuste do painel do Discord que o bot mandou como fato do canal (ajustes da Liz).
  async function callAi({ prompt, system, history, ctx, sensitive, deadlineAt, channel, perfil = null }) {
    return ai.chat({ prompt, system, history, ctx, memoryBlock: '', sensitive, tokensPorProvedor: pedidoDeLimiteDoCanal(channel), ...(deadlineAt ? { deadlineAt } : {}), ...campoPerfil(perfil) });
  }

  /**
   * A chamada é DIRIGIDA à Yui? As mesmas regras do isDirectToYui do bot, só com os fatos do turno: o /yui e o comando, a DM, ou a menção, o nome dela
   * e a resposta a ela num servidor. Conversa espontânea, voz e o log de terceiros (/chat_resumo) nunca.
   */
  function chamadaDireta(f, o = {}) {
    const c = f.call;
    if (c.chatter || c.thirdParty || c.voice || c.voiceItem || c.voiceInteraction || o.thirdParty || o.chatter) return false;
    if (c.entry === 'yui' || c.type !== 'mention' || !f.ctx.guildId) return true;
    return Boolean(c.mentionsBot || c.hasBotName || c.repliesToBot);
  }

  const semRodape = (t) => String(t ?? '').replace(/^-# .*$/gm, '').trim();
  /** A última fala da Yui no histórico foi o "De qual cidade?" do clima? (então a resposta curta da pessoa é o local). */
  function ultimaFoiPerguntaDeCidade(history) {
    const last = [...(Array.isArray(history) ? history : [])].reverse().find((h) => h?.role === 'assistant');
    return Boolean(last) && semRodape(last.content) === TEXTO_CLIMA_SEM_CIDADE;
  }

  /**
   * O pedido de clima deste turno (ou null): decidido por CÓDIGO sobre a fala do próprio autor, só em chamada dirigida à Yui. Vale na DM do dono, na DM de
   * outras pessoas e nos servidores. A resposta curta a "De qual cidade?" também vale (o local é a própria fala).
   */
  function pedidoDeClimaDoTurno(f, o, texto, history = []) {
    if (!texto || !climaConfig(env).ligado || !chamadaDireta(f, o)) return null;
    const d = detectarPedidoDeClima(texto);
    if (d.clima) return { local: d.local, quando: d.quando, origem: 'pedido' };
    if (ultimaFoiPerguntaDeCidade(history)) {
      const local = interpretarRespostaDeCidade(texto);
      if (local) return { local, quando: { tipo: 'hoje', rotulo: 'hoje' }, origem: 'resposta' };
    }
    return null;
  }

  /**
   * A pesquisa por intenção deste turno (ou null): a política do intencaoBusca.js (chave, chamada direta, conversa privada) mais as travas daqui: a busca
   * automática ligada, search_web ligada no servidor e a RESERVA da cota (a busca que ninguém pediu não gasta o fim da cota: só o pedido explícito gasta).
   */
  /**
   * A política (intencaoBusca.js), com FALHA FECHADA (revisão da Liz): nunca lança; qualquer erro, resposta estranha ou resposta que não bate com os fatos da conversa
   * (busca privada fora da DM do proprietário, consulta privada vazia) vira "não pesquisa". Os fatos vêm do contexto que o CÉREBRO remontou, nunca do texto.
   */
  function avaliarIntencaoFechado(f, o, texto) {
    const nao = (motivo) => ({ buscar: false, privado: false, motivo, categoria: null, consultaPrivada: null });
    try {
      const contexto = { channelKind: f.ctx.channelKind, guildId: f.ctx.guildId ?? null, role: f.ctx.role, memoryScope: f.ctx.memoryScope };
      const r = avaliarIntencao({ texto, chamadaDireta: chamadaDireta(f, o), contexto, env, forbiddenKeywords: keywords });
      if (!r || typeof r !== 'object' || r.buscar !== true) return nao(String(r?.motivo ?? 'sem_decisao').slice(0, 60));
      const privadaPorFato = !f.ctx.guildId;
      if ((r.privado === true) !== privadaPorFato) return nao('classificacao_incerta');
      if (r.privado === true && (f.ctx.role !== 'OWNER' || f.ctx.memoryScope !== 'personal' || typeof r.consultaPrivada !== 'string' || !r.consultaPrivada.trim())) return nao('classificacao_incerta');
      return r;
    } catch {
      counters.intencaoErro += 1;
      logger.warn?.('[Conversa] a decisão da pesquisa por intenção falhou: segue sem a web.');
      return nao('erro_fechado');
    }
  }

  function decidirIntencao(f, o, texto, channel) {
    if (!texto || !autoSearchEnabled(env) || channel.toolsDisabled.includes('search_web')) return null;
    if (climaConfig(env).ligado && detectarPedidoDeClima(texto).clima) return null; // o clima é ferramenta própria: nunca vira pesquisa
    const r = avaliarIntencaoFechado(f, o, texto);
    if (!r.buscar) return null;
    if (cotaDaBusca(f.ctx.userId, { ...(budgetDaBusca ? { budget: budgetDaBusca } : {}), env }).perto) { counters.intencaoSemCota += 1; return null; }
    counters.intencaoBusca += 1;
    return r;
  }

  /**
   * A busca automática do passo (a do generateResponse do bot, com allowSearch): só a fala do PRÓPRIO autor vai à porta e ao buscador;
   * nunca em conversa sensível (webSearchGate) nem com search_web desligada no servidor. O otimizador é uma chamada à IA sem histórico,
   * sem memória e sem provedor anônimo. Devolve o resultado do smartSearchDetailed (nunca lança) ou null quando nem se aplica.
   */
  async function autoSearch(f, channel, o, prompt, sensitive, diario = null, opcoes = {}) {
    if (!autoSearchEnabled(env)) return null;
    // Etapa 11: a pesquisa por intenção na conversa PRIVADA (já aprovada pela política: chave, YUI_PRIVATE_SEARCH e scrubQuery) é a ÚNICA exceção ao portão da
    // conversa sensível; vai com `privado: true`, sem o otimizador (nenhuma chamada à IA com o texto privado) e com a leitura de páginas sem log do host.
    const privadaPorIntencao = opcoes.privadaPorIntencao === true;
    if (!privadaPorIntencao && !webSearchGate({ sensitive, allowSearch: true }).allowed) return null;
    if (channel.toolsDisabled.includes('search_web')) return null;
    counters.autoSearches += 1;
    const optimizerCtx = { userId: f.ctx.userId, platform: 'api', memoryScope: 'public' };
    const tokensPorProvedor = pedidoDeLimiteDoCanal(channel);
    const optimizer = privadaPorIntencao ? async () => ({ text: 'NAO' }) : async (p, system) => {
      // etapa 9: o otimizador é uma chamada sensível por desenho (nunca provedor anônimo): com o perfil privado declarado, ela segue por ele
      const perfil = campoPerfil(escolherPerfil({ ponto: 'otimizador-busca', privada: true }));
      const call = typeof ai.isolatedChat === 'function'
        ? ai.isolatedChat({ prompt: p, system, ctx: optimizerCtx, sensitive: true, tokensPorProvedor, ...perfil })
        : ai.chat({ prompt: p, system, history: [], ctx: optimizerCtx, memoryBlock: '', sensitive: true, tokensPorProvedor, ...perfil });
      return { text: String((await call) ?? '') };
    };
    // Os buscadores e o leitor de páginas (de verdade ou os dublês do teste); com o diário da retomada, cada busca e cada página ficam
    // guardadas pela chave do pedido (a repetição depois de um reinício reaproveita a web sem buscar de novo).
    const baseSearch = typeof busca.searchWeb === 'function' ? busca.searchWeb : searchWeb;
    const baseReadPublica = typeof busca.readPage === 'function' ? busca.readPage : fetchPageContent;
    const baseRead = privadaPorIntencao ? (url, opts = {}) => baseReadPublica(url, { ...opts, quiet: true }) : baseReadPublica;
    // Conversa privada (a sensível e a DM de qualquer pessoa): a busca dela nunca é compartilhada nem reaproveitada entre pessoas (revisão da Liz, §12).
    const privado = sensitive || (!f.ctx.guildId && !f.call?.voiceItem);
    const comPrivado = (fn) => (q, opts = {}) => fn(q, privado ? { ...opts, privado: true } : opts);
    try {
      return await smartSearchDetailed(o.searchPrompt || prompt, optimizer, {
        userId: f.ctx.userId, sensitive: privadaPorIntencao ? false : sensitive, forbiddenKeywords: keywords, memo: createWebContextMemo(),
        searchImpl: comPrivado(diario ? diario.busca('rapida', baseSearch) : baseSearch),
        readPage: diario ? diario.pagina(baseRead) : baseRead,
        ...(o.searchDecided ? { decidido: true } : {}),
      });
    } catch (err) {
      logger.warn?.(`[Conversa] busca automática falhou (segue sem a web): ${String(err?.code ?? err?.message ?? 'erro').slice(0, 80)}`);
      return null;
    }
  }

  /** Um passo: monta o prompt com as regras do cérebro e chama a IA. Devolve { text, model, failed, repeated? }. */
  async function step(f, channel, o, prompt, extra = {}) {
    counters.steps += 1;
    const { ctx, call } = f;
    const sensitive = ctx.memoryScope === 'personal';
    // Google (etapa 15): o pedido do dono à PRÓPRIA agenda/tarefas, reconhecido por código (sem YUI_GOOGLE: null, nada muda). Resposta curta (não conectado, expirou...)
    // sai direto; com os dados, o prompt os leva CERCADOS e o passo roda sem ferramentas, sem busca e sem provedor anônimo, fora do contexto por horas.
    const googlePendente = rotearGoogle({ ctx, call, texto: f.ownText || o.searchPrompt || '', prompt });
    const google = googlePendente ? await googlePendente : null; // desligado: null na hora, sem esperar nada
    if (google?.resposta) {
      marcarPesquisado(f.turnId);
      return { text: google.resposta, model: 'cérebro', failed: false, usedSearch: false, searchFailure: '', searchRetryAfterMs: 0 };
    }
    if (google?.prompt) { marcarPesquisado(f.turnId); prompt = google.prompt; o = { ...o, ...google.opcoes }; }
    const { target, ramKey } = f.decision;
    if (target) { try { await context.init(); } catch { /* o contexto fica só em RAM */ } }
    const history = o.noHistory ? [] : readHistory(target, ramKey, sensitive);
    // O CLIMA (etapa 11): ferramenta própria, decidida por código sobre a fala do próprio autor (a chamada principal da fila ou a resposta do /yui). Sai só o
    // nome do local. Sem os dados (falha, cota, local não achado, sem cidade) a Yui responde UMA frase fixa, sem chamar a IA: o modelo nunca inventa o tempo.
    let dadosDoClima = null;
    const textoDoAutor = extra.textoDoAutor ?? (o.main && !o.noTools ? f.ownText : null);
    const pedidoClima = pedidoDeClimaDoTurno(f, o, textoDoAutor, history);
    if (pedidoClima) {
      counters.climaPedidos += 1;
      const r = await clima.obter({ local: pedidoClima.local, quando: pedidoClima.quando, userId: ctx.userId });
      if (r.ok) {
        counters.climaRespondidos += 1;
        dadosDoClima = r.dados;
      } else {
        if (r.motivo === 'sem_local') counters.climaPerguntouCidade += 1; else counters.climaFalhas += 1;
        logger.info?.(`[Conversa] clima sem dados no passo ${f.step} (${String(r.motivo).slice(0, 30)}): resposta fixa, sem chamar a IA.`);
        return { text: textoDeFalhaDoClima(r.motivo), model: 'cérebro (clima)', failed: false, usedSearch: false, searchFailure: '', searchRetryAfterMs: 0, usedClima: true };
      }
    }
    let memoryBlock = '';
    if (o.memory && !call.thirdParty && !o.thirdParty) {
      try { memoryBlock = String((await memoryBlockFor(ctx, f.memoryQuery || prompt)) ?? ''); } catch { memoryBlock = ''; }
    }
    const persona = o.persona ? personaFor(ctx) : undefined;
    // A oferta da pesquisa é decisão do cérebro: conversa privada (a sensível e a DM de qualquer pessoa) só com o YUI_PRIVATE_SEARCH; espontânea nunca.
    const privateChat = sensitive || (!ctx.guildId && !call.voiceItem);
    const offerSearch = searchOfferedFor({ sensitive: sensitive || privateChat, userId: ctx.userId, chatter: call.chatter || o.chatter });
    const searchHidden = channel.toolsDisabled.includes('search_web') || !offerSearch;
    const { withMemory } = buildConversationSystemPrompt({
      serverPrompt: channel.serverPrompt, persona, guildName: o.guildName, channelName: o.channelName, radioBlock: channel.radioBlock,
      noToolRule: o.noTools || searchHidden, channelSettings: channel.channelSettings, memoryBlock, voice: o.voicePersona,
    });
    // Busca automática (etapa 6) ou a web já achada neste turno: o texto da web vai CERCADO como dado não confiável e, com ele no
    // prompt, as ferramentas saem desta chamada (como no generateResponse do bot).
    let finalPrompt = prompt;
    let usedSearch = false;
    let searchFailure = '';
    let searchRetryAfterMs = 0;
    // A pesquisa por intenção do passo principal (decidida em turn()) ou do /yui privado (decidida em pesquisa.js): a mesma busca automática, com o contexto "já decidiu".
    const porIntencao = !o.allowSearch && extra.intencao?.buscar === true;
    const privadaPorIntencao = (porIntencao && extra.intencao.privado === true) || extra.privadaPorIntencao === true;
    if (dadosDoClima) {
      finalPrompt = montarPromptDeClima({ dados: dadosDoClima, userPrompt: prompt });
    } else if (o.reuseWeb) {
      const web = webDoTurno(f.turnId);
      if (web) { finalPrompt = buildWebContextPrompt({ context: web, userPrompt: prompt }); usedSearch = true; }
    } else if (o.allowSearch || porIntencao) {
      let opcoesDaBusca = o;
      if (porIntencao) {
        // só a fala do próprio autor vai ao buscador (nunca o prompt com o CONTEXTO); na conversa privada, só a consulta limpa, tirada do pedido
        opcoesDaBusca = { ...o, allowSearch: true, searchDecided: true, searchPrompt: extra.intencao.privado ? extra.intencao.consultaPrivada : f.ownText };
      } else if (privadaPorIntencao) {
        // o /yui privado: a consulta limpa é recalculada aqui (nunca guardada em disco com o diário)
        const again = avaliarIntencaoFechado(f, o, textoDoAutor);
        opcoesDaBusca = again.buscar && again.privado ? { ...o, searchPrompt: again.consultaPrivada, searchDecided: true } : { ...o, allowSearch: false };
      }
      const out = opcoesDaBusca.allowSearch === false ? null : await autoSearch(f, channel, opcoesDaBusca, prompt, sensitive, extra.diario ?? null, { privadaPorIntencao });
      if (out?.context) {
        usedSearch = true;
        counters.autoSearchUsed += 1;
        guardarWeb(f.turnId, out.context);
        finalPrompt = buildWebContextPrompt({ context: out.context, userPrompt: prompt });
      } else if (out) {
        const note = searchFailureNote(out.reason);
        if (note) { finalPrompt = `${prompt}\n\n${note}`; searchFailure = String(out.reason ?? ''); searchRetryAfterMs = Number(out.retryAfterMs) || 0; }
      }
    }
    if (usedSearch) marcarPesquisado(f.turnId);
    let system = withMemory;
    // Com a web ou o clima no prompt as ferramentas saem desta chamada: a resposta é o texto, nunca o JSON de uma ferramenta. Na pesquisa por intenção as
    // ferramentas saem também quando a busca NÃO deu certo: o modelo não pode chamar search_web depois (o bot recusaria na conversa privada).
    if (!o.noTools && !usedSearch && !dadosDoClima && !porIntencao) system += toolsDefinitionFromNames({ allTools: allTools(), active: channel.toolsActive, disabled: channel.toolsDisabled, offerSearch });
    // Nunca provedor anônimo: conversa sensível, texto de anexo (dado de terceiros) e qualquer memória no prompt (como na cadeia do bot).
    const noAnonymous = sensitive || o.attachment || Boolean(memoryBlock);
    const backend = (ai.listBackends?.() ?? []).find((b) => b.active)?.name ?? 'cérebro';
    // O perfil de IA desta chamada (etapa 9): escolhido SÓ pelos fatos deste pedido (o ponto, a privacidade, o texto e o tamanho do histórico), nunca por
    // algo guardado de outra conversa. null = sem perfil configurado: a chamada segue idêntica à de antes.
    const historyChars = history.reduce((n, h) => n + String(h?.content ?? '').length, 0);
    const perfil = escolherPerfil({
      ponto: o.voicePersona ? 'conversa-voz' : 'conversa', privada: noAnonymous, texto: f.ownText || o.searchPrompt || prompt, historicoChars: historyChars,
      imagem: o.image === true || MARCADOR_DE_IMAGEM.test(String(prompt).slice(0, 200_000)),
    });
    let text;
    try {
      text = String(await callAi({ prompt: finalPrompt, system, history, ctx, sensitive: noAnonymous, deadlineAt: o.deadlineAt, channel, perfil }) ?? '');
    } catch (err) {
      counters.aiFailures += 1;
      // A falha FECHADA do perfil privado (etapa 9): nada saiu a nenhum provedor; a pessoa recebe a mensagem curta e clara, sem o aviso de "IA fora"
      // (a rota privada já avisa o dono com o limite de repetição dela).
      if (err?.code === 'PERFIL_FECHADO') {
        logger.warn?.(`[Conversa] a rota privada da IA está fechada no passo ${f.step} (${String(err.motivo ?? 'fechada').slice(0, 60)}): nada foi enviado a nenhum provedor.`);
        return { text: String(err.mensagemCurta ?? LIMITS_REACHED_TEXT), model: backend, failed: true, usedSearch, searchFailure, searchRetryAfterMs };
      }
      logger.warn?.(`[Conversa] a IA falhou no passo ${f.step} (${String(err?.code ?? err?.message ?? 'erro').slice(0, 80)})`);
      try { alertOwner('ai-down', 'A IA do cérebro não respondeu', String(err?.message ?? 'sem detalhes').slice(0, 300), { level: 'error', cooldownMinutes: 15 }); } catch { /* */ }
      return { text: LIMITS_REACHED_TEXT, model: backend, failed: true, usedSearch, searchFailure, searchRetryAfterMs };
    }
    // Resposta idêntica à anterior (a chamada principal): pede UMA vez outra resposta, como a fila do bot fazia com o histórico dele.
    // Com o clima (ou a web da pesquisa por intenção) a resposta pode legitimamente se repetir, e o novo pedido iria SEM os dados (o modelo inventaria): não repete.
    if (o.main && history.length && !dadosDoClima && !(porIntencao && usedSearch)) {
      const last = [...history].reverse().find((h) => h.role === 'assistant');
      const lastClean = footerless(last?.content);
      if (lastClean.length > 15 && footerless(text) === lastClean) {
        counters.regenerated += 1;
        logger.warn?.('[Conversa] resposta idêntica à anterior: pedindo outra (anti-repetição).');
        try {
          const again = buildConversationSystemPrompt({
            serverPrompt: channel.serverPrompt, radioBlock: channel.radioBlock, noToolRule: true, channelSettings: channel.channelSettings, voice: o.voicePersona,
          });
          const retry = String(await callAi({ prompt: `(responda de forma diferente, com outras palavras): ${f.ownText || prompt}`, system: again.withMemory, history, ctx, sensitive: noAnonymous, channel, perfil }) ?? '');
          if (retry.trim()) text = retry;
        } catch { /* fica a primeira */ }
      }
    }
    if (google?.revisar) text = google.revisar(text); // com dados do Google, uma "chamada de ferramenta" na resposta nunca é legítima
    // A pesquisa por intenção NÃO saiu porque a pesquisa está temporariamente indisponível (sem o dono da cota ou sem o registro em disco): o texto ÚNICO de sempre,
    // uma vez só, sem detalhe interno (a mesma regra do /yui).
    if (porIntencao && searchFailure === 'unavailable') text = comAvisoDeIndisponivel(text);
    return { text, model: `cérebro (${backend})`, failed: false, usedSearch, searchFailure, searchRetryAfterMs, ...(dadosDoClima ? { usedClima: true } : {}) };
  }

  /** chat.commit: grava o que o turno deixou, UMA vez, onde o cérebro decide. */
  async function commit(f, history, contextLineIn) {
    let contextLine = contextLineIn;
    counters.commits += 1;
    open.delete(f.turnId);
    if (committed.has(f.turnId)) { counters.repeatedCommits += 1; return { ok: true, repeated: true }; }
    // Resposta com pesquisa na web não entra no contexto por horas (texto derivado da web seria uma injeção persistida), como hoje.
    if (contextLine && researched.has(f.turnId)) {
      counters.researchedContextBlocked += 1;
      logger.info?.('[Conversa] este turno pesquisou na web: a troca não entra no contexto por horas.');
      contextLine = null;
    }
    const { target, ramKey } = f.decision;
    let recorded = { context: false, history: 0, duplicate: false };
    if (target) {
      // Contexto por horas ativo: só o contexto (o histórico em RAM do canal fica intocado, como no processo único).
      if (contextLine && target.record && f.ownText && !isUnsafeForContext(contextLine)) {
        try { await context.init(); } catch { /* */ }
        const pause = recordPauseForTest(env);
        if (pause?.when === 'antes') { logger.warn?.('[Conversa] teste: pausa ANTES de gravar a troca'); await delay(pause.ms); }
        // A fala e a resposta com o instante da MENSAGEM: a troca fica junta na ordem do disco e o instante é a chave natural do turno.
        const out = context.recordOnce(target, { userText: f.ownText, assistantText: contextLine, userAt: f.at, assistantAt: f.at });
        if (pause?.when === 'depois') { logger.warn?.('[Conversa] teste: pausa DEPOIS de gravar a troca'); await delay(pause.ms); }
        recorded = { context: out.recorded === true, history: 0, duplicate: out.duplicate === true };
        if (out.duplicate) {
          counters.duplicatesBlocked += 1;
          logger.info?.('[Conversa] a troca deste turno já estava no contexto (repetida depois de um reinício): não entrou de novo.');
        }
        if (out.recorded) counters.contextRecorded += 1;
      }
    } else if (f.call.entry !== 'yui') {
      for (const h of history) addRam(ramKey, h.role, h.content);
      recorded.history = history.length;
      counters.historyRecorded += history.length;
    }
    committed.set(f.turnId, now());
    sweep();
    return { ok: true, ...recorded };
  }

  return {
    /** Handler do chat.turn (cérebro <- bot). */
    turn(p, meta = {}) {
      const f = turnFactsFromWire(p, meta);
      const channel = channelFactsFromWire(p.channel);
      const o = stepOptionsFromWire(p.options);
      const stepNo = Number.isInteger(p.step) && p.step > 0 ? p.step : 1;
      const prompt = str(p.prompt, 200_000);
      if (!prompt.trim()) throw bad('Texto do turno vazio.');
      f.step = stepNo;
      f.decision = decide(f);
      if (!open.has(f.turnId)) open.set(f.turnId, { at: now(), steps: 0 });
      open.get(f.turnId).steps = stepNo;
      // A busca automática deste passo (o "jogo não encontrado" da fila) grava no diário da retomada pela chave do passo: a repetição do
      // MESMO passo depois de um reinício do cérebro reaproveita a web já achada, sem buscar de novo.
      // A pesquisa por intenção (etapa 11): só na chamada principal da fila, sobre a fala do próprio autor; decidida ANTES de abrir o diário (a busca dela
      // também grava no diário da retomada, como a busca automática de sempre).
      const intencao = o.main && !o.noTools && !o.allowSearch && !o.reuseWeb ? decidirIntencao(f, o, f.ownText, channel) : null;
      let diario = null;
      if ((o.allowSearch || intencao) && retomada && typeof meta.idem === 'string') {
        // privada para a pesquisa: a conversa sensível e a DM de qualquer pessoa (a mesma regra do research.turn): sem conteúdo em disco
        const privado = f.ctx.memoryScope === 'personal' || (!f.ctx.guildId && !f.call.voiceItem);
        try { diario = retomada.abrir(meta.idem, { userId: f.ctx.userId, privado, tipo: 'chat.turn' }); } catch { diario = null; }
      }
      return inOrder(f.decision.lockKey, async () => {
        // Monitores (etapa 16): o pedido do DONO ("me avisa quando sair o patch X", "meus monitores", "cancela o monitor 2") é tratado por código, sem a IA, só
        // na chamada principal do turno e só para mensagem dirigida à Yui. A troca não entra no contexto por horas (como os lembretes).
        if (monitores && stepNo === 1 && o.main) {
          const mon = await monitores.rotear({ ctx: f.ctx, call: f.call, texto: f.ownText });
          if (mon?.handled) { marcarPesquisado(f.turnId); return { text: mon.text, model: 'cérebro', failed: false, usedSearch: false, searchFailure: '', searchRetryAfterMs: 0 }; }
        }
        // Passo com a busca automática numa conversa PRIVADA interrompido por um reinício: sem o conteúdo (nunca em disco), a Yui não busca de
        // novo sozinha e pede para mandar de novo (segunda revisão da Liz, §12).
        if (diario?.reenviar) {
          marcarPesquisado(f.turnId); // o aviso não entra no contexto por horas
          return { text: TEXTO_PRIVADA_REENVIAR, model: 'cérebro', failed: false, usedSearch: false, searchFailure: '', searchRetryAfterMs: 0 };
        }
        const out = await step(f, channel, o, prompt, { diario, intencao });
        try { if (diario) { if (out.usedSearch || out.searchFailure) diario.concluir(); else diario.descartar(); } } catch { /* */ }
        return out;
      });
    },
    /** Handler do chat.commit (cérebro <- bot). */
    commit(p, meta = {}) {
      const f = turnFactsFromWire(p, meta);
      const history = (Array.isArray(p.history) ? p.history : [])
        .filter((h) => h && (h.role === 'user' || h.role === 'assistant') && typeof h.content === 'string' && h.content.trim())
        .slice(0, 20)
        .map((h) => ({ role: h.role, content: h.content.slice(0, 2000) }));
      const contextLine = optStr(p.contextLine, 4000);
      f.decision = decide(f);
      return inOrder(f.decision.lockKey, () => commit(f, history, contextLine));
    },
    /** Saída da voz de um servidor: esquece o histórico em RAM da voz daquele servidor. */
    forgetVoice(p) {
      const guildId = String(p?.guildId ?? '');
      if (!/^\d{5,25}$/.test(guildId)) throw bad('Servidor inválido.');
      let removed = 0;
      for (const key of [...ramHistory.keys()]) if (key.startsWith(`voice:${guildId}:`)) { ramHistory.delete(key); removed += 1; }
      return { removed };
    },
    stats: () => ({ ...counters, open: open.size, ramKeys: ramHistory.size, committed: committed.size, queues: queues.size, researched: researched.size, webTurns: webByTurn.size, clima: clima.stats() }),
    // ── Para o /yui do cérebro (src/cerebro/pesquisa.js) ──
    /** O pedido de clima da fala (ou null): decidido por código, só em chamada dirigida à Yui. */
    pedidoDeClima: (f, texto) => pedidoDeClimaDoTurno(f, {}, String(texto ?? ''), []),
    /** A política da pesquisa por intenção para a conversa PRIVADA do /yui (a pública segue a decisão do contexto): { buscar, privado, motivo }. */
    intencaoDeBuscaPrivada: (f, texto) => {
      const r = avaliarIntencaoFechado(f, {}, String(texto ?? ''));
      return { buscar: r.buscar, privado: r.privado, motivo: r.motivo };
    },
    // ── Para a pesquisa do cérebro (src/cerebro/pesquisa.js) ──
    /** Os fatos de um pedido do bot já conferidos e a decisão do cérebro (alvo do contexto, histórico, fila da conversa). */
    preparar(p, meta = {}) {
      const f = turnFactsFromWire(p, meta);
      f.decision = decide(f);
      f.step = 0;
      return { f, channel: channelFactsFromWire(p.channel) };
    },
    /** Um passo (chamada à IA com as regras do cérebro), na fila da conversa. `o`: as opções do passo (o formato do chat.turn). */
    passo(f, channel, o, prompt, extra = {}) {
      const opts = stepOptionsFromWire(o);
      f.step = (f.step ?? 0) + 1;
      const g = { ...f };
      // `extra.textoDoAutor` (o /yui): a pergunta do próprio autor, para o clima; `extra.privadaPorIntencao`: a busca do /yui privado já aprovada pela política.
      return inOrder(f.decision.lockKey, () => step(g, channel, opts, String(prompt ?? ''), extra));
    },
    marcarPesquisado,
    foiPesquisado: (turnId) => researched.has(String(turnId)),
  };
}

/**
 * Registra chat.turn, chat.commit e chat.forgetVoice no servidor do canal (só o papel bot).
 * @returns {{ methods: string[], brain: ReturnType<typeof createChatBrain> }}
 */
export function registerChatMethods(server, deps = {}) {
  const brain = deps.brain ?? createChatBrain(deps);
  const methods = [];
  const opts = { roles: ['bot'] };
  server.handle('chat.turn', (p, meta) => brain.turn(p, meta), { ...opts, timeoutMs: chatTurnHandlerTimeoutMs(deps.env ?? process.env) });
  methods.push('chat.turn');
  server.handle('chat.commit', (p, meta) => brain.commit(p, meta), opts);
  methods.push('chat.commit');
  server.handle('chat.forgetVoice', async (p) => brain.forgetVoice(p), opts);
  methods.push('chat.forgetVoice');
  return { methods, brain };
}

