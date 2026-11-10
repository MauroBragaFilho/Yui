// Porta B (Biblioteca): "yui procura Matrix na biblioteca", "o que eu tenho de filmes?", "quanto espaço tem no servidor de arquivos?",
// "o que chegou de novo na biblioteca?". Decidido pelo CÓDIGO, sem depender de o modelo lembrar da ferramenta bds.*.
// Módulo puro: sem Discord, sem rede própria (usa bdsLibrary, injetável), sem ler o .env no import.
//
// Regras (docs/content_pt/CONVERSA_E_COMANDOS.md):
//  - só o DONO; só pedido DIRETO à Yui, em texto (nada de voz, rádio, anexo, log de terceiros nem ferramentas desligadas);
//  - só dispara quando a pessoa fala da BIBLIOTECA/servidor/BDS ("na biblioteca", "meus filmes"...): "tem o filme Matrix?" sozinho é conversa comum;
//  - pergunta de capacidade ("você consegue procurar...?"), negação, link e texto colado não disparam;
//  - o nome de arquivo é DADO (não vira ordem); a pasta vem de uma lista fixa de apelidos;
//  - o conteúdo da biblioteca só aparece em DM/canal privado: em canal público a Yui avisa e não mostra nada;
//  - SOMENTE LEITURA: a Yui nunca escreve, move nem apaga arquivos da biblioteca.
import { FOLDER_ALIASES, readBdsConfig, runLibraryAction } from '../services/bdsLibrary.js';

export const LIBRARY_REQUEST_MAX_CHARS = 300;
export const QUERY_MAX_CHARS = 80;

function fold(text) {
    return String(text ?? '').normalize('NFC').normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function stripAddressing(text) {
    let t = String(text ?? '').replace(/<@!?\d+>/g, ' ').replace(/\s+/g, ' ').trim();
    t = t.replace(/^(?:e a[ií]|ei|oi|ol[aá]|opa|fala|salve)[\s,!.]+/i, '');
    t = t.replace(/^@?yui\b[\s,:!.-]*/i, '');
    t = t.replace(/^(?:por favor|pf|pfv|pls|please)[\s,:!.-]*/i, '');
    t = t.replace(/[\s,.!?]*\b(?:por favor|pf|pfv|pls|please)\b[\s,.!?]*$/i, '').trim();
    return t;
}

function gate(text, ctx = {}) {
    const { voice = false, direct = false, radioMode = false, disableTools = false, thirdPartyPrompt = false, hasAttachment = false } = ctx;
    if (typeof text !== 'string' || !text.trim()) return '';
    if (voice || radioMode || disableTools || thirdPartyPrompt || hasAttachment || !direct) return '';
    if (/\n[\s\S]*\n[\s\S]*\n/.test(text)) return '';
    const clean = stripAddressing(text);
    if (!clean || clean.length > LIBRARY_REQUEST_MAX_CHARS) return '';
    if (/https?:\/\//i.test(clean)) return '';
    return clean;
}

// Pergunta de capacidade, negação e "como faço": nunca é ordem.
const NOT_AN_ORDER_RE = /\b(?:nao|nunca|como(?!\s+(?:esta|ta)\b)|consegue|sera que|por ?que|da pra|ser capaz|onde fica)\b/i;

const PLACE = '(?:biblioteca|servidor(?:\\s+de\\s+arquivos)?|bds(?:\\s+server)?|notebook|arquivos)';
const IN_PLACE = `(?:na|no|nos|nas|em)\\s+(?:minha\\s+|meu\\s+|meus\\s+|minhas\\s+)?${PLACE}\\b`;
const LIB_REF_RE = new RegExp(`\\b(?:${IN_PLACE}|minha\\s+biblioteca|meu\\s+servidor(?:\\s+de\\s+arquivos)?|servidor\\s+de\\s+arquivos|meus\\s+arquivos)`);
const ART = '(?:o\\s+|a\\s+|os\\s+|as\\s+|um\\s+|uma\\s+)?';
const KIND = '(?:(?:filme|serie|musica|video|arquivo|pasta)s?\\s+)?';
// Os grupos de captura usam o flag "d" (índices) para recortar o texto ORIGINAL (com acento) pela posição achada no texto sem acento.
const SEARCH_RES = [
    new RegExp(`\\b(?:procura|procure|busca|busque|acha|ache|encontra|encontre|pesquisa|pesquise|localiza|localize)\\s+(?:por\\s+|pelo\\s+|pela\\s+)?${ART}${KIND}(.{2,100}?)\\s+${IN_PLACE}`, 'd'),
    new RegExp(`\\b(?:eu\\s+)?(?:tenho|tem|existe|temos)\\s+${ART}${KIND}(.{2,100}?)\\s+${IN_PLACE}`, 'd'),
    new RegExp(`\\b(?:na|no)\\s+(?:minha\\s+|meu\\s+)?${PLACE}[,:]?\\s+(?:procura|procure|busca|busque|tem|existe)\\s+${ART}${KIND}(.{2,100})$`, 'd')
];

const STATUS_RE = /\b(?:quanto|qual|que)\b[^.!?\n]{0,30}\b(?:espaco|disco|armazenamento|livre|sobrando|ocupado|usado)\b/;
const STATUS_ALT_RE = /\b(?:como (?:esta|ta)|esta (?:no ar|ligado|funcionando|online)|ta (?:no ar|ligado|funcionando|online))\b/;
const RECENT_RE = /\b(?:o que|quais?|que)\b[^.!?\n]{0,40}\b(?:chegou|entrou|foi (?:adicionado|salvo|baixado)|adicionei|baixei|salvei)\b|\b(?:novidades?|ultimos? arquivos?|arquivos? (?:novos?|recentes?)|recentes?)\b/;
const LIST_VERB_RE = /\b(?:o que|quais?|lista(?:r)?|liste|mostra(?:r)?|mostre|me mostra|ver)\b/;
const OWNERSHIP_RE = /\b(?:meus?|minhas?|tenho|temos|na biblioteca|no servidor|no bds|no notebook)\b/;
const CATEGORY_RE = /\b(filmes?|series?|downloads?|projetos?|backups?|biblioteca)\b/g;

/**
 * Decide se a fala é um pedido claro sobre a biblioteca.
 * @returns {{kind:'none'|'search'|'list'|'recent'|'status', query?:string, folder?:string, reason:string}}
 */
export function detectLibraryRequest(text, ctx = {}) {
    const clean = gate(text, ctx);
    if (!clean) return { kind: 'none', reason: 'contexto ou texto não serve' };
    const folded = fold(clean).toLowerCase();
    if (NOT_AN_ORDER_RE.test(folded)) return { kind: 'none', reason: 'pergunta, negação ou como-fazer' };

    // Busca por nome (precisa citar a biblioteca)
    for (const re of SEARCH_RES) {
        const m = re.exec(folded);
        if (!m || !m.indices?.[1]) continue;
        let q = clean.slice(m.indices[1][0], m.indices[1][1]).replace(/^["'“”‘’]+|["'“”‘’?!.,;:\s]+$/g, '').replace(/\s+/g, ' ').trim();
        if (!q || /[\\/]|\.\./.test(q) || q.length < 2) continue;
        return { kind: 'search', query: q.slice(0, QUERY_MAX_CHARS), reason: 'busca na biblioteca' };
    }

    const hasLib = LIB_REF_RE.test(folded);
    if (hasLib && (STATUS_RE.test(folded) || STATUS_ALT_RE.test(folded))) return { kind: 'status', reason: 'estado do servidor de arquivos' };
    if (hasLib && RECENT_RE.test(folded)) return { kind: 'recent', reason: 'o que chegou de novo' };

    // Listar uma pasta (precisa de verbo de listar, de "meu/tenho/na biblioteca" e de UMA categoria clara)
    if (LIST_VERB_RE.test(folded) && OWNERSHIP_RE.test(folded)) {
        // "biblioteca" sozinha é ambígua (a biblioteca inteira?): só lista quando a pessoa cita UMA pasta específica.
        const specific = [...new Set([...folded.matchAll(CATEGORY_RE)].map((m) => m[1]))].filter((c) => c !== 'biblioteca');
        if (specific.length === 1 && FOLDER_ALIASES[specific[0]]) return { kind: 'list', folder: specific[0], reason: 'listar pasta' };
    }
    return { kind: 'none', reason: 'não é pedido sobre a biblioteca' };
}

export function libraryPreRouteEnabled(env = process.env) {
    const cfg = readBdsConfig(env);
    return cfg.enabled && cfg.preRoute;
}

const PRIVATE_ONLY_TEXT = 'Isso é do meu servidor de arquivos, então só mostro por DM ou canal privado. 🙂';

/**
 * Executa o pedido. Nunca lança. `handled:false` => segue para o modelo (não é dono, desligado ou não é pedido da biblioteca).
 * @param {object} entry  { text, isOwner, privateChat, ...ctx do detect }
 * @param {object} deps   { env, config, fetchImpl, run (injeção p/ teste), audit }
 */
export async function routeLibrary(entry = {}, deps = {}) {
    try {
        if (entry.isOwner !== true) return { handled: false, reason: 'só o dono' };
        const env = deps.env ?? process.env;
        const cfg = deps.config ?? readBdsConfig(env);
        if (!cfg.enabled || !cfg.preRoute) return { handled: false, reason: 'desligado' };
        const intent = detectLibraryRequest(entry.text, entry);
        if (intent.kind === 'none') return { handled: false, reason: intent.reason };
        if (entry.privateChat !== true) return { handled: true, text: PRIVATE_ONLY_TEXT, kind: 'library', private: false, historyLine: null };
        const run = deps.run ?? runLibraryAction;
        const text = await run(intent.kind, { query: intent.query, folder: intent.folder }, { config: cfg, fetchImpl: deps.fetchImpl });
        try { deps.audit?.('library.chat', { kind: intent.kind }, { ok: true }); } catch (_) { /* auditoria nunca derruba */ }
        return { handled: true, text, kind: 'library', private: true, historyLine: null };
    } catch (_) {
        return { handled: false, reason: 'erro' };
    }
}
