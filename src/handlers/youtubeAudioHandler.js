import { execFile, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { logger } from '../utils/logger.js';
import { getYtdlpPath, getFfmpegPath } from '../utils/binaries.js';
import {
    MediaError,
    MEDIA_MESSAGES,
    normalizeMediaUrl,
    buildYtdlpAudioFlags as buildAudioArgs,
    buildYtdlpVideoFlags as buildVideoArgs,
    readDownloadLimits,
    readMaxConcurrentDownloads,
    createRequestDir,
    removeRequestDir,
    sweepStaleRequestDirs,
    safeFileStem,
    runTool,
    isMissingBinary,
    resolveExistingPath,
    resolveBinaryPath,
} from '../utils/mediaUrls.js';
import {
    RADIO_SOURCES,
    shouldFitForUpload,
    audioUploadMaxMinutes,
    prepareAudioForDelivery,
    describePrepared,
} from '../utils/audioFit.js';
import { getUploadLimitBytes } from '../utils/uploadLimit.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// As pastas só são criadas sob demanda (uma subpasta única por pedido), nunca ao importar o módulo.
const TEMP_AUDIO_DIR = path.join(__dirname, '../data/temp_audio');
const TEMP_VIDEO_DIR = path.join(__dirname, '../data/temp_videos');

// Legado: mantidas só para o export default. NÃO são usadas para montar comandos
// (a validação real é feita por src/utils/mediaUrls.js).
const YOUTUBE_SHORTS_REGEX = /^https?:\/\/(?:www\.|m\.)?youtube\.com\/shorts\/([A-Za-z0-9_-]{11})(?:[/?#][A-Za-z0-9_\-.~%&=+/?#]*)?$/;
const INSTAGRAM_REGEX = /^https?:\/\/(?:www\.)?instagram\.com\/(?:reel|reels)\/([A-Za-z0-9_-]+)\/?(?:[?#][A-Za-z0-9_\-.~%&=+/?#]*)?$/;
const TIKTOK_REGEX = /^https?:\/\/(?:www\.|m\.|vm\.|vt\.)?tiktok\.com\/[A-Za-z0-9._~@/-]+\/?(?:\?[A-Za-z0-9_\-.~&=+/]*)?$/;

// Origens que não sofrem o limite de duração (o Modo Rádio toca sets e faixas longas de propósito).
// A mesma lista decide quem NÃO tem o MP3 recomprimido para caber no upload (audioFit.js).
const LIMIT_EXEMPT_SOURCES = new Set(RADIO_SOURCES);
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
const MAX_BUFFER = 1024 * 1024 * 10;

const activeUserProcesses = new Set();
let isCompressing = false;
const compressionQueue = [];
const pendingVideoFiles = new Map();
const lastSweepAt = new Map();

function describeContext(context) {
    let source = 'Desconhecido';
    let userStr = 'N/A';
    let localStr = 'DM';
    if (context) {
        source = context.source || source;
        if (context.user) {
            userStr = `${context.user.tag} (${context.user.id})`;
        } else if (context.userTag && context.userId) {
            userStr = `${context.userTag} (${context.userId})`;
        } else if (context.userId) {
            userStr = `ID: ${context.userId}`;
        }
        if (context.guild) {
            localStr = context.guild.name;
        } else if (context.guildName) {
            localStr = context.guildName;
        }
    }
    return { source, userStr, localStr };
}

// A URL registrada é sempre a canônica (nunca o texto cru do usuário).
function logMediaAction(type, platform, url, context, status, extra = '') {
    const { source, userStr, localStr } = describeContext(context);
    const platformStr = platform ? ` [${platform.toUpperCase()}]` : '';
    const extraStr = extra ? ` | ${extra}` : '';
    const line = `[LOG] ${type} (${source})${platformStr} | Usuário: ${userStr} | Local: ${localStr} | URL: ${url || 'n/a'} | Status: ${status}${extraStr}`;
    if (/^erro/i.test(status)) logger.warn(line);
    else logger.info(line);
}

function logCompressionAction(context, status, extra = '') {
    const { userStr, localStr } = describeContext(context);
    const extraStr = extra ? ` | ${extra}` : '';
    logger.info(`[LOG] Compressão (Botão) | Usuário: ${userStr} | Local: ${localStr} | Status: ${status}${extraStr}`);
}

function formatVideoSuccessMessage(videoData, showDetails = false) {
    const metadata = videoData.metadata || {};
    let providerName = 'Vídeo';
    const extractor = (metadata.extractor_key || '').toLowerCase();
    if (extractor.includes('instagram')) {
        providerName = 'Instagram Reels';
    } else if (extractor.includes('tiktok')) {
        providerName = 'TikTok';
    } else if (extractor.includes('youtube')) {
        const isShorts = (metadata.webpage_url || '').includes('/shorts/') || (metadata.title || '').toLowerCase().includes('shorts');
        providerName = isShorts ? 'YouTube Shorts' : 'YouTube';
    }
    let msg = `🎬 Vídeo baixado do ${providerName}:`;
    if (showDetails) {
        const author = metadata.uploader || metadata.creator || metadata.channel || metadata.artist;
        const description = metadata.description;
        if (author) {
            msg += `\n👤 By: ${author}`;
        }
        if (description && description.trim().length > 0) {
            let cleanDesc = description.trim();
            if (cleanDesc.length > 150) {
                cleanDesc = cleanDesc.substring(0, 150) + '...';
            }
            msg += `\n📝 Descrição: ${cleanDesc}`;
        }
    }
    return msg;
}

function sanitizeFilenameForDiscord(filename) {
    let sanitized = String(filename ?? '').replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ');
    sanitized = sanitized.replace(/[<>:"/\\|?*`!,]/g, '');
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    const MAX_FILENAME_LENGTH = 100;
    if (sanitized.length > MAX_FILENAME_LENGTH) {
        const lastSpace = sanitized.lastIndexOf(' ', MAX_FILENAME_LENGTH);
        sanitized = sanitized.substring(0, lastSpace > 0 ? lastSpace : MAX_FILENAME_LENGTH);
    }
    return sanitized;
}

/** Plataforma do link ('youtube', 'youtube_music', 'youtube_shorts', 'instagram', 'tiktok') ou null. */
function detectPlatform(url) {
    const info = normalizeMediaUrl(url);
    return info ? info.platform : null;
}

// ---------------------------------------------------------------------------
// Execução do yt-dlp (sem shell)
// ---------------------------------------------------------------------------

// `deps` existe para testes: { execFileImpl, killImpl, ytdlpPath, ffmpegPath, cookiesPath, extraFlags, limits, tempRoot }.
function resolveRuntime(deps = {}) {
    const cookies = deps.cookiesPath !== undefined ? deps.cookiesPath : config.ytdlpCookiesPath;
    const ffmpeg = deps.ffmpegPath !== undefined ? deps.ffmpegPath : getFfmpegPath();
    // O yt-dlp roda com cwd na subpasta do pedido: caminhos relativos do .env (cookies, ffmpeg, yt-dlp)
    // precisam virar absolutos AQUI, a partir do diretório de trabalho da Yui.
    return {
        execFileImpl: deps.execFileImpl || execFile,
        killImpl: deps.killImpl,
        ytdlpPath: resolveBinaryPath(deps.ytdlpPath || getYtdlpPath()),
        cookiesPath: resolveExistingPath(cookies),
        ffmpegPath: resolveExistingPath(ffmpeg),
        extraFlags: deps.extraFlags || config.ytdlpExtraFlags || [],
        limits: { ...readDownloadLimits(), ...(deps.limits || {}) },
    };
}

function effectiveLimits(limits, context) {
    if (context && (context.skipLimits === true || LIMIT_EXEMPT_SOURCES.has(context.source))) {
        return { ...limits, maxMinutes: 0 };
    }
    return limits;
}

// Limites de um download de ÁUDIO. Quando o MP3 vai ser enviado ao Discord (nunca no Modo Rádio), a duração também
// respeita o que cabe no limite de upload a 96 kbps, o último degrau da recompressão (cerca de 13 minutos nos 10 MB):
// o yt-dlp recusa o que não caberia, em vez de baixar tudo e falhar no envio. Com YUI_AUDIO_REENCODE=false não há
// garantia de que caiba, então não há essa checagem prévia (vale a checagem de tamanho depois do download).
function audioLimits(limits, context, env = process.env) {
    const base = effectiveLimits(limits, context);
    if (!shouldFitForUpload(context)) return base;
    const cap = audioUploadMaxMinutes(getUploadLimitBytes(context?.guild, env), env);
    if (cap <= 0) return base;
    return { ...base, maxMinutes: base.maxMinutes > 0 ? Math.min(base.maxMinutes, cap) : cap };
}

function flagOptions(runtime, limits, info) {
    return {
        playlistOnly: info.playlistOnly,
        maxMinutes: limits.maxMinutes,
        maxFilesizeMB: limits.maxFilesizeMB,
        cookiesPath: runtime.cookiesPath,
        extraFlags: runtime.extraFlags,
        ffmpegPath: runtime.ffmpegPath,
    };
}

/** Argumentos do yt-dlp para áudio MP3 (ARRAY, sem aspas). `url` precisa ser a URL canônica. */
function buildYtdlpAudioFlags(outputPath, url, options = {}) {
    const runtime = resolveRuntime();
    return buildAudioArgs(outputPath, url, { ...flagOptions(runtime, runtime.limits, { playlistOnly: false }), ...options });
}

/** Argumentos do yt-dlp para vídeo (ARRAY, sem aspas). `url` precisa ser a URL canônica. */
function buildYtdlpVideoFlags(outputPath, url, options = {}) {
    const runtime = resolveRuntime();
    return buildVideoArgs(outputPath, url, { ...flagOptions(runtime, runtime.limits, { playlistOnly: false }), ...options });
}

function sweepIfDue(root) {
    const now = Date.now();
    if (now - (lastSweepAt.get(root) || 0) < SWEEP_INTERVAL_MS) return;
    lastSweepAt.set(root, now);
    try {
        const removed = sweepStaleRequestDirs(root);
        if (removed > 0) logger.info(`[MediaHandler] Faxina: ${removed} pasta(s) temporária(s) antiga(s) removida(s).`);
    } catch (err) {
        logger.warn(`[MediaHandler] Faxina de temporários falhou: ${err.message}`);
    }
}

function lastLine(text) {
    const lines = String(text || '').trim().split(/\r?\n/);
    return (lines[lines.length - 1] || '').slice(0, 300);
}

const MB = 1024 * 1024;

function fileTooLargeMessage(limits) {
    return limits.maxFilesizeMB > 0
        ? `Esse conteúdo passa do limite de ${limits.maxFilesizeMB} MB para download.`
        : MEDIA_MESSAGES.FILE_TOO_LARGE;
}

function tooLongMessage(limits) {
    return limits.maxMinutes > 0
        ? `Esse conteúdo passa do limite de ${limits.maxMinutes} minutos (ou é uma transmissão ao vivo).`
        : MEDIA_MESSAGES.MEDIA_TOO_LONG;
}

// Primeira linha de stdout que é um objeto JSON (o `--print-json` do yt-dlp imprime uma linha por item).
function findJsonObject(stdout) {
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const trimmed = line.trim();
        if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed && typeof parsed === 'object') return parsed;
        } catch { /* tenta a próxima linha */ }
    }
    return null;
}

// Tamanho (bytes) que o yt-dlp informou para o item escolhido; 0 = desconhecido.
function knownSizeBytes(meta) {
    const sizeOf = (entry) => {
        const n = Number(entry && (entry.filesize ?? entry.filesize_approx));
        return Number.isFinite(n) && n > 0 ? n : 0;
    };
    const direct = sizeOf(meta);
    if (direct) return direct;
    if (Array.isArray(meta.requested_formats)) {
        return meta.requested_formats.reduce((sum, format) => sum + sizeOf(format), 0);
    }
    return 0;
}

// O yt-dlp sai com código 0 e SEM baixar nada em dois casos silenciosos (com `--print-json` ele
// roda em modo quieto, sem nenhuma mensagem), e a diferença está no JSON da saída:
//  - o --match-filters rejeitou o conteúdo (duração acima do limite ou transmissão ao vivo): SEM JSON;
//  - o arquivo passa do --max-filesize: o JSON do item é impresso (antes do download), mas nenhum arquivo aparece.
function missingOutputError(run, limits) {
    const meta = findJsonObject(run.stdout);
    if (meta && limits.maxFilesizeMB > 0) {
        const size = knownSizeBytes(meta);
        if (size === 0 || size > limits.maxFilesizeMB * MB) {
            return new MediaError('FILE_TOO_LARGE', fileTooLargeMessage(limits),
                { detail: `JSON sem arquivo com limite de tamanho ativo (tamanho informado: ${size ? `${(size / MB).toFixed(1)} MB` : 'desconhecido'})` });
        }
    }
    if (!meta && limits.maxMinutes > 0) {
        return new MediaError('MEDIA_TOO_LONG', tooLongMessage(limits),
            { detail: 'saída vazia com filtro de duração ativo' });
    }
    return new MediaError('OUTPUT_NOT_FOUND', MEDIA_MESSAGES.OUTPUT_NOT_FOUND);
}

// Converte a saída/erro do yt-dlp num MediaError amigável (o detalhe técnico fica em `.detail`).
function classifyYtdlpFailure(run, kind, limits) {
    const text = `${run.stderr}\n${run.stdout}`;
    const detail = lastLine(run.stderr) || (run.error && run.error.message) || '';
    const make = (code, message) => new MediaError(code, message, { detail, cause: run.error || undefined });

    if (isMissingBinary(run)) return make('YTDLP_NOT_INSTALLED', MEDIA_MESSAGES.YTDLP_NOT_INSTALLED);
    if (run.timedOut) return make('DOWNLOAD_TIMEOUT', MEDIA_MESSAGES.DOWNLOAD_TIMEOUT);
    if (/larger than max-filesize/i.test(text)) return make('FILE_TOO_LARGE', fileTooLargeMessage(limits));
    if (/does not pass filter/i.test(text)) return make('MEDIA_TOO_LONG', tooLongMessage(limits));
    if (/Private video|Video unavailable|This video is (?:private|unavailable|not available)|has been removed/i.test(text)) {
        return make('VIDEO_PRIVATE', MEDIA_MESSAGES.VIDEO_PRIVATE);
    }
    if (/age-restricted|confirm your age/i.test(text)) return make('VIDEO_AGE_RESTRICTED', MEDIA_MESSAGES.VIDEO_AGE_RESTRICTED);
    if (/not a bot/i.test(text)) return make('YOUTUBE_BOT_CHECK', MEDIA_MESSAGES.YOUTUBE_BOT_CHECK);
    if (kind === 'audio' && /no appropriate format|Requested format is not available/i.test(text)) {
        return make('FORMAT_UNAVAILABLE', MEDIA_MESSAGES.FORMAT_UNAVAILABLE);
    }
    return kind === 'video'
        ? make('YTDLP_ERROR', MEDIA_MESSAGES.YTDLP_VIDEO_ERROR)
        : make('YTDLP_ERROR', MEDIA_MESSAGES.YTDLP_ERROR);
}

// Ocupado = o usuário já tem um download em andamento OU o teto global de downloads simultâneos foi atingido
// (YUI_DL_MAX_CONCURRENT, padrão 3; o dono nunca é barrado pelo teto global).
function getBusyReason(userId, env = process.env) {
    if (activeUserProcesses.has(userId)) return 'user';
    const max = readMaxConcurrentDownloads(env);
    if (max > 0 && activeUserProcesses.size >= max && !canBypass(userId)) return 'global';
    return null;
}

function isUserBusy(userId) {
    return getBusyReason(userId) !== null;
}

function lockUser(userId) {
    activeUserProcesses.add(userId);
}

function unlockUser(userId) {
    activeUserProcesses.delete(userId);
}

function canBypass(userId) {
    return config.isOwner(userId);
}

function getMemoryUsagePercent() {
    const total = os.totalmem();
    const free = os.freemem();
    return ((total - free) / total) * 100;
}

function parseMetadata(stdout, fallbackId) {
    const text = String(stdout || '');
    // O yt-dlp (--print-json) imprime o JSON do item em uma linha.
    let videoMetadata = findJsonObject(text);
    if (!videoMetadata) {
        videoMetadata = {};
        try {
            const jsonLineMatch = text.match(/^\{.*\}$/ms);
            if (jsonLineMatch) videoMetadata = JSON.parse(jsonLineMatch[0]);
        } catch { /* cai no título genérico */ }
    }
    if (!videoMetadata.title || typeof videoMetadata.title !== 'string') {
        const titleMatch = text.match(/\[ExtractAudio\] Destination: .*? - (.+?)\./);
        videoMetadata.title = titleMatch && titleMatch[1] ? titleMatch[1].trim() : `Media_${fallbackId}`;
    }
    return videoMetadata;
}

// Arquivo gerado na subpasta do pedido: o maior com uma das extensões esperadas.
function findProducedFile(dir, extensions) {
    let best = null;
    let bestSize = -1;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!extensions.includes(path.extname(name).toLowerCase())) continue;
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            if (stat.isFile() && stat.size > bestSize) {
                best = full;
                bestSize = stat.size;
            }
        }
    } catch { /* pasta sumiu */ }
    return best;
}

function renameInsideDir(produced, dir, stem, extension) {
    const target = path.join(dir, `${stem}${extension}`);
    if (target === produced) return produced;
    try {
        fs.renameSync(produced, target);
        return target;
    } catch {
        return produced;
    }
}

/**
 * Baixa o áudio (MP3) de um link do YouTube, Instagram ou TikTok.
 * Devolve { filePath, metadata, playlistIgnored, playlistOnly, cleanup }:
 *  - playlistIgnored: o link tinha uma playlist (list=) junto do vídeo; baixou só o vídeo;
 *  - playlistOnly: o link era uma playlist/perfil/coleção; baixou só o 1º item;
 *  - cleanup(): apaga a subpasta temporária inteira do pedido (idempotente).
 * Erros são `MediaError` (`error.code`, `error.userMessage`).
 */
async function downloadAudio(videoUrl, context = null, deps = {}) {
    const info = normalizeMediaUrl(videoUrl);
    if (!info) {
        logMediaAction('Download Áudio', null, null, context, 'Erro', 'Código: URL_INVALID');
        throw new MediaError('URL_INVALID', MEDIA_MESSAGES.URL_INVALID);
    }

    const runtime = resolveRuntime(deps);
    const limits = audioLimits(runtime.limits, context, deps.env || process.env);
    const tempRoot = deps.tempRoot || TEMP_AUDIO_DIR;
    sweepIfDue(tempRoot);
    const tempDir = createRequestDir(tempRoot);
    const startedAt = Date.now();
    const note = info.playlistOnly ? 'Playlist: só o 1º item' : (info.playlistIgnored ? 'Playlist ignorada: só o vídeo' : '');
    logMediaAction('Download Áudio', info.platform, info.url, context, 'Iniciado', note);

    try {
        const args = buildAudioArgs(path.join(tempDir, 'media.%(ext)s'), info.url, flagOptions(runtime, limits, info));
        const run = await runTool(runtime.ytdlpPath, args, {
            timeoutMs: limits.timeoutMs,
            maxBuffer: MAX_BUFFER,
            cwd: tempDir,
            execFileImpl: runtime.execFileImpl,
            killImpl: runtime.killImpl,
        });
        if (run.error) throw classifyYtdlpFailure(run, 'audio', limits);

        const produced = findProducedFile(tempDir, ['.mp3']);
        if (!produced) throw missingOutputError(run, limits);

        const metadata = parseMetadata(run.stdout, info.id || crypto.randomUUID().slice(0, 8));
        const filePath = renameInsideDir(produced, tempDir, safeFileStem(metadata.title, 'audio'), '.mp3');
        // Entrega ao Discord: recomprime se passar do limite de upload e limpa as tags de origem (não vale para o Modo Rádio).
        const prepared = await prepareAudioForDelivery(filePath, {
            context,
            env: deps.env,
            durationSeconds: Number(metadata.duration),
            ffmpegPath: runtime.ffmpegPath || resolveBinaryPath(deps.ffmpegPath || getFfmpegPath()),
            execFileImpl: runtime.execFileImpl,
            killImpl: runtime.killImpl,
            ...(deps.audioFit || {}),
        });
        const preparedNote = describePrepared(prepared);
        const sizeMB = (fs.statSync(filePath).size / (1024 * 1024)).toFixed(1);
        logMediaAction('Download Áudio', info.platform, info.url, context, 'Sucesso',
            `Título: "${metadata.title}" | Tamanho: ${sizeMB} MB | Tempo: ${((Date.now() - startedAt) / 1000).toFixed(1)}s${preparedNote ? ` | ${preparedNote}` : ''}`);
        return {
            filePath,
            metadata,
            playlistIgnored: info.playlistIgnored,
            playlistOnly: info.playlistOnly,
            cleanup: () => removeRequestDir(tempRoot, tempDir),
        };
    } catch (err) {
        removeRequestDir(tempRoot, tempDir);
        const mediaError = err instanceof MediaError
            ? err
            : new MediaError('YTDLP_ERROR', MEDIA_MESSAGES.YTDLP_ERROR, { cause: err, detail: err && err.message });
        logMediaAction('Download Áudio', info.platform, info.url, context, 'Erro',
            `Código: ${mediaError.code}${mediaError.detail ? ` | Detalhe: ${mediaError.detail}` : ''}`);
        throw mediaError;
    }
}

/**
 * Baixa um vídeo (mp4) de Shorts, Instagram Reels ou TikTok. Vídeos comuns do YouTube continuam
 * bloqueados de propósito (YOUTUBE_FULL_VIDEO).
 * Devolve { filePath, metadata, fileSize, playlistIgnored, playlistOnly, cleanup }.
 */
async function downloadVideo(videoUrl, context = null, deps = {}) {
    const info = normalizeMediaUrl(videoUrl);
    if (!info) {
        logMediaAction('Download Vídeo', null, null, context, 'Erro', 'Código: URL_INVALID');
        throw new MediaError('URL_INVALID', MEDIA_MESSAGES.URL_INVALID);
    }
    if (info.platform === 'youtube' || info.platform === 'youtube_music') {
        logMediaAction('Download Vídeo', info.platform, info.url, context, 'Erro', 'Código: YOUTUBE_FULL_VIDEO');
        throw new MediaError('YOUTUBE_FULL_VIDEO', MEDIA_MESSAGES.YOUTUBE_FULL_VIDEO);
    }

    const runtime = resolveRuntime(deps);
    const limits = effectiveLimits(runtime.limits, context);
    const tempRoot = deps.tempRoot || TEMP_VIDEO_DIR;
    sweepIfDue(tempRoot);
    const tempDir = createRequestDir(tempRoot);
    const startedAt = Date.now();
    logMediaAction('Download Vídeo', info.platform, info.url, context, 'Iniciado', info.playlistOnly ? 'Coleção/perfil: só o 1º item' : '');

    try {
        const args = buildVideoArgs(path.join(tempDir, 'media.%(ext)s'), info.url, flagOptions(runtime, limits, info));
        const run = await runTool(runtime.ytdlpPath, args, {
            timeoutMs: limits.timeoutMs,
            maxBuffer: MAX_BUFFER,
            cwd: tempDir,
            execFileImpl: runtime.execFileImpl,
            killImpl: runtime.killImpl,
        });
        if (run.error) throw classifyYtdlpFailure(run, 'video', limits);

        const produced = findProducedFile(tempDir, ['.mp4', '.webm', '.mkv', '.mov']);
        if (!produced) throw missingOutputError(run, limits);

        const metadata = parseMetadata(run.stdout, info.id || crypto.randomUUID().slice(0, 8));
        const filePath = renameInsideDir(produced, tempDir, safeFileStem(metadata.title, 'video'), '.mp4');
        const fileSize = fs.statSync(filePath).size;
        const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
        logMediaAction('Download Vídeo', info.platform, info.url, context, 'Sucesso',
            `Título: "${metadata.title}" | Tamanho: ${sizeMB} MB | Tempo: ${((Date.now() - startedAt) / 1000).toFixed(1)}s`);
        return {
            filePath,
            metadata,
            fileSize,
            playlistIgnored: info.playlistIgnored,
            playlistOnly: info.playlistOnly,
            cleanup: () => removeRequestDir(tempRoot, tempDir),
        };
    } catch (err) {
        removeRequestDir(tempRoot, tempDir);
        const mediaError = err instanceof MediaError
            ? err
            : new MediaError('YTDLP_ERROR', MEDIA_MESSAGES.YTDLP_VIDEO_ERROR, { cause: err, detail: err && err.message });
        logMediaAction('Download Vídeo', info.platform, info.url, context, 'Erro',
            `Código: ${mediaError.code}${mediaError.detail ? ` | Detalhe: ${mediaError.detail}` : ''}`);
        throw mediaError;
    }
}

/** Libera o resultado de um download: apaga a subpasta do pedido (ou, na falta dela, só o arquivo). */
function cleanupDownload(result) {
    if (!result) return;
    try {
        if (typeof result.cleanup === 'function') {
            result.cleanup();
        } else if (result.filePath && fs.existsSync(result.filePath)) {
            fs.unlinkSync(result.filePath);
        }
    } catch (err) {
        logger.warn(`[MediaHandler] Falha ao limpar temporários: ${err.message}`);
    }
}

function storeVideoForCompression(filePath) {
    const fileId = crypto.randomUUID().slice(0, 12);
    pendingVideoFiles.set(fileId, { filePath, createdAt: Date.now() });

    const timer = setTimeout(() => {
        const entry = pendingVideoFiles.get(fileId);
        if (entry) {
            pendingVideoFiles.delete(fileId);
            try {
                if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
            } catch (e) {}
            logger.info(`[MediaHandler] Arquivo expirado removido: ${fileId}`);
        }
    }, 6 * 60 * 60 * 1000);
    if (typeof timer.unref === 'function') timer.unref();

    return fileId;
}

function getPendingVideo(fileId) {
    return pendingVideoFiles.get(fileId);
}

function removePendingVideo(fileId) {
    const entry = pendingVideoFiles.get(fileId);
    if (entry) {
        pendingVideoFiles.delete(fileId);
        try {
            if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
        } catch (e) {}
    }
}

async function compressVideo(inputPath, attachmentLimit) {
    return new Promise((resolve, reject) => {
        const outputPath = inputPath.replace(/\.[^.]+$/, '_compressed.mp4');
        const targetBytes = Math.floor(attachmentLimit * 0.95);
        const fileStat = fs.statSync(inputPath);
        const durationEstimate = Math.max(30, Math.min(300, fileStat.size / 500000));
        const targetBitrate = Math.floor((targetBytes * 8) / durationEstimate / 1000);
        const videoBitrate = Math.max(200, Math.min(targetBitrate - 64, 2000));

        const ffmpegArgs = [
            '-i', inputPath,
            '-vf', 'scale=-2:480',
            '-vcodec', 'libx264',
            '-crf', '28',
            '-preset', 'faster',
            '-acodec', 'aac',
            '-b:a', '64k',
            '-threads', '1',
            '-y',
            outputPath
        ];

        const ffmpegBin = getFfmpegPath();
        logger.info(`[MediaHandler] Comprimindo vídeo de ${(fileStat.size / (1024 * 1024)).toFixed(1)} MB (limite ${(attachmentLimit / (1024 * 1024)).toFixed(0)} MB)`);
        const ffmpegProcess = spawn(ffmpegBin, ffmpegArgs, { windowsHide: true });
        let killed = false;

        const memoryMonitor = setInterval(() => {
            const usage = getMemoryUsagePercent();
            if (usage > 95) {
                killed = true;
                ffmpegProcess.kill('SIGKILL');
                clearInterval(memoryMonitor);
                logger.error(`[MediaHandler] FFmpeg encerrado - RAM em ${usage.toFixed(1)}%`);
            }
        }, 1000);

        ffmpegProcess.on('close', (code) => {
            clearInterval(memoryMonitor);
            if (killed) {
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                return reject(new Error(`MEMORY_ERROR`));
            }
            if (code !== 0) {
                try { if (fs.existsSync(outputPath)) fs.unlinkSync(outputPath); } catch (e) {}
                return reject(new Error(`FFmpeg falhou com código ${code}`));
            }
            if (!fs.existsSync(outputPath)) {
                return reject(new Error("Arquivo comprimido não encontrado após processamento."));
            }
            const compressedSize = fs.statSync(outputPath).size;
            if (compressedSize > attachmentLimit) {
                try { fs.unlinkSync(outputPath); } catch (e) {}
                return reject(new Error("STILL_TOO_LARGE: O vídeo continua muito grande mesmo após compressão. Tente um vídeo mais curto."));
            }
            resolve({ filePath: outputPath, fileSize: compressedSize });
        });

        ffmpegProcess.on('error', (err) => {
            clearInterval(memoryMonitor);
            reject(new Error(`Erro ao iniciar FFmpeg: ${err.message}`));
        });
    });
}

async function processCompressionQueue() {
    if (isCompressing || compressionQueue.length === 0) return;
    isCompressing = true;
    const task = compressionQueue.shift();

    try {
        const result = await compressVideo(task.inputPath, task.attachmentLimit);
        task.resolve(result);
    } catch (error) {
        task.reject(error);
    } finally {
        isCompressing = false;
        processCompressionQueue();
    }
}

function enqueueCompression(inputPath, attachmentLimit, userId) {
    if (canBypass(userId)) {
        return compressVideo(inputPath, attachmentLimit);
    }

    return new Promise((resolve, reject) => {
        compressionQueue.push({ inputPath, attachmentLimit, userId, resolve, reject });
        processCompressionQueue();
    });
}

function getCompressionQueuePosition(userId) {
    const idx = compressionQueue.findIndex(t => t.userId === userId);
    return idx === -1 ? compressionQueue.length : idx;
}

function isCompressionActive() {
    return isCompressing;
}

export {
    downloadAudio, downloadVideo, cleanupDownload, sanitizeFilenameForDiscord, detectPlatform,
    buildYtdlpAudioFlags, buildYtdlpVideoFlags,
    isUserBusy, getBusyReason, lockUser, unlockUser, canBypass, storeVideoForCompression,
    getPendingVideo, removePendingVideo, enqueueCompression,
    getCompressionQueuePosition, isCompressionActive, getMemoryUsagePercent,
    logCompressionAction, formatVideoSuccessMessage
};

export default {
    downloadAudio,
    downloadVideo,
    cleanupDownload,
    sanitizeFilenameForDiscord,
    detectPlatform,
    buildYtdlpAudioFlags,
    buildYtdlpVideoFlags,
    isUserBusy,
    getBusyReason,
    lockUser,
    unlockUser,
    canBypass,
    storeVideoForCompression,
    getPendingVideo,
    removePendingVideo,
    enqueueCompression,
    getCompressionQueuePosition,
    isCompressionActive,
    getMemoryUsagePercent,
    logCompressionAction,
    formatVideoSuccessMessage,
    YOUTUBE_SHORTS_REGEX,
    INSTAGRAM_REGEX,
    TIKTOK_REGEX
};
