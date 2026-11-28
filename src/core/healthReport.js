import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { interactionSeries } from './interactionStats.js';
import * as database from '../database/db.js';
import { getReminderStore, isRemindersRemote } from '../reminders/assistant.js';
import { diagnosticoDosLimites } from './ai/limitesTokens.js';
import { fusoDoDono } from './fuso.js';
import { pastaDoDisco } from './limitesDoComputador.js';

/**
 * Relatório diário de saúde da Yui para o dono (uma mensagem por dia, 08:00 no fuso do dono, YUI_FUSO; padrão Brasília).
 * Só lê números que já existem (memória, disco, uptime, logs, contador de respostas, log do atualizador, estatísticas
 * dos bancos): nada de conteúdo de conversa, nada de SQL.
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

/** Religadas feitas pelo supervisor nas últimas 24 h: { count, last } ou null se não há log (supervisor não instalado). */
export function readSupervisorStats({ file, now = Date.now(), readFile = fs.readFileSync } = {}) {
  if (!file) return null;
  let text;
  try { text = String(readFile(file, 'utf8')); } catch { return null; }
  let count = 0; let last = null;
  for (const line of text.split(/\r?\n/)) {
    const m = /^(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}) RELIGADA: (.*)$/.exec(line);
    if (!m) continue;
    const at = new Date(`${m[1]}T${m[2]}`).getTime();
    if (Number.isNaN(at) || now - at > DAY) continue;
    count += 1; last = m[3].slice(0, 80);
  }
  return { count, last };
}

export function formatUptime(seconds) {
  const s = Math.max(0, Math.floor(Number(seconds) || 0));
  const d = Math.floor(s / 86400); const h = Math.floor((s % 86400) / 3600); const m = Math.floor((s % 3600) / 60);
  return d ? `${d}d ${h}h` : h ? `${h}h ${m}min` : `${m}min`;
}

// ── Bancos (critério E): motor, tamanhos, checkpoint do WAL, bloqueios, erros, falhas de abertura e gravações lentas ──
const MB = 1024 * 1024;
const WAL_BIG_BYTES = 64 * MB;
const WAL_PAGE_BYTES = 4096; // página padrão do SQLite: wal_autocheckpoint vem em páginas
const SLOW_AVG_WRITE_MS = 50;
const SLOW_MAX_WRITE_MS = 1000;
const SLOW_AVG_READ_MS = 50;
const MAX_DB_LINE = 300; // a linha dos bancos não pode tomar o aviso inteiro (limite de ~500 caracteres)

/** Bytes em texto curto, com vírgula decimal: '512 B', '820 KB', '2,3 MB', '1,2 GB'. */
export function formatBytes(bytes) {
  const b = Math.max(0, Math.round(Number(bytes) || 0));
  const one = (n) => (Math.round(n * 10) / 10).toFixed(1).replace(/\.0$/, '').replace('.', ',');
  if (b < 1024) return `${b} B`;
  if (b < MB) return `${Math.round(b / 1024)} KB`;
  if (b < 1024 * MB) return `${one(b / MB)} MB`;
  return `${one(b / 1024 / MB)} GB`;
}

const num = (v) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const plural = (n, one, many) => `${n} ${n === 1 ? one : many}`;
/** Uma linha só, sem caracteres de controle, até `max` caracteres. */
const oneLine = (text, max) => String(text ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max).trim();
/** Mensagem de erro do banco para o relatório: trechos entre aspas simples (valores de SQL, podem ser dado de usuário) viram '…'. */
const errorText = (message) => oneLine(String(message ?? '').replace(/'[^']*(?:'|$)/g, "'…'"), 120);

/** O que merece atenção num banco (lista de textos curtos; vazia = nada). */
function databaseAlerts(b) {
  const out = [];
  const wal = num(b.sizes?.wal);
  const autoCheckpoint = num(b.walAutocheckpoint);
  const stuck = autoCheckpoint > 0 && wal > autoCheckpoint * WAL_PAGE_BYTES * 4;
  if (wal > WAL_BIG_BYTES || stuck) out.push(`-wal ${formatBytes(wal)}${stuck ? ', checkpoint parado' : ''}`);
  if (num(b.busy) > 0) out.push(plural(num(b.busy), 'bloqueio', 'bloqueios'));
  const last = b.lastError ? [oneLine(b.lastError.code, 40), errorText(b.lastError.message)].filter(Boolean).join(': ') : '';
  const detail = last ? ` (${last})` : '';
  if (num(b.errors) > 0) out.push(`${plural(num(b.errors), 'erro', 'erros')}${detail}`);
  if (num(b.openFailures) > 0) out.push(`${plural(num(b.openFailures), 'falha', 'falhas')} ao abrir ou recuperar${num(b.errors) > 0 ? '' : detail}`);
  // Trava de dono (cérebro e bot separados): perdida = o banco foi fechado sem gravar; as recusas de dono já contam acima.
  if (num(b.ownerLost) > 0 || b.ownerLock?.held === false) out.push('trava de dono perdida (banco fechado)');
  const avgWrite = num(b.avgWriteMs); const maxWrite = num(b.maxWriteMs);
  if (avgWrite > SLOW_AVG_WRITE_MS || maxWrite > SLOW_MAX_WRITE_MS) out.push(`gravação lenta (média ${Math.round(avgWrite)} ms, máx. ${Math.round(maxWrite)} ms)`);
  if (num(b.avgReadMs) > SLOW_AVG_READ_MS) out.push(`consulta lenta (média ${Math.round(num(b.avgReadMs))} ms)`);
  return out;
}

/**
 * Resumo de databaseStats() para o relatório: { line, alertNames } ou null (sem bancos abertos).
 * Normal: 'Bancos: 10 (9 sql.js, 1 nativo), 2,3 MB, sem alertas'. Com alerta, os bancos que merecem atenção (até 3).
 */
export function summarizeDatabases(list) {
  if (!Array.isArray(list)) return null;
  const banks = list.filter((b) => b && typeof b === 'object');
  if (!banks.length) return null;
  const engines = new Map([['sql.js', 0], ['nativo', 0]]);
  let total = 0;
  const alerts = [];
  for (const b of banks) {
    // engine null = o banco não está aberto (falhou ao abrir: db.js o mantém na lista por causa do openFailures)
    const engine = b.engine === 'native' ? 'nativo' : b.engine === 'sqljs' ? 'sql.js' : b.engine == null ? 'não abriu' : oneLine(b.engine, 20);
    engines.set(engine, (engines.get(engine) || 0) + 1);
    total += num(b.sizes?.db) + num(b.sizes?.wal) + num(b.sizes?.shm);
    const found = databaseAlerts(b);
    if (found.length) alerts.push({ name: oneLine(b.name || '?', 30), text: found.join(', ') });
  }
  const engineText = [...engines].filter(([, n]) => n > 0).map(([e, n]) => (e === 'nativo' ? plural(n, 'nativo', 'nativos') : `${n} ${e}`)).join(', ');
  const head = `Bancos: ${banks.length} (${engineText}), ${formatBytes(total)}`;
  if (!alerts.length) return { line: `${head}, sem alertas`, alertNames: [] };
  const shown = alerts.slice(0, 3).map((a) => `${a.name}: ${a.text}`);
  if (alerts.length > 3) shown.push(`mais ${alerts.length - 3} com alerta`);
  const line = `${head}. ${shown.join('; ')}`;
  return { line: line.length > MAX_DB_LINE ? `${line.slice(0, MAX_DB_LINE - 1)}…` : line, alertNames: alerts.map((a) => a.name) };
}

/** Junta os números do relatório. Tudo injetável para teste. */
export function collectHealth({
  now = Date.now(), osImpl = os, fsImpl = fs, cwd = process.cwd(), logDir = path.resolve('logs'),
  uptimeSeconds = process.uptime(), rssBytes = process.memoryUsage().rss, interactions = interactionSeries, updateLog = process.env.YUI_UPDATE_LOG || (process.platform === 'win32' ? 'C:\\Tools\\atualizar-yui.log' : ''),
  backupLog = process.env.YUI_BACKUP_LOG || (process.platform === 'win32' ? 'C:/Tools/backup/backup.log' : ''),
  supervisorLog = process.env.YUI_SUPERVISOR_LOG || (process.platform === 'win32' ? 'C:/Tools/supervisor/supervisor.log' : ''),
  discordOnline = null, readFile, statFile, dbStats = database.databaseStats, lembretes = entregaDosLembretes,
  configuracao = diagnosticoDosLimites,
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
    supervisor: readSupervisorStats({ file: supervisorLog, now, readFile }),
    databases: null,
    lembretesIncertos: null,
    // Erros de configuração dos limites de tokens (ex.: AI_MAX_TOKENS inválido): o padrão que vale no lugar não esconde o erro (Liz, §12).
    configuracao: [],
  };
  try { data.ramTotalGB = gb(osImpl.totalmem()); data.ramFreeGB = gb(osImpl.freemem()); } catch { /* sem leitura */ }
  // o mesmo disco que o alerta por DM e o Início medem (a pasta dos dados; core/limitesDoComputador.js, Fase 1 do painel)
  try { const st = fsImpl.statfsSync(pastaDoDisco(process.env, { fsImpl, cwd: () => cwd })); data.diskTotalGB = gb(st.blocks * st.bsize); data.diskFreeGB = gb(st.bavail * st.bsize); } catch { /* sem leitura */ }
  try { data.replies24h = interactions(now).total; } catch { /* sem contador */ }
  try {
    if (typeof dbStats === 'function') {
      const list = dbStats();
      if (Array.isArray(list)) data.databases = list;
    }
  } catch { /* sem estatísticas dos bancos: o relatório segue sem a seção */ }
  try { data.lembretesIncertos = typeof lembretes === 'function' ? lembretes() : null; } catch { /* sem lembretes: segue sem a linha */ }
  try { const c = typeof configuracao === 'function' ? configuracao() : []; data.configuracao = Array.isArray(c) ? c : []; } catch { /* sem diagnóstico */ }
  return data;
}

/**
 * Números dos lembretes com a entrega INCERTA (só existem com o cérebro separado: cerebro/entregaLembretes.js). Lido só no
 * processo dono do lembretes.json: o bot com o cérebro separado não abre o arquivo.
 */
export function entregaDosLembretes() {
  if (isRemindersRemote()) return null;
  return getReminderStore().list().filter((r) => r?.entrega?.estado === 'incerto').map((r) => r.id);
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
  let db = null;
  try { db = summarizeDatabases(d.databases); } catch { db = null; /* dado estranho dos bancos não derruba o relatório */ }
  if (db?.alertNames.length) {
    const names = db.alertNames.slice(0, 3).join(', ') + (db.alertNames.length > 3 ? ` e mais ${db.alertNames.length - 3}` : '');
    issues.push(db.alertNames.length === 1 ? `alerta no banco ${names}` : `alerta nos bancos ${names}`);
  }
  if (d.reconnects >= 5) issues.push(`${d.reconnects} reconexões`);
  if (d.errors >= 20) issues.push(`${d.errors} erros no log`);
  if (d.lastUpdate && !d.lastUpdate.ok) issues.push('a última atualização falhou');
  if (d.lastBackup && !d.lastBackup.ok) issues.push('o último backup falhou');
  else if (d.lastBackup?.at && d.now - d.lastBackup.at > 36 * 3600 * 1000) issues.push('o backup fora do notebook está atrasado (mais de 36 h)');
  if (d.supervisor?.count > 0) issues.push(`o supervisor religou a Yui ${d.supervisor.count}x (${d.supervisor.last})`);
  if (d.uptimeSeconds < 6 * 3600) issues.push(`reiniciou há ${formatUptime(d.uptimeSeconds)}`);
  const incertos = Array.isArray(d.lembretesIncertos) ? d.lembretesIncertos : [];
  if (incertos.length) issues.push(`${incertos.length} lembrete(s) com entrega incerta (${incertos.slice(0, 5).map((id) => `#${id}`).join(', ')})`);
  const config = Array.isArray(d.configuracao) ? d.configuracao.filter((c) => c && c.variavel) : [];
  if (config.length) issues.push(`configuração inválida no .env (${config.slice(0, 3).map((c) => c.variavel).join(', ')})`);

  const tags = Object.entries(d.byTag || {}).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([t, n]) => `${t} ${n}`).join(', ');
  const lines = [
    issues.length ? `Atenção: ${issues.join('; ')}.` : 'Tudo certo por aqui.',
    incertos.length ? `Lembretes com entrega incerta: ${incertos.slice(0, 5).map((id) => `#${id}`).join(', ')} (diga “reenvia o lembrete N” ou “descarta o lembrete N”)` : null,
    config.length ? `Configuração: ${config.slice(0, 3).map((c) => `${c.variavel} ${c.problema} (valendo ${c.usando})`).join('; ')}` : null,
    `Ligada há ${formatUptime(d.uptimeSeconds)} (Yui usa ${d.processMB} MB)`,
    d.ramFreeGB != null ? `RAM livre ${d.ramFreeGB} de ${d.ramTotalGB} GB${ramPct !== null ? ` (${ramPct}%)` : ''}` : null,
    d.diskFreeGB != null ? `Disco livre ${d.diskFreeGB} de ${d.diskTotalGB} GB${diskPct !== null ? ` (${diskPct}%)` : ''}` : null,
    db ? db.line : null,
    d.replies24h != null ? `Respostas da IA (24 h): ${d.replies24h}` : null,
    `Reconexões do Discord (24 h): ${d.reconnects}`,
    `Erros no log (24 h): ${d.errors}${tags ? ` (${tags})` : ''}`,
    d.lastUpdate ? `Atualizador: ${d.lastUpdate.text}` : null,
    d.lastBackup ? `Backup fora do notebook: ${d.lastBackup.text}` : null,
    d.supervisor ? `Religadas pelo supervisor (24 h): ${d.supervisor.count}` : null,
  ].filter(Boolean);
  // Cabe no aviso: linhas inteiras, na ordem; a que não cabe fica de fora (a primeira sempre vai, cortada se preciso).
  let body = lines[0].slice(0, 480);
  for (const line of lines.slice(1)) if (body.length + 1 + line.length <= 480) body += `\n${line}`;
  return { level: issues.length ? 'warn' : 'info', title: 'Relatório diário de saúde', body, issues };
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
  return { cron: `0 ${hour} * * *`, timezone: fusoDoDono(env), hour };
}
