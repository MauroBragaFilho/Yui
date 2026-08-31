import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { generateResponse } from '../../handlers/llmHandler.js';
import { logger } from '../../utils/logger.js';
import { CONSTANTS } from '../../config/constants.js';

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
    `Você é a Yui, especialista em GTA Online. Analise o artigo semanal oficial abaixo e responda ` +
    `ESTRITAMENTE em formato JSON válido, sem markdown code fences, sem texto antes ou depois, ` +
    `contendo exatamente estas chaves (todas como string, usando formatação Discord: negrito, listas com "•", emojis):\n\n` +
    `{\n` +
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
    `\n--- ARTIGO OFICIAL DA SEMANA (traduzido) ---\nTítulo: ${weeklyData.title}\n\n${weeklyData.fullText || weeklyData.summary}`
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

const ANALYSIS_KEYS = ['destaques', 'itensGratuitos', 'veiculosDesconto', 'novidades', 'melhorFarm', 'avaliacao'];

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
 * Monta as 4 páginas do embed semanal:
 *   Página 1 — Destaques da Semana + Itens Gratuitos
 *   Página 2 — Veículos com Desconto + Armas com Desconto (Van de Armas)
 *   Página 3 — Melhores Pontos de Farm + Novidades da Semana
 *   Página 4 — Avaliação da Semana
 *
 * Retorna um array de 4 EmbedBuilder, prontos para navegação por botão.
 */
export function buildWeeklyPaginatedEmbeds(weeklyData, dailyData) {
  const analysis = weeklyData.analysis || {};
  const discountedWeapons = getGunVanDiscountedWeapons(dailyData);

  const baseEmbed = () =>
    new EmbedBuilder()
      .setColor(CONSTANTS.COLORS.WEEKLY_EVENT)
      .setAuthor({ name: `🚨 GTA Online — ${weeklyData.title || 'Atualização Semanal'}`, url: weeklyData.url })
      .setThumbnail(weeklyData.thumbnailUrl || CONSTANTS.THUMBNAILS.GTA_LOGO)
      .setTimestamp();

  const pages = [];

  // Página 1 — Destaques + Itens Gratuitos
  pages.push(
    baseEmbed()
      .setTitle('📰 Página 1/4 — Destaques & Itens Gratuitos')
      .addFields(
        { name: '🎉 Destaques da Semana', value: truncateField(analysis.destaques), inline: false },
        { name: '🎁 Itens Gratuitos / Recompensas', value: truncateField(analysis.itensGratuitos), inline: false }
      )
  );

  // Página 2 — Veículos em desconto + Armas em desconto (Van de Armas)
  const weaponsText =
    discountedWeapons.length > 0
      ? discountedWeapons.map((w) => `• ${w.name} (-${w.discountPercent}%)`).join('\n')
      : '*Nenhuma arma com desconto ativo na Van de Armas hoje.*';

  pages.push(
    baseEmbed()
      .setTitle('🏷️ Página 2/4 — Descontos da Semana')
      .addFields(
        { name: '🚗 Veículos com Desconto', value: truncateField(analysis.veiculosDesconto), inline: false },
        { name: '🔫 Armas com Desconto (Van de Armas)', value: truncateField(weaponsText), inline: false }
      )
  );

  // Página 3 — Melhor farm + Novidades
  pages.push(
    baseEmbed()
      .setTitle('💰 Página 3/4 — Farm & Novidades')
      .addFields(
        { name: '💰 Melhores Pontos de Farm', value: truncateField(analysis.melhorFarm), inline: false },
        { name: '✨ Novidades da Semana', value: truncateField(analysis.novidades), inline: false }
      )
  );

  // Página 4 — Avaliação da semana
  pages.push(
    baseEmbed()
      .setTitle('📊 Página 4/4 — Avaliação da Semana')
      .addFields({ name: '📊 Nota da Yui', value: truncateField(analysis.avaliacao), inline: false })
      .setFooter({ text: 'Análise feita pela Yui com base no artigo oficial da Rockstar' })
  );

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
