import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} from 'discord.js';
import config from '../config.js';
import {
    addBan,
    removeBan,
    getBans,
    setAutoBlock,
    getAutoBlockMode
} from './banHandler.js';
import { buildBanListPayload } from './banListHandler.js';
import {
    updateShowModel,
    getShowModel,
    updateShowModelThinking,
    getShowModelThinking,
    updateErrorRetries,
    getErrorRetries,
    getDisabledTools,
    getAllMcpTools,
    setServerToolEnabled,
    resetServerTools
} from './llmHandler.js';
import { handleConfigCommand } from './configPanelHandler.js';
import { sendMcpToolsManager } from './mcpToolPanelHandler.js';

async function handleCreatorAdminCommand(interaction, client) {
    if (!config.isOwner(interaction.user.id)) {
        const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Acesso Negado')
            .setDescription(`Esse comando é exclusivo do criador da Yui <@${config.ownerId}>.`);
        return interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

    const sub = interaction.options.getSubcommand(false);

    if (sub === 'modelo') {
        const mostrarModelo = interaction.options.getBoolean('mostrar_nome');
        const mostrarPensamento = interaction.options.getBoolean('mostrar_pensamento');
        const retentativas = interaction.options.getInteger('retentativas');

        if (mostrarModelo !== null) updateShowModel(mostrarModelo);
        if (mostrarPensamento !== null) updateShowModelThinking(mostrarPensamento);
        if (retentativas !== null) updateErrorRetries(retentativas);

        const successEmbed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('⚙️ Configurações • Exibição & Modelos')
            .setDescription('As variáveis operacionais de exibição de modelo foram atualizadas.')
            .addFields(
                { name: 'Exibir Modelo', value: mostrarModelo !== null ? (mostrarModelo ? '✅ Sim' : '❌ Não') : 'Não alterado', inline: true },
                { name: 'Exibir Pensamento', value: mostrarPensamento !== null ? (mostrarPensamento ? '✅ Sim' : '❌ Não') : 'Não alterado', inline: true },
                { name: 'Tentativas de Erro', value: retentativas !== null ? String(retentativas) : 'Não alterado', inline: true }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [successEmbed], ephemeral: true });
    }

    if (sub === 'banir') {
        const tipo = interaction.options.getString('tipo');
        const id = interaction.options.getString('id');
        const motivo = interaction.options.getString('motivo') || 'Violação dos termos.';
        addBan(tipo, id, motivo);
        const embed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('🔒 Restrição Aplicada')
            .addFields(
                { name: 'Tipo', value: tipo, inline: true },
                { name: 'ID', value: `\`${id}\``, inline: true },
                { name: 'Motivo', value: motivo }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (sub === 'desbanir') {
        const tipo = interaction.options.getString('tipo');
        const id = interaction.options.getString('id');
        removeBan(tipo, id);
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('🔓 Restrição Revogada')
            .addFields(
                { name: 'Tipo', value: tipo, inline: true },
                { name: 'ID', value: `\`${id}\``, inline: true }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (sub === 'bans_lista') {
        const payload = await buildBanListPayload(client, 'home');
        return interaction.reply({ ...payload, ephemeral: true });
    }

    if (sub === 'automod') {
        const guildId = interaction.options.getString('servidor_id');
        const modo = interaction.options.getString('modo');
        setAutoBlock(guildId, modo);
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('🛡️ AutoMod Configurado')
            .addFields(
                { name: 'ID do Servidor', value: `\`${guildId}\``, inline: true },
                { name: 'Modo', value: `\`${modo}\``, inline: true }
            )
            .setTimestamp();
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (sub === 'ferramenta') {
        const acao = interaction.options.getString('acao');
        const toolInput = interaction.options.getString('ferramenta') || '';
        const estado = interaction.options.getString('estado');
        const targetGuildId = interaction.options.getString('servidor_id') || interaction.guildId;

        if (acao === 'toggle') {
            const allTools = getAllMcpTools();
            let tool = allTools.find(t => t.function.name === toolInput || t.meta.label === toolInput);
            if (!tool) tool = allTools.find(t => toolInput.includes(t.function.name) || toolInput.includes(t.meta.label));
            if (!tool) {
                return interaction.reply({ content: `❌ Ferramenta \`${toolInput}\` não encontrada.`, ephemeral: true });
            }
            const enabled = estado === 'on';
            setServerToolEnabled(targetGuildId, tool.function.name, enabled);
            const embed = new EmbedBuilder()
                .setColor(enabled ? 0x10B981 : 0xE11D48)
                .setTitle(`Ferramenta ${enabled ? 'Ativada' : 'Desativada'}`)
                .addFields(
                    { name: 'Ferramenta', value: tool.meta.label, inline: true },
                    { name: 'Servidor', value: `\`${targetGuildId}\``, inline: true }
                );
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (acao === 'reset') {
            resetServerTools(targetGuildId);
            const embed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('🔄 Ferramentas MCP Resetadas')
                .setDescription(`Todas as ferramentas foram reativadas para o servidor \`${targetGuildId}\`.`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (acao === 'list') {
            const disabled = getDisabledTools(targetGuildId);
            const allTools = getAllMcpTools();
            const embed = new EmbedBuilder()
                .setColor(0x7C3AED)
                .setTitle('🔧 Ferramentas MCP — Status')
                .setDescription(`Desabilitadas no servidor \`${targetGuildId}\`: ${disabled.length > 0 ? disabled.map(d => `\`${d}\``).join(', ') : 'Nenhuma'}`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }
    }

    if (sub === 'bot_config') {
        return handleConfigCommand(interaction);
    }

    return sendCreatorAdminDashboard(interaction, client);
}

async function sendCreatorAdminDashboard(interaction, client, isUpdate = false) {
    const currentBans = getBans();
    const userBansCount = Object.keys(currentBans.users || {}).length;
    const guildBansCount = Object.keys(currentBans.guilds || {}).length;
    const channelBansCount = Object.keys(currentBans.channels || {}).length;

    const memUsage = process.memoryUsage();
    const ramMB = (memUsage.heapUsed / 1024 / 1024).toFixed(1);

    const autoBlockMode = interaction.guildId ? getAutoBlockMode(interaction.guildId) : 'off';

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('👑 Central de Controle Master • Criador Yui')
        .setDescription('Painel de gestão global e administração avançada da Yui.')
        .addFields(
            { name: '📊 Status do Sistema', value: `**RAM em uso:** ${ramMB} MB\n**Exibir Modelo:** ${getShowModel() ? '✅ Sim' : '❌ Não'}\n**Exibir Pensamento:** ${getShowModelThinking() ? '✅ Sim' : '❌ Não'}\n**Retentativas:** ${getErrorRetries()}\n**AutoMod (Servidor):** \`${autoBlockMode}\``, inline: true },
            { name: '🛑 Restrições Globais', value: `**Usuários:** ${userBansCount}\n**Servidores:** ${guildBansCount}\n**Canais:** ${channelBansCount}`, inline: true }
        )
        .setFooter({ text: 'Central de Administração Criador • by yGuilhermy' })
        .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('crtcfg_btn_modelos').setLabel('Modelos & Pensamento').setStyle(ButtonStyle.Primary).setEmoji('🤖'),
        new ButtonBuilder().setCustomId('crtcfg_btn_ban').setLabel('Banir / Desbanir').setStyle(ButtonStyle.Danger).setEmoji('🛑'),
        new ButtonBuilder().setCustomId('crtcfg_btn_bans_lista').setLabel('Central de Bans').setStyle(ButtonStyle.Secondary).setEmoji('📜'),
        new ButtonBuilder().setCustomId('crtcfg_btn_automod').setLabel('AutoMod por Servidor').setStyle(ButtonStyle.Secondary).setEmoji('🛡️'),
        new ButtonBuilder().setCustomId('crtcfg_btn_mcp').setLabel('Gestor MCP').setStyle(ButtonStyle.Secondary).setEmoji('🔧')
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('crtcfg_btn_bot_config').setLabel('Painel Runtime').setStyle(ButtonStyle.Secondary).setEmoji('⚙️')
    );

    if (isUpdate) {
        return interaction.update({ embeds: [embed], components: [row1, row2] });
    }
    return interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: true });
}

async function handleCreatorAdminInteraction(interaction, client) {
    if (!config.isOwner(interaction.user.id)) {
        return interaction.reply({ content: '❌ Acesso restrito ao criador.', ephemeral: true });
    }

    const { customId } = interaction;

    if (customId === 'crtcfg_btn_modelos') {
        const modal = new ModalBuilder()
            .setCustomId('crtcfg_modal_modelos')
            .setTitle('🤖 Configurar Exibição & Retentativas');

        const showModelInput = new TextInputBuilder()
            .setCustomId('mostrar_nome')
            .setLabel('Exibir Nome do Modelo? (SIM / NAO)')
            .setStyle(TextInputStyle.Short)
            .setValue(getShowModel() ? 'SIM' : 'NAO')
            .setRequired(true);

        const showThinkingInput = new TextInputBuilder()
            .setCustomId('mostrar_pensamento')
            .setLabel('Exibir Modelo no Pensamento? (SIM / NAO)')
            .setStyle(TextInputStyle.Short)
            .setValue(getShowModelThinking() ? 'SIM' : 'NAO')
            .setRequired(true);

        const retriesInput = new TextInputBuilder()
            .setCustomId('retentativas')
            .setLabel('Número de Retentativas de Erro (0-10)')
            .setStyle(TextInputStyle.Short)
            .setValue(String(getErrorRetries()))
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(showModelInput),
            new ActionRowBuilder().addComponents(showThinkingInput),
            new ActionRowBuilder().addComponents(retriesInput)
        );

        return interaction.showModal(modal);
    }

    if (customId === 'crtcfg_btn_ban') {
        const modal = new ModalBuilder()
            .setCustomId('crtcfg_modal_ban')
            .setTitle('🛑 Aplicar / Revogar Bloqueio Global');

        const actionInput = new TextInputBuilder()
            .setCustomId('acao')
            .setLabel('Ação: BANIR ou DESBANIR')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Digite BANIR ou DESBANIR')
            .setRequired(true);

        const typeInput = new TextInputBuilder()
            .setCustomId('tipo')
            .setLabel('Tipo de Alvo: USER, GUILD ou CHANNEL')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('USER / GUILD / CHANNEL')
            .setRequired(true);

        const idInput = new TextInputBuilder()
            .setCustomId('id')
            .setLabel('ID do Alvo')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: 123456789012345678')
            .setRequired(true);

        const reasonInput = new TextInputBuilder()
            .setCustomId('motivo')
            .setLabel('Motivo (Apenas para Banir)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Motivo da restrição')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(actionInput),
            new ActionRowBuilder().addComponents(typeInput),
            new ActionRowBuilder().addComponents(idInput),
            new ActionRowBuilder().addComponents(reasonInput)
        );

        return interaction.showModal(modal);
    }

    if (customId === 'crtcfg_btn_bans_lista') {
        const payload = await buildBanListPayload(client, 'home');
        return interaction.reply({ ...payload, ephemeral: true });
    }

    if (customId === 'crtcfg_btn_automod') {
        const modal = new ModalBuilder()
            .setCustomId('crtcfg_modal_automod')
            .setTitle('🛡️ Configurar AutoMod por Servidor');

        const guildIdInput = new TextInputBuilder()
            .setCustomId('servidor_id')
            .setLabel('ID do Servidor Target')
            .setStyle(TextInputStyle.Short)
            .setValue(interaction.guildId || '')
            .setRequired(true);

        const modeInput = new TextInputBuilder()
            .setCustomId('modo')
            .setLabel('Modo: OFF, TRIGGER, MCP ou BOTH')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('off / trigger / mcp / both')
            .setRequired(true);

        modal.addComponents(
            new ActionRowBuilder().addComponents(guildIdInput),
            new ActionRowBuilder().addComponents(modeInput)
        );

        return interaction.showModal(modal);
    }

    if (customId === 'crtcfg_btn_mcp') {
        return sendMcpToolsManager(interaction, interaction.guildId, null, false, true);
    }

    if (customId === 'crtcfg_btn_bot_config') {
        return handleConfigCommand(interaction);
    }

    if (customId === 'crtcfg_modal_modelos') {
        const mostrarNome = (interaction.fields.getTextInputValue('mostrar_nome') || '').toUpperCase() === 'SIM';
        const mostrarPensamento = (interaction.fields.getTextInputValue('mostrar_pensamento') || '').toUpperCase() === 'SIM';
        const rawRetentativas = interaction.fields.getTextInputValue('retentativas');
        const parsedRetentativas = parseInt(rawRetentativas);
        const retentativas = isNaN(parsedRetentativas) ? getErrorRetries() : Math.max(0, Math.min(10, parsedRetentativas));

        updateShowModel(mostrarNome);
        updateShowModelThinking(mostrarPensamento);
        updateErrorRetries(retentativas);

        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('🤖 Parâmetros de Exibição Atualizados')
            .addFields(
                { name: 'Exibir Nome do Modelo', value: mostrarNome ? '✅ Sim' : '❌ Não', inline: true },
                { name: 'Exibir Modelo no Pensamento', value: mostrarPensamento ? '✅ Sim' : '❌ Não', inline: true },
                { name: 'Retentativas em Erro', value: String(retentativas), inline: true }
            );
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (customId === 'crtcfg_modal_ban') {
        const acao = (interaction.fields.getTextInputValue('acao') || '').toLowerCase();
        const tipo = (interaction.fields.getTextInputValue('tipo') || '').toLowerCase();
        const id = interaction.fields.getTextInputValue('id');
        const motivo = interaction.fields.getTextInputValue('motivo') || 'Violação.';

        if (acao === 'banir') {
            addBan(tipo, id, motivo);
            const embed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('🛑 Bloqueio Aplicado')
                .setDescription(`O alvo \`${id}\` (${tipo}) foi banido globalmente.`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        } else if (acao === 'desbanir') {
            removeBan(tipo, id);
            const embed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('🔓 Bloqueio Revogado')
                .setDescription(`O alvo \`${id}\` (${tipo}) foi desbanido.`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        } else {
            return interaction.reply({ content: '❌ Ação inválida. Digite BANIR ou DESBANIR.', ephemeral: true });
        }
    }

    if (customId === 'crtcfg_modal_automod') {
        const guildId = interaction.fields.getTextInputValue('servidor_id');
        const modo = (interaction.fields.getTextInputValue('modo') || '').toLowerCase();

        if (!['off', 'trigger', 'mcp', 'both'].includes(modo)) {
            return interaction.reply({ content: '❌ Modo inválido. Escolha entre: off, trigger, mcp, both.', ephemeral: true });
        }

        setAutoBlock(guildId, modo);
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('🛡️ AutoMod do Servidor Atualizado')
            .setDescription(`Servidor: \`${guildId}\` | Novo modo: \`${modo}\``);
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (customId === 'crtcfg_modal_mcp') {
        const guildId = interaction.fields.getTextInputValue('servidor_id');
        const toolOrCmd = (interaction.fields.getTextInputValue('ferramenta') || '').trim();
        const estadoRaw = (interaction.fields.getTextInputValue('estado') || '').toLowerCase();

        if (toolOrCmd.toUpperCase() === 'RESET') {
            resetServerTools(guildId);
            const embed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('🔄 Tools Resetadas')
                .setDescription(`Todas as ferramentas foram reativadas para o servidor \`${guildId}\`.`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        if (toolOrCmd.toUpperCase() === 'LIST') {
            const disabled = getDisabledTools(guildId);
            const embed = new EmbedBuilder()
                .setColor(0x7C3AED)
                .setTitle('🔧 Ferramentas Desabilitadas')
                .setDescription(`Servidor \`${guildId}\`: ${disabled.length > 0 ? disabled.map(d => `\`${d}\``).join(', ') : 'Nenhuma'}`);
            return interaction.reply({ embeds: [embed], ephemeral: true });
        }

        const enabled = estadoRaw === 'on';
        setServerToolEnabled(guildId, toolOrCmd, enabled);
        const embed = new EmbedBuilder()
            .setColor(enabled ? 0x10B981 : 0xE11D48)
            .setTitle(`Ferramenta ${enabled ? 'Ativada' : 'Desativada'}`)
            .setDescription(`Ferramenta \`${toolOrCmd}\` para o servidor \`${guildId}\`.`);
        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

export default {
    handleCreatorAdminCommand,
    handleCreatorAdminInteraction
};
