import { ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, AttachmentBuilder, EmbedBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));

const SOURCES = [
    { name: 'FitGirl', url: path.join(__dirname, '../data/fitgirl.json'), emoji: '💃' },
    { name: 'DODI', url: path.join(__dirname, '../data/dodi.json'), emoji: '🦆' },
    { name: 'Online Fix', url: path.join(__dirname, '../data/onlinefix.json'), emoji: '🦆' }
];

const aliases = {
    'gta v': 'grand theft auto v',
    'gta 5': 'grand theft auto v',
    'rdr2': 'red dead redemption 2',
    'rdr 2': 'red dead redemption 2',
    'cod': 'call of duty'
};

function normalizeString(str) {
    if (!str) return '';
    return str
        .normalize('NFD')
        .replace(/[\u0300-\u036f]/g, '')
        .toLowerCase()
        .replace(/[:\-\/\(\)\[\]\?!.,]/g, ' ')
        .replace(/\s+/g, ' ')
        .trim();
}

function cleanMagnet(magnetLink) {
    try {
        const urlParams = new URLSearchParams(magnetLink.replace('magnet:?', ''));
        const hash = urlParams.get('xt');
        if (hash) return { magnet: `magnet:?xt=${hash}`, hash: hash.replace('urn:btih:', '') };
        return { magnet: magnetLink, hash: null };
    } catch (e) {
        return { magnet: magnetLink, hash: null };
    }
}

async function fetchTorrentFile(hash) {
    if (!hash) return null;
    try {
        const url = `https://itorrents.org/torrent/${hash}.torrent`;
        const response = await axios.get(url, { responseType: 'arraybuffer', timeout: 3000 });
        return response.data;
    } catch (error) {
        return null;
    }
}

async function searchGames(gameName, provider = 'any') {
    let fitgirlMatches = [];
    let dodiMatches = [];
    let onlineFixMatches = [];
    
    let query = normalizeString(gameName);
    for (const [key, value] of Object.entries(aliases)) {
        const regex = new RegExp(`\\b${key}\\b`, 'g');
        query = query.replace(regex, value);
    }
    
    const searchWords = query.split(' ').filter(w => w.length > 0);
    if (searchWords.length === 0) return [];

    const activeSources = SOURCES.filter(s => {
        if (!provider || provider === 'any') return true;
        return s.name.toLowerCase() === provider.toLowerCase();
    });

    await Promise.all(activeSources.map(async (source) => {
        try {
            let data;
            if (source.url.startsWith('http')) {
                const response = await axios.get(source.url);
                data = response.data;
            } else {
                const filePath = path.isAbsolute(source.url) ? source.url : path.join(process.cwd(), source.url);
                const rawData = await fs.promises.readFile(filePath, 'utf-8');
                data = JSON.parse(rawData);
            }
            const games = data.downloads;
            const found = games.filter(game => {
                const normTitle = normalizeString(game.title);
                return searchWords.every(word => normTitle.includes(word));
            }).map(game => {
                const originalMagnet = game.uris.find(u => u.startsWith('magnet:?'));
                if (!originalMagnet) return null;
                const cleanData = cleanMagnet(originalMagnet);
                return {
                    provider: source.name,
                    emoji: source.emoji,
                    title: game.title.trim(),
                    fileSize: game.fileSize.replace(/\s+/g, ' ').trim(),
                    uploadDate: game.uploadDate,
                    magnet: cleanData.magnet,
                    hash: cleanData.hash
                };
            }).filter(item => item !== null);
            
            if (source.name === 'FitGirl') fitgirlMatches = found;
            if (source.name === 'DODI') dodiMatches = found;
            if (source.name === 'Online Fix') onlineFixMatches = found;
        } catch (err) {
            console.error(`Erro ao buscar em ${source.name}:`, err.message);
        }
    }));

    const finalResults = [];
    const maxLength = Math.max(fitgirlMatches.length, dodiMatches.length, onlineFixMatches.length);
    for (let i = 0; i < maxLength; i++) {
        if (i < fitgirlMatches.length) finalResults.push(fitgirlMatches[i]);
        if (i < dodiMatches.length) finalResults.push(dodiMatches[i]);
        if (i < onlineFixMatches.length) finalResults.push(onlineFixMatches[i]);
        if (finalResults.length >= 25) break;
    }
    return finalResults.slice(0, 25);
}

async function getTorrentOrMagnet(game) {
    const torrentData = await fetchTorrentFile(game.hash);
    if (torrentData) {
        return {
            type: 'file',
            buffer: Buffer.from(torrentData),
            fileName: `${game.title.substring(0, 20).replace(/[^a-z0-9]/gi, '_')}.torrent`,
            message: `✅ **Arquivo .torrent carregado com sucesso!**\n\n📖 **Guia Rápido de Instalação:**\n1️⃣ Baixe o arquivo \`.torrent\` anexado acima.\n2️⃣ Dê dois cliques para abri-lo no seu cliente torrent (recomendamos o **qBittorrent**).\n3️⃣ Escolha o local de destino e clique em **OK** para começar a baixar.`,
            color: '#10B981'
        };
    } else {
        return {
            type: 'magnet',
            buffer: Buffer.from(game.magnet, 'utf-8'),
            fileName: 'link_magnetico.txt',
            message: `⚠️ **Arquivo .torrent não encontrado (Cache Miss)**\nO arquivo foi enviado em formato de texto \`.txt\` com o link direto.\n\n📖 **Guia Rápido de Magnet Link:**\n1️⃣ Copie o código contido no campo abaixo ou abra o arquivo \`.txt\` anexo.\n2️⃣ No seu cliente torrent (ex: **qBittorrent**), clique no botão de adicionar link (ícone de link/corrente).\n3️⃣ Cole o código copiado e confirme para iniciar o download.`,
            color: '#F59E0B'
        };
    }
}

function createPaginationComponents(page, totalPages, itemsInPage, startIndex) {
    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId('select_game')
        .setPlaceholder('📂 Escolha o arquivo para baixar...')
        .addOptions(
            itemsInPage.map((game, index) => {
                const safeTitle = game.title.length > 90 ? game.title.substring(0, 90) + '...' : game.title;
                return new StringSelectMenuOptionBuilder()
                    .setLabel(`${startIndex + index + 1}. ${safeTitle}`)
                    .setDescription(`${game.provider} - ${game.fileSize}`)
                    .setValue((startIndex + index).toString())
                    .setEmoji(game.emoji);
            })
        );
    const rowMenu = new ActionRowBuilder().addComponents(selectMenu);

    const prevButton = new ButtonBuilder()
        .setCustomId('game_prev')
        .setLabel('⬅️ Anterior')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === 0);

    const nextButton = new ButtonBuilder()
        .setCustomId('game_next')
        .setLabel('➡️ Próximo')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(page === totalPages - 1);

    const rowButtons = new ActionRowBuilder().addComponents(prevButton, nextButton);
    
    const components = [rowMenu];
    if (totalPages > 1) {
        components.push(rowButtons);
    }
    return components;
}

async function executeGameCommand(interaction) {
    const gameName = interaction.options.getString('nome');
    const provider = interaction.options.getString('fonte') || 'any';
    console.log(`[LOG] Slash: /buscar_jogo | Usuário: ${interaction.user.tag} (${interaction.user.id}) | Jogo: "${gameName}" | Fonte: "${provider}"`);
    
    const interactionResponse = await interaction.deferReply({ ephemeral: false });
    try {
        const finalResults = await searchGames(gameName, provider);
        if (finalResults.length === 0) {
            return interaction.editReply({ content: `❌ Nada encontrado para "**${gameName}**".` });
        }
        
        const pageSize = 5;
        const totalPages = Math.ceil(finalResults.length / pageSize);
        let currentPage = 0;
        
        const renderPage = (page) => {
            const startIndex = page * pageSize;
            const endIndex = Math.min(startIndex + pageSize, finalResults.length);
            const pageItems = finalResults.slice(startIndex, endIndex);
            
            let description = 'Selecione uma das opções no menu abaixo para receber o arquivo de download.\n\n';
            pageItems.forEach((game, index) => {
                const date = new Date(game.uploadDate).toLocaleDateString('pt-BR');
                const safeTitle = game.title.length > 70 ? game.title.substring(0, 67) + '...' : game.title;
                const displayIndex = startIndex + index + 1;
                description += `**#${displayIndex}** ${game.emoji} **${safeTitle}**\n`;
                description += `\`📦 ${game.fileSize}\`  •  \`📅 ${date}\`  •  \`${game.provider}\`\n\n`;
            });

            const embed = new EmbedBuilder()
                .setTitle(`🔍 Resultados para: "${gameName}" (Página ${page + 1}/${totalPages})`)
                .setDescription(description)
                .setColor('#8F55FD')
                .setFooter({ text: 'Yui Torrent • by oBraga' });
            
            const components = createPaginationComponents(page, totalPages, pageItems, startIndex);
            return { embeds: [embed], components };
        };
        
        await interaction.editReply(renderPage(currentPage));
        
        const collector = interactionResponse.createMessageComponentCollector({
            time: 120000
        });
        
        collector.on('collect', async i => {
            if (i.user.id !== interaction.user.id) {
                return i.reply({ content: '❌ Faça sua própria busca com /buscar_jogo.', ephemeral: true });
            }
            
            if (i.customId === 'game_prev') {
                currentPage--;
                await i.update(renderPage(currentPage));
            } else if (i.customId === 'game_next') {
                currentPage++;
                await i.update(renderPage(currentPage));
            } else if (i.customId === 'select_game') {
                await i.update({ content: '🔄 **Processando...** Buscando arquivo...', components: [], embeds: [] });
                const selectedIndex = parseInt(i.values[0]);
                const selectedGame = finalResults[selectedIndex];
                console.log(`[LOG] Seleção Game: ${selectedGame.title} | Usuário: ${i.user.tag} (${i.user.id})`);
                const result = await getTorrentOrMagnet(selectedGame);
                const attachment = new AttachmentBuilder(result.buffer, { name: result.fileName });
                const successEmbed = new EmbedBuilder()
                    .setTitle(`🚀 Download Pronto: ${selectedGame.title}`)
                    .setDescription(result.message)
                    .setColor(result.color)
                    .addFields({ name: '🔗 Magnet Link (Backup)', value: `\`\`\`${selectedGame.magnet}\`\`\`` })
                    .setFooter({ text: 'Yui Torrent Search • by oBraga' });
                await i.editReply({ content: '', embeds: [successEmbed], files: [attachment] });
                collector.stop();
            }
        });
        
        collector.on('end', (collected, reason) => {
            if (reason === 'time') {
                interaction.deleteReply().catch(() => {});
            }
        });
    } catch (error) {
        console.error('Erro no gameHandler:', error);
        await interaction.editReply('Ocorreu um erro interno ao processar a busca.');
    }
}

export { executeGameCommand, searchGames, getTorrentOrMagnet, createPaginationComponents, normalizeString };
export default { executeGameCommand, searchGames, getTorrentOrMagnet, createPaginationComponents, normalizeString };
