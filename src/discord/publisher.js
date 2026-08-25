import { guildRepository } from '../database/repositories/guildRepo.js';
import { publicationRepository } from '../database/repositories/publicationRepo.js';
import { createNewswireEmbed } from './embeds/newswireEmbed.js';
import { createDailyEmbed } from './embeds/dailyEmbed.js';
import { createWeeklyEmbed } from './embeds/weeklyEmbed.js';
import { logger } from '../utils/logger.js';

export const discordPublisher = {
  /**
   * Publica uma lista de artigos novos em todos os servidores configurados
   */
  async publishNews(client, articles) {
    if (!articles || articles.length === 0) return;

    const guilds = guildRepository.getAll();
    for (const article of articles) {
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
   * Publica o evento semanal em todos os servidores configurados
   */
  async publishWeekly(client, weeklyData, weekKey) {
    if (!weeklyData) return;

    const guilds = guildRepository.getAll();
    const embed = createWeeklyEmbed(weeklyData);

    for (const g of guilds) {
      if (!g.weekly_channel_id) continue;

      if (publicationRepository.isPublished('weekly', weekKey, g.guild_id)) {
        continue;
      }

      try {
        const channel = await client.channels.fetch(g.weekly_channel_id);
        if (channel && channel.isTextBased()) {
          const msg = await channel.send({ embeds: [embed] });
          publicationRepository.recordPublication('weekly', weekKey, g.guild_id, g.weekly_channel_id, msg.id);
          logger.info(`[Publisher] Evento Semanal [${weekKey}] publicado na guilda ${g.guild_id}`);
        }
      } catch (error) {
        logger.error(`[Publisher] Falha ao enviar semanal para canal ${g.weekly_channel_id}: ${error.message}`);
      }
    }
  },
};
