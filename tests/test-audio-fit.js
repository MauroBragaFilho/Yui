// Testes do ajuste do MP3 ao limite de upload (TG-02) e da limpeza das tags de origem (TG-21).
// Sem rede, sem Discord e sem ffmpeg real: o execFile é substituído por dublês. Tudo roda numa pasta temporária.
// Execução: npm run test:audiofit
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-audiofit-'));
const originalCwd = process.cwd();
process.env.DATABASE_DIR = path.join(sandbox, 'db');
process.env.LOG_LEVEL = 'error';
process.chdir(sandbox); // o logger grava em ./logs: fica na pasta temporária
for (const name of ['YUI_AUDIO_REENCODE', 'YUI_AUDIO_FIT_TIMEOUT_S', 'YUI_UPLOAD_LIMIT_MB', 'YUI_DL_MAX_CONCURRENT']) delete process.env[name];

const load = (relative) => import(pathToFileURL(path.join(root, relative)).href);
const fit = await load('src/utils/audioFit.js');
const media = await load('src/utils/mediaUrls.js');
const limits = await load('src/utils/uploadLimit.js');
const yt = await load('src/handlers/youtubeAudioHandler.js');
const sp = await load('src/handlers/spotifyDownloadHandler.js');

let passed = 0;
const failures = [];
async function test(name, fn) {
    try {
        await fn();
        passed++;
        console.log(`  ok    ${name}`);
    } catch (err) {
        failures.push(name);
        console.log(`  FALHA ${name}\n        ${String(err.stack || err.message).split('\n').slice(0, 5).join('\n        ')}`);
    }
}

const MIB = 1024 * 1024;
const LIMIT = limits.getUploadLimitBytes(null); // 9.961.472 (10 MiB com a folga de 0,95)
let counter = 0;
function newDir(label = 'd') {
    const dir = path.join(sandbox, `${label}-${++counter}`);
    fs.mkdirSync(dir, { recursive: true });
    return dir;
}
function writeFile(file, content) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    return file;
}
const leftovers = (dir) => fs.readdirSync(dir).filter((name) => /\.(part|tmp)$/.test(name));

/** execFile falso: `handler({ file, args, options })` devolve { stdout, stderr, error }; pode ser assíncrono. */
function fakeExec(handler) {
    const calls = [];
    const fn = (file, args, options, cb) => {
        calls.push({ file, args, options });
        Promise.resolve(handler({ file, args, options, calls })).then((r = {}) => {
            cb(r.error || null, r.stdout || '', r.stderr || '');
        }).catch((e) => cb(e, '', ''));
        return { pid: 4242, kill() {} };
    };
    fn.calls = calls;
    return fn;
}
/** ffmpeg falso: a sonda (-i sem saída) informa `probe`; cada bitrate grava um arquivo do tamanho combinado. */
function fakeFfmpeg(sizes, { probe = 'Duration: N/A', delayMs = 0, onEncode } = {}) {
    return fakeExec(async ({ args }) => {
        if (!args.includes('-b:a')) return { error: Object.assign(new Error('x'), { code: 1 }), stderr: `Input #0, mp3, from 'x.mp3':\n  ${probe}, start: 0.000000` };
        const kbps = Number(args[args.indexOf('-b:a') + 1].replace('k', ''));
        if (onEncode) onEncode(kbps, 'start');
        if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
        fs.writeFileSync(args[args.length - 1], Buffer.alloc(sizes[kbps] ?? 100, 1));
        if (onEncode) onEncode(kbps, 'end');
        return {};
    });
}
const encodesOf = (fake) => fake.calls.filter((c) => c.args.includes('-b:a')).map((c) => c.args[c.args.indexOf('-b:a') + 1]);
const probesOf = (fake) => fake.calls.filter((c) => !c.args.includes('-b:a'));

// --- ID3 -----------------------------------------------------------------------------------------
const synchsafe = (n) => Buffer.from([(n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
function frame(id, data, major = 3, flags = 0) {
    const head = Buffer.alloc(10);
    head.write(id, 0, 'latin1');
    if (major === 4) synchsafe(data.length).copy(head, 4);
    else head.writeUInt32BE(data.length, 4);
    head.writeUInt16BE(flags, 8);
    return Buffer.concat([head, data]);
}
/** TXXX nas quatro codificações do ID3v2: 0 latin1, 1 UTF-16 com BOM, 2 UTF-16BE, 3 UTF-8. */
function txxx(description, value, encoding = 0) {
    const le = (s) => Buffer.from(s, 'utf16le');
    switch (encoding) {
        case 1: return Buffer.concat([Buffer.from([1, 0xff, 0xfe]), le(description), Buffer.from([0, 0, 0xff, 0xfe]), le(value)]);
        case 2: return Buffer.concat([Buffer.from([2]), le(description).swap16(), Buffer.from([0, 0]), le(value).swap16()]);
        case 3: return Buffer.concat([Buffer.from([3]), Buffer.from(description, 'utf8'), Buffer.from([0]), Buffer.from(value, 'utf8')]);
        default: return Buffer.concat([Buffer.from([0]), Buffer.from(description, 'latin1'), Buffer.from([0]), Buffer.from(value, 'latin1')]);
    }
}
const text = (value) => Buffer.concat([Buffer.from([0]), Buffer.from(value, 'latin1')]);
const comment = (value) => Buffer.concat([Buffer.from([0]), Buffer.from('eng'), Buffer.from([0]), Buffer.from(value, 'latin1')]);
const AUDIO = Buffer.alloc(256, 7);
function id3(frames, { major = 3, audio = AUDIO, padding = 0, flags = 0 } = {}) {
    const body = Buffer.concat([...frames.map(([id, data, frameFlags]) => frame(id, data, major, frameFlags)), Buffer.alloc(padding)]);
    const header = Buffer.concat([Buffer.from('ID3', 'latin1'), Buffer.from([major, 0, flags]), synchsafe(body.length)]);
    return Buffer.concat([header, body, audio]);
}
/** Lê de volta os ids dos frames e confere que o tamanho do cabeçalho é coerente. */
function framesOf(buf) {
    const major = buf[3];
    const size = (buf[6] << 21) | (buf[7] << 14) | (buf[8] << 7) | buf[9];
    const ids = [];
    let pos = 10;
    while (pos + 10 <= 10 + size && buf[pos] !== 0) {
        ids.push(buf.toString('latin1', pos, pos + 4));
        const frameSize = major === 4
            ? (buf[pos + 4] << 21) | (buf[pos + 5] << 14) | (buf[pos + 6] << 7) | buf[pos + 7]
            : buf.readUInt32BE(pos + 4);
        pos += 10 + frameSize;
    }
    return { ids, size, audioStart: 10 + size };
}
const SPOTDL_LIKE = () => [
    ['TIT2', text('Faixa')], ['TPE1', text('Artista')], ['TALB', text('Álbum')],
    ['WOAS', Buffer.from('https://open.spotify.com/track/abc')], ['COMM', comment('https://music.youtube.com/watch?v=abc')],
    ['WXXX', Buffer.concat([Buffer.from([0]), Buffer.from('desc'), Buffer.from([0]), Buffer.from('https://x.invalid')])],
];

// =================================================================================================
console.log('Configuração e regras');
await test('readAudioFitConfig: recompressão ligada por padrão; false/0/no/off desliga; prazo 120 s (10 a 900)', () => {
    assert.deepEqual(fit.readAudioFitConfig({}), { reencode: true, timeoutMs: 120000 });
    assert.deepEqual(fit.readAudioFitConfig(undefined), { reencode: true, timeoutMs: 120000 });
    for (const off of ['false', 'FALSE', '0', 'no', 'Off', 'não', ' false ']) assert.equal(fit.readAudioFitConfig({ YUI_AUDIO_REENCODE: off }).reencode, false, off);
    for (const on of ['', 'true', '1', 'yes', 'abc']) assert.equal(fit.readAudioFitConfig({ YUI_AUDIO_REENCODE: on }).reencode, true, on);
    assert.equal(fit.readAudioFitConfig({ YUI_AUDIO_FIT_TIMEOUT_S: '30' }).timeoutMs, 30000);
    assert.equal(fit.readAudioFitConfig({ YUI_AUDIO_FIT_TIMEOUT_S: '900' }).timeoutMs, 900000);
    for (const bad of ['9', '901', '-5', 'abc', '', '1e3x']) assert.equal(fit.readAudioFitConfig({ YUI_AUDIO_FIT_TIMEOUT_S: bad }).timeoutMs, 120000, bad);
});

await test('shouldFitForUpload: vale para envio; nunca para o Modo Rádio nem com skipUploadFit', () => {
    assert.equal(fit.shouldFitForUpload(null), true);
    assert.equal(fit.shouldFitForUpload(undefined), true);
    assert.equal(fit.shouldFitForUpload({}), true);
    assert.equal(fit.shouldFitForUpload({ source: 'Slash' }), true);
    assert.equal(fit.shouldFitForUpload({ source: 'MCP' }), true);
    for (const radio of ['Modo Rádio', 'Modo Radio', 'Rádio', 'Radio']) assert.equal(fit.shouldFitForUpload({ source: radio }), false, radio);
    assert.equal(fit.shouldFitForUpload({ source: 'Slash', skipUploadFit: true }), false);
    assert.equal(fit.shouldFitForUpload({ source: 'Slash', skipUploadFit: false }), true);
    assert.deepEqual([...fit.RADIO_SOURCES], ['Modo Rádio', 'Modo Radio', 'Rádio', 'Radio']);
});

await test('audioUploadMaxMinutes: o que cabe a 96 kbps (13 min nos 10 MB); 0 com a recompressão desligada', () => {
    assert.equal(fit.audioUploadMaxMinutes(LIMIT, {}), 13);
    assert.equal(fit.audioUploadMaxMinutes(LIMIT, { YUI_AUDIO_REENCODE: 'false' }), 0);
    assert.equal(fit.audioUploadMaxMinutes(limits.getUploadLimitBytes({ premiumTier: 2 }), {}), Math.floor(limits.maxAudioMinutes(limits.getUploadLimitBytes({ premiumTier: 2 }), 96)));
    assert.equal(fit.audioUploadMaxMinutes(0, {}), 0);
});

await test('parseDurationSeconds lê o banner do ffmpeg', () => {
    assert.equal(fit.parseDurationSeconds('  Duration: 00:03:45.12, start: 0.0, bitrate: 320 kb/s'), 225.12);
    assert.equal(fit.parseDurationSeconds('Duration: 01:00:00.00, x'), 3600);
    assert.equal(fit.parseDurationSeconds('Duration: N/A, start: 0'), null);
    assert.equal(fit.parseDurationSeconds(''), null);
    assert.equal(fit.parseDurationSeconds(null), null);
    assert.equal(fit.parseDurationSeconds('Duration: 00:00:00.00'), null);
});

await test('buildFitArgs: ARRAY sem aspas, só a primeira faixa de áudio, sem capa, libmp3lame no bitrate pedido', () => {
    const args = fit.buildFitArgs('C:\\x\\in.mp3', 'C:\\x\\out.part', 128);
    assert.ok(Array.isArray(args));
    assert.ok(args.every((a) => typeof a === 'string' && !/^["']|["']$/.test(a)));
    assert.equal(args[args.indexOf('-i') + 1], 'C:\\x\\in.mp3');
    assert.equal(args[args.indexOf('-b:a') + 1], '128k');
    assert.equal(args[args.indexOf('-c:a') + 1], 'libmp3lame');
    assert.ok(args.includes('-vn') && args.includes('-y') && args.includes('-nostdin'));
    // título, artista e álbum são copiados (-map_metadata 0); comentário, descrição e URLs são apagados (valor vazio)
    assert.equal(args[args.indexOf('-map_metadata') + 1], '0');
    // (synopsis, episode_id e show: o yt-dlp com --embed-metadata grava o ID do vídeo e a descrição nessas chaves)
    for (const key of ['comment', 'description', 'purl', 'url', 'synopsis', 'episode_id', 'show']) {
        const at = args.indexOf(`${key}=`);
        assert.ok(at > 0 && args[at - 1] === '-metadata', `falta apagar ${key}`);
    }
    assert.equal(args[args.indexOf('-map') + 1], '0:a:0');
    assert.equal(args[args.length - 1], 'C:\\x\\out.part');
    assert.deepEqual(args.slice(-3, -1), ['-f', 'mp3'], 'formato explícito antes da saída (a extensão .part não diz o formato)');
});

await test('createSemaphore: no máximo N juntos, fila FIFO, liberar duas vezes não solta vaga extra', async () => {
    const gate = fit.createSemaphore(2);
    const r1 = await gate.acquire();
    const r2 = await gate.acquire();
    assert.equal(gate.active, 2);
    const order = [];
    const p3 = gate.acquire().then((release) => { order.push(3); return release; });
    const p4 = gate.acquire().then((release) => { order.push(4); return release; });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(gate.waiting, 2);
    assert.deepEqual(order, []);
    r1();
    r1(); // segunda liberação da mesma vaga: não faz nada
    const rel3 = await p3;
    assert.deepEqual(order, [3]);
    assert.equal(gate.active, 2);
    assert.equal(gate.waiting, 1);
    r2();
    const rel4 = await p4;
    assert.deepEqual(order, [3, 4]);
    rel3(); rel4();
    assert.equal(gate.active, 0);
    assert.equal(fit.createSemaphore(0).acquire !== undefined, true, 'máximo inválido vira 1');
});

await test('uploadTooLargeError: frase curta e clara com o limite; sem recompressão cita o tamanho; nunca cita a origem', () => {
    const comprimido = fit.uploadTooLargeError({ sizeBytes: 20 * MIB, limitBytes: LIMIT, reencode: true });
    assert.ok(comprimido instanceof media.MediaError);
    assert.equal(comprimido.code, 'UPLOAD_TOO_LARGE');
    assert.match(comprimido.userMessage, /limite de envio do Discord \(10 MB\), mesmo comprimido/);
    assert.match(comprimido.userMessage, /até 13 minutos/);
    const semRecompressao = fit.uploadTooLargeError({ sizeBytes: 12.3 * MIB, limitBytes: LIMIT, reencode: false });
    assert.match(semRecompressao.userMessage, /\(12,3 MB\) passou do limite de envio do Discord \(10 MB\)/);
    const tier2 = fit.uploadTooLargeError({ sizeBytes: 90 * MIB, limitBytes: limits.getUploadLimitBytes({ premiumTier: 2 }), reencode: true });
    assert.match(tier2.userMessage, /\(50 MB\)/);
    for (const e of [comprimido, semRecompressao, tier2]) {
        assert.ok(!media.mentionsOrigin(e.userMessage) && !/ffmpeg|libmp3lame/i.test(e.userMessage), e.userMessage);
        assert.ok(e.userMessage.length < 200);
        assert.ok(e.detail && /bytes/.test(e.detail), 'o detalhe técnico fica em .detail');
    }
});

// =================================================================================================
console.log('fitAudioToUpload (ffmpeg falso)');
await test('arquivo que já cabe: nada é executado e o arquivo fica como está', async () => {
    const dir = newDir('cabe');
    const file = writeFile(path.join(dir, 'a.mp3'), Buffer.alloc(1000, 1));
    const ff = fakeFfmpeg({});
    const result = await fit.fitAudioToUpload(file, { execFileImpl: ff, ffmpegPath: 'ffmpeg-falso' });
    assert.equal(result.changed, false);
    assert.equal(result.limitBytes, LIMIT);
    assert.equal(result.originalBytes, 1000);
    assert.equal(ff.calls.length, 0);
    assert.equal(fs.statSync(file).size, 1000);
    // exatamente no limite ainda cabe
    const noLimite = writeFile(path.join(dir, 'b.mp3'), Buffer.alloc(5000, 1));
    assert.equal((await fit.fitAudioToUpload(noLimite, { limitBytes: 5000, execFileImpl: ff })).changed, false);
    // arquivo que sumiu: não lança, só informa
    const sumiu = await fit.fitAudioToUpload(path.join(dir, 'nao-existe.mp3'), { execFileImpl: ff });
    assert.equal(sumiu.skipped, 'missing');
    assert.equal(ff.calls.length, 0);
});

await test('recomprime 192 -> 128 -> 96 e para no primeiro que cabe; substitui o arquivo no MESMO caminho; sem sobras', async () => {
    const dir = newDir('degraus');
    const file = writeFile(path.join(dir, 'faixa.mp3'), Buffer.alloc(30000, 1));
    const ff = fakeFfmpeg({ 192: 12000, 128: 11000, 96: 7000 });
    const result = await fit.fitAudioToUpload(file, { limitBytes: 10000, execFileImpl: ff, ffmpegPath: 'ffmpeg-falso' });
    assert.equal(result.changed, true);
    assert.equal(result.bitrateKbps, 96);
    assert.equal(result.originalBytes, 30000);
    assert.equal(result.finalBytes, 7000);
    assert.deepEqual(result.attempts.map((a) => a.kbps), [192, 128, 96]);
    assert.deepEqual(encodesOf(ff), ['192k', '128k', '96k']);
    assert.equal(result.filePath, file);
    assert.equal(fs.statSync(file).size, 7000);
    assert.deepEqual(leftovers(dir), []);
    assert.deepEqual(fs.readdirSync(dir), ['faixa.mp3']);
    for (const call of ff.calls) {
        assert.equal(call.file, 'ffmpeg-falso');
        assert.ok(Array.isArray(call.args));
        assert.equal(call.options.windowsHide, true);
        assert.equal(call.options.timeout, call.args.includes('-b:a') ? 120000 : 15000, 'prazo do ajuste (120 s) e da sonda (15 s)');
        assert.equal(path.resolve(call.options.cwd), path.resolve(dir));
    }
    const encode = ff.calls.find((c) => c.args.includes('-b:a'));
    assert.equal(encode.args[encode.args.indexOf('-i') + 1], file, 'a entrada é o arquivo do pedido');
    assert.ok(path.dirname(encode.args[encode.args.length - 1]) === dir, 'a saída temporária fica na pasta do pedido');
});

await test('o prazo de cada ffmpeg vem de YUI_AUDIO_FIT_TIMEOUT_S (ou da opção timeoutMs)', async () => {
    const file = writeFile(path.join(newDir('prazo'), 'a.mp3'), Buffer.alloc(30000, 1));
    const ff = fakeFfmpeg({ 192: 5000 });
    await fit.fitAudioToUpload(file, { limitBytes: 10000, execFileImpl: ff, env: { YUI_AUDIO_FIT_TIMEOUT_S: '45' } });
    assert.equal(ff.calls.find((c) => c.args.includes('-b:a')).options.timeout, 45000);
    const file2 = writeFile(path.join(newDir('prazo'), 'b.mp3'), Buffer.alloc(30000, 1));
    const ff2 = fakeFfmpeg({ 192: 5000 });
    await fit.fitAudioToUpload(file2, { limitBytes: 10000, execFileImpl: ff2, timeoutMs: 7000 });
    assert.equal(ff2.calls.find((c) => c.args.includes('-b:a')).options.timeout, 7000);
});

await test('duração conhecida: degraus que não poderiam caber nem são tentados; sem degrau possível, erro sem rodar o ffmpeg', async () => {
    const dir = newDir('duracao');
    // 10 min: 192 kbps daria 14,4 MB, 128 kbps cabe
    const file = writeFile(path.join(dir, 'a.mp3'), Buffer.alloc(16 * MIB, 1));
    const ff = fakeFfmpeg({ 192: 1, 128: 9 * MIB, 96: 1 });
    const result = await fit.fitAudioToUpload(file, { durationSeconds: 600, execFileImpl: ff });
    assert.equal(result.bitrateKbps, 128);
    assert.deepEqual(encodesOf(ff), ['128k'], 'o 192 nem foi tentado');
    assert.equal(probesOf(ff).length, 0, 'com a duração informada não há sonda');
    // 15 min: nem 96 kbps cabe -> erro sem ffmpeg
    const grande = writeFile(path.join(dir, 'b.mp3'), Buffer.alloc(16 * MIB, 1));
    const ff2 = fakeFfmpeg({});
    await assert.rejects(() => fit.fitAudioToUpload(grande, { durationSeconds: 900, execFileImpl: ff2 }),
        (err) => err.code === 'UPLOAD_TOO_LARGE' && /até 13 minutos/.test(err.userMessage));
    assert.equal(ff2.calls.length, 0);
    assert.equal(fs.statSync(grande).size, 16 * MIB, 'o arquivo original fica intacto');
});

await test('sem duração informada: uma sonda (-i) do ffmpeg descobre; a duração filtra os degraus', async () => {
    const file = writeFile(path.join(newDir('sonda'), 'a.mp3'), Buffer.alloc(16 * MIB, 1));
    const ff = fakeFfmpeg({ 128: 8 * MIB }, { probe: 'Duration: 00:10:00.00' });
    const result = await fit.fitAudioToUpload(file, { execFileImpl: ff, ffmpegPath: 'ffmpeg-falso' });
    assert.equal(result.bitrateKbps, 128);
    assert.equal(probesOf(ff).length, 1);
    const probe = probesOf(ff)[0];
    assert.deepEqual(probe.args.slice(-2), ['-i', file]);
    assert.ok(!probe.args.includes('-b:a'));
    assert.deepEqual(encodesOf(ff), ['128k']);
});

await test('nada cabe: UPLOAD_TOO_LARGE depois dos 3 degraus, arquivo original intacto e sem temporários', async () => {
    const dir = newDir('nadacabe');
    const original = Buffer.alloc(30000, 3);
    const file = writeFile(path.join(dir, 'a.mp3'), original);
    const ff = fakeFfmpeg({ 192: 12000, 128: 11000, 96: 10500 });
    await assert.rejects(() => fit.fitAudioToUpload(file, { limitBytes: 10000, execFileImpl: ff }), (err) => {
        assert.ok(err instanceof media.MediaError);
        assert.equal(err.code, 'UPLOAD_TOO_LARGE');
        assert.match(err.userMessage, /limite de envio do Discord/);
        return true;
    });
    assert.deepEqual(encodesOf(ff), ['192k', '128k', '96k']);
    assert.ok(fs.readFileSync(file).equals(original));
    assert.deepEqual(leftovers(dir), []);
});

await test('YUI_AUDIO_REENCODE=false: só avisa ("passou do limite"), sem ffmpeg e sem mexer no arquivo', async () => {
    const dir = newDir('semreenc');
    const file = writeFile(path.join(dir, 'a.mp3'), Buffer.alloc(12 * MIB, 1));
    const ff = fakeFfmpeg({});
    await assert.rejects(() => fit.fitAudioToUpload(file, { execFileImpl: ff, env: { YUI_AUDIO_REENCODE: 'false' } }), (err) => {
        assert.equal(err.code, 'UPLOAD_TOO_LARGE');
        assert.match(err.userMessage, /\(12 MB\) passou do limite de envio do Discord \(10 MB\)/);
        return true;
    });
    assert.equal(ff.calls.length, 0);
    assert.equal(fs.statSync(file).size, 12 * MIB);
});

await test('falhas do ffmpeg viram erros claros e curtos (sem comando, caminho nem stderr) e não deixam temporários', async () => {
    const cases = [
        ['ausente', { error: Object.assign(new Error('spawn x ENOENT'), { code: 'ENOENT' }) }, 'AUDIO_FIT_UNAVAILABLE', /Avise o dono/],
        ['prazo', { error: Object.assign(new Error('Command failed'), { killed: true, signal: 'SIGTERM' }) }, 'AUDIO_FIT_TIMEOUT', /demorou demais/],
        ['saída 1', { error: Object.assign(new Error('Command failed: ffmpeg -i C:\\segredo\\a.mp3'), { code: 1 }), stderr: 'Invalid data found when processing input C:\\segredo\\a.mp3' }, 'AUDIO_FIT_FAILED', /Não consegui compactar/],
    ];
    for (const [label, result, code, pattern] of cases) {
        const dir = newDir('falha');
        const file = writeFile(path.join(dir, 'a.mp3'), Buffer.alloc(30000, 1));
        const ff = fakeExec(({ args }) => (args.includes('-b:a') ? result : { error: Object.assign(new Error('x'), { code: 1 }), stderr: 'Duration: N/A' }));
        await assert.rejects(() => fit.fitAudioToUpload(file, { limitBytes: 10000, execFileImpl: ff, killImpl: () => {} }), (err) => {
            assert.equal(err.code, code, label);
            assert.match(err.userMessage, pattern, label);
            assert.doesNotMatch(err.userMessage, /segredo|Command failed|ENOENT|ffmpeg|spawn|C:\\/i, label);
            assert.ok(!media.mentionsOrigin(err.userMessage), label);
            return true;
        });
        assert.equal(fs.statSync(file).size, 30000, `${label}: arquivo original intacto`);
        assert.deepEqual(leftovers(dir), [], label);
    }
    // saída vazia (ffmpeg "ok" mas sem arquivo útil)
    const dir = newDir('vazio');
    const file = writeFile(path.join(dir, 'a.mp3'), Buffer.alloc(30000, 1));
    const ff = fakeExec(({ args }) => {
        if (args.includes('-b:a')) fs.writeFileSync(args[args.length - 1], Buffer.alloc(0));
        return args.includes('-b:a') ? {} : { error: Object.assign(new Error('x'), { code: 1 }), stderr: 'Duration: N/A' };
    });
    await assert.rejects(() => fit.fitAudioToUpload(file, { limitBytes: 10000, execFileImpl: ff }), (err) => err.code === 'AUDIO_FIT_FAILED');
    assert.deepEqual(leftovers(dir), []);
});

await test('semáforo: no máximo 2 ffmpeg de ajuste ao mesmo tempo, mesmo com 6 pedidos juntos', async () => {
    let running = 0;
    let peak = 0;
    const ff = fakeFfmpeg({ 192: 5000 }, {
        delayMs: 25,
        onEncode: (_kbps, phase) => { running += phase === 'start' ? 1 : -1; peak = Math.max(peak, running); },
    });
    const gate = fit.createSemaphore(fit.FIT_MAX_PARALLEL);
    assert.equal(fit.FIT_MAX_PARALLEL, 2);
    const files = Array.from({ length: 6 }, (_, i) => writeFile(path.join(newDir('par'), `f${i}.mp3`), Buffer.alloc(30000, 1)));
    const results = await Promise.all(files.map((file) => fit.fitAudioToUpload(file, { limitBytes: 10000, execFileImpl: ff, semaphore: gate })));
    assert.ok(results.every((r) => r.changed && r.bitrateKbps === 192));
    assert.equal(peak, 2, `pico de ${peak} ffmpeg simultâneos`);
    assert.equal(gate.active, 0);
    assert.equal(gate.waiting, 0);
});

await test('a vaga do semáforo volta mesmo quando o ffmpeg falha', async () => {
    const gate = fit.createSemaphore(1);
    const ff = fakeExec(({ args }) => (args.includes('-b:a') ? { error: Object.assign(new Error('x'), { code: 1 }) } : { stderr: 'Duration: N/A' }));
    for (let i = 0; i < 3; i++) {
        const file = writeFile(path.join(newDir('vaga'), 'a.mp3'), Buffer.alloc(30000, 1));
        await assert.rejects(() => fit.fitAudioToUpload(file, { limitBytes: 10000, execFileImpl: ff, semaphore: gate }));
    }
    assert.equal(gate.active, 0);
});

// =================================================================================================
console.log('Tags de origem (URL e comentário)');
await test('ID3v2.3: tira WOAS, WXXX e COMM; título, artista e álbum ficam; tamanho do cabeçalho coerente; áudio intacto', () => {
    const file = writeFile(path.join(newDir('tags'), 'a.mp3'), id3(SPOTDL_LIKE(), { padding: 64 }));
    const before = fs.statSync(file).size;
    const out = fit.stripSourceTags(file);
    assert.equal(out.changed, true);
    assert.deepEqual(out.removed, ['WOAS', 'COMM', 'WXXX']);
    const buf = fs.readFileSync(file);
    const parsed = framesOf(buf);
    assert.deepEqual(parsed.ids, ['TIT2', 'TPE1', 'TALB']);
    assert.ok(buf.subarray(parsed.audioStart).equals(AUDIO), 'o áudio começa logo depois do cabeçalho e não mudou');
    assert.ok(buf.length < before);
    assert.ok(!buf.toString('latin1').includes('spotify') && !buf.toString('latin1').includes('youtube'));
    // idempotente
    const again = fit.stripSourceTags(file);
    assert.equal(again.changed, false);
    assert.ok(fs.readFileSync(file).equals(buf));
    assert.deepEqual(leftovers(path.dirname(file)), []);
});

await test('ID3v2.4 (tamanhos synchsafe) também funciona', () => {
    const file = writeFile(path.join(newDir('tags4'), 'a.mp3'), id3(SPOTDL_LIKE(), { major: 4 }));
    const out = fit.stripSourceTags(file);
    assert.equal(out.changed, true);
    const buf = fs.readFileSync(file);
    assert.equal(buf[3], 4);
    const parsed = framesOf(buf);
    assert.deepEqual(parsed.ids, ['TIT2', 'TPE1', 'TALB']);
    assert.ok(buf.subarray(parsed.audioStart).equals(AUDIO));
});

await test('TXXX de origem (comment, purl, description, url, source...) saem em qualquer codificação; outros TXXX e frames com flags ficam', () => {
    // é assim que o ffmpeg grava comentário e URLs: como TXXX com a chave na descrição
    const comoOFfmpeg = id3([
        ['TIT2', text('Faixa')], ['TXXX', txxx('comment', 'https://x.invalid/o')], ['TXXX', txxx('purl', 'https://p.invalid')],
        ['TXXX', txxx('description', 'texto longo da descrição')], ['TSSE', text('Lavf62')],
    ]);
    const file = writeFile(path.join(newDir('txxx'), 'a.mp3'), comoOFfmpeg);
    const out = fit.stripSourceTags(file);
    assert.deepEqual(out.removed, ['TXXX', 'TXXX', 'TXXX']);
    assert.deepEqual(framesOf(fs.readFileSync(file)).ids, ['TIT2', 'TSSE']);

    for (const major of [3, 4]) {
        const frames = [
            ['TIT2', text('Faixa')],
            ['TXXX', txxx('Comment', 'x', 0)], ['TXXX', txxx('PURL', 'x', 3)], ['TXXX', txxx('description', 'x', 1)],
            ['TXXX', txxx('SOURCE', 'x', 2)], ['TXXX', txxx('SOURCEID', 'x', 0)], ['TXXX', txxx('url', 'x', 3)],
            ['TXXX', txxx('ARTISTS', 'A/B', 0)],          // não é de origem: fica
            ['TXXX', txxx('BARCODE', '123', 3)],          // fica
            ['TXXX', txxx('comment', 'x', 0), 0x0001],    // frame com flags: não é lido, fica
            ['TXXX', Buffer.from([9, 99, 0, 1])],         // codificação desconhecida: fica
            ['TXXX', Buffer.from([0])],                   // curto demais: fica
        ];
        const buf = fs.readFileSync(writeFile(path.join(newDir('txxx2'), 'b.mp3'), id3(frames, { major })));
        const outcome = fit.stripSourceTagsFromBuffer(buf);
        assert.equal(outcome.changed, true);
        assert.equal(outcome.removed.length, 6, `v2.${major}`);
        const parsed = framesOf(outcome.buffer);
        assert.deepEqual(parsed.ids, ['TIT2', 'TXXX', 'TXXX', 'TXXX', 'TXXX', 'TXXX']);
        assert.ok(outcome.buffer.subarray(parsed.audioStart).equals(AUDIO));
    }
});

await test('TXXX synopsis, episode_id (o ID do vídeo) e show também são de origem e saem; "album" e outros ficam', () => {
    for (const major of [3, 4]) {
        const frames = [
            ['TIT2', text('Faixa')],
            ['TXXX', txxx('synopsis', 'sinopse com link https://x.invalid', 3)], ['TXXX', txxx('episode_id', 'dQw4w9WgXcQ', 0)], ['TXXX', txxx('Episode ID', 'abc', 3)],
            ['TXXX', txxx('SHOW', 'canal x', 1)], ['TXXX', txxx('episode_sort', '3', 0)],
            ['TXXX', txxx('ARTISTS', 'A/B', 0)],
        ];
        const buf = fs.readFileSync(writeFile(path.join(newDir('txxx3'), 'c.mp3'), id3(frames, { major })));
        const outcome = fit.stripSourceTagsFromBuffer(buf);
        assert.equal(outcome.changed, true);
        assert.equal(outcome.removed.length, 4, `v2.${major}`);
        assert.deepEqual(framesOf(outcome.buffer).ids, ['TIT2', 'TXXX', 'TXXX'], 'ficam episode_sort e ARTISTS');
    }
    assert.equal(fit.isSourceFrame('TXXX', txxx('show', 'x', 0)), true);
});

await test('sem frames de origem, sem tag ou sem nada a mudar: o arquivo fica EXATAMENTE como está', () => {
    const cases = {
        limpo: id3([['TIT2', text('Faixa')], ['TPE1', text('Artista')]]),
        semTag: Buffer.alloc(500, 9),
        pequeno: Buffer.from([1, 2, 3]),
        vazio: Buffer.alloc(0),
    };
    for (const [label, content] of Object.entries(cases)) {
        const file = writeFile(path.join(newDir('intacto'), `${label}.mp3`), content);
        const out = fit.stripSourceTags(file);
        assert.equal(out.changed, false, label);
        assert.ok(fs.readFileSync(file).equals(content), label);
        assert.deepEqual(leftovers(path.dirname(file)), [], label);
    }
});

await test('estruturas inesperadas não são tocadas (sincronização da tag, cabeçalho estendido, frame inválido, tamanho absurdo, ID3v2.2)', () => {
    const base = SPOTDL_LIKE();
    const good = id3(base);
    const mutate = (fn) => { const copy = Buffer.from(good); fn(copy); return copy; };
    const cases = {
        sincronizada: mutate((b) => { b[5] = 0x80; }),
        cabecalhoEstendido: mutate((b) => { b[5] = 0x40; }),
        rodape: mutate((b) => { b[5] = 0x10; }),
        v22: mutate((b) => { b[3] = 2; }),
        v25: mutate((b) => { b[3] = 5; }),
        tamanhoDaTagInvalido: mutate((b) => { b[6] = 0xff; }),
        tamanhoMaiorQueOArquivo: mutate((b) => { b[6] = 0x7f; b[7] = 0x7f; }),
        idDeFrameInvalido: mutate((b) => { b[10] = 0x61; }), // 'a' minúsculo
        frameMaiorQueATag: mutate((b) => { b.writeUInt32BE(0x00ffffff, 14); }),
        truncado: good.subarray(0, 40),
    };
    for (const [label, content] of Object.entries(cases)) {
        const file = writeFile(path.join(newDir('estranho'), `${label}.mp3`), content);
        const out = fit.stripSourceTags(file);
        assert.equal(out.changed, false, label);
        assert.ok(fs.readFileSync(file).equals(content), `${label}: arquivo alterado`);
    }
});

await test('ID3v1: o comentário é zerado (v1.0 inteiro, v1.1 preservando o número da faixa); título e artista ficam', () => {
    const tag = (v11) => {
        const t = Buffer.alloc(128, 0);
        t.write('TAG', 0, 'latin1');
        t.write('Titulo', 3, 'latin1');
        t.write('Artista', 33, 'latin1');
        t.write('Album', 63, 'latin1');
        t.write('2024', 93, 'latin1');
        t.write('https://origem.invalid/x', 97, 'latin1');
        if (v11) { t[125] = 0; t[126] = 5; } // comentário de 28 bytes + número da faixa
        return t;
    };
    for (const v11 of [false, true]) {
        const audio = Buffer.alloc(300, 5);
        const file = writeFile(path.join(newDir('v1'), 'a.mp3'), Buffer.concat([audio, tag(v11)]));
        const out = fit.stripSourceTags(file);
        assert.equal(out.changed, true);
        assert.equal(out.v1CommentCleared, true);
        const buf = fs.readFileSync(file);
        const t = buf.subarray(buf.length - 128);
        assert.equal(t.toString('latin1', 0, 3), 'TAG');
        assert.equal(t.toString('latin1', 3, 9), 'Titulo');
        assert.equal(t.toString('latin1', 33, 40), 'Artista');
        assert.ok(t.subarray(97, 125).every((b) => b === 0), 'comentário zerado');
        if (v11) assert.equal(t[126], 5, 'número da faixa preservado');
        assert.ok(buf.subarray(0, 300).equals(audio));
    }
    // ID3v2 e ID3v1 juntos
    const both = Buffer.concat([id3(SPOTDL_LIKE()), tag(false)]);
    const file = writeFile(path.join(newDir('v1v2'), 'a.mp3'), both);
    const out = fit.stripSourceTags(file);
    assert.deepEqual(out.removed, ['WOAS', 'COMM', 'WXXX']);
    assert.equal(out.v1CommentCleared, true);
});

await test('stripSourceTagsFromBuffer nunca altera o buffer de entrada (nem só com o comentário do ID3v1 sujo)', () => {
    const v1 = Buffer.alloc(128, 0);
    v1.write('TAG', 0, 'latin1');
    v1.write('https://origem.invalid', 97, 'latin1');
    const onlyV1 = Buffer.concat([Buffer.alloc(300, 5), v1]);
    const copy = Buffer.from(onlyV1);
    const out = fit.stripSourceTagsFromBuffer(onlyV1);
    assert.equal(out.changed, true);
    assert.ok(onlyV1.equals(copy), 'a entrada continua igual');
    assert.notEqual(out.buffer, onlyV1);
    assert.ok(out.buffer.subarray(out.buffer.length - 31, out.buffer.length - 3).every((b) => b === 0));
    const withV2 = Buffer.concat([id3(SPOTDL_LIKE()), v1]);
    const copy2 = Buffer.from(withV2);
    fit.stripSourceTagsFromBuffer(withV2);
    assert.ok(withV2.equals(copy2), 'a entrada continua igual também com ID3v2');
    // nada a fazer: devolve o MESMO buffer, sem cópia
    const clean = id3([['TIT2', text('Faixa')]]);
    assert.equal(fit.stripSourceTagsFromBuffer(clean).buffer, clean);
});

await test('falha de disco nunca lança: arquivo original intacto e temporário removido; arquivo acima do teto não é lido', () => {
    const original = id3(SPOTDL_LIKE());
    const file = writeFile(path.join(newDir('disco'), 'a.mp3'), original);
    const broken = { ...fs, writeFileSync: () => { throw new Error('disco cheio'); } };
    const out = fit.stripSourceTags(file, { fsImpl: broken });
    assert.equal(out.changed, false);
    assert.match(out.error, /disco cheio/);
    assert.ok(fs.readFileSync(file).equals(original));
    assert.deepEqual(leftovers(path.dirname(file)), []);
    // acima do teto: pula
    const skipped = fit.stripSourceTags(file, { maxBytes: 10 });
    assert.equal(skipped.changed, false);
    assert.ok(fs.readFileSync(file).equals(original));
    // arquivo inexistente
    assert.equal(fit.stripSourceTags(path.join(path.dirname(file), 'nao-existe.mp3')).changed, false);
});

await test('fuzz: buffers aleatórios com cabeçalho ID3 nunca lançam e só mudam quando algo foi removido', () => {
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed; };
    for (let i = 0; i < 400; i++) {
        const len = 10 + (rnd() % 300);
        const buf = Buffer.alloc(len);
        for (let j = 0; j < len; j++) buf[j] = rnd() & 0xff;
        buf.write('ID3', 0, 'latin1');
        buf[3] = 3 + (rnd() % 2);
        buf[5] = rnd() % 2 ? 0 : (rnd() & 0xff);
        const out = fit.stripSourceTagsFromBuffer(buf);
        if (!out.changed) assert.ok(out.buffer.equals(buf));
        else assert.ok(out.removed.length > 0 || out.v1CommentCleared);
    }
    // frames bem formados em posição aleatória: sempre o mesmo resultado esperado
    for (let i = 0; i < 100; i++) {
        const frames = [];
        const expected = [];
        for (let j = 0; j < 1 + (rnd() % 6); j++) {
            const kind = rnd() % 4;
            const [id, data] = kind === 0 ? ['TIT2', text(`t${j}`)] : kind === 1 ? ['WOAS', Buffer.from(`https://x.invalid/${j}`)] : kind === 2 ? ['COMM', comment(`c${j}`)] : ['TPE1', text(`a${j}`)];
            frames.push([id, data]);
            if (id === 'TIT2' || id === 'TPE1') expected.push(id);
        }
        const out = fit.stripSourceTagsFromBuffer(id3(frames, { major: 3 + (rnd() % 2), padding: rnd() % 40 }));
        const hadSource = frames.some(([id]) => id === 'WOAS' || id === 'COMM');
        assert.equal(out.changed, hadSource);
        if (hadSource) {
            const parsed = framesOf(out.buffer);
            assert.deepEqual(parsed.ids, expected);
            assert.ok(out.buffer.subarray(parsed.audioStart).equals(AUDIO));
        }
    }
});

// =================================================================================================
console.log('Produtores: downloadAudio, Spotify (dublês de yt-dlp, spotdl e ffmpeg)');
const ID = 'dQw4w9WgXcQ';
const WATCH = `https://www.youtube.com/watch?v=${ID}`;
const SP = '4uLU6hMCjMI75M1A2tKUQC';
const okJson = (title, extra = {}) => `${JSON.stringify({ title, extractor_key: 'Youtube', ...extra })}\n`;

/** execFile único para yt-dlp, spotdl e ffmpeg: decide pelo executável e pelos argumentos. */
function producerExec({ mp3, ffmpegSizes = {}, duration, ytdlpMissing = false }) {
    return fakeExec(({ file, args }) => {
        if (file === 'ffmpeg-falso') {
            if (!args.includes('-b:a')) return { error: Object.assign(new Error('x'), { code: 1 }), stderr: 'Duration: N/A' };
            const kbps = Number(args[args.indexOf('-b:a') + 1].replace('k', ''));
            fs.writeFileSync(args[args.length - 1], Buffer.alloc(ffmpegSizes[kbps] ?? 100, 1));
            return {};
        }
        if (file === 'spotdl') {
            const dir = args[args.indexOf('--output') + 1];
            fs.writeFileSync(path.join(dir, 'Artista - Faixa.mp3'), mp3);
            return {};
        }
        if (ytdlpMissing) return { error: Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' }) };
        const out = args[args.indexOf('-o') + 1].replace('%(ext)s', 'mp3');
        fs.writeFileSync(out, mp3);
        return { stdout: okJson('Faixa grande', duration ? { duration } : {}) };
    });
}
function producerDeps(exec, extra = {}) {
    const tempRoot = fs.mkdtempSync(path.join(sandbox, 'root-'));
    return {
        tempRoot,
        deps: {
            execFileImpl: exec, tempRoot,
            ytdlpPath: 'yt-dlp-falso', spotdlPath: 'spotdl', ffmpegPath: 'ffmpeg-falso', cookiesPath: '',
            extraFlags: ['--ignore-config'],
            limits: { maxMinutes: 20, maxFilesizeMB: 200, timeoutMs: 5000 },
            killImpl: () => { throw new Error('não deveria matar nada neste teste'); },
            ...extra,
        },
    };
}

await test('downloadAudio no Modo Rádio: arquivo de 30 MB volta INTACTO, sem ffmpeg, sem teto de duração e com as tags como vieram', async () => {
    const withTags = Buffer.concat([id3(SPOTDL_LIKE()), Buffer.alloc(30 * MIB, 2)]);
    for (const source of ['Modo Rádio', 'Radio']) {
        const exec = producerExec({ mp3: withTags });
        const { tempRoot, deps } = producerDeps(exec);
        const result = await yt.downloadAudio(WATCH, { source, userId: '1' }, deps);
        assert.equal(exec.calls.filter((c) => c.file === 'ffmpeg-falso').length, 0, 'o ffmpeg não pode rodar na rádio');
        assert.equal(fs.statSync(result.filePath).size, withTags.length);
        assert.ok(fs.readFileSync(result.filePath).equals(withTags), 'arquivo e tags idênticos');
        assert.ok(!exec.calls[0].args.includes('--match-filters'), 'sem teto de duração');
        result.cleanup();
        assert.deepEqual(fs.readdirSync(tempRoot), []);
    }
});

await test('downloadAudio com skipUploadFit: nada é recomprimido nem limpo', async () => {
    const content = Buffer.concat([id3(SPOTDL_LIKE()), Buffer.alloc(12 * MIB, 2)]);
    const exec = producerExec({ mp3: content });
    const { deps } = producerDeps(exec);
    const result = await yt.downloadAudio(WATCH, { source: 'MCP', userId: '1', skipUploadFit: true }, deps);
    assert.equal(exec.calls.filter((c) => c.file === 'ffmpeg-falso').length, 0);
    assert.ok(fs.readFileSync(result.filePath).equals(content));
    result.cleanup();
});

await test('downloadAudio para envio: arquivo de 12 MB é recomprimido para caber; tags de URL e comentário saem; cleanup apaga tudo', async () => {
    const content = Buffer.concat([id3(SPOTDL_LIKE()), Buffer.alloc(12 * MIB, 2)]);
    const exec = producerExec({ mp3: content, ffmpegSizes: { 192: 9 * MIB, 128: 6 * MIB, 96: 4 * MIB }, duration: 300 });
    const { tempRoot, deps } = producerDeps(exec);
    const result = await yt.downloadAudio(WATCH, { source: 'MCP', userId: '1', userTag: 't' }, deps);
    const encodes = encodesOf(exec);
    assert.deepEqual(encodes, ['192k'], 'a duração do yt-dlp (300 s) dispensa a sonda e 192 kbps cabe');
    assert.equal(exec.calls.filter((c) => c.file === 'ffmpeg-falso' && !c.args.includes('-b:a')).length, 0, 'sem sonda');
    assert.equal(fs.statSync(result.filePath).size, 9 * MIB);
    assert.ok(fs.statSync(result.filePath).size <= LIMIT);
    assert.equal(path.basename(result.filePath), 'Faixa grande.mp3');
    const ffmpegCall = exec.calls.find((c) => c.file === 'ffmpeg-falso');
    assert.equal(ffmpegCall.args[ffmpegCall.args.indexOf('-i') + 1], result.filePath);
    assert.deepEqual(leftovers(path.dirname(result.filePath)), []);
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);
});

await test('downloadAudio: tags de origem saem do arquivo entregue (mesmo sem precisar recomprimir)', async () => {
    const content = Buffer.concat([id3(SPOTDL_LIKE()), Buffer.alloc(2000, 2)]);
    const exec = producerExec({ mp3: content });
    const { deps } = producerDeps(exec);
    const result = await yt.downloadAudio(WATCH, { source: 'Slash', userId: '1' }, deps);
    const buf = fs.readFileSync(result.filePath);
    assert.equal(exec.calls.filter((c) => c.file === 'ffmpeg-falso').length, 0);
    assert.deepEqual(framesOf(buf).ids, ['TIT2', 'TPE1', 'TALB']);
    assert.ok(!buf.toString('latin1').includes('spotify.com'));
    result.cleanup();
});

await test('downloadAudio num servidor com boost 2: 12 MB cabem (limite de 50 MB), então nada é recomprimido', async () => {
    const content = Buffer.alloc(12 * MIB, 2);
    const exec = producerExec({ mp3: content });
    const { deps } = producerDeps(exec);
    const result = await yt.downloadAudio(WATCH, { source: 'Slash', userId: '1', guild: { premiumTier: 2, name: 'G' } }, deps);
    assert.equal(exec.calls.filter((c) => c.file === 'ffmpeg-falso').length, 0);
    assert.equal(fs.statSync(result.filePath).size, 12 * MIB);
    // e o teto prévio de duração acompanha o limite do servidor (50 MB a 96 kbps = 69 min, limitado pelos 20 min do .env)
    const filter = exec.calls[0].args[exec.calls[0].args.indexOf('--match-filters') + 1];
    assert.equal(filter, '!is_live&duration<=?1200');
    result.cleanup();
});

await test('downloadAudio: nada cabe, ou recompressão desligada: erro claro, pasta do pedido apagada', async () => {
    const content = Buffer.alloc(12 * MIB, 2);
    const exec = producerExec({ mp3: content, ffmpegSizes: { 192: 11 * MIB, 128: 11 * MIB, 96: 11 * MIB }, duration: 120 });
    const a = producerDeps(exec);
    await assert.rejects(() => yt.downloadAudio(WATCH, { source: 'Slash', userId: '1' }, a.deps), (err) => {
        assert.equal(err.code, 'UPLOAD_TOO_LARGE');
        assert.match(err.userMessage, /limite de envio do Discord \(10 MB\)/);
        return true;
    });
    assert.deepEqual(fs.readdirSync(a.tempRoot), [], 'pasta do pedido apagada');
    assert.deepEqual(encodesOf(exec), ['192k', '128k', '96k']);

    const exec2 = producerExec({ mp3: content });
    const b = producerDeps(exec2, { env: { YUI_AUDIO_REENCODE: 'false' } });
    await assert.rejects(() => yt.downloadAudio(WATCH, { source: 'Slash', userId: '1' }, b.deps), (err) => err.code === 'UPLOAD_TOO_LARGE' && /passou do limite/.test(err.userMessage));
    assert.equal(exec2.calls.filter((c) => c.file === 'ffmpeg-falso').length, 0);
    assert.deepEqual(fs.readdirSync(b.tempRoot), []);
});

await test('Spotify (spotdl): MP3 de 12 MB é recomprimido; WOAS e comentário com as URLs saem; provider fica só nos metadados internos', async () => {
    const content = Buffer.concat([id3(SPOTDL_LIKE()), Buffer.alloc(12 * MIB, 2)]);
    const exec = producerExec({ mp3: content, ffmpegSizes: { 192: 9 * MIB } });
    const { tempRoot, deps } = producerDeps(exec);
    const result = await sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, { source: 'Slash', userId: '1' }, deps);
    assert.equal(result.metadata.provider, 'spot-dlp');
    assert.equal(result.metadata.title, 'Artista - Faixa');
    assert.equal(fs.statSync(result.filePath).size, 9 * MIB);
    assert.deepEqual(encodesOf(exec), ['192k']);
    result.cleanup();
    assert.deepEqual(fs.readdirSync(tempRoot), []);

    // sem precisar recomprimir: as tags de origem saem do mesmo jeito
    const small = Buffer.concat([id3(SPOTDL_LIKE()), Buffer.alloc(3000, 2)]);
    const exec2 = producerExec({ mp3: small });
    const second = producerDeps(exec2);
    const r2 = await sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, { source: 'Slash', userId: '1' }, second.deps);
    const buf = fs.readFileSync(r2.filePath);
    assert.deepEqual(framesOf(buf).ids, ['TIT2', 'TPE1', 'TALB']);
    assert.ok(!buf.toString('latin1').includes('youtube.com') && !buf.toString('latin1').includes('spotify.com'));
    r2.cleanup();
});

await test('Spotify: nada cabe -> erro claro e pasta apagada; recompressão desligada -> aviso', async () => {
    const content = Buffer.alloc(12 * MIB, 2);
    const exec = producerExec({ mp3: content, ffmpegSizes: { 192: 11 * MIB, 128: 11 * MIB, 96: 11 * MIB } });
    const a = producerDeps(exec);
    await assert.rejects(() => sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, { source: 'Slash', userId: '1' }, a.deps), (err) => err.code === 'UPLOAD_TOO_LARGE');
    assert.deepEqual(fs.readdirSync(a.tempRoot), []);
    const exec2 = producerExec({ mp3: content });
    const b = producerDeps(exec2, { env: { YUI_AUDIO_REENCODE: 'false' } });
    await assert.rejects(() => sp.downloadSpotify(`https://open.spotify.com/track/${SP}`, { source: 'Slash', userId: '1' }, b.deps), (err) => err.code === 'UPLOAD_TOO_LARGE' && /passou do limite/.test(err.userMessage));
    assert.deepEqual(fs.readdirSync(b.tempRoot), []);
});

await test('nenhuma mensagem do ajuste ao usuário cita a origem do arquivo nem a ferramenta', () => {
    const messages = [
        fit.uploadTooLargeError({ sizeBytes: 20 * MIB, limitBytes: LIMIT, reencode: true }).userMessage,
        fit.uploadTooLargeError({ sizeBytes: 20 * MIB, limitBytes: LIMIT, reencode: false }).userMessage,
        media.MEDIA_MESSAGES.UPLOAD_TOO_LARGE,
    ];
    for (const m of messages) assert.ok(!media.mentionsOrigin(m) && !/ffmpeg|lame/i.test(m), m);
});

await test('o módulo não usa console.*, logger nem exec com string de shell, e importar não deixa handles', () => {
    const source = fs.readFileSync(path.join(root, 'src/utils/audioFit.js'), 'utf8');
    assert.ok(!/console\./.test(source));
    assert.ok(!/utils\/logger|from '\.\/logger/.test(source));
    assert.ok(!/\bexecSync\(|(^|[^.\w])exec\(|shell\s*:\s*true/.test(source));
    assert.ok(!/setInterval|setTimeout/.test(source), 'sem timers próprios');
});

// =================================================================================================
console.log(`\n${passed} teste(s) passaram, ${failures.length} falharam.`);
process.chdir(originalCwd);
try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* arquivos de log ainda abertos no Windows */ }
if (failures.length) {
    console.log('Falhas:\n - ' + failures.join('\n - '));
    process.exit(1);
}
process.exit(0);
