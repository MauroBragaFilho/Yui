import { config } from '../../config/index.js';
import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { getLatestChannelItems, classifyYoutubeItem, resolveChannel } from '../../handlers/youtubeApiHandler.js';
import { logger } from '../../utils/logger.js';

let isCheckingYoutube = false;

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';
// videos.list aceita até 50 IDs por chamada e custa 1 unidade de cota por CHAMADA (não por vídeo).
const VIDEOS_BATCH_SIZE = 50;
// Itens já vistos como 'video'/'ended_vod' continuam sendo reconferidos por este tempo, para não perder
// transições raras (vídeo que vira live, VOD reeditado como vídeo). Depois disso são considerados estáveis.
const RECHECK_WINDOW_MS = 48 * 60 * 60 * 1000;
// Quando a cota diária acaba, para de insistir por este tempo (cada tentativa só gera erro no log).
const QUOTA_BACKOFF_MS = 15 * 60 * 1000;

/**
 * Busca os detalhes de vários vídeos de uma vez (`id=a,b,c`), em lotes de até 50.
 * Lança em caso de erro da API; `err.quotaExceeded` indica cota diária esgotada.
 *
 * @param {string[]} videoIds
 * @param {{ apiKey?: string, fetchImpl?: typeof fetch }} [options]
 * @returns {Promise<Map<string, object>>} videoId -> detalhes (IDs inexistentes/privados ficam de fora)
 */
export async function fetchVideoDetailsBatch(videoIds, { apiKey = config.youtube.apiKey, fetchImpl = fetch } = {}) {
  const result = new Map();
  const ids = [...new Set((videoIds || []).filter(Boolean))];
  if (!apiKey || ids.length === 0) return result;

  for (let i = 0; i < ids.length; i += VIDEOS_BATCH_SIZE) {
    const chunk = ids.slice(i, i + VIDEOS_BATCH_SIZE);
    const params = new URLSearchParams({
      part: 'snippet,contentDetails,liveStreamingDetails',
      id: chunk.join(','),
      // Sem maxResults: a documentação do videos.list diz que ele NÃO é aceito junto com `id`
      // (a API pode responder 400), e já voltam inteiros até 50 vídeos por chamada.
      key: apiKey,
    });
    const response = await fetchImpl(`${YOUTUBE_API_BASE}/videos?${params}`);
    if (!response.ok) {
      const body = await response.text();
      const err = new Error(`YouTube API videos error ${response.status}: ${String(body).slice(0, 300)}`);
      err.status = response.status;
      err.quotaExceeded = response.status === 403 && /quotaExceeded|dailyLimitExceeded/i.test(String(body));
      throw err;
    }
    const data = await response.json();
    for (const item of data.items || []) {
      if (item?.id) result.set(item.id, item);
    }
  }
  return result;
}

/** O erro é de cota diária esgotada? (vale tanto para o nosso lote quanto para o handler antigo) */
function isQuotaError(err) {
  return Boolean(err?.quotaExceeded) || /quotaExceeded|dailyLimitExceeded/i.test(String(err?.message || ''));
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC, formato do SQLite CURRENT_TIMESTAMP) -> ms; null se não der para ler. */
function parseSqlTimestamp(value) {
  if (!value) return null;
  const ms = Date.parse(String(value).replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(String(value)) ? '' : 'Z'));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Este item precisa de detalhes da API neste ciclo?
 *  - nunca visto: sim (precisa classificar e decidir se anuncia);
 *  - visto como 'upcoming'/'live': sim (pode mudar de estado: virar live, terminar);
 *  - visto como 'short': não (nenhuma transição gera evento);
 *  - visto como 'video'/'ended_vod': só dentro da janela de reconferência.
 */
export function needsDetails(seen, nowMs = Date.now()) {
  if (!seen) return true;
  const state = seen.last_known_state;
  if (state === 'upcoming' || state === 'live') return true;
  if (state === 'short') return false;
  const firstSeen = parseSqlTimestamp(seen.first_seen_at);
  if (firstSeen === null) return true;
  return nowMs - firstSeen < RECHECK_WINDOW_MS;
}

/**
 * Cria o motor de checagem do YouTube. Tudo que toca rede/banco/relógio é injetável (testes).
 */
export function createYoutubeEngine({
  repo = youtubeRepository,
  api = { getLatestChannelItems, fetchVideoDetails: fetchVideoDetailsBatch, resolveChannel },
  classify = classifyYoutubeItem,
  now = () => Date.now(),
  log = logger,
} = {}) {
  let quotaBlockedUntil = 0;

  function blockForQuota(where) {
    quotaBlockedUntil = now() + QUOTA_BACKOFF_MS;
    log.warn(`[YoutubeEngine] Cota diária da API do YouTube esgotada (${where}). Pausando as checagens por ${Math.round(QUOTA_BACKOFF_MS / 60000)} min.`);
  }

  return {
    /**
     * Checa todos os canais cadastrados, detecta itens novos e transições de
     * estado de lives, e retorna uma lista de eventos a publicar.
     *
     * Custo de cota por ciclo: 1 unidade por canal (playlistItems) + 1 por lote de até 50 vídeos
     * (videos.list com `id=a,b,c`), só para itens que precisam (veja needsDetails). Antes eram
     * 1 + 5 unidades por canal, mesmo para vídeos já vistos, o que esgotava a cota diária.
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
        log.warn('[YoutubeEngine] ⏳ Ciclo de checagem já em andamento. Ignorando chamada concorrente.');
        return [];
      }

      isCheckingYoutube = true;
      const events = [];

      try {
        if (now() < quotaBlockedUntil) return [];

        const subscriptions = repo.getAllSubscriptions();
        if (subscriptions.length === 0) {
          return [];
        }

        // Canais únicos monitorados (com uploads_playlist_id resolvida no cadastro)
        const channelsById = new Map();
        for (const tracked of repo.getAllTrackedChannels()) {
          channelsById.set(tracked.youtube_channel_id, {
            channelName: tracked.channel_name,
            uploadsPlaylistId: tracked.uploads_playlist_id,
          });
        }

        const playlistCache = new Map(); // channelId -> uploadsPlaylistId (fallback dinâmico)

        // Fase 1: itens recentes de cada canal. Falha em um canal não aborta os outros.
        const channels = [];
        for (const [channelId, meta] of channelsById) {
          log.info(`[YoutubeEngine] Checando canal ${meta.channelName || channelId}...`);

          try {
            let uploadsPlaylistId = meta.uploadsPlaylistId;
            if (!uploadsPlaylistId) {
              if (playlistCache.has(channelId)) {
                uploadsPlaylistId = playlistCache.get(channelId);
              } else {
                const resolved = await api.resolveChannel(channelId);
                uploadsPlaylistId = resolved?.uploadsPlaylistId || null;
                playlistCache.set(channelId, uploadsPlaylistId);
              }
            }

            if (!uploadsPlaylistId) {
              log.warn(`[YoutubeEngine] Sem uploadsPlaylistId para o canal ${channelId}. Pulando.`);
              continue;
            }

            const items = await api.getLatestChannelItems(uploadsPlaylistId, 5);
            if (!items || items.length === 0) continue;
            channels.push({ channelId, meta, items });
          } catch (err) {
            log.error(`[YoutubeEngine] Erro na API para canal ${channelId}: ${err.message}`);
            if (isQuotaError(err)) {
              // Sem cota nada mais vai funcionar neste ciclo: não insiste nos outros canais.
              blockForQuota('lista de uploads');
              break;
            }
          }
        }

        // Nada a processar, ou a cota acabou durante a fase 1 (não adianta gastar mais chamadas).
        if (channels.length === 0 || now() < quotaBlockedUntil) return events;

        // Fase 2: estado "visto" de cada item e quais precisam de detalhes (itens estáveis ficam de fora).
        const nowMs = now();
        const wanted = new Set();
        for (const entry of channels) {
          entry.rows = [];
          for (const item of entry.items) {
            let seen = null;
            try {
              seen = repo.getSeenItem(item.videoId) || null;
            } catch (err) {
              log.error(`[YoutubeEngine] Erro ao ler o estado do vídeo ${item.videoId}: ${err.message}`);
              continue;
            }
            const needs = needsDetails(seen, nowMs);
            if (needs) wanted.add(item.videoId);
            entry.rows.push({ item, seen, needs });
          }
        }

        // Fase 3: detalhes em lote (1 unidade de cota por 50 vídeos). Se falhar, os itens que
        // dependem dela ficam para o próximo ciclo (não são marcados como vistos nem anunciados).
        let detailsById = new Map();
        let detailsFailed = false;
        if (wanted.size > 0) {
          try {
            detailsById = await api.fetchVideoDetails([...wanted]);
          } catch (err) {
            detailsFailed = true;
            log.error(`[YoutubeEngine] Erro ao buscar detalhes de ${wanted.size} vídeo(s): ${err.message}`);
            if (isQuotaError(err)) blockForQuota('detalhes dos vídeos');
          }
        }

        // Fase 4: classifica e gera os eventos (mesmas regras de antes), com try/catch por item.
        for (const { channelId, meta, rows } of channels) {
          for (const { item, seen, needs } of rows) {
            if (!needs) continue; // estado estável: nada a anunciar, nada a gravar
            if (detailsFailed) continue;

            try {
              const details = detailsById.get(item.videoId) ?? null;
              const newState = classify(details);
              const eventType = mapStateToEventType(newState);

              if (!seen) {
                // Primeira vez vendo esse item. Anuncia vídeo/short sempre;
                // live apenas se upcoming ou já ao vivo.
                repo.upsertSeenItem(item.videoId, channelId, newState);
                if (eventType) {
                  events.push(buildEvent(eventType, item, details, channelId, meta.channelName));
                }
              } else if (seen.last_known_state !== newState) {
                // Transição de estado — exemplo: upcoming -> live, live -> ended_vod
                const transitionType = mapTransitionToEventType(seen.last_known_state, newState);
                repo.upsertSeenItem(item.videoId, channelId, newState);
                if (transitionType) {
                  events.push(buildEvent(transitionType, item, details, channelId, meta.channelName));
                }
              }
              // Estado igual -> nada muda
            } catch (err) {
              log.error(`[YoutubeEngine] Erro ao processar o vídeo ${item.videoId} do canal ${channelId}: ${err.message}`);
            }
          }
        }

        log.info(`[YoutubeEngine] Checagem concluída: ${events.length} evento(s) para publicar.`);
        return events;
      } catch (err) {
        log.error(`[YoutubeEngine] Erro no ciclo de checagem: ${err.message}`);
        // Eventos já gravados como "vistos" não podem ser perdidos: devolve o que foi montado.
        return events;
      } finally {
        isCheckingYoutube = false;
      }
    },
  };
}

export const youtubeEngine = createYoutubeEngine();

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