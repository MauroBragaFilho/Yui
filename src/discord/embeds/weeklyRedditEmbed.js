import { EmbedBuilder } from 'discord.js';
import { CONSTANTS } from '../../config/constants.js';

/**
 * Embed enxuto do Weekly do r/gtaonline (fonte Reddit).
 *
 * Formato proposto no plano:
 *   🎉 GTA Online — Bônus da Semana
 *   📅 27/08/2026 — 03/09/2026
 *   💰 Bônus / 🚗 Veículos / 🏷️ Descontos
 *
 * Recebe o JSON normalizado produzido pelo weeklyService (NÃO o selftext
 * cru do Reddit).
 */

function formatDateBR(iso) {
  if (!iso) return null;
  const m = iso.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return `${m[3]}/${m[2]}/${m[1]}`;
}

function buildPeriodLine(weekly) {
  const p = weekly.periodo || {};
  const inicio = formatDateBR(p.inicio);
  const fim = formatDateBR(p.fim);
  if (inicio && fim) return `📅 ${inicio} — ${fim}`;
  if (inicio) return `📅 Início: ${inicio}`;
  return '📅 Período não informado no post';
}

function buildBonusSection(weekly) {
  const bonus = weekly.bonus || [];
  if (bonus.length === 0) return null;

  const lines = [];
  for (const b of bonus) {
    const mult = b.multiplicador;
    const atv = (b.atividades || []).join('\n• ');
    lines.push(`**${mult}x GTA$ & RP**`);
    if (atv) lines.push(`• ${atv}`);
  }
  return lines.join('\n');
}

function buildVehiclesSection(weekly) {
  const veh = weekly.veiculos || {};
  const parts = [];
  if (veh.podium) parts.push(`🏆 Podium: **${veh.podium}**`);
  if (veh.prizeRide) parts.push(`🎁 Prize Ride: **${veh.prizeRide}**`);
  return parts.length ? parts.join('\n') : null;
}

function buildDiscountsSection(weekly) {
  const discounts = weekly.descontos || [];
  if (discounts.length === 0) return null;
  return discounts.slice(0, 15).map((d) => `• ${d}`).join('\n');
}

export function createWeeklyRedditEmbed(weekly) {
  const embed = new EmbedBuilder()
    .setColor(CONSTANTS.COLORS.WEEKLY_EVENT)
    .setTitle(`🎉 GTA Online — ${weekly.title || 'Bônus da Semana'}`)
    .setThumbnail(CONSTANTS.THUMBNAILS.GTA_LOGO)
    .setDescription(buildPeriodLine(weekly))
    .setURL(weekly.url)
    .setTimestamp();

  const bonus = buildBonusSection(weekly);
  if (bonus) {
    embed.addFields({ name: '💰 Bônus', value: bonus, inline: false });
  }

  const vehicles = buildVehiclesSection(weekly);
  if (vehicles) {
    embed.addFields({ name: '🚗 Veículos', value: vehicles, inline: false });
  }

  const descontos = buildDiscountsSection(weekly);
  if (descontos) {
    embed.addFields({ name: '🏷️ Descontos', value: descontos, inline: false });
  }

  if (weekly.gunVan && weekly.gunVan.length > 0) {
    embed.addFields({
      name: '🛻 Van de Armas',
      value: weekly.gunVan.slice(0, 8).map((x) => `• ${x}`).join('\n'),
      inline: false,
    });
  }

  if (weekly.gtaPlus && (weekly.gtaPlus.items || []).length > 0) {
    embed.addFields({
      name: '⭐ GTA+',
      value: weekly.gtaPlus.items.slice(0, 5).map((x) => `• ${x}`).join('\n'),
      inline: false,
    });
  }

  embed.setFooter({
    text: `Fonte: r/gtaonline • Post ${weekly.id || ''} • Clique no título para ver o post`,
  });

  return embed;
}

export default { createWeeklyRedditEmbed };
