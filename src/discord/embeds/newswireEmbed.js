import { CONSTANTS } from '../../config/constants.js';
import { makeEmbed, clampText } from '../embedLimits.js';

/**
 * Embed de uma notícia da Newswire.
 *
 * Monta pelo makeEmbed (embedLimits.js): título, rodapé e links são cortados/validados ANTES de
 * montar. Assim um artigo com título enorme, link relativo ou data inválida não derruba mais a
 * publicação do lote inteiro (os setters do EmbedBuilder lançam na hora).
 */
export function createNewswireEmbed(article) {
  const a = article && typeof article === 'object' ? article : {};
  const published = a.publishedAt ? new Date(a.publishedAt) : null;

  return makeEmbed({
    color: CONSTANTS.COLORS.NEWSWIRE,
    title: `📰 ${a.title ?? ''}`,
    url: a.url,
    author: {
      name: 'Rockstar Games Newswire',
      iconURL: CONSTANTS.THUMBNAILS.ROCKSTAR_LOGO,
      url: CONSTANTS.ROCKSTAR_NEWSWIRE_URL,
    },
    footer: { text: `Categoria: ${clampText(a.category || 'Geral', 100)}` },
    // Data ausente ou inválida: usa o momento atual (antes uma data inválida lançava RangeError).
    timestamp: published && Number.isFinite(published.getTime()) ? published : new Date(),
    image: a.thumbnailUrl,
  });
}
