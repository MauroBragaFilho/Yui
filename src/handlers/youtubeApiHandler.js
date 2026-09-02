import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const YOUTUBE_API_BASE = 'https://www.googleapis.com/youtube/v3';

/**
 * Busca os itens mais recentes de um canal do YouTube.
 * Usa playlistItems.list na "uploads" playlist — mais econômico em cota
 * do que search.list para monitoramento contínuo.
 *
 * @param {string} uploadsPlaylistId — ID da playlist "uploads" do canal
 * @param {number} maxResults — quantidade máxima de itens (padrão 5)
 * @returns {Promise<Array<{videoId: string, title: string, publishedAt: string, thumbnails: object}>>}
 */
export async function getLatestChannelItems(uploadsPlaylistId, maxResults = 5) {
  const apiKey = config.youtube.apiKey;
  if (!apiKey) {
    logger.warn('[YouTubeAPI] YOUTUBE_API_KEY não configurada. Pulando checagem.');
    return [];
  }

  const params = new URLSearchParams({
    part: 'snippet',
    playlistId: uploadsPlaylistId,
    maxResults: String(maxResults),
    order: 'date',
    key: apiKey,
  });

  const url = `${YOUTUBE_API_BASE}/playlistItems?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube API playlistItems error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return (data.items || []).map((item) => ({
    videoId: item.snippet.resourceId.videoId,
    title: item.snippet.title,
    publishedAt: item.snippet.publishedAt,
    thumbnails: item.snippet.thumbnails,
  }));
}

/**
 * Retorna detalhes completos de um vídeo (snippet + contentDetails + liveStreamingDetails).
 *
 * @param {string} videoId
 * @returns {Promise<object|null>}
 */
export async function getVideoDetails(videoId) {
  const apiKey = config.youtube.apiKey;
  if (!apiKey) return null;

  const params = new URLSearchParams({
    part: 'snippet,contentDetails,liveStreamingDetails',
    id: videoId,
    key: apiKey,
  });

  const url = `${YOUTUBE_API_BASE}/videos?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube API videos error ${response.status}: ${body}`);
  }

  const data = await response.json();
  return data.items?.[0] || null;
}

/**
 * Resolve @handle ou URL de canal customizada para channel_id + uploadsPlaylistId.
 *
 * @param {string} input — @handle, handle, channel ID direto (UC...), ou URL
 *   (ex: "https://youtube.com/@Canal", "https://youtube.com/c/Nome")
 * @returns {Promise<{channelId: string, uploadsPlaylistId: string, title: string}|null>}
 */
export async function resolveChannel(input) {
  const apiKey = config.youtube.apiKey;
  if (!apiKey) return null;

  const raw = (input || '').trim();
  if (!raw) return null;

  // 1. Channel ID direto (UC + 22 chars)
  const directId = raw.match(/^(UC[\w-]{22})$/);
  if (directId) {
    return await fetchChannelById(directId[1], apiKey);
  }

  // 2. URL com /channel/UC...
  const urlChannelId = raw.match(/youtube\.com\/channel\/(UC[\w-]{22})/);
  if (urlChannelId) {
    return await fetchChannelById(urlChannelId[1], apiKey);
  }

  // 3. Handle: extrai de URLs (youtube.com/@handle, youtube.com/c/..., youtube.com/handle)
  //    ou de entradas puras (@handle / handle)
  let cleanHandle = null;
  const urlHandle = raw.match(/youtube\.com\/(?:@|c\/|user\/)?([\w.-]+)/);
  if (urlHandle) {
    cleanHandle = urlHandle[1].replace(/^@/, '');
  } else {
    const bare = raw.match(/^@?([\w.-]+)$/i);
    if (bare) cleanHandle = bare[1];
  }

  if (!cleanHandle) return null;

  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    forHandle: cleanHandle,
    key: apiKey,
  });

  const url = `${YOUTUBE_API_BASE}/channels?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube API channels error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const item = data.items?.[0];
  if (!item) return null;

  return {
    channelId: item.id,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
    title: item.snippet?.title || 'Canal desconhecido',
  };
}

/**
 * Busca um canal pelo ID direto.
 */
async function fetchChannelById(channelId, apiKey) {
  const params = new URLSearchParams({
    part: 'snippet,contentDetails',
    id: channelId,
    key: apiKey,
  });

  const url = `${YOUTUBE_API_BASE}/channels?${params}`;
  const response = await fetch(url);

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`YouTube API channels error ${response.status}: ${body}`);
  }

  const data = await response.json();
  const item = data.items?.[0];
  if (!item) return null;

  return {
    channelId: item.id,
    uploadsPlaylistId: item.contentDetails?.relatedPlaylists?.uploads,
    title: item.snippet?.title || 'Canal desconhecido',
  };
}

/**
 * Função pura que classifica o estado de um item do YouTube.
 *
 * @param {object} videoDetails — resultado de getVideoDetails()
 * @returns {'live'|'upcoming'|'ended_vod'|'short'|'video'}
 */
export function classifyYoutubeItem(videoDetails) {
  if (!videoDetails) return 'video';

  const liveBroadcastContent = videoDetails.snippet?.liveBroadcastContent;

  if (liveBroadcastContent === 'live') return 'live';
  if (liveBroadcastContent === 'upcoming') return 'upcoming';

  // Se liveBroadcastContent é 'none' mas existe liveStreamingDetails,
  // é uma gravação de live (VOD/ended).
  if (videoDetails.liveStreamingDetails && liveBroadcastContent === 'none') {
    return 'ended_vod';
  }

  // Verificar se é Shorts (duração ≤ 60s via ISO 8601)
  const duration = videoDetails.contentDetails?.duration;
  if (duration) {
    const seconds = parseISO8601Duration(duration);
    if (seconds <= 60) return 'short';
  }

  return 'video';
}

/**
 * Parseia uma duração ISO 8601 (PT##M##S) para segundos.
 * @param {string} iso — Ex: "PT5M30S", "PT45S", "PT1H2M3S"
 * @returns {number}
 */
function parseISO8601Duration(iso) {
  const match = iso.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;
  const hours = parseInt(match[1] || '0', 10);
  const minutes = parseInt(match[2] || '0', 10);
  const seconds = parseInt(match[3] || '0', 10);
  return hours * 3600 + minutes * 60 + seconds;
}