import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { checkAutoBan } from './banHandler.js';
import config from '../config.js';
import { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, AuditLogEvent, WebhookClient } from 'discord.js';
const TERMS_FILE = path.join(__dirname, '../data/accepted_servers.json');
if (!fs.existsSync(path.dirname(TERMS_FILE))) {
    fs.mkdirSync(path.dirname(TERMS_FILE), { recursive: true });
}
let acceptedServers = [];
function loadAcceptedServers() {
    if (fs.existsSync(TERMS_FILE)) {
        try {
            const raw = JSON.parse(fs.readFileSync(TERMS_FILE, 'utf8'));
            if (Array.isArray(raw)) {
                const map = new Map();
                for (const item of raw) {
                    if (item && item.guildId) {
                        map.set(item.guildId, item);
                    }
                }
                acceptedServers = Array.from(map.values());
            } else {
                acceptedServers = [];
            }
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
function saveAcceptedServer(guildName, guildId, ownerId, userId) {
    const existingIndex = acceptedServers.findIndex(s => s.guildId === guildId);
    const entry = {
        guildName,
        guildId,
        ownerId,
        authorizedBy: userId,
        timestamp: new Date().toISOString()
    };
    if (existingIndex !== -1) {
        acceptedServers[existingIndex] = entry;
    } else {
        acceptedServers.push(entry);
    }
    fs.writeFileSync(TERMS_FILE, JSON.stringify(acceptedServers, null, 2));
}

function removeAcceptedServer(guildId) {
    if (!guildId) return;
    const initialLen = acceptedServers.length;
    acceptedServers = acceptedServers.filter(s => s.guildId !== guildId);
    if (acceptedServers.length !== initialLen) {
        fs.writeFileSync(TERMS_FILE, JSON.stringify(acceptedServers, null, 2));
    }
}
const DEFAULT_TOS_PAGES = [
    {
        title: '🛡️ Categoria 1/5 • Moderação Automática (AutoMod)',
        content: `### 🛡️ 1. O SISTEMA AUTOMOD (MODERAÇÃO AUTOMÁTICA)\nA Yui possui um dos sistemas de segurança mais severos e avançados do Discord. Esse sistema monitora todas as interações no chat e em chamadas de voz através de dois mecanismos integrados e simultâneos:\n\n1️⃣ **FILTRO DE GATILHOS RÁPIDOS (Keyword Trigger):**\nQualquer mensagem ou comando que contenha termos explícitos altamente proibidos causará um bloqueio automático imediato.\n* *Exemplos de gatilhos:* Apologia a crimes graves, termos relacionados a automutilação, terrorismo, racismo/discurso de ódio extremo, ou tentativas de gerar pornografia/NSFW.\n* *Nota:* O sistema filtra de forma inteligente para evitar falsos positivos comuns, mas termos graves geram punições instantâneas.\n\n2️⃣ **ANÁLISE COGNITIVA DA IA (AI AutoMod MCP):**\nMesmo que você não use palavras ofensivas explícitas, a inteligência artificial analisa o **contexto** e a **intenção** da conversa.\n* **Intenção Maliciosa / Jailbreak:** Tentativas sutis de fazer a IA contornar suas diretrizes de segurança, gerar conteúdo impróprio disfarçado ou ensinar a cometer atos ilícitos.\n* **Abuso, Xingamentos e Toxicidade à IA:** A Yui não aceita abusos verbais. Insultos direcionados ao bot, assédio moral, xingamentos constantes ou comportamento tóxico forçado acionarão a moderação. A IA identificará o ataque ao seu próprio sistema e usará a ferramenta de banimento de forma autônoma.`
    },
    {
        title: '🎙️ Categoria 2/5 • Segurança em Calls de Voz',
        content: `### 🎙️ 2. REGRAS E SEGURANÇA EM CANAIS DE VOZ (CALLS)\nO uso do Assistente de Voz (\`/entrar-call\`) está sujeito às mesmas diretrizes de segurança de texto:\n* **Transcrição e Monitoramento:** Todo áudio direcionado à Yui ao falar o gatilho ('Yui...') é transcrito e processado pelo sistema de AutoMod. Xingamentos, assédio por voz, ofensas ou tentativas de burlar filtros por áudio acarretam **BANIMENTO GLOBAL IMEDIATO**.\n* **Restrição Absoluta de Acesso:** Usuários, servidores ou canais com banimentos ativos estão estritamente proibidos de chamar a Yui para chamadas de voz. O sistema de voz rejeita o comando \`/entrar-call\` e ignora 100% de qualquer sinal de voz originado de perfis banidos.`
    },
    {
        title: '🚨 Categoria 3/5 • Diretrizes de Conteúdo',
        content: `### 🚨 3. DIRETRIZES DE CONTEÚDO (PROIBIÇÕES CRÍTICAS)\nÉ expressamente proibido utilizar qualquer recurso da Yui (texto ou voz) para fins de:\n* **NSFW & Pornografia:** Criação ou solicitação de descrições, contos ou imagens de cunho sexual.\n* **Violência & Ódio:** Promoção de discurso de ódio contra minorias, preconceito religioso, de gênero, sexual ou apologia à violência física real/tortura.\n* **Ataque e Ofensa ao Bot:** O usuário que abusar verbalmente da Yui com palavras chulas ou xingamentos tóxicos (em texto ou voz) será **permanentemente bloqueado** e a IA o ignorará de forma absoluta.\n* **Exploração & Spam:** Floodar comandos, tentar derrubar os servidores de IA ou sobrecarregar a fila global.`
    },
    {
        title: '🛑 Categoria 4/5 • Funcionamento do Banimento',
        content: `### 🛑 4. COMO FUNCIONA O BANIMENTO\nQuando um banimento é aplicado (seja por palavra gatilho ou decisão autônoma da IA):\n1. **Bloqueio Global de Perfil:** O ID do seu usuário é banido globalmente. A Yui passará a ignorar todas as suas interações, áudios de voz, marcações ou comandos em qualquer servidor onde ela esteja presente.\n2. **Notificação de Segurança:** Um alerta detalhado com a violação e a conversa correspondente é enviado ao canal central de auditoria dos administradores.\n3. **Bloqueio de Canal/Servidor:** Em casos graves onde a administração de um servidor permita abusos sistemáticos coletivos, o servidor inteiro pode ser banido da rede Yui.`
    },
    {
        title: '⚖️ Categoria 5/5 • Apelações & Recursos',
        content: `### ⚖️ 5. APELAÇÕES & RECURSOS\nSe você acredita que o seu banimento foi injusto ou decorreu de um mal-entendido técnico da IA:\n* Você poderá submeter uma apelação clicando no botão **'Solicitar Apelação'** gerado na mensagem do banimento.\n* Sua apelação será avaliada manualmente pelo criador/desenvolvedor da Yui.\n* *Importante:* Mentir na apelação ou tentar burlar o bloqueio através de contas secundárias resultará na rejeição imediata de qualquer recurso.`
    }
];

function getTosPages() {
    return DEFAULT_TOS_PAGES;
}

function buildTosPagePayload(pageIndex = 0, maxVisited = 0, isLegacy = false) {
    const pages = getTosPages();
    const totalPages = pages.length;
    const safePageIndex = Math.max(0, Math.min(pageIndex, totalPages - 1));
    const safeMaxVisited = Math.max(maxVisited, safePageIndex);
    const currentPage = pages[safePageIndex];
    const isFullyUnlocked = safeMaxVisited >= totalPages - 1;

    let description = "";
    if (safePageIndex === 0 && isLegacy) {
        description += "⚠️ **Aviso de Atualização:** Identificamos que a Yui já faz parte deste servidor há algum tempo. Implementamos novas diretrizes de segurança e privacidade. **Para continuar utilizando os serviços da Yui, é obrigatório que a administração aceite os termos abaixo.**\n\n";
    }

    description += currentPage.content;

    description += "\n\n" + (isFullyUnlocked
        ? "✅ **Você leu todas as categorias dos Termos!** O botão **Aceitar Termos** está liberado abaixo."
        : `📌 *Página ${safePageIndex + 1} de ${totalPages} • Passe por todas as categorias com o botão "Próximo ➡️" para liberar a aceitação.*`);

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle(`⚖️ Termos de Uso — ${currentPage.title}`)
        .setDescription(description)
        .setFooter({ text: `Página ${safePageIndex + 1} de ${totalPages} • Yui ToS • by yGuilhermy` })
        .setTimestamp();

    const legFlag = isLegacy ? '1' : '0';
    const prevIndex = safePageIndex - 1;
    const nextIndex = safePageIndex + 1;

    const rowNav = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`tos_nav_${prevIndex}_${safeMaxVisited}_${legFlag}`)
            .setLabel('⬅️ Voltar')
            .setStyle(ButtonStyle.Secondary)
            .setDisabled(safePageIndex === 0),
        new ButtonBuilder()
            .setCustomId(`tos_nav_${nextIndex}_${Math.max(safeMaxVisited, nextIndex)}_${legFlag}`)
            .setLabel('Próximo ➡️')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(safePageIndex === totalPages - 1),
        new ButtonBuilder()
            .setLabel('Página do Projeto')
            .setURL('https://github.com/yGuilhermy/Yui')
            .setStyle(ButtonStyle.Link)
            .setEmoji('📂')
    );

    const rowActions = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('tos_accept')
            .setLabel('Aceitar Termos')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!isFullyUnlocked)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId('tos_decline')
            .setLabel('Recusar e Sair')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('❌'),
        new ButtonBuilder()
            .setLabel('Apoiar desenvolvimento')
            .setURL('https://bio.site/yGuilhermy')
            .setStyle(ButtonStyle.Link)
            .setEmoji('💖')
    );

    return {
        embeds: [embed],
        components: [rowNav, rowActions]
    };
}

async function sendTermsOfService(target) {
    const guild = target.guild;
    const guildId = target.guildId || (target.guild ? target.guild.id : null);
    if (!guild || !guildId) return;
    const now = Date.now();
    const diffDays = (now - (guild.joinedTimestamp || now)) / (1000 * 60 * 60 * 24);
    const isLegacy = diffDays >= 7;

    const payload = buildTosPagePayload(0, 0, isLegacy);
    try {
        if (target.deferred || target.replied) {
            await target.editReply({ content: null, ...payload });
        } else if (typeof target.reply === 'function') {
            await target.reply({ ...payload, failIfNotExists: false });
        }
    } catch (err) {
        console.error('[TOS] Erro ao enviar mensagem de ToS:', err.message);
    }
}

async function handleTosInteraction(interaction) {
    if (!interaction.isButton()) return;
    if (interaction.customId.startsWith('tos_nav_')) {
        const parts = interaction.customId.split('_');
        const targetPageIndex = parseInt(parts[2], 10) || 0;
        const maxVisited = parseInt(parts[3], 10) || 0;
        const isLegacy = parts[4] === '1';

        const newMaxVisited = Math.max(maxVisited, targetPageIndex);
        const payload = buildTosPagePayload(targetPageIndex, newMaxVisited, isLegacy);

        await interaction.update(payload).catch(e => {
            console.error('[TOS] Erro ao atualizar página do TOS:', e.message);
        });
        return;
    }
    if (interaction.customId !== 'tos_accept' && interaction.customId !== 'tos_decline') return;
    try {
        console.log(`[TOS-DEBUG] Iniciando interação: ${interaction.customId} | Usuário: ${interaction.user.tag} | Guild: ${interaction.guild?.name || 'N/A'}`);
        const { PermissionFlagsBits } = await import('discord.js');
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
            const { setServerUpdateChannel, getServerSettings } = await import('./llmHandler.js');
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
                content: `✅ **Termos de Uso aceitos por <@${interaction.user.id}>!** A Yui agora está liberada para este servidor. ✨`,
                embeds: [],
                components: []
            }).catch(err => console.error('[TOS-DEBUG] Erro no editReply (Accept):', err.message));
            const updatesEmbed = new EmbedBuilder()
                .setColor(0x7C3AED)
                .setTitle('📢 Central de Updates Configurada')
                .setDescription(`O canal <#${targetUpdateChannel.id}> foi registrado para receber as novidades e atualizações da Yui.\n\nCaso um administrador queira alterar este canal, utilize o comando:\n\`/chat_updates [canal]\``);
            await targetUpdateChannel.send({ embeds: [updatesEmbed] }).catch(() => {});
            console.log(`[TOS-DEBUG] Servidor ${guild.id} aceitou.`);
        } else {
            if (interaction.guild) {
                removeAcceptedServer(interaction.guild.id);
            }
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
                .setTitle(autoBanTrigger ? '⚠️ Yui Adicionada (Nome Suspeito)' : '📥 Yui Adicionada a um Novo Servidor')
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
            const payload = buildTosPagePayload(0, 0, false);
            await targetChannel.send({ content: '👋 Olá! Obrigada por me adicionar! Por favor, leia os Termos de Uso abaixo:', ...payload });
        } catch (err) {
            console.error(`[REPORT] Erro ao enviar boas-vindas na guild ${guild.id}:`, err.message);
        }
    }
}
async function checkAndInitializeUpdateChannel(guild, channel) {
    if (!guild) return;
    if (!isServerAccepted(guild.id)) return;
    const { getServerSettings, setServerUpdateChannel } = await import('./llmHandler.js');
    const settings = getServerSettings(guild.id);
    if (!settings.updateChannelId) {
        const target = findGeneralChannel(guild) || channel;
        if (target && target.id) {
            setServerUpdateChannel(guild.id, target.id);
        }
    }
}
export { getTosPages, reportNewGuild, removeAcceptedServer, isServerAccepted, sendTermsOfService, handleTosInteraction, checkAndInitializeUpdateChannel };

export default {
    isServerAccepted,
    sendTermsOfService,
    handleTosInteraction,
    reportNewGuild,
    checkAndInitializeUpdateChannel,
    removeAcceptedServer,
    getTosPages
};
