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
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;

const root = path.resolve(import.meta.dirname, '..', '..', '..');
const { initMemory } = await import(`file://${root}/src/core/index.js`);
const ai = await import(`file://${root}/src/core/ai/manager.js`);
const { createApiServer, parseTokens, parseCorsOrigins } = await import(`file://${root}/src/core/api/server.js`);
const { registerTool, clearTools } = await import(`file://${root}/src/core/agent/tools.js`);
const { createClient, normalizeBaseUrl, ApiError } = await import('../src/api/client.ts');
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
  assert.deepEqual(await owner.me(), { userId: '111', role: 'OWNER', memoryScope: 'personal' });
  assert.equal((await createClient({ baseUrl: url, token: MEMBER }).me()).role, 'MEMBER');
});

test('erros: token inválido, servidor fora do ar e mensagens amigáveis', async () => {
  await assert.rejects(createClient({ baseUrl: url, token: 'token-errado-0123456789' }).me(), (e) => e instanceof ApiError && e.status === 401 && /Token inválido/.test(e.message));
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
