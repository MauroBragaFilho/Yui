import { SlashCommandBuilder } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { gtaoEngine } from '../../engines/gtao/index.js';
import { weeklyService } from '../../engines/gtao/systems/weekly/service.js';
import { buildWeeklyPaginatedEmbeds, buildWeeklyPaginationRow } from '../../engines/gtao/weeklyAnalysis.js';
import { getCurrentWeekKey } from '../../utils/weekKey.js';
import { logger } from '../../utils/logger.js';

export const weeklyCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('gta-semanal')
      .setDescription('Consulta sob demanda os eventos, descontos e a análise da IA sobre a semana atual do GTA Online.')
      .addStringOption(opt =>
        opt
          .setName('fonte')
          .setDescription('Fonte dos dados semanais (padrão: Reddit)')
          .setRequired(false)
          .addChoices(
            { name: '🌐 Reddit r/gtaonline (padrão)', value: 'reddit' },
            { name: '📰 Rockstar Newswire', value: 'newswire' },
          )
      )
  ),

  async execute(interaction) {
    await interaction.deferReply();

    const source = interaction.options.getString('fonte') || 'reddit';
    const currentWeekKey = getCurrentWeekKey();

    // ── Cache: verifica se já temos dados para esta semana e fonte ───
    const latest = gtaoRepository.getLatestWeekly();
    let weeklyData = latest?.data;

    let needsCollect = false;

    if (!latest || latest.event_week !== currentWeekKey) {
      // Sem cache para esta semana → precisa coletar
      needsCollect = true;
    } else if (weeklyData?.source !== source) {
      // Fonte diferente da solicitada → precisa coletar da nova fonte
      needsCollect = true;
    } else if (source === 'reddit' && weeklyData?.id) {
      // Para Reddit: verifica se o post mudou desde o último cache.
      // Isso resolve o caso de publicação na quarta (Reddit) vs troca de
      // semana na quinta (jogo) — se um post novo apareceu, re-coleta.
      try {
        const latestRedditPost = await weeklyService.getLatest();
        if (latestRedditPost && latestRedditPost.id !== weeklyData.id) {
          logger.info(`[GTA-Semanal] Novo post Reddit detectado (${latestRedditPost.id} ≠ ${weeklyData.id}). Re-coletando...`);
          needsCollect = true;
        }
      } catch (err) {
        // Se o Reddit estiver indisponível, usa o cache silenciosamente.
        logger.warn(`[GTA-Semanal] Não foi possível verificar Reddit (${err.message}); usando cache.`);
      }
    }

    if (needsCollect) {
      logger.info(`[GTA-Semanal] Coletando dados da fonte "${source}"...`);
      try {
        weeklyData = await gtaoEngine.collectWeekly({ source });
      } catch (err) {
        logger.error(`[GTA-Semanal] Falha ao coletar da fonte "${source}": ${err.message}`);
      }

      // Fallback: se a coleta retornou null (ex: Reddit 403 tratado) ou lançou
      // exceção, e temos cache do mesmo semana, usa ele como backup.
      if (!weeklyData && latest?.data && latest.event_week === currentWeekKey) {
        logger.info('[GTA-Semanal] Coleta sem dados; usando cache da semana como fallback.');
        weeklyData = latest.data;
      }
    }

    if (!weeklyData) {
      return interaction.editReply({
        content: '❌ Não foi possível carregar os dados do evento semanal no momento. Tente novamente em alguns minutos.',
      });
    }

    // Dados diários (Van de Armas, Comerciantes, etc.) usados para as armas
    // com desconto na página 2. Sempre pega o snapshot mais recente do
    // banco, mesmo que a semana já tenha sido coletada em outro dia.
    const dailyData = gtaoRepository.getLatestDaily()?.data;

    const pages = buildWeeklyPaginatedEmbeds(weeklyData, dailyData);
    let currentPage = 0;

    const message = await interaction.editReply({
      embeds: [pages[currentPage]],
      components: [buildWeeklyPaginationRow(currentPage, pages.length)],
    });

    const collector = message.createMessageComponentCollector({ time: 5 * 60 * 1000 });

    collector.on('collect', async (i) => {
      if (i.user.id !== interaction.user.id) {
        return i.reply({ content: '❌ Apenas quem executou o comando pode navegar entre as páginas.', ephemeral: true });
      }

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
      interaction.editReply({ components: [] }).catch(() => null);
    });
  },
};
