import { SlashCommandBuilder, EmbedBuilder, PermissionFlagsBits } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { twitchRepository } from '../../database/repositories/twitchRepo.js';

export const listarSeguindoCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-listar-seguindo')
      .setDescription('[Admin] Lista todos os canais do YouTube e streamers da Twitch que este servidor está monitorando.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
  ),

  async execute(interaction) {
    if (!interaction.guildId) {
      return interaction.reply({
        content: '❌ Este comando só pode ser usado em um servidor.',
        ephemeral: true,
      });
    }

    const youtubeSubs = youtubeRepository.getSubscriptionsByGuild(interaction.guildId);
    const twitchSubs = twitchRepository.getSubscriptionsByGuild(interaction.guildId);

    const embed = new EmbedBuilder()
      .setColor(0x2ECC71)
      .setTitle('📡 Monitoramento Social deste servidor');

    const youtubeLines = youtubeSubs.map((sub, i) => {
      const prefs = [
        sub.notify_videos === 1 ? '📹' : null,
        sub.notify_shorts === 1 ? '📱' : null,
        sub.notify_lives === 1 ? '🔴' : null,
      ].filter(Boolean).join(' ');
      const roleMention = sub.mention_role_id ? ` · <@&${sub.mention_role_id}>` : '';
      return `${i + 1}. **${sub.channel_name || sub.youtube_channel_id}**\n   └ <#${sub.discord_channel_id}> ${prefs}${roleMention}`;
    });

    const twitchLines = twitchSubs.map((sub, i) => {
      const roleMention = sub.mention_role_id ? ` · <@&${sub.mention_role_id}>` : '';
      return `${i + 1}. **${sub.twitch_login}**\n   └ <#${sub.discord_channel_id}> 🔴${roleMention}`;
    });

    if (youtubeLines.length > 0) {
      embed.addFields({ name: `📺 YouTube (${youtubeLines.length})`, value: youtubeLines.join('\n'), inline: false });
    }
    if (twitchLines.length > 0) {
      embed.addFields({ name: `🎮 Twitch (${twitchLines.length})`, value: twitchLines.join('\n'), inline: false });
    }

    if (youtubeLines.length === 0 && twitchLines.length === 0) {
      embed.setDescription(
        'Nenhum canal monitorado neste servidor ainda.\n\n' +
          'Use **/yui-seguir-youtube** para acompanhar um canal do YouTube ou **/yui-seguir-twitch** para acompanhar um streamer.'
      );
    }

    return interaction.reply({ embeds: [embed], ephemeral: true });
  },
};