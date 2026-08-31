import { SlashCommandBuilder } from 'discord.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { gtaoEngine } from '../../engines/gtao/index.js';
import { createDailyEmbed } from '../embeds/dailyEmbed.js';

export const dailyCommand = {
  data: new SlashCommandBuilder()
    .setName('gta-diario')
    .setDescription('Consulta sob demanda o resumo diário atual do GTA Online (Gun Van, Dealers, etc.).'),

  async execute(interaction) {
    await interaction.deferReply();

    const todayStr = new Date().toISOString().split('T')[0];
    let dailyData = gtaoRepository.getDaily(todayStr)?.data;

    // Se ainda não tiver no banco local para hoje, realiza a coleta imediatamente
    if (!dailyData) {
      dailyData = await gtaoEngine.collectDaily();
    }

    if (!dailyData) {
      return interaction.editReply({
        content: '❌ Não foi possível carregar os dados do reset diário no momento.',
      });
    }

    const embed = createDailyEmbed(dailyData);
    return interaction.editReply({ embeds: [embed] });
  },
};
