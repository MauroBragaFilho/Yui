import { SlashCommandBuilder } from 'discord.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { gtaoEngine } from '../../engines/gtao/index.js';
import { buildWeeklyPaginatedEmbeds, buildWeeklyPaginationRow } from '../../engines/gtao/weeklyAnalysis.js';

function getCurrentWeekKey() {
  const d = new Date();
  const year = d.getUTCFullYear();
  const onejan = new Date(year, 0, 1);
  const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
  return `${year}-W${String(week).padStart(2, '0')}`;
}

export const weeklyCommand = {
  data: new SlashCommandBuilder()
    .setName('gta-semanal')
    .setDescription('Consulta sob demanda os eventos, descontos e a análise da IA sobre a semana atual do GTA Online.'),

  async execute(interaction) {
    await interaction.deferReply();

    const currentWeekKey = getCurrentWeekKey();
    const latest = gtaoRepository.getLatestWeekly();
    let weeklyData = latest?.data;

    // Só reaproveita o cache se ele for realmente da semana atual — evita
    // a Yui ficar presa numa atualização antiga já salva no banco.
    if (!weeklyData || latest.event_week !== currentWeekKey) {
      const fresh = await gtaoEngine.collectWeekly();
      if (fresh) weeklyData = fresh;
    }

    if (!weeklyData) {
      return interaction.editReply({
        content: '❌ Não foi possível carregar os dados do evento semanal no momento.',
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
