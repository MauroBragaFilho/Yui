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
import { getFfmpegPath, isOpusAvailable } from '../utils/binaries.js';
import { logger } from '../utils/logger.js';
import {
    attachPlayerSafety,
    classifyIdleEnd,
    classifyPlaybackError,
    createFailureBreaker,
    environmentError,
    errMsg,
    IDLE_DEFAULTS
} from '../utils/voiceSafety.js';

const players = new Map();
const activeStreams = new Map();
const transitioningGuilds = new Set();

// Disjuntor: conta falhas seguidas de reprodução por servidor e para o rádio depois de N,
// em vez de repetir a mesma faixa quebrada a cada ~2 s (loopMode TRACK/QUEUE) com chime e embed.
// Ambiente quebrado (sem Opus/ffmpeg) para mais cedo que "música não encontrada".
const failureBreaker = createFailureBreaker();
// Servidores cujo player acabou de dar erro (o Idle que vem junto não conta como faixa tocada com sucesso).
const playerErrored = new Set();
// Tempo mínimo tocando para uma faixa contar como "tocou de verdade" e zerar as falhas seguidas.
const MIN_PLAY_MS_FOR_SUCCESS = IDLE_DEFAULTS.successMs;
// Terminar sem erro tendo tocado menos que isto = faixa vazia (yt-dlp/ffmpeg sem dados): conta como falha.
const MAX_EMPTY_PLAY_MS = IDLE_DEFAULTS.emptyMs;
// Espera antes de avançar depois de uma faixa que morreu logo (passa da janela de transição de 1,5 s).
const ADVANCE_DELAY_MS = 2000;
// Recurso (AudioResource) da faixa que toca AGORA em cada servidor. Só o fim natural desse recurso
// (o Idle dele) faz o rádio avançar ou contar falha. Toda parada forçada nossa (stopPlayer, disjuntor,
// troca de faixa) limpa o registro ANTES do player.stop(true), porque o stop dispara o Idle de forma SÍNCRONA.
const currentResources = new Map();
// "Geração" por servidor: avanços atrasados (setTimeout) se cancelam se, nesse meio-tempo, o usuário
// pulou, parou ou começou outra faixa (senão pulariam também a faixa nova).
const advanceEpochs = new Map();
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

function bumpEpoch(guildId) {
    advanceEpochs.set(guildId, (advanceEpochs.get(guildId) || 0) + 1);
}

/**
 * Para o player à força SEM que o Idle resultante seja confundido com o fim natural da faixa
 * (esse Idle é emitido de forma síncrona dentro do stop(true)).
 */
function forceStopPlayer(guildId, player) {
    currentResources.delete(guildId);
    if (!player) return;
    try { player.stop(true); } catch (_) {}
}

/** Chama handleTrackEnd depois de `delayMs`, a não ser que o servidor tenha mudado de faixa/parado nesse meio-tempo. */
function scheduleAdvance(guildId, textChannel, client, delayMs = ADVANCE_DELAY_MS) {
    const epoch = advanceEpochs.get(guildId) || 0;
    const timer = setTimeout(() => {
        if ((advanceEpochs.get(guildId) || 0) !== epoch) return;
        handleTrackEnd(guildId, textChannel, client);
    }, delayMs);
    timer?.unref?.();
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
            attachPlayerSafety(player, { label: 'RadioPlayer', guildId, log: logger });
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

/**
 * Para o rádio depois de falhas seguidas de reprodução (disjuntor). Explica ao canal
 * se o problema é do ambiente de áudio da Yui ou das faixas, em vez de repetir em laço.
 */
async function haltRadioAfterFailures(guildId, textChannel, client, verdict) {
    const ambiente = verdict.kind === 'environment';
    logger.error(
        `[RadioPlayer] Rádio parado no servidor ${guildId} após ${verdict.count} falha(s) seguida(s) ` +
        `(${ambiente ? 'ambiente de áudio com problema: Opus/ffmpeg' : 'faixas que não tocam'}).`
    );
    // ORDEM IMPORTA: player.stop(true) emite o Idle de forma SÍNCRONA (confirmado com um AudioPlayer real).
    // Se a sessão ainda estivesse PLAYING, o ouvinte de Idle chamaria handleTrackEnd e iniciaria a faixa seguinte,
    // desfazendo a parada. Por isso: trava transições e grava STOPPED ANTES de derrubar o stream e o player.
    transitioningGuilds.add(guildId);
    bumpEpoch(guildId);
    try {
        updateSession(guildId, { status: 'STOPPED', currentTrack: null });
        failureBreaker.reset(guildId);
        playerErrored.delete(guildId);
        destroyActiveStream(guildId);
        forceStopPlayer(guildId, players.get(guildId));
        await updateEmbed(guildId, textChannel, client);
        if (textChannel) {
            try {
                await textChannel.send(ambiente
                    ? '⚠️ **Parei o rádio:** o ambiente de áudio da Yui está com problema (codificador Opus ou ffmpeg). Avise o dono para verificar.'
                    : `⚠️ **Parei o rádio:** ${verdict.count} faixas seguidas não puderam ser tocadas. Confira os links ou tente outras músicas.`);
            } catch (_) {}
        }
    } finally {
        setTimeout(() => {
            transitioningGuilds.delete(guildId);
        }, 1500);
    }
}

async function playTrack(guildId, track, textChannel, client) {
    const conn = getVoiceConnection(guildId);
    if (!conn) return;

    transitioningGuilds.add(guildId);
    bumpEpoch(guildId);

    if (activeStreams.get(guildId)) {
        destroyActiveStream(guildId);
    }

    let player = players.get(guildId);
    if (player) {
        // Troca de faixa: o Idle desta parada forçada não é o fim da faixa nova.
        forceStopPlayer(guildId, player);
    } else {
        currentResources.delete(guildId);
    }

    updateSession(guildId, { status: 'BUFFERING', currentTrack: track });
    await updateEmbed(guildId, textChannel, client);

    if (!player) {
        player = createAudioPlayer();
        players.set(guildId, player);
        conn.subscribe(player);

        player.on(AudioPlayerStatus.Idle, (oldState) => {
            // O erro (se houve) já foi contado pelo ouvinte de 'error'; este Idle é só o rastro dele.
            const comErro = playerErrored.delete(guildId);
            const resource = oldState?.resource;
            const isCurrent = Boolean(resource) && currentResources.get(guildId) === resource;
            if (isCurrent) currentResources.delete(guildId);

            const outcome = classifyIdleEnd({
                oldState,
                isCurrent,
                errored: comErro,
                successMs: MIN_PLAY_MS_FOR_SUCCESS,
                emptyMs: MAX_EMPTY_PLAY_MS
            });
            // Parada forçada nossa, troca de faixa, chime: não é o fim da faixa, o rádio não anda sozinho.
            if (outcome === 'ignore') return;

            // Faixa que tocou de verdade e terminou sem erro zera a contagem de falhas seguidas.
            if (outcome === 'success') failureBreaker.recordSuccess(guildId);

            if (outcome === 'failure') {
                // Terminou sem erro e sem áudio (yt-dlp/ffmpeg sem dados, Modo Rápido): sem isto a faixa "tocava"
                // em silêncio, não contava falha e, com loopMode TRACK/QUEUE, repetia sem parar.
                logger.warn(
                    `[RadioPlayer] Faixa terminou sem áudio (servidor ${guildId}, ` +
                    `${Math.round(Number(resource?.playbackDuration) || 0)} ms tocados).`
                );
                const verdict = failureBreaker.recordFailure(guildId, 'track');
                if (verdict.trip) {
                    haltRadioAfterFailures(guildId, textChannel, client, verdict).catch((e) => {
                        logger.warn(`[RadioPlayer] Falha ao parar o rádio (servidor ${guildId}): ${errMsg(e)}`);
                    });
                    return;
                }
            }

            // Faixa quebrada morre dentro da janela de transição (1,5 s após o início): handleTrackEnd não anda
            // agora e o rádio ficaria parado em "tocando". Reagenda para depois da janela (se o erro já avançou, não).
            if (outcome === 'failure' || transitioningGuilds.has(guildId)) {
                if (!comErro) scheduleAdvance(guildId, textChannel, client);
                return;
            }
            handleTrackEnd(guildId, textChannel, client);
        });

        player.on('error', (err) => {
            if (transitioningGuilds.has(guildId)) return;
            if (err.message?.includes('Premature close')) return;
            playerErrored.add(guildId);
            const kind = classifyPlaybackError(err);
            logger.warn(`[RadioPlayer] Erro no player (servidor ${guildId}, tipo ${kind}): ${errMsg(err)}`);
            const verdict = failureBreaker.recordFailure(guildId, kind);
            if (verdict.trip) {
                haltRadioAfterFailures(guildId, textChannel, client, verdict).catch((e) => {
                    logger.warn(`[RadioPlayer] Falha ao parar o rádio (servidor ${guildId}): ${errMsg(e)}`);
                });
                return;
            }
            handleTrackEnd(guildId, textChannel, client);
        });
    }

    try {
        // Sem o Opus o createAudioResource(Raw) lança na criação do Encoder: falha logo, sem gastar yt-dlp/ffmpeg.
        if (!isOpusAvailable()) {
            throw environmentError('Codificador Opus indisponível (instale opusscript ou @discordjs/opus)');
        }

        if (track.source === 'youtube') {
            const progressiveStream = createYouTubeProgressiveStream(track.link);
            activeStreams.set(guildId, progressiveStream);
            // ANTES do await: se o yt-dlp/ffmpeg falhar ao abrir, o stream emite 'error' e, sem ouvinte, isso derrubaria o processo.
            progressiveStream.on('error', (e) => {
                logger.warn(`[RadioPlayer] Erro no stream do YouTube (servidor ${guildId}): ${errMsg(e)}`);
            });

            await progressiveStream.waitUntilReady();

            const resource = createAudioResource(progressiveStream, { inputType: StreamType.Raw });
            // Registra ANTES do play: é por este registro que o Idle sabe que o fim é o da faixa atual.
            currentResources.set(guildId, resource);
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
            // O erro também chega ao player ('error'), que cuida do disjuntor; aqui só registra.
            pcmHandle.stream.on('error', (e) => {
                logger.warn(`[RadioPlayer] Erro no ffmpeg/arquivo de áudio (servidor ${guildId}): ${errMsg(e)}`);
            });
            const resource = createAudioResource(pcmHandle.stream, { inputType: StreamType.Raw });
            currentResources.set(guildId, resource);
            player.play(resource);

            await updateEmbed(guildId, textChannel, client);
        }

        prefetchNextTrack(guildId).catch(() => {});

    } catch (err) {
        const kind = classifyPlaybackError(err);
        logger.warn(`[RadioPlayer] Falha ao tocar faixa "${track.title}" (servidor ${guildId}, fonte ${track.source}, tipo ${kind}): ${errMsg(err)}`);

        const verdict = failureBreaker.recordFailure(guildId, kind);
        if (verdict.trip) {
            await haltRadioAfterFailures(guildId, textChannel, client, verdict);
            return;
        }

        await playChime(guildId);
        // Ambiente quebrado não é "música não encontrada": não confunde o canal (o aviso vem se o disjuntor parar o rádio).
        if (textChannel && kind === 'track') {
            try {
                const { buildNotFoundEmbed } = await import('./radioEmbed.js');
                await textChannel.send({ embeds: [buildNotFoundEmbed(track.title)] });
            } catch (_) {}
        }
        // Avança daqui a 2 s, a não ser que o usuário tenha pulado/parado nesse meio-tempo.
        scheduleAdvance(guildId, textChannel, client);
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
    } catch (err) {
        logger.warn(`[RadioPlayer] Erro ao avançar a faixa (servidor ${guildId}): ${errMsg(err)}`);
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
    bumpEpoch(guildId);
    destroyActiveStream(guildId);
    // Parada explícita (ou fim da sessão): recomeça a contagem de falhas seguidas.
    failureBreaker.reset(guildId);
    playerErrored.delete(guildId);

    // Antes o Idle síncrono deste stop(true) chamava handleTrackEnd com a sessão ainda PLAYING e iniciava a
    // faixa seguinte logo depois do "parar". Agora a parada forçada não é tomada como fim de faixa.
    forceStopPlayer(guildId, players.get(guildId));
    players.delete(guildId);
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
        logger.warn(`[RadioPlayer] Falha ao atualizar o embed (servidor ${guildId}): ${errMsg(err)}`);
    } finally {
        embedUpdateLocksMap.delete(guildId);
    }
}

/**
 * Abre ffmpeg para decodificar um arquivo de áudio local em PCM s16le (48kHz estéreo).
 * O resultado é tocado com StreamType.Raw. ATENÇÃO: Raw NÃO dispensa o Opus. O createAudioResource
 * do @discordjs/voice converte Raw em Opus com prism.opus.Encoder, que exige @discordjs/opus,
 * node-opus ou opusscript (por isso playTrack confere isOpusAvailable() antes de tocar).
 * Retorna um objeto { process, stream } para permitir o encerramento correto do ffmpeg.
 * Lança erro de ambiente se o binário (caminho absoluto) não existir; se o spawn falhar de
 * forma assíncrona (ex.: ENOENT no PATH), o erro é repassado ao stream, e dali ao player.
 */
function createFilePcmStream(filePath) {
    const ffmpegBin = getFfmpegPath();
    if (path.isAbsolute(ffmpegBin) && !fs.existsSync(ffmpegBin)) {
        throw environmentError(`ffmpeg não encontrado em ${ffmpegBin}`);
    }
    const ffmpegArgs = [
        '-i', filePath,
        '-f', 's16le',
        '-ac', String(PCM_CHANNELS),
        '-ar', String(PCM_SAMPLE_RATE),
        '-loglevel', 'quiet',
        'pipe:1'
    ];
    const proc = spawn(ffmpegBin, ffmpegArgs, { windowsHide: true });
    const stream = proc.stdout;
    // Sem ouvinte de 'error', um binário ausente/inexecutável vira exceção não tratada.
    proc.on('error', (err) => {
        logger.error(`[RadioPlayer] Não foi possível executar o ffmpeg (${err.code || 'erro'}): ${errMsg(err)}`);
        try { stream.destroy(err); } catch (_) {}
    });
    proc.on('close', (code, signal) => {
        // Encerrado por nós (SIGKILL ao trocar de faixa) não é falha.
        if (code && !signal && !proc.killed) logger.warn(`[RadioPlayer] ffmpeg terminou com código ${code}.`);
    });
    proc.stdin?.on('error', () => {});
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
