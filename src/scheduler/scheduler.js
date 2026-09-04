import cron from 'node-cron';
import { newswireEngine } from '../engines/newswire/index.js';
import { gtaoEngine } from '../engines/gtao/index.js';
import { youtubeEngine } from '../engines/youtube/index.js';
import { twitchEngine } from '../engines/twitch/index.js';
import { discordPublisher } from '../discord/publisher.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { getCurrentWeekKey } from '../utils/weekKey.js';
import { weeklyService } from '../engines/gtao/systems/weekly/service.js';

export function startScheduler(client) {
  logger.info('[Scheduler] Inicializando agendador central de tarefas em UTC...');

  // 1-2. Newswire automático (notícias + checagem periódica)
  //      Desativado por padrão (NEWSWIRE_ENABLED=false). Ative no .env se
  //      quiser que o bot publique notícias do Newswire automaticamente.
  if (config.newswire.enabled) {
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
  } else {
    logger.info('[Scheduler] Newswire automático desativado (NEWSWIRE_ENABLED=false). Disponível via /gta-semanal fonte:newswire.');
  }

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

  // 4. Verificação de Atualização Semanal via Newswire (quarta e quinta, a cada hora entre 09:00 e 20:00 UTC)
  //    DESATIVADO por padrão. O Reddit (task 4.5) é a fonte primária agora.
  //    Ative com NEWSWIRE_ENABLED=true se quiser manter o Newswire como fallback automático.
  if (config.newswire.enabled) {
    cron.schedule('0 9-20 * * 3,4', async () => {
      try {
        logger.info('[Scheduler] Disparando checagem semanal via Newswire (quarta/quinta)...');
        const weeklyData = await gtaoEngine.collectWeekly({ source: 'newswire' });
        if (weeklyData) {
          const weekKey = getCurrentWeekKey();
          await discordPublisher.publishWeekly(client, weeklyData, weekKey);
        }
      } catch (err) {
        logger.error(`[Scheduler] Erro na tarefa Semanal (Newswire): ${err.message}`);
      }
    }, {
      timezone: 'UTC',
    });
    logger.info('[Scheduler] Monitoramento semanal via Newswire (quartas e quintas) ativo.');
  } else {
    logger.info('[Scheduler] Newswire semanal desativado. Fonte primária: Reddit (task 4.5).');
  }

  // 4.5 Weekly do r/gtaonline (fonte Reddit) — polling configurável.
  //     Usa o scheduler central (node-cron) existente; NÃO cria um sistema
  //     paralelo de timers. Uma flag evita execuções simultâneas do mesmo
  //     ciclo (rate limit / processos duplicados).
  let weeklyRunning = false;
  const runWeeklyCheck = async () => {
    if (weeklyRunning) {
      logger.info('[Weekly] Ciclo anterior ainda em execução; ignorando novo ciclo.');
      return;
    }
    weeklyRunning = true;
    try {
      logger.info('[Weekly] Consultando Reddit (ciclo agendado)...');
      const result = await weeklyService.checkForUpdates({
        onNew: async (weekly) => {
          await discordPublisher.publishWeeklyReddit(client, weekly);
        },
      });
      if (result.status === 'published') {
        logger.info(`[Weekly] Weekly novo publicado (${result.id}).`);
      }
    } catch (err) {
      logger.error(`[Weekly] Falha no ciclo: ${err.message}`);
    } finally {
      weeklyRunning = false;
    }
  };

  if (config.weekly.enabled && config.weekly.intervalMinutes > 0) {
    // Sincronização inicial com delay, para não competir com o Newswire no boot.
    setTimeout(() => {
      runWeeklyCheck().catch(() => null);
    }, 3 * 60 * 1000);

    const weeklyCronExpr = `*/${config.weekly.intervalMinutes} * * * *`;
    cron.schedule(weeklyCronExpr, runWeeklyCheck);
    logger.info(
      `[Scheduler] Weekly Reddit configurado para rodar a cada ${config.weekly.intervalMinutes} minutos.`
    );
  } else {
    logger.warn(
      `[Scheduler] Weekly Reddit desativado (GTA_WEEKLY_ENABLED=false ou GTA_WEEKLY_INTERVAL_MINUTES=0).`
    );
  }



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
