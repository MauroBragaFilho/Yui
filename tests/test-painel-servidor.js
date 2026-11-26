// Painel: configurações POR SERVIDOR (rotas /v1/admin/guilds/:id/{mcp-tools,tos,channels,mentions} e /v1/admin/tos).
// Só o dono, validação por lista fechada, confirm, gravação nas MESMAS estruturas dos comandos (/yui-ferramentas, /yui-servidor, aceite dos Termos),
// a ponte com o cérebro separado e a auditoria sem conteúdo. SEM rede e SEM os arquivos reais (pasta temporária; Discord de mentira).
// Execução: node tests/test-painel-servidor.js
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-painel-servidor-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const arq = (n) => path.join(tmp, n);
Object.assign(process.env, {
  DATABASE_DIR: arq('db'), YUI_AUDIT_FILE: arq('audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false', LOG_LEVEL: 'error',
  YUI_POLICY_MODE: 'observe', REQUIRE_TOS: 'true',
  YUI_SERVER_TOOLS_FILE: arq('server_tools.json'), YUI_CHANNEL_SETTINGS_FILE: arq('channel_settings.json'),
  YUI_SERVER_SETTINGS_FILE: arq('server_settings.json'), YUI_ACCEPTED_SERVERS_FILE: arq('accepted_servers.json'),
});
delete process.env.OWNER_ID;
delete process.env.OWNER_IDS;
fs.mkdirSync(arq('db'), { recursive: true });

const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { createAdmin } = await import('../src/core/api/admin.js');
const { createCerebroAdmin, PANEL_ACTIONS } = await import('../src/cerebro/painel.js');
const { registerBotActions, BOT_PANEL_ACTIONS } = await import('../src/discord/canalCerebro.js');
const { carregarServidorDoBot } = await import('../src/discord/painelServidor.js');
const { actionForRoute } = await import('../src/core/security/routeGuard.js');
const llm = await import('../src/handlers/llmHandler.js');
const tos = await import('../src/handlers/tosHandler.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try { await fn(); passed += 1; console.log(`  ok   ${name}`); } catch (err) { failures.push(name); console.log(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 6).join('\n        ')}`); }
};
const ler = (n) => JSON.parse(fs.readFileSync(arq(n), 'utf8'));

// ── Discord de mentira ──
const GUILD = '444444444444444444';
const CANAL = '777777777777777777';
const VOZ = '888888888888888888';
const DE_FORA = '999999999999999999';
const enviados = [];
const eu = { id: '1010101010101010' };
const canalTexto = { id: CANAL, name: 'geral', type: 0, isTextBased: () => true, permissionsFor: () => ({ has: () => true }), send: async (m) => { enviados.push(m); } };
const guild = {
  id: GUILD, name: 'Servidor B', ownerId: MEMBER, memberCount: 3, client: { user: eu }, systemChannel: null,
  channels: { cache: new Map([[CANAL, canalTexto], [VOZ, { id: VOZ, name: 'voz', type: 2, isTextBased: () => false }]]) },
};
const client = { isReady: () => true, user: eu, guilds: { cache: new Map([[GUILD, guild]]) } };

const TOKEN_DONO = 'static-owner-token-0123456789';
const TOKEN_MEMBRO = 'static-member-token-0123456789';
async function subir(admin) {
  const server = createApiServer({ tokens: parseTokens(`${TOKEN_DONO}=${OWNER},${TOKEN_MEMBRO}=${MEMBER}`), panel: { enabled: false, reasons: [], warnings: [] }, admin });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const call = async (method, route, body, token = TOKEN_DONO) => {
    const res = await fetch(`${base}/v1/admin${route}`, { method, headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined });
    return { status: res.status, json: await res.json().catch(() => null) };
  };
  return { call, close: () => server.close() };
}

const G = `/guilds/${GUILD}`;
const C = `${G}/channels/${CANAL}`;
const SEGREDO_PERSONA = 'fale como um pirata chamado Barbanegra';
const ROTAS = [
  ['GET', '/tos'], ['GET', `${G}/mcp-tools`], ['PUT', `${G}/mcp-tools/search_web`, { ligada: false, confirm: true }], ['POST', `${G}/mcp-tools/reset`, { confirm: true }],
  ['GET', `${G}/tos`], ['POST', `${G}/tos`, { confirm: true, emNomeDeTerceiros: true }], ['DELETE', `${G}/tos`, { confirm: true }], ['GET', C],
  ['PUT', `${C}/persona`, { humor: 'x', confirm: true }], ['DELETE', `${C}/persona`, { confirm: true }], ['PUT', `${C}/espontaneo`, { ativo: true, confirm: true }],
  ['PUT', `${G}/mentions`, { respondToEveryone: true, confirm: true }],
];

const s = await subir(createAdmin({ client, servidor: carregarServidorDoBot }));

await test('só o dono: membro recebe 403 em todas as rotas e nada é gravado', async () => {
  for (const [m, r, b] of ROTAS) assert.equal((await s.call(m, r, b, TOKEN_MEMBRO)).status, 403, `${m} ${r}`);
  for (const n of ['server_tools.json', 'channel_settings.json', 'server_settings.json', 'accepted_servers.json']) assert.ok(!fs.existsSync(arq(n)), n);
});

await test('toda rota que muda estado está no guarda de rotas e exige confirm: true', async () => {
  for (const [m, r, b] of ROTAS.filter(([m]) => m !== 'GET')) {
    assert.equal(actionForRoute(m, `/v1/admin${r}`), 'admin.guild_configure', `${m} ${r}`);
    const { confirm, ...sem } = b;
    assert.equal((await s.call(m, r, sem)).status, 400, `${m} ${r} sem confirm`);
    assert.equal((await s.call(m, r, { ...sem, confirm: 'true' })).status, 400, `${m} ${r} confirm como texto`);
  }
});

await test('ferramentas: a lista é a do /yui-ferramentas, liga, desliga e restaura no mesmo arquivo', async () => {
  const lista = (await s.call('GET', `${G}/mcp-tools`)).json.ferramentas;
  const esperadas = llm.getAllMcpTools().filter((t) => t.meta?.disableable && t.function.name !== 'leave_voice_call').map((t) => t.function.name);
  assert.deepEqual(lista.map((f) => f.nome), esperadas);
  assert.ok(lista.every((f) => f.rotulo && typeof f.ligada === 'boolean' && typeof f.padraoLigada === 'boolean'));
  assert.equal((await s.call('PUT', `${G}/mcp-tools/search_web`, { ligada: false, confirm: true })).status, 200);
  assert.deepEqual(ler('server_tools.json')[GUILD].disabled, ['search_web']);
  assert.equal(llm.isToolDisabled(GUILD, 'search_web'), true, 'o bot enxerga na hora');
  await s.call('PUT', `${G}/mcp-tools/join_voice_call`, { ligada: true, confirm: true });
  assert.deepEqual(ler('server_tools.json')[GUILD].enabled, ['join_voice_call', 'leave_voice_call'], 'entrar e sair andam juntos');
  const r = await s.call('POST', `${G}/mcp-tools/reset`, { confirm: true });
  assert.equal(r.status, 200);
  assert.equal(ler('server_tools.json')[GUILD], undefined);
  assert.ok(r.json.ferramentas.every((f) => f.ligada === f.padraoLigada));
});

await test('ferramentas: nome fora da lista, tipo errado e servidor desconhecido são recusados', async () => {
  for (const nome of ['leave_voice_call', 'nao_existe', 'ban_user']) assert.equal((await s.call('PUT', `${G}/mcp-tools/${nome}`, { ligada: false, confirm: true })).status, 404, nome);
  assert.equal((await s.call('PUT', `${G}/mcp-tools/search_web`, { ligada: 'off', confirm: true })).status, 400);
  assert.equal((await s.call('GET', `/guilds/${DE_FORA}/mcp-tools`)).status, 404);
});

await test('Termos: texto, estado, aceite com os efeitos do Discord (uma vez só) e revogação', async () => {
  const paginas = (await s.call('GET', '/tos')).json.paginas;
  assert.equal(paginas.length, tos.getTosPages().length);
  assert.ok(paginas.every((p) => p.titulo && p.texto));
  let e = (await s.call('GET', `${G}/tos`)).json;
  assert.deepEqual([e.aceito, e.exigido, e.aceitoEm, e.donoDoServidor], [false, true, null, false]);
  assert.equal((await s.call('POST', `${G}/tos`, { confirm: true })).status, 400, 'servidor de terceiros sem reconhecer');
  assert.equal(enviados.length, 0);
  assert.ok(!fs.existsSync(arq('accepted_servers.json')));
  const a = (await s.call('POST', `${G}/tos`, { confirm: true, emNomeDeTerceiros: true })).json;
  assert.equal(a.jaAceito, false);
  assert.equal(a.canalAtualizacoes, CANAL);
  assert.equal(a.avisoEnviado, true);
  assert.equal(enviados.length, 1);
  const [reg] = ler('accepted_servers.json');
  assert.deepEqual([reg.guildId, reg.ownerId, reg.authorizedBy, reg.via], [GUILD, MEMBER, OWNER, 'painel']);
  assert.equal(ler('server_settings.json')[GUILD].updateChannelId, CANAL);
  assert.equal(tos.isServerAccepted(GUILD), true, 'o bot libera o servidor na hora');
  assert.equal((await s.call('POST', `${G}/tos`, { confirm: true })).json.jaAceito, true);
  assert.equal(enviados.length, 1, 'não manda o aviso de novo');
  const rev = (await s.call('DELETE', `${G}/tos`, { confirm: true })).json;
  assert.equal(rev.estado.aceito, false);
  assert.deepEqual(ler('accepted_servers.json'), []);
});

await test('persona: grava, limpa, reseta (mantendo as falas espontâneas) e respeita os limites do comando', async () => {
  const antes = (await s.call('GET', C)).json;
  assert.deepEqual(antes.limites, { instrucao: 1500, humor: 100 });
  assert.equal((await s.call('PUT', `${C}/persona`, { instrucao: SEGREDO_PERSONA, humor: 'debochada', confirm: true })).status, 200);
  assert.deepEqual(ler('channel_settings.json')[CANAL], { instruction: SEGREDO_PERSONA, mood: 'debochada' });
  await s.call('PUT', `${C}/persona`, { humor: '', confirm: true });
  assert.deepEqual((await s.call('GET', C)).json.persona, { instrucao: SEGREDO_PERSONA, humor: null });
  for (const ruim of [{ instrucao: 'x'.repeat(1501) }, { humor: 'x'.repeat(101) }, { instrucao: 7 }, {}]) {
    assert.equal((await s.call('PUT', `${C}/persona`, { ...ruim, confirm: true })).status, 400, JSON.stringify(ruim).slice(0, 40));
  }
  await s.call('PUT', `${C}/espontaneo`, { ativo: true, frequencia: 'low', confirm: true });
  await s.call('DELETE', `${C}/persona`, { confirm: true });
  assert.deepEqual(ler('channel_settings.json')[CANAL], { chatter: { active: true, frequency: 'low' } });
});

await test('falas espontâneas: frequência ou porcentagem, com validação', async () => {
  let r = await s.call('PUT', `${C}/espontaneo`, { porcentagem: 30, confirm: true });
  assert.deepEqual(r.json.espontaneo, { ativo: true, frequencia: 'custom', porcentagem: 30 });
  r = await s.call('PUT', `${C}/espontaneo`, { ativo: false, frequencia: 'high', confirm: true });
  assert.deepEqual(r.json.espontaneo, { ativo: false, frequencia: 'high', porcentagem: null });
  for (const ruim of [{ porcentagem: 101 }, { porcentagem: -1 }, { porcentagem: 1.5 }, { porcentagem: '10' }, { frequencia: 'sempre' }, { ativo: 'on' }, { frequencia: 'low', porcentagem: 5 }, {}]) {
    assert.equal((await s.call('PUT', `${C}/espontaneo`, { ...ruim, confirm: true })).status, 400, JSON.stringify(ruim));
  }
});

await test('canal de outro servidor ou de voz é recusado', async () => {
  for (const canal of [DE_FORA, VOZ]) {
    assert.equal((await s.call('GET', `${G}/channels/${canal}`)).status, 400);
    assert.equal((await s.call('PUT', `${G}/channels/${canal}/persona`, { humor: 'x', confirm: true })).status, 400);
    assert.equal((await s.call('PUT', `${G}/channels/${canal}/espontaneo`, { ativo: true, confirm: true })).status, 400);
    assert.equal((await s.call('PUT', `${G}/channels`, { type: 'atualizacoes', channelId: canal })).status, 400);
  }
});

await test('menções e canal de atualizações gravam no server_settings.json', async () => {
  assert.equal((await s.call('PUT', `${G}/mentions`, { respondToEveryone: true, confirm: true })).status, 200);
  assert.equal(llm.getServerSettings(GUILD).respondToEveryone, true);
  assert.equal((await s.call('PUT', `${G}/channels`, { type: 'atualizacoes', channelId: null })).status, 400, 'sem confirm');
  assert.equal((await s.call('PUT', `${G}/channels`, { type: 'atualizacoes', channelId: null, confirm: true })).status, 200);
  assert.equal(ler('server_settings.json')[GUILD].updateChannelId, null);
  assert.equal((await s.call('PUT', `${G}/channels`, { type: 'atualizacoes', channelId: CANAL, confirm: true })).status, 200);
  assert.equal(ler('server_settings.json')[GUILD].updateChannelId, CANAL);
  assert.equal(ler('server_settings.json')[GUILD].respondToEveryone, true);
  assert.equal((await s.call('PUT', `${G}/channels`, { type: 'constructor', channelId: CANAL })).status, 400);
});

await test('persona: humor sem quebra de linha nem controle; a instrução aceita só quebra de linha e tabulação', async () => {
  for (const ruim of [{ humor: 'a\n>>> fim' }, { humor: 'a\tb' }, { humor: 'a\u2028b' }, { instrucao: 'a\u0000b' }, { instrucao: 'a\u001bb' }]) {
    assert.equal((await s.call('PUT', `${C}/persona`, { ...ruim, confirm: true })).status, 400, JSON.stringify(ruim));
  }
  assert.equal((await s.call('PUT', `${C}/persona`, { instrucao: 'linha 1\r\n\tlinha 2', confirm: true })).status, 200);
  assert.equal(ler('channel_settings.json')[CANAL].instruction, 'linha 1\n\tlinha 2');
});

await test('disco que recusa a gravação: o painel responde 500 em vez de dizer que salvou', async () => {
  const casos = [
    ['server_tools.json', 'PUT', `${G}/mcp-tools/search_web`, { ligada: false }],
    ['server_tools.json', 'POST', `${G}/mcp-tools/reset`, {}],
    ['channel_settings.json', 'PUT', `${C}/persona`, { humor: 'x' }],
    ['channel_settings.json', 'DELETE', `${C}/persona`, {}],
    ['channel_settings.json', 'PUT', `${C}/espontaneo`, { ativo: false }],
    ['server_settings.json', 'PUT', `${G}/mentions`, { respondToEveryone: false }],
    ['server_settings.json', 'PUT', `${G}/channels`, { type: 'atualizacoes', channelId: CANAL }],
  ];
  for (const [nome, m, r, b] of casos) {
    // Uma pasta no lugar do arquivo faz a escrita falhar.
    fs.rmSync(arq(nome), { recursive: true, force: true });
    fs.mkdirSync(arq(nome));
    try {
      assert.equal((await s.call(m, r, { ...b, confirm: true })).status, 500, `${m} ${r}`);
    } finally {
      fs.rmSync(arq(nome), { recursive: true, force: true });
    }
  }
});
s.close();

await test('o teste das rotas por servidor está na CI', async () => {
  assert.equal(JSON.parse(fs.readFileSync(new URL('../package.json', import.meta.url), 'utf8')).scripts['test:painelservidor'], 'node tests/test-painel-servidor.js');
  assert.match(fs.readFileSync(new URL('../scripts/run-ci.mjs', import.meta.url), 'utf8'), /'test:painelservidor'/);
});

await test('sem a ponte do bot, as rotas respondem 503', async () => {
  const sem = await subir(createAdmin({ client }));
  assert.equal((await sem.call('GET', `${G}/mcp-tools`)).status, 503);
  sem.close();
});

await test('cérebro separado: as telas vão ao bot por panel.admin, o bot confere o dono e grava', async () => {
  assert.deepEqual([...BOT_PANEL_ACTIONS].sort(), Object.keys(PANEL_ACTIONS).sort(), 'a mesma lista nos dois lados');
  const handlers = new Map();
  registerBotActions({ handle: (m, fn) => handlers.set(m, fn) }, { getClient: () => client, admin: createAdmin({ client, servidor: carregarServidorDoBot }) });
  const pedidos = [];
  let ligado = true;
  const channel = {
    isConnected: () => ligado,
    request: async (_papel, method, params, opts) => {
      pedidos.push({ method, action: params.action, idem: opts.idem });
      return JSON.parse(JSON.stringify(await handlers.get(method)(JSON.parse(JSON.stringify(params)), { role: 'cerebro' })));
    },
  };
  const c = await subir(createCerebroAdmin({ channel }));
  assert.equal((await c.call('PUT', `${G}/mcp-tools/generate_image`, { ligada: false, confirm: true })).status, 200);
  assert.deepEqual(ler('server_tools.json')[GUILD].disabled, ['generate_image']);
  assert.ok(pedidos.at(-1).idem, 'efeito leva chave de idempotência');
  assert.equal((await c.call('PUT', `${G}/channels`, { type: 'atualizacoes', channelId: CANAL })).status, 400, 'o bot também exige confirm');
  assert.equal((await c.call('PUT', `${G}/channels`, { type: 'atualizacoes', channelId: CANAL, confirm: true })).status, 200, 'o confirm atravessa o canal');
  assert.equal((await c.call('GET', C)).status, 200);
  assert.equal(pedidos.at(-1).idem, undefined, 'leitura não leva');
  assert.equal((await c.call('PUT', `${C}/persona`, { humor: 'x'.repeat(101), confirm: true })).status, 400, 'o erro do bot volta com o mesmo status');
  const antes = pedidos.length;
  assert.equal((await c.call('GET', `${G}/tos`, undefined, TOKEN_MEMBRO)).status, 403);
  assert.equal(pedidos.length, antes, 'membro nem chega ao canal');
  await assert.rejects(handlers.get('panel.admin')({ userId: MEMBER, action: 'revokeGuildTos', args: [GUILD, { confirm: true }] }, {}), (e) => e.code === 'FORBIDDEN');
  ligado = false;
  assert.equal((await c.call('GET', `${G}/mcp-tools`)).status, 503);
  c.close();
});

await test('auditoria: os eventos existem e não levam o texto da persona nem o humor', async () => {
  const bruto = fs.readFileSync(arq('audit.jsonl'), 'utf8');
  const eventos = bruto.split('\n').filter(Boolean).map((l) => JSON.parse(l).event);
  for (const e of ['admin.guild.tool', 'admin.guild.tools.reset', 'admin.guild.tos.accept', 'admin.guild.tos.revoke', 'admin.guild.persona', 'admin.guild.persona.reset', 'admin.guild.chatter', 'admin.guild.mentions', 'admin.guild.channel']) {
    assert.ok(eventos.includes(e), `falta ${e}`);
  }
  assert.ok(!bruto.includes('Barbanegra') && !bruto.includes('debochada'));
});

console.log(`\n${passed} ok, ${failures.length} falha(s)`);
(await import('../src/database/db.js')).closeAllDatabases();
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* arquivo ainda aberto no Windows */ }
process.exit(failures.length ? 1 : 0);
