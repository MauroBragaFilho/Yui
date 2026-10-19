// Testes das pendências do pacote I3: /baixar_video e aviso do plano B (interactionCreate), contrato do
// downloadAudio na rádio (radioProviders), caminhos relativos no plano B do Deezer (deezerMusicHandler),
// checagem do Deemix no boot (binaries) e no painel (integrations), e isolamento da auditoria nos testes antigos.
// Tudo com dublês: sem rede, sem Discord, sem yt-dlp/ffmpeg/Python reais, sem bancos nem logs reais.
// Execução: npm run test:pendencias   (node tests/test-integration-pendencias.js)
import assert from 'node:assert';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { register } from 'node:module';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-pendencias-'));

// ---- ambiente isolado -------------------------------------------------------------------------
process.env.DATABASE_DIR = path.join(tmp, 'db');
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_TEST_RADIO_DIR = path.join(tmp, 'radio');
process.env.YUI_OWNER_ID = '999';
process.env.LOG_LEVEL = 'error';
for (const k of ['DEEZER_ARL', 'DEEMIX_ARL', 'PYTHON_PATH', 'YUI_DEEZER_TIMEOUT_S', 'YTDLP_PATH', 'FFMPEG_PATH']) delete process.env[k];
fs.mkdirSync(process.env.DATABASE_DIR, { recursive: true });
fs.mkdirSync(process.env.YUI_TEST_RADIO_DIR, { recursive: true });
// logs/, secrets/ e .env (nenhum) ficam no temporário: o cwd do teste é a pasta temporária.
process.chdir(tmp);

// Dublês de módulo, só do que tem efeito colateral ao importar:
//  - radioCleaner apaga arquivos antigos da pasta REAL da rádio e liga um setInterval; radioPrefetcher apaga uma pasta legada;
//  - o logger (winston) abriria arquivos de log; qualquer módulo que resolva para src/utils/logger.js recebe um dublê que só captura.
const stubs = {
  './radioCleaner.js': 'export const TEMP_RADIO_DIR = process.env.YUI_TEST_RADIO_DIR; export function cleanTempRadioAudio() {} export default {};',
  './radioPrefetcher.js': 'export async function prefetchNextTrack() {} export async function prefetchPlaylistTracks() {} export function cleanupSessionAudioFiles() {} export function cleanupOrphanedAudioFiles() {} export default {};',
};
const stubUrls = Object.fromEntries(Object.entries(stubs).map(([k, v]) => [k, `data:text/javascript,${encodeURIComponent(v)}`]));
const loggerStubUrl = `data:text/javascript,${encodeURIComponent('export const logger = globalThis.__yuiLog;')}`;
const hooks = `
let stubs = {};
let loggerStub = '';
export function initialize(data) { stubs = data.stubs; loggerStub = data.loggerStub; }
export async function resolve(specifier, context, nextResolve) {
  if (Object.prototype.hasOwnProperty.call(stubs, specifier)) return { url: stubs[specifier], shortCircuit: true };
  const resolved = await nextResolve(specifier, context);
  if (resolved.url.endsWith('/src/utils/logger.js')) return { url: loggerStub, shortCircuit: true };
  return resolved;
}`;
const logs = [];
const LOG_LEVELS = new Set(['info', 'warn', 'error', 'debug', 'verbose', 'silly', 'http']);
globalThis.__yuiLog = new Proxy({}, {
  get: (_, prop) => (...args) => {
    if (LOG_LEVELS.has(prop)) logs.push(`${prop}: ${args[0] && args[0].message ? args[0].message : args[0]}`);
    return globalThis.__yuiLog;
  },
  set: () => true,
});
register(`data:text/javascript,${encodeURIComponent(hooks)}`, { parentURL: import.meta.url, data: { stubs: stubUrls, loggerStub: loggerStubUrl } });

const imp = (rel) => import(pathToFileURL(path.join(root, rel)).href);

// Nada sai da máquina.
globalThis.fetch = async () => { throw new Error('rede bloqueada no teste'); };
const { default: axios } = await import('axios');
for (const m of ['get', 'post', 'request']) axios[m] = async () => { throw new Error('rede bloqueada no teste'); };

const mediaUrls = await imp('src/utils/mediaUrls.js');
const svc = await imp('src/services/deezerMusicService.js');
const handler = await imp('src/handlers/deezerMusicHandler.js');
const radio = await imp('src/music/radioProviders.js');
const binaries = await imp('src/utils/binaries.js');
const integrations = await imp('src/core/api/integrations.js');
const yt = await imp('src/handlers/youtubeAudioHandler.js');
const ic = await imp('src/events/interactionCreate.js');
const { MediaError, MEDIA_MESSAGES } = mediaUrls;
const { DEEZER_ERROR_CODES: CODE } = svc;

// ---- mini framework ---------------------------------------------------------------------------
let passed = 0;
let failed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok - ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FALHA - ${name}\n      ${String(err && err.stack ? err.stack : err).split('\n').slice(0, 5).join('\n      ')}`);
  }
}

let counter = 0;
function newDir(label = 'd') {
  const dir = path.join(tmp, `${label}-${++counter}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}
function writeFile(file, size = 2048) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(size, 7));
  return file;
}
function listDir(dir) {
  return fs.existsSync(dir) ? fs.readdirSync(dir) : [];
}
const logCount = (re) => logs.filter((l) => re.test(l)).length;

/** execFile falso: `handler({ file, args, options })` devolve { stdout, stderr, error }. */
function fakeExecFile(fn) {
  const calls = [];
  const exec = (file, args, options, cb) => {
    calls.push({ file, args, options });
    Promise.resolve(fn({ file, args, options }))
      .then((r = {}) => cb(r.error || null, r.stdout || '', r.stderr || ''))
      .catch((e) => cb(e, '', ''));
  };
  exec.calls = calls;
  return exec;
}

/** Interação falsa dos comandos de download. `editFailures`: quantas chamadas de editReply falham antes de dar certo. */
function makeInteraction({ userId = 'u-ana', url = '', details = false, tier = 0, editFailures = 0, commandName = 'baixar_video' } = {}) {
  const events = [];
  let edits = 0;
  const interaction = {
    events,
    commandName,
    guildId: null,
    channelId: null,
    user: { id: userId, tag: 'ana#0001' },
    guild: { premiumTier: tier, name: 'Servidor Teste' },
    options: {
      getString: (n) => (n === 'url' ? url : null),
      getBoolean: (n) => (n === 'descricao' ? details : null),
      getSubcommand: () => null,
    },
    isCommand: () => true,
    isAutocomplete: () => false,
    isStringSelectMenu: () => false,
    isModalSubmit: () => false,
    isButton: () => false,
    async reply(p) { events.push(['reply', p]); },
    async deferReply(p) { events.push(['defer', p]); },
    async editReply(p) {
      edits++;
      events.push(['edit', p]);
      if (edits <= editFailures) throw new Error('Unknown interaction (dublê)');
    },
    async followUp(p) { events.push(['followUp', p]); },
  };
  interaction.edits = () => events.filter((e) => e[0] === 'edit').map((e) => e[1]);
  return interaction;
}

/** Resultado falso de downloadVideo: o arquivo fica numa subpasta única do pedido e cleanup() a remove. */
function makeVideo({ size = 1000, title = 'Vídeo de teste', playlistOnly = false, playlistIgnored = false, extra = {} } = {}) {
  const reqRoot = path.join(tmp, 'temp_videos');
  const dir = mediaUrls.createRequestDir(reqRoot);
  const filePath = writeFile(path.join(dir, `${mediaUrls.safeFileStem(title, 'video')}.mp4`), 64);
  const video = {
    filePath,
    fileSize: size,
    metadata: { title, extractor_key: 'TikTok', ...extra },
    playlistOnly,
    playlistIgnored,
    dir,
    cleanupCalls: 0,
    order: [],
    cleanup() { video.cleanupCalls++; video.order.push('cleanup'); mediaUrls.removeRequestDir(reqRoot, dir); },
  };
  return video;
}

const NO_MENTIONS = { parse: [] };

// =================================================================================================
console.log('1. /baixar_video (interactionCreate)');

await test('sucesso: mostra a linha de playlist, não menciona ninguém e limpa a pasta do pedido DEPOIS de enviar', async () => {
  const video = makeVideo({ playlistOnly: true, extra: { uploader: '@everyone sou eu', description: '@everyone olha isso' } });
  const it = makeInteraction({ url: 'https://www.tiktok.com/@a/video/12345678', details: true });
  it.editReply = async (p) => { video.order.push('edit'); it.events.push(['edit', p]); };
  await ic.runBaixarVideo(it, { downloadVideo: async () => video });
  const [payload] = it.edits();
  assert.match(payload.content, /^🎬 Vídeo baixado do TikTok:/);
  assert.ok(payload.content.includes('Link de playlist: baixei só a primeira faixa.'), payload.content);
  assert.deepStrictEqual(payload.allowedMentions, NO_MENTIONS, 'autor e descrição vêm de sites externos');
  assert.strictEqual(payload.files.length, 1);
  assert.strictEqual(video.cleanupCalls, 1);
  assert.deepStrictEqual(video.order, ['edit', 'cleanup'], 'o arquivo só é apagado depois do envio');
  assert.ok(!fs.existsSync(video.dir), 'a subpasta inteira sumiu, não só o arquivo');
  assert.strictEqual(yt.isUserBusy('u-ana'), false, 'o usuário foi liberado');
});

await test('link com playlist junto do vídeo: avisa que baixou só o vídeo; sem playlist: nenhuma linha extra', async () => {
  const a = makeVideo({ playlistIgnored: true });
  const ita = makeInteraction({ url: 'x' });
  await ic.runBaixarVideo(ita, { downloadVideo: async () => a });
  assert.ok(ita.edits()[0].content.includes('O link tinha uma playlist; baixei só este vídeo.'));
  const b = makeVideo();
  const itb = makeInteraction({ url: 'x' });
  await ic.runBaixarVideo(itb, { downloadVideo: async () => b });
  assert.ok(!itb.edits()[0].content.includes('playlist'), itb.edits()[0].content);
  assert.strictEqual(a.cleanupCalls + b.cleanupCalls, 2);
});

await test('título que não sobra nada depois de limpar vira "video.mp4"; conteúdo nunca passa de 1900 caracteres', async () => {
  const video = makeVideo({ title: '???***', extra: { uploader: 'u'.repeat(3000) } });
  const it = makeInteraction({ url: 'x', details: true });
  await ic.runBaixarVideo(it, { downloadVideo: async () => video });
  const [payload] = it.edits();
  assert.strictEqual(payload.files[0].name, 'video.mp4');
  assert.ok(payload.content.length <= 1900);
});

await test('falha ao ENVIAR: a pasta temporária é limpa mesmo assim e o usuário recebe uma frase amigável', async () => {
  const video = makeVideo();
  const it = makeInteraction({ url: 'x', editFailures: 1 });
  await ic.runBaixarVideo(it, { downloadVideo: async () => video });
  assert.strictEqual(video.cleanupCalls, 1, 'cleanup também em falha de envio');
  assert.ok(!fs.existsSync(video.dir));
  const edits = it.edits();
  assert.strictEqual(edits.length, 2);
  const text = JSON.stringify(edits[1].embeds[0].toJSON());
  assert.ok(text.includes('Não consegui concluir o download agora'), text);
  assert.ok(!text.includes('Unknown interaction'), 'a mensagem crua do erro não vai ao usuário');
  assert.strictEqual(yt.isUserBusy('u-ana'), false);
});

await test('MediaError: o usuário vê só a frase amigável (sem "CODIGO:"), como aviso no log', async () => {
  const before = logs.length;
  const it = makeInteraction({ url: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ' });
  await ic.runBaixarVideo(it, { downloadVideo: async () => { throw new MediaError('YOUTUBE_FULL_VIDEO', MEDIA_MESSAGES.YOUTUBE_FULL_VIDEO, { detail: 'C:\\segredo\\yt-dlp.exe' }); } });
  const embed = it.edits()[0].embeds[0].toJSON();
  assert.strictEqual(embed.description, MEDIA_MESSAGES.YOUTUBE_FULL_VIDEO);
  assert.ok(!embed.description.includes('YOUTUBE_FULL_VIDEO:'));
  const added = logs.slice(before);
  assert.ok(added.some((l) => l.startsWith('warn:') && l.includes('YOUTUBE_FULL_VIDEO')), added.join('\n'));
  assert.ok(!added.some((l) => l.startsWith('error:')), 'erro esperado não vira error');
});

await test('erro inesperado: frase genérica ao usuário (sem caminho/comando) e error no log', async () => {
  const before = logs.length;
  const it = makeInteraction({ url: 'x' });
  await ic.runBaixarVideo(it, { downloadVideo: async () => { throw new Error('Command failed: C:\\segredo\\yt-dlp.exe --cookies c.txt'); } });
  const embed = it.edits()[0].embeds[0].toJSON();
  assert.ok(!/segredo|Command failed|yt-dlp/.test(embed.description), embed.description);
  assert.strictEqual(embed.description, 'Não consegui concluir o download agora. Tente novamente em instantes.');
  assert.ok(logs.slice(before).some((l) => l.startsWith('error:') && l.includes('Command failed')), 'o detalhe técnico fica no log');
});

await test('vídeo acima do limite: guarda para o botão de compressão e NÃO apaga o arquivo', async () => {
  const video = makeVideo({ size: 30 * 1024 * 1024, title: 'Grandão' });
  const it = makeInteraction({ url: 'x' });
  await ic.runBaixarVideo(it, { downloadVideo: async () => video });
  const [payload] = it.edits();
  const button = payload.components[0].toJSON().components[0];
  assert.match(button.custom_id, /^compress_video_[0-9a-f-]{12}$/);
  const pending = yt.getPendingVideo(button.custom_id.replace('compress_video_', ''));
  assert.ok(pending && pending.filePath === video.filePath, 'o arquivo ficou registrado para a compressão');
  assert.strictEqual(video.cleanupCalls, 0, 'cleanup não pode rodar: o botão ainda vai precisar do arquivo');
  assert.ok(fs.existsSync(video.filePath));
  assert.strictEqual(yt.isUserBusy('u-ana'), false);
  yt.removePendingVideo(button.custom_id.replace('compress_video_', ''));
  video.cleanup();
});

await test('vídeo grande + falha ao mostrar o botão: solta o arquivo guardado e limpa tudo', async () => {
  const video = makeVideo({ size: 30 * 1024 * 1024 });
  const it = makeInteraction({ url: 'x', editFailures: 1 });
  await ic.runBaixarVideo(it, { downloadVideo: async () => video });
  assert.strictEqual(video.cleanupCalls, 1);
  assert.ok(!fs.existsSync(video.dir));
});

await test('limite maior em servidor com boost: 30 MB cabe no nível 2 (50 MB) e é enviado', async () => {
  const video = makeVideo({ size: 30 * 1024 * 1024 });
  const it = makeInteraction({ url: 'x', tier: 2 });
  await ic.runBaixarVideo(it, { downloadVideo: async () => video });
  assert.strictEqual(it.edits()[0].files.length, 1);
  assert.strictEqual(video.cleanupCalls, 1);
});

await test('usuário com download em andamento: responde em privado e não baixa nada', async () => {
  yt.lockUser('u-busy');
  let calls = 0;
  const it = makeInteraction({ userId: 'u-busy', url: 'x' });
  await ic.runBaixarVideo(it, { downloadVideo: async () => { calls++; return makeVideo(); } });
  yt.unlockUser('u-busy');
  assert.strictEqual(calls, 0);
  assert.strictEqual(it.events[0][0], 'reply');
  assert.strictEqual(it.events[0][1].ephemeral, true);
});

await test('pelo execute real: link inválido e vídeo comum do YouTube dão a frase amigável, sem processo e sem pasta', async () => {
  for (const [url, expected] of [
    ['https://exemplo.invalido/x"&calc&"', MEDIA_MESSAGES.URL_INVALID],
    ['https://www.youtube.com/watch?v=dQw4w9WgXcQ', MEDIA_MESSAGES.YOUTUBE_FULL_VIDEO],
  ]) {
    const it = makeInteraction({ url });
    await ic.default.execute(it, {});
    const embed = it.edits()[0].embeds[0].toJSON();
    assert.strictEqual(embed.description, expected);
  }
});

// =================================================================================================
console.log('2. Música: aviso do plano B (interactionCreate + deezerMusicHandler)');

const track = { id: 3135556, title: 'Canção `Teste`', artist: 'Artista @everyone', album: 'Álbum', duration: 200, link: 'https://www.deezer.com/track/3135556' };

await test('musicDeliveryText: sem plano B mantém o texto; com plano B mostra um aviso NEUTRO de qualidade (sem citar a origem)', () => {
  const plain = ic.musicDeliveryText({ track }, '✅ Música baixada: ');
  assert.strictEqual(plain, `✅ Música baixada: \`${mediaUrls.codeSafe(track.title)} - ${mediaUrls.codeSafe(track.artist)}\``);
  assert.strictEqual(plain.split('`').length, 3, 'só as duas crases do trecho de código: as do título foram tiradas');
  const fb = ic.musicDeliveryText({ track: { ...track, artist: 'x (baixado do YouTube)' }, originalTrack: track, fallback: { source: 'youtube' }, notice: '⚠️ Não consegui baixar pelo Deezer, então baixei do YouTube.' });
  assert.strictEqual(fb, mediaUrls.formatDeezerDelivery({ track, originalTrack: track, fallback: { source: 'youtube' }, notice: '⚠️ Não consegui baixar pelo Deezer, então baixei do YouTube.' }).text);
  // Decisão do dono (D6/D14): o arquivo chega sem dizer de onde veio. Um aviso que cite a origem é trocado pelo neutro.
  assert.ok(fb.startsWith(mediaUrls.DEEZER_FALLBACK_NOTICE), fb);
  assert.ok(!mediaUrls.mentionsOrigin(fb), 'o texto entregue não diz de onde veio a faixa');
  assert.ok(!/alta qualidade|via Deezer|baixei do YouTube/.test(fb));
});

await test('resultado REAL do plano B (executeDownloadAndPackage) é mostrado com o aviso, sem menções, e os temporários somem', async () => {
  const ytFile = writeFile(path.join(newDir('yt'), 'dQw4w9WgXcQ.mp3'));
  const result = await handler.executeDownloadAndPackage(track, {
    downloadDeezerTrack: async () => { throw new svc.DeezerDownloadError(CODE.LOGIN); },
    downloadFromYoutube: async () => ({ filePath: ytFile, youtubeTitle: 'Artista - Canção (Official)' }),
  });
  assert.ok(result.fallback);
  const it = makeInteraction();
  await ic.deliverMusicResult(it, result, { prefix: '✅ Música baixada: ' });
  const [payload] = it.edits();
  // Aviso neutro de qualidade e o título/artista da faixa PEDIDA; nada de origem (nem o título do vídeo do plano B).
  assert.ok(payload.content.startsWith(mediaUrls.DEEZER_FALLBACK_NOTICE), payload.content);
  assert.ok(/Canção\s+Teste - Artista @everyone/.test(payload.content), payload.content);
  assert.ok(!mediaUrls.mentionsOrigin(payload.content), payload.content);
  assert.ok(!/alta qualidade|via Deezer|Música baixada:/.test(payload.content), payload.content);
  assert.deepStrictEqual(payload.allowedMentions, NO_MENTIONS);
  assert.strictEqual(payload.files.length, 1);
  assert.ok(!fs.existsSync(ytFile), 'cleanup do resultado rodou');
});

await test('resultado do Deezer: texto normal, embed mantido só se pedido; error/ambíguo limpam o embed de "baixando"', async () => {
  const file = writeFile(path.join(newDir('dz'), 'a.mp3'));
  const ok = await handler.executeDownloadAndPackage(track, { downloadDeezerTrack: async () => file });
  const keep = { title: 'info' };
  const it1 = makeInteraction();
  await ic.deliverMusicResult(it1, ok, { embeds: [keep], clearEmbeds: true });
  assert.deepStrictEqual(it1.edits()[0].embeds, [keep]);
  assert.strictEqual(it1.edits()[0].content, `✅ \`${mediaUrls.codeSafe(track.title)} - ${mediaUrls.codeSafe(track.artist)}\``);
  assert.ok(!fs.existsSync(file));
  const it2 = makeInteraction();
  await ic.deliverMusicResult(it2, { error: 'Nenhuma música encontrada para "@everyone".' }, { clearEmbeds: true });
  assert.deepStrictEqual(it2.edits()[0], { content: '❌ Nenhuma música encontrada para "@everyone".', embeds: [], allowedMentions: NO_MENTIONS });
  const it3 = makeInteraction();
  await ic.deliverMusicResult(it3, { isAmbiguous: true, textList: 'lista', components: ['c'], embed: 'e' }, {});
  assert.deepStrictEqual(it3.edits()[0], { content: 'lista', components: ['c'], embeds: ['e'], allowedMentions: NO_MENTIONS });
});

await test('falha ao enviar a música: os temporários são limpos mesmo assim (cleanup no finally) e o erro sobe', async () => {
  const file = writeFile(path.join(newDir('dz'), 'b.mp3'));
  const ok = await handler.executeDownloadAndPackage(track, { downloadDeezerTrack: async () => file });
  const it = makeInteraction({ editFailures: 1 });
  await assert.rejects(ic.deliverMusicResult(it, ok, {}), /Unknown interaction/);
  assert.ok(!fs.existsSync(file));
});

await test('seleção de faixa pelo execute real: sem pesquisa pendente mostra o erro, sem menções', async () => {
  const it = makeInteraction({ userId: 'u-sel' });
  Object.assign(it, {
    customId: 'music_select_u-sel',
    values: ['1'],
    isCommand: () => false,
    isStringSelectMenu: () => true,
    async update(p) { it.events.push(['update', p]); },
  });
  await ic.default.execute(it, {});
  assert.strictEqual(it.events[0][0], 'update');
  const [payload] = it.edits();
  assert.match(payload.content, /^❌ Nenhuma pesquisa de música pendente/);
  assert.deepStrictEqual(payload.allowedMentions, NO_MENTIONS);
});

// =================================================================================================
console.log('3. Plano B do Deezer: cookies, ffmpeg e pasta do pedido com caminhos relativos');

await test('buildYoutubeFallbackArgs: cookies e ffmpeg relativos viram absolutos; nome puro de binário continua puro', () => {
  const args = handler.buildYoutubeFallbackArgs(track, path.join(tmp, 'req'), { cookiesPath: 'cookies-rel.txt', ffmpegPath: path.join('ferramentas', 'ffmpeg.exe') });
  assert.strictEqual(args[args.indexOf('--cookies') + 1], path.resolve('cookies-rel.txt'));
  assert.strictEqual(args[args.indexOf('--ffmpeg-location') + 1], path.resolve('ferramentas', 'ffmpeg.exe'));
  const bare = handler.buildYoutubeFallbackArgs(track, path.join(tmp, 'req'), { ffmpegPath: 'ffmpeg' });
  assert.strictEqual(bare[bare.indexOf('--ffmpeg-location') + 1], 'ffmpeg');
});

await test('downloadFromYoutubeFallback: tudo que vai ao yt-dlp é ABSOLUTO, porque ele roda com cwd na pasta do pedido', async () => {
  writeFile('cookies-rel.txt', 10);
  writeFile(path.join('ferramentas', 'ffmpeg.exe'), 10);
  const exec = fakeExecFile(({ args, options }) => {
    const out = args[args.indexOf('-o') + 1];
    assert.ok(path.isAbsolute(out), `saída relativa: ${out}`);
    assert.strictEqual(options.cwd, path.dirname(out));
    writeFile(path.join(path.dirname(out), 'dQw4w9WgXcQ.mp3'));
    return { stdout: `${JSON.stringify({ id: 'dQw4w9WgXcQ', title: 'Título ao vivo' })}\n` };
  });
  const res = await handler.downloadFromYoutubeFallback(track, {
    execFileImpl: exec,
    baseDir: 'base-relativa',
    cookiesPath: 'cookies-rel.txt',
    ffmpegPath: path.join('ferramentas', 'ffmpeg.exe'),
    ytdlpPath: path.join('bin', 'yt-dlp-falso.exe'),
    extraFlags: [],
  });
  const call = exec.calls[0];
  assert.strictEqual(call.file, path.resolve('bin', 'yt-dlp-falso.exe'), 'o próprio yt-dlp relativo também vira absoluto');
  const cookies = call.args[call.args.indexOf('--cookies') + 1];
  const ffmpeg = call.args[call.args.indexOf('--ffmpeg-location') + 1];
  assert.strictEqual(cookies, path.resolve('cookies-rel.txt'));
  assert.ok(path.isAbsolute(cookies) && fs.existsSync(cookies), 'os cookies existem no caminho passado');
  assert.ok(path.isAbsolute(ffmpeg) && fs.existsSync(ffmpeg), 'o ffmpeg existe no caminho passado');
  assert.ok(path.isAbsolute(res.filePath) && path.dirname(path.dirname(res.filePath)) === path.resolve('base-relativa'));
  assert.strictEqual(res.youtubeTitle, 'Título ao vivo');
});

await test('cookies/ffmpeg que não existem não viram argumento; yt-dlp só com nome puro continua como veio (PATH)', async () => {
  const exec = fakeExecFile(({ args }) => {
    writeFile(path.join(path.dirname(args[args.indexOf('-o') + 1]), 'x.mp3'));
    return {};
  });
  const baseDir = newDir('base');
  await handler.downloadFromYoutubeFallback(track, { execFileImpl: exec, baseDir, cookiesPath: 'nao-existe.txt', ffmpegPath: 'ffmpeg-que-nao-existe', ytdlpPath: 'yt-dlp-falso', extraFlags: [] });
  const call = exec.calls[0];
  assert.strictEqual(call.file, 'yt-dlp-falso');
  assert.ok(!call.args.includes('--cookies') && !call.args.includes('--ffmpeg-location'));
});

await test('falha do plano B remove a subpasta do pedido', async () => {
  const baseDir = newDir('base');
  await assert.rejects(handler.downloadFromYoutubeFallback(track, { execFileImpl: fakeExecFile(() => ({ error: Object.assign(new Error('x'), { code: 1 }) })), baseDir, cookiesPath: '', ffmpegPath: '', extraFlags: [] }), /yt-dlp sem resultado/);
  assert.strictEqual(listDir(baseDir).length, 0);
});

// =================================================================================================
console.log('4. Modo Rádio: contrato do downloadAudio (filePath, metadata, cleanup)');

const radioDir = process.env.YUI_TEST_RADIO_DIR;
const ytTrack = { id: 'dQw4w9WgXcQ', source: 'youtube', link: 'https://www.youtube.com/watch?v=dQw4w9WgXcQ', title: 'Numb', artist: 'Linkin Park' };
/** downloadAudio falso que imita o real: MP3 numa subpasta única de `reqRoot` e um cleanup() que a remove. */
function fakeYoutubeAudio(reqRoot) {
  const state = { cleanupCalls: 0 };
  state.fn = async () => {
    const dir = mediaUrls.createRequestDir(reqRoot);
    state.dir = dir;
    const filePath = writeFile(path.join(dir, 'Numb.mp3'), 4096);
    return { filePath, metadata: { title: 'Numb' }, cleanup: () => { state.cleanupCalls++; mediaUrls.removeRequestDir(reqRoot, dir); } };
  };
  return state;
}

await test('YouTube: a faixa é MOVIDA para a pasta plana da rádio, a subpasta do pedido some e o arquivo continua tocável', async () => {
  const reqRoot = newDir('temp_audio');
  const dl = fakeYoutubeAudio(reqRoot);
  const file = await radio.downloadTrackToDisk(ytTrack, null, { downloadAudio: dl.fn, radioDir });
  assert.strictEqual(path.dirname(file), radioDir, 'na pasta onde só o radioCleaner (15 min, protege a faixa atual) age');
  assert.match(path.basename(file), /^youtube_dQw4w9WgXcQ_[0-9a-f]{8}\.mp3$/);
  assert.ok(fs.existsSync(file) && fs.statSync(file).size === 4096, 'o arquivo que a rádio vai tocar existe e está inteiro');
  assert.strictEqual(dl.cleanupCalls, 1, 'cleanup() chamado depois do move');
  assert.strictEqual(listDir(reqRoot).length, 0, 'nenhuma subpasta sobrando');
});

await test('YouTube: depois do move, nem a faxina de 24 h do YouTube nem a de 3 h do Deezer encostam na faixa', async () => {
  const reqRoot = newDir('temp_audio');
  const dl = fakeYoutubeAudio(reqRoot);
  const file = await radio.downloadTrackToDisk(ytTrack, null, { downloadAudio: dl.fn, radioDir });
  const future = Date.now() + 48 * 60 * 60 * 1000;
  for (const base of [radioDir, reqRoot]) {
    mediaUrls.sweepStaleRequestDirs(base, { now: future });
    svc.sweepStaleDeezerDirs(base, { now: future });
  }
  assert.ok(fs.existsSync(file), 'a pasta plana da rádio não tem subpastas UUID: as faxinas dos downloads ignoram-na');
  // Contraste: no lugar antigo (dentro da subpasta do pedido) a faxina de 3 h do Deezer APAGARIA a faixa.
  const old = mediaUrls.createRequestDir(reqRoot);
  writeFile(path.join(old, 'Numb.mp3'));
  assert.strictEqual(svc.sweepStaleDeezerDirs(reqRoot, { now: future }), 1);
  assert.ok(!fs.existsSync(old));
});

await test('YouTube: resultado sem cleanup() (formato antigo) devolve o caminho como veio, sem mover nada', async () => {
  const direct = writeFile(path.join(newDir('dl'), 'direto.mp3'));
  assert.strictEqual(await radio.downloadTrackToDisk(ytTrack, null, { downloadAudio: async () => ({ filePath: direct }), radioDir }), direct);
  assert.ok(fs.existsSync(direct));
});

await test('YouTube: se o move falhar, a faixa segue tocável onde está e a pasta do pedido NÃO é apagada', async () => {
  const reqRoot = newDir('temp_audio');
  const dl = fakeYoutubeAudio(reqRoot);
  const notADir = writeFile(path.join(newDir('x'), 'arquivo-comum'));
  const file = await radio.downloadTrackToDisk(ytTrack, null, { downloadAudio: dl.fn, radioDir: path.join(notADir, 'radio') });
  assert.strictEqual(path.dirname(file), dl.dir);
  assert.ok(fs.existsSync(file));
  assert.strictEqual(dl.cleanupCalls, 0, 'apagar a pasta agora tiraria o arquivo que a rádio ainda vai tocar');
  assert.ok(logCount(/Não consegui mover a faixa do YouTube/) >= 1);
});

await test('YouTube: arquivo que sumiu libera a pasta do pedido e cai no plano Deezer uma única vez', async () => {
  const reqRoot = newDir('temp_audio');
  let cleanups = 0;
  let searches = 0;
  await assert.rejects(
    radio.downloadTrackToDisk(ytTrack, null, {
      downloadAudio: async () => {
        const dir = mediaUrls.createRequestDir(reqRoot);
        return { filePath: path.join(dir, 'sumiu.mp3'), metadata: {}, cleanup: () => { cleanups++; mediaUrls.removeRequestDir(reqRoot, dir); } };
      },
      searchDeezerTracks: async () => { searches++; return []; },
      radioDir,
    }),
    /Falha ao baixar áudio do YouTube/,
  );
  assert.strictEqual(cleanups, 1);
  assert.strictEqual(searches, 1);
  assert.strictEqual(listDir(reqRoot).length, 0);
});

await test('YouTube: caminho pré-baixado e download que lança continuam como antes', async () => {
  const pre = writeFile(path.join(newDir('pre'), 'pre.mp3'));
  assert.strictEqual(await radio.downloadTrackToDisk({ ...ytTrack, preDownloadedPath: pre }, null, {}), pre);
  await assert.rejects(radio.downloadTrackToDisk(ytTrack, null, { downloadAudio: async () => { throw new MediaError('YTDLP_ERROR', 'x'); }, searchDeezerTracks: async () => [], radioDir }), /Falha ao baixar áudio do YouTube/);
});

// =================================================================================================
console.log('5. Deemix: boot (binaries) e painel (integrations)');

const okJson = `${JSON.stringify({ ok: true, deemix: '3.6.6', 'deezer-py': '1.3.7', python: '3.12.10' })}\n`;
const fakeLog = () => { const lines = []; return { lines, info: (m) => lines.push(`info: ${m}`), warn: (m) => lines.push(`warn: ${m}`) }; };
// Só o item do deemix: a lista padrão também traz o spotdl (que tem os testes dele em tests/test-binaries-spotdl.js).
const onlyDeemix = () => binaries.OPTIONAL_PYTHON_TOOLS.filter((t) => t.key === 'deemix');

await test('checkOptionalPythonTools: "[MediaTools] Deemix: OK" quando o --check passa (sem rede, sem login)', async () => {
  const log = fakeLog();
  const exec = fakeExecFile(({ file, args }) => {
    assert.strictEqual(file, 'python-falso');
    assert.strictEqual(args[1], '--check');
    return { stdout: okJson };
  });
  const res = await binaries.checkOptionalPythonTools({ tools: onlyDeemix(), log, options: { deemix: { execFileImpl: exec, maxAgeMs: 0, pythonBin: 'python-falso', scriptPath: 'script-falso.py' } } });
  assert.strictEqual(res.deemix.ok, true);
  assert.strictEqual(res.deemix.code, null);
  assert.deepStrictEqual(log.lines, ['info: [MediaTools] Deemix: OK (deemix 3.6.6, deezer-py 1.3.7 (Python 3.12.10))']);
  assert.strictEqual(exec.calls[0].options.timeout, 30000, 'o boot não espera mais de 30 s pelo Python (o 1º import depois do boot do Windows passa de 12 s)');
});

await test('checkOptionalPythonTools: "[MediaTools] Deemix: FALTANDO" quando o Python/deemix não existe, sem lançar', async () => {
  const log = fakeLog();
  const exec = fakeExecFile(() => ({ error: Object.assign(new Error('spawn python ENOENT'), { code: 'ENOENT' }) }));
  const res = await binaries.checkOptionalPythonTools({ tools: onlyDeemix(), log, options: { deemix: { execFileImpl: exec, maxAgeMs: 0, pythonBin: 'python-falso', scriptPath: 'x.py' } } });
  assert.strictEqual(res.deemix.ok, false);
  assert.strictEqual(res.deemix.code, CODE.NOT_INSTALLED);
  assert.strictEqual(log.lines.length, 1);
  assert.ok(log.lines[0].startsWith('warn: [MediaTools] Deemix: FALTANDO (DEEMIX_NOT_INSTALLED).'), log.lines[0]);
  assert.ok(log.lines[0].includes('requirements-deemix.txt') && log.lines[0].includes('plano B'));
  assert.ok(!/ENOENT|spawn/.test(log.lines[0]), 'sem detalhe técnico na linha');
});

await test('checkOptionalPythonTools: ponto de extensão — outra ferramenta entra na lista e uma que lança vira FALTANDO', async () => {
  const log = fakeLog();
  const tools = [
    { key: 'deemix', label: 'Deemix', hint: 'dica 1', check: async () => ({ ok: true, message: 'v1' }) },
    { key: 'spotdl', label: 'spotdl', hint: 'dica 2', check: async () => { throw new Error('explodiu\nlinha 2'); } },
  ];
  const res = await binaries.checkOptionalPythonTools({ tools, log });
  assert.deepStrictEqual(Object.keys(res), ['deemix', 'spotdl']);
  assert.strictEqual(res.spotdl.ok, false);
  assert.strictEqual(res.spotdl.code, 'CHECK_ERROR');
  assert.deepStrictEqual(log.lines, ['info: [MediaTools] Deemix: OK (v1)', 'warn: [MediaTools] spotdl: FALTANDO (CHECK_ERROR). dica 2']);
  assert.ok(binaries.OPTIONAL_PYTHON_TOOLS.some((t) => t.key === 'deemix'));
});

await test('validateMediaTools chama a checagem do Deemix, devolve deemixOk e não importa o serviço do Deezer ao carregar', () => {
  const src = fs.readFileSync(path.join(root, 'src/utils/binaries.js'), 'utf8');
  const body = src.slice(src.indexOf('export async function validateMediaTools()'));
  assert.match(body, /await checkOptionalPythonTools\(\)/);
  assert.match(body, /return \{[^}]*deemixOk[^}]*\}/);
  assert.ok(!/^import .*deezerMusicService/m.test(src), 'import estático traria o dotenv do serviço para quem só quer os caminhos dos binários');
  assert.ok(/import\('\.\.\/services\/deezerMusicService\.js'\)/.test(src));
  assert.ok(!/console\.(log|warn|error|info)/.test(body));
  assert.strictEqual(typeof binaries.validateMediaTools, 'function');
});

const itemsOf = (data, env = {}) => Object.fromEntries(integrations.buildIntegrations({ env, data }).groups.flatMap((g) => g.items).map((i) => [i.key, i]));

await test('painel: o item "deemix" tem os três estados (ok / missing / off) e nunca expõe o ARL', () => {
  const ok = itemsOf({ deemix: { ok: true, code: null, message: 'deemix 3.6.6, deezer-py 1.3.7 (Python 3.12.10)' } }, { DEEZER_ARL: 'arl-secreto-0123456789' });
  assert.deepStrictEqual(ok.deemix, { key: 'deemix', name: 'Música (Deemix)', status: 'ok', detail: 'deemix 3.6.6, deezer-py 1.3.7 (Python 3.12.10)' });
  assert.ok(!JSON.stringify(ok).includes('arl-secreto'));
  const missing = itemsOf({ deemix: { ok: false, code: CODE.NOT_INSTALLED, message: 'x' } });
  assert.strictEqual(missing.deemix.status, 'missing');
  assert.ok(missing.deemix.detail.includes('requirements-deemix.txt') && missing.deemix.detail.includes('YouTube'));
  assert.ok(itemsOf({ deemix: { ok: false, code: CODE.TIMEOUT } }).deemix.detail.includes('demorou demais'));
  assert.ok(itemsOf({ deemix: { ok: false, code: CODE.ERROR } }).deemix.detail.includes('não foi possível verificar'));
  assert.deepStrictEqual(itemsOf({}).deemix, { key: 'deemix', name: 'Música (Deemix)', status: 'off', detail: 'ainda não verificado' });
  assert.strictEqual(itemsOf({ deemix: null }).deemix.status, 'off');
  for (const i of Object.values(itemsOf({}))) assert.ok(['ok', 'off', 'missing'].includes(i.status), i.key);
});

await test('painel: o item "deezer" (ARL) continua igual e o "deemix" vem logo depois dele, no mesmo grupo', () => {
  const groups = integrations.buildIntegrations({ env: { DEEZER_ARL: 'abc' }, data: {} }).groups;
  const group = groups.find((g) => g.items.some((i) => i.key === 'deezer'));
  const keys = group.items.map((i) => i.key);
  assert.strictEqual(keys[keys.indexOf('deezer') + 1], 'deemix');
  assert.deepStrictEqual(group.items.find((i) => i.key === 'deezer'), { key: 'deezer', name: 'Música (Deezer)', status: 'ok', detail: 'ARL configurado' });
});

await test('painel: loadIntegrationData traz o estado do Deemix (do cache de 10 min do serviço, sem abrir processo)', async () => {
  const exec = fakeExecFile(() => ({ stdout: okJson }));
  const seeded = await svc.getDeemixStatus({ execFileImpl: exec, maxAgeMs: 0, pythonBin: 'python-falso', scriptPath: 'x.py', log: false });
  assert.strictEqual(seeded.ok, true);
  const data = await integrations.loadIntegrationData();
  assert.strictEqual(data.deemix.ok, true);
  assert.strictEqual(exec.calls.length, 1, 'a segunda leitura veio do cache');
  assert.strictEqual(itemsOf(data).deemix.status, 'ok');
});

// =================================================================================================
console.log('6. Isolamento da auditoria nos testes antigos');

const auditTests = ['test-readonly', 'test-core-agent', 'test-core-api', 'test-core', 'test-search-skills', 'test-llm-safety', 'test-longreply'];
await test('os testes que carregam src/core definem YUI_AUDIT_FILE ANTES de importar qualquer módulo de src/', () => {
  for (const name of auditTests) {
    const src = fs.readFileSync(path.join(root, 'tests', `${name}.js`), 'utf8');
    const setAt = src.search(/YUI_AUDIT_FILE/);
    const firstImport = src.search(/(?:import\(\s*['"]\.\.\/src\/|from\s+['"]\.\.\/src\/)/);
    assert.ok(setAt >= 0, `${name}: não define YUI_AUDIT_FILE`);
    assert.ok(firstImport < 0 || setAt < firstImport, `${name}: define YUI_AUDIT_FILE depois de importar src/`);
    assert.match(src, /YUI_AUDIT_FILE[^\n]*(?:tmp|mkdtemp)/, `${name}: o arquivo de auditoria não está na pasta temporária`);
  }
});

await test('rodando de verdade (cwd temporário, sem YUI_AUDIT_FILE no ambiente) nenhum cria logs/core-audit.jsonl; test-readonly sai com 0', () => {
  for (const name of ['test-readonly', 'test-core-agent', 'test-core-api', 'test-core']) {
    const cwd = newDir(`cwd-${name}`);
    const env = { ...process.env, LOG_LEVEL: 'error' };
    delete env.YUI_AUDIT_FILE;
    delete env.DATABASE_DIR;
    const run = spawnSync(process.execPath, [path.join(root, 'tests', `${name}.js`)], { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    assert.strictEqual(run.status, 0, `${name}: saiu com ${run.status}\n${String(run.stdout).slice(-300)}\n${String(run.stderr).slice(-300)}`);
    assert.ok(!/Assertion failed/.test(`${run.stdout}${run.stderr}`), `${name}: assertion do libuv ao sair`);
    assert.ok(!fs.existsSync(path.join(cwd, 'logs', 'core-audit.jsonl')), `${name}: gravou em logs/core-audit.jsonl`);
  }
});

// =================================================================================================
console.log('7. Estrutura do código alterado');

await test('interactionCreate/radioProviders/deezerMusicHandler/binaries/integrations: sem exec de shell e sem console.* nas partes novas', () => {
  const read = (rel) => fs.readFileSync(path.join(root, rel), 'utf8');
  for (const rel of ['src/music/radioProviders.js', 'src/handlers/deezerMusicHandler.js', 'src/core/api/integrations.js']) {
    const src = read(rel);
    assert.ok(!/\bexecSync\s*\(|\bexec\s*\(/.test(src), `${rel}: exec de shell`);
    assert.ok(!/\bconsole\.(log|warn|error|info)\b/.test(src), `${rel}: console.*`);
  }
  const icSrc = read('src/events/interactionCreate.js');
  const start = icSrc.indexOf('export function musicDeliveryText');
  const end = icSrc.indexOf('function getHelpRegrasPages');
  const novo = icSrc.slice(start, end);
  assert.ok(start > 0 && end > start);
  assert.ok(!/\bconsole\./.test(novo), 'console.* nas funções novas do interactionCreate');
  assert.ok(!/setDescription\(error\.message\)/.test(novo), 'mensagem crua do erro mostrada ao usuário');
  assert.ok(!/Erro ao baixar: \$\{err\.message\}/.test(icSrc), 'mensagem crua do erro mostrada ao usuário (música atual)');
  assert.ok(!/console\.error\('\[BaixarVideo\]'/.test(icSrc));
  assert.match(icSrc, /commandName === 'baixar_video'\) \{\r?\n\s*await runBaixarVideo\(interaction\);/);
  assert.match(icSrc, /deliverMusicResult\(interaction, result,/);
  assert.match(icSrc, /deliverMusicResult\(interaction, musicResult,/);
  assert.match(icSrc, /import \{ baixarMusicaCommand, playlistNote \}/);
  const bin = read('src/utils/binaries.js');
  assert.ok(!/\bexecSync\s*\(/.test(bin));
});

// ---- fim ---------------------------------------------------------------------------------------
process.chdir(root); // o Windows não remove a pasta que é o diretório de trabalho
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* logs ainda abertos no Windows */ }
console.log(`\n${failed === 0 ? 'ok' : 'FALHA'}: ${passed} teste(s) passaram${failed ? `, ${failed} falharam` : ''}.`);
process.exitCode = failed === 0 ? 0 : 1;
// Se algum módulo importado deixar um temporizador vivo, não segura o processo para sempre.
setTimeout(() => process.exit(process.exitCode), 3000).unref();
