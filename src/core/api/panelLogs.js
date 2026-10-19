import fs from 'fs';
import path from 'path';

/**
 * Leitura dos logs da Yui para o painel (SOMENTE LEITURA, só o dono).
 *
 * Lê apenas arquivos app-AAAA-MM-DD.log e error-AAAA-MM-DD.log da pasta de logs
 * (nenhum caminho vem do cliente). Antes de devolver, mascara segredos: valores
 * de variáveis sensíveis do ambiente e formatos conhecidos de chaves.
 */

const KINDS = ['app', 'error'];
const FILE_RE = /^(app|error)-(\d{4}-\d{2}-\d{2})\.log$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const LEVELS = ['error', 'warn', 'info', 'debug'];
const MAX_LINES = 500;
const TAIL_BYTES = 768 * 1024;
const ENTRY_RE = /^\[(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2})\] \[([a-z]+)\] ?(.*)$/;
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\u001b\[[0-9;]*m/g;

const SENSITIVE_NAME = /(KEY|TOKEN|SECRET|PASSWORD|HASH|ARL|COOKIE)/i;
const KNOWN_FORMATS = [
  /AIza[0-9A-Za-z_-]{20,}/g, // Google
  /gsk_[0-9A-Za-z]{16,}/g, // Groq
  /hf_[0-9A-Za-z]{16,}/g, // Hugging Face
  /sk-[0-9A-Za-z_-]{16,}/g, // OpenAI/OpenRouter e parecidos
  /[MNO][A-Za-z0-9_-]{23,25}\.[A-Za-z0-9_-]{6}\.[A-Za-z0-9_-]{27,}/g, // token de bot do Discord
  /Bearer\s+[A-Za-z0-9._~+/=-]{12,}/gi,
  /([?&](?:key|token|api_key|apikey|access_token)=)[^&\s"']+/gi,
];

/** Troca segredos por ••••. Cobre o que está no ambiente agora e formatos conhecidos. */
export function redact(text, env = process.env) {
  let out = String(text ?? '');
  const values = new Set();
  for (const [name, value] of Object.entries(env)) {
    if (!SENSITIVE_NAME.test(name)) continue;
    for (const part of String(value ?? '').split(',')) {
      const v = part.trim().replace(/^["']|["']$/g, '');
      if (v.length >= 12) values.add(v);
    }
  }
  for (const v of [...values].sort((a, b) => b.length - a.length)) out = out.split(v).join('••••');
  for (const re of KNOWN_FORMATS) out = out.replace(re, (m, g1) => (g1 ? `${g1}••••` : '••••'));
  return out;
}

export function listLogFiles(dir) {
  let names = [];
  try {
    names = fs.readdirSync(dir);
  } catch {
    return [];
  }
  return names
    .map((name) => {
      const m = name.match(FILE_RE);
      if (!m) return null;
      let size = 0;
      try { size = fs.statSync(path.join(dir, name)).size; } catch { /* some */ }
      return { name, kind: m[1], date: m[2], size };
    })
    .filter(Boolean)
    .sort((a, b) => b.date.localeCompare(a.date) || a.kind.localeCompare(b.kind))
    .slice(0, 60);
}

function tail(file, bytes) {
  const fd = fs.openSync(file, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const chunk = Math.min(size, bytes);
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, size - chunk);
    let text = buf.toString('utf8');
    // Se cortou no meio do arquivo, descarta a primeira linha (pode estar incompleta).
    if (size > chunk) text = text.slice(text.indexOf('\n') + 1);
    return { text, truncatedStart: size > chunk };
  } finally {
    fs.closeSync(fd);
  }
}

/** Agrupa linhas em entradas: linhas sem [data] [nível] (stack trace) continuam a anterior. */
export function parseEntries(text) {
  const entries = [];
  for (const raw of text.replace(ANSI_RE, '').split(/\r?\n/)) {
    if (!raw) continue;
    const m = raw.match(ENTRY_RE);
    if (m) entries.push({ time: m[1], level: m[2], text: m[3] });
    else if (entries.length) entries[entries.length - 1].text += `\n${raw}`;
  }
  return entries;
}

/**
 * @param {{dir: string, kind?: string, date?: string, level?: string, q?: string, limit?: number, env?: object}} opts
 */
export function readLogs({ dir, kind = 'app', date = null, level = null, q = '', limit = 150, env = process.env } = {}) {
  if (!KINDS.includes(kind)) return { error: 'Tipo inválido. Use app ou error.' };
  if (date && !DATE_RE.test(date)) return { error: 'Data inválida (use AAAA-MM-DD).' };
  if (level && !LEVELS.includes(level)) return { error: `Nível inválido. Use: ${LEVELS.join(', ')}.` };

  const files = listLogFiles(dir);
  const pick = files.find((f) => f.kind === kind && (!date || f.date === date));
  const n = Math.min(MAX_LINES, Math.max(10, parseInt(limit, 10) || 150));
  const needle = String(q ?? '').trim().slice(0, 100).toLowerCase();
  if (!pick) return { files, file: null, entries: [], truncated: false };

  let t;
  try {
    t = tail(path.join(dir, pick.name), TAIL_BYTES);
  } catch {
    return { files, file: pick.name, entries: [], truncated: false };
  }
  let entries = parseEntries(t.text);
  if (level) entries = entries.filter((e) => e.level === level);
  if (needle) entries = entries.filter((e) => e.text.toLowerCase().includes(needle));
  const cut = entries.length > n;
  entries = entries.slice(-n).reverse(); // mais recentes primeiro
  return {
    files,
    file: pick.name,
    entries: entries.map((e) => ({ time: e.time, level: e.level, text: redact(e.text, env).slice(0, 4000) })),
    truncated: cut || t.truncatedStart,
  };
}
