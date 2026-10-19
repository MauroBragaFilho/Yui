// Provedor de voz neural (Edge, nuvem): escape, limites, falhas e porta de privacidade do motor. Sem rede.
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { createEdgeProvider, escapeXml, safeProsody, safeVoice } from '../src/services/tts/providers/edge.js';
import { createFakeProvider } from '../src/services/tts/providers/fake.js';
import { createEngine } from '../src/services/tts/engine.js';
import { getTtsConfig } from '../src/services/tts/config.js';

let ok = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); ok++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FALHA', name, '\n       ', e?.message); }
}

const silentLog = { info() {}, warn() {}, error() {}, debug() {} };

/** Cliente falso da biblioteca: registra o SSML/texto recebido e devolve MP3 "falso" em pedaços. */
function fakeLib({ chunks = [Buffer.from('mp3-1'), Buffer.from('mp3-2')], fail = false, hang = false, big = false } = {}) {
  const calls = { texts: [], opts: [], voices: [], closed: 0 };
  class MsEdgeTTS {
    async setMetadata(voice) { if (fail) throw new Error('Connect Error'); calls.voices.push(voice); }
    toStream(text, opts) {
      calls.texts.push(text); calls.opts.push(opts);
      const s = new PassThrough();
      if (!hang) {
        setImmediate(() => {
          if (big) s.write(Buffer.alloc(3 * 1024 * 1024));
          else for (const c of chunks) s.write(c);
          s.end();
        });
      }
      return { audioStream: s };
    }
    close() { calls.closed++; }
  }
  return { loader: async () => ({ MsEdgeTTS, OUTPUT_FORMAT: { AUDIO_24KHZ_96KBITRATE_MONO_MP3: 'mp3' } }), calls };
}

/** spawn falso do ffmpeg: devolve PCM (n bytes) ou sai com erro. */
function fakeSpawn({ pcmBytes = 48000, code = 0 } = {}) {
  const seen = [];
  const spawn = (file, args, opts) => {
    seen.push({ file, args, opts });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    child.stdin.on('finish', () => setImmediate(() => { if (pcmBytes) child.stdout.write(Buffer.alloc(pcmBytes, 1)); child.stdout.end(); child.emit('close', code); }));
    return child;
  };
  return { spawn, seen };
}

const mk = (over = {}) => {
  const lib = fakeLib(over.lib);
  const sp = fakeSpawn(over.spawn);
  const p = createEdgeProvider({ config: { edgeVoice: 'pt-BR-FranciscaNeural', edgeRate: '-4%', edgePitch: '+0Hz', edgeMaxCharsPerDay: over.cap ?? 100000, ...over.config }, logger: silentLog, loadClient: lib.loader, spawn: sp.spawn, getFfmpeg: () => 'ffmpeg-falso', now: over.now });
  return { p, lib, sp };
};

console.log('A. Texto e configuração');
await test('escapeXml neutraliza os 5 caracteres e controles', () => {
  assert.equal(escapeXml(`a & b < c > "d" 'e'`), 'a &amp; b &lt; c &gt; &quot;d&quot; &apos;e&apos;');
  assert.equal(escapeXml('x\u0000y‮z'), 'x y z');
  assert.ok(!/[<>]/.test(escapeXml('</prosody><voice name="x">')));
});
await test('prosódia e voz inválidas (injeção de SSML pelo .env) caem no padrão', () => {
  assert.equal(safeProsody('-4%', 'x'), '-4%');
  assert.equal(safeProsody('+3Hz', 'x'), '+3Hz');
  assert.equal(safeProsody('"><evil/>', '+0Hz'), '+0Hz');
  assert.equal(safeVoice('pt-BR-ThalitaNeural', 'f'), 'pt-BR-ThalitaNeural');
  assert.equal(safeVoice('pt-BR-X"><x', 'pt-BR-FranciscaNeural'), 'pt-BR-FranciscaNeural');
});
await test('config: nuvem desligada => só SAPI; nuvem ligada => edge antes do SAPI', () => {
  assert.deepEqual(getTtsConfig({}).providers, ['sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_CLOUD: 'true' }).providers, ['edge', 'sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_CLOUD: 'true', YUI_TTS_PROVIDERS: 'sapi' }).providers, ['sapi']);
  assert.equal(getTtsConfig({}).edgeVoice, 'pt-BR-FranciscaNeural');
});

console.log('B. Síntese');
await test('sintetiza: PCM mono 24 kHz, SSML escapado, prosódia e voz certas, ffmpeg só com array', async () => {
  const { p, lib, sp } = mk();
  const r = await p.synth('Oi <b> & "tchau"');
  assert.equal(r.sampleRate, 24000);
  assert.equal(r.channels, 1);
  assert.equal(r.pcm.length, 48000);
  assert.equal(lib.calls.texts[0], 'Oi &lt;b&gt; &amp; &quot;tchau&quot;');
  assert.deepEqual(lib.calls.opts[0], { rate: '-4%', pitch: '+0Hz' });
  assert.deepEqual(lib.calls.voices, ['pt-BR-FranciscaNeural']);
  assert.ok(Array.isArray(sp.seen[0].args) && sp.seen[0].args.includes('s16le') && sp.seen[0].opts.windowsHide === true);
  assert.ok(!('DISCORD_TOKEN' in sp.seen[0].opts.env), 'ffmpeg não recebe o ambiente do bot');
  assert.ok(lib.calls.closed >= 1, 'conexão fechada');
});
await test('provedor é de NUVEM (local: false) e a sondagem não usa rede', async () => {
  const { p, lib } = mk();
  assert.equal(p.local, false);
  const pr = await p.probe();
  assert.equal(pr.ok, true);
  assert.equal(lib.calls.texts.length, 0);
});
await test('texto vazio, longo demais e teto diário recusados com código', async () => {
  const { p } = mk({ cap: 1000 });
  await assert.rejects(p.synth('   '), (e) => e.code === 'EDGE_EMPTY');
  await assert.rejects(p.synth('a'.repeat(601)), (e) => e.code === 'EDGE_TOO_LONG');
  await p.synth('a'.repeat(600));
  await assert.rejects(p.synth('b'.repeat(500)), (e) => e.code === 'EDGE_QUOTA');
  assert.equal(p.getUsage().chars, 600);
});
await test('o teto diário zera no dia seguinte', async () => {
  let t = Date.parse('2026-10-16T12:00:00Z');
  const { p } = mk({ cap: 100, now: () => t });
  await p.synth('a'.repeat(100));
  await assert.rejects(p.synth('b'), (e) => e.code === 'EDGE_QUOTA');
  t += 24 * 3600 * 1000;
  await p.synth('c');
});
await test('falhas: conexão, áudio vazio, áudio enorme, ffmpeg com erro e sem saída; mensagem nunca vaza o texto', async () => {
  const segredo = 'texto-secreto-123';
  for (const [over, code] of [[{ lib: { fail: true } }, 'EDGE_ERROR'], [{ lib: { chunks: [] } }, 'EDGE_EMPTY'], [{ lib: { big: true } }, 'EDGE_TOO_BIG'], [{ spawn: { code: 1 } }, 'EDGE_FFMPEG'], [{ spawn: { pcmBytes: 0 } }, 'EDGE_FFMPEG']]) {
    const { p } = mk(over);
    await assert.rejects(p.synth(segredo), (e) => e.code === code && !String(e.message).includes(segredo), code);
  }
});
await test('abort cancela (antes e durante) e fecha a conexão', async () => {
  const { p, lib } = mk({ lib: { hang: true } });
  const pre = new AbortController(); pre.abort();
  await assert.rejects(p.synth('oi', { signal: pre.signal }), (e) => e.code === 'ABORTED');
  const ctl = new AbortController();
  const prom = p.synth('oi', { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(prom, (e) => e.code === 'ABORTED');
  assert.ok(lib.calls.closed >= 1);
});

console.log('C. Porta de privacidade do motor');
const timers = { setTimeout, clearTimeout };
const engineWith = (cfgOver, edge, sapi) => createEngine({ providers: [edge, sapi], config: { ...getTtsConfig({}), providers: ['edge', 'sapi'], ...cfgOver }, logger: silentLog, timers });
await test('nuvem DESLIGADA: o edge nunca é chamado (mesmo com texto público)', async () => {
  const edge = createFakeProvider({ name: 'edge', local: false });
  const sapi = createFakeProvider({ name: 'sapi', local: true });
  const eng = engineWith({ cloud: false }, edge, sapi);
  const r = await eng.synthesize('oi', { sensitive: false });
  assert.equal(r.provider, 'sapi');
  assert.equal(edge.stats?.synth ?? 0, 0);
});
await test('texto SENSÍVEL: o edge nunca é chamado, mesmo com a nuvem ligada', async () => {
  const edge = createFakeProvider({ name: 'edge', local: false });
  const sapi = createFakeProvider({ name: 'sapi', local: true });
  const eng = engineWith({ cloud: true }, edge, sapi);
  const r = await eng.synthesize('oi', { sensitive: true });
  assert.equal(r.provider, 'sapi');
  assert.equal(edge.stats?.synth ?? 0, 0);
});
await test('nuvem ligada e texto público: edge é o primeiro; se ele cai, o SAPI responde', async () => {
  const sapi = createFakeProvider({ name: 'sapi', local: true });
  let eng = engineWith({ cloud: true }, createFakeProvider({ name: 'edge', local: false }), sapi);
  assert.equal((await eng.synthesize('oi', { sensitive: false })).provider, 'edge');
  eng = engineWith({ cloud: true }, createFakeProvider({ name: 'edge', local: false, mode: 'fail' }), createFakeProvider({ name: 'sapi', local: true }));
  assert.equal((await eng.synthesize('oi', { sensitive: false, sticky: {} })).provider, 'sapi');
});

console.log(`\n${ok} teste(s) ok, ${fail} falha(s).`);
process.exit(fail ? 1 : 0);
