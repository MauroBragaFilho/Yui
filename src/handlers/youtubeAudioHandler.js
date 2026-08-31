import { exec, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { getYtdlpPath, getFfmpegPath } from '../utils/binaries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_AUDIO_DIR = path.join(__dirname, '../data/temp_audio');
const TEMP_VIDEO_DIR = path.join(__dirname, '../data/temp_videos');
if (!fs.existsSync(TEMP_AUDIO_DIR)) fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
if (!fs.existsSync(TEMP_VIDEO_DIR)) fs.mkdirSync(TEMP_VIDEO_DIR, { recursive: true });

const YOUTUBE_VIDEO_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtube\.com|youtu\.be)\/(?:watch\?v=|embed\/|v\/|shorts\/)?([a-zA-Z0-9_-]{11,})(?:\S+)?$/;
const YOUTUBE_MUSIC_REGEX = /^(?:https?:\/\/)?(?:www\.)?music\.youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11,})(?:\S+)?$/;
const YOUTUBE_PLAYLIST_REGEX = /(?:youtube\.com|youtu\.be)\/playlist\?list=|youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11,}&list=([a-zA-Z0-9_-]+)|music\.youtube\.com\/playlist\?list=|music\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11,}&list=/;
const YOUTUBE_SHORTS_REGEX = /^(?:https?:\/\/)?(?:www\.)?(?:m\.)?(?:youtube\.com|youtu\.be)\/shorts\/([a-zA-Z0-9_-]{11,})(?:\S+)?$/;
const INSTAGRAM_REGEX = /^(?:https?:\/\/)?(?:www\.)?instagram\.com\/(?:reel|reels)\/([a-zA-Z0-9_-]+)/;
const TIKTOK_REGEX = /^(?:https?:\/\/)?(?:[a-z0-9-]+\.)?tiktok\.com\/.+/;

const activeUserProcesses = new Set();
let isCompressing = false;
const compressionQueue = [];
const pendingVideoFiles = new Map();

function getYtdlpCmd() {
    return `"${getYtdlpPath()}"`;
}

function logMediaAction(type, platform, url, context, status, extra = '') {
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
    const platformStr = platform ? ` [${platform.toUpperCase()}]` : '';
    const extraStr = extra ? ` | ${extra}` : '';
    console.log(`[LOG] ${type} (${source})${platformStr} | Usuário: ${userStr} | Local: ${localStr} | URL: ${url} | Status: ${status}${extraStr}`);
}

function logCompressionAction(context, status, extra = '') {
    let userStr = 'N/A';
    let localStr = 'DM';
    if (context) {
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
    const extraStr = extra ? ` | ${extra}` : '';
    console.log(`[LOG] Compressão (Botão) | Usuário: ${userStr} | Local: ${localStr} | Status: ${status}${extraStr}`);
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
    let sanitized = filename.replace(/[<>:"/\\|?*`!,]/g, '');
    sanitized = sanitized.replace(/\s+/g, ' ').trim();
    const MAX_FILENAME_LENGTH = 100;
    if (sanitized.length > MAX_FILENAME_LENGTH) {
        const lastSpace = sanitized.lastIndexOf(' ', MAX_FILENAME_LENGTH);
        sanitized = sanitized.substring(0, lastSpace > 0 ? lastSpace : MAX_FILENAME_LENGTH);
    }
    return sanitized;
}

function detectPlatform(url) {
    if (YOUTUBE_SHORTS_REGEX.test(url)) return 'youtube_shorts';
    if (YOUTUBE_MUSIC_REGEX.test(url)) return 'youtube_music';
    if (YOUTUBE_VIDEO_REGEX.test(url)) return 'youtube';
    if (INSTAGRAM_REGEX.test(url)) return 'instagram';
    if (TIKTOK_REGEX.test(url)) return 'tiktok';
    return null;
}

function buildYtdlpAudioFlags(outputPath, url) {
    const flags = ['--no-playlist', '-x', '--audio-format', 'mp3'];
    const cookiesPath = config.ytdlpCookiesPath;
    if (cookiesPath && fs.existsSync(cookiesPath)) {
        flags.push('--cookies', `"${cookiesPath}"`);
    }
    flags.push(...config.ytdlpExtraFlags);
    const ffmpegPath = getFfmpegPath();
    if (fs.existsSync(ffmpegPath)) {
        flags.push('--ffmpeg-location', `"${ffmpegPath}"`);
    }
    flags.push('-o', `"${outputPath}"`, '--print-json', `"${url}"`);
    return flags.join(' ');
}

function buildYtdlpVideoFlags(outputPath, url) {
    const flags = ['--no-playlist', '-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best'];
    const cookiesPath = config.ytdlpCookiesPath;
    if (cookiesPath && fs.existsSync(cookiesPath)) {
        flags.push('--cookies', `"${cookiesPath}"`);
    }
    flags.push(...config.ytdlpExtraFlags);
    const ffmpegPath = getFfmpegPath();
    if (fs.existsSync(ffmpegPath)) {
        flags.push('--ffmpeg-location', `"${ffmpegPath}"`);
    }
    flags.push('-o', `"${outputPath}"`, '--print-json', `"${url}"`);
    return flags.join(' ');
}

function isUserBusy(userId) {
    return activeUserProcesses.has(userId);
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
    let videoMetadata = {};
    try {
        const jsonLineMatch = stdout.match(/^\{.*\}$/ms);
        if (jsonLineMatch) {
            videoMetadata = JSON.parse(jsonLineMatch[0]);
        } else {
            const titleMatch = stdout.match(/\[ExtractAudio\] Destination: .*? - (.+?)\./);
            if (titleMatch && titleMatch[1]) {
                videoMetadata.title = titleMatch[1].trim();
            } else {
                videoMetadata.title = `Media_${fallbackId}`;
            }
        }
    } catch (parseError) {
        videoMetadata.title = `Media_${fallbackId}`;
    }
    if (!videoMetadata.title) videoMetadata.title = `Media_${fallbackId}`;
    return videoMetadata;
}

function extractVideoId(url, platform) {
    let match;
    switch (platform) {
        case 'youtube_shorts':
            match = url.match(YOUTUBE_SHORTS_REGEX);
            return match ? match[1] : crypto.randomUUID().slice(0, 11);
        case 'youtube_music':
            match = url.match(YOUTUBE_MUSIC_REGEX);
            return match ? match[1] : crypto.randomUUID().slice(0, 11);
        case 'youtube':
            match = url.match(YOUTUBE_VIDEO_REGEX);
            return match ? match[1] : crypto.randomUUID().slice(0, 11);
        case 'instagram':
            match = url.match(INSTAGRAM_REGEX);
            return match ? match[1] : crypto.randomUUID().slice(0, 8);
        case 'tiktok':
            return crypto.randomUUID().slice(0, 8);
        default:
            return crypto.randomUUID().slice(0, 8);
    }
}

async function downloadAudio(videoUrl, context = null) {
    return new Promise((resolve, reject) => {
        const platform = detectPlatform(videoUrl);
        if (!platform) {
            const err = new Error("URL_INVALID: A URL fornecida não é de uma plataforma suportada (YouTube, Instagram ou TikTok).");
            logMediaAction('Download Áudio', platform, videoUrl, context, 'Erro', `Detalhe: ${err.message}`);
            return reject(err);
        }
        if (YOUTUBE_PLAYLIST_REGEX.test(videoUrl)) {
            const err = new Error("PLAYLIST_DETECTED: O download de playlists não é suportado no momento. Por favor, forneça uma URL de vídeo individual.");
            logMediaAction('Download Áudio', platform, videoUrl, context, 'Erro', `Detalhe: ${err.message}`);
            return reject(err);
        }
        let processedUrl = videoUrl;
        if (platform === 'youtube_music') {
            const match = videoUrl.match(YOUTUBE_MUSIC_REGEX);
            if (match && match[1]) {
                processedUrl = `https://www.youtube.com/watch?v=${match[1]}`;
            }
        }
        const videoId = extractVideoId(videoUrl, platform);
        const tempOutputFilename = `${videoId}.mp3`;
        const tempOutputFilePath = path.join(TEMP_AUDIO_DIR, tempOutputFilename);
        const command = `${getYtdlpCmd()} ${buildYtdlpAudioFlags(tempOutputFilePath, processedUrl)}`;
        logMediaAction('Download Áudio', platform, videoUrl, context, 'Iniciado');
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[MediaHandler] FALHA NO YT-DLP (Áudio):\nSTDOUT: ${stdout}\nSTDERR: ${stderr}\nERROR: ${error.message}`);
                let errObj = error;
                if (stderr.includes("Private video") || stdout.includes("Private video")) {
                    errObj = new Error("VIDEO_PRIVATE: Este vídeo é privado ou não está disponível.");
                } else if (stderr.includes("age-restricted") || stdout.includes("age-restricted")) {
                    errObj = new Error("VIDEO_AGE_RESTRICTED: Este vídeo é restrito por idade.");
                } else if (stderr.includes("no appropriate format") || stdout.includes("no appropriate format")) {
                    errObj = new Error("FORMAT_UNAVAILABLE: Não foi encontrado um formato de áudio adequado.");
                } else if (error.code === 'ENOENT' || /not recognized|não é reconhecido|command not found/i.test(stderr)) {
                    errObj = new Error('YTDLP_NOT_INSTALLED: O yt-dlp não está instalado ou não está disponível no PATH da máquina. Instale-o e reinicie o bot.');
                } else {
                    errObj = new Error(`YTDLP_ERROR: O yt-dlp falhou: ${stderr.trim().split('\n').pop() || error.message}`);
                }
                logMediaAction('Download Áudio', platform, videoUrl, context, 'Erro', `Detalhe: ${errObj.message}`);
                return reject(errObj);
            }
            const videoMetadata = parseMetadata(stdout, videoId);
            const sanitizedTitle = sanitizeFilenameForDiscord(videoMetadata.title);
            const finalFilePath = path.join(TEMP_AUDIO_DIR, `${sanitizedTitle}.mp3`);
            const renameAndResolve = (src, dest) => {
                const sizeMB = (fs.statSync(src).size / (1024 * 1024)).toFixed(1);
                logMediaAction('Download Áudio', platform, videoUrl, context, 'Sucesso', `Título: "${videoMetadata.title}" | Tamanho: ${sizeMB} MB`);
                resolve({ filePath: dest, metadata: videoMetadata });
            };
            if (fs.existsSync(tempOutputFilePath)) {
                fs.rename(tempOutputFilePath, finalFilePath, (renameErr) => {
                    if (renameErr) {
                        renameAndResolve(tempOutputFilePath, tempOutputFilePath);
                    } else {
                        renameAndResolve(finalFilePath, finalFilePath);
                    }
                });
            } else {
                const err = new Error("O áudio não foi encontrado na pasta temporária após o download. Tente novamente ou com outro vídeo.");
                logMediaAction('Download Áudio', platform, videoUrl, context, 'Erro', `Detalhe: ${err.message}`);
                reject(err);
            }
        });
    });
}

async function downloadVideo(videoUrl, context = null) {
    return new Promise((resolve, reject) => {
        const platform = detectPlatform(videoUrl);
        if (!platform) {
            const err = new Error("URL_INVALID: A URL fornecida não é de uma plataforma suportada.");
            logMediaAction('Download Vídeo', platform, videoUrl, context, 'Erro', `Detalhe: ${err.message}`);
            return reject(err);
        }
        if (platform === 'youtube' || platform === 'youtube_music') {
            const err = new Error("YOUTUBE_FULL_VIDEO: Para vídeos do YouTube, apenas Shorts são suportados para download de vídeo. Use /baixar_musica para extrair o áudio.");
            logMediaAction('Download Vídeo', platform, videoUrl, context, 'Erro', `Detalhe: ${err.message}`);
            return reject(err);
        }
        if (YOUTUBE_PLAYLIST_REGEX.test(videoUrl)) {
            const err = new Error("PLAYLIST_DETECTED: O download de playlists não é suportado.");
            logMediaAction('Download Vídeo', platform, videoUrl, context, 'Erro', `Detalhe: ${err.message}`);
            return reject(err);
        }
        let processedUrl = videoUrl;
        const videoId = extractVideoId(videoUrl, platform);
        const tempOutputFilename = `${videoId}.mp4`;
        const tempOutputFilePath = path.join(TEMP_VIDEO_DIR, tempOutputFilename);
        const command = `${getYtdlpCmd()} ${buildYtdlpVideoFlags(tempOutputFilePath, processedUrl)}`;
        logMediaAction('Download Vídeo', platform, videoUrl, context, 'Iniciado');
        exec(command, { maxBuffer: 1024 * 1024 * 10 }, (error, stdout, stderr) => {
            if (error) {
                console.error(`[MediaHandler] FALHA NO YT-DLP (Vídeo):\nSTDOUT: ${stdout}\nSTDERR: ${stderr}\nERROR: ${error.message}`);
                let errObj = error;
                if (stderr.includes("Private video") || stdout.includes("Private video")) {
                    errObj = new Error("VIDEO_PRIVATE: Este vídeo é privado ou não está disponível.");
                } else if (stderr.includes("age-restricted") || stdout.includes("age-restricted")) {
                    errObj = new Error("VIDEO_AGE_RESTRICTED: Este vídeo é restrito por idade.");
                } else {
                    errObj = new Error(`lib do ytdlp desatualizada, peça o <@${config.ownerId}> para atualizar na host`);
                }
                logMediaAction('Download Vídeo', platform, videoUrl, context, 'Erro', `Detalhe: ${errObj.message}`);
                return reject(errObj);
            }
            const videoMetadata = parseMetadata(stdout, videoId);
            const sanitizedTitle = sanitizeFilenameForDiscord(videoMetadata.title);
            const possiblePaths = [
                tempOutputFilePath,
                tempOutputFilePath.replace('.mp4', '.webm'),
                tempOutputFilePath.replace('.mp4', '.mkv')
            ];
            let foundPath = possiblePaths.find(p => fs.existsSync(p));
            if (foundPath) {
                const finalFilePath = path.join(TEMP_VIDEO_DIR, `${sanitizedTitle}.mp4`);
                if (foundPath !== finalFilePath) {
                    try {
                        fs.renameSync(foundPath, finalFilePath);
                        foundPath = finalFilePath;
                    } catch (e) {}
                }
                const fileSize = fs.statSync(foundPath).size;
                const sizeMB = (fileSize / (1024 * 1024)).toFixed(1);
                logMediaAction('Download Vídeo', platform, videoUrl, context, 'Sucesso', `Título: "${videoMetadata.title}" | Tamanho: ${sizeMB} MB`);
                resolve({ filePath: foundPath, metadata: videoMetadata, fileSize });
            } else {
                const err = new Error("O vídeo não foi encontrado na pasta temporária após o download. Tente novamente.");
                logMediaAction('Download Vídeo', platform, videoUrl, context, 'Erro', `Detalhe: ${err.message}`);
                reject(err);
            }
        });
    });
}

function storeVideoForCompression(filePath) {
    const fileId = crypto.randomUUID().slice(0, 12);
    pendingVideoFiles.set(fileId, { filePath, createdAt: Date.now() });

    setTimeout(() => {
        const entry = pendingVideoFiles.get(fileId);
        if (entry) {
            pendingVideoFiles.delete(fileId);
            try {
                if (fs.existsSync(entry.filePath)) fs.unlinkSync(entry.filePath);
            } catch (e) {}
            console.log(`[MediaHandler] Arquivo expirado removido: ${fileId}`);
        }
    }, 6 * 60 * 60 * 1000);

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
        console.log(`[MediaHandler] Comprimindo: ${ffmpegBin} ${ffmpegArgs.join(' ')}`);
        const ffmpegProcess = spawn(ffmpegBin, ffmpegArgs);
        let killed = false;

        const memoryMonitor = setInterval(() => {
            const usage = getMemoryUsagePercent();
            if (usage > 95) {
                killed = true;
                ffmpegProcess.kill('SIGKILL');
                clearInterval(memoryMonitor);
                console.error(`[MediaHandler] FFmpeg KILLED - RAM em ${usage.toFixed(1)}%`);
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
    downloadAudio, downloadVideo, sanitizeFilenameForDiscord, detectPlatform,
    isUserBusy, lockUser, unlockUser, canBypass, storeVideoForCompression,
    getPendingVideo, removePendingVideo, enqueueCompression,
    getCompressionQueuePosition, isCompressionActive, getMemoryUsagePercent,
    logCompressionAction, formatVideoSuccessMessage
};

export default {
    downloadAudio,
    downloadVideo,
    sanitizeFilenameForDiscord,
    detectPlatform,
    isUserBusy,
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
