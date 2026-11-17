// Motor de políticas nas ROTAS da API (admin, BDS, memória): observe não muda nada; enforce nega/exige aprovação local.
// Execução: npm run test:routes
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-routes-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.MEMORY_RETENTION_DAYS = '30';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
delete process.env.YUI_POLICY_MODE;

const { initMemory } = await import('../src/core/index.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { actionForRoute } = await import('../src/core/security/routeGuard.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`) });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

/** remote=true simula pedido vindo de proxy/Tailscale (cabeçalho de encaminhamento): origem REMOTE. */
async function call(method, route, { token = OWNER, body, remote = false } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...(remote ? { 'X-Forwarded-For': '100.64.0.9' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json().catch(() => null) };
}
const policyBlocked = (r) => r.status === 403 && Boolean(r.json?.policy);
const mode = (m, readOnly) => { process.env.YUI_POLICY_MODE = m; process.env.YUI_READ_ONLY = String(readOnly); };

console.log('Tabela de rotas');
await test('rotas que mudam estado mapeiam para ações da matriz; leituras e rotas desconhecidas não', () => {
  const cases = [
    ['POST', '/v1/memory', 'memory.write_own'], ['DELETE', '/v1/memory', 'memory.wipe_own'], ['DELETE', '/v1/memory/12', 'memory.forget_item'],
    ['POST', '/v1/admin/bans', 'admin.ban_user'], ['DELETE', '/v1/admin/bans/user/123', 'admin.ban_user'],
    ['DELETE', '/v1/admin/memory/users/123', 'memory.admin_wipe_user'], ['DELETE', '/v1/admin/memory/users/123/9', 'memory.admin_wipe_user'],
    ['POST', '/v1/admin/ai/keys', 'admin.ai_configure'], ['POST', '/v1/admin/ai/custom', 'admin.ai_configure'], ['DELETE', '/v1/admin/ai/custom/meu', 'admin.ai_configure'],
    ['POST', '/v1/admin/restart', 'admin.restart'], ['POST', '/v1/admin/bds/purge', 'bds.purge'], ['POST', '/v1/admin/bds/delete', 'bds.delete'],
    ['PUT', '/v1/admin/bds/upload', 'bds.write'], ['GET', '/v1/admin/bds/list', 'bds.read'], ['POST', '/v1/admin/radio/123456789012345', 'radio.play_control'],
  ];
  for (const [m, p, a] of cases) assert.equal(actionForRoute(m, p), a, `${m} ${p}`);
  for (const [m, p] of [['GET', '/v1/admin/overview'], ['GET', '/v1/memory'], ['POST', '/v1/chat'], ['GET', '/v1/health'], ['POST', '/v1/admin/inexistente']]) assert.equal(actionForRoute(m, p), null, `${m} ${p}`);
});

console.log('observe (padrão): nada muda');
await test('em observe nenhuma rota é bloqueada pelo motor, nem as críticas por origem remota', async () => {
  mode('observe', true);
  for (const [m, p, body] of [['POST', '/v1/admin/ai/keys', {}], ['POST', '/v1/admin/bans', {}], ['POST', '/v1/admin/bds/purge', {}], ['POST', '/v1/admin/restart', {}]]) {
    const r = await call(m, p, { body, remote: true });
    assert.equal(policyBlocked(r), false, `${m} ${p} -> ${r.status} ${JSON.stringify(r.json)}`);
  }
  assert.equal((await call('DELETE', '/v1/memory')).status, 200);
});

console.log('enforce: somente leitura');
await test('com YUI_READ_ONLY=true o motor nega ação que grava/apaga/bane, mesmo para o dono no PC', async () => {
  mode('enforce', true);
  for (const [m, p] of [['POST', '/v1/admin/bans'], ['DELETE', '/v1/admin/memory/users/222'], ['POST', '/v1/admin/restart'], ['POST', '/v1/admin/bds/delete'], ['POST', '/v1/admin/ai/keys']]) {
    const r = await call(m, p, { body: {} });
    assert.ok(policyBlocked(r), `${m} ${p} -> ${r.status}`);
    assert.equal(r.json.policy.decision, 'DENY');
  }
  assert.equal(policyBlocked(await call('GET', '/v1/admin/overview')), false, 'leitura continua');
  assert.equal(policyBlocked(await call('DELETE', '/v1/memory')), false, 'a própria memória não é "modifica o computador"');
});

console.log('enforce: origem e papel');
await test('crítico pelo app/remoto é negado e pede o computador; no PC passa pelo guarda', async () => {
  mode('enforce', false);
  for (const [m, p] of [['POST', '/v1/admin/ai/keys'], ['POST', '/v1/admin/bds/purge']]) {
    const remote = await call(m, p, { body: {}, remote: true });
    assert.ok(policyBlocked(remote) && remote.json.requiresLocalApproval === true, `${m} ${p} remoto -> ${remote.status}`);
    const local = await call(m, p, { body: {} });
    assert.equal(policyBlocked(local), false, `${m} ${p} local -> ${local.status}`);
  }
});
await test('quem não é dono recebe 403 do motor nas rotas de administração', async () => {
  mode('enforce', false);
  for (const [m, p] of [['POST', '/v1/admin/bans'], ['POST', '/v1/admin/restart'], ['DELETE', '/v1/admin/memory/users/111']]) {
    assert.ok(policyBlocked(await call(m, p, { token: MEMBER, body: {} })), `${m} ${p}`);
  }
});
await test('auditoria registra as rotas bloqueadas e o modo', () => {
  const lines = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.ok(lines.some((e) => e.event === 'policy.route_blocked'), 'policy.route_blocked');
  assert.ok(lines.some((e) => e.event === 'policy.evaluate' && e.mode === 'enforce'), 'policy.evaluate enforce');
});

console.log('Freio de adivinhação de token');
await test('muitos Bearer inválidos travam a origem; um token certo não passa durante o bloqueio', async () => {
  const s2 = createApiServer({ tokens: parseTokens(`${OWNER}=111`) });
  await new Promise((r) => s2.listen(0, '127.0.0.1', r));
  const b2 = `http://127.0.0.1:${s2.address().port}`;
  const hit = (token, extra = {}) => fetch(b2 + '/v1/me', { headers: { Authorization: `Bearer ${token}`, ...extra } }).then((r) => r.status);
  for (let i = 0; i < 20; i++) assert.equal(await hit(`errado-${i}-0123456789abcdef`), 401);
  assert.equal(await hit(OWNER), 429, 'travado, mesmo com o token certo');
  assert.equal(await hit(OWNER, { 'X-Forwarded-For': '100.64.0.77' }), 200, 'outra origem (atrás do proxy) não é afetada');
  s2.close();
});

delete process.env.YUI_POLICY_MODE;
delete process.env.YUI_READ_ONLY;
server.close();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
