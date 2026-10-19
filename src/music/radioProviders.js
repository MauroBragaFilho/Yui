import axios from 'axios';
import { execFile } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import {
    searchDeezerTracks,
    calculateConfidenceScore,
    downloadDeezerTrack,
    cleanupDeezerDir,
    normalizeDeezerTrackLink,
    getDeezerTimeoutMs
} from '../services/deezerMusicService.js';
import { downloadAudio } from '../handlers/youtubeAudioHandler.js';
import { getYtdlpPath } from '../utils/binaries.js';
import { logger } from '../utils/logger.js';

import { TEMP_RADIO_DIR, cleanTempRadioAudio } from './radioCleaner.js';

// Caracteres que nunca aparecem num link legítimo de YouTube/Deezer/Spotify (controle, aspas, shell).
const BLOCKED_URL_CHARS = /[\u0000-\u001f\u007f"'`<>\\^{}|]/;
const YTDLP_MAX_BUFFER = 10 * 1024 * 1024;
// A rádio não pode ficar esperando o deemix para sempre: teto de 60 s (ou menos, se YUI_DEEZER_TIMEOUT_S for menor).
const RADIO_DEEZER_TIMEOUT_CAP_MS = 60 * 1000;

function hostMatches(host, ...domains) {
    return domains.some((domain) => host === domain || host.endsWith(`.${domain}`));
}

function hostOf(str) {
    try {
        return new URL(String(str)).hostname.toLowerCase();
    } catch (_) {
        return '';
    }
}

/**
 * Valida o primeiro link http(s) do texto: sem controle/aspas, sem usuário:senha e só de hosts
 * conhecidos (YouTube, Deezer, Spotify). Devolve a URL normalizada ou null.
 */
function sanitizeMediaUrl(str) {
    const match = String(str ?? '').match(/https?:\/\/[^\s]+/i);
    if (!match) return null;
    const candidate = match[0].replace(/>+$/, ''); // link entre <...> do Discord
    if (BLOCKED_URL_CHARS.test(candidate)) return null;
    let url;
    try {
        url = new URL(candidate);
    } catch (_) {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    return hostMatches(host, 'youtube.com', 'youtu.be', 'deezer.com', 'spotify.com', 'spoti.fi') ? url.href : null;
}

/** Link validado, ou o próprio texto (para busca por nome) quando não há link; '' se o link for recusado. */
function extractUrl(str) {
    if (!str) return '';
    const text = String(str);
    if (/https?:\/\//i.test(text)) return sanitizeMediaUrl(text) || '';
    return text.trim();
}

function isYouTubeUrl(str) {
    return hostMatches(hostOf(str), 'youtube.com', 'youtu.be');
}

function isDeezerUrl(str) {
    return hostMatches(hostOf(str), 'deezer.com');
}

function isDeezerPlaylist(str) {
    return isDeezerUrl(str) && /deezer\.com\/.*playlist/i.test(str);
}

function isDeezerAlbum(str) {
    return isDeezerUrl(str) && /deezer\.com\/.*album/i.test(str);
}

function isSpotifyUrl(str) {
    return hostMatches(hostOf(str), 'spotify.com', 'spoti.fi');
}

function isYouTubePlaylist(str) {
    return isYouTubeUrl(str) && (/(?:youtube\.com|youtu\.be|music\.youtube\.com)\/.*[?&]list=/i.test(str) || /\/playlist\?list=/i.test(str));
}

// ---------------------------------------------------------------------------
// yt-dlp: sempre execFile com array de argumentos (sem shell, sem aspas)
// ---------------------------------------------------------------------------

function sanitizeSearchQuery(query) {
    return String(query ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 200);
}

function buildYtdlpInfoArgs(url, cookiesPath = '') {
    const args = ['--no-warnings', '--no-update'];
    if (cookiesPath) args.push('--cookies', cookiesPath);
    args.push('-j', url);
    return args;
}

function buildYtdlpPlaylistArgs(url, cookiesPath = '') {
    const args = ['--no-warnings', '--no-update'];
    if (cookiesPath) args.push('--cookies', cookiesPath);
    args.push('--flat-playlist', '--playlist-end', '100', '-j', url);
    return args;
}

function buildYtdlpSearchArgs(query, limit = 5, cookiesPath = '') {
    const count = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);
    const args = ['--no-warnings', '--no-update'];
    if (cookiesPath) args.push('--cookies', cookiesPath);
    args.push('--flat-playlist', '-j', `ytsearch${count}:${sanitizeSearchQuery(query)}`);
    return args;
}

async function getCookiesPath() {
    const { default: config } = await import('../config.js');
    const cookiesPath = config.ytdlpCookiesPath;
    return (cookiesPath && fs.existsSync(cookiesPath)) ? cookiesPath : '';
}

function runYtdlp(args, timeout, execFileImpl = execFile) {
    return new Promise((resolve) => {
        try {
            execFileImpl(getYtdlpPath(), args, { maxBuffer: YTDLP_MAX_BUFFER, timeout, windowsHide: true }, (err, stdout) => {
                resolve({ err: err || null, stdout: stdout ? String(stdout) : '' });
            });
        } catch (err) {
            resolve({ err, stdout: '' });
        }
    });
}

async function resolveDeezerTrack(url) {
    try {
        const clean = extractUrl(url);
        const match = clean.match(/deezer\.com\/(?:.+?\/)?track\/(\d+)/);
        if (!match) return null;
        const res = await axios.get(`https://api.deezer.com/track/${match[1]}`);
        const t = res.data;
        if (!t || !t.id) return null;
        return {
            id: String(t.id),
            title: t.title,
            artist: t.artist?.name || 'Desconhecido',
            album: t.album?.title || '',
            duration: t.duration,
            cover: t.album?.cover_medium || '',
            link: t.link,
            source: 'deezer'
        };
    } catch (_) {
        return null;
    }
}

async function resolveDeezerPlaylist(url) {
    try {
        const clean = extractUrl(url);
        const match = clean.match(/deezer\.com\/(?:.+?\/)?playlist\/(\d+)/);
        if (!match) return [];
        const res = await axios.get(`https://api.deezer.com/playlist/${match[1]}`);
        const tracks = (res.data?.tracks?.data || []).slice(0, 100);
        return tracks.map(t => ({
            id: String(t.id),
            title: t.title,
            artist: t.artist?.name || 'Desconhecido',
            album: t.album?.title || '',
            duration: t.duration,
            cover: t.album?.cover_medium || '',
            link: t.link,
            source: 'deezer'
        }));
    } catch (_) {
        return [];
    }
}

async function resolveYouTubeTrack(url) {
    const cleanUrl = extractUrl(url);
    const videoIdMatch = cleanUrl.match(/(?:v=|\/|embed\/|shorts\/)([0-9A-Za-z_-]{11})/);
    const videoId = videoIdMatch ? videoIdMatch[1] : null;

    let oembedData = null;
    if (videoId) {
        try {
            const res = await axios.get(`https://www.youtube.com/oembed?url=https://www.youtube.com/watch?v=${videoId}&format=json`, { timeout: 4000 });
            if (res.data && res.data.title) {
                oembedData = res.data;
            }
        } catch (_) {}
    }

    const cookiesPath = await getCookiesPath();
    const { stdout } = await runYtdlp(buildYtdlpInfoArgs(cleanUrl, cookiesPath), 15000);

    let m = {};
    if (stdout) {
        try {
            const firstBrace = stdout.indexOf('{');
            const lastBrace = stdout.lastIndexOf('}');
            if (firstBrace !== -1 && lastBrace > firstBrace) {
                m = JSON.parse(stdout.substring(firstBrace, lastBrace + 1));
            }
        } catch (_) {}
    }

    const title = m.title || oembedData?.title || 'Vídeo do YouTube';
    const artist = m.uploader || m.channel || m.artist || oembedData?.author_name || 'YouTube';
    const duration = m.duration || 0;
    const cover = m.thumbnail || oembedData?.thumbnail_url || (videoId ? `https://img.youtube.com/vi/${videoId}/hqdefault.jpg` : '');

    return {
        id: m.id || videoId || `yt_${Date.now()}`,
        title,
        artist,
        album: '',
        duration,
        cover,
        link: cleanUrl,
        source: 'youtube'
    };
}

async function resolveDeezerAlbum(url) {
    try {
        const clean = extractUrl(url);
        const match = clean.match(/deezer\.com\/(?:.+?\/)?album\/(\d+)/);
        if (!match) return [];
        const res = await axios.get(`https://api.deezer.com/album/${match[1]}`);
        const tracks = (res.data?.tracks?.data || []).slice(0, 100);
        return tracks.map(t => ({
            id: String(t.id),
            title: t.title,
            artist: t.artist?.name || res.data?.artist?.name || 'Desconhecido',
            album: res.data?.title || '',
            duration: t.duration,
            cover: res.data?.cover_medium || '',
            link: t.link,
            source: 'deezer'
        }));
    } catch (_) {
        return [];
    }
}

/** IDs de vídeo do YouTube têm sempre 11 caracteres; qualquer outra coisa não vira link de faixa. */
function isYouTubeVideoId(id) {
    return typeof id === 'string' && /^[A-Za-z0-9_-]{11}$/.test(id);
}

async function resolveYouTubePlaylist(url) {
    const cleanUrl = extractUrl(url);
    const cookiesPath = await getCookiesPath();
    const { stdout } = await runYtdlp(buildYtdlpPlaylistArgs(cleanUrl, cookiesPath), 35000);
    if (!stdout) return [];

    const tracks = [];
    const lines = stdout.split('\n');

    for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        try {
            const firstBrace = trimmed.indexOf('{');
            const lastBrace = trimmed.lastIndexOf('}');
            if (firstBrace === -1 || lastBrace <= firstBrace) continue;

            const jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
            const parsed = JSON.parse(jsonStr);

            if (parsed.entries && Array.isArray(parsed.entries)) {
                for (const e of parsed.entries) {
                    if (e && isYouTubeVideoId(e.id) && !e.title?.includes('[Private') && !e.title?.includes('[Deleted')) {
                        tracks.push({
                            id: e.id,
                            title: e.title || 'Faixa YouTube',
                            artist: e.uploader || e.channel || 'YouTube',
                            album: '',
                            duration: e.duration || 0,
                            cover: e.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${e.id}/hqdefault.jpg`,
                            link: `https://www.youtube.com/watch?v=${e.id}`,
                            source: 'youtube'
                        });
                    }
                }
            } else if (isYouTubeVideoId(parsed.id) && !parsed.title?.includes('[Private') && !parsed.title?.includes('[Deleted')) {
                tracks.push({
                    id: parsed.id,
                    title: parsed.title || 'Faixa YouTube',
                    artist: parsed.uploader || parsed.channel || parsed.playlist_uploader || 'YouTube',
                    album: '',
                    duration: parsed.duration || 0,
                    cover: parsed.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${parsed.id}/hqdefault.jpg`,
                    link: `https://www.youtube.com/watch?v=${parsed.id}`,
                    source: 'youtube'
                });
            }
        } catch (_) {}
    }

    return tracks;
}

/** `deps.execFileImpl` existe só para teste (sem yt-dlp real). */
async function searchYouTubeByName(query, limit = 5, deps = {}) {
    try {
        const count = Math.min(Math.max(parseInt(limit, 10) || 5, 1), 20);
        if (!sanitizeSearchQuery(query)) return [];
        const cookiesPath = await getCookiesPath();
        const { stdout } = await runYtdlp(buildYtdlpSearchArgs(query, count, cookiesPath), 20000, deps.execFileImpl);
        if (!stdout) return [];

        const tracks = [];
        const lines = stdout.split('\n');

        for (const line of lines) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
                const firstBrace = trimmed.indexOf('{');
                const lastBrace = trimmed.lastIndexOf('}');
                if (firstBrace === -1 || lastBrace <= firstBrace) continue;

                const jsonStr = trimmed.substring(firstBrace, lastBrace + 1);
                const parsed = JSON.parse(jsonStr);

                if (isYouTubeVideoId(parsed.id) && !parsed.title?.includes('[Private') && !parsed.title?.includes('[Deleted')) {
                    tracks.push({
                        id: parsed.id,
                        title: parsed.title || 'Faixa YouTube',
                        artist: parsed.uploader || parsed.channel || 'YouTube',
                        album: '',
                        duration: parsed.duration || 0,
                        cover: parsed.thumbnails?.[0]?.url || `https://img.youtube.com/vi/${parsed.id}/hqdefault.jpg`,
                        link: `https://www.youtube.com/watch?v=${parsed.id}`,
                        source: 'youtube'
                    });
                }
            } catch (_) {}

            if (tracks.length >= count) break;
        }

        return tracks;
    } catch (_) {
        return [];
    }
}

function cleanYouTubeSearchTitle(title) {
    return String(title || '')
        .replace(/\s*\(official\s+(audio|video|lyrics?|music).*?\)/gi, '')
        .replace(/\s*\[official\s+(audio|video|lyrics?|music).*?\]/gi, '')
        .replace(/\s*\(.*?\baudio\b.*?\)/gi, '')
        .replace(/\s*\[.*?\baudio\b.*?\]/gi, '')
        .replace(/\s*\(clipe\s+oficial.*?\)/gi, '')
        .replace(/\s*\(vídeo\s+oficial.*?\)/gi, '')
        .replace(/\s*\|.*$/gi, '')
        .replace(/\(hd\)/gi, '')
        .replace(/\(4k\)/gi, '')
        .trim();
}

async function searchByName(query) {
    let results = await searchDeezerTracks(query);
    let fromYouTube = false;

    if (!results || results.length === 0) {
        results = await searchYouTubeByName(query);
        fromYouTube = results && results.length > 0;
        if (!fromYouTube) return { track: null, ambiguous: false, results: [] };
    }

    const top = results[0];
    const score = calculateConfidenceScore(
        fromYouTube ? cleanYouTubeSearchTitle(top.title) : query,
        top
    );

    if (score >= 80) {
        return {
            track: {
                id: String(top.id),
                title: top.title,
                artist: top.artist,
                album: top.album || '',
                duration: top.duration,
                cover: top.cover,
                link: top.link,
                source: fromYouTube ? 'youtube' : 'deezer'
            },
            ambiguous: false,
            results: []
        };
    }

    return {
        track: null,
        ambiguous: true,
        results: results.map(r => ({
            id: String(r.id),
            title: r.title,
            artist: r.artist,
            album: r.album || '',
            duration: r.duration,
            cover: r.cover,
            link: r.link,
            source: fromYouTube ? 'youtube' : 'deezer'
        }))
    };
}

// Downloads do Deezer em andamento, por faixa: o prefetch (que desiste após 15 s mas deixa o processo
// rodando) e o player compartilham o mesmo processo em vez de lançar dois deemix para a mesma faixa.
const inflightDeezerDownloads = new Map();

/**
 * Leva o arquivo da subpasta única do pedido para a pasta plana da rádio (onde o radioCleaner
 * apaga por idade e protege a faixa tocando) e remove a subpasta. O nome nunca é usado para
 * localizar o arquivo: o caminho vem do que o script imprimiu.
 */
function moveIntoRadioDir(downloadedPath, track, radioDir) {
    const ext = path.extname(downloadedPath) || '.mp3';
    const safeId = String(track.id ?? 'faixa').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'faixa';
    const target = path.join(radioDir, `deezer_${safeId}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    try {
        fs.renameSync(downloadedPath, target);
        cleanupDeezerDir(path.dirname(downloadedPath), { baseDir: radioDir });
        return target;
    } catch (err) {
        logger.warn(`[RadioProviders] Não consegui mover a faixa para a pasta da rádio: ${err.message}`);
        return downloadedPath; // continua tocável; a subpasta é varrida depois pelo serviço
    }
}

async function downloadDeezerForRadio(track, deps) {
    const download = deps.downloadDeezerTrack || downloadDeezerTrack;
    const radioDir = deps.radioDir || TEMP_RADIO_DIR;
    const ref = normalizeDeezerTrackLink(track.link) || normalizeDeezerTrackLink(track.id);
    if (!ref) throw new Error('Faixa do Deezer sem link ou ID válido');

    const timeoutMs = Math.min(getDeezerTimeoutMs(), RADIO_DEEZER_TIMEOUT_CAP_MS);
    const downloaded = await download(ref, { outDir: radioDir, timeoutMs });
    return moveIntoRadioDir(downloaded, track, radioDir);
}

function downloadDeezerDeduped(track, deps) {
    const key = String(track.id ?? track.link);
    const running = inflightDeezerDownloads.get(key);
    if (running) return running;
    const promise = downloadDeezerForRadio(track, deps).finally(() => inflightDeezerDownloads.delete(key));
    inflightDeezerDownloads.set(key, promise);
    return promise;
}

/** Chama o cleanup() do resultado de um download (idempotente), sem nunca lançar. */
function releaseDownloadResult(result) {
    try {
        if (result && typeof result.cleanup === 'function') result.cleanup();
    } catch (err) {
        logger.warn(`[RadioProviders] Falha ao limpar a pasta temporária do pedido: ${String(err?.message || err).slice(0, 120)}`);
    }
}

/**
 * Contrato do downloadAudio do YouTube: { filePath, metadata, cleanup }, com o MP3 numa subpasta única do
 * pedido (src/data/temp_audio/<uuid>/). A rádio só TOCA o arquivo depois que este módulo devolve o caminho,
 * então chamar cleanup() ali o apagaria antes da hora. E deixar o arquivo na subpasta o expõe às faxinas dos
 * downloads: a do Deezer apaga subpastas UUID paradas há 3 h, a do YouTube apaga as vazias após 5 min e as paradas
 * após 24 h. Por isso a faixa é MOVIDA para a pasta plana da rádio (a mesma do Deezer), onde só o radioCleaner
 * age: apaga por idade (15 min) e protege a faixa que está tocando. Depois do move a subpasta está vazia e o
 * cleanup() é chamado na hora. Sem cleanup() o resultado não é de uma subpasta de pedido: o caminho segue como veio.
 * Se o move falhar, o arquivo continua tocável onde está e a subpasta NÃO é apagada (a faxina cuida dela depois).
 */
function moveYoutubeDownloadIntoRadioDir(result, track, radioDir) {
    if (typeof result.cleanup !== 'function') return result.filePath;
    const ext = path.extname(result.filePath) || '.mp3';
    const safeId = String(track.id ?? 'faixa').replace(/[^0-9A-Za-z_-]/g, '').slice(0, 40) || 'faixa';
    const target = path.join(radioDir, `youtube_${safeId}_${crypto.randomBytes(4).toString('hex')}${ext}`);
    try {
        fs.mkdirSync(radioDir, { recursive: true });
        try {
            fs.renameSync(result.filePath, target);
        } catch (_) {
            fs.copyFileSync(result.filePath, target); // pastas em discos diferentes
        }
    } catch (err) {
        logger.warn(`[RadioProviders] Não consegui mover a faixa do YouTube para a pasta da rádio: ${String(err?.message || err).slice(0, 120)}`);
        try { fs.rmSync(target, { force: true }); } catch (_) { /* cópia parcial: melhor esforço */ }
        return result.filePath;
    }
    releaseDownloadResult(result);
    return target;
}

/**
 * Baixa a faixa para o disco e devolve o caminho do arquivo.
 * `deps` existe só para teste (dublês de download/busca).
 */
async function downloadTrackToDisk(track, context = null, deps = {}) {
    if (!track || !track.source) {
        throw new Error('Objeto de faixa inválido ou fonte ausente');
    }

    const logContext = context || {
        source: 'Modo Rádio',
        userId: track.addedBy || 'Desconhecido'
    };

    if (track.source === 'deezer') {
        return downloadDeezerDeduped(track, deps);
    }

    if (track.source === 'youtube') {
        if (track.preDownloadedPath && fs.existsSync(track.preDownloadedPath)) {
            return track.preDownloadedPath;
        }

        try {
            const result = await (deps.downloadAudio || downloadAudio)(track.link, logContext);
            if (result && result.filePath && fs.existsSync(result.filePath)) {
                return moveYoutubeDownloadIntoRadioDir(result, track, deps.radioDir || TEMP_RADIO_DIR);
            }
            // Sem arquivo utilizável: libera a subpasta do pedido antes de tentar o Deezer.
            releaseDownloadResult(result);
        } catch (ytErr) {
            logger.warn(`[RadioProviders] Download do YouTube falhou: ${String(ytErr?.message || ytErr).split('\n')[0].slice(0, 120)}`);
        }

        // Fallback inverso (YouTube -> Deezer). O ramo do Deezer acima não volta para o YouTube: não há laço.
        const searchTarget = (track.title && track.title !== 'Vídeo do YouTube') ? `${track.title} ${track.artist !== 'YouTube' ? track.artist : ''}`.trim() : null;
        if (searchTarget) {
            logger.info('[RadioProviders] YouTube falhou. Tentando fallback via Deezer.');
            try {
                const deezerRes = await (deps.searchDeezerTracks || searchDeezerTracks)(searchTarget);
                if (deezerRes && deezerRes.length > 0) {
                    const fallbackTrack = {
                        id: String(deezerRes[0].id),
                        link: deezerRes[0].link,
                        source: 'deezer'
                    };
                    return await downloadTrackToDisk(fallbackTrack, null, deps);
                }
            } catch (fallbackErr) {
                logger.warn(`[RadioProviders] Fallback via Deezer falhou: ${String(fallbackErr?.message || fallbackErr).split('\n')[0].slice(0, 120)}`);
            }
        }

        throw new Error('Falha ao baixar áudio do YouTube');
    }

    throw new Error('Fonte de áudio desconhecida');
}

async function resolveSpotify(url) {
    try {
        const cleanUrl = extractUrl(url);
        let embedUrl = cleanUrl;
        if (!cleanUrl.includes('/embed/')) {
            embedUrl = cleanUrl.replace('open.spotify.com/', 'open.spotify.com/embed/');
        }

        const res = await axios.get(embedUrl, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36'
            },
            timeout: 7000
        });

        const match = res.data.match(/<script id="__NEXT_DATA__" type="application\/json">(.*?)<\/script>/);
        if (match) {
            const json = JSON.parse(match[1]);
            const entity = json?.props?.pageProps?.state?.data?.entity;

            if (entity) {
                if (entity.type === 'track') {
                    const title = entity.name || entity.title || '';
                    const artist = entity.artists ? entity.artists.map(a => a.name).join(', ') : '';
                    const query = `${title} ${artist}`.trim();

                    const deezerRes = await searchDeezerTracks(query);
                    if (deezerRes && deezerRes.length > 0) {
                        const t = deezerRes[0];
                        return {
                            type: 'track',
                            track: {
                                id: String(t.id),
                                title: t.title,
                                artist: t.artist?.name || artist || 'Desconhecido',
                                album: t.album?.title || '',
                                duration: t.duration,
                                cover: t.album?.cover_medium || entity.visualIdentity?.image?.[0]?.url || '',
                                link: t.link,
                                source: 'deezer'
                            }
                        };
                    }
                }

                if ((entity.type === 'album' || entity.type === 'playlist') && Array.isArray(entity.trackList)) {
                    const resolvedTracks = [];
                    for (const item of entity.trackList) {
                        const title = item.title || item.name;
                        const artist = item.subtitle || (item.artists ? item.artists.map(a => a.name).join(', ') : '');
                        const query = `${title} ${artist}`.trim();
                        if (!query) continue;

                        try {
                            const deezerRes = await searchDeezerTracks(query);
                            if (deezerRes && deezerRes.length > 0) {
                                const t = deezerRes[0];
                                resolvedTracks.push({
                                    id: String(t.id),
                                    title: t.title,
                                    artist: t.artist?.name || artist || 'Desconhecido',
                                    album: t.album?.title || '',
                                    duration: t.duration,
                                    cover: t.album?.cover_medium || '',
                                    link: t.link,
                                    source: 'deezer'
                                });
                            }
                        } catch (_) {}
                    }

                    if (resolvedTracks.length > 0) {
                        return { type: 'playlist', tracks: resolvedTracks };
                    }
                }
            }
        }
    } catch (_) {}

    try {
        const oembedUrl = `https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`;
        const res = await axios.get(oembedUrl, { timeout: 5000 });
        if (res.data && res.data.title) {
            const title = res.data.title;
            const deezerRes = await searchDeezerTracks(title);
            if (deezerRes && deezerRes.length > 0) {
                const t = deezerRes[0];
                return {
                    type: 'track',
                    track: {
                        id: String(t.id),
                        title: t.title,
                        artist: t.artist?.name || 'Desconhecido',
                        album: t.album?.title || '',
                        duration: t.duration,
                        cover: t.album?.cover_medium || res.data.thumbnail_url || '',
                        link: t.link,
                        source: 'deezer'
                    }
                };
            }
        }
    } catch (_) {}

    return null;
}

async function convertYouTubeTrackToDeezer(ytTrack) {
    if (!ytTrack || !ytTrack.title || ytTrack.title === 'Vídeo do YouTube') return ytTrack;

    const rawTitle = ytTrack.title
        .replace(/\(official audio.*?\)/gi, '')
        .replace(/\[official audio.*?\]/gi, '')
        .replace(/\(official video.*?\)/gi, '')
        .replace(/\[official video.*?\]/gi, '')
        .replace(/\(lyric video.*?\)/gi, '')
        .replace(/\[lyric video.*?\]/gi, '')
        .replace(/\(clipe oficial.*?\)/gi, '')
        .replace(/\[clipe oficial.*?\]/gi, '')
        .replace(/\(vídeo oficial.*?\)/gi, '')
        .replace(/\[vídeo oficial.*?\]/gi, '')
        .replace(/\(audio.*?\)/gi, '')
        .replace(/\[audio.*?\]/gi, '')
        .trim();

    const artistStr = (ytTrack.artist && ytTrack.artist !== 'YouTube') ? ytTrack.artist : '';
    const query = `${rawTitle} ${artistStr}`.trim();

    try {
        let deezerRes = await searchDeezerTracks(query);
        if (!deezerRes || deezerRes.length === 0) {
            deezerRes = await searchDeezerTracks(rawTitle);
        }

        if (deezerRes && deezerRes.length > 0) {
            for (const candidate of deezerRes) {
                const score = calculateConfidenceScore(query, candidate);
                const titleScore = calculateConfidenceScore(rawTitle, candidate);
                const bestScore = Math.max(score, titleScore);

                const durationDiff = (ytTrack.duration && candidate.duration) 
                    ? Math.abs(ytTrack.duration - candidate.duration) 
                    : 0;

                const isDurationOk = !ytTrack.duration || !candidate.duration || durationDiff <= 45;

                if (bestScore >= 50 && isDurationOk) {
                    return {
                        id: String(candidate.id),
                        title: candidate.title,
                        artist: candidate.artist,
                        album: candidate.album || '',
                        duration: candidate.duration,
                        cover: candidate.cover,
                        link: candidate.link,
                        source: 'deezer'
                    };
                }
            }
        }
    } catch (_) {}
    return ytTrack;
}

async function resolveInput(input, guildId = null) {
    input = (input || '').trim();
    const cleanUrl = extractUrl(input);
    const hasHttp = /^https?:\/\//i.test(cleanUrl);

    const { getSession } = await import('./radioDatabase.js');
    const session = guildId ? getSession(guildId) : null;
    const isFast = session?.streamMode === 'FAST';

    if (hasHttp) {
        if (isSpotifyUrl(cleanUrl)) {
            const spotifyResult = await resolveSpotify(cleanUrl);
            if (spotifyResult) return spotifyResult;
        }
        if (isDeezerPlaylist(cleanUrl)) {
            const tracks = await resolveDeezerPlaylist(cleanUrl);
            if (tracks && tracks.length > 0) return { type: 'playlist', tracks };
        }
        if (isDeezerAlbum(cleanUrl)) {
            const tracks = await resolveDeezerAlbum(cleanUrl);
            if (tracks && tracks.length > 0) return { type: 'playlist', tracks };
        }
        if (isDeezerUrl(cleanUrl)) {
            const track = await resolveDeezerTrack(cleanUrl);
            if (track) return { type: 'track', track };
        }
        if (isYouTubePlaylist(cleanUrl)) {
            const tracks = await resolveYouTubePlaylist(cleanUrl);
            if (tracks && tracks.length > 0) {
                if (isFast) {
                    const converted = await Promise.all(tracks.map(t => convertYouTubeTrackToDeezer(t)));
                    return { type: 'playlist', tracks: converted };
                }
                return { type: 'playlist', tracks };
            }
        }
        if (isYouTubeUrl(cleanUrl)) {
            const track = await resolveYouTubeTrack(cleanUrl);
            if (track) {
                if (isFast) {
                    const converted = await convertYouTubeTrackToDeezer(track);
                    return { type: 'track', track: converted };
                }
                return { type: 'track', track };
            }
        }
    }

    const result = await searchByName(input);
    if (result.ambiguous) {
        return { type: 'ambiguous', results: result.results };
    }
    if (result.track) {
        return { type: 'track', track: result.track };
    }
    return { type: 'not_found' };
}

export {
    resolveInput,
    downloadTrackToDisk,
    searchByName,
    searchYouTubeByName,
    // auxiliares puros, exportados para teste
    sanitizeMediaUrl,
    extractUrl,
    buildYtdlpInfoArgs,
    buildYtdlpPlaylistArgs,
    buildYtdlpSearchArgs
};

export default {
    resolveInput,
    downloadTrackToDisk,
    searchByName,
    searchYouTubeByName,
    TEMP_RADIO_DIR
};
