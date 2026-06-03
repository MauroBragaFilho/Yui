const { AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const { checkBan } = require('../handlers/banHandler');
const { resolveMentions } = require('../utils/mentions');
const { addToQueue, getChannelSettings, setChannelPersona, setChannelChatter, getServerSettings } = require('../handlers/llmHandler');
const { generateImage } = require('../handlers/imageHandler');
const {
    downloadAudio,
    downloadVideo,
    sanitizeFilenameForDiscord,
    isUserBusy,
    lockUser,
    unlockUser,
    canBypass,
    storeVideoForCompression,
    formatVideoSuccessMessage
} = require('../handlers/youtubeAudioHandler');
const config = require('../config');
module.exports = {
    name: 'messageCreate',
    once: false,
    async execute(message, client) {
        if (message.author.bot) return;
        const banInfo = checkBan(message.author.id, message.guildId, message.channelId);
        if (banInfo) {
            const isMentionForBan = message.mentions.has(client.user, { ignoreEveryone: true });
            if (!isMentionForBan) return;
            const banEmbed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('🛑 ACESSO NEGADO — VOCÊ ESTÁ BANIDO!')
                .setDescription(`Sua tentativa de interação foi abortada. O acesso à **IA Hikari** está permanentemente bloqueado para você.\n\n**DETALHES DO SEU BANIMENTO:**\n- **ALVO:** ${banInfo.typeName || banInfo.type}\n- **MOTIVO:** ${banInfo.reason || 'Violação severa dos Termos de Uso da IA Hikari.'}\n- **STATUS:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.\n\nVocê perdeu todos os privilégios de utilização dos nossos serviços.\n\nSe acredita que isso é um erro, solicite um desbanimento pelo botão abaixo.\n\n---\n💡 **Quer usar a Hikari sem restrições?** Hospede sua própria versão!\n🚀 **Repositório:** [yGuilhermy/Hikari](https://github.com/yGuilhermy/Hikari)`)
                .setFooter({ text: 'Hikari Security & Moderation • by yGuilhermy' })
                .setTimestamp();
            const appealButton = new ButtonBuilder()
                .setCustomId(`appeal_ban_user_${message.author.id}`)
                .setLabel('⚖️ Solicitar Apelação')
                .setStyle(ButtonStyle.Secondary);
            const githubButton = new ButtonBuilder()
                .setLabel('Página do Projeto')
                .setURL('https://github.com/yGuilhermy/Hikari')
                .setStyle(ButtonStyle.Link)
                .setEmoji('🚀');
            const banRow = new ActionRowBuilder().addComponents(appealButton, githubButton);
            return message.reply({ embeds: [banEmbed], components: [banRow] }).catch(() => {});
        }
        if (message.guildId) {
            const { isServerAccepted } = require('../handlers/tosHandler');
            if (!isServerAccepted(message.guildId)) {
                const prefix = config.prefix;
                const isPrefix = message.content.startsWith(prefix);
                const serverSettings = getServerSettings(message.guildId);
                const respondToEveryone = serverSettings.respondToEveryone || false;
                const isMention = message.mentions.has(client.user, { ignoreEveryone: true }) || (respondToEveryone && message.mentions.everyone);
                const botName = config.botName || 'Hikari';
                const nameRegex = new RegExp(`\\b${botName}\\b`, 'i');
                const hasHikariName = nameRegex.test(message.content);
                if (isMention || hasHikariName || isPrefix) {
                    return message.reply({
                        content: '❌ **Acesso Bloqueado!** Este servidor ainda não aceitou os **Termos de Uso da Hikari**. Peça para um administrador liberar o bot executando o comando \`/aceitar_tos\`.'
                    }).catch(() => {});
                }
                return;
            }
        }
        const serverSettings = getServerSettings(message.guildId);
        const respondToEveryone = serverSettings.respondToEveryone || false;
        const isMention = message.mentions.has(client.user, { ignoreEveryone: true }) || (respondToEveryone && message.mentions.everyone);
        const botName = config.botName || 'Hikari';
        const nameRegex = new RegExp(`\\b${botName}\\b`, 'i');
        const hasHikariName = nameRegex.test(message.content);
        if (isMention || hasHikariName) {
            if (message.guildId && message.channelId) {
                const { setServerLastChannel } = require('../handlers/llmHandler');
                setServerLastChannel(message.guildId, message.channelId);
                const { checkAndInitializeUpdateChannel } = require('../handlers/tosHandler');
                await checkAndInitializeUpdateChannel(message.guild, message.channel);
            }
            try {
                let currentUserPrompt = message.content;
                if (isMention) {
                    currentUserPrompt = currentUserPrompt.replace(new RegExp(`<@!?${client.user.id}>`, 'g'), '').trim();
                }
                currentUserPrompt = resolveMentions(currentUserPrompt, client);
                const history = [];
                let repliedMessage = null;
                if (message.reference && message.reference.messageId) {
                    try {
                        repliedMessage = await message.channel.messages.fetch(message.reference.messageId);
                    } catch (err) {
                        console.error(err.message);
                    }
                }
                const recentMessages = await message.channel.messages.fetch({ limit: 10, before: message.id });
                const messageMap = new Map();
                if (repliedMessage) messageMap.set(repliedMessage.id, repliedMessage);
                recentMessages.forEach(msg => {
                    if (msg.author.bot && msg.author.id !== client.user.id) return;
                    if (!messageMap.has(msg.id)) messageMap.set(msg.id, msg);
                });
                const sortedMessages = [...messageMap.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                for (const msg of sortedMessages) {
                    const authorName = msg.author.id === client.user.id ? 'Você (Hikari)' : `${msg.author.username} (${msg.author.id})`;
                    history.push(`${authorName}: ${resolveMentions(msg.content, client)}`);
                }
                const currentDate = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                const finalPrompt = `
--- CONTEXTO DO CHAT ---
Data atual: ${currentDate}
${history.join('\n')}
--- FIM DO CONTEXTO ---
--- MENSAGEM ATUAL ---
${message.author.username} (${message.author.id}): "${currentUserPrompt}"
INSTRUÇÃO: Responda diretamente à mensagem atual considerando o contexto.`;
                if (currentUserPrompt.length > 0 || message.attachments.size > 0) {
                    addToQueue(finalPrompt, message, 'mention', { allowSearch: true, searchPrompt: currentUserPrompt, guildId: message.guildId });
                } else {
                    message.reply('Oi! Vi que me marcou, mas não entendi o que você precisa.');
                }
            } catch (error) {
                console.error(error);
                const fallbackPrompt = message.content.replace(`<@${client.user.id}>`, '').trim();
                if (fallbackPrompt) {
                    addToQueue(fallbackPrompt, message, 'mention', { allowSearch: true, searchPrompt: fallbackPrompt, guildId: message.guildId });
                } else {
                    message.reply('Oi, tive um erro ao ler o histórico.');
                }
            }
        } else {
            const settings = getChannelSettings(message.channelId);
            if (settings?.chatter?.active) {
                let chance = 0;
                if (settings.chatter.percentage !== undefined && settings.chatter.percentage !== null) {
                    chance = settings.chatter.percentage / 100;
                } else {
                    switch (settings.chatter.frequency) {
                        case 'low': chance = 0.01; break;
                        case 'medium': chance = 0.05; break;
                        case 'high': chance = 0.15; break;
                    }
                }
                if (Math.random() < chance) {
                    if (message.guildId && message.channelId) {
                        const { setServerLastChannel } = require('../handlers/llmHandler');
                        setServerLastChannel(message.guildId, message.channelId);
                        const { checkAndInitializeUpdateChannel } = require('../handlers/tosHandler');
                        await checkAndInitializeUpdateChannel(message.guild, message.channel);
                    }
                    try {
                        const currentUserPrompt = resolveMentions(message.content, client);
                        const history = [];
                        const recentMessages = await message.channel.messages.fetch({ limit: 5, before: message.id });
                        [...recentMessages.values()].reverse().forEach(msg => {
                            const authorName = msg.author.id === client.user.id ? 'Você (Hikari)' : `${msg.author.username} (${msg.author.id})`;
                            history.push(`${authorName}: ${resolveMentions(msg.content, client)}`);
                        });
                        const currentDate = new Date().toLocaleDateString('pt-BR', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });
                        const finalPrompt = `
--- CONTEXTO DO CHAT ---
Data atual: ${currentDate}
${history.join('\n')}
--- MENSAGEM ATUAL ---
${message.author.username}: "${currentUserPrompt}"
INSTRUÇÃO: Entre na conversa espontaneamente.`;
                        addToQueue(finalPrompt, message, 'mention', { allowSearch: true, searchPrompt: currentUserPrompt, guildId: message.guildId });
                    } catch (error) {
                        console.error(error);
                    }
                }
            }
        }
        const prefix = config.prefix;
        if (message.content.startsWith(prefix)) {
            if (message.guildId && message.channelId) {
                const { setServerLastChannel } = require('../handlers/llmHandler');
                setServerLastChannel(message.guildId, message.channelId);
                const { checkAndInitializeUpdateChannel } = require('../handlers/tosHandler');
                await checkAndInitializeUpdateChannel(message.guild, message.channel);
            }
            const args = message.content.slice(prefix.length).trim().split(/ +/);
            const commandName = args.shift().toLowerCase();
            if (commandName === 'draw') {
                const prompt = args.join(' ');
                if (!prompt) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('⚠️ Prompt Ausente')
                        .setDescription('Por favor, forneça uma descrição/prompt para gerar a imagem. Exemplo: `h!draw uma raposa no espaço`');
                    return message.reply({ embeds: [errorEmbed] });
                }
                const processingEmbed = new EmbedBuilder()
                    .setColor(0x3B82F6)
                    .setTitle('🎨 Gerando Imagem...')
                    .setDescription('Iniciando o processo de geração da sua imagem. Por favor, aguarde...');
                const processingMessage = await message.reply({ embeds: [processingEmbed] });
                try {
                    const imageData = await generateImage(prompt);
                    if (imageData?.imageUrl) {
                        const successEmbed = new EmbedBuilder()
                            .setColor(0x10B981)
                            .setTitle('🎨 Imagem Gerada com Sucesso')
                            .setDescription(`Prompt: **"${prompt}"**`)
                            .setImage(imageData.imageUrl);
                        await processingMessage.edit({ content: null, embeds: [successEmbed] });
                    } else {
                        const failEmbed = new EmbedBuilder()
                            .setColor(0xE11D48)
                            .setTitle('❌ Falha na Geração')
                            .setDescription('Não foi possível gerar a imagem no momento. Tente novamente mais tarde.');
                        await processingMessage.edit({ content: null, embeds: [failEmbed] });
                    }
                } catch (error) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro Interno')
                        .setDescription('Ocorreu um erro interno ao tentar gerar a imagem.');
                    await processingMessage.edit({ content: null, embeds: [errEmbed] });
                }
            } else if (commandName === 'yt_audio') {
                const videoUrl = args[0];
                if (!videoUrl) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('⚠️ Link Ausente')
                        .setDescription('Por favor, forneça a URL do vídeo do YouTube, Instagram ou TikTok. Exemplo: `h!yt_audio <link>`');
                    return message.reply({ embeds: [errorEmbed] });
                }
                const userId = message.author.id;
                if (!canBypass(userId) && isUserBusy(userId)) {
                    const busyEmbed = new EmbedBuilder()
                        .setColor(0xF59E0B)
                        .setTitle('⏳ Processo em Andamento')
                        .setDescription('Você já tem um download ou compressão ativa. Por favor, aguarde a conclusão.');
                    return message.reply({ embeds: [busyEmbed] });
                }
                const processingEmbed = new EmbedBuilder()
                    .setColor(0x3B82F6)
                    .setTitle('🎧 Baixando Áudio...')
                    .setDescription('Estou baixando e convertendo o áudio solicitado. Por favor, aguarde...');
                const processingMessage = await message.reply({ embeds: [processingEmbed] });
                lockUser(userId);
                let downloadedAudioInfo = null;
                try {
                    downloadedAudioInfo = await downloadAudio(videoUrl, { source: 'Prefixo', user: message.author, guild: message.guild });
                    if (downloadedAudioInfo?.filePath) {
                        const attachment = new AttachmentBuilder(downloadedAudioInfo.filePath, { name: `${sanitizeFilenameForDiscord(downloadedAudioInfo.metadata.title)}.mp3` });
                        const successEmbed = new EmbedBuilder()
                            .setColor(0x10B981)
                            .setTitle('✅ Áudio Pronto')
                            .setDescription(`O áudio de **${downloadedAudioInfo.metadata.title}** foi baixado com sucesso!`);
                        await processingMessage.edit({ content: null, embeds: [successEmbed], files: [attachment] });
                    } else {
                        const failEmbed = new EmbedBuilder()
                            .setColor(0xE11D48)
                            .setTitle('❌ Falha no Download')
                            .setDescription('Não foi possível obter o áudio no momento.');
                        await processingMessage.edit({ content: null, embeds: [failEmbed] });
                    }
                } catch (error) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro no Processamento')
                        .setDescription(`Não foi possível baixar o áudio: ${error.message}`);
                    await processingMessage.edit({ content: null, embeds: [errEmbed] });
                } finally {
                    unlockUser(userId);
                    if (downloadedAudioInfo?.filePath && fs.existsSync(downloadedAudioInfo.filePath)) {
                        fs.unlink(downloadedAudioInfo.filePath, () => {});
                    }
                }
            } else if (commandName === 'yt_video') {
                const videoUrl = args[0];
                const showDetails = args[1] === 'true' || args[1] === '--desc' || args[1] === '--details';
                if (!videoUrl) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('⚠️ Link Ausente')
                        .setDescription('Por favor, forneça a URL do vídeo (YouTube Shorts, Instagram Reels ou TikTok).');
                    return message.reply({ embeds: [errorEmbed] });
                }
                const userId = message.author.id;
                if (!canBypass(userId) && isUserBusy(userId)) {
                    const busyEmbed = new EmbedBuilder()
                        .setColor(0xF59E0B)
                        .setTitle('⏳ Processo em Andamento')
                        .setDescription('Você já tem um download ou compressão ativa. Por favor, aguarde a conclusão.');
                    return message.reply({ embeds: [busyEmbed] });
                }
                const processingEmbed = new EmbedBuilder()
                    .setColor(0x3B82F6)
                    .setTitle('🎬 Baixando Vídeo...')
                    .setDescription('Obtendo o arquivo de vídeo do link fornecido. Por favor, aguarde...');
                const processingMessage = await message.reply({ embeds: [processingEmbed] });
                lockUser(userId);
                try {
                    const videoData = await downloadVideo(videoUrl, { source: 'Prefixo', user: message.author, guild: message.guild });
                    const guild = message.guild;
                    const attachmentLimit = guild ? guild.premiumTier === 3 ? 100 * 1024 * 1024 : guild.premiumTier === 2 ? 50 * 1024 * 1024 : 25 * 1024 * 1024 : 25 * 1024 * 1024;
                    if (videoData.fileSize <= attachmentLimit) {
                        const displayFileName = sanitizeFilenameForDiscord(videoData.metadata.title || 'video');
                        const attachment = new AttachmentBuilder(videoData.filePath, { name: `${displayFileName}.mp4` });
                        await processingMessage.edit({ content: formatVideoSuccessMessage(videoData, showDetails), embeds: [], files: [attachment] });
                        try { if (fs.existsSync(videoData.filePath)) fs.unlinkSync(videoData.filePath); } catch (e) {}
                    } else {
                        const fileId = storeVideoForCompression(videoData.filePath);
                        const sizeMB = (videoData.fileSize / (1024 * 1024)).toFixed(1);
                        const limitMB = (attachmentLimit / (1024 * 1024)).toFixed(0);
                        const { EmbedBuilder: EB, ActionRowBuilder: AR, ButtonBuilder: BB, ButtonStyle: BS } = require('discord.js');
                        const compressEmbed = new EB()
                            .setColor(0xF59E0B)
                            .setTitle('📦 Vídeo Grande Demais')
                            .setDescription(`O vídeo tem **${sizeMB} MB**, mas o limite é **${limitMB} MB**.\nClique no botão para tentar comprimir.\n\n⏰ *Disponível por 6 horas.*`)
                            .setFooter({ text: 'Hikari Media • by yGuilhermy' })
                            .setTimestamp();
                        const row = new AR().addComponents(
                            new BB().setCustomId(`compress_video_${fileId}`).setLabel('🔄 Tentar Compressão').setStyle(BS.Primary)
                        );
                        await processingMessage.edit({ content: '', embeds: [compressEmbed], components: [row] });
                    }
                } catch (error) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro no Processamento')
                        .setDescription(`Não foi possível baixar o vídeo: ${error.message}`);
                    await processingMessage.edit({ content: null, embeds: [errEmbed] });
                } finally {
                    unlockUser(userId);
                }
            }
        }
    },
};