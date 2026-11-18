// A PESQUISA na web do Discord no CÉREBRO (etapa 6, docs/ETAPA3_DONOS_E_CONTRATO.md §9 e docs/RELATORIO_ETAPA6_PESQUISA.md).
//
// Até a etapa 5 a pesquisa da fila (buscas e leitura de páginas) e a do /yui inteira rodavam no BOT; só a síntese da fila ia ao cérebro.
// Agora o cérebro faz a pesquisa INTEIRA: a busca automática (no passo do chat.turn, conversa.js), a escolha das fontes, a leitura das
// páginas, a síntese e a organização dos resultados (o agente de sempre: core/ai/researchAgent.js, pelo adaptador core/ai/research.js).
// O bot fica com a interface (o progresso na mensagem "Processando...", que chega como evento, e a entrega) e com a execução das ferramentas.
//
// Métodos (cérebro <- bot, só o papel bot):
//  - research.turn (chave `research.turn:<id da mensagem>:<n>`): a pesquisa de um turno da FILA, quando o modelo chamou search_web (Porta B)
//    ou a guarda trocou uma promessa vazia por uma pesquisa (Porta C). Com YUI_RESEARCH_ENABLED=false, o ramo ANTIGO (busca rápida +
//    resposta com a web), também aqui;
//  - chat.yui (chave `chat.yui:<id da interação>`): o /yui inteiro depois das pré-rotas do bot (listas, lembretes, mods): a Porta A (pré-rota
//    de pesquisa), a resposta do modelo com a busca automática, as Portas C e D (promessa vazia vira pesquisa, recusa ou resposta final) e a
//    nova resposta com a mesma web. Mesma sequência do discord/commands/ask.js no processo único.
// Evento (cérebro -> bot): research.progress { chave, linha }: a linha de progresso ("-# 🔎 Pesquisando…") vai SÓ para o pedido daquela chave.
//
// Regras de privacidade e segurança (as de sempre, agora aplicadas aqui, com o contexto REMONTADO pelo cérebro a partir dos fatos):
//  - conversa privada (o Braga em DM ou canal privado, e a DM de qualquer pessoa) só pesquisa com YUI_PRIVATE_SEARCH liberando a pessoa; nela a
//    consulta é SÓ o texto literal do pedido (o agente ignora a consulta e a intenção do modelo), a síntese nunca vai a provedor anônimo e
//    nem o canal entra no prompt (sem persona de canal, prompt do servidor ou rádio);
//  - a síntese não recebe memória, histórico nem o fio do contexto (chamada isolada): nada pessoal chega a provedor nenhum por ela;
//  - o texto da web é DADO, nunca instrução (llmSafety: cerca de dado não confiável, links e menções neutralizados, fontes pelo código);
//  - turno com pesquisa nunca entra no contexto por horas (o commit do turno ignora a linha do contexto: conversa.js);
//  - voz nunca pesquisa; conversa espontânea também não; search_web desligada no servidor recusa;
//  - os limites e prazos de sempre: YUI_RESEARCH_* (prazo total, passos, páginas), uma pesquisa por pessoa por vez (a mesma trava do app),
//    as vagas fora da fila (/yui e app somados) e as cotas dos buscadores (secrets/search-budget.json: agora um processo só grava nele).
// Idempotência: a chave por mensagem + o cache do canal (um pedido repetido enquanto o primeiro ainda roda espera o MESMO resultado): uma
// reconexão nunca faz a mesma busca duas vezes. O log nunca recebe a pergunta, a consulta nem o texto da web: só tipos e contagens.
//
// Ajustes da Liz (§10/§11 do relatório da etapa 6):
//  - RETOMADA sem repetição cega (src/cerebro/pesquisaRetomada.js): cada pesquisa (pela chave do pedido) tem estado pending/running/completed/
//    uncertain e o resultado de cada etapa (busca, página, síntese) fica num diário do cérebro. Depois de um REINÍCIO, a mesma chave retoma de
//    onde parou: busca concluída e guardada não roda de novo; busca enviada sem resultado registrado vira "incerta" e tem UMA nova tentativa
//    controlada (registrada, contada na cota uma vez, visível no log e na saúde);
//  - a BUSCA AUTOMÁTICA do /yui é decidida pelo CONTEXTO (decidirBusca): conversa e pergunta simples não pesquisam; assunto atual (notícia, preço,
//    lançamento...), documentação/fonte e o pedido explícito pesquisam; com a cota de busca perto do fim, só o pedido explícito pesquisa e a
//    Yui avisa. Usar o /yui não basta, sozinho, para gastar cota. A conversa privada segue exatamente as regras de antes.
// Segunda revisão da Liz (§12/§13): a pesquisa PRIVADA nunca tem conteúdo em disco (só o estado); interrompida por um reinício, a Yui pede para
// mandar de novo (TEXTO_PRIVADA_REENVIAR) e não pesquisa sozinha.
// Revisão da Liz da etapa 8 (§12 do relatório): FALHAR FECHADO. Nenhuma pesquisa externa começa sem o dono da cota (a trava) e sem o registro persistente
// (a marca do diário e a cota em disco), privada, pública, automática ou explícita. Em qualquer dos caminhos daqui (research.turn, chat.yui, a busca
// automática do passo e o ramo antigo) a busca simplesmente não sai e a Yui responde, no lugar da pesquisa, o aviso ÚNICO de que a pesquisa está
// temporariamente indisponível (TEXTO_PESQUISA_INDISPONIVEL). A pesquisa PRIVADA nunca é compartilhada nem reaproveitada entre pessoas (`privado: true`
// segue até o searchWeb).
import * as defaultAi from '../core/ai/manager.js';
import { routeExplicitResearch, reviewResearchReply } from '../core/ai/manager.js';
import { createCoreResearch } from '../core/ai/research.js';
import { readResearchConfig, createUserGuard } from '../core/ai/researchAgent.js';
import { buildConversationSystemPrompt } from '../core/ai/promptConversa.js';
import { acabamentoSemFerramentas, isSystemReply, stripThinking } from '../core/ai/limpezaResposta.js';
import { buildSearchToolPrompt, webSearchGate, describeSearchOutcome } from '../core/ai/llmSafety.js';
import { VOICE_REFUSAL, precisaDeFonteExterna } from '../core/ai/searchIntent.js';
import { buildSearchContext, fetchPageContent, searchForAgent } from '../core/ai/searchManager.js';
import { searchWeb, activeProviders } from '../search/providers.js';
import { getDefaultBudget, userLimitPerHour, globalLimitPerHour, monthlyCap } from '../search/budget.js';
import { limitesDoCanal } from '../core/ai/limitesTokens.js';
import { TEXTO_PRIVADA_REENVIAR } from './pesquisaRetomada.js';
import { TEXTO_PESQUISA_INDISPONIVEL, comAvisoDeIndisponivel } from '../search/indisponivel.js';
import { isOwnerId } from '../core/permissions.js';
import { ChannelError } from '../core/channel/protocol.js';
import { logger as defaultLogger } from '../utils/logger.js';
import { chatTurnHandlerTimeoutMs, autoSearchEnabled } from './conversa.js';
// Perfis de IA (etapa 9): a síntese da pesquisa usa o perfil "pesquisa" (ou o "privado", se a pesquisa é privada e o dono o declarou).
import { selecionarPerfil, campoPerfil } from './seletorPerfil.js';

export const SPONTANEOUS_NO_SEARCH_TEXT = 'Eu só pesquiso na web quando alguém me chama de verdade. Me menciona com o pedido que eu pesquiso.';
const RESEARCH_FAILED_TEXT = 'Deu um problema aqui na pesquisa. Tente de novo em instantes.';
/** O aviso do /yui quando a cota de busca está perto do fim e a pergunta não PEDIU pesquisa (decidirBusca, modo "cota"). */
export const AVISO_COTA = '-# ⚠️ A cota de pesquisa na web está quase no fim, então respondi sem buscar. Se precisar mesmo de fonte, pede "pesquise ..." que eu busco.';

/** Reserva da cota (YUI_CEREBRO_BUSCA_RESERVA, em %, padrão 20; 0 desliga o aviso): abaixo disto do que sobra, a cota está "perto do fim". */
export function reservaDaCota(env = process.env) {
  const n = Number.parseInt(String(env.YUI_CEREBRO_BUSCA_RESERVA ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 0 ? Math.min(n, 90) : 20;
}

/**
 * A cota de busca está perto do fim para esta pessoa? Só LÊ os contadores (não gasta nada): o limite por hora da pessoa
 * (YUI_SEARCH_USER_PER_HOUR), o teto global por hora (YUI_SEARCH_GLOBAL_PER_HOUR) e, se TODOS os buscadores ativos tiverem teto mensal, a cota
 * do mês. "Perto do fim" = sobram até YUI_CEREBRO_BUSCA_RESERVA % (no mínimo 1 busca). Só números no resultado.
 * @returns {{ perto: boolean, motivo: string, restantes: { usuario: number|null, global: number|null, mensal: number|null } }}
 */
export function cotaDaBusca(userId, { budget = getDefaultBudget(), env = process.env } = {}) {
  const pct = reservaDaCota(env);
  const out = { perto: false, motivo: '', restantes: { usuario: null, global: null, mensal: null } };
  if (!pct) return out;
  const reserva = (limite) => Math.max(1, Math.ceil((limite * pct) / 100));
  try {
    const u = budget.userStatus?.(userId, env);
    if (u && userLimitPerHour(env) > 0 && userId) {
      out.restantes.usuario = Math.max(0, u.limit - u.used);
      if (out.restantes.usuario <= reserva(u.limit)) { out.perto = true; out.motivo = 'usuario'; }
    }
    const g = budget.globalStatus?.(env);
    if (g && globalLimitPerHour(env) > 0) {
      out.restantes.global = Math.max(0, g.limit - g.used);
      if (!out.perto && out.restantes.global <= reserva(g.limit)) { out.perto = true; out.motivo = 'global'; }
    }
    const ativos = activeProviders(env);
    const comTeto = ativos.filter((p) => monthlyCap(p, env) > 0);
    if (ativos.length && comTeto.length === ativos.length && typeof budget.used === 'function') {
      const sobras = comTeto.map((p) => ({ sobra: Math.max(0, monthlyCap(p, env) - budget.used(p)), cap: monthlyCap(p, env) }));
      out.restantes.mensal = sobras.reduce((s, x) => s + x.sobra, 0);
      if (!out.perto && sobras.every((x) => x.sobra <= reserva(x.cap))) { out.perto = true; out.motivo = 'mensal'; }
    }
  } catch { /* sem como ler a cota: segue sem o aviso (a cota de verdade continua valendo no buscador) */ }
  return out;
}
const MAX_LINE = 200;

const bad = (message) => new ChannelError('BAD_PARAMS', message);
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** Prazo do handler do research.turn: o prazo total da pesquisa (YUI_RESEARCH_DEADLINE_MS, até 180 s) + folga. */
export function researchHandlerTimeoutMs(env = process.env) {
  return readResearchConfig(env).totalDeadlineMs + 15_000;
}
/** Prazo do handler do chat.yui: dois passos da IA (a resposta e a nova resposta) + uma pesquisa + folga; no máximo 14 min (o /yui vale 15). */
export function yuiHandlerTimeoutMs(env = process.env) {
  return Math.min(14 * 60_000, 2 * chatTurnHandlerTimeoutMs(env) + readResearchConfig(env).totalDeadlineMs + 10_000);
}

function pedidoFromWire(p) {
  const x = p && typeof p === 'object' ? p : {};
  return {
    question: str(x.question, 2000),
    query: str(x.query, 500),
    intent: str(x.intent, 500),
    antigo: x.antigo === true,
    prompt: str(x.prompt, 200_000),
    voz: x.voz === true,
  };
}

/** Só o que o bot precisa do resultado do agente (o trace e as estatísticas internas ficam aqui). */
function shape(out, extra = {}) {
  return {
    ok: out?.ok === true,
    kind: out?.kind ?? 'failed',
    text: String(out?.text ?? '').trim() || RESEARCH_FAILED_TEXT,
    private: out?.private === true,
    historyLine: typeof out?.historyLine === 'string' ? out.historyLine : null,
    usedSearch: out?.usedSearch !== false,
    sources: Array.isArray(out?.sources) ? out.sources.slice(0, 10).map((s) => ({ n: s?.n ?? null, host: String(s?.host ?? '').slice(0, 100) })) : [],
    ...extra,
  };
}

/**
 * A pesquisa do cérebro. Tudo injetável para teste.
 * @param {{ chat: ReturnType<import('./conversa.js').createChatBrain>, ai?: object, env?: object, logger?: object,
 *           emit?: (event: string, payload: object) => unknown, busca?: { search?: Function, readPage?: Function, searchWeb?: Function },
 *           slots?: object, forbiddenKeywords?: string[], retomada?: ReturnType<import('./pesquisaRetomada.js').createRetomadaDePesquisa>|null,
 *           budget?: object }} deps
 *   `retomada`: o diário da retomada (null = sem diário: a pesquisa perdida num reinício roda de novo, como na etapa 6);
 *   `budget`: os contadores da cota de busca (padrão: os do processo, search/budget.js), só LIDOS aqui para a decisão do /yui.
 */
export function createResearchBrain(deps = {}) {
  const chat = deps.chat;
  if (!chat || typeof chat.preparar !== 'function') throw new TypeError('createResearchBrain: informe o cérebro da conversa (chat).');
  const ai = deps.ai ?? defaultAi;
  const env = deps.env ?? process.env;
  const logger = deps.logger ?? defaultLogger;
  const emit = typeof deps.emit === 'function' ? deps.emit : () => 0;
  const busca = deps.busca ?? {};
  // `privado`: a pesquisa PRIVADA nunca é compartilhada nem reaproveitada entre pessoas (o searchWeb não a põe nas buscas em andamento nem no cache).
  const search = typeof busca.search === 'function' ? busca.search : (q, o) => searchForAgent(q, { ...(o?.max ? { max: o.max } : {}), userId: o?.userId ?? null, signal: o?.signal ?? null, privado: o?.private === true });
  const readPage = typeof busca.readPage === 'function' ? busca.readPage : (url, o) => fetchPageContent(url, { ...(o?.maxChars ? { maxChars: o.maxChars } : {}), ...(o?.totalDeadlineMs ? { totalDeadlineMs: o.totalDeadlineMs } : {}), ...(o?.signal ? { signal: o.signal } : {}), ...(o?.private ? { quiet: true } : {}) });
  const searchQuick = typeof busca.searchWeb === 'function' ? busca.searchWeb : searchWeb;
  const retomada = deps.retomada ?? null;
  const budget = deps.budget ?? null;
  // Uma pesquisa por pessoa por vez, POR CÉREBRO (no processo é o mesmo que a trava do adaptador; nos testes, dois "processos" não dividem a trava).
  const userGuard = createUserGuard();
  // `indisponiveis`: quantas respostas foram o aviso de pesquisa temporariamente indisponível (a busca não saiu: sem o dono da cota ou sem o registro em disco).
  const counters = { pesquisas: 0, yui: 0, antigas: 0, recusadas: 0, progresso: 0, retomadas: 0, respostasReaproveitadas: 0, interrompidas: 0, privadasReenviar: 0, indisponiveis: 0, yuiDecisoes: { pesquisar: 0, sem_fonte: 0, cota: 0, privada: 0, desligada: 0 } };
  /** O pedido de limite por provedor da IA, com os ajustes do painel do Discord que o bot mandou como fato do canal. */
  const limiteDoCanal = (channel) => {
    const canal = limitesDoCanal(channel?.maxTokens);
    return Object.keys(canal).length ? { canal } : true;
  };

  /** Progresso só para o pedido desta chave (o bot entrega à mensagem "Processando..." daquele turno, e de nenhum outro). */
  const progressFor = (chave) => (line) => {
    const linha = String(line ?? '').slice(0, MAX_LINE);
    if (!linha.trim()) return false;
    counters.progresso += 1;
    try { emit('research.progress', { chave, linha }); } catch { /* o progresso nunca derruba a pesquisa */ }
    return true;
  };

  /** Decisões do cérebro sobre ESTA conversa (remontadas dos fatos; nunca do que o bot afirmou). */
  function conversaDe(f) {
    const sensitive = f.ctx.memoryScope === 'personal';
    // Conversa privada para a PESQUISA: a sensível e a DM de qualquer pessoa (voz nunca é DM: o escopo dela é sempre público).
    const privateChat = sensitive || (!f.ctx.guildId && !f.call.voiceItem);
    return { sensitive, privateChat, isOwner: isOwnerId(f.ctx.userId) };
  }

  /**
   * O agente de pesquisa ligado a ESTE turno: buscadores e leitor de páginas daqui, a síntese pela IA do cérebro com o prompt de sistema da
   * conversa do Discord (o MESMO do processo único: prompt do servidor, persona e humor do canal, rádio, regra "toda resposta é FINAL" sem
   * ferramentas), sem histórico, sem memória e sem persona pessoal. Na pesquisa PRIVADA nem o canal entra. search_web desligada = recusa.
   */
  function runnerFor(f, channel, diario = null) {
    const systemFor = (privateMode) => buildConversationSystemPrompt(privateMode
      ? { noToolRule: true }
      : { serverPrompt: channel.serverPrompt, radioBlock: channel.radioBlock, channelSettings: channel.channelSettings, noToolRule: true }).withMemory;
    const tokensPorProvedor = limiteDoCanal(channel);
    // Sem histórico e sem memória (chamada isolada); `sensitive` = pesquisa privada (nunca provedor anônimo); a resposta passa pela
    // mesma limpeza do processo único (raciocínio, chamada escrita como texto) antes da validação do agente.
    const sintese = async ({ prompt, ctx, sensitive, deadlineAt }) => {
      const perfil = campoPerfil((deps.selecionarPerfil ?? ((t) => selecionarPerfil(t, { env })))({ ponto: 'sintese-pesquisa', privada: sensitive === true }));
      const call = typeof ai.isolatedChat === 'function'
        ? ai.isolatedChat({ prompt, system: systemFor(sensitive === true), ctx, sensitive: sensitive === true, deadlineAt, tokensPorProvedor, ...perfil })
        : ai.chat({ prompt, system: systemFor(sensitive === true), history: [], ctx, memoryBlock: '', sensitive: sensitive === true, deadlineAt, tokensPorProvedor, ...perfil });
      return stripThinking(String((await call) ?? ''));
    };
    return createCoreResearch({
      // Com o diário (retomada): cada busca, página e síntese fica guardada; na retomada, o que já foi feito não se repete.
      search: diario ? diario.busca('agente', search) : search,
      readPage: diario ? diario.pagina(readPage) : readPage,
      isToolDisabled: (_guildId, tool) => channel.toolsDisabled.includes(tool),
      ...(Array.isArray(deps.forbiddenKeywords) ? { forbiddenKeywords: deps.forbiddenKeywords } : {}),
      chat: diario ? diario.sintese(sintese) : sintese,
      userGuard,
      log: (level, message) => { try { logger[level]?.(message); } catch { /* */ } },
    });
  }

  /** O diário da retomada desta pesquisa (ou null). Nunca lança. */
  function abrirDiario(chave, f, conv, tipo) {
    if (!retomada) return null;
    try {
      const d = retomada.abrir(chave, { userId: f.ctx.userId, privado: conv.privateChat, tipo });
      if (d?.retomada) counters.retomadas += 1;
      return d;
    } catch {
      return null;
    }
  }
  /** Guarda o fim da pesquisa no diário (nunca derruba a resposta). */
  function concluirDiario(d, resultado) {
    try { d?.concluir(resultado); } catch { /* */ }
  }

  /**
   * A busca automática do /yui decidida pelo CONTEXTO (ajustes da Liz, §11). Só a fala do autor; nenhuma IA; só LÊ a cota.
   *  - conversa privada: 'privada' (as regras de sempre: sem busca automática; o agente só com YUI_PRIVATE_SEARCH e pedido explícito);
   *  - YUI_CEREBRO_BUSCA_AUTOMATICA=false: 'desligada' (sem busca automática; a promessa do modelo ainda vira pesquisa pela Porta C, como antes);
   *  - a pergunta não pede fonte externa (precisaDeFonteExterna: conversa, pergunta simples, cotação...): 'sem_fonte' (nada de busca, nem
   *    pela promessa do modelo: a Porta C pede a resposta final em vez de pesquisar);
   *  - pede fonte, mas a cota está perto do fim e a pessoa NÃO pediu a pesquisa: 'cota' (não começa a busca e avisa);
   *  - pede fonte (pedido explícito, assunto atual, documentação/fonte): 'pesquisar'.
   */
  function decidirBusca(f, conv, pergunta) {
    if (conv.privateChat) return { modo: 'privada', motivo: 'conversa privada', explicito: false };
    if (!autoSearchEnabled(env)) return { modo: 'desligada', motivo: 'YUI_CEREBRO_BUSCA_AUTOMATICA', explicito: false };
    const precisa = precisaDeFonteExterna(pergunta);
    if (!precisa.precisa) return { modo: 'sem_fonte', motivo: precisa.motivo, explicito: false };
    if (!precisa.explicito) {
      const cota = cotaDaBusca(f.ctx.userId, { ...(budget ? { budget } : {}), env });
      if (cota.perto) return { modo: 'cota', motivo: `${precisa.motivo}/${cota.motivo}`, explicito: false };
    }
    return { modo: 'pesquisar', motivo: precisa.motivo, explicito: precisa.explicito };
  }

  /** O ramo ANTIGO (YUI_RESEARCH_ENABLED=false): busca rápida + leitura das 3 melhores páginas + a resposta COM a web (e o histórico), sem ferramentas. */
  async function antiga(f, channel, pedido, conv, diario = null) {
    counters.antigas += 1;
    const gate = webSearchGate({ sensitive: conv.sensitive });
    if (!gate.allowed) return { ok: false, kind: 'refused', text: gate.message, private: false, historyLine: null, usedSearch: false, sources: [] };
    logger.info?.(`[Pesquisa] ramo antigo no cérebro (consulta com ${pedido.query.length} caracteres)`);
    const buscar = diario ? diario.busca('rapida', searchQuick) : searchQuick;
    // `privado`: conversa privada (a sensível e a DM de qualquer pessoa): a busca dela nunca é compartilhada nem reaproveitada entre pessoas.
    const found = await buscar(pedido.query, { max: 5, userId: f.ctx.userId, sensitive: conv.sensitive, privado: conv.privateChat });
    if (diario?.desistiu) return { ok: false, kind: 'failed', text: diario.textoDaDesistencia, private: false, historyLine: null, usedSearch: false, sources: [] };
    const context = Array.isArray(found?.results) && found.results.length ? await buildSearchContext(found, { readPage: diario ? diario.pagina(readPage) : readPage }) : null;
    if (!context) {
      const outcome = describeSearchOutcome(found ?? { results: [] }, { hasContext: false });
      return { ok: false, kind: 'failed', text: outcome.message || `❌ Não encontrei nada relevante sobre "${pedido.query}" na busca rápida.`, private: false, historyLine: null, usedSearch: false, sources: [] };
    }
    chat.marcarPesquisado(f.turnId);
    const contextPrompt = buildSearchToolPrompt({ results: context, userPrompt: pedido.prompt || pedido.question });
    const r = await chat.passo(f, channel, { noTools: true, voicePersona: pedido.voz }, contextPrompt);
    const text = `${r.failed ? r.text : acabamentoSemFerramentas(r.text)}\n-# 🔎 Search`;
    return { ok: !r.failed, kind: r.failed ? 'failed' : 'answer', text, private: false, historyLine: null, usedSearch: true, sources: [] };
  }

  /** research.turn: a pesquisa de um turno da FILA. */
  async function turn(p, meta = {}) {
    const { f, channel } = chat.preparar(p, meta);
    const pedido = pedidoFromWire(p.pedido);
    // (pedido sem pergunta nem consulta: o agente responde "não entendi o que pesquisar", como no processo único)
    const chave = meta.idem ?? `research.turn:${f.turnId}`;
    counters.pesquisas += 1;
    // A resposta deste turno é derivada da web (ou da recusa da pesquisa): não entra no contexto por horas, como no processo único.
    chat.marcarPesquisado(f.turnId);
    // Defesa em profundidade (o bot já filtra): voz nunca pesquisa; conversa espontânea também não.
    if (f.call.voice || f.call.voiceItem) { counters.recusadas += 1; return shape({ ok: false, kind: 'refused', text: VOICE_REFUSAL, usedSearch: false }); }
    if (f.call.chatter) { counters.recusadas += 1; return shape({ ok: false, kind: 'refused', text: SPONTANEOUS_NO_SEARCH_TEXT, usedSearch: false }); }
    const conv = conversaDe(f);
    // Retomada: a mesma chave depois de um reinício continua de onde parou (ou devolve a resposta que já estava pronta).
    const diario = abrirDiario(chave, f, conv, 'research.turn');
    const pronta = diario?.concluida();
    if (pronta) { counters.respostasReaproveitadas += 1; return pronta; }
    // Pesquisa PRIVADA interrompida por um reinício (o conteúdo dela nunca fica em disco): a Yui pede para mandar de novo, sem pesquisar sozinha.
    if (diario?.reenviar) { counters.privadasReenviar += 1; return shape({ ok: false, kind: 'failed', text: TEXTO_PRIVADA_REENVIAR, private: true, usedSearch: false }); }
    let resultado;
    if (pedido.antigo || !readResearchConfig(env).enabled) {
      resultado = await antiga(f, channel, pedido, conv, diario);
    } else {
      const out = await runnerFor(f, channel, diario).runResearchFor({
        question: pedido.question || pedido.query, query: pedido.query, intent: pedido.intent, userId: f.ctx.userId,
        sensitive: conv.privateChat, isOwner: conv.isOwner, channelId: f.realChannelId, guildId: f.ctx.guildId,
        progress: progressFor(chave),
      });
      resultado = shape(out);
    }
    // A busca ficou incerta duas vezes (ou a privada sem conteúdo guardado): sem uma busca às cegas, a Yui pede para mandar de novo.
    if (diario?.desistiu) { counters.interrompidas += 1; resultado = shape({ ok: false, kind: 'failed', text: diario.textoDaDesistencia, private: conv.privateChat, usedSearch: false }); }
    if (resultado.text === TEXTO_PESQUISA_INDISPONIVEL) counters.indisponiveis += 1;
    concluirDiario(diario, resultado);
    return resultado;
  }

  /** chat.yui: o /yui inteiro (depois das pré-rotas do bot), na mesma sequência do discord/commands/ask.js do processo único. */
  async function yui(p, meta = {}) {
    const { f, channel } = chat.preparar(p, meta);
    if (f.call.entry !== 'yui') throw bad('O chat.yui é só para o /yui.');
    const pergunta = str(p.pergunta, 20_000);
    if (!pergunta.trim()) throw bad('Pergunta vazia.');
    const contexto = str(p.contexto, 200_000);
    const chave = meta.idem ?? `chat.yui:${f.turnId}`;
    counters.yui += 1;
    const conv = conversaDe(f);
    // Retomada: a mesma chave depois de um reinício continua de onde parou (ou devolve a resposta que já estava pronta).
    const diario = abrirDiario(chave, f, conv, 'chat.yui');
    const pronta = diario?.concluida();
    if (pronta) { counters.respostasReaproveitadas += 1; return pronta; }
    // /yui PRIVADO interrompido por um reinício: sem o conteúdo (nunca em disco), a Yui pede para mandar de novo, sem pesquisar sozinha.
    if (diario?.reenviar) {
      counters.privadasReenviar += 1;
      return { text: TEXTO_PRIVADA_REENVIAR, researched: true, usedSearch: false, model: null, failed: false, decisao: { modo: 'privada', motivo: 'reinicio' } };
    }
    // A busca automática decidida pelo CONTEXTO (a retomada usa a decisão já guardada: a cota do processo novo pode estar diferente).
    const decisao = diario?.decisao ?? decidirBusca(f, conv, pergunta);
    diario?.guardarDecisao(decisao);
    counters.yuiDecisoes[decisao.modo] = (counters.yuiDecisoes[decisao.modo] ?? 0) + 1;
    logger.info?.(`[Pesquisa] /yui: decisão da busca=${decisao.modo} motivo=${decisao.motivo}`);
    const podePesquisar = decisao.modo === 'pesquisar' || decisao.modo === 'privada' || decisao.modo === 'desligada';
    const progress = progressFor(chave);
    const runner = runnerFor(f, channel, diario);
    const entry = {
      text: pergunta, sensitive: conv.privateChat, isOwner: conv.isOwner, userId: f.ctx.userId, guildId: f.ctx.guildId ?? null,
      channelId: f.realChannelId, searchIfExplicit: conv.privateChat, progress,
      // A pergunta não pede fonte (ou a cota está no fim e ela não pediu): a promessa do modelo NÃO vira pesquisa (vira a resposta final).
      ...(podePesquisar ? {} : { semBuscaPorContexto: true }),
    };
    const deps2 = { llm: { runResearchFor: runner.runResearchFor, isToolDisabled: runner.isToolDisabled } };
    const comContexto = (t) => (contexto ? `${contexto}\n\n${t}` : t);
    const limpa = (r) => {
      if (r.failed) return '';
      const clean = acabamentoSemFerramentas(r.text);
      return clean && !isSystemReply(clean) ? clean : '';
    };
    const decisaoPublica = { modo: decisao.modo, motivo: decisao.motivo };
    const fim = (out) => {
      if (diario?.desistiu) { counters.interrompidas += 1; Object.assign(out, { text: diario.textoDaDesistencia, researched: true, failed: false }); }
      // Só a pesquisa fica no diário (a resposta pronta, para a repetição com a mesma chave); o /yui que não pesquisou não deixa nada.
      if (out.researched || out.usedSearch) concluirDiario(diario, out); else { try { diario?.descartar(); } catch { /* */ } }
      return out;
    };
    // Porta A (só com YUI_RESEARCH_PRE_ROUTE=true): pedido explícito e estrito pesquisa por código, sem consultar o modelo.
    const routed = podePesquisar ? await routeExplicitResearch(entry, deps2) : { handled: false };
    if (routed.handled) {
      if (routed.researched) chat.marcarPesquisado(f.turnId);
      return fim({ text: routed.text, researched: routed.researched === true, usedSearch: false, model: null, failed: false, decisao: decisaoPublica });
    }
    // A resposta do modelo, sem ferramentas. A busca automática só com a decisão "pesquisar" (nunca na conversa privada: a pesquisa privada é
    // do agente); com ela, o gatilho de palavras do otimizador não é exigido (`searchDecided`: o contexto já decidiu).
    const buscaAutomatica = decisao.modo === 'pesquisar';
    const gen = await chat.passo(f, channel, { noTools: true, allowSearch: buscaAutomatica, searchDecided: buscaAutomatica, searchPrompt: pergunta }, contexto ? `${contexto}\n\nPergunta do usuário: ${pergunta}` : pergunta, { diario });
    let resposta = gen.failed ? gen.text : acabamentoSemFerramentas(gen.text);
    if (gen.usedSearch && !gen.failed) resposta += '\n-# 🔎 Search';
    // Portas C e D: promessa vazia vira pesquisa de verdade, recusa honesta ou a resposta final; o que ainda for só promessa não chega à pessoa.
    const reviewed = await reviewResearchReply({
      ...entry, reply: resposta, usedSearch: gen.usedSearch === true,
      searchFailure: gen.searchFailure || '', searchRetryAfterMs: gen.searchRetryAfterMs || 0, rejectToolJson: true,
      // a busca automática trouxe a web, mas a resposta só prometeu: nova resposta COM a mesma web (sem pesquisar de novo)
      regenerateWithWeb: async (retryPrompt) => (gen.usedSearch ? limpa(await chat.passo(f, channel, { noTools: true, reuseWeb: true }, comContexto(retryPrompt))) : ''),
      regenerate: async (retryPrompt) => limpa(await chat.passo(f, channel, { noTools: true }, comContexto(retryPrompt))),
    }, deps2);
    if (reviewed.researched || gen.usedSearch) chat.marcarPesquisado(f.turnId);
    let texto = reviewed.text;
    // Cota perto do fim e a pessoa não pediu a pesquisa: respondeu sem buscar, e avisa (uma linha de subtexto, fora do contexto).
    if (decisao.modo === 'cota' && !gen.failed && !reviewed.researched) texto = `${texto}\n${AVISO_COTA}`;
    // A busca automática NÃO saiu (sem o dono da cota ou sem o registro em disco): a Yui respondeu com o que sabe e avisa, com o texto ÚNICO, que a pesquisa
    // está temporariamente indisponível (uma vez só: se a guarda já trocou a resposta por esse aviso, não repete).
    if (gen.searchFailure === 'unavailable' && !gen.failed) texto = comAvisoDeIndisponivel(texto);
    if (texto.includes(TEXTO_PESQUISA_INDISPONIVEL)) counters.indisponiveis += 1;
    return fim({ text: texto, researched: reviewed.researched === true, usedSearch: gen.usedSearch === true, model: gen.model ?? null, failed: gen.failed === true, decisao: decisaoPublica });
  }

  return {
    turn,
    yui,
    decidirBusca: (p, pergunta) => { const { f } = chat.preparar(p, {}); return decidirBusca(f, conversaDe(f), String(pergunta ?? '')); },
    stats: () => ({ ...counters, yuiDecisoes: { ...counters.yuiDecisoes }, retomada: retomada?.stats?.() ?? null }),
  };
}

/**
 * Registra research.turn e chat.yui no servidor do canal (só o papel bot). O progresso sai como evento para o bot.
 * @returns {{ methods: string[], brain: ReturnType<typeof createResearchBrain> }}
 */
export function registerResearchMethods(server, deps = {}) {
  const env = deps.env ?? process.env;
  const brain = deps.brain ?? createResearchBrain({ ...deps, emit: deps.emit ?? ((event, payload) => server.emit?.(event, payload, { role: 'bot' })) });
  const opts = { roles: ['bot'] };
  server.handle('research.turn', (p, meta) => brain.turn(p, meta), { ...opts, timeoutMs: researchHandlerTimeoutMs(env) });
  server.handle('chat.yui', (p, meta) => brain.yui(p, meta), { ...opts, timeoutMs: yuiHandlerTimeoutMs(env) });
  return { methods: ['research.turn', 'chat.yui'], brain };
}
