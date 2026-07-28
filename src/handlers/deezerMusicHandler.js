const { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } = require('discord.js');
const { searchDeezerTracks, calculateConfidenceScore, downloadDeezerTrack, cleanupTempAudio } = require('../services/deezerMusicService');
const { checkBan } = require('./banHandler');

const musicSessions = new Map();

function formatDuration(seconds) {
    const mins = Math.floor(seconds / 60);
    const secs = String(seconds % 60).padStart(2, '0');
    return `${mins}:${secs}`;
}

async function handleMusicSearchAndDownload(query, selectedIndex = null, context = {}) {
    const userId = context.user?.id || context.userId || 'default_user';
    const banInfo = checkBan(userId, context.guild?.id || context.guildId, context.channel?.id || context.channelId);
    if (banInfo) {
        return { error: '🛑 ACESSO NEGADO: Você está banido do sistema.' };
    }

    if (selectedIndex !== null && selectedIndex !== undefined) {
        const session = musicSessions.get(userId);
        if (!session || !session.results || session.results.length === 0) {
            return { error: 'Nenhuma pesquisa de música pendente foi encontrada. Faça a busca novamente.' };
        }

        const idx = parseInt(selectedIndex, 10) - 1;
        if (isNaN(idx) || idx < 0 || idx >= session.results.length) {
            return { error: `Opção inválida. Escolha um número de 1 a ${session.results.length}.` };
        }

        const chosenTrack = session.results[idx];
        musicSessions.delete(userId);

        return await executeDownloadAndPackage(chosenTrack);
    }

    const results = await searchDeezerTracks(query);
    if (!results || results.length === 0) {
        return { error: `Nenhuma música encontrada no catálogo para "${query}".` };
    }

    const topResult = results[0];
    const topScore = calculateConfidenceScore(query, topResult);

    if (topScore >= 80) {
        return await executeDownloadAndPackage(topResult);
    }

    musicSessions.set(userId, {
        query,
        results,
        timestamp: Date.now()
    });

    let textFormatted = 'Não achei a correta, mas na pesquisa me retornou essas:\n';
    results.forEach((item, index) => {
        textFormatted += `${index + 1}. ${item.title} - ${item.artist} (${formatDuration(item.duration)})\n`;
    });
    textFormatted += 'Só selecionar ou dizer qual delas quer baixar';

    const embed = new EmbedBuilder()
        .setTitle('🎵 Seleção de Música')
        .setDescription('Não achei a correta mas encontrei essas outras opções. Escolha qual deseja baixar abaixo:')
        .setColor(0x9b59b6)
        .setThumbnail(topResult.cover || null)
        .setFooter({ text: 'Sistema de Áudio HQ | Base de dados do Deezer' });

    results.forEach((item, index) => {
        embed.addFields({
            name: `${index + 1}. ${item.title}`,
            value: `👤 Artista: ${item.artist}\n⏱️ Duração: ${formatDuration(item.duration)}`,
            inline: false
        });
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`music_select_${userId}`)
        .setPlaceholder('Selecione uma música da lista...')
        .addOptions(results.map((item, index) => ({
            label: `${index + 1}. ${item.title.substring(0, 40)}`,
            description: `${item.artist.substring(0, 45)} (${formatDuration(item.duration)})`,
            value: String(index + 1)
        })));

    const cancelButton = new ButtonBuilder()
        .setCustomId(`music_cancel_${userId}`)
        .setLabel('Cancelar')
        .setStyle(ButtonStyle.Danger);

    const row1 = new ActionRowBuilder().addComponents(selectMenu);
    const row2 = new ActionRowBuilder().addComponents(cancelButton);

    return {
        isAmbiguous: true,
        textList: textFormatted,
        embed,
        components: [row1, row2],
        results
    };
}

async function executeDownloadAndPackage(track) {
    try {
        const filePath = await downloadDeezerTrack(track.id || track.link);
        const attachment = new AttachmentBuilder(filePath, { name: `${sanitizeFilename(track.title)}.mp3` });

        return {
            success: true,
            filePath,
            attachment,
            track,
            cleanup: () => cleanupTempAudio(filePath)
        };
    } catch (error) {
        return { error: `Erro ao baixar a música: ${error.message}` };
    }
}

function sanitizeFilename(filename) {
    return filename.replace(/[<>:"/\\|?*`!,]/g, '').replace(/\s+/g, ' ').trim();
}

function clearSession(userId) {
    musicSessions.delete(userId);
}

module.exports = {
    handleMusicSearchAndDownload,
    executeDownloadAndPackage,
    clearSession
};
