import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { youtubeRepository } from '../../database/repositories/youtubeRepo.js';
import { normalizeLiveMode } from '../../database/liveModes.js';
import { resolveChannel } from '../../handlers/youtubeApiHandler.js';
import { clampText } from '../embedLimits.js';

const LIVE_MODE_LABELS = {
  auto: 'automático (edita a mensagem se a live começa logo; senão avisa de novo)',
  new: 'mensagem nova a cada etapa',
  edit: 'editar sempre a mesma mensagem',
};

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
      .addStringOption((option) =>
        option
          .setName('modo_live')
          .setDescription('Como avisar as lives: automático (padrão), mensagem nova a cada etapa, ou editar a mesma mensagem')
          .addChoices(
            { name: 'Automático (edita se a live começa logo; senão avisa de novo)', value: 'auto' },
            { name: 'Mensagem nova a cada etapa', value: 'new' },
            { name: 'Editar sempre a mesma mensagem', value: 'edit' }
          )
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
    const liveModeOption = interaction.options.getString('modo_live');
    const liveMode = normalizeLiveMode(liveModeOption);

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
        content: `❌ Falha ao consultar a API do YouTube: ${clampText(err?.message, 200)}`,
      });
    }

    if (!resolved) {
      return interaction.editReply({
        content: `❌ Não encontrei o canal "${clampText(input, 100)}". Confira o handle (@Canal), o ID (UC...) ou a URL.`,
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
      liveMode,
    });

    const preferences = [
      notifyVideos ? '📹 Vídeos' : null,
      notifyShorts ? '📱 Shorts' : null,
      notifyLives ? '🔴 Lives' : null,
    ].filter(Boolean).join(', ');

    if (result.changes === 0) {
      // Já seguia: se o admin escolheu o modo de live, atualiza só isso (é assim que se muda o modo de uma inscrição que já existe).
      if (liveModeOption) {
        youtubeRepository.setLiveMode(interaction.guildId, resolved.channelId, discordChannel.id, liveMode);
        return interaction.editReply({
          content: `🔁 Já seguia **${clampText(resolved.title, 100)}** em ${discordChannel}. Atualizei o modo das lives: **${LIVE_MODE_LABELS[liveMode]}**.`,
        });
      }
      return interaction.editReply({
        content: `⚠️ Este servidor **já segue** o canal **${clampText(resolved.title, 100)}** neste canal (${discordChannel}).`,
      });
    }

    return interaction.editReply({
      content:
        `✅ **Agora seguindo!**\n\n` +
        `📺 **Canal:** ${clampText(resolved.title, 100)}\n` +
        `📍 **Publicação:** ${discordChannel}\n` +
        `${mentionRole ? `👥 **Menção:** <@&${mentionRole.id}>\n` : ''}` +
        `🔔 **Notificações:** ${preferences}
` +
        `🔴 **Modo das lives:** ${LIVE_MODE_LABELS[liveMode]}`,
    });
  },
};