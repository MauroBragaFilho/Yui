import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import config from '../config.js';
import { logger } from '../utils/logger.js';
import { getYtdlpPath, getFfmpegPath } from '../utils/binaries.js';
import {
    MediaError,
    MEDIA_MESSAGES,
    normalizeSpotifyUrl,
    buildYtdlpAudioFlags,
    readDownloadLimits,
    createRequestDir,
    removeRequestDir,
    sweepStaleRequestDirs,
    safeFileStem,
    runTool,
    isMissingBinary,
    resolveExistingPath,
    resolveBinaryPath,
} from '../utils/mediaUrls.js';
import { prepareAudioForDelivery, describePrepared } from '../utils/audioFit.js';
// O resolvedor do spotdl mora em spotdlTools.js (e não em binaries.js) de propósito: assim este handler só importa
// getYtdlpPath/getFfmpegPath de binaries.js, e o stub desse módulo em tests/test-deezer.js não quebra o link ESM.
import {
    buildSpotdlArgs,
    buildSpotdlEnv,
    withEnv,
    classifySpotdlRun,
    spotdlFailureToMediaError,
    summarizeToolOutput,
    resolveSpotdl,
    readSpotdlBitrate,
    readSpotdlLogLevel,
    getSpotdlGate,
    getSpotdlBreaker,
    trackSpotdlChild,
    forgetSpotdlChild,
    installSpotdlExitHook,
} from '../utils/spotdlTools.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// A pasta só é criada sob demanda (uma subpasta única por pedido), nunca ao importar o módulo.
const TEMP_SPOTIFY_DIR = path.join(__dirname, '../data/temp_spotify');
const MAX_BUFFER = 1024 * 1024 * 10;
const SWEEP_INTERVAL_MS = 5 * 60 * 1000;
let lastSweepAt = 0;
// Caminhos do spotdl já anunciados no log (uma linha por caminho distinto, não uma por pedido).
const announcedSpotdlPaths = new Set();

const activeUserProcesses = new Set();

// Locks por usuário
export function isUserBusy(userId) {
    return activeUserProcesses.has(userId);
}
export function lockUser(userId) {
    activeUserProcesses.add(userId);
}
export function unlockUser(userId) {
    activeUserProcesses.delete(userId);
}
export function canBypass(userId) {
    return config.isOwner(userId);
}

function logSpotifyAction(type, url, context, status, extra = '') {
    let source = 'Desconhecido';
    let userStr = 'N/A';
    let localStr = 'DM';
    if (context) {
        source = context.source || source;
        if (context.user) {
            userStr = `${context.user.tag} (${context.user.id})`;
        } else if (context.userTag && context.userId) {
            userStr = `${context.userTag} (${context.userId})`;
        } else if (context.userId) {
            userStr = `ID: ${context.userId}`;
        }
        if (context.guild) {
            localStr = context.guild.name;
        } else if (context.guildName) {
            localStr = context.guildName;
        }
    }
    const extraStr = extra ? ` | ${extra}` : '';
    // A URL registrada é sempre a canônica (nunca o texto cru do usuário).
    const line = `[LOG] ${type} [SPOTIFY] (${source}) | Usuário: ${userStr} | Local: ${localStr} | URL: ${url || 'n/a'} | Status: ${status}${extraStr}`;
    if (/^erro/i.test(status)) logger.warn(line);
    else logger.info(line);
}

function sweepIfDue(root) {
    const now = Date.now();
    if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
    lastSweepAt = now;
    try {
        sweepStaleRequestDirs(root);
    } catch (err) {
        logger.warn(`[SpotifyHandler] Faxina de temporários falhou: ${err.message}`);
    }
}

// MP3 mais recente da subpasta do pedido (a subpasta é só deste pedido).
function findNewestMp3(dir) {
    let newest = null;
    let newestTime = 0;
    try {
        for (const name of fs.readdirSync(dir)) {
            if (!name.toLowerCase().endsWith('.mp3')) continue;
            const full = path.join(dir, name);
            const stat = fs.statSync(full);
            if (stat.isFile() && stat.mtimeMs >= newestTime) {
                newestTime = stat.mtimeMs;
                newest = full;
            }
        }
    } catch { /* pasta sumiu */ }
    return newest;
}

// Todos os .mp3 do TOPO da pasta do pedido (a `_home` do spotdl e o que há dentro dela não entram).
function listMp3Files(dir) {
    const found = [];
    try {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
            if (entry.isFile() && entry.name.toLowerCase().endsWith('.mp3')) found.push(path.join(dir, entry.name));
        }
    } catch { /* pasta sumiu */ }
    return found;
}

// Saída do spotdl para o log: 0, o código de erro (ENOENT, 1...) ou "erro". Só caracteres seguros.
function exitLabel(run) {
    if (!run.error) return '0';
    const code = run.error.code;
    if (code !== undefined && code !== null && /^[A-Za-z0-9_-]{1,50}$/.test(String(code))) return String(code); // cabe ERR_CHILD_PROCESS_STDIO_MAXBUFFER
    return run.timedOut ? 'timeout' : 'erro';
}

/**
 * Estratégia 1: spotdl. Devolve { file } quando há EXATAMENTE um mp3 e o spotdl não deu erro, ou { missing: true }
 * quando o spotdl não está instalado (o chamador cai no yt-dlp). Qualquer outro desfecho lança MediaError.
 *
 * Salvaguardas (cobertas por tests/test-spotdl.js):
 *  - o disjuntor e o porteiro são consultados ANTES de criar a `_home` ou iniciar qualquer processo;
 *  - ambiente mínimo: sem tokens da Yui, com USERPROFILE/HOME/TEMP dentro da pasta do pedido (R1);
 *  - defesa em profundidade do R1: mais de um mp3 na pasta do pedido é anomalia (descarta tudo);
 *  - o código de saída do spotdl não é confiável (sai com 0 sem arquivo): classifica-se pelo texto.
 */
async function runSpotdlStrategy({ target, tempDir, ffmpegPath, limits, deps, execFileImpl }) {
    const baseEnv = deps.baseEnv || process.env;
    const spotdl = deps.spotdlPath ? { path: deps.spotdlPath, source: 'deps' } : resolveSpotdl({ env: baseEnv });
    if (!announcedSpotdlPaths.has(spotdl.path)) {
        announcedSpotdlPaths.add(spotdl.path);
        logger.info(`[SpotifyHandler] spotdl: ${spotdl.path} (origem: ${spotdl.source})`);
        if (spotdl.warning) logger.warn(`[SpotifyHandler] ${spotdl.warning}`);
    }
    const bitrate = readSpotdlBitrate(baseEnv);
    const logLevel = readSpotdlLogLevel(baseEnv);
    const breaker = deps.spotdlBreaker || getSpotdlBreaker();
    const gate = deps.spotdlGate || getSpotdlGate(baseEnv);

    breaker.assertClosed(); // SPOTIFY_BLOCKED sem iniciar processo
    const release = await gate.acquire(); // SPOTIFY_BUSY se a fila estiver cheia
    const startedAt = Date.now();
    let child = null;
    let run;
    try {
        breaker.assertClosed(); // pode ter aberto enquanto este pedido esperava na fila
        installSpotdlExitHook(); // se a Yui sair no meio do download, a árvore do spotdl é encerrada
        const homeDir = path.join(tempDir, '_home'); // "home" do spotdl só deste pedido; some junto com a pasta
        const tmpDir = path.join(homeDir, 'tmp');
        fs.mkdirSync(tmpDir, { recursive: true });
        run = await runTool(
            resolveBinaryPath(spotdl.path),
            buildSpotdlArgs(target.url, tempDir, { ffmpegPath, bitrate, logLevel }), // ffmpegPath já é absoluto ou null
            {
                timeoutMs: limits.timeoutMs,
                maxBuffer: MAX_BUFFER,
                cwd: tempDir,
                execFileImpl: withEnv(execFileImpl, buildSpotdlEnv(homeDir, tmpDir, baseEnv), (spawned) => {
                    child = spawned;
                    trackSpotdlChild(spawned);
                }),
                // runTool derruba a ÁRVORE (taskkill /T /F): spotdl.exe -> python.exe (venv) -> python.exe (base) -> ffmpeg/deno
                killImpl: deps.killImpl,
            },
        );
    } finally {
        forgetSpotdlChild(child);
        release();
    }
    const seconds = ((Date.now() - startedAt) / 1000).toFixed(1);

    const mp3Files = listMp3Files(tempDir);
    if (mp3Files.length > 1) {
        // R1: uma faixa por pedido. Mais de um mp3 quer dizer que algo expandiu a lista (álbum, config do spotdl...);
        // entregar "o mais novo" esconderia o problema. A pasta do pedido inteira é apagada pelo catch do chamador.
        logger.error(`[SpotifyHandler] R1: o spotdl gerou ${mp3Files.length} arquivos mp3 para uma única faixa; pedido descartado.`);
        throw new MediaError('SPOTIFY_ERROR', MEDIA_MESSAGES.SPOTIFY_ERROR, { detail: `R1: ${mp3Files.length} arquivos mp3 na pasta do pedido` });
    }
    if (!run.error && mp3Files.length === 1) {
        breaker.record('ok');
        logger.info(`[SpotifyHandler] spotdl: ok, saída 0, ${seconds} s`);
        const maxBytes = (Number(limits.maxFilesizeMB) || 0) * 1024 * 1024; // o spotdl não tem limite próprio de tamanho/duração
        if (maxBytes > 0 && fs.statSync(mp3Files[0]).size > maxBytes) {
            throw new MediaError('FILE_TOO_LARGE', MEDIA_MESSAGES.FILE_TOO_LARGE);
        }
        return { file: mp3Files[0] };
    }

    // Sem arquivo (ou com erro). O spotdl sai com 0 mesmo quando a faixa não foi achada: classifique pelo texto.
    const verdict = classifySpotdlRun(run, { debug: logLevel === 'DEBUG' });
    const opened = breaker.record(verdict.kind);
    logger.warn(`[SpotifyHandler] spotdl: ${verdict.kind}, saída ${exitLabel(run)}, ${seconds} s`
        + `${verdict.detail ? `. Resumo: ${verdict.detail}` : ''}${verdict.hint ? `. ${verdict.hint}` : ''}`);
    if (opened) logger.warn('[SpotifyHandler] Disjuntor do spotdl aberto por 5 minutos depois de falhas seguidas do Spotify ou da rede.');
    if (verdict.kind === 'missing') return { missing: true };
    // Sem fallback para o yt-dlp: ele não baixa áudio do Spotify (DRM) e só dobraria o tempo (outro timeout de 300 s).
    throw spotdlFailureToMediaError(verdict, run.error);
}

/**
 * Baixa uma FAIXA do Spotify.
 * Tenta primeiro o `spotdl` (ambiente .venv-spotdl, SPOTDL_PATH ou PATH). O `yt-dlp` só entra como reserva quando o
 * spotdl NÃO está instalado; se o spotdl existe e falha, a resposta é a causa real (o yt-dlp não baixa áudio do Spotify).
 * Álbum, playlist, artista, podcast e episódio são recusados (SPOTIFY_ONLY_TRACK): não há como
 * limitar o `spotdl` a uma única faixa de forma comprovadamente segura.
 *
 * @param {string} url URL do Spotify (precisa ser de uma faixa)
 * @param {object} context Contexto do comando (source, user, guild, etc.)
 * @param {object} [deps] Só para testes: { execFileImpl, killImpl, tempRoot, ytdlpPath, ffmpegPath, cookiesPath, extraFlags,
 *   limits, spotdlPath, baseEnv (ambiente de origem), spotdlGate, spotdlBreaker }
 * @returns {Promise<{filePath, metadata, cleanup}>} `cleanup()` apaga a subpasta temporária do pedido.
 */
export async function downloadSpotify(url, context = null, deps = {}) {
    const target = normalizeSpotifyUrl(url);
    if (!target) {
        logSpotifyAction('Download Spotify', null, context, 'Erro', 'Código: SPOTIFY_INVALID_URL');
        throw new MediaError('SPOTIFY_INVALID_URL', MEDIA_MESSAGES.SPOTIFY_INVALID_URL);
    }
    if (target.kind !== 'track') {
        logSpotifyAction('Download Spotify', target.url, context, 'Erro', `Código: SPOTIFY_ONLY_TRACK (${target.kind})`);
        throw new MediaError('SPOTIFY_ONLY_TRACK', MEDIA_MESSAGES.SPOTIFY_ONLY_TRACK);
    }

    const execFileImpl = deps.execFileImpl || execFile;
    const limits = { ...readDownloadLimits(), ...(deps.limits || {}) };
    const tempRoot = deps.tempRoot || TEMP_SPOTIFY_DIR;
    sweepIfDue(tempRoot);
    const tempDir = createRequestDir(tempRoot);
    const ffmpegCandidate = deps.ffmpegPath !== undefined ? deps.ffmpegPath : getFfmpegPath();
    // spotdl e yt-dlp rodam com cwd na subpasta do pedido: caminhos relativos do .env viram absolutos aqui.
    const ffmpegPath = resolveExistingPath(ffmpegCandidate);
    const cleanup = () => removeRequestDir(tempRoot, tempDir);
    const finish = async (file, provider) => {
        // Entrega ao Discord: recomprime se passar do limite de upload e limpa as tags de origem (URL e comentário que o
        // spotdl grava). `provider` fica só nos metadados internos e no log: não aparece em nada que o usuário recebe.
        const prepared = await prepareAudioForDelivery(file, {
            context,
            env: deps.env,
            ffmpegPath: ffmpegPath || resolveBinaryPath(deps.ffmpegPath || getFfmpegPath()),
            execFileImpl,
            killImpl: deps.killImpl,
            ...(deps.audioFit || {}),
        });
        const preparedNote = describePrepared(prepared);
        const title = path.basename(file, '.mp3');
        const sizeMB = (fs.statSync(file).size / (1024 * 1024)).toFixed(1);
        logSpotifyAction('Download Spotify', target.url, context, `Sucesso (${provider})`, `Tamanho: ${sizeMB} MB${preparedNote ? ` | ${preparedNote}` : ''}`);
        return { filePath: file, metadata: { title, provider }, cleanup };
    };

    logSpotifyAction('Download Spotify', target.url, context, 'Iniciado');

    let spotdlMissing = false;
    try {
        // ---- Estratégia 1: spotdl (ambiente isolado, UMA faixa, ambiente mínimo) ----
        const spotdlResult = await runSpotdlStrategy({ target, tempDir, ffmpegPath, limits, deps, execFileImpl });
        if (spotdlResult.file) return await finish(spotdlResult.file, 'spot-dlp');
        spotdlMissing = Boolean(spotdlResult.missing); // só chega aqui com o spotdl ausente: cai no yt-dlp

        // ---- Estratégia 2: yt-dlp (fallback) ----
        const cookies = deps.cookiesPath !== undefined ? deps.cookiesPath : config.ytdlpCookiesPath;
        const flags = buildYtdlpAudioFlags(path.join(tempDir, 'spotify.%(ext)s'), target.url, {
            audioQuality: 2,
            maxMinutes: limits.maxMinutes,
            maxFilesizeMB: limits.maxFilesizeMB,
            cookiesPath: resolveExistingPath(cookies),
            extraFlags: deps.extraFlags || config.ytdlpExtraFlags || [],
            ffmpegPath,
        });
        logSpotifyAction('Download Spotify (fallback yt-dlp)', target.url, context, 'Fallback iniciado');

        const ytdlpRun = await runTool(resolveBinaryPath(deps.ytdlpPath || getYtdlpPath()), flags, {
            timeoutMs: limits.timeoutMs,
            maxBuffer: MAX_BUFFER,
            cwd: tempDir,
            execFileImpl,
            killImpl: deps.killImpl,
        });

        if (ytdlpRun.error) {
            const text = `${ytdlpRun.stdout}\n${ytdlpRun.stderr}`;
            // Resumo seguro (sem URL assinada, caminho nem chave=valor); o error.message cru traz a linha de comando inteira.
            const detail = summarizeToolOutput(ytdlpRun.stderr) || summarizeToolOutput(ytdlpRun.error.message);
            const make = (code, message) => new MediaError(code, message, { detail, cause: ytdlpRun.error });
            if (ytdlpRun.timedOut) throw make('DOWNLOAD_TIMEOUT', MEDIA_MESSAGES.DOWNLOAD_TIMEOUT);
            if (isMissingBinary(ytdlpRun)) {
                throw make(spotdlMissing ? 'SPOTIFY_UNAVAILABLE' : 'YTDLP_NOT_INSTALLED',
                    spotdlMissing ? MEDIA_MESSAGES.SPOTIFY_UNAVAILABLE : MEDIA_MESSAGES.YTDLP_NOT_INSTALLED);
            }
            if (/private|restricted|não disponível/i.test(text)) throw make('SPOTIFY_PRIVATE', MEDIA_MESSAGES.SPOTIFY_PRIVATE);
            // O yt-dlp não baixa áudio do Spotify (DRM); sem o spotdl, a causa provável é essa.
            if (spotdlMissing) throw make('SPOTIFY_UNAVAILABLE', MEDIA_MESSAGES.SPOTIFY_UNAVAILABLE);
            throw make('SPOTIFY_ERROR', MEDIA_MESSAGES.SPOTIFY_ERROR);
        }

        const matching = findNewestMp3(tempDir);
        if (!matching) throw new MediaError('SPOTIFY_NO_FILE', MEDIA_MESSAGES.SPOTIFY_NO_FILE);

        // Tenta extrair o título do JSON retornado pelo yt-dlp
        // Nome de reserva neutro (vira o título mostrado ao usuário quando a faixa vem sem título): não cita a origem.
        let title = 'musica';
        try {
            for (const line of ytdlpRun.stdout.split(/\r?\n/)) {
                const trimmed = line.trim();
                if (!trimmed.startsWith('{') || !trimmed.endsWith('}')) continue;
                const meta = JSON.parse(trimmed);
                title = safeFileStem(meta.title || meta.track || 'musica', 'musica');
                break;
            }
        } catch { /* mantém o título padrão */ }

        let resolvedPath = matching;
        const finalPath = path.join(tempDir, `${title}.mp3`);
        if (finalPath !== matching) {
            try {
                fs.renameSync(matching, finalPath);
                resolvedPath = finalPath;
            } catch { /* mantém o caminho original */ }
        }
        return await finish(resolvedPath, 'yt-dlp');
    } catch (err) {
        cleanup();
        const mediaError = err instanceof MediaError
            ? err
            : new MediaError('SPOTIFY_ERROR', MEDIA_MESSAGES.SPOTIFY_ERROR, { cause: err, detail: err && err.message });
        logSpotifyAction('Download Spotify', target.url, context, 'Erro',
            `Código: ${mediaError.code}${mediaError.detail ? ` | Detalhe: ${mediaError.detail}` : ''}`);
        throw mediaError;
    }
}

export default {
    downloadSpotify,
    isUserBusy,
    lockUser,
    unlockUser,
    canBypass,
};
