const { AttachmentBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const { checkBan } = require('../handlers/banHandler');
const { resolveMentions } = require('../utils/mentions');
const { addToQueue, getChannelSettings, setChannelPersona, setChannelChatter, getServerSettings } = require('../handlers/llmHandler');
const { generateImage } = require('../handlers/imageHandler');
const { downloadYouTubeAudio, sanitizeFilenameForDiscord } = require('../handlers/youtubeAudioHandler');
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
                .setColor(0xE74C3C)
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
                if (!prompt) return message.reply('Forneça um prompt.');
                const processingMessage = await message.reply('Gerando...');
                try {
                    const imageData = await generateImage(prompt);
                    if (imageData?.imageUrl) {
                        await processingMessage.edit({ content: `Pronto! "${prompt}"`, files: [imageData.imageUrl] });
                    } else {
                        await processingMessage.edit('Falhou.');
                    }
                } catch (error) {
                    await processingMessage.edit('Erro interno.');
                }
            } else if (commandName === 'yt_audio') {
                const videoUrl = args[0];
                if (!videoUrl) return message.reply('Forneça a URL.');
                const processingMessage = await message.reply('Baixando...');
                let downloadedAudioInfo = null;
                try {
                    downloadedAudioInfo = await downloadYouTubeAudio(videoUrl);
                    if (downloadedAudioInfo?.filePath) {
                        const attachment = new AttachmentBuilder(downloadedAudioInfo.filePath, { name: `${sanitizeFilenameForDiscord(downloadedAudioInfo.metadata.title)}.mp3` });
                        await processingMessage.edit({ content: `Pronto: \`${downloadedAudioInfo.metadata.title}\``, files: [attachment] });
                    } else {
                        await processingMessage.edit('Falhou.');
                    }
                } catch (error) {
                    await processingMessage.edit(`Erro: ${error.message}`);
                } finally {
                    if (downloadedAudioInfo?.filePath && fs.existsSync(downloadedAudioInfo.filePath)) {
                        fs.unlink(downloadedAudioInfo.filePath, () => {});
                    }
                }
            }
        }
    },
};