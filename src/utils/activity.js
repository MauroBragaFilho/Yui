import { ActivityType } from 'discord.js';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkWatchedUsers, checkActiveRadio, resolveEventPresence } from './watchedPresence.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PRESENCE_PATH = path.join(__dirname, '../data/presence.json');

const ACTIVITY_TYPE_MAP = {
    Playing: ActivityType.Playing,
    Watching: ActivityType.Watching,
    Listening: ActivityType.Listening,
    Competing: ActivityType.Competing,
    Custom: ActivityType.Custom,
};

const DEFAULT_CONFIG = {
    defaultIntervalHours: 2,
    statuses: [
        { type: 'Custom', text: 'GTA Online Updates', status: 'online' },
    ],
};

let cachedConfig = null;
let cachedMtimeMs = 0;

function loadPresenceConfig() {
    try {
        const stat = fs.statSync(PRESENCE_PATH);
        if (cachedConfig && stat.mtimeMs === cachedMtimeMs) {
            return cachedConfig;
        }
        const raw = fs.readFileSync(PRESENCE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.statuses) || parsed.statuses.length === 0) {
            throw new Error('presence.json não contém uma lista "statuses" válida.');
        }
        cachedConfig = parsed;
        cachedMtimeMs = stat.mtimeMs;
        return cachedConfig;
    } catch (err) {
        console.warn(`[Activity] Falha ao ler presence.json (usando fallback): ${err.message}`);
        return DEFAULT_CONFIG;
    }
}

// ──────────────────────────────────────────────────────────────
// Config ajustável do sistema
// ──────────────────────────────────────────────────────────────

const CHECK_INTERVAL_MS = 30_000;   // frequência da checagem de eventos
const MIN_SET_PRESENCE_INTERVAL_MS = 12_000; // respeita o rate limit do Discord
const EVENT_DEBOUNCE_CHECKS = 3;    // nº de checagens "sem evento" antes de liberar o ciclo

// ──────────────────────────────────────────────────────────────
// Estado interno
// ──────────────────────────────────────────────────────────────

let clientRef = null;
let cycleTimer = null;       // timer do ciclo normal (presence.json)
let checkTimer = null;       // timer da checagem de eventos

let currentIndex = 0;            // posição no ciclo normal
let currentPresenceSource = 'cycle'; // 'watched' | 'radio' | 'cycle'
let consecutiveNullChecks = 0;  // debounce antes de voltar ao ciclo
let lastPresenceUpdate = 0;     // cooldown do rate limit


// ──────────────────────────────────────────────────────────────
// Aplicação de presence (com cooldown de rate limit)
// ──────────────────────────────────────────────────────────────

function applyPresence(clientInstance, activityPayload, statusText) {
    if (!clientInstance || !clientInstance.user) return false;

    const now = Date.now();
    if (now - lastPresenceUpdate < MIN_SET_PRESENCE_INTERVAL_MS) {
        return false;
    }
    lastPresenceUpdate = now;

    clientInstance.user.setPresence({
        activities: [activityPayload],
        status: statusText || 'online',
    });
    return true;
}

// ──────────────────────────────────────────────────────────────
// Ciclo normal (Fonte 3 — presence.json)
// ──────────────────────────────────────────────────────────────

function applyCycleStatus(clientInstance) {
    if (!clientInstance || !clientInstance.user) return;

    const config = loadPresenceConfig();
    const list = config.statuses;
    if (currentIndex >= list.length) currentIndex = 0;

    const entry = list[currentIndex];
    const activityType = ACTIVITY_TYPE_MAP[entry.type] ?? ActivityType.Custom;

    const activityPayload = { type: activityType };
    if (activityType === ActivityType.Custom) {
        activityPayload.name = 'custom';
        activityPayload.state = entry.text;
    } else {
        activityPayload.name = entry.text;
    }

    const applied = applyPresence(clientInstance, activityPayload, entry.status || 'online');
    if (applied) {
        console.log(`[Activity][Ciclo] ${entry.type}: "${entry.text}" (${entry.status || 'online'})`);
        currentIndex = (currentIndex + 1) % list.length;
    }

    scheduleCycle(clientInstance, entry, config.defaultIntervalHours);
}

function scheduleCycle(clientInstance, entry, defaultIntervalHours) {
    if (cycleTimer) clearTimeout(cycleTimer);

    const hours = typeof entry.intervalHours === 'number' && entry.intervalHours > 0
        ? entry.intervalHours
        : (defaultIntervalHours || 2);

    cycleTimer = setTimeout(() => {
        if (currentPresenceSource === 'cycle') {
            applyCycleStatus(clientInstance);
        }
    }, hours * 60 * 60 * 1000);
}

// ──────────────────────────────────────────────────────────────
// Aplicação de evento (Fontes 1 e 2)
// ──────────────────────────────────────────────────────────────

function applyEvent(clientInstance, event) {
    const resolved = resolveEventPresence(event);
    if (!resolved) return;

    const applied = applyPresence(clientInstance, resolved.activityPayload, resolved.status);
    if (applied) {
        console.log(`[Activity][${event.eventType}] ${event.label || ''} → "${resolved.activityPayload.name}"`);
    }
}

// ──────────────────────────────────────────────────────────────
// Checagem de eventos (Timer rápido)
// ──────────────────────────────────────────────────────────────

async function runEventCheck() {
    if (!clientRef || !clientRef.user) return;

    let watchedEvent = null;
    let radioEvent = null;

    try {
        watchedEvent = await checkWatchedUsers(clientRef);
    } catch {
        watchedEvent = null;
    }

    if (!watchedEvent) {
        try {
            const radio = checkActiveRadio();
            if (radio) {
                radioEvent = { eventType: 'radio_track', extra: radio };
            }
        } catch {
            radioEvent = null;
        }
    }

    const activeEvent = watchedEvent || radioEvent;

    if (activeEvent) {
        consecutiveNullChecks = 0;
        if (currentPresenceSource !== (watchedEvent ? 'watched' : 'radio')) {
            currentPresenceSource = watchedEvent ? 'watched' : 'radio';
            console.log(`[Activity] Controle assumido por: ${currentPresenceSource}`);
        }
        applyEvent(clientRef, activeEvent);
    } else {
        consecutiveNullChecks++;
        if (currentPresenceSource !== 'cycle' && consecutiveNullChecks >= EVENT_DEBOUNCE_CHECKS) {
            currentPresenceSource = 'cycle';
            consecutiveNullChecks = 0;
            console.log('[Activity] Sem eventos ativos — retomando ciclo normal.');
            applyCycleStatus(clientRef);
        }
    }
}

function startEventChecker(client) {
    if (checkTimer) clearInterval(checkTimer);
    checkTimer = setInterval(() => {
        runEventCheck();
    }, CHECK_INTERVAL_MS);
}

// ──────────────────────────────────────────────────────────────
// API pública (compatível com o que já existia)
// ──────────────────────────────────────────────────────────────

function startActivityUpdater(client) {
    if (cycleTimer) {
        clearTimeout(cycleTimer);
        cycleTimer = null;
    }
    if (checkTimer) {
        clearInterval(checkTimer);
        checkTimer = null;
    }
    if (client) clientRef = client;
    currentIndex = 0;
    currentPresenceSource = 'cycle';
    consecutiveNullChecks = 0;

    if (clientRef && clientRef.user) {
        applyCycleStatus(clientRef);
    }
    startEventChecker(clientRef);
}

function updateBotActivity(clientInstance, queueLength) {
    if (!clientInstance || !clientInstance.user) return;
    if (!cycleTimer) {
        startActivityUpdater(clientInstance);
    } else if (!clientRef) {
        clientRef = clientInstance;
    }
}

export { updateBotActivity, startActivityUpdater };
export default { updateBotActivity, startActivityUpdater };

