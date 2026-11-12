/**
 * Entrega dos lembretes: a cada minuto o agendador chama runDueReminders, que avisa o dono por DM de tudo que já chegou na hora.
 *
 * - Se a Yui ficou fora do ar, o lembrete sai atrasado e diz isso ("era para as 09:00"). O que repete avisa UMA vez e vai para a
 *   próxima ocorrência (não manda uma rajada de avisos perdidos).
 * - Se a DM falhar (Discord fora), o lembrete fica e é tentado de novo no minuto seguinte; nunca se perde.
 * - O texto do lembrete NÃO vai para a auditoria (só o número e o resultado).
 */
import { describeRepeat } from './when.js';

const pad = (n) => String(n).padStart(2, '0');
const LATE_MS = 5 * 60 * 1000;
const GIVE_UP_TRIES = 60; // 1 tentativa por minuto

/** Texto da DM. `at` é o horário que estava marcado; `now`, o instante do envio. */
export function formatReminderMessage(r, now = Date.now()) {
  const at = new Date(r.at);
  const late = now - at.getTime();
  const lines = [`⏰ **Lembrete #${r.id}**`, r.text];
  if (r.from) lines.push(`-# Pedido por ${r.from}.`);
  if (late > LATE_MS) {
    const mins = Math.round(late / 60000);
    const quando = mins >= 1440 ? `${Math.round(mins / 1440)} dia(s) atrás` : mins >= 60 ? `${Math.floor(mins / 60)} h ${mins % 60} min atrás` : `${mins} min atrás`;
    lines.push(`-# Era para as ${pad(at.getHours())}:${pad(at.getMinutes())} (${quando}); a Yui estava fora do ar ou sem conexão.`);
  }
  if (r.repeat) lines.push(`-# Repete: ${describeRepeat(r.repeat)}. Para parar: "cancela o lembrete ${r.id}".`);
  else lines.push(`-# Para adiar: "adia o lembrete ${r.id} por 30 minutos".`);
  return lines.join('\n');
}

/**
 * @param {object} p
 * @param {object} p.store   createReminderStore()
 * @param {(text:string, reminder:object)=>Promise<boolean|void>} p.send   manda a DM (ao dono, ou a quem criou o lembrete: r.userId); false ou erro = não saiu
 * @param {number} [p.now]
 * @param {(event:string, ctx:null, data:object)=>void} [p.audit]
 * @returns {Promise<{ fired: number, failed: number }>}
 */
export async function runDueReminders({ store, send, now = Date.now(), audit = () => {} }) {
  let fired = 0;
  let failed = 0;
  for (const r of store.due(now)) {
    let ok = false;
    try { ok = (await send(formatReminderMessage(r, now), r)) !== false; } catch { ok = false; }
    if (ok) {
      store.complete(r.id, now);
      fired += 1;
      try { audit('reminder.fire', null, { id: r.id, repeat: Boolean(r.repeat) }); } catch { /* auditoria não derruba a entrega */ }
    } else {
      store.recordFailure(r.id);
      failed += 1;
      // Lembrete de outra pessoa que não sai há ~1 h (DM fechada, bloqueou a Yui): desiste, para não tentar para sempre.
      if (r.userId && (r.tries || 0) + 1 >= GIVE_UP_TRIES) {
        store.remove(r.id);
        try { audit('reminder.drop', null, { id: r.id }); } catch { /* ok */ }
      }
    }
  }
  return { fired, failed };
}
