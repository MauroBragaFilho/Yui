const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');

function formatDuration(seconds) {
    if (!seconds || isNaN(seconds)) return '?:??';
    const m = Math.floor(seconds / 60);
    const s = String(Math.floor(seconds % 60)).padStart(2, '0');
    return `${m}:${s}`;
}

function loopLabel(mode) {
    if (mode === 'TRACK') return '🔂 1×';
    if (mode === 'QUEUE') return '🔁 Playlist';
    return '🔁 Off';
}

function loopButtonStyle(mode) {
    if (mode === 'OFF') return ButtonStyle.Secondary;
    return ButtonStyle.Success;
}

function buildRadioEmbed(session) {
    const track = session.currentTrack;
    const status = session.status;
    const playlist = session.playlist || [];
    const currentPos = session.currentIndex >= 0 ? session.currentIndex + 1 : 0;

    const statusLabel = status === 'PLAYING' ? '▶️ Tocando' : status === 'PAUSED' ? '⏸️ Pausado' : '⏹️ Parado';
    const color = status === 'PLAYING' ? 0x1DB954 : status === 'PAUSED' ? 0xF59E0B : 0x6B7280;

    const embed = new EmbedBuilder()
        .setColor(color)
        .setTitle('📻 Modo Rádio — Hikari')
        .setFooter({ text: 'Hikari Radio • Use os botões abaixo para controlar' });

    if (track) {
        embed.setDescription(`**${statusLabel}** (Faixa #${currentPos} de ${playlist.length})`)
            .addFields(
                { name: '🎵 Faixa Atual', value: `**#${currentPos}. ${track.title}**\n👤 ${track.artist}`, inline: true },
                { name: '⏱️ Duração', value: formatDuration(track.duration), inline: true },
                { name: '📂 Álbum', value: track.album || '—', inline: true },
                { name: '📋 Playlist Total', value: `${playlist.length} faixa(s)`, inline: true },
                { name: '🎲 Shuffle', value: session.shuffle ? '✅ Ativo' : '❌ Off', inline: true },
                { name: '🔁 Loop', value: loopLabel(session.loopMode), inline: true }
            );
        if (track.cover) embed.setThumbnail(track.cover);
        if (track.addedBy) embed.addFields({ name: '➕ Adicionada por', value: `<@${track.addedBy}>`, inline: true });
    } else {
        embed.setDescription(`**${statusLabel}**\n\nNenhuma faixa tocando. Playlist com ${playlist.length} música(s). Use ➕ para adicionar!`);
    }

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_prev').setLabel('⏮️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('radio_playpause').setEmoji(status === 'PLAYING' ? '⏸️' : '▶️').setLabel(status === 'PLAYING' ? 'Pausar' : 'Play').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('radio_stop').setLabel('⏹️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('radio_next').setLabel('⏭️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('radio_shuffle').setLabel('🔀 Shuffle').setStyle(session.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_loop').setLabel(loopLabel(session.loopMode)).setStyle(loopButtonStyle(session.loopMode)),
        new ButtonBuilder().setCustomId('radio_voice_toggle').setLabel(session.voiceListening ? '🎙️ Voz: On' : '🔇 Voz: Off').setStyle(session.voiceListening ? ButtonStyle.Success : ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('radio_queue').setLabel('📜 Ver Lista').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('radio_add').setLabel('➕ Adicionar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('radio_remove').setLabel('🗑️ Remover').setStyle(ButtonStyle.Danger)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_leave').setLabel('🚪 Sair').setStyle(ButtonStyle.Secondary)
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

function buildQueueEmbed(session) {
    const playlist = session.playlist || [];
    const currentIdx = typeof session.currentIndex === 'number' ? session.currentIndex : -1;

    const embed = new EmbedBuilder()
        .setColor(0x7C3AED)
        .setTitle('📋 Fila Permanente do Rádio')
        .setFooter({ text: `${playlist.length} faixa(s) cadastradas nesta sessão de rádio` });

    let desc = '';
    playlist.forEach((t, i) => {
        const pos = i + 1;
        const dur = formatDuration(t.duration);
        if (i === currentIdx && session.status === 'PLAYING') {
            desc += `**▶️ #${pos}. ${t.title} — ${t.artist}** (tocando agora)\n`;
        } else if (i === currentIdx && session.status === 'PAUSED') {
            desc += `**⏸️ #${pos}. ${t.title} — ${t.artist}** (pausada)\n`;
        } else if (i < currentIdx) {
            desc += `~~#${pos}. ${t.title} — ${t.artist}~~\n`;
        } else {
            desc += `**#${pos}.** ${t.title} — ${t.artist} (${dur})\n`;
        }
    });

    embed.setDescription(desc || 'Fila vazia.');
    return embed;
}

function buildAmbiguousEmbed(results) {
    const embed = new EmbedBuilder()
        .setColor(0x9B59B6)
        .setTitle('🎵 Qual música você quer?')
        .setDescription('Não achei a correta com certeza. Escolha uma das opções abaixo:')
        .setFooter({ text: 'Powered by Deezer' });

    if (results[0]?.cover) embed.setThumbnail(results[0].cover);

    results.forEach((t, i) => {
        embed.addFields({
            name: `${i + 1}. ${t.title}`,
            value: `👤 ${t.artist} | ⏱️ ${formatDuration(t.duration)}`,
            inline: false
        });
    });

    return embed;
}

function buildNotFoundEmbed(query) {
    return new EmbedBuilder()
        .setColor(0xE11D48)
        .setTitle('❌ Música não encontrada')
        .setDescription(`Não consegui encontrar **"${query}"** no Deezer.`)
        .setFooter({ text: 'Hikari Radio' });
}

module.exports = {
    buildRadioEmbed,
    buildQueueEmbed,
    buildAmbiguousEmbed,
    buildNotFoundEmbed,
    formatDuration
};
