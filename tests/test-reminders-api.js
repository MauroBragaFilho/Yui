// API dos lembretes e do relatório matinal (/v1/admin/reminders e /v1/admin/morning), só o dono. Execução: npm run test:remindersapi
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-remapi-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';

const { initMemory } = await import('../src/core/index.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { createAdmin } = await import('../src/core/api/admin.js');
const { createReminderStore } = await import('../src/reminders/store.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const store = createReminderStore({ file: path.join(tmp, 'lembretes.json') });
const sentDms = [];
let dmOk = true;
const reminders = { store, compose: async () => 'RELATÓRIO DE TESTE', send: async (t) => { sentDms.push(t); return dmOk; } };
const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`), admin: createAdmin({ reminders }) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, route, { token = OWNER, body } = {}) {
  const res = await fetch(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined });
  return { status: res.status, json: await res.json().catch(() => null) };
}

console.log('API dos lembretes');

await test('só o dono entra', async () => {
  assert.equal((await call('GET', '/v1/admin/reminders', { token: MEMBER })).status, 403);
  assert.equal((await call('POST', '/v1/admin/reminders', { token: MEMBER, body: { text: 'x', when: 'amanhã às 9h' } })).status, 403);
  assert.equal((await call('POST', '/v1/admin/morning/send', { token: MEMBER })).status, 403);
  assert.equal((await call('GET', '/v1/admin/reminders', { token: null })).status, 401);
});

await test('criar com "quando" em português, listar com os textos prontos', async () => {
  assert.deepEqual((await call('GET', '/v1/admin/reminders')).json.reminders, []);
  const a = await call('POST', '/v1/admin/reminders', { body: { text: 'pagar a conta', when: 'amanhã às 9h' } });
  assert.equal(a.status, 200, JSON.stringify(a.json));
  assert.equal(a.json.reminder.text, 'pagar a conta');
  assert.equal(a.json.reminder.whenText, 'amanhã às 09:00');
  assert.equal(a.json.reminder.repeat, null);
  const b = await call('POST', '/v1/admin/reminders', { body: { text: 'vitamina', when: 'todo dia às 8h' } });
  assert.equal(b.json.reminder.repeatText, 'todo dia às 08:00');
  const list = (await call('GET', '/v1/admin/reminders')).json;
  assert.equal(list.reminders.length, 2);
  assert.ok(list.now);
});

await test('criar com data exata (ISO) e recusar o que não faz sentido', async () => {
  const at = new Date(Date.now() + 3 * 3600_000).toISOString();
  assert.equal((await call('POST', '/v1/admin/reminders', { body: { text: 'ligar', at } })).status, 200);
  const semQuando = await call('POST', '/v1/admin/reminders', { body: { text: 'x', when: 'qualquer hora' } });
  assert.equal(semQuando.status, 400);
  assert.match(semQuando.json.error, /Diga quando/);
  assert.equal((await call('POST', '/v1/admin/reminders', { body: { text: 'x', when: 'ontem às 10h' } })).status, 400);
  assert.equal((await call('POST', '/v1/admin/reminders', { body: { text: '  ', when: 'amanhã às 9h' } })).status, 400);
  assert.equal((await call('POST', '/v1/admin/reminders', { body: { text: 'x', at: 'lixo' } })).status, 400);
});

await test('adiar por minutos ou por "quando"; apagar; id que não existe dá 404', async () => {
  const id = store.list()[0].id;
  const antes = Date.now();
  const s = await call('POST', `/v1/admin/reminders/${id}/snooze`, { body: { minutes: 30 } });
  assert.equal(s.status, 200);
  const t = Date.parse(s.json.reminder.at);
  assert.ok(t >= antes + 29 * 60_000 && t <= Date.now() + 31 * 60_000, 'adiou 30 minutos a partir de agora');
  assert.equal((await call('POST', `/v1/admin/reminders/${id}/snooze`, { body: { when: 'amanhã às 10h' } })).json.reminder.whenText, 'amanhã às 10:00');
  assert.equal((await call('POST', `/v1/admin/reminders/${id}/snooze`, { body: { when: 'sei lá' } })).status, 400);
  assert.equal((await call('POST', '/v1/admin/reminders/9999/snooze', { body: { minutes: 5 } })).status, 404);
  assert.equal((await call('DELETE', `/v1/admin/reminders/${id}`)).status, 200);
  assert.equal((await call('DELETE', `/v1/admin/reminders/${id}`)).status, 404);
});

await test('relatório matinal: ver o texto e mandar por DM (e avisar se a DM não saiu)', async () => {
  assert.equal((await call('GET', '/v1/admin/morning')).json.text, 'RELATÓRIO DE TESTE');
  assert.equal(sentDms.length, 0, 'ver não envia');
  assert.equal((await call('POST', '/v1/admin/morning/send')).status, 200);
  assert.deepEqual(sentDms, ['RELATÓRIO DE TESTE']);
  dmOk = false;
  const falha = await call('POST', '/v1/admin/morning/send');
  assert.equal(falha.status, 503);
  assert.match(falha.json.error, /mensagem privada/);
});

await test('a auditoria registra as ações sem o texto dos lembretes', async () => {
  const lines = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const ev = lines.map((e) => e.event);
  for (const e of ['admin.reminder.add', 'admin.reminder.snooze', 'admin.reminder.remove', 'admin.morning.send']) assert.ok(ev.includes(e), e);
  const all = JSON.stringify(lines);
  for (const secret of ['pagar a conta', 'vitamina', 'ligar']) assert.equal(all.includes(secret), false, `"${secret}" não vai para a auditoria`);
});

server.close();
console.log(`\n${passed} testes OK`);
process.exit(0);
