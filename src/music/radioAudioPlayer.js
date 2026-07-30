const {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection,
    StreamType
} = require('@discordjs/voice');
const fs = require('fs');
const path = require('path');
const { getSession, updateSession, nextTrack } = require('./radioDatabase');
const { downloadTrackToDisk } = require('./radioProviders');
const { buildRadioEmbed } = require('./radioEmbed');
const { createYouTubeProgressiveStream } = require('./youtubeBufferStream');

const players = new Map();
const activeStreams = new Map();
const transitioningGuilds = new Set();
const CHIME_PATH = path.join(__dirname, 'data', 'chime.opus');

function getPlayer(guildId) {
    return players.get(guildId) || null;
}

function createChimeBuffer() {
    const silenceOpus = Buffer.from([0xf8, 0xff, 0xfe]);
    return silenceOpus;
}

async function playChime(guildId) {
    try {
        const conn = getVoiceConnection(guildId);
        if (!conn) return;
        let player = players.get(guildId);
        if (!player) {
            player = createAudioPlayer();
            players.set(guildId, player);
            conn.subscribe(player);
        }
        const silenceFrame = Buffer.from([0xf8, 0xff, 0xfe]);
        const { Readable } = require('stream');
        const s = new Readable({ read() { this.push(silenceFrame); this.push(null); } });
        const resource = createAudioResource(s, { inputType: StreamType.Opus });
        player.play(resource);
    } catch (_) {}
}

async function playTrack(guildId, track, textChannel, client) {
    const conn = getVoiceConnection(guildId);
    if (!conn) return;

    transitioningGuilds.add(guildId);

    const existingStream = activeStreams.get(guildId);
    if (existingStream) {
        try { existingStream.destroy(); } catch (_) {}
        activeStreams.delete(guildId);
    }

    updateSession(guildId, { status: 'PLAYING', currentTrack: track });
    await updateEmbed(guildId, textChannel, client);

    let player = players.get(guildId);
    if (!player) {
        player = createAudioPlayer();
        players.set(guildId, player);
        conn.subscribe(player);

        player.on(AudioPlayerStatus.Idle, () => {
            if (transitioningGuilds.has(guildId)) return;
            handleTrackEnd(guildId, textChannel, client);
        });

        player.on('error', (err) => {
            if (transitioningGuilds.has(guildId)) return;
            if (err.message?.includes('Premature close')) return;
            console.error(`[RadioPlayer] Erro no player de ${guildId}:`, err.message);
            handleTrackEnd(guildId, textChannel, client);
        });
    }

    try {
        if (track.source === 'youtube') {
            const progressiveStream = createYouTubeProgressiveStream(track.link);
            activeStreams.set(guildId, progressiveStream);

            await progressiveStream.waitUntilReady();

            const resource = createAudioResource(progressiveStream, { inputType: StreamType.Raw });
            player.play(resource);

            await updateEmbed(guildId, textChannel, client);
        } else {
            const filePath = await downloadTrackToDisk(track);
            updateSession(guildId, { currentTrack: { ...track, localPath: filePath } });

            const resource = createAudioResource(filePath, { inlineVolume: false });
            player.play(resource);

            await updateEmbed(guildId, textChannel, client);

            setTimeout(() => {
                try {
                    if (fs.existsSync(filePath)) fs.unlinkSync(filePath);
                } catch (_) {}
            }, 300000);
        }

    } catch (err) {
        console.error(`[RadioPlayer] Falha ao tocar faixa "${track.title}":`, err.message);
        await playChime(guildId);
        if (textChannel) {
            try {
                const { buildNotFoundEmbed } = require('./radioEmbed');
                await textChannel.send({ embeds: [buildNotFoundEmbed(track.title)] });
            } catch (_) {}
        }
        setTimeout(() => handleTrackEnd(guildId, textChannel, client), 2000);
    } finally {
        setTimeout(() => {
            transitioningGuilds.delete(guildId);
        }, 1500);
    }
}

async function handleTrackEnd(guildId, textChannel, client) {
    if (transitioningGuilds.has(guildId)) return;
    transitioningGuilds.add(guildId);

    try {
        const activeStream = activeStreams.get(guildId);
        if (activeStream) {
            try { activeStream.destroy(); } catch (_) {}
            activeStreams.delete(guildId);
        }

        const session = getSession(guildId);
        if (!session || session.status === 'STOPPED') return;

        const next = nextTrack(guildId);
        if (next) {
            await playTrack(guildId, next, textChannel, client);
        } else {
            updateSession(guildId, { status: 'STOPPED', currentTrack: null });
            await updateEmbed(guildId, textChannel, client);
        }
    } finally {
        setTimeout(() => {
            transitioningGuilds.delete(guildId);
        }, 1500);
    }
}

async function pausePlayer(guildId) {
    const player = players.get(guildId);
    if (!player) return false;
    player.pause();
    updateSession(guildId, { status: 'PAUSED' });
    return true;
}

async function resumePlayer(guildId) {
    const player = players.get(guildId);
    if (!player) return false;
    player.unpause();
    updateSession(guildId, { status: 'PLAYING' });
    return true;
}

function stopPlayer(guildId) {
    const activeStream = activeStreams.get(guildId);
    if (activeStream) {
        try { activeStream.destroy(); } catch (_) {}
        activeStreams.delete(guildId);
    }

    const player = players.get(guildId);
    if (player) {
        try { player.stop(true); } catch (_) {}
        players.delete(guildId);
    }
}


async function updateEmbed(guildId, textChannel, client) {
    const session = getSession(guildId);
    if (!session) return;

    let targetChannel = textChannel;
    if (!targetChannel && session.textChannelId && client) {
        targetChannel = client.channels?.cache?.get(session.textChannelId) || null;
        if (!targetChannel && client.channels?.fetch) {
            try { targetChannel = await client.channels.fetch(session.textChannelId); } catch (_) {}
        }
    }

    try {
        const { embeds, components } = buildRadioEmbed(session);

        if (session.embedMessageId && targetChannel) {
            try {
                const msg = await targetChannel.messages.fetch(session.embedMessageId);
                await msg.edit({ embeds, components });
                return;
            } catch (_) {}
        }

        if (targetChannel) {
            const msg = await targetChannel.send({ embeds, components });
            updateSession(guildId, { embedMessageId: msg.id });
        }
    } catch (err) {
        console.error('[RadioPlayer] Falha ao atualizar embed:', err.message);
    }
}

module.exports = {
    playTrack,
    pausePlayer,
    resumePlayer,
    stopPlayer,
    playChime,
    updateEmbed,
    getPlayer
};
