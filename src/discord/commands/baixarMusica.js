import { EmbedBuilder, AttachmentBuilder } from 'discord.js';
import { SlashCommandBuilder } from 'discord.js';
import fs from 'node:fs';
import { setGlobalContext } from '../setGlobalContext.js';
import { clampText } from '../embedLimits.js';
import {
    downloadAudio,
    cleanupDownload,
    sanitizeFilenameForDiscord,
    isUserBusy,
    getBusyReason,
    lockUser,
    unlockUser,
    canBypass
} from '../../handlers/youtubeAudioHandler.js';
import { handleMusicSearchAndDownload } from '../../handlers/deezerMusicHandler.js';
import { downloadSpotify } from '../../handlers/spotifyDownloadHandler.js';
import {
    MediaError,
    MEDIA_MESSAGES,
    looksLikeSpotifyUrl,
    getMediaUserMessage,
    codeSafe,
    formatDeezerDelivery,
    isUploadTooLargeError
} from '../../utils/mediaUrls.js';
import { getUploadLimitBytes, formatMB, formatUploadLimit } from '../../utils/uploadLimit.js';
import { logger } from '../../utils/logger.js';

// Nunca marca ninguém: o título vem de um site externo.
const NO_MENTIONS = { parse: [] };

// Limite de upload do servidor: 10 MB no servidor comum, 50 MB no nível 2 e 100 MB no nível 3, já com a folga
// de segurança (uploadLimit.js; YUI_UPLOAD_LIMIT_MB muda a base).
function getAttachmentLimit(guild) {
  return getUploadLimitBytes(guild);
}

function getFileSize(filePath) {
  try {
    return fs.statSync(filePath).size;
  } catch {
    return 0;
  }
}

function tooLargeEmbed(fileSize, attachmentLimit) {
  return new EmbedBuilder()
    .setColor(0xE11D48)
    .setTitle('❌ Arquivo muito grande')
    .setDescription(
      `O arquivo baixado tem **${formatMB(fileSize)}**, acima do limite de envio do Discord neste servidor (**${formatUploadLimit(attachmentLimit)}**). Tente um conteúdo mais curto.`
    );
}

// Título vindo de fora: sem crases nem quebras e no máximo 200 caracteres.
function shortTitle(title, fallback) {
  return clampText(codeSafe(title), 200) || fallback;
}

// Linha discreta (subtexto do Discord) quando o link trazia uma playlist.
function playlistNote(info) {
  if (info.playlistOnly) return '\n-# Link de playlist: baixei só a primeira faixa.';
  if (info.playlistIgnored) return '\n-# O link tinha uma playlist; baixei só este vídeo.';
  return '';
}

export { playlistNote, getAttachmentLimit };

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

  // `deps` existe só para testes (dublês de downloadAudio/downloadSpotify/busca no Deezer); o Discord chama execute(interaction).
  async execute(interaction, deps = {}) {
    const runDownloadAudio = deps.downloadAudio || downloadAudio;
    const runDownloadSpotify = deps.downloadSpotify || downloadSpotify;
    const runMusicSearch = deps.handleMusicSearchAndDownload || handleMusicSearchAndDownload;
    const url = interaction.options.getString('url');
    const query = interaction.options.getString('busca');
    const userId = interaction.user.id;

    if (!canBypass(userId) && isUserBusy(userId)) {
      // Dois motivos: este usuário já tem um download rodando, ou o teto global de downloads simultâneos foi atingido.
      const globalCap = getBusyReason(userId) === 'global';
      const waitEmbed = new EmbedBuilder()
        .setColor(0xF59E0B)
        .setTitle(globalCap ? '⏳ Muitos Downloads' : '⏳ Download em Andamento')
        .setDescription(globalCap
          ? 'Há muitos downloads acontecendo ao mesmo tempo agora. Tente de novo em instantes.'
          : 'Você já tem um download em execução. Por favor, aguarde ele terminar.');
      return interaction.reply({ embeds: [waitEmbed], ephemeral: true });
    }

    if (!url && !query) {
      const errEmbed = new EmbedBuilder()
        .setColor(0xE11D48)
        .setTitle('❌ Informação Necessária')
        .setDescription('Informe um **link** em `url:` (YouTube, Spotify, Instagram ou TikTok) **ou** o **nome/artista** em `busca:`.');
      return interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

    // Trava ANTES de qualquer await: com o teto global de downloads simultâneos, vários pedidos juntos não podem
    // passar todos pela checagem acima enquanto o deferReply ainda está no ar.
    lockUser(userId);
    let downloadedInfo = null;

    try {
      await interaction.deferReply({ ephemeral: false });
      if (query) {
        // Busca por nome/artista
        const result = await runMusicSearch(query, null, {
          user: interaction.user,
          userId: interaction.user.id,
          userTag: interaction.user.tag,
          guild: interaction.guild
        });

        if (result.error) {
          await interaction.editReply({ content: `❌ ${clampText(String(result.error), 1900)}`, allowedMentions: NO_MENTIONS });
        } else if (result.isAmbiguous) {
          await interaction.editReply({ content: '', embeds: [result.embed], components: result.components });
        } else if (result.success) {
          // A limpeza (cleanup) roda no `finally`, mesmo se o envio falhar.
          downloadedInfo = result;
          // O produtor já ajustou o arquivo ao limite base; aqui confere o limite DESTE servidor antes de anexar.
          const attachmentLimit = getAttachmentLimit(interaction.guild);
          const fileSize = getFileSize(result.filePath);
          if (fileSize > attachmentLimit) {
            await interaction.editReply({ content: '', embeds: [tooLargeEmbed(fileSize, attachmentLimit)] });
          } else {
            // Texto neutro: não diz de onde veio a faixa (o plano B só acrescenta um aviso de qualidade).
            await interaction.editReply({
              content: formatDeezerDelivery(result).text,
              files: [result.attachment],
              allowedMentions: NO_MENTIONS
            });
          }
        }
      } else if (looksLikeSpotifyUrl(url)) {
        // Link do Spotify (só links de faixa)
        downloadedInfo = await runDownloadSpotify(url, {
          source: 'Slash',
          user: interaction.user,
          guild: interaction.guild
        });

        const attachmentLimit = getAttachmentLimit(interaction.guild);
        const fileSize = getFileSize(downloadedInfo.filePath);

        if (fileSize > 0 && fileSize <= attachmentLimit) {
          const attachment = new AttachmentBuilder(downloadedInfo.filePath, {
            // Nome de reserva neutro: o anexo não cita a origem da faixa quando ela vem sem título.
            name: `${sanitizeFilenameForDiscord(downloadedInfo.metadata.title || 'musica') || 'musica'}.mp3`,
          });
          // Sem o campo "Fonte" e sem citar a origem no rodapé: a origem do arquivo vai só para os logs.
          const successEmbed = new EmbedBuilder()
            .setColor(0x1DB954)
            .setTitle('✅ Download Concluído')
            .setDescription(`**${shortTitle(downloadedInfo.metadata.title, 'Música')}**`)
            .addFields({ name: 'Tamanho', value: formatMB(fileSize), inline: true })
            .setFooter({ text: 'Yui Music' })
            .setTimestamp();
          await interaction.editReply({ embeds: [successEmbed], files: [attachment], allowedMentions: NO_MENTIONS });
        } else {
          await interaction.editReply({ embeds: [tooLargeEmbed(fileSize, attachmentLimit)] });
        }
      } else {
        // YouTube / Instagram / TikTok
        downloadedInfo = await runDownloadAudio(url, { source: 'Slash', user: interaction.user, guild: interaction.guild });
        if (downloadedInfo && downloadedInfo.filePath) {
          const { filePath, metadata } = downloadedInfo;
          const attachmentLimit = getAttachmentLimit(interaction.guild);
          const fileSize = getFileSize(filePath);
          if (fileSize > attachmentLimit) {
            await interaction.editReply({ embeds: [tooLargeEmbed(fileSize, attachmentLimit)] });
          } else {
            const displayFileName = sanitizeFilenameForDiscord(metadata.title || 'audio') || 'audio';
            const attachment = new AttachmentBuilder(filePath, { name: `${displayFileName}.mp3` });
            await interaction.editReply({
              content: `🎵 Áudio baixado: \`${shortTitle(metadata.title, 'áudio')}\`${playlistNote(downloadedInfo)}`,
              files: [attachment],
              allowedMentions: NO_MENTIONS
            });
          }
        } else {
          const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Falha no Download')
            .setDescription('Não consegui baixar o áudio.');
          await interaction.editReply({ embeds: [errEmbed] });
        }
      }
    } catch (error) {
      // Detalhe técnico só no log; o usuário recebe uma frase curta e amigável.
      const logFailure = error instanceof MediaError ? logger.warn : logger.error; // erro esperado (link ruim etc.) é só aviso
      logFailure.call(logger, `[BaixarMusica] Falha no download (código: ${error && error.code ? error.code : 'n/d'}): ${error && error.message ? error.message : error}`);
      // Erro 40005 / 413 no envio (arquivo acima do limite do servidor): frase curta e clara, sem o texto cru da API.
      const uploadTooLarge = isUploadTooLargeError(error);
      const errEmbed = new EmbedBuilder()
        .setColor(0xE11D48)
        .setTitle(uploadTooLarge ? '❌ Arquivo muito grande' : '❌ Erro')
        .setDescription(uploadTooLarge ? MEDIA_MESSAGES.UPLOAD_TOO_LARGE : getMediaUserMessage(error));
      try {
        await interaction.editReply({ embeds: [errEmbed] });
      } catch (_) { /* ignore */ }
    } finally {
      unlockUser(userId);
      cleanupDownload(downloadedInfo);
    }
  },
};
