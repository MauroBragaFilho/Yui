const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { exec } = require('child_process');
require('dotenv').config();

const TEMP_AUDIO_DIR = path.join(__dirname, '../data/temp_audio');
if (!fs.existsSync(TEMP_AUDIO_DIR)) {
    fs.mkdirSync(TEMP_AUDIO_DIR, { recursive: true });
}

function calculateConfidenceScore(query, track) {
    const cleanQuery = query.toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cleanTitle = (track.title || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    const cleanArtist = (track.artist?.name || track.artist || '').toLowerCase().normalize('NFD').replace(/[\u0300-\u036f]/g, '');
    
    let score = 0;
    const queryTokens = cleanQuery.split(/\s+/).filter(Boolean);
    const combinedText = `${cleanTitle} ${cleanArtist}`;
    
    let matchedTokens = 0;
    for (const token of queryTokens) {
        if (combinedText.includes(token)) {
            matchedTokens++;
        }
    }
    
    if (queryTokens.length > 0) {
        score = (matchedTokens / queryTokens.length) * 100;
    }
    return score;
}

async function searchDeezerTracks(query) {
    try {
        const searchUrl = `https://api.deezer.com/search?q=${encodeURIComponent(query)}`;
        const response = await axios.get(searchUrl);
        const items = response.data?.data || [];
        
        return items.slice(0, 5).map(item => ({
            id: item.id,
            title: item.title,
            artist: item.artist?.name || 'Desconhecido',
            album: item.album?.title || '',
            duration: item.duration,
            link: item.link,
            cover: item.album?.cover_medium || item.album?.cover || ''
        }));
    } catch (error) {
        console.error('[DeezerService] Erro ao buscar faixas:', error.message);
        return [];
    }
}

function downloadDeezerTrack(trackUrlOrId) {
    return new Promise((resolve, reject) => {
        const arl = process.env.DEEZER_ARL || process.env.DEEMIX_ARL || '';
        const link = String(trackUrlOrId).startsWith('http') ? trackUrlOrId : `https://www.deezer.com/track/${trackUrlOrId}`;
        const outputFolder = TEMP_AUDIO_DIR;
        const scriptPath = path.join(__dirname, 'download_deezer.py');
        const pythonBin = process.env.PYTHON_PATH || (process.platform === 'win32' ? 'python' : 'python3');
        const cmd = `${pythonBin} "${scriptPath}" "${link}" "${outputFolder}" "${arl}"`;

        exec(cmd, (error, stdout, stderr) => {
            const match = stdout.match(/DOWNLOADED_FILE:(.+)/);
            if (match && match[1]) {
                const targetPath = match[1].trim();
                if (fs.existsSync(targetPath)) {
                    return resolve(targetPath);
                }
            }

            const files = fs.readdirSync(outputFolder).filter(f => f.endsWith('.mp3') || f.endsWith('.flac'));
            if (files.length > 0) {
                const latestFile = files.map(f => ({
                    name: f,
                    time: fs.statSync(path.join(outputFolder, f)).mtimeMs
                })).sort((a, b) => b.time - a.time)[0];

                return resolve(path.join(outputFolder, latestFile.name));
            }

            if (error) {
                return reject(new Error(`Falha ao baixar faixa via deemix: ${stderr || error.message}`));
            }
            reject(new Error('Nenhum arquivo baixado pelo deemix.'));
        });
    });
}

function cleanupTempAudio(filePath) {
    if (filePath && fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            console.error('[DeezerService] Erro ao limpar arquivo temporário:', err.message);
        }
    }
}

module.exports = {
    searchDeezerTracks,
    calculateConfidenceScore,
    downloadDeezerTrack,
    cleanupTempAudio
};
