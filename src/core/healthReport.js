import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { interactionSeries } from './interactionStats.js';

/**
 * Relatório diário de saúde da Yui para o dono (uma mensagem por dia, 08:00 de Brasília por padrão).
 * Só lê números que já existem (memória, disco, uptime, logs, contador de respostas, log do atualizador): nada de conteúdo de conversa.
 *
 * YUI_HEALTH_REPORT=false desliga; YUI_HEALTH_REPORT_HOUR muda a hora (0 a 23, padrão 8); YUI_UPDATE_LOG aponta o log do atualizador.
 */

const DAY = 24 * 60 * 60 * 1000;
const MAX_LOG_BYTES = 2 * 1024 * 1024;

/** '[2026-11-11 04:06:47] [error] ...' -> { ts (ms, hora local), level, tag } ou null. */
export function parseLogLine(line) {
  const m = /^\[(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})\] \[(?:\x1b\[\d+m)?(\w+?)(?:\x1b\[\d+m)?\] ?(.*)$/.exec(String(line));
  if (!m) return null;
  const ts = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), Number(m[4]), Number(m[5]), Number(m[6])).getTime();
  const tag = /^\[([^\]]{1,24})\]/.exec(m[8]);
  return { ts, level: m[7], tag: tag ? tag[1] : 'geral', text: m[8] };
}

function readTail(file, readFile = fs.readFileSync, statFile = fs.statSync) {
  try {
    const size = statFile(file).size;
    if (size <= MAX_LOG_BYTES) return String(readFile(file, 'utf8'));
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(MAX_LOG_BYTES);
      fs.readSync(fd, buf, 0, MAX_LOG_BYTES, size - MAX_LOG_BYTES);
      return buf.toString('utf8');
    } finally { fs.closeSync(fd); }
  } catch {
    return '';
  }
}

const pad = (n) => String(n).padStart(2, '0');
const dayName = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

/** Conta, nas últimas 24 h dos logs, os erros (por etiqueta) e as reconexões do Discord. */
export function readLogStats({ logDir, now = Date.now(), readFile, statFile } = {}) {
  const out = { errors: 0, byTag: {}, reconnects: 0 };
  const days = [new Date(now - DAY), new Date(now)].map(dayName);
  for (const day of [...new Set(days)]) {
    for (const kind of ['app', 'error']) {
      const text = readTail(path.join(logDir, `${kind}-${day}.log`), readFile, statFile);
      if (!text) continue;
      for (const raw of text.split('\n')) {
        const e = parseLogLine(raw.replace(/\r$/, ''));
        if (!e || now - e.ts > DAY || e.ts > now + 60_000) continue;
        if (kind === 'error' && e.level === 'error') {
          out.errors += 1;
          out.byTag[e.tag] = (out.byTag[e.tag] || 0) + 1;
        }
        if (kind === 'app' && /Conexão retomada|Conex.o retomada/.test(e.text)) out.reconnects += 1;
      }
    }
  }
  return out;
}

/** Última conclusão registrada no log do atualizador: { ok, text } ou null. */
export function readLastUpdate({ file, readFile = fs.readFileSync } = {}) {
  if (!file) return null;
  let text;
  try { text = String(readFile(file, 'utf8')); } catch { return null; }
  const lines = text.split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}):\d{2} (OK: .*|ERRO: .*|FALHA: .*|Rollback .*|Sem novidades.*)$/.exec(lines[i]);
    if (m) {
      const [, d, hm, what] = m;
      const at = new Date(`${d}T${hm}:00`).getTime();
      return { ok: /^(OK|Sem novidades)/.test(what), at: Number.isNaN(at) ? null : at, text: `${what.slice(0, 70)} (${d.slice(8, 10)}/${d.slice(5, 7)} ${hm})` };
    }
  }
  return null;
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}

/** Junta os números do relatório. Tudo injetável para teste. */
export function collectHealth({
  now = Date.now(), osImpl = os, fsImpl = fs, cwd = process.cwd(), logDir = path.resolve('logs'),
  uptimeSeconds = process.uptime(), rssBytes = process.memoryUsage().rss, interactions = interactionSeries, updateLog = process.env.YUI_UPDATE_LOG || (process.platform === 'win32' ? 'C:\\Tools\\atualizar-yui.log' : ''),
  backupLog = process.env.YUI_BACKUP_LOG || (process.platform === 'win32' ? 'C:/Tools/backup/backup.log' : ''),
  discordOnline = null, readFile, statFile,
} = {}) {
  const gb = (b) => Math.round((b / 1024 / 1024 / 1024) * 10) / 10;
  const data = {
    now, uptimeSeconds, discordOnline,
    processMB: Math.round(rssBytes / 1024 / 1024),
    ramTotalGB: null, ramFreeGB: null, diskTotalGB: null, diskFreeGB: null,
    ...readLogStats({ logDir, now, readFile, statFile }),
    replies24h: null,
    lastUpdate: readLastUpdate({ file: updateLog, readFile }),
    lastBackup: readLastUpdate({ file: backupLog, readFile }),
  };
  try { data.ramTotalGB = gb(osImpl.totalmem()); data.ramFreeGB = gb(osImpl.freemem()); } catch { /* sem leitura */ }
  try { const st = fsImpl.statfsSync(cwd); data.diskTotalGB = gb(st.blocks * st.bsize); data.diskFreeGB = gb(st.bavail * st.bsize); } catch { /* sem leitura */ }
  try { data.replies24h = interactions(now).total; } catch { /* sem contador */ }
  return data;
}

const pct = (free, total) => (free != null && total ? Math.round((free / total) * 100) : null);

/** Texto do relatório (até ~500 caracteres, o limite do aviso) e o nível: 'info' se está tudo bem, 'warn' se há o que olhar. */
export function buildHealthReport(d) {
  const ramPct = pct(d.ramFreeGB, d.ramTotalGB);
  const diskPct = pct(d.diskFreeGB, d.diskTotalGB);
  const issues = [];
  if (d.discordOnline === false) issues.push('Discord desconectado');
  if (ramPct !== null && ramPct < 10) issues.push('pouca RAM livre');
  if (diskPct !== null && diskPct < 15) issues.push('pouco disco livre');
  if (d.reconnects >= 5) issues.push(`${d.reconnects} reconexões`);
  if (d.errors >= 20) issues.push(`${d.errors} erros no log`);
  if (d.lastUpdate && !d.lastUpdate.ok) issues.push('a última atualização falhou');
  if (d.lastBackup && !d.lastBackup.ok) issues.push('o último backup falhou');
  else if (d.lastBackup?.at && d.now - d.lastBackup.at > 36 * 3600 * 1000) issues.push('o backup fora do notebook está atrasado (mais de 36 h)');
  if (d.uptimeSeconds < 6 * 3600) issues.push(`reiniciou há ${formatUptime(d.uptimeSeconds)}`);

  const tags = Object.entries(d.byTag || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t} ${n}`).join(', ');
  const lines = [
    issues.length ? `Atenção: ${issues.join('; ')}.` : 'Tudo certo por aqui.',
    `Ligada há ${formatUptime(d.uptimeSeconds)} (Yui usa ${d.processMB} MB)`,
    d.ramFreeGB != null ? `RAM livre ${d.ramFreeGB} de ${d.ramTotalGB} GB${ramPct !== null ? ` (${ramPct}%)` : ''}` : null,
    d.diskFreeGB != null ? `Disco livre ${d.diskFreeGB} de ${d.diskTotalGB} GB${diskPct !== null ? ` (${diskPct}%)` : ''}` : null,
    d.replies24h != null ? `Respostas da IA (24 h): ${d.replies24h}` : null,
    `Reconexões do Discord (24 h): ${d.reconnects}`,
    `Erros no log (24 h): ${d.errors}${tags ? ` (${tags})` : ''}`,
    d.lastUpdate ? `Atualizador: ${d.lastUpdate.text}` : null,
    d.lastBackup ? `Backup fora do notebook: ${d.lastBackup.text}` : null,
  ].filter(Boolean);
  return { level: issues.length ? 'warn' : 'info', title: 'Relatório diário de saúde', body: lines.join('\n').slice(0, 480), issues };
}

/** Monta e envia o relatório ao dono (um por dia; o cooldown evita repetir se o agendador disparar duas vezes). */
export async function sendHealthReport({ alert, collect = collectHealth, client = null } = {}) {
  const data = collect({ discordOnline: client?.isReady?.() ?? null });
  const report = buildHealthReport(data);
  const send = alert ?? (await import('./alerts.js')).alertOwner;
  send('health-daily', report.title, report.body, { level: report.level, cooldownMinutes: 600 });
  return report;
}

export function healthReportSchedule(env = process.env) {
  if (String(env.YUI_HEALTH_REPORT ?? 'true').toLowerCase() === 'false') return null;
  const h = Number(env.YUI_HEALTH_REPORT_HOUR);
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
  return { cron: `0 ${hour} * * *`, timezone: 'America/Sao_Paulo', hour };
}
