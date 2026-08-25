import cron from 'node-cron';
import { newswireEngine } from '../engines/newswire/index.js';
import { gtaoEngine } from '../engines/gtao/index.js';
import { discordPublisher } from '../discord/publisher.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export function startScheduler(client) {
  logger.info('[Scheduler] Inicializando agendador central de tarefas em UTC...');

  // 1. Verificação periódica do Rockstar Newswire (Default: a cada 30 minutos)
  const newswireCronExpr = `*/${config.newswire.intervalMinutes} * * * *`;
  cron.schedule(newswireCronExpr, async () => {
    try {
      logger.info('[Scheduler] Disparando checagem agendada do Newswire...');
      const newArticles = await newswireEngine.checkLatestNews();
      if (newArticles.length > 0) {
        await discordPublisher.publishNews(client, newArticles);
      }
    } catch (err) {
      logger.error(`[Scheduler] Erro na tarefa do Newswire: ${err.message}`);
    }
  });
  logger.info(`[Scheduler] Agendamento do Newswire configurado para rodar a cada ${config.newswire.intervalMinutes} minutos.`);

  // 2. Reset Diário do GTA Online às 06:00 UTC pontualmente
  // Cron: '0 6 * * *' com timezone UTC
  cron.schedule('0 6 * * *', async () => {
    try {
      logger.info('[Scheduler] ⏰ Disparando tarefa do Reset Diário do GTA Online (06:00 UTC)...');
      const dailyData = await gtaoEngine.collectDaily();
      if (dailyData) {
        await discordPublisher.publishDaily(client, dailyData);
      }
    } catch (err) {
      logger.error(`[Scheduler] Erro na tarefa de Reset Diário: ${err.message}`);
    }
  }, {
    timezone: 'UTC',
  });
  logger.info('[Scheduler] Reset Diário do GTA Online agendado para 06:00 UTC.');

  // 3. Verificação de Atualização Semanal (Todas as quintas-feiras a cada hora entre 09:00 e 15:00 UTC)
  cron.schedule('0 9-15 * * 4', async () => {
    try {
      logger.info('[Scheduler] Disparando checagem semanal de quinta-feira...');
      const weeklyData = await gtaoEngine.collectWeekly();
      if (weeklyData) {
        const d = new Date();
        const year = d.getUTCFullYear();
        const onejan = new Date(year, 0, 1);
        const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
        const weekKey = `${year}-W${String(week).padStart(2, '0')}`;

        await discordPublisher.publishWeekly(client, weeklyData, weekKey);
      }
    } catch (err) {
      logger.error(`[Scheduler] Erro na tarefa Semanal: ${err.message}`);
    }
  }, {
    timezone: 'UTC',
  });
  logger.info('[Scheduler] Monitoramento semanal de eventos (quintas-feiras) ativo.');
}
