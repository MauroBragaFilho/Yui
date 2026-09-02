import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { resolveChannel } from '../../handlers/youtubeApiHandler.js';

export const seguirYoutubeCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-seguir-youtube')
      .setDescription('[Admin] Passa a anunciar vídeos/Shorts/lives de um canal do YouTube neste servidor.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option
          .setName('canal')
          .setDescription('Handle do canal (ex: @Canal), ID (UC...) ou URL completa do YouTube')
          .setRequired(true)
      )
      .addChannelOption((option) =>
        option
          .setName('canal_discord')
          .setDescription('Canal do Discord onde os anúncios serão publicados')
          .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement)
          .setRequired(true)
      )
      .addRoleOption((option) =>
        option
          .setName('cargo')
          .setDescription('Cargo a ser mencionado nos anúncios (opcional)')
          .setRequired(false)
      )
      .addBooleanOption((option) =>
        option
          .setName('notificar_videos')
          .setDescription('Anunciar vídeos comuns (padrão: sim)')
          .setRequired(false)
      )
      .addBooleanOption((option) =>
        option
          .setName('notificar_shorts')
          .setDescription('Anunciar Shorts (padrão: sim)')
          .setRequired(false)
      )
      .addBooleanOption((option) =>
        option
          .setName('notificar_lives')
          .setDescription('Anunciar lives (agendada/ao vivo/encerrada) (padrão: sim)')
          .setRequired(false)
      )
  ),

  async execute(interaction) {
    const input = interaction.options.getString('canal', true);
    const discordChannel = interaction.options.getChannel('canal_discord', true);
    const mentionRole = interaction.options.getRole('cargo');
    const notifyVideos = interaction.options.getBoolean('notificar_videos') ?? true;
    const notifyShorts = interaction.options.getBoolean('notificar_shorts') ?? true;
    const notifyLives = interaction.options.getBoolean('notificar_lives') ?? true;

    if (!interaction.guildId) {
      return interaction.reply({
        content: '❌ Este comando só pode ser usado em um servidor.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    let resolved;
    try {
      resolved = await resolveChannel(input);
    } catch (err) {
      return interaction.editReply({
        content: `❌ Falha ao consultar a API do YouTube: ${err.message}`,
      });
    }

    if (!resolved) {
      return interaction.editReply({
        content: `❌ Não encontrei o canal "${input}". Confira o handle (@Canal), o ID (UC...) ou a URL.`,
      });
    }

    const result = youtubeRepository.addSubscription({
      guildId: interaction.guildId,
      youtubeChannelId: resolved.channelId,
      channelName: resolved.title,
      uploadsPlaylistId: resolved.uploadsPlaylistId,
      discordChannelId: discordChannel.id,
      mentionRoleId: mentionRole ? mentionRole.id : null,
      notifyVideos: notifyVideos ? 1 : 0,
      notifyShorts: notifyShorts ? 1 : 0,
      notifyLives: notifyLives ? 1 : 0,
    });

    const preferences = [
      notifyVideos ? '📹 Vídeos' : null,
      notifyShorts ? '📱 Shorts' : null,
      notifyLives ? '🔴 Lives' : null,
    ].filter(Boolean).join(', ');

    if (result.changes === 0) {
      return interaction.editReply({
        content: `⚠️ Este servidor **já segue** o canal **${resolved.title}** neste canal (${discordChannel}).`,
      });
    }

    return interaction.editReply({
      content:
        `✅ **Agora seguindo!**\n\n` +
        `📺 **Canal:** ${resolved.title}\n` +
        `📍 **Publicação:** ${discordChannel}\n` +
        `${mentionRole ? `👥 **Menção:** <@&${mentionRole.id}>\n` : ''}` +
        `🔔 **Notificações:** ${preferences}`,
    });
  },
};