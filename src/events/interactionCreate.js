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
    sanitizeFilenameForDiscord,
    isUserBusy,
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
import { baixarMusicaCommand } from '../discord/commands/baixarMusica.js';

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
                    title: `âš–ï¸ Regras & Termos (${idx + 1}/${categorySections.length}) â€¢ ${firstLine}`,
                    content: `### ${firstLine}\n\n${body}`
                };
            });
        }
    }
    return [{
        title: 'âš–ï¸ Regras & Termos (1/1)',
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
                        .setTitle('âŒ Acesso Negado')
                        .setDescription('Esta aÃ§Ã£o Ã© restrita ao criador da Yui.');
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
                    return interaction.reply({ content: 'ðŸ›‘ **ACESSO NEGADO:** VocÃª estÃ¡ banido do sistema e nÃ£o pode interagir.', ephemeral: true });
                }
                const targetUserId = interaction.customId.replace('music_select_', '');
                if (interaction.user.id !== targetUserId) {
                    return interaction.reply({ content: 'âŒ Esta seleÃ§Ã£o pertence a outro usuÃ¡rio.', ephemeral: true });
                }
                const selectedIndex = interaction.values[0];
                await interaction.update({ content: 'ðŸ”„ **Processando download da faixa selecionada...**', embeds: [], components: [] });
                const result = await handleMusicSearchAndDownload(null, selectedIndex, {
                    user: interaction.user,
                    userId: interaction.user.id,
                    userTag: interaction.user.tag,
                    guild: interaction.guild
                });
                if (result.error) {
                    return await interaction.editReply({ content: `âŒ ${result.error}` });
                }
                if (result.success) {
                    const keepEmbed = config.keepMusicEmbed !== false;
                    const replyPayload = {
                        content: `âœ… MÃºsica baixada: \`${result.track.title} - ${result.track.artist}\``,
                        files: [result.attachment],
                    };
                    if (keepEmbed && result.infoEmbed) {
                        replyPayload.embeds = [result.infoEmbed];
                    }
                    await interaction.editReply(replyPayload);
                    if (typeof result.cleanup === 'function') {
                        result.cleanup();
                    }
                }
                return;
            }
            if (interaction.customId === 'cfgpanel_goto_select') {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('âŒ Acesso Negado')
                        .setDescription('Esta aÃ§Ã£o Ã© restrita ao criador da Yui.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigSelect(interaction);
            }
            if (interaction.customId.startsWith('banlist_select_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('âŒ Acesso Negado')
                        .setDescription('Esta aÃ§Ã£o Ã© restrita ao criador da Yui.');
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
                    return interaction.reply({ content: 'ðŸ›‘ **ACESSO NEGADO:** VocÃª estÃ¡ banido do sistema e nÃ£o pode interagir.', ephemeral: true });
                }
                const targetUserId = cid.replace('music_cancel_', '');
                if (interaction.user.id !== targetUserId) {
                    return interaction.reply({ content: 'âŒ Esta aÃ§Ã£o pertence a outro usuÃ¡rio.', ephemeral: true });
                }
                clearSession(interaction.user.id);
                return await interaction.update({ content: 'âŒ **Pesquisa de mÃºsica cancelada.**', embeds: [], components: [] });
            }
            if (cid.startsWith('cfgpanel_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('âŒ Acesso Negado')
                        .setDescription('Esta aÃ§Ã£o Ã© restrita ao criador da Yui.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigButton(interaction);
            }
            if (cid.startsWith('adm_') || cid.startsWith('banlist_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('âŒ Acesso Negado')
                        .setDescription('Esta aÃ§Ã£o Ã© restrita ao criador da Yui.');
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
                        await interaction.update({ content: `âœ… SaÃ­ do servidor \`${targetGuild.name}\` com sucesso.`, embeds: [], components: [] });
                    } else {
                        await interaction.reply({ content: 'âŒ Servidor nÃ£o encontrado ou jÃ¡ saÃ­.', ephemeral: true });
                    }
                } else if (action === 'confirm') {
                    await interaction.update({ content: 'âœ… Servidor confirmado e botÃ£o ignorado.', components: [] });
                }
                return;
            } else if (cid.startsWith('adm_remoteban_')) {
                const parts = cid.split('_');
                const type = parts[2];
                const targetId = parts[3];
                if (type === 'ignore') {
                    await interaction.update({ content: 'âœ… Alerta ignorado.', components: [] });
                } else {
                    addBan(type, targetId, "Banido remotamente pelo log de violaÃ§Ãµes do sistema Yui.");
                    await interaction.update({ content: `âœ… Alvo \`${targetId}\` (${type}) banido com sucesso.`, components: [] });
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
                    return await interaction.reply({ content: 'âŒ Sem mais registros.', ephemeral: true });
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
                    .setTitle('ðŸ”“ Desbanido com Sucesso')
                    .setDescription(`O alvo com ID \`${targetId}\` (${apiType}) foi desbanido do sistema.`);
                const row = new ActionRowBuilder().addComponents(
                    new ButtonBuilder().setCustomId('banlist_home').setLabel('ðŸ  InÃ­cio').setStyle(ButtonStyle.Primary)
                );
                return await interaction.update({ embeds: [embed], components: [row] });
            }

            if (cid.startsWith('compress_video_')) {
                const fileId = cid.replace('compress_video_', '');
                const pending = getPendingVideo(fileId);
                if (!pending) {
                    return interaction.reply({ content: 'â° Este vÃ­deo jÃ¡ expirou (limite de 6 horas). FaÃ§a o download novamente.', ephemeral: true });
                }
                const guild = interaction.guild;
                const attachmentLimit = guild ? guild.premiumTier === 3 ? 100 * 1024 * 1024 : guild.premiumTier === 2 ? 50 * 1024 * 1024 : 25 * 1024 * 1024 : 25 * 1024 * 1024;
                const isQueue = isCompressionActive();
                const progressEmbed = new EmbedBuilder()
                    .setFooter({ text: 'Yui Media â€¢ by oBraga' })
                    .setTimestamp();
                if (isQueue) {
                    progressEmbed.setColor(0xF59E0B)
                        .setTitle('â³ CompressÃ£o na Fila')
                        .setDescription('JÃ¡ existe uma compressÃ£o de vÃ­deo em andamento no bot. Seu vÃ­deo foi adicionado Ã  fila de espera e serÃ¡ processado automaticamente assim que a atual terminar!\n\nPor favor, aguarde...');
                } else {
                    progressEmbed.setColor(0x3B82F6)
                        .setTitle('ðŸ”„ Comprimindo VÃ­deo...')
                        .setDescription('Iniciando a compressÃ£o do vÃ­deo para reduzir o tamanho do arquivo. Isso pode levar alguns minutos. NÃ£o se preocupe, estou trabalhando nisso!');
                }
                await interaction.update({ embeds: [progressEmbed], components: [] });
                logCompressionAction({ user: interaction.user, guild: interaction.guild }, isQueue ? 'Fila' : 'Iniciado');
                try {
                    const result = await enqueueCompression(pending.filePath, attachmentLimit, interaction.user.id);
                    const attachment = new AttachmentBuilder(result.filePath, { name: 'video_compressed.mp4' });
                    const sizeMB = (result.fileSize / (1024 * 1024)).toFixed(1);
                    await interaction.editReply({ content: `âœ… **VÃ­deo comprimido com sucesso!** (${sizeMB} MB)`, embeds: [], files: [attachment], components: [] });
                    logCompressionAction({ user: interaction.user, guild: interaction.guild }, 'Sucesso', `Tamanho: ${sizeMB} MB`);
                    try { if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath); } catch (e) {}
                    removePendingVideo(fileId);
                } catch (compressError) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('âŒ Falha na CompressÃ£o')
                        .setFooter({ text: 'Yui Media â€¢ by oBraga' })
                        .setTimestamp();
                    if (compressError.message === 'MEMORY_ERROR') {
                        errorEmbed.setDescription(`âš ï¸ Ocorreu um erro de falta de memÃ³ria no servidor da host ao tentar comprimir o vÃ­deo. Por favor, entre em contato com <@${config.ownerId}>.`);
                    } else {
                        errorEmbed.setDescription(`âŒ Ocorreu um erro ao comprimir o vÃ­deo: ${compressError.message}`);
                    }
                    await interaction.editReply({ embeds: [errorEmbed], components: [] });
                    logCompressionAction({ user: interaction.user, guild: interaction.guild }, 'Erro', `Detalhe: ${compressError.message}`);
                }
                return;
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
            const cmdLog = `[LOG] Slash: /${interaction.commandName}${sub ? ' ' + sub : ''} | UsuÃ¡rio: ${interaction.user.tag} (${interaction.user.id}) | Local: {${interaction.guild?.name || 'DM'} - ${interaction.guildId || 'N/A'}}`;
            console.log(cmdLog);
            const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
            if (banInfo && interaction.commandName !== 'ajuda') {
                const banEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('ðŸ›‘ ACESSO NEGADO â€” VOCÃŠ ESTÃ BANIDO!')
                    .setDescription(`Sua tentativa de execuÃ§Ã£o foi abortada. O acesso Ã  **IA Yui** estÃ¡ permanentemente bloqueado para vocÃª.\n\n**DETALHES DO SEU BANIMENTO:**\n- **Tipo:** ${banInfo.typeName || banInfo.type}\n- **Motivo do Banimento:** ${banInfo.reason || "ViolaÃ§Ã£o severa dos Termos de Uso da IA Yui."}\n- **Status Atual:** ðŸ”´ TOTALMENTE RESTRITO / SUSPENSO.\n\nVocÃª perdeu todos os privilÃ©gios de utilizaÃ§Ã£o dos nossos serviÃ§os. NÃ£o adianta insistir.\n\nSe vocÃª acredita que isso Ã© um erro ou deseja solicitar um desbanimento, entre em contato com o desenvolvedor: <@${config.ownerId}> [\[Abrir Perfil\](https://discord.com/users/${config.ownerId})] âœ¨`)
                    .setFooter({ text: 'Yui Security & Moderation â€¢ by oBraga' })
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
                                name: `${isDisabled ? 'âŒ' : 'âœ…'} ðŸŽ™ï¸ Assistente de Voz (Call)`,
                                value: 'join_voice_call'
                            };
                        }
                        const isDisabled = disabled.includes(t.function.name);
                        return {
                            name: `${isDisabled ? 'âŒ' : 'âœ…'} ${t.meta.label}`,
                            value: t.function.name
                        };
                    })
                    .filter(c => c.name.toLowerCase().includes(focused) || c.value.toLowerCase().includes(focused))
                    .slice(0, 25);
                return interaction.respond(choices);
            }
            if (interaction.commandName === 'converter_moeda') {
                const CURRENCIES = [
                    { name: 'ðŸ‡§ðŸ‡· BRL â€” Real Brasileiro',            value: 'BRL' },
                    { name: 'ðŸ‡ºðŸ‡¸ USD â€” DÃ³lar Americano',           value: 'USD' },
                    { name: 'ðŸ‡ªðŸ‡º EUR â€” Euro',                       value: 'EUR' },
                    { name: 'ðŸ‡¬ðŸ‡§ GBP â€” Libra Esterlina',            value: 'GBP' },
                    { name: 'ðŸ’¹ BTC â€” Bitcoin',                     value: 'BTC' },
                    { name: 'ðŸ’¸ ETH â€” Ethereum',                    value: 'ETH' },
                    { name: 'ðŸ’µ USDT â€” Tether',                    value: 'USDT' },
                    { name: 'ðŸ‡¯ðŸ‡µ JPY â€” Iene JaponÃªs',              value: 'JPY' },
                    { name: 'ðŸ‡¨ðŸ‡¦ CAD â€” DÃ³lar Canadense',           value: 'CAD' },
                    { name: 'ðŸ‡¨ðŸ‡­ CHF â€” Franco SuÃ­Ã§o',              value: 'CHF' },
                    { name: 'ðŸ‡¦ðŸ‡º AUD â€” DÃ³lar Australiano',         value: 'AUD' },
                    { name: 'ðŸ‡¨ðŸ‡³ CNY â€” Yuan ChinÃªs',               value: 'CNY' },
                    { name: 'ðŸ‡°ðŸ‡· KRW â€” Won Sul-Coreano',           value: 'KRW' },
                    { name: 'ðŸ‡²ðŸ‡½ MXN â€” Peso Mexicano',             value: 'MXN' },
                    { name: 'ðŸ‡¦ðŸ‡· ARS â€” Peso Argentino',             value: 'ARS' },
                    { name: 'ðŸ‡¨ðŸ‡± CLP â€” Peso Chileno',               value: 'CLP' },
                    { name: 'ðŸ‡¨ðŸ‡´ COP â€” Peso Colombiano',            value: 'COP' },
                    { name: 'ðŸ‡ºðŸ‡¾ UAH â€” Hryvnia Ucraniana',          value: 'UAH' },
                    { name: 'ðŸ‡·ðŸ‡º RUB â€” Rublo Russo',                value: 'RUB' },
                    { name: 'ðŸ‡®ðŸ‡³ INR â€” Rupia Indiana',              value: 'INR' },
                    { name: 'ðŸ‡³ðŸ‡¿ NZD â€” DÃ³lar NeozelandÃªs',         value: 'NZD' },
                    { name: 'ðŸ‡¸ðŸ‡¬ SGD â€” DÃ³lar de Singapura',       value: 'SGD' },
                    { name: 'ðŸ‡¸ðŸ‡¦ SAR â€” Riyal Saudita',              value: 'SAR' },
                    { name: 'ðŸ§© SOL â€” Solana',                      value: 'SOL' },
                    { name: 'ðŸ§© BNB â€” BNB (Binance)',                value: 'BNB' },
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
                    .setTitle('âŒ Acesso Negado')
                    .setDescription('Apenas administradores do servidor podem aceitar os Termos de Uso.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const { isServerAccepted, sendTermsOfService } = await import('../handlers/tosHandler.js');
            if (isServerAccepted(interaction.guildId)) {
                const alreadyAcceptedEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('âœ… Termos de Uso JÃ¡ Aceitos')
                    .setDescription('Os Termos de Uso da Yui jÃ¡ foram previamente aceitos e estÃ£o ativos neste servidor.')
                    .setFooter({ text: 'Yui ToS â€¢ by oBraga' })
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
                        .setTitle('ðŸŽ¨ Imagem Gerada')
                        .setDescription('âš ï¸ **Aviso:** Eu apenas **gero** imagens novas a partir de texto. Eu **nÃ£o edito** imagens e **nÃ£o tenho visÃ£o computacional** para ver arquivos.')
                        .addFields(
                            { name: 'ðŸ¤– Modelo', value: `\`${imageData.modelName || 'Desconhecido'}\``, inline: false },
                            { name: 'ðŸŒ± Seed', value: `\`${imageData.actualSeed}\``, inline: true },
                            { name: 'ðŸ“ ResoluÃ§Ã£o', value: `\`${width}x${height}\``, inline: true }
                        )
                        .setFooter({ text: `Prompt: ${prompt.substring(0, 100)} â€¢ by oBraga` })
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
                        .setTitle('âŒ Falha na GeraÃ§Ã£o')
                        .setDescription('NÃ£o consegui gerar a imagem.');
                    await interaction.editReply({ embeds: [errEmbed] });
                }
            } catch (error) {
                console.error('Erro /draw:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('âŒ Erro')
                    .setDescription(error.message);
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'baixar_musica') {
            await baixarMusicaCommand.execute(interaction);
        } else if (commandName === 'baixar_video') {
            const videoUrl = interaction.options.getString('url');
            const showDetails = interaction.options.getBoolean('descricao') || false;
            const userId = interaction.user.id;
            if (!canBypass(userId) && isUserBusy(userId)) {
                const waitEmbed = new EmbedBuilder()
                    .setColor(0xF59E0B)
                    .setTitle('â³ Download em Andamento')
                    .setDescription('VocÃª jÃ¡ tem um download em execuÃ§Ã£o. Por favor, aguarde ele terminar.');
                return interaction.reply({ embeds: [waitEmbed], ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: false });
            lockUser(userId);
            try {
                const videoData = await downloadVideo(videoUrl, { source: 'Slash', user: interaction.user, guild: interaction.guild });
                const guild = interaction.guild;
                const attachmentLimit = guild ? guild.premiumTier === 3 ? 100 * 1024 * 1024 : guild.premiumTier === 2 ? 50 * 1024 * 1024 : 25 * 1024 * 1024 : 25 * 1024 * 1024;
                if (videoData.fileSize <= attachmentLimit) {
                    const displayFileName = sanitizeFilenameForDiscord(videoData.metadata.title || 'video');
                    const attachment = new AttachmentBuilder(videoData.filePath, { name: `${displayFileName}.mp4` });
                    const sizeMB = (videoData.fileSize / (1024 * 1024)).toFixed(1);
                    await interaction.editReply({ content: formatVideoSuccessMessage(videoData, showDetails), files: [attachment] });
                    try { if (fs.existsSync(videoData.filePath)) fs.unlinkSync(videoData.filePath); } catch (e) {}
                } else {
                    const fileId = storeVideoForCompression(videoData.filePath);
                    const sizeMB = (videoData.fileSize / (1024 * 1024)).toFixed(1);
                    const limitMB = (attachmentLimit / (1024 * 1024)).toFixed(0);
                    const compressEmbed = new EmbedBuilder()
                        .setColor(0xF39C12)
                        .setTitle('ðŸ“¦ VÃ­deo Grande Demais')
                        .setDescription(`O vÃ­deo **${videoData.metadata.title}** tem **${sizeMB} MB**, mas o limite deste servidor Ã© **${limitMB} MB**.\n\nClique no botÃ£o abaixo para tentar comprimir o vÃ­deo automaticamente.\n\nâ° *O arquivo ficarÃ¡ disponÃ­vel por 6 horas.*`)
                        .setFooter({ text: 'Yui Media â€¢ by oBraga' })
                        .setTimestamp();
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`compress_video_${fileId}`).setLabel('ðŸ”„ Tentar CompressÃ£o').setStyle(ButtonStyle.Primary)
                    );
                    await interaction.editReply({ embeds: [compressEmbed], components: [row] });
                }
            } catch (error) {
                console.error('[BaixarVideo]', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('âŒ Erro')
                    .setDescription(error.message);
                await interaction.editReply({ embeds: [errEmbed] });
            } finally {
                unlockUser(userId);
            }
        } else if (commandName === 'buscar_jogo') {
            await executeGameCommand(interaction);
        } else if (commandName === 'chat_resumo') {
            const amount = interaction.options.getInteger('quantidade') || 20;
            await interaction.deferReply();
            try {
                const messages = await interaction.channel.messages.fetch({ limit: amount });
                const sortedMessages = [...messages.values()].sort((a, b) => a.createdTimestamp - b.createdTimestamp);
                let conversationLog = "";
                sortedMessages.forEach(msg => {
                    if (msg.content) {
                        const time = msg.createdAt.toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
                        conversationLog += `[${time}] ${msg.author.username}: ${msg.content}\n`;
                    }
                });
                const summaryPrompt = `FaÃ§a um resumo: \n${conversationLog}`;
                addToQueue(summaryPrompt, interaction, 'slash', { allowSearch: false, disableTools: true });
            } catch (error) {
                console.error('summary:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('âŒ Erro no Resumo')
                    .setDescription('NÃ£o foi possÃ­vel obter o histÃ³rico de mensagens ou gerar o resumo deste canal.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'anime_origem') {
            await handleSauceCommand(interaction);
        } else if (commandName === 'yui-config_ia') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('âŒ Acesso Negado')
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
                        .setTitle('âŒ Dados Insuficientes')
                        .setDescription('Para configurar um provedor de IA, especifique a configuraÃ§Ã£o e o valor.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                updateProviderSetting(provider, setting, value);
            }
            const successEmbed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('âš™ï¸ ConfiguraÃ§Ãµes â€¢ ParÃ¢metros de IA')
                .setDescription('As variÃ¡veis operacionais dos modelos de IA foram ajustadas com sucesso.');
            if (provider) {
                successEmbed.addFields(
                    { name: 'Provedor', value: provider, inline: true },
                    { name: 'ConfiguraÃ§Ã£o', value: setting, inline: true },
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
                        .setTitle('âŒ Erro na Steam')
                        .setDescription(steamInfo.error);
                    return await interaction.editReply({ embeds: [errEmbed] });
                }

                let finalDesc = steamInfo.description || "Sem sinopse vÃ¡lida.";
                if (finalDesc.length > 3900) finalDesc = finalDesc.substring(0, 3900) + '...';

                const steamEmbed = new EmbedBuilder()
                    .setColor(0x7C3AED)
                    .setTitle(steamInfo.name)
                    .setURL(steamInfo.url)
                    .setDescription(finalDesc)
                    .addFields(
                        { name: 'PreÃ§o', value: steamInfo.discount > 0 ? `~~${steamInfo.originalPrice}~~ **${steamInfo.price}** (-${steamInfo.discount}%)` : steamInfo.price, inline: true },
                        { name: 'LanÃ§amento', value: steamInfo.releaseDate, inline: true },
                        { name: 'Desenvolvedor', value: steamInfo.developers, inline: true }
                    )
                    .setFooter({ text: 'Fonte: Loja da Steam â€¢ Yui â€¢ by oBraga' })
                    .setTimestamp();

                if (steamInfo.headerImage) {
                    steamEmbed.setImage(steamInfo.headerImage);
                }
                if (steamInfo.metacritic) {
                    steamEmbed.addFields({ name: 'Metacritic', value: `${steamInfo.metacritic}/100 ðŸŒŸ`, inline: true });
                }

                let yuiComment = "";
                try {
                    const commentPrompt = `Eu acabei de consultar o jogo "${steamInfo.name}" na Steam via comando manual. O preÃ§o atual Ã© ${steamInfo.price}. FaÃ§a um comentÃ¡rio CURTO (mÃ¡ximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
                    const rawComment = await generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
                    if (rawComment && !rawComment.includes('âš ï¸ SYSTEM ERROR')) {
                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || cleanData;
                            } catch (e) {}
                        }
                        yuiComment = cleanData;
                    }
                } catch (e) {
                    console.warn('[SteamCommand] Falha ao gerar comentÃ¡rio IA:', e.message);
                }

                await interaction.editReply({ content: yuiComment || null, embeds: [steamEmbed] });
            } catch (error) {
                console.error('Erro no comando steam_jogo:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('âŒ Erro de Processamento')
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
                        .setTitle('âŒ Erro na ConversÃ£o')
                        .setDescription(convInfo.error);
                    return await interaction.editReply({ embeds: [errEmbed] });
                }

                const amountFormatted = Number(convInfo.amount).toLocaleString('pt-BR');
                const resultFormatted = Number(convInfo.result).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const rateFormatted = Number(convInfo.rate).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
                
                const convEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle(`ConversÃ£o de Moedas: ${convInfo.name}`)
                    .setDescription(`**${amountFormatted} ${convInfo.from}** equivale a **${resultFormatted} ${convInfo.to}**`)
                    .addFields(
                        { name: 'CotaÃ§Ã£o (' + convInfo.from + ')', value: `1 ${convInfo.from} = ${rateFormatted} ${convInfo.to}`, inline: true },
                        { name: 'Ãšltima AtualizaÃ§Ã£o', value: convInfo.lastUpdate || 'Desconhecida', inline: true }
                    )
                    .setFooter({ text: 'Fonte: AwesomeAPI â€¢ Yui â€¢ by oBraga' })
                    .setTimestamp();
                    
                let yuiComment = "";
                try {
                    const commentPrompt = `Eu acabei de converter ${convInfo.amount} ${convInfo.from} para ${convInfo.to} via comando manual. O resultado foi ${resultFormatted}. FaÃ§a um comentÃ¡rio CURTO (mÃ¡ximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
                    const rawComment = await generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
                    if (rawComment && !rawComment.includes('âš ï¸ SYSTEM ERROR')) {
                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || cleanData;
                            } catch (e) {}
                        }
                        yuiComment = cleanData;
                    }
                } catch (e) {
                    console.warn('[CurrencyCommand] Falha ao gerar comentÃ¡rio IA:', e.message);
                }

                await interaction.editReply({ content: yuiComment || null, embeds: [convEmbed] });
            } catch (error) {
                console.error('Erro no comando converter_moeda:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('âŒ Erro de Processamento')
                    .setDescription('Erro ao tentar converter essa moeda.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'entrar-call') {
            const { joinVoiceCall } = await import('../handlers/voiceHandler.js');
            await interaction.deferReply({ ephemeral: true });
            const result = await joinVoiceCall(interaction.member, interaction.channel);
            if (result) {
                await interaction.editReply({ content: 'âœ… Processando entrada no canal de voz...' });
            } else {
                await interaction.editReply({ content: 'âŒ NÃ£o foi possÃ­vel entrar no canal de voz.' });
            }
        } else if (commandName === 'sair-call') {
            const { leaveVoiceCall } = await import('../handlers/voiceHandler.js');
            await interaction.deferReply({ ephemeral: true });
            const result = await leaveVoiceCall(interaction.guildId, interaction.channel);
            if (result) {
                await interaction.editReply({ content: 'âœ… SaÃ­ do canal de voz.' });
            } else {
                await interaction.editReply({ content: 'âŒ NÃ£o estou em nenhum canal de voz neste servidor.' });
            }
        } else if (commandName === 'modo-radio') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            try {
                const result = await startRadioMode(interaction.member, interaction.channel, client);
                if (result.success) {
                    await interaction.editReply({ content: 'ðŸ“» Modo RÃ¡dio ativado!' });
                } else {
                    await interaction.editReply({ content: result.error || 'âŒ NÃ£o foi possÃ­vel ativar o Modo RÃ¡dio.' });
                }
            } catch (err) {
                console.error('[ModoRadio]', err);
                await interaction.editReply({ content: 'âŒ Erro ao iniciar o Modo RÃ¡dio.' });
            }
        } else if (commandName === 'baixar_musica_atual') {
            await interaction.deferReply();
            try {
                const targetInput = interaction.options.getString('usuario') || interaction.user.id;
                const musicInfo = await getCurrentMusicFromUser(targetInput, client, interaction.guildId);
                if (!musicInfo.success) {
                    let msg = `ðŸŽµ ${musicInfo.message}`;
                    if (musicInfo.helpInstructions || musicInfo.reason === 'no_presence') {
                        msg += '\n\n> **Como ativar:**\n> VÃ¡ em **ConfiguraÃ§Ãµes do Discord â†’ Privacidade e SeguranÃ§a â†’ Atividade de Status** e ative **"Exibir atividade atual como mensagem de status"**.';
                    }
                    return await interaction.editReply({ content: msg });
                }
                const infoEmbed = new EmbedBuilder()
                    .setColor(0x1DB954)
                    .setTitle(`${musicInfo.platformEmoji} MÃºsica Identificada`)
                    .setDescription(`**${musicInfo.title}**\nðŸŽ¤ ${musicInfo.artist}${musicInfo.album ? `\nðŸ“€ ${musicInfo.album}` : ''}`)
                    .addFields({ name: 'Plataforma', value: musicInfo.platformLabel, inline: true });
                if (musicInfo.targetUser && musicInfo.targetUser.id !== interaction.user.id) {
                    infoEmbed.addFields({ name: 'UsuÃ¡rio', value: `<@${musicInfo.targetUser.id}>`, inline: true });
                }
                infoEmbed.setFooter({ text: `Yui Music â€¢ ${musicInfo.platformLabel}` }).setTimestamp();
                if (musicInfo.coverUrl) infoEmbed.setThumbnail(musicInfo.coverUrl);
                const userId = interaction.user.id;
                if (!canBypass(userId) && isUserBusy(userId)) {
                    return await interaction.editReply({ content: 'â³ VocÃª jÃ¡ tem um download em andamento. Aguarde.' });
                }
                const keepEmbed = config.keepMusicEmbed !== false;
                const downloadingEmbed = EmbedBuilder.from(infoEmbed);
                if (keepEmbed) {
                    downloadingEmbed.addFields({ name: 'Status', value: 'â³ Baixando mÃºsica, aguarde...', inline: true });
                }
                await interaction.editReply({ embeds: [downloadingEmbed] });
                lockUser(userId);
                try {
                    const musicResult = await handleMusicSearchAndDownload(
                        musicInfo.searchQuery,
                        null,
                        { user: interaction.user, userId, userTag: interaction.user.tag, guild: interaction.guild }
                    );
                    if (musicResult.error) {
                        await interaction.editReply({ content: `âŒ ${musicResult.error}`, embeds: [] });
                    } else if (musicResult.isAmbiguous) {
                        await interaction.editReply({ content: musicResult.textList, components: musicResult.components, embeds: [musicResult.embed] });
                    } else if (musicResult.success) {
                        if (keepEmbed) {
                            await interaction.editReply({ content: `âœ… \`${musicResult.track.title} - ${musicResult.track.artist}\``, embeds: [infoEmbed], files: [musicResult.attachment] });
                        } else {
                            await interaction.editReply({ content: `âœ… \`${musicResult.track.title} - ${musicResult.track.artist}\``, embeds: [], files: [musicResult.attachment] });
                        }
                        if (typeof musicResult.cleanup === 'function') musicResult.cleanup();
                    }
                } catch (err) {
                    console.error('[IdentificarMusica]', err);
                    await interaction.followUp({ content: `\u274C Erro ao baixar: ${err.message}` });
                } finally {
                    unlockUser(userId);
                }
            } catch (err) {
                console.error('[IdentificarMusica]', err);
                await interaction.editReply({ content: '\u274C Erro interno.' });
            }
        }
    },
};
