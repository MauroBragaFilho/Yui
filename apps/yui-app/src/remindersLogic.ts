/**
 * Regras da tela "Lembretes", sem React e sem rede (testáveis em Node): separar o que é de hoje do que vem depois,
 * atalhos de "quando" e o texto do que está por vir. Nada aqui inventa dado.
 */

export interface ReminderLike { id: number; text: string; at: string; repeat: unknown | null }

export interface Groups<T extends ReminderLike> { overdue: T[]; today: T[]; upcoming: T[] }

const startOfDay = (d: Date) => { const x = new Date(d); x.setHours(0, 0, 0, 0); return x; };

/** Atrasados (a hora já passou e ainda estão na lista, por exemplo se a DM não saiu), hoje e os próximos, cada grupo por horário. */
export function groupReminders<T extends ReminderLike>(list: T[], now: Date = new Date()): Groups<T> {
  const sod = startOfDay(now).getTime();
  const eod = sod + 86_400_000;
  const sorted = [...list].sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id - b.id);
  const out: Groups<T> = { overdue: [], today: [], upcoming: [] };
  for (const r of sorted) {
    const t = Date.parse(r.at);
    if (Number.isNaN(t)) continue;
    if (t < now.getTime()) out.overdue.push(r);
    else if (t < eod) out.today.push(r);
    else out.upcoming.push(r);
  }
  return out;
}

export interface QuickWhen { label: string; when: string }

/** Atalhos que preenchem o campo "quando" (o servidor interpreta o texto, então tudo aqui é português normal). */
export const QUICK_WHEN: QuickWhen[] = [
  { label: 'Em 30 min', when: 'em 30 minutos' },
  { label: 'Em 1 hora', when: 'em 1 hora' },
  { label: 'Hoje 18h', when: 'hoje às 18h' },
  { label: 'Amanhã 9h', when: 'amanhã às 9h' },
  { label: 'Todo dia 8h', when: 'todo dia às 8h' },
];

/** Resumo para o cartão do Início: "2 hoje, 1 depois" / "Nenhum lembrete". */
export function summarizeReminders(list: ReminderLike[], now: Date = new Date()): string {
  const g = groupReminders(list, now);
  const parts: string[] = [];
  if (g.overdue.length) parts.push(`${g.overdue.length} atrasado(s)`);
  if (g.today.length) parts.push(`${g.today.length} hoje`);
  if (g.upcoming.length) parts.push(`${g.upcoming.length} depois`);
  return parts.length ? parts.join(', ') : 'Nenhum lembrete';
}

/** O texto digitado é bom para criar? Devolve o motivo do erro ou null. */
export function reminderInputProblem(text: string, when: string): string | null {
  if (!text.trim()) return 'Escreva do que devo te lembrar.';
  if (text.trim().length > 300) return 'O texto do lembrete é longo demais (300 caracteres).';
  if (!when.trim()) return 'Diga quando: por exemplo "amanhã às 9h" ou "em 2 horas".';
  return null;
}
