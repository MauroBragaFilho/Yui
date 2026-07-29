const axios = require('axios');
const { exec } = require('child_process');
const path = require('path');
const fs = require('fs');
const { searchDeezerTracks, calculateConfidenceScore } = require('../services/deezerMusicService');
const { downloadAudio } = require('../handlers/youtubeAudioHandler');

const { TEMP_RADIO_DIR, cleanTempRadioAudio } = require('./radioCleaner');

function extractUrl(str) {
    if (!str) return '';
    const match = str.match(/(https?:\/\/[^\s]+)/i);
    return match ? match[1] : str.trim();
}

function isYouTubeUrl(str) {
    return /(?:youtube\.com|youtu\.be|music\.youtube\.com)/i.test(str);
}

function isDeezerUrl(str) {
    return /deezer\.com/i.test(str);
}

function isDeezerPlaylist(str) {
    return /deezer\.com\/.*playlist/i.test(str);
}

function isDeezerAlbum(str) {
    return /deezer\.com\/.*album/i.test(str);
}

function isYouTubePlaylist(str) {
    return /(?:youtube\.com|youtu\.be|music\.youtube\.com)\/.*[?&]list=/i.test(str) || /\/playlist\?list=/i.test(str);
}

async function resolveDeezerTrack(url) {
    try {
        const clean = extractUrl(url);
        const match = clean.match(/deezer\.com\/.+?\/track\/(\d+)/);
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
        const match = clean.match(/deezer\.com\/.+?\/playlist\/(\d+)/);
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

    return new Promise((resolve) => {
        const config = require('../config');
        const cookiesPath = config.ytdlpCookiesPath;
        const cookieFlag = (cookiesPath && fs.existsSync(cookiesPath)) ? `--cookies "${cookiesPath}"` : '';
        const cmd = `yt-dlp --no-warnings --no-update ${cookieFlag} -j "${cleanUrl}"`;

        exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 15000 }, (err, stdout) => {
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

            resolve({
                id: m.id || videoId || `yt_${Date.now()}`,
                title,
                artist,
                album: '',
                duration,
                cover,
                link: cleanUrl,
                source: 'youtube'
            });
        });
    });
}

async function resolveDeezerAlbum(url) {
    try {
        const clean = extractUrl(url);
        const match = clean.match(/deezer\.com\/.+?\/album\/(\d+)/);
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

function resolveYouTubePlaylist(url) {
    return new Promise((resolve) => {
        const cleanUrl = extractUrl(url);
        const config = require('../config');
        const cookiesPath = config.ytdlpCookiesPath;
        const cookieFlag = (cookiesPath && fs.existsSync(cookiesPath)) ? `--cookies "${cookiesPath}"` : '';
        const cmd = `yt-dlp --no-warnings --no-update ${cookieFlag} --flat-playlist --playlist-end 100 -j "${cleanUrl}"`;

        exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 35000 }, (err, stdout) => {
            if (!stdout) return resolve([]);
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
                            if (e && e.id && !e.title?.includes('[Private') && !e.title?.includes('[Deleted')) {
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
                    } else if (parsed.id && !parsed.title?.includes('[Private') && !parsed.title?.includes('[Deleted')) {
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

            resolve(tracks);
        });
    });
}

async function searchByName(query) {
    const results = await searchDeezerTracks(query);
    if (!results || results.length === 0) return { track: null, ambiguous: false, results: [] };

    const top = results[0];
    const score = calculateConfidenceScore(query, top);

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
                source: 'deezer'
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
            source: 'deezer'
        }))
    };
}

function downloadTrackToDisk(track) {
    return new Promise(async (resolve, reject) => {
        if (!track || !track.source) {
            return reject(new Error('Objeto de faixa inválido ou fonte ausente'));
        }

        const arl = process.env.DEEZER_ARL || process.env.DEEMIX_ARL || '';
        const scriptPath = path.join(__dirname, '../services/download_deezer.py');
        const pythonBin = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');

        if (track.source === 'deezer') {
            const link = track.link || `https://www.deezer.com/track/${track.id}`;
            const cmd = `${pythonBin} "${scriptPath}" "${link}" "${TEMP_RADIO_DIR}" "${arl}"`;
            exec(cmd, { maxBuffer: 10 * 1024 * 1024, timeout: 60000 }, (error, stdout) => {
                const match = stdout?.match(/DOWNLOADED_FILE:(.+)/);
                if (match && match[1]) {
                    const p = match[1].trim();
                    if (fs.existsSync(p)) return resolve(p);
                }
                const files = fs.readdirSync(TEMP_RADIO_DIR)
                    .filter(f => f.includes(track.id))
                    .map(f => path.join(TEMP_RADIO_DIR, f));
                if (files.length > 0) return resolve(files[0]);
                reject(new Error('Falha ao baixar faixa via deemix'));
            });
        } else if (track.source === 'youtube') {
            if (track.preDownloadedPath && fs.existsSync(track.preDownloadedPath)) {
                return resolve(track.preDownloadedPath);
            }

            try {
                const result = await downloadAudio(track.link);
                if (result && result.filePath && fs.existsSync(result.filePath)) {
                    return resolve(result.filePath);
                }
            } catch (ytErr) {
                console.warn(`[RadioProviders] youtubeAudioHandler.downloadAudio falhou: ${ytErr.message}`);
            }

            const searchTarget = (track.title && track.title !== 'Vídeo do YouTube') ? `${track.title} ${track.artist !== 'YouTube' ? track.artist : ''}`.trim() : null;
            if (searchTarget) {
                console.log(`[RadioProviders] 🔄 YouTube falhou. Tentando fallback via Deezer para: "${searchTarget}"...`);
                try {
                    const deezerRes = await searchDeezerTracks(searchTarget);
                    if (deezerRes && deezerRes.length > 0) {
                        const fallbackTrack = {
                            id: String(deezerRes[0].id),
                            link: deezerRes[0].link,
                            source: 'deezer'
                        };
                        const downloadedPath = await downloadTrackToDisk(fallbackTrack);
                        return resolve(downloadedPath);
                    }
                } catch (_) {}
            }

            reject(new Error('Falha ao baixar áudio do YouTube'));
        } else {
            reject(new Error('Fonte de áudio desconhecida'));
        }
    });
}

async function resolveInput(input) {
    input = (input || '').trim();
    const cleanUrl = extractUrl(input);
    const hasHttp = /^https?:\/\//i.test(cleanUrl);

    if (hasHttp) {
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
            if (tracks && tracks.length > 0) return { type: 'playlist', tracks };
        }
        if (isYouTubeUrl(cleanUrl)) {
            const track = await resolveYouTubeTrack(cleanUrl);
            if (track) return { type: 'track', track };
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

module.exports = {
    resolveInput,
    downloadTrackToDisk,
    searchByName,
    TEMP_RADIO_DIR
};
