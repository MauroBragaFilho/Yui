/**
 * Relatório matinal: UMA mensagem privada por dia para o dono (08:00 no fuso do dono, YUI_FUSO; padrão Brasília) que junta
 *   - os lembretes de hoje (e quantos há amanhã),
 *   - as pendências (itens ainda abertos nas listas pessoais),
 *   - a saúde da Yui (memória, disco, erros, atualizador, backup, religadas do watchdog).
 * Só lê o que já existe; com YUI_GOOGLE=true e conectado, o relatório por DM ganha a seção "Agenda e tarefas de hoje" (Google, somente leitura; nunca e-mail).
 * Também sai sob pedido ("resumo do dia"), mas essa versão (que pode aparecer num canal) nunca leva a agenda do Google.
 *
 * YUI_MORNING_REPORT=false desliga (volta ao relatório de saúde sozinho); YUI_MORNING_REPORT_HOUR muda a hora (0 a 23, no fuso do dono).
 * Se a Yui estava fora do ar às 08:00, o relatório sai assim que ela volta (até o meio-dia), uma vez por dia.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fusoDoDono, partesNoFuso, chaveDoDia, somarDias, inicioDoDia } from '../core/fuso.js';

const MAX_LIST_LINES = 4;
const MAX_REMINDER_LINES = 8;

const pad = (n) => String(n).padStart(2, '0');

export function dateTitle(now, fuso = fusoDoDono()) {
  const txt = new Intl.DateTimeFormat('pt-BR', { weekday: 'long', day: 'numeric', month: 'long', timeZone: fuso }).format(now);
  return txt.charAt(0).toUpperCase() + txt.slice(1);
}

/** Saudação pela hora do dono (YUI_FUSO): 5h–11h59 Bom dia, 12h–17h59 Boa tarde, resto Boa noite (o horário do relatório pode mudar). */
export function greeting(now = new Date(), fuso = fusoDoDono()) {
  const h = partesNoFuso(now, fuso).hora;
  if (h >= 5 && h < 12) return { text: 'Bom dia', icon: '☀️' };
  if (h >= 12 && h < 18) return { text: 'Boa tarde', icon: '🌤️' };
  return { text: 'Boa noite', icon: '🌙' };
}

/** HH:MM de um instante no relógio do dono. */
const clock = (d, fuso) => { const p = partesNoFuso(d, fuso); return `${pad(p.hora)}:${pad(p.minuto)}`; };

/**
 * Texto do relatório. Tudo entra por parâmetro (puro):
 *  reminders: [{ id, text, at, repeat }]    lists: [{ name, open, items?: string[] }]    healthLines: string[]    healthIssues: string[]
 */
export function buildMorningReport({ now = new Date(), reminders = [], lists = [], healthLines = [], healthIssues = [], googleLines = [] } = {}) {
  const fuso = fusoDoDono();
  const hoje = partesNoFuso(now, fuso);
  const amanha = somarDias(hoje, 1);
  const keyOf = (t) => chaveDoDia(t, fuso);
  const todayKey = keyOf(now); const tomorrowKey = `${amanha.ano}-${pad(amanha.mes)}-${pad(amanha.dia)}`;
  const today = reminders.filter((r) => keyOf(new Date(r.at)) === todayKey).sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  const late = reminders.filter((r) => Date.parse(r.at) < inicioDoDia(hoje.ano, hoje.mes, hoje.dia, fuso).getTime()); // ficaram para trás (ex.: a DM falhou)
  const nextDay = reminders.filter((r) => keyOf(new Date(r.at)) === tomorrowKey);
  const out = [`${greeting(now, fuso).icon} **${greeting(now, fuso).text}!** ${dateTitle(now, fuso)}.`];

  out.push('', '**📌 Hoje**');
  if (today.length === 0 && late.length === 0) out.push('Nenhum lembrete para hoje.');
  for (const r of late.slice(0, 3)) out.push(`• (atrasado) ${r.text}`);
  for (const r of today.slice(0, MAX_REMINDER_LINES)) {
    out.push(`• ${clock(new Date(r.at), fuso)} — ${r.text}${r.repeat ? ` 🔁` : ''}`);
  }
  if (today.length > MAX_REMINDER_LINES) out.push(`… e mais ${today.length - MAX_REMINDER_LINES}.`);
  if (nextDay.length) out.push(`-# Amanhã: ${nextDay.length} lembrete(s).`);

  // Agenda e tarefas do Google (etapa 15, só com YUI_GOOGLE=true e conectado): sem as linhas o relatório é idêntico ao de sempre.
  if (googleLines.length) out.push('', '**📅 Agenda e tarefas de hoje**', ...googleLines);

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
export async function composeMorningReport({ now = new Date(), reminderStore, listStore = null, ownerId = null, health = null, google = null } = {}) {
  const reminders = reminderStore ? reminderStore.list().filter((r) => !r.userId) : []; // só os do dono (os de outras pessoas vão por DM para elas)
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
  // `google`: as linhas da agenda e tarefas de hoje (só o dono, só no relatório por DM; null = sem o Google). Falha = sem a seção.
  let googleLines = [];
  if (typeof google === 'function') {
    try { const got = await google(now); googleLines = Array.isArray(got) ? got : []; } catch { googleLines = []; }
  }
  return buildMorningReport({ now, reminders, lists, healthLines, healthIssues, googleLines });
}

// ── Uma vez por dia, também depois de uma queda ──

export function morningSchedule(env = process.env) {
  if (String(env.YUI_MORNING_REPORT ?? 'true').toLowerCase() === 'false') return null;
  const h = Number(env.YUI_MORNING_REPORT_HOUR ?? env.YUI_HEALTH_REPORT_HOUR);
  const hour = Number.isInteger(h) && h >= 0 && h <= 23 ? h : 8;
  return { cron: `0 ${hour} * * *`, timezone: fusoDoDono(env), hour };
}

export function defaultMorningStateFile(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'relatorio-matinal.json');
}

const dayKey = (d, fuso = fusoDoDono()) => chaveDoDia(d, fuso);

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
  const fuso = schedule.timezone || fusoDoDono();
  const h = partesNoFuso(now, fuso).hora;
  return h >= schedule.hour && h < 12 && lastDate !== dayKey(now, fuso);
}

/** Monta e manda o relatório ao dono. `send` devolve true se saiu; só então marca o dia como enviado. */
export async function sendMorningReport({ send, compose, now = new Date(), stateFile } = {}) {
  const text = await compose(now, { dm: true }); // `dm`: este texto vai por mensagem privada ao dono (só nele entra a agenda do Google)
  const ok = (await send(text)) === true;
  if (ok) markMorningSent(now, stateFile);
  return { ok, text };
}

