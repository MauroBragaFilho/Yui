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
 * Embed do Weekly do r/gtaonline (fonte Reddit), dividido em duas camadas:
 *
 *  - PÁGINA 1 (`createWeeklyRedditEmbed`): resumo rápido, lido em segundos —
 *    período, bônus compactados, pódio/carro premiado, só os DESTAQUES de
 *    desconto (grátis e ≥ 50%) e um desafio.
 *  - PÁGINAS DE DETALHE (`buildWeeklyDetailSections`): descontos completos
 *    por loja, Van de Armas, GTA+ e todos os desafios.
 *
 * Recebe o JSON normalizado produzido pelo weeklyService (NÃO o selftext
 * cru do Reddit).
 */

/** Quantas atividades aparecem por multiplicador no resumo (o resto vira "+N"). */
const SUMMARY_MAX_ACTIVITIES = 3;
/** Máximo de destaques de desconto no resumo. */
const SUMMARY_MAX_HIGHLIGHTS = 5;
/** Desconto mínimo (%) para virar destaque. */
const HIGHLIGHT_MIN_PERCENT = 50;

/** Limites do Discord para um embed. */
const FIELD_MAX = 1000; // de 1024 por field
const EMBED_SAFE_CHARS = 5000; // de 6000 por embed
const EMBED_MAX_FIELDS = 24; // de 25

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

/** Trunca strings longas respeitando o limite de 1024 chars de um field. */
function truncateValue(text, maxLen = FIELD_MAX) {
  if (!text) return null;
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trim()}…`;
}

// ───────────────────────── Resumo (página 1) ─────────────────────────

/**
 * Rótulo curto de uma atividade para o resumo: "Série X: a, b, c" vira só
 * "Série X" (o texto completo vai para a página de Bônus).
 */
function shortActivity(text) {
  const head = text.split(':')[0].trim();
  const short = head.length >= 6 ? head : text;
  return short.length > 60 ? `${short.slice(0, 59).trim()}…` : short;
}

/** Atividades de um bônus já traduzidas. */
function bonusActivities(b, useI18n) {
  return (b.atividades || []).map((a) => (useI18n ? a : translateText(a)));
}

/** True quando o resumo omite informação (corta atividades ou encurta rótulos). */
function summaryOmitsBonusInfo(weekly, useI18n = false) {
  return (weekly.bonus || []).some((b) => {
    const list = bonusActivities(b, useI18n);
    return list.length > SUMMARY_MAX_ACTIVITIES || list.some((a) => shortActivity(a) !== a);
  });
}

/** Bônus compactos: uma linha por multiplicador, com até 3 atividades e "+N". */
function buildBonusSummary(weekly, useI18n = false) {
  const bonus = weekly.bonus || [];
  if (bonus.length === 0) return null;

  return bonus
    .map((b) => {
      const atividades = bonusActivities(b, useI18n);
      const shown = atividades.slice(0, SUMMARY_MAX_ACTIVITIES).map(shortActivity);
      const extra = atividades.length - shown.length;
      const list = shown.join(' · ') + (extra > 0 ? ` · **+${extra}**` : '');
      return `**${b.multiplicador}x GTA$ & RP** — ${list || '—'}`;
    })
    .join('\n');
}

/** Título de exibição sem o ruído "(Not live until ~5am ET...)". */
function cleanTitle(title) {
  return String(title || '').replace(/\s*\((?:not live|dispon[ií]vel)[^)]*\)\s*$/i, '').trim();
}

function buildVehiclesSection(weekly) {
  const veh = weekly.veiculos || {};
  const parts = [];
  if (veh.podium) parts.push(`🏆 Pódio: **${veh.podium}**`);
  if (veh.prizeRide) parts.push(`🎁 Carro Premiado: **${veh.prizeRide}**`);
  return parts.length ? parts.join('\n') : null;
}

/** Reaplica o texto PT-BR por extenso em uma linha de desconto agrupada. */
function beautifyDiscountLine(line) {
  const m = line.match(/^(.+?)\s*\((\d{1,3}\s*%)\)$/);
  if (m) return `${m[1].trim()} — ${m[2].trim()} de desconto`;
  return line;
}

/** Separa "Nome — 70% de desconto" em { name, percent, free }. */
function parseDiscountLine(line) {
  const text = String(line);
  const [namePart] = text.split(/\s[—–-]\s/);
  const pct = text.match(/(\d{1,3})\s*%/);
  const free = /gr[aá]tis|\bfree\b|de gra[cç]a/i.test(text);
  return {
    name: (namePart || text).trim(),
    percent: pct ? parseInt(pct[1], 10) : null,
    free,
  };
}

/**
 * Seleciona os destaques: itens grátis primeiro e depois os maiores
 * descontos (>= 50%). Retorna { lines, rest }.
 */
function buildDiscountHighlights(weekly, useI18n = false) {
  const discounts = weekly.descontos || [];
  if (discounts.length === 0) return null;

  const items = discounts
    .map((d) => (useI18n ? d : translateDiscount(d)))
    .map((line) => ({ line, ...parseDiscountLine(line) }));

  const free = items.filter((i) => i.free);
  const big = items
    .filter((i) => !i.free && i.percent !== null && i.percent >= HIGHLIGHT_MIN_PERCENT)
    .sort((a, b) => b.percent - a.percent);

  const picked = [...free, ...big].slice(0, SUMMARY_MAX_HIGHLIGHTS);
  const lines = picked.map((i) => (i.free ? `🆓 ${i.name}` : `🔥 ${i.name} — **${i.percent}%**`));
  const rest = discounts.length - picked.length;

  if (lines.length === 0) {
    return `${discounts.length} descontos disponíveis — veja as próximas páginas ▶`;
  }
  if (rest > 0) lines.push(`*+${rest} descontos nas próximas páginas ▶*`);
  return lines.join('\n');
}

function buildChallengeSummary(weekly, useI18n = false) {
  const first = (weekly.desafios || [])[0];
  if (!first) return null;
  const text = useI18n ? first : translateText(first);
  return `🎯 ${text.length > 160 ? `${text.slice(0, 159).trim()}…` : text}`;
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

/** True se existirá ao menos uma página de detalhe para este weekly. */
function hasDetails(weekly, options = {}) {
  return buildWeeklyDetailSections(weekly, options).length > 0;
}

export function createWeeklyRedditEmbed(weekly, options = {}) {
  // Se o weekly já chega traduzido (por translateWeeklyForEmbed — via IA ou
  // glossário), não reaplicamos o glossário aqui: os valores já são pt-BR.
  const useI18n = Boolean(weekly._i18n && weekly._i18n.by);
  const embed = new EmbedBuilder()
    .setColor(CONSTANTS.COLORS.WEEKLY_EVENT)
    .setTitle(
      `🎉 GTA Online — ${cleanTitle(useI18n ? weekly.title : translateTitle(weekly.title)) || 'Bônus da Semana'}`
    )
    .setThumbnail(CONSTANTS.THUMBNAILS.GTA_LOGO)
    .setTimestamp();
  if (weekly.url) embed.setURL(weekly.url);

  const withMore = options.detailsExpected ?? hasDetails(weekly, options);
  embed.setDescription(
    `${buildPeriodLine(weekly)}${withMore ? '\n*Resumo rápido — use ▶ para ver os detalhes: bônus, descontos por loja, Van de Armas e GTA+.*' : ''}`
  );

  const bonus = buildBonusSummary(weekly, useI18n);
  if (bonus) embed.addFields({ name: '💰 Bônus', value: truncateValue(bonus), inline: false });

  const vehicles = buildVehiclesSection(weekly);
  if (vehicles) embed.addFields({ name: '🚗 Veículos', value: vehicles, inline: false });

  const highlights = buildDiscountHighlights(weekly, useI18n);
  if (highlights) {
    embed.addFields({ name: '🔥 Destaques de Desconto', value: truncateValue(highlights), inline: false });
  }

  const challenge = buildChallengeSummary(weekly, useI18n);
  if (challenge) embed.addFields({ name: '🎯 Desafio da Semana', value: truncateValue(challenge), inline: false });

  const relTime = formatRelativeTimeBR(weekly.createdUtc);
  embed.setFooter({
    text: `Fonte: r/gtaonline • Post ${weekly.id || ''} • Clique no título para ver o post${relTime ? ` • ${relTime}` : ''}`,
  });

  return embed;
}

// ───────────────────────── Detalhes (páginas seguintes) ─────────────────────────

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

/** Quebra uma lista de linhas em chunks que cabem em um field (<= FIELD_MAX). */
function chunkLines(lines, max = FIELD_MAX) {
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max && current) {
      chunks.push(current);
      current = line.length > max ? `${line.slice(0, max - 1)}…` : line;
    } else {
      current = next.length > max ? `${next.slice(0, max - 1)}…` : next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

/** Agrupa fields em páginas que respeitam os limites do Discord. */
function paginateFields(fields) {
  const pages = [];
  let current = [];
  let size = 0;
  for (const f of fields) {
    const fieldSize = f.name.length + f.value.length;
    if (current.length && (current.length >= EMBED_MAX_FIELDS || size + fieldSize > EMBED_SAFE_CHARS)) {
      pages.push(current);
      current = [];
      size = 0;
    }
    current.push(f);
    size += fieldSize;
  }
  if (current.length) pages.push(current);
  return pages;
}

function buildDiscountFields(weekly, useI18n = false) {
  const discounts = weekly.descontos || [];
  if (discounts.length === 0) return [];

  const prepared = discounts.map((d) => (useI18n ? d : translateDiscount(d)));
  const groups = groupDiscountsByStore(prepared);

  // Sem catálogo de lojas: lista única (nada é perdido).
  if (groups.length === 0) {
    return chunkLines(prepared.map((d) => `• ${beautifyDiscountLine(d)}`)).map((value, i) => ({
      name: i === 0 ? '🏷️ Descontos' : '🏷️ Descontos (cont.)',
      value,
      inline: false,
    }));
  }

  const fields = [];
  for (const g of groups) {
    const emoji = STORE_EMOJIS[g.store] || '🏪';
    const lines = g.vehicles.map((v) => `• ${beautifyDiscountLine(v)}`);
    chunkLines(lines).forEach((value, i) => {
      fields.push({
        name: `${emoji} ${g.store}${i > 0 ? ' (cont.)' : ''}`,
        value,
        inline: false,
      });
    });
  }
  return fields;
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

/**
 * Páginas de detalhe do Weekly, no mesmo formato das seções da IA
 * ({ emoji, title, fields, footerText }) para entrarem na paginação.
 *
 *   0-1 Bônus da Semana (completos; só se o resumo omitiu algo)
 *   1+ Descontos da Semana (por loja; vira "cont." se passar dos limites)
 *   1  Van de Armas, GTA+ e Desafios (só as seções que existirem)
 */
export function buildWeeklyDetailSections(weekly, options = {}) {
  const useI18n = Boolean(weekly._i18n && weekly._i18n.by);
  const sections = [];
  const footerText = `Fonte: r/gtaonline • Post ${weekly.id || ''}`;

  // Bônus completos: só quando o resumo da página 1 omitiu algo.
  if (summaryOmitsBonusInfo(weekly, useI18n)) {
    const bonusFields = [];
    for (const b of weekly.bonus || []) {
      const lines = bonusActivities(b, useI18n).map((a) => `• ${a}`);
      chunkLines(lines).forEach((value, i) => {
        bonusFields.push({ name: `💰 ${b.multiplicador}x GTA$ & RP${i > 0 ? ' (cont.)' : ''}`, value, inline: false });
      });
    }
    paginateFields(bonusFields).forEach((fields, i) => {
      sections.push({ emoji: '💰', title: i === 0 ? 'Bônus da Semana' : 'Bônus da Semana (cont.)', fields, footerText });
    });
  }

  const discountPages = paginateFields(buildDiscountFields(weekly, useI18n));
  discountPages.forEach((fields, i) => {
    sections.push({
      emoji: '🏷️',
      title: i === 0 ? 'Descontos da Semana' : 'Descontos da Semana (cont.)',
      fields,
      footerText,
    });
  });

  const extras = [];
  const gunVan = buildGunVanSection(weekly, useI18n, options);
  if (gunVan) extras.push({ name: '🛻 Van de Armas', value: truncateValue(gunVan), inline: false });

  if (weekly.gtaPlus && (weekly.gtaPlus.items || []).length > 0) {
    extras.push({
      name: '⭐ GTA+',
      value: truncateValue(
        weekly.gtaPlus.items
          .slice(0, 8)
          .map((x) => `• ${useI18n ? x : translateText(x)}`)
          .join('\n')
      ),
      inline: false,
    });
  }

  const desafios = weekly.desafios || [];
  if (desafios.length > 0) {
    extras.push({
      name: '🎯 Desafios da Semana',
      value: truncateValue(desafios.slice(0, 4).map((d) => `🎯 ${useI18n ? d : translateText(d)}`).join('\n')),
      inline: false,
    });
  }

  if (extras.length > 0) {
    sections.push({ emoji: '🛻', title: 'Van de Armas, GTA+ e Desafios', fields: extras, footerText });
  }

  return sections;
}

export default { createWeeklyRedditEmbed, buildWeeklyDetailSections };
