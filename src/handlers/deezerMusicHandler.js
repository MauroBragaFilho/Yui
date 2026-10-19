import { EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle, AttachmentBuilder } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import {
    searchDeezerTracks,
    calculateConfidenceScore,
    downloadDeezerTrack,
    cleanupTempAudio,
    cleanupDeezerDir,
    DeezerDownloadError,
    DEEZER_ERROR_CODES,
    DEEZER_USER_MESSAGES,
    normalizeSearchQuery,
    TEMP_AUDIO_DIR
} from '../services/deezerMusicService.js';
import { checkBan } from './banHandler.js';
import { getYtdlpPath, getFfmpegPath } from '../utils/binaries.js';
import { resolveExistingPath, resolveBinaryPath, createRequestDir, getMediaUserMessage, DEEZER_FALLBACK_NOTICE } from '../utils/mediaUrls.js';
import { prepareAudioForDelivery, describePrepared } from '../utils/audioFit.js';
import { clampText } from '../discord/embedLimits.js';
import config from '../config.js';
import { logger } from '../utils/logger.js';

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
        const savedInfoEmbed = session.infoEmbed || null;
        musicSessions.delete(userId);

        const result = await executeDownloadAndPackage(chosenTrack, { context });
        if (result.success && savedInfoEmbed) {
            result.infoEmbed = savedInfoEmbed;
        }
        return result;
    }

    // A consulta vai para um serviço externo e é ecoada nas respostas: no máximo 150 caracteres, sem controle.
    const cleanQuery = normalizeSearchQuery(query);
    const results = await searchDeezerTracks(cleanQuery);
    if (!results || results.length === 0) {
        return { error: `Nenhuma música encontrada no catálogo para "${clampText(cleanQuery, 100)}".` };
    }

    const topResult = results[0];
    const topScore = calculateConfidenceScore(cleanQuery, topResult);

    if (context.forceDownload) {
        const result = await executeDownloadAndPackage(topResult, { context });
        if (result.success && topScore < 40) {
            result.lowConfidence = true;
        }
        return result;
    }

    if (topScore >= 80) {
        return await executeDownloadAndPackage(topResult, { context });
    }

    musicSessions.set(userId, {
        query: cleanQuery,
        results,
        infoEmbed: context.infoEmbed || null,
        timestamp: Date.now()
    });

    let textFormatted = 'Não achei a correta, mas na pesquisa me retornou essas:\n';
    results.forEach((item, index) => {
        textFormatted += `${index + 1}. ${clampText(item.title, 120)} - ${clampText(item.artist, 80)} (${formatDuration(item.duration)})\n`;
    });
    textFormatted += 'Só selecionar ou dizer qual delas quer baixar';

    // Sem indicar de onde vêm os resultados (decisão do dono): o rodapé não cita o serviço de busca.
    const embed = new EmbedBuilder()
        .setTitle('🎵 Seleção de Música')
        .setDescription('Não achei a correta mas encontrei essas outras opções. Escolha qual deseja baixar abaixo:')
        .setColor(0x9b59b6)
        .setThumbnail(topResult.cover || null)
        .setFooter({ text: 'Sistema de Áudio HQ' });

    // Título e artista vêm de fora: cortados para caber (nome do campo 256, valor 1024).
    results.forEach((item, index) => {
        embed.addFields({
            name: clampText(`${index + 1}. ${item.title}`, 250),
            value: clampText(`👤 Artista: ${item.artist}\n⏱️ Duração: ${formatDuration(item.duration)}`, 1000),
            inline: false
        });
    });

    const selectMenu = new StringSelectMenuBuilder()
        .setCustomId(`music_select_${userId}`)
        .setPlaceholder('Selecione uma música da lista...')
        .addOptions(results.map((item, index) => ({
            label: `${index + 1}. ${clampText(item.title, 40, { ellipsis: '' })}`,
            description: `${clampText(item.artist, 45, { ellipsis: '' })} (${formatDuration(item.duration)})`,
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

// ---------------------------------------------------------------------------
// Plano B: se o deemix falhar, baixa o áudio do YouTube por busca (sem shell, um único argumento).
//
// Decisão: o plano B vale para TODOS os motivos de falha do Deezer (deemix não instalado, login/ARL
// expirado, tempo esgotado, erro genérico). O objetivo é entregar a música; o motivo real vai para o
// log (o dono corrige o ARL/instalação). O usuário recebe só um aviso NEUTRO de qualidade: de onde veio o
// arquivo (serviço ou ferramenta) não aparece em nada que ele recebe (decisão do dono); fica nos logs.
// Este laço é só Deezer -> YouTube: o fallback inverso do Modo Rádio (radioProviders) não passa por aqui.
// ---------------------------------------------------------------------------

const YT_FALLBACK_TIMEOUT_MS = 150 * 1000;

function cleanQueryPart(text) {
    return String(text ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
}

/** "<artista> - <título>" sem caracteres de controle (a consulta nasce de dados externos). */
export function buildYoutubeSearchQuery(track) {
    const artist = cleanQueryPart(track?.artist?.name || track?.artist);
    const title = cleanQueryPart(track?.title);
    return cleanQueryPart(artist && title ? `${artist} - ${title}` : (title || artist)).slice(0, 200);
}

/** Duração máxima aceita para o resultado do YouTube (evita baixar um álbum/live de horas). */
function maxFallbackDuration(track) {
    const seconds = Number(track?.duration);
    if (Number.isFinite(seconds) && seconds > 0) return Math.min(Math.max(Math.round(seconds * 2 + 90), 240), 1500);
    return 900;
}

/**
 * Array de argumentos do yt-dlp para o plano B. Sem aspas e sem shell:
 * a consulta é UM único argumento ('ytsearch1:' + consulta).
 */
export function buildYoutubeFallbackArgs(track, requestDir, { cookiesPath = '', extraFlags = [], ffmpegPath = '' } = {}) {
    const query = buildYoutubeSearchQuery(track);
    if (!query) throw new Error('Consulta vazia para o plano B.');
    const args = ['-x', '--audio-format', 'mp3', '--no-playlist', '--no-warnings', '--socket-timeout', '20'];
    args.push('--match-filter', `duration<=${maxFallbackDuration(track)}`);
    // O yt-dlp roda com cwd na subpasta do pedido: caminho relativo (vindo do .env) seria resolvido a partir dela
    // e não existiria. Por isso os caminhos seguem SEMPRE absolutos (nome puro de binário, do PATH, fica como está).
    if (cookiesPath) args.push('--cookies', path.resolve(cookiesPath));
    for (const flag of extraFlags) if (typeof flag === 'string' && flag) args.push(flag);
    if (ffmpegPath) args.push('--ffmpeg-location', resolveBinaryPath(ffmpegPath));
    args.push('-o', path.join(requestDir, '%(id)s.%(ext)s'), '--print-json');
    args.push(`ytsearch1:${query}`);
    return args;
}

function readYtdlpJson(stdout) {
    for (const line of String(stdout || '').split(/\r?\n/).reverse()) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{')) continue;
        try {
            return JSON.parse(trimmed);
        } catch (_) { /* próxima linha */ }
    }
    return null;
}

/**
 * Baixa o primeiro resultado do YouTube para uma subpasta única de TEMP_AUDIO_DIR.
 * @returns {Promise<{filePath: string, youtubeTitle: string}>}
 */
export async function downloadFromYoutubeFallback(track, deps = {}) {
    const execFileImpl = deps.execFileImpl || execFile;
    const baseDir = deps.baseDir || TEMP_AUDIO_DIR;
    // Subpasta única e ABSOLUTA: o yt-dlp roda com cwd nela, então um caminho relativo se duplicaria.
    const requestDir = createRequestDir(baseDir);

    try {
        const cookiesPath = deps.cookiesPath !== undefined ? deps.cookiesPath : config.ytdlpCookiesPath;
        const ffmpegPath = deps.ffmpegPath !== undefined ? deps.ffmpegPath : getFfmpegPath();
        // Mesmo defeito que o R1 corrigiu no youtubeAudioHandler: cookies/ffmpeg relativos do .env são resolvidos AQUI,
        // a partir da pasta de trabalho da Yui, antes de o cwd mudar para a pasta do pedido.
        const args = buildYoutubeFallbackArgs(track, requestDir, {
            cookiesPath: resolveExistingPath(cookiesPath) || '',
            extraFlags: deps.extraFlags || config.ytdlpExtraFlags || [],
            ffmpegPath: resolveExistingPath(ffmpegPath) || ''
        });

        const { error, stdout } = await new Promise((resolve) => {
            try {
                execFileImpl(resolveBinaryPath(deps.ytdlpPath || getYtdlpPath()), args, {
                    timeout: deps.timeoutMs || YT_FALLBACK_TIMEOUT_MS,
                    maxBuffer: 20 * 1024 * 1024,
                    windowsHide: true,
                    cwd: requestDir
                }, (err, out) => resolve({ error: err || null, stdout: String(out ?? '') }));
            } catch (err) {
                resolve({ error: err, stdout: '' });
            }
        });

        // Só vale arquivo MP3 dentro da subpasta deste pedido.
        const mp3 = fs.readdirSync(requestDir).find((name) => /\.mp3$/i.test(name));
        const filePath = mp3 ? path.join(requestDir, mp3) : null;
        if (!filePath || fs.statSync(filePath).size === 0) {
            const reason = error ? (error.killed ? 'tempo esgotado' : `saída ${error.code ?? '?'}`) : 'nenhum arquivo gerado (filtro de duração?)';
            throw new Error(`yt-dlp sem resultado: ${reason}`);
        }
        const info = readYtdlpJson(stdout);
        return { filePath, youtubeTitle: cleanQueryPart(info?.title).slice(0, 120) };
    } catch (err) {
        cleanupDeezerDir(requestDir, { baseDir });
        throw err;
    }
}

/** Mensagem segura para o usuário: nunca repassa `error.message` de erros inesperados. */
function friendlyMessage(error) {
    if (error instanceof DeezerDownloadError) return error.message;
    return DEEZER_USER_MESSAGES[DEEZER_ERROR_CODES.ERROR];
}

/**
 * Prepara o arquivo baixado para a ENTREGA ao Discord: recomprime se passar do limite de upload (a faixa do Deezer
 * vem a 320 kbps e passa de 10 MB com 4 min 22 s) e limpa as tags de origem. Devolve null quando está pronto, ou a
 * frase de erro para o usuário. O motivo técnico vai só para o log.
 * `deps.context` (guild, source) decide o limite; `deps.audioFit` e os dublês de `deps` existem para teste.
 */
async function prepareForDelivery(filePath, track, deps) {
    try {
        const prepared = await prepareAudioForDelivery(filePath, {
            context: deps.context || null,
            env: deps.env,
            durationSeconds: Number(track?.duration),
            ffmpegPath: deps.ffmpegPath || getFfmpegPath(),
            execFileImpl: deps.execFileImpl,
            killImpl: deps.killImpl,
            ...(deps.audioFit || {}),
        });
        const note = describePrepared(prepared);
        if (note) logger.info(`[DeezerMusic] Faixa ${track?.id ?? '?'}: ${note}`);
        return null;
    } catch (error) {
        logger.warn(`[DeezerMusic] Faixa ${track?.id ?? '?'} não pôde ser preparada para o envio (${error?.code || 'ERRO'}): ${error?.detail || error?.message || error}`);
        return getMediaUserMessage(error);
    }
}

async function executeDownloadAndPackage(track, deps = {}) {
    const download = deps.downloadDeezerTrack || downloadDeezerTrack;
    let deezerFailure = null;
    let downloaded = null;

    try {
        downloaded = await download(track.id || track.link);
    } catch (error) {
        deezerFailure = error;
        logger.warn(`[DeezerMusic] Deezer falhou (${error?.code || DEEZER_ERROR_CODES.ERROR}) na faixa ${track?.id ?? '?'}; tentando o plano B (YouTube).`);
    }

    if (downloaded) {
        const problem = await prepareForDelivery(downloaded, track, deps);
        if (problem) {
            cleanupTempAudio(downloaded);
            return { error: problem };
        }
        return {
            success: true,
            filePath: downloaded,
            attachment: new AttachmentBuilder(downloaded, { name: attachmentName(track.title) }),
            track,
            cleanup: () => cleanupTempAudio(downloaded)
        };
    }

    try {
        const fallback = await (deps.downloadFromYoutube || downloadFromYoutubeFallback)(track, deps);
        const youtubeTitle = fallback.youtubeTitle || '';
        logger.info(`[DeezerMusic] Plano B (YouTube) entregou a faixa ${track?.id ?? '?'}.`);
        const problem = await prepareForDelivery(fallback.filePath, track, deps);
        if (problem) {
            cleanupTempAudio(fallback.filePath);
            return { error: problem };
        }
        return {
            success: true,
            filePath: fallback.filePath,
            // Nome do arquivo e artista iguais aos da faixa original: nada indica de onde o áudio veio.
            attachment: new AttachmentBuilder(fallback.filePath, { name: attachmentName(track.title) }),
            track,
            originalTrack: track,
            fallback: { source: 'youtube', reason: deezerFailure?.code || DEEZER_ERROR_CODES.ERROR, youtubeTitle },
            notice: DEEZER_FALLBACK_NOTICE,
            cleanup: () => cleanupTempAudio(fallback.filePath)
        };
    } catch (ytError) {
        logger.error(`[DeezerMusic] Plano B (YouTube) também falhou na faixa ${track?.id ?? '?'}: ${ytError.message}`);
        return { error: `Erro ao baixar a música: ${friendlyMessage(deezerFailure)}` };
    }
}

function sanitizeFilename(filename) {
    return String(filename ?? '').replace(/[<>:"/\\|?*`!,]/g, '').replace(/\s+/g, ' ').trim();
}

// Nome do anexo: só o título da faixa (até 100 caracteres), sem sufixo de origem.
function attachmentName(title) {
    return `${clampText(sanitizeFilename(title), 100, { ellipsis: '' }).trim() || 'musica'}.mp3`;
}

function clearSession(userId) {
    musicSessions.delete(userId);
}

export { handleMusicSearchAndDownload, executeDownloadAndPackage, clearSession };
export default {
    handleMusicSearchAndDownload,
    executeDownloadAndPackage,
    clearSession
};
