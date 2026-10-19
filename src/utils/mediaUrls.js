// Links de mídia (YouTube, Instagram, TikTok, Spotify): validação, normalização e
// montagem dos argumentos do yt-dlp.
//
// Regras deste módulo:
//  - NUNCA repassa a string do usuário ao yt-dlp/spotdl: o link é parseado com
//    `new URL()`, o host é conferido numa lista permitida e a URL CANÔNICA é
//    reconstruída a partir do identificador extraído.
//  - Os argumentos dos binários são ARRAYS (para `execFile`, sem shell, sem aspas).
//  - Importar o módulo não tem efeito colateral: só mexe em disco / processos quando
//    uma função de pasta temporária ou de execução é chamada.
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clampText } from '../discord/embedLimits.js';

// ---------------------------------------------------------------------------
// Mensagens amigáveis (o detalhe técnico vai só para o logger)
// ---------------------------------------------------------------------------

export const MEDIA_MESSAGES = Object.freeze({
    URL_INVALID: 'Esse link não é de uma plataforma suportada. Use um link do YouTube, Instagram ou TikTok.',
    VIDEO_PRIVATE: 'Este vídeo é privado ou não está disponível.',
    VIDEO_AGE_RESTRICTED: 'Este vídeo tem restrição de idade e não pôde ser baixado.',
    YOUTUBE_BOT_CHECK: 'O YouTube pediu uma verificação anti-robô para esse vídeo. Tente de novo mais tarde ou use outro link.',
    FORMAT_UNAVAILABLE: 'Não encontrei um formato de áudio adequado para esse vídeo.',
    YTDLP_NOT_INSTALLED: 'O baixador de mídia não está disponível na máquina da Yui. Avise o dono para instalar.',
    YTDLP_ERROR: 'Não consegui baixar esse conteúdo agora. Tente novamente em instantes ou use outro link.',
    YTDLP_VIDEO_ERROR: 'Não consegui baixar esse vídeo agora. O baixador pode estar desatualizado; se o problema continuar, avise o dono para atualizá-lo.',
    DOWNLOAD_TIMEOUT: 'O download demorou demais e foi cancelado. Tente um conteúdo mais curto.',
    FILE_TOO_LARGE: 'Esse conteúdo é grande demais para baixar.',
    MEDIA_TOO_LONG: 'Esse conteúdo é longo demais para baixar (ou é uma transmissão ao vivo).',
    OUTPUT_NOT_FOUND: 'O arquivo não apareceu depois do download. Tente de novo ou use outro link.',
    YOUTUBE_FULL_VIDEO: 'Para vídeos do YouTube, só Shorts são suportados no download de vídeo. Use /baixar_musica para extrair o áudio.',
    UPLOAD_TOO_LARGE: 'O arquivo ficou maior que o limite de envio do Discord. Tente uma faixa mais curta.',
    SPOTIFY_INVALID_URL: 'Isso não parece ser um link do Spotify.',
    SPOTIFY_ONLY_TRACK: 'Só consigo baixar links de faixa do Spotify (open.spotify.com/track/...). Álbuns, playlists, artistas e podcasts não são suportados.',
    SPOTIFY_PRIVATE: 'Essa faixa do Spotify não pôde ser baixada (pode ser exclusiva ou restrita).',
    SPOTIFY_UNAVAILABLE: 'Não consegui baixar essa faixa do Spotify. O recurso não está disponível na máquina da Yui; avise o dono.',
    SPOTIFY_ERROR: 'Não consegui baixar essa faixa do Spotify agora. Tente novamente em instantes.',
    SPOTIFY_NO_FILE: 'O áudio não apareceu depois do download do Spotify. Tente novamente.',
});

const GENERIC_USER_MESSAGE = 'Não consegui concluir o download agora. Tente novamente em instantes.';
// Aviso do plano B: NEUTRO de propósito. A origem da faixa (serviço ou ferramenta) vai só para os logs.
export const DEEZER_FALLBACK_NOTICE = '⚠️ Aviso: a qualidade desta faixa pode ser menor que a original.';

/**
 * Nomes de serviços e ferramentas que NÃO aparecem no que o usuário recebe na ENTREGA de música (decisão do dono):
 * o arquivo chega sem dizer de onde veio. Os nomes das plataformas aceitas como LINK (YouTube, Spotify, Instagram,
 * TikTok) continuam permitidos na ajuda e nas mensagens de erro do link que o próprio usuário mandou.
 */
export const ORIGIN_NAMES_RE = /deezer|youtube|youtu\.be|spotify|spot-?dlp|yt-?dlp|spotdl|deemix/i;

/** O texto cita algum serviço ou ferramenta de origem do áudio? (usado também pelos testes que varrem os textos entregues) */
export function mentionsOrigin(text) {
    return ORIGIN_NAMES_RE.test(String(text ?? ''));
}

/** Texto dentro de um trecho de código do Discord: sem crases e sem quebras de linha. */
export function codeSafe(text) {
    return String(text ?? '').replace(/[`\r\n]+/g, ' ').trim();
}

/**
 * Texto de sucesso para uma faixa entregue por `executeDownloadAndPackage` (deezerMusicHandler).
 * NÃO diz de onde o arquivo veio. Quando o plano B entrou (`result.fallback`), mostra um aviso neutro de
 * qualidade (`result.notice` só vale se não citar a origem). Devolve { viaFallback, text }.
 * Título e artista são cortados (200 e 100) e as crases saem. Os chamadores devem enviar com
 * `allowedMentions: { parse: [] }` (o título vem de sites externos).
 */
export function formatDeezerDelivery(result) {
    const track = (result && (result.originalTrack || result.track)) || {};
    const title = clampText(codeSafe(track.title), 200);
    const artist = clampText(codeSafe(track.artist), 100);
    const label = artist ? `${title} - ${artist}` : title;
    if (result && result.fallback) {
        const custom = typeof result.notice === 'string' ? result.notice.trim().slice(0, 500) : '';
        const notice = custom && !mentionsOrigin(custom) ? custom : DEEZER_FALLBACK_NOTICE;
        return { viaFallback: true, text: `${notice}\n🎵 \`${label}\`` };
    }
    return { viaFallback: false, text: `✅ Música baixada: \`${label}\`` };
}

/** O envio falhou porque o arquivo passou do limite do Discord (erro 40005, HTTP 413 ou texto "entity too large")? */
export function isUploadTooLargeError(error) {
    if (!error) return false;
    if (error.code === 40005 || Number(error.status) === 413 || Number(error.statusCode) === 413) return true;
    return /request entity too large|payload too large/i.test(String(error.message ?? ''));
}

/**
 * Erro de download com código estável e frase amigável.
 * `message` mantém o formato histórico "CODIGO: frase"; use `userMessage` para mostrar ao usuário.
 */
export class MediaError extends Error {
    constructor(code, userMessage, options = {}) {
        super(`${code}: ${userMessage}`);
        this.name = 'MediaError';
        this.code = code;
        this.userMessage = userMessage;
        if (options.cause) this.cause = options.cause;
        // Detalhe técnico: vai só para o logger, nunca para o usuário.
        if (options.detail) this.detail = String(options.detail).slice(0, 300);
    }
}

/** Frase segura para mostrar ao usuário (nunca o `error.message` cru). */
export function getMediaUserMessage(error, fallback = GENERIC_USER_MESSAGE) {
    if (error && typeof error.userMessage === 'string' && error.userMessage) return error.userMessage;
    return fallback;
}

// ---------------------------------------------------------------------------
// Parse seguro de URL
// ---------------------------------------------------------------------------

const MAX_URL_LENGTH = 2048;
// Espaço/quebra de linha/controle, aspas, crase, < > | ^ e barra invertida.
const UNSAFE_URL_CHARS = /[\s\u0000-\u001f\u007f-\u009f"'`<>|^\\]/;
// Acrescentado para TikTok/Instagram (onde a URL final não vem de um ID simples).
const STRICT_EXTRA_CHARS = /[%!]/;

/**
 * Converte o texto do usuário numa URL http(s) ou devolve null.
 * Aceita link sem esquema ("youtu.be/ID") e o formato "<link>" do Discord.
 */
export function parseHttpUrl(raw) {
    if (typeof raw !== 'string') return null;
    let text = raw.trim();
    if (text.startsWith('<') && text.endsWith('>')) text = text.slice(1, -1).trim();
    if (!text || text.length > MAX_URL_LENGTH) return null;
    if (UNSAFE_URL_CHARS.test(text)) return null;
    if (text.includes('://')) {
        if (!/^https?:\/\//i.test(text)) return null;
    } else {
        text = `https://${text}`;
    }
    let url;
    try {
        url = new URL(text);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    if (url.username || url.password) return null;
    if (url.port) return null; // a porta padrão é normalizada para vazio
    return url;
}

// ---------------------------------------------------------------------------
// YouTube
// ---------------------------------------------------------------------------

const YT_VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YT_LIST_ID = /^[A-Za-z0-9_-]{10,}$/;
const YT_HOSTS = new Set([
    'youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com',
    'youtu.be', 'www.youtu.be',
]);

function youtubeResult({ platform, url, videoId, listId }) {
    return {
        platform,
        url,
        id: videoId || null,
        videoId: videoId || null,
        listId: listId || null,
        playlistIgnored: Boolean(videoId && listId),
        playlistOnly: !videoId,
    };
}

/**
 * Normaliza um link do YouTube / YouTube Music.
 * Devolve { platform, url (canônica), videoId, listId, playlistIgnored, playlistOnly } ou null.
 *  - link com ID de vídeo (mesmo com list=): baixa só o vídeo (playlistIgnored = true se havia list=);
 *  - playlist pura: playlistOnly = true (o chamador baixa só o 1º item, com `-I 1`).
 */
export function normalizeYoutubeUrl(raw) {
    const url = parseHttpUrl(raw);
    if (!url) return null;
    const host = url.hostname;
    if (!YT_HOSTS.has(host)) return null;

    const isShortHost = host === 'youtu.be' || host === 'www.youtu.be';
    const isMusic = host === 'music.youtube.com';
    const segs = url.pathname.split('/').filter(Boolean);

    const rawList = url.searchParams.get('list');
    const listId = rawList && YT_LIST_ID.test(rawList) ? rawList : null;
    const platformFor = (shorts) => (shorts ? 'youtube_shorts' : (isMusic ? 'youtube_music' : 'youtube'));

    const playlistOnly = () => {
        if (!listId) return null;
        return youtubeResult({
            platform: platformFor(false),
            url: `https://www.youtube.com/playlist?list=${listId}`,
            videoId: null,
            listId,
        });
    };
    const video = (id, shorts = false) => {
        if (!id || !YT_VIDEO_ID.test(id)) return null;
        return youtubeResult({
            platform: platformFor(shorts),
            url: shorts ? `https://www.youtube.com/shorts/${id}` : `https://www.youtube.com/watch?v=${id}`,
            videoId: id,
            listId,
        });
    };

    if (isShortHost) {
        // youtu.be/ID
        if (segs.length !== 1) return null;
        return video(segs[0]);
    }

    if (segs.length === 1 && segs[0] === 'watch') {
        const v = url.searchParams.get('v'); // "v=" em qualquer posição da query
        if (v !== null) return video(v);
        return playlistOnly(); // watch?list=PL... sem v= é uma playlist para o yt-dlp
    }
    if (segs.length === 1 && segs[0] === 'playlist') {
        return playlistOnly();
    }
    if (segs.length === 2 && ['shorts', 'live', 'embed', 'v'].includes(segs[0])) {
        if (segs[0] === 'embed' && segs[1] === 'videoseries') return playlistOnly(); // embed de playlist
        return video(segs[1], segs[0] === 'shorts');
    }
    return null;
}

// ---------------------------------------------------------------------------
// Instagram e TikTok
// ---------------------------------------------------------------------------

const INSTAGRAM_HOSTS = new Set(['instagram.com', 'www.instagram.com']);
const TIKTOK_HOSTS = new Set([
    'tiktok.com', 'www.tiktok.com', 'm.tiktok.com', 'vm.tiktok.com', 'vt.tiktok.com',
]);
const TIKTOK_SHORT_HOSTS = new Set(['vm.tiktok.com', 'vt.tiktok.com']);
const SAFE_PATH = /^[A-Za-z0-9._~@/-]+$/;

/** Reels do Instagram. Devolve a URL canônica https://www.instagram.com/reel/<codigo>/ ou null. */
export function normalizeInstagramUrl(raw) {
    const url = parseHttpUrl(raw);
    if (!url || !INSTAGRAM_HOSTS.has(url.hostname)) return null;
    if (typeof raw === 'string' && STRICT_EXTRA_CHARS.test(raw)) return null;
    const match = url.pathname.match(/^\/(?:reel|reels)\/([A-Za-z0-9_-]{5,40})\/?$/);
    if (!match) return null;
    return {
        platform: 'instagram',
        url: `https://www.instagram.com/reel/${match[1]}/`,
        id: match[1],
        videoId: null,
        listId: null,
        playlistIgnored: false,
        playlistOnly: false,
    };
}

/**
 * Links do TikTok. A URL final é host + caminho (sem query nem hash), com o caminho limitado a
 * letras, números e . _ ~ @ / -. Perfil/coleção/tag viram `playlistOnly` (o chamador usa `-I 1`).
 */
export function normalizeTiktokUrl(raw) {
    const url = parseHttpUrl(raw);
    if (!url || !TIKTOK_HOSTS.has(url.hostname)) return null;
    if (typeof raw === 'string' && STRICT_EXTRA_CHARS.test(raw)) return null;
    const pathname = url.pathname;
    if (!pathname || pathname === '/' || pathname.length > 300 || !SAFE_PATH.test(pathname)) return null;

    const videoMatch = pathname.match(/^\/@[A-Za-z0-9._-]+\/(?:video|photo)\/(\d{5,25})\/?$/);
    const single = Boolean(videoMatch)
        || TIKTOK_SHORT_HOSTS.has(url.hostname)
        || /^\/t\/[A-Za-z0-9]+\/?$/.test(pathname);
    return {
        platform: 'tiktok',
        url: `https://${url.hostname}${pathname}`,
        id: videoMatch ? videoMatch[1] : null,
        videoId: null,
        listId: null,
        playlistIgnored: false,
        playlistOnly: !single,
    };
}

/** Normaliza um link de YouTube, Instagram ou TikTok. Devolve null se não for suportado. */
export function normalizeMediaUrl(raw) {
    return normalizeYoutubeUrl(raw) || normalizeInstagramUrl(raw) || normalizeTiktokUrl(raw) || null;
}

// ---------------------------------------------------------------------------
// Spotify
// ---------------------------------------------------------------------------

const SPOTIFY_HOSTS = new Set(['open.spotify.com', 'play.spotify.com', 'spotify.com', 'www.spotify.com']);
const SPOTIFY_KINDS = new Set(['track', 'album', 'playlist', 'artist', 'episode', 'show']);

/** O link é do Spotify (host permitido)? Não valida o restante do caminho. */
export function looksLikeSpotifyUrl(raw) {
    const url = parseHttpUrl(raw);
    return Boolean(url && SPOTIFY_HOSTS.has(url.hostname));
}

/** Devolve { platform:'spotify', kind, id, url canônica } ou null. */
export function normalizeSpotifyUrl(raw) {
    const url = parseHttpUrl(raw);
    if (!url || !SPOTIFY_HOSTS.has(url.hostname)) return null;
    const segs = url.pathname.split('/').filter(Boolean);
    if (segs[0] && /^intl-[a-z]{2}(?:-[a-z]{2,4})?$/i.test(segs[0])) segs.shift();
    if (segs.length !== 2) return null;
    const kind = segs[0].toLowerCase();
    const id = segs[1];
    if (!SPOTIFY_KINDS.has(kind) || !/^[A-Za-z0-9]{22}$/.test(id)) return null;
    return { platform: 'spotify', kind, id, url: `https://open.spotify.com/${kind}/${id}` };
}

// ---------------------------------------------------------------------------
// Limites e argumentos do yt-dlp
// ---------------------------------------------------------------------------

function readNonNegativeInt(value, fallback, max) {
    if (value === undefined || value === null || String(value).trim() === '') return fallback;
    const n = Number.parseInt(String(value).trim(), 10);
    if (!Number.isFinite(n) || n < 0) return fallback;
    return Math.min(n, max);
}

/**
 * Limites dos downloads, configuráveis por ambiente (0 desliga o limite de duração/tamanho):
 *  YUI_DL_MAX_MINUTES (20), YUI_DL_MAX_FILESIZE_MB (200), YUI_DL_TIMEOUT_SECONDS (300).
 */
export function readDownloadLimits(env = process.env) {
    const timeoutSeconds = readNonNegativeInt(env.YUI_DL_TIMEOUT_SECONDS, 300, 3600);
    return {
        maxMinutes: readNonNegativeInt(env.YUI_DL_MAX_MINUTES, 20, 24 * 60),
        maxFilesizeMB: readNonNegativeInt(env.YUI_DL_MAX_FILESIZE_MB, 200, 10240),
        timeoutMs: Math.max(30, timeoutSeconds) * 1000,
    };
}

/**
 * Teto de downloads ao mesmo tempo (todos os usuários, áudio e vídeo): YUI_DL_MAX_CONCURRENT, padrão 3.
 * 0 desliga o teto; valor inválido volta ao padrão; máximo 50.
 */
export function readMaxConcurrentDownloads(env = process.env) {
    return readNonNegativeInt(env?.YUI_DL_MAX_CONCURRENT, 3, 50);
}

/**
 * Caminho ABSOLUTO de um arquivo/pasta que existe, ou null.
 * O yt-dlp/spotdl rodam com `cwd` na subpasta temporária do pedido; um caminho relativo vindo do
 * .env (cookies, ffmpeg) seria resolvido a partir dela e não existiria (o yt-dlp baixa, mas sai
 * com código 1 ao tentar regravar os cookies). Por isso o caminho é resolvido ANTES, a partir do
 * diretório de trabalho do processo da Yui.
 */
export function resolveExistingPath(p) {
    if (typeof p !== 'string' || !p) return null;
    const absolute = path.resolve(p);
    return fs.existsSync(absolute) ? absolute : null;
}

/**
 * Caminho de um binário para o `execFile`/`--ffmpeg-location`: caminho relativo COM diretório vira
 * absoluto; nome puro ("yt-dlp.exe", procurado no PATH) e caminho absoluto ficam como estão.
 */
export function resolveBinaryPath(p) {
    if (typeof p !== 'string' || !p || path.isAbsolute(p)) return p;
    return path.basename(p) === p ? p : path.resolve(p);
}

function assertCanonicalUrl(url) {
    if (typeof url !== 'string' || !/^https:\/\/[A-Za-z0-9.-]+\/[^\s]*$/.test(url) || UNSAFE_URL_CHARS.test(url)) {
        throw new Error('URL inválida para o yt-dlp (use a URL canônica de normalizeMediaUrl).');
    }
}

function assertSafeArg(value, label) {
    if (typeof value !== 'string' || !value || /["\u0000\r\n]/.test(value)) {
        throw new Error(`Argumento inválido para o yt-dlp (${label}).`);
    }
}

function pushCommonFlags(flags, opts) {
    const maxMinutes = Number(opts.maxMinutes) || 0;
    const maxFilesizeMB = Number(opts.maxFilesizeMB) || 0;
    if (maxFilesizeMB > 0) flags.push('--max-filesize', `${Math.floor(maxFilesizeMB)}M`);
    if (maxMinutes > 0) {
        // Sem espaços (cada elemento é um argumento único). "<=?" deixa passar duração desconhecida.
        flags.push('--match-filters', `!is_live&duration<=?${Math.floor(maxMinutes * 60)}`);
    }
    if (opts.cookiesPath) {
        assertSafeArg(opts.cookiesPath, 'cookies');
        // Sempre absoluto: o yt-dlp roda com cwd na subpasta do pedido (veja resolveExistingPath).
        flags.push('--cookies', path.resolve(opts.cookiesPath));
    }
    for (const extra of opts.extraFlags || []) {
        assertSafeArg(String(extra), 'extra');
        flags.push(String(extra));
    }
    if (opts.ffmpegPath) {
        assertSafeArg(opts.ffmpegPath, 'ffmpeg');
        flags.push('--ffmpeg-location', resolveBinaryPath(opts.ffmpegPath));
    }
}

/**
 * Argumentos do yt-dlp para extrair MP3. Devolve um ARRAY (use com execFile, sem shell).
 * `opts`: { playlistOnly, audioQuality, maxMinutes, maxFilesizeMB, cookiesPath, extraFlags, ffmpegPath }.
 * Playlist pura => `--no-playlist -I 1` (NUNCA `--max-downloads`: o yt-dlp sairia com código 101).
 */
export function buildYtdlpAudioFlags(outputTemplate, url, opts = {}) {
    assertCanonicalUrl(url);
    assertSafeArg(outputTemplate, 'saída');
    const flags = ['--no-playlist'];
    if (opts.playlistOnly) flags.push('-I', '1');
    flags.push('-x', '--audio-format', 'mp3');
    if (opts.audioQuality !== undefined && opts.audioQuality !== null) {
        const quality = String(opts.audioQuality);
        if (!/^\d{1,3}K?$/i.test(quality)) throw new Error('Qualidade de áudio inválida.');
        flags.push('--audio-quality', quality);
    }
    pushCommonFlags(flags, opts);
    flags.push('-o', outputTemplate, '--print-json', url);
    return flags;
}

/** Argumentos do yt-dlp para baixar vídeo (mp4). Mesmas regras de `buildYtdlpAudioFlags`. */
export function buildYtdlpVideoFlags(outputTemplate, url, opts = {}) {
    assertCanonicalUrl(url);
    assertSafeArg(outputTemplate, 'saída');
    const flags = ['--no-playlist'];
    if (opts.playlistOnly) flags.push('-I', '1');
    flags.push('-f', 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best');
    pushCommonFlags(flags, opts);
    flags.push('-o', outputTemplate, '--print-json', url);
    return flags;
}

// ---------------------------------------------------------------------------
// Nomes de arquivo e pastas temporárias por pedido
// ---------------------------------------------------------------------------

/** Nome de arquivo seguro para disco (sem caracteres de controle, reservados do Windows etc.). */
export function safeFileStem(name, fallback = 'audio', maxLength = 100) {
    let stem = String(name ?? '')
        .replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ')
        .replace(/[<>:"/\\|?*`!,]/g, '');
    stem = stem.replace(/\s+/g, ' ').trim();
    if (stem.length > maxLength) {
        const lastSpace = stem.lastIndexOf(' ', maxLength);
        stem = stem.substring(0, lastSpace > 0 ? lastSpace : maxLength);
    }
    stem = stem.replace(/^\.+/, '').replace(/[. ]+$/, '');
    if (!stem) return fallback;
    if (/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])$/i.test(stem)) stem = `_${stem}`;
    return stem;
}

const UUID_DIR = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Cria (e devolve, em caminho absoluto) uma subpasta única (UUID) dentro de `root` para um pedido de download. */
export function createRequestDir(root) {
    // Absoluta: os binários rodam com cwd nesta pasta, então um caminho relativo se duplicaria.
    const dir = path.resolve(root, crypto.randomUUID());
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}

// Segunda chance em SEGUNDO PLANO para uma pasta que o rmSync não conseguiu apagar (a faxina de 24 h é a última rede).
function retryRemoveInBackground(target) {
    try {
        const pending = fs.promises.rm(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        if (pending && typeof pending.catch === 'function') pending.catch(() => {});
    } catch { /* melhor esforço */ }
}

/**
 * Remove uma subpasta de pedido (só aceita subpastas UUID diretamente sob `root`).
 * Devolve true só se a pasta foi apagada agora. No Windows um arquivo ainda aberto (ffmpeg que acabou de ser morto,
 * antivírus) dá EPERM/EBUSY por instantes. O rmSync síncrono NÃO repete (medido no Node 24: falha em 1 ms mesmo com
 * maxRetries) e esperar aqui travaria o laço de eventos; por isso, se a primeira tentativa falhar, as tentativas
 * (fs.promises.rm com maxRetries) rodam em segundo plano e o retorno é false.
 */
export function removeRequestDir(root, dir) {
    try {
        const relative = path.relative(path.resolve(root), path.resolve(dir));
        if (!UUID_DIR.test(relative)) return false;
        const target = path.resolve(root, relative);
        try {
            fs.rmSync(target, { recursive: true, force: true });
            return true;
        } catch {
            retryRemoveInBackground(target);
            return false;
        }
    } catch {
        return false;
    }
}

/**
 * Faxina das subpastas de pedido que sobraram: vazias há mais de `emptyAfterMs` ou inteiras
 * paradas há mais de `staleAfterMs`. Só toca em subpastas com nome UUID. Devolve quantas removeu.
 */
export function sweepStaleRequestDirs(root, { now = Date.now(), emptyAfterMs = 5 * 60 * 1000, staleAfterMs = 24 * 60 * 60 * 1000 } = {}) {
    let removed = 0;
    let entries;
    try {
        entries = fs.readdirSync(root, { withFileTypes: true });
    } catch {
        return 0;
    }
    for (const entry of entries) {
        if (!entry.isDirectory() || !UUID_DIR.test(entry.name)) continue;
        const dir = path.join(root, entry.name);
        try {
            const dirStat = fs.statSync(dir);
            const files = fs.readdirSync(dir);
            if (files.length === 0) {
                if (now - dirStat.mtimeMs > emptyAfterMs) {
                    fs.rmdirSync(dir);
                    removed++;
                }
                continue;
            }
            let newest = dirStat.mtimeMs;
            for (const file of files) {
                try { newest = Math.max(newest, fs.statSync(path.join(dir, file)).mtimeMs); } catch { /* sumiu no meio */ }
            }
            if (now - newest > staleAfterMs) {
                fs.rmSync(dir, { recursive: true, force: true });
                removed++;
            }
        } catch { /* melhor esforço */ }
    }
    return removed;
}

// ---------------------------------------------------------------------------
// Execução de binários (sem shell)
// ---------------------------------------------------------------------------

/**
 * Encerra um processo e os filhos (o yt-dlp.exe "onefile" lança um processo filho no Windows).
 * REGRA DE SEGURANÇA: só age sobre um filho que AINDA ESTÁ VIVO. No Windows os PIDs são reaproveitados, e o
 * `taskkill /pid <pid> /T /F` contra o PID de um filho que já saiu pode derrubar um programa que não é da Yui.
 * Vivo = sem `exitCode` numérico e sem `signalCode` (um dublê sem esses campos conta como vivo).
 * `deps` ({ execFileImpl, platform }) existe só para teste.
 */
export function killProcessTree(child, { execFileImpl = execFile, platform = process.platform } = {}) {
    if (!child) return;
    if (typeof child.exitCode === 'number' || typeof child.signalCode === 'string') return; // já saiu: o PID pode ser de outro
    try {
        if (platform === 'win32' && child.pid) {
            execFileImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 10000 }, () => {});
        } else if (typeof child.kill === 'function') {
            child.kill('SIGKILL');
        }
    } catch { /* melhor esforço */ }
}

/**
 * Roda um binário com execFile (array de argumentos, sem shell) e NUNCA rejeita:
 * resolve { error, stdout, stderr, timedOut }.
 * `deps`: { execFileImpl, killImpl } para testes.
 */
export function runTool(file, args, { timeoutMs = 300000, maxBuffer = 10 * 1024 * 1024, cwd, execFileImpl = execFile, killImpl = killProcessTree } = {}) {
    return new Promise((resolve) => {
        let finished = false;
        let timedOut = false;
        let timer = null;
        const done = (error, stdout, stderr) => {
            if (finished) return;
            finished = true;
            if (timer) clearTimeout(timer);
            resolve({
                error: error || null,
                stdout: String(stdout ?? ''),
                stderr: String(stderr ?? ''),
                timedOut: timedOut || Boolean(error && error.killed),
            });
        };
        let child = null;
        try {
            child = execFileImpl(file, args, { timeout: timeoutMs, maxBuffer, cwd, windowsHide: true }, done);
        } catch (err) {
            done(err, '', '');
            return;
        }
        if (!finished && timeoutMs > 0) {
            // Rede de segurança: derruba a árvore de processos ANTES do timeout do Node. O `taskkill /T /F` leva
            // ~250 ms (medido: 226 a 539 ms); se o timeout do Node matasse a raiz primeiro, o taskkill responderia
            // "processo não encontrado" e os netos (ffmpeg, deno) ficariam órfãos. Por isso a vantagem é de 1/3 do
            // prazo, no máximo 5 s. O `timeout` do execFile continua valendo como segunda rede.
            const headStartMs = Math.min(5000, Math.floor(timeoutMs / 3));
            timer = setTimeout(() => {
                timedOut = true;
                killImpl(child);
                // Se a raiz JÁ saiu, o killImpl padrão não age (o PID pode ser de outro processo) e quem segura o pipe é um
                // neto: o callback do execFile só viria quando ele o soltasse. Não prende o pedido (nem a vaga do porteiro).
                if (child && (typeof child.exitCode === 'number' || typeof child.signalCode === 'string')) {
                    done(Object.assign(new Error('Tempo esgotado esperando a saída do processo.'), { code: 'ETIMEDOUT' }), '', '');
                }
            }, Math.max(50, timeoutMs - headStartMs));
        }
    });
}

/** O binário não existe / não foi encontrado? */
export function isMissingBinary(run) {
    const code = run.error && run.error.code;
    return code === 'ENOENT'
        || /not recognized|não é reconhecido|command not found/i.test(run.stderr || '');
}
