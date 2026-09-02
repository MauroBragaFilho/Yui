import { EmbedBuilder } from 'discord.js';
import { CONSTANTS } from '../../config/constants.js';

/**
 * Embed de streamer da Twitch entrando ao vivo.
 *
 * @param {object} event — evento normalizado pelo twitchEngine
 * @returns {EmbedBuilder}
 */
export function createTwitchLiveEmbed(event) {
  // Substitui os placeholders {width}x{height} da thumbnail da Helix
  let thumbnailUrl = event.thumbnailUrl || '';
  if (thumbnailUrl) {
    thumbnailUrl = thumbnailUrl
      .replace('{width}', '1280')
      .replace('{height}', '720');
  }

  const embed = new EmbedBuilder()
    .setColor(CONSTANTS.COLORS.TWITCH)
    .setTitle(`🔴 ${event.title}`)
    .setURL(event.url)
    .setAuthor({
      name: event.login,
      url: `https://twitch.tv/${event.login}`,
    })
    .addFields(
      { name: '🎮 Categoria', value: event.gameName || 'Indeterminado', inline: true },
      { name: '👀 Espectadores', value: String(event.viewerCount || 0), inline: true }
    )
    .setFooter({ text: 'Twitch' })
    .setTimestamp(event.startedAt ? new Date(event.startedAt) : new Date());

  if (thumbnailUrl.startsWith('http')) {
    embed.setImage(thumbnailUrl);
  }

  return embed;
}