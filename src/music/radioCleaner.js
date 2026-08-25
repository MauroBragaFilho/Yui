import fs from 'fs.js';
import path from 'path.js';
import { getAllSessions } from './radioDatabase.js';

const TEMP_RADIO_DIR = path.join(__dirname, 'data', 'temp_radio_audio');
if (!fs.existsSync(TEMP_RADIO_DIR)) {
    fs.mkdirSync(TEMP_RADIO_DIR, { recursive: true });
}

function cleanTempRadioAudio(maxAgeMs = 15 * 60 * 1000) {
    if (!fs.existsSync(TEMP_RADIO_DIR)) return;

    try {
        const files = fs.readdirSync(TEMP_RADIO_DIR);
        const now = Date.now();

        const activePaths = new Set();
        const sessions = getAllSessions();
        for (const s of sessions) {
            if (s && s.currentTrack && s.currentTrack.localPath) {
                activePaths.add(path.resolve(s.currentTrack.localPath));
            }
        }

        for (const file of files) {
            const filePath = path.join(TEMP_RADIO_DIR, file);
            try {
                const stat = fs.statSync(filePath);
                if (stat.isFile()) {
                    const resolved = path.resolve(filePath);
                    if (activePaths.has(resolved)) continue;

                    const age = now - stat.mtimeMs;
                    if (age > maxAgeMs) {
                        fs.unlinkSync(filePath);
                    }
                }
            } catch (_) {}
        }
    } catch (_) {}
}

function startAutoCleaner(intervalMs = 10 * 60 * 1000) {
    cleanTempRadioAudio(15 * 60 * 1000);
    setInterval(() => {
        cleanTempRadioAudio(15 * 60 * 1000);
    }, intervalMs);
}

startAutoCleaner();

export default {
    TEMP_RADIO_DIR,
    cleanTempRadioAudio,
    startAutoCleaner
};
