import axios from 'axios';
import { logger } from '../../utils/logger.js';
import { buildPersonaPrompt } from '../persona.js';
// Agente de pesquisa (módulos PUROS, sem rede nem Discord): a pesquisa fora da fila usa o MESMO agente da fila (ver "Pesquisa na web" abaixo).
import { readResearchConfig, privateSearchAllowed, failureMessage } from '../../handlers/researchAgent.js';
import {
  preRouteDecision, recoveryPlan, finalGuard, finalGuardDetailed, inspectFinalGuard, userNeedsAnswer, detectSearchRequest, detectUnfulfilledPromise, isRawToolLeak,
  buildNoPromiseRetryPrompt, clipInput, norm, SEARCH_DISABLED_REPLY, SENSITIVE_SEARCH_REFUSAL, PROMISE_ONLY_FALLBACK,
} from '../../handlers/searchIntent.js';
import { webSearchGate, scrubLogText } from '../../handlers/llmSafety.js';

/**
 * AI Manager — interface única de IA do Yui Core.
 *
 * O Core nunca chama um provedor diretamente: ele pede `chat()` ao Manager,
 * que delega a um backend registrado. Trocar de modelo (nuvem → LM Studio →
 * llama.cpp → OmniRoute) é registrar/selecionar outro backend, sem tocar no Core.
 *
 * Contrato de um backend:
 *   {
 *     name: string,
 *     local: boolean,                       // o modelo roda na máquina do dono?
 *     chat({ prompt, system, history, ctx, memoryBlock }) => Promise<string>
 *   }
 *
 * Backends embutidos:
 *  - "legacy-chain" (padrão): a cadeia de provedores que já existe no
 *    llmHandler.js (LM Studio → HF → Groq → Gemini → Cloudflare → ...).
 *    Carregada sob demanda, para o Core não depender do Discord na importação.
 *    Extrair esses provedores para backends independentes é evolução futura.
 *  - "openai-compatible": qualquer endpoint /chat/completions (ver abaixo).
 *
 * Seleção: AI_BACKEND=<nome> (padrão: legacy-chain).
 */

const backends = new Map();
let activeName = null;

export function registerBackend(backend, { activate = false } = {}) {
  if (!backend?.name || typeof backend.chat !== 'function') {
    throw new Error('Backend inválido: precisa de { name, chat() }.');
  }
  backends.set(backend.name, { local: false, ...backend });
  if (activate || !activeName) activeName = backend.name;
}

export function setActiveBackend(name) {
  if (!backends.has(name)) throw new Error(`Backend desconhecido: ${name}`);
  activeName = name;
}

export function listBackends() {
  return [...backends.values()].map((b) => ({ name: b.name, local: b.local, active: b.name === activeName }));
}

/**
 * Pede uma resposta à IA ativa.
 *
 * `AI_PRIVATE_LOCAL_ONLY=true` faz o Manager RECUSAR enviar contexto de
 * memória pessoal para um backend que não seja local (pronto para quando
 * houver IA local; hoje o padrão é false, pois a nuvem é permitida).
 *
 * `deadlineAt` (opcional, instante em ms): a cadeia de provedores não abre outro depois dele (usado na nova resposta que a
 * pesquisa pede ao modelo). Backend que não o conhece o ignora.
 */
export async function chat({ prompt, system = '', history = [], ctx, memoryBlock = '', deadlineAt = null }) {
  const backend = backends.get(activeName);
  if (!backend) throw new Error('Nenhum backend de IA registrado.');

  if (
    String(process.env.AI_PRIVATE_LOCAL_ONLY || 'false').toLowerCase() === 'true' &&
    ctx?.memoryScope === 'personal' &&
    !backend.local
  ) {
    throw new Error('Contexto pessoal bloqueado: AI_PRIVATE_LOCAL_ONLY exige backend local.');
  }

  // Personalidade decidida pelo backend a partir do contexto (papel + canal).
  const persona = system || buildPersonaPrompt(ctx);

  const started = Date.now();
  const text = await backend.chat({ prompt, system: persona, history, ctx, memoryBlock, ...(deadlineAt ? { deadlineAt } : {}) });
  logger.info(`[AI] backend=${backend.name} ${Date.now() - started}ms`);
  return text;
}

// ───────────────────────── Pesquisa na web (entradas FORA da fila: app/API, /yui e +yui) ─────────────────────────
//
// O agente de pesquisa (handlers/researchAgent.js, via llmHandler.runResearchFor) é o MESMO da fila do Discord: toda pesquisa termina em resposta
// sintetizada, resumo com links ou mensagem com o motivo, nunca em "vou pesquisar" parado. Quem não passa pela fila usa as PORTAS daqui:
//  - Porta A, routeExplicitResearch: pedido de pesquisa EXPLÍCITO e ESTRITO pesquisa por código, sem a primeira chamada ao modelo
//    (só com YUI_RESEARCH_PRE_ROUTE=true; YUI_RESEARCH_ENABLED=false desliga);
//  - Portas C e D, reviewResearchReply: a resposta do modelo só PROMETE pesquisar ("Vou pesquisar isso!")? Vira pesquisa de verdade, recusa honesta,
//    pergunta do assunto ou a resposta final. O que ainda for só promessa é trocado pelo aviso (YUI_RESEARCH_GUARD: on | observe | off).
// O modelo dessas entradas NUNCA tem ferramentas (o app e o /yui só conversam): por isso, onde nenhum outro caminho pesquisa, o pedido explícito é
// pesquisado pelo código mesmo que o modelo tenha respondido "de cabeça" (searchIfExplicit), como a fila faz com provedor sem ferramentas.
// CONVERSA PRIVADA (o app é sempre privado; o /yui do dono em DM ou em canal privado): só pesquisa se o YUI_PRIVATE_SEARCH liberar este usuário e SÓ em
// pedido explícito; a consulta sai SÓ do texto literal da mensagem (nunca histórico, memória ou contexto pessoal), passa por scrubQuery e pelas
// palavras proibidas do banHandler, a síntese roda com sensitive:true (nunca provedor anônimo) e nada da consulta vai ao log nem ao histórico.
// Nenhuma destas funções lança: qualquer falha aqui deixa a resposta do modelo seguir como estava.

/** Pesquisas simultâneas FORA da fila (/yui, +yui e app somados): dentro da fila a pesquisa já é serial. */
export const OUTSIDE_QUEUE_MAX = 2;

/** Vagas simultâneas: tryAcquire() devolve a função que libera, ou null se todas estão ocupadas. Vaga esquecida expira (ttlMs). */
export function createSlotLimiter(max = OUTSIDE_QUEUE_MAX, { ttlMs = 5 * 60_000, now = Date.now } = {}) {
  const active = new Map();
  return {
    tryAcquire() {
      const t = now();
      for (const [token, since] of active) if (t - since >= ttlMs) active.delete(token);
      if (active.size >= max) return null;
      const token = Symbol('pesquisa');
      active.set(token, t);
      return () => { active.delete(token); };
    },
    size: () => active.size,
  };
}
export const researchSlots = createSlotLimiter();

export const RESEARCH_BUSY_REPLY = 'Tem pesquisa demais rodando agora. Tenta de novo em instantes.';
// A resposta do modelo ainda era um JSON de ferramenta cru (o /yui e o +yui nunca executam ferramentas). Contém "Desculpe, tive um erro": o contexto não a guarda.
export const RAW_TOOL_REPLY = 'Desculpe, tive um erro ao montar essa resposta. Pode perguntar de novo?';
// Motivo da busca automática (smartSearchDetailed.reason) -> código de failureMessage: o usuário vê POR QUE não deu certo, em vez de uma 2ª busca com a mesma cota.
const SEARCH_FAILURE_CODES = Object.freeze({
  user_limited: 'user_limited', global_limited: 'global_limited', deadline: 'deadline', no_providers: 'no_providers', providers_rest: 'providers_rest',
  providers_error: 'providers_error', error: 'providers_error', no_results: 'no_results', filtered: 'no_results', no_content: 'no_results',
  sensitive_data: 'sensitive_data', forbidden: 'forbidden',
});
// O app só usa esta frase quando a guarda final troca uma promessa de pesquisa que ficou sem resposta: diz a verdade (não deu para pesquisar).
export const APP_NO_SEARCH_REPLY = 'Desculpe, não consegui pesquisar isso agora. Pede de novo com o assunto na mesma frase (por exemplo: "pesquise o preço do PS5").';
const CURRENCY_FAILED = 'Não consegui consultar a cotação agora. Tente de novo em instantes.';
const FALLBACK_RESEARCH_CONFIG = Object.freeze({ enabled: false, guard: 'off', preRoute: false, privateSearch: 'off', totalDeadlineMs: 60_000 });

function readCfg(deps) {
  try { return (typeof deps?.config === 'function' ? deps.config : readResearchConfig)(); } catch (_) { return FALLBACK_RESEARCH_CONFIG; }
}
/** { runResearchFor, isToolDisabled } do llmHandler, carregado SÓ quando uma pesquisa vai de fato acontecer (o Core não puxa o Discord na importação). */
async function loadLlm(deps) {
  if (deps?.llm?.runResearchFor && deps?.llm?.isToolDisabled) return deps.llm;
  const mod = await import('../../handlers/llmHandler.js');
  return { runResearchFor: mod.runResearchFor, isToolDisabled: mod.isToolDisabled };
}
const refusalOf = (text, reason) => ({ text, researched: false, kind: 'refused', reason, private: false, historyLine: null });
const errorTag = (err) => scrubLogText(err?.code ?? err?.message ?? 'erro', 80);

/** Cotação (a promessa "vou ver o dólar" vira a conversão de verdade): texto pronto, nunca lança. */
async function currencyAnswer(args, deps) {
  try {
    if (typeof deps?.currencyAnswer === 'function') return String((await deps.currencyAnswer(args)) || CURRENCY_FAILED);
    const { convertCurrency } = await import('../../handlers/currencyHandler.js');
    const info = await convertCurrency(args?.amount, args?.from, args?.to);
    if (!info || info.error) return String(info?.error || CURRENCY_FAILED);
    const fmt = (n, o) => Number(n).toLocaleString('pt-BR', o);
    return `${fmt(info.amount)} ${info.from} equivale a ${fmt(info.result, { minimumFractionDigits: 2, maximumFractionDigits: 2 })} ${info.to} (1 ${info.from} = ${fmt(info.rate, { minimumFractionDigits: 2, maximumFractionDigits: 4 })} ${info.to}).`;
  } catch (err) {
    logger.warn(`[Pesquisa] cotação falhou: ${errorTag(err)}`);
    return CURRENCY_FAILED;
  }
}

/**
 * O núcleo comum: portão da conversa privada, ferramenta ligada no servidor, vaga (no máximo OUTSIDE_QUEUE_MAX simultâneas), e então o agente.
 * `p`: { text (SÓ a fala do autor), query, intent, sensitive, isOwner, privateBlocked, userId, guildId, channelId, progress }.
 * Devolve { text, researched, kind, private, historyLine, reason }; `researched` é true sempre que o agente respondeu (inclusive com recusa dele).
 */
async function runEntryResearch(p, cfg, deps) {
  const sensitive = p.sensitive === true;
  const isOwner = p.isOwner === true;
  if (sensitive && p.privateBlocked === true) return refusalOf(SENSITIVE_SEARCH_REFUSAL, 'sensitive');
  const gate = webSearchGate({ sensitive, privateMode: cfg.privateSearch, isOwner, explicit: true });
  if (!gate.allowed) return refusalOf(gate.message || SENSITIVE_SEARCH_REFUSAL, 'sensitive');
  const llm = await loadLlm(deps);
  if (llm.isToolDisabled(p.guildId ?? null, 'search_web')) return refusalOf(SEARCH_DISABLED_REPLY, 'disabled');
  const release = (deps?.slots ?? researchSlots).tryAcquire();
  if (!release) return refusalOf(RESEARCH_BUSY_REPLY, 'busy');
  try {
    const found = await llm.runResearchFor({
      question: String(p.text ?? ''), query: p.query ?? '', intent: p.intent ?? '', userId: p.userId ?? null, sensitive, isOwner,
      channelId: p.channelId ?? null, guildId: p.guildId ?? null, progress: typeof p.progress === 'function' ? p.progress : null,
    });
    return {
      text: String(found?.text ?? '').trim() || 'Deu um problema aqui na pesquisa. Tente de novo em instantes.',
      researched: true, kind: found?.kind ?? 'failed', private: found?.private === true, historyLine: found?.historyLine || null, reason: p.reason ?? '',
    };
  } finally {
    release();
  }
}

/**
 * Porta A. Pedido de pesquisa EXPLÍCITO e ESTRITO (preRouteDecision, chamada sempre DIRETA) pesquisa por código, sem consultar o modelo.
 * Só com YUI_RESEARCH_ENABLED e YUI_RESEARCH_PRE_ROUTE ligados. Conversa privada que o YUI_PRIVATE_SEARCH não liberou recebe a recusa na hora.
 * `p`: ver runEntryResearch. @returns {Promise<{handled:false, reason}|{handled:true, text, researched, kind, private, historyLine}>}
 */
export async function routeExplicitResearch(p = {}, deps = {}) {
  try {
    const cfg = readCfg(deps);
    if (!cfg.enabled || !cfg.preRoute) return { handled: false, reason: 'pré-rota desligada' };
    if (p.skipCodeSearch === true) return { handled: false, reason: 'ferramenta local' };
    const text = String(p.text ?? '');
    const pre = preRouteDecision(text, { direct: true });
    if (!pre.explicit) return { handled: false, reason: pre.reason };
    const out = await runEntryResearch({ ...p, text, query: pre.query, reason: 'pré-rota' }, cfg, deps);
    logger.info(`[Pesquisa] entrada fora da fila: pré-rota tipo=${out.kind} privado=${p.sensitive === true ? 'sim' : 'nao'}`);
    return { handled: true, ...out };
  } catch (err) {
    logger.warn(`[Pesquisa] pré-rota fora da fila falhou: ${errorTag(err)}`);
    return { handled: false, reason: 'erro' };
  }
}

/**
 * Portas C e D sobre a resposta que o modelo deu. `p`: { reply, text (SÓ a fala do autor), sensitive, isOwner, privateBlocked, userId, guildId,
 * channelId, progress, hadAction (uma ação real já aconteceu), usedSearch (a busca automática já pôs a web no prompt), searchIfExplicit (sem
 * ferramentas: pedido explícito sem promessa também é pesquisado), appMode (a troca da guarda final diz que não deu para pesquisar),
 * regenerate: async (prompt) => texto|'' (pede UMA resposta final ao modelo, sem ferramentas),
 * searchFailure (o motivo da busca automática do generateResponse que JÁ foi tentada e não deu certo: o agente não pesquisa de novo, só diz o motivo; searchRetryAfterMs: daqui a quanto tempo tentar),
 * regenerateWithWeb: async (prompt) => texto|'' (a busca automática trouxe a web mas a síntese só prometeu: nova resposta COM a mesma web, sem pesquisar de novo),
 * rejectToolJson (resposta que ainda for JSON de ferramenta cru é trocada pelo aviso: o /yui e o +yui nunca executam ferramentas) }.
 * @returns {Promise<{text, researched, kind, private, historyLine, guarded, action, reason}>} `guarded`: a guarda final trocou uma promessa pelo aviso.
 */
export async function reviewResearchReply(p = {}, deps = {}) {
  const original = String(p.reply ?? '');
  const out = { text: original, researched: false, kind: null, private: false, historyLine: null, guarded: false, action: 'none', reason: '' };
  if (!original.trim()) return out;
  const text = String(p.text ?? '');
  const sensitive = p.sensitive === true;
  const isOwner = p.isOwner === true;
  let reply = original;
  let hadAction = p.hadAction === true;
  const cfg = readCfg(deps);

  // Porta C: a resposta só PROMETE (ou o pedido explícito ficou sem pesquisa): pesquisar, rotear, recusar, perguntar ou pedir a resposta final.
  if (cfg.enabled && cfg.guard !== 'off' && !hadAction && p.usedSearch !== true) {
    try {
      const privateOk = sensitive && p.privateBlocked !== true && privateSearchAllowed(cfg.privateSearch, { isOwner });
      let plan = recoveryPlan({ reply, userText: text, sensitive, privateSearch: privateOk, searchAvailable: true, voice: false, direct: true });
      if (plan.action === 'none' && p.searchIfExplicit === true && p.skipCodeSearch !== true && (!sensitive || privateOk)) {
        const pre = preRouteDecision(text, { direct: true });
        if (pre.explicit) plan = { action: 'search', query: pre.query, private: sensitive, reason: 'pedido explícito (sem ferramentas)' };
      }
      // Pedido de ferramenta LOCAL do app ("pesquise o arquivo X"): o nome nunca vai a um buscador; no lugar da pesquisa, pede-se a resposta final.
      if (plan.action === 'search' && p.skipCodeSearch === true) plan = { action: 'regenerate', reason: 'ferramenta local: não pesquisa na web' };
      out.action = plan.action;
      out.reason = plan.reason ?? '';
      if (plan.action !== 'none') {
        if (cfg.guard === 'observe') {
          logger.info(`[Pesquisa] guarda (observe): acao=${plan.action} motivo=${plan.reason}`); // só metadados; a resposta fica como veio
        } else {
          logger.info(`[Pesquisa] guarda: acao=${plan.action} motivo=${plan.reason}`);
          if (plan.action === 'search' || plan.action === 'route') {
            // a ferramenta de pesquisa desligada no servidor vale também aqui (o recoveryPlan só avisa com searchAvailable false)
            const llm = await loadLlm(deps);
            if (llm.isToolDisabled(p.guildId ?? null, 'search_web')) {
              reply = SEARCH_DISABLED_REPLY;
              hadAction = true;
              out.action = 'refuse';
            } else if (plan.action === 'route') {
              reply = await currencyAnswer(plan.args, deps);
              hadAction = true;
            } else if (plan.action === 'search' && p.searchFailure) {
              // A busca automática do generateResponse JÁ foi tentada e não deu certo (e o modelo prometeu pesquisar mesmo assim): pesquisar de novo gastaria a cota
              // duas vezes no mesmo pedido (3 buscas). O usuário recebe o motivo.
              reply = failureMessage(SEARCH_FAILURE_CODES[p.searchFailure] ?? 'providers_error', { retryAfterMs: Number(p.searchRetryAfterMs) || 0 });
              hadAction = true;
              out.action = 'refuse';
              out.reason = 'busca automática já tentada e sem resultado';
            } else {
              const found = await runEntryResearch({ ...p, text, query: plan.query, intent: plan.intent, reason: plan.reason }, cfg, { ...deps, llm });
              reply = found.text;
              hadAction = true;
              if (found.researched) Object.assign(out, { researched: true, kind: found.kind, private: found.private, historyLine: found.historyLine });
            }
          } else if (plan.action === 'refuse' || plan.action === 'ask') {
            reply = plan.message;
            hadAction = true;
          } else if (plan.action === 'regenerate' && typeof p.regenerate === 'function' && text) {
            // UMA nova resposta, sem ferramentas. Se ainda vier promessa, a guarda final (Porta D) troca pelo aviso.
            const again = String((await p.regenerate(buildNoPromiseRetryPrompt(text))) ?? '').trim();
            if (again && !/^\s*[{[]/.test(again)) reply = again;
          }
        }
      }
    } catch (err) {
      logger.warn(`[Pesquisa] guarda de promessa fora da fila falhou: ${errorTag(err)}`);
    }
  }

  // A busca automática do generateResponse trouxe a web, mas a síntese só PROMETEU ("vou analisar os resultados..."): pede a resposta final COM a mesma web (sem
  // pesquisar de novo). Sem isto a guarda final trocaria a resposta pelo pedido de desculpas e os links já achados se perderiam.
  if (cfg.enabled && cfg.guard === 'on' && !hadAction && p.usedSearch === true && typeof p.regenerateWithWeb === 'function') {
    try {
      if (detectUnfulfilledPromise(reply).promise) {
        const again = String((await p.regenerateWithWeb(buildNoPromiseRetryPrompt(text))) ?? '').trim();
        out.action = 'regenerate';
        out.reason = 'busca automática trouxe a web, mas a síntese só prometeu';
        logger.info('[Pesquisa] guarda: a síntese da busca automática só prometeu; nova resposta com a mesma web');
        if (again && !isRawToolLeak(again) && !/^\s*[{[]/.test(again)) reply = again;
      }
    } catch (err) {
      logger.warn(`[Pesquisa] nova resposta com a web falhou: ${errorTag(err)}`);
    }
  }

  // Porta D: uma resposta que ainda é SÓ promessa, sem ação nenhuma, nunca vai ao usuário. Promessa que FECHA uma resposta com conteúdo perde só essa frase.
  if (cfg.guard !== 'off') {
    try {
      const guardInput = { hadAction: hadAction || out.researched, userNeedsAnswer: userNeedsAnswer(text) };
      if (cfg.guard === 'observe') {
        const seen = inspectFinalGuard(reply, guardInput);
        if (seen.replace) logger.info(`[Pesquisa] guarda final (observe): trocaria a resposta (motivo=${seen.reason} tipo=${seen.kind ?? '-'} forca=${seen.strength ?? '-'})`);
        else if (seen.trim) logger.info(`[Pesquisa] guarda final (observe): tiraria a promessa que fecha a resposta (tipo=${seen.kind ?? '-'} forca=${seen.strength ?? '-'})`);
      } else {
        const guarded = finalGuardDetailed(reply, guardInput);
        if (guarded.action === 'replace') {
          let replaced = guarded.text;
          if (p.appMode === true && detectSearchRequest(text).wanted) replaced = replaced.replace(PROMISE_ONLY_FALLBACK, APP_NO_SEARCH_REPLY);
          logger.info('[Pesquisa] guarda final: a resposta era só uma promessa e foi trocada pelo aviso');
          out.guarded = true;
          reply = replaced;
        } else if (guarded.action === 'trim') {
          logger.info('[Pesquisa] guarda final: a resposta fechava com uma promessa de pesquisa; só essa frase saiu');
          reply = guarded.text;
        }
      }
    } catch (err) {
      logger.warn(`[Pesquisa] guarda final fora da fila falhou: ${errorTag(err)}`);
    }
  }

  // O /yui e o +yui nunca executam ferramentas: JSON de ferramenta cru ({"tool":...}, {}, cerca vazia) não é resposta.
  if (p.rejectToolJson === true && cfg.guard !== 'off' && !out.researched && isRawToolLeak(reply)) {
    const size = reply.length;
    if (cfg.guard === 'observe') {
      logger.info(`[Pesquisa] guarda (observe): a resposta é JSON de ferramenta cru ou vazio (${size} caracteres); seria trocada pelo aviso`);
    } else {
      logger.warn(`[Pesquisa] a resposta ainda era JSON de ferramenta cru ou vazio (${size} caracteres): trocada pelo aviso`);
      out.guarded = true;
      reply = RAW_TOOL_REPLY;
    }
  }
  out.text = reply;
  return out;
}

// ── App / API ──
// O app é uma conversa 1:1 PRIVADA (equivale a uma DM) para qualquer usuário: vale o YUI_PRIVATE_SEARCH (off | owner | all). Chamada sempre direta à Yui.

// O agente do app tem ferramentas LOCAIS (arquivos, projetos, programas, comandos do computador, estado do sistema): "pesquise o arquivo X" é delas, não
// da web (e o nome de um arquivo do dono não deve ir a um buscador). Pedido que fala dessas coisas nunca é roteado nem pesquisado por código.
// ("meu/minha ... arquivo, pasta, projeto, programa, pc..." ou "procure/pesquise/busque o arquivo/a pasta"). Estreito de propósito: "pesquise o preço da RAM" segue para a web.
const LOCAL_TOOL_HINT = /\b(?:meus?|minhas?|nossos?|nossas?)\s+(?:\w+\s+){0,2}(?:arquivos?|pastas?|diretorios?|projetos?|programas?|aplicativos?|apps?|computador|pc|disco|sistema|cpu|ram)\b|\b(?:procur|busc|pesquis|ach|encontr)\w*\s+(?:(?:o|a|os|as|um|uma|por|pelo|pela)\s+)?(?:arquivos?|pastas?|diretorios?)\b/;
const looksLikeLocalTool = (text) => LOCAL_TOOL_HINT.test(norm(clipInput(text)));

/** Entrada do app para as portas acima. `AI_PRIVATE_LOCAL_ONLY=true` com memória pessoal em jogo também fecha a pesquisa privada (o texto sairia para a nuvem). */
function appEntry(ctx, text) {
  const localOnly = String(process.env.AI_PRIVATE_LOCAL_ONLY || 'false').toLowerCase() === 'true' && ctx?.memoryScope === 'personal';
  return {
    text: String(text ?? ''), sensitive: true, isOwner: ctx?.role === 'OWNER', privateBlocked: localOnly,
    userId: ctx?.userId ?? null, guildId: null, channelId: null, appMode: true, searchIfExplicit: true,
    skipCodeSearch: looksLikeLocalTool(text),
  };
}

/** Porta A do app. @see routeExplicitResearch */
export function appResearchRoute({ ctx, text } = {}, deps = {}) {
  return routeExplicitResearch(appEntry(ctx, text), deps);
}

/** Portas C e D do app sobre a resposta do modelo (a "nova resposta" pede ao MESMO backend, sem ferramentas). @see reviewResearchReply */
export function appReviewReply({ ctx, text, reply, history = [], memoryBlock = '' } = {}, deps = {}) {
  const cfg = readCfg(deps);
  return reviewResearchReply({
    ...appEntry(ctx, text), reply,
    regenerate: (prompt) => chat({ prompt, history, ctx, memoryBlock, deadlineAt: Date.now() + (Number(cfg.totalDeadlineMs) || 60_000) }),
  }, deps);
}

/**
 * Um turno de conversa do app (POST /v1/chat): pré-rota -> modelo -> guarda de promessa. Devolve { text, researched, historyLine, kind, guarded }.
 * `historyLine`: o que vai ao histórico em RAM no lugar da resposta quando ela veio de uma pesquisa (linha curta e neutra, nunca o texto da web).
 * `text` é SÓ a fala do usuário (padrão: o próprio prompt).
 */
export async function chatTurn({ prompt, history = [], ctx, memoryBlock = '', text = prompt } = {}, deps = {}) {
  const routed = await appResearchRoute({ ctx, text }, deps);
  if (routed.handled) return routed;
  const reply = await chat({ prompt, history, ctx, memoryBlock });
  return appReviewReply({ ctx, text, reply, history, memoryBlock }, deps);
}

// ───────────────────────── Backends embutidos ─────────────────────────

function registerLegacyChain() {
  registerBackend({
    name: 'legacy-chain',
    local: false,
    async chat({ prompt, system, history, ctx, memoryBlock, deadlineAt }) {
      const { generateResponse } = await import('../../handlers/llmHandler.js');
      // A cadeia legada guarda histórico por canal do Discord, que não existe
      // aqui: o histórico da conversa vai no próprio prompt.
      const transcript = history.length
        ? history.map((m) => `${m.role === 'assistant' ? 'Você (Yui)' : 'Usuário'}: ${m.content}`).join('\n')
        : '';
      const finalPrompt = transcript
        ? `[CONVERSA ATÉ AGORA]\n${transcript}\n\n[MENSAGEM ATUAL DO USUÁRIO]\n${prompt}`
        : prompt;
      return generateResponse(finalPrompt, `api:${ctx?.userId || 'anon'}`, {
        userId: ctx?.userId,
        memoryBlock,
        persona: system || undefined,
        sensitive: ctx?.memoryScope === 'personal',
        // O app não tem ferramentas nem a busca automática da cadeia: a pesquisa na web, quando existe, é do agente (ver
        // chatTurn abaixo), que decide por código e roda FORA daqui. Aqui a cadeia só conversa.
        allowSearch: false,
        disableTools: true,
        guildId: null,
        ...(deadlineAt ? { deadlineAt } : {}),
      });
    },
  });
}

/**
 * Backend "openai-compatible": LM Studio, llama.cpp server, OmniRoute,
 * OpenRouter, Groq... Configurado por AI_BASE_URL, AI_API_KEY e AI_MODEL.
 *
 * AI_BASE_LOCAL=true deve ser marcado SOMENTE se o modelo realmente roda na
 * sua máquina. Um gateway local (ex.: OmniRoute) que encaminha para
 * provedores de nuvem NÃO é local, e por isso não é inferido pelo endereço.
 */
function registerOpenAiCompatible() {
  const baseUrl = (process.env.AI_BASE_URL || '').trim().replace(/\/+$/, '');
  if (!baseUrl) return;
  const endpoint = baseUrl.endsWith('/chat/completions') ? baseUrl : `${baseUrl}/chat/completions`;
  registerBackend({
    name: 'openai-compatible',
    local: String(process.env.AI_BASE_LOCAL || 'false').toLowerCase() === 'true',
    async chat({ prompt, system, history, memoryBlock }) {
      const persona = system || process.env.AI_SYSTEM_PROMPT ||
        'Você é a Yui, prestativa, direta e simpática. Não se apresente como assistente, IA ou bot. Responda em português do Brasil.';
      const messages = [
        { role: 'system', content: persona + (memoryBlock || '') },
        ...history.map((m) => ({ role: m.role, content: m.content })),
        { role: 'user', content: prompt },
      ];
      const headers = { 'Content-Type': 'application/json' };
      if (process.env.AI_API_KEY) headers.Authorization = `Bearer ${process.env.AI_API_KEY}`;
      const { data } = await axios.post(
        endpoint,
        {
          model: process.env.AI_MODEL || undefined,
          messages,
          max_tokens: parseInt(process.env.AI_MAX_TOKENS || '1500', 10),
        },
        { headers, timeout: 90_000 }
      );
      const text = data?.choices?.[0]?.message?.content;
      if (!text || !String(text).trim()) throw new Error('Resposta vazia do backend openai-compatible');
      return String(text).trim();
    },
  });
}

/**
 * Backend "gateway": o Yui Gateway em processo (failover entre Groq, Gemini, HF...).
 * Conversas com contexto pessoal nunca vão a provedores anônimos.
 */
function registerGateway() {
  registerBackend({
    name: 'gateway',
    local: false,
    async chat({ prompt, system, history, ctx, memoryBlock }) {
      const { getGateway } = await import('../../gateway/index.js');
      const persona = system || process.env.AI_SYSTEM_PROMPT ||
        'Você é a Yui, prestativa, direta e simpática. Não se apresente como assistente, IA ou bot. Responda em português do Brasil.';
      const result = await getGateway().chat({
        model: process.env.AI_MODEL || 'auto',
        messages: [
          { role: 'system', content: persona + (memoryBlock || '') },
          ...history.map((m) => ({ role: m.role, content: m.content })),
          { role: 'user', content: prompt },
        ],
        max_tokens: parseInt(process.env.AI_MAX_TOKENS || '1500', 10),
      }, { sensitive: ctx?.memoryScope === 'personal' });
      const text = result?.choices?.[0]?.message?.content;
      if (!text || !String(text).trim()) throw new Error('Resposta vazia do gateway');
      return String(text).trim();
    },
  });
}

/** (Re)carrega os backends embutidos e aplica AI_BACKEND. Útil em testes. */
export function initAiManager() {
  backends.clear();
  activeName = null;
  registerLegacyChain();
  registerOpenAiCompatible();
  registerGateway();
  const wanted = (process.env.AI_BACKEND || '').trim();
  if (wanted) {
    if (backends.has(wanted)) activeName = wanted;
    else logger.warn(`[AI] AI_BACKEND="${wanted}" não encontrado; mantendo "${activeName}".`);
  }
}

initAiManager();
