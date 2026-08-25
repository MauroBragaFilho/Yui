import { EmbedBuilder } from 'discord.js';
import { CONSTANTS } from '../../config/constants.js';

export function createNewswireEmbed(article) {
  const embed = new EmbedBuilder()
    .setColor(CONSTANTS.COLORS.NEWSWIRE)
    .setTitle(`📰 ${article.title}`)
    .setURL(article.url)
    .setAuthor({
      name: 'Rockstar Games Newswire',
      iconURL: CONSTANTS.THUMBNAILS.ROCKSTAR_LOGO,
      url: CONSTANTS.ROCKSTAR_NEWSWIRE_URL,
    })
    .setFooter({ text: `Categoria: ${article.category || 'Geral'}` })
    .setTimestamp(article.publishedAt ? new Date(article.publishedAt) : new Date());

  if (article.thumbnailUrl && article.thumbnailUrl.startsWith('http')) {
    embed.setImage(article.thumbnailUrl);
  }

  return embed;
}
