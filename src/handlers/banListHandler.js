import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { getBans } from './banHandler.js';

async function buildBanListPayload(client, category, page = 0) {
    const currentBans = getBans();
    const embed = new EmbedBuilder().setColor(0xE11D48);

    if (category === 'home') {
        embed.setTitle('🚫 Central de Bloqueios • Yui')
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

export default {
    buildBanListPayload,
    buildBanDetailPayload
};
