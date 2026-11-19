// Voz pelo OmniRoute (etapa 12): a configuração, a preparação do texto, o provedor (corpo da chamada, chave, falhas, teto, cache, estilo, MP3)
// e o lugar dele no motor (ordem de reserva, porta de privacidade para texto sensível). Sem rede (fetch falso), sem Discord, sem processo, sem espera fixa.
// Execução: node tests/test-tts-omniroute.js
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { createOmnirouteProvider, prepareOmnirouteText, composeInput, resolveOmnirouteRoute, detectAudioFormat, MAX_TEXT_CHARS } from '../src/services/tts/providers/omniroute.js';
import { createFakeProvider } from '../src/services/tts/providers/fake.js';
import { createEngine } from '../src/services/tts/engine.js';
import { findSecret } from '../src/services/tts/secretGuard.js';
import { initTts, warmupTts, disposeGuild, shutdownTts } from '../src/services/tts/index.js';
import { getTtsConfig, KNOWN_PROVIDERS, DEFAULT_OMNIROUTE_STYLE } from '../src/services/tts/config.js';
import { criarWavDeTeste } from './helpers/omnirouteFalso.js';

let ok = 0;
let fail = 0;
const failures = [];
async function test(name, fn) {
  try { await fn(); ok++; console.log('  ok  ', name); } catch (e) { fail++; failures.push(name); console.log('  FALHA', name, '\n       ', String(e?.message ?? e).split('\n').slice(0, 4).join('\n        ')); }
}
const section = (t) => console.log(`\n${t}`);

const KEY = 'sk-omni-tts-chave-secreta-0123456789';
const SEGREDO_DE_FALA = 'texto-secreto-da-fala-xyz';
const omniEnv = (over = {}) => ({
  YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'omniroute', label: 'OmniRoute', baseUrl: 'http://127.0.0.1:20128/v1', apiKeyEnv: 'OMNI_TTS_KEY', models: ['free-stack'], anonymous: true }]),
  OMNI_TTS_KEY: KEY,
  ...over,
});
const linhas = () => { const l = []; return { l, info: (m) => l.push(`info ${m}`), warn: (m) => l.push(`warn ${m}`), error: (m) => l.push(`error ${m}`), debug() {} }; };
const WAV = criarWavDeTeste({ ms: 300 });
const resposta = (corpo, { status = 200, type = 'audio/wav' } = {}) => new Response(corpo, { status, headers: type ? { 'Content-Type': type } : {} });

/** fetch falso: `plano(chamada)` devolve a Response (ou lança); sem plano devolve o WAV. */
function mkFetch(plano) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    const c = { url, init, method: init.method, body: init.body ? JSON.parse(init.body) : null };
    calls.push(c);
    if (plano) return plano(c, calls.length);
    return resposta(WAV);
  };
  return { fetchImpl, calls };
}
const cfgDe = (envCfg = {}, over = {}) => ({ ...getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES: '4', ...envCfg }), ...over });
function mk({ cfg = {}, cfgOver = {}, env = omniEnv(), f = mkFetch(), now, log = linhas(), spawn, getFfmpeg } = {}) {
  const p = createOmnirouteProvider({ config: cfgDe(cfg, cfgOver), env, logger: log, fetchImpl: f.fetchImpl, now, spawn, getFfmpeg });
  return { p, f, log };
}
const tentar = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };

// ═══ A. Configuração ═══════════════════════════════════════════════════════════════════════════════════════════
section('A. Configuração (chaves, padrões, ordem)');
await test('padrões: desligado, Leda, modelo do Gemini, teto 400, prazo 10 s, texto sensível NÃO vai', () => {
  const c = getTtsConfig({});
  assert.equal(c.omniroute, false);
  assert.equal(c.omnirouteModel, 'google/gemini-3.8-flash-tts');
  assert.equal(c.omnirouteVoice, 'Leda');
  assert.equal(c.omnirouteStyle, null);
  assert.equal(c.omnirouteSensitive, false);
  assert.equal(c.omnirouteDailyCap, 400);
  assert.equal(c.omnirouteTimeoutMs, 10000);
  assert.ok(KNOWN_PROVIDERS.includes('omniroute'));
});
await test('ordem de reserva: omniroute > azure > edge > sapi (a ordem de hoje não muda sem a chave)', () => {
  assert.deepEqual(getTtsConfig({}).providers, ['sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_CLOUD: 'true' }).providers, ['edge', 'sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_OMNIROUTE: 'true' }).providers, ['omniroute', 'sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_CLOUD: 'true' }).providers, ['omniroute', 'edge', 'sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_CLOUD: 'true', AZURE_SPEECH_KEY: KEY }).providers, ['omniroute', 'azure', 'edge', 'sapi']);
  assert.deepEqual(getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_PROVIDERS: 'sapi' }).providers, ['sapi'], 'a lista escrita vale como está');
  assert.deepEqual(getTtsConfig({ YUI_TTS_PROVIDERS: 'omniroute,azure,edge,sapi' }).providers, ['omniroute', 'azure', 'edge', 'sapi']);
});
await test('chaves: valores inválidos caem no padrão, números ficam nos limites, texto de estilo é limpo', () => {
  const c = getTtsConfig({ YUI_TTS_OMNIROUTE_MODELO: 'x"y', YUI_TTS_OMNIROUTE_VOZ: 'Le da;', YUI_TTS_OMNIROUTE_TETO_DIA: '0', YUI_TTS_OMNIROUTE_TIMEOUT_MS: '1' });
  assert.equal(c.omnirouteModel, 'google/gemini-3.8-flash-tts');
  assert.equal(c.omnirouteVoice, 'Leda');
  assert.equal(c.omnirouteDailyCap, 1);
  assert.equal(c.omnirouteTimeoutMs, 2000);
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_MODELO: 'outra/voz-x', YUI_TTS_OMNIROUTE_VOZ: 'Kore' }).omnirouteModel, 'outra/voz-x');
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_VOZ: 'Kore' }).omnirouteVoice, 'Kore');
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_ESTILO: 'Say it\nwith\tcalm' }).omnirouteStyle, 'Say it with calm');
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_ESTILO: 'nenhum' }).omnirouteStyle, '');
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_ESTILO: 'a'.repeat(500) }).omnirouteStyle.length, 200);
});
await test('as duas chaves booleanas falham FECHADAS: valor estranho = desligado', () => {
  for (const v of ['talvez', 'ligado', 'verdade', '2']) {
    assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE: v }).omniroute, false, v);
    assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_SENSIVEL: v }).omnirouteSensitive, false, v);
  }
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE: 'true' }).omniroute, true);
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_SENSIVEL: 'sim' }).omnirouteSensitive, true);
});
await test('a chave do OmniRoute NUNCA entra no objeto de configuração', () => {
  const c = getTtsConfig({ ...omniEnv(), YUI_TTS_OMNIROUTE: 'true' });
  assert.ok(!JSON.stringify(c).includes(KEY));
});

// ═══ B. Preparação do texto ════════════════════════════════════════════════════════════════════════════════════
section('B. Preparação do texto');
await test('tira Markdown, emoji, links e menções; o texto limpo passa igual', () => {
  assert.equal(prepareOmnirouteText('Oi, tudo bem? Hoje o dia está lindo.').text, 'Oi, tudo bem? Hoje o dia está lindo.');
  assert.equal(prepareOmnirouteText('## Título\n- **Item** um\n- _item_ dois\n1. três').text, 'Título Item um item dois três');
  assert.equal(prepareOmnirouteText('Veja [o guia](https://exemplo.com/x?a=1) e https://outro.com/y ou www.site.com agora').text, 'Veja o guia e ou agora');
  assert.equal(prepareOmnirouteText('Oi <@123456789> e <@!99> do <#555>, <@&7>. @everyone @here @fulano').text, 'Oi e do , .');
  assert.equal(prepareOmnirouteText('Boa! 😀🎉 <:legal:12345> <a:dança:777> Vamos 👍🏽 ❤️').text, 'Boa! Vamos');
  assert.equal(prepareOmnirouteText('use `código` e ```bloco\nlinha\n``` fim').text, 'use código e fim');
  assert.equal(prepareOmnirouteText('<b>negrito</b> <script>x</script> a < b > c').text, 'negrito x a b c');
});
await test('mantém as 4 marcas do Gemini (em qualquer caixa) e descarta qualquer outra etiqueta', () => {
  assert.equal(prepareOmnirouteText('Oi! <short pause> Tudo bem? <LAUGH> Claro. <Long Pause> Fim <sigh>').text, 'Oi! <short pause> Tudo bem? <laugh> Claro. <long pause> Fim <sigh>');
  assert.equal(prepareOmnirouteText('Oi <laughs> <whisper> tchau').text, 'Oi tchau');
  assert.equal(prepareOmnirouteText('Oi! <short pause> Tchau.', { keepMarks: false }).text, 'Oi! Tchau.', 'sem keepMarks as marcas somem (o modelo as leria em voz alta)');
});
await test('só símbolos, só emoji ou só marcas não viram fala', () => {
  for (const t of ['', '   ', '😀😀', '***', '<laugh>', '<short pause> <sigh>', 'https://x.com', '<@123>', null, undefined, 42]) {
    assert.equal(prepareOmnirouteText(t).text, '', String(t));
  }
});
await test(`passou de ${MAX_TEXT_CHARS} caracteres: corta no último fim de frase que cabe; uma frase só maior que o limite não é falada`, () => {
  const frase = 'Esta é uma frase de tamanho médio para encher o texto. ';
  const grande = frase.repeat(20); // ~1100
  const r = prepareOmnirouteText(grande);
  assert.ok(r.cut && r.text.length <= MAX_TEXT_CHARS && r.text.endsWith('texto.'), r.text.slice(-30));
  assert.ok(r.text.length > MAX_TEXT_CHARS - frase.length);
  assert.deepEqual(prepareOmnirouteText('a'.repeat(600)), { text: '', cut: false, tooLong: true });
  assert.deepEqual(prepareOmnirouteText('Oi. ' + 'b'.repeat(600)).text, 'Oi.', 'a 1ª frase cabe: só ela vai');
  assert.equal(prepareOmnirouteText('Vale 3.5 reais e mais ' + 'c'.repeat(600)).tooLong, true, 'o ponto do 3.5 não é fim de frase');
  assert.equal(prepareOmnirouteText('um dois. três.', { maxChars: 9 }).text, 'um dois.');
});
await test('o corte nunca divide uma marca do Gemini', () => {
  const comMarcaDepois = `${'palavra '.repeat(50)}fim. <short pause> ${'outra '.repeat(30)}fim.`;
  const a = prepareOmnirouteText(comMarcaDepois, { maxChars: 410 });
  assert.ok(a.cut && a.text.endsWith('fim.') && !a.text.includes('<'), 'a marca que vem depois do corte some inteira');
  const comMarcaDentro = `Oi <short pause> ${'palavra '.repeat(30)}fim. <laugh> ${'outra '.repeat(80)}fim.`;
  const b = prepareOmnirouteText(comMarcaDentro, { maxChars: 330 });
  assert.ok(b.cut && b.text.startsWith('Oi <short pause> ') && (b.text.match(/</g) || []).length === (b.text.match(/>/g) || []).length, b.text.slice(0, 40));
});
await test('composeInput: o estilo vem antes, com dois-pontos; sem estilo o texto vai puro', () => {
  assert.equal(composeInput('Say it warmly', 'Oi.'), 'Say it warmly: Oi.');
  assert.equal(composeInput('Say it warmly:  ', 'Oi.'), 'Say it warmly: Oi.');
  assert.equal(composeInput('', 'Oi.'), 'Oi.');
  assert.equal(composeInput(undefined, 'Oi.'), 'Oi.');
});

// ═══ C. A chamada e a rota ═════════════════════════════════════════════════════════════════════════════════════
section('C. A chamada: corpo exato, chave só no cabeçalho, rota do provedor da IA');
await test('corpo EXATO: model, input (estilo + texto), voice e response_format wav; endereço = o da IA com /audio/speech', async () => {
  const { p, f } = mk();
  const r = await p.synth('Oi, Yui!', { sensitive: false });
  assert.equal(f.calls.length, 1);
  const c = f.calls[0];
  assert.equal(c.url, 'http://127.0.0.1:20128/v1/audio/speech');
  assert.deepEqual(Object.keys(c.body), ['model', 'input', 'voice', 'response_format']);
  assert.deepEqual(c.body, { model: 'google/gemini-3.8-flash-tts', input: `${DEFAULT_OMNIROUTE_STYLE}: Oi, Yui!`, voice: 'Leda', response_format: 'wav' });
  assert.equal(c.init.method, 'POST');
  assert.equal(c.init.headers['Content-Type'], 'application/json');
  assert.equal(c.init.redirect, 'error', 'o redirecionamento é recusado (a chave não segue para outro lugar)');
  assert.deepEqual([r.sampleRate, r.channels, r.pcm.length > 0], [24000, 1, true]);
  assert.equal(p.local, false);
});
await test('a chave vai SÓ no cabeçalho Bearer: nunca na URL nem no corpo; sem chave (provedor anônimo sem chave) não há Authorization', async () => {
  const { p, f } = mk();
  await p.synth('Oi.');
  const c = f.calls[0];
  assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
  assert.ok(!c.url.includes(KEY) && !c.init.body.includes(KEY));
  const semChave = mk({ env: { YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'omniroute', baseUrl: 'http://127.0.0.1:20128/v1', models: ['m'], anonymous: true }]) } });
  await semChave.p.synth('Oi.');
  assert.equal(semChave.f.calls[0].init.headers.Authorization, undefined);
});
await test('com várias chaves usa a primeira (a mesma ordem do cadastro da IA)', async () => {
  const { p, f } = mk({ env: omniEnv({ OMNI_TTS_KEY: `${KEY}-A,${KEY}-B` }) });
  await p.synth('Oi.');
  assert.equal(f.calls[0].init.headers.Authorization, `Bearer ${KEY}-A`);
});
await test('rota: vem do provedor "omniroute" da IA; sem ele, desligado no Gateway, com endereço estranho ou sem chave (não anônimo) = indisponível', () => {
  assert.deepEqual(resolveOmnirouteRoute(omniEnv()), { ok: true, url: 'http://127.0.0.1:20128/v1/audio/speech', key: KEY });
  assert.equal(resolveOmnirouteRoute({}).ok, false);
  assert.equal(resolveOmnirouteRoute({ YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'outro', baseUrl: 'http://x/v1', models: ['m'], anonymous: true }]) }).ok, false);
  assert.equal(resolveOmnirouteRoute(omniEnv({ YUI_GATEWAY_DISABLE: 'omniroute' })).ok, false, 'desligado no Gateway: a fala também não usa');
  assert.equal(resolveOmnirouteRoute({ YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'omniroute', endpoint: 'http://x/v1/outra-coisa', models: ['m'], anonymous: true }]) }).ok, false);
  assert.equal(resolveOmnirouteRoute({ YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'omniroute', baseUrl: 'http://x/v1', apiKeyEnv: 'NADA', models: ['m'] }]) }).ok, false);
  assert.equal(resolveOmnirouteRoute({ YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'omniroute', endpoint: 'https://omni.exemplo.com/v1/chat/completions/', models: ['m'], anonymous: true }]) }).url, 'https://omni.exemplo.com/v1/audio/speech');
  assert.equal(resolveOmnirouteRoute({ YUI_GATEWAY_CUSTOM: 'isto não é json' }).ok, false);
});
await test('a rota é relida a cada fala: o painel muda a chave sem reiniciar', async () => {
  const env = omniEnv();
  const { p, f } = mk({ env });
  await p.synth('Um.');
  env.OMNI_TTS_KEY = `${KEY}-NOVA`;
  await p.synth('Dois.');
  assert.deepEqual(f.calls.map((c) => c.init.headers.Authorization), [`Bearer ${KEY}`, `Bearer ${KEY}-NOVA`]);
  delete env.YUI_GATEWAY_CUSTOM;
  assert.equal(p.gate.enabled(), false, 'sem o provedor da IA a porta fecha');
  const e = await tentar(() => p.synth('Três.'));
  assert.equal(e.code, 'OMNIROUTE_CONFIG');
});
await test('sonda sem rede: desligado = indisponível; ligado = disponível (a rota é conferida a cada fala)', async () => {
  assert.equal((await mk({ cfg: {}, cfgOver: { omniroute: false } }).p.probe()).ok, false);
  const pr = await mk().p.probe();
  assert.ok(pr.ok && !pr.detail.includes(KEY) && !pr.detail.includes('127.0.0.1'));
});

// ═══ D. Falhas ═════════════════════════════════════════════════════════════════════════════════════════════════
section('D. Falhas: um código, nenhum segredo (chave, texto, endereço) nem em erro nem em log');
const CASOS = [
  ['401', () => resposta('{"error":"x"}', { status: 401, type: 'application/json' }), 'OMNIROUTE_AUTH', 401],
  ['403', () => resposta('{}', { status: 403, type: 'application/json' }), 'OMNIROUTE_AUTH', 403],
  ['429', () => resposta('{}', { status: 429, type: 'application/json' }), 'OMNIROUTE_RATE', 429],
  ['500', () => resposta('{}', { status: 500, type: 'application/json' }), 'OMNIROUTE_HTTP', 500],
  ['503', () => resposta('{}', { status: 503, type: 'application/json' }), 'OMNIROUTE_HTTP', 503],
  ['rede caiu', () => { throw new Error(`ECONNRESET ${KEY} 127.0.0.1 ${SEGREDO_DE_FALA}`); }, 'OMNIROUTE_NETWORK', null],
  ['corpo vazio', () => resposta(Buffer.alloc(0)), 'OMNIROUTE_EMPTY', 200],
  ['WAV inválido', () => resposta('isto não é um wav de jeito nenhum'), 'OMNIROUTE_BAD_AUDIO', 200],
  ['JSON no lugar do áudio', () => resposta('{"ok":true}', { type: 'application/json' }), 'OMNIROUTE_BAD_AUDIO', 200],
  ['cabeçalho RIFF sem dados', () => resposta(Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE')])), 'OMNIROUTE_BAD_AUDIO', 200],
  ['WAV sem amostras', () => resposta(criarWavDeTeste({ ms: 0 })), 'OMNIROUTE_EMPTY', 200],
  ['WAV mudo', () => resposta(criarWavDeTeste({ ms: 300, silencio: true })), 'OMNIROUTE_SILENT', 200],
  ['formato desconhecido', () => resposta(Buffer.alloc(100, 7), { type: 'audio/ogg' }), 'OMNIROUTE_BAD_AUDIO', 200],
];
for (const [nome, mkResp, codigo, status] of CASOS.filter((c) => c[2])) {
  await test(`falha "${nome}" -> ${codigo}, sem vazar a chave, o texto nem o endereço`, async () => {
    const log = linhas();
    const { p } = mk({ f: mkFetch(mkResp), log });
    const e = await tentar(() => p.synth(SEGREDO_DE_FALA, { sensitive: false }));
    assert.equal(e?.code, codigo);
    const tudo = `${e.message} ${e.stack} ${log.l.join('\n')}`;
    for (const proibido of [KEY, SEGREDO_DE_FALA, '127.0.0.1', 'Bearer']) assert.ok(!tudo.includes(proibido), `vazou "${proibido}"`);
    assert.equal(log.l.filter((l) => l.startsWith('warn')).length, 1, 'UMA linha de log por falha');
    assert.ok(log.l.some((l) => l.includes(`codigo=${codigo}`) && l.includes(`status=${status ?? '-'}`)), log.l.join('|'));
    assert.ok(/ms=\d+/.test(log.l.at(-1)), 'a latência da falha (só número)');
  });
}
await test('UMA tentativa só: uma falha não repete a chamada', async () => {
  const f = mkFetch(() => resposta('{}', { status: 500, type: 'application/json' }));
  const { p } = mk({ f });
  await tentar(() => p.synth('Oi.'));
  assert.equal(f.calls.length, 1);
});
await test('lento demais: o prazo estoura com OMNIROUTE_TIMEOUT e a chamada é cancelada', async () => {
  let cancelada = false;
  const f = mkFetch(async (c) => { await new Promise((_, rej) => c.init.signal.addEventListener('abort', () => { cancelada = true; rej(new Error('abort')); })); });
  const { p } = mk({ f, cfgOver: { omnirouteTimeoutMs: 150 } });
  // guarda: se o prazo não cortar a chamada, o teste FALHA em vez de ficar pendurado
  let guarda;
  const semPrazo = new Promise((resolve) => { guarda = setTimeout(() => resolve(Object.assign(new Error('o prazo não cortou a chamada lenta'), { code: 'SEM_PRAZO' })), 3000); });
  const e = await Promise.race([tentar(() => p.synth('Oi.')), semPrazo]);
  clearTimeout(guarda);
  assert.equal(e?.code, 'OMNIROUTE_TIMEOUT');
  assert.ok(cancelada);
});
await test('o motor cancela (abort): ABORTED, sem contar como falha do provedor e sem linha de falha', async () => {
  const log = linhas();
  const f = mkFetch(async (c) => { await new Promise((_, rej) => c.init.signal.addEventListener('abort', () => rej(new Error('abort')))); });
  const { p } = mk({ f, log });
  const ctl = new AbortController();
  const prom = p.synth('Oi.', { signal: ctl.signal });
  setImmediate(() => ctl.abort());
  const e = await tentar(() => prom);
  assert.equal(e?.code, 'ABORTED');
  assert.ok(!log.l.some((l) => l.includes('falha')));
  assert.equal(p.getUsage().fail, 0);
  const ja = new AbortController(); ja.abort();
  assert.equal((await tentar(() => p.synth('Oi.', { signal: ja.signal })))?.code, 'ABORTED');
});
await test('corpo gigante anunciado ou real vira OMNIROUTE_TOO_BIG', async () => {
  const grande = new Response(Buffer.alloc(10), { status: 200, headers: { 'Content-Type': 'audio/wav', 'Content-Length': String(9 * 1024 * 1024) } });
  assert.equal((await tentar(() => mk({ f: mkFetch(() => grande) }).p.synth('Oi.')))?.code, 'OMNIROUTE_TOO_BIG');
  const real = mk({ f: mkFetch(() => resposta(criarWavDeTeste({ ms: 200_000 }))) });
  assert.equal((await tentar(() => real.p.synth('Oi.')))?.code, 'OMNIROUTE_TOO_BIG');
});
await test('texto sem nada legível ou longo demais nem chega à rede', async () => {
  const f = mkFetch();
  const { p } = mk({ f });
  assert.equal((await tentar(() => p.synth('😀 <@123>')))?.code, 'OMNIROUTE_EMPTY');
  assert.equal((await tentar(() => p.synth('x'.repeat(700))))?.code, 'OMNIROUTE_TOO_LONG');
  assert.equal(f.calls.length, 0);
  assert.equal(p.getUsage().used, 0, 'e não gasta o teto');
});

// ═══ E. Teto diário ═══════════════════════════════════════════════════════════════════════════════════════════
section('E. Teto diário de falas');
await test('passado o teto a porta fecha (o motor segue para o próximo) até o dia seguinte; falhas também contam; cache não conta', async () => {
  let t = new Date(2026, 10, 18, 10, 0, 0).getTime();
  const log = linhas();
  const f = mkFetch((c, n) => (n === 2 ? resposta('{}', { status: 500, type: 'application/json' }) : resposta(WAV)));
  const { p } = mk({ f, now: () => t, log, cfgOver: { omnirouteDailyCap: 3 } });
  assert.equal(p.gate.enabled(), true);
  await p.synth('Um.', { sensitive: false });
  await tentar(() => p.synth('Dois.', { sensitive: false })); // 500: gastou uma
  await p.synth('Um.', { sensitive: false }); // cache: não gasta
  assert.equal(p.getUsage().used, 2);
  await p.synth('Três.', { sensitive: false });
  assert.equal(p.getUsage().used, 3);
  assert.equal(p.gate.enabled(), false, 'teto atingido: indisponível');
  assert.ok(log.l.some((l) => l.includes('teto diário de 3 falas atingido')));
  const e = await tentar(() => p.synth('Quatro.', { sensitive: false }));
  assert.equal(e?.code, 'OMNIROUTE_TETO');
  assert.equal(f.calls.length, 3, 'a 4ª nem saiu');
  await p.synth('Um.', { sensitive: false }); // o cache ainda atende
  t = new Date(2026, 10, 19, 0, 0, 5).getTime();
  assert.equal(p.gate.enabled(), true, 'virou o dia: volta');
  await p.synth('Quatro.', { sensitive: false });
  assert.equal(p.getUsage().used, 1);
});
await test('o teto não deixa passar uma chamada além dele nem em rajada', async () => {
  const f = mkFetch();
  const { p } = mk({ f, cfgOver: { omnirouteDailyCap: 5 } });
  const res = await Promise.allSettled(Array.from({ length: 12 }, (_, i) => p.synth(`Fala número ${i}.`, { sensitive: false })));
  assert.equal(res.filter((r) => r.status === 'fulfilled').length, 5);
  assert.equal(f.calls.length, 5);
});

// ═══ F. Cache ═════════════════════════════════════════════════════════════════════════════════════════════════
section('F. Cache de RAM das falas repetidas');
await test('a mesma fala (texto + voz + modelo + estilo) não vai à rede de novo; mudar qualquer um dos três vai', async () => {
  const f = mkFetch();
  const base = mk({ f });
  await base.p.synth('Oi, tudo bem?', { sensitive: false });
  await base.p.synth('Oi, tudo bem?', { sensitive: false });
  assert.equal(f.calls.length, 1);
  assert.deepEqual([base.p.getUsage().cacheHits, base.p.getUsage().cacheMisses, base.p.getUsage().cacheEntries], [1, 1, 1]);
  assert.ok(base.log.l.some((l) => l.includes('cache') && !l.includes('cache=nao')));
  // outra voz / modelo / estilo = outro provedor (cada um com o seu cache): a fala sai de novo
  for (const over of [{ omnirouteVoice: 'Kore' }, { omnirouteModel: 'google/gemini-3.1-flash-tts-preview' }, { omnirouteStyle: 'Say it calmly' }]) {
    const n = f.calls.length;
    const outro = mk({ f, cfgOver: over });
    await outro.p.synth('Oi, tudo bem?', { sensitive: false });
    assert.equal(f.calls.length, n + 1, JSON.stringify(over));
  }
  assert.equal(f.calls.at(-1).body.input, 'Say it calmly: Oi, tudo bem?');
});
await test('o texto sensível (ou sem a marca) NUNCA entra no cache nem sai dele', async () => {
  const f = mkFetch();
  const { p } = mk({ f });
  await p.synth('Segredo pessoal.', { sensitive: true });
  await p.synth('Segredo pessoal.', { sensitive: true });
  await p.synth('Segredo pessoal.');
  assert.equal(f.calls.length, 3);
  assert.equal(p.getUsage().cacheEntries, 0);
  await p.synth('Segredo pessoal.', { sensitive: false });
  await p.synth('Segredo pessoal.', { sensitive: true });
  assert.equal(f.calls.length, 5, 'a fala pública guardada não serve a quem pede como sensível');
});
await test('validade curta (10 min) e poucas dezenas de entradas (40): a mais antiga sai primeiro', async () => {
  let t = 1_000_000;
  const f = mkFetch();
  const { p } = mk({ f, now: () => t, cfgOver: { omnirouteDailyCap: 1000 } });
  await p.synth('Hoje faz sol.', { sensitive: false });
  t += 9 * 60_000;
  await p.synth('Hoje faz sol.', { sensitive: false });
  assert.equal(f.calls.length, 1);
  t += 2 * 60_000; // 11 min depois da gravação
  await p.synth('Hoje faz sol.', { sensitive: false });
  assert.equal(f.calls.length, 2, 'passou da validade');
  for (let i = 0; i < 45; i++) await p.synth(`Fala diferente número ${i}.`, { sensitive: false });
  assert.ok(p.getUsage().cacheEntries <= 40, `entradas: ${p.getUsage().cacheEntries}`);
  const n = f.calls.length;
  await p.synth('Fala diferente número 44.', { sensitive: false });
  assert.equal(f.calls.length, n, 'a mais recente continua');
  await p.synth('Fala diferente número 0.', { sensitive: false });
  assert.equal(f.calls.length, n + 1, 'a mais antiga já saiu');
});
await test('dispose esvazia o cache', async () => {
  const { p } = mk();
  await p.synth('Oi.', { sensitive: false });
  assert.equal(p.getUsage().cacheEntries, 1);
  await p.dispose();
  assert.equal(p.getUsage().cacheEntries, 0);
});
await test('a latência é medida e logada (só números)', async () => {
  let t = 5_000;
  const log = linhas();
  const f = mkFetch(async () => { t += 730; return resposta(WAV); });
  const { p } = mk({ f, now: () => t, log });
  await p.synth('Oi, tudo bem?', { sensitive: false });
  const linha = log.l.find((l) => l.includes('ms_total='));
  assert.ok(linha && /ms_rede=730 ms_total=730/.test(linha), linha);
  assert.ok(!linha.includes('Oi, tudo bem'), 'sem o texto');
  assert.deepEqual([p.getUsage().lastMs, p.getUsage().avgMs, p.getUsage().maxMs], [730, 730, 730]);
});

// ═══ G. Estilo e modelo ═══════════════════════════════════════════════════════════════════════════════════════
section('G. Estilo e marcas dependem do modelo (nada presume o prefixo google/)');
await test('modelo do Gemini: estilo padrão + marcas mantidas; estilo próprio substitui o padrão; "nenhum" manda o texto puro', async () => {
  const f = mkFetch();
  await mk({ f }).p.synth('Oi! <short pause> Tudo bem? <laugh>');
  assert.equal(f.calls[0].body.input, `${DEFAULT_OMNIROUTE_STYLE}: Oi! <short pause> Tudo bem? <laugh>`);
  await mk({ f, cfgOver: { omnirouteStyle: 'Say it softly' } }).p.synth('Oi.');
  assert.equal(f.calls[1].body.input, 'Say it softly: Oi.');
  await mk({ f, cfgOver: { omnirouteStyle: '' } }).p.synth('Oi! <sigh> Ufa.');
  assert.equal(f.calls[2].body.input, 'Oi! <sigh> Ufa.', 'sem estilo e modelo Gemini: as marcas continuam');
});
await test('outro modelo, sem estilo definido: texto PURO (sem estilo em inglês e sem as marcas); com estilo definido, as duas coisas valem', async () => {
  const f = mkFetch();
  await mk({ f, cfgOver: { omnirouteModel: 'outro/voz-x', omnirouteVoice: 'pt_BR-faber' } }).p.synth('Oi! <short pause> Tudo bem?');
  assert.deepEqual(f.calls[0].body, { model: 'outro/voz-x', input: 'Oi! Tudo bem?', voice: 'pt_BR-faber', response_format: 'wav' });
  await mk({ f, cfgOver: { omnirouteModel: 'outro/voz-x', omnirouteStyle: 'Calmly' } }).p.synth('Oi! <short pause> Tudo bem?');
  assert.equal(f.calls[1].body.input, 'Calmly: Oi! <short pause> Tudo bem?');
  await mk({ f, cfgOver: { omnirouteModel: 'outro/voz-x', omnirouteStyle: '' } }).p.synth('Oi! <short pause> Tudo bem?');
  assert.equal(f.calls[2].body.input, 'Oi! Tudo bem?');
});
await test('a voz e o modelo só são repassados (e inválidos caem no padrão: nunca um valor perigoso no corpo)', async () => {
  const f = mkFetch();
  await mk({ f, cfgOver: { omnirouteVoice: 'Kore', omnirouteModel: 'google/gemini-3.1-flash-tts-preview' } }).p.synth('Oi.');
  assert.deepEqual([f.calls[0].body.voice, f.calls[0].body.model], ['Kore', 'google/gemini-3.1-flash-tts-preview']);
  await mk({ f, cfgOver: { omnirouteVoice: 'x"}], "extra":1', omnirouteModel: 'm"; drop' } }).p.synth('Oi.');
  assert.deepEqual([f.calls[1].body.voice, f.calls[1].body.model], ['Leda', 'google/gemini-3.8-flash-tts']);
  assert.deepEqual(Object.keys(f.calls[1].body), ['model', 'input', 'voice', 'response_format']);
});

// ═══ H. MP3 ═══════════════════════════════════════════════════════════════════════════════════════════════════
section('H. Formato do áudio: WAV ou MP3, pelo Content-Type');
function fakeSpawn({ pcm = criarWavDeTeste({ ms: 300 }).subarray(44), code = 0, enoent = false } = {}) {
  const seen = [];
  const spawn = (file, args, opts) => {
    seen.push({ file, args, opts });
    if (enoent) throw Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => { child.killed = true; };
    child.stdin.on('finish', () => setImmediate(() => { if (code === 0) child.stdout.write(pcm); child.stdout.end(); child.emit('close', code); }));
    return child;
  };
  return { spawn, seen };
}
await test('detecta pelo Content-Type e, sem ele (ou genérico), pelos primeiros bytes', () => {
  assert.equal(detectAudioFormat('audio/wav', Buffer.from('x')), 'wav');
  assert.equal(detectAudioFormat('audio/x-wav; charset=binary', Buffer.from('x')), 'wav');
  assert.equal(detectAudioFormat('audio/mpeg', Buffer.from('x')), 'mp3');
  assert.equal(detectAudioFormat('audio/mp3', Buffer.from('x')), 'mp3');
  assert.equal(detectAudioFormat('', WAV), 'wav');
  assert.equal(detectAudioFormat('application/octet-stream', Buffer.from('ID3abc')), 'mp3');
  assert.equal(detectAudioFormat(null, Buffer.from([0xff, 0xfb, 0x90, 0x00])), 'mp3');
  assert.equal(detectAudioFormat('application/json', WAV), null, 'JSON não é áudio, mesmo com bytes de WAV');
  assert.equal(detectAudioFormat('text/html', Buffer.from('<html>')), null);
  assert.equal(detectAudioFormat('', Buffer.from('lixo qualquer aqui')), null);
});
await test('MP3: o ffmpeg converte para PCM de 24 kHz mono (spawn com array, ambiente mínimo, sem shell)', async () => {
  const sp = fakeSpawn();
  const f = mkFetch(() => resposta(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 1)]), { type: 'audio/mpeg' }));
  const { p, log } = mk({ f, spawn: sp.spawn, getFfmpeg: () => 'ffmpeg-falso' });
  const r = await p.synth('Oi.');
  assert.deepEqual([r.sampleRate, r.channels, r.pcm.length > 0], [24000, 1, true]);
  assert.equal(sp.seen.length, 1);
  assert.equal(sp.seen[0].file, 'ffmpeg-falso');
  assert.ok(Array.isArray(sp.seen[0].args) && sp.seen[0].args.includes('pcm_s16le') && sp.seen[0].args.includes('24000'));
  assert.ok(!sp.seen[0].opts.shell && Object.keys(sp.seen[0].opts.env).length <= 2, 'sem shell e com ambiente mínimo');
  assert.ok(log.l.some((l) => l.includes('formato=mp3')));
});
await test('MP3: ffmpeg ausente, que falha ou que devolve nada = OMNIROUTE_FFMPEG; WAV nunca passa pelo ffmpeg', async () => {
  const mp3 = () => resposta(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 1)]), { type: 'audio/mpeg' });
  for (const sp of [fakeSpawn({ enoent: true }), fakeSpawn({ code: 1 }), fakeSpawn({ pcm: Buffer.alloc(0) })]) {
    const { p } = mk({ f: mkFetch(mp3), spawn: sp.spawn, getFfmpeg: () => 'ffmpeg-falso' });
    assert.equal((await tentar(() => p.synth('Oi.')))?.code, 'OMNIROUTE_FFMPEG');
  }
  const semProgram = mk({ f: mkFetch(mp3), getFfmpeg: () => { throw new Error('sem ffmpeg'); } });
  assert.equal((await tentar(() => semProgram.p.synth('Oi.')))?.code, 'OMNIROUTE_FFMPEG');
  const sp = fakeSpawn();
  await mk({ spawn: sp.spawn }).p.synth('Oi.');
  assert.equal(sp.seen.length, 0, 'o WAV é lido em JS, sem processo');
});
await test('WAV com Content-Type de WAV mas bytes de outra coisa NÃO é aceito (o WAV precisa ser válido)', async () => {
  const { p } = mk({ f: mkFetch(() => resposta(Buffer.concat([Buffer.from('ID3'), Buffer.alloc(100, 1)]), { type: 'audio/wav' })) });
  assert.equal((await tentar(() => p.synth('Oi.')))?.code, 'OMNIROUTE_BAD_AUDIO');
});

// ═══ I. No motor: ordem, reserva e porta de privacidade ═══════════════════════════════════════════════════════
section('I. No motor: ordem de reserva e porta de privacidade');
const quieto = { info() {}, warn() {}, error() {}, debug() {} };
/** Um provedor que anota o que recebeu (o texto fica só no teste). */
function espiao(prov) {
  const vistos = [];
  const synth = prov.synth.bind(prov);
  return Object.assign(prov, { vistos, synth: async (text, o) => { vistos.push({ text, sensitive: o?.sensitive }); return synth(text, o); } });
}
function montar({ cfgEnv = {}, cfgOver = {}, f = mkFetch(), env = omniEnv(), nuvem = true, log = quieto } = {}) {
  const config = { ...getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_CLOUD: nuvem ? 'true' : 'false', AZURE_SPEECH_KEY: KEY, YUI_TTS_PROVIDERS: 'omniroute,azure,edge,sapi', ...cfgEnv }), ...cfgOver };
  const omni = espiao(createOmnirouteProvider({ config, env, logger: log, fetchImpl: f.fetchImpl }));
  const azure = espiao(createFakeProvider({ name: 'azure', local: false }));
  const edge = espiao(createFakeProvider({ name: 'edge', local: false }));
  const sapi = espiao(createFakeProvider({ name: 'sapi', local: true }));
  const engine = createEngine({ providers: [omni, azure, edge, sapi], config, logger: log, env });
  return { engine, omni, azure, edge, sapi, f, config };
}
await test('texto público com o OmniRoute ligado: ele fala primeiro e as reservas nem são tocadas', async () => {
  const m = montar();
  const r = await m.engine.synthesize('Oi, tudo bem?', { sensitive: false });
  assert.equal(r?.provider, 'omniroute');
  assert.deepEqual([m.azure.vistos.length, m.edge.vistos.length, m.sapi.vistos.length], [0, 0, 0]);
  assert.deepEqual(m.engine.selectChain({ sensitive: false }).map((p) => p.name), ['omniroute', 'azure', 'edge', 'sapi']);
});
await test('cada falha cai no PRÓXIMO da ordem (azure, depois edge, depois sapi), sem erro para a pessoa', async () => {
  for (const [nome, mkResp] of CASOS.filter((c) => c[2]).map((c) => [c[0], c[1]])) {
    const m = montar({ f: mkFetch(mkResp) });
    const r = await m.engine.synthesize('Oi, tudo bem?', { sensitive: false });
    assert.equal(r?.provider, 'azure', `${nome}: o azure assume`);
    assert.equal(m.omni.vistos.length, 1, `${nome}: o omniroute tentou uma vez`);
    assert.equal(m.edge.vistos.length + m.sapi.vistos.length, 0);
  }
  const m = montar({ f: mkFetch(() => resposta('{}', { status: 500, type: 'application/json' })) });
  m.azure.setMode('fail');
  assert.equal((await m.engine.synthesize('Oi, tudo bem?', { sensitive: false }))?.provider, 'edge');
  m.edge.setMode('fail');
  assert.equal((await m.engine.synthesize('Oi, tudo bem?', { sensitive: false }))?.provider, 'sapi');
});
await test('lento demais cai no próximo; o motor não fica esperando além do prazo', async () => {
  const f = mkFetch(async (c) => { await new Promise((_, rej) => c.init.signal.addEventListener('abort', () => rej(new Error('abort')))); });
  const m = montar({ f, cfgOver: { omnirouteTimeoutMs: 200, omnirouteColdTimeoutMs: 200 } });
  const t0 = Date.now();
  const r = await m.engine.synthesize('Oi, tudo bem?', { sensitive: false });
  assert.equal(r?.provider, 'azure');
  assert.ok(Date.now() - t0 < 1500);
  assert.equal(m.engine.getStatus().providers.find((p) => p.name === 'omniroute').lastError, 'OMNIROUTE_TIMEOUT', 'quem estourou foi o prazo do provedor (o motor só conta)');
});
await test('desligado (YUI_TTS_OMNIROUTE=false): nunca é chamado, mesmo estando na ordem; as reservas seguem', async () => {
  const m = montar({ cfgEnv: { YUI_TTS_OMNIROUTE: 'false' } });
  assert.deepEqual(m.engine.selectChain({ sensitive: false }).map((p) => p.name), ['azure', 'edge', 'sapi']);
  const r = await m.engine.synthesize('Oi, tudo bem?', { sensitive: false });
  assert.equal(r?.provider, 'azure');
  assert.equal(m.omni.vistos.length, 0);
  assert.equal(m.f.calls.length, 0);
  const sondas = await m.engine.probeAll();
  const s = sondas.find((p) => p.name === 'omniroute');
  assert.ok(s.skipped && !s.ok);
});
await test('sem YUI_TTS_CLOUD o OmniRoute segue valendo (a chave dele é a própria porta); o azure e o edge continuam barrados', async () => {
  const m = montar({ nuvem: false });
  assert.deepEqual(m.engine.selectChain({ sensitive: false }).map((p) => p.name), ['omniroute', 'sapi']);
  assert.equal((await m.engine.synthesize('Oi, tudo bem?', { sensitive: false }))?.provider, 'omniroute');
  const sondas = await m.engine.probeAll();
  assert.equal(sondas.find((p) => p.name === 'omniroute').ok, true);
  assert.equal(sondas.find((p) => p.name === 'azure').skipped, true);
});
await test('sem o provedor "omniroute" cadastrado na IA o provedor de fala se declara indisponível e a ordem segue', async () => {
  const m = montar({ env: {} });
  assert.deepEqual(m.engine.selectChain({ sensitive: false }).map((p) => p.name), ['azure', 'edge', 'sapi']);
  assert.equal((await m.engine.synthesize('Oi, tudo bem?', { sensitive: false }))?.provider, 'azure');
  assert.equal(m.omni.vistos.length, 0);
});
await test('TEXTO SENSÍVEL com YUI_TTS_OMNIROUTE_SENSIVEL=false (padrão): NUNCA vai ao OmniRoute e cai no provedor local', async () => {
  const m = montar();
  for (const opts of [{ sensitive: true }, {}, { sensitive: undefined }, { sensitive: null }, { sensitive: 0 }, { sensitive: 'false' }]) {
    const r = await m.engine.synthesize('Resposta com memória pessoal.', opts);
    assert.equal(r?.provider, 'sapi', JSON.stringify(opts));
  }
  assert.equal(m.omni.vistos.length, 0);
  assert.equal(m.f.calls.length, 0, 'nenhuma chamada saiu');
  assert.deepEqual(m.engine.selectChain({ sensitive: true }).map((p) => p.name), ['sapi']);
});
await test('TEXTO SENSÍVEL com YUI_TTS_OMNIROUTE_SENSIVEL=true: vai ao OmniRoute (e só ao OmniRoute: as outras nuvens seguem barradas); sem cache', async () => {
  const m = montar({ cfgEnv: { YUI_TTS_OMNIROUTE_SENSIVEL: 'true' } });
  assert.deepEqual(m.engine.selectChain({ sensitive: true }).map((p) => p.name), ['omniroute', 'sapi'], 'azure e edge continuam só para texto público');
  const r = await m.engine.synthesize('Resposta com memória pessoal.', { sensitive: true });
  assert.equal(r?.provider, 'omniroute');
  assert.equal(m.f.calls.length, 1);
  assert.equal(m.omni.vistos[0].sensitive, true);
  await m.engine.synthesize('Resposta com memória pessoal.', { sensitive: true });
  assert.equal(m.f.calls.length, 2, 'o sensível não é guardado no cache');
  // e se o OmniRoute falhar, o sensível cai SÓ no provedor local (nunca no azure/edge)
  const f = mkFetch(() => resposta('{}', { status: 500, type: 'application/json' }));
  const n = montar({ cfgEnv: { YUI_TTS_OMNIROUTE_SENSIVEL: 'true' }, f });
  assert.equal((await n.engine.synthesize('Resposta com memória pessoal.', { sensitive: true }))?.provider, 'sapi');
  assert.equal(n.azure.vistos.length + n.edge.vistos.length, 0);
});
await test('teto estourado: o motor passa ao próximo provedor sem registrar falha nem abrir o disjuntor', async () => {
  const m = montar({ cfgOver: { omnirouteDailyCap: 2 } });
  assert.equal((await m.engine.synthesize('Primeira fala.', { sensitive: false }))?.provider, 'omniroute');
  assert.equal((await m.engine.synthesize('Segunda fala.', { sensitive: false }))?.provider, 'omniroute');
  assert.deepEqual(m.engine.selectChain({ sensitive: false }).map((p) => p.name), ['azure', 'edge', 'sapi']);
  for (let i = 0; i < 6; i++) assert.equal((await m.engine.synthesize(`Fala ${i} depois do teto.`, { sensitive: false }))?.provider, 'azure');
  assert.equal(m.f.calls.length, 2);
  const st = m.engine.getStatus().providers.find((p) => p.name === 'omniroute');
  assert.equal(st.failures, 0);
  assert.equal(st.breaker.state, 'closed');
});
await test('três falhas seguidas abrem o disjuntor da nuvem e o OmniRoute deixa de ser tentado por um tempo', async () => {
  const f = mkFetch(() => resposta('{}', { status: 500, type: 'application/json' }));
  const m = montar({ f });
  for (let i = 0; i < 3; i++) await m.engine.synthesize(`Fala ${i}.`, { sensitive: false });
  const n = f.calls.length;
  assert.equal(n, 3);
  await m.engine.synthesize('Mais uma.', { sensitive: false });
  assert.equal(f.calls.length, n, 'disjuntor aberto: nem tentou');
});
await test('o motor entrega ao provedor só texto já saneado e o marcador de sensibilidade', async () => {
  const m = montar();
  await m.engine.synthesize('Oi {chaves} [colchetes] @alguem tudo bem?', { sensitive: false });
  assert.equal(m.omni.vistos[0].sensitive, false);
  assert.ok(!/[{}[\]@]/.test(m.omni.vistos[0].text));
});

// ═══ J. Cadeia no motor: a rota privada da IA não é tocada ════════════════════════════════════════════════════
section('J. Contrato de provedor');
await test('o provedor cumpre o contrato (name, local, gate, probe, warmup, synth, dispose, getUsage) e não faz nada ao ser criado', async () => {
  const f = mkFetch();
  const p = createOmnirouteProvider({ config: getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES: '4' }), env: omniEnv(), logger: quieto, fetchImpl: f.fetchImpl });
  assert.deepEqual([p.name, p.local, typeof p.gate.enabled, typeof p.gate.allowsSensitive], ['omniroute', false, 'function', 'function']);
  for (const fn of ['probe', 'warmup', 'synth', 'dispose', 'getUsage']) assert.equal(typeof p[fn], 'function', fn);
  assert.equal(f.calls.length, 0);
  assert.equal(p.gate.allowsSensitive(), false);
  assert.equal(createOmnirouteProvider({ config: getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_OMNIROUTE_SENSIVEL: 'true' }), env: omniEnv(), fetchImpl: f.fetchImpl }).gate.allowsSensitive(), true);
  await p.warmup();
  assert.equal(f.calls.filter((c) => c.method === 'POST').length, 0, 'o aquecimento não fala nada');
  assert.equal(f.calls.length, 1, 'só um toque leve (GET /models)');
  assert.equal(p.getUsage().used, 0, 'o aquecimento não gasta cota');
  for (const fn of ['isWarm', 'keepWarm']) assert.equal(typeof p[fn], 'function', fn);
});

// ═══ K. Segredos nunca vão à síntese; a exceção da fala sensível fica registrada ═══════════════════════════════════
section('K. Segredos (chave, token, senha) nunca vão à síntese; a exceção da fala sensível fica registrada');
const discordToken = `MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.${'abcdefghij'.repeat(3)}`; // o formato de um token de bot do Discord (montado aqui, nada real)
const SEGREDOS = [
  ['chave de API sk-', 'minha chave é sk-proj-abcdefghijklmnopqrstuvwx1234'],
  ['chave de API do Google (AIza)', 'use AIzaSyA1B2C3D4E5F6G7H8I9J0K1L2M3N4O5P6Q'],
  ['chave de API do Groq (gsk_)', 'a chave gsk_abcdefghijklmnop1234567890 serve'],
  ['chave de API do Hugging Face (hf_)', 'token hf_abcdefghijklmnopqrstuvwxyz'],
  ['token de bot do Discord', `o token do bot é ${discordToken}`],
  ['cabeçalho Bearer', 'Authorization: Bearer abcdef1234567890xyz'],
  ['Bearer solto', 'manda Bearer eyJhbGciOiJIUzI1NiJ9 no cabeçalho'],
  ['hexadecimal longo', 'o hash é a3f9c2e1b7d84a0f9c3e5d7b1a2c4e6f e pronto'],
  ['hexadecimal longo sem dígito algum no meio', 'chave abcdefabcdefabcdefabcdefabcdef fim'],
  ['chave na URL (?key=)', 'abra https://exemplo.com/x?key=abcdef123456 agora'],
  ['atribuição api_key =', 'defina api_key = 98765432 no arquivo'],
  ['atribuição token:', 'token: zx81qw92 e depois'],
  ['senha com rótulo', 'a senha é Hunter2 combinado'],
  ['senha: valor', 'senha: abc123 ok'],
  ['o VALOR de uma variável de segredo do ambiente', `o valor é ${KEY} mesmo`],
];
const NORMAIS = [
  'Oi, tudo bem? Hoje faz sol.',
  'A palavra inconstitucionalissimamente é bem longa.',
  'O token do jogo custa dez moedas.',
  'Basic principles of testing.',
  'Bearer of bad news chegou.',
  'Reunião às quinze e trinta, sala doze.',
  'IlustrissimoSenhorDoutorDesembargador chegou.',
  'Custa três vírgula cinco reais.',
];
await test('findSecret acha chave, token, Bearer, hexa e senha (inclusive o valor de uma variável de segredo) e devolve só uma palavra fixa', () => {
  for (const [nome, texto] of SEGREDOS) {
    const r = findSecret(texto, omniEnv());
    assert.ok(['chave', 'token', 'senha', 'hexa', 'bearer', 'atribuicao'].includes(r), `${nome}: ${r}`);
  }
});
await test('findSecret NÃO acusa texto normal (frase comum, palavra longa, "token" e "Bearer" em sentido comum, hora)', () => {
  for (const t of NORMAIS) assert.equal(findSecret(t, omniEnv()), null, t);
  assert.equal(findSecret('', omniEnv()), null);
  assert.equal(findSecret(null, omniEnv()), null);
  assert.equal(findSecret(42, omniEnv()), null);
});
await test('o VALOR de uma variável de segredo do ambiente é segredo mesmo sem nenhum formato conhecido (e sem a variável o mesmo texto passa)', async () => {
  const valor = 'frase-simples-de-segredo'; // não casa com nenhum formato de chave: só o mascaramento do ambiente a acusa
  const texto = `repete a palavra ${valor} agora`;
  assert.ok(findSecret(texto, { MEU_TOKEN_DE_ACESSO: valor }));
  assert.equal(findSecret(texto, {}), null);
  const m = montar({ env: { ...omniEnv(), MEU_TOKEN_DE_ACESSO: valor } });
  assert.equal((await m.engine.synthesize(texto, { sensitive: false }))?.provider, 'sapi', 'só o local fala');
  assert.equal(m.omni.vistos.length + m.azure.vistos.length + m.edge.vistos.length, 0);
  assert.equal(m.engine.getStatus().secretBlocked, 1);
});
await test('o motor manda texto com segredo SÓ ao provedor local (nem OmniRoute, nem Azure, nem Edge), conta o evento e o log tem só um número', async () => {
  const log = linhas();
  const m = montar({ log });
  let esperado = 0;
  for (const [nome, texto] of SEGREDOS) {
    const r = await m.engine.synthesize(texto, { sensitive: false });
    esperado += 1;
    assert.equal(r?.provider, 'sapi', `${nome}: só o local fala`);
    assert.equal(m.engine.getStatus().secretBlocked, esperado, nome);
  }
  assert.equal(m.omni.vistos.length + m.azure.vistos.length + m.edge.vistos.length, 0, 'nenhuma nuvem recebeu nada');
  assert.equal(m.f.calls.length, 0, 'nenhuma chamada saiu');
  const avisos = log.l.filter((l) => l.includes('cara de chave, token ou senha'));
  assert.equal(avisos.length, SEGREDOS.length, 'uma linha por evento');
  for (const a of avisos) assert.ok(/^warn \[TTS\] Texto com cara de chave, token ou senha: só o provedor local pode falar \(eventos=\d+\)\.$/.test(a), a);
  const tudo = log.l.join('\n');
  for (const [, texto] of SEGREDOS) {
    for (const trecho of texto.split(/\s+/).filter((p) => p.length >= 8)) assert.ok(!tudo.includes(trecho), 'o log não tem nenhum trecho do texto');
  }
  assert.ok(!tudo.includes(KEY) && !tudo.includes(discordToken));
  // o texto normal continua indo ao OmniRoute
  for (const t of NORMAIS.slice(0, 3)) assert.equal((await m.engine.synthesize(t, { sensitive: false }))?.provider, 'omniroute', t);
  assert.equal(m.engine.getStatus().secretBlocked, esperado, 'texto normal não conta');
});
await test('com SENSIVEL=true um segredo no texto sensível TAMBÉM fica no provedor local (a exceção não libera credencial)', async () => {
  const m = montar({ cfgEnv: { YUI_TTS_OMNIROUTE_SENSIVEL: 'true' } });
  for (const [nome, texto] of SEGREDOS) assert.equal((await m.engine.synthesize(texto, { sensitive: true }))?.provider, 'sapi', nome);
  assert.equal(m.f.calls.length, 0);
  assert.equal((await m.engine.synthesize('Conversa privada sem segredo nenhum.', { sensitive: true }))?.provider, 'omniroute');
  assert.equal(m.omni.getUsage().sensitiveSent, 1);
});
await test('o provedor, chamado direto, também recusa o segredo (OMNIROUTE_SECRET): nada sai, o teto não é gasto e não é "falha do provedor"', async () => {
  for (const [nome, texto] of SEGREDOS) {
    const log = linhas();
    const f = mkFetch();
    const { p } = mk({ f, log });
    const e = await tentar(() => p.synth(texto, { sensitive: false }));
    assert.equal(e?.code, 'OMNIROUTE_SECRET', nome);
    assert.equal(f.calls.length, 0, nome);
    const u = p.getUsage();
    assert.deepEqual([u.used, u.fail, u.secretBlocked], [0, 0, 1], nome);
    const tudo = `${e.message} ${log.l.join('\n')}`;
    assert.ok(!tudo.includes(KEY) && !tudo.includes(discordToken) && !tudo.includes('Hunter2') && !tudo.includes('a3f9c2e1b7d84a0f'), `${nome}: vazou no erro ou no log`);
  }
});
await test('a EXCEÇÃO da fala sensível fica registrada: um contador e uma linha de palavras fixas, sem texto, trecho ou hash; o público não conta', async () => {
  const log = linhas();
  const m = montar({ log, cfgEnv: { YUI_TTS_OMNIROUTE_SENSIVEL: 'true' } });
  const privado = 'Resposta de conversa privada com a memória pessoal do usuário.';
  await m.engine.synthesize(privado, { sensitive: true });
  await m.engine.synthesize('Outra resposta privada diferente da primeira.', { sensitive: true });
  await m.engine.synthesize('Uma fala pública comum.', { sensitive: false });
  assert.equal(m.omni.getUsage().sensitiveSent, 2, 'só as duas sensíveis');
  const registros = log.l.filter((l) => l.includes('fala sensível enviada ao OmniRoute'));
  assert.deepEqual(registros, ['info [TTS] OmniRoute: fala sensível enviada ao OmniRoute (total=1).', 'info [TTS] OmniRoute: fala sensível enviada ao OmniRoute (total=2).']);
  const tudo = log.l.join('\n');
  for (const trecho of [...privado.split(' '), 'Outra resposta privada', 'memória pessoal']) assert.ok(trecho.length < 8 ? true : !tudo.includes(trecho), `o log tem "${trecho}"`);
  assert.ok(!/[0-9a-f]{16,}/.test(tudo), 'nenhum hash nem hexa no log');
  const sucessos = log.l.filter((l) => l.includes('ms_total=') && l.includes('cache=nao'));
  assert.equal(sucessos.length, 3);
  assert.ok(sucessos[0].includes('caracteres=-') && sucessos[1].includes('caracteres=-'), 'a fala sensível nem o tamanho do texto leva ao log');
  assert.ok(/caracteres=\d+/.test(sucessos[2]), 'a pública continua com o tamanho');
});
await test('sem a exceção (SENSIVEL=false) nada sensível é enviado e nada é registrado como enviado', async () => {
  const log = linhas();
  const m = montar({ log });
  await m.engine.synthesize('Resposta de conversa privada.', { sensitive: true });
  assert.equal(m.omni.getUsage().sensitiveSent, 0);
  assert.ok(!log.l.some((l) => l.includes('fala sensível enviada')));
  assert.equal(m.f.calls.length, 0);
});

// ═══ L. Prazo frio, "quente" e toque leve (incidente de 19/11/2026: a 1ª fala depois de ocioso levou 12,7 s e o prazo era de 10 s) ═════════════════
section('L. Prazo frio, quente e toque leve (GET /models)');
/** fetch que só responde depois de `ms` (ou falha ao ser abortado), para provar quem vence: o prazo do provedor ou o que o motor passou. */
const fetchLento = (ms, { ok = true } = {}) => {
  const calls = [];
  const fetchImpl = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url, init, method: init.method });
    const h = setTimeout(() => resolve(ok ? resposta(WAV) : resposta('x', { status: 500 })), ms);
    init.signal?.addEventListener('abort', () => { clearTimeout(h); reject(new Error('abortado')); }, { once: true });
  });
  return { fetchImpl, calls };
};
await test('os padrões novos: prazo frio de 14 s, "quente" por 5 min e toque DESLIGADO (0; o prazo frio nunca é menor que o quente)', () => {
  const c = getTtsConfig({});
  assert.deepEqual([c.omnirouteTimeoutMs, c.omnirouteColdTimeoutMs, c.omnirouteWarmMinutes, c.omnirouteKeepaliveMinutes], [10000, 14000, 5, 0]);
  assert.equal(getTtsConfig({ YUI_TTS_OMNIROUTE_COLD_TIMEOUT_MS: '99999999' }).omnirouteColdTimeoutMs, 60000);
});
await test('isWarm(): frio no começo, quente com fala bem-sucedida, volta a frio depois de 5 min parado; falha, cache e toque NÃO esquentam', async () => {
  let t = Date.parse('2026-11-19T12:00:00');
  const m = mk({ now: () => t, f: mkFetch((c) => (c.body?.input?.includes('quebra') ? resposta('x', { status: 500 }) : resposta(WAV))) });
  assert.equal(m.p.isWarm(), false, 'recém-criado');
  await m.p.warmup();
  assert.equal(m.p.isWarm(), false, 'o toque não esquenta a fala: o prazo frio vale até uma fala de verdade dar certo');
  assert.ok(await tentar(() => m.p.synth('quebra tudo', { sensitive: false })));
  assert.equal(m.p.isWarm(), false, 'falha não esquenta');
  await m.p.synth('Oi, tudo bem por aí.', { sensitive: false });
  assert.equal(m.p.isWarm(), true, 'fala bem-sucedida pela rede esquenta');
  t += 4 * 60_000 + 59_000;
  assert.equal(m.p.isWarm(), true, 'a 4 min e 59 s ainda está quente');
  t += 2000;
  assert.equal(m.p.isWarm(), false, 'passou de 5 min: voltou a ser frio');
  const posts = () => m.f.calls.filter((c) => c.method === 'POST').length;
  const n = posts();
  await m.p.synth('Oi, tudo bem por aí.', { sensitive: false }); // mesma fala: vem do cache (10 min de validade)
  assert.equal(posts(), n, 'veio do cache');
  assert.equal(m.p.isWarm(), false, 'o cache não esquenta (a rede não foi usada)');
  await m.p.synth('Outra fala nova.', { sensitive: false });
  assert.equal(m.p.isWarm(), true, 'um sucesso pela rede esquenta de novo');
  t -= 60_000; // o relógio andou para trás: nunca fica quente por engano
  assert.equal(m.p.isWarm(), false);
});
await test('a janela do "quente" vem de YUI_TTS_OMNIROUTE_WARM_MINUTES', async () => {
  let t = 1_700_000_000_000;
  const m = mk({ now: () => t, cfg: { YUI_TTS_OMNIROUTE_WARM_MINUTES: '1' } });
  await m.p.synth('Oi, tudo bem por aí.', { sensitive: false });
  t += 59_000;
  assert.equal(m.p.isWarm(), true);
  t += 2000;
  assert.equal(m.p.isWarm(), false);
});
await test('o prazo da chamada vem do motor (timeoutMs): o prazo curto do provedor não vence o prazo frio; sem o aviso, vale o do provedor', async () => {
  const f = fetchLento(450);
  const { p } = mk({ f, cfgOver: { omnirouteTimeoutMs: 300, omnirouteColdTimeoutMs: 1500 } });
  const sem = await tentar(() => p.synth('Oi, tudo bem por aí.', { sensitive: false }));
  assert.equal(sem?.code, 'OMNIROUTE_TIMEOUT', 'sem timeoutMs: o prazo do próprio provedor (270 ms) vence a resposta de 450 ms');
  const t0 = Date.now();
  const audio = await p.synth('Oi, tudo bem por aí.', { sensitive: false, timeoutMs: 1500 });
  assert.ok(audio.pcm.length > 0, 'com o prazo frio do motor a resposta lenta é aproveitada');
  assert.ok(Date.now() - t0 >= 400, 'esperou mesmo a resposta lenta');
  const curto = await tentar(() => p.synth('Terceira fala nova.', { sensitive: false, timeoutMs: 200 }));
  assert.equal(curto?.code, 'OMNIROUTE_TIMEOUT', 'e um prazo menor também vale');
  for (const ruim of [undefined, null, 'x', 0, 50, NaN, -5]) {
    const e = await tentar(() => p.synth(`Fala ${String(ruim)} nova.`, { sensitive: false, timeoutMs: ruim }));
    assert.equal(e?.code, 'OMNIROUTE_TIMEOUT', `timeoutMs inválido (${String(ruim)}) cai no prazo do provedor`);
  }
});
await test('PARECER DA LIZ: o toque nasce DESLIGADO (padrão 0): nem a entrada na call nem o periódico fazem GET; com 4 os dois fazem; e o prazo frio continua valendo', async () => {
  const padrao = getTtsConfig({ YUI_TTS_OMNIROUTE: 'true' });
  assert.equal(padrao.omnirouteKeepaliveMinutes, 0);
  const f0 = mkFetch();
  const p0 = createOmnirouteProvider({ config: padrao, env: omniEnv(), logger: quieto, fetchImpl: f0.fetchImpl });
  await p0.warmup();
  assert.equal(await p0.keepWarm(), false);
  assert.equal(f0.calls.length, 0, 'com 0 nenhuma sondagem sai (nem na entrada da call)');
  const f4 = mkFetch();
  const p4 = createOmnirouteProvider({ config: getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES: '4' }), env: omniEnv(), logger: quieto, fetchImpl: f4.fetchImpl });
  await p4.warmup();
  assert.equal(f4.calls.length, 1, 'com 4 a entrada da call sonda');
  assert.equal(f4.calls[0].method, 'GET');
  assert.ok(String(f4.calls[0].url).endsWith('/models'));
  assert.equal(f4.calls[0].init.redirect, 'error', 'o toque nunca segue redirecionamento');
  // a fala continua com o prazo frio maior mesmo com o toque desligado
  assert.equal(padrao.omnirouteColdTimeoutMs, 14000);
});
await test('o toque leve: GET {base}/models com a MESMA chave só no cabeçalho, sem gastar cota, sem POST, sem registrar a chave nem o endereço', async () => {
  const log = linhas();
  const m = mk({ log });
  await m.p.warmup();
  assert.equal(m.f.calls.length, 1);
  const c = m.f.calls[0];
  assert.equal(c.method, 'GET');
  assert.equal(c.url, 'http://127.0.0.1:20128/v1/models');
  assert.equal(c.init.headers.Authorization, `Bearer ${KEY}`);
  assert.equal(c.init.body, undefined);
  assert.equal(c.init.redirect, 'error', 'a chave não segue redirecionamento');
  assert.ok(!c.url.includes(KEY));
  assert.equal(m.p.getUsage().used, 0);
  assert.ok(!log.l.join('\n').includes(KEY) && !log.l.join('\n').includes('127.0.0.1'), 'nada de chave nem endereço no log');
});
await test('o toque nunca atrapalha: desligado, sem rota, rede caída, 401, 500 ou pendurado = em silêncio, sem lançar e sem log', async () => {
  const falhas = [
    ['desligado', mk({ cfg: {}, cfgOver: { omniroute: false } })],
    ['sem a rota da IA', mk({ env: {} })],
    ['rede caída', mk({ f: mkFetch(() => { throw new Error('ECONNREFUSED'); }) })],
    ['401', mk({ f: mkFetch(() => resposta('x', { status: 401 })) })],
    ['500', mk({ f: mkFetch(() => resposta('x', { status: 500 })) })],
  ];
  for (const [nome, m] of falhas) {
    await m.p.warmup();
    assert.equal(await m.p.keepWarm(), false, nome);
    assert.equal(m.log.l.length, 0, `${nome}: nada de log`);
    assert.equal(m.p.getUsage().used, 0);
  }
  assert.equal(falhas[0][1].f.calls.length, 0, 'desligado: nem tenta');
  assert.equal(falhas[1][1].f.calls.length, 0, 'sem rota: nem tenta');
  const lento = fetchLento(60_000);
  const { p } = mk({ f: lento, cfgOver: { omnirouteTimeoutMs: 400, omnirouteColdTimeoutMs: 400 } });
  const t0 = Date.now();
  assert.equal(await p.keepWarm(), false);
  assert.ok(Date.now() - t0 < 2000, 'o toque tem prazo e não fica pendurado');
});
await test('keepWarm(): não repete o toque se uma fala ou um toque deu certo há menos de 2 min (a fala já o manteve acordado); depois toca de novo', async () => {
  let t = 1_700_000_000_000;
  const m = mk({ now: () => t });
  assert.equal(await m.p.keepWarm(), true);
  assert.equal(await m.p.keepWarm(), false, 'acabou de tocar');
  assert.equal(m.f.calls.length, 1);
  t += 3 * 60_000;
  assert.equal(await m.p.keepWarm(), true);
  assert.equal(m.f.calls.length, 2);
  t += 60_000;
  await m.p.synth('Oi, tudo bem por aí.', { sensitive: false });
  t += 60_000;
  assert.equal(await m.p.keepWarm(), false, 'a fala de 1 min atrás já o manteve acordado');
  t += 2 * 60_000;
  assert.equal(await m.p.keepWarm(), true);
});
await test('a chave não aparece nos objetos que o provedor expõe nem na configuração nova', async () => {
  const m = mk();
  await m.p.warmup();
  await m.p.synth('Oi, tudo bem por aí.', { sensitive: false });
  assert.ok(!JSON.stringify(m.p.getUsage()).includes(KEY));
  assert.ok(!JSON.stringify(getTtsConfig({ ...omniEnv(), YUI_TTS_OMNIROUTE: 'true' })).includes(KEY));
});

// ═══ M. O toque periódico enquanto a Yui está na call (index.js) ═══════════════════════════════════════════════
section('M. Toque periódico enquanto a Yui está na call');
function mundoDoToque(envExtra = {}, { comOmni = true } = {}) {
  const pend = new Map();
  let id = 0;
  const timers = {
    setTimeout(fn, ms) { id += 1; pend.set(id, { fn, ms }); return { id, unref() { return this; } }; },
    clearTimeout(h) { pend.delete(h?.id); },
  };
  const omniF = {
    name: 'omniroute', local: false, keep: 0, warm: 0, keepMode: 'ok',
    gate: { enabled: () => true, allowsSensitive: () => false },
    probe: async () => ({ ok: true, detail: '' }),
    warmup: async () => { omniF.warm += 1; },
    keepWarm: async () => { omniF.keep += 1; if (omniF.keepMode === 'throw') throw new Error('sem rede'); return true; },
    getUsage: () => ({}),
    synth: async () => { throw new Error('não deve falar'); },
    dispose: async () => {},
  };
  const sapiF = createFakeProvider({ name: 'sapi', local: true });
  const manager = { warmup: async () => true, dispose: () => true, disposeAll() {}, getStatus: () => ({ count: 0, guilds: [] }), interrupt: () => false };
  const deps = { isOpusAvailable: () => true };
  const providers = comOmni ? [omniF, sapiF] : [sapiF];
  const iniciar = () => initTts({ client: null, deps, overrides: { env: { YUI_TTS_OMNIROUTE: 'true', YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES: '4', ...envExtra }, providers, manager, logger: quieto, timers } });
  const periodicos = () => [...pend.entries()].filter(([, v]) => v.ms === 240_000);
  const dispararPeriodico = async () => {
    const [h, v] = periodicos()[0];
    pend.delete(h);
    v.fn();
    for (let i = 0; i < 10; i += 1) await new Promise((r) => setImmediate(r)); // o toque do motor também usa um prazo (o relógio falso o deixa pendente e sem disparar)
  };
  return { omniF, iniciar, periodicos, dispararPeriodico, pend };
}
await test('entrar na call (warmupTts com a guilda) agenda o toque a cada 4 min; cada disparo toca o OmniRoute e agenda o próximo; sair da call encerra', async () => {
  const w = mundoDoToque();
  assert.equal((await w.iniciar()).enabled, true);
  assert.equal(w.periodicos().length, 0, 'nada antes de entrar na call');
  assert.equal(await warmupTts('g1'), true);
  assert.equal(w.omniF.warm, 1, 'o aquecimento da entrada tocou o provedor');
  assert.equal(w.periodicos().length, 1);
  assert.equal(await warmupTts('g1'), true);
  assert.equal(w.periodicos().length, 1, 'entrar de novo não duplica o temporizador');
  await w.dispararPeriodico();
  assert.equal(w.omniF.keep, 1);
  assert.equal(w.periodicos().length, 1, 'agendou o próximo');
  await w.dispararPeriodico();
  assert.equal(w.omniF.keep, 2);
  disposeGuild('g1');
  assert.equal(w.periodicos().length, 0, 'saiu da call: o temporizador some');
  await shutdownTts();
});
await test('com duas calls o toque só acaba quando a última sai; o shutdown também limpa; sem guilda, sem OmniRoute ou com 0 minutos não agenda nada', async () => {
  const w = mundoDoToque();
  await w.iniciar();
  await warmupTts('g1');
  await warmupTts('g2');
  assert.equal(w.periodicos().length, 1);
  disposeGuild('g1');
  assert.equal(w.periodicos().length, 1, 'ainda há uma call');
  disposeGuild('g2');
  assert.equal(w.periodicos().length, 0);
  await warmupTts('g3');
  assert.equal(w.periodicos().length, 1);
  await shutdownTts();
  assert.equal(w.periodicos().length, 0, 'o shutdown limpa o temporizador');

  const semGuilda = mundoDoToque();
  await semGuilda.iniciar();
  await warmupTts();
  await warmupTts('');
  assert.equal(semGuilda.periodicos().length, 0);
  await shutdownTts();

  const zero = mundoDoToque({ YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES: '0' });
  await zero.iniciar();
  await warmupTts('g1');
  assert.equal(zero.periodicos().length, 0, '0 = nunca');
  assert.equal(zero.pend.size, 0, '0 = nenhum temporizador de toque, de nenhum prazo');
  await shutdownTts();

  const padrao = mundoDoToque({ YUI_TTS_OMNIROUTE_KEEPALIVE_MINUTES: undefined }); // sem a chave: o padrão do CÓDIGO (0)
  await padrao.iniciar();
  await warmupTts('g1');
  assert.equal(padrao.periodicos().length, 0, 'padrão do código: o toque periódico NÃO é agendado');
  assert.equal(padrao.omniF.keep, 0);
  assert.equal(padrao.pend.size, 0, 'padrão do código = nenhum temporizador de toque, de nenhum prazo');
  await shutdownTts();

  const semOmni = mundoDoToque({}, { comOmni: false });
  await semOmni.iniciar();
  await warmupTts('g1');
  assert.equal(semOmni.periodicos().length, 0, 'sem o provedor omniroute não há o que tocar');
  await shutdownTts();

  const desligado = mundoDoToque({ YUI_TTS_OMNIROUTE: 'false' });
  await desligado.iniciar();
  await warmupTts('g1');
  assert.equal(desligado.periodicos().length, 0, 'YUI_TTS_OMNIROUTE desligado: nada');
  await shutdownTts();
});
await test('o toque que falha nunca para o ciclo, não lança e não derruba a call', async () => {
  const w = mundoDoToque();
  await w.iniciar();
  w.omniF.keepMode = 'throw';
  await warmupTts('g1');
  await w.dispararPeriodico();
  assert.equal(w.omniF.keep, 1);
  assert.equal(w.periodicos().length, 1, 'continua agendado apesar da falha');
  await shutdownTts();
});

console.log(`\n${ok} testes OK${fail ? `, ${fail} falha(s): ${failures.join('; ')}` : ''}`);
process.exit(fail ? 1 : 0);
