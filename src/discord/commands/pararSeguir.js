import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { twitchRepository } from '../../database/repositories/twitchRepo.js';

export const pararSeguirCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-parar-seguir')
      .setDescription('[Admin] Para de seguir um canal do YouTube ou streamer da Twitch neste servidor.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option
          .setName('plataforma')
          .setDescription('Plataforma do alvo')
          .setRequired(true)
          .addChoices(
            { name: 'YouTube', value: 'youtube' },
            { name: 'Twitch', value: 'twitch' }
          )
      )
      .addStringOption((option) =>
        option
          .setName('alvo')
          .setDescription('ID do canal (UC...) para YouTube ou login para Twitch')
          .setRequired(true)
      )
  ),

  async execute(interaction) {
    const platform = interaction.options.getString('plataforma', true);
    const target = interaction.options.getString('alvo', true);

    if (!interaction.guildId) {
      return interaction.reply({
        content: '❌ Este comando só pode ser usado em um servidor.',
        ephemeral: true,
      });
    }

    if (platform === 'youtube') {
      const result = youtubeRepository.removeByGuildAndChannel(interaction.guildId, target);
      if (result.changes === 0) {
        return interaction.reply({
          content: `⚠️ Este servidor não estava seguindo o canal YouTube **${target}**.`,
          ephemeral: true,
        });
      }
      return interaction.reply({
        content: `✅ Parei de seguir o canal do YouTube **${target}** neste servidor.`,
        ephemeral: true,
      });
    }

    if (platform === 'twitch') {
      const login = target.toLowerCase().replace(/^@/, '');
      const result = twitchRepository.removeByGuildAndLogin(interaction.guildId, login);
      if (result.changes === 0) {
        return interaction.reply({
          content: `⚠️ Este servidor não estava seguindo o streamer **${login}**.`,
          ephemeral: true,
        });
      }
      return interaction.reply({
        content: `✅ Parei de seguir o streamer **${login}** neste servidor.`,
        ephemeral: true,
      });
    }

    return interaction.reply({
      content: '❌ Plataforma inválida.',
      ephemeral: true,
    });
  },
};