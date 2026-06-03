const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { Client, GatewayIntentBits, EmbedBuilder, PermissionFlagsBits } = require('discord.js');
const config = require('../config');

const ACCEPTED_FILE = path.join(__dirname, '../data/accepted_servers.json');
const SETTINGS_FILE = path.join(__dirname, '../data/server_settings.json');

if (!fs.existsSync(ACCEPTED_FILE) || !fs.existsSync(SETTINGS_FILE)) {
    console.error('Arquivos de dados nao encontrados.');
    process.exit(1);
}

const acceptedServers = JSON.parse(fs.readFileSync(ACCEPTED_FILE, 'utf8'));
const serverSettings = JSON.parse(fs.readFileSync(SETTINGS_FILE, 'utf8'));

const updateEmbed = new EmbedBuilder()
    .setColor(0x7C3AED)
    .setTitle('🚀 Novo update da Hikari - Novas Features!')
    .setDescription('Modificações da última atualização:\n\n Placeholder aqui ó')
    .setFooter({ text: 'Hikari Updates • by yGuilhermy' })
    .setTimestamp();

function askQuestion(query) {
    const rl = readline.createInterface({
        input: process.stdin,
        output: process.stdout,
    });
    return new Promise(resolve => rl.question(query, ans => {
        rl.close();
        resolve(ans);
    }));
}

const client = new Client({ intents: [GatewayIntentBits.Guilds] });

client.once('ready', async () => {
    console.log(`Script iniciado. Bot logado como ${client.user.tag}`);
    const targets = [];

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
            const isFirstTime = !targetChannelId;
            targets.push({ guild, channel, settings, guildId, isFirstTime });
        } else {
            console.log(`Nao foi possivel encontrar um canal de texto valido para ${guild.name}`);
        }
    }

    if (targets.length === 0) {
        console.log('Nenhum canal de destino encontrado.');
        client.destroy();
        process.exit(0);
    }

    console.log('\n--- Canais de destino mapeados ---');
    targets.forEach(t => {
        const tag = t.isFirstTime ? ' (Primeira Configuração / Inicial)' : '';
        console.log(`- Servidor: ${t.guild.name} (ID: ${t.guild.id}) | Canal: #${t.channel.name} (ID: ${t.channel.id})${tag}`);
    });
    console.log('----------------------------------\n');

    const ans1 = await askQuestion('Deseja prosseguir com o envio para esses canais? (s/n): ');
    if (ans1.toLowerCase() !== 's' && ans1.toLowerCase() !== 'sim') {
        console.log('Operação cancelada.');
        client.destroy();
        process.exit(0);
    }

    console.log('\n--- Mensagem a ser enviada (Embed) ---');
    console.log(`Título: ${updateEmbed.data.title}`);
    console.log(`Descrição:\n${updateEmbed.data.description}`);
    console.log('--------------------------------------\n');

    const ans2 = await askQuestion('Confirmar envio da mensagem? (s/n): ');
    if (ans2.toLowerCase() !== 's' && ans2.toLowerCase() !== 'sim') {
        console.log('Operação cancelada.');
        client.destroy();
        process.exit(0);
    }

    console.log('\nIniciando envio...');
    for (const target of targets) {
        try {
            if (target.isFirstTime) {
                if (!serverSettings[target.guildId]) serverSettings[target.guildId] = {};
                serverSettings[target.guildId].updateChannelId = target.channel.id;
                
                const infoEmbed = new EmbedBuilder()
                    .setColor(0x7C3AED)
                    .setTitle('📢 Central de Updates Ativada!')
                    .setDescription('Olá! Apresentamos a nova função de avisos de atualizações da Hikari. Este canal foi configurado automaticamente como o canal de updates do servidor.\n\nA partir de agora, novas atualizações da Hikari serão enviadas aqui. Caso um administrador queira alterar este canal, utilize o comando:\n\`/chat_updates [canal]\`');
                
                await target.channel.send({ embeds: [infoEmbed] }).catch(() => {});
            }
            
            await target.channel.send({ embeds: [updateEmbed] });
            console.log(`Update enviado para ${target.guild.name} no canal #${target.channel.name}`);
        } catch (err) {
            console.error(`Erro ao enviar update para ${target.guild.name}:`, err.message);
        }
    }

    fs.writeFileSync(SETTINGS_FILE, JSON.stringify(serverSettings, null, 2));
    console.log('Script concluido. Configurações salvas.');
    client.destroy();
    process.exit(0);
});

client.login(config.discordToken);
