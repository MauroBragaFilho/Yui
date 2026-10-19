import dotenv from 'dotenv';
import { searchWeb } from '../search/providers.js';
import { getDefaultBudget } from '../search/budget.js';
import { fetchPage, UNTRUSTED_WEB_MARK } from '../search/safeFetch.js';
import { logger } from '../utils/logger.js';
import { detectSearchRequest, preRouteDecision, saneQuery } from './searchIntent.js';
import { classifyFailure, failureMessage, scrubQuery } from './researchAgent.js';
dotenv.config();
const SEARCH_CONFIG = {
    MAX_RESULTS_SCRAPE: 8,
    MAX_DEEP_READ: 3,
    MIN_CONTENT_LENGTH: 100,
    MAX_CONTENT_LENGTH: 2000,
    TIMEOUT_MS: 6000,
    DOMAIN_BLACKLIST: [
        'facebook.com', 'instagram.com', 'twitter.com', 'tiktok.com',
        'amazon.com', 'mercadolivre.com.br', 'shopee.com.br',
        'orders.google.com', 'myaccount.google.com', 'accounts.google.com'
    ],
    DOMAIN_WHITELIST: [
        'wikipedia.org', 'stackoverflow.com', 'github.com',
        'g1.globo.com', 'uol.com.br', 'techtudo.com.br',
        'cnnbrasil.com.br', 'bbc.com', 'mcpedl.com'
    ]
};
// Palavras que, SOZINHAS e INTEIRAS (sem acento, minúsculas), pedem uma pesquisa. Palavras genéricas
// ("como", "qual", "quem", "quanto", "check") ficaram de fora: abriam o gate em quase toda frase.
const SEARCH_TRIGGERS = new Set([
    'pesquise', 'pesquisa', 'pesquisar', 'procure', 'procurar', 'busque', 'buscar',
    'search', 'google', 'consulte', 'consultar', 'verifique'
]);
// A pergunta do usuário pode ter milhares de caracteres: o otimizador de busca (e o fallback) só recebem o começo.
const MAX_QUESTION_CHARS = 500;
// A consulta que vai ao buscador (de terceiros) nunca passa disto.
const MAX_QUERY_CHARS = 200;
// A resposta do otimizador é lida até aqui (o resto é ignorado: evita varrer texto enorme).
const MAX_OPTIMIZER_REPLY_CHARS = 4000;
// Erro de teto global: o agente de pesquisa reconhece "teto global" no texto e `limited: 'global'` no retorno.
const GLOBAL_LIMIT_ERROR = 'teto global de buscas por hora atingido';
function clipQuestion(text, max = MAX_QUESTION_CHARS) {
    const s = String(text ?? '');
    if (s.length <= max) return s;
    let out = s.slice(0, max);
    const last = out.charCodeAt(out.length - 1);
    if (last >= 0xD800 && last <= 0xDBFF) out = out.slice(0, -1); // não deixa meio par substituto no fim
    return out;
}
function wordsOf(text) {
    return String(text ?? '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').match(/[a-z0-9]+/g) ?? [];
}
function hasSearchTrigger(prompt) {
    return wordsOf(prompt).some(w => SEARCH_TRIGGERS.has(w));
}
function hostOf(link) {
    try {
        return new URL(link).hostname;
    } catch (e) {
        return 'invalido';
    }
}
// Domínio da lista negra? Compara o host (e subdomínios), não um pedaço qualquer da URL.
function isBlacklisted(link) {
    if (link === '#quick-answer') return false;
    const host = hostOf(link).toLowerCase();
    return SEARCH_CONFIG.DOMAIN_BLACKLIST.some(d => host === d || host.endsWith('.' + d));
}
// Só o tipo do erro e o código (nunca a mensagem: ela pode repetir texto do pedido) vão para o log.
function errorTag(err) {
    const name = String(err?.name || 'Error').slice(0, 40);
    const code = err?.code || err?.cause?.code || err?.status || err?.response?.status || '';
    return code ? `${name} ${String(code).slice(0, 30)}` : name;
}

// ---------------------------------------------------------------------------------------------
// Motivo da falha de uma busca (cota, tempo, bloqueio...) para quem monta a mensagem ao usuário
// ---------------------------------------------------------------------------------------------

// Causa de CADA erro devolvido pelo providers.js (texto "<provedor>: <erro>"). 'quota' junta cota e limite de taxa (HTTP 429).
const CAUSE_RULES = [
    ['quota', /cota mensal|\bhttp (?:402|429|432|433)\b/],
    ['resting', /descansando/],
    ['timeout', /tempo esgotado|prazo total/],
    ['cancelled', /(?:^|: )cancelado$/],
    ['blocked', /bloqueio|desafio|\bhttp (?:202|401|403)\b/]
];
function causeOfError(error) {
    const text = String(error ?? '').toLowerCase();
    if (/sem resultados/.test(text)) return 'none';
    for (const [cause, re] of CAUSE_RULES) if (re.test(text)) return cause;
    return 'network';
}
/**
 * Por que a busca não rendeu? Usa o MESMO vocabulário do agente de pesquisa (classifyFailure/failureMessage do researchAgent.js):
 *   reason: 'ok' | 'user_limited' | 'global_limited' | 'sensitive' | 'deadline' | 'no_providers' | 'providers_rest' | 'no_results' | 'providers_error'
 *   cause (o tipo concreto): 'quota' (cota mensal ou limite do provedor) | 'resting' (em descanso) | 'timeout' (tempo) | 'blocked' (bloqueio/desafio)
 *     | 'network' (erro de rede/servidor) | 'cancelled' | 'mixed' (vários tipos) | 'user' | 'global' | 'sensitive' | 'none' | '' (ok)
 * @param {{ results?: any[], errors?: string[], limited?: string, retryAfterMs?: number }} found retorno do searchWeb
 * @returns {{ ok: boolean, reason: string, cause: string, causes: string[], retryAfterMs: number, message: string }}
 */
function classifySearchOutcome(found) {
    const results = Array.isArray(found?.results) ? found.results : [];
    if (results.length) return { ok: true, reason: 'ok', cause: '', causes: [], retryAfterMs: 0, message: '' };
    const errors = (Array.isArray(found?.errors) ? found.errors : []).map((e) => String(e).slice(0, 200));
    const limited = found?.limited === 'user' || found?.limited === 'global' ? found.limited : null;
    const retryAfterMs = Number(found?.retryAfterMs) > 0 ? Number(found.retryAfterMs) : 0;
    const reason = classifyFailure(errors, { limited });
    const causes = [...new Set(errors.map(causeOfError))].filter((c) => c !== 'none');
    let cause;
    if (limited) cause = limited;
    else if (reason === 'sensitive') cause = 'sensitive';
    else if (reason === 'deadline') cause = 'timeout';
    else if (reason === 'no_results' || reason === 'no_providers') cause = 'none';
    else cause = causes.length === 1 ? causes[0] : (causes.length ? 'mixed' : 'none');
    return { ok: false, reason, cause, causes, retryAfterMs, message: failureMessage(reason, { retryAfterMs }) };
}

// ---------------------------------------------------------------------------------------------
// Otimizador de busca (um modelo transforma o pedido numa consulta): entrada limpa, sem ferramentas, sem histórico
// ---------------------------------------------------------------------------------------------

function buildOptimizerPrompt(question, year, tried = []) {
    const triedRule = tried.length ? `\n7. Estas consultas JÁ foram tentadas e não renderam; escreva uma DIFERENTE: ${tried.join(' | ')}` : '';
    return `
[SYSTEM]
Você é um Otimizador de Busca SearchEngine (SEO).
Sua missão: Transformar o pedido do usuário em uma QUERY PERFEITA para um buscador (Brave/Google).
ENTRADA: "${question}"
REGRAS:
1. Ignore saudações e polidez ("por favor", "bom dia").
2. Identifique o NÚCLEO da busca (O que o usuário quer saber?).
3. Converta para palavras-chave diretas (se for técnico, prefira inglês).
4. Se for notícias/fatos, adicione o ano atual (${year}).
5. REMOVA ASPAS da resposta final.
6. NUNCA inclua e-mail, telefone, CPF, senha, chave ou outro dado pessoal na consulta.${triedRule}
SAÍDA (Apenas uma linha):
SIM: termo da busca
ou
NAO
`;
}
// Tira o raciocínio que alguns modelos escrevem antes da resposta (<think>...</think>, bloco aberto e nunca fechado, só o fecho).
function stripReasoning(text) {
    return String(text ?? '').slice(0, MAX_OPTIMIZER_REPLY_CHARS)
        .replace(/<(think|thinking|thought|reasoning)>[\s\S]*?<\/\1>/gi, ' ')
        .replace(/<(?:think|thinking|thought|reasoning)>[\s\S]*$/i, ' ')
        .replace(/^[\s\S]*<\/(?:think|thinking|thought|reasoning)>/i, ' ')
        .replace(/<ctrl\d+>/gi, ' ')
        .trim();
}
// Primeiro objeto JSON balanceado do texto (sem regex gulosa: "{...} texto com {chaves}" não quebra). null se não houver.
function firstJsonObject(text) {
    const s = String(text ?? '');
    let tried = 0;
    for (let start = s.indexOf('{'); start !== -1 && tried < 5; start = s.indexOf('{', start + 1), tried++) {
        let depth = 0;
        let inString = false;
        let escaped = false;
        for (let i = start; i < s.length; i++) {
            const ch = s[i];
            if (inString) {
                if (escaped) escaped = false;
                else if (ch === '\\') escaped = true;
                else if (ch === '"') inString = false;
                continue;
            }
            if (ch === '"') inString = true;
            else if (ch === '{') depth++;
            else if (ch === '}') {
                depth--;
                if (depth === 0) {
                    try { return JSON.parse(s.slice(start, i + 1)); } catch (e) { break; }
                }
            }
        }
    }
    return null;
}
const SEARCH_TOOL_NAMES = new Set(['search_web', 'web_search', 'google_search', 'pesquisar', 'pesquisa_web', 'search']);
const QUERY_KEYS = ['query', 'q', 'search', 'consulta', 'term', 'termo'];
function queryFromArgs(args) {
    let a = args;
    if (typeof a === 'string') {
        try { a = JSON.parse(a); } catch (e) { return ''; }
    }
    if (!a || typeof a !== 'object') return '';
    for (const key of QUERY_KEYS) {
        const v = Array.isArray(a[key]) ? a[key].find((x) => typeof x === 'string') : a[key];
        if (typeof v === 'string' && v.trim()) return v;
    }
    return '';
}
// Chamada da ferramenta search_web em JSON (o modelo do otimizador recebeu ferramentas ou escreveu a chamada no texto): devolve a consulta.
function queryFromToolJson(obj) {
    if (!obj || typeof obj !== 'object') return '';
    const wrapped = obj.search_web ?? obj.web_search ?? obj.google_search;
    if (wrapped) return queryFromArgs(wrapped);
    const name = String(obj.tool ?? obj.name ?? obj.tool_name ?? obj.function?.name ?? obj.action ?? '').toLowerCase();
    if (!SEARCH_TOOL_NAMES.has(name)) return '';
    return queryFromArgs(obj.args ?? obj.arguments ?? obj.parameters ?? obj.action_input ?? obj.function?.arguments ?? obj.input ?? obj);
}
/**
 * Lê a resposta do otimizador. kind: 'search' (query, source 'sim' | 'json') | 'no' (NAO) | 'unclear' | 'empty'.
 * "SIM:" vale em QUALQUER ponto do texto ("Claro! SIM: ..."), depois de ignorar o bloco de raciocínio; JSON de search_web também vale.
 */
function parseOptimizerReply(text) {
    const clean = stripReasoning(text);
    if (!clean) return { kind: 'empty' };
    const fromJson = queryFromToolJson(firstJsonObject(clean));
    if (fromJson) return { kind: 'search', query: fromJson, source: 'json' };
    const flat = clean.replace(/["`*]/g, '');
    const sim = /(?<![\p{L}\p{N}_])SIM\s*:\s*([^\r\n]*)/iu.exec(flat);
    if (sim) return { kind: 'search', query: sim[1].trim(), source: 'sim' };
    const firstLine = flat.split(/\r?\n/).find((l) => l.trim()) ?? '';
    if (/^[^\p{L}\p{N}]*N(?:AO|ÃO)(?![\p{L}\p{N}])/iu.test(firstLine)) return { kind: 'no' };
    return { kind: 'unclear' };
}
const PLACEHOLDER_QUERY = /\btermo (?:da|de|para a) busca\b/i;
// Consulta que pode ir a um buscador de terceiros: aceitável (sem URL/JSON/modelo de formato), sem dado pessoal/segredo e sem palavra proibida.
function checkedQuery(raw, forbiddenKeywords) {
    const sane = saneQuery(raw, MAX_QUERY_CHARS);
    if (!sane || PLACEHOLDER_QUERY.test(sane)) return { ok: false, reason: 'bad_query' };
    const scrubbed = scrubQuery(sane, { forbiddenKeywords, max: MAX_QUERY_CHARS });
    if (!scrubbed.ok) return { ok: false, reason: scrubbed.reason };
    const final = saneQuery(scrubbed.query, MAX_QUERY_CHARS);
    return final ? { ok: true, query: final } : { ok: false, reason: 'bad_query' };
}
const OPTIMIZER_SYSTEM = 'Responda apenas com o comando solicitado.';
// O otimizador nunca recebe ferramentas nem histórico: só a pergunta já limpa. As funções dos provedores leem options.history e options.disableTools.
const optimizerOptions = () => ({ disableTools: true, history: [] });

/**
 * Decide se (e o que) pesquisar a partir da fala do usuário.
 *  1. Porta: precisa de palavra de pesquisa ou de pedido explícito, e NÃO pode ser negação ("não pesquise"), "como pesquisar",
 *     "vou pesquisar" ou pergunta de capacidade (detectSearchRequest). Nesses casos o otimizador nem é chamado.
 *  2. A pergunta é limpa (sem menção, código nem link) e BLOQUEIA se tiver dado pessoal/segredo ou palavra proibida (forbiddenKeywords).
 *  3. O otimizador recebe só essa pergunta limpa (até 500 caracteres), sem ferramentas e sem histórico.
 *  4. A consulta final (do otimizador ou, se ele falhar/disser NAO num pedido EXPLÍCITO, tirada do próprio pedido) passa de novo
 *     pela limpeza antes de ir ao buscador.
 * @returns {{ shouldSearch: boolean, query: string|null, reason: string, source: string }}
 */
async function decideSearch(prompt, providerFunc, { now = Date.now, forbiddenKeywords = null, log = logger, tried = [] } = {}) {
    const no = (reason) => ({ shouldSearch: false, query: null, reason, source: '' });
    const req = detectSearchRequest(prompt, { now: new Date(now()) });
    if (req.blocked) return no(`blocked_${req.blocked}`);
    if (!hasSearchTrigger(prompt) && !req.explicit) return no('no_trigger');
    const cleaned = scrubQuery(clipQuestion(prompt), { forbiddenKeywords, max: MAX_QUESTION_CHARS });
    if (!cleaned.ok) {
        log.warn(`[Search] pedido barrado antes de pesquisar (${cleaned.reason}: ${cleaned.detail})`);
        return no(cleaned.reason);
    }
    if (!cleaned.query) return no('no_trigger');
    const year = new Date(now()).getFullYear();
    let parsed = { kind: 'error' };
    try {
        log.info('[Search] analisando intenção de busca');
        const reply = await providerFunc(buildOptimizerPrompt(cleaned.query, year, tried), OPTIMIZER_SYSTEM, optimizerOptions());
        parsed = parseOptimizerReply(reply?.text);
    } catch (err) {
        log.warn(`[Search] otimizador de busca falhou (${errorTag(err)})`);
    }
    if (parsed.kind === 'search') {
        const checked = checkedQuery(parsed.query, forbiddenKeywords);
        if (checked.ok) {
            log.info(`[Search] busca aprovada (consulta com ${checked.query.length} caracteres)`);
            return { shouldSearch: true, query: checked.query, reason: 'optimizer', source: parsed.source };
        }
        log.warn(`[Search] consulta do otimizador descartada (${checked.reason})`);
    }
    // Pedido EXPLÍCITO ("pesquise o preço de X") sempre pesquisa: o otimizador falhou, disse NAO ou escreveu lixo; vale a consulta tirada do
    // pedido. Só o pedido ESTRITO conta (preRouteDecision: marcador de web inequívoco, sem ferramenta própria nem música/jogo): "verifique
    // se é verdade" e afins continuam com a decisão do otimizador. Quem chama o smartSearch é sempre uma conversa DIRIGIDA à Yui.
    // (como o otimizador, o fallback só olha o começo da fala: os primeiros 500 caracteres)
    const strict = preRouteDecision(clipQuestion(prompt), { direct: true, now: new Date(now()) });
    if (strict.explicit && strict.query) {
        const checked = checkedQuery(strict.query, forbiddenKeywords);
        if (checked.ok) {
            log.info(`[Search] pedido explícito: pesquisando com a consulta tirada do pedido (${checked.query.length} caracteres)`);
            return { shouldSearch: true, query: checked.query, reason: parsed.kind === 'error' ? 'explicit_after_error' : 'explicit', source: 'explicit' };
        }
    }
    return no(parsed.kind === 'no' ? 'optimizer_no' : parsed.kind === 'error' ? 'optimizer_error' : 'optimizer_unclear');
}
async function analyzeSearchIntent(prompt, providerFunc, { now = Date.now, forbiddenKeywords = null, logger: log = logger, info = null } = {}) {
    const decision = await decideSearch(prompt, providerFunc, { now, forbiddenKeywords, log });
    if (info && typeof info === 'object') Object.assign(info, { reason: decision.reason, source: decision.source });
    return { shouldSearch: decision.shouldSearch, query: decision.query };
}
/**
 * Reescreve a consulta do AGENTE de pesquisa (que ela mesma derivou do texto literal do usuário) com o otimizador. A consulta passa por
 * scrubQuery ANTES de ir ao modelo e DEPOIS de voltar; o modelo só recebe essa consulta (e a lista das já tentadas), nunca a fala crua do
 * usuário nem histórico, e sem ferramentas. Em conversa PRIVADA (private: true) não faz nada.
 * @returns {Promise<{ ok: boolean, query: string, reason: string }>}
 */
async function optimizeQuery(query, providerFunc, { tried = [], forbiddenKeywords = null, now = Date.now, private: isPrivate = false, logger: log = logger } = {}) {
    if (isPrivate === true) return { ok: false, query: '', reason: 'private' };
    const input = checkedQuery(query, forbiddenKeywords);
    if (!input.ok) return { ok: false, query: '', reason: input.reason };
    const triedList = (Array.isArray(tried) ? tried : []).map((t) => String(t ?? '').replace(/\s+/g, ' ').trim().slice(0, 80)).filter(Boolean).slice(0, 3);
    try {
        const reply = await providerFunc(buildOptimizerPrompt(input.query, new Date(now()).getFullYear(), triedList), OPTIMIZER_SYSTEM, optimizerOptions());
        const parsed = parseOptimizerReply(reply?.text);
        if (parsed.kind !== 'search') return { ok: false, query: '', reason: parsed.kind === 'no' ? 'optimizer_no' : 'optimizer_unclear' };
        const out = checkedQuery(parsed.query, forbiddenKeywords);
        if (!out.ok) return { ok: false, query: '', reason: out.reason };
        const same = (a, b) => a.toLowerCase().replace(/\s+/g, ' ') === b.toLowerCase().replace(/\s+/g, ' ');
        if ([input.query, ...triedList].some((t) => same(t, out.query))) return { ok: false, query: '', reason: 'same_query' };
        return { ok: true, query: out.query, reason: 'optimizer' };
    } catch (err) {
        log.warn(`[Search] reescrita da consulta falhou (${errorTag(err)})`);
        return { ok: false, query: '', reason: 'optimizer_error' };
    }
}

// ---------------------------------------------------------------------------------------------
// Busca e ranqueamento
// ---------------------------------------------------------------------------------------------

function toItems(found) {
    return found.results.map((r) => (r.url === '#quick-answer'
        ? { title: 'RESPOSTA RÁPIDA', link: '#quick-answer', snippet: r.snippet, score: 999 }
        : { title: r.title, link: r.url, snippet: r.snippet || '', score: 0 }));
}
function rankAndFilterResults(rawResults, query) {
    const keywords = query.toLowerCase().split(' ').filter(w => w.length > 2);
    const validResults = [];
    rawResults.forEach(r => {
        if (r.link === "#quick-answer") {
            r.score = 999;
            validResults.push(r);
            return;
        }
        let score = 0;
        const lowerTitle = r.title.toLowerCase();
        const lowerSnippet = r.snippet.toLowerCase();
        const lowerLink = r.link.toLowerCase();
        if (isBlacklisted(r.link)) {
            return;
        }
        try {
            const urlObj = new URL(r.link);
            if ((urlObj.pathname === '/' || urlObj.pathname.length < 2) && !lowerTitle.includes(keywords[0] ?? '')) return;
            if (urlObj.pathname.includes('/login') || urlObj.pathname.includes('/signin')) return;
        } catch (e) { return; }
        keywords.forEach(kw => {
            if (lowerTitle.includes(kw)) score += 10;
        });
        keywords.forEach(kw => {
            if (lowerLink.includes(kw)) score += 15;
        });
        keywords.forEach(kw => {
            if (lowerSnippet.includes(kw)) score += 5;
        });
        if (lowerTitle.includes(query.toLowerCase())) {
            score += 20;
        }
        if (SEARCH_CONFIG.DOMAIN_WHITELIST.some(d => lowerLink.includes(d))) {
            score += 10;
        }
        if (r.link.split('/').length < 4) {
            score -= 5;
        }
        if (score > 10) {
            r.score = score;
            validResults.push(r);
        }
    });
    return validResults.sort((a, b) => b.score - a.score);
}
// Lê uma página com as proteções de safeFetch (SSRF, tamanho, prazo total, tipo de conteúdo).
// Devolve o texto útil (até MAX_CONTENT_LENGTH caracteres) ou null. Reutilizável pelo llmHandler.
// `quiet` (pesquisa PRIVADA): o log não leva nem o host da página, que denunciaria o assunto; ficam só os números.
async function fetchPageContent(url, { quiet = false, ...opts } = {}) {
    const page = await fetchPage(url, { maxChars: SEARCH_CONFIG.MAX_CONTENT_LENGTH, timeoutMs: SEARCH_CONFIG.TIMEOUT_MS, ...opts });
    const where = quiet ? 'privado' : `host=${hostOf(url)}`;
    if (!page.ok) {
        logger.warn(`[Search] leitura falhou ${where} motivo=${page.error}`);
        return null;
    }
    if (page.parse === 'timeout' || page.parse === 'error' || page.parse === 'busy') {
        // Página pesada ou hostil demais para o parse isolado: vira "sem conteúdo" (o resumo da busca é usado no lugar).
        logger.warn(`[Search] leitura sem conteúdo ${where} parse=${page.parse} ms=${page.ms}`);
    } else {
        logger.info(`[Search] leitura ${where} chars=${page.content.length} ms=${page.ms}${page.truncated ? ' (cortada)' : ''}`);
    }
    return page.content || null;
}

// ---------------------------------------------------------------------------------------------
// Contexto da web compartilhado entre os provedores de UM pedido
// ---------------------------------------------------------------------------------------------

/**
 * Memória de UM pedido (crie uma por chamada de generateResponse e passe como `memo` a cada provedor). Guarda o RESULTADO da busca
 * (inclusive o negativo: sem resultado, limite, conta já gasta): o provedor seguinte reaproveita o contexto sem chamar o
 * otimizador nem o buscador de novo (não gasta cota do usuário duas vezes) e sem que a busca já feita se perca para quem não
 * "suporta busca". Só uma falha do próprio otimizador NÃO é guardada (o próximo provedor pode decidir melhor).
 */
function createWebContextMemo() {
    return { done: false, result: null };
}

/**
 * Busca de ponta a ponta (o caminho do /yui): porta -> pergunta limpa -> otimizador -> buscador -> ranking -> leitura -> contexto.
 * NUNCA lança. Devolve sempre o motivo, para quem chama avisar o modelo/usuário em vez de a Yui prometer pesquisar e não fazer.
 * @param {string} prompt fala do usuário (use só a fala do PRÓPRIO autor, nunca o bloco de contexto do canal)
 * @param {Function} providerFunc função do provedor de IA que roda o otimizador
 * @param {object} [opts] userId, sensitive (true = não pesquisa), forbiddenKeywords (moderação), memo (createWebContextMemo), signal, now, logger,
 *   e para teste: searchImpl, readPage
 * @returns {Promise<{ context: string|null, reason: string, cause: string, query: string, count: number, provider: string|null, retryAfterMs: number, message: string, reused: boolean }>}
 *   reason: 'ok' | 'sensitive' | 'no_trigger' | 'blocked_negated|howto|capability|statement' | 'sensitive_data' | 'forbidden' | 'optimizer_no|unclear|error'
 *     | 'user_limited' | 'global_limited' | 'deadline' | 'no_providers' | 'providers_rest' | 'providers_error' | 'no_results' | 'filtered' | 'no_content' | 'error'
 *   `query` é a consulta já limpa: use para decisão, NUNCA no log.
 */
async function smartSearchDetailed(prompt, providerFunc, { userId = null, sensitive = false, searchImpl = searchWeb, readPage = fetchPageContent, now = Date.now, forbiddenKeywords = null, memo = null, signal = null, logger: log = logger } = {}) {
    const result = (extra) => ({ context: null, reason: '', cause: '', query: '', count: 0, provider: null, retryAfterMs: 0, message: '', reused: false, ...extra });
    // Conversa sensível: a consulta sairia para terceiros (buscadores). Não pesquisa.
    if (sensitive === true) return result({ reason: 'sensitive', cause: 'sensitive' });
    if (memo?.done && memo.result) {
        log.info('[Search] reaproveitando o resultado da busca deste pedido');
        return { ...memo.result, reused: true };
    }
    const remember = (r, { keep = true } = {}) => {
        if (memo && keep) {
            memo.done = true;
            memo.result = { ...r };
        }
        return r;
    };
    try {
        const decision = await decideSearch(prompt, providerFunc, { now, forbiddenKeywords, log });
        if (!decision.shouldSearch) {
            const barred = decision.reason === 'sensitive_data' || decision.reason === 'forbidden';
            return remember(result({ reason: decision.reason, message: barred ? failureMessage(decision.reason) : '' }), { keep: decision.reason !== 'optimizer_error' });
        }
        const query = decision.query;
        let found;
        try {
            found = await searchImpl(query, { max: SEARCH_CONFIG.MAX_RESULTS_SCRAPE, userId, sensitive, ...(signal ? { signal } : {}) });
        } catch (err) {
            log.warn(`[Search] a busca lançou erro (${errorTag(err)})`);
            return remember(result({ reason: 'providers_error', cause: 'network', query, message: failureMessage('providers_error') }));
        }
        const outcome = classifySearchOutcome(found);
        if (!outcome.ok) {
            log.warn(`[Search] sem resultados (${(Array.isArray(found?.errors) ? found.errors : []).join('; ') || 'nenhum provedor'})`);
            return remember(result({ reason: outcome.reason, cause: outcome.cause, query, retryAfterMs: outcome.retryAfterMs, message: outcome.message }));
        }
        log.info(`[Search] ${found.provider}: ${found.results.length} resultados`);
        const rawResults = toItems(found);
        const bestResults = rankAndFilterResults(rawResults, query);
        log.info(`[Search] funil: ${rawResults.length} brutos -> ${bestResults.length} filtrados`);
        if (bestResults.length === 0) {
            // Fallback: os 2 primeiros brutos, mas a lista negra de domínios continua valendo.
            const fallback = rawResults.filter(r => !isBlacklisted(r.link)).slice(0, 2);
            log.warn(`[Search] filtro removeu tudo; fallback bruto com ${fallback.length} resultado(s)`);
            fallback.forEach(r => bestResults.push(r));
        }
        if (bestResults.length === 0) return remember(result({ reason: 'filtered', query, provider: found.provider ?? null }));
        const targets = bestResults.slice(0, SEARCH_CONFIG.MAX_DEEP_READ);
        log.info(`[Search] sites selecionados para leitura: ${targets.map(t => `${hostOf(t.link)}(${t.score})`).join(', ')}`);
        const deepContents = await Promise.all(
            targets.map(async (r) => {
                if (r.link === "#quick-answer") return `[RESPOSTA RÁPIDA]: ${r.snippet}`;
                const content = await readPage(r.link);
                if (!content) return `[FONTE (Resumo): ${r.title}]\nURL: ${r.link}\nRESUMO (Site bloqueado/erro): ${r.snippet}\n--------------------`;
                return `[FONTE: ${r.title}]\nURL: ${r.link}\nCONTEÚDO: ${content}\n--------------------`;
            })
        );
        const finalContext = deepContents.filter(c => c).join('\n\n');
        log.info(`[Search] contexto gerado: ${finalContext.length} chars (~${Math.ceil(finalContext.length / 4)} tokens)`);
        if (finalContext.length === 0) return remember(result({ reason: 'no_content', query, provider: found.provider ?? null }));
        // Texto da web é DADO, nunca instrução: o contexto já sai marcado.
        return remember(result({ context: `${UNTRUSTED_WEB_MARK}\n${finalContext}`, reason: 'ok', query, count: targets.length, provider: found.provider ?? null }));
    } catch (err) {
        log.warn(`[Search] busca interrompida por erro interno (${errorTag(err)})`);
        return remember(result({ reason: 'error', cause: 'network' }));
    }
}
// Contrato antigo: só o contexto (ou null). Não lança.
async function smartSearch(prompt, providerFunc, options = {}) {
    const out = await smartSearchDetailed(prompt, providerFunc, options);
    return out.context;
}

// ---------------------------------------------------------------------------------------------
// Busca do AGENTE de pesquisa: teto global reconhecível e motivo da falha
// ---------------------------------------------------------------------------------------------

/**
 * searchWeb para o adaptador `deps.search` do agente (researchAgent.js). Diferenças:
 *  - `sensitive` é sempre false (o agente já aplicou as regras do modo privado antes de chamar);
 *  - recusa pelo teto GLOBAL por hora (budget.js, YUI_SEARCH_GLOBAL_PER_HOUR) volta como `limited: 'global'` e o erro "teto global...",
 *    não como `limited: 'user'` (o providers.js hoje rotula qualquer recusa do budget como de usuário);
 *  - o retorno ganha `reason`/`cause`/`message` (ver classifySearchOutcome): cota, tempo, bloqueio, sem resultado, limite.
 * Nunca lança. Não registra a consulta em log. Injeção para teste: searchImpl, budget e as opções do searchWeb (env, fetchImpl, now, logger...).
 */
async function searchForAgent(query, { max = 6, userId = null, signal = null, searchImpl = searchWeb, budget = null, logger: log = logger, ...extra } = {}) {
    const base = budget ?? getDefaultBudget();
    const seen = { scope: null };
    // O searchWeb só repassa `limited: 'user'`; este envoltório anota quem recusou (usuário ou global) para corrigir o rótulo.
    const tracked = Object.create(base);
    tracked.takeUser = (...args) => {
        const turn = base.takeUser(...args);
        if (!turn.ok) seen.scope = turn.scope ?? 'user';
        return turn;
    };
    let found;
    try {
        found = await searchImpl(query, { ...extra, max, userId, signal, sensitive: false, budget: tracked, logger: log });
    } catch (err) {
        log.warn(`[Search] a busca do agente lançou erro (${errorTag(err)})`);
        found = { provider: null, results: [], errors: ['erro inesperado na busca'] };
    }
    let out = found && typeof found === 'object' ? found : { provider: null, results: [], errors: [] };
    if (seen.scope === 'global' && out.limited !== 'global') {
        out = { ...out, limited: 'global', errors: [GLOBAL_LIMIT_ERROR] };
    }
    const outcome = classifySearchOutcome(out);
    return { ...out, reason: outcome.reason, cause: outcome.cause, message: outcome.message };
}

export { smartSearch, smartSearchDetailed, analyzeSearchIntent, optimizeQuery, classifySearchOutcome, createWebContextMemo, searchForAgent, rankAndFilterResults, fetchPageContent, hasSearchTrigger, isBlacklisted };
export default {
    smartSearch
};
