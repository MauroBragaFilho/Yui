const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { checkBan } = require('../handlers/banHandler');
const { resolveMentions } = require('../utils/mentions');
const { addToQueue, getChannelSettings, getServerSettings } = require('../handlers/llmHandler');
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
                .setDescription(`Sua tentativa de interação foi abortada. O acesso à **IA Yui** está permanentemente bloqueado para você.\n\n**DETALHES DO SEU BANIMENTO:**\n- **ALVO:** ${banInfo.typeName || banInfo.type}\n- **MOTIVO:** ${banInfo.reason || 'Violação severa dos Termos de Uso da IA Yui.'}\n- **STATUS:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.\n\nVocê perdeu todos os privilégios de utilização dos nossos serviços.\n\nSe acredita que isso é um erro, solicite um desbanimento pelo botão abaixo.\n\n---\n💡 **Quer usar a Yui sem restrições?** Hospede sua própria versão!\n🚀 **Repositório:** [yGuilhermy/Yui](https://github.com/yGuilhermy/Yui)`)
                .setFooter({ text: 'Yui Security & Moderation • by yGuilhermy' })
                .setTimestamp();
            const appealButton = new ButtonBuilder()
                .setCustomId(`appeal_ban_user_${message.author.id}`)
                .setLabel('⚖️ Solicitar Apelação')
                .setStyle(ButtonStyle.Secondary);
            const githubButton = new ButtonBuilder()
                .setLabel('Página do Projeto')
                .setURL('https://github.com/yGuilhermy/Yui')
                .setStyle(ButtonStyle.Link)
                .setEmoji('🚀');
            const banRow = new ActionRowBuilder().addComponents(appealButton, githubButton);
            return message.reply({ embeds: [banEmbed], components: [banRow] }).catch(() => {});
        }
        if (message.guildId) {
            const { isServerAccepted, sendTermsOfService } = require('../handlers/tosHandler');
            if (!isServerAccepted(message.guildId)) {
                const serverSettings = getServerSettings(message.guildId);
                const respondToEveryone = serverSettings.respondToEveryone || false;
                const isMention = message.mentions.has(client.user, { ignoreEveryone: true }) || (respondToEveryone && message.mentions.everyone);
                const botName = config.botName || 'Yui';
                const nameRegex = new RegExp(`\\b${botName}\\b`, 'i');
                const hasYuiName = nameRegex.test(message.content);
                let isReplyToBot = false;
                if (message.reference && message.reference.messageId) {
                    try {
                        const refMsg = message.channel.messages.cache.get(message.reference.messageId);
                        if (refMsg && refMsg.author && refMsg.author.id === client.user.id) {
                            isReplyToBot = true;
                        }
                    } catch (e) {}
                }
                const settings = getChannelSettings(message.channelId);
                const isChatterActive = settings?.chatter?.active || false;
                if (isMention || hasYuiName || isReplyToBot || isChatterActive) {
                    await sendTermsOfService(message);
                }
                return;
            }
        }
        const serverSettings = getServerSettings(message.guildId);
        const respondToEveryone = serverSettings.respondToEveryone || false;
        const isMention = message.mentions.has(client.user, { ignoreEveryone: true }) || (respondToEveryone && message.mentions.everyone);
        const botName = config.botName || 'Yui';
        const nameRegex = new RegExp(`\\b${botName}\\b`, 'i');
        const hasYuiName = nameRegex.test(message.content);
        if (isMention || hasYuiName) {
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
                    const isBot = msg.author.id === client.user.id;
                    const authorName = isBot ? 'Yui' : msg.author.username;
                    let content = resolveMentions(msg.content, client);
                    if (isBot && (content.includes('erro ao processar seu pedido') || content.includes('Limites de Processamento Atingidos') || content.includes('Desculpe, tive um erro'))) {
                        content = 'erro da ia';
                    }
                    if (isBot) {
                        content = content.replace(/^-# .*$/gm, '').replace(/🧠 \*\*Processando\.\.\.\*\*/g, '').trim();
                    }
                    if (content.trim().length === 0) continue;
                    if (content.length > 500) content = content.substring(0, 500) + '...';
                    history.push(`${authorName}: ${content}`);
                }
                const currentDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                let envInfo = '';
                if (config.sendEnvironmentInfo) {
                    envInfo = `Servidor: ${message.guild?.name || 'DM'} | Canal: #${message.channel?.name || 'Chat'}\n`;
                }
                const finalPrompt = `--- CONTEXTO ---\nData: ${currentDate}\n${envInfo}${history.join('\n')}\n--- MENSAGEM ATUAL ---\n${message.author.username}: "${currentUserPrompt}"\nINSTRUÇÃO: Responda diretamente à mensagem atual. Não repita o que o usuário disse nem o que você disse antes.`;
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
                            const isBot = msg.author.id === client.user.id;
                            const authorName = isBot ? 'Yui' : msg.author.username;
                            let content = resolveMentions(msg.content, client);
                            if (isBot && (content.includes('erro ao processar seu pedido') || content.includes('Limites de Processamento Atingidos') || content.includes('Desculpe, tive um erro'))) {
                                content = 'erro da ia';
                            }
                            if (isBot) {
                                content = content.replace(/^-# .*$/gm, '').replace(/🧠 \*\*Processando\.\.\.\*\*/g, '').trim();
                            }
                            if (content.trim().length === 0) return;
                            if (content.length > 500) content = content.substring(0, 500) + '...';
                            history.push(`${authorName}: ${content}`);

                        });
                        const currentDate = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit' });
                        let envInfo = '';
                        if (config.sendEnvironmentInfo) {
                            envInfo = `Servidor: ${message.guild?.name || 'DM'} | Canal: #${message.channel?.name || 'Chat'}\n`;
                        }
                        const finalPrompt = `--- CONTEXTO ---\nData: ${currentDate}\n${envInfo}${history.join('\n')}\n--- MENSAGEM ATUAL ---\n${message.author.username}: "${currentUserPrompt}"\nINSTRUÇÃO: Entre na conversa espontaneamente sem repetir o que foi dito.`;
                        addToQueue(finalPrompt, message, 'mention', { allowSearch: true, searchPrompt: currentUserPrompt, guildId: message.guildId });

                    } catch (error) {
                        console.error(error);
                    }
                }
            }
        }
    },
};