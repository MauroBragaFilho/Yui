/**
 * Retorna a chave da semana atual no formato "AAAA-Www" (ex: "2026-W36"),
 * usada como identificador único de cache em `weekly_events.event_week`.
 * Mesma lógica já usada em `gtaoEngine.collectWeekly()` e `scheduler.js`,
 * centralizada aqui para evitar duplicidade e garantir que todo lugar do
 * código concorde sobre "qual semana é essa".
 */
/** Quantas horas faz que a linha do banco foi gravada (created_at do SQLite, em UTC: "AAAA-MM-DD HH:MM:SS"). Infinity se ilegível. */
export function weeklyRowAgeHours(row, now = Date.now()) {
  const raw = String(row?.created_at ?? '').trim();
  if (!raw) return Infinity;
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(raw) ? raw : `${raw.replace(' ', 'T')}Z`);
  return Number.isFinite(t) ? Math.max(0, (now - t) / 3_600_000) : Infinity;
}

/** O semanal do Newswire guardado vale por poucas horas: a Rockstar publica o artigo novo na quinta e a semana do banco vai de segunda a domingo. */
export const NEWSWIRE_CACHE_HOURS = 6;

export function getCurrentWeekKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const onejan = new Date(year, 0, 1);
  const week = Math.ceil((((date - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
