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
    .setTimestamp(event.publishedAt ? new Date(event.publishedAt) : new Date());

  if (event.thumbnailUrl && event.thumbnailUrl.startsWith('http')) {
    embed.setImage(event.thumbnailUrl);
  }

  return embed;
}