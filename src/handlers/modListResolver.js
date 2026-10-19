/**
 * RESOLVEDOR DE LISTA DE MODS (Minecraft).
 *
 * Por que existe: alguém manda 70 nomes de mods e pede "o link de download de cada". A pesquisa na web do agente faz 1 a 2 buscas por
 * pedido (limite de 5 por hora por pessoa): 70 buscas são inviáveis, e o modelo, sem ferramenta, só repetia os nomes ou, pior, inventava link.
 * Aqui o CÓDIGO faz o trabalho, de forma determinística e SEM IA:
 *
 *   TEXTO -> parseModList (itens, dicas de loader/versão) -> triagem de dado pessoal -> busca de cada nome na API pública do Modrinth
 *   (sem chave) -> correspondência aproximada (achado / achei como X, confira / não achado) -> escada de recuperação para erro de digitação
 *   -> par (loader, versão do Minecraft) em que MAIS mods existem juntos -> versão real de cada mod nesse par (link) -> dependências
 *   OBRIGATÓRIAS que não estão na lista ("Important Complements") -> texto final.
 *
 * Regras de ouro:
 *  1. Nenhum link é inventado: só vale o que a API devolveu (slug e id de versão validados) ou os links de BUSCA fixos
 *     (modrinth.com/mods?q= e www.curseforge.com/minecraft/search), sempre marcados como "busca". Link escrito pelo usuário nunca é seguido nem repetido.
 *  2. Tudo que vem do usuário ou da API passa por plainText/mdLink (sem menção, sem @everyone, sem markdown quebrado, sem URL).
 *  3. Limites: itens (YUI_MODLIST_MAX_ITEMS), prazo total (YUI_MODLIST_DEADLINE_MS) com resultado PARCIAL honesto, concorrência
 *     (YUI_MODLIST_CONCURRENCY), 429 com espera e abandono ordenado, uma lista por pessoa e no máximo 2 no total, bytes por resposta.
 *  4. Conversa PRIVADA só consulta o Modrinth se o YUI_PRIVATE_SEARCH liberar; senão responde só com links de busca, dizendo por quê.
 *  5. Log só com metadados (itens, achados, pedidos, ms): nunca os nomes.
 *  6. Tudo é injetável (fetch no formato do safeFetchText, relógio, sono, contexto, configuração): os testes não usam rede.
 *
 * Não importa llmHandler, ask nem messageCreate (sem ciclo). Entradas: routeModList (/yui, +yui e menção/DM na fila) e resolveModList.
 */
import { readResearchConfig, privateSearchAllowed, scrubQuery, plainText, mdLink, cleanUrl } from './researchAgent.js';
import { neutralizeMassMentions } from '../discord/mentions.js';
import { safeFetchText } from '../search/safeFetch.js';
import { logger } from '../utils/logger.js';

const NL = '\n';
const CR = '\r';

// ---------------------------------------------------------------------------------------------
// 1. Configuração (YUI_MODLIST_*): lida a cada uso, nunca no import
// ---------------------------------------------------------------------------------------------

export const MODLIST_DEFAULTS = Object.freeze({
    enabled: true,
    maxItems: 120,
    deadlineMs: 120_000,
    concurrency: 3,
    maxJobs: 2, // listas ao mesmo tempo, somando todas as pessoas
    slotTtlMs: 5 * 60_000, // vaga esquecida expira
});

const clampInt = (value, fallback, min, max) => {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(n) && n >= min ? Math.min(max, n) : fallback;
};
const flag = (value, fallback) => {
    const s = String(value ?? '').trim().toLowerCase();
    if (!s) return fallback;
    if (['false', '0', 'off', 'no', 'nao', 'não'].includes(s)) return false;
    if (['true', '1', 'on', 'yes', 'sim'].includes(s)) return true;
    return fallback;
};

/** YUI_MODLIST_ENABLED (true) | YUI_MODLIST_MAX_ITEMS (120; 5 a 300) | YUI_MODLIST_DEADLINE_MS (120000; 20000 a 300000) | YUI_MODLIST_CONCURRENCY (3; 1 a 5). */
export function readModlistConfig(env = process.env) {
    return {
        enabled: flag(env?.YUI_MODLIST_ENABLED, MODLIST_DEFAULTS.enabled),
        maxItems: clampInt(env?.YUI_MODLIST_MAX_ITEMS, MODLIST_DEFAULTS.maxItems, 5, 300),
        deadlineMs: clampInt(env?.YUI_MODLIST_DEADLINE_MS, MODLIST_DEFAULTS.deadlineMs, 20_000, 300_000),
        concurrency: clampInt(env?.YUI_MODLIST_CONCURRENCY, MODLIST_DEFAULTS.concurrency, 1, 5),
    };
}

const API_BASE = 'https://api.modrinth.com/v2';
export const MODRINTH_USER_AGENT = 'Yui-Discord-Bot/1.0 (https://github.com/MauroBragaFilho/Yui)';
const LIMITS = Object.freeze({
    maxResponseBytes: 2_000_000, // por resposta
    requestDeadlineMs: 10_000, // prazo de UMA requisição
    minRequestMs: 400, // sem pelo menos isto de prazo, nem tenta
    maxPerMinute: 240, // ritmo próprio, abaixo dos 300 por minuto do Modrinth
    searchTtlMs: 6 * 3_600_000,
    versionsTtlMs: 3_600_000,
    projectsTtlMs: 6 * 3_600_000,
    cacheMax: 400,
    maxComplementLookups: 100, // dependências distintas consultadas; o que passar disso é avisado no texto
    searchStageShare: 0.6, // fração do prazo reservada à fase de busca (o resto confere versões e complementos)
});

// ---------------------------------------------------------------------------------------------
// 2. Textos
// ---------------------------------------------------------------------------------------------

export const MODLIST_TEXT = Object.freeze({
    title: (n) => `**Lista de mods: ${n} ${n === 1 ? 'nome' : 'nomes'}**`,
    counts: ({ ok, fuzzy, none, skipped, dup }) => {
        const parts = [`Achei **${ok}** no Modrinth`];
        if (fuzzy) parts.push(`**${fuzzy}** por nome parecido ou variante do mod (confira)`);
        if (none) parts.push(`**${none}** sem resultado (só link de busca)`);
        if (dup) parts.push(`**${dup}** repetido${dup === 1 ? '' : 's'}`);
        if (skipped) parts.push(`**${skipped}** ignorado${skipped === 1 ? '' : 's'}`);
        return parts.length === 1 ? `${parts[0]}.` : `${parts.slice(0, -1).join(', ')} e ${parts[parts.length - 1]}.`;
    },
    noConsult: 'Não consultei o Modrinth: numa conversa privada eu só consulto serviços externos quando o dono libera. Seguem links de busca prontos (não são downloads); abra pelo navegador.',
    disabled: 'A pesquisa na web está desativada neste servidor, então não consultei o Modrinth. Seguem links de busca prontos (não são downloads); abra pelo navegador.',
    outage: 'O Modrinth não respondeu agora (fora do ar ou limitando acessos), então não consegui conferir os mods nem a compatibilidade. Seguem links de busca (não são downloads). Tente de novo daqui a alguns minutos.',
    over: (limit, n) => `Você mandou mais nomes do que o limite (${limit}): procurei os ${limit} primeiros e deixei ${n} de fora. Mande o resto numa nova mensagem.`,
    deadline: (secs, idx) => `Passei do prazo de ${secs} s: do item ${idx} em diante saíram só os links de busca.`,
    stoppedOutage: (idx) => `O Modrinth parou de responder no item ${idx}: de lá em diante saíram só os links de busca.`,
    stoppedRate: (idx) => `O Modrinth pediu para eu esperar (limite de acessos) no item ${idx}: de lá em diante saíram só os links de busca.`,
    unverified: (n) => `Não deu tempo ou o Modrinth falhou ao conferir a versão de ${n} ${n === 1 ? 'mod' : 'mods'}: ${n === 1 ? 'ele está marcado' : 'eles estão marcados'} abaixo (só a página do mod).`,
    complementsPartial: 'Atenção: não consegui conferir todas as dependências obrigatórias (eram muitas ou o prazo acabou), então a lista de Important Complements pode estar incompleta. Confira as dependências na página de cada mod.',
    ask: 'Se for outra versão ou loader, me diga (ex.: Fabric 1.21) que eu monto de novo.',
    howTo: 'O link do nome abre a página do mod; "baixar" abre a versão certa para a combinação acima. Link de busca não é download, só abre a busca.',
    howToNoCombo: 'O link abre a página do mod no Modrinth. Link de busca não é download, só abre a busca.',
    noCombo: 'Compatibilidade: não achei uma versão em comum para os mods encontrados.',
    footer: '-# Fonte: Modrinth. Link de busca não é download. Confira o loader e a versão antes de baixar.',
    complements: 'Important Complements',
    complementsHeader: '**Important Complements** (obrigatórios que não estavam na sua lista):',
    conflictsHeader: '**Atenção, incompatibilidades declaradas pelos autores:**',
    userBusy: 'Ainda estou procurando os links da sua outra lista de mods. Espera ela terminar para mandar a próxima.',
    busy: 'Estou procurando duas listas de mods agora. Tenta de novo daqui a um minutinho.',
});

// ---------------------------------------------------------------------------------------------
// 3. Leitura da lista (parse) e detector de "pedido de lista de mods"
// ---------------------------------------------------------------------------------------------

export const PARSE_LIMITS = Object.freeze({
    maxText: 20_000,
    minItems: 5,
    itemMinChars: 2,
    itemMaxChars: 80,
    itemMaxWords: 10,
    itemRatio: 0.6, // fração mínima de linhas-item entre as linhas não vazias
});

const COMBINING = /[̀-ͯ]/g;
const INVISIBLE = /[​-‏‪-‮⁠-⁤﻿­]/g;
// eslint-disable-next-line no-control-regex
const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g;
const MENTION_TOKEN = /<(?:@[!&]?|#)\d{3,25}>/g;

/** minúsculo, sem acento, espaços repetidos colapsados (quebras de linha ficam). */
export function fold(text) {
    return String(text ?? '').normalize('NFD').replace(COMBINING, '').toLowerCase().replace(INVISIBLE, '').replace(/ {2,}/g, ' ');
}

const word = (alternatives) => new RegExp(`(?<![a-z0-9])(?:${alternatives})(?![a-z0-9])`);
const RE_MOD_PLURAL = word('mods|modpacks?|modrinth|curseforge|neoforge');
const RE_MOD_SINGULAR = word('mod');
const RE_MC_HINT = word('minecraft|forge|neoforge|fabric|quilt|curseforge|modrinth|modpacks?');
const RE_MOD_CUE = word('ban|banir|banido|banidos|kick|expulsar|mute|silenciar|moderador|moderadores|moderacao|staff|cargo|cargos');
const RE_OTHER_GAME = word('gta|gtav|gta5|fivem|skyrim|fallout|sims|stardew|cyberpunk|witcher|oblivion|starfield|rimworld|terraria|valheim|cities skylines|euro truck|baldur|bg3');
const RE_REQUEST = word('links?|downloads?|baixar|baixa|baixe|baixem|lista|listar|liste|urls?|sites?|pagina|paginas|onde acho|onde achar|onde encontrar|onde baixo|onde baixar|onde consigo');
const RE_PROSE_WORD = word('links?|downloads?|baixar|baixa|baixe|baixem|lista|listar|liste|urls?|mods|modpacks?|modrinth|curseforge');
const RE_LOADER = word('neoforge|forge|fabric|quilt');
const RE_VERSION = /(?<![0-9.])1[.][0-9]{1,2}(?:[.][0-9]{1,2})?(?![0-9]|[.][0-9])/g;
const RE_VERSION_WHOLE = /^1[.][0-9]{1,2}(?:[.][0-9]{1,2})?$/;
const HINT_FILLER = new Set(['minecraft', 'mc', 'versao', 'version', 'ver', 'loader', 'para', 'pra', 'na', 'no', 'de', 'do', 'da', 'em', 'e', 'com', 'o', 'a', 'java', 'edition', 'mod', 'mods']);
const LOADER_SET = new Set(['neoforge', 'forge', 'fabric', 'quilt']);

const hasLetter = (s) => {
    for (const ch of s) if (ch.toLowerCase() !== ch.toUpperCase()) return true;
    return false;
};

/** Linha que só informa versão e/ou loader ("Forge 1.20.1", "fabric", "versão 1.21"): vira dica, não item. */
export function isHintLine(line) {
    const tokens = fold(line).replace(/[,;:()]/g, ' ').split(' ').filter(Boolean);
    if (!tokens.length || tokens.length > 6) return false;
    let signal = false;
    for (const t of tokens) {
        if (LOADER_SET.has(t) || RE_VERSION_WHOLE.test(t)) { signal = true; continue; }
        if (!HINT_FILLER.has(t)) return false;
    }
    return signal;
}

const BULLET = /^(?:[-*+>•–—]+|[0-9]{1,3}[.):]|[0-9]{1,3} [-–—])[ ]+/;
const CHECKBOXES = ['[ ] ', '[x] ', '[X] ', '[] '];

/** Tira marcador de lista, enfeite de markdown nas pontas e pontuação final; colapsa espaços. '' se nada sobra. */
export function cleanItemText(raw) {
    // Linha enorme nunca é nome (itemMaxChars = 80): o corte evita custo quadrático nos regex de pontuação final.
    let s = String(raw ?? '').slice(0, 300).replace(INVISIBLE, '').replace(CONTROL, ' ').trim();
    for (let i = 0; i < 3; i++) {
        let t = s.replace(BULLET, '');
        for (const box of CHECKBOXES) if (t.startsWith(box)) t = t.slice(box.length);
        if (t === s) break;
        s = t.trim();
    }
    for (let i = 0; i < 2; i++) {
        s = s.replace(/[,;]+$/, '').trim();
        s = s.replace(/^[*_~`]+/, '').replace(/[*_~`]+$/, '').trim();
    }
    return s.replace(/[ ]+/g, ' ').trim();
}

// Palavras funcionais do português: duas ou mais numa linha de 4+ palavras é frase, não nome de mod.
const PT_STOP = new Set(['de', 'do', 'da', 'dos', 'das', 'que', 'se', 'para', 'pra', 'pro', 'com', 'nao', 'voce', 'vc', 'eu', 'meu', 'minha', 'meus', 'minhas',
    'pela', 'pelo', 'uma', 'uns', 'os', 'as', 'no', 'na', 'nos', 'nas', 'por', 'mas', 'ja', 'tambem', 'muito', 'ate', 'ao', 'aos', 'esse', 'essa', 'esses',
    'essas', 'isso', 'aqui', 'quero', 'queria', 'pode', 'tem', 'tenho', 'foi', 'sao', 'vou', 'vai', 'valeu', 'obrigado', 'obrigada', 'porque', 'quando', 'como']);
function looksLikePortugueseSentence(item) {
    const tokens = fold(item).split(' ').map((t) => t.replace(/[^a-z0-9]+/g, '')).filter(Boolean);
    if (tokens.length < 4) return false;
    let n = 0;
    for (const t of tokens) if (PT_STOP.has(t)) n++;
    return n >= 2;
}

// Linha de código colada sem cerca (chaves, seta, comparação, "//", chamada de função com ponto e vírgula): nome de mod não tem isto.
const CODE_LIKE = /[{}]|=>|===?|!==?|&&|\|\||\/\/|\w\([^)]*\)\s*[;{.]|\)\s*;|[<>]=|\$\{|^\s*[})\]]|^\s*[A-Z][A-Z0-9_]{3,}:\s|\w:\s*['"`]|\s=\s|^\s*(?:const|let|var|function|import|export|return|await|async)\s/;

function isItemShape(item) {
    if (item.length < PARSE_LIMITS.itemMinChars || item.length > PARSE_LIMITS.itemMaxChars) return false;
    if (CODE_LIKE.test(item)) return false;
    if (looksLikePortugueseSentence(item)) return false;
    if (!hasLetter(item)) return false;
    if (item.includes('://') || item.toLowerCase().includes('www.')) return false;
    if (item.startsWith('#')) return false;
    const last = item[item.length - 1];
    if (last === '?' || last === ':') return false;
    const words = item.split(' ').filter(Boolean);
    if (words.length > PARSE_LIMITS.itemMaxWords) return false;
    if (words.length >= 7 && (last === '.' || last === '!')) return false;
    if ((item.match(/,/g) || []).length >= 3) return false;
    return true;
}

const keyOf = (item) => fold(item).replace(/[^a-z0-9]+/g, '');

const GENERIC_PARTS = new Set(['addons', 'addon', 'add ons', 'add on', 'extras', 'extra', 'extensions', 'mods', 'mod', 'plus']);

/** "Industrial Craft + addons" -> { parts: ['Industrial Craft'], generic: ['addons'] }. Só divide com espaço em volta do "+" ("HUD+" fica inteiro). */
export function splitParts(label) {
    const raw = String(label ?? '').split(' + ').map((p) => p.trim()).filter(Boolean);
    if (raw.length <= 1) return { parts: [String(label ?? '').trim()], generic: [] };
    const parts = [];
    const generic = [];
    for (const p of raw) (GENERIC_PARTS.has(fold(p).replace(/[^a-z0-9 ]+/g, '').trim()) ? generic : parts).push(p);
    return { parts: parts.length ? parts : [raw[0]], generic: parts.length ? generic : raw.slice(1) };
}

/** Versão do Minecraft e loader citados na PROSA/dicas (nunca nos nomes). Ambíguo (dois loaders ou duas versões) = null. */
export function extractHints(textFolded) {
    const loaders = new Set();
    for (const m of textFolded.matchAll(new RegExp(RE_LOADER.source, 'g'))) loaders.add(m[0]);
    const versions = new Set();
    for (const m of textFolded.matchAll(RE_VERSION)) versions.add(m[0]);
    return {
        loader: loaders.size === 1 ? [...loaders][0] : null,
        mcVersion: versions.size === 1 ? [...versions][0] : null,
        ambiguous: loaders.size > 1 || versions.size > 1,
    };
}

/**
 * Lê o texto: separa linhas-ITEM (nomes), PROSA (introdução e observações) e DICAS (linhas "Forge 1.20.1"). Não decide se é um pedido
 * (isso é do detectModListRequest). Itens repetidos contam uma vez.
 * @returns {{items:{index:number,label:string,parts:string[],generic:string[]}[], duplicates:number, prose:string[], hintLines:string[],
 *            itemLines:number, lines:number}}
 */
export function parseModList(text) {
    const raw = String(text ?? '').replace(MENTION_TOKEN, ' ');
    const lines = raw.split(NL).map((l) => l.split(CR).join('')).map((l) => l.trim()).filter(Boolean);
    const out = { items: [], duplicates: 0, prose: [], hintLines: [], itemLines: 0, lines: lines.length };
    const seen = new Set();
    for (const line of lines) {
        if (line.length > 300) { out.prose.push(line.slice(0, 300)); continue; } // linha enorme nunca é nome de mod (limite de 80) e não deve custar tempo
        if (isHintLine(line)) { out.hintLines.push(line); continue; }
        const cleaned = cleanItemText(line);
        const proseLike = RE_PROSE_WORD.test(fold(cleaned)) || !isItemShape(cleaned) || CODE_LIKE.test(line); // a linha CRUA também: ";" e "," finais saem na limpeza
        if (proseLike) { out.prose.push(line); continue; }
        out.itemLines++;
        const key = keyOf(cleaned);
        if (!key) continue;
        if (seen.has(key)) { out.duplicates++; continue; }
        seen.add(key);
        const { parts, generic } = splitParts(cleaned);
        out.items.push({ index: out.items.length + 1, label: cleaned, parts, generic });
    }
    return out;
}

/**
 * Esta mensagem é um PEDIDO de lista de mods? Função pura (sem rede, relógio ou log). Todas precisam valer:
 *  1. texto de até 20000 caracteres e SEM bloco de código;
 *  2. 5 ou mais linhas-item únicas, que são 60% ou mais das linhas não vazias (o resto é prosa);
 *  3. a PROSA diz "mods"/"modpack"/"modrinth"/"curseforge" (ou "mod" junto de uma dica de Minecraft), sem cargo de moderação nem outro jogo;
 *  4. a PROSA pede link/download/baixar/lista/url/site/página (ou "onde achar").
 * Conversa normal, listas de compras, de músicas ou de jogos e "mods" de moderação ficam de fora.
 */
export function detectModListRequest(text) {
    const out = { isRequest: false, reason: '', items: [], duplicates: 0, hints: { loader: null, mcVersion: null, ambiguous: false }, stats: { lines: 0, itemLines: 0, proseLines: 0 } };
    const raw = String(text ?? '');
    if (!raw.trim()) { out.reason = 'vazio'; return out; }
    if (raw.length > PARSE_LIMITS.maxText) { out.reason = 'texto-grande'; return out; }
    if (raw.includes('```')) { out.reason = 'bloco-de-codigo'; return out; }
    if (raw.split(NL).length < PARSE_LIMITS.minItems) { out.reason = 'poucas-linhas'; return out; }
    const parsed = parseModList(raw);
    out.stats = { lines: parsed.lines, itemLines: parsed.itemLines, proseLines: parsed.prose.length };
    if (parsed.lines < PARSE_LIMITS.minItems) { out.reason = 'poucas-linhas'; return out; }
    out.items = parsed.items;
    out.duplicates = parsed.duplicates;
    if (parsed.items.length < PARSE_LIMITS.minItems) { out.reason = 'poucos-itens'; return out; }
    const nonEmpty = parsed.itemLines + parsed.prose.length;
    if (parsed.itemLines / nonEmpty < PARSE_LIMITS.itemRatio) { out.reason = 'muita-prosa'; return out; }

    const proseText = fold(parsed.prose.join(NL) + NL + parsed.hintLines.join(NL));
    const mcHint = RE_MC_HINT.test(proseText);
    const modWord = RE_MOD_PLURAL.test(proseText) || (RE_MOD_SINGULAR.test(proseText) && mcHint);
    if (!modWord) { out.reason = 'sem-palavra-mod'; return out; }
    if (RE_MOD_CUE.test(proseText) && !mcHint) { out.reason = 'moderacao'; return out; }
    if (RE_OTHER_GAME.test(proseText) && !mcHint) { out.reason = 'outro-jogo'; return out; }
    if (!RE_REQUEST.test(proseText)) { out.reason = 'sem-pedido'; return out; }
    out.hints = extractHints(proseText);
    out.isRequest = true;
    out.reason = 'ok';
    return out;
}

// ---------------------------------------------------------------------------------------------
// 4. Correspondência de nomes (pura)
// ---------------------------------------------------------------------------------------------

const STOP = new Set(['the', 'a', 'an', 'of', 'and', 'mod', 'mods', 'for', 'in', 'on', 'to', 'x', 'by']);
const MODIFIERS = new Set(['compat', 'compatibility', 'addon', 'addons', 'integration', 'patch', 'port', 'backport', 'fork', 'unofficial', 'bridge', 'fix']);

/** minúsculas, sem acento nem apóstrofo; "&" vira and, "+" vira plus; pontuação vira espaço; "'II" (i maiúsculo) vira "'ll". */
export function normalizeName(s) {
    return String(s || '')
        .normalize('NFKD')
        .replace(COMBINING, '')
        .toLowerCase()
        .replace(/[‘’´`]/g, "'")
        .replace(/'ii\b/g, "'ll")
        .replace(/'/g, '')
        .replace(/&/g, ' and ')
        .replace(/\+/g, ' plus ')
        .replace(/[^a-z0-9]+/g, ' ')
        .trim();
}

/** Palavras significativas: sem stopwords, e um "2"/"4" no MEIO do nome conta como "to"/"for" (Waystones 2 Waypoints). */
export function nameTokens(s) {
    const all = normalizeName(s).split(' ').filter(Boolean);
    const mid = all.filter((t, i) => !((t === '2' || t === '4') && i > 0 && i < all.length - 1));
    const kept = mid.filter((t) => !STOP.has(t));
    return kept.length ? kept : mid.length ? mid : all;
}

/** Distância de Damerau-Levenshtein (OSA). */
export function editDistance(a, b) {
    const al = a.length;
    const bl = b.length;
    if (!al) return bl;
    if (!bl) return al;
    const d = Array.from({ length: al + 1 }, () => new Array(bl + 1).fill(0));
    for (let i = 0; i <= al; i++) d[i][0] = i;
    for (let j = 0; j <= bl; j++) d[0][j] = j;
    for (let i = 1; i <= al; i++) {
        for (let j = 1; j <= bl; j++) {
            const c = a[i - 1] === b[j - 1] ? 0 : 1;
            d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + c);
            if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) d[i][j] = Math.min(d[i][j], d[i - 2][j - 2] + 1);
        }
    }
    return d[al][bl];
}

function wordSim(a, b) {
    if (a === b) return 1;
    const m = Math.min(a.length, b.length);
    const L = Math.max(a.length, b.length);
    const d = editDistance(a, b);
    if (m >= 4 && d <= 1) return 0.92;
    if (L >= 8 && d <= 2) return 0.85;
    if (m >= 3 && (a.startsWith(b) || b.startsWith(a))) return 0.5;
    return 0;
}

// Dice "mole": casa palavras de A e B (guloso pelo maior wordSim) e penaliza as casadas fora de ordem ("Eye of Dragons" x "Dragon Eye").
function softDice(A, B) {
    if (!A.length || !B.length) return 0;
    const pairs = [];
    A.forEach((a, i) => B.forEach((b, j) => { const w = wordSim(a, b); if (w > 0) pairs.push([w, i, j]); }));
    pairs.sort((x, y) => y[0] - x[0]);
    const ua = new Set();
    const ub = new Set();
    const matched = [];
    let sum = 0;
    for (const [w, i, j] of pairs) {
        if (ua.has(i) || ub.has(j)) continue;
        ua.add(i); ub.add(j); sum += w; matched.push([i, j]);
    }
    matched.sort((x, y) => x[0] - y[0]);
    let inv = 0;
    for (let x = 0; x < matched.length; x++) for (let y = x + 1; y < matched.length; y++) if (matched[x][1] > matched[y][1]) inv++;
    return Math.max(0, (2 * sum) / (A.length + B.length) - Math.min(0.24, 0.12 * inv));
}

function compactSim(a, b) {
    const x = a.join('');
    const y = b.join('');
    if (!x || !y) return 0;
    return 1 - editDistance(x, y) / Math.max(x.length, y.length);
}

/** Tira "(JEI)", "[FABRIC]" do título (siglas e rótulos de loader não fazem parte do nome). */
export function cleanTitle(t) {
    const s = String(t || '').replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
    return s || String(t || '');
}

function leadExtras(A, B) {
    for (let j = 0; j < B.length; j++) if (A.some((a) => wordSim(a, B[j]) >= 0.85)) return j;
    return B.length;
}

/** Pontuação 0..1 de um hit (título e slug) contra o nome pedido. */
export function scoreName(query, title, slug) {
    const A = nameTokens(query);
    let best = 0;
    const cands = [nameTokens(cleanTitle(title))];
    if (slug) cands.push(nameTokens(String(slug).replace(/-/g, ' ')));
    for (const B of cands) {
        const sd = softDice(A, B);
        const cs = compactSim(A, B);
        let s = Math.max(sd, cs);
        // prefixo: todas as palavras do pedido abrem o título ("Chisel" -> "Chisel Reborn")
        if (A.length && B.length > A.length && A.every((t, i) => wordSim(t, B[i]) >= 0.85)) s = Math.max(s, 0.7 + 0.2 * (A.length / B.length));
        // palavras a mais ANTES do trecho que casa ("No More Portals" para "More Portals")
        const lead = leadExtras(A, B);
        if (lead && cs < 0.9) s -= Math.min(0.3, 0.12 * lead);
        // compat, addon, patch, fork... no título e não no pedido
        if (B.filter((t) => MODIFIERS.has(t) && !A.includes(t)).length) s -= 0.25;
        // palavra distintiva do pedido sem par nenhum no título ("Mobs" em "Dungeons Plus"): é outro mod, nunca passa do limiar de aviso
        if (cs < 0.9 && A.some((a) => !/^[0-9]+$/.test(a) && !MODIFIERS.has(a) && !B.some((b) => wordSim(a, b) >= 0.5))) s = Math.min(s, THRESHOLDS.warn - 0.01);
        if (s > best) best = s;
    }
    return Math.max(0, Math.min(1, best));
}

export const THRESHOLDS = Object.freeze({ found: 0.88, warn: 0.75 });
const DOUBTFUL_BELOW = 0.85; // aviso abaixo disto (e que não é extensão por prefixo) sai sem "baixar" e sem complementos

/** 'achado' (>= 0,88) | 'aviso' (0,75 a 0,88: achei como X, confira) | 'nao'. */
export function bandOf(score) {
    return score >= THRESHOLDS.found ? 'achado' : score >= THRESHOLDS.warn ? 'aviso' : 'nao';
}

/** Melhor hit: maior pontuação; empate (até 0,05) decidido por downloads. */
export function pickBest(query, hits) {
    const scored = (Array.isArray(hits) ? hits : []).map((h, idx) => ({ h, idx, score: scoreName(query, h.title, h.slug) }));
    scored.sort((a, b) => b.score - a.score);
    if (!scored.length) return { best: null, scored };
    const top = scored[0].score;
    const near = scored.filter((s) => top - s.score <= 0.05);
    near.sort((a, b) => (b.h.downloads || 0) - (a.h.downloads || 0));
    return { best: near[0], scored };
}

// "Chisel" -> "Chisel Reborn": extensão por prefixo (sem ":" ou "|" no título que o pedido não tem)
function prefixExtension(query, title) {
    const shown = cleanTitle(title); // "(JEI)" e "[Forge]" não contam
    if (/[:|]/.test(shown) && !/[:|]/.test(query)) return false;
    const A = nameTokens(query);
    const B = nameTokens(shown);
    return B.length > A.length && A.every((a, i) => wordSim(a, B[i]) >= 0.85);
}

/** Candidatos aceitáveis para o nome: acima do limiar de aviso e (a até 0,05 do melhor ou extensão por prefixo). Melhor primeiro. */
export function acceptableCandidates(query, pool, max = 5) {
    const scored = (Array.isArray(pool) ? pool : [])
        .map((h) => ({ h, score: scoreName(query, h.title, h.slug) }))
        .filter((c) => c.score >= THRESHOLDS.warn)
        .sort((a, b) => b.score - a.score || (b.h.downloads || 0) - (a.h.downloads || 0));
    if (!scored.length) return [];
    return scored.filter((c) => scored[0].score - c.score <= 0.05 || prefixExtension(query, c.h.title)).slice(0, max);
}

// ---------------------------------------------------------------------------------------------
// 5. Compatibilidade: par (loader, versão do Minecraft)
// ---------------------------------------------------------------------------------------------

export const LOADERS = Object.freeze(['forge', 'neoforge', 'fabric', 'quilt']);
const LOADER_NAMES = Object.freeze({ forge: 'Forge', neoforge: 'NeoForge', fabric: 'Fabric', quilt: 'Quilt' });
export const loaderName = (l) => LOADER_NAMES[String(l || '').toLowerCase()] || plainText(String(l || ''), 20, { domains: false }) || 'loader';
const isReleaseVersion = (v) => /^\d{1,2}\.\d{1,2}(\.\d{1,2})?$/.test(String(v));
/** Compara versões do Minecraft por NÚMEROS (a numeração nova 26.1 convive com 1.21.11): positivo se a > b. */
export function compareMcVersion(a, b) {
    const x = String(a).split('.').map(Number);
    const y = String(b).split('.').map(Number);
    for (let i = 0; i < Math.max(x.length, y.length); i++) {
        const d = (x[i] || 0) - (y[i] || 0);
        if (d) return d;
    }
    return 0;
}
const supports = (hit, loader, version) => Array.isArray(hit?.categories) && hit.categories.includes(loader) && Array.isArray(hit?.versions) && hit.versions.includes(version);

/**
 * Escolhe o par (loader, versão) que reúne mais mods. `entries`: { cands:[{h}] } (um mod conta se ALGUM candidato aceitável suporta o par,
 * segundo a união de loaders/versões que o hit traz; a conferência real vem depois). `hints`: { loader, mcVersion } do texto (fixam o par).
 * Desempate: soma de log10(downloads) do melhor candidato de cada mod coberto (só se a diferença for de 3 ou mais), depois a versão mais nova, depois a ordem forge, neoforge, fabric, quilt.
 */
export function choosePair(entries, hints = {}) {
    const list = (Array.isArray(entries) ? entries : []).filter((e) => Array.isArray(e.cands) && e.cands.length);
    const loaders = hints.loader && LOADERS.includes(hints.loader) ? [hints.loader] : LOADERS;
    const versions = new Set();
    if (hints.mcVersion && isReleaseVersion(hints.mcVersion)) versions.add(hints.mcVersion);
    else for (const e of list) for (const c of e.cands) for (const v of c.h.versions || []) if (isReleaseVersion(v)) versions.add(v);
    const rows = [];
    for (const loader of loaders) {
        for (const version of versions) {
            let covered = 0;
            let weight = 0;
            for (const e of list) {
                const sup = e.cands.filter((c) => supports(c.h, loader, version));
                if (!sup.length) continue;
                covered++;
                weight += Math.log10((sup[0].h.downloads || 0) + 1);
            }
            rows.push({ loader, version, covered, weight });
        }
    }
    // Empate de cobertura: a popularidade dos mods cobertos só decide se a diferença é enorme (3 ordens de grandeza somadas); senão vale a versão mais nova e, por fim, a ordem
    // forge, neoforge, fabric, quilt (a mesma união de loaders/versões costuma empatar forge e neoforge, e o forge é o que mais mods tem).
    rows.sort((a, b) => b.covered - a.covered
        || (Math.abs(b.weight - a.weight) >= 3 ? b.weight - a.weight : 0)
        || compareMcVersion(b.version, a.version)
        || LOADERS.indexOf(a.loader) - LOADERS.indexOf(b.loader));
    return { best: rows[0] ?? null, found: list.length, rows };
}

// ---------------------------------------------------------------------------------------------
// 6. Links: host fixo, tudo validado
// ---------------------------------------------------------------------------------------------

const SLUG_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const ID_RE = /^[A-Za-z0-9]{4,16}$/;

export const modPageUrl = (slug) => (SLUG_RE.test(String(slug ?? '')) ? `https://modrinth.com/mod/${slug}` : '');
export const projectPageUrl = (slug) => (SLUG_RE.test(String(slug ?? '')) ? `https://modrinth.com/project/${slug}` : '');
export const versionPageUrl = (slug, versionId) => (SLUG_RE.test(String(slug ?? '')) && ID_RE.test(String(versionId ?? '')) ? `https://modrinth.com/mod/${slug}/version/${versionId}` : '');

const encodeStrict = (s) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);

/** Texto que pode ir num link de busca: sem menção, sem link ou domínio escrito pela pessoa, sem marcação. */
function cleanSearchText(raw) {
    return String(raw ?? '')
        .replace(INVISIBLE, '').replace(CONTROL, ' ')
        .replace(MENTION_TOKEN, ' ')
        .replace(/<?\b[a-z][a-z0-9+.-]{1,15}:\/\/\S*/gi, ' ') // esquema://...
        .replace(/\bwww\.\S*/gi, ' ')
        .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.[a-z]{2,24}\/\S*/gi, ' ') // dominio.tld/caminho
        .replace(/[@`<>[\]|]/g, ' ')
        .replace(/\s+/g, ' ').trim().slice(0, 80);
}

/** Links de BUSCA fixos (não são downloads). O nome entra codificado e limpo (nada de link ou menção da pessoa). */
export function searchLinks(label) {
    const q = encodeStrict(cleanSearchText(label));
    return {
        modrinth: `https://modrinth.com/mods?q=${q}`,
        curseforge: `https://www.curseforge.com/minecraft/search?search=${q}&class=mc-mods`,
    };
}

// ---------------------------------------------------------------------------------------------
// 7. Contexto compartilhado do processo (semáforo, ritmo, 429, cache) e cliente do Modrinth
// ---------------------------------------------------------------------------------------------

export function createLimiter(max = 3) {
    let limit = Math.max(1, max);
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < limit && queue.length) {
            const next = queue.shift();
            active++;
            Promise.resolve().then(next.fn).then(next.resolve, next.reject).finally(() => { active--; pump(); });
        }
    };
    return {
        run(fn) { return new Promise((resolve, reject) => { queue.push({ fn, resolve, reject }); pump(); }); },
        setMax(n) { limit = Math.max(1, Math.floor(n) || 1); pump(); },
        get active() { return active; },
        get waiting() { return queue.length; },
    };
}

/** Estado que vale para o PROCESSO inteiro (os trabalhos de pessoas diferentes dividem o IP do bot): um semáforo, o ritmo, a pausa do 429 e o cache. */
export function createModlistContext({ concurrency = MODLIST_DEFAULTS.concurrency, maxPerMinute = LIMITS.maxPerMinute, cacheMax = LIMITS.cacheMax } = {}) {
    return { limiter: createLimiter(concurrency), window: [], maxPerMinute, cache: new Map(), cacheMax, pauseUntil: 0 };
}
export const sharedModlistContext = createModlistContext();

let defaultFetchForTest = null;
/** SÓ PARA TESTES: troca o fetch padrão (safeFetchText). As portas reais (/yui, menção) não recebem fetch por injeção. Sem argumento, volta ao padrão. */
export function _setDefaultFetchForTest(fn) {
    defaultFetchForTest = typeof fn === 'function' ? fn : null;
}

const defaultSleep = (ms) => new Promise((resolve) => { setTimeout(resolve, Math.max(0, ms)); }); // limitado pelo prazo do trabalho

function newJobState() {
    return {
        requests: 0, okCount: 0, failCount: 0, consecFail: 0, count429: 0, cacheHits: 0,
        stopped: false, stopReason: '', rateLimited: false, deadlineHit: false,
    };
}

function createClient({ ctx, fetch, now, sleep, random, signal, state, userAgent = MODRINTH_USER_AGENT, maxBytes = LIMITS.maxResponseBytes }) {
    const pace = async (until) => {
        for (;;) {
            const t = now();
            while (ctx.window.length && t - ctx.window[0] >= 60_000) ctx.window.shift();
            if (ctx.window.length < ctx.maxPerMinute) { ctx.window.push(t); return true; }
            const wait = ctx.window[0] + 60_000 - t + 50;
            if (t + wait >= until) return false;
            await sleep(wait);
        }
    };

    const fail = (kind, status = 0) => ({ kind, status });

    /** GET na API. kind: ok | notfound | error | deadline | stopped | ratelimited. Nunca lança. */
    async function get(pathAndQuery, { until, ttlMs = 0 } = {}) {
        const url = `${API_BASE}${pathAndQuery}`;
        if (ttlMs > 0) {
            const hit = ctx.cache.get(url);
            if (hit && now() - hit.at < hit.ttl) { state.cacheHits++; return hit.value; }
        }
        let tries = 0;
        let tries429 = 0;
        for (;;) {
            if (state.stopped) return fail('stopped');
            if (signal?.aborted) { state.stopped = true; state.stopReason ||= 'abort'; return fail('stopped'); }
            const t = now();
            if (t >= until - LIMITS.minRequestMs) { state.deadlineHit = true; return fail('deadline'); }
            if (ctx.pauseUntil > t) {
                const wait = ctx.pauseUntil - t;
                if (t + wait >= until) { state.deadlineHit = true; return fail('deadline'); }
                await sleep(wait);
                continue;
            }
            if (!(await pace(until))) { state.deadlineHit = true; return fail('deadline'); }
            let res;
            try {
                res = await ctx.limiter.run(() => {
                    state.requests++;
                    return fetch(url, {
                        userAgent,
                        headers: { Accept: 'application/json' },
                        allowedContentTypes: ['application/json'],
                        maxBytes,
                        timeoutMs: 8000,
                        maxRedirects: 0, // a API do Modrinth não redireciona: qualquer 3xx (para outro host, por exemplo) é falha, nunca seguido
                        totalDeadlineMs: Math.max(1000, Math.min(LIMITS.requestDeadlineMs, until - now())),
                        signal,
                    });
                });
            } catch (_) {
                res = { ok: false, status: 0, code: 'NETWORK' };
            }
            const rate = res?.rate;
            if (rate) {
                const remaining = Number(rate.remaining);
                const reset = Number(rate.reset);
                if (Number.isFinite(remaining) && remaining <= 10 && Number.isFinite(reset) && reset > 0) ctx.pauseUntil = Math.max(ctx.pauseUntil, now() + Math.min(60, reset) * 1000);
            }
            const status = Number(res?.status) || 0;
            let foreignHost = false;
            if (res?.url) { try { foreignHost = new URL(String(res.url)).host !== 'api.modrinth.com'; } catch (_) { foreignHost = true; } }
            if (res?.code === 'REDIRECTS' || (res?.ok && foreignHost)) { // resposta de outro host: não confia, não repete
                state.failCount++; state.consecFail++;
                if (state.consecFail >= 6) { state.stopped = true; state.stopReason ||= 'outage'; }
                return fail('error', status);
            }
            if (res?.ok) {
                let json = null;
                try { json = res.truncated ? null : JSON.parse(String(res.text ?? '')); } catch (_) { json = null; }
                if (json === null) { state.failCount++; return fail('error', status); }
                state.okCount++;
                state.consecFail = 0;
                const value = { kind: 'ok', status, json };
                if (ttlMs > 0) {
                    ctx.cache.set(url, { at: now(), ttl: ttlMs, value });
                    while (ctx.cache.size > ctx.cacheMax) ctx.cache.delete(ctx.cache.keys().next().value);
                }
                return value;
            }
            if (status === 404) { state.okCount++; state.consecFail = 0; return fail('notfound', 404); }
            if (status === 429) {
                state.count429++;
                tries429++;
                const retry = Number(rate?.retryAfter);
                const waitMs = Math.min(30_000, Math.max(1000, Number.isFinite(retry) && retry > 0 ? retry * 1000 : 5000)) + 500;
                if (tries429 > 2 || state.count429 > 6 || now() + waitMs >= until) {
                    state.rateLimited = true; state.stopped = true; state.stopReason ||= 'ratelimit';
                    return fail('ratelimited', 429);
                }
                ctx.pauseUntil = Math.max(ctx.pauseUntil, now() + waitMs);
                continue;
            }
            if (status >= 400 && status < 500) { state.okCount++; state.consecFail = 0; return fail('error', status); } // o servidor respondeu: pedido inválido, sem nova tentativa
            // rede, prazo, 5xx
            tries++;
            if (tries <= 2) {
                await sleep((tries === 1 ? 500 : 1500) + Math.floor(random() * 200));
                continue;
            }
            state.failCount++;
            state.consecFail++;
            if (state.consecFail >= 6) { state.stopped = true; state.stopReason ||= 'outage'; }
            return fail('error', status);
        }
    }

    const cleanHit = (h) => {
        if (!h || typeof h !== 'object' || !ID_RE.test(String(h.project_id ?? '')) || typeof h.title !== 'string' || !h.title) return null;
        return {
            project_id: h.project_id,
            slug: SLUG_RE.test(String(h.slug ?? '')) ? h.slug : '',
            title: h.title.slice(0, 120),
            categories: Array.isArray(h.categories) ? h.categories.filter((c) => typeof c === 'string').slice(0, 40) : [],
            versions: Array.isArray(h.versions) ? h.versions.filter((v) => typeof v === 'string').slice(0, 400) : [],
            downloads: Number(h.downloads) || 0,
        };
    };

    return {
        get,
        /** { kind, hits }: hits já limpos (id e título válidos). */
        async search(query, { limit = 10, until }) {
            const qs = `?query=${encodeStrict(query)}&facets=${encodeStrict(JSON.stringify([['project_type:mod']]))}&limit=${limit}&index=relevance`;
            const r = await get(`/search${qs}`, { until, ttlMs: LIMITS.searchTtlMs });
            if (r.kind !== 'ok') return { kind: r.kind === 'notfound' ? 'error' : r.kind, hits: [] }; // busca nunca deveria dar 404: é falha
            const hits = Array.isArray(r.json?.hits) ? r.json.hits.map(cleanHit).filter(Boolean) : [];
            return { kind: 'ok', hits };
        },
        /** Versões de um projeto para UM par: { kind:'ok'|'empty'|'fail'|..., best } (release antes de beta e alpha, depois a mais recente). */
        async versionFor(projectId, loader, mcVersion, { until }) {
            if (!ID_RE.test(String(projectId ?? ''))) return { kind: 'fail', best: null };
            const qs = `?loaders=${encodeStrict(JSON.stringify([loader]))}&game_versions=${encodeStrict(JSON.stringify([mcVersion]))}&include_changelog=false`;
            const r = await get(`/project/${projectId}/version${qs}`, { until, ttlMs: LIMITS.versionsTtlMs });
            if (r.kind === 'notfound') return { kind: 'empty', best: null };
            if (r.kind !== 'ok') return { kind: r.kind === 'error' ? 'fail' : r.kind, best: null };
            const list = Array.isArray(r.json) ? r.json.filter((v) => v && ID_RE.test(String(v.id ?? ''))) : [];
            if (!list.length) return { kind: 'empty', best: null };
            const rank = { release: 0, beta: 1, alpha: 2 };
            list.sort((a, b) => (rank[a.version_type] ?? 3) - (rank[b.version_type] ?? 3) || (String(b.date_published) > String(a.date_published) ? 1 : -1));
            const v = list[0];
            const deps = Array.isArray(v.dependencies) ? v.dependencies : [];
            return {
                kind: 'ok',
                best: {
                    id: v.id,
                    number: String(v.version_number ?? '').slice(0, 40),
                    type: ['release', 'beta', 'alpha'].includes(v.version_type) ? v.version_type : 'release',
                    required: deps.filter((d) => d?.dependency_type === 'required' && ID_RE.test(String(d.project_id ?? ''))).map((d) => d.project_id),
                    incompatible: deps.filter((d) => d?.dependency_type === 'incompatible' && ID_RE.test(String(d.project_id ?? ''))).map((d) => d.project_id),
                },
            };
        },
        /** Título e slug de vários projetos (1 requisição por bloco). Map id -> { title, slug }. */
        async projectInfo(ids, { until }) {
            const out = new Map();
            const valid = [...new Set(ids)].filter((id) => ID_RE.test(String(id)));
            for (let i = 0; i < valid.length; i += 20) {
                const block = valid.slice(i, i + 20);
                const r = await get(`/projects?ids=${encodeStrict(JSON.stringify(block))}`, { until, ttlMs: LIMITS.projectsTtlMs });
                if (r.kind !== 'ok' || !Array.isArray(r.json)) continue;
                for (const p of r.json) {
                    if (p && ID_RE.test(String(p.id ?? '')) && typeof p.title === 'string' && SLUG_RE.test(String(p.slug ?? ''))) out.set(p.id, { title: p.title.slice(0, 120), slug: p.slug });
                }
            }
            return out;
        },
    };
}

// ---------------------------------------------------------------------------------------------
// 8. Resolução
// ---------------------------------------------------------------------------------------------

// Forma de consulta da escada: igual ao normalize, mas o apóstrofo vira espaço (o índice separa "majrusz's" em "majrusz" + "s").
function queryForm(s) {
    return String(s).normalize('NFKD').replace(COMBINING, '').toLowerCase()
        .replace(/'ii\b/g, "'ll").replace(/[‘’']/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Pool de trabalhadores em ORDEM: cada um pega o próximo da fila. */
async function runPool(list, concurrency, worker) {
    let next = 0;
    const lanes = Array.from({ length: Math.max(1, Math.min(concurrency, list.length)) }, async () => {
        for (;;) {
            const i = next++;
            if (i >= list.length) return;
            await worker(list[i], i);
        }
    });
    await Promise.all(lanes);
}

const emptyEntry = (label, band, extra = {}) => ({ label, band, ...extra });

/** Resolve UMA parte (um nome): primeira busca, escada de recuperação e, por último, a divisão "A x B". Só a rede: nenhum efeito fora. */
async function resolvePart(part, { client, until }) {
    const label = part.label;
    const query = part.query;
    let pool = [];
    let steps = 0;
    let failed = false;
    const first = await client.search(query, { limit: 10, until });
    if (first.kind === 'error') return { entries: [emptyEntry(label, 'nao', { searchFailed: true })], failed: true };
    if (first.kind !== 'ok') return { entries: [], cutoff: true }; // prazo, 429 ou queda: este nome nem foi consultado
    pool = [...first.hits];
    let { best } = pickBest(query, pool);
    let band = best ? bandOf(best.score) : 'nao';
    if (band === 'nao') {
        // ESCADA: a busca do Modrinth não tolera erro de digitação (palavras unidas por E, só a última aceita prefixo). Até 3 degraus.
        const sent = new Set([queryForm(query)]);
        const STOPQ = new Set(['the', 'a', 'an', 'of', 'and', 'mod', 'mods', 'for', 'in', 'on', 'to', 'x', 'by']);
        const qt = queryForm(query).split(' ').filter((t, i, arr) => !STOPQ.has(t) && !((t === '2' || t === '4') && i > 0 && i < arr.length - 1));
        const tryQ = async (text, limit) => {
            const qf = queryForm(text);
            if (!qf || sent.has(qf) || steps >= 3) return false;
            sent.add(qf);
            steps++;
            const r = await client.search(qf, { limit, until });
            if (r.kind !== 'ok') { failed = r.kind !== 'notfound'; return false; }
            for (const h of r.hits) if (!pool.some((p) => p.project_id === h.project_id)) pool.push(h);
            best = pickBest(query, pool).best;
            return best && bandOf(best.score) !== 'nao';
        };
        let ok = false;
        if (qt.join(' ') !== queryForm(query)) ok = await tryQ(qt.join(' '), 10);
        if (!ok && !failed) {
            const order = qt.filter((t) => t.length >= 3).sort((a, b) => b.length - a.length);
            if (order.length >= 2) {
                for (const t of order.slice(0, 3)) {
                    if (ok || failed || steps >= 3) break;
                    ok = await tryQ(t, 25);
                }
                if (!ok && !failed && steps < 3 && order[0].length >= 6) ok = await tryQ(order[0].slice(0, 4), 25);
            } else if (order.length === 1 && order[0].length >= 5) {
                ok = await tryQ(order[0].slice(0, 4), 25);
                if (!ok && !failed) ok = await tryQ(order[0].slice(0, 3), 25);
            }
        }
        best = pickBest(query, pool).best;
        band = best ? bandOf(best.score) : 'nao';
        // achado só pela escada nunca é "achado" cheio (a não ser pontuação >= 0,99)
        if (steps > 0 && band === 'achado' && best.score < 0.99) band = 'aviso';
    }

    const makeEntry = (lbl, q, b, bestHit, viaSplit = false) => {
        const cands = acceptableCandidates(q, pool);
        const ordered = bestHit ? [{ h: bestHit.h, score: bestHit.score }, ...cands.filter((c) => c.h.project_id !== bestHit.h.project_id)] : [];
        // "duvidoso": aviso de pontuação baixa e que não é extensão do nome pedido ("Eye of Dragons" -> "Dragon Eye"): só a página, sem "baixar" nem complementos
        const doubtful = b === 'aviso' && !viaSplit && Boolean(bestHit) && bestHit.score < DOUBTFUL_BELOW && !prefixExtension(q, bestHit.h.title);
        return emptyEntry(lbl, b, { title: bestHit?.h.title ?? '', slug: bestHit?.h.slug ?? '', projectId: bestHit?.h.project_id ?? '', score: bestHit?.score ?? 0, cands: ordered, ladderSteps: steps, split: viaSplit, doubtful });
    };

    if (band !== 'nao' && best) return { entries: [makeEntry(label, query, band, best)], failed: false };

    // último recurso: "Starlight x Create" -> duas metades, resolvidas no conjunto já obtido (nenhuma requisição nova)
    if (/\sx\s/i.test(label)) {
        const halves = label.split(/\s+x\s+/i).map((p) => p.trim()).filter(Boolean).slice(0, 3);
        if (halves.length >= 2) {
            const entries = [];
            for (const h of halves) {
                const hb = pickBest(h, pool).best;
                const b = hb ? bandOf(hb.score) : 'nao';
                if (hb && b !== 'nao') entries.push(makeEntry(h, h, 'aviso', hb, true)); // dividido: a pessoa confere
                else entries.push(emptyEntry(h, 'nao'));
            }
            if (entries.some((e) => e.band !== 'nao')) return { entries, failed: false };
        }
    }
    return { entries: [emptyEntry(label, 'nao', failed ? { searchFailed: true } : {})], failed };
}

const PROBE = Object.freeze({ maxRows: 12, sample: 3 });

/**
 * Entre os pares EMPATADOS na cobertura da união (loaders/versões do hit de busca), confere de verdade com 3 mods populares (1 requisição cada,
 * a mesma que a fase de verificação repete e aproveita do cache). O primeiro par em que todos da amostra existem ganha; senão o de mais acertos.
 * Devolve a linha escolhida, ou null (sem empate, falha ou prazo: vale a escolha original).
 */
async function probePairs(rows, live, { client, until }) {
    const list = Array.isArray(rows) ? rows : [];
    const top = list[0];
    if (!top || top.covered <= 0) return null;
    const group = list.filter((r) => r.covered === top.covered).slice(0, PROBE.maxRows);
    if (group.length < 2) return null;
    let bestRow = null;
    let bestRatio = -1;
    for (const row of group) {
        const sample = live
            .map((e) => ({ e, c: e.cands.find((x) => supports(x.h, row.loader, row.version)) }))
            .filter((x) => x.c)
            .sort((a, b) => (b.c.h.downloads || 0) - (a.c.h.downloads || 0))
            .slice(0, PROBE.sample);
        if (!sample.length) continue;
        let hits = 0;
        for (const { c } of sample) {
            const r = await client.versionFor(c.h.project_id, row.loader, row.version, { until });
            if (r.kind === 'ok') hits++;
            else if (r.kind !== 'empty') return null; // prazo, 429 ou falha: não decide nada
        }
        const ratio = hits / sample.length;
        if (ratio === 1) return row;
        if (ratio > bestRatio) { bestRatio = ratio; bestRow = row; }
    }
    return bestRatio > 0 ? bestRow : null;
}

/**
 * Resolve a lista inteira.
 *
 * @param {string} text  a fala da pessoa (a lista, com a introdução)
 * @param {object} [opts]
 * @param {Function} [opts.fetch]       no formato do safeFetchText: (url, opts) => { ok, status, text, truncated, rate? }. Padrão: safeFetchText.
 * @param {Function} [opts.now] [opts.sleep] [opts.random]  relógio, sono e sorteio injetáveis
 * @param {object} [opts.ctx]           createModlistContext() (semáforo/ritmo/cache). Padrão: o do processo.
 * @param {object} [opts.config]        readModlistConfig(); padrão: lido do ambiente
 * @param {object} [opts.researchConfig]  readResearchConfig() (YUI_PRIVATE_SEARCH)
 * @param {boolean} [opts.sensitive]    conversa PRIVADA (DM, canal privado)
 * @param {boolean} [opts.isOwner]
 * @param {boolean} [opts.searchDisabled]  a ferramenta search_web está desligada neste servidor
 * @param {string[]} [opts.forbiddenKeywords]  moderação por item (dado pessoal e palavra proibida viram "ignorado", sem eco)
 * @param {{loader?:string,mcVersion?:string}} [opts.hints]  par pedido (senão vem do texto)
 * @param {AbortSignal} [opts.signal]
 * @param {Function} [opts.onProgress]  ({ stage:'search'|'verify'|'complements'|'format', done, total })
 * @param {Function} [opts.log]         (level, mensagem): só metadados
 * @param {string} [opts.userId]        quem pediu: com `userId` (ou `gate`) vale a trava de UMA lista por pessoa e no máximo duas no total
 *                                      (recusa devolve { ok:false, mode:'ocupado', busy:'user'|'busy', text })
 * @param {object} [opts.gate]          createModlistGate(); padrão: o do processo
 * @returns {Promise<{ok:boolean, mode:string, items:object[], compat:object|null, complements:object[], text:string, stats:object}>}
 */
export async function resolveModList(text, opts = {}) {
    if (!opts.gate && !opts.userId) return runModList(text, opts);
    const slot = (opts.gate ?? modlistGate).tryAcquire(opts.userId ?? null);
    if (!slot.ok) {
        const log = typeof opts.log === 'function' ? opts.log : (level, msg) => { try { logger[level]?.(msg); } catch (_) { /* nada */ } };
        log('info', `[ListaMods] recusado: ${slot.reason}`);
        return {
            ok: false, mode: 'ocupado', busy: slot.reason, items: [], compat: null, complements: [], conflicts: [],
            text: slot.reason === 'user' ? MODLIST_TEXT.userBusy : MODLIST_TEXT.busy, stats: { items: 0, found: 0, requests: 0 },
        };
    }
    try {
        return await runModList(text, opts);
    } finally {
        slot.release();
    }
}

async function runModList(text, opts) {
    const now = typeof opts.now === 'function' ? opts.now : Date.now;
    const sleep = typeof opts.sleep === 'function' ? opts.sleep : defaultSleep;
    const random = typeof opts.random === 'function' ? opts.random : Math.random;
    const log = typeof opts.log === 'function' ? opts.log : (level, msg) => { try { logger[level]?.(msg); } catch (_) { /* o log nunca atrapalha */ } };
    const cfg = opts.config ?? readModlistConfig(opts.env ?? process.env);
    const startedAt = now();
    const totalUntil = startedAt + cfg.deadlineMs;
    const state = newJobState();

    const parsed = opts.parsed ?? parseModList(text);
    const allItems = parsed.items;
    const items = allItems.slice(0, cfg.maxItems);
    const over = allItems.length - items.length;
    const hintsRaw = opts.hints ?? (opts.parsed?.hints) ?? extractHints(fold(`${parsed.prose.join(NL)}${NL}${parsed.hintLines.join(NL)}`));
    const hints = {
        loader: hintsRaw?.loader && LOADERS.includes(hintsRaw.loader) ? hintsRaw.loader : null,
        mcVersion: hintsRaw?.mcVersion && isReleaseVersion(hintsRaw.mcVersion) ? hintsRaw.mcVersion : null,
    };

    // Triagem ANTES de qualquer rede: dado pessoal/segredo e palavra proibida viram "ignorado" (sem eco e sem link de busca); partes genéricas também.
    const model = items.map((it) => ({ index: it.index, input: it.label, entries: [], parts: [] }));
    items.forEach((it, i) => {
        for (const p of it.parts) {
            const scrub = scrubQuery(p, { forbiddenKeywords: opts.forbiddenKeywords ?? [], max: 80 });
            if (!scrub.ok || !scrub.query) { model[i].parts.push({ item: model[i], label: p, skip: 'masked' }); continue; }
            model[i].parts.push({ item: model[i], label: p, query: scrub.query });
        }
        for (const g of it.generic ?? []) model[i].parts.push({ item: model[i], label: g, skip: 'generic' });
    });
    const allParts = model.flatMap((m) => m.parts);
    const toSearch = allParts.filter((p) => !p.skip);

    const researchCfg = opts.researchConfig ?? readResearchConfig(opts.env ?? process.env);
    let mode = 'normal';
    if (opts.sensitive === true && !privateSearchAllowed(researchCfg.privateSearch, { isOwner: opts.isOwner === true })) mode = 'sem-consulta';
    else if (opts.searchDisabled === true) mode = 'desativada';

    const base = { total: items.length, over, limit: cfg.maxItems, deadlineSeconds: Math.round(cfg.deadlineMs / 1000) };
    const finish = (extra) => {
        const stats = {
            items: items.length, parts: toSearch.length, requests: state.requests, cacheHits: state.cacheHits, ms: Math.max(0, now() - startedAt),
            ...extra.stats,
        };
        const result = { ok: true, mode: extra.mode ?? mode, items: model.map((m) => ({ index: m.index, input: m.input, entries: m.entries })), compat: extra.compat ?? null, complements: extra.complements ?? [], conflicts: extra.conflicts ?? [], stats };
        result.text = formatModListReply({
            ...base, items: result.items, compat: result.compat, complements: result.complements, conflicts: result.conflicts, mode: result.mode,
            stopAt: stats.stopAt, stopReason: stats.stopReason, unverified: stats.unverified, complementsSkipped: stats.complementsSkipped,
        });
        return result;
    };
    if (mode !== 'normal' || !toSearch.length) {
        // sem consulta nenhuma: só links de busca locais
        for (const m of model) {
            for (const p of m.parts) {
                if (p.skip) m.entries.push(emptyEntry(p.skip === 'masked' ? '' : p.label, 'pulado', { masked: p.skip === 'masked', reason: p.skip }));
                else m.entries.push(emptyEntry(p.label, 'nao', { unsearched: true }));
            }
        }
        const result = finish({ mode, stats: { found: 0, skipped: allParts.filter((p) => p.skip).length, partial: false } });
        log('info', `[ListaMods] sem consulta (${mode}): itens=${items.length}`);
        return result;
    }

    const ctx = opts.ctx ?? sharedModlistContext;
    ctx.limiter.setMax(cfg.concurrency);
    const client = createClient({ ctx, fetch: typeof opts.fetch === 'function' ? opts.fetch : (defaultFetchForTest ?? safeFetchText), now, sleep, random, signal: opts.signal, state });
    const progressCb = typeof opts.onProgress === 'function' ? opts.onProgress : () => {};
    const progress = (event) => { try { progressCb(event); } catch (_) { /* progresso nunca derruba o trabalho */ } };

    // ── Fase 1: buscar cada nome (em ORDEM; ao estourar a fatia da fase, o resto fica sem consulta) ──
    const searchUntil = startedAt + Math.floor(cfg.deadlineMs * LIMITS.searchStageShare);
    let done = 0;
    try { progress({ stage: 'start', done: 0, total: toSearch.length }); } catch (_) { /* progresso nunca derruba */ }
    await runPool(toSearch, cfg.concurrency, async (part) => {
        let r;
        try { r = await resolvePart(part, { client, until: searchUntil }); } catch (_) { r = { entries: [emptyEntry(part.label, 'nao', { searchFailed: true })], failed: true }; }
        part.result = r;
        done++;
        try { progress({ stage: 'search', done, total: toSearch.length }); } catch (_) { /* progresso nunca derruba */ }
    });

    // O Modrinth não respondeu NENHUMA vez (e houve tentativa): resposta honesta, só links de busca
    if (state.requests > 0 && state.okCount + state.cacheHits === 0) {
        for (const m of model) for (const p of m.parts) m.entries.push(p.skip ? emptyEntry(p.skip === 'masked' ? '' : p.label, 'pulado', { masked: p.skip === 'masked', reason: p.skip }) : emptyEntry(p.label, 'nao', { unsearched: true }));
        const result = finish({ mode: 'fora-do-ar', stats: { found: 0, outage: true, rateLimited: state.rateLimited } });
        log('warn', `[ListaMods] Modrinth sem resposta: itens=${items.length} pedidos=${state.requests} 429=${state.count429} ms=${result.stats.ms}`);
        return result;
    }

    // Itens que ficaram sem consulta (prazo, 429 ou queda no meio): só link de busca, e a partir de qual item
    let stopAt = 0;
    let stopReason = '';
    for (const m of model) {
        for (const p of m.parts) {
            if (p.skip) continue;
            if (!p.result || p.result.cutoff === true || !p.result.entries.length) {
                if (!stopAt) stopAt = m.index;
                p.unsearched = true;
            }
        }
    }
    if (stopAt) stopReason = state.rateLimited ? 'ratelimit' : state.stopReason === 'outage' ? 'outage' : 'deadline'; // abort do chamador conta como prazo

    // Entradas por parte, em ordem
    for (const m of model) {
        for (const p of m.parts) {
            if (p.skip) { m.entries.push(emptyEntry(p.skip === 'masked' ? '' : p.label, 'pulado', { masked: p.skip === 'masked', reason: p.skip })); continue; }
            if (p.unsearched) { m.entries.push(emptyEntry(p.label, 'nao', { unsearched: true })); continue; }
            for (const e of p.result.entries) m.entries.push(e);
        }
    }
    const flat = model.flatMap((m) => m.entries.map((e) => ({ e, item: m })));

    // Duplicatas: duas linhas que caem no mesmo projeto (Embelium e Embelium 2) aparecem uma vez
    const firstOf = new Map();
    for (const { e, item } of flat) {
        if (!e.projectId || e.band === 'nao' || e.band === 'pulado') continue;
        if (firstOf.has(e.projectId)) { const f = firstOf.get(e.projectId); e.band = 'duplicado'; e.dupOf = f.index; e.dupTitle = f.title; e.cands = []; continue; }
        firstOf.set(e.projectId, { index: item.index, title: e.title });
    }
    const live = flat.map((x) => x.e).filter((e) => (e.band === 'achado' || e.band === 'aviso') && e.cands?.length);

    // ── Fase 2: o par (loader, versão) ──
    const unpinned = choosePair(live, {});
    const pinned = hints.loader || hints.mcVersion ? choosePair(live, hints) : null;
    const chosen = pinned ?? unpinned;
    // A união de loaders/versões que o Modrinth traz na busca MENTE (um mod com "forge" e "26.1.2" na união pode ter Forge só até 1.20.1), e o empate
    // vai para a versão mais nova. Sem par completo pedido, confere DE VERDADE os pares empatados com uma amostra pequena de mods populares.
    let chosenBest = chosen.best;
    if (chosenBest && chosenBest.covered > 0 && !(hints.loader && hints.mcVersion)) {
        chosenBest = await probePairs(chosen.rows, live, { client, until: totalUntil - 1500 }) ?? chosenBest;
    }
    // Par com cobertura; sem cobertura só vale como "pedido" quando a pessoa fixou loader E versão (senão não há par para mostrar)
    let pair = null;
    if (chosenBest && chosenBest.covered > 0) pair = chosenBest;
    else if (hints.loader && hints.mcVersion) pair = { loader: hints.loader, version: hints.mcVersion, covered: 0 };
    const pairKnown = Boolean(pair);
    const requested = [hints.loader ? loaderName(hints.loader) : '', hints.mcVersion ?? ''].filter(Boolean).join(' ');

    // ── Fase 3: a versão REAL de cada mod no par (1 requisição por mod, filtrada por loader e versão) ──
    let unverified = 0;
    const completeUntil = totalUntil - 1500;
    if (pairKnown && pair.covered > 0) {
        const targets = live;
        let verified = 0;
        progress({ stage: 'verify', done: 0, total: targets.length });
        await runPool(targets, cfg.concurrency, async (e) => {
            const options = e.cands.filter((c) => supports(c.h, pair.loader, pair.version)).slice(0, 2);
            if (!options.length) { e.inPair = false; return; }
            let outcome = 'empty';
            for (const c of options) {
                const r = await client.versionFor(c.h.project_id, pair.loader, pair.version, { until: completeUntil });
                if (r.kind === 'ok') {
                    outcome = 'ok';
                    if (c.h.project_id !== e.projectId) {
                        // troca para caber no par: marcada com aviso
                        e.swappedFrom = e.title;
                        e.projectId = c.h.project_id; e.title = c.h.title; e.slug = c.h.slug;
                        if (e.band === 'achado') e.band = 'aviso';
                        e.swapped = true;
                    }
                    e.inPair = true;
                    e.version = r.best;
                    break;
                }
                if (r.kind !== 'empty') { outcome = 'fail'; break; }
            }
            if (outcome === 'empty') e.inPair = false;
            if (outcome === 'fail') { e.inPair = null; unverified++; }
            verified++;
            try { progress({ stage: 'verify', done: verified, total: targets.length }); } catch (_) { /* nada */ }
        });
    } else {
        for (const e of live) e.inPair = pairKnown ? false : null;
    }
    // quem não está no par: onde existe (segundo o que o próprio projeto lista)
    for (const e of live) {
        if (e.inPair !== false) continue;
        const hit = (e.cands.find((c) => c.h.project_id === e.projectId) ?? e.cands[0])?.h;
        if (!hit) continue;
        e.otherLoaders = LOADERS.filter((l) => hit.categories.includes(l)).map(loaderName);
        const vs = (hit.versions || []).filter(isReleaseVersion).sort(compareMcVersion);
        e.newestVersion = vs.length ? vs[vs.length - 1] : '';
    }

    // ── Fase 4: Important Complements (dependências OBRIGATÓRIAS que não estão na lista) ──
    const listed = new Set();
    for (const e of live) { listed.add(e.projectId); for (const c of e.cands) listed.add(c.h.project_id); }
    for (const x of flat) if (x.e.projectId) listed.add(x.e.projectId);
    const idToEntry = new Map();
    for (const e of live) if (e.projectId) idToEntry.set(e.projectId, e);
    const complementMap = new Map(); // id -> { id, neededBy:Set<entry>, depth, version }
    const need = (id, owner, depth) => {
        if (!id || listed.has(id)) return false;
        let c = complementMap.get(id);
        if (!c) { c = { id, owners: new Set(), depth, version: null, info: null }; complementMap.set(id, c); }
        c.owners.add(owner);
        return true;
    };
    const conflicts = [];
    for (const e of live) {
        if (!e.version || e.doubtful) continue; // nome duvidoso: nem complementos nem incompatibilidades de um mod que pode ser outro
        for (const id of e.version.required) need(id, e, 1);
        for (const id of e.version.incompatible) {
            const other = idToEntry.get(id);
            if (other && other !== e) conflicts.push({ a: e, b: other });
        }
    }
    let complementsSkipped = false;
    if (complementMap.size && pairKnown && pair.covered > 0 && now() < completeUntil - 1000) {
        progress({ stage: 'complements', done: 0, total: complementMap.size });
        let lookups = 0;
        for (let round = 0; round < 2; round++) {
            let pending = [...complementMap.values()].filter((c) => !c.looked && c.depth === round + 1);
            if (!pending.length) break;
            const room = LIMITS.maxComplementLookups - lookups;
            if (pending.length > room) { complementsSkipped = true; pending = pending.slice(0, Math.max(0, room)); } // consulta o que cabe e AVISA do resto
            if (!pending.length) break;
            lookups += pending.length;
            const info = await client.projectInfo(pending.map((c) => c.id), { until: completeUntil });
            for (const c of pending) c.info = info.get(c.id) ?? null;
            await runPool(pending.filter((c) => c.info), cfg.concurrency, async (c) => {
                c.looked = true;
                const r = await client.versionFor(c.id, pair.loader, pair.version, { until: completeUntil });
                if (r.kind === 'ok') {
                    c.version = r.best;
                    if (round === 0) for (const id of r.best.required) { if (need(id, [...c.owners][0], 2)) for (const o of c.owners) complementMap.get(id)?.owners.add(o); }
                } else if (r.kind === 'empty') c.unavailable = true;
            });
        }
        for (const c of complementMap.values()) if (!c.info) complementsSkipped = true; // prazo, falha ou teto: o complemento existe mas não foi conferido
    } else if (complementMap.size) complementsSkipped = true;

    const complements = [];
    for (const c of complementMap.values()) {
        if (!c.info) continue;
        const slug = c.info.slug;
        const comp = {
            projectId: c.id, title: c.info.title, slug, url: projectPageUrl(slug), versionUrl: c.version ? versionPageUrl(slug, c.version.id) : '',
            versionNumber: c.version?.number ?? '', unavailable: c.unavailable === true, neededBy: [...c.owners].map((o) => o.title).slice(0, 12),
        };
        complements.push(comp);
        for (const o of c.owners) (o.complements ??= []).push(comp);
    }

    // ── Compatibilidade ──
    const cover = live.filter((e) => e.inPair === true);
    const out = live.filter((e) => e.inPair === false);
    const found = live.length;
    const compat = {
        loader: pairKnown ? pair.loader : null,
        version: pairKnown ? pair.version : null,
        pinned: Boolean(pinned),
        partialPin: Boolean(pinned && !(hints.loader && hints.mcVersion)),
        requested,
        found,
        covered: cover.length,
        coverage: found ? cover.length / found : 0,
        missing: out.map((e) => e.title),
        notFound: flat.filter((x) => x.e.band === 'nao' && !x.e.unsearched && !x.e.searchFailed).map((x) => x.e.label).filter(Boolean),
        unverified,
        suggestion: pinned && unpinned.best && (pinned.best?.covered ?? 0) < unpinned.best.covered ? { loader: unpinned.best.loader, version: unpinned.best.version, covered: unpinned.best.covered } : null,
    };
    const conflictList = conflicts.slice(0, 6).map((c) => ({ a: c.a.title, b: c.b.title }));

    progress({ stage: 'format', done: 1, total: 1 });
    const bands = flat.map((x) => x.e.band);
    const result = finish({
        compat,
        complements,
        conflicts: conflictList,
        stats: {
            found,
            warned: bands.filter((b) => b === 'aviso').length,
            notFound: bands.filter((b) => b === 'nao').length,
            skipped: bands.filter((b) => b === 'pulado').length,
            duplicates: bands.filter((b) => b === 'duplicado').length,
            stopAt, stopReason, unverified, complementsSkipped,
            rateLimited: state.rateLimited, count429: state.count429, partial: Boolean(stopAt || unverified || complementsSkipped),
        },
    });
    log('info', `[ListaMods] pronto: itens=${items.length} achados=${found} no_par=${cover.length} complementos=${complements.length} pedidos=${state.requests} cache=${state.cacheHits} ms=${result.stats.ms}${stopAt ? ` parou=${stopReason}` : ''}`);
    return result;
}

// ---------------------------------------------------------------------------------------------
// 9. Formatação (texto puro em português; tudo que veio de fora passa por plainText/mdLink)
// ---------------------------------------------------------------------------------------------

const MAX_COMPLEMENTS_INLINE = 4;
const MAX_NAMES_LISTED = 8;
const nameList = (names) => {
    const clean = names.map((n) => plainText(n, 40)).filter(Boolean);
    const shown = clean.slice(0, MAX_NAMES_LISTED).join(', ');
    return clean.length > MAX_NAMES_LISTED ? `${shown} e mais ${clean.length - MAX_NAMES_LISTED}` : shown;
};
const pairName = (c) => `${loaderName(c.loader)} ${plainText(String(c.version), 12, { domains: false })}`;

function searchText(label) {
    if (!cleanSearchText(label)) return 'sem link de busca (o texto era só um endereço)'; // nada de q= vazio
    const { modrinth, curseforge } = searchLinks(label);
    return `busca (não é download): ${mdLink('Modrinth', cleanUrl(modrinth))} · ${mdLink('CurseForge', cleanUrl(curseforge))}`;
}

function complementsInline(list) {
    const usable = (Array.isArray(list) ? list : []).filter((c) => c && cleanUrl(c.url));
    const shown = usable.slice(0, MAX_COMPLEMENTS_INLINE);
    if (!shown.length) return '';
    const more = usable.length - shown.length;
    const links = shown.map((c) => mdLink(c.title || 'complemento', cleanUrl(c.url))).join(', ');
    return ` (${MODLIST_TEXT.complements}: ${links}${more > 0 ? ` e mais ${more}` : ''})`;
}

function entryText(entry, { pair, searchOnly }) {
    const label = plainText(entry.label, 60);
    if (entry.band === 'pulado') {
        if (entry.masked) return 'item ignorado (não consultei)';
        return entry.reason === 'generic' ? `${label} — genérico demais para procurar: diga o nome de cada um` : `${label} — ignorado (não consultei)`;
    }
    if (entry.band === 'duplicado') return `${label} — é o mesmo mod do item ${Number(entry.dupOf) || '?'} (${plainText(entry.dupTitle, 50)})`;
    const page = entry.slug ? cleanUrl(modPageUrl(entry.slug)) : '';
    if (searchOnly || entry.band === 'nao' || !page) {
        if (entry.searchFailed) return `${label} — não consegui consultar este nome agora; ${searchText(entry.label)}`;
        if (searchOnly || entry.unsearched) return `${label} — não consultei; ${searchText(entry.label)}`;
        return `${label} — não achei no Modrinth; ${searchText(entry.label)}`;
    }
    const verUrl = entry.version && entry.slug && !entry.doubtful ? cleanUrl(versionPageUrl(entry.slug, entry.version.id)) : '';
    let text = mdLink(entry.title || entry.label, page);
    if (entry.doubtful) return `${text} — para «${label}» só achei algo parecido e pode ser outro mod: confira antes de baixar; ${searchText(entry.label)}`;
    if (verUrl) {
        const vn = plainText(entry.version.number, 30, { domains: false });
        const beta = entry.version.type === 'release' ? '' : ` (${entry.version.type})`;
        text += ` · ${mdLink(`baixar${vn ? ` ${vn}` : ''}${beta}`, verUrl)}`;
    }
    if (entry.band === 'aviso') {
        const wrote = normalizeName(entry.swappedFrom ?? entry.title) === normalizeName(entry.label) ? '' : ` (você escreveu «${label}»)`;
        if (entry.split) text += ' — separei o nome em dois, confira';
        else if (entry.swapped) text += ` — troquei «${plainText(entry.swappedFrom, 40)}» por este para caber em ${pair ? pairName(pair) : 'a combinação'}${wrote}, confira`;
        else text += ` — achei como «${plainText(entry.title, 50)}»${wrote}, confira`;
    }
    if (entry.inPair === false) {
        const where = (entry.otherLoaders ?? []).slice(0, 4).join(', ');
        const upto = entry.newestVersion ? `, versões até ${plainText(entry.newestVersion, 12, { domains: false })}` : '';
        text += ` — sem versão para ${pair ? pairName(pair) : 'a combinação'}${where ? ` (existe para: ${where}${upto})` : ''}`;
    } else if (entry.inPair === null) {
        text += ' — não consegui conferir a versão agora (só a página do mod)';
    }
    return text + complementsInline(entry.complements);
}

function itemText(item, opts) {
    const searchOnly = opts.stopAt ? item.index >= opts.stopAt : false;
    const entries = Array.isArray(item.entries) && item.entries.length ? item.entries : [emptyEntry(item.input, 'nao', { unsearched: true })];
    if (entries.length <= 1) return `${item.index}. ${entryText(entries[0], { ...opts, searchOnly })}`;
    // parte ignorada por dado pessoal/palavra proibida: o texto da linha NUNCA volta (nem no título do item)
    const heading = entries.some((e) => e.masked) ? 'item com parte ignorada' : plainText(item.input, 80);
    const lines = [`${item.index}. ${heading}`];
    for (const e of entries) lines.push(`   - ${entryText(e, { ...opts, searchOnly })}`);
    return lines.join(NL);
}

function compatLines(result, counts) {
    const c = result.compat;
    const out = [];
    if (!c || !c.found) {
        if (counts.ok + counts.fuzzy > 0) out.push(MODLIST_TEXT.noCombo);
        return out;
    }
    if (!c.loader || !c.covered) {
        const asked = c.loader ? pairName(c) : plainText(c.requested || '', 30, { domains: false });
        out.push(c.pinned && asked ? `Compatibilidade: nenhum dos ${c.found} mods achados tem versão para **${asked}**.` : MODLIST_TEXT.noCombo);
        if (c.suggestion) out.push(`A combinação que reúne mais mods é **${pairName(c.suggestion)}** (${c.suggestion.covered} dos ${c.found}).`);
        return out;
    }
    const notFound = Array.isArray(c.notFound) ? c.notFound : [];
    if (c.covered === c.found) {
        out.push(`Compatibilidade: ${c.found === 1 ? 'o único mod encontrado existe' : `todos os ${c.found} mods encontrados existem`} para **${pairName(c)}**${notFound.length ? `; faltam (não achei no Modrinth): ${nameList(notFound)}.` : '.'}`);
    } else if (c.pinned) {
        const head = c.partialPin ? `Você pediu **${plainText(c.requested || '', 30, { domains: false })}**; a melhor combinação com isso é **${pairName(c)}**` : `Você pediu **${pairName(c)}**`;
        out.push(`${head}: ${c.covered} dos ${c.found} mods encontrados existem para ela. Ficam de fora: ${nameList(c.missing)}${notFound.length ? `. Faltam (não achei): ${nameList(notFound)}.` : '.'}`);
        if (c.suggestion && !c.partialPin) out.push(`A combinação que reúne mais mods é **${pairName(c.suggestion)}** (${c.suggestion.covered} dos ${c.found}).`);
    } else {
        out.push(`Compatibilidade: **${pairName(c)}** é a combinação que reúne mais mods (${c.covered} dos ${c.found} encontrados). Ficam de fora: ${nameList(c.missing)}${notFound.length ? `. Faltam (não achei): ${nameList(notFound)}.` : '.'}`);
    }
    return out;
}

/** Texto final (Markdown do Discord): cabeçalho, compatibilidade, itens numerados na ordem da pessoa, complementos, avisos e rodapé. */
export function formatModListReply(result) {
    const items = Array.isArray(result?.items) ? result.items : [];
    const total = result?.total ?? items.length;
    const mode = result?.mode ?? 'normal';
    const out = [MODLIST_TEXT.title(total)];
    const all = items.flatMap((i) => i.entries ?? []);
    const counts = {
        ok: all.filter((e) => e.band === 'achado').length,
        fuzzy: all.filter((e) => e.band === 'aviso').length,
        none: all.filter((e) => e.band === 'nao').length,
        skipped: all.filter((e) => e.band === 'pulado').length,
        dup: all.filter((e) => e.band === 'duplicado').length,
    };
    if (mode === 'sem-consulta') out.push(MODLIST_TEXT.noConsult);
    else if (mode === 'desativada') out.push(MODLIST_TEXT.disabled);
    else if (mode === 'fora-do-ar') out.push(MODLIST_TEXT.outage);
    else {
        out.push(MODLIST_TEXT.counts(counts));
        out.push(...compatLines(result, counts));
        const c = result?.compat;
        if (counts.ok + counts.fuzzy > 0) out.push(c && c.loader && c.covered > 0 ? MODLIST_TEXT.howTo : MODLIST_TEXT.howToNoCombo);
        if (result?.unverified > 0) out.push(MODLIST_TEXT.unverified(result.unverified));
        if (result?.complementsSkipped === true) out.push(MODLIST_TEXT.complementsPartial);
    }
    if (result?.over > 0) out.push(MODLIST_TEXT.over(result.limit ?? total, result.over));
    const stopAt = result?.stopAt ?? 0;
    if (stopAt > 0 && mode === 'normal') {
        out.push(result?.stopReason === 'outage' ? MODLIST_TEXT.stoppedOutage(stopAt)
            : result?.stopReason === 'ratelimit' ? MODLIST_TEXT.stoppedRate(stopAt)
                : MODLIST_TEXT.deadline(result.deadlineSeconds ?? 120, stopAt));
    }
    if (mode === 'normal' && result?.compat?.loader && counts.ok + counts.fuzzy > 0) out.push(MODLIST_TEXT.ask);

    out.push('');
    const opts = { pair: result?.compat?.loader ? result.compat : null, stopAt };
    for (const item of items) out.push(itemText(item, opts));

    const comps = Array.isArray(result?.complements) ? result.complements : [];
    if (mode === 'normal' && comps.length) {
        out.push('', MODLIST_TEXT.complementsHeader);
        for (const c of comps) {
            const page = cleanUrl(c.url);
            if (!page) continue;
            const ver = c.versionUrl ? cleanUrl(c.versionUrl) : '';
            const by = (c.neededBy ?? []).slice(0, 3).map((n) => plainText(n, 30)).filter(Boolean).join(', ');
            let line = `- ${mdLink(c.title, page)}`;
            if (ver) line += ` · ${mdLink(`baixar${c.versionNumber ? ` ${plainText(c.versionNumber, 30, { domains: false })}` : ''}`, ver)}`;
            else if (c.unavailable) line += ' — sem versão para a combinação escolhida';
            if (by) line += ` — pedido por ${by}${(c.neededBy ?? []).length > 3 ? ' e outros' : ''}`;
            out.push(line);
        }
    }
    const conflicts = Array.isArray(result?.conflicts) ? result.conflicts : [];
    if (mode === 'normal' && conflicts.length) {
        out.push('', MODLIST_TEXT.conflictsHeader);
        for (const c of conflicts) out.push(`- ${plainText(c.a, 40)} declara ser incompatível com ${plainText(c.b, 40)}`);
    }
    out.push('', MODLIST_TEXT.footer);
    return neutralizeMassMentions(out.join(NL));
}

// ---------------------------------------------------------------------------------------------
// 10. Trava: uma lista por pessoa e no máximo duas no total
// ---------------------------------------------------------------------------------------------

export function createModlistGate({ maxJobs = MODLIST_DEFAULTS.maxJobs, ttlMs = MODLIST_DEFAULTS.slotTtlMs, now = Date.now } = {}) {
    const byUser = new Map();
    const anonymous = new Map();
    const sweep = (t) => {
        for (const [k, v] of byUser) if (t - v.since >= ttlMs) byUser.delete(k);
        for (const [k, since] of anonymous) if (t - since >= ttlMs) anonymous.delete(k);
    };
    return {
        /** { ok:true, release } | { ok:false, reason:'user'|'busy' } */
        tryAcquire(userId) {
            const t = now();
            sweep(t);
            const id = userId ? String(userId) : '';
            if (id && byUser.has(id)) return { ok: false, reason: 'user' };
            if (byUser.size + anonymous.size >= maxJobs) return { ok: false, reason: 'busy' };
            const token = Symbol('modlist');
            if (id) byUser.set(id, { since: t, token }); else anonymous.set(token, t);
            return { ok: true, release: () => { if (id) { if (byUser.get(id)?.token === token) byUser.delete(id); } else anonymous.delete(token); } };
        },
        size: () => byUser.size + anonymous.size,
    };
}
export const modlistGate = createModlistGate();

// ---------------------------------------------------------------------------------------------
// 11. Porta de entrada (/yui, +yui e menção/DM)
// ---------------------------------------------------------------------------------------------

/**
 * Mesmo contrato do routeExplicitResearch do manager.js. `entry`: { text (SÓ a fala da pessoa), sensitive (conversa PRIVADA), isOwner, userId,
 * guildId, channelId, progress (show(linha, opts)) }. `deps`: { llm:{ isToolDisabled }, fetch, now, sleep, ctx, gate, env, log, forbiddenKeywords, researchConfig }.
 * @returns {Promise<{handled:false, reason:string}|{handled:true, text:string, researched:true, kind:'modlist', private:boolean, historyLine:null}>}
 * Nunca lança: erro inesperado devolve handled:false (a IA responde como antes).
 */
export async function routeModList(entry = {}, deps = {}) {
    const log = typeof deps.log === 'function' ? deps.log : (level, msg) => { try { logger[level]?.(msg); } catch (_) { /* nada */ } };
    try {
        const env = deps.env ?? process.env;
        const cfg = readModlistConfig(env);
        if (!cfg.enabled) return { handled: false, reason: 'desligado' };
        // Quem roda dentro da fila serial (menção/DM) limita o prazo: o trabalho segura a fila toda enquanto roda. Pode ser menor que o piso da configuração.
        if (Number.isFinite(deps.deadlineCapMs) && deps.deadlineCapMs > 0) cfg.deadlineMs = Math.min(cfg.deadlineMs, Math.floor(deps.deadlineCapMs));
        const det = detectModListRequest(entry.text);
        if (!det.isRequest) return { handled: false, reason: det.reason };

        const privateChat = entry.sensitive === true;
        const out = (text) => ({ handled: true, text, researched: true, kind: 'modlist', private: privateChat, historyLine: null });
        let forbiddenKeywords = deps.forbiddenKeywords;
        if (!Array.isArray(forbiddenKeywords)) {
            try { forbiddenKeywords = (await import('./banHandler.js')).forbiddenKeywords; } catch (_) { forbiddenKeywords = []; }
        }
        const toolOff = deps.isToolDisabled ?? deps.llm?.isToolDisabled;
        const searchDisabled = typeof toolOff === 'function' && toolOff(entry.guildId ?? null, 'search_web') === true;
        const progress = typeof entry.progress === 'function' ? entry.progress : () => false;
        let midShown = false;
        const total = Math.min(det.items.length, cfg.maxItems);
        const result = await resolveModList(entry.text, {
            ...deps, config: cfg, parsed: { ...parseModList(entry.text), hints: det.hints }, hints: det.hints,
            sensitive: privateChat, isOwner: entry.isOwner === true, searchDisabled, forbiddenKeywords, env, log,
            userId: entry.userId ?? null, gate: deps.gate ?? modlistGate, // a trava vale também para quem veio sem id (conta no total)
            onProgress: ({ stage, done }) => {
                if (stage === 'start') progress(`-# 🔎 Procurando os mods: 0/${total}`);
                else if (stage === 'search' && !midShown && total >= 10 && done >= Math.floor(total / 2)) { midShown = true; progress(`-# 🔎 Procurando ${done}/${total}`); }
                else if (stage === 'verify' && done === 0) progress('-# 🔎 Conferindo versões e complementos');
            },
        });
        if (result.mode === 'ocupado') return out(result.text);
        // Nenhum acerto e o Modrinth RESPONDEU: quase certo que não era lista de mods de Minecraft (ex.: mods de outro jogo). A IA responde como antes.
        if (result.mode === 'normal' && (result.stats.found ?? 0) === 0 && total >= 5 && !result.stats.partial && !result.stats.stopAt && (result.stats.skipped ?? 0) === 0) {
            log('info', `[ListaMods] sem acertos no Modrinth (itens=${total}): segue para a IA`);
            return { handled: false, reason: 'sem-acertos' };
        }
        // Poucos acertos de verdade (ex.: "mods" = moderadores e uma lista de nomes de pessoas): menos de 30% dos itens e nenhum acerto cheio -> também não é lista de mods
        if (result.mode === 'normal' && total >= 5 && !result.stats.partial && !result.stats.stopAt && (result.stats.skipped ?? 0) === 0) {
            const solid = result.items.reduce((n, it) => n + it.entries.filter((e) => e.band === 'achado').length, 0);
            if ((result.stats.found ?? 0) / total < 0.3 && solid === 0) {
                log('info', `[ListaMods] poucos acertos (${result.stats.found ?? 0} de ${total}, nenhum cheio): segue para a IA`);
                return { handled: false, reason: 'poucos-acertos' };
            }
        }
        progress('-# ✍️ Montando a lista', { last: true });
        return out(result.text);
    } catch (err) {
        try { log('warn', `[ListaMods] falha inesperada (a IA responde): ${String(err?.message ?? err).replace(/\s+/g, ' ').slice(0, 100)}`); } catch (_) { /* nada */ }
        return { handled: false, reason: 'erro' };
    }
}
