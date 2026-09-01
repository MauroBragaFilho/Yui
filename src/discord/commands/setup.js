import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { guildRepository } from '../../database/repositories/guildRepo.js';

export const setupCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-configurar')
      .setDescription('Configura os canais de transmissão da Yui neste servidor.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addChannelOption((option) =>
        option
          .setName('noticias')
          .setDescription('Canal onde serão publicadas as notícias do Rockstar Newswire')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      )
      .addChannelOption((option) =>
        option
          .setName('diario')
          .setDescription('Canal onde serão publicados os resets diários (Gun Van, Dealers, etc.)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      )
      .addChannelOption((option) =>
        option
          .setName('semanal')
          .setDescription('Canal onde serão publicadas as atualizações semanais (Bônus, Pódio, etc.)')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(false)
      )
  ),

  async execute(interaction) {
    const newsChannel = interaction.options.getChannel('noticias');
    const dailyChannel = interaction.options.getChannel('diario');
    const weeklyChannel = interaction.options.getChannel('semanal');

    if (!newsChannel && !dailyChannel && !weeklyChannel) {
      return interaction.reply({
        content: '⚠️ Por favor, selecione ao menos um canal para configurar.',
        ephemeral: true,
      });
    }

    const updates = [];
    if (newsChannel) {
      guildRepository.setChannel(interaction.guildId, 'news_channel_id', newsChannel.id);
      updates.push(`📰 **Notícias:** ${newsChannel}`);
    }
    if (dailyChannel) {
      guildRepository.setChannel(interaction.guildId, 'daily_channel_id', dailyChannel.id);
      updates.push(`📅 **Reset Diário:** ${dailyChannel}`);
    }
    if (weeklyChannel) {
      guildRepository.setChannel(interaction.guildId, 'weekly_channel_id', weeklyChannel.id);
      updates.push(`🎁 **Atualização Semanal:** ${weeklyChannel}`);
    }

    return interaction.reply({
      content: `✅ **Configurações salvas com sucesso para este servidor:**\n\n${updates.join('\n')}`,
      ephemeral: true,
    });
  },
};
