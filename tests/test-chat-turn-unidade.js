// Etapa 5 (chat.turn) por partes, num processo só (docs/ETAPA3_DONOS_E_CONTRATO.md §8):
//  A. persona única: o prompt de sistema que o CÉREBRO monta (src/cerebro/conversa.js + core/ai/promptConversa.js) é IGUAL ao que o bot monta
//     no processo único (llmHandler.generateResponse) para a mesma situação: base, persona, memória, voz, ferramentas, rádio, canal, servidor;
//  B. o cérebro da conversa: escopo e contexto decididos por ele (o do Braga separado do dos outros), voz fora do contexto, histórico em RAM
//     por canal como o buffer antigo, commit uma vez só (inclusive depois de "reinício": o fio relido do disco), ordem por conversa sob
//     concorrência, conversas intercaladas sem vazamento, IA fora, anti-repetição, oferta da pesquisa, fatos inválidos recusados;
//  C. o lado do bot (src/discord/turnoCerebro.js): chaves de idempotência por mensagem, repetição com a MESMA chave depois de cair no meio,
//     "indisponível" sem prender a fila, commit guardado e mandado na reconexão (antes do próximo passo);
//  D. a fila de verdade do llmHandler com o canal falso ligado a um cérebro no mesmo processo: a resposta vem do cérebro, o bot não guarda
//     histórico, o aviso de indisponível e a volta.
// SEM rede, SEM Discord, SEM bancos reais (pasta temporária). O E2E com processos de verdade é o tests/test-chat-turn.js.
// Execução: npm run test:chatturnunidade   (node tests/test-chat-turn-unidade.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-chatturn-unidade-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const CHAN2 = '666666666666666666';
const DMCH = '777777777777777777';
const GUILD_SP = '888888888888888881';
const GUILD_NOSEARCH = '888888888888888882';
const GUILD_RADIO = '888888888888888883';
const CHAN_P = '888888888888888884';

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_RESEARCH_ENABLED: 'true', YUI_RESEARCH_GUARD: 'on', YUI_RESEARCH_PRE_ROUTE: 'false', YUI_PRIVATE_SEARCH: 'off',
  YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', YUI_QUEUE_MAX_PER_USER: '20', YUI_CHAT_ESPERA_CEREBRO_MS: '400',
  GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890',
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'YUI_VOICE_TOOLS', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'YUI_CEREBRO_EXTERNO', 'YUI_CHAT_TURN_TIMEOUT_MS', 'YUI_HISTORY_MAX_CHANNELS']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp); // logs/, secrets/ e .env (nenhum) ficam no temporário

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: axios } = await import('axios');
let captured = [];
axios.post = async (url, body) => {
  if (String(url) === config.groqApiUrl) {
    captured.push({ system: body.messages[0].content, history: body.messages.slice(1, -1), user: body.messages.at(-1).content });
    return { data: { choices: [{ message: { content: 'resposta do processo único' }, finish_reason: 'stop' }] } };
  }
  throw new Error('offline (teste)');
};
axios.get = async () => { throw new Error('offline (teste)'); };
globalThis.fetch = async (u) => { throw new Error(`fetch bloqueado no teste: ${String(u).slice(0, 40)}`); };
const realWrite = fs.writeFileSync;
fs.writeFileSync = function guarded(file, ...rest) {
  if (/[\\/]data[\\/][^\\/]+\.json$/.test(String(file)) && !String(file).startsWith(tmp)) return undefined; // nada nos arquivos de dados reais
  return realWrite.call(this, file, ...rest);
};
const realAppendFile = fs.appendFile;
fs.appendFile = function guardedAppend(file, data, cb) {
  if (String(file).endsWith(path.join('data', 'historico.txt'))) { if (typeof cb === 'function') cb(null); return undefined; }
  return realAppendFile.call(this, file, data, cb);
};

const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
const { logger } = await imp('src/utils/logger.js');
const logLines = [];
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = (...args) => { logLines.push(`${level}: ${args.map(String).join(' ')}`); };
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const llm = await imp('src/handlers/llmHandler.js');
const radio = await imp('src/music/radioDatabase.js');
const persona = await imp('src/core/persona.js');
const perms = await imp('src/core/permissions.js');
const conversa = await imp('src/cerebro/conversa.js');
const turno = await imp('src/discord/turnoCerebro.js');
const ctxStore = await imp('src/core/context/contextStore.js');
const { createFakeAiBackend } = await imp('src/cerebro/iaFalsa.js');
const { LIMITS_REACHED_TEXT } = await imp('src/core/ai/promptConversa.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    say(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const META = { role: 'bot' };
const FIXED = new Date('2026-11-18T12:00:00Z');

// ── Ajudantes do cérebro ────────────────────────────────────────────────────────────────────────
function captureAi(reply = (a, n) => `resposta ${n}`) {
  const calls = [];
  return {
    calls,
    listBackends: () => [{ name: 'falsa', active: true }],
    async chat(a) { calls.push(a); return typeof reply === 'function' ? reply(a, calls.length) : reply; },
  };
}
const fakeAiAdapter = () => {
  const fake = createFakeAiBackend();
  const calls = [];
  return { calls, listBackends: () => [{ name: 'teste-ia-falsa', active: true }], async chat(a) { calls.push(a); return fake.chat(a); } };
};
const tokensOf = (text) => [...new Set(String(text).match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
const seenOf = (reply) => { const m = /vistos=\[([^\]]*)\]/.exec(reply); return m && m[1] ? m[1].split(',') : []; };
let idSeq = 900000000000000000n;
const nextId = () => String(++idSeq);
const defaultChannel = () => llm.channelFactsForCerebro({ guildId: GUILD, channelId: CHAN, userId: MEMBER });
function turnParams({ user, guild = null, channel, text, step = 1, options = {}, call = {}, id, at, ch } = {}) {
  return {
    turn: { id: id ?? nextId(), at: at ?? Date.now() - 1000 },
    ctx: { platform: 'discord', userId: user, guildId: guild, channelId: channel, isDM: !guild, isBlocked: false },
    call: { entry: 'fila', type: 'mention', mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false, ...call },
    ownText: text, memoryQuery: text, channel: ch ?? defaultChannel(), step, prompt: `user: "${text}"`, options: { main: true, persona: true, memory: true, ...options },
  };
}
const commitOf = (p, reply, { contextLine = reply } = {}) => ({
  turn: p.turn, ctx: p.ctx, call: p.call, ownText: p.ownText,
  history: [{ role: 'user', content: p.ownText }, { role: 'assistant', content: reply }], contextLine,
});
async function exchange(brain, p) {
  const r = await brain.turn(p, META);
  const c = await brain.commit(commitOf(p, r.text), META);
  return { ...r, commit: c };
}

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. Persona única: o prompt do cérebro é o mesmo do processo único');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  llm.setChannelPersona(CHAN_P, { instruction: 'fale como pirata', mood: 'feliz demais' });
  llm.setServerPrompt(GUILD_SP, 'PROMPT PERSONALIZADO DO SERVIDOR');
  llm.setServerToolEnabled(GUILD_NOSEARCH, 'search_web', false);
  radio.createSession(GUILD_RADIO, '999999999999999991', '999999999999999992');
  radio.updateSession(GUILD_RADIO, { status: 'PLAYING', currentIndex: 0, playlist: [{ title: 'Faixa Um', artist: 'Artista A', album: 'Album X' }, { title: 'Faixa Dois', artist: 'Artista B' }] });
  const ownerCtx = perms.buildContext({ platform: 'discord', userId: OWNER, isDM: true });
  const P = persona.buildPersonaPrompt(ownerCtx, { now: FIXED });
  const MEM = '\n[MEMÓRIA SOBRE ESTE USUÁRIO — teste]\n- [fact] algo\n';
  const cases = [
    { name: 'básico (servidor, com ferramentas)', bot: ['oi', CHAN, { guildId: GUILD, userId: MEMBER }], user: MEMBER, guild: GUILD, channel: CHAN, options: { persona: false, memory: false } },
    { name: 'sem ferramentas', bot: ['oi', CHAN, { guildId: GUILD, userId: MEMBER, disableTools: true }], user: MEMBER, guild: GUILD, channel: CHAN, options: { noTools: true, persona: false, memory: false } },
    { name: 'dono em DM (persona pessoal, sem a pesquisa oferecida)', bot: ['oi', DMCH, { userId: OWNER, persona: P, sensitive: true, privateChat: true }], user: OWNER, guild: null, channel: DMCH, options: { persona: true, memory: false }, personaText: P },
    { name: 'com memória', bot: ['oi', CHAN, { guildId: GUILD, userId: MEMBER, memoryBlock: MEM }], user: MEMBER, guild: GUILD, channel: CHAN, options: { persona: false, memory: true }, mem: MEM },
    { name: 'voz (bloco de voz por último, sem ferramentas)', bot: ['oi', `voice:${GUILD}:${MEMBER}`, { guildId: GUILD, userId: MEMBER, voice: true, persona: P, memoryBlock: MEM }], user: MEMBER, guild: GUILD, channel: CHAN, options: { noTools: true, persona: true, memory: true, voicePersona: true }, call: { voice: true, voiceInteraction: true, voiceItem: true }, personaText: P, mem: MEM, chKey: `voice:${GUILD}:${MEMBER}` },
    { name: 'conversa espontânea (sem a pesquisa)', bot: ['oi', CHAN, { guildId: GUILD, userId: MEMBER, chatter: true }], user: MEMBER, guild: GUILD, channel: CHAN, options: { persona: false, memory: false, chatter: true }, call: { chatter: true } },
    { name: 'persona e humor do canal', bot: ['oi', CHAN_P, { guildId: GUILD, userId: MEMBER }], user: MEMBER, guild: GUILD, channel: CHAN_P, options: { persona: false, memory: false } },
    { name: 'prompt do servidor', bot: ['oi', CHAN, { guildId: GUILD_SP, userId: MEMBER }], user: MEMBER, guild: GUILD_SP, channel: CHAN, options: { persona: false, memory: false } },
    { name: 'pesquisa desligada no servidor', bot: ['oi', CHAN, { guildId: GUILD_NOSEARCH, userId: MEMBER }], user: MEMBER, guild: GUILD_NOSEARCH, channel: CHAN, options: { persona: false, memory: false } },
    { name: 'rádio tocando', bot: ['oi', CHAN, { guildId: GUILD_RADIO, userId: MEMBER }], user: MEMBER, guild: GUILD_RADIO, channel: CHAN, options: { persona: false, memory: false } },
    { name: 'ambiente (servidor e canal no prompt)', bot: ['oi', CHAN, { guildId: GUILD, userId: MEMBER, guildName: 'Servidor X', channelName: 'geral' }], user: MEMBER, guild: GUILD, channel: CHAN, options: { persona: false, memory: false, guildName: 'Servidor X', channelName: 'geral' } },
  ];
  for (const c of cases) {
    await test(`mesmo prompt: ${c.name}`, async () => {
      captured = [];
      await llm.generateResponse(...c.bot);
      assert.equal(captured.length, 1, 'o processo único chamou o provedor');
      const ai = captureAi('ok');
      const brain = conversa.createChatBrain({ ai, logger: quiet, persona: () => c.personaText ?? '', memoryBlock: () => c.mem ?? '', context: { enabled: () => false } });
      const ch = llm.channelFactsForCerebro({ guildId: c.guild, channelId: c.chKey ?? c.channel, userId: c.user });
      await brain.turn(turnParams({ user: c.user, guild: c.guild, channel: c.channel, text: 'oi', options: { main: false, ...c.options }, call: c.call ?? {}, ch }), META);
      assert.equal(ai.calls.length, 1);
      assert.equal(ai.calls[0].system, captured[0].system, 'o texto do prompt de sistema diverge');
    });
  }
  await test('o cérebro marca como sensível (sem provedor anônimo) a conversa pessoal, o anexo e qualquer memória no prompt', async () => {
    const ai = captureAi('ok');
    const brain = conversa.createChatBrain({ ai, logger: quiet, memoryBlock: () => '', context: { enabled: () => false } });
    await brain.turn(turnParams({ user: OWNER, channel: DMCH, text: 'oi' }), META);
    await brain.turn(turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
    await brain.turn(turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi', options: { attachment: true } }), META);
    assert.deepEqual(ai.calls.map((x) => x.sensitive), [true, false, true]);
    const ai2 = captureAi('ok');
    const brain2 = conversa.createChatBrain({ ai: ai2, logger: quiet, memoryBlock: () => MEM, context: { enabled: () => false } });
    await brain2.turn(turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
    assert.equal(ai2.calls[0].sensitive, true, 'memória no prompt nunca vai a provedor anônimo');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. O cérebro da conversa: escopo, contexto, histórico, ordem e garantias');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('o dono em DM usa o fio PESSOAL (arquivo separado) e o membro no servidor o público; um nunca vê o do outro', async () => {
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const o1 = await exchange(brain, turnParams({ user: OWNER, channel: DMCH, text: 'tok-O1 oi' }));
    const m1 = await exchange(brain, turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'tok-M1 oi' }));
    const o2 = await exchange(brain, turnParams({ user: OWNER, channel: DMCH, text: 'tok-O2 de novo' }));
    const m2 = await exchange(brain, turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'tok-M2 de novo' }));
    assert.deepEqual(seenOf(o1.text), []);
    assert.deepEqual(seenOf(m1.text), []);
    assert.deepEqual(seenOf(o2.text), ['tok-O1'], 'o dono vê só o próprio fio');
    assert.deepEqual(seenOf(m2.text), ['tok-M1'], 'o membro vê só o próprio fio');
    assert.equal(o2.commit.context, true);
    const counts = ctxStore.contextCounts();
    assert.equal(counts.personalScopes, 1, 'o fio do dono em DM é pessoal');
    assert.ok(counts.persisted.public && counts.persisted.personal, 'os dois arquivos de contexto estão abertos no cérebro');
    assert.match(o2.text, /sensivel=sim/);
    assert.match(m2.text, /sensivel=nao/);
  });

  await test('escopo "owner": o membro fica no histórico em RAM do canal (como o buffer antigo) e o dono no contexto, sem cruzar', async () => {
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet, env: { ...process.env, YUI_CONTEXT_SCOPE: 'owner' } });
    const ch3 = '555555555555555003';
    const a = await exchange(brain, turnParams({ user: MEMBER, guild: GUILD, channel: ch3, text: 'tok-R1 oi' }));
    assert.equal(a.commit.history, 2, 'o membro foi para o histórico em RAM');
    const b = await exchange(brain, turnParams({ user: OWNER, guild: GUILD, channel: ch3, text: 'tok-R2 oi' }));
    assert.equal(b.commit.context, true, 'o dono foi para o contexto');
    assert.deepEqual(seenOf(b.text), [], 'o dono não lê o histórico do canal (só o fio dele)');
    const c = await exchange(brain, turnParams({ user: OTHER, guild: GUILD, channel: ch3, text: 'tok-R3 oi' }));
    assert.deepEqual(seenOf(c.text), ['tok-R1'], 'o canal (fora do contexto) é um histórico só do canal, sem o fio do dono');
  });

  await test('voz: nunca o contexto por horas, histórico em RAM pela chave da voz, escopo público e o bloco de voz no prompt', async () => {
    const ai = fakeAiAdapter();
    const seenScopes = [];
    const brain = conversa.createChatBrain({ ai, logger: quiet, memoryBlock: (ctx) => { seenScopes.push(ctx.memoryScope); return ''; } });
    const voiceCall = { voice: true, voiceInteraction: true, voiceItem: true, type: 'mention', mentionsBot: false };
    const v1 = await exchange(brain, turnParams({ user: OWNER, guild: GUILD, channel: CHAN, text: 'tok-V1 oi', call: voiceCall, options: { noTools: true, voicePersona: true } }));
    const v2 = await exchange(brain, turnParams({ user: OWNER, guild: GUILD, channel: CHAN, text: 'tok-V2 oi', call: voiceCall, options: { noTools: true, voicePersona: true } }));
    assert.equal(v1.commit.context, false);
    assert.equal(v1.commit.history, 2, 'a voz vai para o histórico em RAM da voz');
    assert.deepEqual(seenOf(v2.text), ['tok-V1']);
    assert.match(v2.text, /voz=sim/);
    assert.match(v2.text, /ferramentas=nao/);
    assert.deepEqual(seenScopes, ['public', 'public'], 'voz é sempre escopo público, até para o dono');
    assert.deepEqual(brain.forgetVoice({ guildId: GUILD }), { removed: 1 });
    const v3 = await brain.turn(turnParams({ user: OWNER, guild: GUILD, channel: CHAN, text: 'tok-V3', call: voiceCall, options: { noTools: true } }), META);
    assert.deepEqual(seenOf(v3.text), [], 'a saída da voz esquece o histórico da voz');
  });

  await test('commit UMA vez: repetido (mesmo id), e depois de um "reinício" (fio relido do disco) a troca não entra de novo', async () => {
    await ctxStore.forgetUserContext(OWNER); // a DM do dono é UM fio só (dm:<id>): começa limpo
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const p = turnParams({ user: OWNER, channel: '777777777777777010', text: 'tok-D1 uma vez' });
    const r = await brain.turn(p, META);
    const c1 = await brain.commit(commitOf(p, r.text), META);
    const c2 = await brain.commit(commitOf(p, r.text), META);
    assert.equal(c1.context, true);
    assert.equal(c2.repeated, true, 'o mesmo turno de novo não grava');
    // "reinício": um cérebro novo (sem a lista de turnos gravados) com um store lido do MESMO banco
    const fresh = ctxStore.createContextStore({ logger: quiet, backends: await ctxStore.createDbBackends({ logger: quiet }) });
    fresh.load();
    const brain2 = conversa.createChatBrain({
      ai, logger: quiet,
      context: {
        enabled: () => true, init: async () => fresh, read: (t, o) => (t.personal && o?.sensitive !== true ? [] : fresh.read(t.key)),
        recordOnce: (t, payload) => (fresh.hasExchange(t, payload) ? { recorded: false, duplicate: true } : { recorded: fresh.record(t, payload), duplicate: false }),
      },
    });
    const c3 = await brain2.commit(commitOf(p, r.text), META);
    assert.equal(c3.duplicate, true, 'o banco já tinha a troca: não entra duas vezes');
    const next = await brain2.turn(turnParams({ user: OWNER, channel: '777777777777777010', text: 'tok-D2' }), META);
    assert.deepEqual(seenOf(next.text), ['tok-D1'], 'a troca está lá UMA vez (fala + resposta)');
    assert.match(next.text, /historico=2 /);
  });

  await test('ordem por conversa: pedidos simultâneos da mesma conversa são atendidos um por vez, na ordem; conversas diferentes em paralelo', async () => {
    const order = [];
    let running = 0;
    let maxParallel = 0;
    const ai = {
      listBackends: () => [{ name: 'lenta', active: true }],
      async chat(a) {
        running += 1; maxParallel = Math.max(maxParallel, running);
        order.push(`ini:${a.prompt}`);
        await sleep(60);
        order.push(`fim:${a.prompt}`);
        running -= 1;
        return `ok ${a.prompt}`;
      },
    };
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const chA = '555555555555555101';
    const chB = '555555555555555102';
    const ps = [
      turnParams({ user: MEMBER, guild: GUILD, channel: chA, text: 'a1' }),
      turnParams({ user: MEMBER, guild: GUILD, channel: chA, text: 'a2' }),
      turnParams({ user: OTHER, guild: GUILD, channel: chB, text: 'b1' }),
      turnParams({ user: MEMBER, guild: GUILD, channel: chA, text: 'a3' }),
    ];
    await Promise.all(ps.map((p) => brain.turn(p, META)));
    const seq = order.filter((x) => x.includes('a'));
    assert.deepEqual(seq, ['ini:user: "a1"', 'fim:user: "a1"', 'ini:user: "a2"', 'fim:user: "a2"', 'ini:user: "a3"', 'fim:user: "a3"'], 'a mesma conversa nunca se sobrepõe e segue a ordem de chegada');
    assert.equal(maxParallel, 2, 'conversas diferentes correm juntas');
  });

  await test('conversas intercaladas e simultâneas de várias pessoas: cada uma vê só o próprio histórico, na ordem certa', async () => {
    await ctxStore.forgetUserContext(OWNER);
    await ctxStore.forgetUserContext(MEMBER);
    await ctxStore.forgetUserContext(OTHER);
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const people = [
      { id: 'A', user: OWNER, guild: null, channel: '777777777777777201' },
      { id: 'B', user: MEMBER, guild: GUILD, channel: '555555555555555201' },
      { id: 'C', user: OTHER, guild: GUILD, channel: '555555555555555201' }, // mesmo canal que B: fios separados (escopo all)
      { id: 'D', user: MEMBER, guild: GUILD, channel: '555555555555555202' }, // mesma pessoa que B, outro canal: outro fio
    ];
    for (let round = 1; round <= 3; round += 1) {
      // cada rodada: os quatro ao mesmo tempo (turno + commit de cada um em paralelo)
      const outs = await Promise.all(people.map((who) => exchange(brain, turnParams({ user: who.user, guild: who.guild, channel: who.channel, text: `tok-${who.id}${round} rodada ${round}` }))));
      outs.forEach((out, i) => {
        const who = people[i];
        const expected = Array.from({ length: round - 1 }, (_, k) => `tok-${who.id}${k + 1}`);
        assert.deepEqual(seenOf(out.text), expected, `${who.id} na rodada ${round}`);
        for (const t of seenOf(out.text)) assert.ok(t.startsWith(`tok-${who.id}`), `vazamento: ${who.id} viu ${t}`);
      });
    }
  });

  await test('IA fora: o aviso de sempre ("Limites de Processamento"), marcado como falha', async () => {
    const ai = { listBackends: () => [{ name: 'x', active: true }], async chat() { throw new Error('todos os provedores falharam'); } };
    const brain = conversa.createChatBrain({ ai, logger: quiet, context: { enabled: () => false } });
    const r = await brain.turn(turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
    assert.equal(r.text, LIMITS_REACHED_TEXT);
    assert.equal(r.failed, true);
    assert.equal(ctxStore.isErrorReply(r.text), true, 'o contexto trata como erro da IA');
  });

  await test('anti-repetição: resposta idêntica à anterior da conversa vira outra (uma vez)', async () => {
    let n = 0;
    const ai = { listBackends: () => [{ name: 'x', active: true }], async chat(a) { n += 1; return /responda de forma diferente/.test(a.prompt) ? 'outra resposta bem diferente' : 'a mesma resposta de sempre aqui'; } };
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const ch = '555555555555555301';
    await exchange(brain, turnParams({ user: MEMBER, guild: GUILD, channel: ch, text: 'oi' }));
    const second = await exchange(brain, turnParams({ user: MEMBER, guild: GUILD, channel: ch, text: 'oi de novo' }));
    assert.equal(second.text, 'outra resposta bem diferente');
    assert.equal(n, 3);
  });

  await test('oferta da pesquisa decidida pelo cérebro: DM privada sem search_web (YUI_PRIVATE_SEARCH=off), servidor com, espontânea sem', async () => {
    const ai = captureAi('ok');
    const brain = conversa.createChatBrain({ ai, logger: quiet, context: { enabled: () => false } });
    await brain.turn(turnParams({ user: OWNER, channel: DMCH, text: 'oi' }), META);
    await brain.turn(turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' }), META);
    await brain.turn(turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi', call: { chatter: true } }), META);
    const offered = ai.calls.map((c) => /\*\*search_web\*\*/.test(c.system));
    assert.deepEqual(offered, [false, true, false]);
  });

  await test('/yui: lê o fio e só grava a resposta pública (a privada só lê)', async () => {
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const ch = '555555555555555401';
    const pub = turnParams({ user: MEMBER, guild: GUILD, channel: ch, text: 'tok-Y1', call: { entry: 'yui', type: 'slash', record: true } });
    const r1 = await brain.turn(pub, META);
    const c1 = await brain.commit({ ...commitOf(pub, r1.text), history: [] }, META);
    assert.equal(c1.context, true);
    const priv = turnParams({ user: MEMBER, guild: GUILD, channel: ch, text: 'tok-Y2', call: { entry: 'yui', type: 'slash', record: false } });
    const r2 = await brain.turn(priv, META);
    assert.deepEqual(seenOf(r2.text), ['tok-Y1']);
    const c2 = await brain.commit({ ...commitOf(priv, r2.text), history: [] }, META);
    assert.equal(c2.context, false, 'a resposta privada não grava');
  });

  await test('fatos inválidos são recusados (o cérebro não confia no bot): id do turno, pessoa, plataforma, texto vazio', async () => {
    const brain = conversa.createChatBrain({ ai: captureAi('ok'), logger: quiet, context: { enabled: () => false } });
    const base = turnParams({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi' });
    assert.throws(() => brain.turn({ ...base, turn: { id: 'id com espaço', at: Date.now() } }, META), (e) => e.code === 'BAD_PARAMS');
    assert.throws(() => brain.turn({ ...base, ctx: { ...base.ctx, userId: 'abc' } }, META), (e) => e.code === 'BAD_PARAMS');
    assert.throws(() => brain.turn({ ...base, ctx: { ...base.ctx, platform: 'api' } }, META), (e) => e.code === 'BAD_PARAMS');
    assert.throws(() => brain.turn({ ...base, prompt: '   ' }, META), (e) => e.code === 'BAD_PARAMS');
    assert.throws(() => brain.turn({ ...base, turn: { id: '123', at: Date.now() + 3_600_000 } }, META), (e) => e.code === 'BAD_PARAMS');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. O lado do bot: chaves, queda no meio, indisponível e commit guardado');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  function fakeChannel(brain) {
    const listeners = new Set();
    const idemCache = new Map();
    const ch = {
      connected: true, calls: [], failNext: null, dropAfterNextCommit: false,
      onState(fn) { listeners.add(fn); return () => listeners.delete(fn); },
      setState(state) { ch.connected = state === 'open'; for (const fn of [...listeners]) fn({ state }); },
      ready(ms) {
        if (ch.connected) return Promise.resolve({});
        return new Promise((resolve, reject) => {
          const t = setTimeout(() => { off(); reject(Object.assign(new Error('não conectou'), { code: 'TIMEOUT' })); }, ms);
          const off = ch.onState(({ state }) => { if (state === 'open') { clearTimeout(t); off(); resolve({}); } });
        });
      },
      async request(method, params, { idem } = {}) {
        ch.calls.push({ method, idem, params });
        if (!ch.connected) throw Object.assign(new Error('desconectado'), { code: 'NOT_CONNECTED' });
        if (ch.failNext) { const code = ch.failNext; ch.failNext = null; ch.setState('disconnected'); throw Object.assign(new Error('caiu'), { code }); }
        const key = `${method}\u0000${idem ?? ''}`;
        if (idem && idemCache.has(key)) return idemCache.get(key);
        let out;
        if (method === 'chat.turn') out = await brain.turn(params, META);
        else if (method === 'chat.commit') out = await brain.commit(params, META);
        else if (method === 'chat.forgetVoice') out = brain.forgetVoice(params);
        else throw Object.assign(new Error('?'), { code: 'METHOD_NOT_FOUND' });
        if (idem) idemCache.set(key, out);
        return out;
      },
    };
    return ch;
  }
  const facts = ({ id, user = MEMBER, guild = GUILD, channel = CHAN, text = 'oi', at } = {}) => ({
    turn: { id, at: at ?? Date.now() - 500 },
    ctx: { platform: 'discord', userId: user, guildId: guild, channelId: channel, isDM: !guild, isBlocked: false },
    call: { entry: 'fila', type: 'mention', mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false },
    ownText: text, memoryQuery: text, channel: defaultChannel(),
  });

  await test('cada passo leva a chave chat.turn:<id da mensagem>:<passo> e o fim do turno chat.commit:<id>, uma vez', async () => {
    const brain = conversa.createChatBrain({ ai: fakeAiAdapter(), logger: quiet });
    const ch = fakeChannel(brain);
    turno.setChatRemote(ch, { logger: quiet });
    const id = nextId();
    const t = turno.createRemoteTurn(facts({ id, text: 'tok-K1 oi', channel: '555555555555555501' }));
    await t.generate('user: "tok-K1 oi"', { main: true, persona: true, memory: true });
    await t.generate('outra coisa', { noTools: true });
    t.noteHistory('user', 'tok-K1 oi');
    assert.equal(t.noteContext('resposta'), true);
    assert.equal(t.noteContext('outra'), false, 'uma fala de contexto por turno');
    await t.finish();
    await t.finish();
    assert.deepEqual(ch.calls.map((c) => [c.method, c.idem]), [['chat.turn', `chat.turn:${id}:1`], ['chat.turn', `chat.turn:${id}:2`], ['chat.commit', `chat.commit:${id}`]]);
    const empty = turno.createRemoteTurn(facts({ id: nextId() }));
    await empty.finish();
    assert.equal(ch.calls.length, 3, 'turno sem passo nem anotação não manda nada');
    turno.setChatRemote(null);
  });

  await test('a conexão cai no meio do passo: espera o cérebro voltar e repete com a MESMA chave (nada em dobro)', async () => {
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const ch = fakeChannel(brain);
    turno.setChatRemote(ch, { logger: quiet });
    const id = nextId();
    const t = turno.createRemoteTurn(facts({ id, channel: '555555555555555502' }));
    ch.failNext = 'CONNECTION_LOST';
    setTimeout(() => ch.setState('open'), 150);
    const out = await t.generate('user: "oi"', { main: true });
    assert.match(out.text, /^IA-FALSA /);
    const turns = ch.calls.filter((c) => c.method === 'chat.turn');
    assert.equal(turns.length, 2);
    assert.equal(turns[0].idem, turns[1].idem, 'a repetição usa a mesma chave');
    assert.equal(ai.calls.length, 1, 'a IA foi chamada uma vez');
    turno.setChatRemote(null);
  });

  await test('cérebro fora: "indisponível" depois da janela de espera; e enquanto continuar fora, na hora (a fila não fica presa)', async () => {
    const brain = conversa.createChatBrain({ ai: fakeAiAdapter(), logger: quiet });
    const ch = fakeChannel(brain);
    ch.connected = false;
    turno.setChatRemote(ch, { logger: quiet });
    const t0 = Date.now();
    await assert.rejects(turno.createRemoteTurn(facts({ id: nextId() })).generate('oi', {}), (e) => turno.isCerebroUnavailable(e));
    const first = Date.now() - t0;
    assert.ok(first >= 300 && first < 3000, `esperou a janela (${first} ms)`);
    const t1 = Date.now();
    await assert.rejects(turno.createRemoteTurn(facts({ id: nextId() })).generate('oi', {}), (e) => turno.isCerebroUnavailable(e));
    assert.ok(Date.now() - t1 < 100, 'depois da janela, recusa na hora');
    turno.setChatRemote(null);
  });

  await test('fim do turno com o cérebro fora: guardado e mandado na reconexão, ANTES do próximo passo (a ordem do histórico fica certa)', async () => {
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const ch = fakeChannel(brain);
    turno.setChatRemote(ch, { logger: quiet });
    const chan = '555555555555555503';
    const t1 = turno.createRemoteTurn(facts({ id: nextId(), channel: chan, text: 'tok-P1 oi' }));
    const r1 = await t1.generate('user: "tok-P1 oi"', { main: true });
    t1.noteContext(r1.text);
    ch.setState('disconnected');
    await t1.finish();
    assert.equal(turno.chatRemoteStats().pendingCommits, 1, 'ficou guardado');
    ch.setState('open');
    await turno.flushPendingCommits();
    assert.equal(turno.chatRemoteStats().pendingCommits, 0, 'saiu na reconexão');
    const t2 = turno.createRemoteTurn(facts({ id: nextId(), channel: chan, text: 'tok-P2' }));
    const r2 = await t2.generate('user: "tok-P2"', { main: true });
    assert.deepEqual(seenOf(r2.text), ['tok-P1'], 'o turno guardado entrou antes do seguinte');
    const order = ch.calls.map((c) => c.method);
    assert.deepEqual(order.slice(-2), ['chat.commit', 'chat.turn']);
    turno.setChatRemote(null);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. A fila de verdade do llmHandler com o cérebro (canal falso, mesmo processo)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  let seq = 0;
  function fakeMention({ userId, channelId, guildId, text }) {
    const edits = [];
    const msg = {
      id: nextId(), createdTimestamp: Date.now() - 50, content: `<@900000000000000001> ${text}`, channelId, guildId,
      guild: guildId ? { id: guildId, name: 'Servidor Teste' } : null,
      author: { id: userId, tag: `u${userId.slice(-4)}#0001`, username: `u${userId.slice(-4)}`, bot: false }, client: { user: { id: '900000000000000001' } },
      mentions: { has: () => true, everyone: false, repliedUser: null, users: new Map() },
      channel: { id: channelId, name: 'geral', send: async (p) => { edits.push(p); return { id: `s${++seq}` }; } },
      edits, replies: [],
      async reply(opts) { this.replies.push(opts); return replyMsg; },
      get outputs() { return [...this.replies, ...this.edits]; },
    };
    const replyMsg = { id: `r${++seq}`, channel: msg.channel, async edit(p) { edits.push(p); return replyMsg; }, async delete() { return undefined; } };
    return msg;
  }
  const isProgress = (c) => /Processando|Sua solicitação está na fila/.test(c);
  const finalText = (m) => [...m.outputs.map((p) => (typeof p === 'string' ? p : p?.content ?? ''))].reverse().find((c) => c && !isProgress(c)) ?? '';
  async function ask(m, text) {
    await llm.addToQueue(`--- CONTEXTO ---\n--- MENSAGEM ATUAL ---\n${m.author.username}: "${text}"`, m, 'mention', { allowSearch: true, searchPrompt: text, guildId: m.guildId ?? undefined });
  }
  async function waitFinal(m, ms = 15_000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) { const t = finalText(m); if (t) return t; await sleep(25); }
    throw new Error('sem resposta final');
  }

  await test('menções na fila: a resposta vem do cérebro, o histórico é dele e o bot não guarda nada (getHistory vazio)', async () => {
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const ch = fakeChannel(brain);
    turno.setChatRemote(ch, { logger: quiet });
    const chan = '555555555555555601';
    const m1 = fakeMention({ userId: MEMBER, channelId: chan, guildId: GUILD, text: 'tok-Q1 olá yui' });
    await ask(m1, 'tok-Q1 olá yui');
    const r1 = await waitFinal(m1);
    assert.match(r1, /^IA-FALSA /, r1);
    assert.match(r1, /ferramentas=sim/, 'as ferramentas do servidor foram oferecidas pelo cérebro');
    assert.match(r1, /identidade=sim/);
    await sleep(1300); // o fim do turno e a próxima volta da fila
    const m2 = fakeMention({ userId: MEMBER, channelId: chan, guildId: GUILD, text: 'tok-Q2 e agora?' });
    await ask(m2, 'tok-Q2 e agora?');
    const r2 = await waitFinal(m2);
    assert.deepEqual(seenOf(r2), ['tok-Q1'], 'o segundo turno viu o primeiro (contexto do cérebro)');
    assert.deepEqual(llm.getHistory(chan), [], 'o bot não guardou histórico do canal');
    const turnIdems = ch.calls.filter((c) => c.method === 'chat.turn').map((c) => c.idem);
    assert.ok(turnIdems.includes(`chat.turn:${m1.id}:1`) && turnIdems.includes(`chat.turn:${m2.id}:1`), 'a chave é o id da mensagem do Discord');
    assert.ok(ch.calls.some((c) => c.method === 'chat.commit' && c.idem === `chat.commit:${m1.id}`));
    await sleep(1300);
    turno.setChatRemote(null);
  });

  await test('cérebro fora na fila: aviso claro e a fila segue; quando ele volta, a conversa continua sem os pedidos perdidos', async () => {
    const ai = fakeAiAdapter();
    const brain = conversa.createChatBrain({ ai, logger: quiet });
    const ch = fakeChannel(brain);
    turno.setChatRemote(ch, { logger: quiet });
    const chan = '555555555555555602';
    const ok1 = fakeMention({ userId: OTHER, channelId: chan, guildId: GUILD, text: 'tok-U1 oi' });
    await ask(ok1, 'tok-U1 oi');
    await waitFinal(ok1);
    await sleep(1300);
    ch.setState('disconnected');
    const lost = fakeMention({ userId: OTHER, channelId: chan, guildId: GUILD, text: 'tok-U2 perdido' });
    await ask(lost, 'tok-U2 perdido');
    assert.equal(await waitFinal(lost), turno.CEREBRO_UNAVAILABLE_TEXT);
    await sleep(1300);
    ch.setState('open');
    const back = fakeMention({ userId: OTHER, channelId: chan, guildId: GUILD, text: 'tok-U3 voltou' });
    await ask(back, 'tok-U3 voltou');
    const r = await waitFinal(back);
    assert.deepEqual(seenOf(r), ['tok-U1'], 'o pedido perdido não entrou no contexto');
    await sleep(1300);
    turno.setChatRemote(null);
  });

  await test('sem o cérebro separado (a chave desligada) a fila é a de sempre: o provedor do bot responde e nada vai ao canal', async () => {
    assert.equal(turno.isChatRemote(), false);
    captured = [];
    const m = fakeMention({ userId: MEMBER, channelId: '555555555555555603', guildId: GUILD, text: 'oi processo único' });
    await ask(m, 'oi processo único');
    assert.match(await waitFinal(m), /resposta do processo único/);
    assert.equal(captured.length, 1);
    await sleep(1300);
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { process.chdir(repoRoot); } catch { /* */ }
  try { const db = await imp('src/database/db.js'); db.closeAllDatabases?.(); } catch { /* */ }
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
