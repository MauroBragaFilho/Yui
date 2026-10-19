import axios from 'axios';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFile } from 'node:child_process';
import dotenv from 'dotenv';
import { fileURLToPath } from 'node:url';
import { logger } from '../utils/logger.js';
import { clampText } from '../discord/embedLimits.js';
dotenv.config();

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Pasta-base dos downloads. Cada pedido ganha uma subpasta própria (UUID) dentro dela. */
export const TEMP_AUDIO_DIR = path.join(__dirname, '../data/temp_audio');
const DEFAULT_SCRIPT_PATH = path.join(__dirname, 'download_deezer.py');

const DEFAULT_TIMEOUT_MS = 180 * 1000;
const MAX_BUFFER = 5 * 1024 * 1024;
const AUDIO_EXT_RE = /\.(mp3|flac)$/i;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Subpasta de pedido abandonada (processo morto, falha ao limpar) é varrida depois deste prazo.
const STALE_DIR_MS = 3 * 60 * 60 * 1000;
const SWEEP_EVERY_MS = 10 * 60 * 1000;
const lastSweepByDir = new Map();

export const DEEZER_ERROR_CODES = Object.freeze({
    NOT_INSTALLED: 'DEEMIX_NOT_INSTALLED',
    LOGIN: 'DEEZER_LOGIN',
    TIMEOUT: 'DEEZER_TIMEOUT',
    ERROR: 'DEEZER_ERROR'
});

/**
 * Mensagens curtas e seguras para o USUÁRIO (sem comando, caminho, traceback ou ARL). NEUTRAS de propósito: o
 * usuário não é informado de qual serviço está por trás do download (decisão do dono). O nome do serviço fica
 * em DEEZER_OWNER_MESSAGES (painel do dono) e nos logs.
 */
export const DEEZER_USER_MESSAGES = Object.freeze({
    [DEEZER_ERROR_CODES.NOT_INSTALLED]: 'O download de músicas por busca está indisponível no momento.',
    [DEEZER_ERROR_CODES.LOGIN]: 'O acesso ao serviço de músicas expirou ou não está configurado. Avise o responsável pelo bot.',
    [DEEZER_ERROR_CODES.TIMEOUT]: 'O download demorou demais para responder. Tente novamente em instantes.',
    [DEEZER_ERROR_CODES.ERROR]: 'Não consegui baixar essa faixa.'
});

/** Mensagens para o DONO (diagnóstico do painel de integrações): aqui o nome do serviço pode aparecer. */
export const DEEZER_OWNER_MESSAGES = Object.freeze({
    [DEEZER_ERROR_CODES.NOT_INSTALLED]: 'O download pelo Deezer está indisponível no momento.',
    [DEEZER_ERROR_CODES.LOGIN]: 'O acesso ao Deezer expirou ou não está configurado. Avise o responsável pelo bot.',
    [DEEZER_ERROR_CODES.TIMEOUT]: 'O Deezer demorou demais para responder. Tente novamente em instantes.',
    [DEEZER_ERROR_CODES.ERROR]: 'Não consegui baixar essa faixa pelo Deezer.'
});

/** Tamanho máximo da consulta enviada à busca (o texto do usuário pode ter milhares de caracteres). */
export const MAX_SEARCH_QUERY_CHARS = 150;

/** Consulta pronta para a busca: sem controle, espaços colapsados e no máximo 150 caracteres (sem partir emoji). */
export function normalizeSearchQuery(query) {
    const text = String(query ?? '').replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim();
    return clampText(text, MAX_SEARCH_QUERY_CHARS, { ellipsis: '' });
}

/** Erro de download: `message` já é a versão amigável; `code` é um dos DEEZER_ERROR_CODES. */
export class DeezerDownloadError extends Error {
    constructor(code = DEEZER_ERROR_CODES.ERROR) {
        super(DEEZER_USER_MESSAGES[code] || DEEZER_USER_MESSAGES[DEEZER_ERROR_CODES.ERROR]);
        this.name = 'DeezerDownloadError';
        this.code = DEEZER_USER_MESSAGES[code] ? code : DEEZER_ERROR_CODES.ERROR;
    }
}

export function calculateConfidenceScore(query, track) {
    const cleanQuery = query.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const cleanTitle = (track.title || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
    const cleanArtist = (track.artist?.name || track.artist || '').toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');

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

export async function searchDeezerTracks(query) {
    try {
        const text = normalizeSearchQuery(query);
        if (!text) return [];
        const searchUrl = `https://api.deezer.com/search?q=${encodeURIComponent(text)}`;
        const response = await axios.get(searchUrl, { timeout: 10000 });
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
        logger.warn(`[DeezerService] Erro ao buscar faixas: ${error.message}`);
        return [];
    }
}

// ---------------------------------------------------------------------------
// Utilidades puras (testáveis sem Python e sem rede)
// ---------------------------------------------------------------------------

/**
 * Classifica a falha do deemix. Função pura.
 * @param {string} stderr  saída de erro do script Python
 * @param {number|string|null} code  código de saída (número) ou código de spawn (ex.: 'ENOENT')
 * @param {boolean|string} signalOrKilled  verdadeiro (ou nome do sinal) quando o processo foi morto por tempo
 */
export function classifyDeezerError(stderr, code, signalOrKilled) {
    const text = String(stderr || '');
    if (signalOrKilled || code === 'ETIMEDOUT') return DEEZER_ERROR_CODES.TIMEOUT;
    if (code === 'ENOENT' || code === 'EACCES') return DEEZER_ERROR_CODES.NOT_INSTALLED; // python ausente
    if (code === 2 || /ModuleNotFoundError|No module named/i.test(text)) return DEEZER_ERROR_CODES.NOT_INSTALLED;
    if (code === 3 || /YUI_DEEZER_LOGIN_FAILED|notLoggedIn|wrongLicense/.test(text)) return DEEZER_ERROR_CODES.LOGIN;
    return DEEZER_ERROR_CODES.ERROR;
}

/** Mascara o ARL (e qualquer sequência longa tipo token) antes de ir para o log. */
export function maskSecrets(text, secrets = []) {
    let out = String(text ?? '');
    for (const secret of secrets) {
        const value = String(secret || '');
        if (value.length >= 6) out = out.split(value).join('***');
    }
    out = out.replace(/\b((?:DEEZER_ARL|DEEMIX_ARL|arl)["'\s:=]+)[A-Za-z0-9_%.\-]{12,}/gi, '$1***');
    out = out.replace(/\b[A-Za-z0-9_-]{64,}\b/g, '***');
    return out;
}

/**
 * Aceita só uma faixa do Deezer: ID numérico ou link deezer.com/[idioma/]track/<id>.
 * Devolve o link canônico ou null. Álbum, playlist, artista e encurtadores ficam de fora
 * de propósito (o ARL não deve baixar coleções inteiras).
 */
export function normalizeDeezerTrackLink(linkOrId) {
    const raw = String(linkOrId ?? '').trim();
    if (/^\d{1,15}$/.test(raw)) return `https://www.deezer.com/track/${raw}`;
    if (!/^https?:\/\//i.test(raw) || /[\u0000-\u001f\u007f\s"'`<>\\]/.test(raw)) return null;
    let url;
    try {
        url = new URL(raw);
    } catch (_) {
        return null;
    }
    if (url.username || url.password) return null;
    const host = url.hostname.toLowerCase();
    if (host !== 'deezer.com' && host !== 'www.deezer.com') return null;
    const match = url.pathname.match(/^\/(?:[a-z]{2}(?:-[a-z]{2})?\/)?track\/(\d{1,15})\/?$/i);
    return match ? `https://www.deezer.com/track/${match[1]}` : null;
}

export function getDeezerTimeoutMs(env = process.env) {
    const seconds = Number(env.YUI_DEEZER_TIMEOUT_S);
    if (Number.isFinite(seconds) && seconds >= 10 && seconds <= 900) return Math.round(seconds * 1000);
    return DEFAULT_TIMEOUT_MS;
}

export function getPythonBin(env = process.env) {
    const configured = String(env.PYTHON_PATH || '').trim().replace(/^"(.*)"$/, '$1');
    return configured || (process.platform === 'win32' ? 'python' : 'python3');
}

function readArl(env = process.env) {
    return String(env.DEEZER_ARL || env.DEEMIX_ARL || '').trim();
}

/**
 * Ambiente do processo Python: o ARL vai aqui (nunca na linha de comando) e o Python
 * é forçado a UTF-8 (em pipe no Windows ele usaria cp1252 e corromperia acentos).
 * Segredos do bot (tokens, chaves) não são repassados ao deemix.
 */
export function buildDeezerEnv(arl, baseEnv = process.env) {
    const env = {};
    for (const [key, value] of Object.entries(baseEnv)) {
        if (value === undefined) continue;
        if (/TOKEN|SECRET|PASSWORD|API_?KEY|COOKIE|PRIVATE|^DEEMIX_ARL$/i.test(key)) continue;
        env[key] = value;
    }
    env.DEEZER_ARL = arl;
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    return env;
}

function parsePrintedPath(stdout) {
    for (const line of String(stdout || '').split(/\r?\n/)) {
        const match = line.match(/^DOWNLOADED_FILE:(.+)$/);
        if (match) return match[1].trim();
    }
    return null;
}

function isInside(child, parent) {
    const test = (a, b) => {
        const rel = path.relative(b, a);
        return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel);
    };
    if (test(child, parent)) return true;
    try {
        return test(fs.realpathSync(child), fs.realpathSync(parent));
    } catch (_) {
        return false;
    }
}

function usableFileInside(candidate, dir) {
    if (!candidate) return null;
    const resolved = path.resolve(dir, candidate);
    try {
        const stat = fs.statSync(resolved);
        if (stat.isFile() && stat.size > 0 && isInside(resolved, dir)) return resolved;
    } catch (_) { /* arquivo não existe */ }
    return null;
}

/** Último recurso: arquivo de áudio dentro da subpasta do próprio pedido (nunca de outra pasta). */
function scanRequestDir(dir) {
    let best = null;
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (!entry.isFile() || !AUDIO_EXT_RE.test(entry.name)) continue;
            const full = path.join(dir, entry.name);
            const stat = fs.statSync(full);
            if (stat.size > 0 && (!best || stat.mtimeMs > best.mtimeMs)) best = { full, mtimeMs: stat.mtimeMs };
        }
    } catch (_) { /* pasta sumiu */ }
    return best ? best.full : null;
}

function runExecFile(execFileImpl, file, args, options) {
    return new Promise((resolve) => {
        try {
            execFileImpl(file, args, options, (error, stdout, stderr) => {
                resolve({ error: error || null, stdout: String(stdout ?? ''), stderr: String(stderr ?? '') });
            });
        } catch (error) {
            resolve({ error, stdout: '', stderr: '' });
        }
    });
}

// ---------------------------------------------------------------------------
// Pastas por pedido
// ---------------------------------------------------------------------------

/**
 * Remove a subpasta única de um pedido. `target` pode ser o arquivo baixado ou a própria pasta.
 * Só apaga pasta com nome UUID que seja filha direta de `baseDir`.
 */
export function cleanupDeezerDir(target, { baseDir = TEMP_AUDIO_DIR } = {}) {
    if (!target) return false;
    try {
        let dir = path.resolve(String(target));
        let isFile = true;
        try { isFile = fs.statSync(dir).isFile(); } catch (_) { /* inexistente: trata como arquivo */ }
        if (isFile) dir = path.dirname(dir);
        const parent = path.dirname(dir);
        if (!UUID_RE.test(path.basename(dir)) || path.relative(path.resolve(baseDir), parent) !== '') return false;
        fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
        return true;
    } catch (err) {
        logger.warn(`[DeezerService] Erro ao limpar pasta temporária: ${err.message}`);
        return false;
    }
}

/** Varre subpastas UUID abandonadas (mais velhas que `maxAgeMs`). Devolve quantas apagou. */
export function sweepStaleDeezerDirs(baseDir = TEMP_AUDIO_DIR, { maxAgeMs = STALE_DIR_MS, now = Date.now() } = {}) {
    let removed = 0;
    try {
        for (const entry of fs.readdirSync(baseDir, { withFileTypes: true })) {
            if (!entry.isDirectory() || !UUID_RE.test(entry.name)) continue;
            const full = path.join(baseDir, entry.name);
            try {
                if (now - fs.statSync(full).mtimeMs > maxAgeMs) {
                    fs.rmSync(full, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
                    removed++;
                }
            } catch (_) { /* em uso ou já removida */ }
        }
    } catch (_) { /* base ainda não existe */ }
    return removed;
}

function sweepThrottled(baseDir) {
    const now = Date.now();
    const key = path.resolve(baseDir);
    if (now - (lastSweepByDir.get(key) || 0) < SWEEP_EVERY_MS) return;
    lastSweepByDir.set(key, now);
    sweepStaleDeezerDirs(baseDir, { now });
}

// ---------------------------------------------------------------------------
// Download
// ---------------------------------------------------------------------------

/**
 * Baixa uma faixa do Deezer via deemix (processo Python, sem shell).
 * Devolve o caminho do arquivo, dentro de uma subpasta única (`<outDir>/<uuid>/`).
 * O chamador deve limpar com `cleanupDeezerDir(caminho)` depois de usar o arquivo.
 *
 * @param {string|number} linkOrId  ID numérico ou link deezer.com/track/<id>
 * @param {object} [options]
 * @param {string} [options.pythonBin]  padrão: PYTHON_PATH ou python/python3
 * @param {string} [options.scriptPath]  padrão: download_deezer.py
 * @param {string} [options.outDir]  pasta-base onde a subpasta do pedido é criada
 * @param {number} [options.timeoutMs]  padrão: YUI_DEEZER_TIMEOUT_S (180 s)
 * @param {string} [options.arl]  padrão: DEEZER_ARL / DEEMIX_ARL
 * @param {Function} [options.execFileImpl]  injeção para testes (assinatura de child_process.execFile)
 * @throws {DeezerDownloadError}  com `.code` e mensagem amigável
 */
export async function downloadDeezerTrack(linkOrId, options = {}) {
    const pythonBin = options.pythonBin || getPythonBin();
    const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
    const outDir = options.outDir || TEMP_AUDIO_DIR;
    const timeoutMs = options.timeoutMs || getDeezerTimeoutMs();
    const execFileImpl = options.execFileImpl || execFile;
    const arl = options.arl !== undefined ? String(options.arl || '').trim() : readArl();

    const link = normalizeDeezerTrackLink(linkOrId);
    if (!link) {
        logger.warn('[DeezerService] Pedido recusado: link/ID não é uma faixa do Deezer.');
        throw new DeezerDownloadError(DEEZER_ERROR_CODES.ERROR);
    }
    if (!arl) {
        logger.error('[DeezerService] DEEZER_ARL não configurado; download pelo Deezer desativado.');
        throw new DeezerDownloadError(DEEZER_ERROR_CODES.LOGIN);
    }

    sweepThrottled(outDir);
    const requestDir = path.join(outDir, crypto.randomUUID());
    try {
        fs.mkdirSync(requestDir, { recursive: true });
    } catch (err) {
        logger.error(`[DeezerService] Não consegui criar a pasta do pedido: ${err.message}`);
        throw new DeezerDownloadError(DEEZER_ERROR_CODES.ERROR);
    }

    const env = buildDeezerEnv(arl);
    const args = [scriptPath, link, requestDir]; // o ARL NÃO vai aqui: vai em env.DEEZER_ARL
    const startedAt = Date.now();
    const { error, stdout, stderr } = await runExecFile(execFileImpl, pythonBin, args, {
        env,
        cwd: requestDir,
        timeout: timeoutMs,
        windowsHide: true,
        maxBuffer: MAX_BUFFER,
        encoding: 'utf8'
    });
    const elapsedMs = Date.now() - startedAt;

    const killed = !!error && error.killed === true && error.code !== 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER';
    if (!killed) {
        // Só vale o caminho impresso pelo script; sem erro, aceita também arquivo na subpasta do pedido.
        const found = usableFileInside(parsePrintedPath(stdout), requestDir) || (!error ? scanRequestDir(requestDir) : null);
        if (found) {
            logger.info(`[DeezerService] Faixa baixada (${elapsedMs} ms, ${fs.statSync(found).size} bytes).${error ? ' Aviso: o script terminou com erro depois de gerar o arquivo.' : ''}`);
            return found;
        }
    }

    const exitCode = error ? (error.code ?? null) : 0;
    const errorCode = classifyDeezerError(stderr, exitCode, killed ? (error.signal || true) : false);
    const detail = maskSecrets(`${stderr}`.trim().slice(-1500), [arl]);
    const hint = errorCode === DEEZER_ERROR_CODES.NOT_INSTALLED
        ? ' (instale com: pip install -r requirements-deemix.txt e aponte PYTHON_PATH para esse Python)'
        : '';
    logger.error(`[DeezerService] Falha ${errorCode} (saída=${exitCode}, ${elapsedMs} ms)${hint}${detail ? `: ${detail}` : ''}`);
    cleanupDeezerDir(requestDir, { baseDir: outDir });
    throw new DeezerDownloadError(errorCode);
}

/**
 * Verificação sem rede e sem login: roda `download_deezer.py --check`.
 * @returns {Promise<{ok: boolean, code: string|null, versions: object|null, message: string}>}
 */
export async function checkDeemix(options = {}) {
    const pythonBin = options.pythonBin || getPythonBin();
    const scriptPath = options.scriptPath || DEFAULT_SCRIPT_PATH;
    const execFileImpl = options.execFileImpl || execFile;
    const { error, stdout, stderr } = await runExecFile(execFileImpl, pythonBin, [scriptPath, '--check'], {
        env: buildDeezerEnv(''),
        timeout: options.timeoutMs || 20000,
        windowsHide: true,
        maxBuffer: 1024 * 1024,
        encoding: 'utf8'
    });

    let info = null;
    for (const line of stdout.split(/\r?\n/)) {
        try { info = JSON.parse(line); break; } catch (_) { /* próxima linha */ }
    }
    if (!error && info?.ok) {
        const message = `deemix ${info.deemix || '?'}, deezer-py ${info['deezer-py'] || '?'} (Python ${info.python || '?'})`;
        if (options.log !== false) logger.info(`[MediaTools] deemix: OK (${message})`);
        return { ok: true, code: null, versions: info, message };
    }

    const killed = !!error && error.killed === true;
    const code = classifyDeezerError(stderr, error ? (error.code ?? null) : 0, killed);
    if (options.log !== false) {
        logger.warn(`[MediaTools] deemix: FALTANDO (${code}). Instale com: pip install -r requirements-deemix.txt e defina PYTHON_PATH.`);
    }
    return { ok: false, code, versions: info, message: DEEZER_OWNER_MESSAGES[code] };
}

let lastStatus = null;
/** Resultado do `checkDeemix` com cache (para painéis que consultam com frequência). */
export async function getDeemixStatus({ maxAgeMs = 10 * 60 * 1000, ...options } = {}) {
    if (lastStatus && Date.now() - lastStatus.at < maxAgeMs) return lastStatus.value;
    const value = await checkDeemix(options);
    lastStatus = { at: Date.now(), value };
    return value;
}

/** Apaga o arquivo baixado e, se ele estiver numa subpasta de pedido, a subpasta inteira. */
export function cleanupTempAudio(filePath) {
    if (!filePath) return;
    if (cleanupDeezerDir(filePath)) return;
    if (fs.existsSync(filePath)) {
        try {
            fs.unlinkSync(filePath);
        } catch (err) {
            logger.warn(`[DeezerService] Erro ao limpar arquivo temporário: ${err.message}`);
        }
    }
}

export default {
    searchDeezerTracks,
    calculateConfidenceScore,
    downloadDeezerTrack,
    cleanupTempAudio,
    cleanupDeezerDir,
    classifyDeezerError,
    checkDeemix,
    getDeemixStatus
};
