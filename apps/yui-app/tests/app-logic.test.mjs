// Testes da lógica do app contra a Yui API REAL (servidor de verdade, IA falsa).
// Execução: npm test   (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-app-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.YUI_OWNER_NAME = 'Dono Teste';
process.env.YUI_AI_SETTINGS_FILE = path.join(tmp, 'secrets', 'ai-providers.json');
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'YUI_GATEWAY_DISABLE', 'YUI_GATEWAY_CUSTOM']) delete process.env[k];
const editCalls = [];
const logDir = path.join(tmp, 'logs');
fs.mkdirSync(logDir, { recursive: true });
fs.writeFileSync(path.join(logDir, 'app-2026-10-08.log'), '[2026-10-08 10:00:00] [info] primeira\n[2026-10-08 10:00:01] [error] segunda com erro\n');
const radioCalls = [];
const radioSession = { guildId: '444444444444444444', voiceChannelId: '1', status: 'PLAYING', playlist: [{ title: 'Faixa', artist: 'Artista' }], currentIndex: 0, queue: [], shuffle: false, loopMode: 'OFF', voiceMode: 'DIRECT', streamMode: 'HYBRID' };
radioSession.currentTrack = radioSession.playlist[0];
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const { initMemory } = await import(`file://${root}/src/core/index.js`);
const ai = await import(`file://${root}/src/core/ai/manager.js`);
const { createApiServer, parseTokens, parseCorsOrigins } = await import(`file://${root}/src/core/api/server.js`);
const { registerTool, clearTools } = await import(`file://${root}/src/core/agent/tools.js`);
const auth = await import(`file://${root}/src/core/api/auth.js`);
const { createAdmin } = await import(`file://${root}/src/core/api/admin.js`);
const { createClient, normalizeBaseUrl, ApiError } = await import('../src/api/client.ts');
const { resolveServerUrl } = await import('../src/serverUrl.ts');
const msg = await import('../src/chat/messages.ts');

await initMemory();

// IA falsa programável: o teste decide a próxima resposta.
let next = null;
ai.registerBackend(
  { name: 'fake', local: false, async chat({ prompt }) { return next ?? `eco: ${prompt}`; } },
  { activate: true }
);

// Ferramentas de teste (o app precisa lidar com execução direta e confirmação).
clearTools();
const ran = [];
registerTool({ name: 'demo.ping', description: 'Responde pong.', minRole: 'MEMBER', access: 'read', privateOnly: false, async run() { ran.push('ping'); return 'pong'; } });
registerTool({ name: 'demo.apagar', description: 'Ação sensível.', minRole: 'MEMBER', access: 'open', privateOnly: false, confirm: true, async run() { ran.push('apagar'); return 'apagado'; } });

const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`), corsOrigins: parseCorsOrigins('') });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); fs.rmSync(tmp, { recursive: true, force: true }); });

test('normalizeBaseUrl: esquema padrão, /v1 e barras finais', () => {
  assert.equal(normalizeBaseUrl('192.168.0.5:3939'), 'http://192.168.0.5:3939');
  assert.equal(normalizeBaseUrl('mnbf-neon.taild52b5a.ts.net:3939/'), 'https://mnbf-neon.taild52b5a.ts.net:3939');
  assert.equal(normalizeBaseUrl('https://x.ts.net/v1/'), 'https://x.ts.net');
  assert.equal(normalizeBaseUrl('  http://localhost:3939///  '), 'http://localhost:3939');
  assert.throws(() => normalizeBaseUrl(''), ApiError);
  assert.throws(() => normalizeBaseUrl('ftp://x.com'), /http/);
});

test('health e me refletem o papel e o escopo decididos pelo servidor', async () => {
  const owner = createClient({ baseUrl: url, token: OWNER });
  const health = await owner.health();
  assert.equal(health.ok, true);
  assert.equal(health.readOnly, true, 'o servidor informa o modo somente leitura');
  assert.equal(health.memory, true);
  assert.deepEqual(await owner.me(), { userId: '111', role: 'OWNER', memoryScope: 'personal', auth: 'token' });
  assert.equal((await createClient({ baseUrl: url, token: MEMBER }).me()).role, 'MEMBER');
});

test('erros: token inválido, servidor fora do ar e mensagens amigáveis', async () => {
  await assert.rejects(createClient({ baseUrl: url, token: 'token-errado-0123456789' }).me(), (e) => e instanceof ApiError && e.status === 401 && /inválidos ou expirados/.test(e.message));
  await assert.rejects(createClient({ baseUrl: 'http://127.0.0.1:1', token: OWNER, timeoutMs: 3000 }).health(), (e) => e.status === 0 && /conectar/.test(e.message));
});

test('chat: conversa normal pelo agent vira mensagem "reply"', async () => {
  const c = createClient({ baseUrl: url, token: MEMBER });
  next = '{"reply":"Oi! Tudo bem?"}';
  const reply = await c.send('oi');
  const m = msg.fromAgentReply(reply, 1000);
  assert.equal(m.role, 'yui');
  assert.equal(m.kind, 'reply');
  assert.equal(m.text, 'Oi! Tudo bem?');
});

test('chat: ferramenta executa direto e aparece como tool_result', async () => {
  const c = createClient({ baseUrl: url, token: MEMBER });
  next = '{"tool":"demo.ping","args":{}}';
  const m = msg.fromAgentReply(await c.send('faz ping'));
  assert.equal(m.kind, 'tool_result');
  assert.equal(m.tool, 'demo.ping');
  assert.equal(m.text, 'pong');
});

test('chat: ação sensível pede confirmação e só executa depois de confirmar', async () => {
  const c = createClient({ baseUrl: url, token: MEMBER });
  const before = ran.length;
  next = '{"tool":"demo.apagar","args":{}}';
  const ask = msg.fromAgentReply(await c.send('apaga tudo'));
  assert.equal(ask.kind, 'confirmation');
  assert.equal(ask.pending.status, 'waiting');
  assert.equal(ran.length, before, 'nada executa antes da confirmação');

  let list = msg.resolvePending([ask], ask.pending.id, 'approved');
  assert.equal(list[0].pending.status, 'approved');
  const done = msg.fromAgentReply(await c.confirm(ask.pending.id, true));
  assert.equal(done.kind, 'tool_result');
  assert.equal(ran.at(-1), 'apagar');

  // segunda confirmação do mesmo pedido é negada
  const again = msg.fromAgentReply(await c.confirm(ask.pending.id, true));
  assert.equal(again.kind, 'denied');
});

test('chat: cancelar a confirmação não executa', async () => {
  const c = createClient({ baseUrl: url, token: MEMBER });
  const before = ran.length;
  next = '{"tool":"demo.apagar","args":{}}';
  const ask = msg.fromAgentReply(await c.send('apaga'));
  const res = await c.confirm(ask.pending.id, false);
  assert.equal(res.reply, 'Ação cancelada.');
  assert.equal(ran.length, before);
});

test('chat: ferramenta inexistente vira "denied" no app', async () => {
  const c = createClient({ baseUrl: url, token: MEMBER });
  next = '{"tool":"pc.formatar","args":{}}';
  assert.equal(msg.fromAgentReply(await c.send('formata')).kind, 'denied');
});

test('memória: CRUD, escopo pessoal do dono e isolamento do membro', async () => {
  next = null;
  const owner = createClient({ baseUrl: url, token: OWNER });
  const member = createClient({ baseUrl: url, token: MEMBER });
  await owner.addMemory('O projeto BDS usa Kotlin', 'project');
  const mine = await owner.memories();
  assert.equal(mine.scope, 'personal');
  assert.equal(mine.memories.length, 1);
  assert.equal((await member.memories()).memories.length, 0, 'membro não vê a memória pessoal do dono');

  await member.addMemory('prefere respostas curtas');
  const list = (await member.memories()).memories;
  assert.equal(list.length, 1);
  assert.equal((await member.deleteMemory(list[0].id)).ok, true);
  await member.addMemory('a');
  await member.addMemory('b');
  assert.equal((await member.clearMemories()).removed, 2);
});

test('histórico: restaura só mensagens válidas e limita o tamanho', () => {
  assert.deepEqual(msg.parseStoredHistory(null), []);
  assert.deepEqual(msg.parseStoredHistory('lixo{'), []);
  const ok = msg.userMessage('oi', 1);
  const stored = JSON.stringify([ok, { id: 1 }, null, { id: 'x', text: 'a', role: 'hacker', createdAt: 1 }]);
  assert.equal(msg.parseStoredHistory(stored).length, 1);
  const many = Array.from({ length: 150 }, (_, i) => msg.userMessage(`m${i}`, i));
  assert.equal(msg.trimHistory(many).length, msg.MAX_HISTORY);
  assert.equal(msg.trimHistory(many).at(-1).text, 'm149');
});

test('confirmações antigas expiram no app (a API descarta em 2 min)', () => {
  const ask = msg.fromAgentReply({ type: 'needs_confirmation', reply: 'Confirma?', tool: 'x', pendingId: 'abc' }, 1_000);
  assert.equal(msg.expireStale([ask], 1_000 + 60_000)[0].pending.status, 'waiting');
  assert.equal(msg.expireStale([ask], 1_000 + msg.CONFIRM_TTL_MS + 1)[0].pending.status, 'expired');
});


// ───────────────────────── Login por usuário e senha + painel ─────────────────────────
const PASS = 'uma-senha-bem-longa-123';
const bans = { users: {}, guilds: {}, channels: {} };
const modes = {};
const fakeDeps = {
  getBans: () => bans,
  addBan: (t, id, r) => { bans[`${t}s`][id] = { reason: r, timestamp: new Date().toISOString() }; },
  removeBan: (t, id) => { delete bans[`${t}s`][id]; },
  setAutoBlock: (g, m) => { modes[g] = m; },
  getAutoBlockMode: (g) => modes[g] ?? 'both',
  isServerAccepted: () => true,
  logDir,
  hostStats: () => ({ platform: 'win32', ramTotalMB: 4096, ramFreeMB: 1024, diskTotalGB: 465.7, diskFreeGB: 120.5 }),
  radio: { sessions: () => [radioSession], getSession: (g) => (g === radioSession.guildId ? radioSession : null), connected: () => true, pause: async () => { radioCalls.push('pause'); return true; }, resume: async () => true, stopMusic: async () => {}, leave: async () => { radioCalls.push('leave'); } },
  setGuildChannel: async (g, col, ch) => { editCalls.push(['channel', g, col, ch]); },
  addYoutube: async (x) => { editCalls.push(['yt+', x.input, x.discordChannelId, x.shorts, x.liveMode]); return { added: true, channelId: 'UCxyz123456', name: 'Canal' }; },
  setYoutubeLiveMode: async (g, y, c, mode) => { editCalls.push(['yt-mode', y, c, mode]); return true; },
  removeYoutube: async (g, y, c) => { editCalls.push(['yt-', y, c]); return true; },
  addTwitch: async (x) => { editCalls.push(['tw+', x.login]); return { added: true, login: x.login, name: x.login }; },
  removeTwitch: async (g, l, c) => { editCalls.push(['tw-', l, c]); return true; },
  aiChat: async () => ({ x_gateway: { model: 'm' } }),
  integrationData: async () => ({ youtubeSubs: 2, twitchSubs: 1, lastDaily: '2026-10-08', lastWeekly: null, gateway: { inChain: true } }),
  guildDetail: async (g) => ({ id: g.id, name: g.name, members: g.memberCount, channels: { noticias: { id: '1', name: 'noticias' }, diario: null, semanal: null, atualizacoes: null }, respondToEveryone: true, youtube: [], twitch: [{ name: 'streamer', channel: null }], tools: null }),
};
const fakeDiscord = { isReady: () => true, user: { tag: 'Yui#0001' }, guilds: { cache: new Map([['444444444444444444', { id: '444444444444444444', name: 'Servidor X', memberCount: 7, channels: { cache: new Map([['777777777777777777', { id: '777777777777777777', name: 'geral', type: 0 }]]) } }]]) } };
const panelServer = createApiServer({
  tokens: parseTokens(`${MEMBER}=222`),
  panel: auth.loadPanelCredentials({ YUI_OWNER_ID: '111', YUI_PANEL_USER: 'mauro', YUI_PANEL_PASSWORD: PASS }),
  admin: createAdmin({ client: fakeDiscord, deps: fakeDeps, exit: () => {} }),
  limiter: auth.createLoginLimiter({ max: 3 }),
  loginDelayMs: 0,
});
await new Promise((r) => panelServer.listen(0, '127.0.0.1', r));
const panelUrl = `http://127.0.0.1:${panelServer.address().port}`;
test.after(() => panelServer.close());

test('login: o servidor informa se há login por senha; sem configuração o app cai no token', async () => {
  assert.equal((await createClient({ baseUrl: panelUrl, token: '' }).authStatus()).passwordLogin, true);
  assert.equal((await createClient({ baseUrl: url, token: '' }).authStatus()).passwordLogin, false);
});

test('login: usuário e senha geram uma sessão que o app usa como token', async () => {
  const anon = createClient({ baseUrl: panelUrl, token: '' });
  const r = await anon.login('mauro', PASS);
  assert.match(r.token, /^[0-9a-f]{64}$/);
  assert.ok(r.expiresAt > Date.now());
  const logged = createClient({ baseUrl: panelUrl, token: r.token });
  const me = await logged.me();
  assert.deepEqual([me.role, me.memoryScope, me.auth], ['OWNER', 'personal', 'session']);
});

test('login: erro mostra mensagem genérica; depois de muitas falhas o app recebe o aviso de bloqueio', async () => {
  const anon = createClient({ baseUrl: panelUrl, token: '' });
  await assert.rejects(anon.login('mauro', 'errada-errada-1'), (e) => e instanceof ApiError && e.status === 401 && /inválidos/.test(e.message));
  await assert.rejects(anon.login('outro', PASS), (e) => e.status === 401 && /inválidos/.test(e.message));
  await assert.rejects(anon.login('mauro', 'errada-errada-2'), (e) => e.status === 401);
  await assert.rejects(anon.login('mauro', PASS), (e) => e.status === 429 && /tentativas/i.test(e.message), 'bloqueado mesmo com a senha certa');
});

test('sessão revogada (logout) faz o app ser avisado: onUnauthorized dispara', async () => {
  // usa o servidor sem limite apertado: novo servidor só para este teste
  const s2 = createApiServer({
    tokens: [], panel: auth.loadPanelCredentials({ YUI_OWNER_ID: '111', YUI_PANEL_USER: 'mauro', YUI_PANEL_PASSWORD: PASS }),
    admin: createAdmin({ client: fakeDiscord, deps: fakeDeps, exit: () => {} }), loginDelayMs: 0,
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const u2 = `http://127.0.0.1:${s2.address().port}`;
  let fired = 0;
  const { token } = await createClient({ baseUrl: u2, token: '' }).login('mauro', PASS);
  const c = createClient({ baseUrl: u2, token, onUnauthorized: () => { fired += 1; } });
  await c.me();
  assert.equal(fired, 0);
  assert.equal((await c.logout()).revoked, true);
  await assert.rejects(c.me(), (e) => e.status === 401);
  assert.equal(fired, 1, 'o app volta para a tela de login');
  // login com credenciais erradas NÃO dispara onUnauthorized (não havia sessão)
  let wrong = 0;
  await assert.rejects(createClient({ baseUrl: u2, token: '', onUnauthorized: () => { wrong += 1; } }).login('x', 'y'));
  assert.equal(wrong, 0);
  s2.close();
});

test('painel: o dono vê visão geral, servidores, bans, memória e ferramentas', async () => {
  const s2 = createApiServer({
    tokens: parseTokens(`${MEMBER}=222`),
    panel: auth.loadPanelCredentials({ YUI_OWNER_ID: '111', YUI_PANEL_USER: 'mauro', YUI_PANEL_PASSWORD: PASS }),
    admin: createAdmin({ client: fakeDiscord, deps: fakeDeps, exit: () => {} }), loginDelayMs: 0,
  });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const u2 = `http://127.0.0.1:${s2.address().port}`;
  const { token } = await createClient({ baseUrl: u2, token: '' }).login('mauro', PASS);
  const { admin } = createClient({ baseUrl: u2, token });

  const ov = await admin.overview();
  assert.equal(ov.discord.online, true);
  assert.equal(ov.flags.readOnly, true);
  // Visão Geral: saúde do computador, atividade recente (sem detalhes dos eventos), retenção da memória e nome do dono
  assert.deepEqual(ov.host, { platform: 'win32', ramTotalMB: 4096, ramFreeMB: 1024, diskTotalGB: 465.7, diskFreeGB: 120.5 });
  assert.equal(ov.ownerName, 'Dono Teste');
  assert.equal(ov.retention.ownerPermanent, true);
  assert.ok(ov.retention.othersDays === null || ov.retention.othersDays > 0);
  assert.deepEqual(Object.keys(ov.limits).sort(), ['dmMax', 'dmWindowMinutes', 'fileLinkMinutes'], 'os limites mostrados na tela vêm do servidor');
  assert.ok(ov.limits.dmMax > 0 && ov.limits.dmWindowMinutes > 0 && ov.limits.fileLinkMinutes > 0);
  assert.equal(typeof ov.retention.othersPermanent, 'boolean', 'o painel sabe dizer "permanente" para os demais usuários');
  assert.ok(Array.isArray(ov.activity) && ov.activity.length > 0 && ov.activity.length <= 8, 'o login anterior aparece na atividade');
  for (const e of ov.activity) assert.deepEqual(Object.keys(e).sort(), ['event', 'platform', 'role', 'ts'], 'só quando, o quê e por onde: nada dos detalhes');
  assert.equal(ov.interactions.series.length, 24, 'gráfico de 24 horas');
  assert.equal(typeof ov.interactions.total, 'number');
  assert.deepEqual(Object.keys(ov.problems).sort(), ['alertFail', 'loginFail', 'toolDenied', 'toolError']);
  const guilds = await admin.guilds();
  assert.equal(guilds[0].name, 'Servidor X');
  assert.equal((await admin.setAutomod('444444444444444444', 'trigger')).automod, 'trigger');
  await admin.addBan('user', '999999999999999999', 'teste');
  assert.equal((await admin.bans()).users[0].id, '999999999999999999');
  await admin.removeBan('user', '999999999999999999');
  assert.equal((await admin.bans()).users.length, 0);
  assert.ok(Array.isArray((await admin.audit(20))));
  assert.equal((await admin.tools()).readOnly, true);
  const groups = await admin.integrations();
  const itemKeys = groups.flatMap((g) => g.items.map((i) => i.key));
  for (const k of ['discord', 'gemini', 'youtube', 'twitch', 'gta-weekly']) assert.ok(itemKeys.includes(k), `falta ${k}`);
  assert.match(groups.flatMap((g) => g.items).find((i) => i.key === 'gta-daily').detail, /2026-10-08/);
  // edição de canais e seguidos
  await admin.setGuildChannel('444444444444444444', 'diario', '777777777777777777');
  await admin.setGuildChannel('444444444444444444', 'diario', null);
  await admin.followYoutube('444444444444444444', { channel: '@Canal', discordChannelId: '777777777777777777', videos: true, shorts: false, lives: true });
  await admin.followYoutube('444444444444444444', { channel: '@Outro', discordChannelId: '777777777777777777', videos: true, shorts: true, lives: true, liveMode: 'edit' });
  const modeRes = await admin.setYoutubeLiveMode('444444444444444444', 'UCxyz123456', '777777777777777777', 'new');
  assert.equal(modeRes.liveMode, 'new');
  await admin.unfollowYoutube('444444444444444444', 'UCxyz123456', '777777777777777777');
  await admin.followTwitch('444444444444444444', { streamer: 'https://twitch.tv/Alanzoka', discordChannelId: '777777777777777777' });
  await admin.unfollowTwitch('444444444444444444', 'alanzoka', '777777777777777777');
  assert.deepEqual(editCalls, [
    ['channel', '444444444444444444', 'daily_channel_id', '777777777777777777'],
    ['channel', '444444444444444444', 'daily_channel_id', null],
    ['yt+', '@Canal', '777777777777777777', false, 'auto'],
    ['yt+', '@Outro', '777777777777777777', true, 'edit'],
    ['yt-mode', 'UCxyz123456', '777777777777777777', 'new'],
    ['yt-', 'UCxyz123456', '777777777777777777'],
    ['tw+', 'alanzoka'],
    ['tw-', 'alanzoka', '777777777777777777'],
  ]);
  await assert.rejects(admin.setGuildChannel('444444444444444444', 'diario', '123456789012345678'), (e) => e.status === 400);
  await assert.rejects(admin.setYoutubeLiveMode('444444444444444444', 'UCxyz123456', '777777777777777777', 'invalido'), (e) => e.status === 400 && /Modo de live/.test(e.message));
  await assert.rejects(admin.followYoutube('444444444444444444', { channel: '@Canal', discordChannelId: '777777777777777777', liveMode: 'xyz' }), (e) => e.status === 400);

  // chaves de IA: entram, aparecem só como "…4 últimos" e saem
  const SECRET = 'gsk_chave_do_app_teste_WXYZ9876';
  await admin.aiAddKey('groq', SECRET);
  const aiView = await admin.ai();
  assert.equal(aiView.editable, true);
  assert.equal(aiView.providers.find((p) => p.id === 'groq').panelKeys[0].hint, '…9876');
  assert.ok(!JSON.stringify(aiView).includes(SECRET));
  assert.equal((await admin.aiTest('groq')).ok, true);
  await admin.aiAddCustom({ id: 'omniroute', label: 'OmniRoute', baseUrl: 'http://127.0.0.1:20128/v1', models: 'free-stack' });
  assert.equal((await admin.ai()).custom.find((c) => c.id === 'omniroute').models[0], 'free-stack');
  await assert.rejects(admin.aiAddKey('groq', 'curta'), (e) => e.status === 400);
  await admin.aiRemoveCustom('omniroute');
  await admin.aiRemoveKey('groq', 0);
  assert.equal((await admin.ai()).providers.find((p) => p.id === 'groq').panelKeys.length, 0);

  // rádio e logs
  const radio = await admin.radio();
  assert.equal(radio[0].current.title, 'Faixa');
  assert.equal(radio[0].guildName, 'Servidor X');
  await admin.radioAction('444444444444444444', 'pause');
  await admin.radioAction('444444444444444444', 'leave');
  assert.deepEqual(radioCalls, ['pause', 'leave']);
  await assert.rejects(admin.radioAction('444444444444444444', 'explodir'), (e) => e.status === 400);
  const logs = await admin.logs({ kind: 'app', level: 'error' });
  assert.equal(logs.entries.length, 1);
  assert.equal(logs.entries[0].text, 'segunda com erro');
  assert.equal((await admin.logs({ q: 'primeira' })).entries.length, 1);
  await assert.rejects(admin.logs({ date: '../../.env' }), (e) => e.status === 400);

  const detail = await admin.guildDetail('444444444444444444');
  assert.equal(detail.channels.noticias.name, 'noticias');
  assert.equal(detail.twitch[0].name, 'streamer');
  await assert.rejects(admin.restart().then(() => { throw new Error('ok'); }), (e) => e.message === 'ok', 'restart responde ok (a saída é simulada)');

  // membro com token estático é barrado em tudo
  const memberAdmin = createClient({ baseUrl: u2, token: MEMBER }).admin;
  await assert.rejects(memberAdmin.overview(), (e) => e.status === 403);
  await assert.rejects(memberAdmin.integrations(), (e) => e.status === 403);
  await assert.rejects(memberAdmin.ai(), (e) => e.status === 403);
  await assert.rejects(memberAdmin.radio(), (e) => e.status === 403);
  await assert.rejects(memberAdmin.logs(), (e) => e.status === 403);
  await assert.rejects(memberAdmin.aiAddKey('groq', 'gsk_membro_nao_pode_123456'), (e) => e.status === 403);
  await assert.rejects(memberAdmin.setGuildChannel('444444444444444444', 'diario', null), (e) => e.status === 403);
  await assert.rejects(memberAdmin.guildDetail('444444444444444444'), (e) => e.status === 403);
  await assert.rejects(memberAdmin.addBan('user', '999999999999999999', 'x'), (e) => e.status === 403);
  s2.close();
});


// ───────────────────────── Endereço do servidor (o usuário não digita) ─────────────────────────
test('servidor: vem da configuração do build; na web, do próprio PC que serviu a página', () => {
  const web = { protocol: 'http:', hostname: 'localhost' };
  assert.equal(resolveServerUrl({ env: 'https://meu-pc.ts.net:3939/', platform: 'android' }), 'https://meu-pc.ts.net:3939');
  assert.equal(resolveServerUrl({ env: 'meu-pc.ts.net:3939', platform: 'android' }), 'https://meu-pc.ts.net:3939', '*.ts.net assume https');
  assert.equal(resolveServerUrl({ platform: 'web', location: web }), 'http://localhost:3939');
  assert.equal(resolveServerUrl({ platform: 'web', location: { protocol: 'https:', hostname: 'pc.ts.net' }, apiPort: 4000 }), 'https://pc.ts.net:4000');
  assert.equal(resolveServerUrl({ env: 'https://a.ts.net:3939', platform: 'web', location: web }), 'https://a.ts.net:3939', 'a configuração tem prioridade');
});

test('servidor: sem configuração no Android, ou configuração inválida, NÃO conecta em lugar nenhum', () => {
  assert.equal(resolveServerUrl({ platform: 'android' }), null);
  assert.equal(resolveServerUrl({ platform: 'ios', location: { protocol: 'http:', hostname: 'x' } }), null);
  assert.equal(resolveServerUrl({ env: 'ftp://x.com', platform: 'web', location: { protocol: 'http:', hostname: 'localhost' } }), null);
  assert.equal(resolveServerUrl({ env: '   ', platform: 'android' }), null);
});

// ───────────────────────── Chave de uso único por DM ─────────────────────────
const dms = [];
const keyServer = createApiServer({
  tokens: [],
  panel: auth.loadPanelCredentials({}),
  admin: createAdmin({ client: fakeDiscord, deps: fakeDeps, exit: () => {} }),
  notify: async (userId, text) => { dms.push({ userId, text }); },
  ownerId: '111',
  loginDelayMs: 0,
});
await new Promise((r) => keyServer.listen(0, '127.0.0.1', r));
const keyUrl = `http://127.0.0.1:${keyServer.address().port}`;
test.after(() => keyServer.close());

test('chave por DM: o app pede, a chave chega só por DM e vira uma sessão do dono', async () => {
  const anon = createClient({ baseUrl: keyUrl, token: '' });
  const st = await anon.authStatus();
  assert.deepEqual([st.passwordLogin, st.discordKey], [false, true]);

  const req = await anon.discordRequest();
  assert.equal(req.ok, true);
  assert.ok(req.expiresInSeconds > 0);
  assert.equal(dms.length, 1);
  assert.equal(dms[0].userId, '111');
  const code = dms[0].text.match(/`([A-Z0-9]{5}-[A-Z0-9]{5})`/)[1];
  assert.ok(!JSON.stringify(req).includes(code), 'a chave não volta pela API');

  const session = await anon.discordVerify(code.toLowerCase());
  const me = await createClient({ baseUrl: keyUrl, token: session.token }).me();
  assert.deepEqual([me.role, me.memoryScope, me.auth], ['OWNER', 'personal', 'session']);
});

test('chave por DM: chave errada dá mensagem amigável; reuso é negado', async () => {
  const anon = createClient({ baseUrl: keyUrl, token: '' });
  await anon.discordRequest();
  const code = dms.at(-1).text.match(/`([A-Z0-9]{5}-[A-Z0-9]{5})`/)[1];
  await assert.rejects(anon.discordVerify('ZZZZZ-ZZZZZ'), (e) => e instanceof ApiError && e.status === 401 && /inválida ou expirada/.test(e.message));
  await anon.discordVerify(code);
  await assert.rejects(anon.discordVerify(code), (e) => e.status === 401);
});

test('chave por DM: limite de pedidos protege a DM do dono e a mensagem do app é clara', async () => {
  const anon = createClient({ baseUrl: keyUrl, token: '' });
  let blocked = null;
  for (let i = 0; i < 6; i++) {
    try { await anon.discordRequest(); } catch (e) { blocked = e; break; }
  }
  assert.ok(blocked instanceof ApiError);
  assert.equal(blocked.status, 429);
});



test('endereço do painel do OmniRoute: mesmo computador da API, porta própria', async () => {
  const { omniRouteUrl, OMNIROUTE_DEFAULT_PORT } = await import('../src/omniRouteUrl.ts');
  assert.equal(OMNIROUTE_DEFAULT_PORT, 20128);
  assert.equal(omniRouteUrl('http://192.168.15.12:3939'), 'http://192.168.15.12:20128/');
  assert.equal(omniRouteUrl('http://192.168.15.12:3939/', '21000'), 'http://192.168.15.12:21000/');
  assert.equal(omniRouteUrl('http://192.168.15.12:3939', 'abc'), 'http://192.168.15.12:20128/', 'porta inválida volta ao padrão');
  assert.equal(omniRouteUrl('https://yui.exemplo.com'), 'https://yui.exemplo.com:20128/');
  assert.equal(omniRouteUrl(''), null);
  assert.equal(omniRouteUrl(null), null);
  assert.equal(omniRouteUrl('javascript:alert(1)'), null);
  assert.equal(omniRouteUrl('ftp://x'), null);
});
