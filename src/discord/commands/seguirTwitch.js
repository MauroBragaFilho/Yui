import { SlashCommandBuilder, PermissionFlagsBits, ChannelType } from 'discord.js';
import { setGlobalContext } from '../setGlobalContext.js';
import { twitchRepository } from '../../database/repositories/twitchRepo.js';
import { getTwitchUser } from '../../handlers/twitchApiHandler.js';

export const seguirTwitchCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('yui-seguir-twitch')
      .setDescription('[Admin] Passa a anunciar quando um streamer da Twitch entra ao vivo.')
      .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
      .addStringOption((option) =>
        option
          .setName('streamer')
          .setDescription('Login da Twitch (ex: alanzoka) ou URL completa de twitch.tv')
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
          .setDescription('Cargo a ser mencionado quando o streamer entrar ao vivo (opcional)')
          .setRequired(false)
      )
  ),

  async execute(interaction) {
    let input = interaction.options.getString('streamer', true);
    const discordChannel = interaction.options.getChannel('canal_discord', true);
    const mentionRole = interaction.options.getRole('cargo');

    if (!interaction.guildId) {
      return interaction.reply({
        content: '❌ Este comando só pode ser usado em um servidor.',
        ephemeral: true,
      });
    }

    await interaction.deferReply({ ephemeral: true });

    // Normaliza: aceita URL completa ou login puro
    const urlMatch = input.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
    if (urlMatch) {
      input = urlMatch[1];
    }
    const login = input.toLowerCase().replace(/^@/, '');

    if (!login) {
      return interaction.editReply({
        content: '❌ Login da Twitch inválido.',
      });
    }

    let twitchUser;
    try {
      twitchUser = await getTwitchUser(login);
    } catch (err) {
      return interaction.editReply({
        content: `❌ Falha ao consultar a API da Twitch: ${err.message}`,
      });
    }

    if (!twitchUser) {
      return interaction.editReply({
        content: `❌ Não encontrei o canal "${login}" na Twitch. Confira o login.`,
      });
    }

    const result = twitchRepository.addSubscription({
      guildId: interaction.guildId,
      twitchLogin: twitchUser.login,
      twitchUserId: twitchUser.id,
      discordChannelId: discordChannel.id,
      mentionRoleId: mentionRole ? mentionRole.id : null,
    });

    if (result.changes === 0) {
      return interaction.editReply({
        content: `⚠️ Este servidor **já segue** o streamer **${twitchUser.displayName}** neste canal (${discordChannel}).`,
      });
    }

    return interaction.editReply({
      content:
        `✅ **Agora seguindo!**\n\n` +
        `🎮 **Streamer:** ${twitchUser.displayName} (${twitchUser.login})\n` +
        `📍 **Publicação:** ${discordChannel}\n` +
        `${mentionRole ? `👥 **Menção:** <@&${mentionRole.id}>` : ''}` +
        `🔴 Você será avisado quando ele(a) entrar ao vivo.`,
    });
  },
};