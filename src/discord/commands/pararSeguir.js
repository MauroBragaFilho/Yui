import { SlashCommandBuilder, PermissionFlagsBits } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { twitchRepository } from '../../database/repositories/twitchRepo.js';
import { clampText } from '../embedLimits.js';

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
    // Eco do que o usuário digitou: no máximo 100 caracteres (a opção aceita até 6000 e a mensagem, 2000).
    const shownTarget = clampText(target, 100);

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
          content: `⚠️ Este servidor não estava seguindo o canal YouTube **${shownTarget}**.`,
          ephemeral: true,
        });
      }
      return interaction.reply({
        content: `✅ Parei de seguir o canal do YouTube **${shownTarget}** neste servidor.`,
        ephemeral: true,
      });
    }

    if (platform === 'twitch') {
      const login = target.toLowerCase().replace(/^@/, '');
      const shownLogin = clampText(login, 100);
      const result = twitchRepository.removeByGuildAndLogin(interaction.guildId, login);
      if (result.changes === 0) {
        return interaction.reply({
          content: `⚠️ Este servidor não estava seguindo o streamer **${shownLogin}**.`,
          ephemeral: true,
        });
      }
      return interaction.reply({
        content: `✅ Parei de seguir o streamer **${shownLogin}** neste servidor.`,
        ephemeral: true,
      });
    }

    return interaction.reply({
      content: '❌ Plataforma inválida.',
      ephemeral: true,
    });
  },
};