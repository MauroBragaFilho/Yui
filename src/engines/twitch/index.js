import { twitchRepository } from '../../database/repositories/twitchRepo.js';
import { getStreamStatus } from '../../handlers/twitchApiHandler.js';
import { logger } from '../../utils/logger.js';

let isCheckingTwitch = false;

export const twitchEngine = {
  /**
   * Checa todos os streamers cadastrados e detecta transições offline → live.
   *
   * @returns {Promise<Array<{
   *   type: 'live_started',
   *   login: string,
   *   title: string,
   *   gameName: string,
   *   thumbnailUrl: string,
   *   startedAt: string,
   *   url: string,
   *   viewerCount: number,
   * }>>}
   */
  async checkTwitchStreamers() {
    if (isCheckingTwitch) {
      logger.warn('[TwitchEngine] ⏳ Ciclo de checagem já em andamento. Ignorando chamada concorrente.');
      return [];
    }

    isCheckingTwitch = true;
    const events = [];

    try {
      const subscriptions = twitchRepository.getAllSubscriptions();
      if (subscriptions.length === 0) {
        return [];
      }

      const logins = twitchRepository.getAllTrackedLogins();
      if (logins.length === 0) {
        return [];
      }

      logger.info(`[TwitchEngine] Checando ${logins.length} streamer(s)...`);

      let resultsMap;
      try {
        resultsMap = await getStreamStatus(logins);
      } catch (err) {
        logger.error(`[TwitchEngine] Erro na Helix API: ${err.message}`);
        return [];
      }

      for (const login of logins) {
        const current = resultsMap.get(login.toLowerCase()) || null;
        const saved = twitchRepository.getStreamState(login.toLowerCase());

        if (current) {
          const streamId = current.streamId;
          const wasLive = saved ? saved.is_live === 1 : false;
          const sameStream = saved && saved.last_stream_id === streamId;

          if (!wasLive || !sameStream) {
            // ACABOU DE FICAR ONLINE (ou reiniciou a live com nova stream_id)
            twitchRepository.upsertStreamState(login.toLowerCase(), true, streamId);
            events.push(buildLiveEvent(current));
            logger.info(`[TwitchEngine] 🔴 ${current.login} entrou ao vivo: ${current.title}`);
          }
          // Já estava ao vivo, mesma stream -> ignora
        } else if (saved && saved.is_live === 1) {
          // Ficou offline — só atualiza estado, sem publicar nada
          twitchRepository.upsertStreamState(login.toLowerCase(), false, null);
          logger.info(`[TwitchEngine] ${login} ficou offline.`);
        }
      }

      logger.info(`[TwitchEngine] Checagem concluída: ${events.length} stream(s) novo(s) ao vivo.`);
      return events;
    } catch (err) {
      logger.error(`[TwitchEngine] Erro no ciclo de checagem: ${err.message}`);
      return [];
    } finally {
      isCheckingTwitch = false;
    }
  },
};

/**
 * Monta o objeto de evento "live_started" normalizado que o publisher entende.
 */
function buildLiveEvent(stream) {
  return {
    type: 'live_started',
    login: stream.login,
    title: stream.title || 'Live sem título',
    gameName: stream.gameName || 'Indeterminado',
    thumbnailUrl: stream.thumbnailUrl || '',
    startedAt: stream.startedAt || null,
    url: `https://twitch.tv/${stream.login}`,
    viewerCount: stream.viewerCount || 0,
    language: stream.language || '',
  };
}

export default twitchEngine;