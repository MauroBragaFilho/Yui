// Testes do login (usuário/senha) e do painel de administração.
// Execução: npm run test:panel
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-panel-'));
const logDir = path.join(tmp, 'logs');
fs.mkdirSync(logDir, { recursive: true });
const ESC = String.fromCharCode(27);
fs.writeFileSync(path.join(logDir, 'app-2026-10-08.log'), [
  '[2026-10-08 10:00:00] [info] [YoutubeEngine] Checando canal vall...',
  '[2026-10-08 10:00:01] [error] Chamada falhou (token=segredo-super-secreto-xyz-12345 chave AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY12 e gsk_abcdefghijklmnop1234)',
  '[2026-10-08 10:00:02] [error] Falha ao baixar dados',
  '    at fetch (node:internal)',
  '    at main (file:///x.js:1:1)',
  `[2026-10-08 10:00:03] [warn] ${ESC}[33mAviso colorido${ESC}[39m do rádio`,
  '[2026-10-08 10:00:04] [info] Última linha do dia',
].join('\n'));
fs.writeFileSync(path.join(logDir, 'app-2026-10-07.log'), '[2026-10-07 09:00:00] [info] Dia anterior\n');
fs.writeFileSync(path.join(logDir, 'error-2026-10-08.log'), '[2026-10-08 10:00:02] [error] Falha ao baixar dados\n');
fs.writeFileSync(path.join(logDir, 'senha.txt'), 'nao deve listar');
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_AI_SETTINGS_FILE = path.join(tmp, 'secrets', 'ai-providers.json');
for (const k of ['GROQ_API_KEY', 'GROQ_API_KEYS', 'YUI_GATEWAY_DISABLE', 'YUI_GATEWAY_CUSTOM', 'CLOUDFLARE_ACCOUNT_ID']) delete process.env[k];
process.env.YUI_OWNER_ID = OWNER;
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.YUI_READ_ONLY = 'true';
delete process.env.OWNER_ID;
delete process.env.OWNER_IDS;
for (const k of ['YUI_PANEL_USER', 'YUI_PANEL_PASSWORD', 'YUI_PANEL_PASSWORD_HASH', 'YUI_PANEL_USER_ID', 'AI_BASE_URL', 'AI_BACKEND']) delete process.env[k];

const auth = await import('../src/core/api/auth.js');
const { createAdmin } = await import('../src/core/api/admin.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { initMemory, memory, buildContext } = await import('../src/core/index.js');
const tools = await import('../src/core/agent/tools.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const STATIC_OWNER = 'static-owner-token-0123456789';
const STATIC_MEMBER = 'static-member-token-0123456789';
const PASSWORD = 'uma-senha-bem-longa-123';

/* ── dependências falsas do bot: nunca tocam em bans.json / Discord reais ── */
function makeBot() {
  const bans = { users: {}, guilds: {}, channels: {} };
  const modes = {};
  const calls = [];
  const botState = { radioPauseFails: false };
  const radioSession = { guildId: '444444444444444444', voiceChannelId: '555555555555555500', status: 'PLAYING', playlist: [{ title: 'Música A', artist: 'Artista 1' }, { title: 'Música B', artist: 'Artista 2' }], currentIndex: 0, shuffle: false, loopMode: 'OFF', voiceMode: 'DIRECT', streamMode: 'HYBRID' };
  radioSession.currentTrack = radioSession.playlist[0];
  radioSession.queue = radioSession.playlist.slice(1);
  const deps = {
    logDir,
    radio: {
      sessions: () => [radioSession],
      getSession: (g) => (g === '444444444444444444' ? radioSession : null),
      connected: () => true,
      pause: async () => { calls.push(['radio:pause']); return !botState.radioPauseFails; },
      resume: async () => { calls.push(['radio:resume']); return true; },
      stopMusic: async () => { calls.push(['radio:stop']); },
      leave: async () => { calls.push(['radio:leave']); },
    },
    setGuildChannel: async (g, col, ch) => { calls.push(['setGuildChannel', g, col, ch]); },
    addYoutube: async (x) => { calls.push(['addYoutube', x]); return { added: true, channelId: 'UCabc123456', name: 'Canal X' }; },
    removeYoutube: async (g, y, c) => { calls.push(['removeYoutube', g, y, c]); return true; },
    addTwitch: async (x) => { calls.push(['addTwitch', x]); return { added: true, login: x.login, name: x.login }; },
    removeTwitch: async (g, l, c) => { calls.push(['removeTwitch', g, l, c]); return true; },
    aiChat: async (model) => { calls.push(['aiChat', model]); return { x_gateway: { model: 'm' } }; },
    getBans: () => bans,
    addBan: (t, id, r) => { bans[`${t}s`][id] = { reason: r, timestamp: new Date().toISOString() }; },
    removeBan: (t, id) => { delete bans[`${t}s`][id]; },
    setAutoBlock: (g, m) => { modes[g] = m; },
    getAutoBlockMode: (g) => modes[g] ?? 'both',
    isServerAccepted: (g) => g !== '333333333333333333',
    integrationData: async () => ({ youtubeSubs: 7, twitchSubs: 0, lastDaily: '2026-10-08', lastWeekly: '2026-W41', gateway: { inChain: true } }),
    guildDetail: async (g) => ({
      id: g.id, name: g.name, members: g.memberCount,
      channels: { noticias: { id: '1', name: 'noticias' }, diario: null, semanal: null, atualizacoes: null },
      youtube: [{ name: 'Canal X', channel: { id: '2', name: 'videos' }, videos: true, shorts: true, lives: false }],
      twitch: [], tools: { enabled: ['join_voice_call'], disabled: [] },
    }),
  };
  const guilds = new Map([
    ['444444444444444444', { id: '444444444444444444', name: 'Servidor B', memberCount: 12, channels: { cache: new Map([['555555555555555500', { id: '555555555555555500', name: 'Sala de música', type: 2 }], ['777777777777777777', { id: '777777777777777777', name: 'noticias', type: 0 }], ['888888888888888888', { id: '888888888888888888', name: 'voz', type: 2 }]]) } }],
    ['333333333333333333', { id: '333333333333333333', name: 'Servidor A', memberCount: 3 }],
  ]);
  const client = { isReady: () => true, user: { tag: 'Yui#0001' }, guilds: { cache: guilds } };
  return { bans, modes, deps, client, calls, get radioPauseFails() { return botState.radioPauseFails; }, set radioPauseFails(v) { botState.radioPauseFails = v; } };
}

async function startServer({ panelEnv = {}, clock, ttlMs, adminOpts = {}, notify = null } = {}) {
  const panel = auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, ...panelEnv });
  const sessions = auth.createSessionStore({ ttlMs: ttlMs ?? 60_000, now: clock });
  const limiter = auth.createLoginLimiter({ now: clock });
  const bot = makeBot();
  const exits = [];
  const admin = createAdmin({ client: bot.client, deps: bot.deps, exit: () => exits.push(Date.now()), ...adminOpts });
  const server = createApiServer({
    tokens: parseTokens(`${STATIC_OWNER}=${OWNER},${STATIC_MEMBER}=${MEMBER}`),
    panel, sessions, limiter, admin, loginDelayMs: 0,
    notify,
    ownerId: OWNER,
    pairing: auth.createPairing({ now: clock }),
    requestLimiter: auth.createLoginLimiter({ max: 3, windowMs: 10 * 60 * 1000, now: clock }),
    codeLimiter: auth.createLoginLimiter({ max: 5, windowMs: 15 * 60 * 1000, now: clock }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, { token, body } = {}) => {
    const res = await fetch(base + route, {
      method,
      headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
      body: body ? JSON.stringify(body) : undefined,
    });
    return { status: res.status, headers: res.headers, json: await res.json().catch(() => null) };
  };
  const login = (user, password) => call('POST', '/v1/auth/login', { body: { user, password } });
  return { server, call, login, bot, exits, sessions, limiter, close: () => server.close() };
}

const GOOD_ENV = { YUI_PANEL_USER: 'mauro', YUI_PANEL_PASSWORD: PASSWORD };

console.log('Senhas e credenciais');
await test('hash scrypt: confere a senha certa, recusa a errada e hash malformado', () => {
  const h = auth.hashPassword('minha-senha-secreta');
  assert.match(h, /^scrypt\$\d+\$/);
  assert.equal(auth.verifyPasswordHash('minha-senha-secreta', h), true);
  assert.equal(auth.verifyPasswordHash('minha-senha-secretA', h), false);
  assert.equal(auth.verifyPasswordHash('x', 'lixo'), false);
  assert.equal(auth.verifyPasswordHash('x', ''), false);
  assert.notEqual(auth.hashPassword('minha-senha-secreta'), h, 'cada hash tem salt próprio');
});
await test('sem configuração o login fica desativado, sem avisos', () => {
  const c = auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER });
  assert.deepEqual([c.enabled, c.reasons.length], [false, 0]);
});
await test('configuração incompleta ou fraca NÃO ativa o login e explica o motivo', () => {
  assert.match(auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, YUI_PANEL_USER: 'a' }).reasons.join(), /SENHA|HASH|PASSWORD/i);
  assert.match(auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, YUI_PANEL_PASSWORD: 'x'.repeat(12) }).reasons.join(), /YUI_PANEL_USER/);
  const curta = auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, YUI_PANEL_USER: 'a', YUI_PANEL_PASSWORD: 'curta' });
  assert.equal(curta.enabled, false);
  assert.match(curta.reasons.join(), /pelo menos 10/);
  const semDono = auth.loadPanelCredentials({ YUI_PANEL_USER: 'a', YUI_PANEL_PASSWORD: PASSWORD });
  assert.equal(semDono.enabled, false);
  assert.match(semDono.reasons.join(), /dono/);
});
await test('senha em texto funciona mas avisa para preferir o hash; o hash tem prioridade', () => {
  const plain = auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, ...GOOD_ENV });
  assert.equal(plain.enabled, true);
  assert.match(plain.warnings.join(), /hash/i);
  assert.equal(plain.check('mauro', PASSWORD), true);
  const hashed = auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, YUI_PANEL_USER: 'mauro', YUI_PANEL_PASSWORD_HASH: auth.hashPassword('outra-senha-longa-9'), YUI_PANEL_PASSWORD: PASSWORD });
  assert.equal(hashed.warnings.length, 0);
  assert.equal(hashed.check('mauro', 'outra-senha-longa-9'), true);
  assert.equal(hashed.check('mauro', PASSWORD), false, 'com hash definido, a senha em texto é ignorada');
});
await test('check exige usuário E senha corretos; vazios e tipos estranhos são recusados', () => {
  const c = auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, ...GOOD_ENV });
  assert.equal(c.check('mauro', PASSWORD), true);
  assert.equal(c.check('Mauro', PASSWORD), false, 'usuário diferencia maiúsculas');
  assert.equal(c.check('mauro', PASSWORD + 'x'), false);
  assert.equal(c.check('outro', PASSWORD), false);
  assert.equal(c.check('', ''), false);
  assert.equal(c.check(undefined, undefined), false);
  assert.equal(c.check(null, null), false);
});
await test('o login é vinculado ao dono (ou a YUI_PANEL_USER_ID)', () => {
  assert.equal(auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, ...GOOD_ENV }).userId, OWNER);
  assert.equal(auth.loadPanelCredentials({ OWNER_ID: '555555555555555555', ...GOOD_ENV }).userId, '555555555555555555');
  assert.equal(auth.loadPanelCredentials({ YUI_OWNER_ID: OWNER, YUI_PANEL_USER_ID: MEMBER, ...GOOD_ENV }).userId, MEMBER);
});

console.log('Sessões e limite de tentativas');
await test('sessão: cria, expira no prazo, revoga e limita a quantidade', () => {
  let t = 1_000;
  const s = auth.createSessionStore({ ttlMs: 10_000, now: () => t });
  const a = s.create(OWNER);
  assert.match(a.token, /^[0-9a-f]{64}$/);
  assert.equal(s.get(a.token).userId, OWNER);
  t += 9_999; assert.ok(s.get(a.token), 'ainda válida');
  t += 2; assert.equal(s.get(a.token), null, 'expirou');
  const b = s.create(OWNER); assert.equal(s.revoke(b.token), true); assert.equal(s.get(b.token), null);
  assert.equal(s.get('inexistente'), null); assert.equal(s.get(''), null); assert.equal(s.get(null), null);
  for (let i = 0; i < 40; i++) s.create(OWNER);
  assert.ok(s.size() <= 20, `no máximo 20 sessões (tem ${s.size()})`);
});
await test('limitador: bloqueia após 5 falhas, informa o tempo e libera depois da janela', () => {
  let t = 0;
  const l = auth.createLoginLimiter({ max: 5, windowMs: 900_000, now: () => t });
  for (let i = 0; i < 4; i++) { l.fail(); t += 1000; }
  assert.equal(l.lockedForSeconds(), 0);
  l.fail();
  assert.ok(l.lockedForSeconds() > 800);
  t += 901_000;
  assert.equal(l.lockedForSeconds(), 0, 'liberou depois da janela');
  l.fail(); l.reset(); assert.equal(l.count(), 0);
});

console.log('Login pela API');
{
  let t = 5_000_000;
  const clock = () => t;
  const s = await startServer({ panelEnv: GOOD_ENV, clock, ttlMs: 60_000 });
  let sessionToken;

  await test('/v1/auth/status informa se o login por senha está ativo', async () => {
    assert.equal((await s.call('GET', '/v1/auth/status')).json.passwordLogin, true);
  });
  await test('login correto devolve uma sessão que vale como o token', async () => {
    const r = await s.login('mauro', PASSWORD);
    assert.equal(r.status, 200);
    assert.match(r.json.token, /^[0-9a-f]{64}$/);
    assert.equal(r.json.userId, OWNER);
    sessionToken = r.json.token;
    const me = await s.call('GET', '/v1/me', { token: sessionToken });
    assert.deepEqual([me.json.role, me.json.memoryScope, me.json.auth], ['OWNER', 'personal', 'session']);
  });
  await test('o token estático continua funcionando (compatibilidade)', async () => {
    const me = await s.call('GET', '/v1/me', { token: STATIC_OWNER });
    assert.deepEqual([me.status, me.json.auth], [200, 'token']);
  });
  await test('senha ou usuário errados: mesma mensagem genérica (não revela qual errou)', async () => {
    const a = await s.login('mauro', 'senha-errada-12345');
    const b = await s.login('usuario-errado', PASSWORD);
    assert.equal(a.status, 401); assert.equal(b.status, 401);
    assert.equal(a.json.error, b.json.error);
    assert.match(a.json.error, /inválidos/);
    assert.ok(!JSON.stringify(a.json).includes(PASSWORD));
  });
  await test('corpo inválido, vazio ou campos gigantes não quebram nem entram', async () => {
    assert.equal((await s.call('POST', '/v1/auth/login', { body: {} })).status, 401);
    assert.equal((await s.login('mauro', 'x'.repeat(5000))).status, 401);
    const raw = await fetch(`http://127.0.0.1:${s.server.address().port}/v1/auth/login`, { method: 'POST', body: '{ruim' });
    assert.equal(raw.status, 400);
  });
  await test('após 5 falhas o login é BLOQUEADO (429 + Retry-After), até com a senha certa', async () => {
    s.limiter.reset();
    for (let i = 0; i < 5; i++) assert.equal((await s.login('mauro', `errada-${i}-0123456`)).status, 401);
    const locked = await s.login('mauro', PASSWORD);
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    assert.match(locked.json.error, /Muitas tentativas/);
  });
  await test('o bloqueio termina sozinho depois da janela e o login volta a funcionar', async () => {
    t += 16 * 60 * 1000;
    const r = await s.login('mauro', PASSWORD);
    assert.equal(r.status, 200);
    sessionToken = r.json.token;
  });
  await test('sessão expira sozinha (401)', async () => {
    t += 61_000;
    assert.equal((await s.call('GET', '/v1/me', { token: sessionToken })).status, 401);
  });
  await test('logout invalida a sessão na hora', async () => {
    const r = await s.login('mauro', PASSWORD);
    assert.equal((await s.call('GET', '/v1/me', { token: r.json.token })).status, 200);
    assert.equal((await s.call('POST', '/v1/auth/logout', { token: r.json.token })).json.revoked, true);
    assert.equal((await s.call('GET', '/v1/me', { token: r.json.token })).status, 401);
  });
  await test('um token inventado ou parecido com o de sessão não passa', async () => {
    assert.equal((await s.call('GET', '/v1/me', { token: 'a'.repeat(64) })).status, 401);
    assert.equal((await s.call('GET', '/v1/me')).status, 401);
  });
  s.close();
}
await test('sem login configurado: status false, login responde 503 e o token continua valendo', async () => {
  const s = await startServer({ panelEnv: {} });
  assert.equal((await s.call('GET', '/v1/auth/status')).json.passwordLogin, false);
  assert.equal((await s.login('mauro', PASSWORD)).status, 503);
  assert.equal((await s.call('GET', '/v1/me', { token: STATIC_OWNER })).status, 200);
  s.close();
});


console.log('Chave de uso único por DM no Discord');
await test('chave: formato legível, sem caracteres confusos, aceita minúsculas e traço', () => {
  const p = auth.createPairing();
  const { code } = p.issue();
  assert.match(code, /^[A-HJKMNP-Z2-9]{5}-[A-HJKMNP-Z2-9]{5}$/);
  assert.equal(p.verify(code.toLowerCase().replace('-', ' ')), true, 'minúsculas e espaço no lugar do traço');
});
await test('chave: uso único, expira, e erros repetidos a invalidam', () => {
  let t = 0;
  const p = auth.createPairing({ ttlMs: 60_000, now: () => t });
  let { code } = p.issue();
  assert.equal(p.verify(code), true);
  assert.equal(p.verify(code), false, 'segunda vez não vale');
  ({ code } = p.issue());
  t += 60_001;
  assert.equal(p.verify(code), false, 'expirou');
  ({ code } = p.issue());
  for (let i = 0; i < 5; i++) assert.equal(p.verify('AAAAA-AAAAA'), false);
  assert.equal(p.verify(code), false, 'depois de 5 erros a chave certa também foi invalidada');
  const a = p.issue().code; const b = p.issue().code;
  assert.equal(p.verify(a), false, 'pedir outra chave invalida a anterior');
  assert.equal(p.verify(b), true);
});
{
  const dms = [];
  let t = 9_000_000;
  const s = await startServer({ panelEnv: {}, clock: () => t, notify: async (userId, text) => { dms.push({ userId, text }); } });
  const codeOf = () => dms.at(-1).text.match(/`([A-Z0-9]{5}-[A-Z0-9]{5})`/)[1];

  await test('status informa que a chave por Discord está disponível (mesmo sem login por senha)', async () => {
    const st = (await s.call('GET', '/v1/auth/status')).json;
    assert.deepEqual([st.passwordLogin, st.discordKey], [false, true]);
  });
  await test('pedido: a chave vai por DM SÓ para o dono e NUNCA aparece na resposta da API', async () => {
    const r = await s.call('POST', '/v1/auth/discord/request');
    assert.equal(r.status, 200);
    assert.equal(dms.length, 1);
    assert.equal(dms[0].userId, OWNER, 'enviada ao dono, em mensagem privada');
    assert.match(dms[0].text, /5 minutos/);
    assert.match(dms[0].text, /uma vez/);
    assert.match(dms[0].text, /ignore esta mensagem/);
    const code = codeOf();
    assert.ok(!JSON.stringify(r.json).includes(code) && !JSON.stringify(r.json).includes(code.replace('-', '')), 'a resposta não contém a chave');
  });
  await test('verificar com a chave certa devolve uma sessão do DONO; a chave não serve duas vezes', async () => {
    const code = codeOf();
    const v = await s.call('POST', '/v1/auth/discord/verify', { body: { code: code.toLowerCase() } });
    assert.equal(v.status, 200);
    assert.equal(v.json.userId, OWNER);
    const me = await s.call('GET', '/v1/me', { token: v.json.token });
    assert.deepEqual([me.json.role, me.json.memoryScope, me.json.auth], ['OWNER', 'personal', 'session']);
    assert.equal((await s.call('GET', '/v1/admin/overview', { token: v.json.token })).status, 200, 'dono acessa o painel');
    assert.equal((await s.call('POST', '/v1/auth/discord/verify', { body: { code } })).status, 401, 'reuso negado');
  });
  await test('chave errada, vazia ou inventada: 401 com mensagem genérica', async () => {
    t += 16 * 60 * 1000; // o reuso negado do teste anterior já contou como 1 erro
    await s.call('POST', '/v1/auth/discord/request');
    for (const code of ['', 'ZZZZZ-ZZZZZ', '1234', 'a'.repeat(500), null]) {
      const r = await s.call('POST', '/v1/auth/discord/verify', { body: { code } });
      assert.equal(r.status, 401, `código ${JSON.stringify(code)}`);
      assert.match(r.json.error, /inválida ou expirada/);
    }
  });
  await test('depois de 5 erros o verificador BLOQUEIA (429), até com a chave certa; libera depois da janela', async () => {
    t += 16 * 60 * 1000; // limpa o bloqueio das tentativas anteriores
    await s.call('POST', '/v1/auth/discord/request');
    const certa = codeOf();
    for (let i = 0; i < 5; i++) assert.equal((await s.call('POST', '/v1/auth/discord/verify', { body: { code: `ERRADA-${i}0000` } })).status, 401);
    const locked = await s.call('POST', '/v1/auth/discord/verify', { body: { code: certa } });
    assert.equal(locked.status, 429);
    assert.ok(Number(locked.headers.get('retry-after')) > 0);
    t += 16 * 60 * 1000;
    await s.call('POST', '/v1/auth/discord/request');
    assert.equal((await s.call('POST', '/v1/auth/discord/verify', { body: { code: codeOf() } })).status, 200);
  });
  await test('pedidos de chave são limitados (3 a cada 10 min): ninguém consegue encher a sua DM', async () => {
    t += 20 * 60 * 1000;
    const before = dms.length;
    const statuses = [];
    for (let i = 0; i < 6; i++) statuses.push((await s.call('POST', '/v1/auth/discord/request')).status);
    assert.deepEqual(statuses, [200, 200, 200, 429, 429, 429]);
    assert.equal(dms.length - before, 3, 'só 3 mensagens foram enviadas');
    t += 11 * 60 * 1000;
    assert.equal((await s.call('POST', '/v1/auth/discord/request')).status, 200, 'libera depois da janela');
  });
  await test('chave expira em 5 minutos', async () => {
    t += 20 * 60 * 1000;
    await s.call('POST', '/v1/auth/discord/request');
    const code = codeOf();
    t += 5 * 60 * 1000 + 1000;
    assert.equal((await s.call('POST', '/v1/auth/discord/verify', { body: { code } })).status, 401);
  });
  await test('se o Discord falhar ao enviar a DM: 502 e a chave é descartada (ninguém fica com chave fantasma)', async () => {
    t += 20 * 60 * 1000;
    const failing = await startServer({ panelEnv: {}, clock: () => t, notify: async () => { throw new Error('Cannot send messages to this user'); } });
    const r = await failing.call('POST', '/v1/auth/discord/request');
    assert.equal(r.status, 502);
    assert.match(r.json.error, /DM/);
    assert.ok(!JSON.stringify(r.json).includes('Cannot send'), 'não vaza detalhe interno');
    failing.close();
  });
  s.close();
}
await test('sem como enviar DM (sem cliente do Discord): a chave fica indisponível (503) e o status avisa', async () => {
  const s = await startServer({ panelEnv: GOOD_ENV, notify: null });
  assert.equal((await s.call('GET', '/v1/auth/status')).json.discordKey, false);
  assert.equal((await s.call('POST', '/v1/auth/discord/request')).status, 503);
  assert.equal((await s.call('POST', '/v1/auth/discord/verify', { body: { code: 'AAAAA-AAAAA' } })).status, 503);
  s.close();
});

console.log('Painel de administração');
{
  const s = await startServer({ panelEnv: GOOD_ENV });
  const owner = (await s.login('mauro', PASSWORD)).json.token;
  const adm = (method, route, body) => s.call(method, `/v1/admin${route}`, { token: owner, body });

  await test('visão geral: Yui online, servidores, bloqueios e proteções', async () => {
    const r = await adm('GET', '/overview');
    assert.equal(r.status, 200);
    assert.equal(r.json.discord.online, true);
    assert.equal(r.json.discord.tag, 'Yui#0001');
    assert.equal(r.json.discord.guilds, 2);
    assert.equal(r.json.flags.readOnly, true);
    assert.ok(r.json.uptimeSeconds >= 0 && r.json.memoryMB > 0);
  });
  await test('servidores listados com AutoMod e TOS, em ordem alfabética', async () => {
    const r = await adm('GET', '/guilds');
    assert.deepEqual(r.json.guilds.map((g) => g.name), ['Servidor A', 'Servidor B']);
    assert.equal(r.json.guilds[0].automod, 'both');
    assert.equal(r.json.guilds[0].tosAccepted, false);
    assert.equal(r.json.guilds[1].tosAccepted, true);
  });
  await test('AutoMod: altera o modo; rejeita modo inválido e servidor desconhecido', async () => {
    assert.equal((await adm('POST', '/guilds/444444444444444444/automod', { mode: 'trigger' })).json.automod, 'trigger');
    assert.equal(s.bot.modes['444444444444444444'], 'trigger');
    assert.equal((await adm('POST', '/guilds/444444444444444444/automod', { mode: 'destruir' })).status, 400);
    assert.equal((await adm('POST', '/guilds/999999999999999999/automod', { mode: 'off' })).status, 404);
    assert.equal((await adm('POST', '/guilds/abc/automod', { mode: 'off' })).status, 404);
  });
  await test('banimentos: adicionar, listar e remover (usuário, servidor e canal)', async () => {
    assert.equal((await adm('POST', '/bans', { type: 'user', id: MEMBER, reason: 'spam' })).status, 200);
    assert.equal((await adm('POST', '/bans', { type: 'guild', id: '777777777777777777' })).status, 200);
    assert.equal((await adm('POST', '/bans', { type: 'channel', id: '888888888888888888', reason: 'x'.repeat(500) })).status, 200);
    const list = (await adm('GET', '/bans')).json;
    assert.equal(list.users[0].id, MEMBER);
    assert.equal(list.users[0].reason, 'spam');
    assert.equal(list.guilds[0].reason, 'Banido pelo painel.', 'motivo padrão');
    assert.equal(list.channels[0].reason.length, 200, 'motivo limitado a 200 caracteres');
    assert.equal((await adm('DELETE', `/bans/user/${MEMBER}`)).status, 200);
    assert.equal((await adm('GET', '/bans')).json.users.length, 0);
  });
  await test('banimentos: valida tipo e ID, e NUNCA permite banir o dono', async () => {
    assert.equal((await adm('POST', '/bans', { type: 'alien', id: MEMBER })).status, 400);
    assert.equal((await adm('POST', '/bans', { type: 'user', id: 'abc' })).status, 400);
    assert.equal((await adm('POST', '/bans', { type: 'user', id: '123' })).status, 400);
    const r = await adm('POST', '/bans', { type: 'user', id: OWNER });
    assert.equal(r.status, 400);
    assert.match(r.json.error, /dono/);
    assert.equal(s.bot.bans.users[OWNER], undefined);
  });
  await test('memória: lista usuários, mostra SÓ metadados e apaga (uma lembrança ou tudo)', async () => {
    const u = buildContext({ platform: 'discord', userId: '666666666666666666', guildId: 'g', channelId: 'c' });
    memory.remember(u, { content: 'CONTEUDO-SECRETO-DO-USUARIO', type: 'preference' });
    memory.remember(u, { content: 'outra lembrança' });
    const users = (await adm('GET', '/memory/users')).json;
    const row = users.users.find((x) => x.userId === '666666666666666666');
    assert.equal(row.count, 2);
    const meta = await adm('GET', '/memory/users/666666666666666666');
    assert.equal(meta.json.memories.length, 2);
    assert.ok(!JSON.stringify(users).includes('CONTEUDO-SECRETO') && !JSON.stringify(meta.json).includes('CONTEUDO-SECRETO'), 'conteúdo nunca é exposto');
    const id = meta.json.memories[0].id;
    assert.equal((await adm('DELETE', `/memory/users/666666666666666666/${id}`)).json.ok, true);
    assert.equal((await adm('GET', '/memory/users/666666666666666666')).json.memories.length, 1);
    assert.equal((await adm('DELETE', '/memory/users/666666666666666666')).json.removed, 1);
  });
  await test('auditoria: mostra os eventos recentes (inclui o que o painel fez), só metadados', async () => {
    const r = await adm('GET', '/audit?limit=50');
    const events = r.json.events.map((e) => e.event);
    for (const wanted of ['admin.automod', 'admin.ban.add', 'admin.ban.remove', 'memory.admin.forgetUser']) assert.ok(events.includes(wanted), `falta ${wanted}`);
    assert.ok(!JSON.stringify(r.json).includes('CONTEUDO-SECRETO'));
    assert.ok((await adm('GET', '/audit?limit=2')).json.events.length <= 2);
  });
  await test('ferramentas: lista com acesso e se estão liberadas; o painel não altera o somente leitura', async () => {
    tools.clearTools();
    tools.registerTool({ name: 'ler.algo', description: 'Lê.', access: 'read', async run() { return 'x'; } });
    tools.registerTool({ name: 'fs.apagar', description: 'Apaga.', access: 'write', async run() { return 'x'; } });
    const r = await adm('GET', '/tools');
    assert.equal(r.json.readOnly, true);
    const by = Object.fromEntries(r.json.tools.map((t) => [t.name, t]));
    assert.equal(by['ler.algo'].allowed, true);
    assert.equal(by['fs.apagar'].allowed, false);
    assert.match(by['fs.apagar'].reason, /somente leitura/);
    for (const route of ['/readonly', '/read-only', '/config', '/env', '/password', '/credentials', '/shell', '/exec']) {
      assert.equal((await adm('POST', route, { value: false })).status, 404, `${route} não pode existir`);
    }
    assert.equal(process.env.YUI_READ_ONLY, 'true');
  });
  await test('gateway de IA: o dono vê a saúde dos provedores (sem chaves) e pode zerar os descansos', async () => {
    const st = await adm('GET', '/gateway');
    assert.equal(st.status, 200);
    assert.ok(Array.isArray(st.json.providers));
    assert.deepEqual(Object.keys(st.json.totals).sort(), ['failed', 'ok', 'requests']);
    for (const p of st.json.providers) {
      assert.equal(typeof p.keys, 'number', 'só a QUANTIDADE de chaves, nunca as chaves');
      assert.ok(!('apiKeys' in p) && !('endpoint' in p));
    }
    assert.equal((await adm('POST', '/gateway/reset', {})).json.ok, true);
    const events = (await adm('GET', '/audit?limit=20')).json.events.map((e) => e.event);
    assert.ok(events.includes('admin.gateway.reset'));
  });
  await test('integrações: o dono vê o estado de cada integração, SEM nenhum valor de chave', async () => {
    const SEGREDO = 'segredo-que-nunca-pode-aparecer-123456';
    process.env.GROQ_API_KEY = SEGREDO;
    process.env.YOUTUBE_API_KEY = SEGREDO;
    process.env.TWITCH_CLIENT_ID = '';
    const r = await adm('GET', '/integrations');
    delete process.env.GROQ_API_KEY; delete process.env.YOUTUBE_API_KEY;
    assert.equal(r.status, 200);
    const all = Object.fromEntries(r.json.groups.flatMap((g) => g.items).map((i) => [i.key, i]));
    for (const key of ['discord', 'memory', 'readonly', 'gemini', 'groq', 'gateway', 'youtube', 'twitch', 'gta-weekly', 'newswire', 'stt', 'tts', 'deezer', 'brave', 'stability']) {
      assert.ok(all[key], `falta a integração ${key}`);
      assert.ok(['ok', 'off', 'missing'].includes(all[key].status));
    }
    assert.equal(all.groq.status, 'ok');
    assert.equal(all.groq.detail, '1 chave');
    assert.equal(all.youtube.status, 'ok');
    assert.equal(all.twitch.status, 'missing');
    assert.equal(all.discord.status, 'ok');
    assert.equal(all.readonly.status, 'ok');
    assert.equal(all.youtube.detail.includes('7 inscrições'), true, 'usa os dados dos bancos');
    assert.ok(!JSON.stringify(r.json).includes(SEGREDO), 'a chave nunca sai do servidor');
  });
  await test('detalhe do servidor: canais, avisos sociais e ferramentas; servidor desconhecido dá 404', async () => {
    const r = await adm('GET', '/guilds/444444444444444444');
    assert.equal(r.status, 200);
    assert.equal(r.json.name, 'Servidor B');
    assert.equal(r.json.channels.noticias.name, 'noticias');
    assert.equal(r.json.youtube[0].name, 'Canal X');
    assert.deepEqual(r.json.tools.enabled, ['join_voice_call']);
    assert.equal((await adm('GET', '/guilds/123456789012345678')).status, 404);
    assert.equal((await adm('GET', '/guilds/abc')).status, 404);
  });
  await test('canais do servidor: o dono define e limpa; só canal de TEXTO do próprio servidor', async () => {
    const G = '/guilds/444444444444444444';
    assert.equal((await adm('PUT', `${G}/channels`, { type: 'noticias', channelId: '777777777777777777' })).status, 200);
    assert.deepEqual(s.bot.calls.at(-1), ['setGuildChannel', '444444444444444444', 'news_channel_id', '777777777777777777']);
    assert.equal((await adm('PUT', `${G}/channels`, { type: 'noticias', channelId: null })).status, 200);
    assert.deepEqual(s.bot.calls.at(-1), ['setGuildChannel', '444444444444444444', 'news_channel_id', null]);
    assert.equal((await adm('PUT', `${G}/channels`, { type: 'noticias', channelId: '888888888888888888' })).status, 400, 'canal de voz não vale');
    assert.equal((await adm('PUT', `${G}/channels`, { type: 'noticias', channelId: '999999999999999990' })).status, 400, 'canal de outro servidor');
    assert.equal((await adm('PUT', `${G}/channels`, { type: 'veiculos', channelId: '777777777777777777' })).status, 400);
    assert.equal((await adm('PUT', '/guilds/123456789012345678/channels', { type: 'diario', channelId: '777777777777777777' })).status, 404);
    const events = (await adm('GET', '/audit?limit=50')).json.events.map((e) => e.event);
    assert.ok(events.includes('admin.guild.channel'));
  });
  await test('seguidos: adicionar e remover YouTube e Twitch, com validação', async () => {
    const G = '/guilds/444444444444444444';
    const y = await adm('POST', `${G}/youtube`, { channel: '@CanalX', discordChannelId: '777777777777777777', roleId: '555555555555555551', shorts: false });
    assert.equal(y.status, 200);
    assert.equal(y.json.added, true);
    const call = s.bot.calls.at(-1);
    assert.equal(call[0], 'addYoutube');
    assert.equal(call[1].input, '@CanalX');
    assert.equal(call[1].roleId, '555555555555555551');
    assert.equal(call[1].shorts, false);
    assert.equal(call[1].videos, true);
    assert.equal((await adm('POST', `${G}/youtube`, { channel: '', discordChannelId: '777777777777777777' })).status, 400);
    assert.equal((await adm('POST', `${G}/youtube`, { channel: '@x', discordChannelId: '888888888888888888' })).status, 400);
    assert.equal((await adm('DELETE', `${G}/youtube/UCabc123456/777777777777777777`)).status, 200);
    assert.deepEqual(s.bot.calls.at(-1), ['removeYoutube', '444444444444444444', 'UCabc123456', '777777777777777777']);

    const t = await adm('POST', `${G}/twitch`, { streamer: 'https://twitch.tv/Alanzoka', discordChannelId: '777777777777777777' });
    assert.equal(t.status, 200);
    assert.equal(s.bot.calls.at(-1)[1].login, 'alanzoka', 'aceita URL e normaliza o login');
    assert.equal((await adm('POST', `${G}/twitch`, { streamer: 'a b', discordChannelId: '777777777777777777' })).status, 400);
    assert.equal((await adm('DELETE', `${G}/twitch/alanzoka/777777777777777777`)).status, 200);
    assert.deepEqual(s.bot.calls.at(-1), ['removeTwitch', '444444444444444444', 'alanzoka', '777777777777777777']);
    const events = (await adm('GET', '/audit?limit=50')).json.events.map((e) => e.event);
    for (const e of ['admin.follow.youtube.add', 'admin.follow.youtube.remove', 'admin.follow.twitch.add', 'admin.follow.twitch.remove']) assert.ok(events.includes(e), e);
  });
  await test('IA: chaves entram pelo painel, valem na hora e NUNCA voltam inteiras', async () => {
    const SECRET = 'gsk_painel_chave_secreta_ABCD1234wxyz';
    const before = process.env.GROQ_API_KEY;
    assert.equal((await adm('POST', '/ai/keys', { provider: 'groq', key: SECRET })).status, 200);
    assert.ok(process.env.GROQ_API_KEY.includes(SECRET), 'aplicada ao ambiente na hora');
    const { loadProviders } = await import('../src/gateway/providers.js');
    assert.ok(loadProviders(process.env).providers.find((p) => p.id === 'groq').keys.includes(SECRET), 'o Gateway enxerga a chave');

    const view = await adm('GET', '/ai');
    assert.equal(view.status, 200);
    assert.equal(view.json.editable, true);
    const groq = view.json.providers.find((p) => p.id === 'groq');
    assert.equal(groq.panelKeys.length, 1);
    assert.equal(groq.panelKeys[0].hint, '…wxyz');
    assert.ok(!JSON.stringify(view.json).includes(SECRET), 'a chave nunca sai do servidor');
    const audit = (await adm('GET', '/audit?limit=50')).json.events;
    assert.ok(audit.some((e) => e.event === 'admin.ai.key.add'));
    assert.ok(!JSON.stringify(audit).includes(SECRET), 'a auditoria também não guarda a chave');
    assert.ok(!fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').includes(SECRET));

    assert.equal((await adm('POST', '/ai/keys', { provider: 'groq', key: SECRET })).status, 409, 'duplicada');
    for (const bad of ['curta', 'com espaco dentro 1234567890', 'a,b,c,d,e,f,g,h,i,j,k', 'x'.repeat(600)]) {
      assert.equal((await adm('POST', '/ai/keys', { provider: 'groq', key: bad })).status, 400, `chave inválida: ${bad.slice(0, 10)}`);
    }
    assert.equal((await adm('POST', '/ai/keys', { provider: 'inexistente', key: SECRET })).status, 404);

    assert.equal((await adm('DELETE', '/ai/keys/groq/0')).status, 200);
    assert.equal(process.env.GROQ_API_KEY, before, 'removida: o ambiente volta ao que o .env tinha');
    assert.equal((await adm('DELETE', '/ai/keys/groq/0')).status, 404);
  });
  await test('IA: provedor próprio (OmniRoute) com validação de endereço, chave e remoção', async () => {
    const KEY = 'sk-omniroute-teste-1234567890';
    const body = { id: 'omniroute', label: 'OmniRoute', baseUrl: 'http://127.0.0.1:20128/v1', models: ['free-stack'], key: KEY };
    assert.equal((await adm('POST', '/ai/custom', body)).status, 200);
    const { loadProviders } = await import('../src/gateway/providers.js');
    const p = loadProviders(process.env).providers.find((x) => x.id === 'omniroute');
    assert.ok(p, 'entra no Gateway');
    assert.equal(p.endpoint, 'http://127.0.0.1:20128/v1/chat/completions');
    assert.deepEqual(p.keys, [KEY]);
    assert.equal(p.models[0].id, 'free-stack');
    const view = (await adm('GET', '/ai')).json;
    assert.equal(view.custom.find((c) => c.id === 'omniroute').keys[0].hint, '…7890');
    assert.ok(!JSON.stringify(view).includes(KEY));
    assert.ok(view.templates.some((t) => t.id === 'omniroute'));

    assert.equal((await adm('POST', '/ai/custom', body)).status, 409, 'ID repetido');
    assert.equal((await adm('POST', '/ai/custom', { ...body, id: 'groq' })).status, 400, 'ID reservado');
    assert.equal((await adm('POST', '/ai/custom', { ...body, id: 'externo', baseUrl: 'http://exemplo.com/v1' })).status, 400, 'http fora da rede');
    assert.equal((await adm('POST', '/ai/custom', { ...body, id: 'esquisito', baseUrl: 'ftp://x.com' })).status, 400);
    assert.equal((await adm('POST', '/ai/custom', { ...body, id: 'comuser', baseUrl: 'https://u:p@x.com/v1' })).status, 400);
    assert.equal((await adm('POST', '/ai/custom', { ...body, id: 'semmodelo', models: [] })).status, 400);
    assert.equal((await adm('POST', '/ai/custom', { ...body, id: 'nuvem', baseUrl: 'https://api.exemplo.com/v1', key: '' })).status, 400, 'nuvem exige chave');
    assert.equal((await adm('POST', '/ai/custom', { ...body, id: 'nuvem', baseUrl: 'https://api.exemplo.com/v1' })).status, 200, 'https com chave');

    assert.equal((await adm('POST', '/ai/providers/omniroute', { enabled: false })).status, 200);
    assert.ok(!loadProviders(process.env).providers.some((x) => x.id === 'omniroute'), 'desligado sai do Gateway');
    assert.equal((await adm('POST', '/ai/providers/omniroute', { enabled: 'sim' })).status, 400);
    assert.equal((await adm('POST', '/ai/providers/omniroute', { enabled: true })).status, 200);
    assert.ok(loadProviders(process.env).providers.some((x) => x.id === 'omniroute'));

    assert.equal((await adm('POST', '/ai/custom/omniroute/keys', { key: 'sk-segunda-chave-1234567890' })).status, 200);

    // ordem na fila: "logo após o LM Studio" = antes de Groq (10) e Gemini (20)
    assert.equal((await adm('POST', '/ai/keys', { provider: 'groq', key: 'gsk_para_testar_ordem_1234567' })).status, 200);
    let order = loadProviders(process.env).providers.map((x) => x.id);
    assert.ok(order.indexOf('groq') < order.indexOf('omniroute'), 'por padrão vem depois do Groq');
    assert.equal((await adm('POST', '/ai/custom/omniroute/options', { first: true })).json.first, true);
    order = loadProviders(process.env).providers.map((x) => x.id);
    assert.equal(order[0], 'omniroute', 'primeiro da fila, logo após o LM Studio');
    assert.equal((await adm('GET', '/ai')).json.custom.find((c) => c.id === 'omniroute').first, true);
    assert.equal((await adm('POST', '/ai/custom/omniroute/options', { first: false })).json.first, false);
    assert.ok(loadProviders(process.env).providers.map((x) => x.id).indexOf('groq') < loadProviders(process.env).providers.map((x) => x.id).indexOf('omniroute'));
    assert.equal((await adm('POST', '/ai/custom/omniroute/options', { first: 'sim' })).status, 400);
    assert.deepEqual((await adm('POST', '/ai/custom/omniroute/options', { models: 'auto/best-fast, free-stack' })).json.models, ['auto/best-fast', 'free-stack']);
    assert.equal(loadProviders(process.env).providers.find((x) => x.id === 'omniroute').models[0].id, 'auto/best-fast');
    assert.equal((await adm('POST', '/ai/custom/omniroute/options', { models: '' })).status, 400);
    assert.equal((await adm('POST', '/ai/custom/omniroute/options', { models: 'a b' })).status, 400);
    assert.equal((await adm('POST', '/ai/custom/inexistente/options', { first: true })).status, 404);

    // conversas pessoais: provedor "sem conversas pessoais" (anonymous) nunca as recebe
    assert.equal((await adm('POST', '/ai/custom/omniroute/options', { anonymous: true })).json.anonymous, true);
    assert.equal(loadProviders(process.env).providers.find((x) => x.id === 'omniroute').anonymous, true);
    assert.equal((await adm('POST', '/ai/custom/omniroute/options', { anonymous: false })).json.anonymous, false);
    assert.equal(loadProviders(process.env).providers.find((x) => x.id === 'omniroute').anonymous, false);
    assert.equal((await adm('DELETE', '/ai/keys/groq/0')).status, 200);
    assert.equal((await adm('POST', '/ai/cloudflare', { accountId: '0123456789abcdef0123456789abcdef' })).status, 404, 'rota é PUT');
    assert.equal((await adm('PUT', '/ai/cloudflare', { accountId: 'curto' })).status, 400);
    assert.equal((await adm('PUT', '/ai/cloudflare', { accountId: '0123456789abcdef0123456789abcdef' })).status, 200);

    const t = await adm('POST', '/ai/test/omniroute');
    assert.equal(t.status, 200);
    assert.equal(t.json.ok, true);
    assert.equal(s.bot.calls.at(-1)[0], 'aiChat');

    assert.equal((await adm('DELETE', '/ai/custom/omniroute')).status, 200);
    assert.equal((await adm('DELETE', '/ai/custom/nuvem')).status, 200);
    assert.ok(!loadProviders(process.env).providers.some((x) => x.id === 'omniroute'));
    assert.equal((await adm('DELETE', '/ai/custom/omniroute')).status, 404);
    assert.equal((await adm('PUT', '/ai/cloudflare', { accountId: '' })).status, 200);
  });
  await test('IA: YUI_PANEL_AI_EDIT=false trava toda edição (a leitura continua)', async () => {
    process.env.YUI_PANEL_AI_EDIT = 'false';
    try {
      assert.equal((await adm('GET', '/ai')).json.editable, false);
      assert.equal((await adm('POST', '/ai/keys', { provider: 'groq', key: 'gsk_nao_deve_entrar_123456' })).status, 403);
      assert.equal((await adm('POST', '/ai/custom', { id: 'x', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] })).status, 403);
      assert.equal((await adm('POST', '/ai/providers/groq', { enabled: false })).status, 403);
    } finally {
      delete process.env.YUI_PANEL_AI_EDIT;
    }
  });
  await test('rádio: o dono vê as sessões e controla (pausar, retomar, parar, sair); ação inválida e servidor sem sessão são recusados', async () => {
    const r = await adm('GET', '/radio');
    assert.equal(r.status, 200);
    assert.equal(r.json.sessions.length, 1);
    const sess = r.json.sessions[0];
    assert.equal(sess.guildName, 'Servidor B');
    assert.equal(sess.voiceChannel, 'Sala de música');
    assert.equal(sess.status, 'PLAYING');
    assert.equal(sess.current.title, 'Música A');
    assert.equal(sess.next.title, 'Música B');
    assert.equal(sess.position, '1/2');
    assert.equal(sess.queueLength, 1);

    const G = '/radio/444444444444444444';
    for (const action of ['pause', 'resume', 'stop', 'leave']) {
      assert.equal((await adm('POST', G, { action })).status, 200, action);
      assert.equal(s.bot.calls.at(-1)[0], `radio:${action}`);
    }
    assert.equal((await adm('POST', G, { action: 'explodir' })).status, 400);
    assert.equal((await adm('POST', '/radio/333333333333333333', { action: 'pause' })).status, 404, 'sem sessão');
    s.bot.radioPauseFails = true;
    assert.equal((await adm('POST', G, { action: 'pause' })).status, 409, 'nada tocando');
    s.bot.radioPauseFails = false;
    const events = (await adm('GET', '/audit?limit=50')).json.events.map((e) => e.event);
    assert.ok(events.includes('admin.radio'));
  });
  await test('logs: últimas linhas, mais recentes primeiro, com filtros e SEM vazar segredos', async () => {
    const SECRET = 'segredo-super-secreto-xyz-12345';
    process.env.TEST_PANEL_API_TOKEN = SECRET;
    try {
      const all = await adm('GET', '/logs');
      assert.equal(all.status, 200);
      assert.equal(all.json.file, 'app-2026-10-08.log');
      assert.equal(all.json.entries[0].text.startsWith('Última linha'), true, 'mais recente primeiro');
      assert.ok(all.json.files.some((f) => f.name === 'error-2026-10-08.log'));
      const blob = JSON.stringify(all.json);
      assert.ok(!blob.includes(SECRET), 'valor de variável sensível mascarado');
      assert.ok(!blob.includes('AIzaSyDUMMYDUMMYDUMMYDUMMYDUMMY12'), 'formato de chave do Google mascarado');
      assert.ok(!blob.includes('gsk_abcdefghijklmnop1234'), 'formato de chave do Groq mascarado');
      assert.ok(blob.includes('••••'));
      assert.ok(!blob.includes('\u001b'), 'sem códigos de cor');

      const stack = all.json.entries.find((e) => e.text.startsWith('Falha ao baixar'));
      assert.match(stack.text, /at fetch \(node:internal\)/, 'stack trace fica junto da entrada');

      const errors = await adm('GET', '/logs?level=error');
      assert.deepEqual([...new Set(errors.json.entries.map((e) => e.level))], ['error']);
      const search = await adm('GET', '/logs?q=youtube');
      assert.ok(search.json.entries.length >= 1 && search.json.entries.every((e) => e.text.toLowerCase().includes('youtube')));
      const err = await adm('GET', '/logs?kind=error');
      assert.equal(err.json.file, 'error-2026-10-08.log');
      assert.equal((await adm('GET', '/logs?limit=10')).json.entries.length <= 10, true);
      const old = await adm('GET', '/logs?date=2026-10-07');
      assert.equal(old.json.file, 'app-2026-10-07.log');
      assert.equal((await adm('GET', '/logs?date=2020-01-01')).json.file, null);
    } finally {
      delete process.env.TEST_PANEL_API_TOKEN;
    }
    for (const bad of ['kind=senha', 'level=banana', 'date=../../.env', 'date=2026-10-08/../x', 'kind=../audit']) {
      assert.equal((await adm('GET', `/logs?${bad}`)).status, 400, bad);
    }
  });
  await test('reiniciar exige confirmação explícita e agenda a saída do processo', async () => {
    assert.equal((await adm('POST', '/restart', {})).status, 400);
    assert.equal((await adm('POST', '/restart', { confirm: 'sim' })).status, 400, 'só confirm=true (booleano)');
    assert.equal(s.exits.length, 0);
    const r = await adm('POST', '/restart', { confirm: true });
    assert.equal(r.status, 200);
    assert.equal(s.exits.length, 0, 'responde antes de sair');
    await new Promise((res) => setTimeout(res, 1000));
    assert.equal(s.exits.length, 1);
  });
  await test('rota de admin inexistente devolve 404', async () => {
    assert.equal((await adm('GET', '/nada')).status, 404);
  });
  s.close();
}

console.log('Mensagem ao Discord do dono, pedida pelo painel');
{
  const dms = [];
  const s = await startServer({ panelEnv: GOOD_ENV, notify: async (userId, text) => { dms.push({ userId, text }); } });
  const send = (message, token = STATIC_OWNER) => s.call('POST', '/v1/admin/discord/dm', { token, body: message === undefined ? {} : { message } });
  await test('o dono pede e a Yui manda DM só para ele; sem texto usa uma mensagem de teste', async () => {
    assert.equal((await send('Oi, estou testando')).status, 200);
    assert.equal(dms.at(-1).userId, OWNER);
    assert.match(dms.at(-1).text, /Mensagem do painel da Yui/);
    assert.match(dms.at(-1).text, /Oi, estou testando/);
    assert.equal((await send(undefined)).status, 200);
    assert.match(dms.at(-1).text, /Teste/);
    assert.equal((await send('x'.repeat(5000))).status, 200);
    assert.ok(dms.at(-1).text.length < 1700, 'mensagem longa é cortada');
  });
  await test('limite de 5 mensagens por 10 minutos e auditoria sem o texto', async () => {
    assert.equal((await send('quarta')).status, 200);
    assert.equal((await send('quinta')).status, 200);
    assert.equal((await send('sexta')).status, 429);
    const events = (await s.call('GET', '/v1/admin/audit?limit=50', { token: STATIC_OWNER })).json.events;
    assert.ok(events.some((e) => e.event === 'admin.discord.dm'));
    assert.ok(!JSON.stringify(events).includes('Oi, estou testando'));
  });
  await test('membro não pode (403)', async () => {
    assert.equal((await send('oi', STATIC_MEMBER)).status, 403);
  });
  s.close();
  const failing = await startServer({ panelEnv: GOOD_ENV, notify: async () => { throw new Error('Cannot send messages to this user'); } });
  await test('DM bloqueada no Discord: 502 com mensagem amigável', async () => {
    const r = await failing.call('POST', '/v1/admin/discord/dm', { token: STATIC_OWNER, body: { message: 'oi' } });
    assert.equal(r.status, 502);
    assert.match(r.json.error, /DM/);
  });
  failing.close();
  const off = await startServer({ panelEnv: GOOD_ENV, notify: null });
  await test('sem Discord conectado: 503', async () => {
    assert.equal((await off.call('POST', '/v1/admin/discord/dm', { token: STATIC_OWNER, body: {} })).status, 503);
  });
  off.close();
}

console.log('Quem NÃO é o dono');
{
  const s = await startServer({ panelEnv: { ...GOOD_ENV, YUI_PANEL_USER_ID: MEMBER } });
  await test('membro (token estático) recebe 403 em TODAS as rotas de administração', async () => {
    const routes = [
      ['GET', '/overview'], ['GET', '/guilds'], ['GET', '/bans'], ['GET', '/memory/users'], ['GET', '/memory/users/666666666666666666'],
      ['GET', '/audit'], ['GET', '/tools'], ['POST', '/guilds/444444444444444444/automod', { mode: 'off' }],
      ['POST', '/bans', { type: 'user', id: '999999999999999999' }], ['DELETE', '/bans/user/999999999999999999'],
      ['DELETE', '/memory/users/666666666666666666'], ['DELETE', '/memory/users/666666666666666666/1'], ['POST', '/restart', { confirm: true }],
      ['GET', '/gateway'], ['POST', '/gateway/reset', {}], ['GET', '/integrations'], ['GET', '/guilds/444444444444444444'],
      ['PUT', '/guilds/444444444444444444/channels', { type: 'noticias', channelId: '777777777777777777' }],
      ['POST', '/guilds/444444444444444444/youtube', { channel: '@x', discordChannelId: '777777777777777777' }],
      ['DELETE', '/guilds/444444444444444444/youtube/UCabc123456/777777777777777777'],
      ['POST', '/guilds/444444444444444444/twitch', { streamer: 'alanzoka', discordChannelId: '777777777777777777' }],
      ['DELETE', '/guilds/444444444444444444/twitch/alanzoka/777777777777777777'],
      ['GET', '/radio'], ['POST', '/radio/444444444444444444', { action: 'pause' }], ['GET', '/logs'], ['GET', '/ai'], ['POST', '/ai/keys', { provider: 'groq', key: 'gsk_membro_nao_pode_123456' }], ['DELETE', '/ai/keys/groq/0'],
      ['PUT', '/ai/cloudflare', { accountId: '' }], ['POST', '/ai/providers/groq', { enabled: false }],
      ['POST', '/ai/custom', { id: 'x', baseUrl: 'http://127.0.0.1:1/v1', models: ['m'] }], ['DELETE', '/ai/custom/x'], ['POST', '/ai/test/groq'],
    ];
    for (const [m, r, b] of routes) {
      const res = await s.call(m, `/v1/admin${r}`, { token: STATIC_MEMBER, body: b });
      assert.equal(res.status, 403, `${m} ${r} deveria ser 403 (veio ${res.status})`);
    }
    assert.equal(s.exits.length, 0);
    assert.deepEqual(s.bot.bans, { users: {}, guilds: {}, channels: {} });
  });
  await test('login cujo usuário NÃO é o dono vira membro: entra, mas sem acesso ao painel', async () => {
    const r = await s.login('mauro', PASSWORD);
    assert.equal(r.status, 200);
    assert.equal((await s.call('GET', '/v1/me', { token: r.json.token })).json.role, 'MEMBER');
    assert.equal((await s.call('GET', '/v1/admin/overview', { token: r.json.token })).status, 403);
  });
  await test('sem autenticação, nenhuma rota de admin responde (401)', async () => {
    assert.equal((await s.call('GET', '/v1/admin/overview')).status, 401);
    assert.equal((await s.call('POST', '/v1/admin/restart', { body: { confirm: true } })).status, 401);
    assert.equal(s.exits.length, 0);
  });
  s.close();
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
