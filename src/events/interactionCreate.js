import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, PermissionFlagsBits, MessageFlags } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import config from '../config.js';
import { getCurrentMusicFromUser } from '../services/activityMusicService.js';
import { handleTosInteraction } from '../handlers/tosHandler.js';
import { handleBanInteraction, checkBan, addBan, removeBan, getBans, setAutoBlock } from '../handlers/banHandler.js';
import {
    addToQueue,
    getDisabledTools,
    getAllMcpTools,
    setServerToolEnabled,
    resetServerTools,
    updateShowModel,
    updateShowModelThinking,
    updateErrorRetries,
    updateProviderSetting,
    getProviderSettings,
    setChannelPersona,
    setChannelChatter,
    setServerEveryoneMention,
    setServerUpdateChannel,
    setServerLastChannel
} from '../handlers/llmHandler.js';
import { generateImage } from '../handlers/imageHandler.js';
import {
    downloadAudio,
    downloadVideo,
    cleanupDownload,
    sanitizeFilenameForDiscord,
    isUserBusy,
    getBusyReason,
    lockUser,
    unlockUser,
    canBypass,
    storeVideoForCompression,
    getPendingVideo,
    removePendingVideo,
    enqueueCompression,
    isCompressionActive,
    getMemoryUsagePercent,
    logCompressionAction,
    formatVideoSuccessMessage
} from '../handlers/youtubeAudioHandler.js';
import { executeGameCommand } from '../handlers/gameHandler.js';
import { handleSauceCommand } from '../handlers/sauceHandler.js';
import { getSteamGameInfo } from '../handlers/steamHandler.js';
import { convertCurrency } from '../handlers/currencyHandler.js';
import { generateResponse } from '../handlers/llmHandler.js';
import { buildThirdPartyLogPrompt } from '../handlers/llmSafety.js';
import { handleConfigCommand, handleConfigButton, handleConfigModal, handleConfigSelect } from '../handlers/configPanelHandler.js';
import { handleMusicSearchAndDownload, clearSession } from '../handlers/deezerMusicHandler.js';
import { handleRadioButton, handleRadioModal, handleAmbiguousSelect } from '../music/radioModalHandler.js';
import { startRadioMode } from '../music/radioManager.js';
import { handleServerAdminCommand, handleServerAdminInteraction, handleIaFerramentasCommand } from '../handlers/serverAdminHandler.js';
import { handleCreatorAdminCommand, handleCreatorAdminInteraction } from '../handlers/creatorAdminHandler.js';
import { buildBanListPayload, buildBanDetailPayload } from '../handlers/banListHandler.js';
import { askCommand } from '../discord/commands/ask.js';
import { dailyCommand } from '../discord/commands/daily.js';
import { weeklyCommand } from '../discord/commands/weekly.js';
import { newsCommand } from '../discord/commands/news.js';
import { statusCommand } from '../discord/commands/status.js';
import { setupCommand } from '../discord/commands/setup.js';
import { baixarMusicaCommand, playlistNote } from '../discord/commands/baixarMusica.js';
import { seguirYoutubeCommand } from '../discord/commands/seguirYoutube.js';
import { seguirTwitchCommand } from '../discord/commands/seguirTwitch.js';
import { pararSeguirCommand } from '../discord/commands/pararSeguir.js';
import { listarSeguindoCommand } from '../discord/commands/listarSeguindo.js';
import { memoriaCommand } from '../discord/commands/memoria.js';
import { MediaError, MEDIA_MESSAGES, getMediaUserMessage, isUploadTooLargeError, codeSafe, formatDeezerDelivery } from '../utils/mediaUrls.js';
import { getUploadLimitBytes, formatMB, formatUploadLimit } from '../utils/uploadLimit.js';
import { buildChatLog } from '../utils/promptBudget.js';
import { clampText, makeEmbed } from '../discord/embedLimits.js';
import { neutralizeMassMentions } from '../discord/mentions.js';
import { logger } from '../utils/logger.js';

// Títulos, artistas e descrições vêm de sites externos: nunca marcam ninguém.
const NO_MENTIONS = { parse: [] };

/**
 * Texto de sucesso de uma faixa de música entregue por `handleMusicSearchAndDownload`.
 * NÃO diz de onde o arquivo veio. Se o plano B entrou (`result.fallback`), mostra só o aviso neutro de qualidade
 * (formatDeezerDelivery). Título e artista vêm de sites externos: sem crases/quebras e cortados em 200 e 100.
 */
export function musicDeliveryText(result, prefix = '✅ ') {
    if (result && result.fallback) return formatDeezerDelivery(result).text;
    const track = (result && result.track) || {};
    const title = clampText(codeSafe(track.title), 200) || 'Faixa';
    const artist = clampText(codeSafe(track.artist), 100);
    return `${prefix}\`${artist ? `${title} - ${artist}` : title}\``;
}

/**
 * Frase para o usuário quando o download ou o ENVIO de uma música falha. Arquivo acima do limite do Discord
 * (erro 40005, HTTP 413) vira uma frase clara; o resto usa a frase amigável do MediaError (nunca a mensagem crua).
 */
export function musicErrorText(error) {
    return isUploadTooLargeError(error) ? MEDIA_MESSAGES.UPLOAD_TOO_LARGE : getMediaUserMessage(error);
}

/**
 * Aviso de "ocupado" dos comandos de download. Dois motivos: este usuário já tem um download rodando, ou o teto global
 * de downloads simultâneos (YUI_DL_MAX_CONCURRENT) foi atingido. Devolve { global, title, description }.
 */
export function busyNotice(userId) {
    const global = getBusyReason(userId) === 'global';
    return global
        ? { global, title: '⏳ Muitos Downloads', description: 'Há muitos downloads acontecendo ao mesmo tempo agora. Tente de novo em instantes.' }
        : { global, title: '⏳ Download em Andamento', description: 'Você já tem um download em execução. Por favor, aguarde ele terminar.' };
}

/**
 * Cartão "Música Identificada" do /baixar_musica_atual, montado com makeEmbed (corta o que passa do limite e descarta
 * URL inválida em vez de lançar). A plataforma em que a pessoa está ouvindo aparece só na PRÉVIA ("Baixando...").
 * `neutral: true` (a ENTREGA, junto do arquivo) não cita plataforma nenhuma: o cartão que acompanha o MP3 não pode
 * sugerir de onde ele veio.
 */
export function buildMusicInfoEmbed(musicInfo, requesterId, { neutral = false } = {}) {
    const fields = [];
    if (!neutral) fields.push({ name: 'Plataforma', value: musicInfo.platformLabel, inline: true });
    if (musicInfo.targetUser && musicInfo.targetUser.id !== requesterId) {
        fields.push({ name: 'Usuário', value: `<@${musicInfo.targetUser.id}>`, inline: true });
    }
    return makeEmbed({
        color: 0x1DB954,
        title: `${neutral ? '🎵' : (musicInfo.platformEmoji || '🎵')} Música Identificada`,
        description: `**${musicInfo.title}**\n🎤 ${musicInfo.artist}${musicInfo.album ? `\n📀 ${musicInfo.album}` : ''}`,
        fields,
        footer: neutral ? 'Yui Music' : `Yui Music • ${musicInfo.platformLabel}`,
        thumbnail: musicInfo.coverUrl || undefined,
        timestamp: true
    });
}

// Comentário curto da Yui (steam_jogo, converter_moeda): vai em `content` (limite do Discord: 2000), então sai cortado.
const COMMENT_MAX_CHARS = 400;
// Respostas de SISTEMA do gerador de texto (erro, cota esgotada, pedido grande demais) não são comentário da Yui.
// Mesma regra do llmHandler (isSystemReply): só pelo TEXTO dessas respostas. Um comentário que começa com emoji ("⚡ Que preço bom!") é
// comentário de verdade e não pode ser descartado por causa do emoji.
const SYSTEM_REPLY_RE = /SYSTEM ERROR|Limites de Processamento|erro ao processar seu pedido/i;

/** Texto do comentário pronto para `content`: cortado em 400 caracteres e sem @everyone/@here. */
export function commentText(text) {
    return neutralizeMassMentions(clampText(String(text ?? ''), COMMENT_MAX_CHARS));
}

/**
 * Extrai o comentário da Yui da resposta crua do gerador de texto. Devolve '' (sem comentário) quando a resposta
 * é vazia ou é uma mensagem de sistema (erro, "Limites de Processamento Atingidos", pedido grande demais).
 * Tira o rodapé técnico (linhas "-# ..."), aceita resposta embrulhada em JSON ({"response": "..."}) e corta o resultado.
 */
export function extractAiComment(rawComment) {
    const raw = typeof rawComment === 'string' ? rawComment : '';
    if (!raw.trim() || SYSTEM_REPLY_RE.test(raw)) return '';
    let clean = raw.replace(/\n-# .*$/gm, '').trim();
    const jsonMatch = clean.match(/\{[\s\S]*\}/);
    if (jsonMatch) {
        try {
            const parsed = JSON.parse(jsonMatch[0]);
            const picked = [parsed.response, parsed.content, parsed.text, parsed.reply].find((v) => typeof v === 'string' && v.trim());
            if (picked) clean = picked.trim();
        } catch (_) { /* não era JSON: fica o texto */ }
    }
    if (SYSTEM_REPLY_RE.test(clean)) return '';
    return commentText(clean);
}

/** Mensagens do Discord (em ordem cronológica) no formato do buildChatLog: { time, user, content }. */
export function toLogEntries(messages) {
    return (Array.isArray(messages) ? messages : []).map((msg) => ({
        time: msg && msg.createdAt ? msg.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : '',
        user: msg && msg.author ? msg.author.username : '',
        content: msg ? msg.content : ''
    }));
}

/**
 * Aviso de que o resumo NÃO cobre tudo que foi pedido: mensagens que ficaram de fora do teto do log e/ou mensagens
 * longas encurtadas. `stats` é o retorno do buildChatLog ({ used, total, clipped, truncated }). Devolve '' se nada foi cortado.
 */
export function summaryNote(stats) {
    const used = Number(stats && stats.used) || 0;
    const total = Number(stats && stats.total) || 0;
    const clipped = Number(stats && stats.clipped) > 0;
    if (stats && stats.truncated) {
        if (used <= 1) return `Resumo só da última mensagem (de ${total})${clipped ? ', que foi encurtada' : ''}.`;
        return `Resumo das últimas ${used} de ${total} mensagens${clipped ? ' (as longas foram encurtadas)' : ''}.`;
    }
    if (clipped) return total === 1 ? 'Resumo de 1 mensagem (ela foi encurtada).' : `Resumo de ${total} mensagens (as longas foram encurtadas).`;
    return '';
}

/**
 * Instrução do /chat_resumo. Sem corte, a de sempre. Com corte, pede que a resposta ABRA com o aviso exato: o texto
 * da resposta sai do llmHandler, então o aviso viaja na instrução (não depende de nenhum campo novo do llmHandler).
 */
export function summaryInstruction(stats) {
    const base = 'Faça um resumo da conversa abaixo.';
    const note = summaryNote(stats);
    return note ? `${base} Comece a resposta com esta linha, exatamente como está: "${note}" Depois, o resumo.` : base;
}

/**
 * Mostra o resultado de uma busca/download de música e SEMPRE libera os temporários (também se o envio falhar).
 * `options.embeds`: embeds a manter no sucesso; `options.clearEmbeds`: limpa o embed de "baixando" nos demais casos.
 */
export async function deliverMusicResult(interaction, result, { prefix = '✅ ', embeds = null, clearEmbeds = false } = {}) {
    try {
        if (result.error) {
            await interaction.editReply({ content: `❌ ${clampText(String(result.error), 1900)}`, ...(clearEmbeds ? { embeds: [] } : {}), allowedMentions: NO_MENTIONS });
        } else if (result.isAmbiguous) {
            await interaction.editReply({ content: result.textList, components: result.components, embeds: [result.embed], allowedMentions: NO_MENTIONS });
        } else if (result.success) {
            const payload = { content: musicDeliveryText(result, prefix), files: [result.attachment], allowedMentions: NO_MENTIONS };
            if (embeds) payload.embeds = embeds;
            else if (clearEmbeds) payload.embeds = [];
            await interaction.editReply(payload);
        }
    } finally {
        cleanupDownload(result);
    }
}

/** Registra a falha de um download: erro esperado (link ruim etc.) é só aviso; o detalhe técnico fica no log. */
function logDownloadFailure(tag, error) {
    const log = error instanceof MediaError ? logger.warn : logger.error;
    log.call(logger, `[${tag}] Falha no download (código: ${error && error.code ? error.code : 'n/d'}): ${error && error.message ? error.message : error}`);
}

/**
 * /baixar_video: baixa Shorts, Reels ou TikTok e envia o MP4.
 * `deps` existe só para testes (dublê de downloadVideo); o Discord chama execute(interaction).
 */
export async function runBaixarVideo(interaction, deps = {}) {
    const runDownloadVideo = deps.downloadVideo || downloadVideo;
    const videoUrl = interaction.options.getString('url');
    const showDetails = interaction.options.getBoolean('descricao') || false;
    const userId = interaction.user.id;
    if (!canBypass(userId) && isUserBusy(userId)) {
        const notice = busyNotice(userId);
        const waitEmbed = new EmbedBuilder()
            .setColor(0xF59E0B)
            .setTitle(notice.title)
            .setDescription(notice.description);
        return interaction.reply({ embeds: [waitEmbed], ephemeral: true });
    }
    // Trava ANTES de qualquer await: com o teto global de downloads simultâneos, vários pedidos juntos não podem
    // passar todos pela checagem acima enquanto o deferReply ainda está no ar.
    lockUser(userId);
    let videoData = null;
    // Vídeo grande demais fica guardado para o botão de compressão (6 h): nesse caso o arquivo NÃO pode ser apagado agora.
    let storedFileId = null;
    try {
        await interaction.deferReply({ ephemeral: false });
        videoData = await runDownloadVideo(videoUrl, { source: 'Slash', user: interaction.user, guild: interaction.guild });
        // Limite de envio DESTE servidor (10 MB no servidor comum, 50 MB nível 2, 100 MB nível 3; já com a folga de segurança).
        const attachmentLimit = getUploadLimitBytes(interaction.guild);
        if (videoData.fileSize <= attachmentLimit) {
            const displayFileName = sanitizeFilenameForDiscord(videoData.metadata.title || 'video') || 'video';
            const attachment = new AttachmentBuilder(videoData.filePath, { name: `${displayFileName}.mp4` });
            await interaction.editReply({
                content: `${formatVideoSuccessMessage(videoData, showDetails)}${playlistNote(videoData)}`.slice(0, 1900),
                files: [attachment],
                allowedMentions: NO_MENTIONS
            });
        } else {
            storedFileId = storeVideoForCompression(videoData.filePath);
            const sizeLabel = formatMB(videoData.fileSize);
            // O teto usado tem folga (10 MB vira 9,5 MB): se tamanho e limite arredondam para o mesmo número, mostra o teto real.
            const limitLabel = sizeLabel === formatUploadLimit(attachmentLimit) ? formatMB(attachmentLimit) : formatUploadLimit(attachmentLimit);
            // O título vem de um site externo: em trecho de código (sem link nem negrito falsos), sem crases e com no máximo 200 caracteres.
            const videoTitle = clampText(codeSafe(videoData.metadata && videoData.metadata.title), 200) || 'vídeo';
            const compressEmbed = new EmbedBuilder()
                .setColor(0xF39C12)
                .setTitle('📦 Vídeo Grande Demais')
                .setDescription(`O vídeo \`${videoTitle}\` tem **${sizeLabel}**, mas o limite deste servidor é **${limitLabel}**.\n\nClique no botão abaixo para tentar comprimir o vídeo automaticamente.\n\n⏰ *O arquivo ficará disponível por 6 horas.*`)
                .setFooter({ text: 'Yui Media • by oBraga' })
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder().setCustomId(`compress_video_${storedFileId}`).setLabel('🔄 Tentar Compressão').setStyle(ButtonStyle.Primary)
            );
            await interaction.editReply({ embeds: [compressEmbed], components: [row], allowedMentions: NO_MENTIONS });
        }
    } catch (error) {
        // O botão de compressão nunca chegou a aparecer: solta o arquivo guardado (a limpeza geral roda no finally).
        if (storedFileId) {
            removePendingVideo(storedFileId);
            storedFileId = null;
        }
        logDownloadFailure('BaixarVideo', error);
        // Detalhe técnico só no log; o usuário recebe uma frase curta e amigável.
        const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Erro')
            .setDescription(getMediaUserMessage(error));
        try {
            await interaction.editReply({ embeds: [errEmbed], allowedMentions: NO_MENTIONS });
        } catch (replyError) {
            logger.warn(`[BaixarVideo] Não consegui avisar o usuário do erro: ${replyError && replyError.message ? replyError.message : replyError}`);
        }
    } finally {
        unlockUser(userId);
        if (!storedFileId) cleanupDownload(videoData);
    }
}

/**
 * Frase do embed de falha da compressão de vídeo. O detalhe técnico (caminhos, saída do ffmpeg) NUNCA vai ao usuário:
 * só o log guarda a mensagem crua. Os motivos que o usuário pode resolver (vídeo ainda grande demais, falta de memória)
 * têm frase própria.
 */
export function compressionErrorText(error, limitBytes) {
    const message = String(error && error.message ? error.message : '');
    if (message === 'MEMORY_ERROR') {
        return `⚠️ Ocorreu um erro de falta de memória no servidor da host ao tentar comprimir o vídeo. Por favor, entre em contato com <@${config.ownerId}>.`;
    }
    if (message.startsWith('STILL_TOO_LARGE')) {
        return `❌ O vídeo continua maior que o limite de envio deste servidor (${formatUploadLimit(limitBytes)}) mesmo depois de comprimido. Tente um vídeo mais curto.`;
    }
    if (isUploadTooLargeError(error)) {
        return `❌ O vídeo comprimido ficou maior que o limite de envio do Discord (${formatUploadLimit(limitBytes)}). Tente um vídeo mais curto.`;
    }
    return '❌ Não consegui comprimir esse vídeo agora. Tente novamente em instantes.';
}

/**
 * Botão "Tentar Compressão" (compress_video_<id>): comprime o vídeo guardado para caber no limite de envio do servidor.
 * `deps` existe só para testes (dublê de enqueueCompression); o Discord chama execute(interaction).
 */
export async function runCompressVideo(interaction, deps = {}) {
    const runCompression = deps.enqueueCompression || enqueueCompression;
    const fileId = String(interaction.customId || '').replace('compress_video_', '');
    const pending = getPendingVideo(fileId);
    if (!pending) {
        return interaction.reply({ content: '⏰ Este vídeo já expirou (limite de 6 horas). Faça o download novamente.', ephemeral: true });
    }
    // Mesmo limite do /baixar_video: o do servidor do botão (10 MB no servidor comum), já com a folga de segurança.
    const attachmentLimit = getUploadLimitBytes(interaction.guild);
    const isQueue = isCompressionActive();
    const progressEmbed = new EmbedBuilder()
        .setFooter({ text: 'Yui Media • by oBraga' })
        .setTimestamp();
    if (isQueue) {
        progressEmbed.setColor(0xF59E0B)
            .setTitle('⏳ Compressão na Fila')
            .setDescription('Já existe uma compressão de vídeo em andamento no bot. Seu vídeo foi adicionado à fila de espera e será processado automaticamente assim que a atual terminar!\n\nPor favor, aguarde...');
    } else {
        progressEmbed.setColor(0x3B82F6)
            .setTitle('🔄 Comprimindo Vídeo...')
            .setDescription('Iniciando a compressão do vídeo para reduzir o tamanho do arquivo. Isso pode levar alguns minutos. Não se preocupe, estou trabalhando nisso!');
    }
    await interaction.update({ embeds: [progressEmbed], components: [] });
    logCompressionAction({ user: interaction.user, guild: interaction.guild }, isQueue ? 'Fila' : 'Iniciado');
    let result = null;
    try {
        result = await runCompression(pending.filePath, attachmentLimit, interaction.user.id);
        const attachment = new AttachmentBuilder(result.filePath, { name: 'video_compressed.mp4' });
        const sizeMB = (result.fileSize / (1024 * 1024)).toFixed(1);
        await interaction.editReply({ content: `✅ **Vídeo comprimido com sucesso!** (${sizeMB} MB)`, embeds: [], files: [attachment], components: [] });
        logCompressionAction({ user: interaction.user, guild: interaction.guild }, 'Sucesso', `Tamanho: ${sizeMB} MB`);
        try { if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath); } catch (e) {}
        removePendingVideo(fileId);
    } catch (compressError) {
        // O arquivo comprimido que não chegou a ser enviado (envio recusado) não fica para trás.
        if (result && result.filePath) {
            try { if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath); } catch (e) {}
        }
        const errorEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Falha na Compressão')
            .setDescription(compressionErrorText(compressError, attachmentLimit))
            .setFooter({ text: 'Yui Media • by oBraga' })
            .setTimestamp();
        await interaction.editReply({ embeds: [errorEmbed], components: [] });
        logCompressionAction({ user: interaction.user, guild: interaction.guild }, 'Erro', `Detalhe: ${compressError && compressError.message ? compressError.message : compressError}`);
    }
}

function getHelpRegrasPages(regrasAnswer) {
    if (!regrasAnswer) return [];
    const sections = regrasAnswer.split(/(?=###\s+)/g).filter(s => s.trim().length > 0);
    if (sections.length >= 2) {
        const categorySections = sections.filter(s => s.startsWith('###'));
        if (categorySections.length > 0) {
            return categorySections.map((sec, idx) => {
                const lines = sec.trim().split('\n');
                const firstLine = lines[0].replace(/^###\s+/, '').trim();
                const body = lines.slice(1).join('\n').trim();
                return {
                    title: `⚖️ Regras & Termos (${idx + 1}/${categorySections.length}) • ${firstLine}`,
                    content: `### ${firstLine}\n\n${body}`
                };
            });
        }
    }
    return [{
        title: '⚖️ Regras & Termos (1/1)',
        content: regrasAnswer
    }];
}

export default {
    name: 'interactionCreate',
    once: false,
    async execute(interaction, client) {
        if (interaction.guildId) {
            const isWhitelisted = config.isAutomodWhitelisted(interaction.user.id) || config.isOwner(interaction.user.id);
            if (!isWhitelisted) {
                const { isServerAccepted, sendTermsOfService } = await import('../handlers/tosHandler.js');
                if (!isServerAccepted(interaction.guildId)) {
                    const isTosAction = (interaction.isCommand() && interaction.commandName === 'aceitar_tos') ||
                                        (interaction.isButton() && (interaction.customId === 'tos_accept' || interaction.customId === 'tos_decline' || interaction.customId.startsWith('tos_nav_')));
                    if (!isTosAction) {
                        if (interaction.isAutocomplete()) {
                            return interaction.respond([]).catch(() => {});
                        }
                        await sendTermsOfService(interaction);
                        return;
                    }
                }
            }
        }
        if (interaction.customId) {
            if (interaction.customId.startsWith('srvcfg_')) {
                return await handleServerAdminInteraction(interaction);
            }
            if (interaction.customId.startsWith('crtcfg_')) {
                return await handleCreatorAdminInteraction(interaction, client);
            }
            if (interaction.customId.startsWith('srvmcp_')) {
                const { handleMcpToolInteraction } = await import('../handlers/mcpToolPanelHandler.js');
                return await handleMcpToolInteraction(interaction);
            }
            if (interaction.customId.startsWith('help_')) {
                const { handleHelpInteraction } = await import('../handlers/helpPanelHandler.js');
                return await handleHelpInteraction(interaction);
            }
        }
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('radio_')) {
                return await handleRadioModal(interaction, client);
            }
            if (interaction.customId.startsWith('cfgmodal_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Yui.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigModal(interaction);
            }
        }
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith('radio_ambiguous_select_')) {
                return await handleAmbiguousSelect(interaction, client);
            }
            if (interaction.customId.startsWith('music_select_')) {
                const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
                if (banInfo) {
                    return interaction.reply({ content: '🛑 **ACESSO NEGADO:** Você está banido do sistema e não pode interagir.', ephemeral: true });
                }
                const targetUserId = interaction.customId.replace('music_select_', '');
                if (interaction.user.id !== targetUserId) {
                    return interaction.reply({ content: '❌ Esta seleção pertence a outro usuário.', ephemeral: true });
                }
                const selectedIndex = interaction.values[0];
                await interaction.update({ content: '🔄 **Processando download da faixa selecionada...**', embeds: [], components: [] });
                try {
                    const result = await handleMusicSearchAndDownload(null, selectedIndex, {
                        user: interaction.user,
                        userId: interaction.user.id,
                        userTag: interaction.user.tag,
                        guild: interaction.guild
                    });
                    const keepEmbed = config.keepMusicEmbed !== false;
                    // Texto neutro (não diz de onde veio a faixa; no plano B só acrescenta um aviso de qualidade); temporários sempre liberados.
                    await deliverMusicResult(interaction, result, {
                        prefix: '✅ Música baixada: ',
                        embeds: keepEmbed && result.success && result.infoEmbed ? [result.infoEmbed] : null
                    });
                } catch (error) {
                    logDownloadFailure('MusicSelect', error);
                    try {
                        await interaction.editReply({ content: `❌ ${musicErrorText(error)}`, allowedMentions: NO_MENTIONS });
                    } catch (replyError) {
                        logger.warn(`[MusicSelect] Não consegui avisar o usuário do erro: ${replyError && replyError.message ? replyError.message : replyError}`);
                    }
                }
                return;
            }
            if (interaction.customId === 'cfgpanel_goto_select') {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Yui.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigSelect(interaction);
            }
            if (interaction.customId.startsWith('banlist_select_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Yui.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                const parts = interaction.customId.split('_');
                const category = parts[2];
                const targetId = interaction.values[0];
                const payload = await buildBanDetailPayload(client, category, targetId);
                return await interaction.update(payload);
            }

            return;
        }
        if (interaction.isButton()) {
            const cid = interaction.customId;
            if (cid.startsWith('radio_')) {
                if (cid.startsWith('radio_ambiguous_cancel_')) {
                    return await handleAmbiguousSelect(interaction, client);
                }
                return await handleRadioButton(interaction, client);
            }
            if (cid.startsWith('music_cancel_')) {
                const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
                if (banInfo) {
                    return interaction.reply({ content: '🛑 **ACESSO NEGADO:** Você está banido do sistema e não pode interagir.', ephemeral: true });
                }
                const targetUserId = cid.replace('music_cancel_', '');
                if (interaction.user.id !== targetUserId) {
                    return interaction.reply({ content: '❌ Esta ação pertence a outro usuário.', ephemeral: true });
                }
                clearSession(interaction.user.id);
                return await interaction.update({ content: '❌ **Pesquisa de música cancelada.**', embeds: [], components: [] });
            }
            if (cid.startsWith('cfgpanel_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Yui.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigButton(interaction);
            }
            if (cid.startsWith('adm_') || cid.startsWith('banlist_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Yui.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
            }
            if (cid.startsWith('adm_manageguild_')) {
                const parts = cid.split('_');
                const action = parts[2];
                const guildId = parts[3];
                if (action === 'leave') {
                    const targetGuild = client.guilds.cache.get(guildId);
                    if (targetGuild) {
                        await targetGuild.leave();
                        await interaction.update({ content: `✅ Saí do servidor \`${targetGuild.name}\` com sucesso.`, embeds: [], components: [] });
                    } else {
                        await interaction.reply({ content: '❌ Servidor não encontrado ou já saí.', ephemeral: true });
                    }
                } else if (action === 'confirm') {
                    await interaction.update({ content: '✅ Servidor confirmado e botão ignorado.', components: [] });
                }
                return;
            } else if (cid.startsWith('adm_remoteban_')) {
                const parts = cid.split('_');
                const type = parts[2];
                const targetId = parts[3];
                if (type === 'ignore') {
                    await interaction.update({ content: '✅ Alerta ignorado.', components: [] });
                } else {
                    addBan(type, targetId, "Banido remotamente pelo log de violações do sistema Yui.");
                    await interaction.update({ content: `✅ Alvo \`${targetId}\` (${type}) banido com sucesso.`, components: [] });
                }
                return;
            } else if (cid === 'banlist_home') {
                const payload = await buildBanListPayload(client, 'home');
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_view_')) {
                const parts = cid.split('_');
                const category = parts[2];
                const page = parseInt(parts[3] || '0');
                const payload = await buildBanListPayload(client, category, page);
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_detail_')) {
                const parts = cid.split('_');
                const category = parts[2];
                const targetId = parts[3];
                if (targetId === 'none') {
                    return await interaction.reply({ content: '❌ Sem mais registros.', ephemeral: true });
                }
                const payload = await buildBanDetailPayload(client, category, targetId);
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_unban_')) {
                const parts = cid.split('_');
                const category = parts[2];
                const targetId = parts[3];
                const apiType = category === 'users' ? 'user' : category === 'guilds' ? 'guild' : 'channel';
                removeBan(apiType, targetId);
                const embed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('🔓 Desbanido com Sucesso')
                    .setDescription(`O alvo com ID \`${targetId}\` (${apiType}) foi desbanido do sistema.`);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('banlist_home').setLabel('🏠 Início').setStyle(ButtonStyle.Primary)
                );
                return await interaction.update({ embeds: [embed], components: [row] });
            }

            if (cid.startsWith('compress_video_')) {
                return await runCompressVideo(interaction);
            }
            if (cid.startsWith('srvcfg_')) {
                return await handleServerAdminInteraction(interaction);
            }
            if (cid.startsWith('crtcfg_')) {
                return await handleCreatorAdminInteraction(interaction, client);
            }
            await handleTosInteraction(interaction);
            await handleBanInteraction(interaction, client);
            return;
        }
        if (!interaction.isCommand() && !interaction.isAutocomplete()) return;
        if (interaction.isCommand()) {
            if (interaction.guildId && interaction.channelId) {
                setServerLastChannel(interaction.guildId, interaction.channelId);
                const { checkAndInitializeUpdateChannel } = await import('../handlers/tosHandler.js');
                await checkAndInitializeUpdateChannel(interaction.guild, interaction.channel);
            }
            const sub = interaction.options.getSubcommand(false);
            const cmdLog = `[LOG] Slash: /${interaction.commandName}${sub ? ' ' + sub : ''} | Usuário: ${interaction.user.tag} (${interaction.user.id}) | Local: {${interaction.guild?.name || 'DM'} - ${interaction.guildId || 'N/A'}}`;
            console.log(cmdLog);
            const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
            if (banInfo && interaction.commandName !== 'ajuda') {
                const banEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('🛑 ACESSO NEGADO — VOCÊ ESTÁ BANIDO!')
                    .setDescription(`Sua tentativa de execução foi abortada. O acesso à **IA Yui** está permanentemente bloqueado para você.\n\n**DETALHES DO SEU BANIMENTO:**\n- **Tipo:** ${banInfo.typeName || banInfo.type}\n- **Motivo do Banimento:** ${clampText(String(banInfo.reason || 'Violação severa dos Termos de Uso da IA Yui.'), 300)}\n- **Status Atual:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.\n\nVocê perdeu todos os privilégios de utilização dos nossos serviços. Não adianta insistir.\n\nSe você acredita que isso é um erro ou deseja solicitar um desbanimento, entre em contato com o desenvolvedor: <@${config.ownerId}> [\[Abrir Perfil\](https://discord.com/users/${config.ownerId})] ✨`)
                    .setFooter({ text: 'Yui Security & Moderation • by oBraga' })
                    .setTimestamp();
                return interaction.reply({ embeds: [banEmbed], ephemeral: false });
            }
        }
        if (interaction.isAutocomplete()) {
            if (interaction.commandName === 'yui-ferramentas' || interaction.commandName === 'yui-criador') {
                const focused = interaction.options.getFocused().toLowerCase();
                const guildId = interaction.guildId;
                const disabled = getDisabledTools(guildId);
                const allTools = getAllMcpTools();
                const choices = allTools
                    .filter(t => t.meta.disableable && t.function.name !== 'leave_voice_call')
                    .map(t => {
                        if (t.function.name === 'join_voice_call') {
                            const isDisabled = disabled.includes('join_voice_call');
                            return {
                                name: `${isDisabled ? '❌' : '✅'} 🎙️ Assistente de Voz (Call)`,
                                value: 'join_voice_call'
                            };
                        }
                        const isDisabled = disabled.includes(t.function.name);
                        return {
                            name: `${isDisabled ? '❌' : '✅'} ${t.meta.label}`,
                            value: t.function.name
                        };
                    })
                    .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
                    .slice(0, 25);
                return interaction.respond(choices);
            }
            if (interaction.commandName === 'converter_moeda') {
                const CURRENCIES = [
                    { name: '🇧🇷 BRL — Real Brasileiro',            value: 'BRL' },
                    { name: '🇺🇸 USD — Dólar Americano',           value: 'USD' },
                    { name: '🇪🇺 EUR — Euro',                       value: 'EUR' },
                    { name: '🇬🇧 GBP — Libra Esterlina',            value: 'GBP' },
                    { name: '💹 BTC — Bitcoin',                     value: 'BTC' },
                    { name: '💸 ETH — Ethereum',                    value: 'ETH' },
                    { name: '💵 USDT — Tether',                    value: 'USDT' },
                    { name: '🇯🇵 JPY — Iene Japonês',              value: 'JPY' },
                    { name: '🇨🇦 CAD — Dólar Canadense',           value: 'CAD' },
                    { name: '🇨🇭 CHF — Franco Suíço',              value: 'CHF' },
                    { name: '🇦🇺 AUD — Dólar Australiano',         value: 'AUD' },
                    { name: '🇨🇳 CNY — Yuan Chinês',               value: 'CNY' },
                    { name: '🇰🇷 KRW — Won Sul-Coreano',           value: 'KRW' },
                    { name: '🇲🇽 MXN — Peso Mexicano',             value: 'MXN' },
                    { name: '🇦🇷 ARS — Peso Argentino',             value: 'ARS' },
                    { name: '🇨🇱 CLP — Peso Chileno',               value: 'CLP' },
                    { name: '🇨🇴 COP — Peso Colombiano',            value: 'COP' },
                    { name: '🇺🇾 UAH — Hryvnia Ucraniana',          value: 'UAH' },
                    { name: '🇷🇺 RUB — Rublo Russo',                value: 'RUB' },
                    { name: '🇮🇳 INR — Rupia Indiana',              value: 'INR' },
                    { name: '🇳🇿 NZD — Dólar Neozelandês',         value: 'NZD' },
                    { name: '🇸🇬 SGD — Dólar de Singapura',       value: 'SGD' },
                    { name: '🇸🇦 SAR — Riyal Saudita',              value: 'SAR' },
                    { name: '🧩 SOL — Solana',                      value: 'SOL' },
                    { name: '🧩 BNB — BNB (Binance)',                value: 'BNB' },
                ];
                const focused = interaction.options.getFocused().toUpperCase();
                const filtered = CURRENCIES
                    .filter(c => c.value.includes(focused) || c.name.toUpperCase().includes(focused))
                    .slice(0, 25);
                return interaction.respond(filtered);
            }
            if (interaction.commandName === 'baixar_musica_atual') {
                const focused = interaction.options.getFocused().toLowerCase();
                const members = interaction.guild ? Array.from(interaction.guild.members.cache.values()) : [];
                const choices = members
                    .filter(m => !m.user.bot)
                    .map(m => {
                        const name = m.displayName || m.user.globalName || m.user.username;
                        return {
                            name: `${name} (@${m.user.username})`,
                            value: m.user.id
                        };
                    })
                    .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
                    .slice(0, 25);
                return interaction.respond(choices);
            }
            return;
        }
        const { commandName } = interaction;
        if (commandName === 'yui') {
            await askCommand.execute(interaction);
        } else if (commandName === 'gta-diario') {
            await dailyCommand.execute(interaction);
        } else if (commandName === 'gta-semanal') {
            await weeklyCommand.execute(interaction);
        } else if (commandName === 'gta-noticias') {
            await newsCommand.execute(interaction);
        } else if (commandName === 'yui-status') {
            await statusCommand.execute(interaction);
        } else if (commandName === 'yui-configurar') {
            await setupCommand.execute(interaction);
        } else if (commandName === 'yui-seguir-youtube') {
            await seguirYoutubeCommand.execute(interaction);
        } else if (commandName === 'yui-seguir-twitch') {
            await seguirTwitchCommand.execute(interaction);
        } else if (commandName === 'yui-parar-seguir') {
            await pararSeguirCommand.execute(interaction);
        } else if (commandName === 'yui-listar-seguindo') {
            await listarSeguindoCommand.execute(interaction);
        } else if (commandName === 'yui-memoria') {
            await memoriaCommand.execute(interaction);
        } else if (commandName === 'yui-servidor') {
            return await handleServerAdminCommand(interaction);
        } else if (commandName === 'yui-ferramentas') {
            return await handleIaFerramentasCommand(interaction);
        } else if (commandName === 'yui-criador') {
            return await handleCreatorAdminCommand(interaction, client);
        } else if (commandName === 'aceitar_tos') {
            const hasPermission = !interaction.guild || (interaction.member && (
                interaction.member.permissions.has(PermissionFlagsBits.Administrator) ||
                interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
                interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)
            )) || config.isOwner(interaction.user.id);
            if (!hasPermission) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Apenas administradores do servidor podem aceitar os Termos de Uso.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const { isServerAccepted, sendTermsOfService } = await import('../handlers/tosHandler.js');
            if (isServerAccepted(interaction.guildId)) {
                const alreadyAcceptedEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('✅ Termos de Uso Já Aceitos')
                    .setDescription('Os Termos de Uso da Yui já foram previamente aceitos e estão ativos neste servidor.')
                    .setFooter({ text: 'Yui ToS • by oBraga' })
                    .setTimestamp();
                return interaction.reply({ embeds: [alreadyAcceptedEmbed], ephemeral: true });
            }
            await sendTermsOfService(interaction);
        } else if (commandName === 'ajuda') {
            const { buildHelpHomePayload } = await import('../handlers/helpPanelHandler.js');
            return await interaction.reply({ ...buildHelpHomePayload(), ephemeral: false });
        } else if (commandName === 'yui-imagem') {
            const prompt = interaction.options.getString('prompt');
            const negativePrompt = interaction.options.getString('negative_prompt') || '';
            const width = interaction.options.getInteger('width') || 1024;
            const height = interaction.options.getInteger('height') || 1024;
            const provider = interaction.options.getString('provider') || 'auto';
            await interaction.deferReply({ ephemeral: false });
            try {
                const imageData = await generateImage(prompt, negativePrompt, width, height, { provider, bypassSafety: true });
                if (imageData) {
                    const drawEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('🎨 Imagem Gerada')
                        .setDescription('⚠️ **Aviso:** Eu apenas **gero** imagens novas a partir de texto. Eu **não edito** imagens e **não tenho visão computacional** para ver arquivos.')
                        .addFields(
                            { name: '🤖 Modelo', value: `\`${imageData.modelName || 'Desconhecido'}\``, inline: false },
                            { name: '🌱 Seed', value: `\`${imageData.actualSeed}\``, inline: true },
                            { name: '📐 Resolução', value: `\`${width}x${height}\``, inline: true }
                        )
                        .setFooter({ text: `Prompt: ${prompt.substring(0, 100)} • by oBraga` })
                        .setTimestamp();
                    const files = [];
                    if (imageData.imageUrl) {
                        drawEmbed.setImage(imageData.imageUrl);
                    } else if (imageData.localFilePath && fs.existsSync(imageData.localFilePath)) {
                        const attachment = new AttachmentBuilder(imageData.localFilePath, { name: 'draw.png' });
                        drawEmbed.setImage('attachment://draw.png');
                        files.push(attachment);
                        setTimeout(() => { try { if (fs.existsSync(imageData.localFilePath)) fs.unlinkSync(imageData.localFilePath); } catch (_) {} }, 10_000);
                    }
                    await interaction.editReply({ embeds: [drawEmbed], files });
                } else {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Falha na Geração')
                        .setDescription('Não consegui gerar a imagem.');
                    await interaction.editReply({ embeds: [errEmbed] });
                }
            } catch (error) {
                console.error('Erro /draw:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro')
                    .setDescription(error.message);
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'baixar_musica') {
            await baixarMusicaCommand.execute(interaction);
        } else if (commandName === 'baixar_video') {
            await runBaixarVideo(interaction);
        } else if (commandName === 'buscar_jogo') {
            await executeGameCommand(interaction);
        } else if (commandName === 'chat_resumo') {
            const amount = interaction.options.getInteger('quantidade') || 20;
            await interaction.deferReply();
            try {
                const messages = await interaction.channel.messages.fetch({ limit: amount });
                const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                // Teto do log (YUI_SUMMARY_MAX_CHARS, padrão 20000; cada mensagem em até YUI_SUMMARY_PER_MESSAGE): mantém as mais novas.
                const summary = buildChatLog(toLogEntries(sortedMessages));
                logger.info(`[ChatResumo] mensagens usadas: ${summary.used} de ${summary.total} (encurtadas: ${summary.clipped}); log: ${summary.log.length} caracteres`);
                // O prompt é o LOG do canal (falas de várias pessoas), não a fala de quem chamou o comando:
                // thirdPartyPrompt impede captura de memória, gravação no histórico de conversa e auto-ban
                // de quem chamou por palavras que OUTRAS pessoas escreveram. Quando o log foi cortado, a instrução pede o aviso.
                if (summary.used === 0) {
                    // Canal vazio ou só com anexos/figurinhas: não há texto para resumir. Sem chamar a IA (com um prompt de ~300 caracteres ela
                    // inventaria um resumo de uma conversa que não existe).
                    await interaction.editReply({ content: 'Não achei nenhuma mensagem com texto para resumir neste canal.', allowedMentions: NO_MENTIONS });
                } else {
                    const summaryPrompt = buildThirdPartyLogPrompt(summary.log, { instruction: summaryInstruction(summary) });
                    addToQueue(summaryPrompt, interaction, 'slash', { allowSearch: false, disableTools: true, thirdPartyPrompt: true });
                }
            } catch (error) {
                logger.error(`[ChatResumo] Falha ao montar o resumo: ${error && error.message ? error.message : error}`);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro no Resumo')
                    .setDescription('Não foi possível obter o histórico de mensagens ou gerar o resumo deste canal.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'anime_origem') {
            await handleSauceCommand(interaction);
        } else if (commandName === 'yui-config_ia') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Yui.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const provider = interaction.options.getString('provider');
            const setting = interaction.options.getString('setting');
            const value = interaction.options.getNumber('value');
            if (provider) {
                if (!setting || value === null) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Dados Insuficientes')
                        .setDescription('Para configurar um provedor de IA, especifique a configuração e o valor.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                updateProviderSetting(provider, setting, value);
            }
            const successEmbed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('⚙️ Configurações • Parâmetros de IA')
                .setDescription('As variáveis operacionais dos modelos de IA foram ajustadas com sucesso.');
            if (provider) {
                successEmbed.addFields(
                    { name: 'Provedor', value: provider, inline: true },
                    { name: 'Configuração', value: setting, inline: true },
                    { name: 'Valor', value: String(value), inline: true }
                );
            }
            await interaction.reply({ embeds: [successEmbed], ephemeral: true });
        } else if (commandName === 'steam_jogo') {
            const query = interaction.options.getString('nome');
            await interaction.deferReply();
            try {
                const steamInfo = await getSteamGameInfo(query);
                if (steamInfo.error) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro na Steam')
                        .setDescription(steamInfo.error);
                    return await interaction.editReply({ embeds: [errEmbed] });
                }

                let finalDesc = steamInfo.description || "Sem sinopse válida.";
                if (finalDesc.length > 3900) finalDesc = finalDesc.substring(0, 3900) + '...';

                const steamEmbed = new EmbedBuilder()
                    .setColor(0x7C3AED)
                    .setTitle(steamInfo.name)
                    .setURL(steamInfo.url)
                    .setDescription(finalDesc)
                    .addFields(
                        { name: 'Preço', value: steamInfo.discount > 0 ? `~~${steamInfo.originalPrice}~~ **${steamInfo.price}** (-${steamInfo.discount}%)` : steamInfo.price, inline: true },
                        { name: 'Lançamento', value: steamInfo.releaseDate, inline: true },
                        { name: 'Desenvolvedor', value: steamInfo.developers, inline: true }
                    )
                    .setFooter({ text: 'Fonte: Loja da Steam • Yui • by oBraga' })
                    .setTimestamp();

                if (steamInfo.headerImage) {
                    steamEmbed.setImage(steamInfo.headerImage);
                }
                if (steamInfo.metacritic) {
                    steamEmbed.addFields({ name: 'Metacritic', value: `${steamInfo.metacritic}/100 🌟`, inline: true });
                }

                let yuiComment = "";
                try {
                    const commentPrompt = `Eu acabei de consultar o jogo "${steamInfo.name}" na Steam via comando manual. O preço atual é ${steamInfo.price}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
                    const rawComment = await generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
                    // Mensagem de sistema (erro, cota esgotada) não vira comentário; o texto sai cortado e sem @everyone/@here.
                    yuiComment = extractAiComment(rawComment);
                } catch (e) {
                    logger.warn(`[SteamCommand] Falha ao gerar comentário IA: ${e && e.message ? e.message : e}`);
                }

                await interaction.editReply({ content: yuiComment || null, embeds: [steamEmbed], allowedMentions: NO_MENTIONS });
            } catch (error) {
                logger.error(`[SteamCommand] Erro no comando steam_jogo: ${error && error.message ? error.message : error}`);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro de Processamento')
                    .setDescription('Erro ao processar a consulta da Steam.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'converter_moeda') {
            const amount = interaction.options.getNumber('valor');
            const from = interaction.options.getString('de');
            const to = interaction.options.getString('para');
            await interaction.deferReply();
            try {
                const convInfo = await convertCurrency(amount, from, to);
                if (convInfo.error) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro na Conversão')
                        .setDescription(convInfo.error);
                    return await interaction.editReply({ embeds: [errEmbed] });
                }

                const amountFormatted = Number(convInfo.amount).toLocaleString('pt-BR');
                const resultFormatted = Number(convInfo.result).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const rateFormatted = Number(convInfo.rate).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
                
                const convEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle(`Conversão de Moedas: ${convInfo.name}`)
                    .setDescription(`**${amountFormatted} ${convInfo.from}** equivale a **${resultFormatted} ${convInfo.to}**`)
                    .addFields(
                        { name: 'Cotação (' + convInfo.from + ')', value: `1 ${convInfo.from} = ${rateFormatted} ${convInfo.to}`, inline: true },
                        { name: 'Última Atualização', value: convInfo.lastUpdate || 'Desconhecida', inline: true }
                    )
                    .setFooter({ text: 'Fonte: AwesomeAPI • Yui • by oBraga' })
                    .setTimestamp();
                    
                let yuiComment = "";
                try {
                    const commentPrompt = `Eu acabei de converter ${convInfo.amount} ${convInfo.from} para ${convInfo.to} via comando manual. O resultado foi ${resultFormatted}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
                    const rawComment = await generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
                    // Mensagem de sistema (erro, cota esgotada) não vira comentário; o texto sai cortado e sem @everyone/@here.
                    yuiComment = extractAiComment(rawComment);
                } catch (e) {
                    logger.warn(`[CurrencyCommand] Falha ao gerar comentário IA: ${e && e.message ? e.message : e}`);
                }

                await interaction.editReply({ content: yuiComment || null, embeds: [convEmbed], allowedMentions: NO_MENTIONS });
            } catch (error) {
                logger.error(`[CurrencyCommand] Erro no comando converter_moeda: ${error && error.message ? error.message : error}`);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro de Processamento')
                    .setDescription('Erro ao tentar converter essa moeda.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'entrar-call') {
            const { joinVoiceCall } = await import('../handlers/voiceHandler.js');
            await interaction.deferReply({ ephemeral: true });
            const result = await joinVoiceCall(interaction.member, interaction.channel);
            if (result) {
                await interaction.editReply({ content: '✅ Processando entrada no canal de voz...' });
            } else {
                await interaction.editReply({ content: '❌ Não foi possível entrar no canal de voz.' });
            }
        } else if (commandName === 'sair-call') {
            const { leaveVoiceCall } = await import('../handlers/voiceHandler.js');
            await interaction.deferReply({ ephemeral: true });
            const result = await leaveVoiceCall(interaction.guildId, interaction.channel);
            if (result) {
                await interaction.editReply({ content: '✅ Saí do canal de voz.' });
            } else {
                await interaction.editReply({ content: '❌ Não estou em nenhum canal de voz neste servidor.' });
            }
        } else if (commandName === 'modo-radio') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const result = await startRadioMode(interaction.member, interaction.channel, client);
                if (result.success) {
                    await interaction.editReply({ content: '📻 Modo Rádio ativado!' });
                } else {
                    await interaction.editReply({ content: result.error || '❌ Não foi possível ativar o Modo Rádio.' });
                }
            } catch (err) {
                console.error('[ModoRadio]', err);
                await interaction.editReply({ content: '❌ Erro ao iniciar o Modo Rádio.' });
            }
        } else if (commandName === 'baixar_musica_atual') {
            await interaction.deferReply();
            try {
                const targetInput = interaction.options.getString('usuario') || interaction.user.id;
                const musicInfo = await getCurrentMusicFromUser(targetInput, client, interaction.guildId);
                if (!musicInfo.success) {
                    let msg = `🎵 ${musicInfo.message}`;
                    if (musicInfo.helpInstructions || musicInfo.reason === 'no_presence') {
                        msg += '\n\n> **Como ativar:**\n> Vá em **Configurações do Discord → Privacidade e Segurança → Atividade de Status** e ative **"Exibir atividade atual como mensagem de status"**.';
                    }
                    return await interaction.editReply({ content: msg });
                }
                // Prévia ("Música Identificada" + "Baixando..."): mostra a plataforma em que a pessoa está ouvindo.
                // O cartão que FICA junto do arquivo (entrega) é neutro: não cita plataforma nenhuma.
                const infoEmbed = buildMusicInfoEmbed(musicInfo, interaction.user.id);
                const deliveredEmbed = buildMusicInfoEmbed(musicInfo, interaction.user.id, { neutral: true });
                const userId = interaction.user.id;
                if (!canBypass(userId) && isUserBusy(userId)) {
                    const notice = busyNotice(userId);
                    return await interaction.editReply({ content: notice.global ? `⏳ ${notice.description}` : '⏳ Você já tem um download em andamento. Aguarde.' });
                }
                // Trava ANTES do próximo await: com o teto global de downloads simultâneos, vários pedidos juntos não podem
                // passar todos pela checagem acima enquanto a mensagem de "baixando" ainda está sendo enviada.
                lockUser(userId);
                try {
                    const keepEmbed = config.keepMusicEmbed !== false;
                    const downloadingEmbed = EmbedBuilder.from(infoEmbed);
                    if (keepEmbed) {
                        downloadingEmbed.addFields({ name: 'Status', value: '⏳ Baixando música, aguarde...', inline: true });
                    }
                    await interaction.editReply({ embeds: [downloadingEmbed] });
                    const musicResult = await handleMusicSearchAndDownload(
                        musicInfo.searchQuery,
                        null,
                        { user: interaction.user, userId, userTag: interaction.user.tag, guild: interaction.guild }
                    );
                    // Texto neutro (não diz de onde veio a faixa); temporários sempre liberados.
                    await deliverMusicResult(interaction, musicResult, { embeds: keepEmbed ? [deliveredEmbed] : null, clearEmbeds: true });
                } catch (err) {
                    logDownloadFailure('IdentificarMusica', err);
                    try {
                        await interaction.followUp({ content: `❌ ${musicErrorText(err)}`, allowedMentions: NO_MENTIONS });
                    } catch (replyError) {
                        logger.warn(`[IdentificarMusica] Não consegui avisar o usuário do erro: ${replyError && replyError.message ? replyError.message : replyError}`);
                    }
                } finally {
                    unlockUser(userId);
                }
            } catch (err) {
                logger.error(`[IdentificarMusica] Erro interno: ${err && err.message ? err.message : err}`);
                try {
                    await interaction.editReply({ content: '\u274C Erro interno.' });
                } catch (_) { /* a interação pode ter expirado */ }
            }
        }
    },
};
