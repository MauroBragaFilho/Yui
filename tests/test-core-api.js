// Testes da Yui API + AI Manager (sem chamar provedores reais).
// Execução: npm run test:core-api
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-api-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.MEMORY_RETENTION_DAYS = '30';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;

const { initMemory } = await import('../src/core/index.js');
const ai = await import('../src/core/ai/manager.js');
const { createApiServer, parseTokens, parseCorsOrigins } = await import('../src/core/api/server.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';

// Backend falso: guarda o que recebeu para inspeção.
const seen = [];
ai.registerBackend(
  { name: 'fake', local: false, async chat(args) { seen.push(args); return `eco: ${args.prompt}`; } },
  { activate: true }
);

const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222,curto=333`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, route, { token, body, raw } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), 'Content-Type': 'application/json' },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}

console.log('Yui API');
await test('health é público; demais rotas exigem token', async () => {
  assert.equal((await call('GET', '/v1/health')).status, 200);
  assert.equal((await call('GET', '/v1/me')).status, 401);
  assert.equal((await call('GET', '/v1/me', { token: 'token-errado-0123456789' })).status, 401);
});
await test('token curto (<16) é descartado na configuração', async () => {
  assert.equal((await call('GET', '/v1/me', { token: 'curto' })).status, 401);
});
await test('papel e escopo vêm do backend, não do cliente', async () => {
  const owner = (await call('GET', '/v1/me', { token: OWNER })).json;
  assert.deepEqual([owner.role, owner.memoryScope], ['OWNER', 'personal']);
  const member = (await call('GET', '/v1/me', { token: MEMBER })).json;
  assert.deepEqual([member.role, member.memoryScope], ['MEMBER', 'public']);
});
await test('chat chama o AI Manager com histórico e memória', async () => {
  const r1 = await call('POST', '/v1/chat', { token: OWNER, body: { message: 'lembra que o projeto BDS usa Laravel' } });
  assert.equal(r1.status, 200);
  assert.match(r1.json.reply, /^eco:/);
  const r2 = await call('POST', '/v1/chat', { token: OWNER, body: { message: 'qual o stack do projeto bds?' } });
  const last = seen.at(-1);
  assert.match(last.memoryBlock, /Laravel/);
  assert.equal(last.history.length, 2);
  assert.equal(r2.json.memoryScope, 'personal');
});
await test('memória pessoal do dono não vaza para outro usuário', async () => {
  await call('POST', '/v1/chat', { token: MEMBER, body: { message: 'e o projeto bds, usa o quê?' } });
  assert.equal(seen.at(-1).memoryBlock, '');
  const list = await call('GET', '/v1/memory', { token: MEMBER });
  assert.equal(list.json.memories.length, 0);
});
await test('CRUD de memória pela API', async () => {
  assert.equal((await call('POST', '/v1/memory', { token: MEMBER, body: { content: 'prefere respostas curtas', type: 'preference' } })).status, 201);
  const list = (await call('GET', '/v1/memory', { token: MEMBER })).json.memories;
  assert.equal(list.length, 1);
  assert.equal((await call('DELETE', `/v1/memory/${list[0].id}`, { token: MEMBER })).json.ok, true);
  assert.equal((await call('GET', '/v1/memory', { token: MEMBER })).json.memories.length, 0);
});
await test('validação: mensagem vazia, JSON inválido, corpo grande, rota inexistente', async () => {
  assert.equal((await call('POST', '/v1/chat', { token: OWNER, body: { message: '  ' } })).status, 400);
  assert.equal((await call('POST', '/v1/chat', { token: OWNER, raw: '{ruim' })).status, 400);
  assert.equal((await call('POST', '/v1/chat', { token: OWNER, body: { message: 'x'.repeat(4001) } })).status, 400);
  const big = await fetch(base + '/v1/chat', { method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: 'a'.repeat(70 * 1024) }).catch(() => ({ status: 413 }));
  assert.equal(big.status, 413);
  assert.equal((await call('GET', '/v1/nada', { token: OWNER })).status, 404);
});
await test('rotas do agent: conversa normal sem ferramentas e confirmação inválida negada', async () => {
  const r = await call('POST', '/v1/agent', { token: OWNER, body: { message: 'oi agent' } });
  assert.equal(r.status, 200);
  assert.equal(r.json.type, 'reply');
  assert.match(r.json.reply, /eco:/);
  assert.equal((await call('POST', '/v1/agent', { token: OWNER, body: {} })).status, 400);
  assert.equal((await call('POST', '/v1/agent/confirm', { token: OWNER, body: {} })).status, 400);
  const c = await call('POST', '/v1/agent/confirm', { token: OWNER, body: { id: 'inexistente' } });
  assert.equal(c.json.type, 'denied');
});
await test('CORS: só origens da allowlist; pré-verificação OPTIONS sem token', async () => {
  const cors = createApiServer({ tokens: parseTokens(`${OWNER}=111`), corsOrigins: parseCorsOrigins('http://localhost:8081/, https://app.exemplo.com') });
  await new Promise((r) => cors.listen(0, '127.0.0.1', r));
  const b = `http://127.0.0.1:${cors.address().port}`;
  const pre = await fetch(b + '/v1/chat', { method: 'OPTIONS', headers: { Origin: 'http://localhost:8081', 'Access-Control-Request-Method': 'POST' } });
  assert.equal(pre.status, 204);
  assert.equal(pre.headers.get('access-control-allow-origin'), 'http://localhost:8081');
  assert.match(pre.headers.get('access-control-allow-headers'), /Authorization/);
  const ok = await fetch(b + '/v1/health', { headers: { Origin: 'https://app.exemplo.com' } });
  assert.equal(ok.headers.get('access-control-allow-origin'), 'https://app.exemplo.com');
  const bad = await fetch(b + '/v1/health', { headers: { Origin: 'https://malicioso.com' } });
  assert.equal(bad.status, 200);
  assert.equal(bad.headers.get('access-control-allow-origin'), null, 'origem fora da allowlist não recebe CORS');
  assert.equal((await fetch(b + '/v1/chat', { method: 'OPTIONS', headers: { Origin: 'https://malicioso.com' } })).status, 403);
  assert.equal((await fetch(b + '/v1/me', { headers: { Origin: 'http://localhost:8081' } })).status, 401, 'CORS não substitui a autenticação');
  cors.close();
  // padrão: sem YUI_API_CORS_ORIGINS não há CORS
  assert.equal(parseCorsOrigins('').size, 0);
});
await test('rate limit por usuário (30/min)', async () => {
  let last = 0;
  for (let i = 0; i < 40; i++) last = (await call('GET', '/v1/me', { token: MEMBER })).status;
  assert.equal(last, 429);
});

console.log('AI Manager');
await test('AI_PRIVATE_LOCAL_ONLY recusa contexto pessoal em backend não-local', async () => {
  process.env.AI_PRIVATE_LOCAL_ONLY = 'true';
  await assert.rejects(ai.chat({ prompt: 'oi', ctx: { memoryScope: 'personal', userId: '111' } }), /AI_PRIVATE_LOCAL_ONLY/);
  await ai.chat({ prompt: 'oi', ctx: { memoryScope: 'public', userId: '222' } }); // público passa
  process.env.AI_PRIVATE_LOCAL_ONLY = 'false';
});
await test('backend openai-compatible fala com um endpoint /chat/completions (ex.: OmniRoute)', async () => {
  let received;
  const fakeGateway = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      received = { auth: req.headers.authorization, url: req.url, body: JSON.parse(body) };
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: ' olá do gateway ' } }] }));
    });
  });
  await new Promise((r) => fakeGateway.listen(0, '127.0.0.1', r));
  process.env.AI_BASE_URL = `http://127.0.0.1:${fakeGateway.address().port}/v1`;
  process.env.AI_API_KEY = 'chave-gateway-teste';
  process.env.AI_MODEL = 'auto/best-free';
  process.env.AI_BACKEND = 'openai-compatible';
  ai.initAiManager();

  const backend = ai.listBackends().find((b) => b.name === 'openai-compatible');
  assert.equal(backend.active, true);
  assert.equal(backend.local, false, 'gateway local NÃO é IA local');

  const reply = await ai.chat({ prompt: 'oi', history: [{ role: 'user', content: 'a' }], memoryBlock: '\n[MEMÓRIA] x\n', ctx: { userId: '222' } });
  assert.equal(reply, 'olá do gateway');
  assert.equal(received.url, '/v1/chat/completions');
  assert.equal(received.auth, 'Bearer chave-gateway-teste');
  assert.equal(received.body.model, 'auto/best-free');
  assert.match(received.body.messages[0].content, /MEMÓRIA/);
  assert.equal(received.body.messages.at(-1).content, 'oi');
  fakeGateway.close();
});

server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
