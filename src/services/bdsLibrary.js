// Biblioteca de arquivos do BDS Server (filmes, séries, importações do Braga Digital Studio), SOMENTE LEITURA.
// A Yui nunca escreve, move nem apaga: só chama rotas GET da API do BDS Server (busca, listar, recentes, estado).
// Módulo sem Discord e sem ler o .env no import: a configuração e o `fetch` entram por parâmetro, para testar offline.
//
// Segurança:
//  - o endereço vem do .env do dono (YUI_BDS_URL), nunca do texto de quem conversa;
//  - só GET; o caminho da pasta sai de uma lista fixa de apelidos (filmes, séries...), nunca de texto livre;
//  - nomes de arquivo são DADO: voltam dentro de código (`...`) sem crases nem menções.

export const BDS_TIMEOUT_MS = 8000;
export const BDS_MAX_BODY = 2_000_000;

/** Apelidos que a pessoa fala -> nome real da pasta na raiz do BDS Server (ver README do BDS Server). */
export const FOLDER_ALIASES = Object.freeze({
    filme: 'Filmes', filmes: 'Filmes',
    serie: 'Series', series: 'Series',
    download: 'Downloads', downloads: 'Downloads',
    projeto: 'Projetos', projetos: 'Projetos',
    backup: 'Backups', backups: 'Backups',
    biblioteca: 'Biblioteca-BDS'
});

export function readBdsConfig(env = process.env) {
    const raw = String(env.YUI_BDS_URL ?? '').trim().replace(/\/+$/, '');
    let url = '';
    try {
        const u = new URL(raw);
        if (u.protocol === 'http:' || u.protocol === 'https:') url = u.origin;
    } catch (_) { /* sem URL válida: desligado */ }
    const timeout = Number.parseInt(env.YUI_BDS_TIMEOUT_MS ?? '', 10);
    return {
        enabled: url !== '',
        url,
        key: String(env.YUI_BDS_KEY ?? '').trim(),
        timeoutMs: Number.isFinite(timeout) && timeout >= 1000 ? Math.min(timeout, 60_000) : BDS_TIMEOUT_MS,
        preRoute: String(env.YUI_BDS_PRE_ROUTE ?? 'true').toLowerCase() !== 'false'
    };
}

export class BdsError extends Error {
    constructor(message, kind = 'erro') { super(message); this.kind = kind; }
}

/** GET em uma rota da API do BDS Server. Lança BdsError (offline, tempo, HTTP, resposta grande/ inválida). */
export async function bdsGet(route, params = {}, deps = {}) {
    const cfg = deps.config ?? readBdsConfig(deps.env ?? process.env);
    if (!cfg.enabled) throw new BdsError('biblioteca desligada (YUI_BDS_URL vazio)', 'desligada');
    if (!/^\/api\/[a-z/]+$/.test(route)) throw new BdsError('rota inválida', 'erro');
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const url = `${cfg.url}${route}${qs.size ? `?${qs}` : ''}`;
    const headers = { Accept: 'application/json' };
    if (cfg.key) headers.Authorization = `Bearer ${cfg.key}`;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs);
    try {
        const res = await (deps.fetchImpl ?? fetch)(url, { method: 'GET', headers, signal: ctrl.signal, redirect: 'error' });
        const text = await res.text();
        if (text.length > BDS_MAX_BODY) throw new BdsError('resposta grande demais', 'erro');
        let data = null;
        try { data = text ? JSON.parse(text) : null; } catch (_) { /* tratado abaixo */ }
        if (!res.ok) throw new BdsError(data?.erro ? String(data.erro).slice(0, 120) : `HTTP ${res.status}`, res.status === 401 || res.status === 403 ? 'acesso' : 'erro');
        if (data === null) throw new BdsError('resposta inválida', 'erro');
        return data;
    } catch (err) {
        if (err instanceof BdsError) throw err;
        if (err?.name === 'AbortError') throw new BdsError('o servidor de arquivos demorou demais', 'tempo');
        throw new BdsError('não consegui falar com o servidor de arquivos', 'offline');
    } finally {
        clearTimeout(timer);
    }
}

// ───────────────────────── Formatação (Discord) ─────────────────────────

const sep = (p) => (String(p).includes('\\') ? '\\' : '/');

/** Nome de arquivo como DADO: sem crases, quebras nem menções; entra sempre dentro de `código`. */
export function safeName(name, max = 90) {
    const t = String(name ?? '').replace(/[`\r\n\u0000-\u001f]/g, ' ').replace(/@/g, '＠').replace(/\s+/g, ' ').trim();
    return t.length > max ? `${t.slice(0, max - 1)}…` : t;
}

export function fmtBytes(n) {
    if (n === null || n === undefined || !Number.isFinite(Number(n))) return '';
    const v = Number(n);
    if (v < 1024) return `${v} B`;
    if (v < 1024 ** 2) return `${(v / 1024).toFixed(1)} KB`;
    if (v < 1024 ** 3) return `${(v / 1024 ** 2).toFixed(1)} MB`;
    if (v < 1024 ** 4) return `${(v / 1024 ** 3).toFixed(2)} GB`;
    return `${(v / 1024 ** 4).toFixed(2)} TB`;
}

function fmtWhen(iso) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return '';
    const p = (n) => String(n).padStart(2, '0');
    return `${p(d.getDate())}/${p(d.getMonth() + 1)} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Caminho relativo à raiz do BDS Server ("Filmes\Acao\x.mkv"). */
function relativeTo(root, full) {
    const r = String(root ?? '').replace(/[\\/]+$/, '');
    const f = String(full ?? '');
    return r && f.toLowerCase().startsWith(r.toLowerCase()) ? f.slice(r.length).replace(/^[\\/]+/, '') || '.' : f;
}

const LINE_BUDGET = 1700;
function joinBudget(lines, budget = LINE_BUDGET) {
    const out = []; let used = 0;
    for (const l of lines) {
        if (used + l.length + 1 > budget) break;
        out.push(l); used += l.length + 1;
    }
    const hidden = lines.length - out.length;
    return { text: out.join('\n'), hidden };
}

async function getRoot(deps) {
    const roots = await bdsGet('/api/files/roots', {}, deps);
    const first = Array.isArray(roots) ? roots.find((r) => r.existe) : null;
    if (!first) throw new BdsError('o servidor de arquivos não tem pasta disponível', 'erro');
    return first.caminho;
}

export async function searchLibrary(query, deps = {}) {
    const q = String(query ?? '').trim();
    if (q.length < 2) return 'Diga pelo menos 2 letras para eu procurar na biblioteca.';
    const [root, data] = await Promise.all([getRoot(deps), bdsGet('/api/files/search', { q }, deps)]);
    const items = data.itens ?? [];
    if (!items.length) return `Não achei nada com **${safeName(q, 60)}** na biblioteca.`;
    const lines = items.map((i) => `• ${i.tipo === 'dir' ? '📁' : '🎞️'} \`${safeName(relativeTo(root, i.caminho))}\`${i.tipo === 'dir' ? '' : ` — ${fmtBytes(i.tamanho)}`}`);
    const { text, hidden } = joinBudget(lines);
    const more = hidden > 0 || data.truncado ? `\n(+${hidden} não exibido(s)${data.truncado ? '; a busca foi cortada, refine o nome' : ''})` : '';
    return `Achei **${items.length}** resultado(s) para **${safeName(q, 60)}**:\n${text}${more}`;
}

export async function listLibraryFolder(folderKey, deps = {}) {
    const name = FOLDER_ALIASES[String(folderKey ?? '').toLowerCase()];
    if (!name) throw new BdsError('pasta desconhecida', 'erro');
    const root = await getRoot(deps);
    const data = await bdsGet('/api/files/list', { caminho: `${root.replace(/[\\/]+$/, '')}${sep(root)}${name}` }, deps);
    const items = data.itens ?? [];
    if (!items.length) return `📁 **${name}** está vazia.`;
    const dirs = items.filter((i) => i.tipo === 'dir').length;
    const total = items.reduce((s, i) => s + (i.tamanho || 0), 0);
    const lines = items.map((i) => `• ${i.tipo === 'dir' ? '📁' : '🎞️'} \`${safeName(i.nome)}\`${i.tipo === 'dir' ? '' : ` — ${fmtBytes(i.tamanho)}`}`);
    const { text, hidden } = joinBudget(lines);
    const head = `📁 **${name}** — ${items.length} item(ns) (${dirs} pasta(s), ${items.length - dirs} arquivo(s), ${fmtBytes(total)} nos arquivos soltos):`;
    return `${head}\n${text}${hidden > 0 ? `\n(+${hidden} não exibido(s))` : ''}`;
}

export async function recentLibrary(deps = {}) {
    const [root, data] = await Promise.all([getRoot(deps), bdsGet('/api/files/recent', { limite: 10 }, deps)]);
    const items = data.itens ?? [];
    if (!items.length) return 'A biblioteca ainda não tem nenhum arquivo.';
    const lines = items.map((i) => `• ${fmtWhen(i.adicionado)} — \`${safeName(relativeTo(root, i.caminho))}\` (${fmtBytes(i.tamanho)})`);
    const { text, hidden } = joinBudget(lines);
    return `🆕 Últimos arquivos que chegaram na biblioteca:\n${text}${hidden > 0 ? `\n(+${hidden} não exibido(s))` : ''}`;
}

export async function statusLibrary(deps = {}) {
    const s = await bdsGet('/api/status', {}, deps);
    const gb = (n) => (Number(n) || 0).toFixed(0);
    const disks = (s.discos ?? []).filter((d) => d.totalGB !== null).map((d) => `💾 ${gb(d.totalGB - d.livreGB)} GB usados de ${gb(d.totalGB)} GB (**${gb(d.livreGB)} GB livres**)`);
    const up = s.uptimeSegundos ? `${(s.uptimeSegundos / 3600).toFixed(1)} h ligado` : '';
    const ram = s.ramTotalGB ? `RAM ${(((s.ramTotalGB - s.ramLivreGB) / s.ramTotalGB) * 100).toFixed(0)}%` : '';
    return `🗄️ Servidor de arquivos no ar (${safeName(s.hostname, 40)}${up ? `, ${up}` : ''}${ram ? `, ${ram}` : ''}).\n${disks.join('\n') || 'Sem dados de disco.'}`;
}

/** Despacha por tipo. Nunca devolve erro cru: traduz para uma frase curta. */
export async function runLibraryAction(kind, args = {}, deps = {}) {
    try {
        if (kind === 'search') return await searchLibrary(args.query, deps);
        if (kind === 'list') return await listLibraryFolder(args.folder, deps);
        if (kind === 'recent') return await recentLibrary(deps);
        if (kind === 'status') return await statusLibrary(deps);
        return 'Não entendi o que fazer na biblioteca.';
    } catch (err) {
        if (err instanceof BdsError) {
            if (err.kind === 'desligada') return 'A biblioteca (servidor de arquivos) não está configurada aqui.';
            if (err.kind === 'offline' || err.kind === 'tempo') return `Não consegui falar com o servidor de arquivos agora (${err.message}). Ele está ligado?`;
            if (err.kind === 'acesso') return 'O servidor de arquivos recusou o acesso da Yui (confira a chave).';
            return `O servidor de arquivos respondeu com erro: ${err.message}.`;
        }
        return 'Deu erro ao consultar a biblioteca.';
    }
}
