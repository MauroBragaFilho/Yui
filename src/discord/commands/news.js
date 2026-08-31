import { SlashCommandBuilder } from 'discord.js';
import { newsRepository } from '../../database/repositories/newsRepo.js';
import { newswireEngine } from '../../engines/newswire/index.js';
import { createNewswireEmbed } from '../embeds/newswireEmbed.js';

export const newsCommand = {
  data: new SlashCommandBuilder()
    .setName('gta-noticias')
    .setDescription('Exibe as últimas notícias publicadas no Rockstar Newswire.')
    .addIntegerOption((option) =>
      option
        .setName('quantidade')
        .setDescription('Quantas notícias exibir (padrão: 2)')
        .setMinValue(1)
        .setMaxValue(5)
        .setRequired(false)
    ),

  async execute(interaction) {
    await interaction.deferReply();

    const quantidade = interaction.options.getInteger('quantidade') || 2;

    let latest = newsRepository.getLatest(quantidade);
    if (!latest || latest.length === 0) {
      await newswireEngine.checkLatestNews();
      latest = newsRepository.getLatest(quantidade);
    }

    if (!latest || latest.length === 0) {
      return interaction.editReply({
        content: '📰 Nenhuma notícia encontrada no banco de dados no momento.',
      });
    }

    const embeds = latest.map((art) => createNewswireEmbed(art));
    return interaction.editReply({ embeds });
  },
};
