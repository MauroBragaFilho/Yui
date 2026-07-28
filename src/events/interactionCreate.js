const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder, PermissionFlagsBits } = require('discord.js');
const fs = require('fs');
const path = require('path');
const config = require('../config');
const { handleTosInteraction } = require('../handlers/tosHandler');
const { handleBanInteraction, checkBan, addBan, removeBan, getBans, setAutoBlock } = require('../handlers/banHandler');
const {
    addToQueue,
    getDisabledTools,
    getAllMcpTools,
    setServerPrompt,
    getServerPrompt,
    resetServerPrompt,
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
} = require('../handlers/llmHandler');
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
    getPendingVideo,
    removePendingVideo,
    enqueueCompression,
    isCompressionActive,
    getMemoryUsagePercent,
    logCompressionAction,
    formatVideoSuccessMessage
} = require('../handlers/youtubeAudioHandler');
const { executeGameCommand } = require('../handlers/gameHandler');
const { handleSauceCommand } = require('../handlers/sauceHandler');
const { getSteamGameInfo } = require('../handlers/steamHandler');
const { convertCurrency } = require('../handlers/currencyHandler');
const { generateResponse } = require('../handlers/llmHandler');
const { handleConfigCommand, handleConfigButton, handleConfigModal, handleConfigSelect } = require('../handlers/configPanelHandler');

async function buildBanListPayload(client, category, page = 0) {
    const currentBans = getBans();
    const embed = new EmbedBuilder().setColor(0xE11D48);

    if (category === 'home') {
        embed.setTitle('🚫 Central de Bloqueios • Hikari')
             .setDescription('Painel administrativo para controle e visualização dos bloqueios globais ativos.')
             .addFields(
                 { name: '👥 Usuários Banidos', value: `${Object.keys(currentBans.users || {}).length} perfil(s)`, inline: true },
                 { name: '🏘️ Servidores Restritos', value: `${Object.keys(currentBans.guilds || {}).length} servidor(es)`, inline: true },
                 { name: '📍 Canais Bloqueados', value: `${Object.keys(currentBans.channels || {}).length} canal(is)`, inline: true }
             )
             .setFooter({ text: 'Selecione uma categoria abaixo para navegar' })
             .setTimestamp();

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('banlist_view_users_0').setLabel('👥 Usuários').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('banlist_view_guilds_0').setLabel('🏘️ Servidores').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('banlist_view_channels_0').setLabel('📍 Canais').setStyle(ButtonStyle.Secondary)
        );

        return { embeds: [embed], components: [row] };
    }

    let entries = [];
    let title = '';
    let icon = '';
    let prefixCid = '';

    if (category === 'users') {
        entries = Object.entries(currentBans.users || {});
        title = 'Usuários';
        icon = '👥';
        prefixCid = 'banlist_view_users';
    } else if (category === 'guilds') {
        entries = Object.entries(currentBans.guilds || {});
        title = 'Servidores';
        icon = '🏘️';
        prefixCid = 'banlist_view_guilds';
    } else if (category === 'channels') {
        entries = Object.entries(currentBans.channels || {});
        title = 'Canais';
        icon = '📍';
        prefixCid = 'banlist_view_channels';
    }

    const pageSize = 5;
    const total = entries.length;
    const totalPages = Math.max(1, Math.ceil(total / pageSize));
    const currentPage = Math.min(page, totalPages - 1);

    embed.setTitle(`🚫 ${icon} Bloqueios: ${title} (${currentPage + 1}/${totalPages})`)
         .setDescription(`Mostrando bloqueios ativos para a categoria **${title}**.`);

    let menuRow = null;

    if (total === 0) {
        embed.addFields({ name: 'Vazio', value: `Nenhum registro de banimento encontrado nesta categoria.` });
    } else {
        const start = currentPage * pageSize;
        const pageEntries = entries.slice(start, start + pageSize);
        const options = [];
        for (const [id, info] of pageEntries) {
            let mentionText = `ID: \`${id}\``;
            let label = `Inspecionar ID: ${id}`;
            if (category === 'users') {
                mentionText = `<@${id}> | ID: \`${id}\``;
                const userObj = client.users.cache.get(id) || await client.users.fetch(id).catch(() => null);
                if (userObj) {
                    label = `${userObj.globalName || userObj.username} (@${userObj.username}) | ID: ${id}`;
                    mentionText = `<@${id}> | **${userObj.globalName || userObj.username}** (@${userObj.username}) | ID: \`${id}\``;
                }
            } else if (category === 'guilds') {
                const guildObj = client.guilds.cache.get(id) || await client.guilds.fetch(id).catch(() => null);
                if (guildObj) {
                    label = `${guildObj.name} | ID: ${id}`;
                    mentionText = `**${guildObj.name}** | ID: \`${id}\``;
                }
            } else if (category === 'channels') {
                mentionText = `<#${id}> | ID: \`${id}\``;
                const channelObj = client.channels.cache.get(id) || await client.channels.fetch(id).catch(() => null);
                if (channelObj) {
                    label = `#${channelObj.name} | ID: ${id}`;
                    mentionText = `<#${id}> | **#${channelObj.name}** | ID: \`${id}\``;
                }
            }
            const dateStr = info.timestamp ? new Date(info.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'N/A';
            embed.addFields({
                name: `${icon} Registro`,
                value: `**Alvo:** ${mentionText}\n**Motivo:** ${info.reason || 'Sem motivo informado'}\n**Data:** ${dateStr}`
            });

            options.push({
                label: label.substring(0, 95),
                description: (info.reason || 'Sem motivo informado').substring(0, 95),
                value: id
            });
        }

        const selectMenu = new StringSelectMenuBuilder()
            .setCustomId(`banlist_select_${category}_${currentPage}`)
            .setPlaceholder('🔍 Selecione um registro para ver detalhes')
            .addOptions(options);

        menuRow = new ActionRowBuilder().addComponents(selectMenu);
    }

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`${prefixCid}_${currentPage - 1}`).setLabel('⬅️ Anterior').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === 0),
        new ButtonBuilder().setCustomId('banlist_home').setLabel('🏠 Início').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId(`${prefixCid}_${currentPage + 1}`).setLabel('➡️ Próximo').setStyle(ButtonStyle.Secondary).setDisabled(currentPage === totalPages - 1)
    );

    const components = [row];
    if (menuRow) {
        components.unshift(menuRow);
    }

    return { embeds: [embed], components };
}

async function buildBanDetailPayload(client, category, targetId) {
    const currentBans = getBans();
    const embed = new EmbedBuilder().setColor(0xE11D48);

    let banDb = null;
    let titleType = '';
    let icon = '';
    let dbKey = '';

    if (category === 'users') {
        dbKey = 'users';
        titleType = 'Usuário';
        icon = '👥';
    } else if (category === 'guilds') {
        dbKey = 'guilds';
        titleType = 'Servidor';
        icon = '🏘️';
    } else if (category === 'channels') {
        dbKey = 'channels';
        titleType = 'Canal';
        icon = '📍';
    }

    banDb = currentBans[dbKey]?.[targetId];

    if (!banDb) {
        embed.setTitle(`⚠️ Registro não encontrado`)
             .setDescription(`O alvo com ID \`${targetId}\` não foi localizado no banco de dados de banimentos.`);
        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('banlist_home').setLabel('🏠 Início').setStyle(ButtonStyle.Primary)
        );
        return { embeds: [embed], components: [row] };
    }

    const allIds = Object.keys(currentBans[dbKey] || {});
    const index = allIds.indexOf(targetId);
    const prevId = index > 0 ? allIds[index - 1] : null;
    const nextId = index < allIds.length - 1 ? allIds[index + 1] : null;
    const returnPage = Math.floor(index / 5);

    embed.setTitle(`🔍 Detalhes do Bloqueio: ${titleType}`)
         .setDescription(`Informações completas e de sistema para o ID \`${targetId}\`.`);

    embed.addFields(
        { name: '📋 Registro Interno (Banco)', value: `**ID:** \`${targetId}\`\n**Motivo:** ${banDb.reason || 'Sem motivo informado'}\n**Data:** ${banDb.timestamp ? new Date(banDb.timestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' }) : 'N/A'}` }
    );

    let discordInfoStr = '';
    let thumbnail = null;

    try {
        if (category === 'users') {
            const userObj = await client.users.fetch(targetId).catch(() => null);
            if (userObj) {
                discordInfoStr += `**Tag:** ${userObj.tag}\n`;
                discordInfoStr += `**Menção:** <@${userObj.id}>\n`;
                discordInfoStr += `**Criado em:** ${new Date(userObj.createdTimestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n`;
                discordInfoStr += `**Bot?:** ${userObj.bot ? 'Sim 🤖' : 'Não 👤'}\n`;
                discordInfoStr += `**Perfil:** [Abrir Link](https://discord.com/users/${userObj.id})`;
                thumbnail = userObj.displayAvatarURL({ dynamic: true });
            }
        } else if (category === 'guilds') {
            const guildObj = await client.guilds.fetch(targetId).catch(() => null);
            if (guildObj) {
                discordInfoStr += `**Nome:** ${guildObj.name}\n`;
                discordInfoStr += `**Membros:** ${guildObj.memberCount}\n`;
                discordInfoStr += `**Criado em:** ${new Date(guildObj.createdTimestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n`;
                discordInfoStr += `**Canais:** ${guildObj.channels?.cache?.size || 'N/A'}\n`;
                discordInfoStr += `**Cargos:** ${guildObj.roles?.cache?.size || 'N/A'}\n`;
                thumbnail = guildObj.iconURL({ dynamic: true });
                if (guildObj.ownerId) {
                    const ownerObj = await client.users.fetch(guildObj.ownerId).catch(() => null);
                    if (ownerObj) {
                        discordInfoStr += `**Dono:** ${ownerObj.tag} (ID: \`${guildObj.ownerId}\`)`;
                    } else {
                        discordInfoStr += `**Dono ID:** \`${guildObj.ownerId}\``;
                    }
                }
            }
        } else if (category === 'channels') {
            const channelObj = await client.channels.fetch(targetId).catch(() => null);
            if (channelObj) {
                discordInfoStr += `**Nome:** #${channelObj.name || channelObj.id}\n`;
                discordInfoStr += `**Menção:** <#${channelObj.id}>\n`;
                discordInfoStr += `**Tipo:** ${channelObj.type}\n`;
                discordInfoStr += `**Criado em:** ${new Date(channelObj.createdTimestamp).toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' })}\n`;
                if (channelObj.guild) {
                    discordInfoStr += `**Servidor:** ${channelObj.guild.name} (ID: \`${channelObj.guild.id}\`)\n`;
                }
                if (channelObj.topic) {
                    discordInfoStr += `**Tópico:** ${channelObj.topic}`;
                }
            }
        }
    } catch (err) {
    }

    if (discordInfoStr) {
        embed.addFields({ name: '🌐 Dados Obtidos via Discord API', value: discordInfoStr });
    } else {
        embed.addFields({ name: '⚠️ Dados Discord API', value: 'Alvo não encontrado no cache ou sem acesso mútuo para consultar dados em tempo real.' });
    }

    if (thumbnail) {
        embed.setThumbnail(thumbnail);
    }

    const navRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`banlist_detail_${category}_${prevId || 'none'}`).setLabel('⬅️ Anterior').setStyle(ButtonStyle.Secondary).setDisabled(!prevId),
        new ButtonBuilder().setCustomId(`banlist_view_${category}_${returnPage}`).setLabel('⬅️ Voltar à Lista').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`banlist_detail_${category}_${nextId || 'none'}`).setLabel('➡️ Próximo').setStyle(ButtonStyle.Secondary).setDisabled(!nextId)
    );

    const actionRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`banlist_unban_${category}_${targetId}`).setLabel('🔓 Desbanir Alvo').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('banlist_home').setLabel('🏠 Início').setStyle(ButtonStyle.Primary)
    );

    return { embeds: [embed], components: [navRow, actionRow] };
}

module.exports = {
    name: 'interactionCreate',
    once: false,
    async execute(interaction, client) {
        if (interaction.guildId) {
            const { isServerAccepted, sendTermsOfService } = require('../handlers/tosHandler');
            if (!isServerAccepted(interaction.guildId)) {
                const isTosAction = (interaction.isCommand() && interaction.commandName === 'aceitar_tos') ||
                                    (interaction.isButton() && (interaction.customId === 'tos_accept' || interaction.customId === 'tos_decline'));
                if (!isTosAction) {
                    await sendTermsOfService(interaction);
                    return;
                }
            }
        }
        if (interaction.isModalSubmit()) {
            if (interaction.customId.startsWith('cfgmodal_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigModal(interaction);
            }
        }
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId === 'cfgpanel_goto_select') {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigSelect(interaction);
            }
            if (interaction.customId.startsWith('banlist_select_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                const parts = interaction.customId.split('_');
                const category = parts[2];
                const targetId = interaction.values[0];
                const payload = await buildBanDetailPayload(client, category, targetId);
                return await interaction.update(payload);
            }
            if (interaction.customId === 'help_menu') {
                const selectedValue = interaction.values[0];
                console.log(`[LOG] Menu Ajuda: ${selectedValue} | Usuário: ${interaction.user.tag} (${interaction.user.id}) | Local: {${interaction.guild?.name || 'DM'} - ${interaction.guildId || 'N/A'}}`);
                try {
                    const helpDataPath = path.join(__dirname, '../data/help.json');
                    const helpData = JSON.parse(fs.readFileSync(helpDataPath, 'utf8'));
                    const selectedOption = helpData.find(item => item.id === selectedValue);
                    const menuOptions = helpData.map(item => ({
                        label: item.label,
                        description: item.description || 'Clique para ver mais',
                        value: item.id,
                        default: item.id === selectedValue,
                    }));
                    const selectMenu = new StringSelectMenuBuilder()
                        .setCustomId('help_menu')
                        .setPlaceholder('Selecione um tópico de ajuda')
                        .addOptions(menuOptions);
                    const menuRow = new ActionRowBuilder().addComponents(selectMenu);

                    if (selectedOption.id === 'geral' && selectedOption.commands) {
                        const page = 0;
                        const command = selectedOption.commands[page];
                        const embed = new EmbedBuilder()
                            .setColor(0x7C3AED)
                            .setTitle(`🤖 Comandos (${page + 1}/${selectedOption.commands.length})`)
                            .setDescription('📖 [Guia Completo de Comandos](https://github.com/yGuilhermy/Hikari/blob/main/docs/content_pt/COMMANDS.md)')
                            .addFields({ name: command.title, value: command.content })
                            .setFooter({ text: 'Use as setas para navegar • Hikari Help • by yGuilhermy' })
                            .setTimestamp();

                        const btnRow = new ActionRowBuilder().addComponents(
                            new ButtonBuilder().setCustomId(`help_page_${page - 1}`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(true),
                            new ButtonBuilder().setCustomId('help_back').setLabel('🏠 Voltar').setStyle(ButtonStyle.Primary),
                            new ButtonBuilder().setCustomId(`help_page_${page + 1}`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(selectedOption.commands.length <= 1)
                        );
                        
                        return await interaction.update({ embeds: [embed], components: [menuRow, btnRow] });
                    }

                    const answerEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle(selectedOption.label)
                        .setDescription(selectedOption.answer + '\n\r\n📖 [Guia Completo de Comandos](https://github.com/yGuilhermy/Hikari/blob/main/docs/content_pt/COMMANDS.md)')
                        .setFooter({ text: 'Hikari • Menu de Ajuda • by yGuilhermy' })
                        .setTimestamp();

                    const backRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId('help_back').setLabel('🏠 Voltar ao Início').setStyle(ButtonStyle.Primary)
                    );

                    await interaction.update({
                        embeds: [answerEmbed],
                        components: [menuRow, backRow],
                    });
                } catch (error) {
                    console.error('Erro ao processar menu de ajuda:', error);
                    await interaction.reply({ content: 'Erro ao carregar a resposta.', ephemeral: true });
                }
            }
            return;
        }
        if (interaction.isButton()) {
            const cid = interaction.customId;
            if (cid.startsWith('cfgpanel_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                return await handleConfigButton(interaction);
            }
            if (cid.startsWith('adm_') || cid.startsWith('banlist_')) {
                if (!config.isOwner(interaction.user.id)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Acesso Negado')
                        .setDescription('Esta ação é restrita ao criador da Hikari.');
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
                    addBan(type, targetId, "Banido remotamente pelo log de violações do sistema Hikari.");
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
            if (cid.startsWith('help_')) {
                const helpDataPath = path.join(__dirname, '../data/help.json');
                const helpData = JSON.parse(fs.readFileSync(helpDataPath, 'utf8'));
                
                if (cid === 'help_back') {
                    const menuOptions = helpData.map(item => ({ label: item.label, description: item.description, value: item.id }));
                    const selectMenu = new StringSelectMenuBuilder().setCustomId('help_menu').setPlaceholder('Selecione um tópico de ajuda').addOptions(menuOptions);
                    const row = new ActionRowBuilder().addComponents(selectMenu);
                    const githubButton = new ButtonBuilder()
                        .setLabel('Pagina do Projeto')
                        .setURL('https://github.com/yGuilhermy/Hikari')
                        .setStyle(ButtonStyle.Link)
                        .setEmoji('🚀');
                    const linkRow = new ActionRowBuilder().addComponents(githubButton);
                    const welcomeEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('✨ Central de Ajuda — Hikari')
                        .setDescription('Bem-vindo(a)! Selecione um tópico no menu abaixo.\n\n📖 [Guia Completo de Comandos](https://github.com/yGuilhermy/Hikari/blob/main/docs/content_pt/COMMANDS.md)')
                        .addFields(helpData.map(item => ({ name: item.label, value: item.description || 'Sem descrição', inline: true })))
                        .setFooter({ text: 'Hikari • Menu de Ajuda • by yGuilhermy' })
                        .setTimestamp();
                    return await interaction.update({ embeds: [welcomeEmbed], components: [row, linkRow] });
                }

                if (cid.startsWith('help_page_')) {
                    const page = parseInt(cid.split('_')[2]);
                    const geral = helpData.find(i => i.id === 'geral');
                    const command = geral.commands[page];
                    
                    const embed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle(`🤖 Comandos (${page + 1}/${geral.commands.length})`)
                        .setDescription('📖 [Guia Completo de Comandos](https://github.com/yGuilhermy/Hikari/blob/main/docs/content_pt/COMMANDS.md)')
                        .addFields({ name: command.title, value: command.content })
                        .setFooter({ text: 'Use as setas para navegar • Hikari Help • by yGuilhermy' })
                        .setTimestamp();

                    const btnRow = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`help_page_${page - 1}`).setLabel('⬅️').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
                        new ButtonBuilder().setCustomId('help_back').setLabel('🏠 Voltar').setStyle(ButtonStyle.Primary),
                        new ButtonBuilder().setCustomId(`help_page_${page + 1}`).setLabel('➡️').setStyle(ButtonStyle.Secondary).setDisabled(page === geral.commands.length - 1)
                    );

                    const menuOptions = helpData.map(item => ({ label: item.label, description: item.description, value: item.id, default: item.id === 'geral' }));
                    const selectMenu = new StringSelectMenuBuilder().setCustomId('help_menu').setPlaceholder('Selecione um tópico de ajuda').addOptions(menuOptions);
                    const menuRow = new ActionRowBuilder().addComponents(selectMenu);

                    return await interaction.update({ embeds: [embed], components: [menuRow, btnRow] });
                }
            }
            if (cid.startsWith('compress_video_')) {
                const fileId = cid.replace('compress_video_', '');
                const pending = getPendingVideo(fileId);
                if (!pending) {
                    return interaction.reply({ content: '⏰ Este vídeo já expirou (limite de 6 horas). Faça o download novamente.', ephemeral: true });
                }
                const guild = interaction.guild;
                const attachmentLimit = guild ? guild.premiumTier === 3 ? 100 * 1024 * 1024 : guild.premiumTier === 2 ? 50 * 1024 * 1024 : 25 * 1024 * 1024 : 25 * 1024 * 1024;
                const isQueue = isCompressionActive();
                const progressEmbed = new EmbedBuilder()
                    .setFooter({ text: 'Hikari Media • by yGuilhermy' })
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
                try {
                    const result = await enqueueCompression(pending.filePath, attachmentLimit, interaction.user.id);
                    const attachment = new AttachmentBuilder(result.filePath, { name: 'video_compressed.mp4' });
                    const sizeMB = (result.fileSize / (1024 * 1024)).toFixed(1);
                    await interaction.editReply({ content: `✅ **Vídeo comprimido com sucesso!** (${sizeMB} MB)`, embeds: [], files: [attachment], components: [] });
                    logCompressionAction({ user: interaction.user, guild: interaction.guild }, 'Sucesso', `Tamanho: ${sizeMB} MB`);
                    try { if (fs.existsSync(result.filePath)) fs.unlinkSync(result.filePath); } catch (e) {}
                    removePendingVideo(fileId);
                } catch (compressError) {
                    const errorEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Falha na Compressão')
                        .setFooter({ text: 'Hikari Media • by yGuilhermy' })
                        .setTimestamp();
                    if (compressError.message === 'MEMORY_ERROR') {
                        errorEmbed.setDescription(`⚠️ Ocorreu um erro de falta de memória no servidor da host ao tentar comprimir o vídeo. Por favor, entre em contato com <@${config.ownerId}>.`);
                    } else {
                        errorEmbed.setDescription(`❌ Ocorreu um erro ao comprimir o vídeo: ${compressError.message}`);
                    }
                    await interaction.editReply({ embeds: [errorEmbed], components: [] });
                    logCompressionAction({ user: interaction.user, guild: interaction.guild }, 'Erro', `Detalhe: ${compressError.message}`);
                }
                return;
            }
            await handleTosInteraction(interaction);
            await handleBanInteraction(interaction, client);
            return;
        }
        if (!interaction.isCommand() && !interaction.isAutocomplete()) return;
        if (interaction.isCommand()) {
            if (interaction.guildId && interaction.channelId) {
                setServerLastChannel(interaction.guildId, interaction.channelId);
                const { checkAndInitializeUpdateChannel } = require('../handlers/tosHandler');
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
                    .setDescription(`Sua tentativa de execução foi abortada. O acesso à **IA Hikari** está permanentemente bloqueado para você.\n\n**DETALHES DO SEU BANIMENTO:**\n- **Tipo:** ${banInfo.typeName || banInfo.type}\n- **Motivo do Banimento:** ${banInfo.reason || "Violação severa dos Termos de Uso da IA Hikari."}\n- **Status Atual:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.\n\nVocê perdeu todos os privilégios de utilização dos nossos serviços. Não adianta insistir.\n\nSe você acredita que isso é um erro ou deseja solicitar um desbanimento, entre em contato com o desenvolvedor: <@${config.ownerId}> [\[Abrir Perfil\](https://discord.com/users/${config.ownerId})] ✨`)
                    .setFooter({ text: 'Hikari Security & Moderation • by yGuilhermy' })
                    .setTimestamp();
                return interaction.reply({ embeds: [banEmbed], ephemeral: false });
            }
        }
        if (interaction.isAutocomplete()) {
            if (interaction.commandName === 'ia_ferramentas') {
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
            return;
        }
        const { commandName } = interaction;
        if (commandName === 'ia_chat') {
            const prompt = interaction.options.getString('prompt');
            const visibility = interaction.options.getString('visibilidade');
            const isPublic = visibility === 'public';
            addToQueue(prompt, interaction, 'slash', { allowSearch: false, public: isPublic, guildId: interaction.guildId });
        } else if (commandName === 'ia_prompt') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription(`Esse comando é exclusivo do meu criador <@${config.ownerId}>.`);
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const sub = interaction.options.getSubcommand();
            const guildId = interaction.guildId;
            if (sub === 'set') {
                const newPrompt = interaction.options.getString('prompt');
                setServerPrompt(guildId, newPrompt);
                const preview = newPrompt.length > 300 ? newPrompt.substring(0, 300) + '...' : newPrompt;
                const embed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('✅ System Prompt Updated')
                    .setDescription('O system prompt deste servidor foi sobrescrito com sucesso.')
                    .addFields({ name: '📝 Novo Prompt (prévia)', value: `\`\`\`${preview}\`\`\`` })
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (sub === 'reset') {
                const current = getServerPrompt(guildId);
                if (!current) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xF59E0B)
                        .setTitle('ℹ️ Nada a Resetar')
                        .setDescription('Este servidor já utiliza o system prompt padrão da Hikari.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                resetServerPrompt(guildId);
                const embed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('🔄 System Prompt Resetado')
                    .setDescription('O system prompt customizado foi removido. A Hikari voltou a usar o prompt padrão do código neste servidor.')
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (sub === 'view') {
                const current = getServerPrompt(guildId);
                if (!current) {
                    const embed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('🔍 System Prompt Atual')
                        .setDescription('Este servidor está usando o **prompt padrão do código**. Nenhum prompt customizado configurado.')
                        .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                        .setTimestamp();
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }
                const preview = current.length > 900 ? current.substring(0, 900) + '\n[... truncado]' : current;
                const embed = new EmbedBuilder()
                    .setColor(0x7C3AED)
                    .setTitle('🔍 System Prompt Atual (Customizado)')
                    .setDescription(`\`\`\`${preview}\`\`\``)
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • Caracteres: ${current.length} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        } else if (commandName === 'ia_ferramentas') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription(`Esse comando é exclusivo do meu criador <@${config.ownerId}>.`);
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const sub = interaction.options.getSubcommand();
            const guildId = interaction.guildId;
            const allTools = getAllMcpTools();
            if (sub === 'toggle') {
                const rawInput = interaction.options.getString('tool') || '';
                let toolName = rawInput.trim();

                if (toolName.toLowerCase().includes('voz') || toolName.toLowerCase().includes('voice') || toolName === 'voice_assistant') {
                    toolName = 'join_voice_call';
                }

                let tool = allTools.find(t => t.function.name === toolName || t.meta.label === toolName);
                if (!tool) {
                    tool = allTools.find(t => rawInput.includes(t.function.name) || rawInput.includes(t.meta.label));
                }
                if (!tool && (rawInput.includes('Voz') || rawInput.includes('Call'))) {
                    tool = allTools.find(t => t.function.name === 'join_voice_call');
                }

                if (!tool) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Ferramenta não Encontrada')
                        .setDescription(`A ferramenta \`${rawInput}\` não foi encontrada.`);
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }

                toolName = tool.function.name;
                const estado = interaction.options.getString('estado');
                const enabled = estado === 'on';
                if (!tool.meta.disableable && !enabled) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('🔒 Acesso Restrito')
                        .setDescription(`A ferramenta **${tool.meta.label}** não pode ser desabilitada.`);
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                const ok = setServerToolEnabled(guildId, toolName, enabled);
                if (!ok) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Erro na Alteração')
                        .setDescription(`Não foi possível alterar o status da ferramenta \`${toolName}\`.`);
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                const displayLabel = (toolName === 'join_voice_call' || toolName === 'leave_voice_call')
                    ? '🎙️ Assistente de Voz (Call)'
                    : tool.meta.label;
                const displayValue = (toolName === 'join_voice_call' || toolName === 'leave_voice_call')
                    ? 'voice_assistant (Entrar/Sair Call)'
                    : toolName;
                const embed = new EmbedBuilder()
                    .setColor(enabled ? 0x10B981 : 0xE11D48)
                    .setTitle(`${enabled ? '✅ Ferramenta Ativada' : '❌ Ferramenta Desativada'}`)
                    .addFields(
                        { name: 'Ferramenta', value: `${displayLabel}\n\`${displayValue}\``, inline: true },
                        { name: 'Servidor', value: interaction.guild?.name || guildId, inline: true },
                        { name: 'Novo Estado', value: enabled ? '✅ **ATIVA**' : '❌ **DESATIVADA**', inline: true }
                    )
                    .setDescription(tool.meta.description)
                    .setFooter({ text: 'A mudança entra em vigor imediatamente. • by yGuilhermy' })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (sub === 'list') {
                const disabled = getDisabledTools(guildId);
                const { getAutoBlockMode: _getMode } = require('../handlers/banHandler');
                const _automodMode = _getMode(guildId);
                const _automodActive = _automodMode !== 'off';
                const _mcpEnabled = _automodActive && (_automodMode === 'mcp' || _automodMode === 'both');
                const displayTools = allTools.filter(t => t.function.name !== 'leave_voice_call');
                const fields = displayTools.map(t => {
                    const isGuard = !!(t.meta && t.meta.guardAutomod);
                    if (isGuard) {
                        const statusLabel = _mcpEnabled ? '✅' : '⛔';
                        const note = !_automodActive ? ' (AutoMod Desativado)' : (_automodMode === 'trigger') ? ' (Modo: trigger — IA inativa)' : '';
                        return { name: `${statusLabel} ${t.meta.label}`, value: `\`${t.function.name}\` 🔒${note}`, inline: true };
                    }
                    if (t.function.name === 'join_voice_call') {
                        const isVoiceDisabled = disabled.includes('join_voice_call');
                        return {
                            name: `${isVoiceDisabled ? '❌' : '✅'} 🎙️ Assistente de Voz (Call)`,
                            value: `\`voice_assistant\` (Entrar/Sair)`,
                            inline: true
                        };
                    }
                    return {
                        name: `${disabled.includes(t.function.name) ? '❌' : '✅'} ${t.meta.label}`,
                        value: `\`${t.function.name}\`${!t.meta.disableable ? ' 🔒' : ''}`,
                        inline: true
                    };
                });
                const activeCnt = displayTools.filter(t => {
                    if (t.meta && t.meta.guardAutomod) return _mcpEnabled;
                    return !disabled.includes(t.function.name);
                }).length;
                const embed = new EmbedBuilder()
                    .setColor(0x7C3AED)
                    .setTitle('🔧 Ferramentas MCP — Status do Servidor')
                    .setDescription(`**${interaction.guild?.name || guildId}**\n\n✅ = Ativa | ❌ = Desativada | ⛔ = Inativa (AutoMod) | 🔒 = Não configurável\n\n🛡️ **Modo AutoMod do Servidor:** \`${_automodMode}\``)
                    .addFields(fields)
                    .setFooter({ text: `${activeCnt}/${displayTools.length} pacotes MCP ativos • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: false });
            } else if (sub === 'reset') {
                const disabled = getDisabledTools(guildId);
                if (disabled.length === 0) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xF59E0B)
                        .setTitle('ℹ️ Nada a Resetar')
                        .setDescription('Nenhuma ferramenta está desabilitada neste servidor.');
                    return interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                resetServerTools(guildId);
                const embed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('🔄 Tools Resetadas')
                    .setDescription(`Todas as **${disabled.length}** tools desabilitadas foram reativadas.`)
                    .addFields({ name: 'Tools reativadas', value: disabled.map(n => `\`${n}\``).join(', ') })
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: false });
            }
        } else if (commandName === 'ia_mention_todos') {
            const hasPermission = !interaction.guild || (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) || config.isOwner(interaction.user.id);
            if (!hasPermission) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Você precisa da permissão de **Gerenciar Servidor** para alterar as menções.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const ativo = interaction.options.getBoolean('ativo');
            setServerEveryoneMention(interaction.guildId, ativo);
            const embed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('🔔 Configuração • Menções Globais')
                .setDescription(`As preferências de marcações em massa foram atualizadas.`)
                .addFields(
                    { name: '📢 Reagir a @everyone / @here', value: ativo ? '✅ **Ativado**' : '❌ **Desativado**', inline: true }
                )
                .setTimestamp();
            await interaction.reply({ embeds: [embed], ephemeral: false });
        } else if (commandName === 'chat_updates') {
            const hasPermission = !interaction.guild || (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) || config.isOwner(interaction.user.id);
            if (!hasPermission) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Você precisa da permissão de Gerenciar Canais para configurar o canal de updates.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const canal = interaction.options.getChannel('canal') || interaction.channel;
            if (!canal.isTextBased()) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Canal Inválido')
                    .setDescription('Por favor, selecione um canal de texto.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            setServerUpdateChannel(interaction.guildId, canal.id);
            const embed = new EmbedBuilder()
                .setColor(0x7C3AED)
                .setTitle('📢 Configuração • Canal de Updates')
                .setDescription(`O canal para transmissão de atualizações foi configurado.`)
                .addFields(
                    { name: '📍 Canal Selecionado', value: `<#${canal.id}>`, inline: true },
                    { name: '🛡️ Servidor', value: `\`${interaction.guild?.name || 'Desconhecido'}\``, inline: true }
                )
                .setFooter({ text: 'Central de Notificações • Hikari' })
                .setTimestamp();
            await interaction.reply({ embeds: [embed] });
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
            const { sendTermsOfService } = require('../handlers/tosHandler');
            await sendTermsOfService(interaction);
        } else if (commandName === 'ajuda') {
            try {
                const helpDataPath = path.join(__dirname, '../data/help.json');
                if (!fs.existsSync(helpDataPath)) {
                    const errEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('❌ Arquivo não Encontrado')
                        .setDescription('O arquivo de ajuda não foi localizado no servidor.');
                    return await interaction.reply({ embeds: [errEmbed], ephemeral: true });
                }
                const helpData = JSON.parse(fs.readFileSync(helpDataPath, 'utf8'));
                const menuOptions = helpData.map(item => ({ label: item.label, description: item.description || 'Clique para ver mais', value: item.id }));
                const selectMenu = new StringSelectMenuBuilder().setCustomId('help_menu').setPlaceholder('Selecione um tópico de ajuda').addOptions(menuOptions);
                const row = new ActionRowBuilder().addComponents(selectMenu);
                const githubButton = new ButtonBuilder()
                    .setLabel('Página do Projeto')
                    .setURL('https://github.com/yGuilhermy/Hikari')
                    .setStyle(ButtonStyle.Link)
                    .setEmoji('🚀');
                const linkRow = new ActionRowBuilder().addComponents(githubButton);
                const welcomeEmbed = new EmbedBuilder()
                    .setColor(0x7C3AED)
                    .setTitle('✨ Central de Ajuda — Hikari')
                    .setDescription('Bem-vindo(a)! Selecione um tópico no menu abaixo.\n\n📖 [Guia Completo de Comandos](https://github.com/yGuilhermy/Hikari/blob/main/docs/content_pt/COMMANDS.md)')
                    .addFields(helpData.map(item => ({ name: item.label, value: item.description || 'Sem descrição', inline: true })))
                    .setFooter({ text: 'Hikari • Menu de Ajuda • by yGuilhermy' })
                    .setTimestamp();
                await interaction.reply({ embeds: [welcomeEmbed], components: [row, linkRow], ephemeral: false });
            } catch (error) {
                console.error('Erro no comando help:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro no Menu')
                    .setDescription('Erro ao criar o menu de ajuda.');
                await interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
        } else if (commandName === 'ia_imagem') {
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
                        .setFooter({ text: `Prompt: ${prompt.substring(0, 100)} • by yGuilhermy` })
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
            const videoUrl = interaction.options.getString('url');
            const userId = interaction.user.id;
            if (!canBypass(userId) && isUserBusy(userId)) {
                const waitEmbed = new EmbedBuilder()
                    .setColor(0xF59E0B)
                    .setTitle('⏳ Download em Andamento')
                    .setDescription('Você já tem um download em execução. Por favor, aguarde ele terminar.');
                return interaction.reply({ embeds: [waitEmbed], ephemeral: true });
            }
            await interaction.deferReply({ ephemeral: false });
            lockUser(userId);
            let downloadedAudioInfo = null;
            try {
                downloadedAudioInfo = await downloadAudio(videoUrl, { source: 'Slash', user: interaction.user, guild: interaction.guild });
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
            } catch (error) {
                console.error('[BaixarMusica]', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro')
                    .setDescription(error.message);
                await interaction.editReply({ embeds: [errEmbed] });
            } finally {
                unlockUser(userId);
                if (downloadedAudioInfo && downloadedAudioInfo.filePath && fs.existsSync(downloadedAudioInfo.filePath)) {
                    fs.unlink(downloadedAudioInfo.filePath, () => {});
                }
            }
        } else if (commandName === 'baixar_video') {
            const videoUrl = interaction.options.getString('url');
            const showDetails = interaction.options.getBoolean('descricao') || false;
            const userId = interaction.user.id;
            if (!canBypass(userId) && isUserBusy(userId)) {
                const waitEmbed = new EmbedBuilder()
                    .setColor(0xF59E0B)
                    .setTitle('⏳ Download em Andamento')
                    .setDescription('Você já tem um download em execução. Por favor, aguarde ele terminar.');
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
                        .setTitle('📦 Vídeo Grande Demais')
                        .setDescription(`O vídeo **${videoData.metadata.title}** tem **${sizeMB} MB**, mas o limite deste servidor é **${limitMB} MB**.\n\nClique no botão abaixo para tentar comprimir o vídeo automaticamente.\n\n⏰ *O arquivo ficará disponível por 6 horas.*`)
                        .setFooter({ text: 'Hikari Media • by yGuilhermy' })
                        .setTimestamp();
                    const row = new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`compress_video_${fileId}`).setLabel('🔄 Tentar Compressão').setStyle(ButtonStyle.Primary)
                    );
                    await interaction.editReply({ embeds: [compressEmbed], components: [row] });
                }
            } catch (error) {
                console.error('[BaixarVideo]', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro')
                    .setDescription(error.message);
                await interaction.editReply({ embeds: [errEmbed] });
            } finally {
                unlockUser(userId);
            }
        } else if (commandName === 'buscar_jogo') {
            await executeGameCommand(interaction);
        } else if (commandName === 'chat_humor') {
            const hasPermission = !interaction.guild || (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) || config.isOwner(interaction.user.id);
            if (!hasPermission) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Você não tem permissão para gerenciar canais.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const reset = interaction.options.getBoolean('reset');
            if (reset) {
                setChannelPersona(interaction.channelId, { reset: true });
                const successEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('🔄 Restaurado • Humor & Instruções')
                    .setDescription('As configurações de comportamento e humor deste canal foram redefinidas para os padrões de fábrica da Hikari.')
                    .setTimestamp();
                await interaction.reply({ embeds: [successEmbed], ephemeral: false });
            } else {
                const instruction = interaction.options.getString('instrucao') || undefined;
                const mood = interaction.options.getString('mood') || undefined;
                if (!instruction && !mood) {
                    const warnEmbed = new EmbedBuilder()
                        .setColor(0xF59E0B)
                        .setTitle('⚠️ Entrada Inválida')
                        .setDescription('Você precisa fornecer pelo menos uma instrução ou um humor.');
                    return interaction.reply({ embeds: [warnEmbed], ephemeral: true });
                }
                setChannelPersona(interaction.channelId, { instruction, mood });
                const successEmbed = new EmbedBuilder()
                    .setColor(0x10B981)
                    .setTitle('🎭 Personalidade • Canal Atualizado')
                    .setDescription('O comportamento adaptativo da Hikari neste canal foi atualizado.')
                    .addFields(
                        { name: '🎭 Humor Selecionado', value: `\`${mood || 'Não alterado'}\``, inline: true },
                        { name: '📝 Diretrizes de Prompt', value: instruction ? `\`\`\`\n${instruction.length > 500 ? instruction.substring(0, 500) + '...' : instruction}\`\`\`` : '*Não alterado*', inline: false }
                    )
                    .setTimestamp();
                await interaction.reply({ embeds: [successEmbed], ephemeral: false });
            }
        } else if (commandName === 'chat_espontaneo') {
            const hasPermission = !interaction.guild || (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) || config.isOwner(interaction.user.id);
            if (!hasPermission) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Você não tem permissão para gerenciar canais.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }

            const percentage = interaction.options.getInteger('porcentagem');
            if (percentage !== null && !config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Apenas o proprietário da Hikari pode ajustar a porcentagem exata de respostas espontâneas.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }

            const state = interaction.options.getString('estado');
            const freq = interaction.options.getString('frequencia') || 'low';
            const isActive = state === 'on';
            setChannelChatter(interaction.channelId, { active: isActive, frequency: freq, percentage });
            const successEmbed = new EmbedBuilder()
                .setColor(isActive ? 0x10B981 : 0xE11D48)
                .setTitle('🗣️ Interação • Modo Espontâneo')
                .setDescription('As preferências para intervenção espontânea de conversa da Hikari foram definidas.')
                .addFields(
                    { name: '⚡ Estado do Modo', value: isActive ? '🟢 **Ativo**' : '🔴 **Inativo**', inline: true },
                    { name: '⏱️ Frequência Estipulada', value: `\`${freq === 'high' ? 'Alta' : freq === 'medium' ? 'Média' : 'Baixa'}\``, inline: true }
                );
            if (percentage !== null) {
                successEmbed.addFields({ name: 'Porcentagem', value: `${percentage}%`, inline: true });
            }
            await interaction.reply({ embeds: [successEmbed], ephemeral: false });
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
                const summaryPrompt = `Faça um resumo: \n${conversationLog}`;
                addToQueue(summaryPrompt, interaction, 'slash', { allowSearch: false, disableTools: true });
            } catch (error) {
                console.error('summary:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro no Resumo')
                    .setDescription('Não foi possível obter o histórico de mensagens ou gerar o resumo deste canal.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'anime_origem') {
            await handleSauceCommand(interaction);
        } else if (commandName === 'ia_config') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
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
        } else if (commandName === 'ia_model_config') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const mostrarModelo = interaction.options.getBoolean('mostrar_modelo');
            const mostrarModeloPensamento = interaction.options.getBoolean('mostrar_modelo_pensamento');
            const tentativasErro = interaction.options.getInteger('tentativas_erro');
            if (mostrarModelo !== null) updateShowModel(mostrarModelo);
            if (mostrarModeloPensamento !== null) updateShowModelThinking(mostrarModeloPensamento);
            if (tentativasErro !== null) updateErrorRetries(tentativasErro);
            const successEmbed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('⚙️ Configurações • Depuração e Retentativas')
                .setDescription('As diretrizes de exibição do modelo e tentativas de execução foram salvas.')
                .addFields(
                    { name: 'Exibir Modelo', value: mostrarModelo !== null ? (mostrarModelo ? 'Sim' : 'Não') : 'Não alterado', inline: true },
                    { name: 'Exibir Pensamento', value: mostrarModeloPensamento !== null ? (mostrarModeloPensamento ? 'Sim' : 'Não') : 'Não alterado', inline: true },
                    { name: 'Tentativas de Erro', value: tentativasErro !== null ? String(tentativasErro) : 'Não alterado', inline: true }
                );
            await interaction.reply({ embeds: [successEmbed], ephemeral: true });
        } else if (commandName === 'adm_banir') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const tipo = interaction.options.getString('tipo');
            const id = interaction.options.getString('id');
            const motivo = interaction.options.getString('motivo') || "Violação.";
            addBan(tipo, id, motivo);
            const successEmbed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('🔒 Restrição • Novo Bloqueio')
                .setDescription('O identificador foi incluído na lista global de restrições de uso.')
                .addFields(
                    { name: 'Tipo de Bloqueio', value: tipo, inline: true },
                    { name: 'Identificador (ID)', value: `\`${id}\``, inline: true },
                    { name: 'Motivo', value: motivo }
                )
                .setTimestamp();
            await interaction.reply({ embeds: [successEmbed], ephemeral: false });
        } else if (commandName === 'adm_desbanir') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const tipo = interaction.options.getString('tipo');
            const id = interaction.options.getString('id');
            removeBan(tipo, id);
            const successEmbed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('🔓 Restrição • Bloqueio Revogado')
                .setDescription('O identificador foi reabilitado para acesso aos serviços do bot.')
                .addFields(
                    { name: 'Tipo', value: tipo, inline: true },
                    { name: 'Identificador (ID)', value: `\`${id}\``, inline: true }
                )
                .setTimestamp();
            await interaction.reply({ embeds: [successEmbed], ephemeral: false });
        } else if (commandName === 'adm_lista_bans') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const payload = await buildBanListPayload(client, 'home');
            await interaction.reply({ ...payload, ephemeral: true });
        } else if (commandName === 'adm_automod') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            const guildId = interaction.options.getString('id');
            const modo = interaction.options.getString('modo');
            setAutoBlock(guildId, modo);
            const successEmbed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('🛡️ Segurança • AutoMod do Servidor')
                .setDescription('O nível de automoderação e monitoramento do servidor foi modificado.')
                .addFields(
                    { name: 'ID do Servidor', value: `\`${guildId}\``, inline: true },
                    { name: 'Novo Modo', value: `\`${modo}\``, inline: true }
                )
                .setTimestamp();
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
                    .setFooter({ text: 'Fonte: Loja da Steam • Hikari • by yGuilhermy' })
                    .setTimestamp();

                if (steamInfo.headerImage) {
                    steamEmbed.setImage(steamInfo.headerImage);
                }
                if (steamInfo.metacritic) {
                    steamEmbed.addFields({ name: 'Metacritic', value: `${steamInfo.metacritic}/100 🌟`, inline: true });
                }

                let hikariComment = "";
                try {
                    const commentPrompt = `Eu acabei de consultar o jogo "${steamInfo.name}" na Steam via comando manual. O preço atual é ${steamInfo.price}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
                    const rawComment = await generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
                    if (rawComment && !rawComment.includes('⚠️ SYSTEM ERROR')) {
                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || cleanData;
                            } catch (e) {}
                        }
                        hikariComment = cleanData;
                    }
                } catch (e) {
                    console.warn('[SteamCommand] Falha ao gerar comentário IA:', e.message);
                }

                await interaction.editReply({ content: hikariComment || null, embeds: [steamEmbed] });
            } catch (error) {
                console.error('Erro no comando steam_jogo:', error);
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
                    .setFooter({ text: 'Fonte: AwesomeAPI • Hikari • by yGuilhermy' })
                    .setTimestamp();
                    
                let hikariComment = "";
                try {
                    const commentPrompt = `Eu acabei de converter ${convInfo.amount} ${convInfo.from} para ${convInfo.to} via comando manual. O resultado foi ${resultFormatted}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (Apenas o texto, sem JSON).`;
                    const rawComment = await generateResponse(commentPrompt, interaction.channelId, { allowSearch: false, disableTools: true, guildId: interaction.guildId, isInternalComment: true });
                    if (rawComment && !rawComment.includes('⚠️ SYSTEM ERROR')) {
                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                        if (jsonMatch) {
                            try {
                                const parsed = JSON.parse(jsonMatch[0]);
                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || cleanData;
                            } catch (e) {}
                        }
                        hikariComment = cleanData;
                    }
                } catch (e) {
                    console.warn('[CurrencyCommand] Falha ao gerar comentário IA:', e.message);
                }

                await interaction.editReply({ content: hikariComment || null, embeds: [convEmbed] });
            } catch (error) {
                console.error('Erro no comando converter_moeda:', error);
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Erro de Processamento')
                    .setDescription('Erro ao tentar converter essa moeda.');
                await interaction.editReply({ embeds: [errEmbed] });
            }
        } else if (commandName === 'bot_config') {
            if (!config.isOwner(interaction.user.id)) {
                const errEmbed = new EmbedBuilder()
                    .setColor(0xE11D48)
                    .setTitle('❌ Acesso Negado')
                    .setDescription('Comando restrito ao criador da Hikari.');
                return interaction.reply({ embeds: [errEmbed], ephemeral: true });
            }
            await handleConfigCommand(interaction);
        } else if (commandName === 'entrar-call') {
            const { joinVoiceCall } = require('../handlers/voiceHandler');
            await interaction.deferReply({ ephemeral: true });
            const result = await joinVoiceCall(interaction.member, interaction.channel);
            if (result) {
                await interaction.editReply({ content: '✅ Processando entrada no canal de voz...' });
            } else {
                await interaction.editReply({ content: '❌ Não foi possível entrar no canal de voz.' });
            }
        } else if (commandName === 'sair-call') {
            const { leaveVoiceCall } = require('../handlers/voiceHandler');
            await interaction.deferReply({ ephemeral: true });
            const result = await leaveVoiceCall(interaction.guildId, interaction.channel);
            if (result) {
                await interaction.editReply({ content: '✅ Saí do canal de voz.' });
            } else {
                await interaction.editReply({ content: '❌ Não estou em nenhum canal de voz neste servidor.' });
            }
        }
    },
};