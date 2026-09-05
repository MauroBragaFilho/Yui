import { EmbedBuilder } from 'discord.js';
import { CONSTANTS } from '../../config/constants.js';
import {
  translateText,
  translateTitle,
  translateDiscount,
  translateGunVanItem,
} from '../../engines/gtao/systems/weekly/translate.js';
import { groupDiscountsByStore } from '../../data/gtaoVehicleStores.js';

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

function buildBonusSection(weekly, useI18n = false) {
  const bonus = weekly.bonus || [];
  if (bonus.length === 0) return null;

  const lines = [];
  for (const b of bonus) {
    const mult = b.multiplicador;
    const atv = (b.atividades || [])
      .map((a) => (useI18n ? a : translateText(a)))
      .join('\n• ');
    lines.push(`**${mult}x GTA$ & RP**`);
    if (atv) lines.push(`• ${atv}`);
  }
  return lines.join('\n');
}

function buildVehiclesSection(weekly) {
  const veh = weekly.veiculos || {};
  const parts = [];
  if (veh.podium) parts.push(`🏆 Pódio: **${veh.podium}**`);
  if (veh.prizeRide) parts.push(`🎁 Carro Premiado: **${veh.prizeRide}**`);
  return parts.length ? parts.join('\n') : null;
}

/** Catálogo de emojis por loja (fonte: r/gtaonline / catálogo do GTAO Engine). */
const STORE_EMOJIS = {
  'Legendary Motorsport': '🏎️',
  'Dock Tease': '🛥️',
  'Warstock Cache & Carry': '🛡️',
  'Southern San Andreas Super Autos': '🚗',
  'Premium Deluxe Motorsport': '🏁',
  "Benny's Original Motor Works": '🔧',
  'Elitás Travel': '✈️',
  'Pedal & Metal': '🚲',
  'Maze Bank Foreclosures': '🏢',
};

/** Trunca strings longas respeitando o limite de 1024 chars de um field. */
function truncateValue(text, maxLen = 1000) {
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trim()}…`;
}

/** Reaplica o texto PT-BR por extenso em uma linha agrupada por loja. */
function beautifyDiscountLine(line) {
  const m = line.match(/^(.+?)\s*\((\d{1,3}\s*%)\)$/);
  if (m) return `${m[1].trim()} — ${m[2].trim()} de desconto`;
  return line;
}

function buildDiscountsSection(weekly, useI18n = false) {
  const discounts = weekly.descontos || [];
  if (discounts.length === 0) return null;

  // Traduz cada linha para PT-BR e agrupa por loja via catálogo veículo→loja
  // (gtaoVehicleStores). Veículos sem loja conhecida vão para "Outros",
  // garantindo que nenhum item seja perdido.
  const prepared = discounts.map((d) => (useI18n ? d : translateDiscount(d)));
  const groups = groupDiscountsByStore(prepared);
  if (groups.length === 0) {
    return truncateValue(prepared.map((d) => `• ${d}`).join('\n'));
  }

  const blocks = [];
  let totalLen = 0;
  const maxLen = 1000;
  for (const g of groups) {
    const emoji = STORE_EMOJIS[g.store] || '🏪';
    const lines = g.vehicles.map((v) => `• ${beautifyDiscountLine(v)}`);
    const block = `**${emoji} ${g.store}**\n${lines.join('\n')}`;
    if (totalLen + block.length + 2 > maxLen) {
      const remaining = maxLen - totalLen - 2;
      if (remaining > 12) blocks.push(`${block.slice(0, remaining)}…`);
      break;
    }
    blocks.push(block);
    totalLen += block.length + 2;
  }
  return blocks.join('\n\n');
}

function buildGunVanSection(weekly, useI18n = false, options = {}) {
  if (weekly.gunVan && weekly.gunVan.length > 0) {
    return weekly.gunVan
      .slice(0, 8)
      .map((x) => `• ${useI18n ? x : translateGunVanItem(x)}`)
      .join('\n');
  }

  // Post sem seção de Van de Armas listada: cai nas armas com desconto ativo
  // do snapshot diário determinístico (dados do GTAO Engine).
  const weapons = options.dailyData?.gunVan?.weapons || [];
  const discounted = weapons.filter((w) => w.discountPercent && w.discountPercent > 0);
  if (discounted.length > 0) {
    return discounted
      .slice(0, 8)
      .map((w) => `• ${w.name} — ${w.discountPercent}% de desconto`)
      .join('\n');
  }

  return null;
}

/** Tempo relativo do post no rodapé (ex: "Hoje às 18:10", "2 dias atrás"). */
function formatRelativeTimeBR(createdUtc) {
  if (!createdUtc) return null;
  const diffMin = Math.floor((Date.now() - createdUtc * 1000) / 60000);
  if (diffMin < 1) return 'agora mesmo';
  if (diffMin < 60) return `${diffMin} min atrás`;
  const diffH = Math.floor(diffMin / 60);
  if (diffH < 24) {
    const d = new Date(createdUtc * 1000);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    if (d.toDateString() === new Date().toDateString()) return `Hoje às ${hh}:${mm}`;
    return `${diffH}h atrás`;
  }
  const days = Math.floor(diffH / 24);
  if (days === 1) return 'Ontem';
  if (days < 7) return `${days} dias atrás`;
  return new Date(createdUtc * 1000).toLocaleDateString('pt-BR');
}

function buildChallengesSection(weekly, useI18n = false) {
  const desafios = weekly.desafios || [];
  if (desafios.length === 0) return null;
  return desafios.slice(0, 3).map((d) => `🎯 ${useI18n ? d : translateText(d)}`).join('\n');
}

export function createWeeklyRedditEmbed(weekly, options = {}) {
  // Se o weekly já chega traduzido (por translateWeeklyForEmbed — via IA ou
  // glossário), não reaplicamos o glossário aqui: os valores já são pt-BR.
  const useI18n = Boolean(weekly._i18n && weekly._i18n.by);
  const embed = new EmbedBuilder()
    .setColor(CONSTANTS.COLORS.WEEKLY_EVENT)
    .setTitle(
      `🎉 GTA Online — ${useI18n ? weekly.title || 'Bônus da Semana' : translateTitle(weekly.title) || 'Bônus da Semana'}`
    )
    .setThumbnail(CONSTANTS.THUMBNAILS.GTA_LOGO)
    .setDescription(buildPeriodLine(weekly))
    .setTimestamp();
  if (weekly.url) embed.setURL(weekly.url);

  const bonus = buildBonusSection(weekly, useI18n);
  if (bonus) {
    embed.addFields({ name: '💰 Bônus', value: truncateValue(bonus), inline: false });
  }

  const vehicles = buildVehiclesSection(weekly);
  if (vehicles) {
    embed.addFields({ name: '🚗 Veículos', value: vehicles, inline: false });
  }

  const descontos = buildDiscountsSection(weekly, useI18n);
  if (descontos) {
    embed.addFields({ name: '🏷️ Descontos', value: descontos, inline: false });
  }

  const gunVan = buildGunVanSection(weekly, useI18n, options);
  if (gunVan) {
    embed.addFields({ name: '🛻 Van de Armas', value: gunVan, inline: false });
  }

  if (weekly.gtaPlus && (weekly.gtaPlus.items || []).length > 0) {
    embed.addFields({
      name: '⭐ GTA+',
      value: weekly.gtaPlus.items
        .slice(0, 5)
        .map((x) => `• ${useI18n ? x : translateText(x)}`)
        .join('\n'),
      inline: false,
    });
  }

  const desafios = buildChallengesSection(weekly, useI18n);
  if (desafios) {
    embed.addFields({ name: '🎯 Desafio da Semana', value: desafios, inline: false });
  }

  const relTime = formatRelativeTimeBR(weekly.createdUtc);
  embed.setFooter({
    text: `Fonte: r/gtaonline • Post ${weekly.id || ''} • Clique no título para ver o post${relTime ? ` • ${relTime}` : ''}`,
  });

  return embed;
}

export default { createWeeklyRedditEmbed };
