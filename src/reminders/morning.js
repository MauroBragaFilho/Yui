/**
 * Relatório matinal: UMA mensagem privada por dia para o dono (08:00 de Brasília por padrão) que junta
 *   - os lembretes de hoje (e quantos há amanhã),
 *   - as pendências (itens ainda abertos nas listas pessoais),
 *   - a saúde da Yui (memória, disco, erros, atualizador, backup, religadas do watchdog).
 * Só lê o que já existe; não consulta agenda nem e-mail (ainda não estão ligados). Também sai sob pedido ("resumo do dia").
 *
 * YUI_MORNING_REPORT=false desliga (volta ao relatório de saúde sozinho); YUI_MORNING_REPORT_HOUR muda a hora (0 a 23).
 * Se a Yui estava fora do ar às 08:00, o relatório sai assim que ela volta (até o meio-dia), uma vez por dia.
 */
import fs from 'node:fs';
import path from 'node:path';

const MAX_LIST_LINES = 4;
const MAX_REMINDER_LINES = 8;

const pad = (n) => String(n).padStart(2, '0');

export function dateTitle(now) {
  const txt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long' }).format(now);
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

function sameDay(a, b) { return a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate(); }

/**
 * Texto do relatório. Tudo entra por parâmetro (puro):
 *  reminders: [{ id, text, at, repeat }]    lists: [{ name, open, items?: string[] }]    healthLines: string[]    healthIssues: string[]
 */
export function buildMorningReport({ now = new Date(), reminders = [], lists = [], healthLines = [], healthIssues = [] } = {}) {
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1);
  const today = reminders.filter((r) => sameDay(new Date(r.at), now)).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const late = reminders.filter((r) => Date.parse(r.at) < new Date(now).setHours(0, 0, 0, 0)); // ficaram para trás (ex.: a DM falhou)
  const nextDay = reminders.filter((r) => sameDay(new Date(r.at), tomorrow));
  const out = [`☀️ **Bom dia!** ${dateTitle(now)}.`];

  out.push('', '**📌 Hoje**');
  if (today.length === 0 && late.length === 0) out.push('Nenhum lembrete para hoje.');
  for (const r of late.slice(0, 3)) out.push(`• (atrasado) ${r.text}`);
  for (const r of today.slice(0, MAX_REMINDER_LINES)) {
    const d = new Date(r.at);
    out.push(`• ${pad(d.getHours())}:${pad(d.getMinutes())} — ${r.text}${r.repeat ? ` 🔁` : ''}`);
  }
  if (today.length > MAX_REMINDER_LINES) out.push(`… e mais ${today.length - MAX_REMINDER_LINES}.`);
  if (nextDay.length) out.push(`-# Amanhã: ${nextDay.length} lembrete(s).`);

  const open = lists.filter((l) => l.open > 0);
  if (open.length) {
    out.push('', '**📝 Pendências**');
    for (const l of open.slice(0, MAX_LIST_LINES)) {
      const sample = (l.items || []).slice(0, 3).join('; ');
      out.push(`• ${l.name}: ${l.open} aberto(s)${sample ? ` (${sample}${l.open > 3 ? '…' : ''})` : ''}`);
    }
    if (open.length > MAX_LIST_LINES) out.push(`… e mais ${open.length - MAX_LIST_LINES} lista(s).`);
  }

  if (healthLines.length) {
    out.push('', `**🩺 Saúde da Yui**${healthIssues.length ? ' ⚠️' : ''}`);
    out.push(...healthLines.map((l) => (healthIssues.length && l === healthLines[0] ? `**${l}**` : l)));
  }
  out.push('', '-# Para marcar um lembrete: “me lembra amanhã às 9h de pagar a conta”. Para ver tudo: “meus lembretes”.');
  return out.join('\n');
}

/** Junta os dados reais (lembretes, listas do dono, saúde) e monta o texto. Tudo injetável para teste. */
export async function composeMorningReport({ now = new Date(), reminderStore, listStore = null, ownerId = null, health = null } = {}) {
  const reminders = reminderStore ? reminderStore.list() : [];
  let lists = [];
  if (listStore && ownerId) {
    try {
      const all = await listStore.listLists(ownerId);
      for (const l of all.slice(0, 20)) {
        const got = await listStore.getList(ownerId, l.name);
        const items = (got?.items || []).filter((i) => !i.done);
        if (items.length) lists.push({ name: l.name, open: items.length, items: items.map((i) => i.text) });
      }
    } catch { lists = []; } // listas ilegíveis não derrubam o relatório
  }
  let healthLines = []; let healthIssues = [];
  if (health) {
    try {
      const r = health();
      healthIssues = r.issues || [];
      healthLines = String(r.body || '').split(String.fromCharCode(10)).filter(Boolean);
    } catch { /* sem saúde: o relatório sai sem essa parte */ }
  }
  return buildMorningReport({ now, reminders, lists, healthLines, healthIssues });
}

// ── Uma vez por dia, também depois de uma queda ──

export function morningSchedule(env = process.env) {
  if (String(env.YUI_MORNING_REPORT ?? 'true').toLowerCase() === 'false') return null;
  const h = Number(env.YUI_MORNING_REPORT_HOUR ?? env.YUI_HEALTH_REPORT_HOUR);
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
  return { cron: `0 ${hour} * * *`, timezone: 'America/Sao_Paulo', hour };
}

export function defaultMorningStateFile(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'relatorio-matinal.json');
}

const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export function readLastMorning(file = defaultMorningStateFile()) {
  try { return String(JSON.parse(fs.readFileSync(file, 'utf8')).lastDate || ''); } catch { return ''; }
}

export function markMorningSent(now = new Date(), file = defaultMorningStateFile()) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, JSON.stringify({ lastDate: dayKey(now) }), 'utf8');
  } catch { /* sem arquivo: pode repetir uma vez depois de um reinício, sem dano */ }
}

/** Já passou a hora do relatório, ainda é de manhã (até 12h) e hoje ainda não saiu? (depois de uma queda ou reinício) */
export function shouldCatchUp(now = new Date(), schedule = morningSchedule(), lastDate = readLastMorning()) {
  if (!schedule) return false;
  const h = now.getHours();
  return h >= schedule.hour && h < 12 && lastDate !== dayKey(now);
}

/** Monta e manda o relatório ao dono. `send` devolve true se saiu; só então marca o dia como enviado. */
export async function sendMorningReport({ send, compose, now = new Date(), stateFile } = {}) {
  const text = await compose(now);
  const ok = (await send(text)) === true;
  if (ok) markMorningSent(now, stateFile);
  return { ok, text };
}

