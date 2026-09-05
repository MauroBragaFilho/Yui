import { EmbedBuilder } from 'discord.js';
import { CONSTANTS } from '../../config/constants.js';
import { translateText } from '../../engines/gtao/systems/weekly/translate.js';

function formatLocationList(items, emoji = '📍') {
  if (!items || items.length === 0) return 'N/A';
  return items.map((i) => `${emoji} ${i.locationName}`).join('\n');
}

export function createDailyEmbed(dailyData) {
  const dateStr = dailyData.date || new Date().toISOString().split('T')[0];
  const embed = new EmbedBuilder()
    .setColor(CONSTANTS.COLORS.DAILY_RESET)
    .setTitle(`📅 GTA Online — Reset Diário (${dateStr})`)
    .setThumbnail(CONSTANTS.THUMBNAILS.GTA_LOGO)
    .setDescription('Confira as localizações e inventários atualizados para o dia de hoje no GTA Online:')
    .setTimestamp();

  // Gun Van
  if (dailyData.gunVan) {
    const gv = dailyData.gunVan;
    const weaponsList = (gv.weapons || [])
      .slice(0, 5)
      .map((w) => `- ${w.discountPercent ? `${translateText(w.name)} (-${w.discountPercent}%)` : translateText(w.name)}`)
      .join('\n') || 'N/A';

    embed.addFields({
      name: '**🚐 Van de Armas**',
      value: `📍 Localização: ${gv.locationName || 'N/A'}\n🔫 Destaques:\n${weaponsList}`,
      inline: false,
    });
  }

  // Street Dealers
  if (dailyData.streetDealers?.dealers?.length > 0) {
    const dealersTxt = dailyData.streetDealers.dealers
      .map((d) => `• ${d.locationName} (⭐ ${d.premiumProduct})`)
      .join('\n');
    embed.addFields({
      name: '**🏪 Comerciantes**',
      value: dealersTxt,
      inline: false,
    });
  }

  // Shipwreck
  if (dailyData.collectibles?.shipwreck) {
    embed.addFields({
      name: '**🚢 Naufrágio Diário**',
      value: `📍 Localização: ${dailyData.collectibles.shipwreck.locationName || 'N/A'}`,
      inline: true,
    });
  }

  // Treasure Chests / Hidden Caches (colecionáveis extras, se houver espaço)
  if (dailyData.collectibles?.treasureChests?.length > 0) {
    const chestsTxt = dailyData.collectibles.treasureChests
      .map((tc) => `📍 ${tc.locationName}`)
      .join('\n');
    embed.addFields({
      name: '**💰 Baús do Tesouro**',
      value: chestsTxt,
      inline: true,
    });
  }

  // Time Trials
  if (dailyData.timeTrials) {
    const tt = dailyData.timeTrials;
    const ttList = [];
    if (tt.rcBandito) ttList.push(`• RC Bandito: ${tt.rcBandito.locationName}`);
    if (tt.junkEnergyBike) ttList.push(`• Junk Energy Bike: ${tt.junkEnergyBike.locationName}`);

    if (ttList.length > 0) {
      embed.addFields({
        name: '**🏎️ Desafios Contra o Relógio**',
        value: ttList.join('\n'),
        inline: false,
      });
    }
  }

  embed.setFooter({ text: 'Reset diário ocorre pontualmente às 06:00 UTC' });
  return embed;
}
