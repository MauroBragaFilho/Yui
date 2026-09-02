import cron from 'node-cron';
import { newswireEngine } from '../engines/newswire/index.js';
import { gtaoEngine } from '../engines/gtao/index.js';
import { youtubeEngine } from '../engines/youtube/index.js';
import { twitchEngine } from '../engines/twitch/index.js';
import { discordPublisher } from '../discord/publisher.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

export function startScheduler(client) {
  logger.info('[Scheduler] Inicializando agendador central de tarefas em UTC...');

  // 1. Verificação suave inicial do Newswire (Catch-up com delay de 2 minutos após o bot subir)
  setTimeout(async () => {
    try {
      logger.info('[Scheduler] ⏳ Executando primeira checagem de sincronização do Newswire (delay inicial)...');
      const unpostedNews = await newswireEngine.checkLatestNews();
      if (unpostedNews.length > 0) {
        logger.info(`[Scheduler] Publicando ${unpostedNews.length} notícia(s) acumulada(s)...`);
        await discordPublisher.publishNews(client, unpostedNews);
      }
    } catch (err) {
      logger.warn(`[Scheduler] Falha na sincronização inicial do Newswire: ${err.message}`);
    }
  }, 2 * 60 * 1000);

  // 2. Verificação periódica do Rockstar Newswire (Default: a cada 30 minutos)
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

  // 3. Reset Diário do GTA Online às 06:00 UTC pontualmente
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

  // 4. Verificação de Atualização Semanal (Todas as quintas-feiras a cada hora entre 09:00 e 15:00 UTC)
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

  // 5. Verificação periódica do YouTube (Default: a cada 5 minutos)
  if (config.youtube.intervalMinutes > 0) {
    const youtubeCronExpr = `*/${config.youtube.intervalMinutes} * * * *`;
    cron.schedule(youtubeCronExpr, async () => {
      try {
        logger.info('[Scheduler] Disparando checagem agendada do YouTube...');
        const events = await youtubeEngine.checkYoutubeChannels();
        if (events.length > 0) {
          logger.info(`[Scheduler] Publicando ${events.length} evento(s) do YouTube...`);
          for (const event of events) {
            await discordPublisher.publishYoutubeEvent(client, event);
          }
        }
      } catch (err) {
        logger.error(`[Scheduler] Erro na tarefa do YouTube: ${err.message}`);
      }
    });
    logger.info(`[Scheduler] Monitoramento do YouTube configurado para rodar a cada ${config.youtube.intervalMinutes} minutos.`);
  } else {
    logger.warn('[Scheduler] YouTube monitoramento desativado (YOUTUBE_INTERVAL_MINUTES = 0).');
  }

  // 6. Verificação periódica da Twitch (Default: a cada 2 minutos)
  if (config.twitch.intervalMinutes > 0) {
    const twitchCronExpr = `*/${config.twitch.intervalMinutes} * * * *`;
    cron.schedule(twitchCronExpr, async () => {
      try {
        logger.info('[Scheduler] Disparando checagem agendada da Twitch...');
        const events = await twitchEngine.checkTwitchStreamers();
        if (events.length > 0) {
          logger.info(`[Scheduler] Publicando ${events.length} evento(s) da Twitch...`);
          for (const event of events) {
            await discordPublisher.publishTwitchEvent(client, event);
          }
        }
      } catch (err) {
        logger.error(`[Scheduler] Erro na tarefa da Twitch: ${err.message}`);
      }
    });
    logger.info(`[Scheduler] Monitoramento da Twitch configurado para rodar a cada ${config.twitch.intervalMinutes} minutos.`);
  } else {
    logger.warn('[Scheduler] Twitch monitoramento desativado (TWITCH_INTERVAL_MINUTES = 0).');
  }
}

export default { startScheduler };
