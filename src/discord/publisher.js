import { guildRepository } from '../database/repositories/guildRepo.js';
import { publicationRepository } from '../database/repositories/publicationRepo.js';
import { gtaoRepository } from '../database/repositories/gtaoRepo.js';
import { createNewswireEmbed } from './embeds/newswireEmbed.js';
import { createDailyEmbed } from './embeds/dailyEmbed.js';
import { buildWeeklyPaginatedEmbeds, buildWeeklyPaginationRow } from '../engines/gtao/weeklyAnalysis.js';
import { logger } from '../utils/logger.js';

// Tempo que os botões de paginação do embed semanal automático ficam
// ativos após a publicação. Depois disso, os botões são desativados
// (a mensagem continua visível, só a navegação para de funcionar —
// o histórico completo sempre pode ser revisto com /gta-semanal).
const WEEKLY_PAGINATION_ACTIVE_MS = 24 * 60 * 60 * 1000; // 24h

export const discordPublisher = {
  /**
   * Publica uma lista de artigos novos em todos os servidores configurados
   */
  async publishNews(client, articles) {
    if (!articles || articles.length === 0) return;

    // O artigo identificado como "atualização semanal" não deve ser publicado
    // como notícia crua com link — ele já é coberto pelo embed paginado com
    // análise da IA em publishWeekly(), então publicá-lo aqui de novo seria
    // duplicado.
    const latestWeeklyUrl = gtaoRepository.getLatestWeekly()?.data?.url || null;

    const guilds = guildRepository.getAll();
    for (const article of articles) {
      if (latestWeeklyUrl && article.url === latestWeeklyUrl) {
        logger.info(`[Publisher] Pulando publicação como notícia comum (já coberto pelo resumo semanal): ${article.url}`);
        continue;
      }

      const embed = createNewswireEmbed(article);

      for (const g of guilds) {
        if (!g.news_channel_id) continue;

        // Evitar republicação caso já tenha sido enviada para este servidor
        if (publicationRepository.isPublished('news', article.id, g.guild_id)) {
          continue;
        }

        try {
          const channel = await client.channels.fetch(g.news_channel_id);
          if (channel && channel.isTextBased()) {
            const msg = await channel.send({ embeds: [embed] });
            publicationRepository.recordPublication('news', article.id, g.guild_id, g.news_channel_id, msg.id);
            logger.info(`[Publisher] Notícia "${article.title}" publicada na guilda ${g.guild_id}`);
          }
        } catch (error) {
          logger.error(`[Publisher] Falha ao enviar notícia para canal ${g.news_channel_id} (Guild: ${g.guild_id}): ${error.message}`);
        }
      }
    }
  },

  /**
   * Publica o resumo do reset diário em todos os servidores configurados
   */
  async publishDaily(client, dailyData) {
    if (!dailyData) return;

    const guilds = guildRepository.getAll();
    const embed = createDailyEmbed(dailyData);
    const dateKey = dailyData.date || new Date().toISOString().split('T')[0];

    for (const g of guilds) {
      if (!g.daily_channel_id) continue;

      if (publicationRepository.isPublished('daily', dateKey, g.guild_id)) {
        continue;
      }

      try {
        const channel = await client.channels.fetch(g.daily_channel_id);
        if (channel && channel.isTextBased()) {
          const msg = await channel.send({ embeds: [embed] });
          publicationRepository.recordPublication('daily', dateKey, g.guild_id, g.daily_channel_id, msg.id);
          logger.info(`[Publisher] Reset Diário [${dateKey}] publicado na guilda ${g.guild_id}`);
        }
      } catch (error) {
        logger.error(`[Publisher] Falha ao enviar diário para canal ${g.daily_channel_id}: ${error.message}`);
      }
    }
  },

  /**
   * Publica o evento semanal em todos os servidores configurados como um
   * embed paginado (4 páginas: destaques/gratuitos, descontos, farm/novidades,
   * avaliação), com a análise da IA já pré-calculada e salva em weeklyData
   * pelo gtaoEngine.collectWeekly() — não faz nenhuma chamada de IA aqui.
   */
  async publishWeekly(client, weeklyData, weekKey) {
    if (!weeklyData) return;

    const guilds = guildRepository.getAll();

    if (!weeklyData.analysis) {
      logger.warn('[Publisher] weeklyData sem análise da IA anexada — publicando mesmo assim com aviso nos campos.');
    }

    const dailyData = gtaoRepository.getLatestDaily()?.data;
    const pages = buildWeeklyPaginatedEmbeds(weeklyData, dailyData);

    for (const g of guilds) {
      if (!g.weekly_channel_id) continue;

      if (publicationRepository.isPublished('weekly', weekKey, g.guild_id)) {
        continue;
      }

      try {
        const channel = await client.channels.fetch(g.weekly_channel_id);
        if (channel && channel.isTextBased()) {
          let currentPage = 0;
          const msg = await channel.send({
            embeds: [pages[currentPage]],
            components: [buildWeeklyPaginationRow(currentPage, pages.length)],
          });
          publicationRepository.recordPublication('weekly', weekKey, g.guild_id, g.weekly_channel_id, msg.id);
          logger.info(`[Publisher] Evento Semanal [${weekKey}] (paginado, com análise da IA) publicado na guilda ${g.guild_id}`);

          const collector = msg.createMessageComponentCollector({ time: WEEKLY_PAGINATION_ACTIVE_MS });

          collector.on('collect', async (i) => {
            if (i.customId.startsWith('weekly_page_prev_')) {
              currentPage = Math.max(0, currentPage - 1);
            } else if (i.customId.startsWith('weekly_page_next_')) {
              currentPage = Math.min(pages.length - 1, currentPage + 1);
            } else {
              return i.deferUpdate().catch(() => null);
            }

            await i.update({
              embeds: [pages[currentPage]],
              components: [buildWeeklyPaginationRow(currentPage, pages.length)],
            });
          });

          collector.on('end', () => {
            msg.edit({ components: [] }).catch(() => null);
          });
        }
      } catch (error) {
        logger.error(`[Publisher] Falha ao enviar semanal para canal ${g.weekly_channel_id}: ${error.message}`);
      }
    }
  },
};
