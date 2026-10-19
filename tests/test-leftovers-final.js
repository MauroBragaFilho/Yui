// Testes do Pacote R (sobras da rodada final):
//   M3   rádio: sendNotify, mensagem da fila e adaptador de resposta de voz não notificam @everyone/@here/cargo/outro usuário
//        (o título e a busca vêm de fora); só o autor do comando continua sendo marcado.
//   B9   imageHandler: o prompt de imagem (texto do usuário) não vai para o log nem para o console, só o tamanho.
//   Reg 6 painel de configuração: o texto de persistência "json" é honesto (aplicado agora, gravado no config.json, mas o arquivo não é
//        lido ao iniciar e o .env tem prioridade).
//   Reg 4 messageCreate: foto/vídeo/PDF junto de uma fala com texto NÃO leva a ordem "Você NÃO leu... Avise isso"; sem texto próprio, ou
//        com .txt/.md/.log que não foi lido, o aviso continua.
// Rodam SEM Discord, SEM rede e SEM bancos reais: as dependências pesadas (llmHandler, rádio, logger, banHandler...) são trocadas por
// dublês via module.registerHooks, o fetch global é um dublê e nada é gravado em arquivo do projeto (tudo em pasta temporária).
// Execução: npm run test:leftovers   (ou: node tests/test-leftovers-final.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-leftovers-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_OWNER_ID: '111',
  YUI_ALERTS: 'false',
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  LOG_LEVEL: 'error',
});
process.chdir(tmp); // .env e logs/ do projeto ficam fora do teste

const realSetTimeout = globalThis.setTimeout;
const sleep = (ms) => new Promise((r) => realSetTimeout(r, ms));

// ── Estado compartilhado com os dublês ──────────────────────────────────────────────────────────
const state = { logs: [], queue: [], session: null, resolved: { type: 'not_found' }, nextTrackValue: null, prevTrackValue: null };
globalThis.__pr = state;
const S = 'globalThis.__pr';

// ── Dublês (módulos pequenos escritos na pasta temporária) ──────────────────────────────────────
const stubDir = path.join(tmp, 'stubs');
fs.mkdirSync(stubDir);
const writeStub = (name, code) => { const f = path.join(stubDir, name); fs.writeFileSync(f, code); return pathToFileURL(f).href; };
const stubs = new Map();
const addStub = (rel, code) => stubs.set(pathToFileURL(path.join(repoRoot, rel)).href.toLowerCase(), writeStub(`${stubs.size}.mjs`, code));

addStub('src/utils/logger.js', `
const mk = (lvl) => (m) => { ${S}.logs.push([lvl, String(m)]); };
export const logger = { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
export default logger;
`);
addStub('src/handlers/llmHandler.js', `
export const addToQueue = (...args) => { ${S}.queue.push(args); };
export const getChannelSettings = () => ({});
export const getServerSettings = () => ({});
export const queueRefusalFor = () => null;
export const refuseQueueRequest = async () => {};
export const setServerLastChannel = () => {};
export const updateShowModel = () => {};
export const getShowModel = () => true;
export const updateShowModelThinking = () => {};
export const getShowModelThinking = () => false;
export const updateErrorRetries = () => {};
export const getErrorRetries = () => 3;
export const updateProviderSetting = () => {};
export const getProviderSettings = () => new Proxy({}, { get: () => new Proxy({}, { get: () => 0.5 }) });
`);
addStub('src/handlers/banHandler.js', 'export const checkBan = () => null; export const checkAutoBan = async () => null;');
addStub('src/discord/prefixRouter.js', 'export const startsWithCommandPrefix = () => false;');
addStub('src/handlers/tosHandler.js', `
export const isServerAccepted = () => true;
export const sendTermsOfService = async () => {};
export const checkAndInitializeUpdateChannel = async () => {};
`);
// rádio
addStub('src/services/sttService.js', 'export const transcribeAudio = async () => ""; export const STT_PROVIDERS_CONFIG = {};');
addStub('src/services/tts/index.js', 'export const interruptSpeech = () => {};');
addStub('src/utils/binaries.js', 'export const isOpusAvailable = () => true;');
addStub('src/music/radioDatabase.js', `
export const createSession = () => ({});
export const getSession = () => ${S}.session;
export const destroySession = () => {};
export const updateSession = () => {};
export const nextTrack = () => ${S}.nextTrackValue;
export const prevTrack = () => ${S}.prevTrackValue;
export const skipToTrack = () => null;
export const addTrackToQueue = () => 1;
export const toggleVoiceListening = () => {};
export const setLoopMode = () => 'OFF';
export const toggleShuffle = () => true;
export const removeTrackFromPlaylist = () => null;
export const stopRadio = () => {};
`);
addStub('src/music/radioAudioPlayer.js', `
export const playTrack = async () => {};
export const pausePlayer = async () => {};
export const resumePlayer = async () => {};
export const stopPlayer = () => {};
export const updateEmbed = async () => {};
`);
addStub('src/music/radioEmbed.js', 'export const buildRadioEmbed = () => ({}); export const buildQueueEmbed = () => ({ title: "fila" });');
addStub('src/music/radioProviders.js', `export const resolveInput = async () => ${S}.resolved;`);
addStub('src/music/radioPrefetcher.js', 'export const prefetchNextTrack = async () => {}; export const cleanupSessionAudioFiles = () => {};');

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const hit = stubs.get(String(resolved.url).toLowerCase());
    return hit ? { url: hit, shortCircuit: true } : resolved;
  },
});

// ── Módulos sob teste ───────────────────────────────────────────────────────────────────────────
const radio = await import('../src/music/radioManager.js');
const { parseRadioIntent } = await import('../src/music/radioIntentEngine.js');
const imageHandler = await import('../src/handlers/imageHandler.js');
const cfg = await import('../src/handlers/configPanelHandler.js');
const mc = await import('../src/events/messageCreate.js');
const { default: appConfig } = await import('../src/config/index.js');
const { UNTRUSTED_OPEN, UNTRUSTED_CLOSE } = await import('../src/handlers/llmSafety.js');
const messageCreate = mc.default;
const { readTextAttachments, buildAttachmentPrompt, attachmentDeps } = mc;
const read = (rel) => fs.readFileSync(path.join(repoRoot, rel), 'utf8');

// ── Mini-runner ─────────────────────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FALHA ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n        ')}`); }
};
const section = (t) => console.log(`\n${t}`);
const json = (e) => (e && typeof e.toJSON === 'function' ? e.toJSON() : e);

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('M3. Rádio: eco de título/busca no canal não notifica ninguém além de quem pediu');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const AUTHOR = '111111111111111111';
const OTHER = '444444444444444444';
const ROLE = '333333333333333333';
const HOSTILE = `Hino @everyone @here <@&${ROLE}> <@${OTHER}> fim`;

/** O que o Discord notificaria com este texto e este allowedMentions (sem allowedMentions: tudo que está no texto). */
function wouldPing(content, allowed) {
  const parse = allowed === undefined ? null : (allowed.parse ?? []);
  const allow = (kind) => parse === null || parse.includes(kind);
  const text = String(content ?? '');
  const users = new Set();
  const roles = new Set();
  const everyone = /@(everyone|here)\b/i.test(text) && allow('everyone');
  for (const m of text.matchAll(/<@!?(\d{15,25})>/g)) if (allow('users') || (allowed?.users ?? []).includes(m[1])) users.add(m[1]);
  for (const m of text.matchAll(/<@&(\d{15,25})>/g)) if (allow('roles') || (allowed?.roles ?? []).includes(m[1])) roles.add(m[1]);
  return { everyone, users: [...users], roles: [...roles] };
}
const asPayload = (p) => (typeof p === 'string' ? { content: p } : p);

function fakeChannel() {
  const ch = {
    id: 'text1', name: 'geral', sent: [],
    guild: { members: { cache: new Map() } },
    messages: { fetch: async () => ({ delete: async () => ({}) }) },
    send: async (p) => {
      ch.sent.push(p);
      const m = { id: `sent${ch.sent.length}`, edits: [], edit: async (e) => { m.edits.push(e); return m; }, delete: async () => ({}) };
      return m;
    },
  };
  return ch;
}
function setSession(extra = {}) {
  state.session = { status: 'PLAYING', playlist: [], currentTrack: null, ...extra };
}
const hostileTrack = { title: HOSTILE, artist: '@everyone', url: 'https://exemplo.test/x', duration: 100 };

// Os temporizadores do código sob teste (apagar a mensagem em 4 a 10 s) viram 1 ms; o relógio de verdade volta no fim da seção.
globalThis.setTimeout = (fn, ms, ...rest) => realSetTimeout(fn, ms >= 1000 ? 1 : ms, ...rest);

await test('o controle do teste: o formato ANTIGO (texto cru, sem allowedMentions) notificaria todo mundo', () => {
  const old = wouldPing(`<@${AUTHOR}> [⚡] Adicionada à fila: **${HOSTILE}**`, undefined);
  assert.equal(old.everyone, true);
  assert.deepEqual(old.roles, [ROLE]);
  assert.deepEqual(old.users.sort(), [AUTHOR, OTHER].sort());
});
await test('radioAllowedMentions: só um ID de verdade (15 a 25 dígitos) é notificado; o resto não notifica ninguém', () => {
  assert.deepEqual(radio.radioAllowedMentions(AUTHOR), { parse: [], users: [AUTHOR] });
  for (const bad of [undefined, null, '', 'abc', '123', '<@&1>', `${AUTHOR}> @everyone`, '1'.repeat(26), -1]) {
    assert.deepEqual(radio.radioAllowedMentions(bad), { parse: [], users: [] }, String(bad));
  }
});
await test('sendNotify (ADD, faixa achada): título e artista com @everyone/@here/cargo/outro usuário NÃO notificam; o autor continua marcado', async () => {
  assert.equal(parseRadioIntent('toca roxette')?.type, 'ADD');
  setSession();
  state.resolved = { type: 'track', track: { ...hostileTrack } };
  const ch = fakeChannel();
  await radio.processDirectRadioVoiceCommand('toca roxette', AUTHOR, 'g1', ch, {});
  assert.equal(ch.sent.length, 2, 'Buscando... + Adicionada à fila');
  for (const raw of ch.sent) {
    const p = asPayload(raw);
    assert.deepEqual(p.allowedMentions, { parse: [], users: [AUTHOR] });
    assert.ok(p.content.startsWith(`<@${AUTHOR}> [⚡] `), 'o autor continua marcado no começo');
    assert.deepEqual(wouldPing(p.content, p.allowedMentions), { everyone: false, users: [AUTHOR], roles: [] });
  }
  const last = asPayload(ch.sent[1]).content;
  assert.ok(!/@(everyone|here)\b/i.test(last), 'sem @everyone/@here crus no texto');
  assert.ok(last.includes('Hino') && last.includes('fim'), 'o título continua legível');
});
await test('sendNotify: a busca falada com @everyone e <@&cargo> (eco do "Buscando" e do "não encontrada") também não notifica', async () => {
  setSession();
  state.resolved = { type: 'not_found' };
  const ch = fakeChannel();
  await radio.processDirectRadioVoiceCommand(`toca @everyone <@&${ROLE}> <@${OTHER}>`, AUTHOR, 'g1', ch, {});
  assert.ok(ch.sent.length >= 2, `${ch.sent.length} mensagem(ns)`);
  for (const raw of ch.sent) {
    const p = asPayload(raw);
    assert.deepEqual(wouldPing(p.content, p.allowedMentions), { everyone: false, users: [AUTHOR], roles: [] });
  }
});
await test('sendNotify: "Pulando para" e "Voltando para" (título de fora) e as mensagens fixas levam o mesmo allowedMentions', async () => {
  setSession();
  state.nextTrackValue = { ...hostileTrack };
  state.prevTrackValue = { ...hostileTrack };
  for (const falado of ['pula', 'voltar', 'pausa', 'parar']) {
    const ch = fakeChannel();
    await radio.processDirectRadioVoiceCommand(falado, AUTHOR, 'g1', ch, {});
    assert.ok(ch.sent.length >= 1, falado);
    for (const raw of ch.sent) {
      const p = asPayload(raw);
      assert.equal(typeof raw, 'object', `${falado}: payload com allowedMentions, não texto cru`);
      assert.deepEqual(wouldPing(p.content, p.allowedMentions), { everyone: false, users: [AUTHOR], roles: [] }, falado);
    }
  }
  state.nextTrackValue = null;
  state.prevTrackValue = null;
});
await test('mensagem da fila do rádio: o autor é marcado e mais ninguém', async () => {
  setSession({ playlist: [{ title: HOSTILE }] });
  const ch = fakeChannel();
  await radio.processDirectRadioVoiceCommand('mostra a fila', AUTHOR, 'g1', ch, {});
  assert.equal(ch.sent.length, 1);
  assert.deepEqual(ch.sent[0].allowedMentions, { parse: [], users: [AUTHOR] });
  assert.ok(ch.sent[0].content.startsWith(`<@${AUTHOR}> `));
});
await test('adaptador de resposta (voz -> IA -> ferramenta do rádio): texto com título de fora só notifica o autor', async () => {
  const ch = fakeChannel();
  state.queue.length = 0;
  await radio.processRadioVoiceCommand('toca algo', AUTHOR, 'g1', ch, {});
  assert.equal(state.queue.length, 1, 'o pedido foi para a fila da IA');
  const [prompt, ctx, type, options] = state.queue[0];
  assert.equal(prompt, 'toca algo');
  assert.equal(type, 'mention');
  assert.equal(options.radioMode, true);
  assert.ok(!('voice' in options), 'a mensagem do rádio nunca ganha options.voice');
  const sent = await ctx.reply(`<@${AUTHOR}> Tocando **${HOSTILE}**`);
  assert.ok(sent, 'devolve a mensagem enviada');
  assert.equal(ch.sent.length, 1);
  const p = asPayload(ch.sent[0]);
  assert.deepEqual(p.allowedMentions, { parse: [], users: [AUTHOR] });
  assert.deepEqual(wouldPing(p.content, p.allowedMentions), { everyone: false, users: [AUTHOR], roles: [] });
  assert.ok(!/@(everyone|here)\b/i.test(p.content));
  // objeto { content } também; sem content nada é enviado
  await ctx.reply({ content: `@here ${HOSTILE}` });
  assert.equal(ch.sent.length, 2);
  assert.deepEqual(wouldPing(ch.sent[1].content, ch.sent[1].allowedMentions), { everyone: false, users: [], roles: [] }, 'sem o autor no texto, ninguém é notificado');
  assert.equal(await ctx.reply({ embeds: [] }), null);
  assert.equal(ch.sent.length, 2);
});
await test('seleção automática da 1ª opção (editar a mensagem com o título): sem @everyone cru e com allowedMentions vazio', async () => {
  const ch = fakeChannel();
  const edits = [];
  const target = { edit: async (p) => { edits.push(p); return {}; }, delete: async () => ({}) };
  const key = 'radio_ambiguous_g1_u1';
  radio.radioAmbiguousSessions.set(key, { results: [{ ...hostileTrack }], guildId: 'g1', userId: AUTHOR, textChannel: ch, client: {} });
  setSession({ status: 'PLAYING' });
  radio.scheduleAmbiguousAutoSelect(key, target);
  await sleep(80);
  assert.equal(edits.length, 1);
  assert.deepEqual(edits[0].allowedMentions, { parse: [] });
  assert.deepEqual(wouldPing(edits[0].content, edits[0].allowedMentions), { everyone: false, users: [], roles: [] });
  assert.ok(!/@(everyone|here)\b/i.test(edits[0].content));
  // o mesmo caminho com editReply (interação)
  const replies = [];
  const target2 = { editReply: async (p) => { replies.push(p); return {}; }, deleteReply: async () => ({}) };
  radio.radioAmbiguousSessions.set(key, { results: [{ ...hostileTrack }], guildId: 'g1', userId: AUTHOR, textChannel: ch, client: {} });
  radio.scheduleAmbiguousAutoSelect(key, target2);
  await sleep(80);
  assert.equal(replies.length, 1);
  assert.deepEqual(replies[0].allowedMentions, { parse: [] });
});
await test('no código-fonte: todo textChannel.send com o texto do autor, do eco ou do adaptador leva allowedMentions; sem console.*', () => {
  const src = read('src/music/radioManager.js');
  const calls = [...src.matchAll(/\.send\(([^;]*);/g)].map((m) => m[0]);
  const risky = calls.filter((c) => /\$\{userId\}|\bcontent\b|msgText/.test(c));
  assert.ok(risky.length >= 3, `só ${risky.length} envios de risco achados`);
  for (const c of risky) assert.ok(c.includes('allowedMentions'), `sem allowedMentions: ${c.slice(0, 90)}`);
  assert.ok(src.includes("import { neutralizeMassMentions } from '../discord/mentions.js'"));
  assert.ok(!/console\.(log|warn|error)/.test(src));
});
await sleep(20); // deixa os temporizadores curtos do código sob teste dispararem antes de devolver o relógio
globalThis.setTimeout = realSetTimeout;

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('B9. imageHandler: o prompt de imagem não vai para o log nem para o console');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const SECRET = 'PROMPT-SECRETO-XYZ';
const realFetch = globalThis.fetch;
/** Roda generateImage com console e fetch sob controle; devolve o resultado, o que foi para o logger e o que foi para o console. */
async function runImage({ provider, prompt, fetchImpl }) {
  state.logs.length = 0;
  const consoleCalls = [];
  const saved = {};
  for (const k of ['log', 'info', 'warn', 'error', 'debug']) { saved[k] = console[k]; console[k] = (...a) => { consoleCalls.push([k, a.map(String).join(' ')]); }; }
  globalThis.fetch = fetchImpl;
  process.env.HF_TOKEN = 'token-de-teste'; // lido por config.hfToken; nunca impresso
  let result;
  try { result = await imageHandler.generateImage(prompt, '', 512, 512, { provider }); }
  finally {
    globalThis.fetch = realFetch;
    delete process.env.HF_TOKEN;
    for (const k of Object.keys(saved)) console[k] = saved[k];
  }
  return { result, logs: state.logs.map(([l, m]) => `${l}: ${m}`), consoleCalls };
}
const allText = (r) => [...r.logs, ...r.consoleCalls.map((c) => c.join(': '))].join('\n');

await test('o prompt vai para o logger só como tamanho; nada de console.*', async () => {
  const prompt = `desenhe ${SECRET} num campo de flores`;
  const r = await runImage({ provider: 'huggingface', prompt, fetchImpl: async () => ({ ok: false, status: 400, text: async () => `detalhe-do-provedor: ${SECRET} foi recusado` }) });
  assert.equal(r.result, null, 'todos os provedores falharam: null (como antes)');
  assert.equal(r.consoleCalls.length, 0, `console.* foi usado: ${JSON.stringify(r.consoleCalls)}`);
  assert.ok(r.logs.some((l) => l.startsWith('info: ') && l.includes(`Prompt: ${prompt.length} caracteres`) && l.includes('huggingface')), r.logs.join(' | '));
  assert.ok(!allText(r).includes(SECRET), 'o texto do prompt vazou para o log');
  assert.ok(!allText(r).includes('detalhe-do-provedor'), 'o corpo da resposta do provedor (pode repetir o prompt) vazou para o log');
  assert.ok(r.logs.some((l) => l.startsWith('warn: ') && l.includes('HuggingFace HTTP 400')), 'o motivo curto continua no log');
  assert.ok(r.logs.some((l) => l.startsWith('error: ') && l.includes('CRITICAL')));
});
await test('prompt de 5000 caracteres: só o tamanho (5000) no log', async () => {
  const prompt = `${SECRET} `.padEnd(5000, 'x');
  assert.equal(prompt.length, 5000);
  const r = await runImage({ provider: 'pollinations', prompt, fetchImpl: async () => ({ ok: false, status: 503 }) });
  assert.equal(r.result, null);
  assert.ok(r.logs.some((l) => l.includes('Prompt: 5000 caracteres')));
  assert.ok(!allText(r).includes(SECRET));
  assert.ok(Math.max(...r.logs.map((l) => l.length)) < 400, 'linhas de log curtas');
  assert.equal(r.consoleCalls.length, 0);
});
await test('erro de biblioteca/rede com o prompt na mensagem: o log leva só o nome do erro (nunca a mensagem)', async () => {
  const r = await runImage({
    provider: 'pollinations', prompt: `foto de ${SECRET}`,
    fetchImpl: async () => { const e = new Error(`falha ao buscar ${SECRET} no servidor`); e.name = 'FetchError'; e.code = 'ECONNRESET'; throw e; },
  });
  assert.equal(r.result, null);
  assert.ok(!allText(r).includes(SECRET));
  assert.ok(r.logs.some((l) => l.startsWith('warn: ') && l.includes('FetchError ECONNRESET')), r.logs.join(' | '));
});
await test('content-type inesperado: o log leva o motivo e não o resto (a mensagem do provedor pode ecoar o prompt)', async () => {
  const r = await runImage({
    provider: 'pollinations', prompt: `foto de ${SECRET}`,
    fetchImpl: async () => ({ ok: true, status: 200, headers: { get: () => 'text/html' }, arrayBuffer: async () => new ArrayBuffer(0) }),
  });
  assert.equal(r.result, null, 'nada é gravado em disco neste caminho');
  assert.ok(r.logs.some((l) => l.includes('Pollinations retornou content-type inesperado')), r.logs.join(' | '));
  assert.ok(!allText(r).includes('text/html'), 'o que vem depois do motivo fica de fora');
  assert.ok(!allText(r).includes(SECRET));
});
await test('provedor escolhido gigante ou com lixo no nome: o log corta em 30 caracteres', async () => {
  const r = await runImage({ provider: `${SECRET}${'y'.repeat(200)}`, prompt: 'qualquer', fetchImpl: async () => ({ ok: false, status: 500 }) });
  assert.ok(!allText(r).includes(SECRET + 'y'.repeat(100)));
  assert.ok(r.logs.some((l) => l.includes(`Provedor: ${SECRET.slice(0, 30)}`)));
});
await test('no código-fonte: nenhum console.* no imageHandler', () => {
  const src = read('src/handlers/imageHandler.js');
  assert.ok(!/console\.(log|info|warn|error|debug)/.test(src));
  assert.ok(src.includes("import { logger } from '../utils/logger.js'"));
  assert.ok(!src.includes('prompt.substring('), 'o trecho do prompt não é mais montado para log');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('Reg 6. Painel de configuração: o texto de persistência "json" é honesto');
// ═════════════════════════════════════════════════════════════════════════════════════════════
/** Renderiza a página n do painel (pelo menu "Ir Para") e devolve o embed como JSON. */
async function panelPage(n) {
  let captured = null;
  await cfg.handleConfigSelect({ customId: 'cfgpanel_goto_select', values: [`cfgpage_${n}`], update: async (p) => { captured = p; } });
  return json(captured.embeds[0]);
}
const field = (embed, name) => (embed.fields ?? []).find((f) => f.name === name);
const pages = [];
for (let n = 1; n <= 200; n++) {
  const e = await panelPage(n);
  if (!String(e.footer?.text ?? '').startsWith(`Página ${n}/`)) break; // passou da última: volta a Home
  pages.push(e);
}

await test('o painel tem páginas runtime e páginas json (a conta não é vazia)', () => {
  const kinds = pages.map((e) => (field(e, '💽 Persistência')?.value ?? '').startsWith('⚡') ? 'runtime' : 'json');
  assert.ok(pages.length >= 30, `${pages.length} páginas`);
  assert.ok(kinds.filter((k) => k === 'runtime').length >= 10 && kinds.filter((k) => k === 'json').length >= 10);
});
await test('páginas json: "aplicado agora", gravado no config.json, o arquivo não é lido ao iniciar e o .env manda; nunca "salvo em disco"', () => {
  const jsonFields = pages.map((e) => field(e, '💽 Persistência')).filter((f) => f && !f.value.startsWith('⚡'));
  assert.ok(jsonFields.length >= 10);
  for (const f of jsonFields) {
    assert.ok(f.value.includes('Aplicado agora'), f.value);
    assert.ok(f.value.includes('src/config/config.json'));
    assert.ok(f.value.includes('esse arquivo ainda não é lido ao iniciar'));
    assert.ok(f.value.includes('.env') && f.value.includes('prioridade') && f.value.includes('padrão'));
    assert.ok(!/salvo em disco|permanente/i.test(f.value), f.value);
    assert.ok(f.value.length <= 1024);
  }
});
await test('páginas runtime continuam como antes ("volta ao padrão no restart")', () => {
  const rt = pages.map((e) => field(e, '💽 Persistência')).filter((f) => f && f.value.startsWith('⚡'));
  assert.ok(rt.length >= 10);
  for (const f of rt) assert.equal(f.value, '⚡ Runtime (volta ao padrão no restart)');
});
await test('aviso do .env: variável que o código LÊ (COMMAND_PREFIX) avisa que o valor vale só até reiniciar; sem a variável, sem aviso', async () => {
  const idx = pages.findIndex((e) => /Prefixo de Comandos/.test(e.title)) + 1;
  assert.ok(idx > 0);
  delete process.env.COMMAND_PREFIX;
  assert.equal(field(await panelPage(idx), '⚠️ Aviso de Ambiente'), undefined);
  process.env.COMMAND_PREFIX = '!';
  try {
    const warn = field(await panelPage(idx), '⚠️ Aviso de Ambiente');
    assert.ok(warn, 'sem aviso com a variável ativa');
    assert.ok(warn.value.includes('COMMAND_PREFIX') && warn.value.includes('só até reiniciar') && warn.value.includes('prioridade'), warn.value);
    assert.ok(!warn.value.includes('não terá efeito'), 'o valor É aplicado na hora: dizer que não tem efeito era falso');
  } finally { delete process.env.COMMAND_PREFIX; }
});
await test('aviso do .env: nomes antigos que nada lê (PREFIX, BOT_NAME, SAVE_HISTORY...) não geram aviso à toa', async () => {
  const legacy = { 'Prefixo de Comandos': 'PREFIX', 'Nome do Bot': 'BOT_NAME' };
  for (const [label, envName] of Object.entries(legacy)) {
    const idx = pages.findIndex((e) => e.title.includes(label)) + 1;
    assert.ok(idx > 0, label);
    process.env[envName] = 'x';
    try { assert.equal(field(await panelPage(idx), '⚠️ Aviso de Ambiente'), undefined, envName); } finally { delete process.env[envName]; }
  }
  const idx = pages.findIndex((e) => (e.footer?.text ?? '').includes('saveHistory')) + 1;
  assert.ok(idx > 0);
  process.env.SAVE_HISTORY = 'false';
  try { assert.equal(field(await panelPage(idx), '⚠️ Aviso de Ambiente'), undefined); } finally { delete process.env.SAVE_HISTORY; }
});
await test('updateConfigJson: aplica na hora (em memória) e grava o arquivo indicado; nada lê o config.json na subida (não foi implementado)', () => {
  const file = path.join(tmp, 'config-copia.json');
  fs.writeFileSync(file, '{ "prefix": "_", "botName": "Yui" }\n');
  assert.equal(cfg.updateConfigJson('botName', 'Outra', file), true);
  assert.equal(appConfig.botName, 'Outra', 'aplicado agora');
  assert.equal(JSON.parse(fs.readFileSync(file, 'utf8')).botName, 'Outra', 'gravado no arquivo');
  appConfig.botName = 'Yui';
  assert.ok(!/config\.json/.test(read('src/config/index.js')), 'a leitura do config.json na subida NÃO faz parte deste pacote');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('Reg 4. Anexo: o aviso "Você NÃO leu" só quando faz sentido');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const att = (name, { size = 3000, contentType = null } = {}) => ({ name, size, url: `https://cdn.discordapp.com/attachments/1/2/${encodeURIComponent(name)}?ex=aa&is=bb&hm=cc`, contentType });
function fakeFetch(map = {}, fallback = 'texto do arquivo') {
  const log = [];
  const f = async (url) => {
    const name = decodeURIComponent(new URL(url).pathname.split('/').pop());
    log.push(name);
    const v = name in map ? map[name] : fallback;
    if (v instanceof Error) throw v;
    if (v && typeof v === 'object') return v;
    return { ok: true, status: 200, text: String(v), truncated: false };
  };
  f.log = log;
  return f;
}
const readAtt = (list, fetchImpl = fakeFetch(), env = {}) => readTextAttachments(list, { fetchText: fetchImpl, env });
const NOT_READ = /NÃO leu/;

await test('readTextAttachments passa a informar textLike (o tipo é .txt/.md/.log) em cada item', async () => {
  const r = await readAtt([att('a.txt'), att('foto.png', { size: 120000 }), att('b.md'), att('c.log'), att('d.txt', { contentType: 'image/png' })]);
  assert.deepEqual(r.items.map((i) => i.textLike), [true, false, true, true, false]);
});
await test('SEM a opção hasText (ou hasText:false) o texto é o de sempre: todo anexo não lido é avisado', async () => {
  const r = await readAtt([att('notas.txt'), att('foto.png', { size: 120000 }), att('grande.txt', { size: 500000 })]);
  const expected = '[Você NÃO leu: foto.png (tipo de arquivo que você não lê), grande.txt (passa de 100 KB). Avise isso em uma frase e não invente o conteúdo.]';
  assert.equal(buildAttachmentPrompt(r).split('\n')[1], expected);
  assert.equal(buildAttachmentPrompt(r, {}).split('\n')[1], expected);
  assert.equal(buildAttachmentPrompt(r, { hasText: false }).split('\n')[1], expected);
  assert.equal(buildAttachmentPrompt(null, { hasText: true }), '');
  assert.equal(buildAttachmentPrompt({ total: 0 }, { hasText: true }), '');
});
await test('hasText + foto: só a nota neutra "[o usuário anexou: ...]", SEM "NÃO leu" e SEM "Avise"', async () => {
  const r = await readAtt([att('foto.png', { size: 120000 })]);
  const p = buildAttachmentPrompt(r, { hasText: true });
  assert.equal(p, '[o usuário anexou: foto.png (117 KB)]');
  assert.ok(!NOT_READ.test(p) && !/Avise/.test(p));
});
await test('hasText + vários tipos que ela não lê (imagem, vídeo, PDF, zip): nota neutra com todos, sem aviso', async () => {
  const r = await readAtt([att('a.png', { size: 2048 }), att('b.mp4', { size: 5 * 1024 * 1024 }), att('c.pdf', { size: 4096 }), att('d.zip', { size: 1024 })]);
  const p = buildAttachmentPrompt(r, { hasText: true });
  assert.equal(p.split('\n').length, 1);
  assert.match(p, /^\[o usuário anexou: a\.png \(2 KB\), b\.mp4 \(5120 KB\), c\.pdf \(4 KB\), d\.zip \(1 KB\)\]$/);
});
await test('hasText + .txt cuja leitura FALHOU: o aviso fica, só com o .txt (a foto junto não entra)', async () => {
  const f = fakeFetch({ 'notas.txt': new Error('rede caiu (teste)') });
  const r = await readAtt([att('notas.txt'), att('foto.png', { size: 120000 })], f);
  const lines = buildAttachmentPrompt(r, { hasText: true }).split('\n');
  assert.equal(lines[0], '[o usuário anexou: notas.txt (3 KB), foto.png (117 KB)]');
  assert.equal(lines[1], '[Você NÃO leu: notas.txt (falha ao baixar). Avise isso em uma frase e não invente o conteúdo.]');
  assert.equal(lines.length, 2);
});
await test('hasText + .md grande demais, .log com binário e .txt vazio: o aviso lista cada um com o motivo', async () => {
  const f = fakeFetch({ 'bin.log': `\u0000\u0001${'\u0000'.repeat(60)}`, 'vazio.txt': '   \n ' });
  const r = await readAtt([att('grande.md', { size: 500000 }), att('bin.log'), att('vazio.txt'), att('foto.png', { size: 120000 })], f);
  const warn = buildAttachmentPrompt(r, { hasText: true }).split('\n')[1];
  assert.equal(warn, '[Você NÃO leu: grande.md (passa de 100 KB), bin.log (não parece texto), vazio.txt (arquivo vazio). Avise isso em uma frase e não invente o conteúdo.]');
});
await test('hasText + leitura desligada (YUI_READ_TEXT_ATTACHMENTS=false): o .txt é avisado, a foto não', async () => {
  const f = fakeFetch();
  const r = await readAtt([att('notas.txt'), att('foto.png', { size: 120000 })], f, { YUI_READ_TEXT_ATTACHMENTS: 'false' });
  assert.equal(f.log.length, 0, 'nada foi baixado');
  const lines = buildAttachmentPrompt(r, { hasText: true }).split('\n');
  assert.equal(lines[1], '[Você NÃO leu: notas.txt (a leitura de anexos está desligada). Avise isso em uma frase e não invente o conteúdo.]');
});
await test('hasText + .txt lido + foto: o conteúdo vem CERCADO como dado não confiável e não há aviso', async () => {
  const r = await readAtt([att('notas.txt'), att('foto.png', { size: 120000 })], fakeFetch({ 'notas.txt': 'lista de mods' }));
  const p = buildAttachmentPrompt(r, { hasText: true });
  assert.ok(!NOT_READ.test(p));
  assert.ok(p.includes(`Conteúdo de notas.txt:\n${UNTRUSTED_OPEN}\nlista de mods\n${UNTRUSTED_CLOSE}`), p);
  assert.equal(r.readCount, 1);
});
await test('SEM texto próprio: a foto junto de um .txt lido continua avisada (como sempre foi)', async () => {
  const r = await readAtt([att('notas.txt'), att('foto.png', { size: 120000 })], fakeFetch({ 'notas.txt': 'algo' }));
  const p = buildAttachmentPrompt(r, { hasText: false });
  assert.match(p, /\[Você NÃO leu: foto\.png \(tipo de arquivo que você não lê\)\. Avise isso em uma frase/);
});
await test('hasText + mais de 5 anexos: os "não listados" ficam só no rótulo da nota (sem aviso); sem texto próprio o aviso os cita', async () => {
  const many = Array.from({ length: 7 }, (_, i) => att(`p${i}.png`, { size: 2048 }));
  const r = await readAtt(many);
  const withText = buildAttachmentPrompt(r, { hasText: true });
  assert.ok(withText.includes('e mais 2]') && !NOT_READ.test(withText) && !withText.includes('não listados'));
  assert.match(buildAttachmentPrompt(r, { hasText: false }), /mais 2 anexo\(s\) \(não listados\)/);
});
await test('hasText + resultado montado à mão sem textLike: "type" sem tentativa de leitura é tipo que ela não lê (não avisa); falha de rede avisa', () => {
  const hand = { total: 2, hidden: 0, label: 'a.png (1 KB), b.txt (1 KB)', maxKb: 100, blocks: [], items: [
    { name: 'a.png', status: 'skipped', reason: 'type' },
    { name: 'b.txt', status: 'failed', reason: 'fetch' },
  ] };
  const lines = buildAttachmentPrompt(hand, { hasText: true }).split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[1], '[Você NÃO leu: b.txt (falha ao baixar). Avise isso em uma frase e não invente o conteúdo.]');
});

// ── fluxo REAL da menção (execute -> addToQueue), com o llmHandler trocado por um dublê que só anota a chamada ───────────────
const BOT = 'BOT1';
const client = { user: { id: BOT, username: 'Yui' }, users: { cache: new Map() }, channels: { cache: new Map() } };
let seq = 9000;
function makeMsg({ content, authorId, attachments = [] }) {
  const channel = { id: 'chan-r4', name: undefined, messages: { cache: new Map(), fetch: async () => new Map() }, send: async () => ({}) };
  const replies = [];
  return {
    id: `m${seq++}`, content, replies,
    author: { id: authorId ?? `U${seq}`, username: 'alice', bot: false, tag: 'alice#0001' },
    createdTimestamp: Date.now(), guildId: null, guild: null, channelId: channel.id, channel,
    mentions: { has: () => true, everyone: false, repliedUser: null },
    reference: null, attachments, client,
    reply: async (p) => { replies.push(typeof p === 'string' ? p : p?.content); return {}; },
  };
}
const realFetchText = attachmentDeps.fetchText;
/** Roda a menção e devolve [prompt, message, type, options] da chamada a addToQueue (ou null se não houve). */
async function mention(msg, fetchImpl = fakeFetch()) {
  state.queue.length = 0;
  attachmentDeps.fetchText = fetchImpl;
  try { await messageCreate.execute(msg, client); } finally { attachmentDeps.fetchText = realFetchText; }
  return state.queue.length ? state.queue[0] : null;
}

await test('menção com texto + foto: o prompt leva a nota neutra, NÃO leva "NÃO leu" nem "Avise"; searchPrompt é só a fala', async () => {
  const q = await mention(makeMsg({ content: `<@${BOT}> o que é isso?`, attachments: [att('foto.png', { size: 120000 })] }));
  assert.ok(q, 'foi para a fila da IA');
  const [prompt, , type, options] = q;
  assert.equal(type, 'mention');
  assert.ok(prompt.includes('alice: "o que é isso?"\n[o usuário anexou: foto.png (117 KB)]\nINSTRUÇÃO: Responda diretamente'), prompt.slice(-260));
  assert.ok(!NOT_READ.test(prompt) && !/Avise isso/.test(prompt));
  assert.equal(options.searchPrompt, 'o que é isso?');
  assert.ok(!/anexou/.test(options.searchPrompt));
  assert.equal(options.disableTools, undefined, 'foto não lida: as ferramentas seguem como antes');
  assert.equal(options.attachmentBlock, undefined);
});
await test('menção com texto + .txt que falhou ao baixar: o aviso fica (só com o .txt)', async () => {
  const f = fakeFetch({ 'notas.txt': new Error('rede caiu (teste)') });
  const q = await mention(makeMsg({ content: `<@${BOT}> resume isso`, attachments: [att('notas.txt'), att('foto.png', { size: 120000 })] }), f);
  const [prompt, , , options] = q;
  assert.ok(prompt.includes('[Você NÃO leu: notas.txt (falha ao baixar). Avise isso em uma frase e não invente o conteúdo.]'));
  assert.ok(!prompt.includes('foto.png (tipo de arquivo'));
  assert.equal(options.searchPrompt, 'resume isso');
  assert.equal(options.disableTools, undefined, 'nada foi lido: sem texto de arquivo no prompt');
});
await test('menção com texto + .txt lido + foto: bloco cercado, sem aviso, ferramentas desligadas e attachmentBlock é o trecho EXATO do prompt', async () => {
  const f = fakeFetch({ 'notas.txt': 'SEGREDO-DO-ARQUIVO' });
  const q = await mention(makeMsg({ content: `<@${BOT}> resume`, attachments: [att('notas.txt'), att('foto.png', { size: 120000 })] }), f);
  const [prompt, , , options] = q;
  assert.ok(!NOT_READ.test(prompt));
  assert.ok(prompt.includes('SEGREDO-DO-ARQUIVO') && prompt.includes('[o usuário anexou: notas.txt (3 KB), foto.png (117 KB)]'));
  assert.equal(options.disableTools, true);
  assert.ok(options.attachmentBlock && prompt.includes(options.attachmentBlock));
  assert.ok(!options.searchPrompt.includes('SEGREDO') && options.searchPrompt === 'resume');
});
await test('menção SEM texto + .txt lido + foto: a foto continua avisada; searchPrompt neutro (sem nome nem conteúdo)', async () => {
  const f = fakeFetch({ 'message.txt': 'texto colado' });
  const q = await mention(makeMsg({ content: `<@${BOT}>`, attachments: [att('message.txt'), att('foto.png', { size: 120000 })] }), f);
  const [prompt, , , options] = q;
  assert.ok(prompt.includes('alice: "(mensagem sem texto, só com o anexo abaixo)"'));
  assert.ok(prompt.includes('[Você NÃO leu: foto.png (tipo de arquivo que você não lê). Avise isso em uma frase e não invente o conteúdo.]'));
  assert.equal(options.searchPrompt, '(enviou um arquivo de texto)');
});
await test('menção SÓ com foto: resposta fixa, sem IA (como antes)', async () => {
  const msg = makeMsg({ content: `<@${BOT}>`, authorId: 'U-so-foto', attachments: [att('foto.png', { size: 120000 })] });
  const q = await mention(msg);
  assert.equal(q, null, 'a IA não foi chamada');
  assert.equal(msg.replies.length, 1);
  assert.match(msg.replies[0], /só leio arquivos \.txt, \.md e \.log/);
});
await test('menção com texto e leitura desligada: o .txt é avisado como "desligada"', async () => {
  process.env.YUI_READ_TEXT_ATTACHMENTS = 'false';
  try {
    const q = await mention(makeMsg({ content: `<@${BOT}> leia isto`, attachments: [att('notas.txt')] }));
    assert.ok(q[0].includes('[Você NÃO leu: notas.txt (a leitura de anexos está desligada). Avise isso em uma frase'));
  } finally { delete process.env.YUI_READ_TEXT_ATTACHMENTS; }
});
await test('menção sem anexo: o prompt é o de sempre (sem linha extra entre a fala e a INSTRUÇÃO)', async () => {
  const q = await mention(makeMsg({ content: `<@${BOT}> qual a capital da frança hoje` }));
  assert.ok(q[0].includes('--- MENSAGEM ATUAL ---\nalice: "qual a capital da frança hoje"\nINSTRUÇÃO: Responda diretamente à mensagem atual.'));
});
await test('no código-fonte: a nota do anexo nunca entra em searchPrompt; a chamada passa { hasText }', () => {
  const src = read('src/events/messageCreate.js');
  assert.ok(src.includes('buildAttachmentPrompt(attachments, { hasText })'));
  assert.equal(src.split('searchPrompt: hasText ? currentUserPrompt : ATTACH_ONLY_SEARCH_PROMPT').length - 1, 1);
  assert.ok(!/searchPrompt:[^,}]*attachment/i.test(src.replace('ATTACH_ONLY_SEARCH_PROMPT', 'x')));
  assert.ok(src.includes('attachments.readCount > 0 ? { disableTools: true, attachmentBlock: attachmentPrompt } : {}'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} ok, ${failures.length} falha(s)`);
process.chdir(repoRoot); // no Windows não dá para apagar a pasta onde o processo está
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* sobra em %TEMP% */ }
if (failures.length) { console.log(`FALHAS: ${failures.join(' | ')}`); process.exit(1); }
process.exit(0);
