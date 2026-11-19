import { audit } from '../audit.js';
import { POLICY_STATES, ROLES } from '../permissions.js';
import { getPolicyEngine } from './policyEngine.js';
import { ORIGINS } from './permissionMatrix.js';

/**
 * Guarda das TAREFAS AUTOMÁTICAS do processo da Yui (agendador, lembretes, relatórios, limpezas, manutenção).
 * Elas não têm um usuário: rodam como o próprio sistema, na máquina da Yui (origem LOCAL_PC, papel dono).
 *  - YUI_POLICY_MODE=observe (padrão): só registra (no máximo 1 vez por hora por tarefa) e a tarefa roda.
 *  - YUI_POLICY_MODE=enforce: a tarefa só roda se o motor decidir AUTO. As que alteram o computador
 *    (manutenção: atualizar yt-dlp, baixar binários, atualizar dados em src/data) viram DENY com YUI_READ_ONLY=true.
 * Tarefas fora da tabela rodam como antes (a tabela é a lista do que existe hoje).
 */

export const JOBS = Object.freeze({
  'scheduler.newswire': 'job.publish',
  'scheduler.daily': 'job.publish',
  'scheduler.weekly_newswire': 'job.publish',
  'scheduler.weekly': 'job.publish',
  'scheduler.youtube': 'job.publish',
  'scheduler.twitch': 'job.publish',
  'scheduler.memory_purge': 'job.data_cleanup',
  'reminders.tick': 'job.notify',
  'reminders.morning': 'job.notify',
  'reminders.health': 'job.notify',
  'alerts.send': 'job.notify',
  'monitores.tick': 'job.notify', // etapa 16 (proatividade): a passada dos monitores de busca do dono
  'eventos.tick': 'job.notify', // etapa 16 (proatividade): a conferência dos alertas por evento (disco, memória, internet, supervisor)
  'cleanup.context': 'job.cleanup_files',
  'cleanup.radio_temp': 'job.cleanup_files',
  'maintenance.ytdlp_update': 'job.maintenance',
  'maintenance.data_refresh': 'job.maintenance',
  'maintenance.binaries_download': 'job.maintenance',
  'maintenance.gtacars_update': 'job.maintenance',
});

const SYSTEM_CTX = Object.freeze({ platform: 'system', userId: 'system', role: ROLES.OWNER, channelKind: 'private', guildId: null, channelId: null });
const THROTTLE_MS = 60 * 60 * 1000;
const lastLogged = new Map();

/** A tarefa pode rodar agora? (nunca lança erro) */
export function jobAllowed(name, { engine = getPolicyEngine(), auditFn = audit, now = Date.now } = {}) {
  try {
    const action = Object.hasOwn(JOBS, name) ? JOBS[name] : null;
    if (!action) return true;
    const due = now() - (lastLogged.get(name) ?? 0) >= THROTTLE_MS;
    if (engine.mode() === 'enforce') {
      const verdict = engine.evaluate({ action, role: SYSTEM_CTX.role, origin: ORIGINS.LOCAL_PC });
      const allowed = verdict.decision === POLICY_STATES.AUTO;
      if (!allowed || due) {
        lastLogged.set(name, now());
        engine.gate({ action, ctx: SYSTEM_CTX, origin: ORIGINS.LOCAL_PC, legacy: 'allow', target: name });
        if (!allowed) { try { auditFn('policy.job_skipped', SYSTEM_CTX, { job: name, action, decision: verdict.decision, reason: verdict.reason }); } catch { /* */ } }
      }
      return allowed;
    }
    if (due) { lastLogged.set(name, now()); engine.gate({ action, ctx: SYSTEM_CTX, origin: ORIGINS.LOCAL_PC, legacy: 'allow', target: name }); }
    return true;
  } catch {
    return true; // o guarda nunca derruba uma tarefa
  }
}

/** Envolve a função da tarefa: só roda se o motor permitir. */
export function guardedJob(name, fn, options) {
  return (...args) => (jobAllowed(name, options) ? fn(...args) : undefined);
}

export function resetJobGuardForTests() {
  lastLogged.clear();
}
