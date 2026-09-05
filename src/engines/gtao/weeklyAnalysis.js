import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { generateResponse } from '../../handlers/llmHandler.js';
import { logger } from '../../utils/logger.js';
import { CONSTANTS } from '../../config/constants.js';
import { groupDiscountsByStore } from '../../data/gtaoVehicleStores.js';
import { translateTitle } from './systems/weekly/translate.js';
import { createWeeklyRedditEmbed } from '../../discord/embeds/weeklyRedditEmbed.js';

/**
 * Monta o prompt de análise semanal para a IA. Diferente da versão
 * anterior (texto livre), agora exigimos JSON estrito para conseguir
 * separar o conteúdo em páginas de embed distintas.
 *
 * Nomes dos sistemas do GTAO Engine já traduzidos para PT-BR:
 *   Gun Van        -> Van de Armas
 *   Street Dealers -> Comerciantes
 *   Time Trials    -> Desafios Contra o Relógio
 */
export function buildWeeklyAnalysisPrompt(weeklyData, dailyData) {
  const parts = [];

  parts.push(
    `Você é a Yui, especialista em GTA Online. O artigo abaixo está em INGLÊS. ` +
    `Analise-o, extraia as informações E traduza tudo para português (Brasil) no resultado. ` +
    `Responda ESTRITAMENTE em formato JSON válido, sem markdown code fences, sem texto antes ou depois, ` +
    `contendo exatamente estas chaves (todas como string, usando formatação Discord: negrito, listas com "•", emojis):\n\n` +
    `{\n` +
    `  "titulo": "Título do artigo traduzido para português (frase curta, ex: 'Recompensas Triplas em Corridas de Transformação').",\n` +
    `  "destaques": "Resumo dos principais eventos, modos e novidades da semana.",\n` +
    `  "itensGratuitos": "Lista de tudo disponível de graça esta semana (roupas, veículos, RP, GTA$, GTA+ etc). Se não houver nada gratuito confirmado, diga isso explicitamente.",\n` +
    `  "veiculosDesconto": "Lista de veículos em desconto mencionados no artigo, com o percentual quando disponível (ex: '• Declasse Vigero ZX -40%'). Se o artigo não mencionar descontos de veículos, diga isso explicitamente — NUNCA invente.",\n` +
    `  "novidades": "Novidades/conteúdos novos lançados nesta atualização (modos, veículos novos à venda, mapas, etc), separado dos itens gratuitos e descontos.",\n` +
    `  "melhorFarm": "Com base nos bônus ativos (2x, 3x, descontos) recomende as melhores atividades para ganhar GTA$/RP esta semana especificamente.",\n` +
    `  "avaliacao": "Nota informal da semana (ex: 'Semana Boa 🟢', 'Semana Razoável 🟡', 'Semana Fraca 🔴') e uma explicação curta do porquê, comparando com uma semana comum do jogo."\n` +
    `}\n\n` +
    `Regras: não invente valores que não estão no texto do artigo. Se não tiver certeza sobre algo, diga isso na própria string em vez de inventar. Seja direta e objetiva.`
  );

  parts.push(
    `\n--- ARTIGO OFICIAL DA SEMANA (em inglês, traduza para PT-BR no resultado) ---\nTítulo original: ${weeklyData.title}\n\n${weeklyData.fullText || weeklyData.summary}`
  );

  if (dailyData) {
    const gv = dailyData.gunVan;
    const dealers = dailyData.streetDealers?.dealers;
    const tt = dailyData.timeTrials;

    const contextLines = [];
    if (gv) contextLines.push(`Van de Armas: ${gv.locationName}`);
    if (dealers?.length) {
      contextLines.push(
        `Comerciantes: ${dealers.map((d) => `${d.locationName} (premium: ${d.premiumProduct})`).join('; ')}`
      );
    }
    if (tt) {
      const ttParts = [];
      if (tt.rcBandito) ttParts.push(`RC Bandito em ${tt.rcBandito.locationName}`);
      if (tt.junkEnergyBike) ttParts.push(`Junk Energy Bike em ${tt.junkEnergyBike.locationName}`);
      if (ttParts.length) contextLines.push(`Desafios Contra o Relógio: ${ttParts.join('; ')}`);
    }

    if (contextLines.length) {
      parts.push(`\n--- DADOS DETERMINÍSTICOS DE HOJE ---\n${contextLines.join('\n')}`);
    }
  }

  return parts.join('\n');
}

/**
 * Extrai o primeiro bloco JSON válido de uma string, tolerando texto
 * extra que o modelo às vezes adiciona antes/depois mesmo quando
 * instruído a não fazer isso.
 */
function extractJson(text) {
  if (!text) return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch (e) {
    return null;
  }
}

const ANALYSIS_KEYS = ['titulo', 'destaques', 'itensGratuitos', 'veiculosDesconto', 'novidades', 'melhorFarm', 'avaliacao'];

function normalizeAnalysis(parsed) {
  if (!parsed) return null;
  const result = {};
  for (const key of ANALYSIS_KEYS) {
    result[key] = typeof parsed[key] === 'string' && parsed[key].trim() ? parsed[key].trim() : null;
  }
  // Se nenhuma chave veio preenchida, tratamos como falha total.
  if (Object.values(result).every((v) => v === null)) return null;
  return result;
}

/**
 * Gera a análise estruturada da IA sobre a semana atual do GTA Online.
 * Retorna um objeto { destaques, itensGratuitos, veiculosDesconto,
 * novidades, melhorFarm, avaliacao } ou null em caso de falha total
 * (nunca lança erro, para não travar publicação/coleta automática).
 */
export async function generateWeeklyAnalysis(weeklyData, dailyData, channelId = null, guildId = null) {
  try {
    const prompt = buildWeeklyAnalysisPrompt(weeklyData, dailyData);
    const resposta = await generateResponse(prompt, channelId, {
      guildId,
      allowSearch: false,
      disableTools: true,
    });

    const parsed = extractJson(resposta);
    const normalized = normalizeAnalysis(parsed);

    if (!normalized) {
      logger.warn('[WeeklyAnalysis] A Yui não retornou um JSON estruturado válido. Resposta bruta descartada.');
      return null;
    }

    return normalized;
  } catch (error) {
    logger.warn(`[WeeklyAnalysis] Falha ao gerar análise da Yui: ${error.message}`);
    return null;
  }
}

/**
 * Extrai as armas com desconto ativo na Van de Armas do dia (dados
 * determinísticos do GTAO Engine, não vêm da Yui).
 */
function getGunVanDiscountedWeapons(dailyData) {
  const weapons = dailyData?.gunVan?.weapons || [];
  return weapons.filter((w) => w.discountPercent && w.discountPercent > 0);
}

function truncateField(text, maxLen = 1000) {
  if (!text) return '*Nenhuma informação confirmada pela Yui para esta seção.*';
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen - 1).trim()}…`;
}

/**
 * Composição ÚNICA do embed semanal, usada tanto no /gta-semanal quanto nas
 * publicações automáticas (Reddit e Newswire):
 *
 *   Página 1 (quando há dados estruturados — Reddit) — resumo enxuto no
 *     formato do r/gtaonline: título com datas, bônus, veículos, descontos
 *     agrupados por loja e Van de Armas.
 *   Páginas seguintes — análise da IA (destaques/gratuitos, descontos da IA
 *     somente quando a página 1 não os cobriu, farm/novidades, avaliação).
 *
 * Retorna um array de EmbedBuilder prontos para navegação por botão.
 */
export function buildWeeklyCombinedEmbeds(weeklyData, dailyData = null) {
  const analysis = weeklyData.analysis || {};
  const discountedWeapons = getGunVanDiscountedWeapons(dailyData);

  // A página 1 (resumo enxuto) só existe quando a fonte trouxe dados
  // estruturados (Reddit). Para a Newswire — que chega como texto traduzido —
  // a análise da IA lidera a paginação.
  const hasStructuredData = Boolean(
    (weeklyData.bonus && weeklyData.bonus.length) ||
      (weeklyData.descontos && weeklyData.descontos.length) ||
      (weeklyData.gunVan && weeklyData.gunVan.length) ||
      (weeklyData.veiculos && (weeklyData.veiculos.podium || weeklyData.veiculos.prizeRide))
  );
  const hasStructuredDiscounts = Boolean(weeklyData.descontos && weeklyData.descontos.length);

  const pages = hasStructuredData
    ? [createWeeklyRedditEmbed(weeklyData, { dailyData })]
    : [];

  const baseEmbed = () =>
    new EmbedBuilder()
      .setColor(CONSTANTS.COLORS.WEEKLY_EVENT)
      .setAuthor({
        name: `🚨 GTA Online — ${analysis.titulo || translateTitle(weeklyData.title) || 'Atualização Semanal'}`,
        url: weeklyData.url,
      })
      .setThumbnail(weeklyData.thumbnailUrl || CONSTANTS.THUMBNAILS.GTA_LOGO)
      .setTimestamp();

  const storeEmoji = {
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

  // ── Páginas da análise da IA ─────────────────────────────────────────────
  const aiSections = [];

  if (analysis.destaques || analysis.itensGratuitos) {
    aiSections.push({
      emoji: '📰',
      title: 'Destaques & Itens Gratuitos',
      fields: [
        { name: '🎉 Destaques da Semana', value: truncateField(analysis.destaques), inline: false },
        { name: '🎁 Itens Gratuitos / Recompensas', value: truncateField(analysis.itensGratuitos), inline: false },
      ],
    });
  }

  // Página de descontos/armas da IA só entra quando a página 1 (resumo
  // enxuto) não cobriu os descontos estruturados (ex.: fonte Newswire).
  if (!hasStructuredDiscounts) {
    const weaponsActive = discountedWeapons.length > 0;
    const hasStoreDiscounts = Boolean(weeklyData.discounts && weeklyData.discounts.length);
    const hasAiDiscounts = Boolean(analysis.veiculosDesconto);
    if (weaponsActive || hasStoreDiscounts || hasAiDiscounts) {
      let vehiclesText;
      if (hasStoreDiscounts) {
        const groups = groupDiscountsByStore(weeklyData.discounts);
        if (groups.length > 0) {
          vehiclesText = groups
            .filter((g) => g.store !== 'Outros')
            .map((g) => {
              const emoji = storeEmoji[g.store] || '🏪';
              return `**${emoji} ${g.store}**\n${g.vehicles.map((v) => `• ${v}`).join('\n')}`;
            })
            .join('\n\n');
        }
      }
      if (!vehiclesText) vehiclesText = analysis.veiculosDesconto || '*Nenhuma informação disponível.*';

      const weaponsText =
        discountedWeapons.length > 0
          ? discountedWeapons.map((w) => `• ${w.name} (-${w.discountPercent}%)`).join('\n')
          : '*Nenhuma arma com desconto ativo na Van de Armas hoje.*';

      aiSections.push({
        emoji: '🏷️',
        title: 'Descontos da Semana',
        fields: [
          { name: '🏷️ Itens com Desconto (por loja)', value: truncateField(vehiclesText), inline: false },
          { name: '🔫 Armas com Desconto (Van de Armas)', value: truncateField(weaponsText), inline: false },
        ],
      });
    }
  }

  if (analysis.melhorFarm || analysis.novidades) {
    aiSections.push({
      emoji: '💰',
      title: 'Farm & Novidades',
      fields: [
        { name: '💰 Melhores Pontos de Farm', value: truncateField(analysis.melhorFarm), inline: false },
        { name: '✨ Novidades da Semana', value: truncateField(analysis.novidades), inline: false },
      ],
    });
  }

  if (analysis.avaliacao) {
    aiSections.push({
      emoji: '📊',
      title: 'Avaliação da Semana',
      fields: [{ name: '📊 Nota da Yui', value: truncateField(analysis.avaliacao), inline: false }],
      footerText: 'Análise feita pela Yui com base no artigo oficial da Rockstar',
    });
  }

  const total = pages.length + aiSections.length;
  const startPage = pages.length; // congela a base antes do loop (pages cresce ao push)
  aiSections.forEach((s, i) => {
    const num = startPage + i + 1;
    let embed = baseEmbed()
      .setTitle(`${s.emoji} Página ${num}/${total} — ${s.title}`)
      .addFields(...s.fields);
    if (s.footerText) embed = embed.setFooter({ text: s.footerText });
    pages.push(embed);
  });

  // Garante que sempre haja ao menos uma página navegável.
  if (pages.length === 0) {
    pages.push(
      new EmbedBuilder()
        .setColor(CONSTANTS.COLORS.WEEKLY_EVENT)
        .setTitle('🔎 GTA Online — Sem dados disponíveis')
        .setDescription('Nenhuma informação semanal disponível no momento.')
        .setTimestamp()
    );
  }

  return pages;
}

/**
 * Monta a linha de botões de navegação (◀️ Anterior / Página X de Y / Próxima ▶️).
 * pageIndex é 0-based.
 */
export function buildWeeklyPaginationRow(pageIndex, totalPages, idPrefix = 'weekly_page') {
  return new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`${idPrefix}_prev_${pageIndex}`)
      .setLabel('⬅️ Anterior')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex <= 0),
    new ButtonBuilder()
      .setCustomId(`${idPrefix}_indicator`)
      .setLabel(`Página ${pageIndex + 1}/${totalPages}`)
      .setStyle(ButtonStyle.Primary)
      .setDisabled(true),
    new ButtonBuilder()
      .setCustomId(`${idPrefix}_next_${pageIndex}`)
      .setLabel('Próxima ➡️')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pageIndex >= totalPages - 1)
  );
}
