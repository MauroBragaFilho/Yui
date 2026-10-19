// Testes dos downloads: normalização de links, playlist, injeção de comando e execução sem shell.
// Nunca chama o yt-dlp/spotdl nem a rede: o execFile é substituído por um dublê.
// Execução: npm run test:media
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
    MediaError,
    getMediaUserMessage,
    parseHttpUrl,
    normalizeYoutubeUrl,
    normalizeInstagramUrl,
    normalizeTiktokUrl,
    normalizeMediaUrl,
    normalizeSpotifyUrl,
    looksLikeSpotifyUrl,
    readDownloadLimits,
    buildYtdlpAudioFlags,
    buildYtdlpVideoFlags,
    safeFileStem,
    createRequestDir,
    removeRequestDir,
    sweepStaleRequestDirs,
    runTool,
    killProcessTree,
    resolveExistingPath,
    resolveBinaryPath,
    codeSafe,
    formatDeezerDelivery,
    mentionsOrigin,
    readMaxConcurrentDownloads,
    isUploadTooLargeError,
} from '../src/utils/mediaUrls.js';
import { getUploadLimitBytes } from '../src/utils/uploadLimit.js';

// Isolamento: cwd, logs e banco em pasta temporária (nada do projeto real é tocado).
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-media-test-'));
const originalCwd = process.cwd();
process.env.DATABASE_DIR = process.env.DATABASE_DIR || path.join(sandbox, 'db');
process.env.LOG_LEVEL = 'error';
process.chdir(sandbox);

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok    ${name}`);
    } catch (err) {
        failures.push(name);
        console.log(`  FALHA ${name}\n        ${String(err.message).split('\n').join('\n        ')}`);
    }
}

const ID = 'dQw4w9WgXcQ';
const PL = 'PLabcdefghijklmnop';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;
const PLAYLIST_URL = `https://www.youtube.com/playlist?list=${PL}`;

function pick(result) {
    if (!result) return result;
    return {
        platform: result.platform,
        url: result.url,
        playlistIgnored: result.playlistIgnored,
        playlistOnly: result.playlistOnly,
    };
}
function expectation(platform, url, playlistIgnored, playlistOnly) {
    return { platform, url, playlistIgnored, playlistOnly };
}

// ---------------------------------------------------------------------------
console.log('YouTube: tabela de comportamento');
const youtubeTable = [
    [`https://www.youtube.com/watch?v=${ID}`, expectation('youtube', WATCH, false, false)],
    [`${WATCH}&list=${PL}`, expectation('youtube', WATCH, true, false)],
    [`${WATCH}&list=${PL}&index=3`, expectation('youtube', WATCH, true, false)],
    [`${WATCH}&index=2&list=${PL}`, expectation('youtube', WATCH, true, false)],
    [`${WATCH}&t=30s&list=${PL}`, expectation('youtube', WATCH, true, false)],
    [`${WATCH}&pp=ygUJbXVzaWM%3D&list=${PL}`, expectation('youtube', WATCH, true, false)],
    [`${WATCH}&feature=share&list=${PL}`, expectation('youtube', WATCH, true, false)],
    [`https://www.youtube.com/watch?list=${PL}&v=${ID}`, expectation('youtube', WATCH, true, false)],
    [`https://www.youtube.com/watch?app=desktop&v=${ID}&list=${PL}`, expectation('youtube', WATCH, true, false)],
    [`https://www.youtube.com/watch?feature=share&v=${ID}`, expectation('youtube', WATCH, false, false)],
    [`https://youtube.com/watch?v=${ID}&t=10`, expectation('youtube', WATCH, false, false)],
    [`https://youtu.be/${ID}`, expectation('youtube', WATCH, false, false)],
    [`https://youtu.be/${ID}?list=${PL}`, expectation('youtube', WATCH, true, false)],
    [`https://youtu.be/${ID}?si=abc123&t=10`, expectation('youtube', WATCH, false, false)],
    [`https://music.youtube.com/watch?v=${ID}&list=RDAMVM${ID}`, expectation('youtube_music', WATCH, true, false)],
    [`https://www.youtube.com/watch?v=${ID}&list=RD${ID}&start_radio=1`, expectation('youtube', WATCH, true, false)],
    [`https://m.youtube.com/watch?v=${ID}`, expectation('youtube', WATCH, false, false)],
    [`https://www.youtube.com/live/${ID}?feature=share`, expectation('youtube', WATCH, false, false)],
    [`https://www.youtube.com/embed/${ID}`, expectation('youtube', WATCH, false, false)],
    [`https://www.youtube.com/v/${ID}`, expectation('youtube', WATCH, false, false)],
    [`youtu.be/${ID}`, expectation('youtube', WATCH, false, false)],
    [`www.youtube.com/watch?v=${ID}`, expectation('youtube', WATCH, false, false)],
    [`<https://youtu.be/${ID}>`, expectation('youtube', WATCH, false, false)],
    [`  https://youtu.be/${ID}  `, expectation('youtube', WATCH, false, false)],
    [`HTTPS://WWW.YOUTUBE.COM/watch?v=${ID}`, expectation('youtube', WATCH, false, false)],
    [`https://www.youtube.com/shorts/${ID}`, expectation('youtube_shorts', `https://www.youtube.com/shorts/${ID}`, false, false)],
    [`https://www.youtube.com/shorts/${ID}?feature=share`, expectation('youtube_shorts', `https://www.youtube.com/shorts/${ID}`, false, false)],
    // Playlist pura: baixa só o 1º item
    [PLAYLIST_URL, expectation('youtube', PLAYLIST_URL, false, true)],
    [`https://music.youtube.com/playlist?list=OLAK5uy_kabcdefghijk`, expectation('youtube_music', 'https://www.youtube.com/playlist?list=OLAK5uy_kabcdefghijk', false, true)],
    [`https://www.youtube.com/playlist?list=RD${ID}`, expectation('youtube', `https://www.youtube.com/playlist?list=RD${ID}`, false, true)],
    [`https://www.youtube.com/watch?list=${PL}`, expectation('youtube', PLAYLIST_URL, false, true)],
    [`https://www.youtube.com/embed/videoseries?list=${PL}`, expectation('youtube', PLAYLIST_URL, false, true)],
];
for (const [input, expected] of youtubeTable) {
    await test(input.trim(), () => {
        assert.deepEqual(pick(normalizeYoutubeUrl(input)), expected);
        assert.deepEqual(pick(normalizeMediaUrl(input)), expected);
    });
}

await test('campos extras: videoId e listId', () => {
    const r = normalizeYoutubeUrl(`${WATCH}&list=${PL}`);
    assert.equal(r.videoId, ID);
    assert.equal(r.listId, PL);
    const p = normalizeYoutubeUrl(PLAYLIST_URL);
    assert.equal(p.videoId, null);
    assert.equal(p.listId, PL);
});

await test('list= inválido com v= válido: baixa o vídeo e não avisa de playlist', () => {
    const r = normalizeYoutubeUrl(`${WATCH}&list=curto`);
    assert.equal(r.url, WATCH);
    assert.equal(r.playlistIgnored, false);
});

console.log('YouTube: entradas rejeitadas');
const rejected = [
    '', '   ', null, undefined, 42, {}, 'texto qualquer', 'oi, baixa essa música pra mim',
    'https://www.youtube.com/watch?v=curto',
    `https://www.youtube.com/watch?v=${ID}extra`,
    'https://www.youtube.com/watch',
    `https://evil.com/watch?v=${ID}`,
    `https://youtube.com.evil.com/watch?v=${ID}`,
    `https://evil.com/youtube.com/watch?v=${ID}`,
    `https://notyoutube.com/watch?v=${ID}`,
    `https://youtube.com@evil.com/watch?v=${ID}`,
    `https://user:senha@youtu.be/${ID}`,
    `https://youtu.be:8080/${ID}`,
    `ftp://youtu.be/${ID}`,
    `javascript:alert(1)`,
    `file:///C:/Windows/win.ini`,
    'https://www.youtube.com/@canal',
    'https://www.youtube.com/channel/UCxxxxxxxxxxxxxxxxxxxxxx',
    'https://www.youtube.com/playlist?list=WL',
    'https://www.youtube.com/playlist',
    `https://youtu.be/playlist?list=${PL}`,
    `https://youtu.be/${ID}/outra/coisa`,
    `https://www.youtube.com/redirect?q=https://youtu.be/${ID}`,
    'a'.repeat(5000),
];
for (const input of rejected) {
    await test(`rejeita ${JSON.stringify(input)?.slice(0, 60)}`, () => {
        assert.equal(normalizeMediaUrl(input), null);
    });
}

// ---------------------------------------------------------------------------
console.log('Segurança: injeção de comando');
const SAFE_CANON = /^https:\/\/[a-z0-9.-]+\/[A-Za-z0-9_./@?=-]*$/;
const INJECTIONS = [
    `https://youtu.be/${ID}"&whoami&"`,
    `https://youtu.be/${ID}" & calc & "`,
    `https://youtu.be/${ID};whoami`,
    `https://youtu.be/${ID}|whoami`,
    `https://youtu.be/${ID}\`whoami\``,
    `https://youtu.be/${ID}\nwhoami`,
    `https://youtu.be/${ID}\r\nwhoami`,
    `https://youtu.be/${ID} && whoami`,
    `https://youtu.be/${ID}$(whoami)`,
    `${WATCH}&x="&whoami&"`,
    `${WATCH}&list=${PL}"&whoami&"`,
    `${WATCH}%22&whoami`,
    `${WATCH}&x=a^b`,
    `${WATCH}&x=a'b`,
    `${WATCH} --exec calc`,
    `https://www.tiktok.com/@u/video/12345678901"&whoami&"`,
    `https://www.tiktok.com/@u/video/12345678901;whoami`,
    `https://www.instagram.com/reel/CxYz123AbCd/"&whoami&"`,
];
for (const input of INJECTIONS) {
    await test(`injeção rejeitada ou reduzida: ${JSON.stringify(input).slice(0, 70)}`, () => {
        const r = normalizeMediaUrl(input);
        if (r !== null) {
            assert.match(r.url, SAFE_CANON);
            assert.ok(!/["'`&|;<>^%!$\\\s]/.test(r.url.replace(/^https:\/\//, '')), `URL com caractere perigoso: ${r.url}`);
        }
    });
}

await test('fuzz: caracteres perigosos em qualquer posição nunca chegam à URL final', () => {
    const bases = [
        WATCH, `https://youtu.be/${ID}`, PLAYLIST_URL, `https://www.youtube.com/shorts/${ID}`,
        'https://www.tiktok.com/@usuario/video/7123456789012345678', 'https://vm.tiktok.com/ZMabc123/',
        'https://www.instagram.com/reel/CxYz123AbCd/',
    ];
    const dangerous = ['"', "'", '`', '&', '|', ';', '<', '>', '^', '%', '!', '$(x)', ')', '\n', '\r', ' ', '\t', '\\', '..', '${x}', '%00', '\u0000', '\u2028'];
    let accepted = 0;
    for (const base of bases) {
        for (const d of dangerous) {
            const cut = Math.floor(base.length * 0.7);
            const variants = [base + d, base + d + 'whoami', `${base}${d}&x=1`, base.slice(0, cut) + d + base.slice(cut), d + base];
            for (const v of variants) {
                const r = normalizeMediaUrl(v);
                if (r === null) continue;
                accepted++;
                assert.match(r.url, SAFE_CANON, `entrada ${JSON.stringify(v)} => ${r.url}`);
                assert.ok(!/["'`&|;<>^%!$\\\s]/.test(r.url.replace(/^https:\/\//, '')), `entrada ${JSON.stringify(v)} => ${r.url}`);
            }
        }
    }
    assert.ok(accepted > 0, 'o fuzz precisa aceitar pelo menos algumas variações válidas');
});

// ---------------------------------------------------------------------------
console.log('Instagram e TikTok');
await test('Instagram reel vira URL canônica', () => {
    assert.deepEqual(
        pick(normalizeInstagramUrl('https://www.instagram.com/reel/CxYz123AbCd/?igsh=abc123')),
        expectation('instagram', 'https://www.instagram.com/reel/CxYz123AbCd/', false, false),
    );
    assert.equal(normalizeMediaUrl('instagram.com/reels/CxYz123AbCd').url, 'https://www.instagram.com/reel/CxYz123AbCd/');
});
await test('Instagram: outros caminhos e hosts são rejeitados', () => {
    for (const bad of [
        'https://www.instagram.com/p/CxYz123AbCd/',
        'https://www.instagram.com/reel/',
        'https://www.instagram.com/reel/CxYz123AbCd/extra/coisa',
        'https://instagram.com.evil.com/reel/CxYz123AbCd/',
        'https://evil.com/reel/CxYz123AbCd/',
        'https://l.instagram.com/reel/CxYz123AbCd/',
    ]) assert.equal(normalizeInstagramUrl(bad), null, bad);
});
await test('TikTok: vídeo, link curto e /t/ (sem -I 1)', () => {
    assert.deepEqual(
        pick(normalizeTiktokUrl('https://www.tiktok.com/@usuario.x/video/7123456789012345678?_t=8abc&_r=1')),
        expectation('tiktok', 'https://www.tiktok.com/@usuario.x/video/7123456789012345678', false, false),
    );
    assert.deepEqual(
        pick(normalizeTiktokUrl('https://vm.tiktok.com/ZMabc123/')),
        expectation('tiktok', 'https://vm.tiktok.com/ZMabc123/', false, false),
    );
    assert.deepEqual(
        pick(normalizeTiktokUrl('https://vt.tiktok.com/ZSabc123/')),
        expectation('tiktok', 'https://vt.tiktok.com/ZSabc123/', false, false),
    );
    assert.equal(normalizeTiktokUrl('https://www.tiktok.com/t/ZTabc123/').playlistOnly, false);
});
await test('TikTok: perfil e coleção viram playlistOnly (-I 1)', () => {
    assert.equal(normalizeTiktokUrl('https://www.tiktok.com/@usuario').playlistOnly, true);
    assert.equal(normalizeTiktokUrl('https://www.tiktok.com/@usuario/collection/minhas-7123456789').playlistOnly, true);
    assert.equal(normalizeTiktokUrl('https://www.tiktok.com/@usuario?lang=pt').url, 'https://www.tiktok.com/@usuario');
});
await test('TikTok: hosts falsos, raiz e caracteres proibidos são rejeitados', () => {
    const base = 'https://www.tiktok.com/@u/video/7123456789012345678';
    for (const bad of [
        'https://www.tiktok.com/',
        'https://tiktok.com.evil.com/@u/video/7123456789012345678',
        'https://evil.com/@u/video/7123456789012345678',
        'https://www.tiktok.com.evil.com/@u/video/7123456789012345678',
        `${base}%20x`, `${base}!`, `${base}\``, `${base}"`, `${base}|x`, `${base}^x`, `${base}<x>`,
        `${base}\nx`, `${base} x`, `${base}'x`, `${base}?a=%41`, `${base}?a=!`,
        'https://www.tiktok.com/@u/vídeo/1',
        'https://www.tiktok.com/@u;calc/video/7123456789012345678',
        'https://www.tiktok.com/@u$(calc)/video/7123456789012345678',
    ]) assert.equal(normalizeTiktokUrl(bad), null, JSON.stringify(bad));
});

console.log('Spotify');
const SP = '4uLU6hMCjMI75M1A2tKUQC';
await test('faixa vira URL canônica', () => {
    for (const input of [
        `https://open.spotify.com/track/${SP}`,
        `https://open.spotify.com/track/${SP}?si=abc123`,
        `https://open.spotify.com/intl-pt/track/${SP}`,
        `open.spotify.com/track/${SP}`,
        `<https://open.spotify.com/track/${SP}>`,
    ]) {
        assert.deepEqual(normalizeSpotifyUrl(input), { platform: 'spotify', kind: 'track', id: SP, url: `https://open.spotify.com/track/${SP}` }, input);
    }
});
await test('álbum, playlist, artista e podcast são reconhecidos (para recusar com mensagem clara)', () => {
    for (const kind of ['album', 'playlist', 'artist', 'episode', 'show']) {
        const r = normalizeSpotifyUrl(`https://open.spotify.com/${kind}/${SP}`);
        assert.equal(r.kind, kind);
    }
});
await test('Spotify: injeção e hosts falsos são rejeitados', () => {
    for (const bad of [
        `https://open.spotify.com/track/${SP}"&whoami&"`,
        `https://open.spotify.com/track/${SP};calc`,
        `https://open.spotify.com/track/${SP}\nx`,
        `https://open.spotify.com.evil.com/track/${SP}`,
        `https://evil.com/open.spotify.com/track/${SP}`,
        'https://open.spotify.com/track/curto',
        `https://open.spotify.com/track/${SP}/extra`,
        '', null,
    ]) assert.equal(normalizeSpotifyUrl(bad), null, JSON.stringify(bad));
});
await test('looksLikeSpotifyUrl só olha o host', () => {
    assert.equal(looksLikeSpotifyUrl(`https://open.spotify.com/track/curto`), true);
    assert.equal(looksLikeSpotifyUrl(WATCH), false);
    assert.equal(looksLikeSpotifyUrl(null), false);
});

// ---------------------------------------------------------------------------
console.log('Argumentos do yt-dlp');
const OUT = path.join(sandbox, 'req', 'media.%(ext)s');
const FULL_OPTS = {
    cookiesPath: path.join(sandbox, 'cookies.txt'),
    ffmpegPath: path.join(sandbox, 'ffmpeg.exe'),
    extraFlags: ['--ignore-config', '--js-runtimes', 'node', '--remote-components', 'ejs:github'],
    maxMinutes: 20,
    maxFilesizeMB: 200,
};
function assertNoQuotes(flags) {
    assert.ok(Array.isArray(flags), 'precisa ser um array');
    for (const part of flags) {
        assert.equal(typeof part, 'string');
        assert.ok(!part.includes('"'), `aspas em ${part}`);
    }
}
await test('áudio: array sem aspas, --no-playlist, sem -I e sem --max-downloads', () => {
    const flags = buildYtdlpAudioFlags(OUT, WATCH, FULL_OPTS);
    assertNoQuotes(flags);
    assert.ok(flags.includes('--no-playlist'));
    assert.ok(!flags.includes('-I'));
    assert.ok(!flags.includes('--max-downloads'));
    assert.equal(flags[flags.length - 1], WATCH);
    assert.equal(flags[flags.length - 2], '--print-json');
    assert.deepEqual(flags.slice(flags.indexOf('-o'), flags.indexOf('-o') + 2), ['-o', OUT]);
    assert.ok(flags.includes('-x') && flags.includes('mp3'));
    assert.equal(flags[flags.indexOf('--cookies') + 1], FULL_OPTS.cookiesPath);
    assert.equal(flags[flags.indexOf('--ffmpeg-location') + 1], FULL_OPTS.ffmpegPath);
});
await test('áudio: limites de tamanho e duração', () => {
    const flags = buildYtdlpAudioFlags(OUT, WATCH, FULL_OPTS);
    assert.equal(flags[flags.indexOf('--max-filesize') + 1], '200M');
    assert.equal(flags[flags.indexOf('--match-filters') + 1], '!is_live&duration<=?1200');
    const semLimite = buildYtdlpAudioFlags(OUT, WATCH, { ...FULL_OPTS, maxMinutes: 0, maxFilesizeMB: 0 });
    assert.ok(!semLimite.includes('--match-filters'));
    assert.ok(!semLimite.includes('--max-filesize'));
});
await test('áudio: playlist pura leva "-I 1" junto de --no-playlist (e nunca --max-downloads)', () => {
    const flags = buildYtdlpAudioFlags(OUT, PLAYLIST_URL, { ...FULL_OPTS, playlistOnly: true });
    assertNoQuotes(flags);
    assert.ok(flags.includes('--no-playlist'));
    assert.equal(flags[flags.indexOf('-I') + 1], '1');
    assert.ok(!flags.includes('--max-downloads'));
    assert.ok(!flags.some((f) => f.startsWith('--max-downloads')));
});
await test('áudio: qualidade opcional (Spotify)', () => {
    const flags = buildYtdlpAudioFlags(OUT, WATCH, { audioQuality: 2 });
    assert.equal(flags[flags.indexOf('--audio-quality') + 1], '2');
    assert.throws(() => buildYtdlpAudioFlags(OUT, WATCH, { audioQuality: '2; calc' }));
});
await test('vídeo: array sem aspas, formato mp4, -I 1 só quando pedido', () => {
    const shorts = `https://www.youtube.com/shorts/${ID}`;
    const flags = buildYtdlpVideoFlags(OUT, shorts, FULL_OPTS);
    assertNoQuotes(flags);
    assert.ok(flags.includes('--no-playlist'));
    assert.ok(!flags.includes('-I'));
    assert.ok(!flags.includes('--max-downloads'));
    assert.ok(flags[flags.indexOf('-f') + 1].startsWith('bestvideo[ext=mp4]'));
    assert.equal(flags[flags.length - 1], shorts);
    const perfil = buildYtdlpVideoFlags(OUT, 'https://www.tiktok.com/@usuario', { ...FULL_OPTS, playlistOnly: true });
    assert.equal(perfil[perfil.indexOf('-I') + 1], '1');
});
await test('o construtor recusa URL que não seja canônica (a string do usuário nunca chega ao yt-dlp)', () => {
    for (const bad of [
        `https://youtu.be/${ID}"&whoami&"`,
        `${WATCH} --exec calc`,
        `${WATCH}\nwhoami`,
        `http://www.youtube.com/watch?v=${ID}`,
        '--exec calc',
        'youtu.be/' + ID,
        '', null, undefined, 42,
    ]) {
        assert.throws(() => buildYtdlpAudioFlags(OUT, bad), /URL inválida/, JSON.stringify(bad));
        assert.throws(() => buildYtdlpVideoFlags(OUT, bad), /URL inválida/, JSON.stringify(bad));
    }
    assert.throws(() => buildYtdlpAudioFlags('C:\\x\\"; calc; ".mp3', WATCH), /Argumento inválido/);
    assert.throws(() => buildYtdlpAudioFlags(OUT, WATCH, { cookiesPath: 'a"b' }), /Argumento inválido/);
    assert.throws(() => buildYtdlpAudioFlags(OUT, WATCH, { extraFlags: ['--x="y"'] }), /Argumento inválido/);
});

await test('caminhos relativos (cookies/ffmpeg do .env) viram absolutos: o yt-dlp roda com cwd na pasta do pedido', () => {
    fs.mkdirSync(path.join(sandbox, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'cfg', 'cookies.txt'), '# Netscape HTTP Cookie File\n');
    // resolveExistingPath: relativo existente => absoluto; inexistente/vazio/inválido => null
    assert.equal(resolveExistingPath('cfg/cookies.txt'), path.join(sandbox, 'cfg', 'cookies.txt'));
    assert.equal(resolveExistingPath(path.join(sandbox, 'cfg', 'cookies.txt')), path.join(sandbox, 'cfg', 'cookies.txt'));
    assert.equal(resolveExistingPath('cfg/nao-existe.txt'), null);
    for (const bad of ['', null, undefined, 42]) assert.equal(resolveExistingPath(bad), null);
    // resolveBinaryPath: nome puro (PATH) e absoluto ficam; relativo com diretório vira absoluto
    assert.equal(resolveBinaryPath('yt-dlp.exe'), 'yt-dlp.exe');
    assert.equal(resolveBinaryPath(path.join(sandbox, 'yt-dlp.exe')), path.join(sandbox, 'yt-dlp.exe'));
    assert.equal(resolveBinaryPath('bin/yt-dlp.exe'), path.join(sandbox, 'bin', 'yt-dlp.exe'));
    assert.equal(resolveBinaryPath('./yt-dlp.exe'), path.join(sandbox, 'yt-dlp.exe'));
    // defesa em profundidade: mesmo se o chamador passar relativo, o construtor emite absoluto
    const flags = buildYtdlpAudioFlags(OUT, WATCH, { cookiesPath: 'cfg/cookies.txt', ffmpegPath: 'bin/ffmpeg.exe' });
    const cookiesArg = flags[flags.indexOf('--cookies') + 1];
    assert.ok(path.isAbsolute(cookiesArg) && fs.existsSync(cookiesArg), `cookies não absoluto: ${cookiesArg}`);
    assert.equal(flags[flags.indexOf('--ffmpeg-location') + 1], path.join(sandbox, 'bin', 'ffmpeg.exe'));
    const video = buildYtdlpVideoFlags(OUT, `https://www.youtube.com/shorts/${ID}`, { cookiesPath: 'cfg/cookies.txt' });
    assert.ok(path.isAbsolute(video[video.indexOf('--cookies') + 1]));
});

console.log('Limites por ambiente');
await test('padrões e valores configurados', () => {
    assert.deepEqual(readDownloadLimits({}), { maxMinutes: 20, maxFilesizeMB: 200, timeoutMs: 300000 });
    const custom = readDownloadLimits({ YUI_DL_MAX_MINUTES: '45', YUI_DL_MAX_FILESIZE_MB: '80', YUI_DL_TIMEOUT_SECONDS: '120' });
    assert.deepEqual(custom, { maxMinutes: 45, maxFilesizeMB: 80, timeoutMs: 120000 });
    assert.equal(readDownloadLimits({ YUI_DL_MAX_MINUTES: '0' }).maxMinutes, 0);
    assert.equal(readDownloadLimits({ YUI_DL_MAX_MINUTES: 'abc' }).maxMinutes, 20);
    assert.equal(readDownloadLimits({ YUI_DL_MAX_MINUTES: '-5' }).maxMinutes, 20);
    assert.equal(readDownloadLimits({ YUI_DL_TIMEOUT_SECONDS: '1' }).timeoutMs, 30000);
});

console.log('Pastas temporárias e nomes de arquivo');
await test('createRequestDir cria subpastas únicas; removeRequestDir só aceita subpastas UUID do root', () => {
    const root = path.join(sandbox, 'tmp-root');
    const a = createRequestDir(root);
    const b = createRequestDir(root);
    assert.notEqual(a, b);
    assert.ok(fs.existsSync(a) && fs.existsSync(b));
    fs.writeFileSync(path.join(a, 'x.mp3'), 'x');
    assert.equal(removeRequestDir(root, a), true);
    assert.ok(!fs.existsSync(a));
    assert.equal(removeRequestDir(root, root), false);
    assert.equal(removeRequestDir(root, path.join(root, '..')), false);
    assert.equal(removeRequestDir(root, path.join(root, 'nao-e-uuid')), false);
    assert.equal(removeRequestDir(root, path.join(a, 'filho')), false);
    assert.ok(fs.existsSync(b) && fs.existsSync(root));
});
await test('createRequestDir devolve caminho absoluto mesmo com root relativo (os binários rodam com cwd nela)', () => {
    const dir = createRequestDir('rel-root');
    assert.ok(path.isAbsolute(dir));
    assert.equal(path.dirname(dir), path.join(sandbox, 'rel-root'));
    assert.ok(fs.existsSync(dir));
    assert.equal(removeRequestDir('rel-root', dir), true);
});
await test('sweepStaleRequestDirs remove vazias antigas e paradas há muito tempo, nunca outras pastas', () => {
    const root = path.join(sandbox, 'sweep-root');
    const empty = createRequestDir(root);
    const busy = createRequestDir(root);
    fs.writeFileSync(path.join(busy, 'faixa.mp3'), 'x');
    const foreign = path.join(root, 'pasta-de-outro-modulo');
    fs.mkdirSync(foreign);
    fs.writeFileSync(path.join(root, 'arquivo-solto.mp3'), 'x');
    const now = Date.now();
    assert.equal(sweepStaleRequestDirs(root, { now }), 0, 'nada é velho ainda');
    assert.equal(sweepStaleRequestDirs(root, { now: now + 10 * 60 * 1000 }), 1, 'só a vazia');
    assert.ok(!fs.existsSync(empty) && fs.existsSync(busy));
    assert.equal(sweepStaleRequestDirs(root, { now: now + 25 * 3600 * 1000 }), 1, 'a parada há 24h+');
    assert.ok(!fs.existsSync(busy));
    assert.ok(fs.existsSync(foreign) && fs.existsSync(path.join(root, 'arquivo-solto.mp3')));
    assert.equal(sweepStaleRequestDirs(path.join(sandbox, 'nao-existe')), 0);
});
await test('safeFileStem', () => {
    assert.equal(safeFileStem('Minha: Música/Teste?'), 'Minha MúsicaTeste');
    assert.equal(safeFileStem('..'), 'audio');
    assert.equal(safeFileStem('???', 'video'), 'video');
    assert.equal(safeFileStem('CON'), '_CON');
    assert.equal(safeFileStem('nul'), '_nul');
    assert.equal(safeFileStem('a\u0000b\nc'), 'a b c');
    assert.equal(safeFileStem('fim com ponto...'), 'fim com ponto');
    assert.ok(safeFileStem('x '.repeat(200)).length <= 100);
});
await test('MediaError: código, mensagem amigável e nunca texto cru', () => {
    const err = new MediaError('VIDEO_PRIVATE', 'Frase amigável.', { detail: 'detalhe técnico' });
    assert.equal(err.code, 'VIDEO_PRIVATE');
    assert.equal(err.userMessage, 'Frase amigável.');
    assert.equal(err.message, 'VIDEO_PRIVATE: Frase amigável.');
    assert.equal(getMediaUserMessage(err), 'Frase amigável.');
    assert.ok(!getMediaUserMessage(new Error('ENOENT: caminho secreto C:\\x')).includes('secreto'));
});
await test('runTool: execFile com array, windowsHide e timeout; nunca rejeita', async () => {
    let seen;
    const run = await runTool('programa', ['a', 'b'], {
        timeoutMs: 1234,
        execFileImpl: (file, args, options, cb) => { seen = { file, args, options }; cb(null, 'saida', 'erro'); return { pid: 1 }; },
    });
    assert.deepEqual(seen.args, ['a', 'b']);
    assert.equal(seen.options.windowsHide, true);
    assert.equal(seen.options.timeout, 1234);
    assert.ok(seen.options.maxBuffer >= 10 * 1024 * 1024);
    assert.equal(run.stdout, 'saida');
    assert.equal(run.timedOut, false);
    const falha = await runTool('x', [], { execFileImpl: () => { throw new Error('boom'); } });
    assert.equal(falha.error.message, 'boom');
});
await test('runTool: o timer da rede de segurança dispara ANTES do timeout do Node (o taskkill leva ~250 ms)', async () => {
    // O taskkill /T /F leva ~250 ms até a raiz morrer. Se o timeout do Node matasse a raiz primeiro, o taskkill
    // responderia "processo não encontrado" e ffmpeg/deno ficariam órfãos. Confere o atraso pedido ao setTimeout.
    const expected = new Map([
        [300000, 295000], // 5 s de vantagem (teto)
        [30000, 25000],
        [9000, 6000], // 1/3 do prazo quando menor que 5 s de vantagem
        [600, 400],
        [60, 50], // piso de 50 ms
    ]);
    const realSetTimeout = globalThis.setTimeout;
    const delays = [];
    globalThis.setTimeout = (fn, ms, ...rest) => { delays.push(ms); return realSetTimeout(fn, ms, ...rest); };
    try {
        for (const [timeoutMs, wanted] of expected) {
            let seen;
            let pendingCallback;
            delays.length = 0;
            const pending = runTool('programa', [], {
                timeoutMs,
                execFileImpl: (file, args, options, cb) => { seen = options; pendingCallback = cb; return { pid: 7 }; },
                killImpl: () => {},
            });
            assert.equal(seen.timeout, timeoutMs, 'o timeout do execFile continua sendo o prazo inteiro (segunda rede)');
            assert.deepEqual(delays, [wanted], `timeoutMs ${timeoutMs}`);
            assert.ok(wanted < timeoutMs, 'o timer dispara antes do timeout do Node');
            pendingCallback(null, '', ''); // termina o pedido e limpa o timer
            await pending;
        }
    } finally {
        globalThis.setTimeout = realSetTimeout;
    }
});
await test('runTool: estourado o prazo, o killImpl recebe o filho e o resultado diz timedOut', async () => {
    let pendingCallback;
    const killed = [];
    const run = await runTool('programa', [], {
        timeoutMs: 600,
        execFileImpl: (file, args, options, cb) => { pendingCallback = cb; return { pid: 321 }; },
        killImpl: (child) => { killed.push(child.pid); pendingCallback(new Error('encerrado'), '', ''); },
    });
    assert.deepEqual(killed, [321]);
    assert.equal(run.timedOut, true);
});
const waitFor = async (condition, ms) => {
    const limit = Date.now() + ms;
    while (!condition() && Date.now() < limit) await new Promise((resolve) => setTimeout(resolve, 25));
    return condition();
};
await test('killProcessTree: só age sobre filho VIVO (o PID de um processo que já saiu pode ser de outro programa)', () => {
    for (const platform of ['win32', 'linux']) {
        const calls = [];
        const killed = [];
        const kill = (child) => killProcessTree(child, { platform, execFileImpl: (...args) => { calls.push(args); } });
        kill({ pid: 4101, exitCode: 0, signalCode: null, kill: (s) => killed.push(s) }); // saiu normalmente
        kill({ pid: 4102, exitCode: 1, signalCode: null, kill: (s) => killed.push(s) }); // saiu com erro
        kill({ pid: 4103, exitCode: null, signalCode: 'SIGTERM', kill: (s) => killed.push(s) }); // morto por sinal
        kill(null);
        kill(undefined);
        assert.equal(calls.length, 0, `${platform}: nenhum taskkill contra processo morto`);
        assert.deepEqual(killed, [], `${platform}: nenhum kill contra processo morto`);
    }
    // vivo (exitCode e signalCode nulos) ou dublê sem esses campos: age
    const calls = [];
    const execFileImpl = (file, args, options) => { calls.push({ file, args, options }); };
    killProcessTree({ pid: 4201, exitCode: null, signalCode: null }, { platform: 'win32', execFileImpl });
    killProcessTree({ pid: 4202 }, { platform: 'win32', execFileImpl });
    assert.deepEqual(calls.map((c) => [c.file, ...c.args]), [['taskkill', '/pid', '4201', '/T', '/F'], ['taskkill', '/pid', '4202', '/T', '/F']]);
    assert.equal(calls[0].options.windowsHide, true);
    const killed = [];
    killProcessTree({ pid: 4203, exitCode: null, signalCode: null, kill: (s) => killed.push(s) }, { platform: 'linux', execFileImpl: () => { throw new Error('não é para usar fora do Windows'); } });
    assert.deepEqual(killed, ['SIGKILL']);
    killProcessTree({ pid: 4204, exitCode: null, signalCode: null }, { platform: 'win32', execFileImpl: () => { throw new Error('boom'); } }); // melhor esforço: não lança
});
await test('runTool: raiz que JÁ saiu e neto segurando o pipe: o prazo encerra a espera, sem taskkill contra o PID morto', async () => {
    const calls = [];
    const started = Date.now();
    let guard;
    const pending = runTool('programa', [], {
        timeoutMs: 300, // timer antecipado em 200 ms
        execFileImpl: () => ({ pid: 4301, exitCode: 0, signalCode: null }), // o callback nunca vem: um neto segura o pipe
        killImpl: (child) => killProcessTree(child, { platform: 'win32', execFileImpl: (...args) => { calls.push(args); } }),
    });
    const stuck = new Promise((resolve) => { guard = setTimeout(() => resolve('PRESO'), 3000); });
    const run = await Promise.race([pending, stuck]);
    clearTimeout(guard);
    assert.notEqual(run, 'PRESO', 'o pedido ficou preso no pipe do neto');
    assert.equal(run.timedOut, true);
    assert.ok(run.error);
    assert.equal(run.error.code, 'ETIMEDOUT');
    assert.equal(calls.length, 0, 'nenhum taskkill contra um PID de processo morto');
    assert.ok(Date.now() - started < 1500);
});
await test('runTool: terminando antes do prazo, o timer da rede de segurança é limpo (nenhum kill depois, em PID reaproveitado)', async () => {
    const killed = [];
    const run = await runTool('programa', [], {
        timeoutMs: 120, // timer antecipado em 80 ms
        execFileImpl: (file, args, options, cb) => { setImmediate(() => cb(null, 'ok', '')); return { pid: 4401 }; },
        killImpl: (child) => killed.push(child.pid),
    });
    assert.equal(run.timedOut, false);
    await new Promise((resolve) => setTimeout(resolve, 250));
    assert.deepEqual(killed, [], 'o timer não pode disparar depois do fim do processo');
});
await test('removeRequestDir: apaga na hora quando consegue (sem tentativas no rmSync) e só aceita subpasta UUID', () => {
    const root = path.join(sandbox, 'retry-root');
    const dir = createRequestDir(root);
    fs.mkdirSync(path.join(dir, '_home', 'tmp'), { recursive: true });
    fs.writeFileSync(path.join(dir, '_home', 'tmp', 'x.bin'), 'x');
    const realRmSync = fs.rmSync;
    const seen = [];
    fs.rmSync = (target, options) => { seen.push({ target, options }); return realRmSync(target, options); };
    try {
        assert.equal(removeRequestDir(root, dir), true);
        assert.equal(removeRequestDir(root, path.join(root, 'nao-e-uuid')), false);
    } finally {
        fs.rmSync = realRmSync;
    }
    assert.equal(seen.length, 1, 'só a subpasta UUID chegou ao rmSync');
    assert.equal(seen[0].options.recursive, true);
    assert.equal(seen[0].options.force, true);
    assert.equal(seen[0].options.maxRetries, undefined, 'o rmSync síncrono não repete (e esperar travaria o laço de eventos)');
    assert.ok(!fs.existsSync(dir));
});
await test('removeRequestDir: se o rmSync falha (arquivo preso), devolve false NA HORA e a pasta é apagada em segundo plano, com tentativas', async () => {
    const root = path.join(sandbox, 'retry-bg-root');
    const dir = createRequestDir(root);
    fs.writeFileSync(path.join(dir, 'x.mp3'), 'x');
    const realRmSync = fs.rmSync;
    const realPromisesRm = fs.promises.rm;
    const background = [];
    let syncCalls = 0;
    fs.rmSync = () => { syncCalls++; throw Object.assign(new Error('EPERM: arquivo em uso'), { code: 'EPERM' }); };
    fs.promises.rm = (target, options) => { background.push({ target, options }); return realPromisesRm(target, options); };
    try {
        assert.equal(removeRequestDir(root, dir), false, 'não apagou agora');
        assert.equal(syncCalls, 1);
        assert.equal(background.length, 1, 'uma segunda chance em segundo plano');
        assert.equal(background[0].target, dir);
        assert.equal(background[0].options.recursive, true);
        assert.equal(background[0].options.force, true);
        assert.equal(background[0].options.maxRetries, 5);
        assert.equal(background[0].options.retryDelay, 200);
        assert.equal(removeRequestDir(root, path.join(root, 'nao-e-uuid')), false);
        assert.equal(background.length, 1, 'o que não é subpasta UUID não vai nem para o segundo plano');
    } finally {
        fs.rmSync = realRmSync;
    }
    try {
        assert.ok(await waitFor(() => !fs.existsSync(dir), 5000), 'a pasta deveria sumir em segundo plano');
    } finally {
        fs.promises.rm = realPromisesRm;
    }
    // falha também em segundo plano: não vira rejeição solta
    const other = createRequestDir(root);
    fs.rmSync = () => { throw new Error('EPERM'); };
    fs.promises.rm = () => Promise.reject(new Error('EBUSY'));
    try {
        assert.equal(removeRequestDir(root, other), false);
        await new Promise((resolve) => setTimeout(resolve, 30)); // uma rejeição sem catch derrubaria o processo
    } finally {
        fs.rmSync = realRmSync;
        fs.promises.rm = realPromisesRm;
    }
    assert.ok(fs.existsSync(other));
});
if (process.platform === 'win32') {
    await test('removeRequestDir (arquivo REALMENTE preso por outro processo): não trava, devolve false e a pasta some quando o arquivo é solto', async () => {
        const root = path.join(sandbox, 'lock-root');
        const dir = createRequestDir(root);
        const locked = path.join(dir, 'Artista - Faixa.mp3');
        fs.writeFileSync(locked, 'x');
        // Quem segura o arquivo (sem FILE_SHARE_DELETE, como o ffmpeg) é um PowerShell criado AQUI; ele o solta sozinho em ~700 ms.
        const holder = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
            `$f=[System.IO.File]::Open('${locked.replace(/'/g, "''")}','Open','ReadWrite','Read'); Write-Output 'LOCKED'; Start-Sleep -Milliseconds 700; $f.Close()`],
        { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
        const closed = new Promise((resolve) => holder.once('close', resolve));
        try {
            await new Promise((resolve, reject) => {
                const timer = setTimeout(() => reject(new Error('o PowerShell não segurou o arquivo em 30 s')), 30000);
                holder.stdout.on('data', (chunk) => { if (String(chunk).includes('LOCKED')) { clearTimeout(timer); resolve(); } });
            });
            const t0 = Date.now();
            assert.equal(removeRequestDir(root, dir), false, 'preso: não apagou agora');
            assert.ok(Date.now() - t0 < 500, 'e não ficou esperando o arquivo ser solto');
            assert.ok(fs.existsSync(dir));
            assert.ok(await waitFor(() => !fs.existsSync(dir), 10000), 'apagada em segundo plano depois que o arquivo foi solto');
        } finally {
            if (holder.exitCode === null && holder.signalCode === null) holder.kill(); // só o PowerShell que ESTE teste criou
            await closed;
        }
    });
}

// ---------------------------------------------------------------------------
console.log('Handlers com execFile falso (sem yt-dlp, sem rede)');
const yt = await import('../src/handlers/youtubeAudioHandler.js');
const sp = await import('../src/handlers/spotifyDownloadHandler.js');

function makeFakeExec(behavior) {
    const calls = [];
    const fn = (file, args, options, cb) => {
        calls.push({ file, args, options });
        const outIndex = args.indexOf('-o');
        const outTemplate = outIndex >= 0 ? args[outIndex + 1] : null;
        const result = behavior({ file, args, options, outTemplate, call: calls.length });
        setImmediate(() => cb(result.error || null, result.stdout || '', result.stderr || ''));
        return { pid: 4242, kill() {} };
    };
    fn.calls = calls;
    return fn;
}
function writeOutput(outTemplate, ext, size = 16) {
    fs.writeFileSync(outTemplate.replace('%(ext)s', ext), Buffer.alloc(size, 1));
}
function sandboxDeps(execFileImpl, extra = {}) {
    const tempRoot = fs.mkdtempSync(path.join(sandbox, 'root-'));
    return {
        tempRoot,
        deps: {
            execFileImpl,
            tempRoot,
            ytdlpPath: path.join(sandbox, 'yt-dlp.exe'),
            spotdlPath: 'spotdl', // nome puro: os dublês decidem por file === 'spotdl' e nunca tocam o .venv-spotdl real
            ffmpegPath: path.join(sandbox, 'ffmpeg-inexistente.exe'),
            cookiesPath: '',
            extraFlags: ['--ignore-config'],
            limits: { maxMinutes: 20, maxFilesizeMB: 200, timeoutMs: 5000 },
            killImpl: () => { throw new Error('não deveria matar nada neste teste'); },
            ...extra,
        },
    };
}
const okJson = (title, extra = {}) => `${JSON.stringify({ title, extractor_key: 'Youtube', ...extra })}\n`;
const ctx = { source: 'Slash', userId: '1', userTag: 'tester' };

await test('detectPlatform usa o normalizador (playlist pura deixa de ser URL_INVALID)', () => {
    assert.equal(yt.detectPlatform(WATCH), 'youtube');
    assert.equal(yt.detectPlatform(`https://music.youtube.com/watch?v=${ID}`), 'youtube_music');
    assert.equal(yt.detectPlatform(`https://www.youtube.com/shorts/${ID}`), 'youtube_shorts');
    assert.equal(yt.detectPlatform(PLAYLIST_URL), 'youtube');
    assert.equal(yt.detectPlatform('https://www.tiktok.com/@u/video/7123456789012345678'), 'tiktok');
    assert.equal(yt.detectPlatform('https://www.instagram.com/reel/CxYz123AbCd/'), 'instagram');
    assert.equal(yt.detectPlatform(`https://youtu.be/${ID}"&whoami&"`), null);
    assert.equal(yt.detectPlatform('https://exemplo.com/x'), null);
});

await test('wrappers exportados do handler devolvem arrays sem aspas', () => {
    const flags = yt.buildYtdlpAudioFlags(OUT, WATCH);
    assertNoQuotes(flags);
    assert.ok(flags.includes('--no-playlist'));
    assertNoQuotes(yt.buildYtdlpVideoFlags(OUT, `https://www.youtube.com/shorts/${ID}`, { playlistOnly: true }));
});

await test('downloadAudio: vídeo com list= baixa só o vídeo e avisa (playlistIgnored)', async () => {
    const exec = makeFakeExec(({ outTemplate }) => {
        writeOutput(outTemplate, 'mp3');
        return { stdout: okJson('Minha: Música/Teste') };
    });
    const { tempRoot, deps } = sandboxDeps(exec);
    const result = await yt.downloadAudio(`${WATCH}&index=2&list=${PL}`, ctx, deps);
    const call = exec.calls[0];
    assert.equal(call.file, deps.ytdlpPath);
    assertNoQuotes(call.args);
    assert.ok(call.args.includes('--no-playlist'));
    assert.ok(!call.args.includes('-I'));
    assert.ok(!call.args.includes('--max-downloads'));
    assert.equal(call.args[call.args.length - 1], WATCH, 'só a URL canônica chega ao yt-dlp');
    assert.equal(call.options.windowsHide, true);
    assert.equal(call.options.timeout, 5000);
    assert.equal(call.options.maxBuffer, 10 * 1024 * 1024);
    assert.equal(result.playlistIgnored, true);
    assert.equal(result.playlistOnly, false);
    assert.equal(result.metadata.title, 'Minha: Música/Teste');
    assert.equal(path.basename(result.filePath), 'Minha MúsicaTeste.mp3');
    assert.equal(path.dirname(path.dirname(result.filePath)), tempRoot, 'arquivo numa subpasta única do pedido');
    assert.ok(fs.existsSync(result.filePath));
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), [], 'cleanup apaga a subpasta inteira');
    result.cleanup();
});

await test('downloadAudio: playlist pura baixa só o 1º item (-I 1, sem --max-downloads) e avisa (playlistOnly)', async () => {
    const exec = makeFakeExec(({ outTemplate }) => {
        writeOutput(outTemplate, 'mp3');
        return { stdout: okJson('Primeira faixa') };
    });
    const { tempRoot, deps } = sandboxDeps(exec);
    const result = await yt.downloadAudio(PLAYLIST_URL, ctx, deps);
    const args = exec.calls[0].args;
    assert.ok(args.includes('--no-playlist'));
    assert.equal(args[args.indexOf('-I') + 1], '1');
    assert.ok(!args.some((a) => a.startsWith('--max-downloads')));
    assert.equal(args[args.length - 1], PLAYLIST_URL);
    assert.equal(result.playlistOnly, true);
    assert.equal(result.playlistIgnored, false);
    assert.equal(typeof result.filePath, 'string');
    assert.equal(typeof result.metadata, 'object');
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('downloadAudio: vídeo comum não tem os campos de playlist ligados', async () => {
    const exec = makeFakeExec(({ outTemplate }) => { writeOutput(outTemplate, 'mp3'); return { stdout: okJson('Solo') }; });
    const { deps } = sandboxDeps(exec);
    const result = await yt.downloadAudio(`https://youtu.be/${ID}`, ctx, deps);
    assert.equal(result.playlistIgnored, false);
    assert.equal(result.playlistOnly, false);
    result.cleanup();
});

await test('dois pedidos simultâneos do mesmo vídeo não colidem (subpastas únicas)', async () => {
    const exec = makeFakeExec(({ outTemplate }) => { writeOutput(outTemplate, 'mp3'); return { stdout: okJson('Mesmo título') }; });
    const { tempRoot, deps } = sandboxDeps(exec);
    const [a, b] = await Promise.all([yt.downloadAudio(WATCH, ctx, deps), yt.downloadAudio(WATCH, ctx, deps)]);
    assert.notEqual(path.dirname(a.filePath), path.dirname(b.filePath));
    assert.ok(fs.existsSync(a.filePath) && fs.existsSync(b.filePath));
    assert.equal(fs.readdirSync(tempRoot).length, 2);
    a.cleanup();
    assert.ok(fs.existsSync(b.filePath), 'limpar um pedido não apaga o do outro');
    b.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('downloadAudio: link com injeção é recusado sem rodar nada nem criar pasta', async () => {
    const exec = makeFakeExec(() => { throw new Error('não deveria executar'); });
    const { tempRoot, deps } = sandboxDeps(exec);
    for (const bad of [`https://youtu.be/${ID}"&whoami&"`, `${WATCH}\ncalc`, 'https://exemplo.com/x', '', null]) {
        await assert.rejects(() => yt.downloadAudio(bad, ctx, deps), (err) => err.code === 'URL_INVALID' && err instanceof MediaError);
    }
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('downloadAudio: erros do yt-dlp viram códigos amigáveis, sem vazar o detalhe técnico, e limpam a pasta', async () => {
    const cases = [
        [{ error: Object.assign(new Error('x'), { code: 1 }), stderr: 'ERROR: [youtube] abc: Private video. Sign in' }, 'VIDEO_PRIVATE'],
        [{ error: Object.assign(new Error('x'), { code: 1 }), stderr: 'ERROR: Sign in to confirm your age. This video may be inappropriate' }, 'VIDEO_AGE_RESTRICTED'],
        [{ error: Object.assign(new Error('x'), { code: 1 }), stderr: "ERROR: Sign in to confirm you're not a bot" }, 'YOUTUBE_BOT_CHECK'],
        [{ error: Object.assign(new Error('x'), { code: 1 }), stderr: 'ERROR: Requested format is not available' }, 'FORMAT_UNAVAILABLE'],
        [{ error: Object.assign(new Error('x'), { code: 1 }), stderr: 'ERROR: File is larger than max-filesize (300 bytes > 200 bytes). Aborting.' }, 'FILE_TOO_LARGE'],
        [{ error: Object.assign(new Error('x'), { code: 1 }), stdout: '[download] Video does not pass filter (!is_live&duration<=?1200), skipping ..' }, 'MEDIA_TOO_LONG'],
        [{ error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) }, 'YTDLP_NOT_INSTALLED'],
        [{ error: Object.assign(new Error('timeout'), { killed: true, signal: 'SIGTERM' }) }, 'DOWNLOAD_TIMEOUT'],
        [{ error: Object.assign(new Error('x'), { code: 1 }), stderr: 'ERROR: segredo-tecnico-123' }, 'YTDLP_ERROR'],
        // Código 0, JSON impresso, nenhum arquivo: é assim que o yt-dlp real trata o --max-filesize (modo quieto do --print-json)
        [{ stdout: okJson('Grande', { filesize_approx: 300 * 1024 * 1024 }) }, 'FILE_TOO_LARGE'],
        [{ stdout: okJson('Grande em partes', { requested_formats: [{ filesize: 150 * 1024 * 1024 }, { filesize_approx: 120 * 1024 * 1024 }] }) }, 'FILE_TOO_LARGE'],
        [{ stdout: okJson('Tamanho desconhecido') }, 'FILE_TOO_LARGE'],
        // Tamanho informado dentro do limite e mesmo assim sem arquivo: não é o limite de tamanho
        [{ stdout: okJson('Sem arquivo', { filesize_approx: 1000 }) }, 'OUTPUT_NOT_FOUND'],
        [{ stdout: '' }, 'MEDIA_TOO_LONG'], // yt-dlp sai com 0 sem baixar quando o --match-filters rejeita (sem JSON)
        [{ stdout: 'texto { solto }\n' }, 'MEDIA_TOO_LONG'], // chaves fora de uma linha JSON não contam como JSON
    ];
    for (const [result, expectedCode] of cases) {
        const exec = makeFakeExec(() => result);
        const { tempRoot, deps } = sandboxDeps(exec);
        await assert.rejects(() => yt.downloadAudio(WATCH, ctx, deps), (err) => {
            assert.equal(err.code, expectedCode);
            assert.ok(err instanceof MediaError);
            assert.ok(err.userMessage && !/segredo-tecnico|ENOENT|spawn/.test(err.userMessage + err.message), `vazou detalhe técnico em ${expectedCode}`);
            return true;
        }, expectedCode);
        assert.deepEqual(fs.readdirSync(tempRoot), [], `pasta temporária sobrou em ${expectedCode}`);
    }
});

await test('downloadAudio: arquivo acima do --max-filesize (código 0, JSON, sem arquivo) diz o limite em MB; sem limite vira OUTPUT_NOT_FOUND', async () => {
    const exec = makeFakeExec(() => ({ stdout: okJson('Enorme', { filesize_approx: 900 * 1024 * 1024 }) }));
    const a = sandboxDeps(exec);
    await assert.rejects(() => yt.downloadAudio(WATCH, ctx, a.deps), (err) => err.code === 'FILE_TOO_LARGE' && /200 MB/.test(err.userMessage));
    assert.deepEqual(fs.readdirSync(a.tempRoot), []);
    const b = sandboxDeps(exec, { limits: { maxMinutes: 20, maxFilesizeMB: 0, timeoutMs: 5000 } });
    await assert.rejects(() => yt.downloadAudio(WATCH, ctx, b.deps), (err) => err.code === 'OUTPUT_NOT_FOUND');
    // o Modo Rádio não tem limite de duração, mas o de tamanho continua valendo
    await assert.rejects(() => yt.downloadAudio(WATCH, { source: 'Modo Rádio', userId: '1' }, a.deps), (err) => err.code === 'FILE_TOO_LARGE');
    // vídeo (Shorts) segue a mesma regra
    await assert.rejects(() => yt.downloadVideo(`https://www.youtube.com/shorts/${ID}`, ctx, a.deps), (err) => err.code === 'FILE_TOO_LARGE');
});

await test('cookies/ffmpeg relativos do .env chegam ao yt-dlp como caminhos absolutos (o cwd do processo filho é a pasta do pedido)', async () => {
    fs.mkdirSync(path.join(sandbox, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'cfg', 'cookies.txt'), '# Netscape HTTP Cookie File\n');
    fs.writeFileSync(path.join(sandbox, 'cfg', 'ffmpeg.exe'), 'x');
    const exec = makeFakeExec(({ outTemplate }) => { writeOutput(outTemplate, 'mp3'); return { stdout: okJson('Com cookies') }; });
    const { deps } = sandboxDeps(exec, { cookiesPath: 'cfg/cookies.txt', ffmpegPath: 'cfg/ffmpeg.exe', ytdlpPath: 'cfg/yt-dlp.exe' });
    const result = await yt.downloadAudio(WATCH, ctx, deps);
    const call = exec.calls[0];
    const cookiesArg = call.args[call.args.indexOf('--cookies') + 1];
    const ffmpegArg = call.args[call.args.indexOf('--ffmpeg-location') + 1];
    assert.notEqual(path.resolve(call.options.cwd), path.resolve(process.cwd()), 'o processo filho roda em outro diretório');
    for (const arg of [cookiesArg, ffmpegArg, call.file]) assert.ok(path.isAbsolute(arg), `caminho relativo chegou ao filho: ${arg}`);
    assert.equal(cookiesArg, path.join(sandbox, 'cfg', 'cookies.txt'));
    assert.ok(fs.existsSync(cookiesArg) && fs.existsSync(ffmpegArg));
    result.cleanup();
    // cookies que não existem são ignorados (como antes)
    const semArquivo = sandboxDeps(exec, { cookiesPath: 'cfg/nao-existe.txt' });
    (await yt.downloadAudio(WATCH, ctx, semArquivo.deps)).cleanup();
    assert.ok(!exec.calls[1].args.includes('--cookies'));
    // vídeo (Shorts) também
    const videoExec = makeFakeExec(({ outTemplate }) => { writeOutput(outTemplate, 'mp4'); return { stdout: okJson('V') }; });
    const video = await yt.downloadVideo(`https://www.youtube.com/shorts/${ID}`, ctx, sandboxDeps(videoExec, { cookiesPath: 'cfg/cookies.txt' }).deps);
    const videoArgs = videoExec.calls[0].args;
    assert.equal(videoArgs[videoArgs.indexOf('--cookies') + 1], path.join(sandbox, 'cfg', 'cookies.txt'));
    video.cleanup();
});

await test('downloadAudio: a rede de segurança derruba a árvore de processos no timeout', async () => {
    let pendingCallback = null;
    const killed = [];
    const exec = (file, args, options, cb) => { pendingCallback = cb; return { pid: 999 }; };
    const { tempRoot, deps } = sandboxDeps(exec, {
        limits: { maxMinutes: 20, maxFilesizeMB: 200, timeoutMs: 300 },
        killImpl: (child) => { killed.push(child.pid); pendingCallback(new Error('encerrado'), '', ''); },
    });
    await assert.rejects(() => yt.downloadAudio(WATCH, ctx, deps), (err) => err.code === 'DOWNLOAD_TIMEOUT');
    assert.deepEqual(killed, [999]);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('downloadAudio: limite de duração vale para usuários (e respeita o que cabe no upload), mas não para o Modo Rádio', async () => {
    const exec = makeFakeExec(({ outTemplate }) => { writeOutput(outTemplate, 'mp3'); return { stdout: okJson('Set longo') }; });
    const { deps } = sandboxDeps(exec);
    const comum = await yt.downloadAudio(WATCH, ctx, deps);
    comum.cleanup();
    const radio = await yt.downloadAudio(WATCH, { source: 'Modo Rádio', userId: '1' }, deps);
    radio.cleanup();
    const [argsComum, argsRadio] = exec.calls.map((c) => c.args);
    // 13 min (780 s): o que ainda cabe nos 10 MB a 96 kbps, o último degrau da recompressão; menor que os 20 min do YUI_DL_MAX_MINUTES
    assert.equal(argsComum[argsComum.indexOf('--match-filters') + 1], '!is_live&duration<=?780');
    assert.ok(!argsRadio.includes('--match-filters'));
    assert.ok(argsRadio.includes('--max-filesize'), 'o limite de tamanho continua valendo');

    // com a recompressão desligada não há o teto prévio por upload: vale o YUI_DL_MAX_MINUTES (20 min)
    (await yt.downloadAudio(WATCH, ctx, { ...deps, env: { YUI_AUDIO_REENCODE: 'false' } })).cleanup();
    const argsOff = exec.calls[2].args;
    assert.equal(argsOff[argsOff.indexOf('--match-filters') + 1], '!is_live&duration<=?1200');

    // um YUI_DL_MAX_MINUTES menor que o teto do upload continua mandando
    (await yt.downloadAudio(WATCH, ctx, { ...deps, limits: { ...deps.limits, maxMinutes: 5 } })).cleanup();
    const argsCurto = exec.calls[3].args;
    assert.equal(argsCurto[argsCurto.indexOf('--match-filters') + 1], '!is_live&duration<=?300');
});

await test('downloadVideo: YouTube comum segue bloqueado; Shorts funciona; TikTok de perfil leva -I 1', async () => {
    const exec = makeFakeExec(({ outTemplate }) => { writeOutput(outTemplate, 'mp4', 64); return { stdout: okJson('Curto', { extractor_key: 'TikTok' }) }; });
    const { tempRoot, deps } = sandboxDeps(exec);
    await assert.rejects(() => yt.downloadVideo(WATCH, ctx, deps), (err) => err.code === 'YOUTUBE_FULL_VIDEO');
    await assert.rejects(() => yt.downloadVideo(`https://music.youtube.com/watch?v=${ID}`, ctx, deps), (err) => err.code === 'YOUTUBE_FULL_VIDEO');
    await assert.rejects(() => yt.downloadVideo(`https://youtu.be/${ID}"&whoami&"`, ctx, deps), (err) => err.code === 'URL_INVALID');
    assert.equal(exec.calls.length, 0);

    const shorts = await yt.downloadVideo(`https://www.youtube.com/shorts/${ID}?feature=share`, ctx, deps);
    const shortsArgs = exec.calls[0].args;
    assertNoQuotes(shortsArgs);
    assert.ok(shortsArgs.includes('--no-playlist'));
    assert.ok(!shortsArgs.includes('-I'));
    assert.equal(shortsArgs[shortsArgs.length - 1], `https://www.youtube.com/shorts/${ID}`);
    assert.equal(shorts.fileSize, 64);
    assert.equal(shorts.playlistIgnored, false);
    assert.equal(shorts.playlistOnly, false);
    assert.equal(path.basename(shorts.filePath), 'Curto.mp4');
    shorts.cleanup();

    const perfil = await yt.downloadVideo('https://www.tiktok.com/@usuario', ctx, deps);
    const perfilArgs = exec.calls[1].args;
    assert.equal(perfilArgs[perfilArgs.indexOf('-I') + 1], '1');
    assert.ok(!perfilArgs.includes('--max-downloads'));
    assert.equal(perfil.playlistOnly, true);
    perfil.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('cleanupDownload apaga a pasta do pedido (ou só o arquivo, sem cleanup)', async () => {
    const exec = makeFakeExec(({ outTemplate }) => { writeOutput(outTemplate, 'mp3'); return { stdout: okJson('Limpar') }; });
    const { tempRoot, deps } = sandboxDeps(exec);
    const result = await yt.downloadAudio(WATCH, ctx, deps);
    yt.cleanupDownload(result);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
    const solto = path.join(sandbox, 'solto.mp3');
    fs.writeFileSync(solto, 'x');
    yt.cleanupDownload({ filePath: solto });
    assert.ok(!fs.existsSync(solto));
    yt.cleanupDownload(null);
});

await test('Spotify: álbum, playlist e links inválidos são recusados sem executar nada', async () => {
    const exec = makeFakeExec(() => { throw new Error('não deveria executar'); });
    const { tempRoot, deps } = sandboxDeps(exec);
    for (const kind of ['album', 'playlist', 'artist', 'show', 'episode']) {
        await assert.rejects(() => sp.downloadSpotify(`https://open.spotify.com/${kind}/${SP}`, ctx, deps),
            (err) => err.code === 'SPOTIFY_ONLY_TRACK' && /faixa/.test(err.userMessage));
    }
    for (const bad of [`https://open.spotify.com/track/${SP}"&whoami&"`, WATCH, '', null]) {
        await assert.rejects(() => sp.downloadSpotify(bad, ctx, deps), (err) => err.code === 'SPOTIFY_INVALID_URL');
    }
    assert.equal(exec.calls.length, 0);
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('Spotify: faixa usa spotdl com array de argumentos e URL canônica', async () => {
    const exec = makeFakeExec(({ file, args }) => {
        const dir = args[args.indexOf('--output') + 1];
        fs.writeFileSync(path.join(dir, 'Artista - Faixa.mp3'), Buffer.alloc(32, 1));
        return {};
    });
    const { tempRoot, deps } = sandboxDeps(exec);
    const result = await sp.downloadSpotify(`https://open.spotify.com/intl-pt/track/${SP}?si=abc`, ctx, deps);
    const call = exec.calls[0];
    assert.equal(call.file, 'spotdl');
    assertNoQuotes(call.args);
    assert.equal(call.args[0], 'download');
    assert.equal(call.args[1], `https://open.spotify.com/track/${SP}`);
    assert.equal(call.options.windowsHide, true);
    assert.equal(path.dirname(path.dirname(result.filePath)), tempRoot);
    assert.equal(result.metadata.provider, 'spot-dlp');
    assert.equal(result.metadata.title, 'Artista - Faixa');
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('Spotify: sem spotdl cai no yt-dlp; sem os dois, erro claro e pasta limpa', async () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const fallbackExec = makeFakeExec(({ file, outTemplate }) => {
        if (file === 'spotdl') return { error: missing };
        writeOutput(outTemplate, 'mp3');
        return { stdout: okJson('Via yt-dlp') };
    });
    const first = sandboxDeps(fallbackExec);
    const result = await sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, ctx, first.deps);
    assert.equal(result.metadata.provider, 'yt-dlp');
    const ytArgs = fallbackExec.calls[1].args;
    assertNoQuotes(ytArgs);
    assert.equal(ytArgs[ytArgs.indexOf('--audio-quality') + 1], '2');
    assert.equal(ytArgs[ytArgs.length - 1], `https://open.spotify.com/track/${SP}`);
    result.cleanup();

    const nothingExec = makeFakeExec(() => ({ error: missing }));
    const second = sandboxDeps(nothingExec);
    await assert.rejects(() => sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, ctx, second.deps),
        (err) => err.code === 'SPOTIFY_UNAVAILABLE' && !/ENOENT/.test(err.userMessage));
    assert.deepEqual(fs.readdirSync(second.tempRoot), []);
});

await test('Spotify via yt-dlp sem título no JSON: o nome de reserva é neutro (musica), nunca "spotify_download"', async () => {
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    for (const stdout of ['saída sem nenhum json', JSON.stringify({ id: 'x1' }), JSON.stringify({ title: '', track: '' })]) {
        const exec = makeFakeExec(({ file, outTemplate }) => {
            if (file === 'spotdl') return { error: missing };
            writeOutput(outTemplate, 'mp3');
            return { stdout };
        });
        const { deps } = sandboxDeps(exec);
        const result = await sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, ctx, deps);
        assert.equal(result.metadata.title, 'musica', stdout);
        assert.ok(!/spotify|youtube|deezer/i.test(path.basename(result.filePath)), result.filePath);
        result.cleanup();
    }
});

await test('Spotify: cookies/ffmpeg/yt-dlp relativos viram absolutos (spotdl e yt-dlp rodam com cwd na pasta do pedido)', async () => {
    fs.mkdirSync(path.join(sandbox, 'cfg'), { recursive: true });
    fs.writeFileSync(path.join(sandbox, 'cfg', 'cookies.txt'), '# Netscape HTTP Cookie File\n');
    fs.writeFileSync(path.join(sandbox, 'cfg', 'ffmpeg.exe'), 'x');
    const missing = Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const exec = makeFakeExec(({ file, outTemplate }) => {
        if (file === 'spotdl') return { error: missing };
        writeOutput(outTemplate, 'mp3');
        return { stdout: okJson('Via yt-dlp') };
    });
    const { deps } = sandboxDeps(exec, { cookiesPath: 'cfg/cookies.txt', ffmpegPath: 'cfg/ffmpeg.exe', ytdlpPath: 'cfg/yt-dlp.exe' });
    const result = await sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, ctx, deps);
    const [spotdlCall, ytCall] = exec.calls;
    assert.equal(spotdlCall.args[spotdlCall.args.indexOf('--ffmpeg') + 1], path.join(sandbox, 'cfg', 'ffmpeg.exe'));
    assert.ok(path.isAbsolute(spotdlCall.args[spotdlCall.args.indexOf('--output') + 1]), 'saída do spotdl absoluta');
    assert.equal(ytCall.file, path.join(sandbox, 'cfg', 'yt-dlp.exe'));
    assert.equal(ytCall.args[ytCall.args.indexOf('--cookies') + 1], path.join(sandbox, 'cfg', 'cookies.txt'));
    assert.equal(ytCall.args[ytCall.args.indexOf('--ffmpeg-location') + 1], path.join(sandbox, 'cfg', 'ffmpeg.exe'));
    result.cleanup();
});

// ---------------------------------------------------------------------------
console.log('Comando /baixar_musica (dublês, sem Discord)');
const { baixarMusicaCommand, playlistNote, getAttachmentLimit } = await import('../src/discord/commands/baixarMusica.js');
const { MEDIA_MESSAGES } = await import('../src/utils/mediaUrls.js');

function fakeInteraction({ url = null, busca = null, guild = null, userId = '4242' } = {}) {
    const sent = [];
    return {
        sent,
        user: { id: userId, tag: 'tester#0001' },
        guild,
        options: { getString: (name) => (name === 'url' ? url : (name === 'busca' ? busca : null)) },
        deferReply: async () => {},
        reply: async (payload) => { sent.push({ kind: 'reply', payload }); },
        editReply: async (payload) => { sent.push({ kind: 'edit', payload }); },
    };
}
function lastEdit(interaction) {
    return interaction.sent.filter((s) => s.kind === 'edit').pop().payload;
}
function fakeDownload({ size = 32, playlistIgnored = false, playlistOnly = false, title = 'Faixa `legal` @everyone' } = {}) {
    const dir = fs.mkdtempSync(path.join(sandbox, 'cmd-'));
    const filePath = path.join(dir, 'faixa.mp3');
    fs.writeFileSync(filePath, Buffer.alloc(size, 1));
    const result = {
        filePath, metadata: { title, provider: 'spot-dlp' }, playlistIgnored, playlistOnly, cleaned: 0,
        cleanup() { result.cleaned++; fs.rmSync(dir, { recursive: true, force: true }); },
    };
    return result;
}

await test('link inválido ou com injeção: frase amigável, sem código nem erro cru, e libera o bloqueio do usuário', async () => {
    for (const bad of [`https://youtu.be/${ID}"&whoami&"`, 'https://exemplo.com/x']) {
        const interaction = fakeInteraction({ url: bad });
        await baixarMusicaCommand.execute(interaction);
        const payload = lastEdit(interaction);
        assert.equal(payload.embeds[0].data.description, MEDIA_MESSAGES.URL_INVALID);
        assert.ok(!/URL_INVALID|whoami/.test(JSON.stringify(payload)));
        assert.equal(yt.isUserBusy('4242'), false);
    }
});
await test('Spotify de álbum/playlist: avisa que só links de faixa funcionam', async () => {
    const interaction = fakeInteraction({ url: `https://open.spotify.com/album/${SP}` });
    await baixarMusicaCommand.execute(interaction);
    assert.equal(lastEdit(interaction).embeds[0].data.description, MEDIA_MESSAGES.SPOTIFY_ONLY_TRACK);
});
await test('erro inesperado não vaza o texto cru para o usuário', async () => {
    const interaction = fakeInteraction({ url: WATCH });
    await baixarMusicaCommand.execute(interaction, {
        downloadAudio: async () => { throw new Error('ENOENT: C:\\Users\\segredo\\yt-dlp.exe'); },
    });
    const description = lastEdit(interaction).embeds[0].data.description;
    assert.ok(description && !/segredo|ENOENT/.test(description));
    assert.equal(yt.isUserBusy('4242'), false);
});
await test('YouTube com list=: mostra a linha discreta de playlist e limpa a pasta do pedido', async () => {
    const download = fakeDownload({ playlistIgnored: true });
    const interaction = fakeInteraction({ url: `${WATCH}&list=${PL}` });
    await baixarMusicaCommand.execute(interaction, { downloadAudio: async () => download });
    const payload = lastEdit(interaction);
    assert.ok(payload.content.includes('\n-# O link tinha uma playlist; baixei só este vídeo.'));
    assert.deepEqual(payload.allowedMentions, { parse: [] });
    assert.equal(payload.files.length, 1);
    assert.ok(!payload.content.slice(0, payload.content.indexOf('\n')).includes('`legal`'), 'crases do título não quebram o trecho de código');
    assert.equal(download.cleaned, 1);
    assert.ok(!fs.existsSync(download.filePath));
});
await test('playlist pura: linha "baixei só a primeira faixa"; vídeo comum: sem linha extra', async () => {
    const only = fakeDownload({ playlistOnly: true });
    const a = fakeInteraction({ url: PLAYLIST_URL });
    await baixarMusicaCommand.execute(a, { downloadAudio: async () => only });
    assert.ok(lastEdit(a).content.includes('\n-# Link de playlist: baixei só a primeira faixa.'));
    const plain = fakeDownload();
    const b = fakeInteraction({ url: WATCH });
    await baixarMusicaCommand.execute(b, { downloadAudio: async () => plain });
    assert.ok(!lastEdit(b).content.includes('-#'));
    assert.equal(playlistNote({}), '');
});
await test('YouTube: arquivo acima do limite de upload do servidor (10 MB) vira aviso (sem anexar) e a pasta é limpa', async () => {
    const big = fakeDownload({ size: 11 * 1024 * 1024 });
    const interaction = fakeInteraction({ url: WATCH, guild: { premiumTier: 0 } });
    await baixarMusicaCommand.execute(interaction, { downloadAudio: async () => big });
    const payload = lastEdit(interaction);
    assert.equal(payload.files, undefined);
    assert.match(payload.embeds[0].data.title, /muito grande/);
    assert.match(payload.embeds[0].data.description, /11 MB/);
    assert.match(payload.embeds[0].data.description, /10 MB/);
    assert.doesNotMatch(payload.embeds[0].data.description, /25 MB/);
    assert.equal(big.cleaned, 1);
    const tier2 = fakeDownload({ size: 26 * 1024 * 1024 });
    const ok = fakeInteraction({ url: WATCH, guild: { premiumTier: 2 } });
    await baixarMusicaCommand.execute(ok, { downloadAudio: async () => tier2 });
    assert.equal(lastEdit(ok).files.length, 1, 'servidor com boost 2 aceita 26 MB');
    // o limite é o mesmo de uploadLimit.js: 10 MiB com a folga de 0,95 (9.961.472 bytes), 50 e 100 MiB nos níveis 2 e 3
    assert.equal(getAttachmentLimit(null), Math.floor(10 * 1024 * 1024 * 0.95));
    assert.equal(getAttachmentLimit(null), getUploadLimitBytes(null));
    assert.ok(getAttachmentLimit(null) < 10_000_000, 'abaixo de 10 MB mesmo na leitura decimal');
    assert.equal(getAttachmentLimit({ premiumTier: 2 }), Math.floor(50 * 1024 * 1024 * 0.95));
    assert.equal(getAttachmentLimit({ premiumTier: 3 }), Math.floor(100 * 1024 * 1024 * 0.95));
});
await test('Spotify (faixa): envia e limpa a pasta do pedido', async () => {
    const download = fakeDownload();
    const interaction = fakeInteraction({ url: `https://open.spotify.com/track/${SP}` });
    await baixarMusicaCommand.execute(interaction, { downloadSpotify: async () => download });
    const payload = lastEdit(interaction);
    assert.equal(payload.files.length, 1);
    assert.match(payload.embeds[0].data.title, /Download Conclu/);
    assert.equal(download.cleaned, 1);
});
await test('Spotify (faixa) SEM título: o anexo usa o nome neutro musica.mp3 (nunca spotify.mp3) e o cartão não cita a origem', async () => {
    for (const title of ['', undefined, '   ']) {
        const download = fakeDownload({ title });
        download.metadata.title = title;
        const interaction = fakeInteraction({ url: `https://open.spotify.com/track/${SP}` });
        await baixarMusicaCommand.execute(interaction, { downloadSpotify: async () => download });
        const payload = lastEdit(interaction);
        assert.equal(payload.files.length, 1);
        assert.equal(payload.files[0].name, 'musica.mp3', JSON.stringify(title));
        assert.ok(!/spotify|youtube|deezer/i.test(JSON.stringify(payload.embeds[0].data) + payload.files[0].name), JSON.stringify(payload.embeds[0].data));
        assert.equal(download.cleaned, 1);
    }
});
function fakeDeezerResult({ fallback = false, title = 'Faixa `x` @everyone', artist = 'Artista' } = {}) {
    const dir = fs.mkdtempSync(path.join(sandbox, 'dz-'));
    const filePath = path.join(dir, 'faixa.mp3');
    fs.writeFileSync(filePath, Buffer.alloc(32, 1));
    const track = { id: 1, title, artist };
    const result = { success: true, filePath, attachment: { name: 'faixa.mp3' }, track, cleaned: 0 };
    result.cleanup = () => { result.cleaned++; fs.rmSync(dir, { recursive: true, force: true }); };
    if (fallback) {
        // o plano B entrega a MESMA faixa (título e artista originais) com um aviso neutro de qualidade
        result.originalTrack = track;
        result.fallback = { source: 'youtube', reason: 'DEEMIX_ERROR', youtubeTitle: 'Faixa (Official)' };
        result.notice = '⚠️ Aviso: a qualidade desta faixa pode ser menor que a original.';
    }
    return result;
}

await test('formatDeezerDelivery: texto NEUTRO (sem origem); o plano B só avisa a qualidade; aviso que cita a origem é trocado pelo padrão', () => {
    const normal = formatDeezerDelivery(fakeDeezerResult());
    assert.equal(normal.viaFallback, false);
    const flat = (text) => text.replace(/\s+/g, ' '); // as crases do título viram espaços
    assert.ok(flat(normal.text).startsWith('✅ Música baixada: `Faixa x @everyone - Artista`'));
    assert.ok(!mentionsOrigin(normal.text), normal.text);
    const plano = fakeDeezerResult({ fallback: true });
    const b = formatDeezerDelivery(plano);
    assert.equal(b.viaFallback, true);
    assert.ok(b.text.includes('a qualidade desta faixa pode ser menor que a original'), 'o aviso neutro chega ao usuário');
    assert.ok(!mentionsOrigin(b.text), b.text);
    assert.ok(!/alta qualidade/i.test(b.text));
    assert.ok(flat(b.text).includes('`Faixa x @everyone - Artista`'));
    // aviso próprio sem origem vale; com a origem (texto antigo) é trocado pelo padrão; sem aviso usa o padrão; nunca lança
    assert.ok(formatDeezerDelivery({ ...plano, notice: 'Aviso: qualidade reduzida.' }).text.startsWith('Aviso: qualidade reduzida.'));
    for (const antigo of [
        '⚠️ Não consegui baixar pelo Deezer, então baixei do YouTube. A qualidade pode ser menor.',
        'veio do Spotify', 'via yt-dlp', 'spotdl', 'deemix',
    ]) {
        const out = formatDeezerDelivery({ ...plano, notice: antigo });
        assert.ok(!mentionsOrigin(out.text), out.text);
        assert.ok(out.text.includes('a qualidade desta faixa pode ser menor'));
    }
    assert.ok(formatDeezerDelivery({ ...plano, notice: undefined }).text.includes('a qualidade desta faixa pode ser menor'));
    // título e artista enormes são cortados (200 e 100)
    const longo = formatDeezerDelivery({ track: { title: 'T'.repeat(5000), artist: 'A'.repeat(5000) } });
    assert.ok(longo.text.length < 400, `texto longo demais: ${longo.text.length}`);
    assert.equal(formatDeezerDelivery(null).viaFallback, false);
    assert.equal(formatDeezerDelivery(null).text, '✅ Música baixada: ``');
    assert.equal(codeSafe('a`b\nc'), 'a b c');
});

await test('mentionsOrigin / isUploadTooLargeError reconhecem o que devem', () => {
    for (const bad of ['Deezer', 'do YouTube', 'youtu.be/x', 'via Spotify', 'spot-dlp', 'spotdlp', 'yt-dlp', 'ytdlp', 'spotdl', 'deemix', 'DEEZER']) assert.equal(mentionsOrigin(bad), true, bad);
    for (const ok of ['Música baixada: Faixa - Artista', 'Aviso: qualidade menor', '', null, undefined]) assert.equal(mentionsOrigin(ok), false, String(ok));
    assert.equal(isUploadTooLargeError({ code: 40005 }), true);
    assert.equal(isUploadTooLargeError({ status: 413 }), true);
    assert.equal(isUploadTooLargeError({ statusCode: 413 }), true);
    assert.equal(isUploadTooLargeError(new Error('Request entity too large')), true);
    assert.equal(isUploadTooLargeError({ code: 50013 }), false);
    assert.equal(isUploadTooLargeError(new Error('outro erro')), false);
    assert.equal(isUploadTooLargeError(null), false);
});

await test('/baixar_musica busca: sucesso normal e plano B com texto neutro; a pasta é limpa nos dois', async () => {
    const normal = fakeDeezerResult();
    const a = fakeInteraction({ busca: 'faixa artista' });
    await baixarMusicaCommand.execute(a, { handleMusicSearchAndDownload: async () => normal });
    const pa = lastEdit(a);
    assert.match(pa.content, /^✅ Música baixada: /);
    assert.ok(!mentionsOrigin(pa.content), pa.content);
    assert.deepEqual(pa.allowedMentions, { parse: [] });
    assert.equal(pa.files.length, 1);
    assert.equal(normal.cleaned, 1, 'limpou uma única vez');

    const plano = fakeDeezerResult({ fallback: true });
    const b = fakeInteraction({ busca: 'faixa artista' });
    await baixarMusicaCommand.execute(b, { handleMusicSearchAndDownload: async () => plano });
    const pb = lastEdit(b);
    assert.ok(pb.content.includes('a qualidade desta faixa pode ser menor que a original'));
    assert.ok(!mentionsOrigin(pb.content), pb.content);
    assert.ok(!/alta qualidade/i.test(pb.content));
    assert.deepEqual(pb.allowedMentions, { parse: [] });
    assert.equal(plano.cleaned, 1);
    assert.ok(!fs.existsSync(plano.filePath));
});

await test('/baixar_musica busca: faixa acima do limite DO SERVIDOR não é anexada (aviso claro) e a pasta é limpa', async () => {
    const big = fakeDeezerResult();
    fs.writeFileSync(big.filePath, Buffer.alloc(11 * 1024 * 1024, 1));
    const a = fakeInteraction({ busca: 'faixa artista', guild: { premiumTier: 0 } });
    await baixarMusicaCommand.execute(a, { handleMusicSearchAndDownload: async () => big });
    const payload = lastEdit(a);
    assert.equal(payload.files, undefined);
    assert.match(payload.embeds[0].data.title, /muito grande/);
    assert.match(payload.embeds[0].data.description, /11 MB/);
    assert.match(payload.embeds[0].data.description, /10 MB/);
    assert.equal(big.cleaned, 1);

    const tier2 = fakeDeezerResult();
    fs.writeFileSync(tier2.filePath, Buffer.alloc(11 * 1024 * 1024, 1));
    const b = fakeInteraction({ busca: 'faixa artista', guild: { premiumTier: 2 } });
    await baixarMusicaCommand.execute(b, { handleMusicSearchAndDownload: async () => tier2 });
    assert.equal(lastEdit(b).files.length, 1, 'servidor com boost 2 aceita 11 MB');
    assert.equal(tier2.cleaned, 1);
});

await test('/baixar_musica busca: erro 40005 no envio vira frase curta e clara (sem texto cru) e a pasta é limpa', async () => {
    const result = fakeDeezerResult();
    const interaction = fakeInteraction({ busca: 'faixa artista' });
    let calls = 0;
    interaction.editReply = async (payload) => {
        calls++;
        if (calls === 1) throw Object.assign(new Error('Request entity too large'), { code: 40005, status: 413 });
        interaction.sent.push({ kind: 'edit', payload });
    };
    await baixarMusicaCommand.execute(interaction, { handleMusicSearchAndDownload: async () => result });
    const payload = lastEdit(interaction);
    assert.match(payload.embeds[0].data.title, /muito grande/);
    assert.equal(payload.embeds[0].data.description, MEDIA_MESSAGES.UPLOAD_TOO_LARGE);
    assert.ok(!/40005|entity|413/.test(JSON.stringify(payload)), 'o texto cru da API não vaza');
    assert.equal(result.cleaned, 1);
    assert.equal(yt.isUserBusy('4242'), false);
});

await test('/baixar_musica busca: o erro devolvido eco da consulta não marca ninguém e vai cortado', async () => {
    const interaction = fakeInteraction({ busca: 'x' });
    await baixarMusicaCommand.execute(interaction, { handleMusicSearchAndDownload: async () => ({ error: `Nenhuma música encontrada para "@everyone ${'z'.repeat(4000)}".` }) });
    const payload = lastEdit(interaction);
    assert.ok(payload.content.length <= 2000, `conteúdo com ${payload.content.length} caracteres`);
    assert.deepEqual(payload.allowedMentions, { parse: [] });
});

await test('/baixar_musica busca: se o envio falhar, a pasta temporária ainda é limpa', async () => {
    const result = fakeDeezerResult();
    const interaction = fakeInteraction({ busca: 'faixa artista' });
    let calls = 0;
    interaction.editReply = async (payload) => {
        calls++;
        if (calls === 1) throw new Error('Request entity too large');
        interaction.sent.push({ kind: 'edit', payload });
    };
    await baixarMusicaCommand.execute(interaction, { handleMusicSearchAndDownload: async () => result });
    assert.equal(result.cleaned, 1);
    assert.ok(!/entity|large/i.test(JSON.stringify(lastEdit(interaction))), 'erro cru não vaza');
    assert.equal(yt.isUserBusy('4242'), false);
});

await test('usuário com download em andamento recebe aviso efêmero', async () => {
    yt.lockUser('777');
    try {
        const interaction = fakeInteraction({ url: WATCH, userId: '777' });
        await baixarMusicaCommand.execute(interaction, { downloadAudio: async () => { throw new Error('não deveria baixar'); } });
        assert.equal(interaction.sent[0].kind, 'reply');
        assert.equal(interaction.sent[0].payload.ephemeral, true);
    } finally {
        yt.unlockUser('777');
    }
});

await test('teto global de downloads simultâneos (YUI_DL_MAX_CONCURRENT): o 4º usuário é barrado com aviso próprio; limite 0 desliga', async () => {
    assert.equal(readMaxConcurrentDownloads({}), 3);
    assert.equal(readMaxConcurrentDownloads({ YUI_DL_MAX_CONCURRENT: '5' }), 5);
    assert.equal(readMaxConcurrentDownloads({ YUI_DL_MAX_CONCURRENT: ' 2 ' }), 2);
    assert.equal(readMaxConcurrentDownloads({ YUI_DL_MAX_CONCURRENT: '0' }), 0);
    assert.equal(readMaxConcurrentDownloads({ YUI_DL_MAX_CONCURRENT: 'abc' }), 3);
    assert.equal(readMaxConcurrentDownloads({ YUI_DL_MAX_CONCURRENT: '-2' }), 3);
    assert.equal(readMaxConcurrentDownloads({ YUI_DL_MAX_CONCURRENT: '9999' }), 50);

    const saved = process.env.YUI_DL_MAX_CONCURRENT;
    delete process.env.YUI_DL_MAX_CONCURRENT;
    const ids = ['g1', 'g2', 'g3'];
    for (const id of ids) yt.lockUser(id);
    try {
        assert.equal(yt.isUserBusy('g4'), true, 'o 4º usuário é barrado');
        assert.equal(yt.getBusyReason('g4'), 'global');
        assert.equal(yt.getBusyReason('g1'), 'user', 'quem já tem download em andamento continua com o motivo próprio');
        const interaction = fakeInteraction({ url: WATCH, userId: 'g4' });
        await baixarMusicaCommand.execute(interaction, { downloadAudio: async () => { throw new Error('não deveria baixar'); } });
        assert.equal(interaction.sent[0].kind, 'reply');
        assert.equal(interaction.sent[0].payload.ephemeral, true);
        assert.match(interaction.sent[0].payload.embeds[0].data.title, /Muitos/);
        process.env.YUI_DL_MAX_CONCURRENT = '0';
        assert.equal(yt.isUserBusy('g4'), false, '0 desliga o teto');
        process.env.YUI_DL_MAX_CONCURRENT = '4';
        assert.equal(yt.isUserBusy('g4'), false, 'com teto 4 ainda cabe o 4º');
    } finally {
        for (const id of ids) yt.unlockUser(id);
        if (saved === undefined) delete process.env.YUI_DL_MAX_CONCURRENT; else process.env.YUI_DL_MAX_CONCURRENT = saved;
    }
    assert.equal(yt.isUserBusy('g4'), false);
    assert.equal(yt.getBusyReason('g4'), null);
});

await test('TG-21: nenhum texto ENTREGUE nos fluxos de música cita a origem; erros e ajuda só citam as plataformas aceitas como link', async () => {
    const delivered = [];
    const collect = (interaction) => { for (const item of interaction.sent) delivered.push(JSON.stringify(item.payload)); };

    // busca: sucesso normal, plano B, erro e lista de escolha
    for (const result of [fakeDeezerResult(), fakeDeezerResult({ fallback: true }), { error: 'Nenhuma música encontrada no catálogo para "x".' }]) {
        const i = fakeInteraction({ busca: 'faixa artista' });
        await baixarMusicaCommand.execute(i, { handleMusicSearchAndDownload: async () => result });
        collect(i);
    }
    // Spotify (provider interno é 'spot-dlp'; não pode aparecer), YouTube/TikTok, arquivo grande e ajuda
    const spotify = fakeInteraction({ url: `https://open.spotify.com/track/${SP}` });
    await baixarMusicaCommand.execute(spotify, { downloadSpotify: async () => fakeDownload() });
    collect(spotify);
    const spotifyGrande = fakeInteraction({ url: `https://open.spotify.com/track/${SP}` });
    await baixarMusicaCommand.execute(spotifyGrande, { downloadSpotify: async () => fakeDownload({ size: 11 * 1024 * 1024 }) });
    collect(spotifyGrande);
    const youtube = fakeInteraction({ url: WATCH });
    await baixarMusicaCommand.execute(youtube, { downloadAudio: async () => fakeDownload({ playlistIgnored: true }) });
    collect(youtube);
    const youtubeGrande = fakeInteraction({ url: WATCH });
    await baixarMusicaCommand.execute(youtubeGrande, { downloadAudio: async () => fakeDownload({ size: 11 * 1024 * 1024 }) });
    collect(youtubeGrande);
    const ajuda = fakeInteraction({});
    await baixarMusicaCommand.execute(ajuda);
    collect(ajuda);

    assert.ok(delivered.length >= 8, `só ${delivered.length} respostas coletadas`);
    for (const text of delivered) {
        // a ajuda ("Informe um link ... YouTube, Spotify, Instagram ou TikTok") é o único texto que lista as plataformas de LINK
        const semPlataformasDeLink = text.replace(/\(YouTube, Spotify, Instagram ou TikTok\)/g, '');
        assert.ok(!mentionsOrigin(semPlataformasDeLink), `cita a origem: ${text.slice(0, 300)}`);
    }
    assert.ok(!delivered.some((t) => /Fonte|Yui Music • |spot-dlp|yt-dlp/i.test(t)));

    // mensagens de erro: nunca citam serviços de busca nem ferramentas; só as plataformas aceitas como link
    const ferramentas = /deezer|spot-?dlp|yt-?dlp|spotdl|deemix/i;
    for (const [key, text] of Object.entries(MEDIA_MESSAGES)) assert.ok(!ferramentas.test(text), `${key}: ${text}`);
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
