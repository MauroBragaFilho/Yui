// Provedor Azure Speech (API oficial, nuvem): SSML, chave só no cabeçalho, limites e falhas. Sem rede.
import assert from 'node:assert/strict';
import { createAzureProvider, buildSsml, escapeXml, safeRegion, safeVoice, safeStyle, safeProsody } from '../src/services/tts/providers/azure.js';
import { getTtsConfig } from '../src/services/tts/config.js';

let ok = 0;
let fail = 0;
async function test(name, fn) {
  try { await fn(); ok++; console.log('  ok  ', name); } catch (e) { fail++; console.log('  FALHA', name, '\n       ', e?.message); }
}
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const KEY = 'chave-super-secreta-123';
const env = { AZURE_SPEECH_KEY: KEY, AZURE_SPEECH_REGION: 'brazilsouth' };

function mkFetch({ status = 200, body = Buffer.alloc(4800, 1), json = null, hang = false, throws = false } = {}) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init });
    if (throws) throw new Error('rede caiu com ' + KEY);
    if (hang) await new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(new Error('abort'))));
    return { ok: status >= 200 && status < 300, status, arrayBuffer: async () => body.buffer.slice(body.byteOffset, body.byteOffset + body.length), json: async () => json };
  };
  return { fetchImpl, calls };
}
const mk = (cfg = {}, f = mkFetch(), e = env) => ({ p: createAzureProvider({ config: { azureRegion: 'brazilsouth', azureVoice: 'pt-BR-ThalitaMultilingualNeural', ...cfg }, env: e, logger: quiet, fetchImpl: f.fetchImpl }), f });

console.log('A. Validação e SSML');
await test('região, voz, estilo e prosódia hostis caem no padrão', () => {
  assert.equal(safeRegion('brazilsouth'), 'brazilsouth');
  assert.equal(safeRegion('evil.com/x'), '');
  assert.equal(safeVoice('pt-BR-ThalitaMultilingualNeural', 'x'), 'pt-BR-ThalitaMultilingualNeural');
  assert.equal(safeVoice('pt-BR-X"><x', 'fb'), 'fb');
  assert.equal(safeStyle('cheerful'), 'cheerful');
  assert.equal(safeStyle('"><evil'), '');
  assert.equal(safeProsody('+12Hz', 'x'), '+12Hz');
  assert.equal(safeProsody('1"><x', '+0Hz'), '+0Hz');
});
await test('SSML: texto escapado, estilo opcional, idioma pela voz', () => {
  const s = buildSsml({ text: 'a <b> & "c"', voice: 'pt-BR-ThalitaMultilingualNeural', style: 'cheerful', rate: '+5%', pitch: '+12Hz' });
  assert.ok(s.includes('a &lt;b&gt; &amp; &quot;c&quot;') && s.includes('xml:lang="pt-BR"') && s.includes('mstts:express-as style="cheerful"'));
  assert.ok(!buildSsml({ text: 'x', voice: 'pt-BR-FranciscaNeural' }).includes('express-as'));
  assert.equal(escapeXml('<>'), '&lt;&gt;');
});
await test('config: chave presente + nuvem => azure vem primeiro; a CHAVE não entra no objeto de config', () => {
  assert.deepEqual(getTtsConfig({ YUI_TTS_CLOUD: 'true', AZURE_SPEECH_KEY: KEY }).providers, ['azure', 'edge', 'sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_CLOUD: 'true' }).providers, ['edge', 'sapi']);
  assert.ok(!JSON.stringify(getTtsConfig({ YUI_TTS_CLOUD: 'true', AZURE_SPEECH_KEY: KEY })).includes(KEY));
});

console.log('B. Síntese');
await test('sintetiza: PCM cru 24 kHz mono, host fixo, chave SÓ no cabeçalho, redirect bloqueado', async () => {
  const { p, f } = mk({ azureStyle: 'cheerful', azureRate: '+5%', azurePitch: '+12Hz' });
  const r = await p.synth('Oi, Yui!');
  assert.deepEqual([r.sampleRate, r.channels, r.pcm.length], [24000, 1, 4800]);
  const c = f.calls[0];
  assert.equal(c.url, 'https://brazilsouth.tts.speech.microsoft.com/cognitiveservices/v1');
  assert.equal(c.init.headers['Ocp-Apim-Subscription-Key'], KEY);
  assert.ok(!c.url.includes(KEY) && !String(c.init.body).includes(KEY));
  assert.equal(c.init.headers['X-Microsoft-OutputFormat'], 'raw-24khz-16bit-mono-pcm');
  assert.equal(c.init.redirect, 'error');
  assert.ok(String(c.init.body).includes('cheerful'));
  assert.equal(p.local, false);
});
await test('sonda sem rede: exige chave e região', async () => {
  assert.equal((await mk({}, mkFetch(), {}).p.probe()).ok, false);
  assert.equal((await mk({ azureRegion: '' }, mkFetch(), { AZURE_SPEECH_KEY: KEY }).p.probe()).ok, false);
  const pr = await mk().p.probe();
  assert.ok(pr.ok && !pr.detail.includes(KEY));
});
await test('erros HTTP e de rede têm código e NUNCA vazam a chave nem o texto', async () => {
  const segredo = 'texto-secreto-xyz';
  for (const [f, code] of [[mkFetch({ status: 401 }), 'AZURE_AUTH'], [mkFetch({ status: 403 }), 'AZURE_AUTH'], [mkFetch({ status: 429 }), 'AZURE_RATE'], [mkFetch({ status: 500 }), 'AZURE_HTTP'], [mkFetch({ throws: true }), 'AZURE_NETWORK'], [mkFetch({ body: Buffer.alloc(0) }), 'AZURE_EMPTY']]) {
    await assert.rejects(mk({}, f).p.synth(segredo), (e) => e.code === code && !String(e.message).includes(KEY) && !String(e.message).includes(segredo), code);
  }
});
await test('texto vazio/longo, sem chave e teto mensal', async () => {
  const { p } = mk({ azureMaxCharsPerMonth: 1000 });
  await assert.rejects(p.synth(' '), (e) => e.code === 'AZURE_EMPTY');
  await assert.rejects(p.synth('a'.repeat(601)), (e) => e.code === 'AZURE_TOO_LONG');
  await p.synth('a'.repeat(600));
  await assert.rejects(p.synth('b'.repeat(500)), (e) => e.code === 'AZURE_QUOTA');
  await assert.rejects(mk({}, mkFetch(), {}).p.synth('oi'), (e) => e.code === 'AZURE_CONFIG');
});
await test('abort cancela a chamada', async () => {
  const { p } = mk({}, mkFetch({ hang: true }));
  const ctl = new AbortController();
  const prom = p.synth('oi', { signal: ctl.signal });
  setTimeout(() => ctl.abort(), 20);
  await assert.rejects(prom, (e) => e.code === 'ABORTED');
});
await test('listVoices devolve só pt-*, com estilos', async () => {
  const f = mkFetch({ json: [{ ShortName: 'pt-BR-ThalitaMultilingualNeural', Gender: 'Female', Locale: 'pt-BR', StyleList: ['cheerful'] }, { ShortName: 'en-US-JennyNeural', Gender: 'Female', Locale: 'en-US' }] });
  const l = await mk({}, f).p.listVoices();
  assert.deepEqual(l, [{ name: 'pt-BR-ThalitaMultilingualNeural', gender: 'Female', locale: 'pt-BR', styles: ['cheerful'] }]);
  assert.equal(f.calls[0].url, 'https://brazilsouth.tts.speech.microsoft.com/cognitiveservices/voices/list');
});

console.log(`\n${ok} teste(s) ok, ${fail} falha(s).`);
process.exit(fail ? 1 : 0);
