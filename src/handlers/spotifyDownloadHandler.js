import { exec } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { getYtdlpPath, getFfmpegPath } from '../utils/binaries.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEMP_SPOTIFY_DIR = path.join(__dirname, '../data/temp_spotify');
if (!fs.existsSync(TEMP_SPOTIFY_DIR)) fs.mkdirSync(TEMP_SPOTIFY_DIR, { recursive: true });

const SPOTIFY_URL_REGEX = /^(?:https?:\/\/)?(?:open\.|play\.)?spotify\.com\/(?:intl-[a-z]{2}\/)?(track|album|playlist|artist|episode|show)\//i;

const activeUserProcesses = new Set();

// Locks por usuário
export function isUserBusy(userId) {
    return activeUserProcesses.has(userId);
}
export function lockUser(userId) {
    activeUserProcesses.add(userId);
}
export function unlockUser(userId) {
    activeUserProcesses.delete(userId);
}
export function canBypass(userId) {
    return config.isOwner(userId);
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
    if (SPOTIFY_URL_REGEX.test(url)) return 'spotify';
    return null;
}

function logSpotifyAction(type, url, context, status, extra = '') {
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
    const extraStr = extra ? ` | ${extra}` : '';
    console.log(`[LOG] ${type} [SPOTIFY] | Usuário: ${userStr} | Local: ${localStr} | URL: ${url} | Status: ${status}${extraStr}`);
}

/**
 * Baixa uma faixa/playlist do Spotify.
 * Tenta primeiro `spot-dlp` (se disponível no PATH) e, em caso de falha,
 * usa `yt-dlp` como fallback.
 *
 * @param {string} url URL do Spotify (track, album, playlist)
 * @param {object} context Contexto do comando (source, user, guild, etc.)
 * @returns {Promise<{filePath, metadata}>}
 */
export async function downloadSpotify(url, context = null) {
    return new Promise((resolve, reject) => {
        const platform = detectPlatform(url);
        if (platform !== 'spotify') {
            return reject(new Error('SPOTIFY_INVALID_URL: Isso não parece ser um link do Spotify.'));
        }

        const jobToken = `spotify_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const outputPath = path.join(TEMP_SPOTIFY_DIR, `${jobToken}.%(ext)s`);
        const ffmpegPath = getFfmpegPath();

        logSpotifyAction('Download Spotify', url, context, 'Iniciado');

        // ---- Estratégia 1: spot-dlp (binário nativo) ----
        const spotdlCmd = 'spotdl';
        const spotdlArgs = [
            'download',
            `"${url}"`,
            '--format', 'mp3',
            '--output', `"${TEMP_SPOTIFY_DIR}"`,
            '--bitrate', '320k',
        ];
        if (ffmpegPath && fs.existsSync(ffmpegPath)) {
            spotdlArgs.push('--ffmpeg', `"${ffmpegPath}"`);
        }

        exec(`"${spotdlCmd}" ${spotdlArgs.join(' ')}`, { maxBuffer: 1024 * 1024 * 10, cwd: TEMP_SPOTIFY_DIR }, (spotdlErr, spotdlOut, spotdlErrOut) => {
            // Verifica se o spotdl não está instalado
            const spotdlMissing =
                (spotdlErr && (spotdlErr.code === 'ENOENT' || /not recognized|não é reconhecido|command not found/i.test(spotdlErrOut || ''))) ||
                (spotdlErrOut && /not recognized|não é reconhecido|command not found/i.test(spotdlErrOut));

            // Procura o arquivo MP3 mais recente gerado
            const findNewestMp3 = () => {
                let newest = null;
                let newestTime = 0;
                try {
                    const files = fs.readdirSync(TEMP_SPOTIFY_DIR);
                    for (const f of files) {
                        if (f.endsWith('.mp3')) {
                            const fp = path.join(TEMP_SPOTIFY_DIR, f);
                            const st = fs.statSync(fp);
                            if (st.mtimeMs > newestTime) {
                                newestTime = st.mtimeMs;
                                newest = fp;
                            }
                        }
                    }
                } catch (_) { /* ignore */ }
                return newest;
            };

            if (!spotdlErr && !spotdlMissing) {
                const file = findNewestMp3();
                if (file) {
                    const sizeMB = (fs.statSync(file).size / (1024 * 1024)).toFixed(1);
                    logSpotifyAction('Download Spotify', url, context, 'Sucesso (spot-dlp)', `Tamanho: ${sizeMB} MB`);
                    return resolve({
                        filePath: file,
                        metadata: { title: path.basename(file, '.mp3'), provider: 'spot-dlp' },
                    });
                }
            }

            // ---- Estratégia 2: yt-dlp (fallback) ----
            const ytdlpCmd = `"${getYtdlpPath()}"`;
            const flags = ['--no-playlist', '-x', '--audio-format', 'mp3', '--audio-quality', '2'];
            const cookiesPath = config.ytdlpCookiesPath;
            if (cookiesPath && fs.existsSync(cookiesPath)) {
                flags.push('--cookies', `"${cookiesPath}"`);
            }
            flags.push(...(config.ytdlpExtraFlags || []));
            if (ffmpegPath && fs.existsSync(ffmpegPath)) {
                flags.push('--ffmpeg-location', `"${ffmpegPath}"`);
            }
            flags.push('-o', `"${outputPath}"`, '--print-json', `"${url}"`);

            const command = `${ytdlpCmd} ${flags.join(' ')}`;
            logSpotifyAction('Download Spotify (fallback yt-dlp)', url, context, 'Fallback iniciado');

            exec(command, { maxBuffer: 1024 * 1024 * 10, cwd: TEMP_SPOTIFY_DIR }, (error, stdout, stderr) => {
                if (error) {
                    console.error(`[SpotifyHandler] FALHA NO YT-DLP:\nSTDOUT: ${stdout}\nSTDERR: ${stderr}\nERROR: ${error.message}`);
                    let errObj = error;
                    if (/private|restricted|não disponível/i.test(stdout + stderr)) {
                        errObj = new Error('SPOTIFY_PRIVATE: A faixa não pôde ser baixada (pode ser exclusiva ou restrita).');
                    } else if (error.code === 'ENOENT' || /not recognized|não é reconhecido|command not found/i.test(stderr)) {
                        errObj = new Error('YTDLP_NOT_INSTALLED: Nem spot-dlp nem yt-dlp estão disponíveis no PATH da máquina.');
                    } else {
                        errObj = new Error(`SPOTIFY_ERROR: Falha ao baixar do Spotify: ${stderr.trim().split('\n').pop() || error.message}`);
                    }
                    logSpotifyAction('Download Spotify', url, context, 'Erro', `Detalhe: ${errObj.message}`);
                    return reject(errObj);
                }

                // Localiza o arquivo .mp3 mais recente gerado
                const allFiles = fs.existsSync(TEMP_SPOTIFY_DIR)
                    ? fs.readdirSync(TEMP_SPOTIFY_DIR).filter((f) => f.endsWith('.mp3'))
                    : [];
                const matching = allFiles
                    .map((f) => path.join(TEMP_SPOTIFY_DIR, f))
                    .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];

                if (!matching) {
                    const err = new Error('SPOTIFY_NO_FILE: O áudio não foi encontrado após o download. Tente novamente.');
                    logSpotifyAction('Download Spotify', url, context, 'Erro', `Detalhe: ${err.message}`);
                    return reject(err);
                }

                // Tenta extrair o título do JSON retornado pelo yt-dlp
                let title = 'spotify_download';
                try {
                    const jsonMatch = stdout.match(/^\{.*\}$/ms);
                    if (jsonMatch) {
                        const meta = JSON.parse(jsonMatch[0]);
                        title = sanitizeFilenameForDiscord(meta.title || meta.track || 'spotify_download');
                    }
                } catch (_) { /* ignore */ }

                const finalPath = path.join(TEMP_SPOTIFY_DIR, `${title}-${jobToken}.mp3`);
                try {
                    fs.renameSync(matching, finalPath);
                } catch (_) { /* mantém o caminho original */ }

                const resolvedPath = fs.existsSync(finalPath) ? finalPath : matching;
                const sizeMB = (fs.statSync(resolvedPath).size / (1024 * 1024)).toFixed(1);
                logSpotifyAction('Download Spotify', url, context, 'Sucesso (yt-dlp)', `Tamanho: ${sizeMB} MB`);
                return resolve({
                    filePath: resolvedPath,
                    metadata: { title, provider: 'yt-dlp' },
                });
            });
        });
    });
}

export default {
    downloadSpotify,
    isUserBusy,
    lockUser,
    unlockUser,
    canBypass,
};
