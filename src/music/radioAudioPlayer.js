import {
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    getVoiceConnection,
    StreamType
} from '@discordjs/voice';
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getSession, updateSession, nextTrack } from './radioDatabase.js';
import { downloadTrackToDisk } from './radioProviders.js';
import { buildRadioEmbed } from './radioEmbed.js';
import { createYouTubeProgressiveStream } from './youtubeBufferStream.js';
import { getFfmpegPath } from '../utils/binaries.js';

const players = new Map();
const activeStreams = new Map();
const transitioningGuilds = new Set();
const CHIME_PATH = path.join(__dirname, 'data', 'chime.opus');
const PCM_SAMPLE_RATE = 48000;
const PCM_CHANNELS = 2;

function getPlayer(guildId) {
    return players.get(guildId) || null;
}

/**
 * Encerra o stream ativo de um guild, lidando tanto com o YouTubeBufferStream
 * (tem .destroy()) quanto com o handle { process, stream } do ffmpeg (Deezer).
 */
function destroyActiveStream(guildId) {
    const active = activeStreams.get(guildId);
    if (!active) return;
    try {
        if (active.process && typeof active.process.kill === 'function') {
            try { active.process.kill('SIGKILL'); } catch (_) {}
        }
        if (active.stream) {
            try { active.stream.destroy(); } catch (_) {}
        } else if (typeof active.destroy === 'function') {
            try { active.destroy(); } catch (_) {}
        }
    } catch (_) {}
    activeStreams.delete(guildId);
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
        const { Readable } = await import('node:stream');
        const s = new Readable({ read() { this.push(silenceFrame); this.push(null); } });
        const resource = createAudioResource(s, { inputType: StreamType.Opus });
        player.play(resource);
    } catch (_) {}
}

import { prefetchNextTrack } from './radioPrefetcher.js';

async function playTrack(guildId, track, textChannel, client) {
    const conn = getVoiceConnection(guildId);
    if (!conn) return;

    transitioningGuilds.add(guildId);

    if (activeStreams.get(guildId)) {
        destroyActiveStream(guildId);
    }

    let player = players.get(guildId);
    if (player) {
        try { player.stop(true); } catch (_) {}
    }

    updateSession(guildId, { status: 'BUFFERING', currentTrack: track });
    await updateEmbed(guildId, textChannel, client);

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

            updateSession(guildId, { status: 'PLAYING', currentTrack: track });
            await updateEmbed(guildId, textChannel, client);
        } else {
            let filePath = track.localPath;
            if (!filePath || !fs.existsSync(filePath)) {
                filePath = await downloadTrackToDisk(track);
            }

            updateSession(guildId, { status: 'PLAYING', currentTrack: { ...track, localPath: filePath } });

            const pcmHandle = createFilePcmStream(filePath);
            activeStreams.set(guildId, pcmHandle);
            pcmHandle.stream.on('error', () => {});
            const resource = createAudioResource(pcmHandle.stream, { inputType: StreamType.Raw });
            player.play(resource);

            await updateEmbed(guildId, textChannel, client);
        }

        prefetchNextTrack(guildId).catch(() => {});

    } catch (err) {
        console.error(`[RadioPlayer] Falha ao tocar faixa "${track.title}":`, err.message);
        await playChime(guildId);
        if (textChannel) {
            try {
                const { buildNotFoundEmbed } = await import('./radioEmbed.js');
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
        destroyActiveStream(guildId);

        const session = getSession(guildId);
        if (!session || session._leaving || session.status === 'STOPPED') return;

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
    destroyActiveStream(guildId);

    const player = players.get(guildId);
    if (player) {
        try { player.stop(true); } catch (_) {}
        players.delete(guildId);
    }
}


const embedUpdateLocksMap = new Map();

async function updateEmbed(guildId, textChannel, client) {
    const session = getSession(guildId);
    if (!session || session._leaving) return;

    if (embedUpdateLocksMap.get(guildId)) return;
    embedUpdateLocksMap.set(guildId, true);

    try {
        let targetChannel = textChannel;
        if (!targetChannel && session.textChannelId && client) {
            targetChannel = client.channels?.cache?.get(session.textChannelId) || null;
            if (!targetChannel && client.channels?.fetch) {
                try { targetChannel = await client.channels.fetch(session.textChannelId); } catch (_) {}
            }
        }

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
    } finally {
        embedUpdateLocksMap.delete(guildId);
    }
}

/**
 * Abre ffmpeg para decodificar um arquivo de áudio local em PCM s16le (48kHz estéreo).
 * Usa StreamType.Raw (PCM), evitando a dependência de codec Opus nativo
 * (@discordjs/opus / node-opus / opusscript) ausente em alguns ambientes de produção.
 * Retorna um objeto { process, stream } para permitir o encerramento correto do ffmpeg.
 */
function createFilePcmStream(filePath) {
    const ffmpegBin = getFfmpegPath();
    const ffmpegArgs = [
        '-i', filePath,
        '-f', 's16le',
        '-ac', String(PCM_CHANNELS),
        '-ar', String(PCM_SAMPLE_RATE),
        '-loglevel', 'quiet',
        'pipe:1'
    ];
    const proc = spawn(ffmpegBin, ffmpegArgs);
    proc.stdin?.on('error', () => {});
    const stream = proc.stdout;
    return { process: proc, stream };
}

export { playTrack, pausePlayer, resumePlayer, stopPlayer, playChime, updateEmbed, getPlayer };

export default {
    playTrack,
    pausePlayer,
    resumePlayer,
    stopPlayer,
    playChime,
    updateEmbed,
    getPlayer
};
