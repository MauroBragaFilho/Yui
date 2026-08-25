import { SlashCommandBuilder } from 'discord.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { gtaoEngine } from '../../engines/gtao/index.js';
import { createWeeklyEmbed } from '../embeds/weeklyEmbed.js';

export const weeklyCommand = {
  data: new SlashCommandBuilder()
    .setName('yui-semanal')
    .setDescription('Consulta sob demanda os eventos e descontos da semana atual no GTA Online.'),

  async execute(interaction) {
    await interaction.deferReply();

    let weeklyData = gtaoRepository.getLatestWeekly()?.data;

    // Se ainda não tiver no banco local, tenta coletar agora
    if (!weeklyData) {
      weeklyData = await gtaoEngine.collectWeekly();
    }

    if (!weeklyData) {
      return interaction.editReply({
        content: '❌ Não foi possível carregar os dados do evento semanal no momento.',
      });
    }

    const embed = createWeeklyEmbed(weeklyData);
    return interaction.editReply({ embeds: [embed] });
  },
};
