import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { getSession } from './radioDatabase.js';
import { downloadTrackToDisk } from './radioProviders.js';

const activePrefetchQueues = new Set();
const TEMP_DIR = path.join(__dirname, '../../temp_radio_audio');

function cleanupOrphanedAudioFiles() {
    try {
        if (fs.existsSync(TEMP_DIR)) {
            const files = fs.readdirSync(TEMP_DIR);
            for (const file of files) {
                try {
                    fs.unlinkSync(path.join(TEMP_DIR, file));
                } catch (_) {}
            }
        }
    } catch (_) {}
}

cleanupOrphanedAudioFiles();

async function downloadWithTimeout(track, timeoutMs = 15000) {
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            reject(new Error('Timeout no download da faixa'));
        }, timeoutMs);

        downloadTrackToDisk(track)
            .then((filePath) => {
                clearTimeout(timer);
                resolve(filePath);
            })
            .catch((err) => {
                clearTimeout(timer);
                reject(err);
            });
    });
}

async function prefetchPlaylistTracks(guildId) {
    if (activePrefetchQueues.has(guildId)) return;
    activePrefetchQueues.add(guildId);

    try {
        const session = getSession(guildId);
        if (!session || !Array.isArray(session.playlist) || session.playlist.length === 0) {
            return;
        }

        let orderIndices = [];
        const total = session.playlist.length;
        const current = session.currentIndex >= 0 ? session.currentIndex : 0;

        if (session.shuffle && total > 1) {
            const remaining = [];
            for (let i = 0; i < total; i++) {
                if (i !== current) remaining.push(i);
            }
            for (let i = remaining.length - 1; i > 0; i--) {
                const j = Math.floor(Math.random() * (i + 1));
                [remaining[i], remaining[j]] = [remaining[j], remaining[i]];
            }
            orderIndices = remaining;
        } else {
            for (let i = 1; i <= total; i++) {
                orderIndices.push((current + i) % total);
            }
        }

        for (const idx of orderIndices) {
            const currentSession = getSession(guildId);
            if (!currentSession) break;

            const track = session.playlist[idx];
            if (!track || track.source === 'youtube') continue;
            if (track.localPath && fs.existsSync(track.localPath)) continue;
            if (track._prefetching) continue;

            track._prefetching = true;
            try {
                const filePath = await downloadWithTimeout(track, 15000);
                track._prefetching = false;
                if (filePath && fs.existsSync(filePath)) {
                    track.localPath = filePath;
                }
            } catch (_) {
                track._prefetching = false;
            }
        }
    } catch (_) {
    } finally {
        activePrefetchQueues.delete(guildId);
    }
}

async function prefetchNextTrack(guildId) {
    prefetchPlaylistTracks(guildId).catch(() => {});
}

function cleanupSessionAudioFiles(session) {
    if (!session || !Array.isArray(session.playlist)) return;
    for (const track of session.playlist) {
        if (track && track.localPath) {
            try {
                if (fs.existsSync(track.localPath)) {
                    fs.unlinkSync(track.localPath);
                }
            } catch (_) {}
            track.localPath = null;
        }
    }
}

export { prefetchNextTrack, prefetchPlaylistTracks, cleanupSessionAudioFiles, cleanupOrphanedAudioFiles };

export default {
    prefetchNextTrack,
    prefetchPlaylistTracks,
    cleanupSessionAudioFiles,
    cleanupOrphanedAudioFiles
};
