// Testes do Pacote 6a: painéis, listas e embeds que estouravam os limites do Discord (TG-03, TG-04, TG-17, TG-19 parte do painel
// do servidor, TG-31, TG-34), o menu "Ir Para" e o __dirname do painel de configuração, e o eco de busca do rádio.
// Rodam SEM Discord, SEM rede e SEM bancos reais: as dependências pesadas (llmHandler, núcleo de memória, repositórios, rádio,
// logger) são trocadas por dublês via module.registerHooks, e nada é gravado em arquivo do projeto (src/config/config.json
// só é lido; as gravações do teste vão para uma pasta temporária).
// Execução: npm run test:embedpanels   (ou: node tests/test-embed-panels.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-embed-panels-'));
Object.assign(process.env, {
  DATABASE_DIR: tmp,
  YUI_OWNER_ID: '111',
  YUI_ALERTS: 'false',
  YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'),
  LOG_LEVEL: 'error',
});
process.chdir(tmp); // .env e logs/ do projeto ficam fora do teste

// ── Estado compartilhado com os dublês ──────────────────────────────────────────────────────────
const state = {
  tools: [], disabled: [], calls: [], persona: [], logs: [],
  ytSubs: [], twSubs: [], memRows: [], adminUsers: { users: [], total: 0 }, adminRows: [],
  session: null, resolved: { type: 'not_found' }, nextTrackValue: null,
  sent: [],
};
globalThis.__p6a = state;

// ── Dublês (módulos pequenos escritos na pasta temporária) ──────────────────────────────────────
const stubDir = path.join(tmp, 'stubs');
fs.mkdirSync(stubDir);
const writeStub = (name, code) => { const f = path.join(stubDir, name); fs.writeFileSync(f, code); return pathToFileURL(f).href; };
const S = 'globalThis.__p6a';
const stubs = new Map();
const addStub = (rel, code) => stubs.set(pathToFileURL(path.join(repoRoot, rel)).href.toLowerCase(), writeStub(`${stubs.size}.mjs`, code));

addStub('src/handlers/llmHandler.js', `
export const getAllMcpTools = () => ${S}.tools;
export const getDisabledTools = () => ${S}.disabled;
export const setServerToolEnabled = (g, n, e) => { ${S}.calls.push(['toggle', g, n, e]); return true; };
export const resetServerTools = (g) => { ${S}.calls.push(['reset', g]); };
export const setChannelPersona = (c, o) => { ${S}.persona.push([c, o]); };
export const setChannelChatter = (c, o) => { ${S}.calls.push(['chatter', c, o]); };
export const setServerEveryoneMention = () => {};
export const setServerUpdateChannel = () => {};
export const updateShowModel = () => {};
export const getShowModel = () => true;
export const updateShowModelThinking = () => {};
export const getShowModelThinking = () => false;
export const updateErrorRetries = () => {};
export const getErrorRetries = () => 3;
export const updateProviderSetting = () => {};
export const getProviderSettings = () => new Proxy({}, { get: () => new Proxy({}, { get: () => 0.5 }) });
export const isToolDisabled = () => false;
`);
addStub('src/core/index.js', `
export const memory = {
  listMemories: () => ${S}.memRows,
  retentionDays: () => 7,
  remember() {}, forget: () => true, forgetAll: () => 0,
  adminListUsers: () => ${S}.adminUsers,
  adminListMetadata: () => ${S}.adminRows,
  adminForget: () => true, adminForgetUser: () => 0,
};
export const audit = () => {};
`);
addStub('src/core/discordAdapter.js', `
export const isMemoryEnabled = () => true;
export const contextFromDiscord = (o) => ({ memoryScope: 'public', ...o });
`);
addStub('src/core/context/contextStore.js', 'export const forgetUserContext = async () => ({ turns: 0, scopes: 0 });');
addStub('src/handlers/banHandler.js', 'export const checkBan = () => null; export const checkAutoBan = async () => null;');
addStub('src/database/repositories/youtubeRepo.js', `export const youtubeRepository = { getSubscriptionsByGuild: () => ${S}.ytSubs };`);
addStub('src/database/repositories/twitchRepo.js', `export const twitchRepository = { getSubscriptionsByGuild: () => ${S}.twSubs };`);
addStub('src/utils/logger.js', `
const mk = (lvl) => (m) => { ${S}.logs.push([lvl, String(m)]); };
export const logger = { info: mk('info'), warn: mk('warn'), error: mk('error'), debug: mk('debug') };
export default logger;
`);
addStub('src/music/radioDatabase.js', `
export const getSession = () => ${S}.session;
export const updateSession = () => {};
export const addTrackToQueue = () => 1;
export const nextTrack = () => ${S}.nextTrackValue;
export const prevTrack = () => null;
export const skipToTrack = () => null;
export const setLoopMode = () => 'OFF';
export const toggleShuffle = () => true;
export const destroySession = () => {};
export const stopRadio = () => {};
export const removeTrackFromPlaylist = () => null;
export const toggleVoiceListening = () => {};
export const cycleVoiceMode = () => {};
export const toggleStreamMode = () => {};
`);
addStub('src/music/radioManager.js', `
export const radioAmbiguousSessions = new Map();
export const scheduleAmbiguousAutoSelect = () => {};
export const leaveRadioCall = async () => {};
`);
addStub('src/music/radioAudioPlayer.js', `
export const playTrack = async () => {};
export const pausePlayer = async () => {};
export const resumePlayer = async () => {};
export const stopPlayer = () => {};
export const updateEmbed = async () => {};
`);
addStub('src/music/radioProviders.js', `export const resolveInput = async () => ${S}.resolved;`);
addStub('src/music/radioPrefetcher.js', 'export const prefetchNextTrack = async () => {};');

registerHooks({
  resolve(specifier, context, nextResolve) {
    const resolved = nextResolve(specifier, context);
    const hit = stubs.get(String(resolved.url).toLowerCase());
    return hit ? { url: hit, shortCircuit: true } : resolved;
  },
});

// ── Módulos sob teste ───────────────────────────────────────────────────────────────────────────
const { EmbedBuilder } = await import('discord.js');
const { embedLength, LIMITS } = await import('../src/discord/embedLimits.js');
const { listarSeguindoCommand } = await import('../src/discord/commands/listarSeguindo.js');
const radioEmbed = await import('../src/music/radioEmbed.js');
const serverAdmin = await import('../src/handlers/serverAdminHandler.js');
const mcpPanel = await import('../src/handlers/mcpToolPanelHandler.js');
const help = await import('../src/handlers/helpPanelHandler.js');
const { memoriaCommand } = await import('../src/discord/commands/memoria.js');
const memAdmin = await import('../src/handlers/memoryAdminHandler.js');
const cfg = await import('../src/handlers/configPanelHandler.js');
const radioMCP = await import('../src/music/radioMCPHandler.js');
const radioModal = await import('../src/music/radioModalHandler.js');
const { default: appConfig } = await import('../src/config/index.js');

// ── Mini-runner ─────────────────────────────────────────────────────────────────────────────────
let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed++; console.log(`  ok   ${name}`); }
  catch (e) { failures.push(name); console.log(`  FALHA ${name}\n        ${String(e?.stack ?? e).split('\n').slice(0, 6).join('\n        ')}`); }
};
const section = (t) => console.log(`\n${t}`);

// ── Ajudantes ───────────────────────────────────────────────────────────────────────────────────
const json = (e) => (e && typeof e.toJSON === 'function' ? e.toJSON() : e);
const resetState = () => {
  Object.assign(state, {
    tools: [], disabled: [], calls: [], persona: [], logs: [], ytSubs: [], twSubs: [], memRows: [],
    adminUsers: { users: [], total: 0 }, adminRows: [], session: null, resolved: { type: 'not_found' }, nextTrackValue: null, sent: [],
  });
};

/** Confere os limites do Discord de UM embed (a API recusa a mensagem inteira se qualquer um falhar). */
function assertEmbedFits(raw, label = 'embed') {
  const j = json(raw);
  assert.ok(j && typeof j === 'object', `${label}: não é embed`);
  if (j.title !== undefined) assert.ok(j.title.length >= 1 && j.title.length <= LIMITS.title, `${label}: título ${j.title.length}`);
  if (j.description !== undefined) assert.ok(j.description.length >= 1 && j.description.length <= LIMITS.description, `${label}: descrição ${j.description.length}`);
  const fields = j.fields ?? [];
  assert.ok(fields.length <= LIMITS.fields, `${label}: ${fields.length} campos`);
  for (const f of fields) {
    assert.ok(f.name.length >= 1 && f.name.length <= LIMITS.fieldName, `${label}: nome de campo ${f.name.length}`);
    assert.ok(f.value.length >= 1 && f.value.length <= LIMITS.fieldValue, `${label}: valor de campo ${f.value.length} em "${f.name}"`);
  }
  if (j.footer) assert.ok(j.footer.text.length >= 1 && j.footer.text.length <= LIMITS.footer, `${label}: rodapé ${j.footer.text.length}`);
  assert.ok(embedLength(j) <= LIMITS.embedTotal, `${label}: soma ${embedLength(j)} > 6000`);
  return j;
}
/** Mensagem inteira: no máximo 10 embeds e 6000 caracteres SOMADOS. */
function assertMessageFits(payload, label = 'mensagem') {
  const embeds = (payload.embeds ?? []).map((e, i) => assertEmbedFits(e, `${label}/embed${i}`));
  assert.ok(embeds.length <= 10);
  assert.ok(embeds.reduce((n, e) => n + embedLength(e), 0) <= 6000, `${label}: soma dos embeds passou de 6000`);
  if (payload.content !== undefined && payload.content !== null) assert.ok(String(payload.content).length <= 2000, `${label}: content ${String(payload.content).length}`);
  assertComponentsFit(payload.components ?? [], label);
  return embeds;
}
/** Linhas e menus: até 5 linhas, 25 opções por menu, ids únicos e dentro de 100 caracteres (toJSON valida o resto). */
function assertComponentsFit(rows, label = 'mensagem') {
  assert.ok(rows.length <= 5, `${label}: ${rows.length} linhas de componentes`);
  const ids = [];
  for (const row of rows) {
    const r = json(row);
    assert.ok(r.components.length >= 1 && r.components.length <= 5, `${label}: linha com ${r.components.length} componentes`);
    for (const c of r.components) {
      if (c.custom_id) { assert.ok(c.custom_id.length <= LIMITS.customId, `${label}: custom_id ${c.custom_id.length}`); ids.push(c.custom_id); }
      if (c.options) {
        assert.ok(c.options.length >= 1 && c.options.length <= 25, `${label}: menu com ${c.options.length} opções`);
        for (const o of c.options) {
          assert.ok(o.label.length >= 1 && o.label.length <= 100, `${label}: rótulo ${o.label.length}`);
          assert.ok(o.value.length >= 1 && o.value.length <= 100);
          if (o.description) assert.ok(o.description.length <= 100);
        }
        assert.equal(new Set(c.options.map((o) => o.value)).size, c.options.length, `${label}: opções repetidas`);
      }
      if (c.placeholder) assert.ok(c.placeholder.length <= LIMITS.placeholder, `${label}: placeholder ${c.placeholder.length}`);
    }
  }
  assert.equal(new Set(ids).size, ids.length, `${label}: custom_id repetido ${JSON.stringify(ids)}`);
}

function fakeInteraction(extra = {}) {
  const log = { reply: [], update: [], followUp: [], editReply: [], showModal: [], deferReply: [] };
  const base = {
    guildId: 'g1', channelId: 'c1', user: { id: '999' }, guild: { id: 'g1', name: 'Servidor de Teste' },
    member: { permissions: { has: () => true } },
    reply: async (p) => { log.reply.push(p); return p; },
    update: async (p) => { log.update.push(p); return p; },
    followUp: async (p) => { log.followUp.push(p); return p; },
    editReply: async (p) => { log.editReply.push(p); return p; },
    deferReply: async (p) => { log.deferReply.push(p); },
    deleteReply: async () => {},
    showModal: async (m) => { log.showModal.push(m); },
    log,
  };
  return Object.assign(base, extra);
}
const optionsOf = (values = {}, subcommand = null) => ({
  getString: (n) => (n in values ? values[n] : null),
  getBoolean: (n) => (n in values ? values[n] : null),
  getInteger: (n) => (n in values ? values[n] : null),
  getChannel: (n) => (n in values ? values[n] : null),
  getSubcommand: () => subcommand,
});

const mkTools = (n, { disabledEvery = 0 } = {}) => Array.from({ length: n }, (_, i) => ({
  type: 'function',
  function: { name: `tool_${i}`, description: `Descrição técnica da ferramenta ${i}` },
  meta: { disableable: true, label: `Ferramenta número ${i}`, description: `Faz a coisa ${i} para o servidor` },
}));

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('TG-03: /yui-listar-seguindo');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const mkYt = (n, nameLen = 18) => Array.from({ length: n }, (_, i) => ({
  channel_name: `Canal ${i + 1} ${'y'.repeat(Math.max(0, nameLen - 8))}`, youtube_channel_id: `UC${String(i).padStart(22, '0')}`,
  discord_channel_id: String(100000000000000000n + BigInt(i)), notify_videos: 1, notify_shorts: i % 2, notify_lives: 1,
  mention_role_id: i % 3 === 0 ? String(200000000000000000n + BigInt(i)) : null,
}));
const mkTw = (n) => Array.from({ length: n }, (_, i) => ({
  twitch_login: `streamer_${i + 1}`, discord_channel_id: String(300000000000000000n + BigInt(i)), mention_role_id: i % 2 === 0 ? String(400000000000000000n + BigInt(i)) : null,
}));
const itemsOf = (embeds, prefix) => {
  const out = [];
  for (const e of embeds) for (const f of e.fields ?? []) if (f.name.startsWith(prefix)) for (const m of f.value.matchAll(/^(\d+)\. \*\*(.+?)\*\*$/gm)) out.push(Number(m[1]));
  return out;
};
const runListar = async () => {
  const it = fakeInteraction({ guildId: 'g-list' });
  await listarSeguindoCommand.execute(it);
  const messages = [...it.log.reply, ...it.log.followUp];
  messages.forEach((m, i) => { assert.equal(m.ephemeral, true, `mensagem ${i} deveria ser efêmera`); });
  return { it, messages, embeds: messages.flatMap((m) => assertMessageFits(m, 'lista')) };
};

await test('lista pequena: uma mensagem, mesmo formato de antes (sem página nem rodapé)', async () => {
  resetState();
  state.ytSubs = mkYt(2); state.twSubs = mkTw(2);
  const { it, embeds } = await runListar();
  assert.equal(it.log.reply.length, 1);
  assert.equal(it.log.followUp.length, 0);
  const j = embeds[0];
  assert.equal(j.title, '📡 Monitoramento Social deste servidor');
  assert.equal(j.footer, undefined);
  assert.deepEqual(j.fields.map((f) => f.name), ['📺 YouTube (2)', '🎮 Twitch (2)']);
  assert.equal(j.fields[0].value.split('\n').length, 4);
  assert.ok(j.fields[0].value.startsWith('1. **Canal 1 yyyyyyyyyy**\n   └ <#100000000000000000> 📹 🔴 · <@&200000000000000000>'));
  assert.ok(j.fields[1].value.includes('2. **streamer_2**\n   └ <#300000000000000001> 🔴'));
});
await test('sem inscrições: mensagem de ajuda como antes', async () => {
  resetState();
  const { embeds } = await runListar();
  assert.equal(embeds.length, 1);
  assert.ok(embeds[0].description.startsWith('Nenhum canal monitorado neste servidor ainda.'));
  assert.equal(embeds[0].fields, undefined);
});
await test('40 do YouTube + 40 da Twitch: todos aparecem, cada campo ≤ 1024 e cada mensagem ≤ 6000', async () => {
  resetState();
  state.ytSubs = mkYt(40); state.twSubs = mkTw(40);
  const { messages, embeds } = await runListar();
  assert.ok(messages.length >= 2 && messages.length <= 3, `${messages.length} mensagens`);
  assert.deepEqual(itemsOf(embeds, '📺'), Array.from({ length: 40 }, (_, i) => i + 1), 'itens do YouTube fora de ordem ou faltando');
  assert.deepEqual(itemsOf(embeds, '🎮'), Array.from({ length: 40 }, (_, i) => i + 1), 'itens da Twitch fora de ordem ou faltando');
  assert.ok(embeds.every((e) => /\(\d\/\d\)$/.test(e.title)), 'páginas numeradas no título');
  assert.ok(!embeds.some((e) => /não exibido/.test(e.footer?.text ?? '')), 'nada deveria ficar de fora');
});
await test('nenhum item é cortado no meio: cada campo termina numa linha de item completa', async () => {
  resetState();
  state.ytSubs = mkYt(60); state.twSubs = mkTw(20);
  const { embeds } = await runListar();
  for (const e of embeds) for (const f of e.fields) {
    const lines = f.value.split('\n');
    assert.equal(lines.length % 2, 0, 'cada item tem 2 linhas');
    for (let i = 0; i < lines.length; i += 2) {
      assert.match(lines[i], /^\d+\. \*\*.+\*\*$/);
      assert.match(lines[i + 1], /^ {3}└ <#\d+>/);
    }
  }
});
await test('400 inscrições: no máximo 3 mensagens e o rodapé conta exatamente o que ficou de fora', async () => {
  resetState();
  state.ytSubs = mkYt(400); state.twSubs = mkTw(30);
  const { messages, embeds } = await runListar();
  assert.equal(messages.length, 3);
  const shown = itemsOf(embeds, '📺').length + itemsOf(embeds, '🎮').length;
  const last = embeds.at(-1);
  const m = /(\d+) item\(ns\) não exibido\(s\)/.exec(last.footer.text);
  assert.ok(m, `rodapé: ${last.footer?.text}`);
  assert.equal(shown + Number(m[1]), 430);
  assert.ok(Number(m[1]) > 0);
});
await test('nome de canal gigante e item maior que o campo não derrubam a lista', async () => {
  resetState();
  state.ytSubs = mkYt(3, 5000); state.twSubs = mkTw(1);
  const { embeds } = await runListar();
  assert.ok(embeds.length >= 1);
  assert.ok(embeds[0].fields.every((f) => f.value.length <= 1024));
});
await test('se uma página extra falhar no envio, a primeira já foi respondida e o erro vai para o log (sem lançar)', async () => {
  resetState();
  state.ytSubs = mkYt(40); state.twSubs = mkTw(40);
  const it = fakeInteraction({ guildId: 'g-list', followUp: async () => { throw new Error('Unknown interaction'); } });
  const result = await listarSeguindoCommand.execute(it);
  assert.equal(it.log.reply.length, 1);
  assert.ok(result);
  assert.ok(state.logs.some(([lvl, m]) => lvl === 'warn' && m.includes('ListarSeguindo')));
});
await test('fora de servidor continua recusando', async () => {
  resetState();
  const it = fakeInteraction({ guildId: null });
  await listarSeguindoCommand.execute(it);
  assert.match(it.log.reply[0].content, /só pode ser usado em um servidor/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('TG-04 e TG-34: embeds do rádio');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const mkTracks = (n, { title = 'Música', artist = 'Artista' } = {}) => Array.from({ length: n }, (_, i) => ({ title: `${title} ${i + 1}`, artist: `${artist} ${i + 1}`, duration: 180 + i, link: `https://example.test/${i}` }));
// A montagem antiga (todas as faixas, sem janela), para provar que filas pequenas não mudaram.
function legacyQueueDescription(session) {
  const playlist = session.playlist || [];
  const currentIdx = typeof session.currentIndex === 'number' ? session.currentIndex : -1;
  let desc = '';
  playlist.forEach((t, i) => {
    const pos = i + 1;
    const dur = radioEmbed.formatDuration(t.duration);
    if (i === currentIdx && session.status === 'PLAYING') desc += `**▶️ #${pos}. ${t.title} — ${t.artist}** (tocando agora)\n`;
    else if (i === currentIdx && session.status === 'PAUSED') desc += `**⏸️ #${pos}. ${t.title} — ${t.artist}** (pausada)\n`;
    else if (i < currentIdx) desc += `~~#${pos}. ${t.title} — ${t.artist}~~\n`;
    else desc += `**#${pos}.** ${t.title} — ${t.artist} (${dur})\n`;
  });
  return desc;
}

await test('fila pequena (até 25 faixas) sai idêntica à montagem antiga', () => {
  for (const [n, cur, status] of [[3, 1, 'PLAYING'], [10, 4, 'PAUSED'], [25, 24, 'PLAYING'], [25, -1, 'STOPPED'], [12, 11, 'BUFFERING']]) {
    const session = { playlist: mkTracks(n), currentIndex: cur, status };
    const d = json(radioEmbed.buildQueueEmbed(session)).description;
    assert.equal(d, legacyQueueDescription(session).trimEnd(), `n=${n} cur=${cur} ${status}`);
  }
});
await test('fila vazia', () => {
  assert.equal(json(radioEmbed.buildQueueEmbed({ playlist: [], currentIndex: -1, status: 'STOPPED' })).description, 'Fila vazia.');
  assert.equal(json(radioEmbed.buildQueueEmbed({})).description, 'Fila vazia.');
});
await test('150 faixas: descrição ≤ 4096, faixa atual visível com a posição real, marcadores de "antes" e "e mais"', () => {
  const session = { playlist: mkTracks(150), currentIndex: 60, status: 'PLAYING' };
  const j = assertEmbedFits(radioEmbed.buildQueueEmbed(session), 'fila');
  assert.ok(j.description.includes('**▶️ #61. Música 61 — Artista 61** (tocando agora)'));
  assert.match(j.description, /^… 55 faixa\(s\) antes\n/);
  assert.match(j.description, /… e mais 70 faixa\(s\)$/);
  assert.equal(j.footer.text, '150 faixa(s) cadastradas nesta sessão de rádio');
  assert.equal(j.description.split('\n').length, 27, '25 faixas + 2 marcadores');
});
await test('fila longa: faixa atual no começo e no fim', () => {
  const first = json(radioEmbed.buildQueueEmbed({ playlist: mkTracks(150), currentIndex: 0, status: 'PLAYING' })).description;
  assert.ok(first.startsWith('**▶️ #1.'));
  assert.ok(!first.includes('faixa(s) antes'));
  assert.match(first, /… e mais 125 faixa\(s\)$/);
  const last = json(radioEmbed.buildQueueEmbed({ playlist: mkTracks(150), currentIndex: 149, status: 'PAUSED' })).description;
  assert.ok(last.includes('**⏸️ #150.'));
  assert.ok(!last.includes('e mais'));
  assert.match(last, /^… 125 faixa\(s\) antes/);
});
await test('títulos e artistas gigantes: janela encolhe, faixa atual continua visível, nada passa de 4096', () => {
  for (const cur of [-1, 0, 40, 74, 149, 150, 200]) {
    for (const n of [1, 26, 75, 150, 300]) {
      const session = { playlist: mkTracks(n, { title: 'T'.repeat(5000), artist: 'A'.repeat(5000) }), currentIndex: cur, status: 'PLAYING' };
      const j = assertEmbedFits(radioEmbed.buildQueueEmbed(session), `fila n=${n} cur=${cur}`);
      if (cur >= 0 && cur < n) assert.ok(j.description.includes(`#${cur + 1}.`), `faixa atual #${cur + 1} sumiu (n=${n})`);
    }
  }
});
await test('faixas sem título/artista não viram "undefined"', () => {
  const j = json(radioEmbed.buildQueueEmbed({ playlist: [{}, { title: 'x' }, null], currentIndex: -1, status: 'STOPPED' }));
  assert.ok(!j.description.includes('undefined'));
  assert.ok(j.description.includes('Sem título'));
});
await test('painel do rádio (TG-34): título, artista e álbum gigantes cabem; capa inválida é descartada', () => {
  const track = { title: 'T'.repeat(5000), artist: 'A'.repeat(5000), album: 'B'.repeat(5000), duration: 200, cover: 'isto não é url', addedBy: '12345' };
  const payload = radioEmbed.buildRadioEmbed({ currentTrack: track, playlist: [track], currentIndex: 0, status: 'PLAYING', streamMode: 'FAST', shuffle: true, loopMode: 'QUEUE' });
  const j = assertEmbedFits(payload.embeds[0], 'rádio');
  assert.equal(j.thumbnail, undefined);
  assert.equal(j.fields.length, 8);
  assert.ok(j.fields[0].value.length < 300);
  assert.equal(payload.components.length, 3);
  assertComponentsFit(payload.components, 'rádio');
});
await test('painel do rádio: capa http(s) válida entra; sem faixa mantém o texto de antes', () => {
  const ok = json(radioEmbed.buildRadioEmbed({ currentTrack: { title: 'a', artist: 'b', cover: 'https://img.example/c.png' }, playlist: [{}], currentIndex: 0, status: 'PAUSED' }).embeds[0]);
  assert.equal(ok.thumbnail.url, 'https://img.example/c.png');
  const idle = json(radioEmbed.buildRadioEmbed({ currentTrack: null, playlist: [], currentIndex: -1, status: 'STOPPED' }).embeds[0]);
  assert.ok(idle.description.startsWith('**⏹️ Parado**\n\nNenhuma faixa tocando. Playlist com 0 música(s).'));
  assert.equal(idle.footer.text, 'Yui Radio • Use os botões abaixo para controlar');
});
await test('opções ambíguas: 30 resultados com títulos gigantes → no máximo 25 campos e dentro dos limites', () => {
  const j = assertEmbedFits(radioEmbed.buildAmbiguousEmbed(mkTracks(30, { title: 'T'.repeat(900), artist: 'A'.repeat(900) })), 'ambíguo');
  assert.ok(j.fields.length <= 25);
  assert.equal(j.footer.text, 'Powered by Deezer', 'o rodapé do rádio não muda');
  const small = json(radioEmbed.buildAmbiguousEmbed(mkTracks(3)));
  assert.equal(small.fields.length, 3);
  assert.equal(small.fields[0].name, '1. Música 1');
  assert.equal(small.fields[0].value, '👤 Artista 1 | ⏱️ 3:00');
});
await test('"não encontrada": busca gigante é cortada no eco', () => {
  const j = assertEmbedFits(radioEmbed.buildNotFoundEmbed('q'.repeat(9000)), 'não encontrada');
  assert.ok(j.description.length < 200);
  assert.equal(json(radioEmbed.buildNotFoundEmbed('abc')).description, 'Não consegui encontrar **"abc"** no Deezer.');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('TG-17: lista de ferramentas (/yui-ferramentas list) e painel MCP');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const runFerramentas = async (acao, extra = {}) => {
  const it = fakeInteraction({ options: optionsOf({ acao, ...extra }) });
  await serverAdmin.handleIaFerramentasCommand(it);
  return it;
};
await test('15 ferramentas: dois campos, formato de antes', async () => {
  resetState();
  state.tools = mkTools(15); state.disabled = ['tool_3'];
  const it = await runFerramentas('list');
  const [j] = assertMessageFits(it.log.reply[0], 'ferramentas');
  assert.deepEqual(j.fields.map((f) => f.name), ['🟢 Ativas (14)', '🔴 Desativadas (1)']);
  assert.equal(j.fields[1].value, '❌ **Ferramenta número 3** (`tool_3`)');
  assert.equal(j.fields[0].value.split('\n').length, 14);
});
await test('40 ferramentas: listas viram vários campos de até 1024 e nenhuma ferramenta some', async () => {
  resetState();
  state.tools = mkTools(40); state.disabled = ['tool_5', 'tool_6'];
  const it = await runFerramentas('list');
  const [j] = assertMessageFits(it.log.reply[0], 'ferramentas');
  const text = j.fields.map((f) => f.value).join('\n');
  for (let i = 0; i < 40; i++) assert.equal(text.split(`(\`tool_${i}\`)`).length - 1, 1, `tool_${i}`);
  assert.ok(j.fields.filter((f) => f.name.startsWith('🟢')).length >= 2);
  assert.equal(j.fields.filter((f) => f.name.startsWith('🟢'))[0].name, '🟢 Ativas (38)');
});
await test('sem ferramentas ativas ou desativadas: textos de antes', async () => {
  resetState();
  state.tools = mkTools(2); state.disabled = ['tool_0', 'tool_1'];
  const [j] = assertMessageFits((await runFerramentas('list')).log.reply[0]);
  assert.deepEqual(j.fields.map((f) => [f.name, f.value]), [
    ['🟢 Ativas', '*Nenhuma ferramenta ativa*'],
    ['🔴 Desativadas (2)', '❌ **Ferramenta número 0** (`tool_0`)\n❌ **Ferramenta número 1** (`tool_1`)'],
  ]);
});
await test('toggle com nome de ferramenta gigante: o eco do erro cabe em uma mensagem', async () => {
  resetState();
  state.tools = mkTools(3);
  const it = await runFerramentas('toggle', { ferramenta: 'z`z'.repeat(2000) });
  assert.ok(it.log.reply[0].content.length <= 200, `${it.log.reply[0].content.length}`);
  assert.ok(it.log.reply[0].content.startsWith('❌ Ferramenta `'));
  assert.ok(!it.log.reply[0].content.slice(15, -22).includes('`'), 'crase do usuário fechava o código');
});

const panelMenus = (payload) => payload.components.map(json).filter((r) => r.components[0].options);
const sendPanel = async (selected = null, guild = 'g1') => {
  const it = fakeInteraction({ guildId: guild });
  await mcpPanel.sendMcpToolsManager(it, guild, selected, false, true);
  return it.log.reply[0];
};
await test('painel MCP com 15 ferramentas: um menu com o id de sempre, como antes', async () => {
  resetState();
  state.tools = mkTools(15);
  const payload = await sendPanel();
  assertMessageFits(payload, 'painel');
  const menus = panelMenus(payload);
  assert.equal(menus.length, 1);
  assert.equal(menus[0].components[0].custom_id, 'srvmcp_select_g1');
  assert.equal(menus[0].components[0].options.length, 15);
  assert.equal(menus[0].components[0].placeholder, '💡 Selecione uma ferramenta para ver detalhes');
  assert.equal(payload.components.length, 2);
  assert.equal(json(payload.components[1]).components[0].custom_id, 'srvmcp_reset_g1');
});
await test('painel MCP com 40 ferramentas: dois menus (25 + 15), ids distintos, todas as ferramentas, campos ≤ 1024', async () => {
  resetState();
  state.tools = mkTools(40); state.disabled = ['tool_30'];
  const payload = await sendPanel();
  const embeds = assertMessageFits(payload, 'painel');
  const menus = panelMenus(payload);
  assert.deepEqual(menus.map((m) => m.components[0].custom_id), ['srvmcp_select_g1', 'srvmcp_select_g1_p2']);
  assert.deepEqual(menus.map((m) => m.components[0].options.length), [25, 15]);
  const values = menus.flatMap((m) => m.components[0].options.map((o) => o.value));
  assert.deepEqual(values, Array.from({ length: 40 }, (_, i) => `tool_${i}`));
  assert.equal(menus[1].components[0].options.find((o) => o.value === 'tool_30').emoji.name, '❌');
  assert.ok(embeds[0].fields.length >= 3);
  assert.equal(payload.components.length, 3, '2 menus + botão de reset');
});
await test('painel MCP com 120 ferramentas: 4 menus (100) + botões = 5 linhas, sem lançar; sem ferramentas: só o botão', async () => {
  resetState();
  state.tools = mkTools(120);
  const payload = await sendPanel();
  assertMessageFits(payload, 'painel120');
  assert.equal(payload.components.length, 5);
  assert.equal(panelMenus(payload).length, 4);
  state.tools = [];
  const empty = await sendPanel();
  assertMessageFits(empty, 'painel0');
  assert.equal(panelMenus(empty).length, 0);
  assert.equal(empty.components.length, 1);
});
await test('painel MCP: ferramenta selecionada no 2º menu fica marcada como padrão e mostra os botões de ligar/desligar', async () => {
  resetState();
  state.tools = mkTools(40);
  const payload = await sendPanel('tool_33');
  assertMessageFits(payload, 'painel/detalhe');
  const menus = panelMenus(payload);
  assert.equal(menus[0].components[0].options.some((o) => o.default), false);
  assert.equal(menus[1].components[0].options.find((o) => o.default).value, 'tool_33');
  assert.equal(payload.components.length, 3);
  assert.equal(json(payload.components[2]).components.length, 4);
});
await test('painel MCP: descrição gigante de ferramenta cabe no embed de detalhe', async () => {
  resetState();
  state.tools = mkTools(2);
  state.tools[1].meta.description = 'd'.repeat(9000);
  const [j] = assertMessageFits(await sendPanel('tool_1'), 'detalhe');
  assert.ok(j.description.length <= 4096);
});
await test('menu 2 do painel MCP: a seleção funciona com o id _p2 e a trava de outro servidor continua valendo', async () => {
  resetState();
  state.tools = mkTools(40);
  const ok = fakeInteraction({ customId: 'srvmcp_select_g1_p2', values: ['tool_39'] });
  await mcpPanel.handleMcpToolInteraction(ok);
  assert.equal(ok.log.reply.length, 0, 'não deveria recusar');
  assert.equal(ok.log.update.length, 1);
  assert.match(json(ok.log.update[0].embeds[0]).title, /Ferramenta número 39/);
  const old = fakeInteraction({ customId: 'srvmcp_select_g1', values: ['tool_2'] });
  await mcpPanel.handleMcpToolInteraction(old);
  assert.equal(old.log.update.length, 1, 'o id antigo continua funcionando');
  const other = fakeInteraction({ customId: 'srvmcp_select_g2_p2', values: ['tool_39'], guildId: 'g1' });
  await mcpPanel.handleMcpToolInteraction(other);
  assert.equal(other.log.update.length, 0);
  assert.equal(other.log.reply[0].ephemeral, true);
  const dm = fakeInteraction({ customId: 'srvmcp_select_g1_p2', values: ['tool_1'], guildId: null, guild: null });
  await mcpPanel.handleMcpToolInteraction(dm);
  assert.equal(dm.log.update.length, 0, 'em DM o painel recusa');
});

await test('ajuda: com os 24 comandos de hoje há um menu só, com o id de sempre; cada comando abre um detalhe válido', () => {
  const payload = help.buildHelpCommandListPayload();
  assertMessageFits(payload, 'ajuda/lista');
  const rows = payload.components.map(json);
  assert.equal(rows.length, 2);
  const menu = rows[1].components[0];
  assert.equal(menu.custom_id, 'help_command_select');
  assert.ok(menu.options.length >= 20 && menu.options.length <= 25);
  for (const o of menu.options) {
    const detail = help.buildHelpCommandDetailPayload(o.value);
    assertMessageFits(detail, `ajuda/${o.value}`);
    assert.ok(json(detail.embeds[0]).title.startsWith('🔍 Inspeção Técnica:'), o.value);
  }
});
await test('ajuda: comando desconhecido (ou nome herdado do Object) volta para a lista', () => {
  for (const id of ['nao-existe', 'constructor', '__proto__', 'toString']) {
    const p = help.buildHelpCommandDetailPayload(id);
    assert.equal(json(p.embeds[0]).title, '🤖 Lista Geral de Comandos', id);
  }
});
const fakeDetails = (perCategory, categories = 3) => {
  const d = {};
  for (let c = 0; c < categories; c++) for (let i = 0; i < perCategory; i++) d[`cmd_${c}_${i}`] = { name: `/cmd-${c}-${i}`, category: `Categoria ${c}`, description: `Descrição do comando ${c}-${i} `.repeat(8) };
  return d;
};
const menuInfo = (rows) => rows.map(json).map((r) => ({ id: r.components[0].custom_id, n: r.components[0].options.length, values: r.components[0].options.map((o) => o.value), ph: r.components[0].placeholder }));
await test('ajuda: até 25 comandos → um menu na ordem original; 30 → dois menus por categoria', () => {
  const small = fakeDetails(5, 5); // 25
  const one = menuInfo(help.buildCommandMenus(small));
  assert.equal(one.length, 1);
  assert.deepEqual(one[0].values, Object.keys(small), 'a ordem original tem de ser mantida');
  assert.equal(one[0].id, 'help_command_select');
  const thirty = fakeDetails(10, 3);
  const two = menuInfo(help.buildCommandMenus(thirty));
  assert.deepEqual(two.map((m) => m.id), ['help_command_select', 'help_command_select_2']);
  assert.deepEqual(two.map((m) => m.n), [20, 10], 'categorias inteiras: 0 e 1 no 1º menu, 2 no 2º');
  assert.ok(two[0].values.every((v) => v.startsWith('cmd_0') || v.startsWith('cmd_1')));
  assert.ok(two[1].values.every((v) => v.startsWith('cmd_2')));
  assert.match(two[0].ph, /\(1\/2\).*Categoria 0.*Categoria 1/);
});
await test('ajuda: 60, categoria maior que um menu, 120 comandos e vazio', () => {
  const sixty = menuInfo(help.buildCommandMenus(fakeDetails(10, 6)));
  assert.deepEqual(sixty.map((m) => m.n), [20, 20, 20]);
  const big = { ...fakeDetails(40, 1), ...Object.fromEntries(Object.entries(fakeDetails(3, 1)).map(([k, v]) => [`z${k}`, { ...v, category: 'Outra' }])) };
  const split = menuInfo(help.buildCommandMenus(big));
  assert.deepEqual(split.map((m) => m.n), [25, 18], 'categoria de 40 continua no menu seguinte');
  const huge = menuInfo(help.buildCommandMenus(fakeDetails(40, 3)));
  assert.equal(huge.length, 4);
  assert.ok(huge.every((m) => m.n <= 25));
  assert.deepEqual(help.buildCommandMenus({}), []);
  for (const rows of [help.buildCommandMenus(fakeDetails(10, 6)), help.buildCommandMenus(fakeDetails(40, 3))]) assertComponentsFit([...rows], 'ajuda/menus');
});
await test('ajuda: o segundo menu de comandos (help_command_select_2) é tratado pelo handler', async () => {
  const it = fakeInteraction({ customId: 'help_command_select_2', values: ['yui'] });
  await help.handleHelpInteraction(it);
  assert.equal(it.log.update.length, 1);
  assert.match(json(it.log.update[0].embeds[0]).title, /Inspeção Técnica: \/yui/);
  const first = fakeInteraction({ customId: 'help_command_select', values: ['ajuda'] });
  await help.handleHelpInteraction(first);
  assert.match(json(first.log.update[0].embeds[0]).title, /\/ajuda/);
});
await test('ajuda: páginas das regras (TOS) cabem como embed', () => {
  for (let i = 0; i < 12; i++) assertMessageFits(help.buildHelpRulesPayload(i), `regras/${i}`);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('TG-19 (painel do servidor): humor e instrução do canal');
// ═════════════════════════════════════════════════════════════════════════════════════════════
await test('comando de barra: instrução e humor de 5000 caracteres são gravados cortados (1500 e 100) e o eco cabe', async () => {
  resetState();
  const it = fakeInteraction({ options: optionsOf({ instrucao: 'i'.repeat(5000), mood: 'm`'.repeat(2500) }) });
  await serverAdmin.handleServerAdminCommand(it);
  assert.equal(state.persona.length, 1);
  const [channel, saved] = state.persona[0];
  assert.equal(channel, 'c1');
  assert.ok(saved.instruction.length <= 1500 && saved.instruction.length > 1400, `${saved.instruction.length}`);
  assert.ok(saved.mood.length <= 100 && saved.mood.length > 80, `${saved.mood.length}`);
  const [j] = assertMessageFits(it.log.reply[0], 'servidor');
  assert.ok(j.description.length < 400);
});
await test('comando de barra: textos curtos são gravados exatamente como vieram', async () => {
  resetState();
  const it = fakeInteraction({ options: optionsOf({ instrucao: 'Seja gentil.', mood: 'Animada' }) });
  await serverAdmin.handleServerAdminCommand(it);
  assert.deepEqual(state.persona[0][1], { instruction: 'Seja gentil.', mood: 'Animada' });
  assert.ok(json(it.log.reply[0].embeds[0]).description.includes('(Mood: `Animada`)'));
  resetState();
  const onlyMood = fakeInteraction({ options: optionsOf({ mood: 'Séria' }) });
  await serverAdmin.handleServerAdminCommand(onlyMood);
  assert.deepEqual(state.persona[0][1], { instruction: undefined, mood: 'Séria' });
});
await test('botão de humor: o modal limita instrução a 1500 e humor a 100', async () => {
  const it = fakeInteraction({ customId: 'srvcfg_btn_humor' });
  await serverAdmin.handleServerAdminInteraction(it);
  const modal = json(it.log.showModal[0]);
  const inputs = modal.components.map((r) => r.components[0]);
  const byId = Object.fromEntries(inputs.map((i) => [i.custom_id, i]));
  assert.equal(byId.instrucao.max_length, 1500);
  assert.equal(byId.mood.max_length, 100);
  assert.equal(byId.reset.max_length, undefined);
});
await test('envio do modal: corta o que for gravado e o eco não quebra o bloco de código nem passa de 1024', async () => {
  resetState();
  const values = { instrucao: 'ab```cd'.repeat(700), mood: 'x'.repeat(4000), reset: '' };
  const it = fakeInteraction({ customId: 'srvcfg_modal_humor', fields: { getTextInputValue: (n) => values[n] } });
  await serverAdmin.handleServerAdminInteraction(it);
  const [, saved] = state.persona[0];
  assert.ok(saved.instruction.length <= 1500);
  assert.ok(saved.mood.length <= 100);
  const [j] = assertMessageFits(it.log.reply[0], 'modal');
  const fence = j.fields.find((f) => f.name === 'Instrução').value;
  assert.equal(fence.split('```').length - 1, 2, 'o texto do usuário não pode abrir/fechar outro bloco de código');
  assert.ok(fence.startsWith('```\n') && fence.endsWith('\n```'));
  assert.ok(j.fields.find((f) => f.name === 'Humor').value.length <= 102);
});
await test('envio do modal vazio ou com SIM mantém o comportamento de antes', async () => {
  resetState();
  const reset = fakeInteraction({ customId: 'srvcfg_modal_humor', fields: { getTextInputValue: (n) => (n === 'reset' ? 'sim' : '') } });
  await serverAdmin.handleServerAdminInteraction(reset);
  assert.deepEqual(state.persona[0][1], { reset: true });
  resetState();
  const empty = fakeInteraction({ customId: 'srvcfg_modal_humor', fields: { getTextInputValue: () => '' } });
  await serverAdmin.handleServerAdminInteraction(empty);
  assert.deepEqual(state.persona[0][1], { instruction: undefined, mood: undefined });
  const j = json(empty.log.reply[0].embeds[0]);
  assert.equal(j.fields[0].value, '`Não alterado`');
  assert.equal(j.fields[1].value, '*Não alterado*');
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('TG-31: /yui-memoria ver e /yui-criador memorias');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const runMemoria = async (sub, values = {}) => {
  const it = fakeInteraction({ options: optionsOf(values, sub) });
  await memoriaCommand.execute(it);
  return it.log.reply[0];
};
const mkMem = (n, len) => Array.from({ length: n }, (_, i) => ({ id: 1000 + i, type: 'note', content: `${i}:` + 'c'.repeat(len - String(i).length - 1) }));
await test('/yui-memoria ver com poucas lembranças: igual ao formato de antes (sem aviso)', async () => {
  resetState();
  state.memRows = mkMem(5, 40);
  const payload = await runMemoria('ver');
  const [j] = assertMessageFits(payload, 'memoria');
  assert.equal(j.description, state.memRows.map((r) => `**#${r.id}** · \`${r.type}\` — ${r.content}`).join('\n'));
  assert.equal(j.footer.text, '🕒 memória temporária (7 dias sem interação)');
  assert.equal(payload.flags, 64);
});
await test('/yui-memoria ver com 25 lembranças de 300 caracteres: nada cortado no meio e o aviso diz quantas ficaram de fora', async () => {
  resetState();
  state.memRows = mkMem(25, 300);
  const [j] = assertMessageFits(await runMemoria('ver'), 'memoria');
  const lines = j.description.split('\n');
  const note = lines.pop();
  const m = /^\(\+(\d+) lembrança\(s\) não exibida\(s\)\)$/.exec(note);
  assert.ok(m, `última linha: ${note}`);
  assert.equal(lines.length + Number(m[1]), 25);
  assert.ok(Number(m[1]) > 0);
  lines.forEach((line, i) => {
    assert.equal(line, `**#${1000 + i}** · \`note\` — ${state.memRows[i].content}`, 'linha inteira, com id, tipo e conteúdo completo');
  });
  assert.ok(lines.at(-1).endsWith('c'), 'a última linha mostrada termina no fim do conteúdo');
});
await test('/yui-memoria ver: conteúdo com quebras de linha e gigante vira uma linha só e fica dentro do limite', async () => {
  resetState();
  state.memRows = [{ id: 7, type: 'fact', content: 'linha 1\nlinha 2\n\n```bloco```' }, { id: 8, type: 'note', content: 'x'.repeat(9000) }];
  const [j] = assertMessageFits(await runMemoria('ver'), 'memoria');
  const lines = j.description.split('\n');
  assert.equal(lines.length, 2);
  assert.equal(lines[0], '**#7** · `fact` — linha 1 linha 2 ```bloco```');
  assert.ok(lines[1].startsWith('**#8** · `note` — xxx') && lines[1].endsWith('…') && lines[1].length <= 500);
});
await test('/yui-memoria ver sem lembranças: texto de ajuda como antes', async () => {
  resetState();
  const [j] = assertMessageFits(await runMemoria('ver'), 'memoria');
  assert.ok(j.description.startsWith('Nada guardado ainda.'));
});

const mkUsers = (n) => Array.from({ length: n }, (_, i) => ({ userId: String(500000000000000000n + BigInt(i)), count: i + 1, lastSeen: 1760000000000 + i, expiresAt: 1770000000000 + i }));
const runAdmin = async (acao, extra = {}) => {
  const it = fakeInteraction({ user: { id: '111' }, options: optionsOf({ acao, ...extra }) });
  await memAdmin.handleMemoriasAdmin(it);
  return it.log.reply[0];
};
await test('/yui-criador memorias listar: 25 usuários listados de 80 no total → linhas inteiras e aviso com o total real', async () => {
  resetState();
  state.adminUsers = { users: mkUsers(25), total: 80 };
  const [j] = assertMessageFits(await runAdmin('listar'), 'admin/listar');
  const lines = j.description.split('\n');
  const note = lines.pop();
  const m = /^\(\+(\d+) usuário\(s\) não exibido\(s\)\)$/.exec(note);
  assert.ok(m, note);
  assert.equal(lines.length + Number(m[1]), 80);
  for (const line of lines) assert.match(line, /^<@\d+> \(`\d+`\) — \*\*\d+\*\* lembrança\(s\) · última interação <t:\d+:R> · expira <t:\d+:R>$/);
  assert.equal(j.footer.text, '80 usuário(s) • retenção de 7 dias • conteúdo oculto por privacidade');
});
await test('/yui-criador memorias listar: poucos usuários → sem aviso; nenhum → texto de antes', async () => {
  resetState();
  state.adminUsers = { users: mkUsers(3), total: 3 };
  const [j] = assertMessageFits(await runAdmin('listar'), 'admin/listar');
  assert.equal(j.description.split('\n').length, 3);
  assert.ok(!j.description.includes('não exibido'));
  state.adminUsers = { users: [], total: 0 };
  assert.equal(assertMessageFits(await runAdmin('listar'))[0].description, 'Nenhum usuário com memória no momento.');
});
await test('/yui-criador memorias ver: 25 linhas de metadados → linhas inteiras e aviso', async () => {
  resetState();
  state.adminRows = Array.from({ length: 25 }, (_, i) => ({ id: 1 + i, type: 'note', chars: 120 + i, source: 'discord-command', createdAt: 1760000000000, expiresAt: 1770000000000 }));
  const [j] = assertMessageFits(await runAdmin('ver', { usuario_id: '500000000000000000' }), 'admin/ver');
  const lines = j.description.split('\n');
  assert.equal(lines[0], '<@500000000000000000> (`500000000000000000`)');
  assert.equal(lines[1], '');
  const body = lines.slice(2);
  const note = body.pop();
  if (note.startsWith('(+')) assert.equal(body.length + Number(/\d+/.exec(note)[0]), 25);
  else { body.push(note); assert.equal(body.length, 25); }
  for (const line of body) assert.match(line, /^\*\*#\d+\*\* · `note` · \d+ caracteres · origem `discord-command` · criada <t:\d+:R> · expira <t:\d+:R>$/);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('Painel de configuração: __dirname e menu "Ir Para"');
// ═════════════════════════════════════════════════════════════════════════════════════════════
// Quantas páginas de configuração existem (lido do rodapé da Home: "Página 0/N"), para o teste não depender de um número fixo.
const homeProbe = fakeInteraction();
await cfg.handleConfigCommand(homeProbe);
const NPAGES = Number(/Página 0\/(\d+)/.exec(json(homeProbe.log.reply[0].embeds[0]).footer.text)[1]);
const WIN = 24; // configurações por janela do menu (mais a opção Home = 25 opções)
const NWIN = Math.ceil(NPAGES / WIN);
const pageFooter = (n) => `Página ${n}/${NPAGES} • key • Yui Config • by oBraga`;
const gotoOpen = async (customId, currentPage) => {
  const it = fakeInteraction({ customId, message: { embeds: [{ footer: { text: pageFooter(currentPage) } }] } });
  await cfg.handleConfigButton(it);
  assert.equal(it.log.update.length, 1, 'deveria atualizar a mensagem');
  return it.log.update[0];
};
const gotoMenu = (u) => json(u.components[0]).components[0];
const pagesOfWindow = (w) => Array.from({ length: Math.min(WIN, NPAGES - w * WIN) }, (_, i) => `cfgpage_${w * WIN + 1 + i}`);

await test(`há mais configurações (${NPAGES}) do que cabem num menu (24 + Home), o motivo do menu paginado`, () => {
  assert.ok(NPAGES > WIN, `só ${NPAGES} páginas: o teste de janelas não prova nada`);
});

await test('__dirname: o caminho do config.json aponta para src/config/config.json e o arquivo existe', () => {
  assert.equal(path.resolve(cfg.CONFIG_JSON_PATH), path.join(repoRoot, 'src', 'config', 'config.json'));
  assert.ok(fs.existsSync(cfg.CONFIG_JSON_PATH));
});
await test('updateConfigJson grava no arquivo indicado (sem ReferenceError), preserva as outras chaves e atualiza o config em memória', () => {
  resetState();
  const file = path.join(tmp, 'config-copia.json');
  fs.writeFileSync(file, '{\n  // comentário que o painel descarta\n  "prefix": "_", "url": "http://exemplo.test/x", "botName": "Yui"\n}\n');
  assert.equal(cfg.updateConfigJson('botName', 'Outra', file), true);
  const saved = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepEqual(saved, { prefix: '_', url: 'http://exemplo.test/x', botName: 'Outra' });
  assert.equal(appConfig.botName, 'Outra');
  delete appConfig.botName;
});
await test('updateConfigJson: arquivo inexistente ou inválido → false e erro no log (não lança)', () => {
  resetState();
  assert.equal(cfg.updateConfigJson('k', 'v', path.join(tmp, 'nao-existe.json')), false);
  const bad = path.join(tmp, 'ruim.json');
  fs.writeFileSync(bad, '{ isto não é json');
  assert.equal(cfg.updateConfigJson('k', 'v', bad), false);
  assert.equal(state.logs.filter(([l, m]) => l === 'error' && m.includes('ConfigPanel')).length, 2);
});
await test('"Ir Para" a partir da última página: janela final, Home, página atual marcada e botões de janela', async () => {
  const last = NPAGES;
  const u = await gotoOpen('cfgpanel_goto_open', last);
  assertComponentsFit(u.components, `goto/${last}`);
  assert.equal(u.components.length, 3);
  const menu = gotoMenu(u);
  assert.equal(menu.custom_id, 'cfgpanel_goto_select');
  assert.deepEqual(menu.options.map((o) => o.value), ['cfgpage_0', ...pagesOfWindow(NWIN - 1)]);
  assert.equal(menu.options.find((o) => o.default).value, `cfgpage_${last}`);
  assert.match(menu.placeholder, new RegExp(`${(NWIN - 1) * WIN + 1} a ${NPAGES} de ${NPAGES}`));
  const [prev, next] = json(u.components[2]).components;
  assert.deepEqual([prev.custom_id, prev.disabled, next.disabled], [`cfgpanel_gotowin_${NWIN - 2}`, false, true]);
});
await test('"Ir Para" a partir da Home e das primeiras páginas: janela 1 (configs 1 a 24)', async () => {
  for (const page of [0, 5, WIN]) {
    const u = await gotoOpen('cfgpanel_goto_open', page);
    const menu = gotoMenu(u);
    assert.deepEqual(menu.options.map((o) => o.value), ['cfgpage_0', ...pagesOfWindow(0)], `página ${page}`);
    const [prev, next] = json(u.components[2]).components;
    assert.deepEqual([prev.disabled, next.disabled, next.custom_id], [true, false, 'cfgpanel_gotowin_1']);
  }
});
await test(`"Ir Para": navegando pelas janelas aparecem as ${NPAGES + 1} opções (Home + ${NPAGES} configurações), sem faltar nenhuma`, async () => {
  const seen = new Set();
  let u = await gotoOpen('cfgpanel_goto_open', 0);
  for (let hops = 0; hops < 10; hops++) {
    for (const o of gotoMenu(u).options) seen.add(o.value);
    const next = json(u.components[2]).components[1];
    if (next.disabled) break;
    u = await gotoOpen(next.custom_id, 0);
  }
  assert.equal(seen.size, NPAGES + 1);
  for (let i = 0; i <= NPAGES; i++) assert.ok(seen.has(`cfgpage_${i}`), `faltou cfgpage_${i}`);
});
await test('"Ir Para": janela pedida fora da faixa ou inválida não lança (vai para a última / a da página atual)', async () => {
  const far = await gotoOpen('cfgpanel_gotowin_99', 3);
  assert.ok(gotoMenu(far).options.some((o) => o.value === `cfgpage_${NPAGES}`));
  const nan = await gotoOpen('cfgpanel_gotowin_abc', NPAGES);
  assert.ok(gotoMenu(nan).options.some((o) => o.value === `cfgpage_${NPAGES}`));
  const neg = await gotoOpen('cfgpanel_gotowin_-4', NPAGES);
  assert.ok(gotoMenu(neg).options.some((o) => o.value === 'cfgpage_1'));
});
await test('selecionar uma configuração no menu abre a página (inclusive as que não apareciam) e todas as páginas cabem', async () => {
  for (let page = 0; page <= NPAGES; page++) {
    const it = fakeInteraction({ customId: 'cfgpanel_goto_select', values: [`cfgpage_${page}`] });
    assert.equal(await cfg.handleConfigSelect(it) !== false, true);
    const payload = it.log.update[0];
    assertMessageFits(payload, `config/${page}`);
    assert.match(json(payload.embeds[0]).footer.text, new RegExp(`^Página ${page}/${NPAGES}`));
  }
});
await test('modal de edição: valor atual maior que 4000 abre vazio (sem setValue, que lançava) e com limite de 4000', async () => {
  // systemPrompt é a última página (texto): descobre o índice pelo rodapé, que traz a chave da configuração.
  let idx = -1;
  for (let page = 1; page <= NPAGES && idx < 0; page++) {
    const it = fakeInteraction({ customId: 'cfgpanel_goto_select', values: [`cfgpage_${page}`] });
    await cfg.handleConfigSelect(it);
    if (json(it.log.update[0].embeds[0]).footer.text.includes(' • systemPrompt • ')) idx = page - 1;
  }
  assert.ok(idx >= 0, 'página systemPrompt não encontrada');
  const before = appConfig.systemPrompt;
  try {
    appConfig.systemPrompt = 's'.repeat(5000);
    const it = fakeInteraction({ customId: `cfgpanel_input_${idx}` });
    await cfg.handleConfigButton(it);
    const input = json(it.log.showModal[0]).components[0].components[0];
    assert.equal(input.value, undefined, 'não pode pré-preencher com texto cortado');
    assert.equal(input.max_length, 4000);
    assert.equal(input.style, 2);
    assert.match(input.placeholder, /grande demais/);
    appConfig.systemPrompt = 'prompt curto';
    const small = fakeInteraction({ customId: `cfgpanel_input_${idx}` });
    await cfg.handleConfigButton(small);
    const input2 = json(small.log.showModal[0]).components[0].components[0];
    assert.equal(input2.value, 'prompt curto');
    assert.equal(input2.placeholder, 'Digite o novo valor...');
  } finally {
    if (before === undefined) delete appConfig.systemPrompt; else appConfig.systemPrompt = before;
  }
});
await test('modal de edição numérico: continua com 1 a 20 caracteres e o valor atual', async () => {
  const it = fakeInteraction({ customId: 'cfgpanel_input_2' });
  await cfg.handleConfigButton(it);
  const input = json(it.log.showModal[0]).components[0].components[0];
  assert.deepEqual([input.value, input.min_length, input.max_length], ['3', 1, 20]);
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
section('Rádio: eco da busca (radioMCPHandler e radioModalHandler)');
// ═════════════════════════════════════════════════════════════════════════════════════════════
const fakeChannel = () => ({ sent: [], send: async function send(p) { this.sent.push(p); return { id: 'm1', delete: async () => {} }; } });
const radioSession = (extra = {}) => ({ status: 'STOPPED', playlist: [], currentIndex: -1, voiceChannelId: 'v1', ...extra });

await test('radio_play_music: busca não encontrada gigante devolve eco de até 100 caracteres', async () => {
  resetState();
  state.session = radioSession();
  state.resolved = { type: 'not_found' };
  const out = await radioMCP.handleRadioMCPCall('radio_play_music', { query: 'q'.repeat(5000) }, 'u1', 'g1', fakeChannel(), {});
  assert.ok(out.length < 220, `${out.length}`);
  assert.ok(out.startsWith('<@u1> Não encontrei **"qqq'));
  assert.ok(out.endsWith('…"** no Deezer nem no YouTube.'));
  const short = await radioMCP.handleRadioMCPCall('radio_play_music', { query: 'Welcome to the Jungle' }, 'u1', 'g1', fakeChannel(), {});
  assert.equal(short, '<@u1> Não encontrei **"Welcome to the Jungle"** no Deezer nem no YouTube.');
});
await test('radio_play_music ambíguo: a mensagem de escolha ecoa no máximo 100 caracteres da busca', async () => {
  resetState();
  state.session = radioSession();
  state.resolved = { type: 'ambiguous', results: mkTracks(5) };
  const channel = fakeChannel();
  const out = await radioMCP.handleRadioMCPCall('radio_play_music', { query: 'w'.repeat(5000) }, 'u1', 'g1', channel, {});
  assert.equal(out, null);
  assert.equal(channel.sent.length, 1);
  assert.ok(channel.sent[0].content.length < 300, `${channel.sent[0].content.length}`);
  assert.ok(channel.sent[0].content.includes('várias opções'));
  assertMessageFits(channel.sent[0], 'rádio/ambíguo');
});
await test('mensagens temporárias do rádio nunca passam de 2000 caracteres', async () => {
  resetState();
  state.session = radioSession();
  state.nextTrackValue = { title: 'T'.repeat(5000), artist: 'A'.repeat(5000) };
  const channel = fakeChannel();
  await radioMCP.handleRadioMCPCall('radio_next_track', {}, 'u1', 'g1', channel, {});
  assert.equal(channel.sent.length, 1);
  // a mensagem agora vai com allowedMentions (só quem pediu é notificado): o texto está em .content
  assert.ok(channel.sent[0].content.length <= 2000, `${channel.sent[0].content.length}`);
  assert.ok(channel.sent[0].content.endsWith('…'));
  state.nextTrackValue = { title: 'Curta', artist: 'Dupla' };
  const small = fakeChannel();
  await radioMCP.handleRadioMCPCall('radio_next_track', {}, 'u1', 'g1', small, {});
  assert.equal(small.sent[0].content, '⏭️ <@u1> Tocando próxima: **Curta** - Dupla');
});
await test('M3 rádio: título/artista com @everyone, @here, cargo ou outro usuário NÃO notificam ninguém além de quem pediu (mensagem temporária e escolha de busca)', async () => {
  resetState();
  state.session = radioSession();
  const OWNER = '123456789012345678';
  state.nextTrackValue = { title: '@everyone <@&987654321098765432> <@999999999999999999>', artist: '@here' };
  const channel = fakeChannel();
  await radioMCP.handleRadioMCPCall('radio_next_track', {}, OWNER, 'g1', channel, {});
  assert.equal(channel.sent.length, 1);
  assert.ok(channel.sent[0].content.includes('@everyone'), 'o texto continua mostrando o título (só não notifica)');
  assert.deepEqual(channel.sent[0].allowedMentions, { parse: [], users: [OWNER] });
  state.resolved = { type: 'ambiguous', results: mkTracks(3) };
  const second = fakeChannel();
  await radioMCP.handleRadioMCPCall('radio_play_music', { query: '@everyone <@&987654321098765432>' }, OWNER, 'g1', second, {});
  assert.equal(second.sent.length, 1);
  assert.deepEqual(second.sent[0].allowedMentions, { parse: [], users: [OWNER] });
  // embed puro (fila) não tem texto para marcar ninguém e segue sem allowedMentions
  const queueChannel = fakeChannel();
  state.session = radioSession({ status: 'PLAYING', playlist: mkTracks(3), currentIndex: 0, voiceChannelId: 'v1' });
  await radioMCP.handleRadioMCPCall('radio_show_queue', {}, OWNER, 'g1', queueChannel, {});
  assert.equal(queueChannel.sent.length, 1);
});
await test('o painel de configuração não promete persistência que não existe: o JSON ainda não é lido ao iniciar', () => {
  const src = fs.readFileSync(path.join(repoRoot, 'src/handlers/configPanelHandler.js'), 'utf8');
  assert.ok(!src.includes('JSON Permanente'), 'a página dizia "permanente", mas nada lê o config.json na subida');
  assert.ok(src.includes('esse arquivo ainda não é lido ao iniciar'));
});
await test('botão "Fila" e radio_show_queue com 150 faixas: o embed é enviado (antes lançava)', async () => {
  resetState();
  state.session = radioSession({ status: 'PLAYING', playlist: mkTracks(150), currentIndex: 10, voiceChannelId: 'v1' });
  const channel = fakeChannel();
  await radioMCP.handleRadioMCPCall('radio_show_queue', {}, 'u1', 'g1', channel, {});
  assert.equal(channel.sent.length, 1);
  assertMessageFits(channel.sent[0], 'rádio/fila');
  const it = fakeInteraction({ customId: 'radio_queue', member: { voice: { channelId: 'v1' } } });
  await radioModal.handleRadioButton(it, {});
  assert.equal(it.log.reply.length, 1);
  assertMessageFits(it.log.reply[0], 'rádio/botão fila');
  assert.ok(!/Ocorreu um erro/.test(it.log.reply[0].content ?? ''));
});
await test('modal de adicionar música: busca não encontrada ecoa no máximo 100 caracteres', async () => {
  resetState();
  state.session = radioSession();
  state.resolved = { type: 'not_found' };
  const it = fakeInteraction({
    customId: 'radio_add_modal', member: { voice: { channelId: 'v1' } },
    fields: { getTextInputValue: () => `  ${'b'.repeat(5000)}  ` },
  });
  const handled = await radioModal.handleRadioModal(it, {});
  assert.equal(handled, true);
  assert.equal(it.log.editReply.length, 1);
  const c = it.log.editReply[0].content;
  assert.ok(c.length < 150, `${c.length}`);
  assert.ok(c.startsWith('❌ Não encontrei **"bbb') && c.endsWith('…"**.'));
});

// ═════════════════════════════════════════════════════════════════════════════════════════════
console.log(`\n${passed} ok, ${failures.length} falha(s)`);
process.chdir(repoRoot); // no Windows não dá para apagar a pasta onde o processo está
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* sobra em %TEMP% */ }
if (failures.length) { console.log(`FALHAS: ${failures.join(' | ')}`); process.exit(1); }
process.exit(0); // o modal do rádio agenda um apagamento de resposta em 5 s (temporizador do código sob teste)
