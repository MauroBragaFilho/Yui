import { ActionRowBuilder, ButtonBuilder, ButtonStyle } from 'discord.js';
import { makeEmbed, clampText } from '../discord/embedLimits.js';

// Limites de texto (TG-04/TG-34): título e artista vêm de provedores externos e não têm teto; os cortes ficam aqui, num lugar só.
const TITLE_MAX = 100;
const ARTIST_MAX = 80;
const ALBUM_MAX = 100;
// A fila mostra uma janela de faixas ao redor da atual (descrição do embed: 4096 caracteres).
const QUEUE_WINDOW = 25;
const QUEUE_BEFORE = 5;
const QUEUE_DESC_BUDGET = 3900;

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

function voiceModeLabel(mode) {
    if (mode === 'DIRECT') return '⚡ Voz: Direct';
    if (mode === 'IA') return '🧠 Voz: IA';
    return '🔇 Voz: Off';
}

function voiceButtonStyle(mode) {
    if (mode === 'DIRECT') return ButtonStyle.Success;
    if (mode === 'IA') return ButtonStyle.Primary;
    return ButtonStyle.Danger;
}

const titleOf = (t) => clampText(t?.title || 'Sem título', TITLE_MAX);
const artistOf = (t) => clampText(t?.artist || 'Artista desconhecido', ARTIST_MAX);

function buildRadioEmbed(session) {
    const track = session.currentTrack;
    const status = session.status;
    const playlist = session.playlist || [];
    const currentPos = session.currentIndex >= 0 ? session.currentIndex + 1 : 0;

    const statusLabel = status === 'PLAYING' ? '▶️ Tocando' : status === 'BUFFERING' ? '⏳ Carregando...' : status === 'PAUSED' ? '⏸️ Pausado' : '⏹️ Parado';
    const color = status === 'PLAYING' ? 0x1DB954 : status === 'BUFFERING' ? 0x3B82F6 : status === 'PAUSED' ? 0xF59E0B : 0x6B7280;

    const currentVoiceMode = session.voiceMode || (session.voiceListening ? 'IA' : 'OFF');

    const isFast = session.streamMode === 'FAST';
    const streamModeText = isFast ? '⚡ Rápido (Converte YT ➔ Deezer)' : '⚖️ Híbrido (Padrão)';

    const embedData = {
        color,
        title: '📻 Modo Rádio — Yui',
        footer: 'Yui Radio • Use os botões abaixo para controlar',
    };

    if (track) {
        embedData.description = `**${statusLabel}** (Faixa #${currentPos} de ${playlist.length})`;
        embedData.fields = [
            { name: '🎵 Faixa Atual', value: `**#${currentPos}. ${titleOf(track)}** - ${artistOf(track)}\n\n`, inline: false },
            { name: '⏱️ Duração', value: formatDuration(track.duration), inline: true },
            { name: '📂 Álbum', value: clampText(track.album || '—', ALBUM_MAX), inline: true },
            { name: '📋 Playlist Total', value: `${playlist.length} faixa(s)`, inline: true },
            { name: '🎲 Shuffle', value: session.shuffle ? '✅ Ativo' : '❌ Off', inline: true },
            { name: '🔁 Loop', value: loopLabel(session.loopMode), inline: true },
            { name: '🚀 Busca', value: streamModeText, inline: true },
        ];
        if (track.addedBy) embedData.fields.push({ name: '➕ Adicionada por', value: `<@${track.addedBy}>`, inline: true });
        // makeEmbed descarta capa que não seja http(s): uma URL ruim do provedor não derruba mais o painel.
        embedData.thumbnail = track.cover;
    } else {
        embedData.description = `**${statusLabel}**\n\nNenhuma faixa tocando. Playlist com ${playlist.length} música(s). Use ➕ para adicionar!\n🚀 **Modo de Busca:** ${streamModeText}`;
    }

    const embed = makeEmbed(embedData);

    const row1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_prev').setLabel('⏮️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('radio_playpause').setEmoji(status === 'PLAYING' ? '⏸️' : '▶️').setLabel(status === 'PLAYING' ? 'Pausar' : 'Play').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('radio_stop').setLabel('⏹️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('radio_next').setLabel('⏭️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('radio_shuffle').setLabel('🔀 Shuffle').setStyle(session.shuffle ? ButtonStyle.Success : ButtonStyle.Secondary)
    );

    const row2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_loop').setLabel(loopLabel(session.loopMode)).setStyle(loopButtonStyle(session.loopMode)),
        new ButtonBuilder().setCustomId('radio_voice_toggle').setLabel(voiceModeLabel(currentVoiceMode)).setStyle(voiceButtonStyle(currentVoiceMode)),
        new ButtonBuilder().setCustomId('radio_queue').setLabel('📜 Ver Lista').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('radio_add').setLabel('➕ Adicionar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId('radio_remove').setLabel('🗑️ Remover').setStyle(ButtonStyle.Danger)
    );

    const row3 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('radio_stream_mode').setLabel(isFast ? '⚡ Rápido' : '⚖️ Híbrido').setStyle(isFast ? ButtonStyle.Success : ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('radio_leave').setLabel('🚪 Sair').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setLabel('Apoie o projeto').setURL('https://bio.site/oBraga').setStyle(ButtonStyle.Link).setEmoji('💖')
    );

    return { embeds: [embed], components: [row1, row2, row3] };
}

function buildQueueEmbed(session) {
    const playlist = session.playlist || [];
    const currentIdx = typeof session.currentIndex === 'number' ? session.currentIndex : -1;
    const total = playlist.length;

    const lineCache = new Map();
    const lineAt = (i) => {
        if (lineCache.has(i)) return lineCache.get(i);
        const t = playlist[i];
        const pos = i + 1;
        const title = titleOf(t);
        const artist = artistOf(t);
        let line;
        if (i === currentIdx && session.status === 'PLAYING') {
            line = `**▶️ #${pos}. ${title} — ${artist}** (tocando agora)\n`;
        } else if (i === currentIdx && session.status === 'PAUSED') {
            line = `**⏸️ #${pos}. ${title} — ${artist}** (pausada)\n`;
        } else if (i < currentIdx) {
            line = `~~#${pos}. ${title} — ${artist}~~\n`;
        } else {
            line = `**#${pos}.** ${title} — ${artist} (${formatDuration(t?.duration)})\n`;
        }
        lineCache.set(i, line);
        return line;
    };

    // Janela de até QUEUE_WINDOW faixas: algumas antes da atual e o resto depois (a posição de cada linha é a real da fila).
    let start = Math.max(0, Math.min(currentIdx >= 0 ? currentIdx - QUEUE_BEFORE : 0, total - QUEUE_WINDOW));
    let end = Math.min(total, start + QUEUE_WINDOW);
    const render = () => {
        let desc = '';
        if (start > 0) desc += `… ${start} faixa(s) antes\n`;
        for (let i = start; i < end; i++) desc += lineAt(i);
        if (end < total) desc += `… e mais ${total - end} faixa(s)\n`;
        return desc;
    };
    let desc = render();
    // Títulos longos podem passar do orçamento da descrição: encurta a janela pelo fim (ou pelo começo, se o fim é a faixa atual).
    while (desc.length > QUEUE_DESC_BUDGET && end - start > 1) {
        if (end - 1 > currentIdx) end -= 1; else start += 1;
        desc = render();
    }

    return makeEmbed({
        color: 0x7C3AED,
        title: '📋 Fila Permanente do Rádio',
        footer: `${total} faixa(s) cadastradas nesta sessão de rádio`,
        description: desc.trimEnd() || 'Fila vazia.',
    });
}

function buildAmbiguousEmbed(results) {
    const list = Array.isArray(results) ? results : [];
    return makeEmbed({
        color: 0x9B59B6,
        title: '🎵 Qual música você quer?',
        description: 'Não achei a correta com certeza. Escolha uma das opções abaixo:',
        footer: 'Powered by Deezer',
        thumbnail: list[0]?.cover,
        fields: list.map((t, i) => ({
            name: `${i + 1}. ${titleOf(t)}`,
            value: `👤 ${artistOf(t)} | ⏱️ ${formatDuration(t?.duration)}`,
            inline: false,
        })),
    });
}

function buildNotFoundEmbed(query) {
    return makeEmbed({
        color: 0xE11D48,
        title: '❌ Música não encontrada',
        description: `Não consegui encontrar **"${clampText(query, 100)}"** no Deezer.`,
        footer: 'Yui Radio',
    });
}

export { buildRadioEmbed, buildQueueEmbed, buildAmbiguousEmbed, buildNotFoundEmbed, formatDuration };

export default {
    buildRadioEmbed,
    buildQueueEmbed,
    buildAmbiguousEmbed,
    buildNotFoundEmbed,
    formatDuration
};
