// Testes do áudio do TTS (audio.js) e dos provedores SAPI e falso, sem Discord e sem rede.
//
// Partes:
//  1. parseWav / toDiscordPcm / pcmToReadable / pcmDurationMs com áudio sintético;
//  2. provedor falso;
//  3. SAPI com processo FALSO (timeout, ERR, linha gigante, reinício, abort, env mínimo...);
//  4. contrato com o @discordjs/voice REAL (pacotes Opus, memória, laço de eventos);
//  5. ffprobe (se existir) e SAPI REAL (só Windows com voz pt-BR; senão [SKIP]).
//
// Execução: node tests/test-tts-audio.js
import assert from 'node:assert';
import { EventEmitter } from 'node:events';
import { execFile } from 'node:child_process';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import path from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { PassThrough, Writable } from 'node:stream';
import { fileURLToPath, pathToFileURL } from 'node:url';
import v8 from 'node:v8';
import vm from 'node:vm';

import {
  DISCORD_FRAME_BYTES,
  encodeWav,
  parseWav,
  pcmDurationMs,
  pcmToReadable,
  toDiscordPcm,
} from '../src/services/tts/audio.js';
import { getTtsConfig } from '../src/services/tts/config.js';
import { createEngine } from '../src/services/tts/engine.js';
import { createFakeProvider, fakeDurationMs } from '../src/services/tts/providers/fake.js';
import { buildHelperEnv, createSapiProvider, getPowerShellPath, SAPI_SCRIPT } from '../src/services/tts/providers/sapi.js';

const THIS_FILE = fileURLToPath(import.meta.url);
const ROOT = path.resolve(path.dirname(THIS_FILE), '..');
const require = createRequire(import.meta.url);

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

// ── Modo filho: usado pelo teste de "helper órfão" (o pai mata este processo à força) ──
if (process.argv[2] === '--orphan-child') {
  const provider = createSapiProvider({ config: getTtsConfig({}), logger: SILENT });
  const probe = await provider.probe();
  console.log(`PID ${provider.getInfo().pid} ${probe.ok ? 'OK' : 'NO'}`);
  setTimeout(() => process.kill(process.pid, 'SIGKILL'), 150); // morte abrupta, sem handlers de saída
  await new Promise(() => {}); // fica vivo até o SIGKILL
}

// ── Mini framework ────────────────────────────────────────────────────

let passed = 0;
let failed = 0;
let skipped = 0;
const metrics = {};

const skip = (reason) => ({ skip: reason });

async function test(name, fn) {
  try {
    const res = await fn();
    if (res && res.skip) {
      skipped++;
      console.log(`  [SKIP] ${name} (${res.skip})`);
    } else {
      passed++;
      console.log(`  ok    ${name}`);
    }
  } catch (err) {
    failed++;
    console.log(`  FALHA ${name}`);
    console.log(`        ${String(err?.stack || err).split('\n').slice(0, 4).join('\n        ')}`);
  }
}

process.on('unhandledRejection', (err) => {
  failed++;
  console.log(`  FALHA unhandledRejection: ${err?.code || err?.message || err}`);
});

const tick = () => new Promise((r) => setImmediate(r));
async function flush(n = 8) {
  for (let i = 0; i < n; i++) await tick();
}
/** Falha com mensagem clara em vez de travar o teste inteiro. */
function guard(promise, ms = 5000) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('o teste travou esperando uma promessa')), ms); }),
  ]).finally(() => clearTimeout(timer));
}
/** Acompanha uma promessa sem esperar por ela. */
function track(promise) {
  const t = { state: 'pending', value: undefined, err: undefined };
  promise.then((v) => { t.state = 'ok'; t.value = v; }, (e) => { t.state = 'err'; t.err = e; });
  return t;
}
async function rejectsWithCode(promise, code) {
  try {
    await guard(promise);
  } catch (err) {
    assert.strictEqual(err?.code, code, `esperava ${code}, veio ${err?.code}: ${err?.message}`);
    return err;
  }
  assert.fail(`esperava rejeição ${code}`);
}

// ── Áudio sintético ───────────────────────────────────────────────────

/** Tom (seno ou quadrada) em s16le com silêncio opcional antes e depois. */
function tonePcm({ sampleRate, ms, freq = 440, amp = 0.5, ampR = null, leadMs = 0, trailMs = 0, channels = 1, square = false }) {
  const nLead = Math.round((sampleRate * leadMs) / 1000);
  const nTone = Math.round((sampleRate * ms) / 1000);
  const nTrail = Math.round((sampleRate * trailMs) / 1000);
  const total = nLead + nTone + nTrail;
  const buf = Buffer.alloc(total * channels * 2);
  for (let i = 0; i < total; i++) {
    for (let c = 0; c < channels; c++) {
      let v = 0;
      if (i >= nLead && i < nLead + nTone) {
        const t = (i - nLead) / sampleRate;
        const a = c === 1 && ampR !== null ? ampR : amp;
        v = (square ? (Math.floor(t * freq * 2) % 2 === 0 ? 1 : -1) : Math.sin(2 * Math.PI * freq * t)) * a;
      }
      buf.writeInt16LE(Math.round(v * 32767), (i * channels + c) * 2);
    }
  }
  return buf;
}

function chunk(id, body) {
  const head = Buffer.alloc(8);
  head.write(id, 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body, body.length & 1 ? Buffer.alloc(1) : Buffer.alloc(0)]);
}
function fmtBody({ format = 1, channels, sampleRate, bits = 16 }) {
  const b = Buffer.alloc(16);
  b.writeUInt16LE(format, 0);
  b.writeUInt16LE(channels, 2);
  b.writeUInt32LE(sampleRate, 4);
  b.writeUInt32LE((sampleRate * channels * bits) / 8, 8);
  b.writeUInt16LE((channels * bits) / 8, 12);
  b.writeUInt16LE(bits, 14);
  return b;
}
/** WAV montado à mão: permite chunks extras antes do data e tamanho do data forjado. */
function makeWav({ fmt, pcm, before = [], dataSize = null, fmtRaw = null }) {
  const dataHead = Buffer.alloc(8);
  dataHead.write('data', 0, 'latin1');
  dataHead.writeUInt32LE(dataSize === null ? pcm.length : dataSize, 4);
  const body = Buffer.concat([Buffer.from('WAVE', 'latin1'), chunk('fmt ', fmtRaw || fmtBody(fmt)), ...before, dataHead, pcm]);
  const head = Buffer.alloc(8);
  head.write('RIFF', 0, 'latin1');
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

const i16 = (buf) => new Int16Array(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.length));
const peakOf = (arr) => arr.reduce((m, v) => Math.max(m, Math.abs(v)), 0);
/** Índice do 1º quadro com amostra acima do limiar (estéreo intercalado). */
function firstLoudFrame(arr, thr = 300) {
  for (let i = 0; i < arr.length; i += 2) if (Math.abs(arr[i]) > thr || Math.abs(arr[i + 1]) > thr) return i / 2;
  return -1;
}
function trailingZeroFrames(arr) {
  let n = 0;
  for (let i = arr.length - 2; i >= 0; i -= 2) {
    if (arr[i] !== 0 || arr[i + 1] !== 0) break;
    n++;
  }
  return n;
}
/** Ciclos de uma senoide = cruzamentos de baixo para cima (amostra exatamente 0 é normal num cruzamento). */
function upwardCrossings(arr, from, to) {
  let n = 0;
  for (let i = from + 1; i < to; i++) if (arr[i - 1] < 0 && arr[i] >= 0) n++;
  return n;
}
function leftChannel(arr) {
  const out = new Int16Array(arr.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = arr[i * 2];
  return out;
}

// ═══════════════════════════════════════════════════════════════════════
console.log('parseWav');

await test('WAV canônico de 44 bytes: PCM, taxa e canais intactos', () => {
  const pcm = tonePcm({ sampleRate: 22050, ms: 100 });
  const r = parseWav(encodeWav({ pcm, sampleRate: 22050, channels: 1 }));
  assert.strictEqual(r.sampleRate, 22050);
  assert.strictEqual(r.channels, 1);
  assert.ok(r.pcm.equals(pcm));
});

await test('chunks LIST e fact (de tamanho ímpar) antes do data', () => {
  const pcm = tonePcm({ sampleRate: 22050, ms: 50 });
  const wav = makeWav({
    fmt: { channels: 1, sampleRate: 22050 },
    pcm,
    before: [chunk('LIST', Buffer.from('INFOISFT\x05\x00\x00\x00Lavf\x00', 'latin1').subarray(0, 17)), chunk('fact', Buffer.alloc(4))],
  });
  const r = parseWav(wav);
  assert.ok(r.pcm.equals(pcm));
});

await test('layout do ffmpeg (data no offset 78) não depende do cabeçalho de 44 bytes', () => {
  const pcm = tonePcm({ sampleRate: 24000, ms: 40 });
  const info = Buffer.concat([
    Buffer.from('INFOISFT', 'latin1'),
    Buffer.from([14, 0, 0, 0]),
    Buffer.from('Lavf58.76.100\0', 'latin1'),
  ]);
  assert.strictEqual(info.length, 26);
  const wav = makeWav({ fmt: { channels: 1, sampleRate: 24000 }, pcm, before: [chunk('LIST', info)] });
  assert.strictEqual(wav.indexOf('data', 12, 'latin1') + 8, 78);
  assert.ok(parseWav(wav).pcm.equals(pcm));
});

await test('chunk depois do data (LIST no fim, como alguns gravadores fazem) não entra no áudio', () => {
  const pcm = tonePcm({ sampleRate: 22050, ms: 60 });
  const wav = Buffer.concat([makeWav({ fmt: { channels: 1, sampleRate: 22050 }, pcm }), chunk('LIST', Buffer.from('INFOlixo', 'latin1'))]);
  assert.ok(parseWav(wav).pcm.equals(pcm));
});

await test('data com tamanho 0 e com 0xFFFFFFFF (streaming) usam o resto do buffer', () => {
  const pcm = tonePcm({ sampleRate: 22050, ms: 60 });
  for (const dataSize of [0, 0xffffffff]) {
    const r = parseWav(makeWav({ fmt: { channels: 1, sampleRate: 22050 }, pcm, dataSize }));
    assert.ok(r.pcm.equals(pcm), `dataSize ${dataSize}`);
  }
});

await test('data maior que o arquivo (truncado) e byte sobrando são tolerados', () => {
  const pcm = tonePcm({ sampleRate: 22050, ms: 60 });
  const cut = Buffer.concat([pcm, Buffer.from([7])]); // 1 byte a mais: não forma amostra
  const r = parseWav(makeWav({ fmt: { channels: 1, sampleRate: 22050 }, pcm: cut, dataSize: 1_000_000 }));
  assert.ok(r.pcm.equals(pcm));
});

await test('float32 vira s16 (com clip) e NaN vira silêncio', () => {
  const f = Buffer.alloc(7 * 4);
  [0, 0.5, -0.5, 1, -1, 2, NaN].forEach((v, i) => f.writeFloatLE(v, i * 4));
  const r = parseWav(makeWav({ fmt: { format: 3, channels: 1, sampleRate: 24000, bits: 32 }, pcm: f }));
  assert.deepStrictEqual(Array.from(i16(r.pcm)), [0, 16384, -16384, 32767, -32768, 32767, 0]);
});

await test('WAVE_FORMAT_EXTENSIBLE com subformato float32', () => {
  const body = Buffer.alloc(40);
  fmtBody({ format: 0xfffe, channels: 1, sampleRate: 24000, bits: 32 }).copy(body);
  body.writeUInt16LE(22, 16); // cbSize
  body.writeUInt16LE(3, 24); // GUID do subformato começa com o código do formato (3 = float)
  const f = Buffer.alloc(8);
  f.writeFloatLE(0.5, 0);
  f.writeFloatLE(-0.25, 4);
  const r = parseWav(makeWav({ pcm: f, fmtRaw: body }));
  assert.deepStrictEqual(Array.from(i16(r.pcm)), [16384, -8192]);
});

await test('estéreo preserva canais; formatos não suportados e lixo dão código', () => {
  const pcm = tonePcm({ sampleRate: 48000, ms: 20, channels: 2 });
  assert.strictEqual(parseWav(encodeWav({ pcm, sampleRate: 48000, channels: 2 })).channels, 2);
  assert.throws(() => parseWav(makeWav({ fmt: { channels: 1, sampleRate: 24000, bits: 24 }, pcm: Buffer.alloc(6) })), { code: 'WAV_UNSUPPORTED' });
  assert.throws(() => parseWav(Buffer.from('isto não é um wav de jeito nenhum')), { code: 'WAV_INVALID' });
  assert.throws(() => parseWav(Buffer.alloc(4)), { code: 'WAV_INVALID' });
  assert.throws(() => parseWav('texto'), { code: 'WAV_INVALID' });
  const semData = Buffer.concat([Buffer.from('RIFF\0\0\0\0WAVE', 'latin1'), chunk('fmt ', fmtBody({ channels: 1, sampleRate: 8000 }))]);
  assert.throws(() => parseWav(semData), { code: 'WAV_INVALID' });
});

// ═══════════════════════════════════════════════════════════════════════
console.log('toDiscordPcm');

await test('pipeline completo (22,05 kHz mono com silêncio nas pontas): formato, canais iguais, pico, aparas e cauda', () => {
  const src = tonePcm({ sampleRate: 22050, ms: 500, freq: 440, amp: 0.5, leadMs: 150, trailMs: 200 });
  const wav = encodeWav({ pcm: src, sampleRate: 22050, channels: 1 });
  const out = toDiscordPcm(parseWav(wav));
  assert.ok(Buffer.isBuffer(out));
  assert.strictEqual(out.length % DISCORD_FRAME_BYTES, 0, 'múltiplo de 3840');
  const s = i16(out);
  // L == R em todas as amostras (mono duplicado).
  for (let i = 0; i < s.length; i += 2) assert.strictEqual(s[i], s[i + 1]);
  // Silêncio inicial: de 150 ms para no máx. 30 ms.
  const leadMs = (firstLoudFrame(s) / 48000) * 1000;
  assert.ok(leadMs >= 25 && leadMs <= 32, `silêncio inicial ${leadMs} ms`);
  // Pico normalizado para ~0,85.
  assert.ok(Math.abs(peakOf(s) - 0.85 * 32768) <= 3, `pico ${peakOf(s)}`);
  // Duração do tom preservada (500 ms) e sem os 200 ms finais; cauda de zeros >= 60 ms.
  const tailMs = (trailingZeroFrames(s) / 48000) * 1000;
  assert.ok(tailMs >= 60 && tailMs <= 115, `cauda ${tailMs} ms`);
  const totalMs = pcmDurationMs(out);
  const toneMs = totalMs - leadMs - tailMs;
  assert.ok(Math.abs(toneMs - 500) <= 12, `tom ${toneMs} ms`);
  // Frequência preservada: 440 Hz x 0,5 s = 220 ciclos.
  const L = leftChannel(s);
  const cycles = upwardCrossings(L, 0, L.length);
  assert.ok(Math.abs(cycles - 220) <= 3, `ciclos ${cycles}`);
});

await test('24 kHz (fator 2 exato) e 22,05 kHz: tamanho exato e frequência preservada', () => {
  for (const sampleRate of [24000, 22050]) {
    const src = tonePcm({ sampleRate, ms: 1000, freq: 440, amp: 0.5 });
    const out = toDiscordPcm({ pcm: src, sampleRate, channels: 1 });
    // 1 s = 48000 amostras + 2880 de cauda = 50880 -> 53 quadros.
    assert.strictEqual(out.length, 53 * DISCORD_FRAME_BYTES, `taxa ${sampleRate}`);
    const L = leftChannel(i16(out));
    const cycles = upwardCrossings(L, 0, L.length);
    assert.ok(Math.abs(cycles - 440) <= 3, `taxa ${sampleRate}: ciclos ${cycles}`);
  }
});

await test('48 kHz mono sem ganho: copia as amostras (sem atenuar 3 dB) e duplica o canal', () => {
  const src = tonePcm({ sampleRate: 48000, ms: 300, amp: 0.85, leadMs: 100 });
  const out = toDiscordPcm({ pcm: src, sampleRate: 48000, channels: 1 });
  const s = i16(out);
  const input = i16(src);
  assert.ok(Math.abs(peakOf(s) - peakOf(input)) <= 2, `pico ${peakOf(s)} x ${peakOf(input)}`);
  // 100 ms de silêncio + a 1ª amostra audível está no índice 4801; sai em 1440 (30 ms mantidos).
  const lead = input.findIndex((v) => Math.abs(v) >= 327);
  assert.strictEqual(lead, 4801);
  for (let j = 2000; j < 2100; j++) {
    assert.ok(Math.abs(s[(1440 + j) * 2] - input[lead + j]) <= 1, `amostra ${j}`);
    assert.strictEqual(s[(1440 + j) * 2], s[(1440 + j) * 2 + 1]);
  }
});

await test('estéreo mantém os canais separados', () => {
  const src = tonePcm({ sampleRate: 48000, ms: 200, freq: 1000, amp: 0.4, ampR: 0.2, channels: 2, square: true });
  const s = i16(toDiscordPcm({ pcm: src, sampleRate: 48000, channels: 2 }));
  const pl = peakOf(leftChannel(s));
  const pr = peakOf(s.filter((_, i) => i % 2 === 1));
  assert.ok(Math.abs(pr / pl - 0.5) < 0.02, `razão R/L ${pr / pl}`);
  assert.ok(Math.abs(pl - 0.85 * 32768) <= 3);
});

await test('fade de 5 ms nas duas pontas do sinal (sem estalo)', () => {
  const src = tonePcm({ sampleRate: 48000, ms: 500, freq: 1000, amp: 0.8, square: true }); // soa desde a 1ª amostra
  const s = i16(toDiscordPcm({ pcm: src, sampleRate: 48000, channels: 1 }));
  const peak = 0.85 * 32768;
  const n = 24000; // amostras do sinal
  assert.strictEqual(s[0], 0, 'começa em zero');
  // A meio caminho do fade (2,5 ms = 120 amostras) a amplitude é ~metade; a 5 ms já é plena.
  assert.ok(Math.abs(Math.abs(s[120 * 2]) / peak - 0.5) < 0.06, `fade-in ${Math.abs(s[240])}`);
  assert.ok(Math.abs(s[240 * 2]) / peak > 0.95);
  assert.strictEqual(s[(n - 1) * 2], 0, 'termina em zero');
  assert.ok(Math.abs(Math.abs(s[(n - 1 - 120) * 2]) / peak - 0.5) < 0.06, 'fade-out');
});

await test('silêncio inicial curto (10 ms) é preservado; o final é aparado', () => {
  const src = tonePcm({ sampleRate: 48000, ms: 300, amp: 0.6, leadMs: 10, trailMs: 800 });
  const s = i16(toDiscordPcm({ pcm: src, sampleRate: 48000, channels: 1 }));
  const leadMs = (firstLoudFrame(s) / 48000) * 1000;
  assert.ok(leadMs >= 8 && leadMs <= 13, `lead ${leadMs}`);
  assert.ok(pcmDurationMs(Buffer.alloc(s.length * 2)) < 450, 'os 800 ms finais sumiram');
});

await test('som baixo recebe no máximo +12 dB; som alto é reduzido para ~0,85', () => {
  const quiet = i16(toDiscordPcm({ pcm: tonePcm({ sampleRate: 48000, ms: 300, amp: 0.05 }), sampleRate: 48000, channels: 1 }));
  const gain = peakOf(quiet) / (0.05 * 32767);
  assert.ok(gain > 3.9 && gain < 4.0, `ganho ${gain}`);
  const loud = i16(toDiscordPcm({ pcm: tonePcm({ sampleRate: 48000, ms: 300, amp: 1 }), sampleRate: 48000, channels: 1 }));
  assert.ok(Math.abs(peakOf(loud) - 0.85 * 32768) <= 3);
});

await test('vazio, só silêncio e ruído abaixo do piso devolvem Buffer vazio', () => {
  assert.strictEqual(toDiscordPcm({ pcm: Buffer.alloc(0), sampleRate: 24000, channels: 1 }).length, 0);
  assert.strictEqual(toDiscordPcm({ pcm: Buffer.alloc(48000), sampleRate: 24000, channels: 1 }).length, 0);
  assert.strictEqual(toDiscordPcm({ pcm: tonePcm({ sampleRate: 24000, ms: 200, amp: 0.001 }), sampleRate: 24000, channels: 1 }).length, 0);
});

await test('áudio de 10 amostras ainda fecha quadros; argumentos inválidos dão AUDIO_INVALID; entrada não é alterada', () => {
  const tiny = tonePcm({ sampleRate: 48000, ms: (10 / 48000) * 1000, amp: 0.7 });
  const out = toDiscordPcm({ pcm: tiny, sampleRate: 48000, channels: 1 });
  assert.ok(out.length > 0 && out.length % DISCORD_FRAME_BYTES === 0);
  assert.throws(() => toDiscordPcm({ pcm: 'x', sampleRate: 24000, channels: 1 }), { code: 'AUDIO_INVALID' });
  assert.throws(() => toDiscordPcm({ pcm: tiny, sampleRate: 100, channels: 1 }), { code: 'AUDIO_INVALID' });
  assert.throws(() => toDiscordPcm({ pcm: tiny, sampleRate: 24000, channels: 3 }), { code: 'AUDIO_INVALID' });
  assert.throws(() => toDiscordPcm(), { code: 'AUDIO_INVALID' });
  const src = tonePcm({ sampleRate: 24000, ms: 100 });
  const copy = Buffer.from(src);
  toDiscordPcm({ pcm: src, sampleRate: 24000, channels: 1 });
  assert.ok(src.equals(copy), 'a entrada não pode mudar');
});

await test('pcm em offset ímpar (subarray) é lido corretamente', () => {
  const src = tonePcm({ sampleRate: 24000, ms: 100, amp: 0.5 });
  const shifted = Buffer.concat([Buffer.from([0]), src]).subarray(1); // byteOffset ímpar
  assert.ok(toDiscordPcm({ pcm: shifted, sampleRate: 24000, channels: 1 }).equals(toDiscordPcm({ pcm: src, sampleRate: 24000, channels: 1 })));
});

await test('pcmDurationMs', () => {
  assert.strictEqual(pcmDurationMs(Buffer.alloc(192000)), 1000);
  assert.strictEqual(pcmDurationMs(Buffer.alloc(DISCORD_FRAME_BYTES)), 20);
  assert.strictEqual(pcmDurationMs(null), 0);
});

// ═══════════════════════════════════════════════════════════════════════
console.log('pcmToReadable');

async function collect(readable) {
  const chunks = [];
  for await (const c of readable) chunks.push(c);
  return chunks;
}

await test('pedaços de 40 quadros, múltiplos de 3840, na ordem e completos', async () => {
  const pcm = Buffer.alloc(100 * DISCORD_FRAME_BYTES);
  for (let i = 0; i < pcm.length; i++) pcm[i] = i % 251;
  const chunks = await guard(collect(pcmToReadable(pcm)));
  assert.deepStrictEqual(chunks.map((c) => c.length / DISCORD_FRAME_BYTES), [40, 40, 20]);
  assert.ok(chunks.every((c) => c.length % DISCORD_FRAME_BYTES === 0));
  assert.ok(Buffer.concat(chunks).equals(pcm));
  const small = await guard(collect(pcmToReadable(pcm, { frames: 10 })));
  assert.strictEqual(small.length, 10);
  assert.strictEqual(small[0].length, 10 * DISCORD_FRAME_BYTES);
});

await test('backpressure: sem consumidor, não despeja o buffer inteiro na fila', async () => {
  const pcm = Buffer.alloc(1000 * DISCORD_FRAME_BYTES);
  const r = pcmToReadable(pcm);
  r.on('readable', () => {}); // liga o fluxo sem consumir
  await flush(10);
  assert.ok(r.readableLength <= 2 * 40 * DISCORD_FRAME_BYTES, `fila interna ${r.readableLength} bytes`);
  const first = r.read(40 * DISCORD_FRAME_BYTES);
  assert.strictEqual(first.length, 40 * DISCORD_FRAME_BYTES);
  r.destroy();
});

await test('buffer vazio termina sem dados; entrada inválida dá AUDIO_INVALID', async () => {
  assert.deepStrictEqual(await guard(collect(pcmToReadable(Buffer.alloc(0)))), []);
  assert.throws(() => pcmToReadable('x'), { code: 'AUDIO_INVALID' });
});

// ═══════════════════════════════════════════════════════════════════════
await test('pcmToReadable: o teto de 500 quadros por pedaço vale mesmo com `frames` absurdo (protege o laço de eventos)', async () => {
  const pcm = Buffer.alloc(1200 * DISCORD_FRAME_BYTES);
  for (const frames of [1e9, Infinity, 501, 100000]) {
    const sizes = (await guard(collect(pcmToReadable(pcm, { frames })))).map((c) => c.length / DISCORD_FRAME_BYTES);
    assert.deepStrictEqual(sizes, [500, 500, 200], `frames=${frames}`);
  }
  // `frames` inválido (0, NaN, texto, nulo) volta ao padrão de 40; negativo vira o mínimo de 1 quadro.
  for (const frames of [0, NaN, 'x', null]) {
    const chunks = await guard(collect(pcmToReadable(Buffer.alloc(100 * DISCORD_FRAME_BYTES), { frames })));
    assert.strictEqual(chunks[0].length / DISCORD_FRAME_BYTES, 40, `frames=${frames}`);
  }
  const minimo = await guard(collect(pcmToReadable(Buffer.alloc(3 * DISCORD_FRAME_BYTES), { frames: -5 })));
  assert.deepStrictEqual(minimo.map((c) => c.length / DISCORD_FRAME_BYTES), [1, 1, 1]);
});

await test('a conversão da fala SAPI de ~13 s fica abaixo de 400 ms (a conta é síncrona; um aviso se crescer demais)', () => {
  const sapiLike = tonePcm({ sampleRate: 48000, ms: 13000, channels: 2, amp: 0.4, leadMs: 150, trailMs: 800 });
  let best = Infinity;
  for (let i = 0; i < 3; i++) {
    const t0 = performance.now();
    const out = toDiscordPcm({ pcm: sapiLike, sampleRate: 48000, channels: 2 });
    best = Math.min(best, performance.now() - t0);
    assert.ok(out.length > 0);
  }
  metrics.toDiscordPcm13sMs = best;
  assert.ok(best < 400, `toDiscordPcm levou ${best.toFixed(0)} ms`);
});


console.log('Provedor falso');

function makeTimers() {
  let nowMs = 0;
  let seq = 0;
  const pending = new Map();
  const handles = []; // todo timer pedido, com a marca de unref (nada pode segurar o processo)
  const seen = []; // os prazos pedidos, na ordem
  return {
    handles,
    seen,
    setTimeout(fn, ms) {
      const id = ++seq;
      const handle = { id, unrefCalled: false, unref() { this.unrefCalled = true; return this; }, ref() { return this; } };
      handles.push(handle);
      seen.push(ms);
      pending.set(id, { fn, at: nowMs + ms });
      return handle;
    },
    clearTimeout(handle) {
      if (handle) pending.delete(handle.id);
    },
    advance(ms) {
      const target = nowMs + ms;
      for (;;) {
        const due = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
        if (!due) break;
        pending.delete(due[0]);
        nowMs = Math.max(nowMs, due[1].at);
        due[1].fn();
      }
      nowMs = target;
    },
    count: () => pending.size,
    now: () => nowMs,
  };
}

await test('fake ok: mono 24 kHz, duração proporcional ao texto, limites mínimo e máximo', async () => {
  const p = createFakeProvider();
  assert.strictEqual(p.name, 'fake');
  assert.strictEqual(p.local, true);
  const r = await p.synth('a'.repeat(10));
  assert.strictEqual(r.sampleRate, 24000);
  assert.strictEqual(r.channels, 1);
  assert.strictEqual(r.pcm.length, (fakeDurationMs('a'.repeat(10)) / 1000) * 24000 * 2);
  const longer = await p.synth('a'.repeat(40));
  assert.ok(longer.pcm.length > r.pcm.length * 3);
  assert.strictEqual(fakeDurationMs(''), 200);
  assert.strictEqual(fakeDurationMs('x'.repeat(5000)), 8000);
  // O áudio falso passa direto pelo conversor.
  const out = toDiscordPcm(r);
  assert.ok(out.length > 0 && out.length % DISCORD_FRAME_BYTES === 0);
  assert.deepStrictEqual(await p.probe(), { ok: true, detail: 'fake (ok)' });
  await p.warmup();
  await p.dispose();
  assert.deepStrictEqual({ ...p.stats }, { probe: 1, warmup: 1, synth: 2, dispose: 1 });
});

await test('fake fail, empty e nuvem (local: false)', async () => {
  await rejectsWithCode(createFakeProvider({ mode: 'fail' }).synth('x'), 'FAKE_FAILURE');
  const e = await createFakeProvider({ mode: 'empty' }).synth('x');
  assert.strictEqual(e.pcm.length, 0);
  const cloud = createFakeProvider({ name: 'nuvem', local: false });
  assert.strictEqual(cloud.local, false);
  assert.strictEqual(cloud.name, 'nuvem');
  const p = createFakeProvider({ mode: 'fail' });
  p.setMode('ok');
  assert.ok((await p.synth('x')).pcm.length > 0);
});

await test('fake slow: espera o relógio; abort cancela o timer e dá ABORTED', async () => {
  const timers = makeTimers();
  const p = createFakeProvider({ mode: 'slow', delayMs: 3000, timers });
  const t = track(p.synth('x'));
  await flush();
  assert.strictEqual(t.state, 'pending');
  timers.advance(2999);
  await flush();
  assert.strictEqual(t.state, 'pending');
  timers.advance(1);
  await flush();
  assert.strictEqual(t.state, 'ok');

  const ac = new AbortController();
  const t2 = track(p.synth('x', { signal: ac.signal }));
  await flush();
  ac.abort();
  await flush();
  assert.strictEqual(t2.err?.code, 'ABORTED');
  assert.strictEqual(timers.count(), 0, 'timer limpo');
  const pre = new AbortController();
  pre.abort();
  await rejectsWithCode(p.synth('x', { signal: pre.signal }), 'ABORTED');
});

// ═══════════════════════════════════════════════════════════════════════
console.log('SAPI com processo falso');

class FakeChild extends EventEmitter {
  constructor(behavior, pid) {
    super();
    this.pid = pid;
    this.behavior = behavior;
    this.lines = [];
    this.killed = false;
    this.exited = false;
    this.stdinEnded = false;
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();
    let partial = '';
    this.stdin = new Writable({
      write: (data, _enc, cb) => {
        if (this.exited) return cb(new Error('EPIPE'));
        partial += data.toString('utf8');
        let i;
        while ((i = partial.indexOf('\n')) >= 0) {
          const line = partial.slice(0, i);
          partial = partial.slice(i + 1);
          this.lines.push(line);
          behavior.onLine?.(this, line, this.lines.length - 1);
        }
        cb();
      },
      final: (cb) => {
        this.stdinEnded = true;
        behavior.onEnd?.(this);
        cb();
      },
    });
    setImmediate(() => behavior.onSpawn?.(this));
  }
  say(text) {
    this.sayRaw(Buffer.from(`${text}\n`, 'latin1'));
  }
  sayRaw(buf) {
    if (!this.exited) this.stdout.write(buf);
  }
  exit(code = 0) {
    if (this.exited) return;
    this.exited = true;
    this.stdout.end();
    this.stderr.end();
    this.emit('exit', code, null);
    this.emit('close', code, null);
  }
  kill() {
    this.killed = true;
    if (!this.behavior.ignoreKill) setImmediate(() => this.exit(null));
    return true;
  }
}

function createSpawn(behaviorFor) {
  const calls = [];
  const spawnFn = (exe, args, opts) => {
    const idx = calls.length;
    const behavior = typeof behaviorFor === 'function' ? behaviorFor(idx) : behaviorFor;
    if (behavior.throwOnSpawn) {
      calls.push({ exe, args, opts, child: null });
      throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    }
    const child = new FakeChild(behavior, 4000 + idx);
    calls.push({ exe, args, opts, child });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

const decode = (line) => {
  const [id, b64] = line.split(' ');
  return { id, text: Buffer.from(b64, 'base64').toString('utf8') };
};
/** 10 ms de bytes por caractere (múltiplo de 4, como o PCM estéreo de 16 bits). */
const fakePcm = (text) => Buffer.alloc(Math.max(1, text.length) * 1920, 1);
const okReply = (c, line) => {
  const { id, text } = decode(line);
  c.say(`${id} OK ${fakePcm(text).toString('base64')}`);
};
const ok = (extra = {}) => ({
  onSpawn: (c) => c.say('READY Voz Falsa'),
  onLine: okReply,
  onEnd: (c) => setImmediate(() => c.exit(0)),
  ...extra,
});

const ENV = {
  SystemRoot: 'C:\\Windows',
  windir: 'C:\\Windows',
  TEMP: 'C:\\Users\\teste\\AppData\\Local\\Temp',
  PATH: 'C:\\caminho\\perigoso',
  DISCORD_TOKEN: 'SEGREDO-DISCORD-TOKEN',
  GEMINI_API_KEY: 'SEGREDO-GEMINI',
  YUI_QUALQUER: 'SEGREDO-QUALQUER',
};

function mk({ behavior = ok(), config = {}, env = ENV, platform = 'win32' } = {}) {
  const timers = makeTimers();
  const spawnFn = createSpawn(behavior);
  const logs = [];
  const rec = (level) => (m) => logs.push(`${level}: ${m}`);
  const logger = { info: rec('info'), warn: rec('warn'), error: rec('error'), debug: rec('debug') };
  const provider = createSapiProvider({ spawn: spawnFn, config: getTtsConfig(config), logger, env, platform, timers, now: timers.now });
  return { provider, spawn: spawnFn, timers, logs };
}

await test('processo filho: caminho absoluto, array de argumentos, sem shell, env mínimo (sem tokens)', async () => {
  const t = mk({ config: { YUI_TTS_SAPI_VOICE: 'Maria Desktop', YUI_TTS_SAPI_RATE: '3' } });
  const r = await guard(t.provider.synth('Olá mundo'));
  assert.strictEqual(r.sampleRate, 48000);
  assert.strictEqual(r.channels, 2);
  assert.strictEqual(r.pcm.length, 'Olá mundo'.length * 1920);
  const { exe, args, opts } = t.spawn.calls[0];
  assert.strictEqual(exe, 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.strictEqual(getPowerShellPath(ENV), exe);
  assert.ok(Array.isArray(args));
  assert.deepStrictEqual(args.slice(0, 3), ['-NoProfile', '-NonInteractive', '-Command']);
  assert.strictEqual(args[3], SAPI_SCRIPT);
  assert.ok(!args[3].includes('"'), 'o script não pode ter aspas duplas');
  assert.strictEqual(opts.windowsHide, true);
  assert.strictEqual(opts.shell, false);
  const dump = JSON.stringify(opts);
  assert.ok(!dump.includes('SEGREDO'), 'nenhum segredo no ambiente do filho');
  assert.ok(!('DISCORD_TOKEN' in opts.env) && !('GEMINI_API_KEY' in opts.env) && !('YUI_QUALQUER' in opts.env));
  assert.deepStrictEqual(Object.keys(opts.env).sort(), ['PATH', 'SystemRoot', 'TEMP', 'TMP', 'YUI_SAPI_RATE', 'YUI_SAPI_VOICE', 'windir'].sort());
  assert.strictEqual(opts.env.PATH, 'C:\\Windows\\System32');
  assert.strictEqual(opts.env.YUI_SAPI_VOICE, 'Maria Desktop');
  assert.strictEqual(opts.env.YUI_SAPI_RATE, '3');
  assert.deepStrictEqual(buildHelperEnv({ SystemRoot: 'D:\\W' }, { voice: 'x', rate: 99 }).YUI_SAPI_RATE, '10');
  // Chaves em outra caixa (um objeto comum não é case-insensitive como o process.env do Windows).
  const lower = buildHelperEnv({ systemroot: 'D:\\W', temp: 'D:\\T' });
  assert.strictEqual(lower.SystemRoot, 'D:\\W');
  assert.strictEqual(lower.TEMP, 'D:\\T');
  assert.strictEqual(getPowerShellPath({ systemroot: 'D:\\W' }), 'D:\\W\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
  assert.strictEqual(getPowerShellPath({}), 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
});

await test('o texto vai em base64 puro (aspas, $, crases e emoji não chegam ao interpretador)', async () => {
  const t = mk();
  const hostile = '"; Remove-Item -Recurse C:\\ ; $(calc) `whoami` \'\' ação ç 😀';
  await guard(t.provider.synth(hostile));
  const line = t.spawn.calls[0].child.lines[0];
  assert.match(line, /^r\d+ [A-Za-z0-9+/=]+$/);
  assert.strictEqual(decode(line).text, hostile);
});

await test('texto vazio, enorme, controle e marcação: sanitiza ou recusa sem subir processo', async () => {
  const t = mk();
  await rejectsWithCode(t.provider.synth('   \n\t '), 'SAPI_BAD_INPUT');
  await rejectsWithCode(t.provider.synth(null), 'SAPI_BAD_INPUT');
  await rejectsWithCode(t.provider.synth('a'.repeat(2001)), 'SAPI_BAD_INPUT');
  assert.strictEqual(t.spawn.calls.length, 0);
  await guard(t.provider.synth('<speak>oi</speak>\u0000\n\u0007 fim'));
  const { text } = decode(t.spawn.calls[0].child.lines[0]);
  assert.strictEqual(text, 'speak oi /speak fim');
});

await test('resposta ERR vira SAPI_ERROR sem a mensagem do filho; o helper continua vivo', async () => {
  const t = mk({ behavior: ok({ onLine: (c, line) => c.say(`${decode(line).id} ERR SEGREDO-ERRO-DO-FILHO detalhe`) }) });
  const err = await rejectsWithCode(t.provider.synth('Olá'), 'SAPI_ERROR');
  assert.ok(!JSON.stringify([err.message, err.stack]).includes('SEGREDO'));
  await rejectsWithCode(t.provider.synth('Olá de novo'), 'SAPI_ERROR');
  assert.strictEqual(t.spawn.calls.length, 1, 'não reinicia por causa de ERR');
});

await test('timeout: 1ª frase usa o prazo frio (15 s), as seguintes o normal (4 s); timeout mata o helper e não repete', async () => {
  const silent = ok({ onLine: () => {} });
  const t = mk({ behavior: silent });
  const p1 = track(t.provider.synth('Olá'));
  await flush();
  assert.strictEqual(t.spawn.calls[0].child.lines.length, 1);
  t.timers.advance(14999);
  await flush();
  assert.strictEqual(p1.state, 'pending');
  t.timers.advance(1);
  await flush();
  assert.strictEqual(p1.err?.code, 'SAPI_TIMEOUT');
  assert.ok(t.spawn.calls[0].child.killed);
  assert.strictEqual(t.spawn.calls.length, 1, 'timeout não reinicia sozinho');

  // Depois de uma resposta boa o prazo cai para 4 s.
  let answers = 0;
  const t2 = mk({ behavior: ok({ onLine: (c, line) => { if (answers++ === 0) okReply(c, line); } }) });
  await guard(t2.provider.synth('primeira'));
  const p2 = track(t2.provider.synth('segunda'));
  await flush();
  t2.timers.advance(3999);
  await flush();
  assert.strictEqual(p2.state, 'pending');
  t2.timers.advance(1);
  await flush();
  assert.strictEqual(p2.err?.code, 'SAPI_TIMEOUT');
  // E a próxima chamada sobe um helper novo.
  answers = 0; // o helper novo responde ao 1º pedido dele
  const spawn2 = t2.spawn.calls.length;
  await guard(t2.provider.synth('terceira'));
  assert.strictEqual(t2.spawn.calls.length, spawn2 + 1);
});

await test('READY que nunca chega: SAPI_TIMEOUT no prazo frio e probe devolve ok:false', async () => {
  const t = mk({ behavior: { onSpawn: () => {} } });
  const pr = track(t.provider.probe());
  await flush();
  t.timers.advance(15000);
  await flush();
  assert.strictEqual(pr.state, 'ok');
  assert.strictEqual(pr.value.ok, false);
  assert.match(pr.value.detail, /SAPI_TIMEOUT/);
  assert.ok(t.spawn.calls[0].child.killed);
});

await test('linha gigante: acima de 16 MB (sem quebra de linha, ou completa) vira SAPI_BAD_RESPONSE e mata o helper', async () => {
  const noNewline = mk({ behavior: ok({ onLine: (c) => { for (let i = 0; i < 17; i++) c.sayRaw(Buffer.alloc(1 << 20, 0x41)); } }) });
  await rejectsWithCode(noNewline.provider.synth('Olá'), 'SAPI_BAD_RESPONSE');
  assert.ok(noNewline.spawn.calls[0].child.killed);
  assert.strictEqual(noNewline.spawn.calls.length, 1, 'não é morte do helper: sem reinício');

  const complete = mk({ behavior: ok({ onLine: (c) => c.sayRaw(Buffer.concat([Buffer.alloc(17 << 20, 0x41), Buffer.from('\n')])) }) });
  await rejectsWithCode(complete.provider.synth('Olá'), 'SAPI_BAD_RESPONSE');
  assert.ok(complete.spawn.calls[0].child.killed);
});

await test('resposta grande porém válida (5 MB de PCM) passa', async () => {
  const big = Buffer.alloc(5 * 1024 * 1024, 3);
  const t = mk({ behavior: ok({ onLine: (c, line) => c.say(`${decode(line).id} OK ${big.toString('base64')}`) }) });
  const r = await guard(t.provider.synth('Olá'), 15000);
  assert.strictEqual(r.pcm.length, big.length);
});

await test('helper morre no meio do pedido: UM reinício e o pedido é refeito; morrendo de novo, SAPI_EXIT', async () => {
  const dying = { onSpawn: (c) => c.say('READY Voz'), onLine: (c) => c.exit(1) };
  const t = mk({ behavior: (i) => (i === 0 ? dying : ok()) });
  const r = await guard(t.provider.synth('Olá'));
  assert.strictEqual(r.pcm.length, 'Olá'.length * 1920);
  assert.strictEqual(t.spawn.calls.length, 2);
  assert.ok(t.logs.some((l) => l.includes('reiniciando')));

  const always = mk({ behavior: dying });
  await rejectsWithCode(always.provider.synth('Olá'), 'SAPI_EXIT');
  assert.strictEqual(always.spawn.calls.length, 2, 'exatamente um reinício');
  // Uma chamada NOVA depois disso tem direito a outro helper (o limite é por pedido).
  const again = mk({ behavior: (i) => (i < 2 ? dying : ok()) });
  await rejectsWithCode(again.provider.synth('um'), 'SAPI_EXIT');
  assert.ok((await guard(again.provider.synth('dois'))).pcm.length > 0);
  assert.strictEqual(again.spawn.calls.length, 3);
});

await test('helper morre antes do READY, spawn que lança e evento error (ENOENT): um reinício', async () => {
  const early = mk({ behavior: (i) => (i === 0 ? { onSpawn: (c) => c.exit(1) } : ok()) });
  assert.ok((await guard(early.provider.synth('Olá'))).pcm.length > 0);
  assert.strictEqual(early.spawn.calls.length, 2);

  const throwing = mk({ behavior: { throwOnSpawn: true } });
  await rejectsWithCode(throwing.provider.synth('Olá'), 'SAPI_EXIT');
  assert.strictEqual(throwing.spawn.calls.length, 2);

  const errEvent = mk({ behavior: { onSpawn: (c) => c.emit('error', Object.assign(new Error('x'), { code: 'ENOENT' })) } });
  await rejectsWithCode(errEvent.provider.synth('Olá'), 'SAPI_EXIT');
  assert.strictEqual(errEvent.spawn.calls.length, 2);
});

await test('NOVOICE: SAPI_NOVOICE sem reinício e sem subir processo a cada pedido por 5 minutos', async () => {
  const noVoice = { onSpawn: (c) => { c.say('NOVOICE'); setImmediate(() => c.exit(2)); } };
  const t = mk({ behavior: (i) => (i === 0 ? noVoice : ok()) });
  await rejectsWithCode(t.provider.synth('Olá'), 'SAPI_NOVOICE');
  assert.strictEqual(t.spawn.calls.length, 1);
  await rejectsWithCode(t.provider.synth('Olá'), 'SAPI_NOVOICE');
  assert.strictEqual(t.spawn.calls.length, 1);
  const probe = await guard(t.provider.probe());
  assert.strictEqual(probe.ok, false);
  assert.match(probe.detail, /SAPI_NOVOICE/);
  t.timers.advance(5 * 60_000 + 1);
  assert.ok((await guard(t.provider.synth('Olá'))).pcm.length > 0);
  assert.strictEqual(t.spawn.calls.length, 2);
});

await test('abort: já abortado não sobe processo; em andamento rejeita na hora e a resposta tardia é descartada', async () => {
  const pre = new AbortController();
  pre.abort();
  const t0 = mk();
  await rejectsWithCode(t0.provider.synth('Olá', { signal: pre.signal }), 'ABORTED');
  assert.strictEqual(t0.spawn.calls.length, 0);

  const held = [];
  const t = mk({ behavior: ok({ onLine: (c, line) => { const d = decode(line); held.push(() => c.say(`${d.id} OK ${fakePcm(d.text).toString('base64')}`)); } }) });
  const ac = new AbortController();
  const p1 = track(t.provider.synth('primeira', { signal: ac.signal }));
  await flush();
  ac.abort();
  await flush();
  assert.strictEqual(p1.err?.code, 'ABORTED');
  const child = t.spawn.calls[0].child;
  assert.ok(!child.killed, 'abort não mata o helper');
  // Um pedido novo espera a resposta abandonada chegar (nunca dois pedidos ao mesmo tempo).
  const p2 = track(t.provider.synth('segunda'));
  await flush();
  assert.strictEqual(child.lines.length, 1);
  assert.strictEqual(p2.state, 'pending');
  held[0]();
  await flush();
  assert.strictEqual(child.lines.length, 2);
  held[1]();
  await flush();
  assert.strictEqual(p2.state, 'ok');
  assert.strictEqual(p2.value.pcm.length, 'segunda'.length * 1920, 'cada pedido recebe a SUA resposta');
});

await test('abort durante o READY e resposta abandonada que nunca chega', async () => {
  let releaseReady;
  const t = mk({ behavior: ok({ onSpawn: (c) => { releaseReady = () => c.say('READY Voz'); } }) });
  const ac = new AbortController();
  const p = track(t.provider.synth('Olá', { signal: ac.signal }));
  await flush();
  ac.abort();
  await flush();
  assert.strictEqual(p.err?.code, 'ABORTED');
  releaseReady();
  await flush();
  assert.ok((await guard(t.provider.synth('Olá'))).pcm.length > 0);
  assert.strictEqual(t.spawn.calls.length, 1, 'o mesmo helper serve o pedido seguinte');

  // Resposta abandonada que nunca vem: o prazo mata o helper e o próximo pedido sobe outro.
  const stuck = mk({ behavior: ok({ onLine: () => {} }) });
  const ac2 = new AbortController();
  const p2 = track(stuck.provider.synth('Olá', { signal: ac2.signal }));
  await flush();
  ac2.abort();
  await flush();
  assert.strictEqual(p2.err?.code, 'ABORTED');
  stuck.timers.advance(15000);
  await flush();
  assert.ok(stuck.spawn.calls[0].child.killed);
});

await test('id de resposta diferente do pedido: SAPI_BAD_RESPONSE e helper morto', async () => {
  const t = mk({ behavior: ok({ onLine: (c) => c.say(`zz OK ${fakePcm('x').toString('base64')}`) }) });
  await rejectsWithCode(t.provider.synth('Olá'), 'SAPI_BAD_RESPONSE');
  assert.ok(t.spawn.calls[0].child.killed);
});

await test('PCM com tamanho que não é de 16 bits estéreo é recusado', async () => {
  const t = mk({ behavior: ok({ onLine: (c, line) => c.say(`${decode(line).id} OK ${Buffer.alloc(6).toString('base64')}`) }) });
  await rejectsWithCode(t.provider.synth('Olá'), 'SAPI_BAD_RESPONSE');
});

await test('CRLF, linhas estranhas antes do READY e resposta em pedaços quebrados no meio', async () => {
  const messy = {
    onSpawn: (c) => {
      c.say('AVISO qualquer do PowerShell');
      c.sayRaw(Buffer.from('READY Voz Com CRLF\r\n', 'latin1'));
    },
    onLine: (c, line) => {
      const { id, text } = decode(line);
      const full = Buffer.from(`${id} OK ${fakePcm(text).toString('base64')}\r\n`, 'latin1');
      for (const cut of [[0, 3], [3, 40], [40, full.length - 1], [full.length - 1, full.length]]) c.sayRaw(full.subarray(cut[0], cut[1]));
    },
  };
  const t = mk({ behavior: ok(messy) });
  const r = await guard(t.provider.synth('Olá'));
  assert.strictEqual(r.pcm.length, 'Olá'.length * 1920);
  assert.deepStrictEqual(await t.provider.probe(), { ok: true, detail: 'voz Voz Com CRLF' });

  const noisy = mk({ behavior: ok({ onSpawn: (c) => { for (let i = 0; i < 11; i++) c.say(`lixo ${i}`); } }) });
  await rejectsWithCode(noisy.provider.synth('Olá'), 'SAPI_BAD_RESPONSE');
});

await test('pedidos simultâneos são serializados e cada um recebe a sua resposta', async () => {
  const held = [];
  const t = mk({ behavior: ok({ onLine: (c, line) => { const d = decode(line); held.push(() => c.say(`${d.id} OK ${fakePcm(d.text).toString('base64')}`)); } }) });
  const ps = ['a', 'bb', 'cccc'].map((txt) => track(t.provider.synth(txt)));
  await flush();
  const child = t.spawn.calls[0].child;
  assert.strictEqual(child.lines.length, 1);
  held[0]();
  await flush();
  assert.strictEqual(child.lines.length, 2);
  held[1]();
  await flush();
  assert.strictEqual(child.lines.length, 3);
  held[2]();
  await flush();
  assert.deepStrictEqual(ps.map((p) => p.value?.pcm.length), [1920, 2 * 1920, 4 * 1920]);
  const ids = child.lines.map((l) => l.split(' ')[0]);
  assert.strictEqual(new Set(ids).size, 3, 'ids únicos');
});

await test('stderr é drenado e jamais vai ao log; o texto falado também não', async () => {
  const t = mk({ behavior: ok({ onLine: (c, line) => { c.stderr.write('SEGREDO-STDERR\n'.repeat(5000)); okReply(c, line); } }) });
  await guard(t.provider.synth('texto-confidencial-do-usuario'));
  await t.provider.probe();
  const child = t.spawn.calls[0].child;
  assert.ok(child.stderr.listenerCount('data') > 0, 'stderr tem leitor (senão o pipe enche)');
  const all = t.logs.join('\n');
  assert.ok(!all.includes('SEGREDO'));
  assert.ok(!all.includes('texto-confidencial'));
  assert.ok(t.logs.length > 0, 'houve log de metadados');
});

await test('inatividade: encerra o helper depois de idleMinutes e o pedido seguinte sobe outro', async () => {
  const t = mk();
  await guard(t.provider.synth('Olá'));
  await flush();
  const child = t.spawn.calls[0].child;
  t.timers.advance(9 * 60_000);
  await flush();
  assert.ok(!child.stdinEnded);
  assert.strictEqual(t.provider.getInfo().running, true);
  t.timers.advance(60_000);
  await flush();
  assert.ok(child.stdinEnded && child.exited, 'stdin fechado e processo saiu');
  assert.strictEqual(t.provider.getInfo().running, false);
  await guard(t.provider.synth('de novo'));
  assert.strictEqual(t.spawn.calls.length, 2);
  await flush();
  assert.strictEqual(t.timers.count(), 1, 'só o relógio de inatividade do helper novo');
});

await test('dispose: fecha o stdin, espera sair, é idempotente e o provedor não sobe mais', async () => {
  const t = mk();
  await guard(t.provider.synth('Olá'));
  await guard(t.provider.dispose());
  const child = t.spawn.calls[0].child;
  assert.ok(child.stdinEnded && child.exited);
  await guard(t.provider.dispose());
  await rejectsWithCode(t.provider.synth('Olá'), 'SAPI_EXIT');
  assert.strictEqual(t.spawn.calls.length, 1);
  assert.strictEqual(t.timers.count(), 0, 'nenhum timer sobrando');
});

await test('dispose com helper teimoso: espera 3 s, mata e, se nem assim sair, desiste em +1 s', async () => {
  const t = mk({ behavior: ok({ onEnd: () => {} }) });
  await guard(t.provider.synth('Olá'));
  const d = track(t.provider.dispose());
  await flush();
  assert.strictEqual(d.state, 'pending');
  t.timers.advance(3000);
  await flush();
  assert.ok(t.spawn.calls[0].child.killed);
  assert.strictEqual(d.state, 'ok', 'o kill faz o processo sair');

  const stubborn = mk({ behavior: ok({ onEnd: () => {}, ignoreKill: true }) });
  await guard(stubborn.provider.synth('Olá'));
  const d2 = track(stubborn.provider.dispose());
  await flush();
  stubborn.timers.advance(3000);
  await flush();
  assert.strictEqual(d2.state, 'pending');
  stubborn.timers.advance(1000);
  await flush();
  assert.strictEqual(d2.state, 'ok');
});

await test('dispose com pedido em andamento: o pedido recebe ABORTED', async () => {
  const t = mk({ behavior: ok({ onLine: () => {} }) });
  const p = track(t.provider.synth('Olá'));
  await flush();
  await guard(t.provider.dispose());
  assert.strictEqual(p.err?.code, 'ABORTED');
});

await test('fora do Windows: probe devolve ok:false e synth dá SAPI_UNAVAILABLE, sem processo', async () => {
  const t = mk({ platform: 'linux' });
  const probe = await t.provider.probe();
  assert.strictEqual(probe.ok, false);
  await rejectsWithCode(t.provider.synth('Olá'), 'SAPI_UNAVAILABLE');
  assert.strictEqual(t.spawn.calls.length, 0);
});

await test('probe e warmup: probe lê a voz; warmup sintetiza uma frase minúscula e nunca rejeita', async () => {
  const t = mk();
  assert.deepStrictEqual(await guard(t.provider.probe()), { ok: true, detail: 'voz Voz Falsa' });
  await guard(t.provider.warmup());
  assert.strictEqual(t.spawn.calls.length, 1);
  assert.strictEqual(t.spawn.calls[0].child.lines.length, 1);

  const broken = mk({ behavior: { throwOnSpawn: true } });
  await guard(broken.provider.warmup()); // não lança
  assert.ok(broken.logs.some((l) => l.startsWith('warn') && l.includes('SAPI_EXIT')));
});

// ═══════════════════════════════════════════════════════════════════════
// ── Correções da revisão ──────────────────────────────────────────────

await test('erros assíncronos dos pipes do helper (stdin/EPIPE, stdout, stderr) NÃO viram uncaughtException', async () => {
  const quiet = ok({ onLine: () => {} }); // o pedido fica em andamento
  const t = mk({ behavior: (i) => (i === 0 ? quiet : ok()) });
  const p = t.provider.synth('Olá');
  await flush();
  const child = t.spawn.calls[0].child;
  assert.ok(child, 'o helper subiu');
  // Sem ouvinte de 'error', emitir aqui LANÇARIA (e no bot de verdade viraria uncaughtException, com stack e DM ao dono).
  assert.doesNotThrow(() => child.stdout.emit('error', new Error('x')), 'stdout');
  assert.doesNotThrow(() => child.stderr.emit('error', new Error('y')), 'stderr');
  assert.doesNotThrow(() => child.stdin.emit('error', Object.assign(new Error('EPIPE'), { code: 'EPIPE' })), 'stdin');
  // O EPIPE derruba o helper (SAPI_EXIT) e o pedido recomeça UMA vez num helper novo.
  const r = await guard(p);
  assert.ok(r.pcm.length > 0);
  assert.strictEqual(t.spawn.calls.length, 2);
  assert.ok(t.logs.some((l) => l.includes('reiniciando')));
});

await test('todo timer do SAPI e do provedor falso recebe unref (nada segura o processo do bot)', async () => {
  const t = mk();
  await guard(t.provider.synth('Olá'));
  await flush();
  t.timers.advance(10 * 60_000); // inatividade: o helper encerra (cria os timers da parada)
  await flush();
  await guard(t.provider.synth('de novo')); // sobe outro helper (timer de READY, de pedido e de inatividade)
  await guard(t.provider.dispose());
  assert.ok(t.timers.handles.length >= 5, `timers criados: ${t.timers.handles.length}`);
  assert.deepStrictEqual(t.timers.handles.filter((h) => !h.unrefCalled).length, 0, 'todos com unref');

  const timers = makeTimers();
  const p = createFakeProvider({ mode: 'slow', delayMs: 1000, timers });
  const run = track(p.synth('x'));
  await flush();
  timers.advance(1000);
  await flush();
  assert.strictEqual(run.state, 'ok');
  assert.ok(timers.handles.length >= 1 && timers.handles.every((h) => h.unrefCalled), 'fake: timer com unref');
});

await test('isWarm(): quente só com helper vivo que já respondeu; o helper que dorme (inatividade) volta a ser frio', async () => {
  const t = mk();
  assert.strictEqual(t.provider.isWarm(), false, 'nada no ar');
  await guard(t.provider.probe());
  assert.strictEqual(t.provider.getInfo().running, true);
  assert.strictEqual(t.provider.isWarm(), false, 'helper no ar, mas a 1ª frase (que carrega a voz) ainda não aconteceu');
  await guard(t.provider.synth('Olá'));
  assert.strictEqual(t.provider.isWarm(), true);
  t.timers.advance(10 * 60_000); // inatividade
  await flush();
  assert.strictEqual(t.provider.getInfo().running, false);
  assert.strictEqual(t.provider.isWarm(), false, 'o helper dormiu');
  await guard(t.provider.synth('de novo'));
  assert.strictEqual(t.provider.isWarm(), true);
  t.spawn.calls[1].child.exit(1); // o helper morre
  await flush();
  assert.strictEqual(t.provider.isWarm(), false);
});

await test('motor + SAPI: depois que o helper dorme, a 1ª fala volta a ter o prazo FRIO (15 s), não 4 s', async () => {
  const t = mk();
  const engineTimers = makeTimers();
  const engine = createEngine({
    providers: [t.provider],
    config: { ...getTtsConfig({}), providers: ['sapi'] },
    timers: engineTimers,
  });
  await guard(engine.synthesize('um', { sensitive: false }));
  await guard(engine.synthesize('dois', { sensitive: false }));
  t.timers.advance(10 * 60_000); // o helper dorme
  await flush();
  await guard(engine.synthesize('tres', { sensitive: false }));
  await guard(engine.synthesize('quatro', { sensitive: false }));
  assert.deepStrictEqual(engineTimers.seen, [15000, 4000, 15000, 4000]);
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'closed');
  await engine.disposeAll();
});

// ═══════════════════════════════════════════════════════════════════════

console.log('Higiene do código');

await test('audio.js, sapi.js e fake.js: sem console.*, sem exec/shell, sem repassar process.env ao filho', () => {
  const dir = path.join(ROOT, 'src/services/tts');
  for (const rel of ['audio.js', 'providers/sapi.js', 'providers/fake.js']) {
    const src = fs.readFileSync(path.join(dir, rel), 'utf8');
    assert.ok(!/\bconsole\./.test(src), `${rel}: console.*`);
    assert.ok(!/\bexecSync?\s*\(|\bexec\s*\(/.test(src), `${rel}: exec`);
    assert.ok(!/shell:\s*true/.test(src), `${rel}: shell`);
    assert.ok(!/env:\s*process\.env/.test(src), `${rel}: env do processo`);
  }
});

await test('importar os módulos não deixa timer, processo nem handle (o processo termina sozinho)', async () => {
  const urls = ['audio.js', 'providers/sapi.js', 'providers/fake.js'].map((f) => pathToFileURL(path.join(ROOT, 'src/services/tts', f)).href);
  // O filho informa a hora em que terminou de importar: o que se mede é quanto o processo DEMORA A SAIR depois disso
  // (um timer pendente o seguraria), e não o tempo de subir o Node, que varia muito com o PC ocupado.
  const code = `${urls.map((u) => `await import(${JSON.stringify(u)});`).join('')} console.log('importado', Date.now());`;
  const out = await guard(new Promise((resolve, reject) => {
    execFile(process.execPath, ['--input-type=module', '-e', code], { timeout: 8000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }), 10000);
  const m = /importado (\d+)/.exec(out);
  assert.ok(m, out);
  assert.ok(Date.now() - Number(m[1]) < 4000, 'o processo ficou vivo depois de importar');
});

await test('scripts/tts-amostra.mjs --fake: grava WAVs válidos de frases fixas e não apaga a pasta', async () => {
  const out = await guard(new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts/tts-amostra.mjs'), '--fake'], { timeout: 20000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }), 25000);
  const m = /Amostras: (\d+) arquivo\(s\) em (.+)/.exec(out);
  assert.ok(m, out);
  const dir = m[2].trim();
  try {
    assert.ok(path.basename(dir).startsWith('yui-tts-amostra-'));
    assert.ok(dir.startsWith(os.tmpdir()));
    assert.match(out, /NÃO é apagada/);
    assert.match(out, /Remove-Item/);
    const files = fs.readdirSync(dir).filter((f) => f.endsWith('.wav'));
    assert.strictEqual(files.length, Number(m[1]));
    assert.ok(files.length >= 8);
    const wav = parseWav(fs.readFileSync(path.join(dir, files[0])));
    assert.strictEqual(wav.sampleRate, 48000);
    assert.strictEqual(wav.channels, 2);
    assert.strictEqual(wav.pcm.length % DISCORD_FRAME_BYTES, 0);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

await test('scripts/tts-amostra.mjs --fake --limpar: gera as amostras e apaga a pasta temporária no fim', async () => {
  const out = await guard(new Promise((resolve, reject) => {
    execFile(process.execPath, [path.join(ROOT, 'scripts/tts-amostra.mjs'), '--fake', '--limpar'], { timeout: 20000, windowsHide: true }, (err, stdout) => (err ? reject(err) : resolve(stdout)));
  }), 25000);
  const m = /Amostras: (\d+) arquivo\(s\) gerado\(s\); a pasta temporária foi apagada: (.+)/.exec(out);
  assert.ok(m, out);
  assert.ok(Number(m[1]) >= 8);
  const dir = m[2].trim();
  assert.ok(path.basename(dir).startsWith('yui-tts-amostra-') && dir.startsWith(os.tmpdir()));
  assert.strictEqual(fs.existsSync(dir), false, 'a pasta foi apagada');
  assert.doesNotMatch(out, /NÃO é apagada/);
});

// ═══════════════════════════════════════════════════════════════════════
console.log('ffprobe');

/** Resolve o caminho do ffprobe pelo helper do projeto (que importa o logger: roda em pasta temporária). */
async function resolveFfprobe() {
  const original = process.cwd();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-tts-audio-bin-'));
  process.env.LOG_LEVEL = 'error';
  try {
    process.chdir(tmp);
    const bin = await import(pathToFileURL(path.join(ROOT, 'src/utils/binaries.js')).href);
    const log = await import(pathToFileURL(path.join(ROOT, 'src/utils/logger.js')).href);
    const found = bin.getFfprobePath();
    log.logger.close();
    await new Promise((r) => setTimeout(r, 300));
    return found;
  } finally {
    process.chdir(original);
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* o winston ainda pode segurar o log; é só lixo temporário */ }
  }
}

await test('ffprobe lê o WAV gerado: 48000 Hz, 2 canais, duração dentro de 20 ms', async () => {
  const ffprobe = await resolveFfprobe();
  const exists = await new Promise((resolve) => execFile(ffprobe, ['-version'], { timeout: 10000, windowsHide: true }, (err) => resolve(!err)));
  if (!exists) return skip('ffprobe não encontrado');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-tts-ffprobe-'));
  try {
    const out = toDiscordPcm({ pcm: tonePcm({ sampleRate: 22050, ms: 1700, amp: 0.4, leadMs: 120 }), sampleRate: 22050, channels: 1 });
    const file = path.join(dir, 'saida.wav');
    fs.writeFileSync(file, encodeWav({ pcm: out, sampleRate: 48000, channels: 2 }));
    const stdout = await new Promise((resolve, reject) => {
      execFile(ffprobe, ['-v', 'error', '-show_entries', 'stream=sample_rate,channels,codec_name:format=duration', '-of', 'default=nw=1', file],
        { timeout: 15000, windowsHide: true }, (err, so) => (err ? reject(err) : resolve(so)));
    });
    const get = (k) => new RegExp(`${k}=(\\S+)`).exec(stdout)?.[1];
    assert.strictEqual(get('sample_rate'), '48000');
    assert.strictEqual(get('channels'), '2');
    assert.strictEqual(get('codec_name'), 'pcm_s16le');
    assert.ok(Math.abs(Number(get('duration')) * 1000 - pcmDurationMs(out)) <= 20, stdout);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// ═══════════════════════════════════════════════════════════════════════
console.log('Contrato com @discordjs/voice real');

let voiceLib = null;
let haveOpus = true;
try {
  require('opusscript');
  voiceLib = await import('@discordjs/voice');
} catch {
  haveOpus = false;
}

/** Lê os pacotes Opus como o AudioPlayer faz (resource.read()) até o fim do fluxo. */
async function drainPackets(res, limitMs = 60000) {
  const sizes = [];
  const t0 = performance.now();
  let maxStall = 0;
  let maxBusy = 0;
  for (;;) {
    const packet = res.read();
    if (packet) {
      sizes.push(packet.length);
      continue;
    }
    if (res.playStream.readableEnded || res.playStream.destroyed) break;
    if (performance.now() - t0 > limitMs) throw new Error('o recurso não terminou');
    // Tempo até o laço voltar a este ponto = tudo que rodou nesse meio tempo (a codificação).
    const before = performance.now();
    const cpuBefore = process.cpuUsage();
    await tick();
    const wall = performance.now() - before;
    const cpu = process.cpuUsage(cpuBefore);
    maxStall = Math.max(maxStall, wall);
    // Parada REAL = o processo esteve ocupado (CPU) durante a espera. Outro programa roubando a CPU
    // aumenta a espera de relógio mas não o tempo de CPU deste processo.
    maxBusy = Math.max(maxBusy, Math.min(wall, (cpu.user + cpu.system) / 1000));
  }
  sizes.maxStallMs = maxStall;
  sizes.maxBusyMs = maxBusy;
  return sizes;
}
const newResource = (pcm) => voiceLib.createAudioResource(pcmToReadable(pcm), { inputType: voiceLib.StreamType.Raw, silencePaddingFrames: 0 });

await test('createAudioResource(Raw) gera 1 pacote Opus por quadro (nem a mais, nem a menos)', async () => {
  if (!haveOpus) return skip('opusscript ausente');
  const pcm = toDiscordPcm({ pcm: tonePcm({ sampleRate: 24000, ms: 3000, amp: 0.5, freq: 300 }), sampleRate: 24000, channels: 1 });
  const frames = pcm.length / DISCORD_FRAME_BYTES;
  const cpu0 = process.cpuUsage();
  const t0 = performance.now();
  const sizes = await guard(drainPackets(newResource(pcm)), 30000);
  const wall = performance.now() - t0;
  const cpu = process.cpuUsage(cpu0);
  assert.strictEqual(sizes.length, frames, `pacotes ${sizes.length} x quadros ${frames}`);
  assert.ok(sizes.every((s) => s >= 1 && s <= 1275), 'tamanho de pacote Opus plausível');
  metrics.opusMsPerFrameWall3s = wall / frames;
  metrics.opusCpuMsPerFrame3s = (cpu.user + cpu.system) / 1000 / frames;
});

await test('200 recursos criados e descartados não fazem a memória crescer de forma anormal', async () => {
  if (!haveOpus) return skip('opusscript ausente');
  v8.setFlagsFromString('--expose-gc');
  const gc = vm.runInNewContext('gc');
  const pcm = toDiscordPcm({ pcm: tonePcm({ sampleRate: 24000, ms: 500, amp: 0.5 }), sampleRate: 24000, channels: 1 });
  async function churn(count) {
    for (let i = 0; i < count; i++) {
      const res = newResource(pcm);
      if (i % 2 === 0) {
        await drainPackets(res); // tocou até o fim
      } else {
        for (let k = 0; k < 5; k++) { res.read(); await tick(); }
        res.playStream.destroy(); // interrompido no meio (barge-in)
      }
    }
  }
  await guard(churn(40), 60000); // aquecimento: compila o WASM e enche caches
  await flush();
  gc();
  const m0 = process.memoryUsage();
  await guard(churn(200), 120000);
  await flush();
  gc();
  const m1 = process.memoryUsage();
  const growthMb = (m1.rss - m0.rss) / 1048576;
  metrics.memoryGrowth200ResourcesMb = growthMb;
  metrics.memoryGrowthExternalMb = (m1.external + m1.arrayBuffers - m0.external - m0.arrayBuffers) / 1048576;
  assert.ok(growthMb < 40, `rss cresceu ${growthMb.toFixed(1)} MB`);
});

await test('codificar 20 s em pedaços de 40 quadros não bloqueia o laço de eventos (máx. 50 ms)', async () => {
  if (!haveOpus) return skip('opusscript ausente');
  const pcm = toDiscordPcm({ pcm: tonePcm({ sampleRate: 24000, ms: 20000, amp: 0.5, freq: 250 }), sampleRate: 24000, channels: 1 });
  const frames = pcm.length / DISCORD_FRAME_BYTES;
  assert.ok(frames >= 1000);
  await drainPackets(newResource(Buffer.alloc(40 * DISCORD_FRAME_BYTES, 1))); // aquecimento

  /**
   * Codifica o PCM inteiro o mais rápido possível e mede de dois jeitos o quanto o laço de
   * eventos ficou parado: o histograma do Node (monitorEventLoopDelay) e a espera real entre
   * duas voltas do laço (mais sensível: o histograma pode perder UM bloqueio isolado).
   */
  async function measure(makeResource) {
    const hist = monitorEventLoopDelay({ resolution: 5 });
    hist.enable();
    const cpu0 = process.cpuUsage();
    const t0 = performance.now();
    let sizes;
    try {
      sizes = await guard(drainPackets(makeResource()), 60000);
      await new Promise((r) => setTimeout(r, 30)); // dá ao histograma a chance de registrar a última volta
    } finally {
      hist.disable();
    }
    const cpu = process.cpuUsage(cpu0);
    return {
      sizes,
      histMs: hist.max / 1e6,
      stallMs: sizes.maxStallMs,
      busyMs: sizes.maxBusyMs,
      wallPerFrame: (performance.now() - t0) / frames,
      cpuPerFrame: (cpu.user + cpu.system) / 1000 / frames,
    };
  }

  // O PC é compartilhado (jogo, bot, outros testes): um tranco isolado do sistema não prova nada.
  // Um bloqueio REAL do codificador aparece em todas as rodadas, então basta uma abaixo do limite.
  const runs = [];
  let best = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    const r = await measure(() => newResource(pcm));
    assert.strictEqual(r.sizes.length, frames);
    // Só conta como bloqueio o que também foi CPU ocupada deste processo (um jogo ou outra suíte rodando ao
    // lado deixa o relógio lento sem que o codificador tenha travado nada).
    r.worst = Math.min(Math.max(r.histMs, r.stallMs), r.busyMs + 5);
    runs.push(r);
    if (!best || r.worst < best.worst) best = r;
    if (r.worst <= 50) break;
  }
  metrics.eventLoopHistMaxMs = best.histMs;
  metrics.eventLoopStallMaxMs = best.stallMs;
  metrics.eventLoopRuns = runs.map((r) => `${r.histMs.toFixed(1)}/${r.stallMs.toFixed(1)}`).join(' | ');
  metrics.opusMsPerFrameWall20s = best.wallPerFrame;
  metrics.opusCpuMsPerFrame20s = best.cpuPerFrame;

  // Controle negativo: UM chunk com tudo, como Readable.from(buffer) faria. Prova que a medição enxerga o problema.
  const { Readable } = await import('node:stream');
  const control = await measure(() => voiceLib.createAudioResource(Readable.from([pcm]), { inputType: voiceLib.StreamType.Raw, silencePaddingFrames: 0 }));
  metrics.eventLoopStallMaxMsSingleChunkControl = control.stallMs;
  metrics.eventLoopBusyMaxMs = best.busyMs;

  assert.ok(best.worst <= 50, `laço de eventos parado (histograma/espera): ${metrics.eventLoopRuns} ms`);
  assert.ok(control.busyMs > best.busyMs * 2, `o controle (um chunk só) deveria parar o laço bem mais: ${control.busyMs} x ${best.busyMs}`);
});

// ═══════════════════════════════════════════════════════════════════════
console.log('SAPI real');

/**
 * Quantos powershell.exe com o helper do SAPI são FILHOS DESTE PROCESSO agora (marcador: o nome da variável
 * do script). O padrão usa [O] para não casar com a linha de comando do próprio contador. Só os filhos
 * diretos contam: a Yui de verdade falando numa call, ou outra execução deste teste ao lado, também tem
 * helpers vivos e não pode mudar o resultado.
 */
function countSapiHelpers() {
  return new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
      `@(Get-CimInstance Win32_Process -Filter "Name='powershell.exe' AND ParentProcessId=${process.pid}" | Where-Object { $_.CommandLine -like '*YUI_SAPI_V[O]ICE*' }).Count`],
    { timeout: 20000, windowsHide: true }, (err, stdout) => resolve(err ? -1 : Number(String(stdout).trim())));
  });
}
const isAlive = (pid) => {
  try { process.kill(pid, 0); return true; } catch { return false; }
};
async function waitDead(pid, ms) {
  const t0 = Date.now();
  while (isAlive(pid) && Date.now() - t0 < ms) await new Promise((r) => setTimeout(r, 100));
  return !isAlive(pid);
}
const median = (a) => [...a].sort((x, y) => x - y)[Math.floor(a.length / 2)];

let realOk = false;
if (process.platform === 'win32') {
  const probeProvider = createSapiProvider({ config: getTtsConfig({}), logger: SILENT });
  realOk = (await probeProvider.probe()).ok;
  await probeProvider.dispose();
}

await test('helper real: READY, frase curta com PCM > 20 ms, latência fria e quente, memória e encerramento limpo', async () => {
  if (!realOk) return skip(process.platform === 'win32' ? 'sem voz pt-BR do SAPI' : 'não é Windows');
  const before = await countSapiHelpers();

  // Frio: provedor novo, nenhum aquecimento (inclui subir o PowerShell e carregar a voz).
  const cold = createSapiProvider({ config: getTtsConfig({}), logger: SILENT });
  const tCold = Date.now();
  const first = await guard(cold.synth('Canberra, não Sydney.'), 30000);
  metrics.sapiColdFirstSynthMs = Date.now() - tCold;
  assert.strictEqual(first.sampleRate, 48000);
  assert.strictEqual(first.channels, 2);
  assert.ok(first.pcm.length % 4 === 0 && pcmDurationMs(first.pcm) > 20, `PCM de ${pcmDurationMs(first.pcm)} ms`);
  const out = toDiscordPcm(first);
  assert.ok(out.length > 0 && out.length % DISCORD_FRAME_BYTES === 0);
  assert.ok(pcmDurationMs(out) < pcmDurationMs(first.pcm) - 500, 'silêncios inicial/final do SAPI foram aparados');
  metrics.sapiRawMs = pcmDurationMs(first.pcm);
  metrics.sapiTrimmedMs = pcmDurationMs(out);

  // Quente: mediana de 7 frases médias.
  const warm = [];
  for (let i = 0; i < 7; i++) {
    const t0 = Date.now();
    const r = await guard(cold.synth(`Esta é a frase número ${i} para medir a síntese com o helper já aquecido.`), 10000);
    warm.push(Date.now() - t0);
    assert.ok(r.pcm.length > 3840);
  }
  metrics.sapiWarmMedianMs = median(warm);
  metrics.sapiWarmMaxMs = Math.max(...warm);

  // Memória do helper.
  const info = cold.getInfo();
  assert.ok(info.running && info.pid > 0);
  metrics.sapiHelperVoice = info.voice;
  metrics.sapiHelperWorkingSetMb = await new Promise((resolve) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `[math]::Round((Get-Process -Id ${info.pid}).WorkingSet64/1MB,1)`],
      { timeout: 20000, windowsHide: true }, (err, stdout) => resolve(err ? null : Number(String(stdout).trim().replace(',', '.'))));
  });

  // Aquecido: warmup() antes da 1ª frase real.
  const warmed = createSapiProvider({ config: getTtsConfig({}), logger: SILENT });
  const tWarmup = Date.now();
  await guard(warmed.warmup(), 30000);
  metrics.sapiWarmupMs = Date.now() - tWarmup;
  const tFirst = Date.now();
  await guard(warmed.synth('Canberra, não Sydney.'), 10000);
  metrics.sapiFirstAfterWarmupMs = Date.now() - tFirst;

  // Encerramento: dispose espera o processo sair e não sobra órfão.
  const pids = [info.pid, warmed.getInfo().pid];
  await guard(cold.dispose(), 10000);
  await guard(warmed.dispose(), 10000);
  for (const pid of pids) assert.ok(await waitDead(pid, 3000), `helper ${pid} ainda vivo depois do dispose`);
  const after = await countSapiHelpers();
  assert.strictEqual(after, before, `powershell órfão: antes ${before}, depois ${after}`);
});

await test('helper real: se o bot morrer à força (SIGKILL), o helper sai sozinho no EOF do stdin', async () => {
  if (!realOk) return skip(process.platform === 'win32' ? 'sem voz pt-BR do SAPI' : 'não é Windows');
  const child = spawn(process.execPath, [THIS_FILE, '--orphan-child'], { stdio: ['ignore', 'pipe', 'ignore'], windowsHide: true });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  await guard(new Promise((resolve) => child.on('exit', resolve)), 30000);
  const m = /PID (\d+) OK/.exec(out);
  assert.ok(m, `saída do filho: ${out}`);
  const pid = Number(m[1]);
  assert.ok(await waitDead(pid, 8000), `o helper ${pid} ficou órfão depois que o pai morreu`);
});

// ═══════════════════════════════════════════════════════════════════════
console.log('');
console.log('Medidas');
for (const [k, v] of Object.entries(metrics)) {
  console.log(`  ${k}: ${typeof v === 'number' ? Math.round(v * 100) / 100 : v}`);
}
console.log('');
console.log(`${passed} passaram, ${failed} falharam, ${skipped} ignorados`);
process.exit(failed ? 1 : 0);
