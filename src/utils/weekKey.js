/**
 * Retorna a chave da semana atual no formato "AAAA-Www" (ex: "2026-W36"),
 * usada como identificador único de cache em `weekly_events.event_week`.
 * Mesma lógica já usada em `gtaoEngine.collectWeekly()` e `scheduler.js`,
 * centralizada aqui para evitar duplicidade e garantir que todo lugar do
 * código concorde sobre "qual semana é essa".
 */
export function getCurrentWeekKey(date = new Date()) {
  const year = date.getUTCFullYear();
  const onejan = new Date(year, 0, 1);
  const week = Math.ceil((((date - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}
