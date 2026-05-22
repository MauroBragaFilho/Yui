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
    updateProviderSetting,
    getProviderSettings,
    setChannelPersona,
    setChannelChatter,
    setServerEveryoneMention
} = require('../handlers/llmHandler');
const { generateImage } = require('../handlers/imageHandler');
const { downloadYouTubeAudio, sanitizeFilenameForDiscord } = require('../handlers/youtubeAudioHandler');
const { executeGameCommand } = require('../handlers/gameHandler');
const { handleSauceCommand } = require('../handlers/sauceHandler');
const { getSteamGameInfo } = require('../handlers/steamHandler');
const { convertCurrency } = require('../handlers/currencyHandler');
const { generateResponse } = require('../handlers/llmHandler');

async function buildBanListPayload(client, category, page = 0) {
    const currentBans = getBans();
    const embed = new EmbedBuilder().setColor(0xE74C3C);

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
    const embed = new EmbedBuilder().setColor(0xE74C3C);

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
        if (interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith('banlist_select_')) {
                if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
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
                            .setColor(0x9B59B6)
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
                        .setColor(0x9B59B6)
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
            if (cid.startsWith('adm_manageguild_')) {
                if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
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
                if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
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
                if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
                const payload = await buildBanListPayload(client, 'home');
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_view_')) {
                if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
                const parts = cid.split('_');
                const category = parts[2];
                const page = parseInt(parts[3] || '0');
                const payload = await buildBanListPayload(client, category, page);
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_detail_')) {
                if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
                const parts = cid.split('_');
                const category = parts[2];
                const targetId = parts[3];
                if (targetId === 'none') {
                    return await interaction.reply({ content: '❌ Sem mais registros.', ephemeral: true });
                }
                const payload = await buildBanDetailPayload(client, category, targetId);
                return await interaction.update(payload);
            } else if (cid.startsWith('banlist_unban_')) {
                if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
                const parts = cid.split('_');
                const category = parts[2];
                const targetId = parts[3];
                const apiType = category === 'users' ? 'user' : category === 'guilds' ? 'guild' : 'channel';
                removeBan(apiType, targetId);
                const embed = new EmbedBuilder()
                    .setColor(0x2ECC71)
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
                        .setColor(0x9B59B6)
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
                        .setColor(0x9B59B6)
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
            await handleTosInteraction(interaction);
            await handleBanInteraction(interaction, client);
            return;
        }
        if (!interaction.isCommand() && !interaction.isAutocomplete()) return;
        if (interaction.isCommand()) {
            const sub = interaction.options.getSubcommand(false);
            const cmdLog = `[LOG] Slash: /${interaction.commandName}${sub ? ' ' + sub : ''} | Usuário: ${interaction.user.tag} (${interaction.user.id}) | Local: {${interaction.guild?.name || 'DM'} - ${interaction.guildId || 'N/A'}}`;
            console.log(cmdLog);
            const banInfo = checkBan(interaction.user.id, interaction.guildId, interaction.channelId);
            if (banInfo && interaction.commandName !== 'ajuda') {
                const banEmbed = new EmbedBuilder()
                    .setColor(0xE74C3C)
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
                    .filter(t => t.meta.disableable)
                    .filter(t => t.function.name.includes(focused) || t.meta.label.toLowerCase().includes(focused))
                    .map(t => {
                        const isDisabled = disabled.includes(t.function.name);
                        return {
                            name: `${isDisabled ? '❌' : '✅'} ${t.meta.label}`,
                            value: t.function.name
                        };
                    })
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
                return interaction.reply({ content: `❌ Esse comando é exclusivo do meu criador <@${config.ownerId}> [\[Abrir Perfil\](https://discord.com/users/${config.ownerId})]. ✨`, ephemeral: true });
            }
            const sub = interaction.options.getSubcommand();
            const guildId = interaction.guildId;
            if (sub === 'set') {
                const newPrompt = interaction.options.getString('prompt');
                setServerPrompt(guildId, newPrompt);
                const preview = newPrompt.length > 300 ? newPrompt.substring(0, 300) + '...' : newPrompt;
                const embed = new EmbedBuilder()
                    .setColor(0x9B59B6)
                    .setTitle('✅ System Prompt Atualizado')
                    .setDescription('O system prompt deste servidor foi sobrescrito com sucesso.')
                    .addFields({ name: '📝 Novo Prompt (prévia)', value: `\`\`\`${preview}\`\`\`` })
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (sub === 'reset') {
                const current = getServerPrompt(guildId);
                if (!current) {
                    return interaction.reply({ content: 'ℹ️ Este servidor já usa o system prompt padrão do código. Nada para resetar.', ephemeral: true });
                }
                resetServerPrompt(guildId);
                const embed = new EmbedBuilder()
                    .setColor(0xE74C3C)
                    .setTitle('🔄 System Prompt Resetado')
                    .setDescription('O system prompt customizado foi removido. A Hikari voltou a usar o prompt padrão do código neste servidor.')
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            } else if (sub === 'view') {
                const current = getServerPrompt(guildId);
                if (!current) {
                    const embed = new EmbedBuilder()
                        .setColor(0x3498DB)
                        .setTitle('🔍 System Prompt Atual')
                        .setDescription('Este servidor está usando o **prompt padrão do código**. Nenhum prompt customizado configurado.')
                        .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                        .setTimestamp();
                    return interaction.reply({ embeds: [embed], ephemeral: true });
                }
                const preview = current.length > 900 ? current.substring(0, 900) + '\n[... truncado]' : current;
                const embed = new EmbedBuilder()
                    .setColor(0x27AE60)
                    .setTitle('🔍 System Prompt Atual (Customizado)')
                    .setDescription(`\`\`\`${preview}\`\`\``)
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • Caracteres: ${current.length} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: true });
            }
        } else if (commandName === 'ia_ferramentas') {
            if (!config.isOwner(interaction.user.id)) {
                return interaction.reply({ content: `❌ Esse comando é exclusivo do meu criador <@${config.ownerId}> [\[Abrir Perfil\](https://discord.com/users/${config.ownerId})]. ✨`, ephemeral: true });
            }
            const sub = interaction.options.getSubcommand();
            const guildId = interaction.guildId;
            const allTools = getAllMcpTools();
            if (sub === 'toggle') {
                const toolName = interaction.options.getString('tool');
                const estado = interaction.options.getString('estado');
                const enabled = estado === 'on';
                const tool = allTools.find(t => t.function.name === toolName);
                if (!tool) return interaction.reply({ content: `❌ Tool \`${toolName}\` não encontrada.`, ephemeral: true });
                if (!tool.meta.disableable && !enabled) return interaction.reply({ content: `🔒 A tool **${tool.meta.label}** não pode ser desabilitada.`, ephemeral: true });
                const ok = setServerToolEnabled(guildId, toolName, enabled);
                if (!ok) return interaction.reply({ content: `❌ Não foi possível alterar a tool \`${toolName}\`.`, ephemeral: true });
                const embed = new EmbedBuilder()
                    .setColor(enabled ? 0x27AE60 : 0xE74C3C)
                    .setTitle(`${enabled ? '✅ Tool Ativada' : '❌ Tool Desativada'}`)
                    .addFields(
                        { name: 'Ferramenta', value: `${tool.meta.label}\n\`${toolName}\``, inline: true },
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
                const fields = allTools.map(t => {
                    const isGuard = !!(t.meta && t.meta.guardAutomod);
                    if (isGuard) {
                        const statusLabel = _mcpEnabled ? '✅' : '⛔';
                        const note = !_automodActive ? ' (AutoMod Desativado)' : (_automodMode === 'trigger') ? ' (Modo: trigger — IA inativa)' : '';
                        return { name: `${statusLabel} ${t.meta.label}`, value: `\`${t.function.name}\` 🔒${note}`, inline: true };
                    }
                    return {
                        name: `${disabled.includes(t.function.name) ? '❌' : '✅'} ${t.meta.label}`,
                        value: `\`${t.function.name}\`${!t.meta.disableable ? ' 🔒' : ''}`,
                        inline: true
                    };
                });
                const activeCnt = allTools.filter(t => {
                    if (t.meta && t.meta.guardAutomod) return _mcpEnabled;
                    return !disabled.includes(t.function.name);
                }).length;
                const embed = new EmbedBuilder()
                    .setColor(0x3498DB)
                    .setTitle('🔧 Ferramentas MCP — Status do Servidor')
                    .setDescription(`**${interaction.guild?.name || guildId}**\n\n✅ = Ativa | ❌ = Desativada | ⛔ = Inativa (AutoMod) | 🔒 = Não configurável\n\n🛡️ **Modo AutoMod do Servidor:** \`${_automodMode}\``)
                    .addFields(fields)
                    .setFooter({ text: `${activeCnt}/${allTools.length} tools ativas • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: false });
            } else if (sub === 'reset') {
                const disabled = getDisabledTools(guildId);
                if (disabled.length === 0) return interaction.reply({ content: 'ℹ️ Nenhuma tool está desabilitada neste servidor.', ephemeral: true });
                resetServerTools(guildId);
                const embed = new EmbedBuilder()
                    .setColor(0x9B59B6)
                    .setTitle('🔄 Tools Resetadas')
                    .setDescription(`Todas as **${disabled.length}** tools desabilitadas foram reativadas.`)
                    .addFields({ name: 'Tools reativadas', value: disabled.map(n => `\`${n}\``).join(', ') })
                    .setFooter({ text: `Servidor: ${interaction.guild?.name || guildId} • by yGuilhermy` })
                    .setTimestamp();
                await interaction.reply({ embeds: [embed], ephemeral: false });
            }
        } else if (commandName === 'ia_mention_todos') {
            const hasPermission = !interaction.guild || (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.ManageGuild)) || config.isOwner(interaction.user.id);
            if (!hasPermission) return interaction.reply({ content: '❌ Acesso restrito (Requer gerenciar servidor).', ephemeral: true });
            
            const ativo = interaction.options.getBoolean('ativo');
            setServerEveryoneMention(interaction.guildId, ativo);
            
            await interaction.reply({ 
                content: `🔔 **Marcações Everyone/Here**: Hikari ${ativo ? '✅ **AGORA VAI**' : '❌ **NÃO VAI MAIS**'} responder a marcações de @everyone e @here neste servidor.`, 
                ephemeral: false 
            });
        } else if (commandName === 'ajuda') {
            try {
                const helpDataPath = path.join(__dirname, '../data/help.json');
                if (!fs.existsSync(helpDataPath)) return await interaction.reply({ content: 'Arquivo de ajuda não encontrado.', ephemeral: true });
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
                    .setColor(0x9B59B6)
                    .setTitle('✨ Central de Ajuda — Hikari')
                    .setDescription('Bem-vindo(a)! Selecione um tópico no menu abaixo.\n\n📖 [Guia Completo de Comandos](https://github.com/yGuilhermy/Hikari/blob/main/docs/content_pt/COMMANDS.md)')
                    .addFields(helpData.map(item => ({ name: item.label, value: item.description || 'Sem descrição', inline: true })))
                    .setFooter({ text: 'Hikari • Menu de Ajuda • by yGuilhermy' })
                    .setTimestamp();
                await interaction.reply({ embeds: [welcomeEmbed], components: [row, linkRow], ephemeral: false });
            } catch (error) {
                console.error('Erro no comando help:', error);
                await interaction.reply({ content: 'Erro ao criar o menu de ajuda.', ephemeral: true });
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
                        .setColor(0x3498DB)
                        .setTitle('🎨 Imagem Gerada')
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
                    await interaction.editReply('❌ Desculpe, não consegui gerar a imagem.');
                }
            } catch (error) {
                console.error('Erro /draw:', error);
                await interaction.editReply(`❌ Erro: ${error.message}`);
            }
        } else if (commandName === 'baixar_musica') {
            const videoUrl = interaction.options.getString('url');
            await interaction.deferReply({ ephemeral: false });
            let downloadedAudioInfo = null;
            try {
                downloadedAudioInfo = await downloadYouTubeAudio(videoUrl);
                if (downloadedAudioInfo && downloadedAudioInfo.filePath) {
                    const { filePath, metadata } = downloadedAudioInfo;
                    const displayFileName = sanitizeFilenameForDiscord(metadata.title || 'audio');
                    const attachment = new AttachmentBuilder(filePath, { name: `${displayFileName}.mp3` });
                    await interaction.editReply({ content: `Áudio baixado: \`${metadata.title}\``, files: [attachment] });
                } else {
                    await interaction.editReply('Não consegui baixar o áudio.');
                }
            } catch (error) {
                console.error('yt_audio:', error);
                await interaction.editReply(`Erro: ${error.message}`);
            } finally {
                if (downloadedAudioInfo && downloadedAudioInfo.filePath && fs.existsSync(downloadedAudioInfo.filePath)) {
                    fs.unlink(downloadedAudioInfo.filePath, (err) => { if (err) console.error(err); });
                }
            }
        } else if (commandName === 'buscar_jogo') {
            await executeGameCommand(interaction);
        } else if (commandName === 'chat_humor') {
            const hasPermission = !interaction.guild || (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) || config.isOwner(interaction.user.id);
            if (!hasPermission) return interaction.reply({ content: 'Sem permissão.', ephemeral: true });
            const reset = interaction.options.getBoolean('reset');
            if (reset) {
                setChannelPersona(interaction.channelId, { reset: true });
                await interaction.reply({ content: '🔄 Resetado.', ephemeral: false });
            } else {
                const instruction = interaction.options.getString('instrucao') || undefined;
                const mood = interaction.options.getString('mood') || undefined;
                if (!instruction && !mood) return interaction.reply({ content: '⚠️ Forneça instrução ou humor.', ephemeral: true });
                setChannelPersona(interaction.channelId, { instruction, mood });
                await interaction.reply({ content: '✅ Atualizado!', ephemeral: false });
            }
        } else if (commandName === 'chat_espontaneo') {
            const hasPermission = !interaction.guild || (interaction.member && interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)) || config.isOwner(interaction.user.id);
            if (!hasPermission) return interaction.reply({ content: '❌ Acesso restrito (Requer gerenciar canais).', ephemeral: true });

            const percentage = interaction.options.getInteger('porcentagem');
            if (percentage !== null && !config.isOwner(interaction.user.id)) {
                return interaction.reply({ content: '❌ Apenas o dono do bot pode definir a porcentagem personalizada.', ephemeral: true });
            }

            const state = interaction.options.getString('estado');
            const freq = interaction.options.getString('frequencia') || 'low';
            const isActive = state === 'on';
            setChannelChatter(interaction.channelId, { active: isActive, frequency: freq, percentage });
            await interaction.reply({ content: `🗣️ **Chatter Mode**: ${isActive ? '✅ ATIVADO' : '🔴 DESATIVADO'}`, ephemeral: false });
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
                await interaction.editReply('Erro ao resumir.');
            }
        } else if (commandName === 'anime_origem') {
            await handleSauceCommand(interaction);
        } else if (commandName === 'ia_config') {
            if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
            const provider = interaction.options.getString('provider');
            const setting = interaction.options.getString('setting');
            const value = interaction.options.getNumber('value');
            if (provider) {
                if (!setting || value === null) return interaction.reply({ content: '❌ Forneça config e valor.', ephemeral: true });
                updateProviderSetting(provider, setting, value);
            }
            await interaction.reply({ content: '✅ Configurações atualizadas.', ephemeral: true });
        } else if (commandName === 'ia_model_config') {
            if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
            const mostrarModelo = interaction.options.getBoolean('mostrar_modelo');
            const mostrarModeloPensamento = interaction.options.getBoolean('mostrar_modelo_pensamento');
            if (mostrarModelo !== null) updateShowModel(mostrarModelo);
            if (mostrarModeloPensamento !== null) updateShowModelThinking(mostrarModeloPensamento);
            await interaction.reply({ content: '✅ Configurações de exibição do modelo atualizadas.', ephemeral: true });
        } else if (commandName === 'adm_banir') {
            if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Negado.', ephemeral: true });
            const tipo = interaction.options.getString('tipo');
            const id = interaction.options.getString('id');
            const motivo = interaction.options.getString('motivo') || "Violação.";
            addBan(tipo, id, motivo);
            await interaction.reply({ content: `✅ **${tipo}** \`${id}\` banido! Motivo: ${motivo}`, ephemeral: false });
        } else if (commandName === 'adm_desbanir') {
            if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Negado.', ephemeral: true });
            const tipo = interaction.options.getString('tipo');
            const id = interaction.options.getString('id');
            removeBan(tipo, id);
            await interaction.reply({ content: `✅ **${tipo}** \`${id}\` desbanido com sucesso!`, ephemeral: false });
        } else if (commandName === 'adm_lista_bans') {
            if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Negado.', ephemeral: true });
            const payload = await buildBanListPayload(client, 'home');
            await interaction.reply({ ...payload, ephemeral: true });
        } else if (commandName === 'adm_automod') {
            if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Restrito.', ephemeral: true });
            const guildId = interaction.options.getString('id');
            const modo = interaction.options.getString('modo');
            setAutoBlock(guildId, modo);
            await interaction.reply({ content: `🛡️ AutoMod do servidor \`${guildId}\` atualizado para \`${modo}\`.`, ephemeral: true });
        } else if (commandName === 'steam_jogo') {
            const query = interaction.options.getString('nome');
            await interaction.deferReply();
            
            try {
                const steamInfo = await getSteamGameInfo(query);
                if (steamInfo.error) {
                    return await interaction.editReply(`❌ ${steamInfo.error}`);
                }

                let finalDesc = steamInfo.description || "Sem sinopse válida.";
                if (finalDesc.length > 3900) finalDesc = finalDesc.substring(0, 3900) + '...';

                const steamEmbed = new EmbedBuilder()
                    .setColor(0x9B59B6)
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
                await interaction.editReply('❌ Erro ao processar a consulta da Steam.');
            }
        } else if (commandName === 'converter_moeda') {
            const amount = interaction.options.getNumber('valor');
            const from = interaction.options.getString('de');
            const to = interaction.options.getString('para');
            await interaction.deferReply();
            
            try {
                const convInfo = await convertCurrency(amount, from, to);
                if (convInfo.error) {
                    return await interaction.editReply(`❌ ${convInfo.error}`);
                }

                const amountFormatted = Number(convInfo.amount).toLocaleString('pt-BR');
                const resultFormatted = Number(convInfo.result).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                const rateFormatted = Number(convInfo.rate).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
                
                const convEmbed = new EmbedBuilder()
                    .setColor(0x2ECC71)
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
                await interaction.editReply('❌ Erro ao tentar converter essa moeda.');
            }
        }
    },
};