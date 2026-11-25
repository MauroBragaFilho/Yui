// Voz unificada, lado do CÉREBRO (Fase 1, docs/DESENHO_FASE1_YUI_PERSONAL_AI.md, parecer da Liz §11b): a política de audiência no chat.turn/chat.commit
// (src/cerebro/conversa.js + src/core/politicaAudiencia.js + a coluna `source` do contexto por horas).
//  A. chave DESLIGADA: o turno de voz é idêntico ao de hoje (resultado sem o campo novo, escopo público, histórico em RAM, nenhuma auditoria, nenhum fato novo);
//  B. privado VÁLIDO (dono sozinho na call, identidade confirmada, medição fresca): ctx remontado como a DM do dono, persona e memória pessoal forçadas,
//     fio dm:<dono> (arquivo PESSOAL) com a etiqueta source='voz' e a troca gravada nele;
//  C. TODO rebaixamento (2 humanos, falante não verificado, medição velha, id do falante diferente do autor, versão errada, bloco ausente, dono ausente, 0 humanos,
//     forma ruim, autor que não é o dono, "nível" pronto do bot): público, nunca lê nem grava o fio do dono;
//  D. INVALIDAÇÃO no meio (humanos 1->2, medição velha, passo seguinte): descarta tudo, devolve vazio, não grava nada, audita sem texto;
//  E. reinício: sem decisão guardada o passo seguinte e o commit são públicos (nunca promove);
//  F. clima e pesquisa por intenção só quando a Yui foi chamada (pública: só clima); Google só com YUI_VOZ_GOOGLE;
//  G. auditoria sem texto, nome nem id; H. a coluna `source` do contexto (migração aditiva, arquivo antigo sem a coluna continua abrindo).
// SEM rede de verdade (IA, buscadores e Open-Meteo falsos), SEM bancos reais (pasta temporária).
// Execução: node tests/test-voz-audiencia-cerebro.js   (script futuro: npm run test:vozaudcerebro)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { abrirClimaFalso } from './helpers/climaFalso.js';

const fetchReal = globalThis.fetch;
const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-voz-aud-cerebro-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const AUDIT_FILE = path.join(tmp, 'audit.jsonl');

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: AUDIT_FILE, YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_PRIVATE_SEARCH: 'off', YUI_CONTEXT_ENABLED: 'true', YUI_CONTEXT_SCOPE: 'all', NODE_ENV: 'test',
  YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), YUI_POLICY_MODE: 'observe',
});
for (const k of ['YUI_VOZ_UNIFICADA', 'YUI_VOZ_GOOGLE', 'YUI_VOZ_TOOLS', 'YUI_VOZ_PRAZO_S', 'YUI_VOICE_TOOLS', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'YUI_CEREBRO_EXTERNO',
  'YUI_HISTORY_MAX_CHANNELS', 'YUI_CLIMA', 'YUI_CLIMA_CIDADE_PADRAO', 'YUI_CEREBRO_BUSCA_AUTOMATICA', 'YUI_GOOGLE', 'GEMINI_API_KEYS', 'GEMINI_API_KEY', 'AI_API_KEY']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: axios } = await import('axios');
axios.post = async () => { throw new Error('offline (teste)'); };
axios.get = async () => { throw new Error('offline (teste)'); };
globalThis.fetch = async (u) => { throw new Error(`fetch bloqueado no teste: ${String(u).slice(0, 40)}`); };

const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};
const quiet = { debug() {}, info() {}, warn() {}, error() {} };
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const conversa = await imp('src/cerebro/conversa.js');
const googleMod = await imp('src/integrations/google/google.js');
const ctxStore = await imp('src/core/context/contextStore.js');
const dbApi = await imp('src/database/db.js');
const { createFakeAiBackend } = await imp('src/cerebro/iaFalsa.js');
const { createClimaService } = await imp('src/core/tools/clima.js');
const { eventoAuditoria } = await imp('src/core/politicaAudiencia.js');
const srv = await abrirClimaFalso({ hoje: '2026-11-18' });

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; say(`  ok   ${name}`); } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const META = { role: 'bot' };
let idSeq = 970000000000000000n;
const nextId = () => String(++idSeq);
const seenOf = (reply) => { const m = /vistos=\[([^\]]*)\]/.exec(reply); return m && m[1] ? m[1].split(',') : []; };
const TURNO = 'abcdef012345';

// ── Ajudantes ───────────────────────────────────────────────────────────────────────────────────
const CANAL = { serverPrompt: null, channelSettings: null, radioBlock: '', toolsActive: [], toolsDisabled: [], maxTokens: {} };
const VOZ = { voice: true, voiceInteraction: true, voiceItem: true, type: 'mention', mentionsBot: false };
const baseCall = { entry: 'fila', type: 'mention', mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false };
/** O bloco `call.audiencia` que o bot manda (o do dono sozinho na call, medido agora). */
const bloco = (o = {}) => ({ v: 1, falanteId: OWNER, falanteVerificado: true, donoPresente: true, humanosNaCall: 1, dirigida: false, medidoEm: Date.now(), turnoId: TURNO, ...o });
function vozParams({ user = OWNER, text, aud = bloco(), id, options = {}, step = 1 } = {}) {
  const call = { ...baseCall, ...VOZ };
  if (aud) call.audiencia = aud;
  return {
    turn: { id: id ?? nextId(), at: Date.now() - 1000 },
    ctx: { platform: 'discord', userId: user, guildId: GUILD, channelId: CHAN, isDM: false, isBlocked: false },
    call, ownText: text, memoryQuery: text, channel: CANAL, step, prompt: `user: "${text}"`,
    options: { main: true, noTools: true, voicePersona: true, persona: true, memory: true, ...options },
  };
}
function dmParams({ text, id } = {}) {
  return {
    turn: { id: id ?? nextId(), at: Date.now() - 1000 },
    ctx: { platform: 'discord', userId: OWNER, guildId: null, channelId: DMCH, isDM: true, isBlocked: false },
    call: { ...baseCall }, ownText: text, memoryQuery: text, channel: CANAL, step: 1, prompt: `user: "${text}"`, options: { main: true, persona: false, memory: false },
  };
}
const commitOf = (p, reply) => ({
  turn: p.turn, ctx: p.ctx, call: p.call, ownText: p.ownText,
  history: [{ role: 'user', content: p.ownText }, { role: 'assistant', content: reply }], contextLine: reply,
});
async function exchange(brain, p) {
  const r = await brain.turn(p, META);
  const c = await brain.commit(commitOf(p, r.text || 'resposta'), META);
  return { ...r, commit: c };
}
function fakeAdapter({ depois = null } = {}) {
  const fake = createFakeAiBackend();
  const calls = [];
  return {
    calls,
    listBackends: () => [{ name: 'teste-ia-falsa', active: true }],
    async chat(a) { calls.push(a); const r = await fake.chat(a); if (depois) depois(a); return r; },
  };
}
/** Um cérebro de teste: IA falsa, persona/memória espiãs, auditoria espiã. `chave:false` = a chave desligada (o padrão de produção). */
function novoCerebro({ chave = true, ai = fakeAdapter(), envExtra = {}, deps = {} } = {}) {
  const spies = { persona: [], memoria: [], audits: [], gravacoes: [] };
  const brain = conversa.createChatBrain({
    ai, logger: quiet, env: { ...process.env, ...(chave ? { YUI_VOZ_UNIFICADA: 'true' } : {}), ...envExtra },
    persona: (ctx) => { spies.persona.push(ctx.memoryScope); return ''; },
    memoryBlock: (ctx) => { spies.memoria.push(ctx.memoryScope); return ''; },
    auditoriaAudiencia: (d, o) => { spies.audits.push({ nivel: d.nivel, rebaixadaPor: d.rebaixadaPor, ...o, env: undefined }); },
    context: { recordOnce: (t, payload) => { spies.gravacoes.push({ key: t.key, personal: t.personal, fonte: t.fonte ?? null }); return ctxStore.recordContextExchangeOnce(t, payload); } },
    ...deps,
  });
  return { brain, ai, spies };
}
/** O que o dono vê no fio dele (DM), pelo cérebro: as marcas tok-... do histórico. */
async function fioDoDono() {
  const { brain } = novoCerebro({ chave: false });
  const r = await brain.turn(dmParams({ text: 'tok-LEITURA oi' }), META);
  return seenOf(r.text);
}

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('H. A coluna `source` do contexto por horas (migração aditiva)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('arquivo ANTIGO sem a coluna `source` continua abrindo; a coluna só é gravada quando a fala tem etiqueta; a etiqueta não vai ao histórico', async () => {
    const NAME = 'memory-context-personal';
    const OLD = `
      CREATE TABLE IF NOT EXISTS context_scopes (scope_key TEXT PRIMARY KEY, user_id TEXT NOT NULL, channel_id TEXT, guild_id TEXT, personal INTEGER NOT NULL DEFAULT 0, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS context_turns (id INTEGER PRIMARY KEY AUTOINCREMENT, scope_key TEXT NOT NULL, role TEXT NOT NULL, content TEXT NOT NULL, at INTEGER NOT NULL);`;
    await dbApi.initDatabase(NAME, OLD);
    const db = dbApi.getDbWrapper(NAME);
    const t0 = Date.now() - 5000;
    db.prepare('INSERT INTO context_scopes (scope_key, user_id, channel_id, guild_id, personal, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)').run('dm:999999999999999999', '999999999999999999', null, null, 1, t0, t0);
    db.prepare('INSERT INTO context_turns (scope_key, role, content, at) VALUES (?, ?, ?, ?)').run('dm:999999999999999999', 'user', 'tok-ANTIGO u', t0);
    db.prepare('INSERT INTO context_turns (scope_key, role, content, at) VALUES (?, ?, ?, ?)').run('dm:999999999999999999', 'assistant', 'tok-ANTIGO a', t0 + 1);
    const backends = await ctxStore.createDbBackends({ logger: quiet });
    assert.ok(backends.personal, 'o arquivo antigo abriu (nada de "só RAM")');
    const rows0 = backends.personal.load();
    assert.equal(rows0.turns.filter((t) => t.scope_key === 'dm:999999999999999999').length, 2, 'as falas antigas foram lidas');
    assert.ok(rows0.turns.every((t) => !t.source), 'sem etiqueta nas falas antigas');
    const store = ctxStore.createContextStore({ logger: quiet, backends });
    store.load();
    const alvo = { active: true, key: 'dm:999999999999999999', personal: true, userId: '999999999999999999', channelId: null, guildId: null, record: true };
    assert.equal(store.record({ ...alvo, fonte: 'voz' }, { userText: 'tok-V u', assistantText: 'tok-V a' }), true);
    assert.equal(store.record(alvo, { userText: 'tok-S u', assistantText: 'tok-S a' }), true);
    const rows = backends.personal.load().turns.filter((t) => t.scope_key === 'dm:999999999999999999');
    assert.deepEqual(rows.map((t) => [t.content, t.source ?? null]), [
      ['tok-ANTIGO u', null], ['tok-ANTIGO a', null], ['tok-V u', 'voz'], ['tok-V a', 'voz'], ['tok-S u', null], ['tok-S a', null],
    ], 'só as falas da voz têm a etiqueta; as outras seguem sem');
    assert.deepEqual(store.read(alvo.key), [
      { role: 'user', content: 'tok-ANTIGO u' }, { role: 'assistant', content: 'tok-ANTIGO a' }, { role: 'user', content: 'tok-V u' },
      { role: 'assistant', content: 'tok-V a' }, { role: 'user', content: 'tok-S u' }, { role: 'assistant', content: 'tok-S a' },
    ], 'a etiqueta é só de armazenamento: o histórico que vai ao prompt é só role/content');
    // reabrir (a etiqueta sobrevive ao disco)
    const store2 = ctxStore.createContextStore({ logger: quiet, backends });
    store2.load();
    assert.equal(store2.read(alvo.key).length, 6);
  });

  await test('erro transitório ao ler o esquema da coluna `source` (arquivo bloqueado) NÃO é "coluna ausente": não tenta o ALTER nem fixa hasSource=false (o arquivo cai no só RAM)', async () => {
    const sqls = [];
    const dbApiFalho = {
      ...dbApi,
      getDbWrapper: (n) => {
        const w = dbApi.getDbWrapper(n);
        return { ...w, prepare: (sql) => { sqls.push(sql); if (/^PRAGMA table_info[(]context_turns[)]/.test(sql)) return { all() { throw new Error('database is locked'); } }; return w.prepare(sql); }, transaction: (fn) => w.transaction(fn) };
      },
    };
    const backends = await ctxStore.createDbBackends({ logger: quiet, dbApi: dbApiFalho });
    assert.equal(backends.personal, null, 'sem a etiqueta por engano o arquivo NÃO abre; vai para o só RAM, como se o COUNT tivesse falhado');
    assert.ok(!sqls.some((q) => /^ALTER TABLE/.test(q)), 'nenhum ALTER foi tentado por um erro transitório na leitura do esquema');
  });

  await test('abrir um banco de contexto NOVO não gera erro contado no wrapper (o diagnóstico não pode virar "banco com alerta" por causa da coluna `source`)', async () => {
    const sqls = [];
    const dbApiEspiao = {
      ...dbApi,
      getDbWrapper: (n) => {
        const w = dbApi.getDbWrapper(n);
        return { ...w, prepare: (sql) => { sqls.push(sql); return w.prepare(sql); }, transaction: (fn) => w.transaction(fn) };
      },
    };
    await ctxStore.createDbBackends({ logger: quiet, dbApi: dbApiEspiao });
    assert.ok(!sqls.some((q) => /^SELECT source/.test(q)), 'a presença da coluna é lida do esquema, não por um SELECT que falha de propósito');
    assert.ok(sqls.some((q) => /^PRAGMA table_info[(]context_turns[)]/.test(q)));
    const alertas = dbApi.databaseStats().filter((b) => /^memory-context/.test(b.name) && (Number(b.errors) > 0 || b.lastError));
    assert.equal(alertas.length, 0, 'nenhum banco de contexto com erro contado: ' + JSON.stringify(alertas.map((b) => [b.name, b.errors, b.lastError?.message])));
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. Chave DESLIGADA: o turno de voz é o de hoje');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('sem a chave: a mesma sequência de hoje (escopo público, histórico em RAM, sem campo novo, sem auditoria), com ou sem o bloco do bot', async () => {
    const corridas = [];
    for (const comBloco of [false, true]) {
      const ai = fakeAdapter();
      const { brain, spies } = novoCerebro({ chave: false, ai });
      const a = vozParams({ text: 'tok-V1 oi', aud: comBloco ? bloco({ dirigida: true }) : null });
      const b = vozParams({ text: 'tok-V2 oi', aud: comBloco ? bloco({ dirigida: true }) : null });
      const v1 = await exchange(brain, a);
      const v2 = await exchange(brain, b);
      assert.equal(v1.commit.context, false);
      assert.equal(v1.commit.history, 2, 'a voz vai para o histórico em RAM da voz');
      assert.deepEqual(seenOf(v2.text), ['tok-V1']);
      assert.match(v2.text, /voz=sim/);
      assert.match(v2.text, /ferramentas=nao/);
      assert.deepEqual(spies.memoria, ['public', 'public'], 'voz é sempre escopo público, até para o dono');
      assert.deepEqual(spies.persona, ['public', 'public']);
      assert.equal('audiencia' in v1, false, 'o resultado do passo NÃO ganha o campo');
      assert.deepEqual(Object.keys(v1).sort(), ['commit', 'failed', 'model', 'searchFailure', 'searchRetryAfterMs', 'text', 'usedSearch']);
      assert.equal(spies.audits.length, 0, 'nenhuma auditoria de audiência');
      assert.equal(spies.gravacoes.length, 0, 'nada no contexto por horas');
      assert.equal('audiencia' in brain.stats(), false, 'as estatísticas não ganham campo');
      assert.deepEqual(brain.forgetVoice({ guildId: GUILD }), { removed: 1 });
      corridas.push(ai.calls.map(({ prompt, system, history, ctx, sensitive }) => ({ prompt, system, history, ctx, sensitive })));
    }
    assert.deepEqual(corridas[1], corridas[0], 'as chamadas à IA são IDÊNTICAS com e sem o bloco (a chave desligada ignora o bloco)');
  });

  await test('sem a chave: os fatos do turno não ganham campo; o clima e o Google continuam fora da voz (como hoje)', async () => {
    assert.deepEqual(Object.keys(conversa.turnFactsFromWire(vozParams({ text: 'oi', aud: null }), META)), ['turnId', 'at', 'call', 'ctx', 'realChannelId', 'ownText', 'memoryQuery']);
    const antes = srv.pedidos.length;
    const gcalls = [];
    const { brain } = novoCerebro({ chave: false, deps: { clima: createClimaService({ env: { NODE_ENV: 'test' }, urls: srv.urls, fetchImpl: fetchReal, timeoutMs: 2000 }), google: (a) => { gcalls.push(a.call); return null; } }, envExtra: { YUI_VOZ_GOOGLE: 'true' } });
    await brain.turn(vozParams({ text: 'Yui, qual o clima em Cuiabá?', aud: bloco({ dirigida: true }) }), META);
    assert.equal(srv.pedidos.length, antes, 'sem a chave a voz nunca consulta o clima');
    assert.equal(gcalls[0].voice, true);
    assert.equal(gcalls[0].voiceItem, true, 'sem a chave o Google recebe a chamada de voz de sempre');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. Privado VÁLIDO: o dono sozinho na call');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await ctxStore.forgetUserContext(OWNER);
  await test('o ctx vira a DM do dono (escopo pessoal, sensível), persona e memória pessoal forçadas, fio dm:<dono> com source=voz e a troca gravada nele', async () => {
    const { brain, ai, spies } = novoCerebro();
    const p1 = vozParams({ text: 'tok-P1 oi', options: { persona: false, memory: false } }); // o bot mandou persona/memória desligadas: o cérebro força
    const r1 = await brain.turn(p1, META);
    assert.deepEqual(r1.audiencia, { nivel: 'privado', invalidada: false, motivo: null, turnoId: TURNO });
    assert.equal(ai.calls[0].ctx.memoryScope, 'personal');
    assert.equal(ai.calls[0].ctx.channelKind, 'dm');
    assert.equal(ai.calls[0].ctx.guildId, null);
    assert.equal(ai.calls[0].sensitive, true, 'conversa pessoal: nunca provedor anônimo');
    assert.deepEqual(spies.persona, ['personal']);
    assert.deepEqual(spies.memoria, ['personal']);
    assert.match(r1.text, /voz=sim/, 'o bloco de voz continua no prompt');
    assert.match(r1.text, /ferramentas=nao/);
    const c1 = await brain.commit(commitOf(p1, r1.text), META);
    assert.equal(c1.context, true);
    assert.equal(c1.history, 0, 'a troca privada NÃO vai ao histórico em RAM da voz');
    assert.deepEqual(spies.gravacoes, [{ key: `dm:${OWNER}`, personal: true, fonte: 'voz' }]);
    const r2 = await exchange(brain, vozParams({ text: 'tok-P2 oi' }));
    assert.deepEqual(seenOf(r2.text), ['tok-P1'], 'a voz privada lê o fio do dono');
    assert.deepEqual(await fioDoDono(), ['tok-P1', 'tok-P2'], 'é o MESMO fio da DM do dono');
    const backends = await ctxStore.createDbBackends({ logger: quiet });
    const noDisco = backends.personal.load().turns.filter((t) => t.scope_key === `dm:${OWNER}` && t.source === 'voz');
    assert.ok(noDisco.length >= 4, 'as falas da voz foram para o arquivo PESSOAL com a etiqueta');
    assert.ok(!backends.public.load().turns.some((t) => t.source === 'voz'), 'nada no arquivo público');
    assert.equal(brain.stats().audiencia.privados, 2);
  });

  await test('privado SEM o contexto por horas: a troca privada não vai ao histórico em RAM da voz (os turnos públicos o leem) nem ao disco', async () => {
    const { brain, spies } = novoCerebro({ deps: { context: { enabled: () => false } } });
    const priv = await exchange(brain, vozParams({ text: 'tok-SEMFIO oi' }));
    assert.equal(priv.audiencia.nivel, 'privado');
    assert.deepEqual(priv.commit, { ok: true, context: false, history: 0, duplicate: false });
    const pub = await exchange(brain, vozParams({ text: 'tok-SEMFIO2 oi', aud: bloco({ humanosNaCall: 2 }) }));
    assert.ok(!seenOf(pub.text).includes('tok-SEMFIO'));
    assert.equal(spies.gravacoes.length, 0);
  });

  await test('privado dirigido: o resultado leva a audiência e a auditoria registrou o turno UMA vez (com o id aleatório do turno, não o da mensagem)', async () => {
    const { brain, spies } = novoCerebro();
    const p = vozParams({ text: 'tok-A1 oi', aud: bloco({ dirigida: true }) });
    const r = await brain.turn(p, META);
    await brain.commit(commitOf(p, r.text), META);
    assert.equal(spies.audits.length, 1);
    assert.equal(spies.audits[0].nivel, 'privado');
    assert.equal(spies.audits[0].turnId, TURNO);
    assert.notEqual(spies.audits[0].turnId, p.turn.id);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. TODO rebaixamento: público, e o fio do dono nunca é lido nem gravado');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await ctxStore.forgetUserContext(OWNER);
  await exchange(novoCerebro({ chave: false }).brain, dmParams({ text: 'tok-SEGREDO guardado na DM do dono' }));
  const REBAIXAMENTOS = [
    ['2 humanos na call', {}, { humanosNaCall: 2 }, 'outros_humanos'],
    ['0 humanos (incoerente)', {}, { humanosNaCall: 0 }, 'outros_humanos'],
    ['falante não verificado', {}, { falanteVerificado: false }, 'falante_nao_verificado'],
    ['medição velha (60 s)', {}, { medidoEm: Date.now() - 60_000 }, 'contagem_indisponivel'], // (a decisão da política segue como está; o 'medicao_velha' é só o motivo da INVALIDAÇÃO)
    ['id do falante diferente do autor', {}, { falanteId: MEMBER }, 'falante_nao_verificado'],
    ['versão errada do bloco', {}, { v: 2 }, 'contagem_indisponivel'],
    ['dono ausente', {}, { donoPresente: false }, 'dono_ausente'],
    ['contagem em forma ruim', {}, { humanosNaCall: '1' }, 'contagem_indisponivel'],
    ['contagem ausente', {}, { humanosNaCall: null }, 'contagem_indisponivel'],
    ['"nível" pronto do bot é ignorado', {}, { nivel: 'privado', humanosNaCall: 2 }, 'outros_humanos'],
    ['bloco ausente', { aud: null }, {}, 'contagem_indisponivel'],
    ['o autor NÃO é o dono', { user: MEMBER }, { falanteId: MEMBER }, 'falante_nao_dono'],
  ];
  for (const [nome, opts, over, motivo] of REBAIXAMENTOS) {
    await test(`rebaixa: ${nome}`, async () => {
      const { brain, ai, spies } = novoCerebro();
      const aud = 'aud' in opts && opts.aud === null ? null : bloco(over);
      const tok = `tok-PUB${nextId().slice(-6)}`;
      const r = await exchange(brain, vozParams({ ...opts, text: `${tok} oi`, aud }));
      assert.deepEqual(r.audiencia, { nivel: 'publico', invalidada: false, motivo: null, turnoId: aud?.turnoId ?? null });
      assert.equal(ai.calls[0].ctx.memoryScope, 'public');
      assert.equal(ai.calls[0].ctx.channelKind, 'public');
      assert.ok(!seenOf(r.text).includes('tok-SEGREDO'), 'não leu o fio do dono');
      assert.deepEqual(spies.persona, ['public']);
      assert.equal(r.commit.context, false, 'não gravou no contexto por horas');
      assert.equal(spies.gravacoes.length, 0);
      if (aud === null) {
        // Bot sem o bloco (bot desligado): decisão pública SILENCIOSA: não audita, não guarda decisão, não aparece no stats; e o commit, sem decisão guardada, não grava nada.
        assert.equal(spies.audits.length, 0, 'sem bloco do bot: nada auditado');
        assert.equal('audiencia' in brain.stats(), false, 'sem bloco do bot: o stats() não ganha "audiencia"');
        assert.equal(r.commit.history, 0);
      } else {
        assert.equal(r.commit.history, 2, 'só o histórico em RAM da voz');
        assert.equal(spies.audits.length, 1);
        assert.equal(spies.audits[0].nivel, 'publico');
        assert.equal(spies.audits[0].rebaixadaPor, motivo);
      }
      const dono = await fioDoDono();
      assert.ok(!dono.some((t) => t.startsWith('tok-PUB')), 'o fio do dono não recebeu nada do turno público');
    });
  }
  await test('o turno público de voz não vê o que a voz privada falou (o histórico em RAM da voz fica só com falas públicas)', async () => {
    const { brain } = novoCerebro();
    await exchange(brain, vozParams({ text: 'tok-PRIV1 conversa privada' }));
    const pub = await exchange(brain, vozParams({ text: 'tok-PUBX oi', aud: bloco({ humanosNaCall: 2 }) }));
    assert.ok(!seenOf(pub.text).includes('tok-PRIV1'), 'a troca privada não foi para o histórico público da voz');
  });
  await test('a mesma pessoa em DM continua como sempre (a política não toca no texto)', async () => {
    const { brain, ai } = novoCerebro();
    const r = await brain.turn(dmParams({ text: 'tok-DMX oi' }), META);
    assert.equal('audiencia' in r, false);
    assert.equal(ai.calls[0].ctx.memoryScope, 'personal');
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. Invalidação no meio do turno privado');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  async function semVazamento(tok, brainDepois) {
    const dono = await fioDoDono();
    assert.ok(!dono.includes(tok), 'nada foi gravado no fio do dono');
    const pub = await brainDepois.turn(vozParams({ text: 'tok-DEPOIS oi', aud: bloco({ humanosNaCall: 2 }) }), META);
    assert.ok(!seenOf(pub.text).includes(tok), 'nada foi gravado no histórico da voz');
  }
  await test('humanos 1->2 entre o turno e o ai.chat: descarta, não chama a IA, devolve vazio, não grava e audita o bloqueio', async () => {
    let medicao = null;
    const { brain, ai, spies } = novoCerebro({ deps: { medicaoAtual: () => medicao, memoryBlock: () => { medicao = bloco({ humanosNaCall: 2 }); return 'memória pessoal'; } } });
    const p = vozParams({ text: 'tok-INV1 oi' });
    const r = await brain.turn(p, META);
    assert.equal(ai.calls.length, 0, 'o contexto privado NÃO foi ao provedor');
    assert.equal(r.text, '');
    assert.deepEqual(r.audiencia, { nivel: 'publico', invalidada: true, motivo: 'outros_humanos', turnoId: TURNO });
    const c = await brain.commit(commitOf(p, 'qualquer coisa'), META);
    assert.deepEqual(c, { ok: true, context: false, history: 0, duplicate: false });
    assert.equal(spies.gravacoes.length, 0);
    assert.deepEqual(spies.audits.map((a) => a.bloqueio ?? null), [null, 'turno_invalidado']);
    assert.equal(brain.stats().audiencia.invalidados, 1);
    await semVazamento('tok-INV1', novoCerebro().brain);
  });
  await test('humanos 1->2 DEPOIS do ai.chat: a resposta gerada com contexto privado é descartada (nunca devolvida) e nada é gravado', async () => {
    let medicao = null;
    const ai = fakeAdapter({ depois: () => { medicao = bloco({ humanosNaCall: 2 }); } });
    const { brain, spies } = novoCerebro({ ai, deps: { medicaoAtual: () => medicao } });
    const p = vozParams({ text: 'tok-INV2 oi' });
    const r = await brain.turn(p, META);
    assert.equal(ai.calls.length, 1, 'a IA foi chamada com a audiência válida da hora');
    assert.equal(r.text, '', 'o texto gerado com o contexto privado não sai');
    assert.equal(r.audiencia.invalidada, true);
    assert.equal(r.audiencia.motivo, 'outros_humanos');
    const c = await brain.commit(commitOf(p, 'texto privado'), META);
    assert.equal(c.context, false);
    assert.equal(spies.gravacoes.length, 0);
    await semVazamento('tok-INV2', novoCerebro().brain);
  });
  await test('medição velha no meio do turno (a espera passou de 15 s): não mantém', async () => {
    let t = Date.now();
    const { brain, ai } = novoCerebro({ deps: { now: () => t, memoryBlock: () => { t += 20_000; return ''; } } });
    const r = await brain.turn(vozParams({ text: 'tok-INV3 oi', aud: bloco({ medidoEm: t }) }), META);
    assert.equal(ai.calls.length, 0);
    assert.equal(r.audiencia.invalidada, true);
    assert.equal(r.audiencia.motivo, 'medicao_velha', 'a medição existia e passou da idade máxima: motivo próprio (o bot diz que demorou, não que mudou a call)');
    assert.equal(r.text, '');
  });
  await test('o passo seguinte (chat.turn 2) com mais gente na call invalida antes de qualquer coisa; com a mesma audiência, segue privado', async () => {
    const { brain, ai, spies } = novoCerebro();
    const id = nextId();
    const p1 = vozParams({ text: 'tok-S1 oi', id });
    const r1 = await brain.turn(p1, META);
    assert.equal(r1.audiencia.nivel, 'privado');
    const p2ok = vozParams({ text: 'tok-S1 oi', id, step: 2 });
    const r2 = await brain.turn(p2ok, META);
    assert.equal(r2.audiencia.nivel, 'privado');
    assert.equal(r2.audiencia.invalidada, false);
    const chamadas = ai.calls.length;
    const p3 = vozParams({ text: 'tok-S1 oi', id, step: 3, aud: bloco({ humanosNaCall: 2 }) });
    const r3 = await brain.turn(p3, META);
    assert.equal(ai.calls.length, chamadas, 'nenhuma chamada à IA no passo invalidado');
    assert.deepEqual(r3.audiencia, { nivel: 'publico', invalidada: true, motivo: 'outros_humanos', turnoId: TURNO });
    const r4 = await brain.turn(vozParams({ text: 'tok-S1 oi', id, step: 4 }), META);
    assert.equal(r4.audiencia.invalidada, true, 'o turno invalidado continua invalidado (nada o promove de volta)');
    assert.equal((await brain.commit(commitOf(p1, 'x'), META)).context, false);
    assert.equal(spies.gravacoes.length, 0);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('E. Reinício: sem decisão guardada nunca promove');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('passo 2 depois de um reinício (sem decisão guardada) é público, mesmo com a call "perfeita"', async () => {
    const { brain, ai, spies } = novoCerebro();
    const r = await brain.turn(vozParams({ text: 'tok-R1 oi', step: 2 }), META);
    assert.equal(r.audiencia.nivel, 'publico');
    assert.equal(ai.calls[0].ctx.memoryScope, 'public');
    assert.equal(spies.audits[0].rebaixadaPor, 'sem_promocao_no_turno');
  });
  await test('commit sem decisão guardada (reinício entre o turno privado e o commit) NÃO grava nada: nem no fio do dono, nem no RAM público da voz', async () => {
    const A = novoCerebro();
    const p = vozParams({ text: 'tok-R2 oi' });
    const r = await A.brain.turn(p, META);
    assert.equal(r.audiencia.nivel, 'privado');
    const B = novoCerebro(); // "reinício": outro cérebro, sem a decisão guardada
    const c = await B.brain.commit(commitOf(p, r.text), META);
    assert.equal(c.context, false);
    assert.equal(c.history, 0, 'a resposta privada NÃO vai ao RAM público da voz');
    assert.equal(B.spies.gravacoes.length, 0);
    assert.ok(!(await fioDoDono()).includes('tok-R2'));
    assert.equal(B.brain.stats().ramKeys, 0, 'nenhuma chave de histórico em RAM criada');
    // e um turno PÚBLICO seguinte do mesmo dono (convidado entrou) não vê a troca privada
    const pub = await B.brain.turn(vozParams({ text: 'tok-R2B oi', aud: bloco({ humanosNaCall: 2 }) }), META);
    assert.ok(!seenOf(pub.text).includes('tok-R2'), 'o turno público não vê a troca privada');
    assert.equal(B.spies.audits.some((a) => a.bloqueio === 'turno_invalidado'), true, 'o commit sem decisão foi auditado (sem texto)');
  });
  await test('commit com decisão PÚBLICA guardada continua indo ao RAM da voz (o que não vira privado segue como sempre)', async () => {
    const { brain } = novoCerebro();
    const p = vozParams({ text: 'tok-R3 oi', aud: bloco({ humanosNaCall: 2 }) });
    const r = await brain.turn(p, META);
    const c = await brain.commit(commitOf(p, r.text), META);
    assert.equal(c.history, 2);
  });
  await test('promocaoProibida (o bot diz que a decisão inicial dele não foi privada, ex.: convidado que SAIU): o passo 1 já é público, sem promover; só o booleano true vale', async () => {
    const a = novoCerebro();
    const r = await a.brain.turn(vozParams({ text: 'tok-PP1 oi', aud: bloco({ promocaoProibida: true }) }), META);
    assert.equal(r.audiencia.nivel, 'publico');
    assert.equal(a.ai.calls[0].ctx.memoryScope, 'public', 'nenhum contexto privado montado');
    assert.equal(a.spies.audits[0].rebaixadaPor, 'sem_promocao_no_turno');
    for (const ruim of ['true', 1, 'sim', {}]) {
      const b = novoCerebro();
      const r2 = await b.brain.turn(vozParams({ text: 'tok-PP2 oi', aud: bloco({ promocaoProibida: ruim }) }), META);
      assert.equal(r2.audiencia.nivel, 'privado', `promocaoProibida ${JSON.stringify(ruim)} é ignorado`);
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('F. Clima, pesquisa por intenção e Google');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const climaNovo = () => createClimaService({ env: { NODE_ENV: 'test' }, urls: srv.urls, fetchImpl: fetchReal, timeoutMs: 2000 });
  const FRASE_CLIMA = 'Yui, qual o clima em Cuiabá hoje?';
  for (const [nome, over, user, esperaClima] of [
    ['privado e chamada pelo nome', { dirigida: true }, OWNER, true],
    ['pública (2 humanos) e chamada pelo nome: só o clima', { dirigida: true, humanosNaCall: 2 }, OWNER, true],
    ['privado, mas não chamada pelo nome', { dirigida: false }, OWNER, false],
    ['pública e não chamada pelo nome', { dirigida: false, humanosNaCall: 2 }, OWNER, false],
    ['outro membro, chamada pelo nome (falante verificado)', { dirigida: true, falanteId: MEMBER }, MEMBER, true],
    ['medição velha (público) e chamada pelo nome', { dirigida: true, medidoEm: Date.now() - 60_000 }, OWNER, true],
  ]) {
    await test(`clima: ${nome} => ${esperaClima ? 'consulta' : 'não consulta'}`, async () => {
      const antes = srv.pedidos.length;
      const { brain, ai } = novoCerebro({ deps: { clima: climaNovo() } });
      const r = await brain.turn(vozParams({ user, text: FRASE_CLIMA, aud: bloco(over) }), META);
      assert.equal(srv.pedidos.length > antes, esperaClima);
      if (esperaClima) {
        assert.match(String(ai.calls.at(-1).prompt), /Cuiab/);
        assert.equal(r.audiencia.invalidada, false);
      }
    });
  }
  await test('pesquisa por intenção: só no PRIVADO dirigido; a pública dirigida só tem o clima (a política nem é consultada)', async () => {
    const avaliacoes = [];
    const avaliarIntencao = (a) => { avaliacoes.push({ direta: a.chamadaDireta, canal: a.contexto.channelKind, escopo: a.contexto.memoryScope }); return { buscar: false, motivo: 'teste' }; };
    const F = 'Yui, quem ganhou o jogo ontem?';
    const priv = novoCerebro({ deps: { avaliarIntencao } });
    await priv.brain.turn(vozParams({ text: F, aud: bloco({ dirigida: true }) }), META);
    assert.deepEqual(avaliacoes, [{ direta: true, canal: 'dm', escopo: 'personal' }]);
    avaliacoes.length = 0;
    const pub = novoCerebro({ deps: { avaliarIntencao } });
    await pub.brain.turn(vozParams({ text: F, aud: bloco({ dirigida: true, humanosNaCall: 2 }) }), META);
    await priv.brain.turn(vozParams({ text: F, aud: bloco({ dirigida: false }) }), META);
    assert.deepEqual(avaliacoes, [], 'pública dirigida e privada não dirigida nunca decidem pesquisa');
    const off = novoCerebro({ chave: false, deps: { avaliarIntencao } });
    await off.brain.turn(vozParams({ text: F, aud: bloco({ dirigida: true }) }), META);
    assert.deepEqual(avaliacoes, [], 'sem a chave a voz nunca pesquisa por intenção');
  });
  await test('a cidade pendente de voz tem chave própria (não colide com a DM do dono)', async () => {
    const { brain } = novoCerebro({ deps: { clima: climaNovo() } });
    const pergunta = await brain.turn(vozParams({ text: 'Yui, qual o clima hoje?', aud: bloco({ dirigida: true }) }), META);
    assert.match(pergunta.text, /cidade/i, 'sem cidade: a pergunta fixa');
    const antes = srv.pedidos.length;
    const dm = await brain.turn(dmParams({ text: 'Recife' }), META); // a DM do dono, mesma pessoa, NÃO é a resposta da cidade da voz
    assert.equal(srv.pedidos.length, antes, 'a DM não consumiu a pergunta pendente da voz');
    assert.equal('audiencia' in dm, false);
  });
  await test('a cidade dita num turno PRIVADO não é reaproveitada num turno PÚBLICO seguinte (a chave do estado leva o nível)', async () => {
    const { brain } = novoCerebro({ deps: { clima: climaNovo() } });
    const pergunta = await brain.turn(vozParams({ text: 'Yui, qual o clima hoje?', aud: bloco({ dirigida: true }) }), META);
    assert.match(pergunta.text, /cidade/i, 'privado: a pergunta fixa da cidade');
    const antes = srv.pedidos.length;
    const pub = await brain.turn(vozParams({ text: 'Cuiabá', aud: bloco({ dirigida: true, humanosNaCall: 2 }) }), META);
    assert.equal(srv.pedidos.length, antes, 'a pergunta pendente do turno privado não foi gasta pelo turno público');
    assert.equal(pub.audiencia.nivel, 'publico');
  });
  await test('Google na voz PRIVADA: só a agenda; e-mail, tarefas e aniversários devolvem a frase fixa "só por mensagem privada" (Google falso)', async () => {
    const google = googleMod.criarGoogle({ env: { YUI_GOOGLE: 'true', YUI_GOOGLE_TOKEN_FILE: path.join(tmp, 'sem-token.json') }, log: quiet, alertar: () => true });
    const { brain } = novoCerebro({ envExtra: { YUI_VOZ_GOOGLE: 'true' }, deps: { google: (a) => google.rotear(a) } });
    for (const fala of ['Yui, minhas tarefas de hoje', 'Yui, quais os aniversários da semana?', 'Yui, tenho e-mails novos na caixa de entrada?']) {
      const r = await brain.turn(vozParams({ text: fala, aud: bloco({ dirigida: true }) }), META);
      assert.equal(r.audiencia.nivel, 'privado');
      assert.equal(r.text, googleMod.FRASES.soPrivado, fala);
    }
    const ag = await brain.turn(vozParams({ text: 'Yui, o que tenho na agenda hoje?', aud: bloco({ dirigida: true }) }), META);
    assert.notEqual(ag.text, googleMod.FRASES.soPrivado, 'a agenda segue permitida na voz privada (aqui: o Google falso ainda não está conectado)');
  });
  await test('Google: só com YUI_VOZ_GOOGLE e no privado a chamada vai normalizada (voice:false); sem a chave, na pública ou com a política desligada, fica "só no privado"', async () => {
    const run = async ({ chave = true, google = false, over = {} }) => {
      const gcalls = [];
      const { brain } = novoCerebro({ chave, envExtra: google ? { YUI_VOZ_GOOGLE: 'true' } : {}, deps: { google: (a) => { gcalls.push({ voice: a.call.voice, voiceItem: a.call.voiceItem, escopo: a.ctx.memoryScope }); return null; } } });
      await brain.turn(vozParams({ text: 'Yui, o que tenho na agenda hoje?', aud: bloco({ dirigida: true, ...over }) }), META);
      return gcalls[0];
    };
    assert.deepEqual(await run({}), { voice: true, voiceItem: true, escopo: 'personal' });
    assert.deepEqual(await run({ google: true }), { voice: false, voiceItem: false, escopo: 'personal' });
    assert.deepEqual(await run({ google: true, over: { humanosNaCall: 2 } }), { voice: true, voiceItem: true, escopo: 'public' });
    assert.deepEqual(await run({ google: true, chave: false }), { voice: true, voiceItem: true, escopo: 'public' });
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('G. Auditoria sem texto, nome nem id');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('o evento da audiência (e o do bloqueio) só tem códigos e números; a gravação REAL no arquivo não leva texto, id de pessoa nem o id da mensagem', async () => {
    const { brain, spies } = novoCerebro({ deps: { auditoriaAudiencia: undefined } });
    assert.equal(spies.audits.length, 0);
    const tokSecreto = 'tok-SEGREDOAUD frase de conversa';
    const p = vozParams({ text: tokSecreto, aud: bloco({ dirigida: true }) });
    const r = await brain.turn(p, META);
    assert.equal(r.audiencia.nivel, 'privado');
    const arquivo = fs.readFileSync(AUDIT_FILE, 'utf8');
    assert.match(arquivo, /politica\.audiencia/);
    for (const proibido of [OWNER, MEMBER, GUILD, CHAN, 'tok-SEGREDOAUD', 'frase de conversa', p.turn.id]) assert.ok(!arquivo.includes(proibido), `a auditoria não pode conter ${proibido.slice(0, 12)}`);
    const linha = JSON.parse(arquivo.trim().split('\n').filter((l) => l.includes('politica.audiencia')).at(-1));
    assert.equal(linha.userId, null);
    assert.equal(linha.turn_id, TURNO);
    // o evento de bloqueio vindo do cérebro (invalidação) também é só código
    const ev = eventoAuditoria(r.audiencia && { nivel: 'privado', recursos: {}, interface: 'voz' }, { turnId: TURNO, timestamp: 1, bloqueio: 'turno_invalidado' });
    assert.equal(ev.action, 'politica.audiencia.bloqueio');
  });
  await test('um dublê de auditoria que LANÇA nunca derruba o turno', async () => {
    const { brain } = novoCerebro({ deps: { auditoriaAudiencia: () => { throw new Error('disco cheio'); } } });
    const r = await brain.turn(vozParams({ text: 'tok-AUDFALHA oi' }), META);
    assert.equal(r.audiencia.nivel, 'privado');
    assert.ok(r.text.length > 0);
  });
} finally {
  await srv.fechar();
  console.log = realConsole.log;
}

say(`\n${passed} teste(s) ok, ${failures.length} falha(s).`);
if (failures.length) {
  say(`Falharam: ${failures.join(' | ')}`);
  process.exitCode = 1;
}
setTimeout(() => process.exit(process.exitCode ?? 0), 100).unref();
