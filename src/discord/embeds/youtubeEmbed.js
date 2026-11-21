import { EmbedBuilder } from 'discord.js';
import { CONSTANTS } from '../../config/constants.js';

/**
 * Embed de vídeo novo (ou Short) do YouTube.
 *
 * @param {object} event — evento normalizado pelo youtubeEngine
 * @returns {EmbedBuilder}
 */
export function createYoutubeVideoEmbed(event) {
  const isShort = event.type === 'short';
  const color = isShort ? CONSTANTS.COLORS.YOUTUBE_SHORT : CONSTANTS.COLORS.YOUTUBE_VIDEO;
  const emoji = isShort ? '📱' : '📹';

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${emoji} ${event.title}`)
    .setURL(event.url)
    .setAuthor({
      name: `${event.channelName} · YouTube`,
      url: `https://www.youtube.com/channel/${event.channelId}`,
    })
    .setFooter({ text: isShort ? 'YouTube Shorts' : 'Vídeo novo no YouTube' })
    .setTimestamp(event.publishedAt ? new Date(event.publishedAt) : new Date());

  if (event.thumbnailUrl && event.thumbnailUrl.startsWith('http')) {
    embed.setImage(event.thumbnailUrl);
  }

  return embed;
}

/** 11_520_000 ms -> "3h 12min"; 2 dias e 7 h -> "2d 7h"; menos de 1 min -> "menos de 1 min". '' se não for um tempo válido. */
export function formatLiveDuration(ms) {
  if (ms === null || ms === undefined || ms === '') return ''; // sem horário de início/fim não há duração (Number(null) seria 0)
  const total = Math.floor(Number(ms) / 60000);
  if (!Number.isFinite(total) || total < 0) return '';
  if (total < 1) return 'menos de 1 min';
  const days = Math.floor(total / 1440);
  const hours = Math.floor((total % 1440) / 60);
  const minutes = total % 60;
  if (days > 0) return hours > 0 ? `${days}d ${hours}h` : `${days}d`;
  if (hours > 0) return minutes > 0 ? `${hours}h ${minutes}min` : `${hours}h`;
  return `${minutes}min`;
}

/** Segundos Unix de uma data ISO válida (o formato do carimbo de horário do Discord), ou null. */
export function unixSeconds(iso) {
  if (iso === null || iso === undefined || iso === '') return null;
  const ms = Date.parse(String(iso));
  return Number.isFinite(ms) ? Math.floor(ms / 1000) : null;
}

/**
 * O horário que o RODAPÉ mostra: o da própria live, e não o de quando o vídeo foi criado no YouTube (`publishedAt`, que é quando a live foi
 * AGENDADA: o aviso dizia "Hoje às 09:21" para uma live das 14h). Agendada = quando começa; ao vivo = quando começou; encerrada = quando terminou.
 * Sem o horário da live (o YouTube nem sempre o informa), cai no que sempre foi usado.
 */
export function liveMomentIso(event) {
  const pick = { live_scheduled: event.scheduledStart, live_started: event.actualStart, live_ended: event.actualEnd }[event.type];
  return unixSeconds(pick) !== null ? pick : event.publishedAt;
}

/**
 * Embed de live do YouTube (agendada, ao vivo ou encerrada).
 *
 * @param {object} event — evento normalizado pelo youtubeEngine
 * @returns {EmbedBuilder}
 */
export function createYoutubeLiveEmbed(event) {
  const color = CONSTANTS.COLORS.YOUTUBE_LIVE;
  const texts = {
    live_scheduled: { emoji: '📅', status: '🔔 Live agendada', desc: 'Uma live foi agendada neste canal!' },
    live_started: { emoji: '🔴', status: '🔴 AO VIVO', desc: 'A live começou agora!' },
    live_ended: { emoji: '✅', status: '🟢 Live encerrada', desc: 'A live terminou — a gravação está disponível.' },
    vod: { emoji: '🎬', status: '📼 Gravação disponível', desc: 'A gravação da live já está publicada no canal.' },
  };

  const t = texts[event.type] || texts.live_started;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${t.emoji} ${event.title}`)
    .setURL(event.url)
    .setAuthor({
      name: `${event.channelName} · YouTube`,
      url: `https://www.youtube.com/channel/${event.channelId}`,
    })
    .setDescription(t.desc)
    .setFooter({ text: t.status })
    .setTimestamp(unixSeconds(liveMomentIso(event)) !== null ? new Date(liveMomentIso(event)) : new Date());

  // Live agendada: QUANDO ela começa, no fuso de quem lê (carimbo do Discord, não uma hora formatada aqui: o relógio do servidor não é o de ninguém) e a contagem.
  if (event.type === 'live_scheduled') {
    const start = unixSeconds(event.scheduledStart);
    if (start !== null) embed.addFields({ name: '🕑 Começa', value: `<t:${start}:F> (<t:${start}:R>)` });
  }

  // Live encerrada: mostra quanto ela durou (horário real de início e fim informado pelo YouTube).
  if (event.type === 'live_ended') {
    const duration = formatLiveDuration(event.durationMs);
    if (duration) embed.addFields({ name: '⏱️ Duração', value: duration, inline: true });
  }

  if (event.thumbnailUrl && event.thumbnailUrl.startsWith('http')) {
    embed.setImage(event.thumbnailUrl);
  }

  return embed;
}