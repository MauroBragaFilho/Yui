const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, 'data');
const SESSION_FILE = path.join(DATA_DIR, 'radio_sessions.json');

if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
}

const sessions = new Map();

function _save() {
    try {
        const obj = {};
        sessions.forEach((v, k) => { obj[k] = v; });
        fs.writeFileSync(SESSION_FILE, JSON.stringify(obj, null, 2));
    } catch (_) {}
}

function _syncLegacyFields(session) {
    if (!session) return;
    if (!Array.isArray(session.playlist)) session.playlist = [];
    if (typeof session.currentIndex !== 'number') session.currentIndex = -1;
    if (!session.voiceMode) {
        session.voiceMode = session.voiceListening === false ? 'OFF' : 'IA';
    }
    session.voiceListening = (session.voiceMode !== 'OFF');

    session.currentTrack = (session.currentIndex >= 0 && session.currentIndex < session.playlist.length) 
        ? session.playlist[session.currentIndex] 
        : null;
    session.history = session.playlist.slice(0, Math.max(0, session.currentIndex));
    session.queue = session.playlist.slice(Math.max(0, session.currentIndex + 1));
}

function createSession(guildId, voiceChannelId, textChannelId) {
    const session = {
        guildId,
        voiceChannelId,
        textChannelId,
        embedMessageId: null,
        status: 'STOPPED',
        loopMode: 'OFF',
        shuffle: false,
        voiceMode: 'DIRECT',
        voiceListening: true,
        currentIndex: -1,
        playlist: [],
        listeners: []
    };
    _syncLegacyFields(session);
    sessions.set(guildId, session);
    _save();
    return session;
}

function getSession(guildId) {
    const s = sessions.get(guildId);
    if (s) _syncLegacyFields(s);
    return s || null;
}

function updateSession(guildId, patch) {
    const s = sessions.get(guildId);
    if (!s) return null;
    Object.assign(s, patch);
    _syncLegacyFields(s);
    _save();
    return s;
}

function destroySession(guildId) {
    sessions.delete(guildId);
    _save();
}

function hasActiveSession(guildId) {
    return sessions.has(guildId);
}

function addTrackToQueue(guildId, track) {
    const s = sessions.get(guildId);
    if (!s) return null;
    if (!Array.isArray(s.playlist)) s.playlist = [];
    s.playlist.push(track);
    _syncLegacyFields(s);
    _save();
    return s.playlist.length;
}

function skipToTrack(guildId, position) {
    const s = sessions.get(guildId);
    if (!s || !Array.isArray(s.playlist)) return null;
    const targetIdx = position - 1;
    if (targetIdx < 0 || targetIdx >= s.playlist.length) return null;
    s.currentIndex = targetIdx;
    s.status = 'PLAYING';
    _syncLegacyFields(s);
    _save();
    return s;
}

function nextTrack(guildId) {
    const s = sessions.get(guildId);
    if (!s || !Array.isArray(s.playlist) || s.playlist.length === 0) {
        if (s) { s.status = 'STOPPED'; s.currentIndex = -1; _syncLegacyFields(s); }
        return null;
    }

    if (s.loopMode === 'TRACK' && s.currentIndex >= 0 && s.currentIndex < s.playlist.length) {
        s.status = 'PLAYING';
        _syncLegacyFields(s);
        _save();
        return s.playlist[s.currentIndex];
    }

    if (s.shuffle && s.playlist.length > 1) {
        let randIdx = Math.floor(Math.random() * s.playlist.length);
        if (randIdx === s.currentIndex) randIdx = (randIdx + 1) % s.playlist.length;
        s.currentIndex = randIdx;
        s.status = 'PLAYING';
    } else {
        const nextIdx = s.currentIndex + 1;
        if (nextIdx < s.playlist.length) {
            s.currentIndex = nextIdx;
            s.status = 'PLAYING';
        } else if (s.loopMode === 'QUEUE') {
            s.currentIndex = 0;
            s.status = 'PLAYING';
        } else {
            s.status = 'STOPPED';
            _syncLegacyFields(s);
            _save();
            return null;
        }
    }

    _syncLegacyFields(s);
    _save();
    return s.currentTrack;
}

function prevTrack(guildId) {
    const s = sessions.get(guildId);
    if (!s || !Array.isArray(s.playlist) || s.playlist.length === 0) return null;

    if (s.currentIndex > 0) {
        s.currentIndex--;
        s.status = 'PLAYING';
    } else if (s.currentIndex === 0) {
        s.status = 'PLAYING';
    } else {
        s.currentIndex = 0;
        s.status = 'PLAYING';
    }

    _syncLegacyFields(s);
    _save();
    return s.currentTrack;
}

function setLoopMode(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    const modes = ['OFF', 'TRACK', 'QUEUE'];
    const idx = modes.indexOf(s.loopMode);
    s.loopMode = modes[(idx + 1) % modes.length];
    _save();
    return s.loopMode;
}

function toggleShuffle(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    s.shuffle = !s.shuffle;
    _save();
    return s.shuffle;
}

function toggleVoiceListening(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    s.voiceListening = !s.voiceListening;
    s.voiceMode = s.voiceListening ? 'IA' : 'OFF';
    _save();
    return s.voiceListening;
}

function cycleVoiceMode(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    const modes = ['OFF', 'IA', 'DIRECT'];
    const currentMode = s.voiceMode || (s.voiceListening ? 'IA' : 'OFF');
    const currentIdx = modes.indexOf(currentMode);
    const nextMode = modes[(currentIdx + 1) % modes.length];
    s.voiceMode = nextMode;
    s.voiceListening = (nextMode !== 'OFF');
    _save();
    return s.voiceMode;
}

function getAllSessions() {
    return Array.from(sessions.values());
}

function stopRadio(guildId) {
    const s = sessions.get(guildId);
    if (!s) return null;
    s.status = 'STOPPED';
    if (Array.isArray(s.playlist)) {
        s.currentIndex = s.playlist.length;
    } else {
        s.currentIndex = -1;
    }
    _syncLegacyFields(s);
    _save();
    return s;
}

function removeTrackFromPlaylist(guildId, position) {
    const s = sessions.get(guildId);
    if (!s || !Array.isArray(s.playlist) || s.playlist.length === 0) return null;

    const targetIdx = position - 1;
    if (targetIdx < 0 || targetIdx >= s.playlist.length) return null;

    const isCurrent = (targetIdx === s.currentIndex && s.status === 'PLAYING');
    const removedTrack = s.playlist.splice(targetIdx, 1)[0];

    if (s.playlist.length === 0) {
        s.currentIndex = -1;
        s.status = 'STOPPED';
    } else if (targetIdx < s.currentIndex) {
        s.currentIndex--;
    } else if (targetIdx === s.currentIndex) {
        if (s.currentIndex >= s.playlist.length) {
            s.currentIndex = s.playlist.length - 1;
        }
    }

    _syncLegacyFields(s);
    _save();

    return {
        removedTrack,
        isCurrent,
        remainingCount: s.playlist.length,
        newCurrentTrack: s.currentTrack
    };
}

module.exports = {
    createSession,
    getSession,
    updateSession,
    destroySession,
    hasActiveSession,
    addTrackToQueue,
    skipToTrack,
    nextTrack,
    prevTrack,
    setLoopMode,
    toggleShuffle,
    toggleVoiceListening,
    cycleVoiceMode,
    getAllSessions,
    stopRadio,
    removeTrackFromPlaylist
};
