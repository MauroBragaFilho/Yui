import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { getLatestChannelItems, getVideoDetails, classifyYoutubeItem, resolveChannel } from '../../handlers/youtubeApiHandler.js';
import { logger } from '../../utils/logger.js';

let isCheckingYoutube = false;

export const youtubeEngine = {
  /**
   * Checa todos os canais cadastrados, detecta itens novos e transições de
   * estado de lives, e retorna uma lista de eventos a publicar.
   *
   * @returns {Promise<Array<{
   *   type: 'video'|'short'|'live_scheduled'|'live_started'|'live_ended'|'vod',
   *   videoId: string,
   *   channelId: string,
   *   channelName: string,
   *   title: string,
   *   url: string,
   *   thumbnailUrl: string,
   *   publishedAt: string,
   * }>>}
   */
  async checkYoutubeChannels() {
    if (isCheckingYoutube) {
      logger.warn('[YoutubeEngine] ⏳ Ciclo de checagem já em andamento. Ignorando chamada concorrente.');
      return [];
    }

    isCheckingYoutube = true;
    const events = [];

    try {
      const subscriptions = youtubeRepository.getAllSubscriptions();
      if (subscriptions.length === 0) {
        return [];
      }

      // Canais únicos monitorados (com uploads_playlist_id resolvida no cadastro)
      const channelsById = new Map();
      for (const tracked of youtubeRepository.getAllTrackedChannels()) {
        channelsById.set(tracked.youtube_channel_id, {
          channelName: tracked.channel_name,
          uploadsPlaylistId: tracked.uploads_playlist_id,
        });
      }

      const playlistCache = new Map(); // channelId -> uploadsPlaylistId (fallback dinâmico)

      for (const [channelId, meta] of channelsById) {
        logger.info(`[YoutubeEngine] Checando canal ${meta.channelName || channelId}...`);

        let uploadsPlaylistId = meta.uploadsPlaylistId;
        if (!uploadsPlaylistId) {
          if (playlistCache.has(channelId)) {
            uploadsPlaylistId = playlistCache.get(channelId);
          } else {
            const resolved = await resolveChannel(channelId);
            uploadsPlaylistId = resolved?.uploadsPlaylistId || null;
            playlistCache.set(channelId, uploadsPlaylistId);
          }
        }

        if (!uploadsPlaylistId) {
          logger.warn(`[YoutubeEngine] Sem uploadsPlaylistId para o canal ${channelId}. Pulando.`);
          continue;
        }

        let items;
        try {
          items = await getLatestChannelItems(uploadsPlaylistId, 5);
        } catch (err) {
          logger.error(`[YoutubeEngine] Erro na API para canal ${channelId}: ${err.message}`);
          continue;
        }

        if (!items || items.length === 0) continue;

        for (const item of items) {
          const seen = youtubeRepository.getSeenItem(item.videoId);
          const details = await getVideoDetails(item.videoId);
          const newState = classifyYoutubeItem(details);
          const eventType = mapStateToEventType(newState);

          if (!seen) {
            // Primeira vez vendo esse item. Anuncia vídeo/short sempre;
            // live apenas se upcoming ou já ao vivo.
            if (eventType) {
              events.push(buildEvent(eventType, item, details, channelId, meta.channelName));
            }
            youtubeRepository.upsertSeenItem(item.videoId, channelId, newState);
          } else if (seen.last_known_state !== newState) {
            // Transição de estado — exemplo: upcoming -> live, live -> ended_vod
            const transitionType = mapTransitionToEventType(seen.last_known_state, newState);
            if (transitionType) {
              events.push(buildEvent(transitionType, item, details, channelId, meta.channelName));
            }
            youtubeRepository.upsertSeenItem(item.videoId, channelId, newState);
          }
          // Estado igual -> nada muda
        }
      }

      logger.info(`[YoutubeEngine] Checagem concluída: ${events.length} evento(s) para publicar.`);
      return events;
    } catch (err) {
      logger.error(`[YoutubeEngine] Erro no ciclo de checagem: ${err.message}`);
      return [];
    } finally {
      isCheckingYoutube = false;
    }
  },
};
/**
 * Mapeia o estado classificado para o tipo de evento publicável.
 */
function mapStateToEventType(state) {
  switch (state) {
    case 'video': return 'video';
    case 'short': return 'short';
    case 'upcoming': return 'live_scheduled';
    case 'live': return 'live_started';
    case 'ended_vod': return null; // VOD antigo não anunciado como novidade
    default: return null;
  }
}

/**
 * Mapeia uma transição de estado para o tipo de evento publicável.
 */
function mapTransitionToEventType(prevState, newState) {
  if (newState === 'live' && (prevState === 'upcoming' || prevState === 'video')) {
    return 'live_started';
  }
  if (newState === 'ended_vod' && (prevState === 'live' || prevState === 'upcoming')) {
    return 'live_ended';
  }
  if (prevState === 'ended_vod' && newState === 'video') {
    return 'vod'; // Repostagem/edição do VOD como vídeo comum
  }
  return null;
}

/**
 * Monta o objeto de evento normalizado que o publisher entende.
 */
function buildEvent(type, item, details, channelId, channelName) {
  const videoId = item.videoId;
  const title = details?.snippet?.title || item.title;
  const channelTitle = details?.snippet?.channelTitle || channelName || 'Canal desconhecido';
  const publishedAt = details?.snippet?.publishedAt || item.publishedAt;

  let url;
  if (type === 'short') {
    url = `https://youtube.com/shorts/${videoId}`;
  } else {
    url = `https://youtu.be/${videoId}`;
  }

  // Melhor thumbnail disponível (maxres > high > medium > default)
  const thumbs = details?.snippet?.thumbnails || item.thumbnails || {};
  const thumbnailUrl =
    thumbs.maxres?.url ||
    thumbs.high?.url ||
    thumbs.medium?.url ||
    thumbs.default?.url ||
    `https://img.youtube.com/vi/${videoId}/hqdefault.jpg`;

  return {
    type,
    videoId,
    channelId,
    channelName: channelTitle,
    title,
    url,
    thumbnailUrl,
    publishedAt,
  };
}

export default youtubeEngine;