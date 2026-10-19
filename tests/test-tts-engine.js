// Testes da política e do motor do TTS (src/services/tts/policy.js e engine.js).
// Sem rede, sem Discord, sem banco e sem espera real: relógio, timers e provedores são falsos.
// Execução: node tests/test-tts-engine.js
import assert from 'assert';
import { performance } from 'perf_hooks';
import { getTtsConfig, KNOWN_PROVIDERS, PLANNED_PROVIDERS } from '../src/services/tts/config.js';
import * as policy from '../src/services/tts/policy.js';
import { createEngine } from '../src/services/tts/engine.js';

// A lista de bloqueio é do dono (blocklist.pt-BR.json, "pode editar à vontade"): os testes usam esta CÓPIA fixa
// e só o teste de fumaça "lista de bloqueio real carrega..." lê o arquivo. Assim esvaziar a lista ou tirar uma
// palavra do arquivo não reprova nada aqui.
const TEST_BLOCKLIST = [
  'porra', 'caralho', 'buceta', 'xoxota', 'piroca', 'pirocudo', 'punheta', 'cuzao', 'arrombado', 'arrombada', 'fdp', 'pqp',
  'vsf', 'tnc', 'puta', 'putas', 'putaria', 'putinha', 'viadinho', 'viado', 'bicha', 'traveco', 'sapatao', 'nigger', 'nigga',
  'merda', 'fodase', 'retardado', 'retardada', 'mongoloide', 'crioulo', 'crioula', 'macumbeiro', 'nazista', 'heil',
  'filho da puta', 'filha da puta', 'puta que pariu', 'puta merda', 'vai tomar no cu', 'tomar no cu', 'vai se foder',
  'foda-se', 'vai se matar', 'se mata', 'se mate', 'volta pra senzala', 'sieg heil', 'heil hitler', 'white power', 'poder branco',
];
policy.setBlocklistForTests(TEST_BLOCKLIST);

let passed = 0;
let failed = 0;
const stray = []; // qualquer promessa rejeitada sem tratamento reprova o teste
process.on('unhandledRejection', (e) => stray.push(`unhandledRejection: ${e?.message ?? e}`));
process.on('uncaughtException', (e) => stray.push(`uncaughtException: ${e?.message ?? e}`));

async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ok     ${name}`);
  } catch (e) {
    failed++;
    console.log(`  FALHA  ${name}\n         ${String(e?.message ?? e).split('\n')[0]}`);
  }
}
const section = (title) => console.log(`\n${title}`);
const tick = () => new Promise((r) => setImmediate(r));
const ZWSP = String.fromCharCode(0x200b); // espaço de largura zero
const CYR_A = String.fromCharCode(0x430); // 'а' cirílico, igual ao 'a' latino
const abortErr = () => Object.assign(new Error('aborted'), { code: 'ABORTED' });

function fakeClock(start = 1_000_000) {
  let t = start;
  const now = () => t;
  now.advance = (ms) => { t += ms; };
  return now;
}

function fakeTimers() {
  let id = 0;
  const pending = new Map();
  return {
    pending,
    seen: [], // todos os prazos já pedidos, na ordem
    setTimeout(fn, ms) { const h = ++id; this.seen.push(ms); pending.set(h, { fn, ms }); return h; },
    clearTimeout(h) { pending.delete(h); },
    delays: () => [...pending.values()].map((t) => t.ms),
    fireAll() {
      const items = [...pending.values()];
      pending.clear();
      for (const t of items) t.fn();
    },
  };
}

// ── decideSpeak ───────────────────────────────────────────────────────

function makeDeps(over = {}) {
  return {
    isEnabled: () => true,
    isBanned: () => false,
    isBot: () => false,
    isRadioActive: () => false,
    isAiCallActive: () => true,
    isUserInSameVoice: () => true,
    canSpeakInChannel: () => true,
    containsForbidden: () => false,
    matchesTrigger: () => false,
    resolveName: () => 'Fulano',
    isOpusAvailable: () => true,
    ...over,
  };
}

function ctx(cfgOver = {}) {
  const clock = fakeClock();
  const cfg = { ...getTtsConfig({}), ...cfgOver };
  const limiter = policy.createLimiter({ config: cfg, now: clock });
  return { clock, cfg, limiter, state: { limiter, now: clock, cfg } };
}
const makeReq = (clock, over = {}) => ({
  guildId: 'g1', userId: 'u1', text: 'Canberra.', sensitive: false, requestedAt: clock(), fromVoice: true, ...over,
});

section('decideSpeak: um caso por razão');

await test('tudo certo => ok', () => {
  const c = ctx();
  assert.deepStrictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), c.state), { ok: true, reason: 'ok' });
});

const reasonCases = [
  ['tts-off (YUI_TTS_ENABLED=false)', { cfg: { enabled: false } }, null, 'tts-off'],
  ['tts-off (sem Opus)', {}, { isOpusAvailable: () => false }, 'tts-off'],
  ['not-voice (fromVoice falso)', { req: { fromVoice: false } }, null, 'not-voice'],
  ['not-voice (fromVoice ausente)', { req: { fromVoice: undefined } }, null, 'not-voice'],
  ['not-voice (texto "true" não vale)', { req: { fromVoice: 'true' } }, null, 'not-voice'],
  ['guild-disabled', {}, { isEnabled: () => false }, 'guild-disabled'],
  ['no-connection', {}, { isAiCallActive: () => false }, 'no-connection'],
  ['bot-user', {}, { isBot: () => true }, 'bot-user'],
  ['banned (objeto de ban)', {}, { isBanned: () => ({ reason: 'x' }) }, 'banned'],
  ['user-not-in-call', {}, { isUserInSameVoice: () => false }, 'user-not-in-call'],
  ['radio-active', {}, { isRadioActive: () => true }, 'radio-active'],
  ['sensitive (true)', { req: { sensitive: true } }, null, 'sensitive'],
  ['sensitive (ausente conta como sensível)', { req: { sensitive: undefined } }, null, 'sensitive'],
  ['sensitive (texto "false" não vale)', { req: { sensitive: 'false' } }, null, 'sensitive'],
  ['no-speak-permission', {}, { canSpeakInChannel: () => false }, 'no-speak-permission'],
  ['bad-request (sem userId)', { req: { userId: '' } }, null, 'bad-request'],
];
for (const [name, o, depsOver, reason] of reasonCases) {
  await test(name, () => {
    const c = ctx(o.cfg || {});
    const r = policy.decideSpeak(makeReq(c.clock, o.req || {}), makeDeps(depsOver || {}), c.state);
    assert.strictEqual(r.ok, false);
    assert.strictEqual(r.reason, reason);
  });
}

await test('tts-off quando o módulo não tem provedor (state.hasProviders === false)', () => {
  const c = ctx();
  c.state.hasProviders = false;
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), c.state).reason, 'tts-off');
});

await test('stale: 30 s ainda vale, 30,001 s não; data inválida ou futura = stale', () => {
  const c = ctx();
  const at = (ms) => policy.decideSpeak(makeReq(c.clock, { requestedAt: c.clock() - ms }), makeDeps(), c.state);
  assert.strictEqual(at(30_000).ok, true);
  assert.strictEqual(at(30_001).reason, 'stale');
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock, { requestedAt: NaN }), makeDeps(), c.state).reason, 'stale');
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock, { requestedAt: undefined }), makeDeps(), c.state).reason, 'stale');
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock, { requestedAt: c.clock() + 60_000 }), makeDeps(), c.state).reason, 'stale');
});

await test('stale respeita YUI_TTS_STALE_SECONDS da configuração', () => {
  const c = ctx({ staleSeconds: 10 });
  const r = policy.decideSpeak(makeReq(c.clock, { requestedAt: c.clock() - 11_000 }), makeDeps(), c.state);
  assert.strictEqual(r.reason, 'stale');
});

await test('rate-user-gap: 1 fala a cada 6 s por usuário (limite exato)', () => {
  const c = ctx();
  c.limiter.recordSpeech('g1', 'u1', 3);
  c.clock.advance(5_999);
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), c.state).reason, 'rate-user-gap');
  c.clock.advance(1);
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), c.state).ok, true);
});

await test('rate-user: 5 por minuto, janela deslizante', () => {
  const c = ctx();
  for (let i = 0; i < 5; i++) { c.limiter.recordSpeech('g1', 'u1', 3); c.clock.advance(7_000); }
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), c.state).reason, 'rate-user');
  c.clock.advance(25_000); // a 1ª fala (há 60 s) sai da janela
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), c.state).ok, true);
});

await test('rate-guild: 8 por minuto no servidor, de pessoas diferentes', () => {
  const c = ctx();
  for (let i = 1; i <= 8; i++) { c.limiter.recordSpeech('g1', `x${i}`, 2); c.clock.advance(100); }
  const r = policy.decideSpeak(makeReq(c.clock, { userId: 'novo' }), makeDeps(), c.state);
  assert.strictEqual(r.reason, 'rate-guild');
  const outro = policy.decideSpeak(makeReq(c.clock, { guildId: 'g2', userId: 'novo' }), makeDeps(), c.state);
  assert.strictEqual(outro.ok, true, 'outro servidor não é afetado');
});

await test('rate-global: 12 por minuto somando servidores', () => {
  const c = ctx();
  for (let i = 1; i <= 6; i++) c.limiter.recordSpeech('g1', `a${i}`, 2);
  for (let i = 1; i <= 6; i++) c.limiter.recordSpeech('g2', `b${i}`, 2);
  const r = policy.decideSpeak(makeReq(c.clock, { guildId: 'g3', userId: 'novo' }), makeDeps(), c.state);
  assert.strictEqual(r.reason, 'rate-global');
  c.clock.advance(60_000);
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock, { guildId: 'g3', userId: 'novo' }), makeDeps(), c.state).ok, true);
});

await test('rate-budget: 120 s falados por servidor a cada 10 min', () => {
  const c = ctx();
  for (let i = 1; i <= 5; i++) { c.limiter.recordSpeech('g1', `p${i}`, 25); c.clock.advance(20_000); }
  const r = policy.decideSpeak(makeReq(c.clock, { userId: 'novo' }), makeDeps(), c.state);
  assert.strictEqual(r.reason, 'rate-budget');
  c.clock.advance(10 * 60_000);
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock, { userId: 'novo' }), makeDeps(), c.state).ok, true);
});

await test('ordem dos portões: a primeira razão que falha é a devolvida', () => {
  const c = ctx({ enabled: false });
  const req = makeReq(c.clock, { fromVoice: false, sensitive: true, requestedAt: c.clock() - 99_000 });
  const deps = makeDeps({
    isOpusAvailable: () => false, isEnabled: () => false, isAiCallActive: () => false, isBot: () => true,
    isBanned: () => true, isUserInSameVoice: () => false, isRadioActive: () => true, canSpeakInChannel: () => false,
  });
  c.limiter.recordSpeech('g1', 'u1', 1);
  const seen = [];
  const step = (fix) => { seen.push(policy.decideSpeak(req, deps, c.state).reason); fix(); };
  step(() => { c.cfg.enabled = true; });
  step(() => { deps.isOpusAvailable = () => true; });
  step(() => { req.fromVoice = true; });
  step(() => { deps.isEnabled = () => true; });
  step(() => { deps.isAiCallActive = () => true; });
  step(() => { deps.isBot = () => false; });
  step(() => { deps.isBanned = () => false; });
  step(() => { deps.isUserInSameVoice = () => true; });
  step(() => { deps.isRadioActive = () => false; });
  step(() => { req.sensitive = false; });
  step(() => { req.requestedAt = c.clock(); });
  step(() => { c.clock.advance(6_000); });
  seen.push(policy.decideSpeak(req, deps, c.state).reason);
  assert.deepStrictEqual(seen, [
    'tts-off', 'tts-off', 'not-voice', 'guild-disabled', 'no-connection', 'bot-user', 'banned',
    'user-not-in-call', 'radio-active', 'sensitive', 'stale', 'rate-user-gap', 'no-speak-permission',
  ]);
});

await test('as dependências recebem os argumentos na ordem do contrato', () => {
  const c = ctx();
  const calls = {};
  const spy = (name, ret) => (...a) => { calls[name] = a; return ret; };
  const deps = {
    isOpusAvailable: spy('isOpusAvailable', true), isEnabled: spy('isEnabled', true), isAiCallActive: spy('isAiCallActive', true),
    isBot: spy('isBot', false), isBanned: spy('isBanned', false), isUserInSameVoice: spy('isUserInSameVoice', true),
    isRadioActive: spy('isRadioActive', false), canSpeakInChannel: spy('canSpeakInChannel', true),
  };
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock, { guildId: 'G', userId: 'U' }), deps, c.state).ok, true);
  assert.deepStrictEqual(calls.isEnabled, ['G']);
  assert.deepStrictEqual(calls.isAiCallActive, ['G']);
  assert.deepStrictEqual(calls.isBot, ['U', 'G']);
  assert.deepStrictEqual(calls.isBanned, ['U', 'G']);
  assert.deepStrictEqual(calls.isUserInSameVoice, ['G', 'U']);
  assert.deepStrictEqual(calls.isRadioActive, ['G']);
  assert.deepStrictEqual(calls.canSpeakInChannel, ['G']);
});

section('decideSpeak: falha fechada');

const depReasons = [
  ['isOpusAvailable', 'tts-off'], ['isEnabled', 'guild-disabled'], ['isAiCallActive', 'no-connection'],
  ['isBot', 'bot-user'], ['isBanned', 'banned'], ['isUserInSameVoice', 'user-not-in-call'],
  ['isRadioActive', 'radio-active'], ['canSpeakInChannel', 'no-speak-permission'],
];
for (const [dep, reason] of depReasons) {
  await test(`${dep} que LANÇA => nega (${reason})`, () => {
    const c = ctx();
    const r = policy.decideSpeak(makeReq(c.clock), makeDeps({ [dep]: () => { throw new Error('boom'); } }), c.state);
    assert.deepStrictEqual(r, { ok: false, reason });
  });
  await test(`${dep} assíncrona (devolve promessa) => nega (${reason}) sem rejeição solta`, async () => {
    const c = ctx();
    const r = policy.decideSpeak(makeReq(c.clock), makeDeps({ [dep]: async () => { throw new Error('boom'); } }), c.state);
    assert.deepStrictEqual(r, { ok: false, reason });
    await tick();
  });
  await test(`${dep} ausente => nega (${reason})`, () => {
    const c = ctx();
    const deps = makeDeps();
    delete deps[dep];
    assert.deepStrictEqual(policy.decideSpeak(makeReq(c.clock), deps, c.state), { ok: false, reason });
  });
}

await test('entradas inválidas nunca lançam e negam', () => {
  const c = ctx();
  assert.strictEqual(policy.decideSpeak(null, makeDeps(), c.state).ok, false);
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), null, c.state).ok, false);
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), null).ok, false);
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), { cfg: c.cfg, now: c.clock }).ok, false, 'sem limitador');
  const limiterQueQuebra = { check() { throw new Error('x'); } };
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps(), { ...c.state, limiter: limiterQueQuebra }).ok, false);
});

section('Limitador: janelas e memória');

await test('entradas velhas são limpas e o mapa tem teto', () => {
  const c = ctx();
  for (let i = 0; i < 3000; i++) c.limiter.recordSpeech(`g${i % 50}`, `u${i}`, 1);
  assert.ok(c.limiter.size().users > 0);
  c.clock.advance(11 * 60_000);
  c.limiter.recordSpeech('gx', 'ux', 1);
  const s = c.limiter.size();
  assert.ok(s.users <= 2 && s.guilds <= 2 && s.global === 1, `sobrou ${JSON.stringify(s)}`);
  for (let i = 0; i < 6500; i++) c.limiter.recordSpeech('g1', `mass${i}`, 1);
  assert.ok(c.limiter.size().users <= 5000, 'teto de chaves');
});

await test('segundos inválidos (NaN, negativo, Infinity) não quebram o orçamento', () => {
  const c = ctx();
  for (const s of [NaN, -5, Infinity, undefined, 'abc']) c.limiter.recordSpeech('g1', `u${String(s)}`, s);
  assert.doesNotThrow(() => c.limiter.check('g1', 'ux'));
  c.limiter.reset();
  assert.deepStrictEqual(c.limiter.size(), { users: 0, guilds: 0, global: 0 });
});

await test('relógio que anda para trás não trava o usuário', () => {
  const c = ctx();
  c.limiter.recordSpeech('g1', 'u1', 1);
  c.clock.advance(-120_000);
  assert.strictEqual(c.limiter.check('g1', 'u1').ok, true);
});

// ── checkSpeakableText ────────────────────────────────────────────────

const check = (text, over = {}, opts) => policy.checkSpeakableText(text, makeDeps(over), opts);
const reasonOf = (text, over, opts) => check(text, over, opts).reason;

section('checkSpeakableText: erro/sistema');
await test('resposta normal passa', () => {
  assert.deepStrictEqual(check('Canberra, não Sydney.'), { ok: true, reason: 'ok' });
  assert.strictEqual(check('Erro de português é comum, fique tranquilo.').ok, true);
});
await test('not-speakable: vazio, só símbolos, tipo errado, gigante', () => {
  for (const t of ['', '   ', '🙂🙂', '...', null, undefined, 123, {}, 'x'.repeat(20_001)]) {
    assert.strictEqual(reasonOf(t), 'not-speakable', String(t).slice(0, 20));
  }
});
await test('system-text: marcadores de erro, fila e limites', () => {
  for (const t of [
    '⚠️ Algo deu errado.', '❌ Falhou.', '⏳ Aguarde um pouco.', '⚡ Muito rápido.', '🛑 Parei.', '🚨 Alerta!',
    '**⚠️ Aviso**: tente depois', '> ❌ Erro', '-# ⏳ fila', '  ⚠ sem seletor',
    'Limites de Processamento Atingidos. Tente mais tarde.', 'Sua solicitação está na fila.',
    'Ocorreu um erro ao processar.', 'Erro: não achei.',
  ]) assert.strictEqual(reasonOf(t), 'system-text', t);
});

section('checkSpeakableText: dados pessoais');
await test('pii: e-mail (escrito, com espaços, falado)', () => {
  for (const t of [
    'joao@gmail.com', 'fale com maria.silva+x@empresa.com.br hoje', 'joão @ gmail.com',
    'meu email é joao arroba gmail ponto com', 'fulano ARROBA hotmail', 'escreva para ana arroba empresa ponto com ponto br',
  ]) assert.strictEqual(reasonOf(t), 'pii', t);
});
await test('pii: telefone BR, CPF, CNPJ, IPv4, cartão, token, 9+ dígitos', () => {
  for (const t of [
    '(11) 91234-5678', '11 91234-5678', '+55 11 91234-5678', '11912345678', '91234-5678', '3333-4444', '(21) 3333-4444',
    '123.456.789-09', '12345678909', '12.345.678/0001-95', '12345678000195',
    '192.168.0.1', 'o servidor é 10.0.0.255 ok',
    '4111 1111 1111 1111',
    'ghp_abcdefghijklmnopqrstuvwxyz123456', 'sk-abcdefghijklmnopqrstuvwxyzabcdef', 'AKIAABCDEFGHIJKLMNOP', 'aB3dE5gH7jK9mN1pQ3sT5vX7zA9', 'AbCdEfGhIjKlMnOpQrStUvWxYz', 'MTIzNDU2Nzg5MDEyMzQ1Njc4.GabcDE.xKq9ZpLmNoPqRsTuVwXyZ01234',
    '123456789', 'protocolo 987654321012',
    '1 2 3 4 5 6 7 8 9',
  ]) assert.strictEqual(reasonOf(t), 'pii', t);
});
await test('pii: 9+ numerais por extenso em sequência (e IP falado)', () => {
  for (const t of [
    'cinco cinco um um nove nove nove nove oito',
    'onze, nove, oito, sete, seis, cinco, quatro, três e dois',
    'Zero Um Dois Três Quatro Cinco Seis Sete Oito',
    'cento e noventa e dois ponto cento e sessenta e oito ponto zero ponto um',
    'cento e vinte e três milhões quatrocentos e cinquenta e seis mil setecentos e oitenta e nove',
    'um bilhão duzentos e trinta e quatro milhões quinhentos e sessenta e sete mil oitocentos e noventa',
  ]) assert.strictEqual(reasonOf(t), 'pii', t);
});
await test('pii: texto parecido mas inofensivo NÃO bloqueia', () => {
  for (const t of [
    'Hoje é 14/10/2026.', 'Custa R$ 1.234,56.', 'dois mil e vinte e seis', 'catorze de outubro de dois mil e vinte e seis',
    'cento e vinte e três mil quatrocentos e cinquenta e seis', 'No ano de 2026 foi assim.', 'versão 2.1 saiu', 'às 12:30',
    'hahahahahahahahahahahahahahahaha', 'kkkkkkkkkkkkkkkkkkkkkkkkkkkkkk', '2024-2025 foi uma boa temporada',
    '<@123456789012345678> tudo bem?', 'olha https://example.com/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa123456789012 isso',
    'um dois três', 'Chame no canal <#123456789012345678>.', 'anticonstitucionalissimamente', 'getUserAccountSettingsHandler',
    'um milhão trezentos e quarenta e cinco mil seiscentos e setenta e oito visualizações', 'mil novecentos e oitenta e quatro',
  ]) assert.strictEqual(check(t).ok, true, t);
});
await test('pii: sinais escondidos por caracteres invisíveis e largura total', () => {
  assert.strictEqual(reasonOf('joao' + ZWSP + '@gmail.com'), 'pii');
  assert.strictEqual(reasonOf('１２３４５６７８９０'), 'pii');
});
await test('findPii informa o tipo (só metadado)', () => {
  assert.strictEqual(policy.findPii('a@b.com'), 'email');
  assert.strictEqual(policy.findPii('123456789'), 'digits');
  assert.strictEqual(policy.findPii('oi'), null);
  assert.strictEqual(policy.hasPii('oi'), false);
  assert.strictEqual(policy.hasPii('a@b.com'), true);
});

section('checkSpeakableText: palavras bloqueadas (só impedem de falar)');
await test('lista própria: variações e disfarces', () => {
  for (const t of [
    'que porra é essa', 'P0RR4!', 'p o r r a', 'porrrrrra', 'po' + ZWSP + 'rra', 'ｐｏｒｒａ', 'pórra', 'p.o.r.r.a', 'p-o-r-r-a',
    'vai tomar no cu', 'VAI TOMAR NO CU', 'bu ceta', 'essa é a p u t a', 'caralhooo', 'caralhos', 'seu arrombado', 'mongoloide',
    'sieg heil', 'Heil Hitler', 'c' + CYR_A + 'ralho' /* a cirílico */, 'f d p', 'filho da puta',
  ]) assert.strictEqual(reasonOf(t), 'blocked-word', t);
});
await test('lista própria: palavras comuns que contêm trechos parecidos NÃO bloqueiam', () => {
  for (const t of [
    'o computador está ligado', 'ele disputaria o título', 'reputaria bem', 'a classe passou', 'Mercedes e Cassandra',
    'uma saia de seda', 'o pintor pintou a parede', 'concurso de arte', 'o assassinato do Rei foi ontem' /* não é lista própria */,
  ]) assert.strictEqual(check(t).ok, true, t);
});
await test('containsForbidden injetada bloqueia SEM banir ninguém (nenhum addBan)', () => {
  let addBanCalls = 0;
  const addBan = () => { addBanCalls++; };
  const seen = [];
  const containsForbidden = (text) => { seen.push(text); return /\bbanana\b|\bporn\b/.test(text); };
  assert.strictEqual(reasonOf('eu gosto de banana', { containsForbidden }), 'blocked-word');
  assert.strictEqual(reasonOf('p0rn', { containsForbidden }), 'blocked-word', 'também recebe o texto sem leet');
  assert.strictEqual(check('eu gosto de maçã', { containsForbidden }).ok, true);
  assert.ok(seen.length >= 3);
  assert.strictEqual(addBanCalls, 0);
  void addBan;
});
await test('containsForbidden que lança, é assíncrona ou ausente => nega', () => {
  assert.strictEqual(reasonOf('oi', { containsForbidden: () => { throw new Error('x'); } }), 'blocked-word');
  assert.strictEqual(reasonOf('oi', { containsForbidden: async () => false }), 'blocked-word');
  const deps = makeDeps();
  delete deps.containsForbidden;
  assert.strictEqual(policy.checkSpeakableText('oi', deps).reason, 'blocked-word');
});
await test('isBlockedSpeech com lista extra (e sem número curto que bloqueia tudo)', () => {
  assert.strictEqual(policy.isBlockedSpeech('o código 1488 apareceu', { extra: ['1488'] }), true);
  assert.strictEqual(policy.isBlockedSpeech('tenho 18 anos', { extra: ['18+'] }), false);
  assert.strictEqual(policy.isBlockedSpeech('ku  klux   klan', { extra: ['ku klux klan'] }), true);
  assert.strictEqual(policy.isBlockedSpeech(''), false);
  assert.strictEqual(policy.isBlockedSpeech(null), false);
  assert.strictEqual(policy.isBlockedSpeech('porra', null), true, 'segundo argumento nulo não quebra');
});

section('checkSpeakableText: gatilho, ferramenta, eco');
await test('self-trigger: o texto aciona a Yui de novo', () => {
  const matchesTrigger = (t) => /\b(yui|ricardo)\b/i.test(t);
  assert.strictEqual(reasonOf('Oi, Yui!', { matchesTrigger }), 'self-trigger');
  assert.strictEqual(check('Canberra.', { matchesTrigger }).ok, true);
  assert.strictEqual(reasonOf('oi', { matchesTrigger: () => { throw new Error('x'); } }), 'self-trigger');
  assert.strictEqual(reasonOf('oi', { matchesTrigger: async () => false }), 'self-trigger');
});
await test('tool-json: JSON de ferramenta nunca é falado', () => {
  for (const t of [
    '{"tool":"play_music","args":{"query":"x"}}',
    'default_api.search(query="gta")',
    '[Tool Use: play_music]',
    '```json\n{"name":"play","arguments":{"q":"x"}}\n```',
    '{"tool_calls":[{"id":"1"}]}',
    '[{"function":"play","args":{"a":"b"}}]',
    'Vou chamar <tool_call> agora',
  ]) assert.strictEqual(reasonOf(t), 'tool-json', t);
  assert.strictEqual(check('Use a ferramenta de busca quando precisar.').ok, true);
  assert.strictEqual(check('O conjunto {um, dois} é finito.').ok, true);
});
await test('json-text: JSON / dado estruturado que escapou como "resposta" nunca é falado (nem truncado); frase com chaves ou colchetes no meio é', () => {
  for (const t of [
    '{"response": "Oi, tudo bem por aqui?"', // JSON truncado (sem a chave de fechamento)
    '{"foo":"bar","x":1}',
    '["Canberra","Sydney"]',
    "['Canberra', 'Sydney']",
    '[{"nome":"Ana"},{"nome":"Beto"}]',
    '  \n  {"resposta":"Paris"}',
    '```json\n{"resposta":"Paris"}\n```',
    'Resposta: "response": "Oi, tudo bem por aqui?" e mais nada',
    'Os dados são "idade": 30 e pronto',
    'campo "ativo": true, depois o resto',
    "valor 'nome': null no registro",
  ]) {
    assert.strictEqual(policy.looksLikeStructuredText(t), true, t);
    assert.strictEqual(reasonOf(t), 'json-text', t);
  }
  for (const t of [
    'Canberra, não Sydney.',
    'O conjunto {um, dois} é finito.',
    '[Risos] foi uma boa piada.',
    'Veja o item [1] da lista.',
    'Ele disse "oi" e saiu.',
    'Ele disse "oi": que bom te ver.', // aspas + dois-pontos, mas o valor não é aspas/número/objeto
    'A razão é simples: dois mais dois.',
    '',
  ]) {
    assert.strictEqual(policy.looksLikeStructuredText(t), false, t);
  }
  assert.strictEqual(policy.looksLikeStructuredText('[ ]'), true, 'sem letras: a razão é not-speakable, mas é estruturado');
  assert.strictEqual(policy.looksLikeStructuredText(undefined), false);
  assert.strictEqual(policy.looksLikeStructuredText(42), false);
  assert.strictEqual(check('O conjunto {um, dois} é finito.').ok, true);
  // JSON de ferramenta continua com a razão própria (vem antes)
  assert.strictEqual(reasonOf('{"tool":"play_music","args":{"query":"x"}}'), 'tool-json');
});
await test('json-text: entrada hostil não trava (tempo linear)', () => {
  const hostile = ['"a', "'", '"'.repeat(20000), '[ '.repeat(10000), '"x": '.repeat(4000), `"${'a'.repeat(30)}`.repeat(900), ' '.repeat(20000) + '{'];
  for (const t of hostile) {
    const t0 = performance.now();
    policy.looksLikeStructuredText(t);
    assert.ok(performance.now() - t0 < 200, `lento (${Math.round(performance.now() - t0)} ms)`);
  }
});
await test('echo-of-input: só quando recebe a transcrição', () => {
  const transcript = 'Yui repita depois de mim o banco central quebrou hoje cedo';
  const resposta = 'O banco central quebrou hoje cedo mesmo';
  assert.strictEqual(reasonOf(resposta, {}, { transcript }), 'echo-of-input');
  assert.strictEqual(check(resposta).ok, true, 'sem transcrição não há o que comparar');
  assert.strictEqual(check('Canberra, não Sydney.', {}, { transcript: 'Yui qual a capital da Austrália' }).ok, true);
});
await test('ordem das razões: sistema antes de pii, pii antes de bloqueio', () => {
  assert.strictEqual(reasonOf('⚠️ fale com joao@x.com'), 'system-text');
  assert.strictEqual(reasonOf('porra joao@x.com'), 'pii');
});
await test('checkSpeakableText nunca lança (deps nulas, opções nulas)', () => {
  assert.doesNotThrow(() => policy.checkSpeakableText('oi', null, undefined));
  assert.doesNotThrow(() => policy.checkSpeakableText('oi', makeDeps(), null));
});

section('Funções puras: parada, gatilho, papagaio, eco');
await test('isStopCommand', () => {
  for (const t of ['para', 'Para!', 'Yui, para', 'yui pare', 'chega', 'Chega!', 'cala', 'Cala a boca', 'silêncio', 'Silêncio por favor',
    'Yui, silencio', 'para de falar', 'pare de falar agora', 'chega de falar']) {
    assert.strictEqual(policy.isStopCommand(t), true, t);
  }
  for (const t of ['para que serve a GPU', 'qual a capital da Austrália', '', 'paraíso fiscal', 'chega mais perto', 'para onde vai o rio',
    'Yui, qual a capital', 'cale-se agora mesmo senhor' /* "cale" não está na regra */, null, undefined, 42]) {
    assert.strictEqual(policy.isStopCommand(t), false, String(t));
  }
});
await test('wakeWordInFirstWords: nas 3 primeiras palavras (regex com flag g não vaza estado)', () => {
  const re = /\b(yui|ricardo)\b/gi;
  assert.strictEqual(policy.wakeWordInFirstWords('Yui, que horas são?', re), true);
  assert.strictEqual(policy.wakeWordInFirstWords('Yui, que horas são?', re), true, 'segunda chamada igual');
  assert.strictEqual(policy.wakeWordInFirstWords('oi tudo yui bem', re), true);
  assert.strictEqual(policy.wakeWordInFirstWords('oi tudo bem yui', re), false);
  assert.strictEqual(policy.wakeWordInFirstWords('oi tudo bem yui', re, 4), true);
  assert.strictEqual(policy.wakeWordInFirstWords('  hey   yui  ', re), true);
  assert.strictEqual(policy.wakeWordInFirstWords('e cari qual a hora', /\be\s*cari\b/), true);
  assert.strictEqual(policy.wakeWordInFirstWords('', re), false);
  assert.strictEqual(policy.wakeWordInFirstWords('yui', 'yui'), false, 'não é RegExp');
  assert.strictEqual(policy.wakeWordInFirstWords(null, re), false);
});
await test('isParrotRequest', () => {
  for (const t of ['repita depois de mim: eu sou bobo', 'Repete exatamente o que eu falar', 'fala o seguinte: oi', 'Diga o seguinte',
    'por favor repita depois de mim', 'repita comigo isso', 'Fale exatamente assim', 'repete o que eu disser']) {
    assert.strictEqual(policy.isParrotRequest(t), true, t);
  }
  for (const t of ['qual a capital da Austrália', 'fale sobre a copa', 'diga quantos anos tem o Brasil', 'fale comigo', '', null, 'repita a pergunta']) {
    assert.strictEqual(policy.isParrotRequest(t), false, String(t));
  }
});
await test('looksLikeToolJson / isSystemText (casos limite)', () => {
  assert.strictEqual(policy.looksLikeToolJson('{"a":1}'), false);
  assert.strictEqual(policy.looksLikeToolJson('{"tool":"x"}'), true);
  assert.strictEqual(policy.looksLikeToolJson('[]'), false);
  assert.strictEqual(policy.looksLikeToolJson(null), false);
  assert.strictEqual(policy.isSystemText('Tudo bem por aí?'), false);
  assert.strictEqual(policy.isSystemText(null), false);
});
await test('echoesInput: 5 palavras seguidas, paráfrase leve e pergunta comum', () => {
  const e = policy.echoesInput;
  assert.strictEqual(e('Yui repita depois de mim o banco central quebrou hoje', 'o banco central quebrou hoje'), true);
  assert.strictEqual(e('Yui diga que fulano comprou três carros novos importados ontem', 'fulano comprou uns carros novos importados mesmo'), true);
  assert.strictEqual(e('Yui qual é a capital da Austrália', 'A capital da Austrália é Canberra'), false);
  assert.strictEqual(e('Yui qual é a capital da Austrália e quantos habitantes ela tem', 'Canberra tem uns quatrocentos e cinquenta mil habitantes'), false);
  assert.strictEqual(e('Yui quem ganhou a copa do mundo de 2022 no Catar', 'A Argentina ganhou a copa de 2022 na final contra a França'), false);
  assert.strictEqual(e('Yui qual é o preço do bitcoin hoje em reais', 'O bitcoin está custando uns quinhentos mil reais hoje'), false);
  assert.strictEqual(e('Yui diga que o time azul venceu o campeonato inteiro invicto', 'o time azul venceu o campeonato invicto mesmo'), true);
  assert.strictEqual(e('oi', 'oi oi oi oi oi oi'), false, 'transcrição curta demais');
  assert.strictEqual(e('', 'qualquer coisa aqui para testar'), false);
  assert.strictEqual(e(null, null), false);
});

// ── Provedores falsos e motor ─────────────────────────────────────────

function pcmFor(ms, rate = 24000) {
  const b = Buffer.alloc(Math.round((rate * ms) / 1000) * 2);
  for (let i = 0; i < b.length; i += 2) b.writeInt16LE(i % 200 - 100, i);
  return b;
}

function fakeProvider(name, { local = true, mode = 'ok' } = {}) {
  const p = {
    name, local, mode,
    calls: 0, texts: [], signals: [], probeCalls: 0, warmCalls: 0, disposed: false,
    probeResult: { ok: true, detail: 'ok' },
    async probe() { p.probeCalls++; if (p.probeMode === 'throw') throw new Error('x'); if (p.probeMode === 'hang') return new Promise(() => {}); return p.probeResult; },
    async warmup() { p.warmCalls++; if (p.warmMode === 'throw') throw new Error('x'); },
    async synth(text, { signal } = {}) {
      p.calls++;
      p.texts.push(text);
      p.signals.push(signal);
      if (signal?.aborted) throw abortErr();
      switch (p.mode) {
        case 'ok': return { pcm: pcmFor(200), sampleRate: 24000, channels: 1 };
        case 'throw': throw Object.assign(new Error(`falhou com ${text}`), { code: 'FAKE_FAIL' });
        case 'empty': return { pcm: Buffer.alloc(0), sampleRate: 24000, channels: 1 };
        case 'short': return { pcm: Buffer.alloc(100), sampleRate: 24000, channels: 1 };
        case 'badformat': return { pcm: pcmFor(200), sampleRate: 0, channels: 3 };
        case 'aborted': throw abortErr();
        case 'u8': return { pcm: new Uint8Array(pcmFor(200)), sampleRate: 24000, channels: 1 };
        case 'trap': throw new Error('NUVEM CHAMADA');
        case 'hang': return new Promise((_, rej) => signal?.addEventListener('abort', () => rej(abortErr()), { once: true }));
        case 'hang-forever': return new Promise(() => {});
        default: throw new Error('modo desconhecido');
      }
    },
    async dispose() { p.disposed = true; },
  };
  return p;
}

function makeEngine(providers, { cfg = {}, clock = fakeClock(), timers = fakeTimers() } = {}) {
  const logs = [];
  const logger = {
    info: (m) => logs.push(['info', String(m)]),
    warn: (m) => logs.push(['warn', String(m)]),
    error: (m) => logs.push(['error', String(m)]),
  };
  const arr = Array.isArray(providers) ? providers : Object.values(providers);
  const config = { ...getTtsConfig({}), providers: arr.map((p) => p.name), ...cfg };
  const engine = createEngine({ providers, config, logger, now: clock, timers });
  return { engine, clock, timers, logs, config };
}
const names = (chain) => chain.map((p) => p.name);

section('Motor: cadeia e falhas');

await test('usa o 1º provedor da cadeia e devolve o formato do contrato', async () => {
  const a = fakeProvider('a');
  const b = fakeProvider('b');
  const { engine } = makeEngine([a, b]);
  const r = await engine.synthesize('Olá mundo');
  assert.strictEqual(r.provider, 'a');
  assert.ok(Buffer.isBuffer(r.pcm) && r.pcm.length > 0);
  assert.strictEqual(r.sampleRate, 24000);
  assert.strictEqual(r.channels, 1);
  assert.strictEqual(a.calls, 1);
  assert.strictEqual(b.calls, 0);
});

await test('a ordem vem de config.providers, não da ordem em que foram instanciados', async () => {
  const a = fakeProvider('a');
  const b = fakeProvider('b');
  const { engine } = makeEngine([a, b], { cfg: { providers: ['b', 'a'] } });
  assert.deepStrictEqual(names(engine.selectChain({ sensitive: false })), ['b', 'a']);
  assert.strictEqual((await engine.synthesize('oi')).provider, 'b');
});

for (const mode of ['throw', 'empty', 'short', 'badformat', 'aborted']) {
  await test(`cai para o próximo quando o provedor falha (${mode})`, async () => {
    const a = fakeProvider('a', { mode });
    const b = fakeProvider('b');
    const { engine } = makeEngine([a, b]);
    const r = await engine.synthesize('oi');
    assert.strictEqual(r.provider, 'b');
    assert.strictEqual(a.calls, 1);
    assert.strictEqual(engine.getStatus().providers[0].failures, 1);
  });
}

await test('Uint8Array que não é Buffer é aceito e devolvido como Buffer', async () => {
  const { engine } = makeEngine([fakeProvider('a', { mode: 'u8' })]);
  const r = await engine.synthesize('oi');
  assert.ok(Buffer.isBuffer(r.pcm));
});

await test('prazo estourado (timers falsos): aborta o provedor e cai para o próximo', async () => {
  const a = fakeProvider('a', { mode: 'hang' });
  const b = fakeProvider('b');
  const { engine, timers } = makeEngine([a, b]);
  const p = engine.synthesize('oi');
  await tick();
  assert.deepStrictEqual(timers.delays(), [15000], '1ª chamada de um provedor "frio" usa o prazo longo');
  timers.fireAll();
  const r = await p;
  assert.strictEqual(r.provider, 'b');
  assert.strictEqual(a.signals[0].aborted, true, 'o provedor recebeu o cancelamento');
  assert.strictEqual(timers.pending.size, 0, 'nenhum timer sobrando');
  assert.strictEqual(engine.getStatus().providers[0].lastError, 'TIMEOUT');
});

await test('prazo: "frio" 15 s, depois de uma síntese boa passa a 4 s (config.sapi*)', async () => {
  const a = fakeProvider('a');
  const { engine, timers } = makeEngine([a]);
  await engine.synthesize('um');
  await engine.synthesize('dois');
  assert.deepStrictEqual(timers.seen, [15000, 4000]);
});

await test('prazo por provedor via config (<nome>TimeoutMs) e genérico (providerTimeoutMs)', async () => {
  const a = fakeProvider('a');
  const b = fakeProvider('b');
  const { engine, timers } = makeEngine([a, b], { cfg: { aTimeoutMs: 1234, aColdTimeoutMs: 1234, providerTimeoutMs: 777, providerColdTimeoutMs: 777 } });
  a.mode = 'throw';
  await engine.synthesize('x');
  assert.deepStrictEqual(timers.seen, [1234, 777]);
});

await test('tudo falha => null (sem lançar) e uma só linha de aviso', async () => {
  const { engine, logs } = makeEngine([fakeProvider('a', { mode: 'throw' }), fakeProvider('b', { mode: 'empty' })]);
  assert.strictEqual(await engine.synthesize('oi'), null);
  assert.strictEqual(await engine.synthesize('oi'), null);
  assert.strictEqual(logs.filter(([, m]) => m.includes('Todos os provedores falharam')).length, 1);
});

await test('texto vazio, só símbolos de limpeza ou grande demais => null sem chamar provedor', async () => {
  const a = fakeProvider('a');
  const { engine } = makeEngine([a]);
  assert.strictEqual(await engine.synthesize(''), null);
  assert.strictEqual(await engine.synthesize('  {} [] @ '), null);
  assert.strictEqual(await engine.synthesize(null), null);
  assert.strictEqual(await engine.synthesize('a'.repeat(1001)), null);
  assert.strictEqual(a.calls, 0);
});

await test('{ } [ ] @ e controles saem do texto antes de chegar ao provedor', async () => {
  const a = fakeProvider('a');
  const { engine } = makeEngine([a]);
  await engine.synthesize('olá {x} [y] @fulano \u0007 tudo   bem');
  assert.strictEqual(a.texts[0], 'olá x y fulano tudo bem');
});

section('Motor: disjuntor');

await test('abre após 3 falhas em 2 min, pula o provedor e faz meia-abertura após 60 s', async () => {
  const a = fakeProvider('a', { mode: 'throw' });
  const b = fakeProvider('b');
  const { engine, clock } = makeEngine([a, b]);
  for (let i = 0; i < 3; i++) { assert.strictEqual((await engine.synthesize('oi')).provider, 'b'); clock.advance(1000); }
  assert.strictEqual(a.calls, 3);
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'open');
  assert.strictEqual((await engine.synthesize('oi')).provider, 'b');
  assert.strictEqual(a.calls, 3, 'aberto: não tenta');
  // O disjuntor abriu na 3ª falha (t0+2 s) e o relógio já está em t0+3 s: faltam 59 s.
  clock.advance(58_999);
  await engine.synthesize('oi');
  assert.strictEqual(a.calls, 3, 'ainda aberto a 1 ms do fim');
  clock.advance(1);
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'half-open');
  a.mode = 'ok';
  assert.strictEqual((await engine.synthesize('oi')).provider, 'a', 'a meia-abertura testa 1 vez e fecha');
  assert.strictEqual(a.calls, 4);
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'closed');
  assert.strictEqual((await engine.synthesize('oi')).provider, 'a');
});

await test('meia-abertura que falha reabre por mais 60 s com UMA tentativa só', async () => {
  const a = fakeProvider('a', { mode: 'throw' });
  const b = fakeProvider('b');
  const { engine, clock } = makeEngine([a, b]);
  for (let i = 0; i < 3; i++) await engine.synthesize('oi');
  clock.advance(60_000);
  await engine.synthesize('oi'); // meia-abertura: a falha de novo
  assert.strictEqual(a.calls, 4);
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'open');
  await engine.synthesize('oi');
  await engine.synthesize('oi');
  assert.strictEqual(a.calls, 4, 'não tenta de novo antes de passar mais 60 s');
  clock.advance(60_000);
  await engine.synthesize('oi');
  assert.strictEqual(a.calls, 5);
});

await test('falhas fora da janela de 2 min não somam', async () => {
  const a = fakeProvider('a', { mode: 'throw' });
  const b = fakeProvider('b');
  const { engine, clock } = makeEngine([a, b]);
  await engine.synthesize('oi');
  await engine.synthesize('oi');
  clock.advance(121_000);
  await engine.synthesize('oi');
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'closed');
  assert.strictEqual(engine.getStatus().providers[0].breaker.recentFailures, 1);
});

await test('sucesso zera as falhas acumuladas', async () => {
  const a = fakeProvider('a', { mode: 'throw' });
  const { engine } = makeEngine([a, fakeProvider('b')]);
  await engine.synthesize('oi');
  await engine.synthesize('oi');
  a.mode = 'ok';
  await engine.synthesize('oi');
  a.mode = 'throw';
  await engine.synthesize('oi');
  await engine.synthesize('oi');
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'closed');
});

await test('provedor de nuvem: disjuntor abre por 10 min', async () => {
  const cloud = fakeProvider('nuvem', { local: false, mode: 'throw' });
  const a = fakeProvider('a');
  const { engine, clock } = makeEngine([cloud, a], { cfg: { cloud: true } });
  for (let i = 0; i < 3; i++) await engine.synthesize('oi', { sensitive: false });
  assert.strictEqual(cloud.calls, 3);
  clock.advance(599_999);
  await engine.synthesize('oi', { sensitive: false });
  assert.strictEqual(cloud.calls, 3);
  clock.advance(1);
  await engine.synthesize('oi', { sensitive: false });
  assert.strictEqual(cloud.calls, 4);
});

await test('log com freio: 1 linha de falha e 1 de disjuntor por provedor a cada 10 min', async () => {
  const a = fakeProvider('a', { mode: 'throw' });
  const { engine, clock, logs } = makeEngine([a, fakeProvider('b')]);
  for (let i = 0; i < 6; i++) { await engine.synthesize('oi'); clock.advance(100); }
  assert.strictEqual(logs.filter(([, m]) => m.includes('falhou (')).length, 1);
  assert.strictEqual(logs.filter(([, m]) => m.includes('Disjuntor aberto')).length, 1);
  clock.advance(11 * 60_000);
  a.mode = 'throw';
  await engine.synthesize('oi'); // meia-abertura falha de novo
  assert.strictEqual(logs.filter(([, m]) => m.includes('falhou (')).length, 2);
});

section('Motor: provedor "sticky" por resposta');

await test('o provedor da 1ª frase fala a resposta toda; se cair, devolve null SEM trocar de voz', async () => {
  const a = fakeProvider('a');
  const b = fakeProvider('b');
  const { engine } = makeEngine([a, b]);
  const sticky = {};
  assert.strictEqual((await engine.synthesize('um', { sticky })).provider, 'a');
  assert.strictEqual(sticky.provider, 'a');
  a.mode = 'throw';
  assert.strictEqual(await engine.synthesize('dois', { sticky }), null);
  assert.strictEqual(b.calls, 0, 'b nunca foi usado: a voz não muda no meio');
  const outra = {};
  assert.strictEqual((await engine.synthesize('três', { sticky: outra })).provider, 'b', 'resposta nova pode usar b');
  assert.strictEqual(outra.provider, 'b');
});

await test('sticky grava o provedor que realmente falou (depois de uma queda na 1ª frase)', async () => {
  const a = fakeProvider('a', { mode: 'throw' });
  const b = fakeProvider('b');
  const { engine } = makeEngine([a, b]);
  const sticky = {};
  await engine.synthesize('um', { sticky });
  assert.strictEqual(sticky.provider, 'b');
  a.mode = 'ok';
  const r = await engine.synthesize('dois', { sticky });
  assert.strictEqual(r.provider, 'b');
  assert.strictEqual(a.calls, 1, 'a não foi tentado de novo nesta resposta');
});

await test('sticky com disjuntor aberto ou provedor desconhecido => null', async () => {
  const a = fakeProvider('a');
  const { engine } = makeEngine([a]);
  assert.strictEqual(await engine.synthesize('oi', { sticky: { provider: 'zzz' } }), null);
  assert.strictEqual(a.calls, 0);
});

section('Motor: privacidade (nuvem só para texto não sensível e com YUI_TTS_CLOUD ligado)');

const trapCalls = (t) => t.calls + t.probeCalls + t.warmCalls;
function cloudTrap() {
  const t = fakeProvider('nuvem', { local: false, mode: 'trap' });
  t.probe = async () => { t.probeCalls++; throw new Error('NUVEM SONDADA'); };
  t.warmup = async () => { t.warmCalls++; throw new Error('NUVEM AQUECIDA'); };
  return t;
}

for (const [label, cloud, sensitive] of [
  ['sensível + nuvem ligada', true, true],
  ['não sensível + nuvem desligada', false, false],
  ['sensível + nuvem desligada', false, true],
]) {
  await test(`nuvem nunca é chamada: ${label}`, async () => {
    const trap = cloudTrap();
    const local = fakeProvider('a');
    const { engine } = makeEngine([trap, local], { cfg: { cloud, providers: ['nuvem', 'a'] } });
    assert.deepStrictEqual(names(engine.selectChain({ sensitive })), ['a']);
    const r = await engine.synthesize('oi', { sensitive });
    assert.strictEqual(r.provider, 'a');
    local.mode = 'throw';
    assert.strictEqual(await engine.synthesize('oi', { sensitive }), null, 'local caiu: sem nuvem de reserva');
    assert.strictEqual(trapCalls(trap), 0);
  });
}

await test('nuvem ligada + texto NÃO sensível => a nuvem é a 1ª da cadeia', async () => {
  const cloud = fakeProvider('nuvem', { local: false });
  const local = fakeProvider('a');
  const { engine } = makeEngine([cloud, local], { cfg: { cloud: true, providers: ['nuvem', 'a'] } });
  assert.deepStrictEqual(names(engine.selectChain({ sensitive: false })), ['nuvem', 'a']);
  assert.strictEqual((await engine.synthesize('oi', { sensitive: false })).provider, 'nuvem');
  assert.strictEqual((await engine.synthesize('oi', { sensitive: true })).provider, 'a');
});

await test('selectChain falha fechada: sensitive ausente ou diferente de false = só local', () => {
  const cloud = fakeProvider('nuvem', { local: false });
  const local = fakeProvider('a');
  const { engine } = makeEngine([cloud, local], { cfg: { cloud: true, providers: ['nuvem', 'a'] } });
  assert.deepStrictEqual(names(engine.selectChain({})), ['a']);
  assert.deepStrictEqual(names(engine.selectChain()), ['a']);
  assert.deepStrictEqual(names(engine.selectChain({ sensitive: null })), ['a']);
  assert.deepStrictEqual(names(engine.selectChain({ sensitive: 'false' })), ['a']);
});

await test('provedor com local diferente de true conta como nuvem', async () => {
  const dubio = fakeProvider('dubio', { local: 'sim' });
  const { engine } = makeEngine([dubio, fakeProvider('a')], { cfg: { cloud: false, providers: ['dubio', 'a'] } });
  assert.deepStrictEqual(names(engine.selectChain({ sensitive: false })), ['a']);
  assert.strictEqual(dubio.calls, 0);
});

await test('probeAll e warmup nem tocam na nuvem quando ela está desligada; tocam quando ligada', async () => {
  const trap = cloudTrap();
  const local = fakeProvider('a');
  const off = makeEngine([trap, local], { cfg: { cloud: false, providers: ['nuvem', 'a'] } });
  const res = await off.engine.probeAll();
  await off.engine.warmup();
  assert.strictEqual(trapCalls(trap), 0);
  assert.strictEqual(res.find((r) => r.name === 'nuvem').skipped, true);
  assert.strictEqual(local.probeCalls, 1);
  assert.strictEqual(local.warmCalls, 1);

  const cloud2 = fakeProvider('nuvem', { local: false });
  const on = makeEngine([cloud2, fakeProvider('a')], { cfg: { cloud: true, providers: ['nuvem', 'a'] } });
  await on.engine.probeAll();
  await on.engine.warmup();
  assert.strictEqual(cloud2.probeCalls, 1);
  assert.strictEqual(cloud2.warmCalls, 1);
});

section('Motor: sondagem, aquecimento, mutex e encerramento');

await test('probeAll: provedor indisponível sai da cadeia; sondagem que lança ou trava não derruba', async () => {
  const a = fakeProvider('a');
  const b = fakeProvider('b');
  const c = fakeProvider('c');
  a.probeResult = { ok: false, detail: 'sem voz pt-BR' };
  b.probeMode = 'throw';
  c.probeMode = 'hang';
  const { engine, timers } = makeEngine([a, b, c], { cfg: { providers: ['a', 'b', 'c', 'd'] } });
  const p = engine.probeAll();
  await tick();
  timers.fireAll(); // a sondagem de "c" trava: o prazo a encerra
  for (let i = 0; i < 5; i++) { await tick(); timers.fireAll(); }
  const res = await p;
  assert.deepStrictEqual(res.map((r) => [r.name, r.ok]), [['a', false], ['b', false], ['c', false]]);
  assert.deepStrictEqual(names(engine.selectChain({ sensitive: false })), []);
  assert.strictEqual(await engine.synthesize('oi'), null);
  assert.strictEqual(a.calls + b.calls + c.calls, 0);
  a.probeResult = { ok: true, detail: 'voz Maria' };
  b.probeMode = undefined;
  c.probeMode = undefined;
  await engine.probeAll();
  assert.deepStrictEqual(names(engine.selectChain({ sensitive: false })), ['a', 'b', 'c'], 'voltam à cadeia quando a sondagem passa');
});

await test('warmup marca o provedor como quente e engole falhas', async () => {
  const a = fakeProvider('a');
  const b = fakeProvider('b');
  b.warmMode = 'throw';
  const { engine } = makeEngine([a, b]);
  await assert.doesNotReject(engine.warmup());
  const st = engine.getStatus().providers;
  assert.strictEqual(st[0].warm, true);
  assert.strictEqual(st[1].warm, false);
});

await test('mutex: só uma síntese por vez, na ordem de chegada', async () => {
  let active = 0;
  let maxActive = 0;
  const gates = [];
  const slow = fakeProvider('a');
  slow.synth = async (text) => {
    active++;
    maxActive = Math.max(maxActive, active);
    await new Promise((r) => gates.push(r));
    active--;
    slow.texts.push(text);
    return { pcm: pcmFor(200), sampleRate: 24000, channels: 1 };
  };
  const { engine } = makeEngine([slow]);
  const ps = [engine.synthesize('um'), engine.synthesize('dois'), engine.synthesize('tres')];
  await tick();
  assert.strictEqual(active, 1);
  assert.deepStrictEqual(engine.getStatus().mutex, { busy: true, waiting: 2 });
  gates.shift()();
  await tick();
  assert.strictEqual(active, 1);
  gates.shift()();
  await tick();
  gates.shift()();
  await Promise.all(ps);
  assert.strictEqual(maxActive, 1);
  assert.deepStrictEqual(slow.texts, ['um', 'dois', 'tres']);
  assert.deepStrictEqual(engine.getStatus().mutex, { busy: false, waiting: 0 });
});

await test('mutex: quem espera respeita o signal (e os outros seguem normalmente)', async () => {
  const gates = [];
  const a = fakeProvider('a');
  const original = a.synth;
  a.synth = async (text, o) => {
    if (a.calls === 0) { a.calls++; await new Promise((r) => gates.push(r)); return { pcm: pcmFor(200), sampleRate: 24000, channels: 1 }; }
    return original(text, o);
  };
  const { engine } = makeEngine([a]);
  const first = engine.synthesize('um');
  const ctl = new AbortController();
  const waiting = engine.synthesize('dois', { signal: ctl.signal });
  const last = engine.synthesize('tres');
  await tick();
  assert.strictEqual(engine.getStatus().mutex.waiting, 2);
  ctl.abort();
  assert.strictEqual(await waiting, null);
  assert.strictEqual(engine.getStatus().mutex.waiting, 1);
  gates.shift()();
  assert.ok(await first);
  assert.ok(await last);
  assert.ok(!a.texts.includes('dois'), 'a síntese abortada nunca chegou ao provedor');
});

await test('abortar durante a síntese devolve null já, sem contar falha do provedor e libera o mutex', async () => {
  const a = fakeProvider('a', { mode: 'hang' });
  const { engine, timers } = makeEngine([a]);
  const ctl = new AbortController();
  const p = engine.synthesize('oi', { signal: ctl.signal });
  await tick();
  ctl.abort();
  assert.strictEqual(await p, null);
  assert.strictEqual(engine.getStatus().providers[0].failures, 0);
  assert.strictEqual(timers.pending.size, 0);
  a.mode = 'ok';
  assert.ok(await engine.synthesize('de novo'));
  assert.strictEqual(await engine.synthesize('já abortado', { signal: AbortSignal.abort() }), null);
});

await test('provedor desconhecido, planejado ou sem instância é ignorado com UM aviso cada', () => {
  const a = fakeProvider('a');
  const { engine, logs } = makeEngine([a], { cfg: { providers: ['piper', 'edge', 'xyz', 'sapi', 'a', 'a', 'piper'] } });
  assert.deepStrictEqual(engine.getStatus().chain, ['a']);
  const warns = logs.filter(([l]) => l === 'warn').map(([, m]) => m);
  assert.strictEqual(warns.length, 4, warns.join(' | '));
  assert.strictEqual(warns.filter((m) => m.includes('"piper"')).length, 1);
  assert.strictEqual(warns.filter((m) => m.includes('"edge"')).length, 1);
  assert.strictEqual(warns.filter((m) => m.includes('"xyz"')).length, 1);
  assert.strictEqual(warns.filter((m) => m.includes('"sapi"')).length, 1);
  assert.ok(KNOWN_PROVIDERS.includes('sapi') && PLANNED_PROVIDERS.includes('piper') && !PLANNED_PROVIDERS.includes('edge') && KNOWN_PROVIDERS.includes('edge'));
});

await test('provedores como objeto/mapa também servem; sem nome ou sem synth é ignorado', () => {
  const a = fakeProvider('a');
  const { engine } = makeEngine({ x: a, y: { name: '', synth() {} }, z: { name: 'z' } }, { cfg: { providers: ['a'] } });
  assert.deepStrictEqual(engine.getStatus().chain, ['a']);
});

await test('disposeAll: fecha os provedores, solta quem espera e passa a devolver null', async () => {
  const a = fakeProvider('a', { mode: 'hang' });
  const b = fakeProvider('b');
  const { engine } = makeEngine([a, b]);
  const running = engine.synthesize('um');
  const waiting = engine.synthesize('dois');
  await tick();
  await engine.disposeAll();
  assert.strictEqual(await running, null);
  assert.strictEqual(await waiting, null);
  assert.ok(a.disposed && b.disposed);
  assert.strictEqual(await engine.synthesize('três'), null);
  assert.strictEqual(engine.getStatus().disposed, true);
  assert.strictEqual(engine.getStatus().providers[0].failures, 0, 'encerrar não conta como falha');
});

await test('disposeAll engole erro de dispose()', async () => {
  const a = fakeProvider('a');
  a.dispose = async () => { throw new Error('x'); };
  const { engine } = makeEngine([a]);
  await assert.doesNotReject(engine.disposeAll());
});

section('Motor: nada de texto em status nem em log');

await test('texto falado e mensagens de erro do provedor nunca aparecem em getStatus nem nos logs', async () => {
  const SECRET = 'SEGREDOZEBRA7391';
  const a = fakeProvider('a', { mode: 'throw' });
  const b = fakeProvider('b');
  const c = fakeProvider('c', { mode: 'throw' });
  c.synth = async (text) => { throw Object.assign(new Error(`erro com ${text}`), { code: `${SECRET} em minúsculas` }); };
  const { engine, logs, clock } = makeEngine([a, b, c], { cfg: { providers: ['c', 'a', 'b'] } });
  for (let i = 0; i < 6; i++) {
    await engine.synthesize(`diga ${SECRET} agora`);
    clock.advance(30_000);
  }
  await engine.synthesize(`${SECRET} `.repeat(300)); // grande demais: recusado
  await engine.probeAll();
  const dump = JSON.stringify([engine.getStatus(), logs]);
  assert.ok(!dump.includes(SECRET), 'o texto vazou');
  assert.ok(!dump.includes('erro com'), 'a mensagem crua do erro vazou');
  assert.ok(!dump.includes('falhou com'), 'a mensagem crua do erro vazou');
  assert.ok(dump.includes('FAKE_FAIL') && dump.includes('PROVIDER_ERROR'), 'só os códigos aparecem');
});

await test('getStatus tem a forma esperada', () => {
  const { engine } = makeEngine([fakeProvider('a'), fakeProvider('b', { local: false })], { cfg: { cloud: false } });
  const s = engine.getStatus();
  assert.deepStrictEqual(s.chain, ['a', 'b']);
  assert.strictEqual(s.cloudEnabled, false);
  assert.strictEqual(s.providers[1].local, false);
  assert.strictEqual(s.providers[0].breaker.state, 'closed');
});

// ── Configuração ──────────────────────────────────────────────────────

section('getTtsConfig: padrões e valores inválidos');

await test('padrões do T1b', () => {
  const c = getTtsConfig({});
  assert.deepStrictEqual(c.providers, ['sapi']);
  assert.deepStrictEqual(
    { enabled: c.enabled, cloud: c.cloud, voiceTools: c.voiceTools, bargeIn: c.bargeIn },
    { enabled: true, cloud: false, voiceTools: false, bargeIn: true },
  );
  assert.deepStrictEqual(
    [c.maxChars, c.maxSentences, c.maxSentenceChars, c.maxSeconds, c.staleSeconds],
    [220, 3, 160, 25, 30],
  );
  assert.deepStrictEqual(
    [c.userGapSeconds, c.userPerMin, c.guildPerMin, c.globalPerMin, c.guildSecondsPer10Min, c.queueMax],
    [6, 5, 8, 12, 120, 3],
  );
  assert.deepStrictEqual([c.bargeInMs, c.echoGuardMs, c.idleMinutes, c.sapiRate, c.sapiVoice], [800, 1500, 10, 0, '']);
  assert.strictEqual(c.personaVoiceFile, 'persona/yui-voz.md');
});

await test('valores inválidos caem no padrão; números respeitam limites; vírgula decimal', () => {
  const c = getTtsConfig({
    YUI_TTS_MAX_CHARS: 'abc', YUI_TTS_MAX_SENTENCES: '99999', YUI_TTS_STALE_SECONDS: '', YUI_TTS_USER_PER_MIN: '0',
    YUI_TTS_ENABLED: 'talvez', YUI_TTS_CLOUD: 'maybe', YUI_TTS_BARGE_IN: 'não', YUI_TTS_SAPI_RATE: '99',
    YUI_TTS_ECHO_GUARD_MS: '-5', YUI_TTS_QUEUE_MAX: '2,6',
  });
  assert.strictEqual(c.maxChars, 220);
  assert.strictEqual(c.maxSentences, 6);
  assert.strictEqual(c.staleSeconds, 30);
  assert.strictEqual(c.userPerMin, 1);
  assert.strictEqual(c.enabled, false, 'chave mestra com valor desconhecido DESLIGA (falha fechada)');
  assert.strictEqual(c.cloud, false);
  assert.strictEqual(c.bargeIn, false);
  assert.strictEqual(c.sapiRate, 10);
  assert.strictEqual(c.echoGuardMs, 0);
  assert.strictEqual(c.queueMax, 3);
  assert.deepStrictEqual(getTtsConfig({ YUI_TTS_PROVIDERS: ' SAPI , piper,,sapi ' }).providers, ['sapi', 'piper']);
  assert.deepStrictEqual(getTtsConfig({ YUI_TTS_PROVIDERS: ' , ' }).providers, ['sapi']);
  assert.strictEqual(getTtsConfig({ YUI_TTS_CLOUD: 'on' }).cloud, true);
  assert.strictEqual(getTtsConfig({ YUI_TTS_ENABLED: 'false' }).enabled, false);
});

await test('lê o ambiente na hora (sem cache) e não guarda estado', () => {
  const antes = process.env.YUI_TTS_MAX_CHARS;
  try {
    process.env.YUI_TTS_MAX_CHARS = '100';
    assert.strictEqual(getTtsConfig().maxChars, 100);
    process.env.YUI_TTS_MAX_CHARS = '150';
    assert.strictEqual(getTtsConfig().maxChars, 150);
  } finally {
    if (antes === undefined) delete process.env.YUI_TTS_MAX_CHARS;
    else process.env.YUI_TTS_MAX_CHARS = antes;
  }
});

await test('o limitador e o motor aceitam a configuração real sem ajustes', async () => {
  const cfg = getTtsConfig({});
  const limiter = policy.createLimiter({ config: cfg });
  assert.strictEqual(limiter.check('g', 'u').ok, true);
  const engine = createEngine({ providers: [fakeProvider('sapi')], config: cfg });
  assert.strictEqual((await engine.synthesize('oi')).provider, 'sapi');
});

// ── ReDoS ─────────────────────────────────────────────────────────────

section('ReDoS: entradas patológicas em menos de 500 ms');

const patho = {
  'a x200k': 'a'.repeat(200_000),
  'a x19k': 'a'.repeat(19_000),
  '"1 " x9k': '1 '.repeat(9_000),
  '@ x19k': '@'.repeat(19_000),
  '"a@" x9k': 'a@'.repeat(9_000),
  'local longo + @ x500': `${'a'.repeat(30)}@`.repeat(500),
  '. x19k': '.'.repeat(19_000),
  '"a." x9k': 'a.'.repeat(9_000),
  '- x19k': '-'.repeat(19_000),
  '"um " x6k': 'um '.repeat(6_000),
  '"e " x9k': 'e '.repeat(9_000),
  '0 x19k': '0'.repeat(19_000),
  '9 x19k + x': `${'9'.repeat(19_000)}x`,
  '! x19k': '!'.repeat(19_000),
  '$ x9k + x + $ x9k': `${'$'.repeat(9_000)}x${'$'.repeat(9_000)}`,
  '"p " x9k (letras soltas)': 'p '.repeat(9_000),
  'url sem fim': `https://${'a'.repeat(19_000)}`,
  '<@ + dígitos': `<@${'1'.repeat(19_000)}`,
  '{"tool": x1k': '{"tool":'.repeat(1_000),
  '[ x19k': '['.repeat(19_000),
  '{ x19k': '{'.repeat(19_000),
  '"por favor " x1k': 'por favor '.repeat(1_000),
  '"yui " x4k': 'yui '.repeat(4_000),
  '"repita " x2k': 'repita '.repeat(2_000),
  'zero-width x19k': ZWSP.repeat(19_000),
  '"arroba " x2k': 'arroba '.repeat(2_000),
  '"arroba" + espaços': `arroba${' '.repeat(19_000)}ponto`,
  'dígitos separados x4k': '1.2.3.'.repeat(3_000),
  '"ç" x19k': 'ç'.repeat(19_000),
  '"a-" x9k': 'a-'.repeat(9_000),
  '"|" x19k': '|'.repeat(19_000),
};
const trig = /\b(yui|ricardo|e\s*cari)\b/gi;
await test('nenhuma função da política passa de 500 ms em entradas patológicas', () => {
  const slow = [];
  // Só reprova se as 3 tentativas passarem de 500 ms: uma regex quadrática erra em segundos todas as vezes,
  // já um pico de CPU de outro programa (jogo aberto, outra suíte ao lado) costuma atrapalhar uma tentativa só.
  const time = (label, fn) => {
    let best = Infinity;
    for (let i = 0; i < 3 && best > 500; i++) {
      const t0 = performance.now();
      try { fn(); } catch (e) { slow.push(`${label}: lançou ${e.message}`); return; }
      best = Math.min(best, performance.now() - t0);
    }
    if (best > 500) slow.push(`${label}: ${Math.round(best)} ms`);
  };
  for (const [name, text] of Object.entries(patho)) {
    time(`hasPii(${name})`, () => policy.hasPii(text));
    time(`isBlockedSpeech(${name})`, () => policy.isBlockedSpeech(text));
    time(`isSystemText(${name})`, () => policy.isSystemText(text));
    time(`looksLikeToolJson(${name})`, () => policy.looksLikeToolJson(text));
    time(`echoesInput(${name})`, () => policy.echoesInput(text, text));
    time(`isParrotRequest(${name})`, () => policy.isParrotRequest(text));
    time(`isStopCommand(${name})`, () => policy.isStopCommand(text));
    time(`wakeWordInFirstWords(${name})`, () => policy.wakeWordInFirstWords(text, trig));
    time(`checkSpeakableText(${name})`, () => policy.checkSpeakableText(text, makeDeps(), { transcript: text }));
  }
  assert.deepStrictEqual(slow, []);
});

await test('o motor aguenta texto patológico sem travar (limpeza e recusa em < 500 ms)', async () => {
  const a = fakeProvider('a');
  const { engine } = makeEngine([a]);
  const t0 = performance.now();
  await engine.synthesize('@'.repeat(200_000));
  await engine.synthesize(' '.repeat(200_000));
  await engine.synthesize('a '.repeat(100_000));
  assert.ok(performance.now() - t0 < 500);
});

section('Robustez extra');

await test('resposta de provedor maluca (campo que lança) vira falha comum, sem rejeição solta', async () => {
  const a = fakeProvider('a');
  a.synth = async () => ({ pcm: pcmFor(200), sampleRate: Symbol('x'), channels: 1 });
  const b = fakeProvider('b');
  const { engine } = makeEngine([a, b]);
  assert.strictEqual((await engine.synthesize('oi')).provider, 'b');
  assert.strictEqual(engine.getStatus().providers[0].lastError, 'BAD_FORMAT');
});

await test('selectChain(null), logger que lança e timers que lançam não derrubam nada', async () => {
  const a = fakeProvider('a');
  const config = { ...getTtsConfig({}), providers: ['a'] };
  const logger = { warn() { throw new Error('log quebrado'); }, info() { throw new Error('log quebrado'); }, error() { throw new Error('log quebrado'); } };
  const bad = createEngine({ providers: [a], config, logger, timers: { setTimeout() { throw new Error('sem timer'); }, clearTimeout() {} } });
  assert.deepStrictEqual(names(bad.selectChain(null)), ['a']);
  assert.strictEqual(await bad.synthesize('oi'), null, 'sem timer não há como garantir o prazo: nega');
  const b = fakeProvider('b', { mode: 'throw' });
  const noisy = createEngine({ providers: [b, fakeProvider('c')], config: { ...config, providers: ['b', 'c'] }, logger });
  assert.strictEqual((await noisy.synthesize('oi')).provider, 'c');
});

await test('lista de bloqueio real (teste de fumaça): o arquivo carrega, o cache pode ser descartado, nada é exigido do conteúdo', () => {
  policy.resetBlocklistCache(); // volta a ler o arquivo de verdade
  try {
    const l1 = policy.loadBlocklist();
    assert.ok(l1.words instanceof Set && l1.phrases instanceof Set, 'estrutura compilada');
    assert.strictEqual(policy.loadBlocklist(), l1, 'cache');
    policy.resetBlocklistCache();
    assert.notStrictEqual(policy.loadBlocklist(), l1);
    assert.strictEqual(typeof policy.isBlockedSpeech('bom dia, tudo bem?'), 'boolean');
  } finally {
    policy.setBlocklistForTests(TEST_BLOCKLIST);
  }
  assert.strictEqual(policy.isBlockedSpeech('porra'), true, 'a cópia fixa voltou');
});

await test('importar policy.js e engine.js não abre timer, processo nem conexão', async () => {
  const kinds = () => process.getActiveResourcesInfo().filter((k) => /Timeout|Process|TCP|Pipe|Immediate/.test(k)).sort().join(',');
  await tick();
  const antes = kinds();
  await import('../src/services/tts/policy.js?fresh=1');
  await import('../src/services/tts/engine.js?fresh=1');
  await import('../src/services/tts/config.js?fresh=1');
  assert.strictEqual(kinds(), antes);
});

// ── Correções da revisão (robustez, segurança e conformidade) ────────

section('Correções da revisão: portões de contexto');

await test('isBot: só `false` EXATO prova que é humano (undefined, null, 0, "" e texto = bot)', () => {
  for (const v of [undefined, null, 0, '', 'false', {}, true]) {
    const c = ctx();
    const r = policy.decideSpeak(makeReq(c.clock), makeDeps({ isBot: () => v }), c.state);
    assert.deepStrictEqual({ ok: r.ok, reason: r.reason }, { ok: false, reason: 'bot-user' }, `isBot -> ${String(v)}`);
  }
  const c = ctx();
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), makeDeps({ isBot: () => false }), c.state).ok, true);
  const semDep = makeDeps();
  delete semDep.isBot;
  assert.strictEqual(policy.decideSpeak(makeReq(c.clock), semDep, c.state).reason, 'bot-user', 'dependência ausente = bot');
});

await test('rate-budget: o limite é exato (120 s gastos já bloqueiam; 119 s não)', () => {
  for (const [spent, expected] of [[120, 'rate-budget'], [119, 'ok']]) {
    const c = ctx();
    c.limiter.recordSpeech('g1', 'p1', spent - 60);
    c.clock.advance(20_000);
    c.limiter.recordSpeech('g1', 'p2', 60);
    c.clock.advance(20_000);
    const r = policy.decideSpeak(makeReq(c.clock, { userId: 'novo' }), makeDeps(), c.state);
    assert.strictEqual(r.reason, expected, `${spent} s gastos`);
  }
});

await test('o limitador usa relógio MONOTÔNICO por padrão (mexer na hora do PC não trava nem libera)', () => {
  const realNow = Date.now;
  try {
    Date.now = () => { throw new Error('o limitador não pode usar Date.now'); };
    const l = policy.createLimiter({ config: getTtsConfig({}) });
    l.recordSpeech('g', 'u', 3);
    assert.strictEqual(l.check('g', 'u').reason, 'rate-user-gap', 'registrou e consultou sem tocar em Date.now');
    // Hora do PC atrasada em 1 h depois da fala: com relógio de parede o intervalo deixava de valer.
    Date.now = () => realNow() - 3_600_000;
    assert.strictEqual(l.check('g', 'u').reason, 'rate-user-gap');
  } finally {
    Date.now = realNow;
  }
});

section('Correções da revisão: texto falável');

await test('isReadableText: o que a voz pt-BR não lê (japonês, russo, árabe, grego, IPA, dígrafos) não é falável', () => {
  const lidos = ['Olá, tudo bem?', 'x', 'Łódź jest miastem.', 'İstanbul çok güzel.', 'Tiếng Việt rất hay.', 'Yui diz こんにちは mundo',
    'ação, coração, pão, tá', 'Café com açúcar', 'ÿ', 'ß', 'ç', 'ã õ ü'];
  // Medido com o SAPI real: texto SÓ dessas letras volta como áudio vazio (inclusive letras latinas raras).
  const mudos = ['こんにちは世界', 'Привет, как дела?', '你好，世界。', 'مرحبا بالعالم', 'ǆ', 'ﷺ', 'ΑΒΓΔ', 'Ω', 'ʘʘʘ', 'ḃḋḟ', '𠀀𠀁𠀂',
    'mundo こんにちは こんにちは こんにちは', '', '...', null, undefined, 42,
    'ā', 'š ž č', 'ŉ', 'Ø', 'ð', 'Þ', 'Đ', 'łł'];
  for (const t of lidos) assert.strictEqual(policy.isReadableText(t), true, String(t));
  for (const t of mudos) assert.strictEqual(policy.isReadableText(t), false, String(t));
});

await test('checkSpeakableText com requireReadable: só o texto FINAL é conferido (not-speakable)', () => {
  assert.strictEqual(reasonOf('こんにちは世界', {}, { requireReadable: true }), 'not-speakable');
  assert.strictEqual(reasonOf('Привет, как дела?', {}, { requireReadable: true }), 'not-speakable');
  assert.strictEqual(check('Olá, tudo bem?', {}, { requireReadable: true }).ok, true);
  assert.strictEqual(check('こんにちは世界').ok, true, 'sem a opção (texto bruto) o alfabeto não importa');
});

await test('zalgo e espaços em excesso não travam o laço de eventos (marcas combinantes cortadas antes do normalize)', () => {
  const marks = ['ͅ', '́', '̖', '̛', '̴'];
  const zalgo = `Olá${Array.from({ length: 19_990 }, (_, i) => marks[i % marks.length]).join('')}`;
  const espacos = `Olá <${' '.repeat(19_980)}x`;
  for (const [nome, texto] of [['zalgo', zalgo], ['"<" + espaços', espacos]]) {
    for (const [fn, run] of [
      ['checkSpeakableText', () => policy.checkSpeakableText(texto, makeDeps(), { requireReadable: true })],
      ['findPii', () => policy.findPii(texto)],
      ['isBlockedSpeech', () => policy.isBlockedSpeech(texto)],
      ['looksLikeToolJson', () => policy.looksLikeToolJson(texto)],
      ['foldText', () => policy.foldText(texto)],
    ]) {
      let melhor = Infinity;
      for (let i = 0; i < 3; i++) {
        const t0 = performance.now();
        run();
        melhor = Math.min(melhor, performance.now() - t0);
      }
      // Antes: 250 a 460 ms CADA chamada (1,4 s no total). Agora ~1 ms; 150 ms dá folga a PC ocupado.
      assert.ok(melhor < 150, `${nome}/${fn}: ${melhor.toFixed(0)} ms`);
    }
  }
  assert.ok(policy.foldText('á́́́́́́').startsWith('a'));
});

section('Correções da revisão: sistema, dados pessoais, ferramentas, papagaio');

await test('system-text: cabeçalho de bloco do prompt vazado ([MODO VOZ], [REGRAS DE FERRAMENTAS...]) não é falado', () => {
  for (const t of [
    '[MODO VOZ] Sua resposta será FALADA, seja breve.',
    'Claro! [REGRAS DE FERRAMENTAS (TOOLS)]: você possui ferramentas poderosas.',
    '[ANTI-LOOP DE CONTEXTO]: o histórico pode conter chamadas',
    '[FORMATO DA RESPOSTA]\n- Para texto: escreva APENAS a fala',
  ]) {
    assert.strictEqual(reasonOf(t), 'system-text', t);
  }
  for (const t of ['[SPOILER] ele morre no final', 'Veja [1] e [2] depois', 'Capítulo [ABC] é bom', '[nsfw] não', 'O modo voz está ligado.']) {
    assert.strictEqual(check(t).ok, true, t);
  }
});

await test('PII: e-mail ofuscado ou sem TLD, telefone de 8 dígitos sem DDD e número ditado com "traço"', () => {
  for (const t of [
    'joao [at] gmail [dot] com', 'joao (at) gmail (dot) com', 'meu email é joao em gmail ponto com', 'joao@gmail', 'maria @ hotmail',
    'fale com ana arroba outlook ponto com',
    'liga 9999-8888', 'meu zap 8888-7777', 'liga 3333 4444', 'ligue 99999-8888', 'fixo 3333-4444',
    'nove nove nove nove traço oito oito oito oito', 'três três três três traço quatro quatro quatro quatro',
    // CEP, RG e segredo com rótulo (sua senha é Hunter2).
    'o CEP é 01310-100', 'RG 12.345.678-9', 'RG 1.234.567-X', 'sua senha é Hunter2', 'PIN: 4821', 'cvv = 123', 'a Senha eh abc123',
  ]) {
    assert.strictEqual(policy.hasPii(t), true, t);
  }
  for (const t of [
    'de 2019-2020 foi bom', 'em 2019 2020 teve', 'nove traço oito', 'dois traço três traço quatro', 'o ponto é esse',
    'a chat da call', 'o gmail caiu hoje', 'Brasil 3 a 1', 'faltam 5 minutos', 'o preço é 1500', 'nota 9,5 de 10',
    'a senha é muito importante', 'o pin do mapa ficou bonito', 'o CEP muda por rua', 'versão 12345 678', 'esqueceu a senha? troque depois',
    'placar 12-3 no jogo',
  ]) {
    assert.strictEqual(policy.hasPii(t), false, t);
  }
});

await test('looksLikeToolJson: formatos que o próprio llmHandler executa (action_input, <ctrl42>, aspas simples, chave solta)', () => {
  for (const t of [
    '{"action":"search_web","action_input":{"query":"a"}}',
    '<ctrl42>call:search_web{query:"x"}<ctrl44>',
    "{'tool': 'search_web', 'args': {'q': 'x'}}",
    '{ tool: "search_web" }',
    'tool: search_web\nargs: x',
    "'action_input': {'query': 'x'}",
    'play_music(query="x")',
    "print(play_music(query='x'))",
    'get_current_music()',
    'default_api.play_music(query="x")',
    'tool_code\nprint(x)',
    '{"tool_input": "x"}',
  ]) {
    assert.strictEqual(policy.looksLikeToolJson(t), true, t);
    assert.strictEqual(reasonOf(t), 'tool-json', t);
  }
  for (const t of [
    'Beleza (haha)', 'Claro (sim)', 'Use a função play_music para tocar', 'A ferramenta (tool) serve para martelar: bata forte',
    'Dica: use o toolbox', 'faça assim: ligar_tudo(x=1) e depois descanse', 'Canberra, não Sydney.', 'ação: respirar fundo',
  ]) {
    assert.strictEqual(policy.looksLikeToolJson(t), false, t);
  }
});

await test('isParrotRequest: "Yui" na frente, grite/pronuncie, "diz que o...", "em voz alta", "responda com a frase"', () => {
  for (const t of [
    'Yui, repita depois de mim: eu sou bobo', 'Yui, diz que o Pedro é um idiota', 'diga que o jantar está pronto', 'fala que a Maria é feia',
    'Yui responda com a frase: oi', 'grite: AAAA', 'Yui, grite isso',
    'pronuncie a frase abaixo: oi', 'fale em voz alta isto aqui', 'leia em voz alta o texto', 'diga literalmente o que eu escrever',
  ]) {
    assert.strictEqual(policy.isParrotRequest(t), true, t);
  }
  for (const t of [
    'Yui diz que horas são', 'diga que sim', 'diga que não', 'responda com sim ou não', 'fala comigo', 'diz oi pro pessoal', 'fale sobre a copa',
    'pronuncie paralelepípedo', 'Yui, qual a capital da Austrália', 'repita a pergunta',
  ]) {
    assert.strictEqual(policy.isParrotRequest(t), false, t);
  }
});

await test('limites exatos: token de 24 caracteres, parada por voz com 6 palavras, eco por 5 palavras', () => {
  // Token (chave): 24+ caracteres com dígito.
  assert.strictEqual(policy.hasPii('chave abcdefghijklmnopqrstuv12 fim'), true, '24 caracteres');
  assert.strictEqual(policy.hasPii('chave abcdefghijklmnopqrstu12 fim'), false, '23 caracteres');
  // Parada por voz: até 6 palavras depois do verbo.
  assert.strictEqual(policy.isStopCommand('yui pare agora por favor ok valeu'), true, '6 palavras');
  assert.strictEqual(policy.isStopCommand('yui pare agora por favor ok valeu pra mim'), false, '8 palavras');
  // Eco: transcrição de 5 palavras reaparecendo inteira na resposta; 4 palavras não bastam.
  assert.strictEqual(policy.echoesInput('a historia do pedro foi', 'ouvi que a historia do pedro foi longa'), true);
  assert.strictEqual(policy.echoesInput('a historia do pedro', 'ouvi que a historia do pedro foi longa'), false);
});

section('Correções da revisão: motor');

await test('synthesize sem `sensitive` conta como SENSÍVEL: a nuvem só recebe texto com sensitive:false explícito', async () => {
  const cloud = fakeProvider('nuvem', { local: false });
  const local = fakeProvider('a');
  const { engine } = makeEngine([cloud, local], { cfg: { cloud: true, providers: ['nuvem', 'a'] } });
  assert.strictEqual((await engine.synthesize('oi')).provider, 'a', 'sem opções');
  assert.strictEqual((await engine.synthesize('oi', {})).provider, 'a', 'opções vazias');
  assert.strictEqual((await engine.synthesize('oi', { sensitive: undefined })).provider, 'a');
  assert.strictEqual((await engine.synthesize('oi', { sensitive: null })).provider, 'a');
  assert.strictEqual(cloud.calls, 0, 'a nuvem nunca foi chamada');
  assert.strictEqual((await engine.synthesize('oi', { sensitive: false })).provider, 'nuvem', 'só com false explícito');
});

await test('prazo frio/quente segue `isWarm()` do provedor (helper que dormiu volta a ter o prazo longo)', async () => {
  const a = fakeProvider('a');
  let warm = false;
  a.isWarm = () => warm;
  const { engine, timers } = makeEngine([a]);
  await engine.synthesize('um'); // frio: 15 s
  warm = true;
  await engine.synthesize('dois'); // quente: 4 s
  warm = false; // o helper dormiu (10 min parado): a partida a frio custa de novo
  await engine.synthesize('tres');
  assert.deepStrictEqual(timers.seen, [15000, 4000, 15000]);
  assert.strictEqual(engine.getStatus().providers[0].warm, false, 'o status mostra o estado real');
  a.isWarm = () => { throw new Error('quebrado'); };
  await engine.synthesize('quatro');
  assert.strictEqual(timers.seen[3], 15000, 'isWarm que lança conta como frio');
  const b = fakeProvider('b'); // sem isWarm: vale o último sucesso (comportamento de sempre)
  const outro = makeEngine([b]);
  await outro.engine.synthesize('um');
  await outro.engine.synthesize('dois');
  assert.deepStrictEqual(outro.timers.seen, [15000, 4000]);
});

await test('meia-abertura abortada pelo chamador libera a tentativa: o provedor volta a ser testado (não trava até reiniciar o bot)', async () => {
  const a = fakeProvider('a', { mode: 'throw' });
  const b = fakeProvider('b');
  const { engine, clock } = makeEngine([a, b]);
  for (let i = 0; i < 3; i++) await engine.synthesize('oi'); // 3 falhas: disjuntor aberto
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'open');
  clock.advance(61_000);
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'half-open');
  // A única tentativa da meia-abertura é abortada pelo chamador (barge-in, interrupção...).
  a.mode = 'hang';
  const ac = new AbortController();
  const p = engine.synthesize('oi', { signal: ac.signal, sensitive: false });
  await tick();
  assert.strictEqual(a.calls, 4, 'a tentativa começou');
  ac.abort();
  assert.strictEqual(await p, null);
  // Se a tentativa tivesse ficado "presa", ninguém mais testaria o provedor e ele nunca voltaria.
  a.mode = 'ok';
  const r = await engine.synthesize('oi', { sensitive: false });
  assert.strictEqual(r.provider, 'a', 'o provedor foi testado de novo e voltou');
  assert.strictEqual(a.calls, 5);
  assert.strictEqual(engine.getStatus().providers[0].breaker.state, 'closed');
});

await test('o timer de prazo do motor recebe unref (nada segura o processo do bot)', async () => {
  const handles = [];
  const timers = {
    setTimeout(fn, ms) {
      const h = { fn, ms, unrefCalled: false, unref() { this.unrefCalled = true; return this; } };
      handles.push(h);
      return h;
    },
    clearTimeout() {},
  };
  const { engine } = makeEngine([fakeProvider('a')], { timers });
  await engine.synthesize('oi', { sensitive: false });
  await engine.warmup();
  await engine.probeAll();
  assert.ok(handles.length >= 3, `timers: ${handles.length}`);
  assert.deepStrictEqual(handles.filter((h) => !h.unrefCalled).length, 0, 'todos com unref');
});

await test('getTtsConfig: tetos e pisos de cada número (um valor digitado errado não trava nem estoura o PC)', () => {
  const alto = {};
  const baixo = {};
  const limites = {
    YUI_TTS_MAX_CHARS: [60, 600], YUI_TTS_MAX_SENTENCES: [1, 6], YUI_TTS_MAX_SENTENCE_CHARS: [60, 400], YUI_TTS_MAX_SECONDS: [5, 60],
    YUI_TTS_STALE_SECONDS: [5, 300], YUI_TTS_USER_GAP_SECONDS: [0, 120], YUI_TTS_USER_PER_MIN: [1, 60], YUI_TTS_GUILD_PER_MIN: [1, 120],
    YUI_TTS_GLOBAL_PER_MIN: [1, 240], YUI_TTS_GUILD_SECONDS_PER_10MIN: [10, 1200], YUI_TTS_QUEUE_MAX: [1, 10],
    YUI_TTS_BARGE_IN_MS: [200, 5000], YUI_TTS_ECHO_GUARD_MS: [0, 10000], YUI_TTS_IDLE_MINUTES: [1, 240], YUI_TTS_SAPI_RATE: [-10, 10],
    YUI_TTS_SAPI_TIMEOUT_MS: [1000, 30000], YUI_TTS_SAPI_COLD_TIMEOUT_MS: [3000, 60000],
  };
  for (const [k, [min, max]] of Object.entries(limites)) { alto[k] = '99999999'; baixo[k] = '-99999999'; }
  const hi = getTtsConfig(alto);
  const lo = getTtsConfig(baixo);
  const campos = {
    YUI_TTS_MAX_CHARS: 'maxChars', YUI_TTS_MAX_SENTENCES: 'maxSentences', YUI_TTS_MAX_SENTENCE_CHARS: 'maxSentenceChars', YUI_TTS_MAX_SECONDS: 'maxSeconds',
    YUI_TTS_STALE_SECONDS: 'staleSeconds', YUI_TTS_USER_GAP_SECONDS: 'userGapSeconds', YUI_TTS_USER_PER_MIN: 'userPerMin', YUI_TTS_GUILD_PER_MIN: 'guildPerMin',
    YUI_TTS_GLOBAL_PER_MIN: 'globalPerMin', YUI_TTS_GUILD_SECONDS_PER_10MIN: 'guildSecondsPer10Min', YUI_TTS_QUEUE_MAX: 'queueMax',
    YUI_TTS_BARGE_IN_MS: 'bargeInMs', YUI_TTS_ECHO_GUARD_MS: 'echoGuardMs', YUI_TTS_IDLE_MINUTES: 'idleMinutes', YUI_TTS_SAPI_RATE: 'sapiRate',
    YUI_TTS_SAPI_TIMEOUT_MS: 'sapiTimeoutMs', YUI_TTS_SAPI_COLD_TIMEOUT_MS: 'sapiColdTimeoutMs',
  };
  for (const [env, [min, max]] of Object.entries(limites)) {
    assert.strictEqual(hi[campos[env]], max, `${env} teto`);
    assert.strictEqual(lo[campos[env]], min, `${env} piso`);
  }
});


section('Correções da revisão: chave mestra, guardas de voz');

await test('YUI_TTS_ENABLED: valor escrito e desconhecido DESLIGA (falha fechada); ausente ou vazio usa o padrão', () => {
  for (const v of ['false', '0', 'off', 'nao', 'não', 'falso', 'desligado', 'disabled', 'talvez', 'nope']) {
    assert.strictEqual(getTtsConfig({ YUI_TTS_ENABLED: v }).enabled, false, v);
  }
  for (const v of ['true', '1', 'on', 'sim', 'YES', ' true ']) {
    assert.strictEqual(getTtsConfig({ YUI_TTS_ENABLED: v }).enabled, true, v);
  }
  for (const env of [{}, { YUI_TTS_ENABLED: '' }, { YUI_TTS_ENABLED: '   ' }]) {
    assert.strictEqual(getTtsConfig(env).enabled, true, JSON.stringify(env));
  }
  assert.strictEqual(getTtsConfig({ YUI_TTS_CLOUD: 'talvez' }).cloud, false, 'a nuvem continua desligada por padrão');
});

await test('voiceGuards: ferramenta por voz, item de voz, validade e texto do chat', async () => {
  const g = await import('../src/services/tts/voiceGuards.js');
  assert.strictEqual(g.VOICE_TOOL_REFUSAL, 'Isso eu faço só pelo chat.');
  // shouldBlockToolForVoice: só para item de voz e sem YUI_VOICE_TOOLS=true.
  assert.strictEqual(g.shouldBlockToolForVoice({ voice: true }, {}), true);
  assert.strictEqual(g.shouldBlockToolForVoice({ voice: true }, { YUI_VOICE_TOOLS: 'false' }), true);
  assert.strictEqual(g.shouldBlockToolForVoice({ voice: true }, { YUI_VOICE_TOOLS: 'TRUE' }), false);
  assert.strictEqual(g.shouldBlockToolForVoice({ voice: true }, { YUI_VOICE_TOOLS: 'talvez' }), true);
  assert.strictEqual(g.shouldBlockToolForVoice({}, {}), false, 'chat de texto não é afetado');
  assert.strictEqual(g.shouldBlockToolForVoice({ voice: 'true' }, {}), false, 'só voice === true');
  assert.strictEqual(g.shouldBlockToolForVoice(undefined, {}), false);
  // isVoiceItem: o portão é options.voice; o radioManager também marca isVoice, mas sem options.voice não vale.
  assert.strictEqual(g.isVoiceItem({ voice: true }, { isVoice: true }), true);
  assert.strictEqual(g.isVoiceItem({}, { isVoice: true }), false, 'mensagem do rádio nunca é fala');
  assert.strictEqual(g.isVoiceItem({ voice: true }, {}), false);
  assert.strictEqual(g.isVoiceItem(null, null), false);
  // buildVoiceKey: um fio por pessoa em cada servidor.
  assert.strictEqual(g.buildVoiceKey('g1', 'u1'), 'voice:g1:u1');
  assert.notStrictEqual(g.buildVoiceKey('g1', 'u1'), g.buildVoiceKey('g1', 'u2'));
  // isStaleVoiceItem: 30 s por padrão; sem carimbo não expira (o pedido nunca é FALADO assim: decideSpeak nega 'stale').
  assert.strictEqual(g.isStaleVoiceItem({ voice: true, voiceRequestedAt: 1000 }, 31_001), true, 'passou de 30 s');
  assert.strictEqual(g.isStaleVoiceItem({ voice: true, voiceRequestedAt: 1000 }, 31_000), false, '30 s exatos ainda valem');
  assert.strictEqual(g.isStaleVoiceItem({ voice: true, voiceRequestedAt: 1000 }, 30_999), false);
  assert.strictEqual(g.isStaleVoiceItem({ voice: true, voiceRequestedAt: 1000 }, 31_000, 60), false, 'prazo configurável');
  assert.strictEqual(g.isStaleVoiceItem({ voice: false, voiceRequestedAt: 1000 }, 999_999), false, 'texto nunca expira por aqui');
  assert.strictEqual(g.isStaleVoiceItem({ voice: true }, 999_999), false);
  assert.strictEqual(g.isStaleVoiceItem({ voice: true, voiceRequestedAt: 'x' }, 999_999), false);
  // clipForChat: 1900 por padrão, corte em fim de frase e nunca passa do limite.
  assert.strictEqual(g.clipForChat('curto'), 'curto');
  assert.strictEqual(g.clipForChat(null), '');
  const longo = `${'Frase de teste número um. '.repeat(100)}`;
  const cortado = g.clipForChat(longo, 1900);
  assert.ok(cortado.length <= 1900 && cortado.endsWith('.'), `corta em fim de frase (${cortado.length})`);
  const semFrase = g.clipForChat('palavra '.repeat(400), 100);
  assert.ok(semFrase.length <= 100 && !semFrase.endsWith(' '), 'sem fim de frase corta no espaço');
  assert.ok(g.clipForChat('x'.repeat(5000), 100).length <= 100, 'palavra enorme: corte duro');
});

await test('o motor expõe isWarm do SAPI sem quebrar o contrato (name, local, probe, warmup, synth, dispose)', async () => {
  const { createSapiProvider } = await import('../src/services/tts/providers/sapi.js');
  const p = createSapiProvider({ config: getTtsConfig({}), logger: { info() {}, warn() {}, error() {}, debug() {} }, platform: 'win32', spawn: () => { throw new Error('não deve subir nada'); } });
  assert.strictEqual(p.name, 'sapi');
  assert.strictEqual(p.local, true);
  for (const m of ['probe', 'warmup', 'synth', 'dispose', 'isWarm']) assert.strictEqual(typeof p[m], 'function', m);
  assert.strictEqual(p.isWarm(), false, 'sem helper vivo não está quente');
  await p.dispose();
});

// ── Fim ───────────────────────────────────────────────────────────────

await tick();
if (stray.length) {
  failed++;
  console.log(`  FALHA  rejeição/exceção solta: ${stray.join(' | ')}`);
}

console.log(`\n${passed} ok, ${failed} falha(s)`);
process.exit(failed ? 1 : 0);
