// Testes da ligação com o spotdl (downloads de faixas do Spotify): argumentos, ambiente mínimo, classificação
// das falhas, porteiro, disjuntor, encerramento dos filhos e o fluxo completo do handler.
// Sem rede e sem baixar música: o execFile é substituído por dublês. As únicas execuções reais são
//  - o `spotdl.exe --version` do .venv-spotdl (se existir), com ambiente mínimo e HOME falso numa pasta temporária;
//  - processos `node` que o próprio teste cria (e só encerra o que criou).
// Execução: npm run test:spotdl
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { MediaError, runTool } from '../src/utils/mediaUrls.js';
import {
    SPOTDL_MESSAGES,
    ALLOWED_SPOTDL_FLAGS,
    SPOTDL_BREAKER_KINDS,
    readSpotdlBitrate,
    readSpotdlLogLevel,
    readSpotdlMaxParallel,
    resolveSpotdl,
    getSpotdlPath,
    checkSpotdl,
    buildSpotdlArgs,
    findSpotdlUnsafePathPart,
    buildSpotdlEnv,
    withEnv,
    trackSpotdlChild,
    forgetSpotdlChild,
    countLiveSpotdlChildren,
    killLiveSpotdlTrees,
    installSpotdlExitHook,
    summarizeToolOutput,
    classifySpotdlRun,
    spotdlFailureToMediaError,
    createSpotdlGate,
    createSpotdlBreaker,
    getSpotdlGate,
    getSpotdlBreaker,
} from '../src/utils/spotdlTools.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Isolamento: cwd, logs e banco em pasta temporária (nada do projeto real é tocado).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-spotdl-test-'));
const originalCwd = process.cwd();
process.env.DATABASE_DIR = process.env.DATABASE_DIR || path.join(sandbox, 'db');
process.env.LOG_LEVEL = 'error';
process.chdir(sandbox);

let passed = 0;
const failures = [];
const TEST_TIMEOUT_MS = 90_000; // um teste que trava (fila do porteiro, processo preso) FALHA em vez de pendurar a suíte
async function test(name, fn) {
    let timer;
    try {
        await Promise.race([
            Promise.resolve().then(fn),
            new Promise((_, reject) => { timer = setTimeout(() => reject(new Error(`o teste passou de ${TEST_TIMEOUT_MS / 1000} s sem terminar`)), TEST_TIMEOUT_MS); }),
        ]);
        passed++;
        console.log(`  ok    ${name}`);
    } catch (err) {
        failures.push(name);
        console.log(`  FALHA ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
    } finally {
        clearTimeout(timer);
    }
}
function skip(name, why) {
    console.log(`  pulou ${name} (${why})`);
}
const waitFor = async (condition, ms = 5000) => {
    const limit = Date.now() + ms;
    while (!condition() && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 10));
    return condition();
};

const SP = '4uLU6hMCjMI75M1A2tKUQC';
const URL_OK = `https://open.spotify.com/track/${SP}`;
const OUT = path.join(sandbox, 'req', '00000000-0000-4000-8000-000000000000');
const FFMPEG_FILE = path.join(sandbox, 'ffmpeg.exe');
fs.writeFileSync(FFMPEG_FILE, 'x');
const execError = (code, extra = {}) => Object.assign(new Error('Command failed: spotdl download'), { code, killed: false, ...extra });
const ENOENT = Object.assign(new Error('spawn spotdl ENOENT'), { code: 'ENOENT' });

// ---------------------------------------------------------------------------
console.log('Argumentos (lista fixa)');
const FULL_ORDER = ['--format', '--output', '--bitrate', '--max-filename-length', '--threads', '--ffmpeg', '--lyrics', '--simple-tui', '--log-level'];

await test('argv: "download" e a URL canônica nas posições 0 e 1, URL uma única vez, sem "--" nem aspas', () => {
    const args = buildSpotdlArgs(URL_OK, OUT, { ffmpegPath: FFMPEG_FILE });
    assert.ok(Array.isArray(args));
    assert.equal(args[0], 'download');
    assert.equal(args[1], URL_OK);
    assert.equal(args.filter((a) => a === URL_OK).length, 1);
    assert.ok(!args.includes('--'));
    assert.ok(args.every((a) => typeof a === 'string' && !a.includes('"')));
    assert.equal(args[args.indexOf('--output') + 1], OUT);
    assert.equal(args[args.indexOf('--format') + 1], 'mp3');
    assert.equal(args[args.indexOf('--bitrate') + 1], '192k');
    assert.equal(args[args.indexOf('--max-filename-length') + 1], '120');
    assert.equal(args[args.indexOf('--threads') + 1], '1');
    assert.equal(args[args.indexOf('--ffmpeg') + 1], FFMPEG_FILE);
    assert.equal(args[args.indexOf('--log-level') + 1], 'WARNING');
});
await test('argv: todo token que começa com "-" está na lista permitida, e a lista inteira aparece no argv completo', () => {
    assert.deepEqual([...ALLOWED_SPOTDL_FLAGS], FULL_ORDER);
    assert.ok(Object.isFrozen(ALLOWED_SPOTDL_FLAGS));
    const full = buildSpotdlArgs(URL_OK, OUT, { ffmpegPath: FFMPEG_FILE });
    const flags = full.filter((a) => a.startsWith('-'));
    assert.deepEqual(flags, FULL_ORDER, 'sentido 1: nada fora da lista; sentido 2: a lista toda está lá');
    for (const flag of flags) assert.ok(ALLOWED_SPOTDL_FLAGS.includes(flag), flag);
    const semFfmpeg = buildSpotdlArgs(URL_OK, OUT).filter((a) => a.startsWith('-'));
    assert.deepEqual(semFfmpeg, FULL_ORDER.filter((f) => f !== '--ffmpeg'));
});
await test('argv: nunca as flags que mudariam o R1, abririam login ou executariam outra ação', () => {
    const args = buildSpotdlArgs(URL_OK, OUT, { ffmpegPath: FFMPEG_FILE });
    const proibidos = [
        '--config', '--fetch-albums', '--scan-for-songs', '--archive', '--m3u', '--save-file', '--audio', '--cookie-file',
        '--user-auth', '--client-id', '--client-secret', '--use-official-api', '--generate-config', '--download-ffmpeg',
        '--check-for-updates', '--yt-dlp-args', '--print-errors', '--save-errors', '--overwrite', '--sponsor-block',
        'web', 'sync', 'save', 'meta', 'url',
    ];
    for (const p of proibidos) assert.ok(!args.includes(p), p);
    assert.ok(!args.some((a) => a.startsWith('--config') || a.startsWith('--fetch') || a.startsWith('--scan')));
});
await test('argv: "--lyrics" (sem provedores) vem depois da URL e antes de OUTRA opção', () => {
    const args = buildSpotdlArgs(URL_OK, OUT);
    const i = args.indexOf('--lyrics');
    assert.ok(i > 1, 'depois da URL');
    assert.ok(args[i + 1].startsWith('--'), 'seguido de outra opção, senão engoliria o próximo valor');
});
await test('argv: bitrate e nível de log configuráveis', () => {
    const args = buildSpotdlArgs(URL_OK, OUT, { bitrate: '192k', logLevel: 'DEBUG' });
    assert.equal(args[args.indexOf('--bitrate') + 1], '192k');
    assert.equal(args[args.indexOf('--log-level') + 1], 'DEBUG');
    assert.equal(buildSpotdlArgs(URL_OK, OUT, { logLevel: 'INFO' }).at(-1), 'INFO');
});
await test('argv: recusa tudo que não seja a URL canônica de faixa (inclusive injeção de flag e abreviações do argparse)', () => {
    for (const bad of [
        '--help', '--output=C:/pwned', '--out C:/pwned', '-evil', '--generate-config', '--download-ffmpeg',
        `https://open.spotify.com/album/${SP}`, `https://open.spotify.com/playlist/${SP}`, `https://open.spotify.com/track/${SP}?si=x`,
        `https://open.spotify.com/track/${SP}"&calc`, `${URL_OK}|https://youtu.be/dQw4w9WgXcQ`, `${URL_OK} --output C:/x`,
        `${URL_OK}\n--lyrics`, `http://open.spotify.com/track/${SP}`, `open.spotify.com/track/${SP}`, ` ${URL_OK}`,
        'https://open.spotify.com/track/curto', 'saved', '', null, undefined, 42, {},
    ]) {
        assert.throws(() => buildSpotdlArgs(bad, OUT), /URL inválida/, JSON.stringify(bad));
    }
});
await test('argv: recusa pasta de saída que o spotdl alteraria (componente que começa com "." ou termina com ".", "*" ou "$")', () => {
    // spotdl/utils/formatter.py: re.search(r"[^\.*](.*)[^\.*$]", parte) em cada componente do --output
    assert.equal(findSpotdlUnsafePathPart('D:/Projetos/Yui/src/data/temp_spotify/00000000-0000-4000-8000-000000000000'), null);
    assert.equal(findSpotdlUnsafePathPart('C:\\Users\\x\\.yui\\src\\data'), '.yui');
    assert.equal(findSpotdlUnsafePathPart('/home/u/.apps/yui'), '.apps');
    assert.equal(findSpotdlUnsafePathPart('D:/Meus Docs./x'), 'Meus Docs.');
    assert.equal(findSpotdlUnsafePathPart('D:/dados$/x'), 'dados$');
    assert.equal(findSpotdlUnsafePathPart('D:/dados*/x'), 'dados*');
    assert.equal(findSpotdlUnsafePathPart('D:/..xy/y'), '..xy');
    // o que o spotdl preserva: nomes curtos (a regex não casa), pontos no meio, ".spotdl" e o próprio drive
    for (const ok of ['D:/a./x', 'D:/.s/x', 'D:/..x/y', 'D:/a.b/x', 'D:/x.y.z/a', 'D:/.spotdl/x', 'D:/Meus Docs/x', 'D:/a-b_c (1)/x', 'C:\\Users\\mauri\\AppData\\Local\\Temp\\yui', '']) {
        assert.equal(findSpotdlUnsafePathPart(ok), null, ok);
    }
    assert.equal(findSpotdlUnsafePathPart(null), null);
    // compartilhamento UNC (\\servidor\c$) é "âncora" no Python e não passa pelo filtro
    assert.equal(findSpotdlUnsafePathPart('\\\\pc\\c$\\00000000-0000-4000-8000-000000000000'), null);
    assert.equal(findSpotdlUnsafePathPart('\\\\pc\\c$\\.oculta\\uuid'), '.oculta');
    for (const bad of [path.join(sandbox, '.oculta', 'req'), path.join(sandbox, 'pasta.longa.', 'req'), path.join(sandbox, 'pasta$', 'req'), path.join(sandbox, 'req', '.x-uuid')]) {
        assert.throws(() => buildSpotdlArgs(URL_OK, bad), /começa com "\."/, bad);
    }
    assert.ok(buildSpotdlArgs(URL_OK, path.join(sandbox, 'a.b', 'req')).includes('--output'));
});
await test('argv: recusa pasta e ffmpeg relativos, aspas, quebra de linha, bitrate e nível de log inválidos', () => {
    assert.throws(() => buildSpotdlArgs(URL_OK, 'relativo/pasta'), /absoluta/);
    assert.throws(() => buildSpotdlArgs(URL_OK, `${OUT}"; calc`), /Argumento inválido/);
    assert.throws(() => buildSpotdlArgs(URL_OK, `${OUT}\nx`), /Argumento inválido/);
    assert.throws(() => buildSpotdlArgs(URL_OK, ''), /Argumento inválido/);
    assert.throws(() => buildSpotdlArgs(URL_OK, OUT, { ffmpegPath: 'bin/ffmpeg.exe' }), /absoluto/);
    assert.throws(() => buildSpotdlArgs(URL_OK, OUT, { ffmpegPath: `${FFMPEG_FILE}"` }), /Argumento inválido/);
    for (const bitrate of ['320k --x', '320', 'k', '1', '3200k', '--bitrate', null, 320]) {
        assert.throws(() => buildSpotdlArgs(URL_OK, OUT, { bitrate }), /Bitrate inválido/, String(bitrate));
    }
    for (const logLevel of ['TRACE', 'warning', 'DEBUG --x', '', null]) {
        assert.throws(() => buildSpotdlArgs(URL_OK, OUT, { logLevel }), /Nível de log inválido/, String(logLevel));
    }
});

// ---------------------------------------------------------------------------
console.log('Configuração por ambiente');
await test('YUI_SPOTDL_BITRATE: padrão 192k; valores válidos passam; inválido volta a 192k', () => {
    assert.equal(readSpotdlBitrate({}), '192k');
    assert.equal(readSpotdlBitrate(undefined), '192k');
    assert.equal(readSpotdlBitrate({ YUI_SPOTDL_BITRATE: '128k' }), '128k');
    assert.equal(readSpotdlBitrate({ YUI_SPOTDL_BITRATE: ' 192K ' }), '192k');
    assert.equal(readSpotdlBitrate({ YUI_SPOTDL_BITRATE: '256k' }), '256k');
    assert.equal(readSpotdlBitrate({ YUI_SPOTDL_BITRATE: '064k' }), '64k');
    for (const bad of ['', '320', 'abc', '63k', '321k', '1k', '0k', '320kb', '320k --x', '-192k', '192k;calc', '1920k']) {
        assert.equal(readSpotdlBitrate({ YUI_SPOTDL_BITRATE: bad }), '192k', JSON.stringify(bad));
    }
});
await test('YUI_SPOTDL_LOG_LEVEL: WARNING (padrão), INFO ou DEBUG; outro valor vira WARNING', () => {
    assert.equal(readSpotdlLogLevel({}), 'WARNING');
    assert.equal(readSpotdlLogLevel({ YUI_SPOTDL_LOG_LEVEL: 'info' }), 'INFO');
    assert.equal(readSpotdlLogLevel({ YUI_SPOTDL_LOG_LEVEL: ' Debug ' }), 'DEBUG');
    assert.equal(readSpotdlLogLevel({ YUI_SPOTDL_LOG_LEVEL: 'WARNING' }), 'WARNING');
    for (const bad of ['', 'TRACE', 'ERROR', 'CRITICAL', 'DEBUG --x', '0']) {
        assert.equal(readSpotdlLogLevel({ YUI_SPOTDL_LOG_LEVEL: bad }), 'WARNING', JSON.stringify(bad));
    }
});
await test('YUI_SPOTDL_MAX_PARALLEL: padrão 2, limitado a 1..4', () => {
    assert.equal(readSpotdlMaxParallel({}), 2);
    assert.equal(readSpotdlMaxParallel({ YUI_SPOTDL_MAX_PARALLEL: '1' }), 1);
    assert.equal(readSpotdlMaxParallel({ YUI_SPOTDL_MAX_PARALLEL: '3' }), 3);
    assert.equal(readSpotdlMaxParallel({ YUI_SPOTDL_MAX_PARALLEL: '99' }), 4);
    for (const bad of ['0', '-1', 'abc', '', '2.5', '1e1']) {
        assert.equal(readSpotdlMaxParallel({ YUI_SPOTDL_MAX_PARALLEL: bad }), 2, JSON.stringify(bad));
    }
});

// ---------------------------------------------------------------------------
console.log('Ambiente do processo filho');
const HOME = path.join(OUT, '_home');
const TMP = path.join(HOME, 'tmp');
const SECRETS = {
    DISCORD_TOKEN: 'segredo-discord', DISCORD_CLIENT_SECRET: 'segredo-client', GEMINI_API_KEY: 'segredo-gemini', GROQ_API_KEY: 'segredo-groq',
    HF_TOKEN: 'segredo-hf', DEEZER_ARL: 'segredo-arl', DEEMIX_ARL: 'segredo-arl2', OWNER_ID: 'segredo-dono', YTDLP_COOKIES_PATH: 'C:/segredo/cookies.txt',
    PYTHONPATH: 'C:/segredo/py', PYTHONHOME: 'C:/segredo/pyhome', NODE_OPTIONS: '--segredo-inspect', SPOTDL_PATH: 'C:/segredo/spotdl.exe',
};
await test('env: sem nenhum segredo; home e temporários DENTRO da pasta do pedido; UTF-8; COLUMNS=300', () => {
    const base = {
        ...SECRETS, Path: 'C:/bin;C:/ffmpeg', SystemRoot: 'C:/Windows', HTTPS_PROXY: 'http://proxy:8080', LOCALAPPDATA: 'C:/Users/real/AppData/Local',
        USERPROFILE: 'C:/Users/real', HOME: 'C:/Users/real', TEMP: 'C:/Users/real/Temp', TMP: 'C:/Users/real/Temp', TMPDIR: 'C:/Users/real/Temp', INDEFINIDA: undefined,
    };
    const env = buildSpotdlEnv(HOME, TMP, base);
    const texto = JSON.stringify(env);
    for (const proibido of [...Object.values(SECRETS), ...Object.keys(SECRETS), 'C:/Users/real/Temp', 'INDEFINIDA']) {
        assert.ok(!texto.includes(proibido), `vazou ${proibido}`);
    }
    for (const key of ['USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR']) {
        assert.ok(env[key] === HOME || env[key] === TMP, key);
        assert.ok(env[key].startsWith(OUT + path.sep), `${key} fora da pasta do pedido: ${env[key]}`);
    }
    assert.equal(env.USERPROFILE, HOME);
    assert.equal(env.HOME, HOME);
    assert.equal(env.TEMP, TMP);
    assert.equal(env.TMP, TMP);
    assert.equal(env.PYTHONUTF8, '1');
    assert.equal(env.PYTHONIOENCODING, 'utf-8');
    assert.equal(env.COLUMNS, '300');
    assert.equal(env.NO_COLOR, '1');
    assert.equal(env.TERM, 'dumb');
    assert.equal(env.Path, 'C:/bin;C:/ffmpeg', 'mantém a grafia original e o PATH (é por ele que o spotdl acha ffmpeg e deno)');
    assert.equal(env.SystemRoot, 'C:/Windows');
    assert.equal(env.HTTPS_PROXY, 'http://proxy:8080');
    assert.equal(env.LOCALAPPDATA, 'C:/Users/real/AppData/Local');
});
await test('env: recusa home/temp vazios, com aspas ou quebra de linha; aceita baseEnv ausente', () => {
    assert.throws(() => buildSpotdlEnv('', TMP, {}), /Argumento inválido/);
    assert.throws(() => buildSpotdlEnv(HOME, `${TMP}"`, {}), /Argumento inválido/);
    assert.throws(() => buildSpotdlEnv(`${HOME}\nx`, TMP, {}), /Argumento inválido/);
    assert.equal(buildSpotdlEnv(HOME, TMP, null).HOME, HOME);
});
await test('env (processo filho REAL de teste): o filho não enxerga segredos e usa o home isolado', async () => {
    const homeDir = path.join(sandbox, 'env-real', '_home');
    const tmpDir = path.join(homeDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const base = { ...SECRETS, ...process.env, ...SECRETS, USERPROFILE: 'C:/Users/real', HOME: 'C:/Users/real' };
    const env = buildSpotdlEnv(homeDir, tmpDir, base);
    const script = 'const e=process.env;console.log(JSON.stringify({keys:Object.keys(e).map((k)=>k.toUpperCase()),USERPROFILE:e.USERPROFILE,HOME:e.HOME,TEMP:e.TEMP,TMP:e.TMP,COLUMNS:e.COLUMNS,UTF8:e.PYTHONUTF8}));';
    const run = await runTool(process.execPath, ['-e', script], { timeoutMs: 30000, cwd: sandbox, execFileImpl: withEnv(execFile, env) });
    assert.equal(run.error, null, run.stderr);
    const seen = JSON.parse(run.stdout.trim().split(/\r?\n/).pop());
    for (const key of Object.keys(SECRETS)) {
        if (key === 'SPOTDL_PATH') continue; // não é segredo (nem passa), mas pode existir no processo real
        assert.ok(!seen.keys.includes(key.toUpperCase()), `o filho enxergou ${key}`);
    }
    assert.equal(seen.USERPROFILE, homeDir);
    assert.equal(seen.HOME, homeDir);
    assert.equal(seen.TEMP, tmpDir);
    assert.equal(seen.TMP, tmpDir);
    assert.equal(seen.COLUMNS, '300');
    assert.equal(seen.UTF8, '1');
});

// ---------------------------------------------------------------------------
console.log('withEnv e filhos vivos');
await test('withEnv: o env chega ao execFile (via runTool), as opções de segurança continuam e onChild recebe o filho', async () => {
    let seen;
    let notified = null;
    const child = { pid: 11 };
    const fake = (file, args, options, cb) => { seen = { file, args, options }; setImmediate(() => cb(null, '', '')); return child; };
    const env = buildSpotdlEnv('C:/h', 'C:/h/tmp', { PATH: 'p' });
    // killImpl vazio: se o timer não fosse limpo, o padrão rodaria `taskkill /pid 11` de verdade
    const run = await runTool('spotdl', ['download', URL_OK], { timeoutMs: 5000, cwd: 'C:/h', killImpl: () => {}, execFileImpl: withEnv(fake, env, (c) => { notified = c; }) });
    assert.equal(run.error, null);
    assert.equal(seen.options.env.USERPROFILE, 'C:/h');
    assert.equal(seen.options.windowsHide, true);
    assert.equal(seen.options.timeout, 5000);
    assert.equal(seen.options.cwd, 'C:/h');
    assert.deepEqual(seen.args, ['download', URL_OK]);
    assert.equal(notified, child);
    // onChild que lança ou filho ausente não derrubam o pedido
    const quebrado = withEnv(() => undefined, env, () => { throw new Error('x'); });
    assert.equal(quebrado('a', [], {}, () => {}), undefined);
});
await test('trackSpotdlChild: entra no conjunto e sai sozinho em exit/close; forgetSpotdlChild também remove', () => {
    const before = countLiveSpotdlChildren();
    const a = Object.assign(new EventEmitter(), { pid: 5001, exitCode: null, signalCode: null });
    const b = Object.assign(new EventEmitter(), { pid: 5002, exitCode: null, signalCode: null });
    const c = { pid: 5003 }; // sem eventos (dublê)
    try {
        trackSpotdlChild(a); trackSpotdlChild(b); trackSpotdlChild(c);
        trackSpotdlChild(null); trackSpotdlChild('texto');
        assert.equal(countLiveSpotdlChildren(), before + 3);
        a.emit('exit', 0);
        assert.equal(countLiveSpotdlChildren(), before + 2);
        b.emit('close', 0);
        assert.equal(countLiveSpotdlChildren(), before + 1);
        forgetSpotdlChild(c);
        forgetSpotdlChild(null);
        assert.equal(countLiveSpotdlChildren(), before);
    } finally {
        // se uma asserção falhar, estes dublês (PIDs inventados) NÃO podem ficar no conjunto global: o teste do filho real chama
        // killLiveSpotdlTrees() e faria `taskkill` contra PIDs que não são nossos
        forgetSpotdlChild(a); forgetSpotdlChild(b); forgetSpotdlChild(c);
    }
});
await test('killLiveSpotdlTrees: só mexe em filho VIVO (exitCode e signalCode nulos); taskkill /T /F no Windows', () => {
    const live = { pid: 4001, exitCode: null, signalCode: null };
    const children = new Set([
        live,
        { pid: 4002, exitCode: 0, signalCode: null }, // já saiu
        { pid: 4003, exitCode: null, signalCode: 'SIGTERM' }, // morto por sinal
        { pid: 4004 }, // dublê sem exitCode
        { pid: 0, exitCode: null, signalCode: null },
        { pid: -5, exitCode: null, signalCode: null },
        { pid: '4005', exitCode: null, signalCode: null },
        { exitCode: null, signalCode: null },
        null,
    ]);
    const calls = [];
    const execFileSyncImpl = (file, args, options) => { calls.push({ file, args, options }); };
    assert.equal(killLiveSpotdlTrees({ execFileSyncImpl, platform: 'win32', children }), 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].file, 'taskkill');
    assert.deepEqual(calls[0].args, ['/pid', '4001', '/T', '/F']);
    assert.equal(calls[0].options.windowsHide, true);
    assert.equal(calls[0].options.timeout, 5000);
    assert.equal(calls[0].options.stdio, 'ignore');
    // erro do taskkill (processo já morto) é engolido
    assert.equal(killLiveSpotdlTrees({ execFileSyncImpl: () => { throw new Error('128'); }, platform: 'win32', children }), 1);
    // fora do Windows: kill do filho vivo
    const killed = [];
    const posix = new Set([{ pid: 9001, exitCode: null, signalCode: null, kill: (s) => killed.push(s) }, { pid: 9002, exitCode: 1, signalCode: null, kill: () => killed.push('NAO') }]);
    assert.equal(killLiveSpotdlTrees({ platform: 'linux', children: posix }), 1);
    assert.deepEqual(killed, ['SIGKILL']);
    assert.equal(killLiveSpotdlTrees({ children: new Set() }), 0);
});
await test('installSpotdlExitHook: instala uma única vez por processo e o gancho não lança', () => {
    const emitter = new EventEmitter();
    assert.equal(countLiveSpotdlChildren(), 0, 'nenhum filho rastreado: o gancho não matará nada real');
    assert.equal(installSpotdlExitHook(emitter), true);
    assert.equal(installSpotdlExitHook(emitter), false);
    assert.equal(emitter.listenerCount('exit'), 1);
    emitter.emit('exit', 0);
    assert.equal(installSpotdlExitHook(null), false);
    assert.equal(installSpotdlExitHook({}), false);
});
await test('processo filho REAL criado pelo teste: killLiveSpotdlTrees o encerra e ele sai do rastreio', async () => {
    const before = countLiveSpotdlChildren();
    // killLiveSpotdlTrees() age sobre TODO filho rastreado: se algum teste anterior deixou um dublê (PID inventado), falha aqui
    // em vez de rodar `taskkill` contra um PID que não é nosso
    assert.equal(before, 0, 'sobrou filho rastreado de um teste anterior');
    const env = buildSpotdlEnv(path.join(sandbox, 'h'), path.join(sandbox, 'h', 'tmp'), process.env);
    const child = withEnv(execFile, env, trackSpotdlChild)(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { windowsHide: true, timeout: 60000 }, () => {});
    try {
        assert.ok(Number.isInteger(child.pid) && child.pid > 0);
        assert.equal(child.exitCode, null, 'o filho está vivo');
        assert.equal(countLiveSpotdlChildren(), before + 1);
        const exited = new Promise((resolve, reject) => {
            const timer = setTimeout(() => reject(new Error('o filho não encerrou em 15 s')), 15000);
            child.once('exit', () => { clearTimeout(timer); resolve(); });
        });
        assert.ok(killLiveSpotdlTrees() >= 1);
        await exited;
        assert.ok(child.exitCode !== null || child.signalCode !== null);
        assert.equal(countLiveSpotdlChildren(), before);
    } finally {
        if (child.exitCode === null && child.signalCode === null) child.kill(); // só o filho que este teste criou
    }
});

// ---------------------------------------------------------------------------
console.log('Onde está o spotdl');
const ROOT = path.resolve(sandbox, 'proj');
const VENV_EXE = path.join(ROOT, '.venv-spotdl', 'Scripts', 'spotdl.exe');
const existsIn = (list) => (p) => list.includes(p);
await test('resolveSpotdl: SPOTDL_PATH > .venv-spotdl > PATH', () => {
    assert.deepEqual(resolveSpotdl({ env: { SPOTDL_PATH: 'C:/x/spotdl.exe' }, exists: existsIn(['C:/x/spotdl.exe', VENV_EXE]), rootDir: ROOT, isWin: true }), { path: 'C:/x/spotdl.exe', source: 'SPOTDL_PATH' });
    assert.equal(resolveSpotdl({ env: { SPOTDL_PATH: '"C:/x/spotdl.exe"' }, exists: existsIn(['C:/x/spotdl.exe']), rootDir: ROOT, isWin: true }).path, 'C:/x/spotdl.exe');
    const inexistente = resolveSpotdl({ env: { SPOTDL_PATH: 'C:/nao/existe.exe' }, exists: existsIn([VENV_EXE]), rootDir: ROOT, isWin: true });
    assert.equal(inexistente.path, VENV_EXE);
    assert.equal(inexistente.source, 'venv');
    assert.match(inexistente.warning, /SPOTDL_PATH/);
    assert.deepEqual(resolveSpotdl({ env: {}, exists: existsIn([VENV_EXE]), rootDir: ROOT, isWin: true }), { path: VENV_EXE, source: 'venv' });
    assert.deepEqual(resolveSpotdl({ env: {}, exists: () => false, rootDir: ROOT, isWin: true }), { path: 'spotdl', source: 'PATH' });
    assert.equal(resolveSpotdl({ env: { SPOTDL_PATH: 'C:/nao/existe.exe' }, exists: () => false, rootDir: ROOT, isWin: true }).source, 'PATH');
    const linux = path.join(ROOT, '.venv-spotdl', 'bin', 'spotdl');
    assert.equal(getSpotdlPath({ env: {}, exists: existsIn([linux]), rootDir: ROOT, isWin: false }), linux);
    assert.equal(resolveSpotdl({ env: { SPOTDL_PATH: '   ' }, exists: () => false, rootDir: ROOT, isWin: true }).source, 'PATH', 'SPOTDL_PATH em branco é ignorado');
});
await test('resolveSpotdl: SPOTDL_PATH que é um DIRETÓRIO não vale; relativo (nome puro ou com pasta) vira absoluto', () => {
    const dir = path.join(sandbox, 'bins');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'spotdl-teste.exe'), 'x');
    fs.writeFileSync(path.join(sandbox, 'spotdl-puro.exe'), 'x');
    // diretório: nem "existe" para o spotdl, nem ok:true no diagnóstico do boot
    const dirResult = resolveSpotdl({ env: { SPOTDL_PATH: dir }, rootDir: ROOT });
    assert.equal(dirResult.source, 'PATH');
    assert.match(dirResult.warning, /SPOTDL_PATH/);
    const check = checkSpotdl({ env: { SPOTDL_PATH: dir }, rootDir: ROOT });
    assert.equal(check.ok, false);
    assert.equal(check.code, 'SPOTDL_NOT_FOUND');
    // um diretório com o nome do executável também não é o spotdl
    fs.mkdirSync(path.join(sandbox, 'proj2', '.venv-spotdl', 'Scripts', 'spotdl.exe'), { recursive: true });
    assert.equal(resolveSpotdl({ env: {}, rootDir: path.join(sandbox, 'proj2'), isWin: true }).source, 'PATH');
    // relativo (a partir da pasta da Yui = cwd do teste): sempre devolvido ABSOLUTO, porque o spotdl roda com cwd na pasta do pedido
    const comPasta = resolveSpotdl({ env: { SPOTDL_PATH: 'bins/spotdl-teste.exe' }, rootDir: ROOT });
    assert.deepEqual(comPasta, { path: path.resolve('bins', 'spotdl-teste.exe'), source: 'SPOTDL_PATH' });
    assert.ok(path.isAbsolute(comPasta.path));
    const nomePuro = resolveSpotdl({ env: { SPOTDL_PATH: 'spotdl-puro.exe' }, rootDir: ROOT });
    assert.deepEqual(nomePuro, { path: path.resolve('spotdl-puro.exe'), source: 'SPOTDL_PATH' });
    assert.equal(resolveSpotdl({ env: { SPOTDL_PATH: '"spotdl-puro.exe"' }, rootDir: ROOT }).path, path.resolve('spotdl-puro.exe'), 'aspas em volta são ignoradas');
    // relativo que não existe: aviso e cai no venv/PATH
    assert.equal(resolveSpotdl({ env: { SPOTDL_PATH: 'nao/existe.exe' }, rootDir: ROOT }).source, 'PATH');
    // com `exists` injetado, um caminho absoluto sai exatamente como veio
    assert.equal(resolveSpotdl({ env: { SPOTDL_PATH: 'C:\\x\\spotdl.exe' }, exists: existsIn(['C:\\x\\spotdl.exe']), rootDir: ROOT, isWin: true }).path, 'C:\\x\\spotdl.exe');
});
await test('resolveSpotdl com os padrões: devolve um caminho coerente com o disco real e não executa nada', () => {
    const r = resolveSpotdl();
    assert.ok(['SPOTDL_PATH', 'venv', 'PATH'].includes(r.source));
    if (r.source !== 'PATH') assert.ok(fs.existsSync(r.path));
    else assert.equal(r.path, 'spotdl');
});
await test('checkSpotdl: só confere arquivos; devolve { ok, code, message } e nunca lança', () => {
    const ok = checkSpotdl({ env: {}, exists: existsIn([VENV_EXE]), rootDir: ROOT, isWin: true });
    assert.equal(ok.ok, true);
    assert.equal(ok.code, null);
    assert.equal(ok.source, 'venv');
    assert.equal(ok.path, VENV_EXE);
    assert.ok(ok.message.includes('venv'));
    const ausente = checkSpotdl({ env: {}, exists: () => false, rootDir: ROOT, isWin: true });
    assert.equal(ausente.ok, false);
    assert.equal(ausente.code, 'SPOTDL_NOT_FOUND');
    assert.equal(ausente.path, null);
    const noPath = path.join('C:/ferramentas', 'spotdl.exe');
    const viaPath = checkSpotdl({ env: { Path: 'C:/outra;"C:/ferramentas"' }, exists: existsIn([noPath]), rootDir: ROOT, isWin: true });
    assert.equal(viaPath.ok, true);
    assert.equal(viaPath.source, 'PATH');
    assert.equal(viaPath.path, noPath);
    assert.equal(checkSpotdl({ env: { PATH: 'C:/outra' }, exists: () => false, rootDir: ROOT, isWin: true }).ok, false);
    const comAviso = checkSpotdl({ env: { SPOTDL_PATH: 'C:/nao/existe.exe' }, exists: existsIn([VENV_EXE]), rootDir: ROOT, isWin: true });
    assert.equal(comAviso.ok, true);
    assert.match(comAviso.warning, /SPOTDL_PATH/);
    const quebrado = checkSpotdl({ exists: () => { throw new Error('boom\nsegunda linha'); }, rootDir: ROOT, isWin: true });
    assert.equal(quebrado.ok, false);
    assert.equal(quebrado.code, 'CHECK_ERROR');
    assert.equal(quebrado.message, 'boom');
    assert.equal(typeof checkSpotdl().ok, 'boolean');
});

// ---------------------------------------------------------------------------
console.log('Classificação da saída');
const run = (extra = {}) => ({ error: null, stdout: '', stderr: '', timedOut: false, ...extra });
const kindOf = (r, options) => classifySpotdlRun(run(r), options).kind;
// As 16 mensagens reais (tiradas do código instalado) + o caso do título que parece erro.
const VECTORS = [
    ['faixa não achada', 'LookupError: No results found for song: Daft Punk - Get Lucky', 'not_found'],
    ['yt-dlp falhou', 'AudioProviderError: YT-DLP download error - https://music.youtube.com/watch?v=abc123', 'ytdlp_fail'],
    ['yt-dlp falhou + Deno ausente', 'Some YouTube downloads require Deno. Run spotdl --download-deno\nAudioProviderError: YT-DLP download error - https://music.youtube.com/watch?v=abc', 'ytdlp_fail'],
    ['YouTube Music bloqueado', 'You might be blocked by YouTube Music. If downloads fail...\nLookupError: No results found for song: A - B', 'blocked_ytm'],
    ['ffmpeg falhou', 'FFmpegError: Failed to convert A - B, you can find error here: C:/x/errors/ffmpeg_error.txt', 'ffmpeg_fail'],
    ['sem ffmpeg', 'FFmpegError: FFmpeg is not installed. Please run `spotdl --download-ffmpeg`', 'ffmpeg_env'],
    ['metadados (se o mp3 existe é sucesso)', 'MetadataError: Failed to embed metadata to the song', 'unknown'],
    ['Spotify fora (traceback)', 'An error occurred Traceback spotapi/client.py BaseClientError: Could not get session auth tokens', 'spotify_down'],
    ['Spotify: song info', 'SongError: Could not get song info', 'spotify_down'],
    ['Spotify: reinicialização', 'Error occurred while reinitializing song: Could not get song info', 'spotify_down'],
    ['faixa removida', 'SongError: Track no longer exists: https://open.spotify.com/track/xyz', 'gone'],
    ['sem rede (spotapi)', 'RequestError: Failed to complete request.', 'spotify_down'],
    ['sem rede (ytmusicapi)', 'requests.exceptions.ConnectionError: HTTPSConnectionPool(host=music.youtube.com): Max retries exceeded', 'no_network'],
    ['launcher do pip quebrado', 'Fatal error in launcher: Unable to create process', 'broken'],
    ['Python base removido', 'No Python at \'"C:/Users/mauri/Py312/python.exe"\'', 'broken'],
    ['bot check (só aparece em DEBUG)', "ERROR: [youtube] abc: Sign in to confirm you're not a bot", 'unknown'],
    ['faixa chamada "Too Many Requests"', 'LookupError: No results found for song: Band - Too Many Requests', 'not_found'],
    ['saída 0 sem texto', '', 'unknown'],
];
for (const [name, text, expected] of VECTORS) {
    await test(`classifica: ${name} => ${expected}`, () => {
        assert.equal(kindOf({ stdout: text }), expected);
        assert.equal(kindOf({ stderr: text }), expected, 'stdout e stderr valem igual');
    });
}
await test('classifica: tipos pelo erro do processo (ENOENT, timeout, EACCES/EPERM/UNKNOWN) antes de qualquer texto', () => {
    assert.equal(kindOf({ error: ENOENT, stdout: 'LookupError: No results found for song: X' }), 'missing');
    assert.equal(kindOf({ error: new Error('x'), timedOut: true, stdout: 'Could not get session' }), 'timeout');
    for (const code of ['EACCES', 'EPERM', 'UNKNOWN']) assert.equal(kindOf({ error: execError(code) }), 'broken', code);
    assert.equal(kindOf({ error: execError(1), stderr: 'ModuleNotFoundError: No module named spotdl' }), 'broken');
    assert.equal(kindOf({ error: execError(1), stderr: 'ImportError: x' }), 'broken');
    assert.equal(kindOf({ error: execError(1), stderr: 'SyntaxError: x' }), 'broken');
});
await test('classifica: título vindo do Spotify nunca vira erro (o trecho depois de "for song:" é apagado)', () => {
    for (const titulo of ['Too Many Requests', 'Could not get session', 'ConnectionError', 'You might be blocked by YouTube Music', 'FFmpeg is not installed', 'Fatal error in launcher', 'Track no longer exists']) {
        const texto = `LookupError: No results found for song: Banda - ${titulo}`;
        assert.equal(kindOf({ stdout: texto }), 'not_found', titulo);
        assert.equal(kindOf({ stdout: texto }, { debug: true }), 'not_found', `${titulo} (DEBUG)`);
    }
    // outras mensagens que carregam o título: a conversão, os resultados do YouTube Music, exceções por faixa
    assert.equal(kindOf({ stdout: 'FFmpegError: Failed to convert Banda - ConnectionError, you can find error here: C:/x/a.txt' }), 'ffmpeg_fail');
    assert.equal(kindOf({ stdout: 'YouTube Music returned no usable results for Banda - Could not get session after 3 attempts\nLookupError: No results found for song: Banda - Could not get session' }), 'not_found');
    assert.equal(kindOf({ stdout: 'Banda - Max retries exceeded generated an exception: LookupError: No results found for song: Banda - Max retries exceeded' }), 'not_found');
    assert.equal(kindOf({ stdout: 'Skipping explicit song: Banda - Too Many Requests' }), 'unknown');
    // quebra de linha do rich no meio do trecho
    assert.equal(kindOf({ stdout: 'ERROR LookupError: No results found\nfor song: Artista - Faixa' }), 'not_found');
    assert.equal(kindOf({ stdout: 'ERROR Could not get\n   song info' }), 'spotify_down');
    // ANSI e caixa
    assert.equal(kindOf({ stdout: '\u001b[31mLOOKUPERROR\u001b[0m: NO RESULTS FOUND FOR SONG: A - B' }), 'not_found');
});
await test('classifica: outras mensagens do spotdl que embutem o título ("metadata for:", "missing required fields:", aspas, DEBUG) também são apagadas', () => {
    for (const titulo of ['Could not get session', 'No module named x', 'Too Many Requests', 'ConnectionError', 'FFmpeg is not installed']) {
        // DownloaderError de downloader.py: "yt-dlp failed to get metadata for: {nome} - {artista}"
        assert.equal(kindOf({ stdout: `DownloaderError: yt-dlp failed to get metadata for: ${titulo} - Banda` }), 'ytdlp_fail', titulo);
        assert.equal(kindOf({ stdout: `Song is missing required fields: Banda - ${titulo}` }), 'unknown', titulo);
    }
    const ruidoso = ['Too Many Requests', 'Could not get session', 'Sign in to confirm you’re not a bot'];
    for (const titulo of ruidoso) {
        // INFO/DEBUG: o título pode ter aspas e vem no meio ou no fim da linha
        assert.equal(kindOf({ stdout: `Downloaded "Banda - Faixa "${titulo}" Ao Vivo": https://open.spotify.com/track/abc` }, { debug: true }), 'unknown', titulo);
        assert.equal(kindOf({ stdout: `Downloading Banda - ${titulo} using https://music.youtube.com/watch?v=abc` }, { debug: true }), 'unknown', titulo);
        assert.equal(kindOf({ stdout: `YouTube Music failed to find Banda - ${titulo}` }, { debug: true }), 'unknown', titulo);
        assert.equal(kindOf({ stdout: `No download info found for Banda - ${titulo}, url: https://x` }, { debug: true }), 'unknown', titulo);
    }
    // título longo que o `rich` quebrou: a continuação (indentada em DEBUG) pertence à mensagem anterior
    const quebrado = 'ERROR LookupError: No results found for song: Artista A, Artista B - Titulo muito longo da faixa\n                  Could not get session auth tokens';
    assert.equal(kindOf({ stdout: quebrado }, { debug: true }), 'not_found');
    assert.equal(kindOf({ stdout: 'ERROR DownloaderError: yt-dlp failed to get metadata for: Banda - Faixa\n    No module named x' }, { debug: true }), 'ytdlp_fail');
    // mas uma mensagem de verdade em OUTRA linha (sem indentação) continua valendo
    assert.equal(kindOf({ stdout: 'LookupError: No results found for song: Banda - Faixa\nCould not get session auth tokens' }), 'spotify_down');
});
await test('classifica: ANSI no meio de uma frase não esconde o erro; EINVAL (.cmd em SPOTDL_PATH) é ambiente quebrado com dica', () => {
    assert.equal(kindOf({ stdout: 'Could not \u001b[1mget session\u001b[0m auth tokens' }), 'spotify_down');
    assert.equal(kindOf({ stdout: 'You might be \u001b[33mblocked by YouTube\u001b[0m Music' }), 'blocked_ytm');
    const verdict = classifySpotdlRun(run({ error: execError('EINVAL') }));
    assert.equal(verdict.kind, 'broken');
    assert.match(verdict.hint, /SPOTDL_PATH/);
    assert.match(verdict.hint, /\.venv-spotdl/);
    assert.equal(spotdlFailureToMediaError(verdict).code, 'SPOTIFY_UNAVAILABLE');
});
await test('classifica: o motivo do yt-dlp só conta com DEBUG (e fica atrás de not_found)', () => {
    const botCheck = "ERROR: [youtube] abc: Sign in to confirm you're not a bot\nAudioProviderError: YT-DLP download error - https://x";
    assert.equal(kindOf({ stdout: botCheck }), 'ytdlp_fail', 'sem DEBUG o texto do bot check não é consultado');
    assert.equal(kindOf({ stdout: botCheck }, { debug: true }), 'blocked');
    assert.equal(kindOf({ stdout: 'ERROR: HTTP Error 429: Too Many Requests' }, { debug: true }), 'blocked');
    assert.equal(kindOf({ stdout: 'ERROR: HTTP Error 429: Too Many Requests' }), 'unknown');
    assert.equal(kindOf({ stdout: 'ERROR: [youtube] abc: Video unavailable. This video is private\nYT-DLP download error' }, { debug: true }), 'private');
    assert.equal(kindOf({ stdout: 'ERROR: Sign in to confirm your age. This video may be inappropriate for some users.' }, { debug: true }), 'private');
    assert.equal(kindOf({ stdout: 'ERROR: This video may be age-restricted' }, { debug: true }), 'private');
    assert.equal(kindOf({ stdout: "ERROR: Sign in to confirm you’re not a bot" }, { debug: true }), 'blocked');
    assert.equal(kindOf({ stdout: 'ERROR: Video unavailable' }), 'unknown');
    assert.equal(kindOf({ stdout: 'Could not get session auth tokens\nSign in to confirm you are not a bot' }, { debug: true }), 'spotify_down', 'o lado Spotify vem antes');
});
await test('classifica: dicas fixas para o operador (venv quebrado, ffmpeg, Deno, DEBUG) e exitFailed', () => {
    assert.match(classifySpotdlRun(run({ stdout: 'Fatal error in launcher' })).hint, /\.venv-spotdl/);
    assert.match(classifySpotdlRun(run({ stdout: 'FFmpeg is not installed' })).hint, /ffmpeg/i);
    const ytdlp = classifySpotdlRun(run({ stdout: 'YT-DLP download error - x' }));
    assert.match(ytdlp.hint, /DEBUG/);
    assert.ok(!ytdlp.hint.includes('Deno'));
    assert.match(classifySpotdlRun(run({ stdout: 'Some YouTube downloads require Deno\nYT-DLP download error - x' })).hint, /Deno/);
    assert.equal(classifySpotdlRun(run({ stdout: 'LookupError: No results found for song: A' })).hint, '');
    assert.equal(classifySpotdlRun(run()).exitFailed, false);
    assert.equal(classifySpotdlRun(run({ error: execError(1) })).exitFailed, true);
    for (const kind of ['broken', 'ffmpeg_env', 'spotify_down', 'no_network', 'blocked_ytm', 'ytdlp_fail']) {
        // nenhuma dica contém chave=valor (o log do operador não pode ter o formato de segredo)
        const sample = { broken: 'Fatal error in launcher', ffmpeg_env: 'FFmpeg is not installed', spotify_down: 'Could not get session', no_network: 'ConnectionError', blocked_ytm: 'You might be blocked by YouTube Music', ytdlp_fail: 'YT-DLP download error' }[kind];
        const verdict = classifySpotdlRun(run({ stdout: sample }));
        assert.equal(verdict.kind, kind);
        assert.ok(verdict.hint && !verdict.hint.includes('='), kind);
    }
});

// ---------------------------------------------------------------------------
console.log('Resumo seguro e erros amigáveis');
await test('resumo seguro: sem URL assinada, caminho, IP, chave=valor nem ANSI; no máximo 200 caracteres', () => {
    const cru = [
        '\u001b[31mERROR\u001b[0m   DownloaderError: yt-dlp failed to get metadata for: A - B',
        'ERROR: unable to download https://rr3---sn-x.googlevideo.com/videoplayback?expire=1&ip=200.1.2.3&sig=SEGREDO&lsig=OUTRO&id=abc',
        'ERROR cookies em C:/Users/Mauro Braga/segredo/cookies.txt token=XYZ123 de 200.1.2.3',
    ].join('\n');
    const r = summarizeToolOutput(cru);
    assert.ok(r.length > 0 && r.length <= 200);
    for (const proibido of ['googlevideo', 'SEGREDO', 'OUTRO', '200.1.2.3', 'C:/Users', 'Mauro', 'Braga', 'XYZ123', '\u001b', 'cookies.txt']) {
        assert.ok(!r.includes(proibido), `${proibido} em: ${r}`);
    }
    assert.ok(!/=/.test(r), 'sem chave=valor');
    assert.ok(!/https?:/i.test(r));
    const outra = summarizeToolOutput('ERROR no /home/mauro/projeto/arquivo falhou com key=abc e sig=def https://a.b/c?d=e');
    for (const proibido of ['/home/mauro', 'abc', 'def', 'a.b/c']) assert.ok(!outra.includes(proibido), `${proibido} em: ${outra}`);
    assert.equal(summarizeToolOutput(''), '');
    assert.equal(summarizeToolOutput(null), '');
    assert.equal(summarizeToolOutput('x'.repeat(5000)).length, 200);
    assert.equal(summarizeToolOutput('linha 1\nlinha 2'), 'linha 2');
});
await test('resumo seguro: sem OSC, controles nem bidi; sem Bearer/Authorization/JSON de token; sem caminho UNC ou relativo; IP vira <ip>', () => {
    const controles = summarizeToolOutput('\u001b]0;titulo falso\u0007ERROR \u0007bell \u0008\u0008 \u202egnp.exe \u0000nul \u001b solto \u009b x \u2066y');
    assert.ok(controles.startsWith('ERROR'), controles);
    assert.ok(!/[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(controles), JSON.stringify(controles));
    assert.ok(!controles.includes('titulo falso'), 'o título do terminal (OSC) some inteiro');
    assert.ok(!summarizeToolOutput('ERROR \u001b]8;;https://evil.example/\u001b\\clique\u001b]8;;\u001b\\ aqui').includes('evil.example'), 'hiperlink OSC 8');
    for (const [linha, segredo] of [
        ['ERROR request failed Bearer ya29.SEGREDO123 foi recusado', 'SEGREDO123'],
        ['ERROR response {"accessToken":"SEGREDO456","other":1}', 'SEGREDO456'],
        ['ERROR resposta {"client_secret": "SEGREDO789"}', 'SEGREDO789'],
        ['ERROR failed Authorization: Basic c2VncmVkbw==', 'c2VncmVkbw'],
        ['ERROR failed Cookie: sp_dc=SEGREDOCOOKIE; outro=x', 'SEGREDOCOOKIE'],
        ['ERROR cannot open \\\\servidor\\share\\pasta\\x.mp3', 'servidor'],
        ['ERROR cannot reach \\\\servidor\\compartilhamento', 'servidor'], // só a regra de UNC pega (não há 2 pastas)
        ['ERROR cannot open ..\\rel\\segredo.txt', 'segredo'],
        ['ERROR cannot open src\\data\\segredo\\x.txt', 'segredo'],
        ['ERROR cannot open ./segredo/x.txt', 'segredo'],
        ['ERROR connect to 200.1.2.3 failed', '200.1.2.3'],
    ]) {
        const r = summarizeToolOutput(linha);
        assert.ok(r.startsWith('ERROR'), r);
        assert.ok(!r.includes(segredo), `${segredo} em: ${r}`);
    }
    assert.match(summarizeToolOutput('ERROR connect to 200.1.2.3 failed'), /<ip>/);
    // texto comum continua legível
    assert.equal(summarizeToolOutput('LookupError: No results found for song: Banda - Faixa'), 'LookupError: No results found for song: Banda - Faixa');
});
await test('resumo seguro: nunca lança (linha gigante com cara de caminho) e não corta um par substituto ao meio', () => {
    const gigante = `error C:/${'a/'.repeat(3 * 1024 * 1024)}`; // ~6 MB numa linha só: estourava a pilha da expressão regular (RangeError)
    const t0 = Date.now();
    const resumo = summarizeToolOutput(gigante);
    assert.ok(typeof resumo === 'string' && resumo.length > 0 && resumo.length <= 200, 'um resumo foi produzido (não o vazio do try/catch)');
    const verdict = classifySpotdlRun(run({ error: execError(1), stdout: gigante }));
    assert.equal(verdict.kind, 'unknown');
    assert.ok(verdict.detail.length <= 200);
    assert.ok(Date.now() - t0 < 5000, `levou ${Date.now() - t0} ms`);
    assert.equal(summarizeToolOutput(`${'x'.repeat(4 * 1024 * 1024)}\nlinha final`), 'linha final', 'só o fim da saída é lido');
    // 🎵 ocupa dois code units: o corte em 200 não pode deixar só a metade
    const musica = summarizeToolOutput(`error ${'x'.repeat(193)}\u{1F3B5}\u{1F3B5}`);
    assert.ok(!/[\ud800-\udbff]$/.test(musica), 'termina com meio par substituto');
    assert.ok(musica.length <= 200);
    assert.equal(summarizeToolOutput(`error ${'x'.repeat(192)}\u{1F3B5}`).length, 200, 'o par inteiro cabe e fica');
});
await test('MediaError: cada tipo vira um código estável e uma frase amigável (sem detalhe técnico)', () => {
    const table = [
        [{ kind: 'timeout', exitFailed: true }, 'DOWNLOAD_TIMEOUT'],
        [{ kind: 'missing', exitFailed: true }, 'SPOTIFY_UNAVAILABLE'],
        [{ kind: 'broken', exitFailed: true }, 'SPOTIFY_UNAVAILABLE'],
        [{ kind: 'gone', exitFailed: true }, 'SPOTIFY_PRIVATE'],
        [{ kind: 'private', exitFailed: true }, 'SPOTIFY_PRIVATE'],
        [{ kind: 'spotify_down', exitFailed: true }, 'SPOTIFY_BLOCKED'],
        [{ kind: 'no_network', exitFailed: true }, 'SPOTIFY_BLOCKED'],
        [{ kind: 'blocked_ytm', exitFailed: false }, 'SPOTIFY_BLOCKED'],
        [{ kind: 'blocked', exitFailed: false }, 'SPOTIFY_BLOCKED'],
        [{ kind: 'not_found', exitFailed: false }, 'SPOTIFY_NOT_FOUND'],
        [{ kind: 'ytdlp_fail', exitFailed: false }, 'SPOTIFY_ERROR'],
        [{ kind: 'ffmpeg_fail', exitFailed: false }, 'SPOTIFY_ERROR'],
        [{ kind: 'ffmpeg_env', exitFailed: true }, 'SPOTIFY_ERROR'],
        [{ kind: 'unknown', exitFailed: true }, 'SPOTIFY_ERROR'],
        [{ kind: 'unknown', exitFailed: false }, 'SPOTIFY_NO_FILE'],
    ];
    for (const [verdict, code] of table) {
        const error = spotdlFailureToMediaError({ ...verdict, detail: 'detalhe' }, new Error('causa'));
        assert.ok(error instanceof MediaError);
        assert.equal(error.code, code, `${verdict.kind}/${verdict.exitFailed}`);
        assert.equal(error.detail, 'detalhe');
        assert.ok(error.cause);
        assert.ok(!/ENOENT|Traceback|https?:|Command failed|spawn|C:\\/.test(error.userMessage), error.userMessage);
    }
});
await test('mensagens novas (SPOTIFY_NOT_FOUND, SPOTIFY_BLOCKED, SPOTIFY_BUSY) sugerem /baixar_musica busca: sem citar o serviço de busca', () => {
    for (const key of ['NOT_FOUND', 'BLOCKED', 'BUSY']) {
        assert.match(SPOTDL_MESSAGES[key], /\/baixar_musica busca:/, key);
        assert.doesNotMatch(SPOTDL_MESSAGES[key], /Deezer/i, key);
        assert.ok(SPOTDL_MESSAGES[key].length < 400);
    }
    assert.ok(Object.isFrozen(SPOTDL_MESSAGES));
    assert.equal(spotdlFailureToMediaError({ kind: 'not_found', detail: '' }).userMessage, SPOTDL_MESSAGES.NOT_FOUND);
    assert.equal(spotdlFailureToMediaError({ kind: 'spotify_down', detail: '' }).userMessage, SPOTDL_MESSAGES.BLOCKED);
});

await test('TG-21: nenhuma mensagem de erro do spotdl entregue ao usuário cita ferramentas nem de onde vem o áudio (só o link do Spotify pode ser nomeado)', () => {
    // serviços e ferramentas que o usuário nunca vê: Deezer, YouTube, yt-dlp, spotdl, spot-dlp, deemix (o link do Spotify é dele)
    const hidden = /deezer|youtube|youtu\.be|yt-?dlp|spot-?dlp|spotdl|deemix/i;
    for (const [key, text] of Object.entries(SPOTDL_MESSAGES)) assert.doesNotMatch(text, hidden, key);
    const kinds = ['timeout', 'missing', 'broken', 'gone', 'private', 'spotify_down', 'no_network', 'blocked_ytm', 'blocked',
        'not_found', 'unknown', 'ytdlp_fail', 'ffmpeg_fail', 'ffmpeg_env'];
    for (const kind of kinds) {
        for (const exitFailed of [true, false]) {
            const error = spotdlFailureToMediaError({ kind, detail: 'detalhe tecnico', exitFailed }, new Error('x'));
            assert.doesNotMatch(error.userMessage, hidden, `${kind}/${exitFailed}: ${error.userMessage}`);
        }
    }
});

// ---------------------------------------------------------------------------
console.log('Porteiro global');
await test('porteiro: 2 rodam, 3 esperam, o 6º recebe SPOTIFY_BUSY; liberar chama o próximo da fila', async () => {
    const gate = createSpotdlGate({ maxParallel: 2, maxWaiting: 3, maxWaitMs: 60000 });
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    assert.deepEqual(gate.stats(), { running: 2, waiting: 0, maxParallel: 2, maxWaiting: 3 });
    const order = [];
    const w3 = gate.acquire().then((release) => { order.push(3); return release; });
    const w4 = gate.acquire().then((release) => { order.push(4); return release; });
    const w5 = gate.acquire().then((release) => { order.push(5); return release; });
    assert.equal(gate.stats().waiting, 3);
    await assert.rejects(() => gate.acquire(), (err) => err instanceof MediaError && err.code === 'SPOTIFY_BUSY' && /busca:/.test(err.userMessage));
    assert.equal(gate.stats().waiting, 3, 'o rejeitado não entra na fila');
    r1();
    const rel3 = await w3;
    assert.deepEqual(order, [3]);
    assert.deepEqual({ running: gate.stats().running, waiting: gate.stats().waiting }, { running: 2, waiting: 2 });
    r1(); // liberar duas vezes não libera outra vaga
    assert.equal(gate.stats().running, 2);
    r2();
    const rel4 = await w4;
    rel3();
    const rel5 = await w5;
    assert.deepEqual(order, [3, 4, 5], 'ordem de chegada');
    rel4(); rel5();
    assert.deepEqual(gate.stats(), { running: 0, waiting: 0, maxParallel: 2, maxWaiting: 3 });
});
await test('porteiro: quem espera demais recebe SPOTIFY_BUSY e sai da fila', async () => {
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 2, maxWaitMs: 40 });
    const hold = await gate.acquire();
    await assert.rejects(() => gate.acquire(), (err) => err.code === 'SPOTIFY_BUSY');
    assert.equal(gate.stats().waiting, 0);
    hold();
    const again = await gate.acquire();
    again();
    assert.equal(gate.stats().running, 0);
});
await test('porteiro: quem sai da fila servido tem o timer de espera limpo (não segura o processo por até 180 s)', async () => {
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 1, maxWaitMs: 123_456 });
    const hold = await gate.acquire();
    const realSet = globalThis.setTimeout;
    const realClear = globalThis.clearTimeout;
    const created = [];
    const cleared = [];
    globalThis.setTimeout = (fn, ms, ...rest) => { const handle = realSet(fn, ms, ...rest); created.push({ handle, ms }); return handle; };
    globalThis.clearTimeout = (handle) => { cleared.push(handle); return realClear(handle); };
    let release;
    try {
        const waiter = gate.acquire();
        hold();
        release = await waiter;
    } finally {
        globalThis.setTimeout = realSet;
        globalThis.clearTimeout = realClear;
    }
    const timer = created.find((c) => c.ms === 123_456);
    assert.ok(timer, 'o pedido na fila criou o timer de espera');
    assert.ok(cleared.includes(timer.handle), 'e ele foi limpo quando a vaga chegou');
    release();
    assert.equal(gate.stats().running, 0);
});
await test('porteiro: sem fila (maxWaiting 0) recusa na hora; o do processo é único e respeita o ambiente', async () => {
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 0 });
    const hold = await gate.acquire();
    await assert.rejects(() => gate.acquire(), (err) => err.code === 'SPOTIFY_BUSY');
    hold();
    assert.equal(getSpotdlGate(), getSpotdlGate());
    assert.equal(typeof getSpotdlGate().acquire, 'function');
    assert.equal(getSpotdlGate().stats().maxWaiting, 3);
    assert.equal(createSpotdlGate({ maxParallel: readSpotdlMaxParallel({ YUI_SPOTDL_MAX_PARALLEL: '1' }) }).stats().maxParallel, 1);
});

// ---------------------------------------------------------------------------
console.log('Disjuntor');
await test('disjuntor: 3 falhas seguidas do Spotify/rede abrem por 5 minutos e fecham depois do prazo', () => {
    let t = 1_000_000;
    const breaker = createSpotdlBreaker({ now: () => t });
    assert.deepEqual([...SPOTDL_BREAKER_KINDS], ['spotify_down', 'no_network', 'blocked_ytm']);
    assert.equal(breaker.record('spotify_down'), false);
    assert.equal(breaker.record('no_network'), false);
    breaker.assertClosed();
    assert.equal(breaker.record('blocked_ytm'), true, 'a terceira abre');
    assert.equal(breaker.isOpen(), true);
    assert.throws(() => breaker.assertClosed(), (err) => err instanceof MediaError && err.code === 'SPOTIFY_BLOCKED' && /busca:/.test(err.userMessage));
    assert.equal(breaker.state().retryInMs, 5 * 60 * 1000);
    t += 5 * 60 * 1000 - 1;
    assert.equal(breaker.isOpen(), true, 'ainda aberto 1 ms antes do prazo');
    t += 1;
    assert.equal(breaker.isOpen(), false, 'fecha no prazo');
    breaker.assertClosed();
    assert.equal(breaker.state().failures, 0, 'a contagem recomeça do zero');
    assert.equal(breaker.record('spotify_down'), false);
});
await test('disjuntor: um sucesso (ou resultado que prova que o Spotify respondeu) zera a contagem; falhas locais não contam nem zeram', () => {
    const breaker = createSpotdlBreaker({ now: () => 0 });
    breaker.record('spotify_down'); breaker.record('spotify_down');
    breaker.record('ok');
    breaker.record('spotify_down'); breaker.record('spotify_down');
    assert.equal(breaker.isOpen(), false, 'sucesso zerou');
    breaker.record('ok');
    for (const respondeu of ['not_found', 'gone', 'ytdlp_fail', 'ffmpeg_fail']) {
        breaker.record('spotify_down'); breaker.record('spotify_down');
        breaker.record(respondeu);
        assert.equal(breaker.state().failures, 0, respondeu);
    }
    breaker.record('spotify_down'); breaker.record('spotify_down');
    for (const neutro of ['timeout', 'missing', 'broken', 'ffmpeg_env', 'unknown', 'blocked', 'private']) breaker.record(neutro);
    assert.equal(breaker.state().failures, 2, 'neutros não contam nem zeram');
    assert.equal(breaker.record('no_network'), true, 'a terceira falha de verdade abre');
    const outro = createSpotdlBreaker({ now: () => 0 });
    for (let i = 0; i < 10; i++) outro.record('blocked'); // bot check do YouTube (só DEBUG): não é o lado Spotify
    assert.equal(outro.isOpen(), false);
    assert.equal(getSpotdlBreaker(), getSpotdlBreaker());
    assert.equal(createSpotdlBreaker({ threshold: 1, openMs: 10, now: () => 0 }).record('spotify_down'), true);
});

// ---------------------------------------------------------------------------
console.log('Handler com execFile falso (sem spotdl real, sem rede)');
const sp = await import('../src/handlers/spotifyDownloadHandler.js');
const { logger } = await import('../src/utils/logger.js');
const ctx = { source: 'Slash', userId: '1', userTag: 'tester' };

function captureLogs() {
    const lines = [];
    const levels = ['info', 'warn', 'error', 'debug'];
    for (const level of levels) logger[level] = (message) => { lines.push({ level, text: String(message) }); return logger; };
    return {
        lines,
        text: () => lines.map((l) => `${l.level}: ${l.text}`).join('\n'),
        restore() { for (const level of levels) delete logger[level]; },
    };
}
function makeExec(behavior) {
    const calls = [];
    const fn = (file, args, options, cb) => {
        calls.push({ file, args, options });
        const result = behavior({ file, args, options, call: calls.length }) || {};
        setImmediate(() => cb(result.error || null, result.stdout || '', result.stderr || ''));
        return { pid: 4242, kill() {} };
    };
    fn.calls = calls;
    return fn;
}
function writeMp3(dir, name = 'Artista - Faixa.mp3', size = 32) {
    fs.writeFileSync(path.join(dir, name), Buffer.alloc(size, 1));
}
function handlerDeps(execFileImpl, extra = {}) {
    const tempRoot = fs.mkdtempSync(path.join(sandbox, 'root-'));
    return {
        tempRoot,
        deps: {
            execFileImpl,
            tempRoot,
            spotdlPath: 'spotdl',
            ytdlpPath: 'yt-dlp-falso',
            ffmpegPath: FFMPEG_FILE,
            cookiesPath: '',
            extraFlags: ['--ignore-config'],
            limits: { maxMinutes: 20, maxFilesizeMB: 200, timeoutMs: 5000 },
            killImpl: () => { throw new Error('não deveria matar nada neste teste'); },
            baseEnv: {
                ...SECRETS, Path: 'C:/bin', SystemRoot: 'C:/Windows', USERPROFILE: 'C:/Users/real', HOME: 'C:/Users/real', TEMP: 'C:/Users/real/Temp',
            },
            spotdlGate: createSpotdlGate({ maxParallel: 2, maxWaiting: 3 }),
            spotdlBreaker: createSpotdlBreaker(),
            ...extra,
        },
    };
}
const downloadOk = async (url, deps) => sp.downloadSpotify(url, ctx, deps);
const rejectsWith = async (promise, code) => {
    let error = null;
    try { await promise; } catch (err) { error = err; }
    assert.ok(error, 'deveria rejeitar');
    assert.ok(error instanceof MediaError, `não é MediaError: ${error && error.message}`);
    assert.equal(error.code, code, `${error.code}: ${error.userMessage}`);
    return error;
};
const NO_LEAK = /ENOENT|Traceback|https?:|Command failed|spawn|segredo|C:\\|C:\//;

await test('sucesso: argv da lista fixa, ambiente mínimo, home isolado na pasta do pedido (R1) e cleanup apaga tudo', async () => {
    const seen = {};
    const exec = makeExec(({ args, options }) => {
        seen.cwd = options.cwd;
        seen.homeAntes = fs.readdirSync(path.join(options.cwd, '_home'));
        writeMp3(args[args.indexOf('--output') + 1]);
    });
    const { tempRoot, deps } = handlerDeps(exec);
    const result = await downloadOk(`https://open.spotify.com/intl-pt/track/${SP}?si=abc`, deps);
    const call = exec.calls[0];
    assert.equal(call.file, 'spotdl');
    assert.equal(call.args[0], 'download');
    assert.equal(call.args[1], URL_OK, 'só a URL canônica chega ao spotdl');
    assert.deepEqual(call.args.filter((a) => a.startsWith('-')), FULL_ORDER);
    assert.equal(call.args[call.args.indexOf('--ffmpeg') + 1], FFMPEG_FILE);
    assert.equal(call.args[call.args.indexOf('--bitrate') + 1], '192k');
    assert.equal(call.args[call.args.indexOf('--log-level') + 1], 'WARNING');
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 10 * 1024 * 1024);
    // R1: o home do spotdl nasce na pasta do pedido e VAZIO (o config.json do spotdl nunca vem de fora)
    assert.equal(path.dirname(seen.cwd), tempRoot);
    assert.equal(call.args[call.args.indexOf('--output') + 1], seen.cwd);
    assert.deepEqual(seen.homeAntes, ['tmp']);
    const env = call.options.env;
    for (const key of ['USERPROFILE', 'HOME', 'TEMP', 'TMP', 'TMPDIR']) {
        assert.ok(env[key].startsWith(seen.cwd + path.sep), `${key} fora da pasta do pedido: ${env[key]}`);
    }
    assert.equal(env.USERPROFILE, path.join(seen.cwd, '_home'));
    assert.equal(env.COLUMNS, '300');
    const texto = JSON.stringify(env);
    for (const proibido of [...Object.values(SECRETS), 'C:/Users/real']) assert.ok(!texto.includes(proibido), `vazou ${proibido}`);
    assert.equal(result.metadata.provider, 'spot-dlp');
    assert.equal(result.metadata.title, 'Artista - Faixa');
    assert.equal(path.dirname(path.dirname(result.filePath)), tempRoot);
    assert.equal(exec.calls.length, 1);
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'a pasta do pedido (com a _home) foi apagada');
});
await test('bitrate e nível de log vêm do ambiente; valor inválido volta ao padrão', async () => {
    for (const [env, bitrate, level] of [
        [{ YUI_SPOTDL_BITRATE: '192k', YUI_SPOTDL_LOG_LEVEL: 'info' }, '192k', 'INFO'],
        [{ YUI_SPOTDL_BITRATE: '128K', YUI_SPOTDL_LOG_LEVEL: 'DEBUG' }, '128k', 'DEBUG'],
        [{ YUI_SPOTDL_BITRATE: 'abc', YUI_SPOTDL_LOG_LEVEL: 'trace' }, '192k', 'WARNING'],
        [{ YUI_SPOTDL_BITRATE: '320k --x', YUI_SPOTDL_LOG_LEVEL: 'INFO --x' }, '192k', 'WARNING'],
    ]) {
        const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
        const { deps, tempRoot } = handlerDeps(exec);
        deps.baseEnv = { ...deps.baseEnv, ...env };
        const result = await downloadOk(URL_OK, deps);
        const args = exec.calls[0].args;
        assert.equal(args[args.indexOf('--bitrate') + 1], bitrate, JSON.stringify(env));
        assert.equal(args[args.indexOf('--log-level') + 1], level, JSON.stringify(env));
        assert.deepEqual(args.filter((a) => a.startsWith('-')), FULL_ORDER);
        result.cleanup();
        assert.deepEqual(fs.readdirSync(tempRoot), []);
    }
});
await test('SPOTDL_PATH do ambiente é usado quando não há spotdlPath injetado (e o caminho vira absoluto)', async () => {
    const fake = path.join(sandbox, 'bin', 'spotdl-do-env.exe');
    fs.mkdirSync(path.dirname(fake), { recursive: true });
    fs.writeFileSync(fake, 'x');
    const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
    const { deps, tempRoot } = handlerDeps(exec);
    delete deps.spotdlPath;
    deps.baseEnv = { ...deps.baseEnv, SPOTDL_PATH: fake };
    const result = await downloadOk(URL_OK, deps);
    assert.equal(exec.calls[0].file, fake);
    assert.ok(path.isAbsolute(exec.calls[0].file));
    assert.ok(!Object.keys(exec.calls[0].options.env).includes('SPOTDL_PATH'), 'a variável não é repassada ao filho');
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});
await test('R1: mais de um mp3 na pasta do pedido é anomalia: SPOTIFY_ERROR, apaga tudo e registra', async () => {
    const logs = captureLogs();
    try {
        const exec = makeExec(({ args }) => {
            const dir = args[args.indexOf('--output') + 1];
            writeMp3(dir, 'Artista - Faixa 1.mp3');
            writeMp3(dir, 'Artista - Faixa 2.MP3');
        });
        const { deps, tempRoot } = handlerDeps(exec);
        const error = await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_ERROR');
        assert.ok(!NO_LEAK.test(error.userMessage));
        assert.match(error.detail, /R1/);
        assert.deepEqual(fs.readdirSync(tempRoot), [], 'nada foi entregue e nada sobrou');
        assert.match(logs.text(), /error: \[SpotifyHandler\] R1: o spotdl gerou 2 arquivos mp3/);
        assert.equal(deps.spotdlBreaker.state().failures, 0, 'a anomalia não é falha do Spotify');
    } finally {
        logs.restore();
    }
});
await test('arquivo mp3 dentro da _home (temporário do spotdl) não conta como entrega nem como anomalia', async () => {
    const exec = makeExec(({ args, options }) => {
        const dir = args[args.indexOf('--output') + 1];
        fs.mkdirSync(path.join(options.cwd, '_home', '.spotdl', 'temp'), { recursive: true });
        writeMp3(path.join(options.cwd, '_home', '.spotdl', 'temp'), 'resto.mp3');
        writeMp3(dir);
    });
    const { deps, tempRoot } = handlerDeps(exec);
    const result = await downloadOk(URL_OK, deps);
    assert.equal(path.basename(result.filePath), 'Artista - Faixa.mp3');
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});
await test('mp3 parcial com erro de saída não é entregue: classifica pelo texto e limpa a pasta', async () => {
    const exec = makeExec(({ args }) => {
        writeMp3(args[args.indexOf('--output') + 1]);
        return { error: execError(1), stdout: 'qualquer coisa' };
    });
    const { deps, tempRoot } = handlerDeps(exec);
    await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_ERROR');
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});
await test('arquivo acima do limite de tamanho vira FILE_TOO_LARGE e a pasta é limpa', async () => {
    const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1], 'Grande.mp3', 2 * 1024 * 1024 + 1); });
    const { deps, tempRoot } = handlerDeps(exec, { limits: { maxMinutes: 20, maxFilesizeMB: 2, timeoutMs: 5000 } });
    await rejectsWith(downloadOk(URL_OK, deps), 'FILE_TOO_LARGE');
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    const semLimite = handlerDeps(exec, { limits: { maxMinutes: 20, maxFilesizeMB: 0, timeoutMs: 5000 } });
    const result = await downloadOk(URL_OK, semLimite.deps);
    result.cleanup();
});
await test('arquivo dentro do limite de tamanho é entregue (1,5 MB com limite de 2 MB)', async () => {
    const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1], 'Medio.mp3', Math.floor(1.5 * 1024 * 1024)); });
    const { deps, tempRoot } = handlerDeps(exec, { limits: { maxMinutes: 20, maxFilesizeMB: 2, timeoutMs: 5000 } });
    const result = await downloadOk(URL_OK, deps);
    assert.equal(path.basename(result.filePath), 'Medio.mp3');
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});
await test('SPOTDL_PATH relativo (com pasta ou nome puro) chega ao execFile ABSOLUTO: o spotdl roda com cwd na pasta do pedido', async () => {
    fs.mkdirSync(path.join(sandbox, 'tools'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'tools', 'spotdl-rel.exe'), 'x');
    fs.writeFileSync(path.join(sandbox, 'spotdl-nome-puro.exe'), 'x');
    for (const [configured, expected] of [['tools/spotdl-rel.exe', path.resolve('tools', 'spotdl-rel.exe')], ['spotdl-nome-puro.exe', path.resolve('spotdl-nome-puro.exe')]]) {
        const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
        const { deps, tempRoot } = handlerDeps(exec);
        delete deps.spotdlPath;
        deps.baseEnv = { ...deps.baseEnv, SPOTDL_PATH: configured };
        const result = await downloadOk(URL_OK, deps);
        assert.equal(exec.calls[0].file, expected, configured);
        assert.ok(path.isAbsolute(exec.calls[0].file));
        assert.notEqual(path.dirname(exec.calls[0].options.cwd), path.dirname(exec.calls[0].file), 'o cwd do filho é a pasta do pedido, outra');
        result.cleanup();
        assert.deepEqual(fs.readdirSync(tempRoot), []);
    }
});
await test('pasta temporária que o spotdl alteraria (".oculta") falha cedo, sem iniciar o spotdl, devolve a vaga e não deixa pasta', async () => {
    const logs = captureLogs();
    try {
        const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
        const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 0 });
        const hazardRoot = path.join(sandbox, '.oculta', 'root');
        const { deps } = handlerDeps(exec, { tempRoot: hazardRoot, spotdlGate: gate });
        const error = await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_ERROR');
        assert.match(error.detail, /começa com "\."/);
        assert.ok(!NO_LEAK.test(error.userMessage));
        assert.equal(exec.calls.length, 0, 'o spotdl nem foi iniciado');
        assert.equal(gate.stats().running, 0, 'a vaga voltou');
        assert.deepEqual(fs.readdirSync(hazardRoot), [], 'nenhuma pasta de pedido sobrou');
        assert.match(logs.text(), /Código: SPOTIFY_ERROR \| Detalhe: Um componente do caminho/);
    } finally {
        logs.restore();
    }
});

// Falhas do spotdl: cada uma vira o código certo, SEM chamar o yt-dlp e SEM sobrar pasta.
const FAILURES = [
    ['saída 0, faixa não achada', { stdout: 'LookupError: No results found for song: Banda - Faixa' }, 'SPOTIFY_NOT_FOUND'],
    ['saída 0, sem arquivo e sem texto', {}, 'SPOTIFY_NO_FILE'],
    ['saída 1, sessão do Spotify', { error: execError(1), stdout: 'An error occurred\nBaseClientError: Could not get session auth tokens' }, 'SPOTIFY_BLOCKED'],
    ['saída 1, Spotify sem rede', { error: execError(1), stdout: 'RequestError: Failed to complete request.' }, 'SPOTIFY_BLOCKED'],
    ['saída 1, ytmusicapi sem rede', { error: execError(1), stdout: 'requests.exceptions.ConnectionError: HTTPSConnectionPool: Max retries exceeded' }, 'SPOTIFY_BLOCKED'],
    ['saída 0, YouTube Music bloqueado', { stdout: 'You might be blocked by YouTube Music.\nLookupError: No results found for song: A - B' }, 'SPOTIFY_BLOCKED'],
    ['saída 1, faixa removida', { error: execError(1), stdout: 'SongError: Track no longer exists: https://open.spotify.com/track/xyz' }, 'SPOTIFY_PRIVATE'],
    ['saída 1, sem ffmpeg', { error: execError(1), stdout: 'FFmpegError: FFmpeg is not installed. Please run spotdl --download-ffmpeg' }, 'SPOTIFY_ERROR'],
    ['saída 0, falha do yt-dlp', { stdout: 'AudioProviderError: YT-DLP download error - https://music.youtube.com/watch?v=abc' }, 'SPOTIFY_ERROR'],
    ['saída 0, falha na conversão', { stdout: 'FFmpegError: Failed to convert A - B, you can find error here: C:/x/errors/e.txt' }, 'SPOTIFY_ERROR'],
    ['saída 1, launcher quebrado', { error: execError(1), stdout: 'Fatal error in launcher: Unable to create process' }, 'SPOTIFY_UNAVAILABLE'],
    ['EACCES ao executar', { error: execError('EACCES') }, 'SPOTIFY_UNAVAILABLE'],
    ['saída 1, texto desconhecido', { error: execError(1), stdout: 'algo que ninguém conhece' }, 'SPOTIFY_ERROR'],
];
for (const [name, result, code] of FAILURES) {
    await test(`falha do spotdl (${name}) => ${code}, sem yt-dlp e com a pasta limpa`, async () => {
        const exec = makeExec(() => result);
        const { deps, tempRoot } = handlerDeps(exec);
        const error = await rejectsWith(downloadOk(URL_OK, deps), code);
        assert.equal(exec.calls.length, 1, 'o yt-dlp não foi chamado');
        assert.equal(exec.calls[0].file, 'spotdl');
        assert.ok(!NO_LEAK.test(error.userMessage), error.userMessage);
        assert.ok(!NO_LEAK.test(error.detail || ''), `o detalhe do erro vaza: ${error.detail}`);
        assert.deepEqual(fs.readdirSync(tempRoot), [], 'pasta do pedido (com a _home) apagada');
        assert.deepEqual(deps.spotdlGate.stats(), { running: 0, waiting: 0, maxParallel: 2, maxWaiting: 3 }, 'a vaga do porteiro foi liberada');
        if (code === 'SPOTIFY_BLOCKED' || code === 'SPOTIFY_NOT_FOUND') assert.match(error.userMessage, /\/baixar_musica busca:/);
    });
}
await test('spotdl ausente (ENOENT) cai no yt-dlp; sem os dois, SPOTIFY_UNAVAILABLE e pasta limpa', async () => {
    const fallback = makeExec(({ file, args }) => {
        if (file === 'spotdl') return { error: ENOENT };
        const out = args[args.indexOf('-o') + 1];
        fs.writeFileSync(out.replace('%(ext)s', 'mp3'), Buffer.alloc(16, 1));
        return { stdout: `${JSON.stringify({ title: 'Via yt-dlp' })}\n` };
    });
    const first = handlerDeps(fallback);
    const result = await downloadOk(URL_OK, first.deps);
    assert.equal(result.metadata.provider, 'yt-dlp');
    assert.equal(fallback.calls.length, 2);
    assert.equal(fallback.calls[1].file, 'yt-dlp-falso');
    assert.equal(first.deps.spotdlBreaker.state().failures, 0, 'spotdl ausente não conta no disjuntor');
    result.cleanup();
    assert.deepEqual(fs.readdirSync(first.tempRoot), []);

    const nenhum = makeExec(() => ({ error: ENOENT }));
    const second = handlerDeps(nenhum);
    const error = await rejectsWith(downloadOk(URL_OK, second.deps), 'SPOTIFY_UNAVAILABLE');
    assert.equal(nenhum.calls.length, 2);
    assert.ok(!NO_LEAK.test(error.userMessage));
    assert.deepEqual(fs.readdirSync(second.tempRoot), []);
});
await test('timeout: o killImpl recebe o filho vivo, vira DOWNLOAD_TIMEOUT, sem fallback; vaga e rastreio são liberados', async () => {
    let pendingCallback = null;
    const killed = [];
    const before = countLiveSpotdlChildren();
    let trackedDuringRun = null;
    const exec = (file, args, options, cb) => { pendingCallback = cb; return { pid: 999 }; };
    const calls = [];
    const wrapped = (...a) => { calls.push(a); return exec(...a); };
    const { deps, tempRoot } = handlerDeps(wrapped, {
        limits: { maxMinutes: 20, maxFilesizeMB: 200, timeoutMs: 600 },
        killImpl: (child) => { killed.push(child.pid); trackedDuringRun = countLiveSpotdlChildren(); pendingCallback(new Error('encerrado'), 'Could not get session', ''); },
    });
    const started = Date.now();
    await rejectsWith(downloadOk(URL_OK, deps), 'DOWNLOAD_TIMEOUT');
    assert.ok(Date.now() - started < 590, 'o timer antecipado disparou antes do timeout do Node (600 ms)');
    assert.deepEqual(killed, [999]);
    assert.equal(trackedDuringRun, before + 1, 'o filho estava rastreado enquanto rodava');
    assert.equal(countLiveSpotdlChildren(), before, 'e foi esquecido depois');
    assert.equal(calls.length, 1, 'sem yt-dlp depois do timeout');
    assert.equal(calls[0][2].timeout, 600, 'o timeout do execFile continua sendo o prazo inteiro');
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    assert.equal(deps.spotdlGate.stats().running, 0);
    assert.equal(deps.spotdlBreaker.state().failures, 0, 'timeout não conta no disjuntor');
});
await test('spotdl ausente e yt-dlp com falha genérica: SPOTIFY_UNAVAILABLE (não SPOTIFY_ERROR), sem vazar o erro cru', async () => {
    const exec = makeExec(({ file }) => (file === 'spotdl'
        ? { error: ENOENT }
        : { error: execError(1), stderr: 'ERROR: alguma coisa estranha em C:/Users/mauri/segredo/x.txt' }));
    const { deps, tempRoot } = handlerDeps(exec);
    const error = await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_UNAVAILABLE');
    assert.equal(exec.calls.length, 2, 'spotdl e depois yt-dlp');
    assert.ok(!NO_LEAK.test(error.userMessage));
    assert.ok(!NO_LEAK.test(error.detail || ''), error.detail);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});
await test('porteiro: uma falha logo depois de pegar a vaga (ex.: disco cheio ao criar a _home) devolve a vaga e limpa a pasta', async () => {
    const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 0 });
    const { deps, tempRoot } = handlerDeps(exec, { spotdlGate: gate });
    const realMkdir = fs.mkdirSync;
    fs.mkdirSync = (target, options) => {
        if (String(target).endsWith(path.join('_home', 'tmp'))) throw new Error('ENOSPC: disco cheio');
        return realMkdir(target, options);
    };
    try {
        await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_ERROR');
    } finally {
        fs.mkdirSync = realMkdir;
    }
    assert.equal(exec.calls.length, 0);
    assert.equal(gate.stats().running, 0, 'a vaga voltou ao porteiro');
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    // com maxParallel 1, uma vaga vazada derrubaria este pedido com SPOTIFY_BUSY
    const result = await downloadOk(URL_OK, deps);
    result.cleanup();
    assert.equal(gate.stats().running, 0);
});
await test('porteiro + disjuntor: o pedido que esperava na fila e encontra o circuito ABERTO recebe SPOTIFY_BLOCKED sem iniciar processo, e a vaga volta', async () => {
    const breaker = createSpotdlBreaker({ threshold: 1, now: () => 9_000_000 });
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 2, maxWaitMs: 20000 });
    const calls = [];
    let failFirst = null;
    const exec = (file, args, options, cb) => {
        calls.push(args);
        if (calls.length === 1) failFirst = () => cb(execError(1), 'BaseClientError: Could not get session auth tokens', ''); // o 1º fica pendente
        else setImmediate(() => cb(null, '', ''));
        return { pid: 4242, kill() {} };
    };
    const a = handlerDeps(exec, { spotdlGate: gate, spotdlBreaker: breaker });
    const b = handlerDeps(exec, { spotdlGate: gate, spotdlBreaker: breaker });
    const first = downloadOk(URL_OK, a.deps).catch((err) => err);
    assert.ok(await waitFor(() => calls.length === 1), 'o 1º pedido iniciou o spotdl');
    const second = downloadOk(URL_OK, b.deps).catch((err) => err);
    assert.ok(await waitFor(() => gate.stats().waiting === 1), 'o 2º entrou na fila');
    failFirst(); // o Spotify falha: o circuito abre (limiar 1) enquanto o 2º espera
    const [error1, error2] = await Promise.all([first, second]);
    assert.equal(error1.code, 'SPOTIFY_BLOCKED');
    assert.equal(error2.code, 'SPOTIFY_BLOCKED');
    assert.match(error2.userMessage, /busca:/);
    assert.equal(calls.length, 1, 'o 2º NÃO iniciou processo: o circuito foi conferido de novo ao sair da fila');
    assert.deepEqual(gate.stats(), { running: 0, waiting: 0, maxParallel: 1, maxWaiting: 2 }, 'as duas vagas voltaram');
    assert.deepEqual(fs.readdirSync(b.tempRoot), []);
    assert.deepEqual(fs.readdirSync(a.tempRoot), []);
});
await test('disjuntor aberto: o pedido recebe SPOTIFY_BLOCKED na hora, sem entrar na fila do porteiro', async () => {
    const breaker = createSpotdlBreaker({ threshold: 1, now: () => 1 });
    breaker.record('spotify_down');
    assert.equal(breaker.isOpen(), true);
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 3, maxWaitMs: 400 });
    const hold = await gate.acquire(); // porteiro cheio
    const exec = makeExec(() => { throw new Error('não deveria executar'); });
    const { deps, tempRoot } = handlerDeps(exec, { spotdlGate: gate, spotdlBreaker: breaker });
    const started = Date.now();
    await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_BLOCKED'); // se entrasse na fila, viria SPOTIFY_BUSY depois de 400 ms
    assert.ok(Date.now() - started < 300);
    assert.equal(gate.stats().waiting, 0);
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    hold();
});
await test('disjuntor: o sucesso zera a contagem de falhas SEGUIDAS (2 falhas, 1 sucesso, 2 falhas não abrem o circuito)', async () => {
    let mode = 'falha';
    const exec = makeExec(({ args }) => {
        if (mode === 'ok') { writeMp3(args[args.indexOf('--output') + 1]); return {}; }
        return { error: execError(1), stdout: 'BaseClientError: Could not get session auth tokens' };
    });
    const { deps } = handlerDeps(exec);
    for (let i = 0; i < 2; i++) await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_BLOCKED');
    assert.equal(deps.spotdlBreaker.state().failures, 2);
    mode = 'ok';
    (await downloadOk(URL_OK, deps)).cleanup();
    assert.equal(deps.spotdlBreaker.state().failures, 0, 'o sucesso zerou a contagem');
    mode = 'falha';
    for (let i = 0; i < 2; i++) await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_BLOCKED');
    assert.equal(deps.spotdlBreaker.state().failures, 2);
    assert.equal(deps.spotdlBreaker.isOpen(), false);
});
await test('log: estouro do maxBuffer mostra o código real (ERR_CHILD_PROCESS_STDIO_MAXBUFFER) e vira SPOTIFY_ERROR', async () => {
    const logs = captureLogs();
    try {
        const exec = makeExec(() => ({ error: execError('ERR_CHILD_PROCESS_STDIO_MAXBUFFER', { message: 'stdout maxBuffer length exceeded' }), stdout: '' }));
        const { deps } = handlerDeps(exec);
        await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_ERROR');
        assert.match(logs.text(), /spotdl: unknown, saída ERR_CHILD_PROCESS_STDIO_MAXBUFFER, \d+\.\d s/);
    } finally {
        logs.restore();
    }
});
await test('motivo do yt-dlp (bot check, 429...) só conta com YUI_SPOTDL_LOG_LEVEL=DEBUG', async () => {
    const stdout = "ERROR: [youtube] abc: Sign in to confirm you're not a bot\nAudioProviderError: YT-DLP download error - https://x";
    const normal = handlerDeps(makeExec(() => ({ stdout })));
    await rejectsWith(downloadOk(URL_OK, normal.deps), 'SPOTIFY_ERROR');
    const debug = handlerDeps(makeExec(() => ({ stdout })));
    debug.deps.baseEnv = { ...debug.deps.baseEnv, YUI_SPOTDL_LOG_LEVEL: 'DEBUG' };
    const error = await rejectsWith(downloadOk(URL_OK, debug.deps), 'SPOTIFY_BLOCKED');
    assert.match(error.userMessage, /busca:/);
    assert.equal(debug.deps.spotdlBreaker.state().failures, 0, 'o bot check do YouTube não conta no disjuntor do Spotify');
});
await test('porteiro: com a fila cheia o pedido recebe SPOTIFY_BUSY sem iniciar processo e sem sobrar pasta', async () => {
    const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 0 });
    const { deps, tempRoot } = handlerDeps(exec, { spotdlGate: gate });
    const hold = await gate.acquire();
    const error = await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_BUSY');
    assert.match(error.userMessage, /busca:/);
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    hold();
    const result = await downloadOk(URL_OK, deps);
    assert.equal(exec.calls.length, 1);
    result.cleanup();
});
await test('porteiro: o pedido que espera na fila roda quando a vaga é liberada', async () => {
    const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
    const gate = createSpotdlGate({ maxParallel: 1, maxWaiting: 1, maxWaitMs: 10000 });
    const { deps } = handlerDeps(exec, { spotdlGate: gate });
    const hold = await gate.acquire();
    const pending = downloadOk(URL_OK, deps);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(exec.calls.length, 0, 'ainda esperando a vaga');
    assert.equal(gate.stats().waiting, 1);
    hold();
    const result = await pending;
    assert.equal(exec.calls.length, 1);
    result.cleanup();
    assert.equal(gate.stats().running, 0);
});
await test('disjuntor: 3 falhas seguidas do Spotify abrem o circuito; o pedido seguinte não inicia processo; depois do prazo volta a tentar', async () => {
    const logs = captureLogs();
    try {
        let t = 5_000_000;
        const breaker = createSpotdlBreaker({ now: () => t });
        let mode = 'falha';
        const exec = makeExec(({ args }) => {
            if (mode === 'ok') { writeMp3(args[args.indexOf('--output') + 1]); return {}; }
            return { error: execError(1), stdout: 'An error occurred\nBaseClientError: Could not get session auth tokens' };
        });
        const { deps, tempRoot } = handlerDeps(exec, { spotdlBreaker: breaker });
        for (let i = 0; i < 3; i++) await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_BLOCKED');
        assert.equal(exec.calls.length, 3);
        assert.equal(breaker.isOpen(), true);
        assert.match(logs.text(), /Disjuntor do spotdl aberto/);
        const bloqueado = await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_BLOCKED');
        assert.match(bloqueado.userMessage, /busca:/);
        assert.equal(exec.calls.length, 3, 'sem processo enquanto o circuito está aberto');
        assert.deepEqual(fs.readdirSync(tempRoot), []);
        t += 5 * 60 * 1000;
        mode = 'ok';
        const result = await downloadOk(URL_OK, deps);
        assert.equal(exec.calls.length, 4);
        assert.equal(breaker.state().failures, 0, 'o sucesso zera a contagem');
        result.cleanup();
    } finally {
        logs.restore();
    }
});
await test('disjuntor: falhas que não são do Spotify/rede (faixa não achada, timeout...) não abrem o circuito', async () => {
    const exec = makeExec(() => ({ stdout: 'LookupError: No results found for song: A - B' }));
    const { deps } = handlerDeps(exec);
    for (let i = 0; i < 6; i++) await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_NOT_FOUND');
    assert.equal(deps.spotdlBreaker.isOpen(), false);
    assert.equal(exec.calls.length, 6);
});
await test('log: uma linha por pedido, sem URL, caminho, ANSI nem chave=valor, e o stderr cru não vaza', async () => {
    const logs = captureLogs();
    try {
        const sujo = [
            '\u001b[31mERROR\u001b[0m AudioProviderError: YT-DLP download error - https://rr3---sn-x.googlevideo.com/videoplayback?expire=1&ip=200.1.2.3&sig=SEGREDO-ASSINATURA&id=abc',
            'ERROR cookies em C:/Users/mauri/segredo/cookies.txt token=XYZ123',
        ].join('\n');
        const exec = makeExec(() => ({ error: execError(1), stderr: sujo }));
        const { deps } = handlerDeps(exec);
        await rejectsWith(downloadOk(URL_OK, deps), 'SPOTIFY_ERROR');
        const linhas = logs.lines.filter((l) => l.text.startsWith('[SpotifyHandler] spotdl:') && !l.text.includes('(origem:'));
        assert.equal(linhas.length, 1, 'exatamente uma linha de resultado do spotdl por pedido');
        const linha = linhas[0].text;
        assert.equal(linhas[0].level, 'warn');
        assert.match(linha, /^\[SpotifyHandler\] spotdl: ytdlp_fail, saída 1, \d+\.\d s/);
        assert.ok(!/=/.test(linha), `chave=valor na linha: ${linha}`);
        assert.ok(!/https?:/i.test(linha), 'sem URL');
        assert.ok(!/[A-Za-z]:[\\/]/.test(linha), 'sem caminho');
        assert.ok(!linha.includes('\u001b'), 'sem ANSI');
        const tudo = logs.text();
        for (const proibido of ['SEGREDO-ASSINATURA', 'googlevideo', '200.1.2.3', 'XYZ123', 'cookies.txt', 'C:/Users/mauri']) {
            assert.ok(!tudo.includes(proibido), `o log vazou ${proibido}`);
        }
    } finally {
        logs.restore();
    }
});
await test('log: o sucesso também tem uma linha; o caminho do spotdl é anunciado uma vez por caminho distinto', async () => {
    const logs = captureLogs();
    try {
        const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
        for (const name of ['spotdl-anuncio-a', 'spotdl-anuncio-a', 'spotdl-anuncio-b']) {
            const { deps } = handlerDeps(exec, { spotdlPath: name });
            (await downloadOk(URL_OK, deps)).cleanup();
        }
        const anuncios = logs.lines.filter((l) => l.text.includes('(origem: deps)'));
        assert.equal(anuncios.length, 2, 'dois caminhos distintos, duas linhas');
        assert.ok(anuncios[0].text.includes('spotdl-anuncio-a') && anuncios[1].text.includes('spotdl-anuncio-b'));
        const ok = logs.lines.filter((l) => /^\[SpotifyHandler\] spotdl: ok, saída 0, \d+\.\d s$/.test(l.text));
        assert.equal(ok.length, 3);
        assert.ok(ok.every((l) => l.level === 'info'));
    } finally {
        logs.restore();
    }
});
await test('o gancho de saída fica instalado depois do primeiro uso do spotdl', async () => {
    const exec = makeExec(({ args }) => { writeMp3(args[args.indexOf('--output') + 1]); });
    const { deps } = handlerDeps(exec);
    (await downloadOk(URL_OK, deps)).cleanup();
    assert.equal(installSpotdlExitHook(), false, 'já instalado no processo real');
});
await test('álbum, playlist e links inválidos continuam recusados antes de qualquer processo', async () => {
    const exec = makeExec(() => { throw new Error('não deveria executar'); });
    const { deps, tempRoot } = handlerDeps(exec);
    for (const kind of ['album', 'playlist', 'artist', 'show', 'episode']) {
        await rejectsWith(downloadOk(`https://open.spotify.com/${kind}/${SP}`, deps), 'SPOTIFY_ONLY_TRACK');
    }
    for (const bad of [`${URL_OK}"&whoami&"`, '--output=C:/pwned', '', null]) {
        await rejectsWith(downloadOk(bad, deps), 'SPOTIFY_INVALID_URL');
    }
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

// ---------------------------------------------------------------------------
console.log('spotdl real (somente --version, ambiente mínimo e HOME falso)');
const REAL_EXE = path.join(projectRoot, '.venv-spotdl', 'Scripts', 'spotdl.exe');
if (process.platform === 'win32' && fs.existsSync(REAL_EXE)) {
    await test('spotdl.exe --version com ambiente mínimo: 4.5.2, sem rede, e o config nasce no HOME falso', async () => {
        const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-spotdl-home-'));
        try {
            const homeDir = path.join(base, '_home');
            const tmpDir = path.join(homeDir, 'tmp');
            fs.mkdirSync(tmpDir, { recursive: true });
            const env = buildSpotdlEnv(homeDir, tmpDir, { ...process.env, DISCORD_TOKEN: 'segredo-nao-pode-chegar' });
            assert.ok(!JSON.stringify(env).includes('segredo-nao-pode-chegar'));
            const real = await runTool(REAL_EXE, ['--version'], { timeoutMs: 60000, cwd: base, execFileImpl: withEnv(execFile, env, trackSpotdlChild) });
            assert.equal(real.error, null, `${real.stdout}\n${real.stderr}`);
            assert.match(`${real.stdout}\n${real.stderr}`, /4\.5\.2/);
            assert.ok(fs.existsSync(path.join(homeDir, '.spotdl')), 'a pasta .spotdl nasceu no HOME falso');
            assert.equal(classifySpotdlRun(real).kind, 'unknown', 'saída normal não é classificada como falha');
        } finally {
            fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
        }
    });
} else {
    skip('spotdl.exe --version', '.venv-spotdl não existe nesta máquina');
}

// ---------------------------------------------------------------------------
console.log('Módulos, requisitos e .gitignore');
await test('importar spotdlTools não tem efeito colateral e o módulo não depende de binaries.js nem do logger', async () => {
    const listenersBefore = process.listenerCount('exit');
    await import('../src/utils/spotdlTools.js?outra-instancia');
    assert.equal(process.listenerCount('exit'), listenersBefore);
    const tools = fs.readFileSync(path.join(projectRoot, 'src', 'utils', 'spotdlTools.js'), 'utf8');
    assert.ok(!/from\s+['"][^'"]*binaries\.js['"]/.test(tools), 'o stub de binaries.js do test-deezer não pode ser exigido');
    assert.ok(!/from\s+['"][^'"]*logger\.js['"]/.test(tools));
    assert.ok(!/console\./.test(tools));
});
await test('o handler só importa getYtdlpPath e getFfmpegPath de binaries.js (o stub do test-deezer continua valendo)', () => {
    const handler = fs.readFileSync(path.join(projectRoot, 'src', 'handlers', 'spotifyDownloadHandler.js'), 'utf8');
    const imports = [...handler.matchAll(/import\s*\{([^}]*)\}\s*from\s*['"][^'"]*binaries\.js['"]/g)];
    assert.equal(imports.length, 1);
    assert.deepEqual(imports[0][1].split(',').map((s) => s.trim()).filter(Boolean).sort(), ['getFfmpegPath', 'getYtdlpPath']);
    assert.ok(!/console\./.test(handler));
});
await test('requirements-spotdl.txt: sem comentários é exatamente spotdl==4.5.2', () => {
    const lines = fs.readFileSync(path.join(projectRoot, 'requirements-spotdl.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.deepEqual(lines, ['spotdl==4.5.2']);
});
await test('requirements-spotdl.lock.txt: versões exatas de todo o ambiente, sem duplicatas, com o spotdl 4.5.2', () => {
    const lines = fs.readFileSync(path.join(projectRoot, 'requirements-spotdl.lock.txt'), 'utf8').split(/\r?\n/).map((l) => l.trim()).filter((l) => l && !l.startsWith('#'));
    assert.ok(lines.length >= 60, `só ${lines.length} linhas`);
    for (const line of lines) assert.match(line, /^[A-Za-z0-9][A-Za-z0-9._-]*==[0-9][A-Za-z0-9.!+_-]*$/, line);
    const names = lines.map((l) => l.split('==')[0].toLowerCase().replace(/[-_.]+/g, '-'));
    assert.equal(new Set(names).size, names.length, 'pacote repetido');
    for (const expected of ['spotdl==4.5.2', 'yt-dlp==2026.8.19', 'spotapi==1.2.8', 'spotipyFree==1.9.14', 'ytmusicapi==1.12.3']) {
        assert.ok(lines.includes(expected), expected);
    }
});
await test('.gitignore: os dois requirements do spotdl são liberados logo depois do requirements-deemix.txt', () => {
    const lines = fs.readFileSync(path.join(projectRoot, '.gitignore'), 'utf8').split(/\r?\n/);
    const i = lines.indexOf('!requirements-deemix.txt');
    assert.ok(i >= 0);
    assert.equal(lines[i + 1], '!requirements-spotdl.txt');
    assert.equal(lines[i + 2], '!requirements-spotdl.lock.txt');
    assert.ok(lines.includes('.venv*/'), 'o ambiente .venv-spotdl continua ignorado');
});

// ---------------------------------------------------------------------------
console.log(`\n${passed} teste(s) passaram, ${failures.length} falharam.`);
process.chdir(originalCwd);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* arquivos de log ainda abertos no Windows */ }
if (failures.length) {
    console.log('Falhas:\n - ' + failures.join('\n - '));
    process.exit(1);
}
process.exit(0);
