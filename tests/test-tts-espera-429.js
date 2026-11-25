// A espera depois de um 429 do provedor de voz na nuvem (YUI_TTS_ESPERA_429_S, padrão 0 = desligado): o disjuntor dele abre NA HORA e as próximas falas vão direto ao
// provedor seguinte, sem martelar a cota estourada a cada frase; a troca de voz (nuvem -> voz local) continua como sempre. Sem rede, sem Discord e sem espera real:
// o relógio e os provedores são falsos.
// Execução: npm run test:tts429   (node tests/test-tts-espera-429.js)
import assert from 'assert';
import { getTtsConfig } from '../src/services/tts/config.js';
import { createEngine } from '../src/services/tts/engine.js';

let passed = 0;
let failed = 0;
async function test(name, fn) {
  try { await fn(); passed++; console.log(`  ok     ${name}`); } catch (e) { failed++; console.log(`  FALHA  ${name}\n         ${String(e?.message ?? e).split('\n')[0]}`); }
}

function fakeClock(start = 5_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}
const audio = () => ({ pcm: new Uint8Array(24000 * 2), sampleRate: 24000, channels: 1 }); // 1 s de áudio de 24 kHz mono
const erro = (code) => Object.assign(new Error('falha de teste'), { code });

/** Um provedor falso que conta as chamadas e segue um roteiro (`modo`: 'ok' | código de erro). */
function provedor(name, local, modo = 'ok') {
  const p = { name, local, chamadas: 0, modo, async synth() { p.chamadas += 1; if (p.modo === 'ok') return audio(); throw erro(p.modo); } };
  return p;
}

function montar(espera429, nuvemModo, localModo = 'ok') {
  const env = { YUI_TTS_CLOUD: 'true', YUI_TTS_PROVIDERS: 'edge,sapi' };
  if (espera429 !== undefined) env.YUI_TTS_ESPERA_429_S = String(espera429);
  const nuvem = provedor('edge', false, nuvemModo);
  const local = provedor('sapi', true, localModo);
  const now = fakeClock();
  const engine = createEngine({ providers: [nuvem, local], config: getTtsConfig(env), now });
  const falar = () => engine.synthesize('Oi, tudo bem por aí?', { sensitive: false });
  return { engine, nuvem, local, now, falar };
}

console.log('\nConfiguração');
await test('padrão 0 (desligado); lê segundos e limita a 0..600', () => {
  assert.strictEqual(getTtsConfig({}).rateLimitWaitMs, 0);
  assert.strictEqual(getTtsConfig({ YUI_TTS_ESPERA_429_S: '60' }).rateLimitWaitMs, 60_000);
  assert.strictEqual(getTtsConfig({ YUI_TTS_ESPERA_429_S: '99999' }).rateLimitWaitMs, 600_000, 'acima do limite fica no teto de 600 s');
  assert.strictEqual(getTtsConfig({ YUI_TTS_ESPERA_429_S: 'abc' }).rateLimitWaitMs, 0);
  assert.strictEqual(getTtsConfig({ YUI_TTS_ESPERA_429_S: '-5' }).rateLimitWaitMs, 0);
});

console.log('\nDesligado: o comportamento de sempre');
await test('sem a chave, a nuvem com 429 é tentada a cada frase (o disjuntor só abre depois de várias falhas)', async () => {
  const { nuvem, local, falar } = montar(undefined, 'OMNIROUTE_RATE');
  const r1 = await falar();
  assert.strictEqual(r1.provider, 'sapi', 'a troca de voz continua');
  const r2 = await falar();
  assert.strictEqual(r2.provider, 'sapi');
  assert.strictEqual(nuvem.chamadas, 2, 'sem a espera, a nuvem foi tentada nas duas falas');
  assert.strictEqual(local.chamadas, 2);
});

console.log('\nLigado (60 s)');
await test('depois de um 429 a próxima fala vai direto à voz local, sem tentar a nuvem de novo', async () => {
  const { nuvem, local, now, falar } = montar(60, 'OMNIROUTE_RATE');
  const r1 = await falar();
  assert.strictEqual(r1.provider, 'sapi', 'a primeira fala cai para a voz local, como sempre');
  assert.strictEqual(nuvem.chamadas, 1);
  now.advance(1000);
  const r2 = await falar();
  now.advance(1000);
  const r3 = await falar();
  assert.strictEqual(r2.provider, 'sapi');
  assert.strictEqual(r3.provider, 'sapi');
  assert.strictEqual(nuvem.chamadas, 1, 'a nuvem NÃO foi tentada nas falas seguintes (em espera)');
  assert.strictEqual(local.chamadas, 3);
});

await test('passada a espera, a nuvem volta (uma tentativa) e, se responder, fecha o disjuntor', async () => {
  const { nuvem, now, falar } = montar(60, 'RATE_LIMIT');
  await falar();
  assert.strictEqual(nuvem.chamadas, 1);
  now.advance(59_000);
  await falar();
  assert.strictEqual(nuvem.chamadas, 1, 'ainda em espera aos 59 s');
  now.advance(2_000);
  nuvem.modo = 'ok';
  const r = await falar();
  assert.strictEqual(nuvem.chamadas, 2, 'passados 60 s, tenta de novo');
  assert.strictEqual(r.provider, 'edge', 'a voz da nuvem voltou');
  const r2 = await falar();
  assert.strictEqual(r2.provider, 'edge');
  assert.strictEqual(nuvem.chamadas, 3, 'disjuntor fechado: segue usando a nuvem');
});

await test('um 429 de novo na tentativa de volta reabre a espera inteira', async () => {
  const { nuvem, now, falar } = montar(60, 'OMNIROUTE_RATE');
  await falar();
  now.advance(61_000);
  await falar();
  assert.strictEqual(nuvem.chamadas, 2);
  now.advance(30_000);
  await falar();
  assert.strictEqual(nuvem.chamadas, 2, 'nova espera de 60 s a partir do segundo 429');
});

await test('só o 429 abre na hora: outro erro (timeout) continua com a regra de sempre', async () => {
  const { nuvem, falar } = montar(60, 'TIMEOUT');
  await falar();
  await falar();
  assert.strictEqual(nuvem.chamadas, 2, 'timeout não pede a espera de 429');
});

await test('provedor LOCAL nunca entra na espera de 429 (só nuvem)', async () => {
  const { nuvem, local, falar } = montar(60, 'OMNIROUTE_RATE', 'RATE_LIMIT');
  const r = await falar();
  assert.strictEqual(r, null, 'os dois falharam: só texto');
  await falar();
  assert.strictEqual(local.chamadas, 2, 'o local foi tentado de novo (sem espera)');
  assert.strictEqual(nuvem.chamadas, 1, 'a nuvem ficou em espera');
});

await test('no máximo UMA tentativa por provedor por fala (sem laço)', async () => {
  const { nuvem, local, falar } = montar(60, 'OMNIROUTE_RATE', 'ERRO_QUALQUER');
  await falar();
  assert.ok(nuvem.chamadas <= 1 && local.chamadas <= 1, `nuvem ${nuvem.chamadas}, local ${local.chamadas}`);
});

await test('estado do motor mostra o disjuntor da nuvem aberto durante a espera', async () => {
  const { engine, falar } = montar(60, 'OMNIROUTE_RATE');
  await falar();
  const txt = JSON.stringify(engine.getStatus());
  assert.ok(/edge/.test(txt));
  assert.ok(!/OMNIROUTE_RATE.*segredo/.test(txt));
});

console.log(`\n${passed} testes OK${failed ? `; ${failed} FALHARAM` : ''}`);
process.exit(failed ? 1 : 0);
