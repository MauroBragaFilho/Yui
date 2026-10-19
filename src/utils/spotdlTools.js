// Ferramentas do spotdl (downloads de faixas do Spotify): resolução do executável, argumentos,
// ambiente mínimo, classificação de falhas, porteiro global, disjuntor e encerramento dos filhos vivos.
//
// Regras deste módulo:
//  - Importar não tem efeito colateral: nenhuma pasta, processo, timer ou ouvinte é criado aqui.
//    (O gancho de saída só é instalado por installSpotdlExitHook, chamado pelo handler.)
//  - Não usa o logger: quem registra é o handler. Assim os testes não precisam de pasta de logs.
//  - Não importa binaries.js (o stub de tests/test-deezer.js troca esse módulo e quebraria o link ESM).
//  - A URL que chega ao spotdl é SEMPRE a canônica de normalizeSpotifyUrl (kind 'track') e o argv é montado
//    por LISTA FIXA: a única posição variável é a URL (posição 1) e os valores das flags permitidas.
//  - O spotdl roda com o HOME isolado dentro da pasta do pedido. Isso não é só higiene: é o que mantém o
//    R1 (uma faixa por pedido), porque o config.json do spotdl (fetch_albums, scan_for_songs, archive...)
//    nasce padrão a cada pedido e nunca vem do config real do usuário.
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaError, MEDIA_MESSAGES } from './mediaUrls.js';

const IS_WIN = process.platform === 'win32';
const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../');

// ---------------------------------------------------------------------------
// Mensagens amigáveis (o detalhe técnico vai só para o logger do handler)
// ---------------------------------------------------------------------------

// Mensagens que o USUÁRIO recebe: não citam de onde vem o áudio (nem serviços nem ferramentas). Só o link do Spotify,
// que foi ele quem mandou, pode ser nomeado.
const BUSCA_HINT = 'Enquanto isso, dá para usar `/baixar_musica busca:` com o nome da música.';

export const SPOTDL_MESSAGES = Object.freeze({
    NOT_FOUND: `Não achei um áudio para essa faixa agora. Tente de novo mais tarde. ${BUSCA_HINT}`,
    BLOCKED: `Não consegui baixar essa faixa agora (pode ser bloqueio temporário ou instabilidade). Tente de novo em alguns minutos. ${BUSCA_HINT}`,
    BUSY: `Já há downloads do Spotify em andamento. Tente de novo em instantes. ${BUSCA_HINT}`,
});

// ---------------------------------------------------------------------------
// Configuração por ambiente
// ---------------------------------------------------------------------------

export const DEFAULT_SPOTDL_BITRATE = '192k';
const DEFAULT_MAX_PARALLEL = 2;
const MAX_PARALLEL_LIMIT = 4;
const LOG_LEVELS = new Set(['WARNING', 'INFO', 'DEBUG']);

/** YUI_SPOTDL_BITRATE: "64k" a "320k". Qualquer outro valor volta ao padrão (192k). */
export function readSpotdlBitrate(env = process.env) {
    const match = /^(\d{2,3})k$/.exec(String(env?.YUI_SPOTDL_BITRATE ?? '').trim().toLowerCase());
    if (!match) return DEFAULT_SPOTDL_BITRATE;
    const kbps = Number(match[1]);
    return kbps >= 64 && kbps <= 320 ? `${kbps}k` : DEFAULT_SPOTDL_BITRATE;
}

/** YUI_SPOTDL_LOG_LEVEL: WARNING (padrão), INFO ou DEBUG. Qualquer outro valor vira WARNING. */
export function readSpotdlLogLevel(env = process.env) {
    const raw = String(env?.YUI_SPOTDL_LOG_LEVEL ?? '').trim().toUpperCase();
    return LOG_LEVELS.has(raw) ? raw : 'WARNING';
}

/** YUI_SPOTDL_MAX_PARALLEL: quantos spotdl podem rodar ao mesmo tempo (1 a 4; padrão 2). */
export function readSpotdlMaxParallel(env = process.env) {
    const raw = String(env?.YUI_SPOTDL_MAX_PARALLEL ?? '').trim();
    if (!/^\d{1,3}$/.test(raw)) return DEFAULT_MAX_PARALLEL;
    const n = Number(raw);
    return n >= 1 ? Math.min(n, MAX_PARALLEL_LIMIT) : DEFAULT_MAX_PARALLEL;
}

// ---------------------------------------------------------------------------
// Onde está o spotdl
// ---------------------------------------------------------------------------

// "Existe" aqui é "existe E é um ARQUIVO": um diretório em SPOTDL_PATH não é um spotdl (o execFile dá ENOENT e o
// pedido cairia, em silêncio, no yt-dlp).
function isRegularFile(candidate) {
    try {
        return fs.statSync(candidate).isFile();
    } catch {
        return false;
    }
}

/**
 * Ordem: SPOTDL_PATH (se for um arquivo que existe) > ambiente isolado .venv-spotdl da raiz do projeto > "spotdl" no PATH.
 * Um SPOTDL_PATH relativo (nome puro ou com pasta) vale a partir da pasta do processo da Yui e sai daqui ABSOLUTO: o
 * spotdl roda com cwd na pasta do pedido, onde um nome puro seria procurado só no PATH (ENOENT).
 * Pura e injetável (env, exists, rootDir, isWin) para teste; `exists` deve responder "é um arquivo". Não roda nada.
 * @returns {{ path: string, source: 'SPOTDL_PATH'|'venv'|'PATH', warning?: string }}
 */
export function resolveSpotdl({ env = process.env, exists = isRegularFile, rootDir = ROOT_DIR, isWin = IS_WIN } = {}) {
    const raw = String(env?.SPOTDL_PATH || '').trim().replace(/^"(.*)"$/, '$1');
    const configured = raw && !(isWin ? path.win32.isAbsolute(raw) : path.isAbsolute(raw)) ? path.resolve(raw) : raw;
    let warning;
    if (configured) {
        if (exists(configured)) return { path: configured, source: 'SPOTDL_PATH' };
        warning = 'SPOTDL_PATH não aponta para um arquivo que existe; usando o ambiente .venv-spotdl ou o PATH.';
    }
    const exe = isWin
        ? path.join(rootDir, '.venv-spotdl', 'Scripts', 'spotdl.exe')
        : path.join(rootDir, '.venv-spotdl', 'bin', 'spotdl');
    if (exists(exe)) return { path: exe, source: 'venv', ...(warning ? { warning } : {}) };
    return { path: 'spotdl', source: 'PATH', ...(warning ? { warning } : {}) };
}

export function getSpotdlPath(options) {
    return resolveSpotdl(options).path;
}

/** Procura um executável nos diretórios do PATH só olhando arquivos (não roda nada). */
function findOnPath(name, { env = process.env, exists = isRegularFile, isWin = IS_WIN } = {}) {
    const key = Object.keys(env || {}).find((k) => k.toUpperCase() === 'PATH');
    const dirs = String((key && env[key]) || '')
        .split(isWin ? ';' : ':')
        .map((dir) => dir.trim().replace(/^"(.*)"$/, '$1'))
        .filter(Boolean);
    const suffixes = isWin ? ['.exe'] : [''];
    for (const dir of dirs) {
        for (const suffix of suffixes) {
            const candidate = path.join(dir, `${name}${suffix}`);
            if (exists(candidate)) return candidate;
        }
    }
    return null;
}

/**
 * Diagnóstico para o boot (validateMediaTools / OPTIONAL_PYTHON_TOOLS): o spotdl está instalado?
 * Só confere ARQUIVOS: não roda o spotdl (custaria ~3 s) e não usa a rede. Nunca lança.
 * Devolve { ok, code, message, path, source, warning } (os três primeiros no formato de checkOptionalPythonTools).
 */
export function checkSpotdl(options = {}) {
    try {
        const resolved = resolveSpotdl(options);
        const found = resolved.source === 'PATH' ? findOnPath('spotdl', options) : resolved.path;
        const warning = resolved.warning || null;
        if (!found) {
            return {
                ok: false,
                code: 'SPOTDL_NOT_FOUND',
                message: 'spotdl não encontrado (.venv-spotdl, SPOTDL_PATH ou PATH)',
                path: null,
                source: resolved.source,
                warning,
            };
        }
        return {
            ok: true,
            code: null,
            message: `${found} (origem: ${resolved.source})`,
            path: found,
            source: resolved.source,
            warning,
        };
    } catch (err) {
        return {
            ok: false,
            code: 'CHECK_ERROR',
            message: String(err?.message ?? err).split(/\r?\n/)[0].slice(0, 200),
            path: null,
            source: null,
            warning: null,
        };
    }
}

// ---------------------------------------------------------------------------
// Argumentos (lista fixa)
// ---------------------------------------------------------------------------

const CANONICAL_TRACK = /^https:\/\/open\.spotify\.com\/track\/[A-Za-z0-9]{22}$/;

/**
 * Todas as flags que a Yui passa ao spotdl. O teste confere nos dois sentidos: nenhum token do argv que
 * comece com "-" fica fora desta lista, e a lista inteira aparece no argv completo.
 * NUNCA: --config, --fetch-albums, --scan-for-songs, --archive, --m3u, --save-file, --cookie-file, --user-auth,
 * --client-secret, --generate-config, --download-ffmpeg, --audio, --yt-dlp-args e operações que não sejam "download".
 */
export const ALLOWED_SPOTDL_FLAGS = Object.freeze([
    '--format', '--output', '--bitrate', '--max-filename-length', '--threads', '--ffmpeg', '--lyrics', '--simple-tui', '--log-level',
]);

function assertSafeArg(value, label) {
    if (typeof value !== 'string' || !value || /["\u0000\r\n]/.test(value)) {
        throw new Error(`Argumento inválido para o spotdl (${label}).`);
    }
}

/**
 * O spotdl "sanitiza" cada componente do caminho de --output com re.search(r"[^\.*](.*)[^\.*$]", parte)
 * (spotdl/utils/formatter.py, create_path_object): uma pasta que começa com "." ou termina com ".", "*" ou "$"
 * (de 3 caracteres ou mais) perde esse caractere, e o mp3 vai para OUTRA pasta (ex.: ".../.yui/..." vira ".../yui/...").
 * Devolve o primeiro componente de `dir` que o spotdl alteraria, ou null. Compartilhamentos UNC (\\servidor\pasta$) são
 * "âncora" no Python e não passam por esse filtro, então os dois primeiros componentes de um UNC não contam.
 */
export function findSpotdlUnsafePathPart(dir) {
    const text = String(dir ?? '');
    const parts = text.split(/[\\/]+/).filter(Boolean);
    const skip = /^[\\/]{2}[^\\/]/.test(text) ? 2 : 0;
    for (const part of parts.slice(skip)) {
        if (part === '.spotdl') continue; // exceção do próprio spotdl
        const match = /[^.*](.*)[^.*$]/.exec(part);
        if (match && match[0] !== part) return part;
    }
    return null;
}

/**
 * argv do spotdl para UMA faixa. `trackUrl` tem de ser a URL canônica de normalizeSpotifyUrl (kind 'track').
 * O argparse do spotdl exige "download <url>" primeiro; "--lyrics" (sem valor = nenhum provedor de letras)
 * precisa vir antes de OUTRA opção, nunca antes da URL; "--" não é usado (com "download" o parser recusa).
 * Abreviações como "--out" também seriam aceitas pelo argparse, por isso a URL é validada por regex e o
 * argv final é conferido contra ALLOWED_SPOTDL_FLAGS.
 */
export function buildSpotdlArgs(trackUrl, outputDir, { ffmpegPath, bitrate = DEFAULT_SPOTDL_BITRATE, logLevel = 'WARNING' } = {}) {
    if (typeof trackUrl !== 'string' || !CANONICAL_TRACK.test(trackUrl)) {
        throw new Error('URL inválida para o spotdl (use a URL canônica de normalizeSpotifyUrl).');
    }
    assertSafeArg(outputDir, 'saída');
    if (!path.isAbsolute(outputDir)) throw new Error('A pasta de saída do spotdl precisa ser absoluta.');
    if (findSpotdlUnsafePathPart(outputDir)) {
        // Falha cedo e com causa clara: sem isso o spotdl gravaria o mp3 fora da pasta do pedido (SPOTIFY_NO_FILE e arquivo órfão).
        throw new Error('Um componente do caminho da pasta temporária começa com "." ou termina com ".", "*" ou "$"; o spotdl o alteraria e o arquivo iria para outra pasta.');
    }
    if (typeof bitrate !== 'string' || !/^\d{2,3}k$/.test(bitrate)) throw new Error('Bitrate inválido para o spotdl.');
    if (!LOG_LEVELS.has(logLevel)) throw new Error('Nível de log inválido para o spotdl.');
    const args = [
        'download', trackUrl,
        '--format', 'mp3',
        '--output', outputDir, // sem variáveis: o spotdl acrescenta "/{artists} - {title}.{output-ext}"
        '--bitrate', bitrate,
        '--max-filename-length', '120',
        '--threads', '1',
    ];
    if (ffmpegPath) {
        assertSafeArg(ffmpegPath, 'ffmpeg');
        if (!path.isAbsolute(ffmpegPath)) throw new Error('O ffmpeg do spotdl precisa ser caminho absoluto.');
        args.push('--ffmpeg', ffmpegPath);
    }
    args.push('--lyrics', '--simple-tui', '--log-level', logLevel);
    // Defesa em profundidade: nada que pareça opção pode estar fora da lista fixa.
    for (const token of args.slice(2)) {
        if (token.startsWith('-') && !ALLOWED_SPOTDL_FLAGS.includes(token)) {
            throw new Error('Argumento do spotdl fora da lista permitida.');
        }
    }
    return args;
}

// ---------------------------------------------------------------------------
// Ambiente do processo filho
// ---------------------------------------------------------------------------

// Lista de PERMISSÃO (nomes em maiúsculas). Tudo o que não está aqui (tokens do bot, chaves de IA, DEEZER_ARL,
// OWNER_ID, PYTHONPATH/PYTHONHOME, NODE_OPTIONS...) NÃO chega ao spotdl. O PATH segue de propósito: é por ele
// que o spotdl acha o ffmpeg e o Deno.
const ENV_ALLOW = new Set([
    'PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'LOCALAPPDATA', 'APPDATA', 'PROGRAMDATA',
    'PROGRAMFILES', 'PROGRAMFILES(X86)', 'PROGRAMW6432', 'COMMONPROGRAMFILES', 'ALLUSERSPROFILE',
    'OS', 'PROCESSOR_ARCHITECTURE', 'NUMBER_OF_PROCESSORS', 'USERNAME', 'USERDOMAIN', 'COMPUTERNAME',
    'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'SSL_CERT_FILE', 'SSL_CERT_DIR',
    'REQUESTS_CA_BUNDLE', 'CURL_CA_BUNDLE', 'DENO_DIR', 'LANG', 'LC_ALL', 'TZ',
]);
const ENV_FORCED = new Set(['USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR']);

/**
 * Ambiente mínimo do spotdl: home e temporários isolados (dentro da pasta do pedido) e nenhum segredo.
 * Atenção (Windows): o libuv reinjeta no filho algumas variáveis do pai que faltarem (PATH, SYSTEMROOT, USERNAME...),
 * então a garantia é "nenhum segredo e home/temp nossos", não "só as variáveis da lista".
 * COLUMNS=300: o `rich` preenche cada linha de log até a largura (1000 colunas = 1 KB por linha em DEBUG).
 */
export function buildSpotdlEnv(homeDir, tmpDir, baseEnv = process.env) {
    assertSafeArg(homeDir, 'home');
    assertSafeArg(tmpDir, 'temp');
    const env = {};
    for (const [key, value] of Object.entries(baseEnv || {})) {
        if (value === undefined || value === null) continue;
        const upper = key.toUpperCase();
        if (ENV_FORCED.has(upper)) continue;
        if (ENV_ALLOW.has(upper)) env[key] = String(value);
    }
    Object.assign(env, {
        USERPROFILE: homeDir, // Path.home() do Python no Windows
        HOME: homeDir, // Path.home() no Linux
        TEMP: tmpDir,
        TMP: tmpDir,
        TMPDIR: tmpDir,
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
        NO_COLOR: '1',
        TERM: 'dumb',
        COLUMNS: '300',
    });
    return env;
}

/**
 * Envolve um execFile para injetar `env` sem mexer em runTool. `onChild(child)` recebe o processo recém-criado
 * (o handler o registra em trackSpotdlChild).
 */
export function withEnv(execFileImpl, env, onChild) {
    return (file, args, options, callback) => {
        const child = execFileImpl(file, args, { ...options, env }, callback);
        if (child && typeof onChild === 'function') {
            try { onChild(child); } catch { /* melhor esforço */ }
        }
        return child;
    };
}

// ---------------------------------------------------------------------------
// Filhos vivos (gancho de saída)
// ---------------------------------------------------------------------------

const liveChildren = new Set();
const hookedProcesses = new WeakSet();

/** Registra um filho recém-criado. Sai do conjunto sozinho nos eventos exit/close. */
export function trackSpotdlChild(child) {
    if (!child || typeof child !== 'object') return;
    liveChildren.add(child);
    if (typeof child.once === 'function') {
        const forget = () => { liveChildren.delete(child); };
        child.once('exit', forget);
        child.once('close', forget);
    }
}

export function forgetSpotdlChild(child) {
    if (child) liveChildren.delete(child);
}

export function countLiveSpotdlChildren() {
    return liveChildren.size;
}

/**
 * Encerra a ÁRVORE dos spotdl ainda vivos (o spotdl.exe do pip lança python.exe, que lança ffmpeg e deno).
 * REGRA DE SEGURANÇA: só mexe em `child.pid` de um filho que ESTA execução criou e que continua vivo
 * (exitCode e signalCode nulos). Nunca em PID guardado, achado por varredura ou de lista antiga: no Windows os PIDs
 * são reaproveitados, e matar o PID errado derruba um programa que não é da Yui.
 * Síncrona (serve ao evento 'exit' do processo). Devolve quantas árvores tentou encerrar.
 */
export function killLiveSpotdlTrees({ execFileSyncImpl = execFileSync, platform = process.platform, children = liveChildren } = {}) {
    let attempted = 0;
    for (const child of [...children]) {
        if (!child || child.exitCode !== null || child.signalCode !== null) continue; // não é um processo vivo nosso
        if (!Number.isInteger(child.pid) || child.pid <= 0) continue;
        attempted++;
        try {
            if (platform === 'win32') {
                execFileSyncImpl('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000, stdio: 'ignore' });
            } else if (typeof child.kill === 'function') {
                child.kill('SIGKILL');
            }
        } catch { /* já morreu ou o taskkill falhou: melhor esforço */ }
    }
    return attempted;
}

/** Instala (uma única vez por processo) o gancho que encerra os spotdl vivos se a Yui sair no meio de um download. */
export function installSpotdlExitHook(proc = process) {
    if (!proc || typeof proc.once !== 'function' || hookedProcesses.has(proc)) return false;
    hookedProcesses.add(proc);
    proc.once('exit', () => { killLiveSpotdlTrees(); });
    return true;
}

// ---------------------------------------------------------------------------
// Resumo seguro e classificação da saída
// ---------------------------------------------------------------------------

const ANSI_RE = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
// Sequências OSC (ESC ] ... BEL ou ESC \): mudam o título do terminal de quem lê o log.
const OSC_RE = /\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)?/g;
// Controles que sobram (NUL, BEL, BS, ESC solto, DEL, C1) e caracteres bidirecionais/invisíveis que disfarçam texto no log.
const CONTROL_RE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;
const SUMMARY_TAIL_CHARS = 256 * 1024; // só o fim da saída interessa (é de lá que se escolhe a linha) e limita o custo
const SUMMARY_LINE_CHARS = 2000; // antes das expressões regulares: uma linha gigante estourava a pilha delas (RangeError)

/**
 * Resumo SEGURO para o log: sem ANSI/OSC/controles, sem URL (podem ter assinatura/IP), sem caminho (Windows, UNC, relativo
 * ou POSIX), sem IP, sem chave=valor, sem cabeçalho Authorization/Cookie, sem "Bearer ..." e sem JSON de token.
 * Uma linha só (a mais "interessante"), no máximo `max` caracteres. NUNCA lança: em caso de erro devolve ''.
 */
export function summarizeToolOutput(text, max = 200) {
    try {
        const raw = String(text ?? '');
        const lines = (raw.length > SUMMARY_TAIL_CHARS ? raw.slice(-SUMMARY_TAIL_CHARS) : raw)
            .replace(OSC_RE, '')
            .replace(ANSI_RE, '')
            .split(/\r?\n/)
            .map((line) => line.slice(0, SUMMARY_LINE_CHARS).replace(/\s+/g, ' ').replace(CONTROL_RE, '').trim())
            .filter(Boolean);
        if (!lines.length) return '';
        const interesting = [...lines].reverse().find((line) => /error|exception|failed|blocked|no results|not found|not installed|could not|no longer/i.test(line));
        const line = (interesting || lines[lines.length - 1])
            .replace(/\b(authorization|proxy-authorization|set-cookie|cookie)\s*:.*$/i, '$1: <oculto>')
            .replace(/\bBearer\s+\S+/gi, '<oculto>')
            .replace(/"[^"\s]{0,60}(?:token|secret|password|passwd|cookie|authorization|api[_-]?key|signature)[^"\s]{0,60}"\s*:\s*"[^"]*"/gi, '<oculto>')
            .replace(/https?:\/\/\S+/gi, '<url>')
            .replace(/\\\\[^\s\\]+\\\S*/g, '<caminho>') // UNC: \\servidor\pasta\arquivo
            .replace(/[A-Za-z]:[\\/](?:[^\\/:*?"<>|\r\n]+[\\/])*[^\\/:*?"<>|\r\n]*/g, '<caminho>')
            .replace(/(^|[\s"'(=])\.{1,2}[\\/]\S*/g, '$1<caminho>') // relativo: ..\x, .\x, ./x
            .replace(/(?:[^\s\\/:*?"<>|]+\\){2,}[^\s\\/:*?"<>|]*/g, '<caminho>') // relativo do Windows com pastas: a\b\c.txt
            .replace(/(^| )\/[^ ]*\/[^ ]*/g, '$1<caminho>')
            .replace(/\b\d{1,3}(?:\.\d{1,3}){3}\b/g, '<ip>')
            .replace(/\b[A-Za-z_][\w.-]*=\S+/g, '<oculto>');
        let summary = line.slice(0, max);
        if (/[\ud800-\udbff]$/.test(summary)) summary = summary.slice(0, -1); // não deixa meio par substituto
        return summary;
    } catch {
        return '';
    }
}

// Trechos que carregam texto vindo do Spotify (título e artista). São apagados ANTES de classificar:
// uma faixa chamada "Too Many Requests" ou "Could not get session" não pode virar bloqueio.
// Mensagens do spotdl 4.5.2 que embutem "artista - título" (conferidas em download/downloader.py e utils/search.py):
// "No results found for song:", "yt-dlp failed to get metadata for:", "Song is missing required fields:",
// "<nome> generated an exception:", "Skipping explicit song:", 'Downloaded "<nome>": url' e as de DEBUG.
const TITLE_SCRUBS = [
    [/for song:.*$/, 'for song:'],
    [/metadata for:.*$/, 'metadata for:'],
    [/missing required fields:.*$/, 'missing required fields:'],
    [/^.*? generated an exception:/, 'generated an exception:'],
    [/no usable results for .*$/, 'no usable results for'],
    [/failed to convert .*$/, 'failed to convert'],
    [/could not find a match for .*$/, 'could not find a match for'],
    [/skipping explicit song:.*$/, 'skipping explicit song:'],
    [/lrc file for .*$/, 'lrc file for'],
    [/\bdownloaded ".*$/, 'downloaded ""'], // o título pode ter aspas: apaga até o fim da linha
    [/no download info found for .*$/, 'no download info found for'],
    [/\bfailed to find .*$/, 'failed to find'],
    [/\bdownloading .*$/, 'downloading'],
];

/**
 * Minúsculas, sem ANSI, sem os trechos com título e com os espaços colapsados. Uma linha INDENTADA é continuação da
 * anterior (o `rich` quebra a mensagem na largura e indenta o resto no modo DEBUG): junta-se antes de apagar o título,
 * para o pedaço do título que quebrou de linha sumir junto.
 */
function normalizeForClassification(text) {
    const entries = [];
    for (const line of String(text ?? '').replace(ANSI_RE, '').split(/\r?\n/)) {
        if (entries.length && /^\s+\S/.test(line)) entries[entries.length - 1] += ` ${line}`;
        else entries.push(line);
    }
    return entries
        .map((entry) => TITLE_SCRUBS.reduce((acc, [re, replacement]) => acc.replace(re, replacement), entry.toLowerCase()))
        .join(' ')
        .replace(/\s+/g, ' ')
        .trim();
}

// Regras por TRECHO de texto, da primeira para a última. O motivo real das falhas do yt-dlp ("not a bot", 429,
// "Video unavailable"...) só aparece com --log-level DEBUG; por isso ficam em DEBUG_RULES.
const RULES_BEFORE_DEBUG = [
    ['broken', ['fatal error in launcher', 'no python at', 'modulenotfounderror', 'importerror', 'no module named', 'syntaxerror']],
    ['ffmpeg_env', ['ffmpeg is not installed']],
    ['gone', ['track no longer exists', "couldn't get metadata"]],
    ['spotify_down', [
        'could not get session', 'could not get client token', 'could not get general hashes', 'could not get song info',
        'could not get playlist hashes', 'could not get album', 'could not get artist', 'failed to complete request',
        'request kept failing', 'invalid json', 'error occurred while reinitializing song',
    ]],
    ['no_network', ['connectionerror', 'max retries exceeded', 'getaddrinfo failed', 'name or service not known']],
    ['blocked_ytm', ['you might be blocked by youtube music']],
    ['not_found', ['no results found for song', 'lookuperror']],
];
// "Sign in to confirm you're not a bot" é bloqueio; "Sign in to confirm your age" é conteúdo restrito (por isso o
// trecho "sign in to confirm" sozinho não serve: casaria com os dois).
const DEBUG_RULES = [
    ['blocked', ['not a bot', "sign in to confirm you're", 'sign in to confirm you’re', 'http error 429', 'too many requests']],
    ['private', ['private video', 'video unavailable', 'age-restricted', 'age restricted', 'confirm your age']],
];
const RULES_AFTER_DEBUG = [
    ['ytdlp_fail', ['yt-dlp download error', 'yt-dlp failed to get metadata', 'no metadata found for the provided url']],
    ['ffmpeg_fail', ['failed to convert', 'ffmpegerror']],
];

// Dicas FIXAS para o log do operador (sem dados do pedido, sem "chave=valor").
const HINTS = Object.freeze({
    broken: 'O ambiente do spotdl parece quebrado (ou SPOTDL_PATH não aponta para um .exe); recrie o .venv-spotdl (veja GET_STARTED).',
    ffmpeg_env: 'O spotdl não achou o ffmpeg; confira FFMPEG_PATH ou o PATH.',
    spotify_down: 'O Spotify não respondeu: bloqueio ou limite de pedidos, instabilidade, relógio do PC errado ou mudança no web player.',
    no_network: 'Sem rede para o Spotify ou o YouTube Music.',
    blocked_ytm: 'O YouTube Music parece estar bloqueando este IP.',
    ytdlp_fail: 'O motivo do yt-dlp fica oculto; defina YUI_SPOTDL_LOG_LEVEL como DEBUG para ver.',
});

/** Tipos de falha que contam no disjuntor (o lado Spotify/rede, não a faixa). */
export const SPOTDL_BREAKER_KINDS = Object.freeze(['spotify_down', 'no_network', 'blocked_ytm']);

/**
 * Classifica o resultado de runTool(spotdl). NÃO confie só no código de saída: o spotdl sai com 0 mesmo quando a
 * faixa não foi achada ou o download falhou (só loga o erro e segue). O log do `rich` vai para o STDOUT, então a
 * análise junta stdout e stderr.
 *  kind: 'missing' | 'timeout' | 'broken' | 'ffmpeg_env' | 'gone' | 'spotify_down' | 'no_network' | 'blocked_ytm'
 *        | 'not_found' | 'blocked' | 'private' (as duas últimas só com DEBUG) | 'ytdlp_fail' | 'ffmpeg_fail' | 'unknown'
 * @param {{ error?: any, stdout?: string, stderr?: string, timedOut?: boolean }} run
 * @param {{ debug?: boolean }} [options] debug: o spotdl rodou com --log-level DEBUG
 * @returns {{ kind: string, detail: string, hint: string, exitFailed: boolean }}
 */
export function classifySpotdlRun(run, { debug = false } = {}) {
    const raw = `${run?.stdout || ''}\n${run?.stderr || ''}`;
    const exitFailed = Boolean(run?.error);
    const code = run?.error?.code;
    const result = (kind, extraHint = '') => ({
        kind,
        detail: summarizeToolOutput(raw),
        hint: `${HINTS[kind] || ''}${extraHint}`.trim(),
        exitFailed,
    });
    if (code === 'ENOENT') return result('missing');
    if (run?.timedOut) return result('timeout');
    // EINVAL: o Node recusa iniciar .cmd/.bat sem shell (SPOTDL_PATH apontando para um script em vez do .exe).
    if (code === 'EACCES' || code === 'EPERM' || code === 'UNKNOWN' || code === 'EINVAL') return result('broken');

    const text = normalizeForClassification(raw);
    const match = (rules) => {
        for (const [kind, needles] of rules) {
            if (needles.some((needle) => text.includes(needle))) return kind;
        }
        return null;
    };
    const early = match(RULES_BEFORE_DEBUG);
    if (early) return result(early);
    if (debug) {
        const debugKind = match(DEBUG_RULES);
        if (debugKind) return result(debugKind);
    }
    const late = match(RULES_AFTER_DEBUG);
    if (late) return result(late, late === 'ytdlp_fail' && text.includes('require deno') ? ' O yt-dlp pediu o Deno: confira se ele está no PATH.' : '');
    return result('unknown');
}

/** Converte o veredito de classifySpotdlRun em MediaError (código estável + frase amigável, sem detalhe técnico). */
export function spotdlFailureToMediaError(verdict, cause) {
    const { kind, detail, exitFailed } = verdict;
    const make = (code, message) => new MediaError(code, message, { detail, cause });
    switch (kind) {
        case 'timeout': return make('DOWNLOAD_TIMEOUT', MEDIA_MESSAGES.DOWNLOAD_TIMEOUT);
        case 'missing':
        case 'broken': return make('SPOTIFY_UNAVAILABLE', MEDIA_MESSAGES.SPOTIFY_UNAVAILABLE);
        case 'gone':
        case 'private': return make('SPOTIFY_PRIVATE', MEDIA_MESSAGES.SPOTIFY_PRIVATE);
        case 'spotify_down':
        case 'no_network':
        case 'blocked_ytm':
        case 'blocked': return make('SPOTIFY_BLOCKED', SPOTDL_MESSAGES.BLOCKED);
        case 'not_found': return make('SPOTIFY_NOT_FOUND', SPOTDL_MESSAGES.NOT_FOUND);
        case 'unknown': return exitFailed
            ? make('SPOTIFY_ERROR', MEDIA_MESSAGES.SPOTIFY_ERROR)
            : make('SPOTIFY_NO_FILE', MEDIA_MESSAGES.SPOTIFY_NO_FILE);
        default: return make('SPOTIFY_ERROR', MEDIA_MESSAGES.SPOTIFY_ERROR); // ffmpeg_env, ytdlp_fail, ffmpeg_fail
    }
}

// ---------------------------------------------------------------------------
// Porteiro global: poucos spotdl ao mesmo tempo
// ---------------------------------------------------------------------------

function busyError(detail) {
    return new MediaError('SPOTIFY_BUSY', SPOTDL_MESSAGES.BUSY, { detail });
}

/**
 * Limita quantos spotdl rodam juntos (cada um é uma cadeia python + ffmpeg + deno e abre 3 sessões no Spotify).
 * Acima de `maxParallel` o pedido espera na fila; com a fila cheia (`maxWaiting`) ou depois de `maxWaitMs`
 * esperando, falha com SPOTIFY_BUSY sem iniciar processo. acquire() devolve a função que libera a vaga
 * (o chamador a executa num finally; chamá-la de novo não faz nada).
 */
export function createSpotdlGate({ maxParallel = DEFAULT_MAX_PARALLEL, maxWaiting = 3, maxWaitMs = 180_000 } = {}) {
    let running = 0;
    const waiting = [];
    const makeRelease = () => {
        let released = false;
        return () => {
            if (released) return;
            released = true;
            running--;
            drain();
        };
    };
    function drain() {
        while (running < maxParallel && waiting.length) {
            const entry = waiting.shift();
            clearTimeout(entry.timer);
            running++;
            entry.resolve(makeRelease());
        }
    }
    return {
        acquire() {
            if (running < maxParallel) {
                running++;
                return Promise.resolve(makeRelease());
            }
            if (waiting.length >= maxWaiting) return Promise.reject(busyError('fila do spotdl cheia'));
            return new Promise((resolve, reject) => {
                const entry = { resolve, timer: null };
                entry.timer = setTimeout(() => {
                    const index = waiting.indexOf(entry);
                    if (index >= 0) waiting.splice(index, 1);
                    reject(busyError('tempo de espera na fila do spotdl esgotado'));
                }, maxWaitMs); // só existe enquanto o pedido está na fila (limpo em drain); sem unref, para o prazo sempre valer
                waiting.push(entry);
            });
        },
        stats() {
            return { running, waiting: waiting.length, maxParallel, maxWaiting };
        },
    };
}

let defaultGate = null;
/** Porteiro único do processo (criado na primeira vez, com YUI_SPOTDL_MAX_PARALLEL daquele momento). */
export function getSpotdlGate(env = process.env) {
    if (!defaultGate) defaultGate = createSpotdlGate({ maxParallel: readSpotdlMaxParallel(env) });
    return defaultGate;
}

// ---------------------------------------------------------------------------
// Disjuntor: Spotify/rede fora do ar
// ---------------------------------------------------------------------------

// Resultados que provam que o Spotify respondeu (a falha veio depois, na faixa): zeram a contagem.
const BREAKER_RESET_KINDS = new Set(['ok', 'not_found', 'gone', 'ytdlp_fail', 'ffmpeg_fail']);

/**
 * Depois de `threshold` falhas SEGUIDAS do lado Spotify/rede (SPOTDL_BREAKER_KINDS), recusa novos pedidos por
 * `openMs` com SPOTIFY_BLOCKED, sem iniciar processo: insistir só piora o bloqueio. Um sucesso (ou um resultado que
 * prova que o Spotify respondeu) zera a contagem; falhas locais (timeout, ffmpeg, ambiente) não contam nem zeram.
 * Passado o prazo, o circuito fecha e a contagem recomeça do zero.
 */
export function createSpotdlBreaker({ threshold = 3, openMs = 5 * 60 * 1000, now = Date.now } = {}) {
    let failures = 0;
    let openUntil = 0;
    const isOpen = () => {
        if (openUntil && now() >= openUntil) {
            openUntil = 0;
            failures = 0;
        }
        return openUntil > 0;
    };
    return {
        isOpen,
        assertClosed() {
            if (isOpen()) throw new MediaError('SPOTIFY_BLOCKED', SPOTDL_MESSAGES.BLOCKED, { detail: 'disjuntor do spotdl aberto' });
        },
        /** Registra o resultado de um pedido ('ok' ou um kind). Devolve true se ESTE resultado abriu o circuito. */
        record(kind) {
            if (BREAKER_RESET_KINDS.has(kind)) {
                failures = 0;
                return false;
            }
            if (!SPOTDL_BREAKER_KINDS.includes(kind)) return false;
            failures++;
            if (failures >= threshold && !isOpen()) {
                openUntil = now() + openMs;
                return true;
            }
            return false;
        },
        state() {
            const open = isOpen();
            return { open, failures, retryInMs: open ? Math.max(0, openUntil - now()) : 0 };
        },
    };
}

let defaultBreaker = null;
/** Disjuntor único do processo. */
export function getSpotdlBreaker() {
    if (!defaultBreaker) defaultBreaker = createSpotdlBreaker();
    return defaultBreaker;
}
