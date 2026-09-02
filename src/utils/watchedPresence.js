import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { ActivityType } from 'discord.js';
import { resolveMember, PLATFORM_PRIORITY } from '../services/activityMusicService.js';
import { getAllSessions } from '../music/radioDatabase.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WATCHED_PATH = path.join(__dirname, '../data/watchedUsers.json');
const EVENTS_PATH  = path.join(__dirname, '../data/presenceEvents.json');

function readJsonSafe(filePath) {
    try {
        if (!fs.existsSync(filePath)) return null;
        const raw = fs.readFileSync(filePath, 'utf-8');
        return JSON.parse(raw);
    } catch {
        return null;
    }
}

// ──────────────────────────────────────────────────────────────
// Fonte 1: Usuários monitorados
// ──────────────────────────────────────────────────────────────

function detectEventFromActivities(activities) {
    if (!activities || activities.length === 0) return null;

    // 1. Streaming (ao vivo) — prioridade máxima por pessoa
    const streaming = activities.find(a => a.type === ActivityType.Streaming);
    if (streaming) {
        return {
            eventType: 'streaming',
            extra: { game: streaming.game || streaming.details || '' },
        };
    }

    // 2. Jogando algum jogo
    const playing = activities.find(a => a.type === ActivityType.Playing && a.name);
    if (playing) {
        return {
            eventType: 'playing_game',
            extra: { game: playing.name },
        };
    }

    // 3. Música (Spotify, YouTube Music, outros)
    for (const platform of PLATFORM_PRIORITY) {
        const activity = activities.find(a => platform.match(a));
        if (!activity) continue;
        const data = platform.extract(activity);
        if (!data.title) continue;
        return {
            eventType: 'listening_music',
            extra: { track: data.title, artist: data.artist || 'Artista desconhecido' },
        };
    }

    return null;
}

export async function checkWatchedUsers(client) {
    const config = readJsonSafe(WATCHED_PATH);
    if (!config || !Array.isArray(config.users) || config.users.length === 0) return null;

    const sorted = [...config.users].sort((a, b) => (a.priority ?? 999) - (b.priority ?? 999));

    for (const watched of sorted) {
        try {
            const member = await resolveMember(watched.userId, client, watched.preferGuildId || null);
            if (!member || !member.presence) continue;

            const event = detectEventFromActivities(member.presence.activities);
            if (!event) continue;

            const displayName = member.user.globalName || member.user.username;
            return {
                label: watched.label || displayName,
                displayName,
                eventType: event.eventType,
                extra: event.extra,
                userId: watched.userId,
                priority: watched.priority ?? 999,
            };
        } catch {
            continue;
        }
    }

    return null;
}

// ──────────────────────────────────────────────────────────────
// Fonte 2: Rádio da Yui
// ──────────────────────────────────────────────────────────────

export function checkActiveRadio() {
    try {
        const sessions = getAllSessions();
        if (!Array.isArray(sessions)) return null;

        for (const session of sessions) {
            if (session.status !== 'PLAYING') continue;
            if (!session.currentTrack) continue;

            const { title, artist } = session.currentTrack;
            if (!title) continue;

            return {
                track: title,
                artist: artist || 'Artista desconhecido',
            };
        }
    } catch {
        // Falha silenciosa
    }
    return null;
}

// ──────────────────────────────────────────────────────────────
// Resolução de templates (presençaEvents.json)
// ──────────────────────────────────────────────────────────────

const ACTIVITY_TYPE_MAP = {
    Playing: ActivityType.Playing,
    Watching: ActivityType.Watching,
    Listening: ActivityType.Listening,
    Competing: ActivityType.Competing,
    Custom: ActivityType.Custom,
};

export function resolveEventPresence(event) {
    const eventsConfig = readJsonSafe(EVENTS_PATH);
    if (!eventsConfig || !eventsConfig.events) return null;

    const template = eventsConfig.events[event.eventType];
    if (!template) return null;

    const placeholders = {
        '{label}': event.label || '',
        '{game}': event.extra?.game || '',
        '{track}': event.extra?.track || '',
        '{artist}': event.extra?.artist || '',
    };

    let text = template.template;
    for (const [key, value] of Object.entries(placeholders)) {
        text = text.replaceAll(key, value);
    }

    const activityType = ACTIVITY_TYPE_MAP[template.activityType] ?? ActivityType.Custom;

    const activityPayload = { type: activityType };
    if (activityType === ActivityType.Custom) {
        activityPayload.name = 'custom';
        activityPayload.state = text;
    } else {
        activityPayload.name = text;
    }

    return {
        activityPayload,
        status: template.status || 'online',
    };
}

export default { checkWatchedUsers, checkActiveRadio, resolveEventPresence };

