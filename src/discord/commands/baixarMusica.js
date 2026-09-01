import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { SlashCommandBuilder } from 'discord.js';
import fs from 'node:fs';
import { setGlobalContext } from '../setGlobalContext.js';
import {
    downloadAudio,
    sanitizeFilenameForDiscord,
    isUserBusy,
    lockUser,
    unlockUser,
    canBypass
} from '../../handlers/youtubeAudioHandler.js';
import { handleMusicSearchAndDownload } from '../../handlers/deezerMusicHandler.js';
import { downloadSpotify } from '../../handlers/spotifyDownloadHandler.js';

const SPOTIFY_URL_REGEX = /^(?:https?:\/\/)?(?:open\.|play\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist|episode|show)\//i;

export const baixarMusicaCommand = {
  data: setGlobalContext(
    new SlashCommandBuilder()
      .setName('baixar_musica')
      .setDescription('Central de downloads de música (MP3): YouTube, Deezer, Spotify, Instagram e TikTok.')
      .addStringOption((option) =>
        option
          .setName('url')
          .setDescription('Link da música/vídeo (YouTube, Spotify, Instagram ou TikTok). Use com "busca" OU "url".')
          .setRequired(false)
      )
      .addStringOption((option) =>
        option
          .setName('busca')
          .setDescription('Nome da música e/ou artista (busca no Deezer). Use com "url" OU "busca".')
          .setRequired(false)
      )
  ),

  async execute(interaction) {
    const url = interaction.options.getString('url');
    const query = interaction.options.getString('busca');
    const userId = interaction.user.id;

    if (!canBypass(userId) && isUserBusy(userId)) {
      const waitEmbed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle('⏳ Download em Andamento')
        .setDescription('Você já tem um download em execução. Por favor, aguarde ele terminar.');
      return interaction.reply({ embeds: [waitEmbed], ephemeral: true });
    }

    if (!url && !query) {
      const errEmbed = new EmbedBuilder()
        .setColor(0xE11D48)
        .setTitle('❌ Informação Necessária')
        .setDescription('Informe um **link** em `url:` (YouTube, Spotify, Instagram ou TikTok) **ou** o **nome/artista** em `busca:` (Deezer).');
      return interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

    await interaction.deferReply({ ephemeral: false });
    lockUser(userId);
    let downloadedAudioInfo = null;

    try {
      if (query) {
        // Deezer: busca por nome/artista
        const result = await handleMusicSearchAndDownload(query, null, {
          user: interaction.user,
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          guild: interaction.guild
        });

        if (result.error) {
          await interaction.editReply({ content: `❌ ${result.error}` });
        } else if (result.isAmbiguous) {
          await interaction.editReply({ content: '', embeds: [result.embed], components: result.components });
        } else if (result.success) {
          await interaction.editReply({
            content: `✅ Música em alta qualidade baixada via Deezer: \`${result.track.title} - ${result.track.artist}\``,
            files: [result.attachment]
          });
          if (typeof result.cleanup === 'function') {
            result.cleanup();
          }
        }
      } else if (SPOTIFY_URL_REGEX.test(url)) {
        // Spotify: download via spot-dlp / yt-dlp
        const result = await downloadSpotify(url, {
          source: 'Slash',
          user: interaction.user,
          guild: interaction.guild
        });

        const guild = interaction.guild;
        const attachmentLimit = guild
          ? guild.premiumTier === 3
            ? 100 * 1024 * 1024
            : guild.premiumTier === 2
              ? 50 * 1024 * 1024
              : 25 * 1024 * 1024
          : 25 * 1024 * 1024;

        const fileSize = (() => {
          try {
            return fs.statSync(result.filePath).size;
          } catch {
            return 0;
          }
        })();

        if (fileSize > 0 && fileSize <= attachmentLimit) {
          const attachment = new AttachmentBuilder(result.filePath, {
            name: `${result.metadata.title || 'spotify'}.mp3`,
          });
          const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
          const successEmbed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('✅ Download Concluído')
            .setDescription(`**${result.metadata.title}**`)
            .addFields(
              { name: 'Fonte', value: result.metadata.provider === 'spot-dlp' ? '🎵 spot-dlp' : '🔄 yt-dlp', inline: true },
              { name: 'Tamanho', value: `${sizeMB} MB`, inline: true }
            )
            .setFooter({ text: 'Yui Music • Spotify' })
            .setTimestamp();
          await interaction.editReply({ embeds: [successEmbed], files: [attachment] });
          try {
            if (fs.existsSync(result.filePath)) {
              fs.unlinkSync(result.filePath);
            }
          } catch (e) { /* ignore */ }
        } else {
          const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
          const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Arquivo muito grande')
            .setDescription(
              `O arquivo baixado tem **${sizeMB} MB**, acima do limite de envio do Discord (\`${Math.floor(attachmentLimit / (1024 * 1024))} MB). Tente uma faixa individual ou uma playlist menor.`
            );
          await interaction.editReply({ embeds: [errEmbed] });
        }
      } else {
        // YouTube / Instagram / TikTok: download via yt-dlp
        downloadedAudioInfo = await downloadAudio(url, { source: 'Slash', user: interaction.user, guild: interaction.guild });
        if (downloadedAudioInfo && downloadedAudioInfo.filePath) {
          const { filePath, metadata } = downloadedAudioInfo;
          const displayFileName = sanitizeFilenameForDiscord(metadata.title || 'audio');
          const attachment = new AttachmentBuilder(filePath, { name: `${displayFileName}.mp3` });
          await interaction.editReply({ content: `🎵 Áudio baixado: \`${metadata.title}\``, files: [attachment] });
        } else {
          const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Falha no Download')
            .setDescription('Não consegui baixar o áudio.');
          await interaction.editReply({ embeds: [errEmbed] });
        }
      }
    } catch (error) {
      console.error('[BaixarMusica]', error);
      const errEmbed = new EmbedBuilder()
        .setColor(0xE11D48)
        .setTitle('❌ Erro')
        .setDescription(error.message);
      try {
        await interaction.editReply({ embeds: [errEmbed] });
      } catch (_) { /* ignore */ }
    } finally {
      unlockUser(userId);
      if (downloadedAudioInfo && downloadedAudioInfo.filePath && fs.existsSync(downloadedAudioInfo.filePath)) {
        fs.unlink(downloadedAudioInfo.filePath, () => {});
      }
    }
  },
};

