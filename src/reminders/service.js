/**
 * Liga os lembretes e o relatório matinal ao agendador da Yui:
 *   - a cada minuto: avisa o dono (DM) dos lembretes que chegaram na hora;
 *   - todo dia (08:00 de Brasília por padrão): relatório matinal, e se a Yui estava fora do ar nessa hora, assim que voltar (até 12h);
 *   - com YUI_MORNING_REPORT=false, só o relatório de saúde de antes (YUI_HEALTH_REPORT).
 */
import { sendOwnerMessage } from '../core/alerts.js';
import { audit } from '../core/audit.js';
import { ownerUserId } from '../core/api/auth.js';
import { buildHealthReport, collectHealth, sendHealthReport, healthReportSchedule } from '../core/healthReport.js';
import { createListStore } from '../handlers/listStore.js';
import { getReminderStore } from './assistant.js';
import { runDueReminders } from './runner.js';
import { composeMorningReport, morningSchedule, sendMorningReport, shouldCatchUp } from './morning.js';

let lists = null;
const listStore = () => (lists ??= createListStore());

/** Função que monta o relatório do dia (usada pelo agendador e pelo "resumo do dia" no chat/painel). */
export function createMorningComposer({ client = null, env = process.env } = {}) {
  return (now = new Date()) => composeMorningReport({
    now,
    reminderStore: getReminderStore(),
    listStore: listStore(),
    ownerId: ownerUserId(env),
    health: () => buildHealthReport(collectHealth({ discordOnline: client?.isReady?.() ?? null })),
  });
}

export function startReminderService({ cron, client = null, logger, env = process.env } = {}) {
  // 1) lembretes: a cada minuto
  let busy = false;
  cron.schedule('* * * * *', async () => {
    if (busy) return;
    busy = true;
    try {
      const r = await runDueReminders({ store: getReminderStore(), send: sendOwnerMessage, audit });
      if (r.fired || r.failed) logger.info(`[Lembretes] ${r.fired} aviso(s) enviado(s)${r.failed ? `, ${r.failed} adiado(s) para o próximo minuto (DM não saiu)` : ''}.`);
    } catch (err) {
      logger.warn(`[Lembretes] Falha na passada: ${err.message}`);
    } finally { busy = false; }
  });
  logger.info('[Scheduler] Lembretes: conferência a cada minuto.');

  // 2) relatório matinal (ou só o de saúde, se o matinal estiver desligado)
  const morning = morningSchedule(env);
  if (morning) {
    const compose = createMorningComposer({ client, env });
    const run = () => sendMorningReport({ send: sendOwnerMessage, compose })
      .then((r) => { if (!r.ok) logger.warn('[Matinal] A DM do relatório não saiu (Discord fora?).'); })
      .catch((err) => logger.warn(`[Matinal] Falha: ${err.message}`));
    cron.schedule(morning.cron, run, { timezone: morning.timezone });
    // depois de uma queda ou reinício de manhã, manda assim que der (uma vez por dia)
    setTimeout(() => { if (shouldCatchUp(new Date(), morning)) run(); }, 3 * 60 * 1000);
    logger.info(`[Scheduler] Relatório matinal às ${String(morning.hour).padStart(2, '0')}:00 (${morning.timezone}).`);
  } else {
    const health = healthReportSchedule(env);
    if (health) {
      cron.schedule(health.cron, () => {
        sendHealthReport({ client }).catch((err) => logger.warn(`[Scheduler] Relatório de saúde falhou: ${err.message}`));
      }, { timezone: health.timezone });
      logger.info(`[Scheduler] Relatório diário de saúde às ${String(health.hour).padStart(2, '0')}:00 (${health.timezone}).`);
    }
  }
}
