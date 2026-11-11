/**
 * Regras da tela "Arquivos" (BDS Server), sem React e sem rede (testáveis em Node): caminhos do Windows, trilha de pastas,
 * tamanhos, ícone e tipo de pré-visualização de cada arquivo. Nada aqui inventa dado: o que não existe vira null ou "—".
 */

/** O separador que o próprio caminho usa ("\\" no Windows do BDS Server, "/" se vier assim). */
export function sepOf(p: string): string {
  return p.includes('\\') ? '\\' : '/';
}

/** "C:\\BDS-Dados\\Filmes" + "Acao" -> "C:\\BDS-Dados\\Filmes\\Acao" (sem duplicar a barra). */
export function joinPath(dir: string, name: string): string {
  const s = sepOf(dir);
  return dir.replace(/[\\/]+$/, '') + s + name.replace(/^[\\/]+/, '');
}

/** Pasta que contém o item: "C:\\BDS-Dados\\Filmes\\a.mp4" -> "C:\\BDS-Dados\\Filmes". Na raiz devolve o próprio caminho. */
export function parentPath(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  const i = Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/'));
  if (/^[A-Za-z]:$/.test(t)) return t + '\\';
  if (i <= 2 && /^[A-Za-z]:/.test(t)) return t.slice(0, 3);
  return i > 0 ? t.slice(0, i) : t;
}

export function baseName(p: string): string {
  const t = p.replace(/[\\/]+$/, '');
  return t.slice(Math.max(t.lastIndexOf('\\'), t.lastIndexOf('/')) + 1);
}

export interface Crumb { label: string; path: string }

/** Trilha clicável: a raiz do servidor vira "Arquivos" e cada pasta abaixo dela, um item. Fora de qualquer raiz, devolve só o caminho inteiro. */
export function breadcrumbs(current: string, roots: string[]): Crumb[] {
  const norm = (x: string) => x.replace(/[\\/]+$/, '').toLowerCase();
  const cur = current.replace(/[\\/]+$/, '');
  const root = [...roots].sort((a, b) => b.length - a.length).find((r) => norm(cur) === norm(r) || norm(cur).startsWith(norm(r) + '\\') || norm(cur).startsWith(norm(r) + '/'));
  if (!root) return [{ label: cur || '—', path: cur }];
  const out: Crumb[] = [{ label: 'Arquivos', path: root.replace(/[\\/]+$/, '') }];
  const rest = cur.slice(root.replace(/[\\/]+$/, '').length).split(/[\\/]+/).filter(Boolean);
  let acc = root.replace(/[\\/]+$/, '');
  for (const part of rest) {
    acc = joinPath(acc, part);
    out.push({ label: part, path: acc });
  }
  return out;
}

/** 1536 -> "1,5 KB"; 3_221_225_472 -> "3,0 GB"; inválido -> "—". */
export function formatBytes(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n) || n < 0) return '—';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) { v /= 1024; i++; }
  const txt = i === 0 ? String(Math.round(v)) : v.toFixed(1).replace('.', ',');
  return `${txt} ${units[i]}`;
}

/** Data curta em pt-BR ("11/11/2026 12:49"); inválida -> "—". */
export function formatWhen(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return '—';
  const p = (x: number) => String(x).padStart(2, '0');
  return `${p(d.getDate())}/${p(d.getMonth() + 1)}/${d.getFullYear()} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

const EXT = (name: string) => (name.includes('.') ? name.slice(name.lastIndexOf('.') + 1).toLowerCase() : '');

export type PreviewKind = 'video' | 'audio' | 'image' | 'pdf' | null;

const VIDEO = new Set(['mp4', 'webm', 'm4v', 'mov', 'ogv']); // o que o navegador toca (mkv/avi/wmv baixam: use o HomeFlix)
const AUDIO = new Set(['mp3', 'wav', 'ogg', 'oga', 'm4a', 'aac', 'flac', 'opus']);
const IMAGE = new Set(['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg', 'avif']);

/** O que o navegador consegue mostrar/tocar sem baixar. null = só baixar. */
export function previewKind(name: string): PreviewKind {
  const e = EXT(name);
  if (VIDEO.has(e)) return 'video';
  if (AUDIO.has(e)) return 'audio';
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'pdf';
  return null;
}

/** Ícone (Material Symbols) por tipo de item. */
export function iconFor(name: string, tipo: string): string {
  if (tipo === 'dir' || tipo === 'pasta') return 'folder';
  const e = EXT(name);
  if (VIDEO.has(e) || ['mkv', 'avi', 'wmv', 'flv', 'ts', 'mpg', 'mpeg'].includes(e)) return 'movie';
  if (AUDIO.has(e)) return 'music_note';
  if (IMAGE.has(e)) return 'image';
  if (e === 'pdf') return 'picture_as_pdf';
  if (['zip', 'rar', '7z', 'tar', 'gz', 'iso'].includes(e)) return 'folder_zip';
  if (['srt', 'ass', 'vtt', 'sub'].includes(e)) return 'subtitles';
  if (['txt', 'md', 'doc', 'docx', 'rtf', 'log'].includes(e)) return 'description';
  return 'draft';
}

export interface RawItem { nome?: string; tipo?: string; tamanho?: number | null; modificado?: string | null; caminho?: string }
export interface FileItem { name: string; isDir: boolean; size: number | null; modified: string | null; path: string }

/** Normaliza os itens que o BDS Server devolve (pasta = tipo "dir"). `dir` é a pasta aberta, usada quando o item não traz o caminho. */
export function normalizeItems(raw: unknown, dir: string): FileItem[] {
  const list = Array.isArray((raw as any)?.itens) ? (raw as any).itens : Array.isArray(raw) ? raw : [];
  return list
    .filter((x: RawItem) => x && typeof x.nome === 'string' && x.nome)
    .map((x: RawItem) => ({
      name: x.nome as string,
      isDir: x.tipo === 'dir' || x.tipo === 'pasta',
      size: typeof x.tamanho === 'number' ? x.tamanho : null,
      modified: x.modificado ?? null,
      path: x.caminho || joinPath(dir, x.nome as string),
    }));
}

/** Pastas primeiro, depois por nome (pt-BR). */
export function sortItems(items: FileItem[]): FileItem[] {
  return [...items].sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'pt-BR') : a.isDir ? -1 : 1));
}

/** Nome novo válido para criar/renomear: sem barras, sem nome reservado, sem vazio. Devolve o motivo do erro ou null se está bom. */
export function nameProblem(name: string): string | null {
  const n = name.trim();
  if (!n) return 'Digite um nome.';
  if (n.length > 200) return 'O nome é longo demais.';
  if (/[\\/:*?"<>|]/.test(n)) return 'O nome não pode ter \\ / : * ? " < > |';
  if (n === '.' || n === '..') return 'Nome inválido.';
  return null;
}

/** Espaço do disco a partir do que o BDS Server informa (/files/usage): { usado, total, livre, percentLivre } ou null. */
export function diskUsage(raw: unknown): { total: number; free: number; used: number; freePercent: number } | null {
  const row = Array.isArray(raw) ? raw[0] : null;
  const total = Number(row?.totalBytes);
  const free = Number(row?.livreBytes);
  if (!Number.isFinite(total) || !Number.isFinite(free) || total <= 0) return null;
  return { total, free, used: total - free, freePercent: Math.max(0, Math.min(100, Math.round((free / total) * 100))) };
}

/** Segundos ligado -> "1d 2h", "3h 12min", "5min"; inválido -> "—". */
export function formatUptime(seconds: number | null | undefined): string {
  if (seconds === null || seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return '—';
  const d = Math.floor(seconds / 86400);
  const h = Math.floor((seconds % 86400) / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}

/** Estado do BDS Server em linhas com rótulo em português. Só mostra o que o servidor informou (nada inventado). */
export function describeBdsStatus(s: Record<string, unknown> | null | undefined): { label: string; value: string }[] {
  if (!s) return [];
  const num = (k: string) => (typeof s[k] === 'number' && Number.isFinite(s[k] as number) ? (s[k] as number) : null);
  const str = (k: string) => (typeof s[k] === 'string' && s[k] ? (s[k] as string) : null);
  const rows: { label: string; value: string }[] = [];
  const add = (label: string, value: string | null) => { if (value) rows.push({ label, value }); };
  add('Computador', str('hostname'));
  add('Sistema', str('so'));
  add('Versão do BDS Server', str('versao'));
  add('Node', str('node'));
  if (num('cpuPercent') !== null) add('Uso da CPU', `${num('cpuPercent')}%`);
  const total = num('ramTotalGB'); const free = num('ramLivreGB');
  if (total !== null && free !== null) add('Memória RAM livre', `${free.toFixed(1).replace('.', ',')} GB de ${total.toFixed(1).replace('.', ',')} GB`);
  if (num('processoMB') !== null) add('Memória do BDS Server', `${num('processoMB')} MB`);
  if (num('uptimeSegundos') !== null) add('Computador ligado há', formatUptime(num('uptimeSegundos')));
  const since = str('servidorDesde');
  if (since) add('BDS Server ligado desde', formatWhen(since));
  return rows;
}

const AUDIT_ACTIONS: Record<string, string> = {
  inicio: 'Servidor iniciado', preview: 'Visualizou', download: 'Baixou', upload: 'Enviou', rename: 'Renomeou', delete: 'Apagou (lixeira)',
  restore: 'Restaurou', purge: 'Apagou de vez', mkdir: 'Criou pasta', login: 'Entrou', logout: 'Saiu',
};

/** Linha da auditoria do BDS Server em português: "Enviou" (ação) e quem fez. */
export function describeBdsAudit(e: { module?: unknown; action?: unknown; user?: unknown; result?: unknown } | null | undefined): { text: string; who: string | null; failed: boolean } {
  const action = typeof e?.action === 'string' ? e.action : '';
  const mod = typeof e?.module === 'string' ? e.module : '';
  const text = AUDIT_ACTIONS[action] ?? ([mod, action].filter(Boolean).join(' · ') || 'Evento');
  const user = typeof e?.user === 'string' && e.user ? (e.user === 'anonimo' ? null : e.user) : null;
  return { text, who: user, failed: typeof e?.result === 'string' && e.result !== 'ok' };
}
