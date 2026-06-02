const fs = require('fs');
const path = require('path');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

const ACCEPTED_FILE = path.join(__dirname, 'src/data/accepted_servers.json');
const SETTINGS_FILE = path.join(__dirname, 'src/data/server_settings.json');

if (!fs.existsSync(ACCEPTED_FILE) || !fs.existsSync(SETTINGS_FILE)) {
    console.error('Arquivos de dados nao encontrados.');
    process.exit(1);
}

const acceptedServers = JSON.parse(fs.readFileSync(ACCEPTED_FILE, 'utf8'));
const serverSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

const updateEmbed = new EmbedBuilder()
    .setColor(0x9B59B6)
    .setTitle('🚀 Nova Versão da Hikari Disponível!')
    .setDescription('Modificações da última atualização:\n\n- <placeholder :D >.')
    .setFooter({ text: 'Hikari Updates • by yGuilhermy' })
    .setTimestamp();

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`Script iniciado. Bot logado como ${client.user.tag}`);
    for (const server of acceptedServers) {
        const guildId = server.guildId;
        const guild = client.guilds.cache.get(guildId);
        if (!guild) {
            console.log(`Bot nao esta no servidor: ${server.guildName} (${guildId})`);
            continue;
        }

        const settings = serverSettings[guildId] || {};
        let targetChannelId = settings.updateChannelId;
        let channel = null;

        if (targetChannelId) {
            channel = guild.channels.cache.get(targetChannelId) || await guild.channels.fetch(targetChannelId).catch(() => null);
        }

        if (!channel) {
            const fallbackChannelId = settings.lastChannelId;
            if (fallbackChannelId) {
                channel = guild.channels.cache.get(fallbackChannelId) || await guild.channels.fetch(fallbackChannelId).catch(() => null);
            }
        }

        if (!channel) {
            channel = guild.systemChannel || guild.channels.cache.find(c =>
                c.isTextBased() &&
                c.permissionsFor(guild.client.user).has(PermissionFlagsBits.SendMessages)
            );
        }

        if (channel && channel.isTextBased()) {
            try {
                if (!settings.updateChannelId) {
                    if (!serverSettings[guildId]) serverSettings[guildId] = {};
                    serverSettings[guildId].updateChannelId = channel.id;
                    
                    const infoEmbed = new EmbedBuilder()
                        .setColor(0x9B59B6)
                        .setTitle('📢 Central de Updates Ativada!')
                        .setDescription('Olá! Apresentamos a nova função de avisos de atualizações da Hikari. Este canal foi configurado automaticamente como o canal de updates do servidor.\n\nA partir de agora, novas atualizações da Hikari serão enviadas aqui. Caso um administrador queira alterar este canal, utilize o comando:\n\`/chat_updates [canal]\`');
                    
                    await channel.send({ embeds: [infoEmbed] }).catch(() => {});
                }
                
                await channel.send({ embeds: [updateEmbed] });
                console.log(`Update enviado para ${guild.name} no canal #${channel.name}`);
            } catch (err) {
                console.error(`Erro ao enviar update para ${guild.name}:`, err.message);
            }
        } else {
            console.log(`Nao foi possivel encontrar um canal de texto valido para ${guild.name}`);
        }
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(serverSettings, null, 2));
    console.log('Script concluido. Configurações salvas.');
    client.destroy();
    process.exit(0);
});

client.login(config.discordToken);
