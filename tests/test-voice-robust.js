// Testes da robustez de voz/rádio e da infraestrutura de mídia (Opus, yt-dlp), sem Discord e sem rede.
// Os dublês de receiver/stream LANÇAM de propósito: o ouvinte de 'speaking.start' nunca pode propagar
// exceção (uncaughtException) nem deixar promessa rejeitada (unhandledRejection).
// Execução: npm run test:voicerobust
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { PassThrough, Transform } from 'stream';
import { fileURLToPath, pathToFileURL } from 'url';

// Pasta temporária para tudo que a importação possa criar (logs do winston, bancos). Nada real é tocado.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-voice-'));
process.env.DATABASE_DIR = tmp;
process.env.LOG_LEVEL = 'error';
process.chdir(tmp);

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const {
  VOICE_DEFAULTS,
  createSpeakerGuard,
  createSpeakingListener,
  attachSpeakingListener,
  attachConnectionSafety,
  attachPlayerSafety,
  classifyPlaybackError,
  environmentError,
  createFailureBreaker,
  classifyIdleEnd,
  IDLE_DEFAULTS,
  errMsg,
  clampTranscript,
} = await import(new URL('../src/utils/voiceSafety.js', import.meta.url));
const binaries = await import(new URL('../src/utils/binaries.js', import.meta.url));

// Qualquer exceção/rejeição que escape dos ouvintes cai aqui (e reprova o teste), em vez de derrubar o processo.
const escaped = [];
process.on('uncaughtException', (e) => escaped.push(`uncaughtException: ${e?.message}`));
process.on('unhandledRejection', (e) => escaped.push(`unhandledRejection: ${e?.message ?? e}`));

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok  ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FALHA  ${name}\n      ${err.stack || err.message}`);
  }
};
const tick = (ms = 0) => new Promise((r) => (ms ? setTimeout(r, ms) : setImmediate(r)));
async function until(cond, ms = 1000) {
  const t0 = Date.now();
  while (!cond()) {
    if (Date.now() - t0 > ms) throw new Error('tempo esgotado esperando a condição');
    await tick(2);
  }
}

function fakeLog() {
  const log = { info: [], warn: [], error: [] };
  return {
    log,
    logger: {
      info: (m) => log.info.push(String(m)),
      warn: (m) => log.warn.push(String(m)),
      error: (m) => log.error.push(String(m)),
    },
  };
}

/** Monta receiver + ouvinte com dublês configuráveis. */
function setup(over = {}) {
  let now = 1_000_000;
  const clock = { now: () => now, advance: (ms) => { now += ms; } };
  const { log, logger } = fakeLog();
  const receiver = { speaking: new EventEmitter() };
  const calls = { createDecoder: 0, subscribe: 0, audio: [], trip: 0 };
  const guard = createSpeakerGuard({ now: clock.now, ...(over.guardOptions || {}) });
  const handle = attachSpeakingListener(receiver, {
    label: 'VOICE',
    guildId: 'g1',
    guard,
    log: logger,
    createDecoder: () => { calls.createDecoder++; return (over.createDecoder || (() => passthroughDecoder()))(); },
    subscribe: (userId) => { calls.subscribe++; return (over.subscribe || (() => new PassThrough()))(userId); },
    precheck: over.precheck,
    onAudio: over.onAudio || (async (userId, pcm) => { calls.audio.push({ userId, pcm }); }),
    onTrip: () => { calls.trip++; },
    maxStreamMs: over.maxStreamMs,
  });
  return { receiver, calls, log, clock, guard, handle };
}
const passthroughDecoder = () => new Transform({ transform(chunk, enc, cb) { cb(null, chunk); } });
const start = async (receiver, userId) => { receiver.speaking.emit('start', userId); await tick(); await tick(); };

// ───────────────────────────────────────────────────────────────────
console.log('Guarda por usuário');
await test('tryStart: ok -> busy; liberar volta a ok', async () => {
  const g = createSpeakerGuard();
  assert.equal(g.tryStart('a'), 'ok');
  assert.equal(g.tryStart('a'), 'busy');
  assert.equal(g.tryStart('b'), 'ok');
  g.release('a');
  assert.equal(g.tryStart('a'), 'ok');
});
await test('falha aplica backoff de 60 s; passado o prazo volta a aceitar', async () => {
  let now = 0;
  const g = createSpeakerGuard({ now: () => now });
  g.tryStart('a');
  assert.equal(g.fail('a').consecutive, 1);
  assert.equal(g.tryStart('a'), 'backoff');
  now = 59_999;
  assert.equal(g.tryStart('a'), 'backoff');
  now = 60_001;
  assert.equal(g.tryStart('a'), 'ok');
  assert.equal(VOICE_DEFAULTS.failBackoffMs, 60_000);
});
await test('N falhas seguidas desligam a sessão (tripped só uma vez); sucesso zera a contagem', async () => {
  const g = createSpeakerGuard({ maxConsecutiveFailures: 3 });
  for (let i = 0; i < 2; i++) { g.tryStart('u' + i); assert.equal(g.fail('u' + i).tripped, false); }
  g.tryStart('ok'); g.success('ok');
  assert.equal(g.consecutiveFailures(), 0);
  const trips = [];
  for (let i = 0; i < 4; i++) { g.tryStart('v' + i); trips.push(g.fail('v' + i).tripped); }
  assert.deepEqual(trips, [false, false, true, false]);
  assert.equal(g.isDisabled(), true);
  assert.equal(g.tryStart('novo'), 'disabled');
});
await test('shouldLog limita o log repetido por etiqueta', async () => {
  let now = 0;
  const g = createSpeakerGuard({ now: () => now });
  assert.equal(g.shouldLog('ban:1', 1000), true);
  assert.equal(g.shouldLog('ban:1', 1000), false);
  assert.equal(g.shouldLog('ban:2', 1000), true);
  now = 1001;
  assert.equal(g.shouldLog('ban:1', 1000), true);
});

// ───────────────────────────────────────────────────────────────────
console.log("Ouvinte de 'speaking.start' com dublês que lançam");
await test('Decoder que lança (sem Opus): o emit NÃO propaga, registra UMA vez mesmo com 200 pacotes, aplica backoff', async () => {
  const s = setup({ createDecoder: () => { throw new Error('Could not find an Opus module! Please install @discordjs/opus, node-opus, or opusscript.'); } });
  for (let i = 0; i < 200; i++) s.receiver.speaking.emit('start', 'u1'); // enxurrada: ~50 pacotes/s reemitindo 'start'
  await tick(); await tick();
  for (let i = 0; i < 200; i++) s.receiver.speaking.emit('start', 'u1');
  await tick();
  assert.equal(s.calls.createDecoder, 1, 'tentou criar o Decoder só uma vez');
  assert.equal(s.calls.subscribe, 0, 'sem Decoder não assina o áudio do usuário (nada pendurado)');
  assert.equal(s.log.warn.length, 1, 'um único registro');
  assert.match(s.log.warn[0], /servidor g1, usuário u1/);
  assert.match(s.log.warn[0], /Opus module/);
  assert.ok(!s.log.warn[0].includes('\n'), 'só a primeira linha do erro');
  assert.equal(s.guard.isActive('g1_u1'), false, 'a chave foi liberada');
  assert.ok(s.guard.failedUntil('g1_u1') > s.clock.now(), 'e ficou em backoff');
});
await test('passado o backoff, o usuário volta a ser tentado (a chave não fica presa até reiniciar)', async () => {
  const s = setup({ createDecoder: () => { throw new Error('falha'); } });
  await start(s.receiver, 'u1');
  await start(s.receiver, 'u1');
  assert.equal(s.calls.createDecoder, 1);
  s.clock.advance(61_000);
  await start(s.receiver, 'u1');
  assert.equal(s.calls.createDecoder, 2);
  assert.equal(s.log.warn.length, 2);
});
await test('subscribe que lança: o Decoder já criado é destruído e a falha é registrada', async () => {
  let dec;
  const s = setup({ createDecoder: () => (dec = passthroughDecoder()), subscribe: () => { throw new Error('sem permissão'); } });
  await start(s.receiver, 'u1');
  assert.equal(s.log.warn.length, 1);
  assert.equal(dec.destroyed, true);
  assert.equal(s.guard.isActive('g1_u1'), false);
});
await test("'error' no stream Opus (decifragem/DAVE) depois do pipe: tratado, sem Uncaught Exception", async () => {
  const opus = new PassThrough();
  const s = setup({ subscribe: () => opus });
  await start(s.receiver, 'u1');
  opus.emit('error', new Error('Failed to decrypt: DecryptionFailed'));
  await tick(); await tick();
  assert.equal(s.log.warn.length, 1);
  assert.match(s.log.warn[0], /decrypt/i);
  assert.ok(s.guard.failedUntil('g1_u1') > 0);
  assert.equal(s.calls.audio.length, 0);
  opus.emit('error', new Error('outro erro tardio')); // erro depois de resolvido continua tendo ouvinte
  await tick();
});
await test("'error' no Decoder: tratado, chave liberada com backoff", async () => {
  const dec = passthroughDecoder();
  const s = setup({ createDecoder: () => dec });
  await start(s.receiver, 'u1');
  dec.emit('error', new Error('corrupted compressed data'));
  await tick();
  assert.equal(s.log.warn.length, 1);
  assert.equal(s.guard.isActive('g1_u1'), false);
  assert.equal(s.guard.tryStart('g1_u1'), 'backoff');
});
await test('precheck ASSÍNCRONO que rejeita (ouvinte do rádio) não vira Unhandled Rejection', async () => {
  const s = setup({ precheck: async () => { throw new Error('falha ao carregar o módulo'); } });
  await start(s.receiver, 'u1');
  assert.equal(s.log.warn.length, 1);
  assert.equal(s.guard.isActive('g1_u1'), false);
});
await test('precheck false: ignora a fala sem contar falha nem backoff', async () => {
  const s = setup({ precheck: () => false });
  await start(s.receiver, 'u1');
  assert.equal(s.calls.createDecoder, 0);
  assert.equal(s.log.warn.length, 0);
  assert.equal(s.guard.consecutiveFailures(), 0);
  assert.equal(s.guard.tryStart('g1_u1'), 'ok');
});
await test('após N falhas seguidas: desliga a escuta da sessão, loga UMA vez com clareza e remove o ouvinte', async () => {
  const s = setup({ createDecoder: () => { throw new Error('sem Opus'); } });
  assert.equal(s.receiver.speaking.listenerCount('start'), 1);
  for (let i = 1; i <= VOICE_DEFAULTS.maxConsecutiveFailures; i++) await start(s.receiver, 'u' + i);
  assert.equal(s.calls.trip, 1, 'onTrip chamado uma vez');
  assert.equal(s.log.error.length, 1);
  assert.match(s.log.error[0], /Escuta de voz DESLIGADA/);
  assert.match(s.log.error[0], /servidor g1/);
  assert.equal(s.guard.isDisabled(), true);
  assert.equal(s.receiver.speaking.listenerCount('start'), 0, 'ouvinte removido do receiver');
  const antes = s.calls.createDecoder;
  await start(s.receiver, 'u99');
  assert.equal(s.calls.createDecoder, antes, 'nada mais é tentado');
});
await test('um sucesso no meio zera a contagem: 4 falhas + sucesso + 4 falhas não desligam', async () => {
  let falhar = true;
  let ultimoOpus;
  const s = setup({
    createDecoder: () => { if (falhar) throw new Error('x'); return passthroughDecoder(); },
    subscribe: () => (ultimoOpus = new PassThrough()),
  });
  for (let i = 1; i <= 4; i++) await start(s.receiver, 'a' + i);
  assert.equal(s.guard.consecutiveFailures(), 4);
  falhar = false;
  await start(s.receiver, 'bom');
  ultimoOpus.write(Buffer.alloc(4)); ultimoOpus.end();
  await until(() => s.guard.consecutiveFailures() === 0);
  falhar = true;
  for (let i = 1; i <= 4; i++) await start(s.receiver, 'b' + i);
  assert.equal(s.guard.consecutiveFailures(), 4);
  assert.equal(s.guard.isDisabled(), false);
  assert.equal(s.calls.trip, 0);
});
await test('captura normal: junta os blocos PCM, entrega ao onAudio e libera a chave NA HORA', async () => {
  const opus = new PassThrough();
  const s = setup({ subscribe: () => opus });
  await start(s.receiver, 'u1');
  assert.equal(s.guard.isActive('g1_u1'), true);
  opus.write(Buffer.from('aa')); opus.write(Buffer.from('bb')); opus.end();
  await until(() => s.calls.audio.length === 1);
  assert.equal(s.calls.audio[0].userId, 'u1');
  assert.equal(s.calls.audio[0].pcm.toString(), 'aabb');
  assert.equal(s.guard.isActive('g1_u1'), false);
  assert.equal(s.log.warn.length, 0);
});
await test('onAudio que lança (ex.: transcrição) só é registrado; não conta como falha de captura nem vira rejeição', async () => {
  const opus = new PassThrough();
  const s = setup({ subscribe: () => opus, onAudio: async () => { throw new Error('STT fora do ar'); } });
  await start(s.receiver, 'u1');
  opus.write(Buffer.alloc(4)); opus.end();
  await until(() => s.log.warn.length === 1);
  assert.match(s.log.warn[0], /processar o áudio/);
  assert.match(s.log.warn[0], /STT fora do ar/);
  assert.equal(s.guard.consecutiveFailures(), 0);
  assert.equal(s.guard.tryStart('g1_u1'), 'ok');
});
await test('Decoder fechado sem end/erro libera a chave (não fica presa)', async () => {
  const dec = passthroughDecoder();
  const s = setup({ createDecoder: () => dec });
  await start(s.receiver, 'u1');
  dec.destroy();
  await until(() => !s.guard.isActive('g1_u1'));
  assert.equal(s.log.warn.length, 0);
});
await test('assinatura Opus derrubada sem end: o que já chegou é processado e a chave é liberada', async () => {
  const opus = new PassThrough();
  const s = setup({ subscribe: () => opus });
  await start(s.receiver, 'u1');
  opus.write(Buffer.from('meio'));
  await tick();
  opus.destroy();
  await until(() => s.calls.audio.length === 1);
  assert.equal(s.calls.audio[0].pcm.toString(), 'meio');
  assert.equal(s.guard.isActive('g1_u1'), false);
});
await test('fala longa demais: o teto encerra a captura e processa o que já foi captado', async () => {
  const opus = new PassThrough();
  const s = setup({ subscribe: () => opus, maxStreamMs: 25 });
  await start(s.receiver, 'u1');
  opus.write(Buffer.from('parcial'));
  await until(() => s.calls.audio.length === 1, 1500);
  assert.equal(s.calls.audio[0].pcm.toString(), 'parcial');
  assert.ok(s.log.warn.some((m) => /Fala acima de/.test(m)));
  assert.equal(s.guard.isActive('g1_u1'), false);
});

// D7 / TG-35: limites da voz. Trechos acima de 30 s são encerrados na captura e a transcrição segue com no máximo 1500 caracteres.
console.log('Limites da voz (D7 / TG-35)');
await test('D7: os padrões são 30 s por fala e 1500 caracteres por transcrição, e a tabela é imutável', async () => {
  assert.equal(VOICE_DEFAULTS.maxStreamMs, 30_000);
  assert.equal(VOICE_DEFAULTS.maxTranscriptChars, 1500);
  assert.ok(Object.isFrozen(VOICE_DEFAULTS));
  // Um WAV de 30 s (48 kHz, estéreo, 16 bits) fica bem abaixo dos 22 MB de 120 s, que os provedores de STT tendem a recusar.
  const wavBytes = (VOICE_DEFAULTS.maxStreamMs / 1000) * 48000 * 2 * 2 + 44;
  assert.ok(wavBytes < 6 * 1024 * 1024, `WAV de ${wavBytes} bytes`);
});
await test('D7: sem maxStreamMs explícito o temporizador é de 30 s; ao disparar a captura é encerrada, só o que já veio segue e o log fala em 30s', async () => {
  const opus = new PassThrough();
  const { log, logger } = fakeLog();
  const timers = [];
  const guard = createSpeakerGuard();
  const audio = [];
  const listener = createSpeakingListener({
    label: 'VOICE', guildId: 'g1', guard, log: logger,
    createDecoder: () => passthroughDecoder(),
    subscribe: () => opus,
    onAudio: async (userId, pcm) => { audio.push(pcm.toString()); },
    setTimeoutImpl: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearTimeoutImpl: () => {},
  });
  listener('u1');
  await until(() => timers.length === 1);
  assert.equal(timers[0].ms, 30_000, 'o padrão do ouvinte vem de VOICE_DEFAULTS.maxStreamMs');
  opus.write(Buffer.from('primeiros-trinta-segundos'));
  await tick();
  timers[0].fn(); // passaram 30 s e a pessoa continua falando
  await until(() => audio.length === 1);
  assert.equal(audio[0], 'primeiros-trinta-segundos');
  assert.ok(log.warn.some((m) => /Fala acima de 30s/.test(m)), log.warn.join(' | '));
  assert.equal(opus.destroyed, true, 'a assinatura Opus é derrubada: o resto da fala não é guardado');
  assert.equal(guard.isActive('g1_u1'), false);
  assert.equal(guard.consecutiveFailures(), 0, 'encerrar por tempo não é falha de captura');
  assert.equal(guard.isDisabled(), false);
});
await test('D7: fala que termina antes dos 30 s cancela o temporizador (nada é cortado)', async () => {
  const opus = new PassThrough();
  const { log, logger } = fakeLog();
  const timers = [];
  const cleared = [];
  const audio = [];
  const listener = createSpeakingListener({
    label: 'VOICE', guildId: 'g1', guard: createSpeakerGuard(), log: logger,
    createDecoder: () => passthroughDecoder(),
    subscribe: () => opus,
    onAudio: async (userId, pcm) => { audio.push(pcm.toString()); },
    setTimeoutImpl: (fn, ms) => { const t = { fn, ms, unref() {} }; timers.push(t); return t; },
    clearTimeoutImpl: (t) => cleared.push(t),
  });
  listener('u1');
  await until(() => timers.length === 1);
  opus.write(Buffer.from('curta'));
  opus.end();
  await until(() => audio.length === 1);
  assert.equal(audio[0], 'curta');
  assert.deepEqual(cleared, [timers[0]]);
  assert.equal(log.warn.length, 0);
});
await test('clampTranscript: texto curto passa inteiro; exatamente 1500 passa inteiro; acima disso corta só o FIM', async () => {
  assert.equal(clampTranscript('Yui, que horas são?'), 'Yui, que horas são?');
  assert.equal(clampTranscript(''), '');
  const exato = 'a'.repeat(1500);
  assert.equal(clampTranscript(exato), exato);
  const out = clampTranscript('Yui, ' + 'x'.repeat(5000));
  assert.equal(out.length, 1500);
  assert.ok(out.startsWith('Yui, xxx'), 'a palavra de ativação e o começo do pedido ficam');
  assert.equal(clampTranscript('a'.repeat(1501)).length, 1500);
});
await test('clampTranscript: prefere terminar numa palavra (últimos 10%), tira o espaço final e nunca passa do teto', async () => {
  const out = clampTranscript('palavra '.repeat(400)); // 3200 caracteres
  assert.ok(out.length <= 1500 && out.length > 1350, String(out.length));
  assert.ok(out.endsWith('palavra'), 'não deixa meia palavra no fim');
  assert.ok(!/\s$/.test(out));
  assert.equal(clampTranscript('abcdefghij klmnopqrst', 11), 'abcdefghij');
  assert.equal(clampTranscript('abcdefghij klmnopqrst', 10), 'abcdefghij', 'o corte cai exatamente antes do espaço');
  // Fronteira de palavra longe demais (fora dos 10% finais): corte seco no teto.
  const longe = clampTranscript('a'.repeat(50) + ' ' + 'b'.repeat(100), 100);
  assert.equal(longe.length, 100);
  assert.ok(longe.endsWith('b'));
});
await test('clampTranscript: nunca deixa meio par substituto (emoji) no fim; emoji inteiro dentro do teto fica', async () => {
  const partido = clampTranscript('a'.repeat(1499) + '😀' + 'b'.repeat(10)); // o corte em 1500 cairia no meio do emoji
  assert.equal(partido, 'a'.repeat(1499));
  assert.ok(!/[\ud800-\udbff]$/.test(partido));
  const inteiro = clampTranscript('a'.repeat(1498) + '😀' + 'b'.repeat(10));
  assert.equal(inteiro, 'a'.repeat(1498) + '😀');
  assert.equal(inteiro.length, 1500);
  assert.equal(clampTranscript('😀😀😀', 1), '', 'teto menor que um emoji: vazio, nunca meio emoji');
});
await test('clampTranscript: entradas estranhas viram texto vazio ou o texto inteiro, sem lançar', async () => {
  for (const bad of [null, undefined, 42, {}, [], true, Symbol('x')]) assert.equal(clampTranscript(bad), '');
  for (const max of [0, -5, NaN, 'abc', null]) assert.equal(clampTranscript('texto', max), '');
  assert.equal(clampTranscript('texto qualquer', 2.9), 'te', 'o teto fracionário é arredondado para baixo');
  assert.equal(clampTranscript('texto qualquer', Infinity), 'texto qualquer');
  assert.equal(clampTranscript('texto', undefined), 'texto', 'sem max usa o padrão de 1500');
  assert.equal(clampTranscript(' '.repeat(3000)), '', 'só espaços: vazio (quem chama trata como sem pedido)');
});
await test('clampTranscript (fuzz de 3000 textos, semente fixa): nunca passa do teto, é prefixo do original, sem par substituto partido', async () => {
  let seed = 20261014;
  const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
  const alphabet = ['a', 'b', 'é', 'ç', ' ', ' ', '\n', ',', '😀', '👍🏽', 'ã', '。'];
  for (let n = 0; n < 3000; n++) {
    const len = Math.floor(rnd() * 400);
    let text = '';
    for (let i = 0; i < len; i++) text += alphabet[Math.floor(rnd() * alphabet.length)];
    const max = 1 + Math.floor(rnd() * 300);
    const out = clampTranscript(text, max);
    assert.ok(out.length <= max, `passou do teto (${out.length} > ${max})`);
    assert.ok(text.startsWith(out), 'o resultado é sempre o começo do original');
    assert.ok(!/[\ud800-\udbff]$/.test(out), 'par substituto partido');
    if (text.length <= max) assert.equal(out, text, 'texto dentro do teto passa intacto');
    else assert.ok(!/\s$/.test(out), 'espaço sobrando no fim');
  }
});
await test('com o SpeakingMap REAL do @discordjs/voice: ouvinte cru lança a cada pacote (o bug); o nosso lança zero vezes', async () => {
  const { SpeakingMap } = await import('@discordjs/voice');
  // Controle: o SpeakingMap emite 'start' ANTES de armar o timeout, então um ouvinte que lança é reemitido a cada pacote.
  const cru = new SpeakingMap();
  let lancou = 0;
  cru.on('start', () => { throw new Error('Could not find an Opus module!'); });
  for (let i = 0; i < 50; i++) { try { cru.onPacket('u1'); } catch { lancou++; } }
  assert.equal(lancou, 50, 'sem proteção, cada pacote (~50/s) vira uma exceção');

  const speaking = new SpeakingMap();
  const { log, logger } = fakeLog();
  let decoders = 0;
  attachSpeakingListener({ speaking }, {
    label: 'VOICE', guildId: 'g1', log: logger,
    createDecoder: () => { decoders++; throw new Error('Could not find an Opus module!'); },
    subscribe: () => new PassThrough(), onAudio: async () => {},
  });
  for (let i = 0; i < 50; i++) speaking.onPacket('u1'); // não pode lançar
  await tick(); await tick();
  for (let i = 0; i < 50; i++) speaking.onPacket('u1');
  assert.equal(decoders, 1);
  assert.equal(log.warn.length, 1);
  await tick(150); // deixa o timeout interno do SpeakingMap terminar
});
await test('Decoder REAL do prism-media: sem Opus a falha é registrada (uma vez); com Opus instalado não há falha', async () => {
  const { default: prism } = await import('prism-media');
  const opusOk = binaries.isOpusAvailable();
  const { log, logger } = fakeLog();
  const speaking = new EventEmitter();
  attachSpeakingListener({ speaking }, {
    label: 'VOICE', guildId: 'g1', log: logger,
    createDecoder: () => new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }),
    subscribe: () => new PassThrough(), onAudio: async () => {},
  });
  speaking.emit('start', 'u1');
  await tick(); await tick();
  assert.equal(log.warn.length, opusOk ? 0 : 1);
  if (!opusOk) assert.match(log.warn[0], /Cannot find module|Opus module/);
});
await test('o ouvinte devolvido por createSpeakingListener nunca lança, mesmo com guarda quebrada', async () => {
  const { logger } = fakeLog();
  const listener = createSpeakingListener({
    label: 'VOICE', guildId: 'g', log: logger,
    guard: { tryStart: () => { throw new Error('guarda quebrada'); }, release() {}, fail() { return {}; }, success() {} },
    createDecoder: () => passthroughDecoder(), subscribe: () => new PassThrough(), onAudio: async () => {},
  });
  listener('u1'); // não deve lançar
});

// ───────────────────────────────────────────────────────────────────
console.log("'error' em conexão e player");
await test("sem ouvinte, emit('error') lança (é o bug); com attachConnectionSafety não lança e registra", async () => {
  const conn = new EventEmitter();
  assert.throws(() => conn.emit('error', new Error('x')));
  const { log, logger } = fakeLog();
  attachConnectionSafety(conn, { label: 'VOICE', guildId: 'g1', log: logger });
  assert.equal(conn.listenerCount('error'), 1);
  conn.emit('error', new Error('Cannot perform IP discovery'));
  assert.match(log.warn[0], /Erro na conexão de voz \(servidor g1\): Cannot perform IP discovery/);
});
await test('attachPlayerSafety registra o erro do AudioPlayer sem lançar', async () => {
  const player = new EventEmitter();
  const { log, logger } = fakeLog();
  attachPlayerSafety(player, { label: 'VOICE', guildId: 'g1', log: logger });
  player.emit('error', new Error('Premature close'));
  assert.equal(log.warn.length, 1);
});
await test('errMsg: primeira linha, no máximo 200 caracteres, aceita qualquer coisa', async () => {
  assert.equal(errMsg(new Error('linha1\nlinha2')), 'linha1');
  assert.equal(errMsg('x'.repeat(500)).length, 200);
  assert.equal(errMsg(undefined), 'erro desconhecido');
});

// ───────────────────────────────────────────────────────────────────
console.log('Disjuntor do rádio');
await test('classifica ambiente quebrado x música que não toca', async () => {
  assert.equal(classifyPlaybackError(new Error('Could not find an Opus module! Please install @discordjs/opus, node-opus, or opusscript.')), 'environment');
  assert.equal(classifyPlaybackError(Object.assign(new Error('spawn ffmpeg.exe ENOENT'), { code: 'ENOENT' })), 'environment');
  assert.equal(classifyPlaybackError(environmentError('ffmpeg não encontrado')), 'environment');
  assert.equal(classifyPlaybackError(new Error('Cannot play audio as no valid encryption package is installed.')), 'environment');
  assert.equal(classifyPlaybackError(new Error('Timeout de 30s aguardando stream do YouTube')), 'track');
  assert.equal(classifyPlaybackError(new Error('Video unavailable')), 'track');
  assert.equal(classifyPlaybackError(Object.assign(new Error('qualquer'), { kind: 'track' })), 'track');
});
await test('faixa que falha sempre (loop TRACK) para depois de 5 falhas seguidas, não repete para sempre', async () => {
  const b = createFailureBreaker();
  const veredictos = [];
  for (let i = 0; i < 5; i++) veredictos.push(b.recordFailure('g1', 'track').trip);
  assert.deepEqual(veredictos, [false, false, false, false, true]);
});
await test('ambiente quebrado (sem Opus/ffmpeg) para mais cedo: 2 falhas', async () => {
  const b = createFailureBreaker();
  assert.equal(b.recordFailure('g1', 'environment').trip, false);
  const v = b.recordFailure('g1', 'environment');
  assert.equal(v.trip, true);
  assert.equal(v.kind, 'environment');
});
await test('uma falha de ambiente no meio de falhas de faixa classifica a sequência como ambiente', async () => {
  const b = createFailureBreaker();
  b.recordFailure('g1', 'track');
  const v = b.recordFailure('g1', 'environment');
  assert.equal(v.kind, 'environment');
  assert.equal(v.trip, true);
});
await test('sucesso e reset zeram a contagem; servidores são independentes', async () => {
  const b = createFailureBreaker();
  b.recordFailure('g1', 'track'); b.recordFailure('g1', 'track'); b.recordFailure('g2', 'track');
  assert.equal(b.count('g1'), 2);
  assert.equal(b.count('g2'), 1);
  b.recordSuccess('g1');
  assert.equal(b.count('g1'), 0);
  b.reset('g2');
  assert.equal(b.count('g2'), 0);
});

// ───────────────────────────────────────────────────────────────────
console.log('Opus e dependências de voz (binaries.js)');
function fakePrism({ encoderThrows = false, decoderThrows = false, type = 'opusscript' } = {}) {
  const made = [];
  class Enc {
    static get type() { return type; }
    constructor() { if (encoderThrows) throw new Error('Could not find an Opus module! Please install @discordjs/opus, node-opus, or opusscript.'); this.destroyed = false; made.push(this); }
    destroy() { this.destroyed = true; }
  }
  class Dec {
    constructor() { if (decoderThrows) throw new Error('decoder quebrado'); this.destroyed = false; made.push(this); }
    destroy() { this.destroyed = true; }
  }
  return { prism: { opus: { Encoder: Enc, Decoder: Dec } }, made };
}
await test('isOpusAvailable: true com módulo falso que funciona (e libera o que criou)', async () => {
  const { prism, made } = fakePrism({ type: 'opusscript' });
  assert.equal(binaries.isOpusAvailable({ prismImpl: prism }), true);
  const r = binaries.checkOpus({ prismImpl: prism });
  assert.equal(r.ok, true);
  assert.equal(r.backend, 'opusscript');
  assert.ok(made.length >= 2 && made.every((s) => s.destroyed));
});
await test('isOpusAvailable: false quando o Encoder lança (módulo ausente), sem propagar', async () => {
  const { prism } = fakePrism({ encoderThrows: true });
  assert.equal(binaries.isOpusAvailable({ prismImpl: prism }), false);
  const r = binaries.checkOpus({ prismImpl: prism });
  assert.equal(r.ok, false);
  assert.match(r.error, /Opus module/);
});
await test('Decoder que lança: o Encoder já criado não fica vazado', async () => {
  const { prism, made } = fakePrism({ decoderThrows: true });
  assert.equal(binaries.isOpusAvailable({ prismImpl: prism }), false);
  assert.ok(made.length === 1 && made[0].destroyed);
});
await test('isOpusAvailable real não lança (resultado depende de o opusscript estar instalado)', async () => {
  assert.equal(typeof binaries.isOpusAvailable(), 'boolean');
});

const REPORT_SEM_OPUS = `--------------------------------------------------
Core Dependencies
- @discordjs/voice: 0.19.2
- prism-media: 1.3.5

Opus Libraries
- @discordjs/opus: not found
- opusscript: not found

Encryption Libraries
- native crypto support for aes-256-gcm: yes
- sodium-native: not found
- sodium: not found
- libsodium-wrappers: not found
- @stablelib/xchacha20poly1305: not found
- @noble/ciphers: not found

DAVE Libraries
- @snazzah/davey: 0.1.12

FFmpeg
- version: 2026-02-09-git-9bfa1635ae-full_build-www.gyan.dev
- libopus: yes
--------------------------------------------------`;
await test('parseDependencyReport: AES-GCM nativo sem bibliotecas, DAVE presente, sem Opus', async () => {
  const r = binaries.parseDependencyReport(REPORT_SEM_OPUS);
  assert.equal(r.aesGcm, true);
  assert.deepEqual(r.cryptoLibs, []);
  assert.deepEqual(r.opusLibs, []);
  assert.equal(r.cryptoOk, true);
  assert.equal(r.dave, '@snazzah/davey 0.1.12');
});
await test('parseDependencyReport: acha opusscript e @noble/ciphers; sem nenhum modo de criptografia -> cryptoOk false', async () => {
  const com = REPORT_SEM_OPUS.replace('- opusscript: not found', '- opusscript: 0.0.8').replace('- @noble/ciphers: not found', '- @noble/ciphers: 2.4.0');
  const r = binaries.parseDependencyReport(com);
  assert.deepEqual(r.opusLibs, ['opusscript']);
  assert.deepEqual(r.cryptoLibs, ['@noble/ciphers']);
  const sem = REPORT_SEM_OPUS.replace('aes-256-gcm: yes', 'aes-256-gcm: no').replace('- @snazzah/davey: 0.1.12', '- @snazzah/davey: not found');
  const s = binaries.parseDependencyReport(sem);
  assert.equal(s.cryptoOk, false);
  assert.equal(s.dave, null);
});
await test('checkVoiceDependencies: usa generateDependencyReport e não lança se o import falhar', async () => {
  const ok = await binaries.checkVoiceDependencies({ importVoice: async () => ({ generateDependencyReport: () => REPORT_SEM_OPUS }) });
  assert.equal(ok.ok, true);
  assert.equal(ok.cryptoOk, true);
  const ruim = await binaries.checkVoiceDependencies({ importVoice: async () => { throw new Error('módulo quebrado'); } });
  assert.equal(ruim.ok, false);
  assert.match(ruim.error, /módulo quebrado/);
});

console.log('yt-dlp: atualização (sem rodar nada de verdade)');
await test('updateYtdlp: execFile com array de argumentos, sem shell, com timeout e janela oculta', async () => {
  const calls = [];
  const exec = (file, args, opts, cb) => { calls.push({ file, args, opts }); cb(null, 'yt-dlp is up to date (2026.10.01)\nresto', ''); };
  assert.equal(await binaries.updateYtdlp({ execFileImpl: exec, binary: 'yt-dlp-falso.exe', timeoutMs: 5000 }), true);
  assert.equal(calls[0].file, 'yt-dlp-falso.exe');
  assert.deepEqual(calls[0].args, ['-U']);
  assert.equal(calls[0].opts.timeout, 5000);
  assert.equal(calls[0].opts.windowsHide, true);
  assert.ok(calls[0].opts.maxBuffer > 0);
});
await test('updateYtdlp: erro do comando ou exceção viram false (só aviso), nunca lançam', async () => {
  assert.equal(await binaries.updateYtdlp({ binary: 'x', execFileImpl: (f, a, o, cb) => cb(new Error('boom'), '', 'ERROR: sem rede') }), false);
  assert.equal(await binaries.updateYtdlp({ binary: 'x', execFileImpl: () => { throw new Error('EACCES'); } }), false);
});

function fakeTimers() {
  const t = { timeouts: [], intervals: [] };
  t.setTimeoutImpl = (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true; return h; } }; t.timeouts.push(h); return h; };
  t.setIntervalImpl = (fn, ms) => { const h = { fn, ms, unref() { h.unrefd = true; return h; } }; t.intervals.push(h); return h; };
  t.clearTimeoutImpl = () => {};
  t.clearIntervalImpl = () => {};
  return t;
}
await test('startYtdlpAutoUpdate: roda uma vez após a inicialização (sem bloquear) e depois uma vez por dia a partir das 04h', async () => {
  const t = fakeTimers();
  const runs = [];
  let date = new Date(2026, 9, 14, 14, 0, 0);
  const handle = binaries.startYtdlpAutoUpdate({
    env: {}, updater: async () => { runs.push(date.toISOString()); }, now: () => date, ...t,
  });
  assert.equal(runs.length, 0, 'nada roda na hora do start (não bloqueia o boot)');
  assert.equal(t.timeouts.length, 1);
  assert.equal(t.intervals.length, 1);
  assert.ok(t.timeouts[0].unrefd && t.intervals[0].unrefd, 'temporizadores com unref');
  t.timeouts[0].fn(); await tick();
  assert.equal(runs.length, 1, 'atualização de inicialização');
  date = new Date(2026, 9, 14, 23, 0, 0); t.intervals[0].fn(); await tick();
  assert.equal(runs.length, 1, 'no mesmo dia não repete');
  date = new Date(2026, 9, 15, 2, 0, 0); t.intervals[0].fn(); await tick();
  assert.equal(runs.length, 1, 'antes das 04h não roda');
  date = new Date(2026, 9, 15, 4, 5, 0); t.intervals[0].fn(); await tick();
  assert.equal(runs.length, 2, 'primeira checagem depois das 04h do dia seguinte');
  date = new Date(2026, 9, 15, 4, 35, 0); t.intervals[0].fn(); await tick();
  assert.equal(runs.length, 2, 'uma vez por dia');
  handle.stop();
});
await test('startYtdlpAutoUpdate: YTDLP_UPDATE_HOUR muda o horário; falha do atualizador não derruba nada; é idempotente', async () => {
  const t = fakeTimers();
  let date = new Date(2026, 9, 14, 5, 0, 0);
  let n = 0;
  const handle = binaries.startYtdlpAutoUpdate({ env: { YTDLP_UPDATE_HOUR: '6' }, updater: async () => { n++; throw new Error('sem rede'); }, now: () => date, ...t });
  const outro = binaries.startYtdlpAutoUpdate({ env: {}, updater: async () => {}, now: () => date, ...t });
  assert.equal(outro, handle);
  assert.equal(t.timeouts.length, 1, 'segunda chamada não cria outro temporizador');
  t.timeouts[0].fn(); await tick();
  assert.equal(n, 1);
  date = new Date(2026, 9, 15, 5, 59, 0); t.intervals[0].fn(); await tick();
  assert.equal(n, 1, 'antes das 06h');
  date = new Date(2026, 9, 15, 6, 0, 0); t.intervals[0].fn(); await tick();
  assert.equal(n, 2);
  handle.stop();
});
await test('startYtdlpAutoUpdate: YTDLP_AUTO_UPDATE=false desliga (nenhum temporizador)', async () => {
  const t = fakeTimers();
  binaries.startYtdlpAutoUpdate({ env: { YTDLP_AUTO_UPDATE: 'false' }, updater: async () => { throw new Error('não devia rodar'); }, ...t });
  assert.equal(t.timeouts.length + t.intervals.length, 0);
});

// ───────────────────────────────────────────────────────────────────
console.log('Rádio: julgamento do Idle (função pura)');
const estadoIdle = (status, playbackDuration) => ({ status, resource: { playbackDuration } });
await test('classifyIdleEnd: parada forçada nossa / recurso que não é o atual => ignore', async () => {
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 0), isCurrent: false }), 'ignore');
  assert.equal(classifyIdleEnd({ oldState: undefined, isCurrent: false }), 'ignore');
});
await test('classifyIdleEnd: terminou sem erro e quase sem áudio (<1 s) => failure, tanto Playing quanto Buffering', async () => {
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 0), isCurrent: true }), 'failure');
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 999), isCurrent: true }), 'failure');
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('buffering', 0), isCurrent: true }), 'failure');
  assert.equal(classifyIdleEnd({ oldState: { status: 'playing', resource: {} }, isCurrent: true }), 'failure', 'sem playbackDuration = 0 ms');
});
await test('classifyIdleEnd: tocou >= 3 s sem erro => success; entre 1 s e 3 s => neutral', async () => {
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 3000), isCurrent: true }), 'success');
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 1000), isCurrent: true }), 'neutral');
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 2999), isCurrent: true }), 'neutral');
  assert.equal(IDLE_DEFAULTS.emptyMs, 1000);
  assert.equal(IDLE_DEFAULTS.successMs, 3000);
});
await test('classifyIdleEnd: o erro já foi contado pelo ouvinte de error (errored) => neutral, nunca conta duas vezes', async () => {
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 0), isCurrent: true, errored: true }), 'neutral');
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('playing', 9000), isCurrent: true, errored: true }), 'neutral');
});
await test('classifyIdleEnd: estados que não são fim natural (pausa) mantêm o comportamento antigo (neutral)', async () => {
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('paused', 0), isCurrent: true }), 'neutral');
  assert.equal(classifyIdleEnd({ oldState: estadoIdle('autopaused', 0), isCurrent: true }), 'neutral');
});

// ───────────────────────────────────────────────────────────────────
console.log('Rádio: radioAudioPlayer REAL com AudioPlayer REAL (banco, provedores, embed e relógio trocados por dublês)');
const realWait = (ms) => new Promise((r) => setTimeout(r, ms));
const VOICE_URL = import.meta.resolve('@discordjs/voice');

/**
 * Carrega uma CÓPIA do src/music/radioAudioPlayer.js (em pasta temporária) com os imports trocados por dublês:
 * o banco de sessões (o real grava em src/music/data), os provedores, o embed, o yt-dlp e o logger.
 * O AudioPlayer e o AudioResource são os REAIS do @discordjs/voice; só a conexão de voz é falsa.
 * O setTimeout do módulo vira um relógio virtual (H.advance), para a janela de transição de 1,5 s não custar tempo.
 */
async function createRadioHarness({ playlist = ['good'], loopMode = 'OFF' } = {}) {
  const dir = fs.mkdtempSync(path.join(tmp, 'radio-'));
  const H = {
    sessions: new Map(),
    streams: [],
    updates: [],
    logs: { info: [], warn: [], error: [] },
    sent: [],
    clock: 0,
    timers: [],
    connection: null,
  };
  H.setTimeout = (fn, ms) => {
    const t = { fn, at: H.clock + (ms || 0), done: false, unref() { return t; } };
    H.timers.push(t);
    return t;
  };
  H.advance = async (ms) => {
    const target = H.clock + ms;
    for (;;) {
      await tick(); await tick();
      const due = H.timers.filter((t) => !t.done && t.at <= target).sort((a, b) => a.at - b.at)[0];
      if (!due) break;
      due.done = true;
      H.clock = Math.max(H.clock, due.at);
      due.fn();
    }
    H.clock = target;
    await tick(); await tick();
  };
  H.connection = {
    state: { status: 'ready' },
    subscribe(player) { const sub = { connection: H.connection, player, unsubscribe() {} }; player.subscribers.push(sub); return sub; },
    dispatchAudio: () => true,
    prepareAudioPacket: (b) => b,
    setSpeaking() {},
  };
  const textChannel = {
    send: async (m) => { H.sent.push(m); return { id: `m${H.sent.length}` }; },
    messages: { fetch: async () => ({ edit: async () => {} }) },
  };
  const tracks = playlist.map((link, i) => ({ title: `Faixa ${i}`, link, source: 'youtube' }));
  H.sessions.set('g1', { guildId: 'g1', status: 'IDLE', playlist: tracks, currentIndex: 0, loopMode, embedMessageId: 'e1', currentTrack: tracks[0] });

  globalThis.__radioHarness = H;
  const write = (name, code) => { const f = path.join(dir, name); fs.writeFileSync(f, code); return pathToFileURL(f).href; };
  const urls = {
    voice: write('voice.mjs', `export * from '${VOICE_URL}';\nconst H = globalThis.__radioHarness;\nexport function getVoiceConnection(g) { return g === 'g1' ? H.connection : null; }\n`),
    db: write('db.mjs', `const H = globalThis.__radioHarness;
export function getSession(g) { return H.sessions.get(g) || null; }
export function updateSession(g, patch) { const s = H.sessions.get(g); if (!s) return null; H.updates.push({ g, patch: { ...patch } }); Object.assign(s, patch); return s; }
export function nextTrack(g) {
  const s = H.sessions.get(g);
  if (!s || !s.playlist.length) { if (s) s.status = 'STOPPED'; return null; }
  if (s.loopMode === 'TRACK' && s.currentIndex >= 0 && s.currentIndex < s.playlist.length) { s.status = 'PLAYING'; return s.playlist[s.currentIndex]; }
  const i = s.currentIndex + 1;
  if (i < s.playlist.length) { s.currentIndex = i; s.status = 'PLAYING'; return s.playlist[i]; }
  if (s.loopMode === 'QUEUE') { s.currentIndex = 0; s.status = 'PLAYING'; return s.playlist[0]; }
  s.status = 'STOPPED';
  return null;
}
`),
    providers: write('providers.mjs', `export async function downloadTrackToDisk() { throw new Error('sem rede (dublê)'); }\n`),
    embed: write('embed.mjs', `export function buildRadioEmbed() { return { embeds: [], components: [] }; }\nexport function buildNotFoundEmbed(title) { return { notFound: title }; }\n`),
    yt: write('yt.mjs', `import { Readable } from 'node:stream';
const H = globalThis.__radioHarness;
class FakeStream extends Readable {
  constructor(mode) { super(); this.mode = mode; this.ending = false; }
  _read() { if (this.mode === 'empty' || this.ending) this.push(null); else this.push(Buffer.alloc(3840)); }
  finish() { this.ending = true; }
  async waitUntilReady() {}
}
export function createYouTubeProgressiveStream(link) { const s = new FakeStream(String(link).startsWith('empty') ? 'empty' : 'good'); H.streams.push(s); return s; }
`),
    prefetch: write('prefetch.mjs', `export async function prefetchNextTrack() {}\n`),
    logger: write('logger.mjs', `const H = globalThis.__radioHarness;\nconst mk = (l) => (m) => { H.logs[l].push(String(m)); };\nexport const logger = { info: mk('info'), warn: mk('warn'), error: mk('error'), debug() {} };\nexport default logger;\n`),
  };
  let code = fs.readFileSync(path.join(ROOT, 'src/music/radioAudioPlayer.js'), 'utf8');
  const swaps = {
    "'@discordjs/voice'": urls.voice,
    "'./radioDatabase.js'": urls.db,
    "'./radioProviders.js'": urls.providers,
    "'./radioEmbed.js'": urls.embed,
    "'./youtubeBufferStream.js'": urls.yt,
    "'./radioPrefetcher.js'": urls.prefetch,
    "'../utils/logger.js'": urls.logger,
    "'../utils/binaries.js'": pathToFileURL(path.join(ROOT, 'src/utils/binaries.js')).href,
    "'../utils/voiceSafety.js'": pathToFileURL(path.join(ROOT, 'src/utils/voiceSafety.js')).href,
  };
  for (const [spec, url] of Object.entries(swaps)) {
    assert.ok(code.includes(spec), `import ${spec} sumiu do radioAudioPlayer.js: atualize o harness do teste`);
    code = code.split(spec).join(`'${url}'`);
  }
  code = `const __H = globalThis.__radioHarness;\n${code.replace(/\bsetTimeout\(/g, '__H.setTimeout(')}`;
  const copy = path.join(dir, 'radioAudioPlayer.mjs');
  fs.writeFileSync(copy, code);
  const mod = await import(pathToFileURL(copy).href);

  return {
    H, mod, textChannel,
    track: (i) => H.sessions.get('g1').playlist[i],
    session: () => H.sessions.get('g1'),
    /** Mensagens de TEXTO enviadas ao canal (o embed vai como objeto). */
    texts: () => H.sent.filter((m) => typeof m === 'string'),
    semAudio: () => H.logs.warn.filter((m) => /terminou sem áudio/.test(m)).length,
    cleanup() {
      try { mod.stopPlayer('g1'); } catch { /* ignora */ }
      for (const st of H.streams) { try { st.destroy(); } catch { /* ignora */ } }
    },
  };
}

if (!binaries.isOpusAvailable()) {
  console.log('  (pulado: sem codificador Opus neste ambiente, o AudioPlayer real não consegue converter PCM)');
} else {
  await test('#1 disjuntor disparado pelo ouvinte de error: STOPPED é gravado ANTES de parar o player e a faixa seguinte NÃO começa', async () => {
    const r = await createRadioHarness({ playlist: ['good', 'good', 'good', 'good'] });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      assert.equal(r.H.streams.length, 1);
      await r.H.advance(2000); // passa a janela de transição de 1,5 s
      const player = r.mod.getPlayer('g1');
      assert.ok(player, 'o player foi criado');

      player.emit('error', new Error('Could not find an Opus module!')); // ambiente quebrado: 1ª falha, ainda avança
      await r.H.advance(2000);
      assert.equal(r.H.streams.length, 2, 'a 1ª falha ainda passa para a faixa seguinte');

      const antes = r.H.updates.length;
      player.emit('error', new Error('Could not find an Opus module!')); // 2ª falha de ambiente: o disjuntor dispara
      await r.H.advance(50);
      const depois = r.H.updates.slice(antes);
      assert.equal(depois[0]?.patch.status, 'STOPPED', 'a primeira gravação na sessão é STOPPED (antes de qualquer stop do player)');
      assert.ok(!depois.some((u) => u.patch.status === 'BUFFERING' || u.patch.status === 'PLAYING'), 'nenhuma faixa nova foi iniciada');
      assert.equal(r.session().status, 'STOPPED');
      assert.equal(r.session().currentTrack, null);
      assert.equal(player.state.status, 'idle');
      const avisos = r.texts().filter((m) => /Parei o rádio/.test(m));
      assert.equal(avisos.length, 1, 'avisa o canal uma vez');
      assert.match(avisos[0], /ambiente de áudio/);

      await r.H.advance(10_000);
      await realWait(100);
      assert.equal(r.H.streams.length, 2, 'depois da parada nada recomeça sozinho');
      assert.equal(r.session().status, 'STOPPED');
    } finally { r.cleanup(); }
  });

  await test('#3 faixa que termina SEM erro e sem áudio (yt-dlp/ffmpeg com 0 bytes) com loopMode TRACK: conta falha e para depois de 5, não repete para sempre', async () => {
    const r = await createRadioHarness({ playlist: ['empty'], loopMode: 'TRACK' });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      for (let i = 1; i <= 5; i++) {
        await until(() => r.semAudio() >= i || r.session().status === 'STOPPED', 3000);
        await r.H.advance(2500); // janela de transição de 1,5 s + espera de 2 s do avanço
      }
      await until(() => r.session().status === 'STOPPED', 3000);
      assert.equal(r.H.streams.length, 5, 'tentou exatamente 5 vezes');
      assert.equal(r.semAudio(), 5);
      const avisos = r.texts().filter((m) => /Parei o rádio/.test(m));
      assert.equal(avisos.length, 1);
      assert.match(avisos[0], /5 faixas seguidas/);
      await r.H.advance(20_000);
      await realWait(100);
      assert.equal(r.H.streams.length, 5, 'parou de vez');
      assert.ok(r.H.logs.error.some((m) => /Rádio parado/.test(m)), 'registrado no log');
    } finally { r.cleanup(); }
  });

  await test('#3 uma faixa que tocou de verdade (>= 3 s) zera as falhas seguidas: 2 vazias + 1 boa + 5 vazias só param na última', async () => {
    const r = await createRadioHarness({ playlist: ['empty', 'empty', 'good', 'empty', 'empty', 'empty', 'empty', 'empty'] });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      await until(() => r.semAudio() >= 1, 3000);
      await r.H.advance(2500);
      await until(() => r.semAudio() >= 2, 3000);
      await r.H.advance(2500);
      await until(() => r.H.streams.length === 3, 3000); // a faixa boa começou
      await r.H.advance(2000); // fim da janela de transição
      const player = r.mod.getPlayer('g1');
      await until(() => player.state.status === 'playing', 3000);
      player.state.resource.playbackDuration = 4000; // finge que já tocou 4 s
      r.H.streams[2].finish(); // fim natural da faixa boa
      await until(() => r.H.streams.length === 4, 3000); // sucesso: avança na hora para a próxima
      for (let i = 1; i <= 5; i++) {
        await until(() => r.semAudio() >= 2 + i || r.session().status === 'STOPPED', 3000);
        await r.H.advance(2500);
      }
      await until(() => r.session().status === 'STOPPED', 3000);
      assert.equal(r.H.streams.length, 8, 'sem o sucesso no meio o rádio teria parado na 6ª tentativa');
      assert.equal(r.semAudio(), 7);
      assert.equal(r.texts().filter((m) => /Parei o rádio/.test(m)).length, 1);
    } finally { r.cleanup(); }
  });

  await test('fim natural de uma faixa que tocou de verdade continua avançando para a seguinte (sem falha)', async () => {
    const r = await createRadioHarness({ playlist: ['good', 'good', 'good'] });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      await r.H.advance(2000);
      const player = r.mod.getPlayer('g1');
      await until(() => player.state.status === 'playing', 3000);
      player.state.resource.playbackDuration = 5000;
      r.H.streams[0].finish();
      await until(() => r.H.streams.length === 2, 3000);
      assert.equal(r.semAudio(), 0);
      assert.equal(r.texts().filter((m) => /Parei o rádio/.test(m)).length, 0);
    } finally { r.cleanup(); }
  });

  await test('faixa que morre dentro da janela de transição não deixa o rádio parado em "tocando": o avanço é reagendado', async () => {
    const r = await createRadioHarness({ playlist: ['empty', 'good'] });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      await until(() => r.semAudio() === 1, 3000); // Idle chegou com a janela de transição ainda ligada
      assert.equal(r.H.streams.length, 1, 'nada avançou ainda (a janela de 1,5 s segura o handleTrackEnd)');
      await r.H.advance(2500);
      assert.equal(r.H.streams.length, 2, 'depois da janela a faixa seguinte começou');
    } finally { r.cleanup(); }
  });

  await test('pular/trocar de faixa durante a espera cancela o avanço atrasado (não pula a faixa nova)', async () => {
    const r = await createRadioHarness({ playlist: ['empty', 'good', 'good'] });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      await until(() => r.semAudio() === 1, 3000); // avanço de 2 s agendado
      await r.mod.playTrack('g1', r.track(1), r.textChannel, null); // o usuário pulou
      assert.equal(r.H.streams.length, 2);
      await r.H.advance(6000);
      await realWait(100);
      assert.equal(r.H.streams.length, 2, 'o avanço atrasado da faixa antiga foi cancelado');
      assert.equal(r.H.streams[1].destroyed, false, 'a faixa nova continua tocando');
    } finally { r.cleanup(); }
  });

  await test('stopPlayer (botão Parar): o Idle do stop forçado NÃO inicia a faixa seguinte nem conta falha', async () => {
    const r = await createRadioHarness({ playlist: ['good', 'good', 'good'] });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      await r.H.advance(2000);
      const antes = r.H.updates.length;
      r.mod.stopPlayer('g1');
      await realWait(100);
      await r.H.advance(5000);
      assert.equal(r.H.streams.length, 1, 'nenhuma faixa nova');
      assert.equal(r.H.updates.slice(antes).length, 0, 'a sessão não foi tocada pelo player depois do stop');
      assert.equal(r.semAudio(), 0);
    } finally { r.cleanup(); }
  });

  await test('stopPlayer logo após iniciar (<1 s) não vira falha de "faixa vazia"', async () => {
    const r = await createRadioHarness({ playlist: ['good', 'good'] });
    try {
      await r.mod.playTrack('g1', r.track(0), r.textChannel, null);
      r.mod.stopPlayer('g1');
      await realWait(100);
      await r.H.advance(5000);
      assert.equal(r.semAudio(), 0);
      assert.equal(r.H.streams.length, 1);
    } finally { r.cleanup(); }
  });
}

// ───────────────────────────────────────────────────────────────────
console.log('Fiação nos arquivos (guarda contra regressão)');
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');
await test('voiceHandler: connection.on("error") via helper, ouvinte seguro, recusa sem Opus, sem console.*, TTS preservado', async () => {
  const src = read('src/handlers/voiceHandler.js');
  assert.match(src, /attachConnectionSafety\(connection,/);
  assert.match(src, /attachSpeakingListener\(receiver,/);
  assert.match(src, /receiverListeners\.get\(receiver\)/, 'não empilha ouvintes no mesmo receiver');
  assert.match(src, /if \(!isOpusAvailable\(\)\)/);
  assert.match(src, /attachPlayerSafety\(player,/);
  assert.ok(!/console\.(log|error|warn)/.test(src), 'sem console.* na voz');
  assert.ok(!src.includes('activeAudioStreams'), 'sem o Set de módulo que prendia a chave');
  // A integração do TTS já entrou: o serviço novo (services/tts + interruptSpeech/disposeGuild) é o ÚNICO estado válido e o
  // ttsService.js legado não existe mais. (Antes esta asserção aceitava os dois estados enquanto a integração não chegava.)
  assert.ok(/from '\.\.\/services\/tts\/index\.js'/.test(src) && /\binterruptSpeech\b/.test(src) && /\bdisposeGuild\b/.test(src), 'TTS: o serviço novo (services/tts + interruptSpeech/disposeGuild) saiu do voiceHandler');
  assert.ok(!/synthesizeSpeech|ttsService/.test(src), 'sem resto do TTS antigo no voiceHandler');
  assert.ok(!fs.existsSync(path.join(ROOT, 'src/services/ttsService.js')), 'o ttsService.js legado foi apagado');
});
await test('D7: a transcrição é cortada ANTES do filtro de alucinação e da palavra de ativação; ninguém sobrescreve o teto de 30 s; o resto do modo voz segue', async () => {
  const src = read('src/handlers/voiceHandler.js').replace(/\r\n/g, '\n');
  assert.match(src, /clampTranscript,\n\s*createSpeakerGuard/, 'importado de utils/voiceSafety.js');
  const proc = src.slice(src.indexOf('async function processVoiceTranscription'), src.indexOf('async function handleVoiceStateUpdate'));
  const cut = proc.indexOf('text = clampTranscript(text)');
  assert.ok(cut > 0, 'o corte está em processVoiceTranscription');
  for (const later of ['text.toLowerCase()', 'STT_HALLUCINATIONS.some', 'parseVoiceTranscript(text)']) {
    assert.ok(proc.indexOf(later) > cut, `${later} vem depois do corte`);
  }
  assert.ok(!/console\./.test(proc), 'o log do corte usa o logger');
  assert.ok(!/text\.slice\(|text\.substring\(/.test(proc), 'sem corte à mão que partiria emoji');
  // A integração do TTS continua inteira.
  for (const piece of ['overlapsSpeech', 'isVoiceModeOn(guildId', 'tryAccept(', 'buildVoiceOptions(', 'wakeWordInFirstWords(text, triggerRegex, 3)', 'CAPTURE_END_SILENCE_MS']) {
    assert.ok(src.includes(piece), `${piece} continua no voiceHandler`);
  }
  // O teto de 30 s vem do padrão: nem a call de IA nem o Modo Rádio passam um valor maior.
  for (const rel of ['src/handlers/voiceHandler.js', 'src/music/radioManager.js']) {
    assert.ok(!/\bmaxStreamMs\s*[:=]/.test(read(rel)), `${rel} usa o padrão de VOICE_DEFAULTS.maxStreamMs`);
  }
});
await test('radioManager: ouvinte seguro, error de conexão, recusa sem Opus, sem console.*', async () => {
  const src = read('src/music/radioManager.js');
  assert.match(src, /attachConnectionSafety\(connection,/);
  assert.match(src, /attachSpeakingListener\(receiver,/);
  assert.match(src, /if \(!isOpusAvailable\(\)\)/);
  assert.ok(!/console\.(log|error|warn)/.test(src));
});
await test('radioAudioPlayer: proc.on("error"), error do stream do YouTube ANTES do await, disjuntor, comentário Raw corrigido', async () => {
  const src = read('src/music/radioAudioPlayer.js');
  assert.match(src, /proc\.on\('error'/);
  const iErro = src.indexOf("progressiveStream.on('error'");
  const iEspera = src.indexOf('await progressiveStream.waitUntilReady()');
  assert.ok(iErro > 0 && iEspera > iErro, 'ouvinte de erro registrado antes de esperar o stream');
  assert.match(src, /failureBreaker\.recordFailure/);
  assert.match(src, /Raw NÃO dispensa o Opus/);
  assert.ok(!/evitando a dependência de codec Opus/.test(src), 'comentário errado removido');
  // haltRadioAfterFailures: o player.stop(true) emite o Idle de forma SÍNCRONA, então a sessão precisa virar STOPPED
  // (e as transições travar) ANTES de derrubar o stream e o player.
  const iHalt = src.indexOf('async function haltRadioAfterFailures');
  const corpoHalt = src.slice(iHalt, src.indexOf('async function playTrack')).replace(/\/\/.*$/gm, ''); // sem comentários
  const pos = (re) => corpoHalt.search(re);
  assert.ok(iHalt > 0 && pos(/transitioningGuilds\.add\(guildId\)/) >= 0, 'halt trava as transições');
  assert.ok(pos(/transitioningGuilds\.add\(guildId\)/) < pos(/updateSession\(guildId, \{ status: 'STOPPED'/), 'trava antes de gravar STOPPED');
  assert.ok(pos(/updateSession\(guildId, \{ status: 'STOPPED'/) < pos(/destroyActiveStream\(guildId\)/), 'STOPPED antes de derrubar o stream');
  assert.ok(pos(/updateSession\(guildId, \{ status: 'STOPPED'/) < pos(/forceStopPlayer\(/), 'STOPPED antes de parar o player');
  assert.ok(!/player\.stop\(true\)/.test(corpoHalt), 'o halt para o player só por forceStopPlayer');
  assert.match(src, /classifyIdleEnd\(/, 'o ouvinte de Idle julga o fim da faixa (faixa vazia conta falha)');
  assert.ok(!/console\.(log|error|warn)/.test(src));
});
await test('index.js: usa a chave por causa-raiz e registra o resultado do Opus na inicialização', async () => {
  const src = read('src/index.js');
  assert.match(src, /crashAlertKey\(reason\)/);
  assert.match(src, /crashAlertKey\(error\)/);
  assert.ok(!src.includes("'crash:rejection:'") && !src.includes("'crash:exception:'"));
  assert.match(src, /opus=\$\{sim\(mediaStatus\.opusOk\)\}/);
  assert.match(src, /startYtdlpAutoUpdate\(\)/);
});

// ───────────────────────────────────────────────────────────────────
await tick(20);
await test('nada escapou como exceção não tratada ou promessa rejeitada durante os testes', async () => {
  assert.deepEqual(escaped, []);
});

console.log(`\n${passed} testes OK${failed ? `, ${failed} FALHARAM` : ''}`);
process.exit(failed ? 1 : 0);
