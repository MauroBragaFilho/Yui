// Voz pelo OmniRoute (etapa 12), de ponta a ponta com o OMNIROUTE FALSO em loopback (tests/helpers/omnirouteFalso.js: a rota POST /v1/audio/speech, aberta pelo
// PRÓPRIO teste; nada sai da máquina e o OmniRoute de verdade nunca é tocado). Cobre: o corpo EXATO da chamada (modelo, voz, texto, formato), a chave Bearer sem vazar
// (logs, status, erros), o WAV tocável (chega ao PCM do Discord), cada falha (401, 429, 500, lento, vazio, WAV ruim, mudo, JSON, enorme, conexão derrubada,
// redirecionamento) caindo no PRÓXIMO provedor sem erro para a pessoa, o teto diário, o cache, a porta de privacidade para texto sensível, o MP3 e o caminho
// inteiro initTts -> speakVoiceReply -> fila -> PCM do Discord. Sem espera fixa (o único tempo é o prazo da chamada lenta, de propósito curto).
// Execução: node tests/test-tts-omniroute-integracao.js
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { criarOmniRouteFalso, criarWavDeTeste, CHAVE_GERAL, CHAVE_PRIVADA } from './helpers/omnirouteFalso.js';
import { createOmnirouteProvider } from '../src/services/tts/providers/omniroute.js';
import { createFakeProvider } from '../src/services/tts/providers/fake.js';
import { createEngine } from '../src/services/tts/engine.js';
import { getTtsConfig, DEFAULT_OMNIROUTE_STYLE } from '../src/services/tts/config.js';
import { toDiscordPcm, pcmDurationMs, DISCORD_FRAME_BYTES } from '../src/services/tts/audio.js';
import { initTts, speakVoiceReply, getTtsStatus, shutdownTts } from '../src/services/tts/index.js';

let ok = 0;
let fail = 0;
const failures = [];
const escapou = [];
process.on('unhandledRejection', (e) => escapou.push(`unhandledRejection: ${e?.code || e?.message || e}`));
process.on('uncaughtException', (e) => escapou.push(`uncaughtException: ${e?.code || e?.message || e}`));
async function test(name, fn) {
  try { await fn(); ok++; console.log('  ok  ', name); } catch (e) { fail++; failures.push(name); console.log('  FALHA', name, '\n       ', String(e?.stack ?? e).split('\n').slice(0, 5).join('\n        ')); }
}
const section = (t) => console.log(`\n${t}`);

const SEGREDO_DE_FALA = 'frase-secreta-que-nunca-vai-ao-log';
const todasAsLinhas = []; // TODO log de TODO o teste: no fim nenhuma chave nem texto pode estar aqui
const logger = {
  info: (m) => todasAsLinhas.push(`info ${m}`), warn: (m) => todasAsLinhas.push(`warn ${m}`), error: (m) => todasAsLinhas.push(`error ${m}`), debug() {},
};

const omni = await criarOmniRouteFalso();
const envIA = (chave = CHAVE_GERAL, extra = {}) => ({
  YUI_GATEWAY_CUSTOM: JSON.stringify([{ id: 'omniroute', label: 'OmniRoute (falso)', baseUrl: omni.url, apiKeyEnv: 'OMNI_CHAVE_TTS', models: ['auto'], anonymous: true }]),
  OMNI_CHAVE_TTS: chave,
  ...extra,
});
const cfgDe = (extra = {}, over = {}) => ({ ...getTtsConfig({ YUI_TTS_OMNIROUTE: 'true', ...extra }), ...over });
const novoProvedor = (extra = {}, over = {}, env = envIA(), opcoes = {}) => createOmnirouteProvider({ config: cfgDe(extra, over), env, logger, ...opcoes });
const tentar = async (fn) => { try { await fn(); return null; } catch (e) { return e; } };
const montar = ({ extra = {}, over = {}, env = envIA(), opcoes = {} } = {}) => {
  const config = { ...cfgDe({ YUI_TTS_PROVIDERS: 'omniroute,sapi', ...extra }, over) };
  const omniProv = novoProvedor({ YUI_TTS_PROVIDERS: 'omniroute,sapi', ...extra }, over, env, opcoes);
  const sapi = createFakeProvider({ name: 'sapi', local: true });
  return { engine: createEngine({ providers: [omniProv, sapi], config, logger, env }), omniProv, sapi };
};

// ═══ A. A chamada de verdade ═══════════════════════════════════════════════════════════════════════════════════
section('A. A chamada de verdade (HTTP em loopback)');
await test('o corpo EXATO: modelo, voz, texto (estilo + fala) e formato; Bearer com a chave da IA, só no cabeçalho', async () => {
  omni.limpar();
  const p = novoProvedor();
  const r = await p.synth('Oi, tudo bem? <short pause> Hoje faz sol.', { sensitive: false });
  assert.equal(omni.falas.length, 1);
  const f = omni.falas[0];
  assert.equal(f.metodo, 'POST');
  assert.equal(f.modelo, 'google/gemini-3.8-flash-tts');
  assert.equal(f.voz, 'Leda');
  assert.equal(f.texto, `${DEFAULT_OMNIROUTE_STYLE}: Oi, tudo bem? <short pause> Hoje faz sol.`);
  assert.equal(f.formato, 'wav');
  assert.deepEqual(f.chavesDoCorpo, ['model', 'input', 'voice', 'response_format']);
  assert.equal(f.papel, 'geral', 'a chave que a Yui usa para a IA');
  assert.ok(f.temAuth);
  assert.ok(/^application\/json/.test(f.tipoDoPedido));
  assert.deepEqual([r.sampleRate, r.channels], [24000, 1]);
});
await test('o WAV é tocável: chega ao PCM do Discord (48 kHz estéreo, múltiplo de 3840 bytes) com a duração certa e som de verdade', async () => {
  omni.limpar();
  omni.definirFala({ duracaoMs: 700 });
  const r = await novoProvedor().synth('Uma fala de teste.', { sensitive: false });
  assert.equal(r.pcm.length, 700 * 24000 / 1000 * 2);
  const discord = toDiscordPcm(r);
  assert.ok(discord.length > 0 && discord.length % DISCORD_FRAME_BYTES === 0);
  const ms = pcmDurationMs(discord);
  assert.ok(ms >= 700 && ms < 900, `duração ${ms}`);
  let pico = 0;
  for (let i = 0; i < discord.length; i += 2) pico = Math.max(pico, Math.abs(discord.readInt16LE(i)));
  assert.ok(pico > 10000, `pico ${pico}`);
});
await test('modelo, voz e estilo vêm das chaves: outro modelo e outra voz vão como estão, sem estilo em inglês e sem as marcas', async () => {
  omni.limpar();
  const p = novoProvedor({ YUI_TTS_OMNIROUTE_MODELO: 'google/gemini-3.1-flash-tts-preview', YUI_TTS_OMNIROUTE_VOZ: 'Kore', YUI_TTS_OMNIROUTE_ESTILO: 'Say it calmly' });
  await p.synth('Oi! <laugh> Tudo bem?', { sensitive: false });
  assert.deepEqual([omni.falas[0].modelo, omni.falas[0].voz, omni.falas[0].texto], ['google/gemini-3.1-flash-tts-preview', 'Kore', 'Say it calmly: Oi! <laugh> Tudo bem?']);
  const outro = novoProvedor({ YUI_TTS_OMNIROUTE_MODELO: 'outro/voz-x', YUI_TTS_OMNIROUTE_VOZ: 'pt_BR-x' });
  await outro.synth('Oi! <laugh> Tudo bem?', { sensitive: false });
  assert.deepEqual([omni.falas[1].modelo, omni.falas[1].voz, omni.falas[1].texto], ['outro/voz-x', 'pt_BR-x', 'Oi! Tudo bem?']);
});
await test('Markdown, emoji, link e menção são tirados antes de sair; as marcas do Gemini ficam', async () => {
  omni.limpar();
  await novoProvedor().synth('## Oi 😀 **tudo** bem? <@123> https://x.com/y <sigh> Ufa.', { sensitive: false });
  assert.equal(omni.falas[0].texto, `${DEFAULT_OMNIROUTE_STYLE}: Oi tudo bem? <sigh> Ufa.`);
});

// ═══ B. Cada falha cai no próximo ═════════════════════════════════════════════════════════════════════════════════
section('B. Falhas: cada uma cai no PRÓXIMO provedor, sem erro para a pessoa');
const VARIACOES = [
  ['401 (não autorizado)', { status: 401 }],
  ['403', { status: 403 }],
  ['429 (cota)', { status: 429 }],
  ['500', { status: 500 }],
  ['503', { status: 503 }],
  ['lento demais (passa do prazo)', { atrasoMs: 1500 }],
  ['200 sem corpo', { vazio: true }],
  ['WAV inválido', { corpo: 'ruim' }],
  ['cabeçalho WAV sem dados', { corpo: 'truncado' }],
  ['WAV sem amostras', { corpo: 'sem-amostras' }],
  ['WAV mudo', { corpo: 'mudo' }],
  ['JSON no lugar do áudio', { corpo: 'json' }],
  ['áudio enorme', { corpo: 'grande' }],
  ['conexão derrubada', { cair: true }],
  ['redirecionamento', { redirecionar: true }],
];
for (const [nome, fala] of VARIACOES) {
  await test(`${nome}: o provedor local fala no lugar, uma chamada só ao OmniRoute`, async () => {
    omni.limpar();
    omni.definirFala(fala);
    const { engine, sapi } = montar({ over: { omnirouteTimeoutMs: 400, omnirouteColdTimeoutMs: 400 } });
    const t0 = Date.now();
    const r = await engine.synthesize('Oi, tudo bem?', { sensitive: false });
    assert.equal(r?.provider, 'sapi', `${nome}: quem falou`);
    assert.ok(r.pcm.length > 0);
    assert.equal(sapi.stats.synth, 1);
    assert.equal(omni.falas.length, 1, 'UMA tentativa (sem repetir)');
    assert.ok(Date.now() - t0 < 1400, 'o prazo curto vale: não esperou a resposta lenta inteira');
    if (fala.redirecionar) assert.equal(omni.alvosDeRedirect.length, 0, 'a chave NÃO seguiu o redirecionamento');
  });
}
await test('chave que o OmniRoute não conhece (401 de verdade): cai no local', async () => {
  omni.limpar();
  const { engine } = montar({ env: envIA('sk-chave-que-o-omniroute-nao-conhece-0000') });
  assert.equal((await engine.synthesize('Oi, tudo bem?', { sensitive: false }))?.provider, 'sapi');
  assert.equal(omni.falas[0].papel, 'desconhecida');
});
await test('a chave da IA mudada no painel vale na fala seguinte, sem reiniciar (a chave privada é outra e também é só repassada)', async () => {
  omni.limpar();
  const env = envIA();
  const p = novoProvedor({}, {}, env);
  await p.synth('Um.', { sensitive: false });
  env.OMNI_CHAVE_TTS = CHAVE_PRIVADA;
  await p.synth('Dois.', { sensitive: false });
  assert.deepEqual(omni.falas.map((f) => f.papel), ['geral', 'privada']);
});
await test('sem o provedor "omniroute" na IA: nada é enviado e o local fala', async () => {
  omni.limpar();
  const { engine } = montar({ env: {} });
  assert.equal((await engine.synthesize('Oi, tudo bem?', { sensitive: false }))?.provider, 'sapi');
  assert.equal(omni.falas.length, 0);
});

// ═══ C. Segredos ═══════════════════════════════════════════════════════════════════════════════════════════════════
section('C. Nenhum segredo vaza');
await test('depois de tudo isso, nenhuma linha de log tem a chave, o texto falado ou o endereço; os logs são só números e códigos', async () => {
  omni.limpar();
  omni.definirFala({ status: 500 });
  const { engine } = montar();
  await engine.synthesize(`Fala com ${SEGREDO_DE_FALA} dentro.`, { sensitive: false });
  omni.limpar();
  await engine.synthesize(`Outra fala com ${SEGREDO_DE_FALA}.`, { sensitive: false });
  const tudo = todasAsLinhas.join('\n');
  for (const proibido of [CHAVE_GERAL, CHAVE_PRIVADA, SEGREDO_DE_FALA, 'Bearer', '127.0.0.1']) assert.ok(!tudo.includes(proibido), `vazou "${proibido}" no log`);
  const linhasOmni = todasAsLinhas.filter((l) => l.includes('OmniRoute'));
  assert.ok(linhasOmni.length > 5);
  assert.ok(linhasOmni.some((l) => /ms_rede=\d+ ms_total=\d+/.test(l)), 'a latência de sucesso (números)');
  assert.ok(linhasOmni.some((l) => /falha codigo=OMNIROUTE_HTTP status=500 ms=\d+/.test(l)), 'a falha: código, status e tempo');
});

// ═══ D. Teto, cache e privacidade ═══════════════════════════════════════════════════════════════════════════════
section('D. Teto diário, cache e texto sensível');
await test('teto diário: passadas as falas do dia o local assume e o OmniRoute nem é chamado', async () => {
  omni.limpar();
  const { engine } = montar({ over: { omnirouteDailyCap: 2 } });
  const quem = [];
  for (let i = 0; i < 4; i++) quem.push((await engine.synthesize(`Fala número ${i}.`, { sensitive: false }))?.provider);
  assert.deepEqual(quem, ['omniroute', 'omniroute', 'sapi', 'sapi']);
  assert.equal(omni.falas.length, 2);
});
await test('cache: a mesma fala pública não volta ao OmniRoute', async () => {
  omni.limpar();
  const { engine } = montar();
  for (let i = 0; i < 3; i++) assert.equal((await engine.synthesize('Bom dia, tudo bem?', { sensitive: false }))?.provider, 'omniroute');
  assert.equal(omni.falas.length, 1);
});
await test('texto sensível com YUI_TTS_OMNIROUTE_SENSIVEL=false (padrão): nada sai para o OmniRoute; o local fala', async () => {
  omni.limpar();
  const { engine } = montar();
  for (const opts of [{ sensitive: true }, {}]) assert.equal((await engine.synthesize('Conversa privada com memória.', opts))?.provider, 'sapi');
  assert.equal(omni.falas.length, 0);
});
await test('texto sensível com YUI_TTS_OMNIROUTE_SENSIVEL=true: vai ao OmniRoute (com a chave da IA) e não é guardado no cache', async () => {
  omni.limpar();
  const { engine } = montar({ extra: { YUI_TTS_OMNIROUTE_SENSIVEL: 'true' } });
  for (let i = 0; i < 2; i++) assert.equal((await engine.synthesize('Conversa privada com memória.', { sensitive: true }))?.provider, 'omniroute');
  assert.equal(omni.falas.length, 2);
  assert.ok(omni.falas.every((f) => f.papel === 'geral'));
});

// ═══ D2. Segredos e a exceção da fala sensível ═════════════════════════════════════════════════════════════════════
section('D2. Segredos nunca vão à síntese; a exceção da fala sensível fica registrada');
const discordToken = `MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.${'abcdefghij'.repeat(3)}`; // o FORMATO de um token de bot (montado aqui, nada real)
const SEGREDOS = [
  ['chave de API', 'a chave é sk-proj-abcdefghijklmnopqrstuvwx1234 ok'],
  ['token do Discord', `o token é ${discordToken}`],
  ['Bearer', 'Authorization: Bearer abcdef1234567890xyz'],
  ['hexadecimal longo', 'o hash é a3f9c2e1b7d84a0f9c3e5d7b1a2c4e6f e pronto'],
  ['senha', 'a senha é Hunter2 combinado'],
  ['a chave que a Yui usa para o OmniRoute', `a chave ${CHAVE_GERAL} está aqui`],
];
await test('texto com chave, token Discord, Bearer, hexa longo, senha ou a chave do OmniRoute NUNCA chega ao OmniRoute: o local fala e o evento é contado', async () => {
  omni.limpar();
  const antes = todasAsLinhas.length;
  const { engine, sapi } = montar({ extra: { YUI_TTS_OMNIROUTE_SENSIVEL: 'true' } });
  for (const [nome, texto] of SEGREDOS) {
    for (const sensitive of [false, true]) assert.equal((await engine.synthesize(texto, { sensitive }))?.provider, 'sapi', `${nome} (sensitive=${sensitive})`);
  }
  assert.equal(omni.falas.length, 0, 'nenhuma chamada saiu');
  assert.equal(sapi.stats.synth, SEGREDOS.length * 2);
  assert.equal(engine.getStatus().secretBlocked, SEGREDOS.length * 2);
  const novas = todasAsLinhas.slice(antes).join('\n');
  for (const proibido of [CHAVE_GERAL, discordToken, 'Hunter2', 'a3f9c2e1b7d84a0f', 'sk-proj-abcdefgh']) assert.ok(!novas.includes(proibido), `o log tem "${proibido}"`);
  // o texto limpo, no mesmo motor, segue normal
  assert.equal((await engine.synthesize('Bom dia, tudo bem com você hoje?', { sensitive: false }))?.provider, 'omniroute');
  assert.equal(omni.falas.length, 1);
});
await test('a EXCEÇÃO da fala sensível: com SENSIVEL=true o texto vai (com a chave da IA) e fica registrado só como contador e palavras fixas; o público não conta', async () => {
  omni.limpar();
  const antes = todasAsLinhas.length;
  const { engine, omniProv } = montar({ extra: { YUI_TTS_OMNIROUTE_SENSIVEL: 'true' } });
  const privado = 'Resposta da conversa privada com a memória pessoal do usuário.';
  assert.equal((await engine.synthesize(privado, { sensitive: true }))?.provider, 'omniroute');
  assert.equal((await engine.synthesize('Mais uma resposta privada, bem diferente.', { sensitive: true }))?.provider, 'omniroute');
  assert.equal((await engine.synthesize('Uma fala pública qualquer.', { sensitive: false }))?.provider, 'omniroute');
  assert.equal(omni.falas.length, 3);
  assert.ok(omni.falas.every((f) => f.papel === 'geral'));
  assert.equal(omniProv.getUsage().sensitiveSent, 2);
  const novas = todasAsLinhas.slice(antes);
  assert.deepEqual(novas.filter((l) => l.includes('fala sensível enviada')), ['info [TTS] OmniRoute: fala sensível enviada ao OmniRoute (total=1).', 'info [TTS] OmniRoute: fala sensível enviada ao OmniRoute (total=2).']);
  const tudo = novas.join('\n');
  for (const trecho of ['Resposta da conversa', 'memória pessoal', 'Mais uma resposta', 'usuário']) assert.ok(!tudo.includes(trecho), `o log tem "${trecho}"`);
});
await test('com SENSIVEL=false (padrão) nenhuma fala sensível sai e nada é registrado como enviado', async () => {
  omni.limpar();
  const antes = todasAsLinhas.length;
  const { engine, omniProv } = montar();
  assert.equal((await engine.synthesize('Resposta da conversa privada.', { sensitive: true }))?.provider, 'sapi');
  assert.equal(omni.falas.length, 0);
  assert.equal(omniProv.getUsage().sensitiveSent, 0);
  assert.ok(!todasAsLinhas.slice(antes).some((l) => l.includes('fala sensível enviada')));
});

// ═══ E. MP3 ═════════════════════════════════════════════════════════════════════════════════════════════════════
section('E. MP3 pelo Content-Type');
await test('o servidor devolve audio/mpeg: o ffmpeg (falso aqui) converte e a fala sai; sem ffmpeg cai no local', async () => {
  omni.limpar();
  omni.definirFala({ corpo: 'mp3' });
  const vistos = [];
  const spawn = (file, args) => {
    vistos.push({ file, args });
    const child = new EventEmitter();
    child.stdout = new PassThrough();
    child.stdin = new PassThrough();
    child.kill = () => {};
    child.stdin.on('finish', () => setImmediate(() => { child.stdout.write(criarWavDeTeste({ ms: 300 }).subarray(44)); child.stdout.end(); child.emit('close', 0); }));
    return child;
  };
  const { engine } = montar({ opcoes: { spawn, getFfmpeg: () => 'ffmpeg-falso' } });
  const r = await engine.synthesize('Oi, tudo bem?', { sensitive: false });
  assert.equal(r?.provider, 'omniroute');
  assert.equal(vistos.length, 1);
  const sem = montar({ opcoes: { spawn: () => { throw new Error('sem ffmpeg'); }, getFfmpeg: () => 'ffmpeg-falso' } });
  assert.equal((await sem.engine.synthesize('Oi, tudo bem? Outra.', { sensitive: false }))?.provider, 'sapi');
});

// ═══ F. O caminho inteiro: initTts -> speakVoiceReply -> fila -> PCM do Discord ═══════════════════════════════════════
section('F. O caminho inteiro da fala (initTts, speakVoiceReply, fila, PCM do Discord)');
const deps = {
  isEnabled: () => true, isBanned: () => false, isBot: () => false, isRadioActive: () => false, isAiCallActive: () => true, isUserInSameVoice: () => true,
  canSpeakInChannel: () => true, containsForbidden: () => false, matchesTrigger: () => false, resolveName: () => 'Fulano', isOpusAvailable: () => true,
};
function filaFalsa() {
  const jobs = [];
  return {
    jobs,
    enqueue: (guildId, job) => { jobs.push({ guildId, job }); return { ok: true }; },
    getStatus: () => ({ count: 0, guilds: [] }), disposeAll() {}, dispose() { return true; }, interrupt() { return false; }, isSpeaking() { return false; },
    overlapsSpeech() { return false; }, noteHumanSpeaking() {}, warmup() {},
  };
}
const pedido = (over = {}) => ({ guildId: 'g1', userId: `u${Math.random().toString(36).slice(2, 8)}`, text: 'Oi, tudo bem? Hoje faz sol.', transcript: 'oi yui tudo bem', sensitive: false, requestedAt: Date.now(), fromVoice: true, ...over });
const subir = async (extra = {}) => {
  await shutdownTts(); // um teste que falhou no meio não deixa o serviço ligado para o seguinte
  const fila = filaFalsa();
  const r = await initTts({ deps, overrides: { env: { YUI_TTS_ENABLED: 'true', YUI_TTS_USER_GAP_SECONDS: '0', YUI_TTS_USER_PER_MIN: '60', YUI_TTS_GUILD_PER_MIN: '120', YUI_TTS_GLOBAL_PER_MIN: '240', ...envIA(), ...extra }, manager: fila, logger } });
  return { fila, r };
};
await test('com YUI_TTS_OMNIROUTE=true e a ordem "omniroute": a fala vira PCM do Discord pelo OmniRoute; sensível nem é falado na call; o status não tem segredo', async () => {
  omni.limpar();
  const { fila, r } = await subir({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_PROVIDERS: 'omniroute' });
  assert.equal(r.enabled, true);
  assert.deepEqual(r.providers.map((p) => [p.name, p.ok]), [['omniroute', true]]);
  const res = speakVoiceReply(pedido());
  assert.equal(res.ok, true, res.reason);
  assert.equal(fila.jobs.length, 1);
  const { job } = fila.jobs[0];
  assert.ok(job.count >= 1);
  const pcm = await job.synth(0, new AbortController().signal);
  assert.ok(Buffer.isBuffer(pcm) && pcm.length > 0 && pcm.length % DISCORD_FRAME_BYTES === 0);
  assert.equal(omni.falas.length, 1);
  assert.ok(omni.falas[0].texto.startsWith(`${DEFAULT_OMNIROUTE_STYLE}: Oi, tudo bem?`));
  assert.equal(omni.falas[0].voz, 'Leda');
  // conteúdo sensível: a fala de call pública nunca acontece (a regra de sempre), e nada vai ao OmniRoute
  const sens = speakVoiceReply(pedido({ sensitive: true }));
  assert.deepEqual([sens.ok, sens.reason], [false, 'sensitive']);
  assert.equal(omni.falas.length, 1);
  const st = getTtsStatus();
  assert.equal(st.omniroute.used, 1);
  assert.equal(st.omniroute.cap, 400);
  assert.equal(st.omniroute.enabled, true);
  assert.equal(st.omniroute.sensitive, false);
  assert.ok(st.omniroute.lastMs >= 0);
  const json = JSON.stringify(st);
  for (const proibido of [CHAVE_GERAL, '127.0.0.1', 'Bearer', 'Oi, tudo bem']) assert.ok(!json.includes(proibido), `o status vazou "${proibido}"`);
  await shutdownTts();
});
await test('no caminho da call a resposta com chave nem chega ao motor (a regra de dado pessoal de sempre) e nada vai ao OmniRoute', async () => {
  omni.limpar();
  const { fila } = await subir({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_PROVIDERS: 'omniroute' });
  const res = speakVoiceReply(pedido({ text: 'A chave é sk-proj-abcdefghijklmnopqrstuvwx1234, anote.' }));
  assert.deepEqual([res.ok, res.reason], [false, 'pii']);
  assert.equal(fila.jobs.length, 0);
  assert.equal(omni.falas.length, 0);
  await shutdownTts();
});
await test('OmniRoute falhando: a fala vira só texto (o motor devolve null), sem erro e sem rejeição solta', async () => {
  omni.limpar();
  omni.definirFala({ status: 500 });
  const { fila } = await subir({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_PROVIDERS: 'omniroute' });
  assert.equal(speakVoiceReply(pedido()).ok, true);
  const pcm = await fila.jobs[0].job.synth(0, new AbortController().signal);
  assert.equal(pcm, null);
  await shutdownTts();
});
await test('sem YUI_TTS_OMNIROUTE (padrão) o provedor fica na ordem mas fechado: nada sai e a fala diz tts-off', async () => {
  omni.limpar();
  const { r } = await subir({ YUI_TTS_PROVIDERS: 'omniroute' });
  assert.equal(r.enabled, true);
  assert.equal(r.providers[0].ok, false);
  const res = speakVoiceReply(pedido());
  assert.deepEqual([res.ok, res.reason], [false, 'tts-off']);
  assert.equal(omni.falas.length, 0);
  await shutdownTts();
});
await test('a ordem padrão com YUI_TTS_OMNIROUTE=true põe o omniroute na frente; ligado e fora da ordem escrita avisa no log', async () => {
  omni.limpar();
  const antes = todasAsLinhas.length;
  const { r } = await subir({ YUI_TTS_OMNIROUTE: 'true', YUI_TTS_PROVIDERS: 'azure' });
  assert.equal(r.enabled, true);
  assert.ok(todasAsLinhas.slice(antes).some((l) => l.includes('YUI_TTS_OMNIROUTE=true') && l.includes('não está em YUI_TTS_PROVIDERS')));
  assert.equal(getTtsStatus().omniroute, undefined, 'fora da ordem: sem bloco do OmniRoute no status');
  await shutdownTts();
  const dois = await subir({ YUI_TTS_OMNIROUTE: 'true' });
  assert.equal(dois.r.providers[0].name, 'omniroute', 'o primeiro da ordem padrão');
  assert.ok(todasAsLinhas.some((l) => l.includes('OmniRoute ligado: modelo=google') && l.includes('sensivel=nao') && l.includes('teto_dia=400')));
  await shutdownTts();
});

// ═══ G. Fim ══════════════════════════════════════════════════════════════════════════════════════════════════════
await omni.close();
await test('nenhuma rejeição ou exceção solta no teste todo', async () => {
  await new Promise((r) => setImmediate(r));
  assert.deepEqual(escapou, []);
});

console.log(`\n${ok} testes OK${fail ? `, ${fail} falha(s): ${failures.join('; ')}` : ''}`);
process.exit(fail ? 1 : 0);
