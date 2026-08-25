import { EmbedBuilder } from 'discord.js';
import { CONSTANTS } from '../../config/constants.js';

export function createWeeklyEmbed(weeklyData) {
  const embed = new EmbedBuilder()
    .setColor(CONSTANTS.COLORS.WEEKLY_EVENT)
    .setTitle(`🚨 GTA Online — ${weeklyData.title || 'Atualização Semanal'}`)
    .setThumbnail(weeklyData.thumbnailUrl || CONSTANTS.THUMBNAILS.GTA_LOGO)
    .setDescription(
      weeklyData.period
        ? `🗓️ **Período:** ${weeklyData.period}`
        : weeklyData.summary || 'Confira os destaques da semana:'
    )
    .setTimestamp();

  if (weeklyData.url) {
    embed.setURL(weeklyData.url);
  }

  if (weeklyData.podiumVehicle) {
    embed.addFields({
      name: '**🎰 Veículo do Cassino (Pódio)**',
      value: `🚗 ${weeklyData.podiumVehicle}`,
      inline: true,
    });
  }

  if (weeklyData.prizeRide) {
    embed.addFields({
      name: '**🏁 Veículo do Evento de Carros LS**',
      value: `🏎️ ${weeklyData.prizeRide}`,
      inline: true,
    });
  }

  if (weeklyData.bonuses && weeklyData.bonuses.length > 0) {
    const bonusTxt = weeklyData.bonuses.slice(0, 6).map((b) => `• ${b}`).join('\n');
    embed.addFields({
      name: '**💰 Bônus de GTA$ e RP**',
      value: bonusTxt,
      inline: false,
    });
  }

  if (weeklyData.discounts && weeklyData.discounts.length > 0) {
    const discTxt = weeklyData.discounts.slice(0, 6).map((d) => `• ${d}`).join('\n');
    embed.addFields({
      name: '**🏷️ Descontos da Semana**',
      value: discTxt,
      inline: false,
    });
  }

  embed.setFooter({
    text: weeklyData.summary
      ? 'Tradução automática do artigo oficial da Rockstar • Clique no título para ler o original'
      : 'Atualização semanal ocorre tradicionalmente às quintas-feiras',
  });
  return embed;
}
