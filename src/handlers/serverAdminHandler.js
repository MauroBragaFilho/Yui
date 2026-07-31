const {
    EmbedBuilder,
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ChannelSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    PermissionFlagsBits,
    ChannelType
} = require('discord.js');
const config = require('../config');
const {
    setChannelPersona,
    setChannelChatter,
    setServerEveryoneMention,
    setServerUpdateChannel,
    getDisabledTools,
    getAllMcpTools,
    setServerToolEnabled,
    resetServerTools
} = require('./llmHandler');
const { sendMcpToolsManager } = require('./mcpToolPanelHandler');

async function handleServerAdminCommand(interaction) {
    const hasPermission = !interaction.guild || (interaction.member && (
        interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)
    )) || config.isOwner(interaction.user.id);

    if (!hasPermission) {
        const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Acesso Negado')
            .setDescription('Você precisa de permissão de **Gerenciar Servidor** ou **Gerenciar Canais** para usar este comando.');
        return interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

    const instrucao = interaction.options.getString('instrucao');
    const mood = interaction.options.getString('mood');
    const resetHumor = interaction.options.getBoolean('reset_humor');
    const espontaneoEstado = interaction.options.getString('espontaneo_estado');
    const espontaneoFrequencia = interaction.options.getString('espontaneo_frequencia');
    const espontaneoPorcentagem = interaction.options.getInteger('espontaneo_porcentagem');
    const canalUpdates = interaction.options.getChannel('canal_updates');
    const mencoesAtivo = interaction.options.getBoolean('mencoes_ativo');

    const hasOptions = instrucao !== null || mood !== null || resetHumor !== null ||
                       espontaneoEstado !== null || espontaneoFrequencia !== null || espontaneoPorcentagem !== null ||
                       canalUpdates !== null || mencoesAtivo !== null;

    if (hasOptions) {
        const results = [];

        if (resetHumor) {
            setChannelPersona(interaction.channelId, { reset: true });
            results.push('🔄 **Humor & Personalidade:** Reseta dos para o padrão neste canal.');
        } else if (instrucao !== null || mood !== null) {
            setChannelPersona(interaction.channelId, { instruction: instrucao || undefined, mood: mood || undefined });
            results.push(`🎭 **Humor & Personalidade:** Atualizado neste canal. (Mood: \`${mood || 'Não alterado'}\`)`);
        }

        if (espontaneoEstado !== null || espontaneoFrequencia !== null || espontaneoPorcentagem !== null) {
            if (espontaneoPorcentagem !== null && !config.isOwner(interaction.user.id)) {
                return interaction.reply({ content: '❌ Apenas o criador pode definir a porcentagem exata.', ephemeral: true });
            }
            const isActive = espontaneoEstado !== null ? espontaneoEstado === 'on' : undefined;
            setChannelChatter(interaction.channelId, {
                active: isActive,
                frequency: espontaneoFrequencia || undefined,
                percentage: espontaneoPorcentagem || undefined
            });
            const statusStr = isActive !== undefined ? (isActive ? '🟢 Ativado' : '🔴 Desativado') : 'Atualizado';
            results.push(`🗣️ **Modo Espontâneo:** ${statusStr} ${espontaneoFrequencia ? `(Frequência: \`${espontaneoFrequencia}\`)` : ''}`);
        }

        if (canalUpdates !== null) {
            if (!canalUpdates.isTextBased()) {
                return interaction.reply({ content: '❌ O canal de updates deve ser um canal de texto.', ephemeral: true });
            }
            setServerUpdateChannel(interaction.guildId, canalUpdates.id);
            results.push(`📢 **Canal de Updates:** Definido para <#${canalUpdates.id}>`);
        }

        if (mencoesAtivo !== null) {
            setServerEveryoneMention(interaction.guildId, mencoesAtivo);
            results.push(`🔔 **Respostas a @everyone/@here:** ${mencoesAtivo ? '✅ Ativado' : '❌ Desativado'}`);
        }

        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('⚙️ Configuração do Servidor Aplicada')
            .setDescription(results.join('\n\n'))
            .setFooter({ text: 'Hikari Server Admin • by yGuilhermy' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    return sendServerAdminDashboard(interaction);
}

async function sendServerAdminDashboard(interaction, isUpdate = false) {
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('⚙️ Painel de Administração do Servidor')
        .setDescription('Selecione uma das opções abaixo para configurar a **Hikari** neste servidor e canal.')
        .addFields(
            { name: '🎭 Personalidade & Humor', value: 'Configure a atitude da IA ou adicione instruções personalizadas para este canal.', inline: false },
            { name: '💬 Mensagens Espontâneas', value: 'Ajuste com que frequência a IA entra nas conversas por conta própria.', inline: false },
            { name: '📢 Canal de Updates', value: 'Escolha o canal de texto onde o bot enviará avisos de atualizações.', inline: false },
            { name: '🔔 Resposta a @everyone / @here', value: 'Defina se a IA deve responder quando o servidor for mencionado em massa.', inline: false },
            { name: '🔧 Ferramentas MCP', value: 'Inspecione descrições e ative/desative ferramentas de IA para este servidor.', inline: false }
        )
        .setFooter({ text: 'Hikari Administrative Dashboard • by yGuilhermy' })
        .setTimestamp();

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('srvcfg_btn_humor').setLabel('Personalidade & Humor').setStyle(ButtonStyle.Primary).setEmoji('🎭'),
        new ButtonBuilder().setCustomId('srvcfg_btn_espontaneo').setLabel('Mensagens Espontâneas').setStyle(ButtonStyle.Secondary).setEmoji('💬'),
        new ButtonBuilder().setCustomId('srvcfg_btn_updates').setLabel('Canal de Updates').setStyle(ButtonStyle.Secondary).setEmoji('📢'),
        new ButtonBuilder().setCustomId('srvcfg_btn_mencoes').setLabel('Respostas a Mentions').setStyle(ButtonStyle.Secondary).setEmoji('🔔')
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('srvcfg_btn_mcp').setLabel('Ferramentas MCP').setStyle(ButtonStyle.Secondary).setEmoji('🔧')
    );

    if (isUpdate) {
        return interaction.update({ embeds: [embed], components: [row1, row2] });
    }
    return interaction.reply({ embeds: [embed], components: [row1, row2], ephemeral: false });
}

async function handleServerAdminInteraction(interaction) {
    const hasPermission = !interaction.guild || (interaction.member && (
        interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)
    )) || config.isOwner(interaction.user.id);

    if (!hasPermission) {
        const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Acesso Negado')
            .setDescription('Você precisa de permissão de **Gerenciar Servidor** ou **Gerenciar Canais** para alterar esta configuração.');
        return interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

    const { customId } = interaction;

    if (customId === 'srvcfg_btn_mcp') {
        return sendMcpToolsManager(interaction, interaction.guildId, null, false, false);
    }

    if (customId === 'srvcfg_btn_humor') {
        const modal = new ModalBuilder()
            .setCustomId('srvcfg_modal_humor')
            .setTitle('🎭 Personalidade & Humor do Canal');

        const instrucaoInput = new TextInputBuilder()
            .setCustomId('instrucao')
            .setLabel('Instrução de Comportamento (Prompt)')
            .setStyle(TextInputStyle.Paragraph)
            .setPlaceholder('Ex: Seja muito irônica, fale com gírias e responda rápido.')
            .setRequired(false);

        const moodInput = new TextInputBuilder()
            .setCustomId('mood')
            .setLabel('Humor / Estado Emocional')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Ex: Engraçada, Séria, Debochada')
            .setRequired(false);

        const resetInput = new TextInputBuilder()
            .setCustomId('reset')
            .setLabel('Resetar para o Padrão? (Digite SIM)')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('Digite SIM para restaurar o padrão de fábrica')
            .setRequired(false);

        modal.addComponents(
            new ActionRowBuilder().addComponents(instrucaoInput),
            new ActionRowBuilder().addComponents(moodInput),
            new ActionRowBuilder().addComponents(resetInput)
        );

        return interaction.showModal(modal);
    }

    if (customId === 'srvcfg_btn_espontaneo') {
        const embed = new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle('💬 Configurar Mensagens Espontâneas')
            .setDescription('Escolha abaixo o estado e a frequência com que a Hikari falará sozinha neste canal.');

        const rowButtons = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('srvcfg_espontaneo_on').setLabel('🟢 Ativar Espontâneo').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('srvcfg_espontaneo_off').setLabel('🔴 Desativar Espontâneo').setStyle(ButtonStyle.Danger)
        );

        const freqMenu = new StringSelectMenuBuilder()
            .setCustomId('srvcfg_espontaneo_freq')
            .setPlaceholder('⏱️ Alterar Frequência de Fala')
            .addOptions([
                { label: '🐢 Baixa (Raro)', value: 'low', description: 'Intromete-se raramente nas conversas' },
                { label: '🐇 Média (Ocasional)', value: 'medium', description: 'Intromete-se de vez em quando' },
                { label: '🐆 Alta (Faladora)', value: 'high', description: 'Intromete-se com alta frequência' }
            ]);

        const rowFreq = new ActionRowBuilder().addComponents(freqMenu);

        return interaction.reply({ embeds: [embed], components: [rowButtons, rowFreq], ephemeral: false });
    }

    if (customId === 'srvcfg_btn_updates') {
        const embed = new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle('📢 Configurar Canal de Updates')
            .setDescription('Selecione abaixo o canal de texto onde a Hikari enviará avisos de atualizações.');

        const channelSelect = new ChannelSelectMenuBuilder()
            .setCustomId('srvcfg_updates_ch')
            .setPlaceholder('📍 Escolha um canal de texto')
            .setChannelTypes([ChannelType.GuildText]);

        const row = new ActionRowBuilder().addComponents(channelSelect);

        return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (customId === 'srvcfg_btn_mencoes') {
        const embed = new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle('🔔 Respostas a Menções Globais')
            .setDescription('Escolha se a Hikari deve responder a marcações de `@everyone` e `@here` neste servidor.');

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('srvcfg_mencoes_on').setLabel('✅ Responder a Mentions').setStyle(ButtonStyle.Success),
            new ButtonBuilder().setCustomId('srvcfg_mencoes_off').setLabel('❌ Ignorar Mentions').setStyle(ButtonStyle.Danger)
        );

        return interaction.reply({ embeds: [embed], components: [row], ephemeral: false });
    }

    if (customId === 'srvcfg_modal_humor') {
        const instrucao = interaction.fields.getTextInputValue('instrucao') || undefined;
        const mood = interaction.fields.getTextInputValue('mood') || undefined;
        const resetText = (interaction.fields.getTextInputValue('reset') || '').toUpperCase();

        if (resetText === 'SIM') {
            setChannelPersona(interaction.channelId, { reset: true });
            const embed = new EmbedBuilder()
                .setColor(0x10B981)
                .setTitle('🔄 Personalidade Restaurada')
                .setDescription('As configurações de comportamento e humor deste canal foram redefinidas para o padrão.');
            return interaction.reply({ embeds: [embed], ephemeral: false });
        }

        setChannelPersona(interaction.channelId, { instruction: instrucao, mood: mood });
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('🎭 Personalidade Atualizada')
            .addFields(
                { name: 'Humor', value: `\`${mood || 'Não alterado'}\``, inline: true },
                { name: 'Instrução', value: instrucao ? `\`\`\`\n${instrucao.substring(0, 500)}\`\`\`` : '*Não alterado*', inline: false }
            );
        return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (customId === 'srvcfg_espontaneo_on' || customId === 'srvcfg_espontaneo_off') {
        const isActive = customId === 'srvcfg_espontaneo_on';
        setChannelChatter(interaction.channelId, { active: isActive });
        const embed = new EmbedBuilder()
            .setColor(isActive ? 0x10B981 : 0xE11D48)
            .setTitle('💬 Modo Espontâneo Atualizado')
            .setDescription(`O modo espontâneo está agora ${isActive ? '🟢 **ATIVADO**' : '🔴 **DESATIVADO**'} neste canal.`);
        return interaction.update({ embeds: [embed], components: [] });
    }

    if (customId === 'srvcfg_espontaneo_freq') {
        const freq = interaction.values[0];
        setChannelChatter(interaction.channelId, { active: true, frequency: freq });
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('⏱️ Frequência Atualizada')
            .setDescription(`Frequência de fala espontânea definida para **${freq === 'high' ? 'Alta' : freq === 'medium' ? 'Média' : 'Baixa'}**.`);
        return interaction.update({ embeds: [embed], components: [] });
    }

    if (customId === 'srvcfg_updates_ch') {
        const channelId = interaction.values[0];
        setServerUpdateChannel(interaction.guildId, channelId);
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('📢 Canal de Updates Definido')
            .setDescription(`O canal <#${channelId}> foi configurado para receber avisos e novidades.`);
        return interaction.update({ embeds: [embed], components: [] });
    }

    if (customId === 'srvcfg_mencoes_on' || customId === 'srvcfg_mencoes_off') {
        const ativo = customId === 'srvcfg_mencoes_on';
        setServerEveryoneMention(interaction.guildId, ativo);
        const embed = new EmbedBuilder()
            .setColor(ativo ? 0x10B981 : 0xE11D48)
            .setTitle('🔔 Configuração de Menções Atualizada')
            .setDescription(`A Hikari irá ${ativo ? '✅ **responder**' : '❌ **ignorar**'} marcações de @everyone e @here neste servidor.`);
        return interaction.update({ embeds: [embed], components: [] });
    }
}

async function handleIaFerramentasCommand(interaction) {
    const hasPermission = !interaction.guild || (interaction.member && (
        interaction.member.permissions.has(PermissionFlagsBits.ManageGuild) ||
        interaction.member.permissions.has(PermissionFlagsBits.ManageChannels)
    )) || config.isOwner(interaction.user.id);

    if (!hasPermission) {
        const errEmbed = new EmbedBuilder()
            .setColor(0xE11D48)
            .setTitle('❌ Acesso Negado')
            .setDescription('Você precisa de permissão de **Gerenciar Servidor** ou **Gerenciar Canais** para usar este comando.');
        return interaction.reply({ embeds: [errEmbed], ephemeral: true });
    }

    const acao = interaction.options.getString('acao');
    const toolInput = interaction.options.getString('ferramenta') || '';
    const estado = interaction.options.getString('estado');
    const targetGuildId = interaction.guildId;

    if (!targetGuildId) {
        return interaction.reply({ content: '❌ Este comando só pode ser usado dentro de um servidor.', ephemeral: true });
    }

    if (acao === 'list') {
        const disabled = getDisabledTools(targetGuildId);
        const allTools = getAllMcpTools().filter(t => t.meta && t.meta.disableable && t.function.name !== 'leave_voice_call');

        const activeList = [];
        const disabledList = [];

        for (const t of allTools) {
            const isDis = disabled.includes(t.function.name);
            const label = t.function.name === 'join_voice_call' ? '🎙️ Assistente de Voz (Call)' : t.meta.label;
            if (isDis) {
                disabledList.push(`❌ **${label}** (\`${t.function.name}\`)`);
            } else {
                activeList.push(`✅ **${label}** (\`${t.function.name}\`)`);
            }
        }

        const embed = new EmbedBuilder()
            .setColor(0x7C3AED)
            .setTitle('🔧 Status das Ferramentas MCP — Servidor')
            .setDescription(`Configuração de ferramentas para o servidor **${interaction.guild?.name || targetGuildId}**`)
            .addFields(
                { name: '🟢 Ativas', value: activeList.length > 0 ? activeList.join('\n') : '*Nenhuma ferramenta ativa*', inline: false },
                { name: '🔴 Desativadas', value: disabledList.length > 0 ? disabledList.join('\n') : '*Nenhuma ferramenta desativada*', inline: false }
            )
            .setFooter({ text: 'Hikari MCP Manager • by yGuilhermy' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (acao === 'toggle') {
        if (!toolInput) {
            return interaction.reply({ content: '❌ Por favor, selecione a ferramenta que deseja alterar.', ephemeral: true });
        }

        const allTools = getAllMcpTools();
        let tool = allTools.find(t => t.function.name === toolInput || t.meta?.label === toolInput);
        if (!tool) tool = allTools.find(t => toolInput.includes(t.function.name) || toolInput.includes(t.meta?.label));

        if (!tool) {
            return interaction.reply({ content: `❌ Ferramenta \`${toolInput}\` não encontrada.`, ephemeral: true });
        }

        const disabled = getDisabledTools(targetGuildId);
        const currentlyDisabled = disabled.includes(tool.function.name);
        const enabled = estado ? estado === 'on' : currentlyDisabled;

        setServerToolEnabled(targetGuildId, tool.function.name, enabled);

        const embed = new EmbedBuilder()
            .setColor(enabled ? 0x10B981 : 0xE11D48)
            .setTitle(`Ferramenta ${enabled ? 'Ativada' : 'Desativada'}`)
            .addFields(
                { name: 'Ferramenta', value: tool.meta?.label || tool.function.name, inline: true },
                { name: 'Status no Servidor', value: enabled ? '🟢 Ativada' : '🔴 Desativada', inline: true }
            )
            .setFooter({ text: 'Hikari MCP Manager • by yGuilhermy' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }

    if (acao === 'reset') {
        resetServerTools(targetGuildId);
        const embed = new EmbedBuilder()
            .setColor(0x10B981)
            .setTitle('🔄 Ferramentas Resetadas')
            .setDescription(`Todas as ferramentas do servidor **${interaction.guild?.name || targetGuildId}** foram restauradas para os valores padrão.`)
            .setFooter({ text: 'Hikari MCP Manager • by yGuilhermy' })
            .setTimestamp();

        return interaction.reply({ embeds: [embed], ephemeral: true });
    }
}

module.exports = {
    handleServerAdminCommand,
    handleServerAdminInteraction,
    handleIaFerramentasCommand
};
