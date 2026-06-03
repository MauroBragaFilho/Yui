const fs = require('fs');
const path = require('path');
const config = require('../config');
const BANS_FILE = path.join(__dirname, '../data/bans.json');
if (!fs.existsSync(path.dirname(BANS_FILE))) {
    fs.mkdirSync(path.dirname(BANS_FILE), { recursive: true });
}
let bans = { users: {}, guilds: {}, channels: {}, autoblock: {} };
function loadBans() {
    if (fs.existsSync(BANS_FILE)) {
        try {
            bans = JSON.parse(fs.readFileSync(BANS_FILE, 'utf8'));
            if (!bans.autoblock) bans.autoblock = {};
        } catch (e) {
            console.error('Erro ao ler bans.json:', e);
            bans = { users: {}, guilds: {}, channels: {}, autoblock: {} };
        }
    }
}
loadBans();
function getAutoBlockMode(guildId) {
    if (!guildId) return 'off';
    const val = bans.autoblock[guildId];
    if (val === undefined) {
        return config.defaultAutoMod !== false ? (config.automodMode || 'both') : 'off';
    }
    if (val === true) return 'both';
    if (val === false) return 'off';
    if (['off', 'both', 'mcp', 'trigger'].includes(val)) return val;
    return 'off';
}
function getAutoBlock(guildId) {
    return getAutoBlockMode(guildId) !== 'off';
}
function setAutoBlock(guildId, val) {
    if (!guildId) return false;
    bans.autoblock[guildId] = val;
    saveBans();
    return true;
}
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
function saveBans() {
    fs.writeFileSync(BANS_FILE, JSON.stringify(bans, null, 2));
}
function checkBan(userId, guildId, channelId) {
    const sanitize = (r) => {
        if (!r) return null;
        if (r.includes('Identificado termo proibido no') && r.includes(':')) {
            return r.split(':')[0] + '.';
        }
        return r;
    };
    if (bans.users[userId]) return { type: 'user', typeName: 'Usuário', reason: sanitize(bans.users[userId].reason) };
    if (guildId && bans.guilds[guildId]) return { type: 'guild', typeName: 'Servidor', reason: sanitize(bans.guilds[guildId].reason) };
    if (channelId && bans.channels[channelId]) return { type: 'channel', typeName: 'Canal', reason: sanitize(bans.channels[channelId].reason) };
    return null;
}
function addBan(type, id, reason = "Violação dos Termos de Uso.") {
    const banInfo = { reason, timestamp: new Date().toISOString() };
    if (type === 'user') bans.users[id] = banInfo;
    else if (type === 'guild') bans.guilds[id] = banInfo;
    else if (type === 'channel') bans.channels[id] = banInfo;
    saveBans();
    return true;
}
function removeBan(type, id) {
    if (type === 'user') delete bans.users[id];
    else if (type === 'guild') delete bans.guilds[id];
    else if (type === 'channel') delete bans.channels[id];
    saveBans();
    return true;
}
const forbiddenKeywords = [
    'nsfw', 'porn', 'hentai', 'gore', 'sexo', 'puta', 'caralho', 'buceta', 'pinto', 'pênis', 'vagina', '18+', 'pornografia', 'pornô',
    'estupro', 'pedofilia', 'bestialidade', 'necrofilia', 'zoofilia', "porno", "pornhub", "redtube", "rule34", "r34", "lolicon", "shotacon",
    'suicídio', 'auto-mutilação', 'autoflagelação',
    'terrorismo', 'nazismo', 'hitler', 'suástica', 'extremismo', '1488',
    'xvideos', 'pornhub', 'redtube', 'rule34', 'r34', 'lolicon', 'shotacon',
    'foder', 'fodendo', 'foda-se', 'fodase', 'boquete', 'viado', 'traveco', 'punheta', 'orgia', 'suruba', 'nude', 'nudes', 'clitóris', 'ânus', 'felação',
    'masturbação', 'masturbar', 'ejaculação', 'sêmen',
    'arrombado', 'filho da puta', 'fdp',
    'cuzão', 'bicha',
    'boob', 'boobs', 'tits', 'fuck', 'bitch',
    'estuprar', 'estuprador',
    'pedófilo',
    'automutilação', 'suicidar',
    'homicídio', 'assassinato', 'decapitação', 'desmembramento', 'tortura', 'esquartejamento', 'assassinar',
    'fascismo', 'fascista', 'neonazista', 'neonazismo',
    'ku klux klan', 'swastika', 'white power'
];
function checkAutoBan(prompt, guildName, guildId, channelName, channelId, userId) {
    const lowerPrompt = (prompt || "").toLowerCase();
    const lowerGuild = (guildName || "").toLowerCase();
    const lowerChannel = (channelName || "").toLowerCase();
    const isForbidden = (text, checkType = 'prompt') => {
        if (!text) return null;
        return forbiddenKeywords.find(k => {
            if (checkType !== 'prompt') {
                return text.includes(k);
            }
            if (k.length <= 3 || k.includes('+') || k.includes('-')) {
                return text.includes(k);
            }
            const regex = new RegExp(`\\b${k}\\b`, 'i');
            return regex.test(text);
        });
    };
    const guildK = isForbidden(lowerGuild, 'guild');
    if (guildK && guildId) return { type: 'guild', id: guildId, keyword: guildK, reason: 'Identificado termo proibido no servidor.' };
    const channelK = isForbidden(lowerChannel, 'channel');
    if (channelK && channelId) return { type: 'channel', id: channelId, keyword: channelK, reason: 'Identificado termo proibido no canal.' };
    const promptK = isForbidden(lowerPrompt, 'prompt');
    if (promptK && userId) return { type: 'user', id: userId, keyword: promptK, reason: 'Identificado termo proibido no prompt.' };
    return null;
}
async function handleBanInteraction(interaction, client) {
    if (!interaction.isButton()) return;
    const cid = interaction.customId;
    if (cid.startsWith('appeal_ban_')) {
        const parts = cid.split('_');
        const type = parts[2];
        const targetId = parts[3];
        if (type === 'user') {
            if (interaction.user.id !== targetId) {
                return interaction.reply({ content: '❌ Apenas o usuário bloqueado pode enviar esta apelação.', ephemeral: true });
            }
        } else {
            const hasPerm = interaction.member?.permissions.has(PermissionFlagsBits.Administrator) ||
                            interaction.member?.permissions.has(PermissionFlagsBits.ManageGuild) ||
                            interaction.member?.permissions.has(PermissionFlagsBits.ManageChannels);
            if (!hasPerm) {
                return interaction.reply({ content: '❌ Apenas Administradores ou Moderadores podem solicitar apelação por bloqueios de servidor/canal.', ephemeral: true });
            }
        }
        await interaction.message.delete().catch(() => {});
        await interaction.reply({ content: '✅ Apelação enviada com sucesso para o canal de desenvolvedor. Aguarde a revisão.', ephemeral: true });
        const appealChannel = client.channels.cache.get(config.appealChannelId);
        if (appealChannel) {
            const embed = new EmbedBuilder()
                .setColor(0xF59E0B)
                .setTitle('⚖️ Novo Pedido de Appeal (Desbanimento)')
                .addFields(
                    { name: 'Tipo do Bloqueio', value: type.toUpperCase(), inline: true },
                    { name: 'ID Bloqueado', value: targetId, inline: true },
                    { name: 'Solicitante', value: `${interaction.user.tag} (${interaction.user.id})`, inline: false }
                )
                .setTimestamp();
            const row = new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`unban_${type}_${targetId}_${interaction.user.id}`)
                    .setLabel('✅ Desbanir')
                    .setStyle(ButtonStyle.Success),
                new ButtonBuilder()
                    .setCustomId(`keepban_${type}_${targetId}_${interaction.user.id}`)
                    .setLabel('❌ Manter Bloqueio')
                    .setStyle(ButtonStyle.Danger)
            );
            await appealChannel.send({
                content: `🔔 Um novo appeal requer atenção dos Administradores (<@${config.ownerId}> [\[Abrir Perfil\](https://discord.com/users/${config.ownerId})]).`,
                embeds: [embed],
                components: [row]
            });
        }
    } else if (cid.startsWith('unban_')) {
        if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Somente dono!', ephemeral: true });
        const parts = cid.split('_');
        const type = parts[1];
        const targetId = parts[2];
        const requestorId = parts[3];
        removeBan(type, targetId);
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0x10B981)
            .setTitle('✅ Apelação Aceita')
            .addFields({ name: 'Veredito', value: 'Bloqueio removido pelo Administrador.' });
        await interaction.update({ embeds: [embed], components: [] });
        try {
            const user = await client.users.fetch(requestorId);
            await user.send(`🎉 Sua apelação foi aceita! O bloqueio de \`${targetId}\` (${type}) foi removido da IA Hikari.`);
        } catch(e) {}
    } else if (cid.startsWith('keepban_')) {
        if (!config.isOwner(interaction.user.id)) return interaction.reply({ content: '❌ Somente dono!', ephemeral: true });
        const embed = EmbedBuilder.from(interaction.message.embeds[0])
            .setColor(0xE11D48)
            .setTitle('❌ Apelação Negada')
            .addFields({ name: 'Veredito', value: 'Bloqueio MANTIDO pelo Administrador.' });
        await interaction.update({ embeds: [embed], components: [] });
    }
}
module.exports = {
    checkBan,
    addBan,
    removeBan,
    getBans: () => bans,
    checkAutoBan,
    handleBanInteraction,
    getAutoBlock,
    getAutoBlockMode,
    setAutoBlock,
    forbiddenKeywords
};