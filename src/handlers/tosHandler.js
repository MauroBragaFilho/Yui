const fs = require('fs');
const path = require('path');
const { checkAutoBan } = require('./banHandler');
const config = require('../config');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, AuditLogEvent, WebhookClient } = require('discord.js');
const TERMS_FILE = path.join(__dirname, '../data/accepted_servers.json');
if (!fs.existsSync(path.dirname(TERMS_FILE))) {
    fs.mkdirSync(path.dirname(TERMS_FILE), { recursive: true });
}
let acceptedServers = [];
function loadAcceptedServers() {
    if (fs.existsSync(TERMS_FILE)) {
        try {
            acceptedServers = JSON.parse(fs.readFileSync(TERMS_FILE, 'utf8'));
        } catch (e) {
            console.error('Erro ao ler accepted_servers.json:', e);
            acceptedServers = [];
        }
    }
}

function findGeneralChannel(guild) {
    if (!guild || !guild.channels) return null;
    const excludeKeywords = ['bem-vindo', 'welcome', 'regras', 'rules', 'logs', 'boas-vindas', 'entradas', 'saidas', 'punicoes', 'bans', 'staff', 'afk', 'poketwo', 'comandos', 'bot-commands', 'anuncios', 'avisos'];
    const keywords = ['geral', 'chat', 'bate-papo', 'bate_papo', 'batepapo', 'conversa', 'conversas', 'general', 'main', 'lounge', 'resenha', 'principal', 'chatzinho', 'comunidade', 'papo',];

    const channels = Array.from(guild.channels.cache.values()).filter(c =>
        c.isTextBased() &&
        c.permissionsFor(guild.client.user)?.has(PermissionFlagsBits.SendMessages) &&
        !excludeKeywords.some(ex => c.name.toLowerCase().includes(ex))
    );
    if (channels.length === 0) return null;

    for (const kw of keywords) {
        const found = channels.find(c => c.name.toLowerCase().includes(kw));
        if (found) return found;
    }

    if (guild.systemChannel && guild.systemChannel.permissionsFor(guild.client.user)?.has(PermissionFlagsBits.SendMessages)) {
        if (!excludeKeywords.some(ex => guild.systemChannel.name.toLowerCase().includes(ex))) {
            return guild.systemChannel;
        }
    }

    return channels[0] || null;
}
loadAcceptedServers();
function isServerAccepted(guildId) {
    if (!config.requireTos) return true;
    if (!guildId) return true;
    return acceptedServers.some(s => s.guildId === guildId);
}
const commandBuffer = new Map();
function saveAcceptedServer(guildName, guildId, ownerId, userId) {
    const entry = {
        guildName,
        guildId,
        ownerId,
        authorizedBy: userId,
        timestamp: new Date().toISOString()
    };
    acceptedServers.push(entry);
    fs.writeFileSync(TERMS_FILE, JSON.stringify(acceptedServers, null, 2));
}
function getBufferedCommand(guildId) {
    return commandBuffer.get(guildId);
}
function clearBufferedCommand(guildId) {
    commandBuffer.delete(guildId);
}
async function sendTermsOfService(target, requestData = null) {
    const guild = target.guild;
    const guildId = target.guildId || (target.guild ? target.guild.id : null);
    if (!guild || !guildId) return;
    if (requestData && !commandBuffer.has(guildId)) {
        commandBuffer.set(guildId, {
            prompt: requestData.prompt,
            interaction: requestData.interaction || requestData.message,
            type: requestData.type,
            options: requestData.options,
            userTag: requestData.userTag
        });
        console.log(`[TOS] Comando de ${requestData.userTag} buffered para o servidor ${guild.name}.`);
    }
    const now = Date.now();
    const diffDays = (now - (guild.joinedTimestamp || now)) / (1000 * 60 * 60 * 24);
    const isLegacy = diffDays >= 7;
    const helpDataPath = path.join(__dirname, '../data/help.json');
    let rulesText = "O servidor precisa aceitar as Regras & Termos de Uso da Hikari para continuar.";
    if (fs.existsSync(helpDataPath)) {
        try {
            const helpData = JSON.parse(fs.readFileSync(helpDataPath, 'utf8'));
            const rulesObj = helpData.find(i => i.id === 'regras');
            if (rulesObj) rulesText = rulesObj.answer;
        } catch (err) {
            console.error('[TOS] Erro ao ler regras do help.json:', err.message);
        }
    }
    const legacyNotice = isLegacy
        ? "⚠️ **Aviso de Atualização:** Identificamos que a Hikari já faz parte deste servidor há algum tempo. Implementamos novas diretrizes de segurança e privacidade. **Para continuar utilizando os serviços da Hikari, é obrigatório que a administração aceite os termos abaixo.**\n\n"
        : "";
    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('⚖️ Termos de Uso e Responsabilidade — Hikari')
        .setDescription(legacyNotice + rulesText + "\n\n**Para continuar usando a Hikari neste servidor, um Administrador ou Gerente deve aceitar os termos abaixo.**")
        .setFooter({ text: 'Lembre-se de usar o "/ajuda" para ver todos os comandos! • by yGuilhermy' })
        .setTimestamp();
    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tos_accept')
            .setLabel('Aceitar Termos')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId('tos_decline')
            .setLabel('Recusar e sair')
            .setStyle(ButtonStyle.Danger),
        new ButtonBuilder()
            .setLabel('Página do Projeto')
            .setURL('https://github.com/yGuilhermy/Hikari')
            .setStyle(ButtonStyle.Link)
    );
    try {
        if (target.deferred || target.replied) {
            await target.editReply({ content: null, embeds: [embed], components: [row] });
        } else if (typeof target.reply === 'function') {
            await target.reply({ embeds: [embed], components: [row], failIfNotExists: false });
        }
    } catch (err) {
        console.error('[TOS] Erro ao enviar mensagem de ToS:', err.message);
    }
}
async function handleTosInteraction(interaction) {
    if (!interaction.isButton()) return;
    if (interaction.customId !== 'tos_accept' && interaction.customId !== 'tos_decline') return;
    try {
        console.log(`[TOS-DEBUG] Iniciando interação: ${interaction.customId} | Usuário: ${interaction.user.tag} | Guild: ${interaction.guild?.name || 'N/A'}`);
        const { PermissionFlagsBits } = require('discord.js');
        await interaction.deferUpdate().catch(e => {
            console.error('[TOS-DEBUG] Falha ao dar deferUpdate:', e.message);
        });
        console.log('[TOS-DEBUG] deferUpdate concluído.');
        const isOwner = interaction.guild && interaction.user.id === interaction.guild.ownerId;
        const hasPermission = isOwner || (interaction.memberPermissions && (
            interaction.memberPermissions.has(PermissionFlagsBits.Administrator) ||
            interaction.memberPermissions.has(PermissionFlagsBits.ManageGuild) ||
            interaction.memberPermissions.has(PermissionFlagsBits.ManageChannels)
        ));
        console.log(`[TOS-DEBUG] Permissões: Owner=${isOwner}, Admin/Manage=${!!hasPermission}`);
        if (!hasPermission) {
            console.warn(`[TOS-DEBUG] Usuário ${interaction.user.tag} não tem permissão para ToS.`);
            return interaction.followUp({
                content: '❌ Apenas usuários com permissão de **Administrador**, **Gerenciar Servidor** ou **Gerenciar Canais** podem aceitar estes termos.',
                ephemeral: true
            }).catch(e => console.error('[TOS-DEBUG] Erro no followUp de permissão:', e.message));
        }
        if (interaction.customId === 'tos_accept') {
            const guild = interaction.guild;
            console.log('[TOS-DEBUG] Salvando aceitação síncrona...');
            saveAcceptedServer(guild.name, guild.id, guild.ownerId, interaction.user.id);
            console.log('[TOS-DEBUG] Salvo com sucesso.');
            const { setServerUpdateChannel, getServerSettings } = require('./llmHandler');
            const settings = getServerSettings(guild.id);
            let targetUpdateChannel = null;
            if (settings && settings.updateChannelId) {
                targetUpdateChannel = guild.channels.cache.get(settings.updateChannelId);
            }
            if (!targetUpdateChannel) {
                targetUpdateChannel = findGeneralChannel(guild) || interaction.channel;
                setServerUpdateChannel(guild.id, targetUpdateChannel.id);
            }
            await interaction.editReply({
                content: `✅ **Termos de Uso aceitos por <@${interaction.user.id}>!** A Hikari agora está liberada para este servidor. ✨`,
                embeds: [],
                components: []
            }).catch(err => console.error('[TOS-DEBUG] Erro no editReply (Accept):', err.message));
            const updatesEmbed = new EmbedBuilder()
                .setColor(0x7C3AED)
                .setTitle('📢 Central de Updates Configurada')
                .setDescription(`O canal <#${targetUpdateChannel.id}> foi registrado para receber as novidades e atualizações da Hikari.\n\nCaso um administrador queira alterar este canal, utilize o comando:\n\`/chat_updates [canal]\``);
            await targetUpdateChannel.send({ embeds: [updatesEmbed] }).catch(() => {});
            console.log(`[TOS-DEBUG] Servidor ${guild.id} aceitou.`);
            const buffered = getBufferedCommand(guild.id);
            if (buffered) {
                console.log(`[TOS-DEBUG] Re-executando comando bufferizado para ${guild.name}...`);
                const { addToQueue } = require('./llmHandler');
                clearBufferedCommand(guild.id);
                addToQueue(buffered.prompt, buffered.interaction, buffered.type, buffered.options);
                console.log('[TOS-DEBUG] Comando re-enviado para a fila.');
            }
        } else {
            console.log('[TOS-DEBUG] Iniciando recusa (Guild Leave)...');
            await interaction.editReply({
                content: '❌ Os termos foram recusados. Saindo do servidor...',
                embeds: [],
                components: []
            }).catch(err => console.error('[TOS-DEBUG] Erro no editReply (Decline):', err.message));
            setTimeout(() => {
                if (interaction.guild) {
                    interaction.guild.leave().catch(e => console.error('[TOS-DEBUG] Erro ao sair da Guild:', e.message));
                }
            }, 3000);
        }
    } catch (err) {
        console.error('[TOS-CRITICAL] Erro fatal em handleTosInteraction:', err);
    }
}
async function reportNewGuild(guild) {
    if (!guild) return;
    const logWebhookUrl = config.avisosWebhookUrl;
    if (logWebhookUrl) {
        try {
            const webhook = new WebhookClient({ url: logWebhookUrl });
            let ownerTag = 'Desconhecido';
            try {
                const owner = await guild.fetchOwner();
                ownerTag = owner.user.tag;
            } catch (e) {}
            let addedByTag = 'Indisponível';
            try {
                const auditLogs = await guild.fetchAuditLogs({ limit: 1, type: AuditLogEvent.BotAdd });
                const entry = auditLogs.entries.first();
                if (entry) {
                    addedByTag = `${entry.executor.tag} (\`${entry.executor.id}\`)`;
                }
            } catch (e) {}
            const autoBanTrigger = checkAutoBan(null, guild.name, guild.id, null, null, null);
            const logEmbed = new EmbedBuilder()
                .setColor(autoBanTrigger ? 0xF59E0B : 0x10B981)
                .setTitle(autoBanTrigger ? '⚠️ Hikari Adicionada (Nome Suspeito)' : '📥 Hikari Adicionada a um Novo Servidor')
                .setThumbnail(guild.iconURL())
                .addFields(
                    { name: 'Nome do Servidor', value: `**${guild.name}**`, inline: true },
                    { name: 'ID do Servidor', value: `\`${guild.id}\``, inline: true },
                    { name: 'Membros', value: `${guild.memberCount}`, inline: true },
                    { name: 'Dono', value: `${ownerTag} (<@${guild.ownerId}>)`, inline: false },
                    { name: 'Adicionada por', value: `${addedByTag}`, inline: false }
                );
            if (autoBanTrigger) {
                logEmbed.addFields({ name: '🚨 Alerta de Termo', value: `O nome do servidor contém o termo proibido: \`${autoBanTrigger.keyword}\``, inline: false });
            }
            logEmbed.addFields({ name: 'Criado em', value: `<t:${Math.floor(guild.createdTimestamp / 1000)}:R>`, inline: true })
                .setFooter({ text: `Total de Servidores: ${guild.client.guilds.cache.size} • by yGuilhermy` })
                .setTimestamp();
            
            const mngRow = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`adm_manageguild_confirm_${guild.id}`)
                    .setLabel('Confirmar (Ignorar)')
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId(`adm_manageguild_leave_${guild.id}`)
                    .setLabel('Remover Bot do Servidor')
                    .setStyle(ButtonStyle.Danger)
            );
            
            await webhook.send({ embeds: [logEmbed], components: [mngRow] });
        } catch (err) {
            console.error('[REPORT] Erro ao enviar log de nova guild:', err.message);
        }
    }
    const targetChannel = guild.systemChannel || guild.channels.cache.find(c =>
        c.isTextBased() &&
        c.permissionsFor(guild.client.user).has(PermissionFlagsBits.SendMessages)
    );
    if (targetChannel && config.requireTos) {
        try {
                    const helpDataPath = path.join(__dirname, '../data/help.json');
            let rulesText = "O servidor precisa aceitar as Regras & Termos de Uso da Hikari para continuar utilizando os serviços de IA.";
            if (fs.existsSync(helpDataPath)) {
                try {
                    const helpData = JSON.parse(fs.readFileSync(helpDataPath, 'utf8'));
                    const rulesObj = helpData.find(i => i.id === 'regras');
                    if (rulesObj) rulesText = rulesObj.answer;
                } catch (e) {}
            }
            const welcomeEmbed = new EmbedBuilder()
                .setColor(0x7C3AED)
                .setTitle('👋 Olá! Obrigada por me adicionar!')
                .setDescription(`
Olá! Eu sou a **Hikari**, sua assistente de IA multifuncional. ✨
Para que eu possa começar a funcionar neste servidor, **é necessário que um Administrador aceite meus Termos de Uso**. Isso garante que todos estejam cientes das diretrizes de segurança e privacidade.
**Regras & Termos:**
${rulesText}
**Como proceder?**
Basta clicar no botão **"Aceitar Termos"** abaixo. Somente usuários com permissão de Administrador ou Gerenciar Servidor podem realizar esta ação.
`)
                .setFooter({ text: 'Ao aceitar, os dados de ativação serão salvos para fins de transparência. • by yGuilhermy' })
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId('tos_accept')
                    .setLabel('Aceitar Termos')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId('tos_decline')
                    .setLabel('Recusar e Sair')
                    .setStyle(ButtonStyle.Danger),
                new ButtonBuilder()
                    .setLabel('Pagina do Projeto')
                    .setURL('https://github.com/yGuilhermy/Hikari')
                    .setStyle(ButtonStyle.Link)
                    .setEmoji('📂')
            );
            await targetChannel.send({ embeds: [welcomeEmbed], components: [row] });
        } catch (err) {
            console.error(`[REPORT] Erro ao enviar boas-vindas na guild ${guild.id}:`, err.message);
        }
    }
}
async function checkAndInitializeUpdateChannel(guild, channel) {
    if (!guild) return;
    if (!isServerAccepted(guild.id)) return;
    const { getServerSettings, setServerUpdateChannel } = require('./llmHandler');
    const settings = getServerSettings(guild.id);
    if (!settings.updateChannelId) {
        const target = findGeneralChannel(guild) || channel;
        if (target && target.id) {
            setServerUpdateChannel(guild.id, target.id);
        }
    }
}
module.exports = {
    isServerAccepted,
    sendTermsOfService,
    handleTosInteraction,
    reportNewGuild,
    checkAndInitializeUpdateChannel
};