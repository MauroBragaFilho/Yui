import { SlashCommandBuilder } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { gtaoEngine } from '../../engines/gtao/index.js';
import { weeklyService } from '../../engines/gtao/systems/weekly/service.js';
import { buildWeeklyCombinedEmbeds, buildWeeklyPaginationRow } from '../../engines/gtao/weeklyAnalysis.js';
import { getCurrentWeekKey, weeklyRowAgeHours, NEWSWIRE_CACHE_HOURS } from '../../utils/weekKey.js';
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

    // Registro que não é um semanal (ex.: artigo do Newswire gravado como semanal) sai do banco antes de qualquer coisa.
    try { gtaoRepository.purgeInvalidWeekly?.(); } catch { /* sem limpeza: segue */ }

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

      // Reddit bloqueado (403 tratado) ou sem resposta: tenta o artigo semanal do Rockstar Newswire (oficial, escolhido por pontuação).
      // Se o cache desta semana JÁ é do Newswire e recente, não repete a coleta (cada uma gasta chamadas de IA).
      if (!weeklyData && source === 'reddit') {
        const cacheNewswireFresco = latest?.event_week === currentWeekKey && latest?.data?.source === 'newswire'
          && weeklyRowAgeHours(latest) <= NEWSWIRE_CACHE_HOURS;
        if (!cacheNewswireFresco) {
          try { weeklyData = await gtaoEngine.collectWeekly({ source: 'newswire' }); } catch (err) {
            logger.warn(`[GTA-Semanal] Newswire também falhou: ${err.message}`);
          }
        }
      }

      // Fallback: se a coleta retornou null (ex: Reddit 403 tratado) ou lançou
      // exceção, e temos cache do mesmo semana, usa ele como backup.
      if (!weeklyData && latest?.data && latest.event_week === currentWeekKey) {
        logger.info('[GTA-Semanal] Coleta sem dados; usando cache da semana como fallback.');
        weeklyData = latest.data;
      }
    }

    // Sem a coleta desta semana: mostra o último semanal VÁLIDO guardado (de outra semana), com aviso, em vez de erro.
    let staleNote = '';
    if (!weeklyData) {
      const old = gtaoRepository.getLatestValidWeekly?.();
      if (old?.data) {
        weeklyData = old.data;
        staleNote = `⚠️ Estes são os dados da semana anterior (${old.event_week}${old.data.periodo ? `, período: ${typeof old.data.periodo === 'string' ? old.data.periodo : JSON.stringify(old.data.periodo)}` : ''}). Não consegui buscar a desta semana agora; o evento pode já ter mudado.`;
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

    const pages = buildWeeklyCombinedEmbeds(weeklyData, dailyData);
    let currentPage = 0;

    const message = await interaction.editReply({
      ...(staleNote ? { content: staleNote } : {}),
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
