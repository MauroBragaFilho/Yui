const fs = require('fs');
const { getSession } = require('./radioDatabase');
const { downloadTrackToDisk } = require('./radioProviders');

const activePrefetchQueues = new Set();

async function prefetchPlaylistTracks(guildId) {
    if (activePrefetchQueues.has(guildId)) return;
    activePrefetchQueues.add(guildId);

    try {
        const session = getSession(guildId);
        if (!session || !Array.isArray(session.playlist) || session.playlist.length === 0) {
            activePrefetchQueues.delete(guildId);
            return;
        }

        for (let i = 0; i < session.playlist.length; i++) {
            const currentSession = getSession(guildId);
            if (!currentSession) break;

            const track = session.playlist[i];
            if (!track || track.source === 'youtube') continue;
            if (track.localPath && fs.existsSync(track.localPath)) continue;
            if (track._prefetching) continue;

            track._prefetching = true;
            try {
                const filePath = await downloadTrackToDisk(track);
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

module.exports = {
    prefetchNextTrack,
    prefetchPlaylistTracks,
    cleanupSessionAudioFiles
};
