/**
 * Respostas longas no Discord: dividir é papel do CÓDIGO, não do modelo.
 *
 *  - splitForDiscord(): divisor PURO (sem Discord, sem rede). Corta em fim de parágrafo, de linha, de frase,
 *    de palavra e, só em último caso, em fronteira de grafema (emoji/ZWJ/bandeira nunca se partem).
 *    Preserva Markdown: item de lista inteiro, bloco de código (fecha e reabre com a mesma linguagem),
 *    links, URLs, <@id>/<:nome:id>/<t:..>, pares ** __ ~~ ||, citações ">" e o rodapé "-# modelo | tempo".
 *  - sendLongReply(): envio SEQUENCIAL (await, nunca Promise.all) com todos os dublês injetáveis. Planos B: parte lenta que
 *    ainda completa na folga não é reenviada; sem a permissão de anexar, as primeiras partes saem pelo fluxo dividido com um
 *    aviso do que faltou; texto só de espaço nunca vira mensagem vazia.
 *  - createUnifiedReply(): fábrica do "unifiedReply" da fila do llmHandler (testável sem Discord real). A edição final de um texto
 *    curto, se falhar por motivo passageiro (5xx, 429, rede, prazo), é repetida UMA vez; se ainda assim falhar por motivo que um
 *    reenvio resolve (10008, 10062, 50027, 5xx), o MESMO texto vai como mensagem nova e a de progresso é apagada. Se nada entregar,
 *    o "Processando..." é trocado por um aviso curto: a mensagem de progresso nunca fica como estado final.
 *  - createProgressReporter() / unifiedReply.progress: progresso do agente de pesquisa na mensagem "Processando..." (no máximo 3
 *    edições, mínimo de 1,2 s entre elas, linhas de subtexto "-# ..."), sem mexer em lastDelivery e fechado antes da resposta final.
 *  - Partes 2+ que não chegam: o anexo com o restante ou o aviso em mensagem à parte; se nem isso sair, o aviso é EDITADO na última
 *    parte entregue e a entrega sai como parcial (ok false, partial true), para o histórico não registrar a resposta como completa.
 *  - utilitários puros: continuação de resposta cortada por limite de tokens, filtro de promessas que a Yui
 *    não cumpre, isenção do ANTI-ECO, cópia aparada para o histórico, corte do contexto do Discord e log de entrega.
 *
 * Importar este módulo NÃO tem efeitos colaterais (não abre arquivo, banco nem timer; o logger é injetado).
 */
import { MessageFlags, AttachmentBuilder } from 'discord.js';
import {
    neutralizeMassMentions,
    resolveMentions as defaultResolveMentions,
    SAFE_ALLOWED_MENTIONS,
} from './mentions.js';

// ---------------------------------------------------------------------------------------------
// Constantes
// ---------------------------------------------------------------------------------------------

/** Limite real do campo `content` de uma mensagem do Discord. */
export const DISCORD_LIMIT = 2000;
/** Orçamento por parte (margem para fechar/reabrir bloco, marcador e rodapé). */
export const DEFAULT_PART_BUDGET = 1900;
export const DEFAULT_MAX_PARTS = 4;
/** Acima disto só o anexo (além da introdução). */
export const MAX_REPLY_CHARS = 20000;
/** Prazo total de entrega: a fila do processQueue é serial. */
export const DELIVERY_DEADLINE_MS = 30000;
const FALLBACK_DEADLINE_MS = 15000;
const EXTRA_RETRIES = 1;
const TOKEN_SAFE_MS = 14 * 60 * 1000; // o token de interação vale 15 min
/** Folga depois do prazo de uma requisição: se a abandonada ainda completar, a parte não é reenviada (evita duplicata). */
const LATE_GRACE_MS = 3000;
/** Pausa antes da nova tentativa da edição final de um texto curto. */
const EDIT_RETRY_DELAY_MS = 800;
/** Prazo de UMA edição de texto puro (sem arquivo): sem isso um pedido pendurado seguraria a fila serial para sempre. */
const EDIT_TIMEOUT_MS = 10_000;
/**
 * Orçamento TOTAL da entrega de um texto curto (edição + nova tentativa + plano B), porque a fila da IA é serial: com o Discord lento (cada chamada pendurada) edição,
 * repetição e mensagem nova somavam ~46 s e o backlog escoava 3 vezes mais devagar. Sem orçamento para outra edição inteira, vai direto ao plano B.
 */
const SHORT_DELIVERY_BUDGET_MS = 20_000;
/** Prazo do plano B (mensagem nova): entre o mínimo e o máximo, o que sobrar do orçamento. */
const RESEND_MIN_MS = 5_000;
const RESEND_MAX_MS = 15_000;
/** Prazo de cada passo da limpeza da mensagem de progresso antiga e do aviso da última cartada. */
const CLEANUP_TIMEOUT_MS = 3000;

/** Última cartada quando nem a edição, nem a nova tentativa, nem o plano B entregaram: troca o "Processando..." parado por isto. */
export const DELIVERY_FAILED_TEXT = '⚠️ Não consegui enviar essa resposta. Tente de novo em instantes.';
/** A resposta saiu como mensagem NOVA e a antiga (progresso) não pôde ser apagada: fica só esta linha. */
export const STALE_REPLY_TEXT = '-# ⬇️ A resposta está na mensagem abaixo.';

/** Progresso do agente de pesquisa: no máximo 3 edições da mensagem "Processando...", com 1,2 s de intervalo mínimo. */
export const PROGRESS_MAX_EDITS = 3;
export const PROGRESS_MIN_GAP_MS = 1200;
export const PROGRESS_BASE_TEXT = '🧠 **Processando...**';
const PROGRESS_EDIT_TIMEOUT_MS = 2500;
const PROGRESS_LINE_MAX = 120;
const PROGRESS_SETTLE_MS = 1500;

const MARKER_RESERVE = 18; // "\n-# parte 999/999"
const SUFFIX_RESERVE = 4;  // "\n```"
const FOOTER_MAX = 400;
const PAIR_MAX_SPAN = 800;

/** Texto de reserva quando a resposta é só espaço e não há arquivo, embed nem botão: o Discord recusa mensagem vazia. */
export const EMPTY_REPLY_TEXT = '⚠️ Não consegui montar uma resposta agora. Tente de novo.';
export const TRUNCATION_NOTICE = '(resposta cortada pelo limite do modelo; peça para continuar)';
export const PROMISE_NOTICE = '(Não guardei nada nem consigo avisar depois.)';
export const CONTINUE_INSTRUCTION = 'Continue exatamente de onde parou, sem repetir nada do que já escreveu e sem introdução. Se a última palavra ficou incompleta, recomece por ela. Termine a resposta.';
export const MAX_CONTINUATIONS = 2;
export const MAX_CONTINUED_CHARS = 8000;

const NOOP_LOGGER = Object.freeze({ info() {}, warn() {}, error() {}, debug() {} });

// ---------------------------------------------------------------------------------------------
// Variáveis de ambiente (puras: recebem o env)
// ---------------------------------------------------------------------------------------------

/** YUI_REPLY_MAX_PARTS: máximo de mensagens por resposta (1 a 10; padrão 4). */
export function parseMaxParts(env = process.env) {
    const n = Number.parseInt(String(env?.YUI_REPLY_MAX_PARTS ?? '').trim(), 10);
    return Number.isInteger(n) && n >= 1 && n <= 10 ? n : DEFAULT_MAX_PARTS;
}

/**
 * YUI_REPLY_ATTACH_EXT: extensão do anexo com a resposta completa. Padrão "md": o Discord mostra a
 * prévia do Markdown já formatada (título, negrito, código); "txt" mostra o texto cru.
 */
export function parseAttachExt(env = process.env) {
    const v = String(env?.YUI_REPLY_ATTACH_EXT ?? '').trim().toLowerCase().replace(/^\./, '');
    return v === 'txt' ? 'txt' : 'md';
}

/**
 * IDs de usuários citados no texto (<@id> e <@!id>), sem repetição, no máx. `max`, ignorando blocos de código.
 * Menção dentro de ANEXO não notifica ninguém (o Discord só analisa o texto da mensagem), então no modo anexo
 * quem foi citado também vai como texto na mensagem. Cargo (<@&id>) e @everyone nunca entram.
 */
export function collectUserMentions(text, max = 10) {
    const withoutCode = String(text ?? '').replace(/```[\s\S]*?```|`[^`\n]*`/g, ' ');
    const ids = [];
    for (const m of withoutCode.matchAll(/<@!?(\d{15,25})>/g)) {
        if (!ids.includes(m[1])) ids.push(m[1]);
        if (ids.length >= max) break;
    }
    return ids;
}

/** YUI_REPLY_MAX_TOKENS: override do max_tokens de saída (64 a 8192) ou null. */
export function parseReplyMaxTokens(env = process.env) {
    const n = Number.parseInt(String(env?.YUI_REPLY_MAX_TOKENS ?? '').trim(), 10);
    return Number.isInteger(n) && n >= 64 && n <= 8192 ? n : null;
}

// ---------------------------------------------------------------------------------------------
// Rodapé "-# modelo | tempo"
// ---------------------------------------------------------------------------------------------

/**
 * Separa o rodapé (as últimas linhas "-# ...") do corpo. O rodapé vai só na última parte.
 * Se o texto inteiro for "-# ..." ou o rodapé for enorme, nada é separado.
 */
export function splitFooter(text) {
    const clean = String(text ?? '').replace(/\r\n?/g, '\n').trimEnd();
    const lines = clean.split('\n');
    let i = lines.length;
    while (i > 0 && /^-# /.test(lines[i - 1])) i--;
    if (i === 0 || i === lines.length) return { body: clean, footer: '' };
    const footer = lines.slice(i).join('\n');
    if (footer.length > FOOTER_MAX) return { body: clean, footer: '' };
    return { body: lines.slice(0, i).join('\n').trimEnd(), footer };
}

// ---------------------------------------------------------------------------------------------
// Divisor PURO
// ---------------------------------------------------------------------------------------------

const F_P = 1;  // fim de parágrafo (limpo)
const F_L = 2;  // fim de linha (limpo)
const F_Q = 4;  // fim de linha de qualidade menor (dentro de código, de item de lista, depois de título ou de "...:")
const F_S = 8;  // fim de frase
const F_W = 16; // fronteira de palavra
const MINFILL = { [F_P]: 0.5, [F_L]: 0.4, [F_Q]: 0.3, [F_S]: 0.25, [F_W]: 0.1 };
const RANKS = [F_P, F_L, F_Q, F_S, F_W];

const LIST_ITEM_RE = /^ *(?:[-*+•]|\d{1,3}[.)])\s+\S/;
const LIST_PREFIX_ONLY_RE = /^\s*(?:\d{1,3}[.)]|[-*+•])\s+$/;
const LINK_RE = /\[[^\]\n]{0,300}\]\([^)\s]{1,2000}(?:\s+"[^"\n]*")?\)/g;
const URL_RE = /https?:\/\/[^\s<>]+/gi;
const ANGLE_RE = /<[^\s<>]{1,300}>/g;
const INLINE_CODE_RE = /`[^`\n]+`/g;
const SENTENCE_RE = /[.!?…]+["'”’)\]*_~|]*[ \t]+/g;
const WORD_RE = /[ \t]+(?=\S)/g;
const PAIR_MARKS = ['**', '__', '~~', '||'];

const segmenter = typeof Intl !== 'undefined' && typeof Intl.Segmenter === 'function'
    ? new Intl.Segmenter('pt-BR', { granularity: 'grapheme' })
    : null;

function graphemeBoundaries(text) {
    const n = text.length;
    const b = new Uint8Array(n + 1);
    b[0] = 1;
    b[n] = 1;
    if (segmenter) {
        for (const { index } of segmenter.segment(text)) b[index] = 1;
        return b;
    }
    for (let i = 1; i < n; i++) {
        const lo = text.charCodeAt(i);
        const hi = text.charCodeAt(i - 1);
        b[i] = lo >= 0xDC00 && lo <= 0xDFFF && hi >= 0xD800 && hi <= 0xDBFF ? 0 : 1;
    }
    return b;
}

/** ">>> texto" vale até o fim da mensagem (o marcador "-# parte" ficaria dentro da citação): vira ">" por linha. */
function expandMultilineQuote(body) {
    if (!/^ {0,3}>>>/m.test(body)) return body;
    const out = [];
    let quoting = false;
    let inFence = false;
    for (const line of body.split('\n')) {
        if (/^ {0,3}`{3,}/.test(line)) inFence = !inFence;
        if (!quoting && !inFence) {
            const m = line.match(/^ {0,3}>>>\s?(.*)$/);
            if (m) { quoting = true; out.push(`> ${m[1]}`.trimEnd()); continue; }
        }
        if (quoting && !inFence && !/^ {0,3}`{3,}/.test(line)) { out.push(line.trim() === '' ? '>' : `> ${line}`); continue; }
        if (quoting && /^ {0,3}`{3,}/.test(line)) quoting = false;
        out.push(line);
    }
    return out.join('\n');
}

function analyze(body) {
    const n = body.length;
    const starts = [0];
    for (let i = 0; i < n; i++) if (body.charCodeAt(i) === 10) starts.push(i + 1);
    const count = starts.length;

    // ── linhas e estado do bloco de código ──
    const lines = [];
    let inCode = false;
    let lang = '';
    let fenceLen = 0;
    let prevItem = false;
    for (let i = 0; i < count; i++) {
        const start = starts[i];
        const end = i + 1 < count ? starts[i + 1] - 1 : n;
        const text = body.slice(start, end);
        const line = { start, end, text, inCodeBefore: inCode, langBefore: lang, fence: false, blank: text.trim() === '', item: false, cont: false, heading: false, quote: false };
        if (inCode) {
            const close = text.match(/^ {0,3}(`{3,})\s*$/);
            if (close && close[1].length >= fenceLen) { line.fence = true; inCode = false; lang = ''; }
            prevItem = false;
        } else {
            const open = text.match(/^ {0,3}(`{3,})([^`]*)$/);
            if (open) {
                line.fence = true;
                inCode = true;
                fenceLen = open[1].length;
                // A "info string" só serve para reabrir o bloco com a mesma linguagem: fica só [A-Za-z0-9_+#.-] e no máximo 20
                // caracteres. Uma cerca com ~1950 caracteres ali estourava o prefixo de reabertura de TODAS as partes.
                lang = (open[2].trim().split(/\s+/)[0] || '').replace(/[^A-Za-z0-9_+#.-]/g, '').slice(0, 20);
                prevItem = false;
            } else {
                line.heading = /^ {0,3}#{1,6}\s/.test(text);
                line.quote = /^ {0,3}>/.test(text);
                if (LIST_ITEM_RE.test(text)) { line.item = true; prevItem = true; }
                else if (prevItem && !line.blank && !line.heading && /^(?: {2,}|\t)/.test(text)) line.cont = true;
                else prevItem = false;
            }
        }
        lines.push(line);
    }

    const lineIndexAt = (c) => {
        let lo = 0;
        let hi = count - 1;
        while (lo < hi) {
            const mid = (lo + hi + 1) >> 1;
            if (starts[mid] <= c) lo = mid; else hi = mid - 1;
        }
        return lo;
    };

    // ── trechos indivisíveis ──
    const blocked = new Uint8Array(n + 1);
    const block = (a, b) => { for (let i = a + 1; i < b && i <= n; i++) blocked[i] = 1; };
    for (const re of [LINK_RE, URL_RE, ANGLE_RE]) {
        for (const m of body.matchAll(re)) block(m.index, m.index + m[0].length);
    }
    for (const ln of lines) {
        if (ln.fence) { block(ln.start, ln.end); continue; }
        if (ln.inCodeBefore) continue;
        for (const m of ln.text.matchAll(INLINE_CODE_RE)) block(ln.start + m.index, ln.start + m.index + m[0].length);
        for (const mk of PAIR_MARKS) {
            const idx = [];
            let p = ln.text.indexOf(mk);
            while (p !== -1) { idx.push(p); p = ln.text.indexOf(mk, p + mk.length); }
            for (let k = 0; k + 1 < idx.length; k += 2) {
                const a = ln.start + idx[k];
                const b = ln.start + idx[k + 1] + mk.length;
                if (b - a <= PAIR_MAX_SPAN) block(a, b);
            }
        }
    }

    const boundary = graphemeBoundaries(body);
    const okPos = (c) => c > 0 && c < n && boundary[c] === 1 && blocked[c] === 0;

    // ── candidatos a corte ──
    const flags = new Uint8Array(n + 1);
    const weakBefore = (i) => {
        let j = i - 1;
        while (j >= 0 && lines[j].blank) j--;
        if (j < 0) return false;
        const t = lines[j].text.trimEnd();
        return lines[j].heading || /:$/.test(t) || /^\s*(?:\*\*|__)[^*_]+(?:\*\*|__):?\s*$/.test(t);
    };
    for (let i = 1; i < count; i++) {
        const c = starts[i];
        if (!okPos(c)) continue;
        const prev = lines[i - 1];
        const cur = lines[i];
        if (cur.inCodeBefore && (prev.fence || cur.fence)) continue; // nunca deixa um bloco vazio ("```js" sozinho)
        const clean = !cur.inCodeBefore && !cur.cont && !weakBefore(i);
        if (clean) { flags[c] |= F_L; if (prev.blank) flags[c] |= F_P; } else flags[c] |= F_Q;
    }
    for (const m of body.matchAll(SENTENCE_RE)) {
        const c = m.index + m[0].length;
        if (!okPos(c)) continue;
        const li = lineIndexAt(c);
        const ln = lines[li];
        if (ln.inCodeBefore || ln.fence) continue;
        if (LIST_PREFIX_ONLY_RE.test(body.slice(ln.start, c))) continue; // "1. " não é fim de frase
        const next = String.fromCodePoint(body.codePointAt(c));
        if (/\p{Ll}/u.test(next)) continue; // "Sr. fulano": continua minúscula
        flags[c] |= F_S;
    }
    for (const m of body.matchAll(WORD_RE)) {
        const c = m.index + m[0].length;
        if (!okPos(c)) continue;
        const ln = lines[lineIndexAt(c)];
        if (LIST_PREFIX_ONLY_RE.test(body.slice(ln.start, c))) continue;
        flags[c] |= F_W;
    }

    return { n, body, starts, lines, lineIndexAt, blocked, boundary, flags };
}

/** O que a parte seguinte precisa reabrir quando o corte cai em `c`. */
function stateAfterCut(A, c) {
    const ln = A.lines[A.lineIndexAt(c)];
    const mid = c > ln.start && c < ln.end;
    if (ln.inCodeBefore) return { prefix: `\`\`\`${ln.langBefore}\n`, suffix: '\n```' };
    if (mid && ln.quote) return { prefix: '> ', suffix: '' };
    return { prefix: '', suffix: '' };
}

function chooseCut(A, s, limit, budget) {
    let first = s;
    while (first < A.n && /\s/.test(A.body[first])) first++;
    const lo = Math.max(s + 1, first + 1);
    if (limit < lo) return Math.min(A.n - 1, Math.max(lo, s + 1));
    for (const rank of RANKS) {
        const floor = Math.max(lo, s + Math.floor(budget * MINFILL[rank]));
        for (let c = limit; c >= floor; c--) {
            if (A.flags[c] & rank) return c;
        }
    }
    for (let c = limit; c >= lo; c--) if (A.boundary[c] === 1 && A.blocked[c] === 0) return c; // corte duro, sem partir grafema
    for (let c = limit; c >= lo; c--) if (A.boundary[c] === 1) return c;                       // trecho indivisível maior que a parte
    return limit;
}

function planCuts(A, { budgetMax, footerExtra, marker, singleLimit }) {
    const markerReserve = marker ? MARKER_RESERVE : 0;
    const cuts = [];
    let s = 0;
    let prefix = '';
    let guard = 0;
    while (s < A.n && guard++ < 10000) {
        const remaining = A.n - s;
        if (prefix.length + remaining + SUFFIX_RESERVE + footerExtra + markerReserve <= Math.min(DISCORD_LIMIT, singleLimit)) {
            cuts.push({ start: s, end: A.n, prefix, suffix: '' });
            s = A.n;
            break;
        }
        const budget = Math.max(200, Math.min(budgetMax, DISCORD_LIMIT - prefix.length - SUFFIX_RESERVE - markerReserve));
        const limit = Math.min(s + budget, A.n - 1);
        const c = chooseCut(A, s, limit, budget);
        const st = stateAfterCut(A, c);
        cuts.push({ start: s, end: c, prefix, suffix: st.suffix });
        prefix = st.prefix;
        s = c;
    }
    return cuts;
}

function assemble(A, cuts, footer, marker) {
    const total = cuts.length;
    return cuts.map((cut, i) => {
        const raw = A.body.slice(cut.start, cut.end);
        const trimmed = raw.replace(/^(?:[ \t]*\n)+/, '').trimEnd();
        const isLast = i === total - 1;
        let content = `${cut.prefix}${trimmed}${cut.suffix}`;
        if (isLast && footer) content += `\n${footer}`;
        if (total > 1 && marker) content += `\n-# parte ${i + 1}/${total}`;
        return { index: i, start: cut.start, end: cut.end, raw, prefix: cut.prefix, suffix: cut.suffix, content };
    });
}

/**
 * Divide `text` em partes para o Discord e devolve os detalhes de cada uma
 * ({ start, end, raw, prefix, suffix, content }; as `raw` são fatias CONTÍGUAS do corpo).
 *
 * @param {string} text
 * @param {{max?:number, footer?:string, marker?:boolean, singleLimit?:number}} [opts]
 *   max: orçamento de texto por parte (padrão 1900); footer: vai só na última parte;
 *   marker: acrescenta "-# parte i/N" quando houver mais de uma parte; singleLimit: tamanho até o qual vale uma parte só.
 */
export function splitDetailed(text, { max = DEFAULT_PART_BUDGET, footer = '', marker = true, singleLimit = DISCORD_LIMIT } = {}) {
    const body0 = String(text ?? '').replace(/\r\n?/g, '\n').trim();
    const foot = String(footer ?? '').replace(/\r\n?/g, '\n').trim();
    const footerExtra = foot ? foot.length + 1 : 0;
    if (body0.length + footerExtra <= singleLimit) {
        const content = foot ? (body0 ? `${body0}\n${foot}` : foot) : body0;
        return { body: body0, footer: foot, parts: [{ index: 0, start: 0, end: body0.length, raw: body0, prefix: '', suffix: '', content }] };
    }
    const body = expandMultilineQuote(body0);
    const A = analyze(body);
    let budgetMax = Math.max(200, Math.min(Math.floor(max) || DEFAULT_PART_BUDGET, DISCORD_LIMIT - 20));
    let parts = [];
    for (let attempt = 0; attempt < 8; attempt++) {
        const cuts = planCuts(A, { budgetMax, footerExtra, marker, singleLimit });
        parts = assemble(A, cuts, foot, marker);
        if (parts.every((p) => p.content.length <= DISCORD_LIMIT)) return { body, footer: foot, parts };
        budgetMax = Math.max(200, budgetMax - 120);
    }
    // Último recurso (não deveria acontecer): garante o limite do Discord.
    for (const p of parts) if (p.content.length > DISCORD_LIMIT) p.content = p.content.slice(0, DISCORD_LIMIT);
    return { body, footer: foot, parts };
}

/** Lista de textos prontos para enviar (cada um com no máximo 2000 caracteres). */
export function splitForDiscord(text, opts = {}) {
    return splitDetailed(text, opts).parts.map((p) => p.content);
}

/** Texto e rodapé juntos: separa o rodapé e divide. */
export function splitReply(text, opts = {}) {
    const { body, footer } = splitFooter(text);
    return splitDetailed(body, { ...opts, footer: opts.footer ?? footer });
}

/** Primeiro trecho (até `max` caracteres) de `text`, cortado em lugar seguro; sem marcador de parte. */
export function firstChunk(text, max = 1500) {
    const parts = splitDetailed(text, { max, marker: false, singleLimit: max, footer: '' }).parts;
    return parts[0]?.content ?? '';
}

/** Para respostas de voz/rádio (sem divisor): cabe numa mensagem só, mantendo o rodapé. */
export function capSingleMessage(text, { limit = 1950 } = {}) {
    const clean = String(text ?? '');
    if (clean.length <= DISCORD_LIMIT) return clean;
    const { body, footer } = splitFooter(clean);
    const tail = '\n[…]' + (footer ? `\n${footer}` : '');
    return firstChunk(body, Math.max(200, limit - tail.length)) + tail;
}

// ---------------------------------------------------------------------------------------------
// Erros do Discord
// ---------------------------------------------------------------------------------------------

const PERMANENT_CODES = new Set([10003, 10008, 10015, 10062, 40005, 50001, 50013, 50027, 50035]);

/** Erro permanente (4xx, exceto 408/425/429): repetir o mesmo envio não adianta. */
export function isPermanentDiscordError(err) {
    const status = Number(err?.status ?? err?.httpStatus ?? err?.rawError?.status);
    if (Number.isFinite(status) && status >= 400 && status < 500) return ![408, 425, 429].includes(status);
    const code = Number(err?.code);
    return PERMANENT_CODES.has(code);
}

/**
 * A edição/resposta falhou por um motivo que o MESMO conteúdo enviado como mensagem nova resolve: mensagem apagada (10008),
 * interação desconhecida (10062), token vencido (50027) ou erro 5xx do Discord. Outros erros (50035 corpo inválido, 50013 sem
 * permissão, 40005 arquivo grande) falhariam igual no reenvio.
 */
export function isRecoverableEditError(err) {
    const code = Number(err?.code);
    if (code === 10008 || code === 10062 || code === 50027) return true;
    const status = Number(err?.status ?? err?.httpStatus ?? err?.rawError?.status);
    return Number.isFinite(status) && status >= 500 && status < 600;
}

/**
 * O alvo da edição não existe mais (mensagem apagada 10008, webhook 10015, interação 10062, token vencido 50027, ou qualquer 404):
 * repetir a edição ou apagar a mensagem antiga não adianta.
 */
export function isTargetGoneError(err) {
    const code = Number(err?.code);
    if (code === 10008 || code === 10015 || code === 10062 || code === 50027) return true;
    const status = Number(err?.status ?? err?.httpStatus ?? err?.rawError?.status);
    return status === 404;
}

/**
 * Vale UMA nova tentativa curta da MESMA edição? Falha passageira (5xx, 408/425/429, erro de rede, prazo da requisição): sim.
 * Mensagem apagada (10008) e qualquer outro 4xx: não (a repetição falharia igual). Só serve para EDIÇÃO (idempotente).
 */
export function isRetryableEditError(err) {
    if (!err) return false;
    if (err.code === 'DELIVERY_TIMEOUT') return true;
    return !isPermanentDiscordError(err);
}

// ---------------------------------------------------------------------------------------------
// Envio sequencial
// ---------------------------------------------------------------------------------------------

const defaultSleep = (ms) => new Promise((resolve) => { const t = setTimeout(resolve, ms); t.unref?.(); });
let nonceCounter = 0;
const defaultNonce = () => `y${Date.now().toString(36)}${(nonceCounter++ % 1296).toString(36)}${Math.random().toString(36).slice(2, 7)}`.slice(0, 25);

/** Estoura o prazo sem cancelar a requisição: o erro leva `pending` (a promessa abandonada) para quem quiser esperar uma folga. */
function withTimeout(promise, ms) {
    if (!Number.isFinite(ms) || ms <= 0) return promise;
    let timer;
    const timeout = new Promise((_, reject) => {
        // sem unref: enquanto a entrega estiver pendente o processo não pode sair; o timer é limpo assim que a corrida termina
        timer = setTimeout(() => reject(Object.assign(new Error('prazo de entrega esgotado'), { code: 'DELIVERY_TIMEOUT', pending: promise })), ms);
    });
    return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

/**
 * Espera até `ms` pela requisição abandonada. { done:true, ok:true, value } = completou a tempo (a parte JÁ foi entregue:
 * não se reenvia); { done:true, ok:false } = falhou; { done:false } = nada a tempo.
 */
async function waitLate(pending, ms, sleepFn) {
    if (!pending || typeof pending.then !== 'function' || !Number.isFinite(ms) || ms <= 0) return { done: false };
    const settled = pending.then((value) => ({ done: true, ok: true, value }), () => ({ done: true, ok: false }));
    const gaveUp = Promise.resolve().then(() => sleepFn(ms)).then(() => ({ done: false }), () => ({ done: false }));
    return Promise.race([settled, gaveUp]);
}

export function countUrls(text) {
    return (String(text ?? '').match(/https?:\/\/\S+/gi) ?? []).length;
}

function describeError(err) {
    return `status=${err?.status ?? err?.httpStatus ?? 'n/d'} codigo=${err?.code ?? 'n/d'}`;
}

/** Há arquivo, embed ou botão? (uma mensagem só com isso é válida mesmo sem texto). */
function hasExtras(...lists) {
    return lists.some((l) => Array.isArray(l) && l.length > 0);
}

/** 4200 -> "4.200" (sem depender do ICU do Node). */
const withThousands = (n) => String(Math.max(0, Math.round(Number(n) || 0))).replace(/\B(?=(\d{3})+(?!\d))/g, '.');

/**
 * A resposta saiu como mensagem NOVA e a antiga ("Processando..." com o subtexto de progresso) ficou para trás: apaga; se não puder,
 * troca por uma linha neutra. Nunca lança. Não faz nada se o alvo já sumiu (10008, 10062, 50027, 404) nem em resposta efêmera.
 * @returns {Promise<boolean>} true se a mensagem antiga foi apagada ou trocada
 */
async function retireStaleMessage({ kind, message, interaction, err, logger = NOOP_LOGGER, allowedMentions = SAFE_ALLOWED_MENTIONS, timeoutMs = CLEANUP_TIMEOUT_MS }) {
    if (isTargetGoneError(err) || interaction?.ephemeral === true) return false;
    const live = interaction?.deferred === true || interaction?.replied === true;
    const remove = kind === 'mention'
        ? (typeof message?.delete === 'function' ? () => message.delete() : null)
        : (live && typeof interaction?.deleteReply === 'function' ? () => interaction.deleteReply() : null);
    const rewrite = kind === 'mention'
        ? (typeof message?.edit === 'function' ? (p) => message.edit(p) : null)
        : (live && typeof interaction?.editReply === 'function' ? (p) => interaction.editReply(p) : null);
    const run = (fn) => withTimeout(Promise.resolve().then(fn), timeoutMs);
    if (remove) {
        try {
            await run(remove);
            return true;
        } catch (e) {
            logger.warn(`[LongReply] não consegui apagar a mensagem de progresso antiga (${describeError(e)})`);
        }
    }
    if (rewrite) {
        try {
            await run(() => rewrite({ content: STALE_REPLY_TEXT, files: [], components: [], embeds: [], allowedMentions }));
            return true;
        } catch (e) {
            logger.warn(`[LongReply] não consegui trocar a mensagem de progresso antiga (${describeError(e)})`);
        }
    }
    return false;
}

// ---------------------------------------------------------------------------------------------
// Progresso do agente de pesquisa
// ---------------------------------------------------------------------------------------------

const ZWSP = String.fromCharCode(0x200b); // espaço de largura zero

/**
 * Uma linha de subtexto ("-# ...") para o progresso: uma linha só, sem URL, sem menção (<@id>, <@&id>, <#id>, @everyone, @nome),
 * sem o "-# " duplicado e com no máximo `max` caracteres (corte em fronteira de grafema). Devolve '' se não sobrar nada.
 */
export function progressSubtext(line, max = PROGRESS_LINE_MAX) {
    let t = String(line ?? '')
        .replace(/\s+/g, ' ')
        .trim()
        .replace(/^(?:-#\s*)+/, '')
        .replace(/https?:\/\/\S+/gi, '')
        .replace(/<[@#][!&]?\d{3,25}>/g, '')
        .replace(/<a?:[A-Za-z0-9_]{2,32}:\d{3,25}>/g, '')
        .replace(/\s+/g, ' ')
        .trim();
    t = neutralizeMassMentions(t).replace(/@(?=[\p{L}\p{N}_])/gu, `@${ZWSP}`);
    const limit = Math.max(8, Math.floor(Number(max)) || PROGRESS_LINE_MAX);
    if (t.length > limit) t = `${t.slice(0, cutPoint(t, limit - 1)).trimEnd()}…`;
    return t ? `-# ${t}` : '';
}

/**
 * Progresso na mensagem "Processando...". `edit(texto, { line, index })` é quem edita (injetado) e recebe a mensagem já montada:
 * o texto-base + a linha de subtexto. Regras:
 *  - no máximo `maxEdits` edições (nunca mais de 3); a última só serve a `show(linha, { last: true })` ou a uma linha que case com
 *    `finalPattern` (padrão: "Escrevendo a resposta");
 *  - no mínimo 1,2 s entre duas edições (linha que chega antes é descartada, não adiada); linha repetida é descartada;
 *  - edições em fila, nunca fora de ordem, cada uma com prazo (a que pendura não segura a pesquisa);
 *  - nunca lança; erro permanente (mensagem apagada, 4xx) encerra o progresso; o texto da linha nunca vai para o log;
 *  - `settle()` fecha e espera a edição em andamento: depois dele nenhuma edição velha pode sobrescrever a resposta final.
 *    `drain()` só espera, sem fechar. `show` não usa `this`: pode ser passado solto (ex.: `onProgress: reporter.show`).
 */
export function createProgressReporter(edit, {
    maxEdits = PROGRESS_MAX_EDITS,
    minGapMs = PROGRESS_MIN_GAP_MS,
    timeoutMs = PROGRESS_EDIT_TIMEOUT_MS,
    base = PROGRESS_BASE_TEXT,
    now = Date.now,
    logger = NOOP_LOGGER,
    finalPattern = /\bescrevendo\b/i,
} = {}) {
    const cap = Math.min(PROGRESS_MAX_EDITS, Number.isFinite(Number(maxEdits)) ? Math.max(0, Math.floor(Number(maxEdits))) : PROGRESS_MAX_EDITS);
    const gap = Math.max(PROGRESS_MIN_GAP_MS, Number.isFinite(Number(minGapMs)) ? Number(minGapMs) : PROGRESS_MIN_GAP_MS);
    const prefix = String(base ?? '').trim() || PROGRESS_BASE_TEXT;
    let used = 0;
    let lastAt = -Infinity;
    let lastLine = '';
    let closed = false;
    let dead = false;
    let warned = false;
    let chain = Promise.resolve();
    const shown = [];

    const fail = (err) => {
        if (!warned) {
            warned = true;
            logger.warn(`[LongReply] a mensagem de progresso não pôde ser atualizada (${describeError(err)})`);
        }
        if (isTargetGoneError(err) || isPermanentDiscordError(err)) dead = true;
    };

    const waitChain = (ms) => new Promise((resolve) => {
        const timer = setTimeout(() => resolve(false), Math.max(0, Number(ms) || 0)); // limpo assim que a fila de edições termina
        chain.then(() => { clearTimeout(timer); resolve(true); });
    });

    return {
        /** Agenda a edição. Devolve true se a linha foi aceita (e será enviada), false se foi descartada. */
        show(line, opts) {
            if (closed || dead || typeof edit !== 'function' || cap < 1) return false;
            const sub = progressSubtext(line);
            if (!sub || sub === lastLine) return false;
            const last = (opts && typeof opts === 'object' && opts.last === true) || (finalPattern instanceof RegExp && finalPattern.test(sub));
            if (used >= (last ? cap : Math.max(1, cap - 1))) return false;
            const t = now();
            if (used > 0 && t - lastAt < gap) return false;
            used++;
            lastAt = t;
            lastLine = sub;
            shown.push(sub);
            const index = used;
            const text = `${prefix}\n${sub}`;
            chain = chain
                .then(() => (closed || dead ? undefined : withTimeout(Promise.resolve().then(() => edit(text, { line: sub, index })), timeoutMs)))
                .catch(fail);
            return true;
        },
        /** Fecha (nada novo entra, o que ainda não começou é descartado) e espera a edição em andamento por até `ms`. */
        async settle(ms = PROGRESS_SETTLE_MS) {
            closed = true;
            return waitChain(ms);
        },
        /** Só espera as edições agendadas (até `ms`); o progresso continua aberto. */
        drain(ms = PROGRESS_SETTLE_MS) {
            return waitChain(ms);
        },
        close() { closed = true; },
        get edits() { return used; },
        get lines() { return [...shown]; },
        get closed() { return closed; },
    };
}

/**
 * Envia uma resposta (possivelmente longa) em ordem, sem Promise.all.
 *
 * @param {object} options
 * @param {'mention'|'slash'} options.kind        mention = Message (+ mensagem "Processando..."); slash = interação/adaptador
 * @param {object} options.interaction            Message ou interação
 * @param {object} [options.replyMessage]         mensagem "Processando..." (mention): a parte 1 a EDITA
 * @param {string} options.text                   texto final (com o rodapé "-# ..." no fim, se houver)
 * @param {Array}  [options.files] [options.components] [options.embeds]  vão na ÚLTIMA parte
 * @param {boolean} [options.ephemeral]           padrão: interaction.ephemeral (nunca cai para channel.send se efêmera)
 * @param {number} [options.lateGraceMs]          folga (padrão 3000) depois do prazo de uma requisição: se ela ainda completar, não se reenvia
 * @returns {Promise<{ok:boolean, mode:'single'|'split'|'attachment'|'failed', parts:number, sentParts:number, chars:number,
 *                    durationMs:number, message:object|null, firstMessage:object|null, degraded:boolean}>}
 *   `parts` = mensagens PLANEJADAS na entrega que valeu: 1 no modo anexo; no modo dividido, o total de partes (ou, se o anexo
 *   não pôde ser enviado, quantas partes iniciais foram tentadas, ver o ramo "anexo").
 *   Campos que só existem quando valem: `partial` (true: faltou texto; as partes 2+ não chegaram nem em arquivo; se nem o aviso à
 *   parte saiu, `ok` fica false e o aviso é editado na última parte entregue) e `firstReplaced` (true: a parte 1 não pôde editar o
 *   "Processando..." e saiu como mensagem NOVA em `firstMessage`; a mensagem de progresso antiga foi apagada ou trocada).
 */
export async function sendLongReply(options = {}) {
    const {
        kind = 'slash',
        interaction,
        replyMessage = null,
        text,
        files = [],
        components = [],
        embeds = [],
        allowedMentions = SAFE_ALLOWED_MENTIONS,
        maxParts = DEFAULT_MAX_PARTS,
        maxChars = MAX_REPLY_CHARS,
        budget = DEFAULT_PART_BUDGET,
        deadlineMs = DELIVERY_DEADLINE_MS,
        fallbackMs = FALLBACK_DEADLINE_MS,
        retryDelayMs = 1500,
        lateGraceMs = LATE_GRACE_MS,
        logger = NOOP_LOGGER,
        now = Date.now,
        sleep = defaultSleep,
        makeNonce = defaultNonce,
        Attachment = AttachmentBuilder,
        attachExt = parseAttachExt(),
    } = options;
    const ephemeral = options.ephemeral ?? (kind === 'slash' && interaction?.ephemeral === true);

    const started = now();
    let safeText = neutralizeMassMentions(String(text ?? ''));
    // Texto só de espaço, sem arquivo, embed nem botão: o Discord recusa mensagem vazia.
    if (!safeText.trim() && !hasExtras(files, components, embeds)) safeText = EMPTY_REPLY_TEXT;
    const { body, footer } = splitFooter(safeText);
    const plan = splitDetailed(body, { max: budget, footer, marker: true });
    const parts = plan.parts;
    const total = parts.length;
    const chars = safeText.length;
    const attachmentMode = total > maxParts || body.length > maxChars;
    const mode = attachmentMode ? 'attachment' : total === 1 ? 'single' : 'split';

    const result = { ok: false, mode: 'failed', parts: total, sentParts: 0, chars, durationMs: 0, message: null, firstMessage: null, degraded: false };
    const finish = () => { result.durationMs = now() - started; return result; };

    let budgetMs = deadlineMs;
    let budgetStart = started;
    const remaining = () => Math.max(Math.min(1000, budgetMs), budgetMs - (now() - budgetStart));
    const expired = () => now() - budgetStart > budgetMs;

    const channelOf = () => replyMessage?.channel ?? interaction?.channel ?? null;
    const tokenValid = () => {
        const created = Number(interaction?.createdTimestamp);
        return !Number.isFinite(created) || now() - created < TOKEN_SAFE_MS;
    };

    async function attempt(fn, { retryable, label }) {
        let tries = 0;
        for (;;) {
            try {
                return await withTimeout(Promise.resolve().then(fn), remaining());
            } catch (err) {
                if (err?.code === 'DELIVERY_TIMEOUT') {
                    // A requisição abandonada pode ainda completar. Espera uma folga curta: se completou, a parte JÁ está no
                    // canal e reenviá-la (ou mandá-la de novo dentro do anexo) duplicaria o texto.
                    const late = await waitLate(err.pending, lateGraceMs, sleep);
                    if (late.done && late.ok) {
                        logger.warn(`[LongReply] ${label} completou depois do prazo; não será reenviada`);
                        return late.value;
                    }
                }
                tries++;
                if (!retryable || tries > EXTRA_RETRIES || err?.code === 'DELIVERY_TIMEOUT' || isPermanentDiscordError(err) || expired()) throw err;
                logger.warn(`[LongReply] falha transitória (${label}; ${describeError(err)}); repetindo uma vez`);
                await sleep(retryDelayMs);
            }
        }
    }

    const baseFlags = (content, { create }) => {
        let flags = 0;
        if (create && ephemeral) flags |= MessageFlags.Ephemeral;
        if (countUrls(content) >= 3) flags |= MessageFlags.SuppressEmbeds;
        return flags;
    };

    // Parte 1: edita o "Processando..." (mention) ou o editReply (slash). Se falhar, manda como mensagem nova.
    async function deliverFirst(content, extra = {}) {
        const flags = baseFlags(content, { create: false });
        const payload = { content, files: [], components: [], embeds: [], allowedMentions, ...(flags ? { flags } : {}), ...extra };
        try {
            return await attempt(async () => {
                if (kind === 'mention') {
                    if (replyMessage) { const edited = await replyMessage.edit(payload); return edited ?? replyMessage; }
                    return interaction.reply({ ...payload, fetchReply: true, failIfNotExists: false });
                }
                if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
                return interaction.reply({ ...payload, fetchReply: true });
            }, { retryable: kind === 'mention' ? Boolean(replyMessage) : true, label: 'parte 1' });
        } catch (err) {
            logger.warn(`[LongReply] a parte 1 não pôde ser editada (${describeError(err)}); enviando como mensagem nova`);
            const sent = await deliverNext(content, null, { ...extra, firstFallback: true });
            result.firstReplaced = true; // quem guarda a mensagem de "Processando..." precisa trocar pela nova
            // A mensagem de progresso antiga não pode ficar para trás como se fosse a resposta: apaga (ou troca por uma linha neutra).
            await retireStaleMessage({ kind, message: replyMessage, interaction, err, logger });
            return sent;
        }
    }

    // Partes seguintes (e o fallback da primeira): channel.send encadeado por resposta, ou followUp (slash).
    async function deliverNext(content, previous, extra = {}) {
        const { firstFallback, ...rest } = extra;
        const silent = !firstFallback;
        const createFlags = baseFlags(content, { create: true }) | (silent && !ephemeral ? MessageFlags.SuppressNotifications : 0);
        const useFollowUp = kind === 'slash' && typeof interaction?.followUp === 'function' && tokenValid();
        if (useFollowUp) {
            const payload = { content, allowedMentions, ...(createFlags ? { flags: createFlags } : {}), ...rest };
            try {
                return await attempt(() => interaction.followUp(payload), { retryable: false, label: 'followUp' });
            } catch (err) {
                // Efêmera nunca vaza para o canal: o followUp não herda o efêmero e channel.send seria público.
                if (ephemeral || !channelOf()?.send) throw err;
                logger.warn(`[LongReply] followUp falhou (${describeError(err)}); usando o canal`);
            }
        } else if (ephemeral) {
            throw Object.assign(new Error('interação efêmera sem token válido'), { status: 400, code: 'EPHEMERAL_EXPIRED' });
        }
        const channel = channelOf();
        if (!channel || typeof channel.send !== 'function') {
            throw Object.assign(new Error('canal indisponível para o envio'), { status: 404, code: 'NO_CHANNEL' });
        }
        const nonce = makeNonce();
        // Encadeia por resposta: a parte k responde à k-1; sem parte anterior, responde à mensagem de quem perguntou.
        const reference = previous ?? (kind === 'mention' && typeof interaction?.id === 'string' ? interaction : null);
        const payload = {
            content,
            allowedMentions,
            ...(createFlags ? { flags: createFlags } : {}),
            nonce,
            enforceNonce: true,
            ...(reference ? { reply: { messageReference: reference, failIfNotExists: false } } : {}),
            ...rest,
        };
        return attempt(() => channel.send(payload), { retryable: true, label: 'channel.send' });
    }

    const attachmentOf = (textForFile, name) => new Attachment(Buffer.from(String(textForFile), 'utf8'), { name });

    // Já se sabe que o anexo não sai neste canal (ramo "anexo" abaixo): o restante não tenta anexo de novo, só avisa.
    let attachFailed = false;

    // O que sobrou vai como UM anexo; se falhar, ao menos um aviso curto.
    // Devolve 'attachment' (o restante chegou inteiro, em arquivo), 'notice' (só o aviso de que faltou texto chegou) ou 'none' (nada).
    async function fallbackRest(fromIndex, previous, reason) {
        budgetMs = fallbackMs;
        budgetStart = now();
        // Os deslocamentos das partes valem para plan.body (já aparado e com ">>>" expandido), não para `body`.
        const rest = plan.body.slice(parts[fromIndex].start) + (footer ? `\n${footer}` : '');
        const label = `${fromIndex + 1} a ${total}`;
        result.degraded = true;
        if (!attachFailed) {
            try {
                const msg = await deliverNext(`📎 Não consegui enviar as partes ${label} como mensagens (${reason}); o restante está neste arquivo.`, previous, {
                    files: [attachmentOf(rest, `resposta-yui-partes-${fromIndex + 1}-a-${total}.${attachExt}`)],
                    firstFallback: true,
                });
                result.message = msg ?? result.message;
                if (!result.firstMessage) result.firstMessage = msg;
                return 'attachment';
            } catch (err) {
                logger.error(`[LongReply] o anexo com as partes ${label} também falhou (${describeError(err)}, tamanho=${rest.length})`);
            }
        }
        try {
            await deliverNext(`⚠️ Não consegui enviar as partes ${label}.`, previous, { firstFallback: true });
            return 'notice';
        } catch (err) {
            logger.error(`[LongReply] nem o aviso das partes ${label} foi entregue (${describeError(err)})`);
        }
        return 'none';
    }

    // Nem o anexo nem o aviso à parte chegaram (o canal recusa channel.send, por exemplo): o usuário ficaria com as primeiras partes
    // e nenhuma pista do que faltou. Edita a ÚLTIMA parte entregue (a parte 1 quando só ela saiu) para avisar. Nunca lança.
    async function noticeOnLastPart(previous) {
        const sent = result.sentParts;
        const target = previous ?? result.message;
        if (sent < 1 || sent >= total) return false;
        const body0 = parts[sent - 1].content.replace(/\n-# parte \d+\/\d+$/, '');
        const range = sent + 1 === total ? `a parte ${total}` : `as partes ${sent + 1} a ${total}`;
        const full = `${body0}\n-# parte ${sent}/${total} · ⚠️ Não consegui enviar ${range}. Pode pedir de novo.`;
        const short = `${body0}\n-# parte ${sent}/${total} · ⚠️ Não consegui enviar ${range}.`;
        const content = full.length <= DISCORD_LIMIT ? full : short;
        if (content.length > DISCORD_LIMIT) {
            logger.warn(`[LongReply] o aviso das partes ${sent + 1} a ${total} não cabe na parte ${sent}`);
            return false;
        }
        const payload = { content, allowedMentions };
        // Onde escrever: a resposta original do slash (parte 1), a mensagem da parte entregue ou, em menção, a de "Processando...".
        const writer = (kind === 'slash' && sent === 1 && !result.firstReplaced && typeof interaction?.editReply === 'function')
            ? () => interaction.editReply(payload)
            : typeof target?.edit === 'function'
                ? () => target.edit(payload)
                : (kind === 'mention' && sent === 1 && !result.firstReplaced && typeof replyMessage?.edit === 'function')
                    ? () => replyMessage.edit(payload)
                    : null;
        if (!writer) {
            logger.warn(`[LongReply] não há como escrever o aviso das partes ${sent + 1} a ${total} na parte ${sent}`);
            return false;
        }
        try {
            await attempt(writer, { retryable: false, label: `aviso na parte ${sent}` });
            return true;
        } catch (err) {
            logger.error(`[LongReply] o aviso de partes faltando não pôde ser escrito na parte ${sent} (${describeError(err)})`);
            return false;
        }
    }

    // Fim de uma sequência que quebrou no meio: marca a entrega como parcial quando o restante não chegou nem em arquivo.
    //   'attachment' = o texto todo chegou (o anexo carrega o restante): entrega completa, só degradada;
    //   'notice'     = chegou o aviso à parte, mas falta texto: ok (a parte 1 foi entregue), partial true;
    //   'none'       = nada avisou o usuário: aviso editado na última parte, ok false, partial true.
    async function settlePartial(run) {
        if (!run?.rest || run.rest === 'attachment') return;
        result.partial = true;
        if (run.rest === 'notice') return;
        result.ok = false;
        await noticeOnLastPart(run.previous);
    }

    // Entrega sequencial de parts[0..count-1]: cada parte só sai depois que a anterior foi confirmada. Arquivos, botões e
    // embeds (`lastExtra`) vão só na última parte enviada; `lastContent` troca o texto dela (aviso de que faltou texto).
    // Devolve { firstFailed, firstFallbackOk, completed, previous, rest }; `rest` (só quando a sequência quebrou no meio) diz como o
    // restante foi tratado: 'attachment', 'notice' ou 'none' (ver fallbackRest).
    async function deliverSequence(count, { lastExtra = {}, lastContent = null } = {}) {
        let previous = null;
        for (let i = 0; i < count; i++) {
            const isLast = i === count - 1;
            if (i > 0 && expired()) {
                logger.warn(`[LongReply] prazo de entrega estourado antes da parte ${i + 1}/${total}`);
                const rest = await fallbackRest(i, previous, 'prazo de entrega');
                return { firstFailed: false, firstFallbackOk: false, completed: false, previous, rest };
            }
            try {
                const content = isLast && lastContent != null ? lastContent : parts[i].content;
                // A parte 1 é uma edição (limpa o que a mensagem de "Processando..." tinha); as demais só levam o que existe.
                const extra = !isLast ? {} : i === 0 ? lastExtra : Object.fromEntries(Object.entries(lastExtra).filter(([, v]) => Array.isArray(v) && v.length > 0));
                const msg = i === 0 ? await deliverFirst(content, extra) : await deliverNext(content, previous, extra);
                previous = msg;
                result.sentParts++;
                result.message = msg;
                if (i === 0) result.firstMessage = msg;
            } catch (err) {
                logger.error(`[LongReply] falha ao enviar a parte ${i + 1}/${total} (${describeError(err)}, tamanho=${parts[i].content.length})`);
                if (i === 0) {
                    // Nem a primeira saiu: tenta o texto completo como um anexo só (a menos que o anexo já tenha falhado).
                    const rest0 = await fallbackRest(0, null, 'erro no envio');
                    return { firstFailed: true, firstFallbackOk: rest0 === 'attachment', completed: false, previous, rest: rest0 };
                }
                const rest = await fallbackRest(i, previous, 'erro no envio');
                return { firstFailed: false, firstFallbackOk: false, completed: false, previous, rest };
            }
        }
        return { firstFailed: false, firstFallbackOk: false, completed: true, previous, rest: null };
    }

    try {
        if (mode === 'attachment') {
            const note = `\n\n📎 Resposta completa no arquivo anexo (${chars} caracteres).`;
            const extraText = note + (footer ? `\n${footer}` : '');
            const cited = collectUserMentions(body);
            const mentionReserve = cited.length ? 40 + cited.length * 24 : 0;
            const head = firstChunk(body.slice(0, 8000), Math.max(300, budget - extraText.length - mentionReserve - 40));
            // Quem já aparece na introdução não se repete; os demais entram como TEXTO (no arquivo a menção não notifica).
            const missing = cited.filter((id) => !new RegExp(`<@!?${id}>`).test(head));
            const mentionLine = missing.length ? `\n\n👥 Citados no arquivo: ${missing.map((id) => `<@${id}>`).join(' ')}` : '';
            const intro = head + note + mentionLine + (footer ? `\n${footer}` : '');
            try {
                const msg = await deliverFirst(intro, {
                    files: [attachmentOf(safeText, `resposta-yui.${attachExt}`), ...files],
                    components,
                    embeds,
                });
                result.sentParts = 1;
                result.parts = 1; // uma mensagem só (com o arquivo): o histórico e o log não podem dizer "N mensagens"
                result.message = msg;
                result.firstMessage = msg;
                result.ok = true;
                result.mode = 'attachment';
                return finish();
            } catch (err) {
                logger.error(`[LongReply] falha ao enviar o anexo da resposta longa (${describeError(err)}, tamanho=${chars})`);
                // Sem o anexo (por exemplo, sem "Anexar arquivos" no canal) o texto não pode ficar só na introdução: entrega as
                // primeiras partes pelo fluxo dividido e termina com um aviso curto do que faltou.
                attachFailed = true;
                const noPermission = Number(err?.code) === 50013 || Number(err?.status) === 403;
                const take = Math.max(1, Math.min(Math.floor(maxParts) || DEFAULT_MAX_PARTS, total));
                const lostAfter = (sent) => Math.max(0, plan.body.length - (sent > 0 ? parts[sent - 1].end : 0));
                const noticeFor = (sent) => `-# 📎 Faltaram ${withThousands(lostAfter(sent))} caracteres (partes ${sent + 1} a ${total}): ${noPermission ? 'preciso da permissão "Anexar arquivos" neste canal para mandar o texto completo' : 'não consegui anexar o texto completo'}.`;
                // O rodapé "-# modelo | tempo" só existe na última parte do plano completo: vai junto do aviso.
                const tail = lostAfter(take) > 0 ? noticeFor(take) + (footer ? `\n${footer}` : '') : '';
                const inlined = tail !== '' && `${parts[take - 1].content}\n${tail}`.length <= DISCORD_LIMIT;
                budgetMs = fallbackMs; // o envio do anexo gastou o prazo: renova para as partes
                budgetStart = now();
                result.degraded = true;
                result.parts = take;
                const run = await deliverSequence(take, { lastExtra: { components, embeds }, lastContent: inlined ? `${parts[take - 1].content}\n${tail}` : null });
                result.ok = result.sentParts > 0;
                result.mode = result.ok ? 'split' : 'failed';
                if (result.ok && run.completed && tail !== '' && !inlined) {
                    try {
                        await deliverNext(tail, run.previous);
                    } catch (err2) {
                        logger.warn(`[LongReply] o aviso do texto que faltou não foi entregue (${describeError(err2)})`);
                    }
                }
                if (result.ok) await settlePartial(run); // a sequência quebrou no meio e nem o anexo nem o aviso à parte saíram
                return finish();
            }
        }

        if (mode === 'single') {
            const msg = await deliverFirst(parts[0].content, { files, components, embeds });
            result.sentParts = 1;
            result.message = msg;
            result.firstMessage = msg;
            result.ok = true;
            result.mode = 'single';
            return finish();
        }

        // Dividida: sequencial, cada parte só sai depois que a anterior foi confirmada.
        const run = await deliverSequence(total, { lastExtra: { files, components, embeds } });
        if (run.firstFailed) {
            result.ok = run.firstFallbackOk;
            result.mode = result.ok ? 'attachment' : 'failed';
            return finish();
        }
        result.ok = result.sentParts > 0;
        result.mode = result.ok ? 'split' : 'failed';
        if (result.ok) await settlePartial(run);
        return finish();
    } catch (err) {
        logger.error(`[LongReply] erro inesperado na entrega (${describeError(err)})`);
        result.ok = result.sentParts > 0;
        result.mode = result.ok ? mode : 'failed';
        return finish();
    }
}

// ---------------------------------------------------------------------------------------------
// Fábrica do unifiedReply (fila do llmHandler)
// ---------------------------------------------------------------------------------------------

/**
 * Cria o `unifiedReply(content, files, components, embeds)` da fila. Contrato preservado:
 * devolve a mensagem (a que carrega botões/embeds/arquivos: na resposta dividida é a ÚLTIMA parte) ou null se falhar.
 * Texto até 2000 caracteres segue o caminho de sempre; só texto maior passa pelo divisor.
 * Voz e rádio NUNCA passam pelo divisor (a resposta vai para a fala; o objeto de resposta é um falso).
 * `reply.lastDelivery` guarda { ok, mode, parts, sentParts, chars, durationMs, degraded?, retried?, noticed?, partial? } da última entrega.
 *
 * Edição final de um texto curto (resposta de verdade: texto não vazio, sem "Processando...", fora de voz e rádio):
 *  1. Falha passageira (5xx, 408/425/429, erro de rede, prazo de 10 s da requisição) é repetida UMA vez, depois de uma pausa curta. Só
 *     edição (idempotente) e só sem arquivo (upload grande não se repete nem tem prazo curto). Mensagem apagada (10008) e qualquer
 *     outro 4xx não repetem: falhariam igual.
 *  2. Plano B: se a edição/resposta falhar porque a mensagem "Processando..." foi apagada (10008), a interação ou o token venceu
 *     (10062, 50027, 10015 ou qualquer 404), o Discord devolveu 5xx ou a requisição estourou o prazo, o MESMO conteúdo vai como mensagem nova (slash público:
 *     followUp e depois channel.send). Nunca em resposta efêmera, voz, rádio, nem para mensagem de progresso (sem texto ou com
 *     "Processando..."). Com a resposta entregue como mensagem nova, a mensagem de progresso antiga é apagada (ou trocada por uma
 *     linha neutra): o subtexto de progresso nunca fica como estado final.
 *  3. Última cartada: se nada entregou (e o alvo da edição ainda existe), o "Processando..." é trocado por um aviso curto
 *     (DELIVERY_FAILED_TEXT). Não vale para envio com arquivo: quem envia arquivo (llmHandler) explica a falha pelo seu lado.
 * `reply.progress` (createProgressReporter): progresso do agente na mensagem "Processando...", fechado antes da resposta final.
 */
export function createUnifiedReply({
    interaction,
    type,
    userId,
    radioMode = false,
    getReplyMessage,
    setReplyMessage,
    resolveMentions = defaultResolveMentions,
    logger = NOOP_LOGGER,
    onError = null,
    limits = {},
    deps = {},
} = {}) {
    let localReply = null;
    const getRm = typeof getReplyMessage === 'function' ? getReplyMessage : () => localReply;
    const setRm = typeof setReplyMessage === 'function' ? setReplyMessage : (m) => { localReply = m; };
    const idText = typeof interaction?.id === 'string' ? interaction.id : '';
    const isVoice = Boolean(interaction?.isVoice || idText.startsWith('voice_'));
    const isRadio = Boolean(radioMode || interaction?.isRadioMode === true || idText.startsWith('radio_voice_'));
    const kind = type === 'mention' ? 'mention' : 'slash';

    const num = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) ? v : fallback);
    const lateSleep = typeof deps?.sleep === 'function' ? deps.sleep : defaultSleep;
    // A pausa da nova tentativa NÃO é "unref": quem a espera é a fila, e um processo de teste sem outro timer vivo não pode sair no meio.
    const retrySleep = typeof deps?.sleep === 'function' ? deps.sleep : (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
    const retryDelayMs = num(deps?.retryDelayMs, EDIT_RETRY_DELAY_MS);
    const lateGraceMs = num(deps?.lateGraceMs, LATE_GRACE_MS);
    const editTimeoutMs = num(limits?.editTimeoutMs, num(deps?.editTimeoutMs, EDIT_TIMEOUT_MS));
    const deliveryBudgetMs = num(limits?.deliveryBudgetMs, num(deps?.deliveryBudgetMs, SHORT_DELIVERY_BUDGET_MS));
    const resendMinMs = num(deps?.resendMinMs, RESEND_MIN_MS);
    const resendMaxMs = num(deps?.resendMaxMs, RESEND_MAX_MS);
    const clock = typeof deps?.now === 'function' ? deps.now : Date.now;

    const tokenFresh = () => {
        const created = Number(interaction?.createdTimestamp);
        return !Number.isFinite(created) || Date.now() - created < TOKEN_SAFE_MS;
    };

    // Chama `fn` com prazo. Se estourar, espera uma folga curta: a requisição abandonada pode ainda completar (a edição JÁ saiu).
    const guarded = async (fn, ms = editTimeoutMs) => {
        try {
            return await withTimeout(Promise.resolve().then(fn), ms);
        } catch (err) {
            if (err?.code === 'DELIVERY_TIMEOUT') {
                const late = await waitLate(err.pending, lateGraceMs, lateSleep);
                if (late.done && late.ok) return late.value;
            }
            throw err;
        }
    };

    // Plano B do texto curto: o MESMO conteúdo como mensagem nova. Devolve a mensagem enviada ou null.
    const resendAsNewMessage = async (payload, err, resendBudgetMs = resendMaxMs) => {
        const oldRm = getRm();
        const channel = oldRm?.channel ?? interaction?.channel ?? null;
        logger.warn(`[LongReply] a mensagem não pôde ser atualizada (${describeError(err)}); enviando como mensagem nova`);
        // Cada passo do plano B tem prazo (o que sobra do orçamento): um followUp/send pendurado não segura mais a fila serial para sempre.
        const resendStartedAt = Date.now();
        const resendLeft = () => Math.max(Math.min(1000, resendBudgetMs), resendBudgetMs - (Date.now() - resendStartedAt));
        try {
            let sent = null;
            if (type !== 'mention' && typeof interaction?.followUp === 'function' && tokenFresh()) {
                try {
                    sent = await guarded(() => interaction.followUp({ ...payload }), resendLeft());
                } catch (err2) {
                    logger.warn(`[LongReply] followUp falhou (${describeError(err2)}); usando o canal`);
                }
            }
            if (!sent) {
                if (!channel || typeof channel.send !== 'function') return null;
                const asReply = type === 'mention' && typeof interaction?.id === 'string';
                sent = await guarded(() => channel.send({ ...payload, ...(asReply ? { reply: { messageReference: interaction, failIfNotExists: false } } : {}) }), resendLeft());
                if (type === 'mention' && sent) setRm(sent); // as próximas edições vão para a mensagem que existe
            }
            if (sent) await retireStaleMessage({ kind, message: oldRm, interaction, err, logger });
            return sent ?? null;
        } catch (err3) {
            logger.error(`[LongReply] o plano B também falhou (${describeError(err3)})`);
            return null;
        }
    };

    // Última cartada: troca o "Processando..." parado por um aviso curto. Devolve true se trocou.
    const noticeInPlace = async () => {
        const p = { content: DELIVERY_FAILED_TEXT, files: [], components: [], embeds: [], allowedMentions: SAFE_ALLOWED_MENTIONS };
        try {
            await withTimeout(Promise.resolve().then(() => (type === 'mention' ? getRm().edit(p) : interaction.editReply(p))), CLEANUP_TIMEOUT_MS);
            return true;
        } catch (err) {
            logger.warn(`[LongReply] o aviso de falha também não pôde ser escrito (${describeError(err)})`);
            return false;
        }
    };

    // Progresso do agente: edita a mensagem "Processando..." SEM mexer em lastDelivery, em onError nem criar mensagem nova.
    const progressEdit = (isVoice || isRadio) ? null : async (text) => {
        const p = { content: text, files: [], components: [], embeds: [], allowedMentions: { parse: [] } };
        if (type === 'mention') {
            const rm = getRm();
            if (!rm || typeof rm.edit !== 'function') return false;
            await rm.edit(p);
            return true;
        }
        if (interaction?.deferred || interaction?.replied) {
            await interaction.editReply(p);
            return true;
        }
        return false;
    };
    const progress = createProgressReporter(progressEdit, { maxEdits: limits?.progressMaxEdits, minGapMs: limits?.progressMinGapMs, now: clock, logger });

    const reply = async (content, files = [], components = [], embeds = []) => {
        const t0 = Date.now();
        // Texto só de espaço, sem arquivo, embed nem botão: o Discord recusa mensagem vazia.
        if (typeof content === 'string' && content.trim() === '' && !hasExtras(files, components, embeds)) content = EMPTY_REPLY_TEXT;
        if (isVoice) {
            const isProcessingMsg = typeof content === 'string' && content.includes('Processando...');
            if (!isProcessingMsg && content && typeof content === 'string' && !content.includes(`<@${userId}>`)) {
                content = `<@${userId}> ${content}`;
            }
        }
        // "@usuario" escrito pela IA vira <@ID> (e @everyone/@here são neutralizados). O divisor roda DEPOIS disto
        // porque o nome curto vira ~21 caracteres.
        if (typeof content === 'string' && content.includes('@')) {
            try { content = await resolveMentions(content, interaction?.guild); } catch (_) { /* mantém o texto */ }
        }
        const isProgress = typeof content === 'string' && content.includes('Processando...');
        const realText = typeof content === 'string' && content.trim() !== '' && !isProgress;
        // A edição de progresso em andamento termina ANTES da entrega (e, numa resposta de verdade, o progresso fecha): nenhuma
        // edição velha pode chegar depois e deixar o subtexto de progresso como estado final.
        if (!isProgress && progress.edits > 0) {
            if (realText) await progress.settle(PROGRESS_SETTLE_MS); else await progress.drain(PROGRESS_SETTLE_MS);
        }
        if (typeof content === 'string' && content.length > DISCORD_LIMIT) {
            if (isVoice || isRadio) {
                logger.warn(`[LongReply] resposta de voz/rádio com ${content.length} caracteres: cabe numa mensagem só (sem divisor)`);
                content = capSingleMessage(content);
            } else {
                const delivery = await sendLongReply({
                    kind,
                    interaction,
                    replyMessage: getRm(),
                    text: content,
                    files,
                    components,
                    embeds,
                    allowedMentions: SAFE_ALLOWED_MENTIONS,
                    maxParts: limits.maxParts ?? parseMaxParts(),
                    logger,
                    ...deps,
                });
                reply.lastDelivery = delivery;
                if (type === 'mention' && delivery.firstMessage && (!getRm() || delivery.firstReplaced)) setRm(delivery.firstMessage);
                return delivery.ok ? delivery.message : null;
            }
        }
        const payload = { content, files, components, embeds, allowedMentions: SAFE_ALLOWED_MENTIONS };
        const chars = typeof content === 'string' ? content.length : 0;
        const plain = !isVoice && !isRadio;
        const noFiles = !hasExtras(files);
        // Só EDIÇÃO se repete (criar a mensagem de novo poderia duplicá-la).
        const isEdit = type === 'mention' ? Boolean(getRm()) : Boolean(interaction.deferred || interaction.replied);
        const canRetry = plain && isEdit && !isProgress && noFiles;
        const deliverOnce = async () => {
            if (type === 'mention') {
                let rm = getRm();
                if (!rm) {
                    rm = await interaction.reply({ ...payload, fetchReply: true, failIfNotExists: false });
                    setRm(rm);
                } else {
                    await rm.edit(payload);
                }
                return rm;
            }
            if (interaction.deferred || interaction.replied) return interaction.editReply(payload);
            return interaction.reply({ ...payload, fetchReply: true });
        };
        let retried = 0;
        let message = null;
        let failure = null;
        for (;;) {
            try {
                message = await ((plain && noFiles) ? guarded(deliverOnce) : deliverOnce());
                failure = null;
                break;
            } catch (err) {
                failure = err;
                if (retried >= 1 || !canRetry || !isRetryableEditError(err)) break;
                // Sem orçamento para outra edição inteira (pausa + prazo): a repetição só atrasaria a fila; vai direto ao plano B.
                if (Date.now() - t0 + retryDelayMs + editTimeoutMs > deliveryBudgetMs) {
                    logger.warn(`[LongReply] a edição da resposta falhou (${describeError(err)}); sem orçamento para repetir, indo ao plano B`);
                    break;
                }
                retried++;
                logger.warn(`[LongReply] a edição da resposta falhou (${describeError(err)}); repetindo uma vez`);
                await retrySleep(retryDelayMs);
            }
        }
        if (!failure) {
            reply.lastDelivery = { ok: true, mode: 'single', parts: 1, sentParts: 1, chars, durationMs: Date.now() - t0, ...(retried ? { retried } : {}) };
            return message;
        }
        const err = failure;
        reply.lastDelivery = { ok: false, mode: 'failed', parts: 1, sentParts: 0, chars, durationMs: Date.now() - t0 };
        if (typeof onError === 'function') onError(err);
        // Só mensagem de resposta de verdade (texto não vazio, sem "Processando..."), fora de voz/rádio e de resposta efêmera,
        // e só para erros em que reenviar adianta (reenviar o mesmo corpo em 50035/50013/40005 falha igual).
        const canResend = plain && interaction?.ephemeral !== true && realText && (isRecoverableEditError(err) || isTargetGoneError(err) || err?.code === 'DELIVERY_TIMEOUT');
        if (canResend) {
            const sent = await resendAsNewMessage(payload, err, Math.min(resendMaxMs, Math.max(resendMinMs, deliveryBudgetMs - (Date.now() - t0))));
            if (sent) {
                reply.lastDelivery = { ok: true, mode: 'single', parts: 1, sentParts: 1, chars, durationMs: Date.now() - t0, degraded: true, ...(retried ? { retried } : {}) };
                return sent;
            }
        }
        // Nada foi entregue. Se a mensagem de "Processando..." ainda existe, ela não pode ficar como estado final.
        if (plain && isEdit && realText && noFiles && !isTargetGoneError(err) && await noticeInPlace()) {
            reply.lastDelivery = { ...reply.lastDelivery, noticed: true, durationMs: Date.now() - t0 };
        }
        return null;
    };
    reply.lastDelivery = null;
    reply.progress = progress;
    return reply;
}

// ---------------------------------------------------------------------------------------------
// Resposta cortada por limite de tokens: continuação
// ---------------------------------------------------------------------------------------------

/** finish_reason de "acabou o orçamento de saída" (OpenAI: length; Gemini nativo: MAX_TOKENS). */
export function isTruncatedFinish(reason) {
    return /^(length|max_tokens|max_output_tokens)$/i.test(String(reason ?? '').trim());
}

/** O rascunho parece uma chamada de ferramenta em JSON? Então não se continua (não é texto para o usuário). */
export function looksLikeToolJson(text) {
    const t = String(text ?? '').trim();
    return t.startsWith('{') || /"tool"\s*:/.test(t) || /^tool_code/i.test(t);
}

/** Decodifica o miolo de uma string JSON que pode ter sido cortada no meio (escape incompleto, par substituto solto). */
function decodeJsonStringPartial(raw) {
    const s = String(raw ?? '').replace(/\\u[0-9a-fA-F]{0,3}$/, ''); // \uXXXX cortado
    let out;
    try {
        out = JSON.parse(`"${s}"`);
    } catch (_) {
        // quebra de linha crua ou escape inválido: decodifica à mão o que der
        out = s
            .replace(/\\u([0-9a-fA-F]{4})/g, (_m, h) => String.fromCharCode(parseInt(h, 16)))
            .replace(/\\(["\\/bfnrt])/g, (_m, c) => ({ b: '\b', f: '\f', n: '\n', r: '\r', t: '\t' }[c] ?? c));
    }
    return out.replace(/[\uD800-\uDBFF]$/, ''); // metade de um emoji no fim
}

/**
 * Texto da resposta dentro dos argumentos de uma chamada de ferramenta `generate_reply`, mesmo que o JSON dos
 * argumentos tenha sido cortado pelo limite de tokens (recupera o `content` parcial por regex).
 *  - parsed:   os argumentos eram um JSON válido;
 *  - complete: o texto de `content` chegou até a aspa final (a resposta em si não foi cortada).
 * @param {string|object} argumentsText argumentos da chamada (texto JSON, ou o objeto já lido)
 * @returns {{ content: string, parsed: boolean, complete: boolean }}
 */
export function recoverReplyContent(argumentsText) {
    if (argumentsText && typeof argumentsText === 'object') {
        const c = typeof argumentsText.content === 'string' ? argumentsText.content : '';
        return { content: c, parsed: true, complete: true };
    }
    const raw = String(argumentsText ?? '');
    try {
        const obj = JSON.parse(raw);
        return { content: typeof obj?.content === 'string' ? obj.content : '', parsed: true, complete: true };
    } catch (_) {
        // JSON incompleto: segue para a recuperação parcial
    }
    const m = /"content"\s*:\s*"((?:[^"\\]|\\[\s\S])*)("?)/.exec(raw);
    if (!m) return { content: '', parsed: false, complete: false };
    return { content: decodeJsonStringPartial(m[1]), parsed: false, complete: m[2] === '"' };
}

/**
 * Junta o rascunho com a continuação, tirando a sobreposição da emenda (até 80 caracteres que o modelo repetiu).
 */
export function mergeContinuation(draft, continuation) {
    const a = String(draft ?? '').replace(/\s+$/, '');
    let b = String(continuation ?? '').replace(/^\s+/, '');
    if (!b) return a;
    if (!a) return b;
    const maxK = Math.min(80, a.length, b.length);
    for (let k = maxK; k >= 5; k--) {
        const piece = b.slice(0, k);
        const at = a.length - k;
        if (a.endsWith(piece) && (at === 0 || !/[\p{L}\p{N}]/u.test(a[at - 1]) || !/[\p{L}\p{N}]/u.test(piece[0]))) {
            return a + b.slice(k);
        }
    }
    if (/^[,.;:!?)\]}]/.test(b)) return a + b;
    if (/^(?:\d{1,3}[.)]|[-*•#>])\s/.test(b)) return `${a}\n${b}`;
    return `${a} ${b}`;
}

// ---------------------------------------------------------------------------------------------
// Promessas que a Yui não cumpre
// ---------------------------------------------------------------------------------------------

const deaccent = (s) => String(s ?? '').normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();

const DEFERRAL = '(?:depois|mais tarde|amanha|quando|assim que|em breve|logo mais|ja ja|ainda hoje|na hora|mais pra frente|mais adiante|daqui a|daqui um|semana que vem|proxima semana|outro dia|hoje a noite|de noite|em instantes|mais um pouco)';
const DEFERRAL_RE = new RegExp(`\\b${DEFERRAL}\\b`);

// Promessas inequívocas: valem sozinhas.
const PROMISE_PATTERNS = [
    /\b(?:anotei|anotado|anotada|guardei|salvei|registrei|memorizei)\b/,
    /\bdeixei (?:anotad[oa]|guardad[oa]|salv[oa]|registrad[oa])\b/,
    /\bvou (?:te )?(?:anotar|guardar|registrar|agendar)\b/,
    /\bvou (?:te )?avisar(?!\s*(?::|que\b|de que\b))/,
    /\bvou te lembrar(?!\s*(?::|que\b|de que\b|como\b|quem\b|onde\b|o que\b))/,
    /\bvou (?:deixar|ficar) (?:anotad[oa]|guardad[oa])\b/,
    /\bte aviso(?!\s*(?::|que\b|de que\b))/,
    new RegExp(`\\bte (?:mando|envio|passo|lembro|chamo|dou um toque|respondo|falo|escrevo)\\b[^.!?\\n]{0,40}\\b${DEFERRAL}\\b`),
    /\b(?:mando|envio|aviso|retorno|respondo|volto) (?:depois|mais tarde|em breve)\b/,
    /\bpode deixar que eu (?:avis|mand|envi|lembr|anot|guard)/,
    /\bme (?:manda|mande|envia|envie) (?:um|uma) (?:ponto|pingo|oi|mensagem)\b[^.!?\n]{0,60}\b(?:continu|segu|proxim|resto|parte)/,
];
// Verbos de entrega comuns ("vou te mandar o link:", "vou enviar a lista abaixo", "vou chamar de bobo", "vou salvar o arquivo"):
// quase sempre é a entrega IMEDIATA na própria resposta. Só viram promessa com marcador de adiamento na mesma frase.
const DEFERRED_ONLY_PATTERNS = [
    /\bvou (?:te )?(?:mandar|enviar|passar|encaminhar|lembrar|salvar|programar|chamar)\b/,
];
const NEGATION_BEFORE_RE = /\b(?:nao|nunca|jamais|sem|nem)\b[^.!?\n]{0,14}$/;
const SENTENCE_END_BEFORE_RE = /(?:[.!?;]+(?=\s)|\n)/g;
const SENTENCE_END_AFTER_RE = /(?:[.!?;]+(?=\s|$)|:(?=\s|$)|\n)/;

/** A frase (de ponto a ponto) que contém o trecho; depois do trecho, os dois-pontos também encerram (começa a lista/o link). */
function sentenceAround(t, index, length) {
    const last = [...t.slice(0, index).matchAll(SENTENCE_END_BEFORE_RE)].pop();
    const start = last ? last.index + last[0].length : 0;
    const after = t.slice(index + length);
    const next = SENTENCE_END_AFTER_RE.exec(after);
    return t.slice(start, next ? index + length + next.index : t.length);
}

/** A resposta promete uma ação futura (anotar, avisar, mandar depois)? */
export function promisesFutureAction(text) {
    // sem rodapé "-# ..." e sem URLs (um "/depois.html" no link não é marcador de adiamento)
    const t = deaccent(String(text ?? '').replace(/^-# .*$/gm, ' ').replace(/https?:\/\/\S+/gi, ' '));
    const negated = (m) => NEGATION_BEFORE_RE.test(t.slice(Math.max(0, m.index - 20), m.index));
    for (const re of PROMISE_PATTERNS) {
        for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
            if (!negated(m)) return true;
        }
    }
    for (const re of DEFERRED_ONLY_PATTERNS) {
        for (const m of t.matchAll(new RegExp(re.source, 'g'))) {
            if (!negated(m) && DEFERRAL_RE.test(sentenceAround(t, m.index, m[0].length))) return true;
        }
    }
    return false;
}

/**
 * Se a resposta promete algo que o código não fez, anexa o aviso fixo (antes do rodapé "-# ...").
 * `savedSomething`: o código gravou algo de verdade (ex.: memória capturada) — então a promessa é verdadeira.
 */
export function applyPromiseNotice(text, { savedSomething = false } = {}) {
    const original = String(text ?? '');
    if (savedSomething || original.includes(PROMISE_NOTICE) || !promisesFutureAction(original)) return original;
    const { body, footer } = splitFooter(original);
    return `${body}\n\n${PROMISE_NOTICE}${footer ? `\n${footer}` : ''}`;
}

// ---------------------------------------------------------------------------------------------
// ANTI-ECO, histórico, contexto do Discord e log
// ---------------------------------------------------------------------------------------------

const LIST_REQUEST_RE = /\b(?:list[ae]r?|liste|enumer\w*|relacion\w*|todos os|todas as|passo a passo|tabela|cat[aá]logo|cronograma|checklist|resum[ao] (?:de )?tudo)\b/i;

/** Mensagem longa (> 200) ou pedido explícito de lista: a resposta pode (e deve) repetir trechos; o ANTI-ECO não descarta. */
export function antiEchoExempt(userText) {
    const t = String(userText ?? '');
    return t.length > 200 || LIST_REQUEST_RE.test(t);
}

/** Cópia aparada da resposta para o histórico da conversa (sem rodapé; nunca o texto inteiro de 20 mil caracteres). */
export function historyCopy(text, { parts = 1, maxChars = 1200 } = {}) {
    const { body } = splitFooter(String(text ?? ''));
    let out = body;
    if (out.length > maxChars) out = `${firstChunk(out, maxChars)} […]`;
    if (parts > 1) out += ` [resposta entregue em ${parts} mensagens]`;
    return out;
}

/** Posição de corte (<= limit) que não parte um par substituto nem um grafema (emoji, ZWJ, bandeira) ao meio. */
function cutPoint(s, limit) {
    if (limit >= s.length) return s.length;
    if (segmenter) {
        let end = 0;
        for (const { index, segment } of segmenter.segment(s.slice(0, limit + 40))) {
            if (index + segment.length > limit) break;
            end = index + segment.length;
        }
        if (end > 0) return end;
    }
    const code = s.charCodeAt(limit - 1);
    return code >= 0xD800 && code <= 0xDBFF ? limit - 1 : limit;
}

/**
 * Corta a mensagem do contexto do Discord (padrão 500; a respondida e a última do mesmo autor mantêm até 4000, o teto de uma
 * mensagem com Nitro). O corte deixa um marcador "[... cortada: N caracteres no original]" para a IA saber que o texto não está inteiro.
 */
export function clipContextText(content, limit = 500) {
    const s = String(content ?? '');
    if (s.length <= limit) return s;
    return `${s.slice(0, cutPoint(s, Math.max(0, Math.floor(limit))))} [... cortada: ${s.length} caracteres no original]`;
}

/** Ids das mensagens do contexto que merecem o limite maior: a respondida e a última do mesmo autor (lista ordenada do mais antigo ao mais novo). */
export function longContextIds(messages, { repliedId = null, authorId = null } = {}) {
    const ids = new Set();
    if (repliedId) ids.add(repliedId);
    if (authorId) {
        for (let i = messages.length - 1; i >= 0; i--) {
            const m = messages[i];
            if (m?.author?.id === authorId) { ids.add(m.id); break; }
        }
    }
    return ids;
}
export const LONG_CONTEXT_LIMIT = 4000;
export const SHORT_CONTEXT_LIMIT = 500;

/** Uma linha por entrega, SEM o conteúdo. `partial`: faltou texto (partes que não chegaram); `retried`: a edição final precisou de nova tentativa. */
export function formatDeliveryLog({
    chars = 0, parts = 1, sentParts = parts, mode = 'single', ok = true, channelKind = 'servidor',
    durationMs = 0, deliveryMs = 0, provider = 'n/d', model = 'n/d', finishReason = 'n/d', continuations = 0,
    partial = false, retried = 0,
} = {}) {
    const modes = { single: 'unica', split: 'dividida', attachment: 'anexo', failed: 'falhou' };
    const clean = (v) => String(v ?? 'n/d').replace(/[\r\n"]+/g, ' ').trim().slice(0, 80) || 'n/d';
    const extra = `${partial ? ' parcial=sim' : ''}${retried ? ` repeticoes=${Math.max(0, Math.floor(Number(retried)) || 0)}` : ''}`;
    return `[Resposta] entrega ${ok ? 'ok' : 'FALHOU'} caracteres=${chars} partes=${sentParts}/${parts} modo=${modes[mode] ?? mode} canal=${channelKind} duracao=${durationMs}ms envio=${deliveryMs}ms provedor=${clean(provider)} modelo="${clean(model)}" finish=${clean(finishReason)} continuacoes=${continuations}${extra}`;
}
