import { CONSTANTS } from '../../config/constants.js';
import { translateText } from '../../engines/gtao/systems/weekly/translate.js';
import { makeEmbed, chunkLines, clampText } from '../embedLimits.js';
import { logger } from '../../utils/logger.js';

function formatLocationList(items, emoji = '📍') {
  if (!items || items.length === 0) return 'N/A';
  return items.map((i) => `${emoji} ${i.locationName}`).join('\n');
}

/**
 * Versão mínima do Reset Diário, usada pelo publicador se a montagem completa falhar (TG-18).
 * Nunca lança.
 */
export function createMinimalDailyEmbed(dailyData) {
  const date = clampText(String((dailyData && dailyData.date) || new Date().toISOString().split('T')[0]), 40);
  return makeEmbed({
    color: CONSTANTS.COLORS.DAILY_RESET,
    title: `📅 GTA Online — Reset Diário (${date})`,
    description: 'O reset diário aconteceu, mas não consegui montar os detalhes de hoje. Use /gta-diario para consultar.',
    thumbnail: CONSTANTS.THUMBNAILS.GTA_LOGO,
    timestamp: true,
  });
}

/**
 * Embed do Reset Diário do GTA Online.
 *
 * Monta pelo makeEmbed (embedLimits.js) e cada seção é montada sozinha: um dado estranho em uma
 * delas (lista que não é lista, nome ausente) ignora só aquela seção, em vez de derrubar a
 * publicação do dia em todos os servidores. Listas longas viram vários campos ("cont.").
 */
export function createDailyEmbed(dailyData) {
  const data = dailyData && typeof dailyData === 'object' ? dailyData : {};
  const dateStr = clampText(String(data.date || new Date().toISOString().split('T')[0]), 40);
  const fields = [];

  const section = (nome, build) => {
    try {
      build();
    } catch (err) {
      logger.warn(`[DailyEmbed] Seção "${nome}" ignorada: ${clampText(err?.message, 120)}`);
    }
  };

  const pushLines = (label, lines, inline) => {
    chunkLines(lines, 1000).forEach((value, i) => {
      fields.push({ name: `**${label}${i > 0 ? ' (cont.)' : ''}**`, value, inline });
    });
  };

  // Gun Van
  section('Van de Armas', () => {
    if (!data.gunVan) return;
    const gv = data.gunVan;
    const weaponsList = (gv.weapons || [])
      .slice(0, 5)
      .map((w) => `- ${w.discountPercent ? `${translateText(w.name)} (-${w.discountPercent}%)` : translateText(w.name)}`)
      .join('\n') || 'N/A';

    fields.push({
      name: '**🚐 Van de Armas**',
      value: `📍 Localização: ${gv.locationName || 'N/A'}\n🔫 Destaques:\n${weaponsList}`,
      inline: false,
    });
  });

  // Street Dealers
  section('Comerciantes', () => {
    if (!(data.streetDealers?.dealers?.length > 0)) return;
    pushLines(
      '🏪 Comerciantes',
      data.streetDealers.dealers.map((d) => `• ${d.locationName} (⭐ ${d.premiumProduct})`),
      false
    );
  });

  // Shipwreck
  section('Naufrágio', () => {
    if (!data.collectibles?.shipwreck) return;
    fields.push({
      name: '**🚢 Naufrágio Diário**',
      value: `📍 Localização: ${data.collectibles.shipwreck.locationName || 'N/A'}`,
      inline: true,
    });
  });

  // Treasure Chests / Hidden Caches (colecionáveis extras, se houver espaço)
  section('Baús do Tesouro', () => {
    if (!(data.collectibles?.treasureChests?.length > 0)) return;
    pushLines(
      '💰 Baús do Tesouro',
      data.collectibles.treasureChests.map((tc) => `📍 ${tc.locationName}`),
      true
    );
  });

  // Time Trials
  section('Desafios Contra o Relógio', () => {
    if (!data.timeTrials) return;
    const tt = data.timeTrials;
    const ttList = [];
    if (tt.rcBandito) ttList.push(`• RC Bandito: ${tt.rcBandito.locationName}`);
    if (tt.junkEnergyBike) ttList.push(`• Junk Energy Bike: ${tt.junkEnergyBike.locationName}`);

    if (ttList.length > 0) {
      fields.push({
        name: '**🏎️ Desafios Contra o Relógio**',
        value: ttList.join('\n'),
        inline: false,
      });
    }
  });

  return makeEmbed({
    color: CONSTANTS.COLORS.DAILY_RESET,
    title: `📅 GTA Online — Reset Diário (${dateStr})`,
    thumbnail: CONSTANTS.THUMBNAILS.GTA_LOGO,
    description: 'Confira as localizações e inventários atualizados para o dia de hoje no GTA Online:',
    timestamp: true,
    footer: { text: 'Reset diário ocorre pontualmente às 06:00 UTC' },
    fields,
  });
}
