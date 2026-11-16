// Aprovação crítica (Fase 1, tarefa 4): tickets de uso único, canal local autenticado, CLI e fluxo completo.
// Execução: npm run test:approvals
import assert from 'assert';
import { execFile } from 'child_process';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';
import { promisify } from 'util';

const run = promisify(execFile);
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-appr-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_READ_ONLY = 'false';
process.env.YUI_MEMORY_ENABLED = 'true';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
for (const k of ['YUI_PANEL_USER', 'YUI_PANEL_PASSWORD', 'YUI_PANEL_PASSWORD_HASH', 'YUI_PANEL_USER_ID']) delete process.env[k];

const { createApprovalManager, canonicalJson, hashParams, TTL_MS, LEVELS, STATUS } = await import('../src/core/security/approvalManager.js');
const { startLocalApprovalChannel, nonceFilePath } = await import('../src/core/security/localChannel.js');
const { createDev } = await import('../src/core/dev/index.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { buildContext } = await import('../src/core/permissions.js');
const { initMemory } = await import('../src/core/index.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const OWNER = { approverId: '111', approverRole: 'OWNER' };
const LOCAL = { ...OWNER, approverOrigin: 'LOCAL_PC' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function fresh(startAt = 1_000_000) {
  const events = [];
  let t = startAt;
  const manager = createApprovalManager({ auditFn: (event, ctx, d) => events.push({ event, ctx, ...d }), now: () => t });
  return { manager, events, advance: (ms) => { t += ms; }, at: () => t };
}
const plan = (over = {}) => ({ action: 'dev.run_terminal', params: { tool: 'run_terminal', command: 'git status', cwd: 'C:/p' }, level: LEVELS.CRITICAL, requester: { userId: '111', role: 'OWNER' }, origin: 'LOCAL_PC', sessionId: 's1', canonicalTarget: 'git status', summary: 'Rodar git status', preview: 'git status', ...over });

console.log('Tickets');
await test('hash canônico: independe da ordem das chaves, recursivo, e muda com qualquer valor', () => {
  assert.equal(canonicalJson({ b: 1, a: { d: 2, c: [3, { z: 1, y: 2 }] } }), '{"a":{"c":[3,{"y":2,"z":1}],"d":2},"b":1}');
  assert.equal(hashParams({ a: 1, b: 2 }), hashParams({ b: 2, a: 1 }));
  assert.notEqual(hashParams({ command: 'git status' }), hashParams({ command: 'git status ' }));
  assert.notEqual(hashParams({ a: [1, 2] }), hashParams({ a: [2, 1] }));
  assert.equal(hashParams({ a: 1, b: undefined }), hashParams({ a: 1 }));
  assert.match(hashParams({}), /^[0-9a-f]{64}$/);
});

await test('ciclo de vida: PENDING -> aprovado no PC -> consumido UMA vez; a auditoria registra cada etapa', async () => {
  const { manager, events } = fresh();
  const t = manager.request(plan());
  assert.equal(t.status, STATUS.PENDING);
  assert.equal(t.expiresAt - t.createdAt, 60_000);
  assert.equal(t.allowedApprovalOrigin, 'LOCAL_ONLY');
  assert.equal(manager.list().length, 1);
  assert.ok(!('params' in t), 'a exibição não leva os parâmetros brutos');
  const waiting = manager.waitFor(t.id);
  assert.equal(manager.decide(t.id, { approve: true, ...LOCAL }).status, STATUS.APPROVED);
  assert.equal((await waiting).status, STATUS.APPROVED);
  const used = manager.consume(t.id, { action: 'dev.run_terminal', params: plan().params });
  assert.equal(used.ok, true);
  assert.equal(manager.get(t.id).status, STATUS.CONSUMED);
  assert.equal(manager.consume(t.id, { action: 'dev.run_terminal', params: plan().params }).ok, false, 'segunda vez não vale');
  manager.enacted(t.id, { executionTimeMs: 12 });
  assert.deepEqual(events.map((e) => e.event), ['policy.approval_created', 'policy.approved', 'policy.violation', 'policy.enacted']);
  assert.equal(events[2].violationType, 'ticket_replay');
  assert.equal(events[1].approverOrigin, 'LOCAL_PC');
  assert.ok(!JSON.stringify(events).includes('git status'), 'a auditoria guarda o hash, não o comando');
});

await test('validade: CRITICAL 60 s e ASK 120 s; expirado não aprova nem executa', async () => {
  const { manager, events, advance } = fresh();
  const crit = manager.request(plan());
  const ask = manager.request(plan({ level: LEVELS.ASK, action: 'commands.run' }));
  assert.equal(TTL_MS.CRITICAL, 60_000);
  assert.equal(TTL_MS.ASK, 120_000);
  assert.equal(ask.expiresAt - ask.createdAt, 120_000);
  const waiting = manager.waitFor(crit.id);
  advance(61_000);
  assert.deepEqual(manager.list().map((t) => t.id), [ask.id], 'o crítico expirou, o simples ainda vale');
  assert.equal((await waiting).status, STATUS.EXPIRED, 'quem espera é avisado');
  assert.throws(() => manager.decide(crit.id, { approve: true, ...LOCAL }), (e) => e.status === 410);
  assert.ok(events.some((e) => e.event === 'policy.expired' && e.approvalId === crit.id));
  // aprovado mas não usado a tempo também expira
  manager.decide(ask.id, { approve: true, ...OWNER, approverOrigin: 'REMOTE' });
  advance(121_000);
  assert.equal(manager.consume(ask.id, { action: 'commands.run', params: plan().params }).ok, false);
  assert.equal(manager.get(ask.id).status, STATUS.EXPIRED);
});

await test('§9.1 aprovação crítica fora do PC (API remota, Tailscale, Discord) é recusada, registrada e o ticket continua pendente', () => {
  const { manager, events } = fresh();
  const t = manager.request(plan());
  for (const origin of ['REMOTE', 'DISCORD_DM', 'DISCORD_GUILD', undefined, null, 'LOCAL_PC ', 'local_pc']) {
    assert.throws(() => manager.decide(t.id, { approve: true, ...OWNER, approverOrigin: origin }), (e) => e.status === 403, String(origin));
  }
  assert.equal(manager.get(t.id).status, STATUS.PENDING);
  assert.equal(events.filter((e) => e.violationType === 'aprovacao_critica_fora_do_pc').length, 7);
  // recusar vale de qualquer origem do dono
  assert.equal(manager.decide(t.id, { approve: false, ...OWNER, approverOrigin: 'REMOTE' }).status, STATUS.REJECTED);
});

await test('só o dono aprova (membro, bloqueado e sem papel são recusados, até do PC)', () => {
  const { manager, events } = fresh();
  const t = manager.request(plan());
  for (const role of ['MEMBER', 'TRUSTED', 'GUEST', 'BLOCKED', null, undefined, 'owner']) {
    assert.throws(() => manager.decide(t.id, { approve: true, approverId: '222', approverRole: role, approverOrigin: 'LOCAL_PC' }), (e) => e.status === 403, String(role));
  }
  assert.equal(manager.get(t.id).status, STATUS.PENDING);
  assert.equal(events.filter((e) => e.violationType === 'aprovador_nao_e_dono').length, 7);
});

await test('ASK (simples) pode ser aprovado de qualquer canal do dono', () => {
  const { manager } = fresh();
  const t = manager.request(plan({ level: LEVELS.ASK, action: 'apps.open' }));
  assert.equal(t.allowedApprovalOrigin, 'ANY_OWNER_CHANNEL');
  assert.equal(manager.decide(t.id, { approve: true, ...OWNER, approverOrigin: 'DISCORD_DM' }).status, STATUS.APPROVED);
});

await test('§9.3 adulteração: aprovado "git status", executar "git push --force" (ou outro cwd/ação) cancela o ticket', () => {
  for (const tampered of [
    { action: 'dev.run_terminal', params: { tool: 'run_terminal', command: 'git push --force', cwd: 'C:/p' } },
    { action: 'dev.run_terminal', params: { tool: 'run_terminal', command: 'git status', cwd: 'C:/outro' } },
    { action: 'dev.run_terminal', params: { tool: 'run_terminal', command: 'git status ', cwd: 'C:/p' } },
    { action: 'dev.write_apply_diff', params: { tool: 'run_terminal', command: 'git status', cwd: 'C:/p' } },
    { action: 'dev.run_terminal', params: { tool: 'run_terminal', command: 'git status', cwd: 'C:/p', extra: 1 } },
  ]) {
    const { manager, events } = fresh();
    const t = manager.request(plan());
    manager.decide(t.id, { approve: true, ...LOCAL });
    const r = manager.consume(t.id, tampered);
    assert.equal(r.ok, false);
    assert.match(r.reason, /difere do que foi aprovado/);
    assert.equal(manager.get(t.id).status, STATUS.REJECTED, 'ticket cancelado');
    assert.ok(events.some((e) => e.violationType === 'parametros_adulterados'));
    assert.equal(manager.consume(t.id, { action: 'dev.run_terminal', params: plan().params }).ok, false, 'nem o comando original passa depois');
  }
});

await test('§9.4 replay: ticket consumido, recusado ou expirado é reconhecido e rejeitado; id desconhecido também', () => {
  const { manager, events } = fresh();
  const a = manager.request(plan());
  manager.decide(a.id, { approve: false, ...LOCAL });
  assert.throws(() => manager.decide(a.id, { approve: true, ...LOCAL }), (e) => e.status === 409);
  assert.equal(manager.consume(a.id, { action: 'dev.run_terminal', params: plan().params }).ok, false);
  assert.equal(manager.consume('nao-existe', { action: 'x', params: {} }).ok, false);
  assert.throws(() => manager.decide('nao-existe', { approve: true, ...LOCAL }), (e) => e.status === 404);
  assert.ok(events.filter((e) => e.violationType === 'ticket_replay').length >= 1);
  assert.ok(events.some((e) => e.violationType === 'ticket_desconhecido'));
});

await test('§9.5 concorrência: 50 consumos simultâneos do mesmo ticket executam exatamente UM', async () => {
  const { manager } = fresh();
  const t = manager.request(plan());
  manager.decide(t.id, { approve: true, ...LOCAL });
  const results = await Promise.all(Array.from({ length: 50 }, () => Promise.resolve().then(() => manager.consume(t.id, { action: 'dev.run_terminal', params: plan().params }))));
  assert.equal(results.filter((r) => r.ok).length, 1);
  assert.equal(results.filter((r) => !r.ok).length, 49);
  assert.equal(manager.stats().consumed, 1);
});

await test('assinatura HMAC: o ticket guardado é verificado; entradas inválidas são recusadas', () => {
  const { manager } = fresh();
  const t = manager.request(plan());
  assert.equal(manager.verifySignature(t.id), true);
  assert.equal(manager.verifySignature('x'), false);
  assert.throws(() => manager.request({ ...plan(), level: 'NADA' }), /nível/);
  assert.throws(() => manager.request({ ...plan(), action: '' }), /ação/);
  // dois gerenciadores têm chaves diferentes: um ticket de um não vale no outro
  const other = fresh().manager;
  assert.equal(other.get(t.id), null);
});

await test('cancelar a sessão recusa o que está pendente e libera quem espera', async () => {
  const { manager } = fresh();
  const a = manager.request(plan());
  const b = manager.request(plan({ sessionId: 's2' }));
  const waiting = manager.waitFor(a.id);
  assert.equal(manager.cancelPending('s1'), 1);
  assert.equal((await waiting).status, STATUS.REJECTED);
  assert.equal(manager.get(b.id).status, STATUS.PENDING);
});

console.log('Canal local');
const nonceFile = path.join(tmp, 'secrets', 'approval-channel.json');
const chEnv = { ...process.env, YUI_APPROVAL_NONCE_FILE: nonceFile, YUI_OWNER_ID: '111' };
const clock = fresh();
let nowMs = 5_000_000;
const channel = await startLocalApprovalChannel({ manager: clock.manager, env: chEnv, port: 0, auditFn: (...a) => clock.events.push({ event: a[0], ...a[2] }), now: () => nowMs });

function call(method, route, { nonce = channel.nonce, headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: channel.port, path: route, method, headers: { ...(nonce === null ? {} : { 'X-Yui-Local-Nonce': nonce }), ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}), ...headers } }, (res) => {
      let text = '';
      res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, json: text ? JSON.parse(text) : {}, headers: res.headers }));
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

await test('o segredo fica num arquivo restrito, o canal só escuta em 127.0.0.1 e o caminho segue o .env', async () => {
  assert.equal(nonceFilePath(chEnv), path.resolve(nonceFile));
  const info = JSON.parse(fs.readFileSync(nonceFile, 'utf8'));
  assert.equal(info.port, channel.port);
  assert.match(info.nonce, /^[0-9a-f]{64}$/);
  assert.equal(info.nonce, channel.nonce);
  if (process.platform !== 'win32') assert.equal(fs.statSync(nonceFile).mode & 0o777, 0o600);
  assert.equal(channel.restricted, true, 'permissão do arquivo restringida');
  assert.equal((await call('GET', '/v1/local/health')).status, 200);
});

await test('sem segredo, com segredo errado ou com cabeçalho de proxy: negado e registrado', async () => {
  assert.equal((await call('GET', '/v1/local/pending', { nonce: null })).status, 401);
  assert.equal((await call('GET', '/v1/local/pending', { nonce: 'errado' })).status, 401);
  assert.equal((await call('GET', '/v1/local/pending', { nonce: channel.nonce.slice(0, -1) + (channel.nonce.endsWith('a') ? 'b' : 'a') })).status, 401);
  for (const h of [{ 'X-Forwarded-For': '203.0.113.9' }, { 'X-Forwarded-Host': 'x' }, { Forwarded: 'for=1.2.3.4' }, { 'Tailscale-User-Login': 'a@b' }, { Via: '1.1 proxy' }]) {
    assert.equal((await call('GET', '/v1/local/pending', { headers: h })).status, 403, JSON.stringify(h));
  }
  assert.equal((await call('GET', '/v1/local/pending', { headers: { Host: 'evil.example.com' } })).status, 403, 'DNS rebinding');
  assert.equal((await call('GET', '/v1/local/pending', { headers: { Origin: 'http://evil.example.com' } })).status, 403, 'navegador');
  const types = new Set(clock.events.filter((e) => e.event === 'policy.violation').map((e) => e.violationType));
  for (const v of ['canal_local_segredo_invalido', 'canal_local_cabecalho_de_proxy', 'canal_local_host_invalido', 'canal_local_origem_de_navegador']) assert.ok(types.has(v), v);
  assert.ok(!clock.events.some((e) => JSON.stringify(e).includes(channel.nonce)), 'o segredo nunca vai para a auditoria');
});

await test('§9.2 spoofing: injetar cabeçalhos de loopback NÃO dá privilégio; só o segredo do arquivo', async () => {
  const t = clock.manager.request(plan());
  for (const h of [{ 'X-Forwarded-For': '127.0.0.1' }, { 'X-Real-IP': '127.0.0.1' }, { Host: '127.0.0.1' }]) {
    const r = await call('POST', '/v1/local/decide', { nonce: 'chute', headers: h, body: { id: t.id, approve: true } });
    assert.ok([401, 403].includes(r.status), JSON.stringify(h));
  }
  assert.equal(clock.manager.get(t.id).status, STATUS.PENDING);
  clock.manager.decide(t.id, { approve: false, ...LOCAL });
});

await test('trava por 60 s depois de 5 tentativas erradas (até o segredo certo é recusado) e volta depois', async () => {
  nowMs = 6_000_000;
  assert.equal((await call('GET', '/v1/local/health')).status, 200, 'uma chamada válida zera o contador de falhas');
  for (let i = 0; i < 5; i++) assert.equal((await call('GET', '/v1/local/pending', { nonce: `x${i}` })).status, 401);
  const locked = await call('GET', '/v1/local/pending');
  assert.equal(locked.status, 429);
  assert.ok(Number(locked.headers['retry-after']) > 0);
  nowMs += 61_000;
  assert.equal((await call('GET', '/v1/local/pending')).status, 200);
});

await test('listar e decidir pelo canal: a decisão sai como LOCAL_PC e do dono; corpo inválido e id inexistente são erros claros', async () => {
  const t = clock.manager.request(plan({ summary: 'Gravar novo.js', preview: '--- novo.js ---\nconteúdo' }));
  const list = await call('GET', '/v1/local/pending');
  assert.equal(list.json.approvals.length, 1);
  assert.equal(list.json.approvals[0].id, t.id);
  assert.equal(list.json.approvals[0].levelRequired, 'CRITICAL');
  assert.match(list.json.approvals[0].paramsHash, /^[0-9a-f]{64}$/);
  assert.equal((await call('POST', '/v1/local/decide', { body: { id: t.id } })).status, 400);
  assert.equal((await call('POST', '/v1/local/decide', { body: { id: 'nada', approve: true } })).status, 404);
  const ok = await call('POST', '/v1/local/decide', { body: { id: t.id, approve: true } });
  assert.deepEqual([ok.status, ok.json.status], [200, 'APPROVED']);
  assert.equal(clock.manager.get(t.id).approverOrigin, 'LOCAL_PC');
  assert.equal(clock.manager.get(t.id).approverId, '111');
  assert.equal((await call('POST', '/v1/local/decide', { body: { id: t.id, approve: true } })).status, 409, 'replay');
  assert.equal((await call('GET', '/v1/local/outra-rota')).status, 404);
});

await test('CLI yui-aprovar: lista, aprova e nega pelo canal (id inteiro ou prefixo) e falha com mensagem clara sem segredo', async () => {
  const env = { ...process.env, YUI_APPROVAL_NONCE_FILE: nonceFile };
  const a = clock.manager.request(plan({ summary: 'Rodar npm test', canonicalTarget: 'npm test' }));
  const b = clock.manager.request(plan({ summary: 'Gravar x.js' }));
  const list = await run(process.execPath, ['scripts/yui-aprovar.mjs', 'lista'], { env, cwd: path.resolve(import.meta.dirname, '..') });
  assert.match(list.stdout, /Rodar npm test/);
  assert.match(list.stdout, /hash dos parâmetros/);
  await run(process.execPath, ['scripts/yui-aprovar.mjs', 'aprovar', a.id.slice(0, 8)], { env, cwd: path.resolve(import.meta.dirname, '..') });
  await run(process.execPath, ['scripts/yui-aprovar.mjs', 'negar', b.id], { env, cwd: path.resolve(import.meta.dirname, '..') });
  assert.equal(clock.manager.get(a.id).status, STATUS.APPROVED);
  assert.equal(clock.manager.get(b.id).status, STATUS.REJECTED);
  await assert.rejects(run(process.execPath, ['scripts/yui-aprovar.mjs', 'aprovar', 'zzzz'], { env, cwd: path.resolve(import.meta.dirname, '..') }), (e) => e.code === 1 && /Nenhum pedido pendente/.test(e.stderr));
  await assert.rejects(run(process.execPath, ['scripts/yui-aprovar.mjs', 'lista'], { env: { ...process.env, YUI_APPROVAL_NONCE_FILE: path.join(tmp, 'nao-existe.json') }, cwd: path.resolve(import.meta.dirname, '..') }), (e) => e.code === 2 && /Não consegui ler/.test(e.stderr));
});

console.log('Fluxo completo (API + módulo Código + canal local)');
await test('a API principal NÃO aprova ação crítica (nem "parecendo local"); o canal local aprova; grava uma vez; replay é recusado', async () => {
  const project = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-appr-proj-'));
  const act = JSON.stringify({ action: 'write_file', params: { path: 'novo.txt', content: 'oi\n' }, thought: '' });
  const llm = { async chat({ messages }) { return { text: String(messages.at(-1).content).includes('[RESULTADO') ? 'Pronto.' : act, provider: 'f', model: 'm' }; } };
  const flow = fresh();
  const dev = createDev({ env: { YUI_DEV_ENABLED: 'true', YUI_PROJECTS: `P=${project}`, YUI_DEV_PROJECTS_FILE: path.join(tmp, 'p.json') }, llm, historyDir: path.join(tmp, 'h'), indexDir: path.join(tmp, 'i'), approvals: flow.manager });
  const OWNER_TOKEN = 'owner-token-0123456789';
  const server = createApiServer({ tokens: parseTokens(`${OWNER_TOKEN}=111`), dev });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const api = async (method, p, body) => { const r = await fetch(base + p, { method, headers: { Authorization: `Bearer ${OWNER_TOKEN}`, 'Content-Type': 'application/json' }, body: body ? JSON.stringify(body) : undefined }); return { status: r.status, json: await r.json() }; };
  const flowChannel = await startLocalApprovalChannel({ manager: flow.manager, env: { ...process.env, YUI_APPROVAL_NONCE_FILE: path.join(tmp, 'flow', 'canal.json'), YUI_OWNER_ID: '111' }, port: 0, auditFn: () => {} });
  const viaChannel = (route, body) => new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port: flowChannel.port, path: route, method: body ? 'POST' : 'GET', headers: { 'X-Yui-Local-Nonce': flowChannel.nonce, ...(data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {}) } }, (res) => { let s = ''; res.on('data', (c) => { s += c; }); res.on('end', () => resolve({ status: res.statusCode, json: JSON.parse(s) })); });
    req.on('error', reject); if (data) req.write(data); req.end();
  });
  try {
    const start = await api('POST', '/v1/dev/projects/p/runs', { message: 'grave novo.txt' });
    assert.equal(start.status, 200, JSON.stringify(start.json));
    assert.equal(start.json.approval, 'ask');
    let approval;
    for (let i = 0; i < 150 && !approval; i++) { approval = (await api('GET', `/v1/dev/runs/${start.json.runId}/events?after=0`)).json.events.find((e) => e.type === 'approval'); await sleep(20); }
    assert.ok(approval, 'pedido aparece');
    assert.equal(approval.level, 'CRITICAL');
    assert.equal(approval.via, 'local');
    assert.equal(fs.existsSync(path.join(project, 'novo.txt')), false);

    // a API (mesmo por loopback, sem cabeçalhos: o "local" antigo) NÃO aprova
    for (const headers of [undefined]) {
      const denied = await api('POST', `/v1/dev/runs/${start.json.runId}/approvals/${approval.id}`, { approve: true });
      assert.equal(denied.status, 403);
      assert.match(denied.json.error, /yui-aprovar/);
    }
    assert.equal(fs.existsSync(path.join(project, 'novo.txt')), false);
    assert.equal(flow.manager.get(approval.id).status, STATUS.PENDING);
    assert.ok(flow.events.some((e) => e.violationType === 'aprovacao_critica_fora_do_pc'));

    // o canal local aprova
    const pending = await viaChannel('/v1/local/pending');
    assert.equal(pending.json.approvals[0].id, approval.id);
    assert.equal((await viaChannel('/v1/local/decide', { id: approval.id, approve: true })).json.status, 'APPROVED');
    let done;
    for (let i = 0; i < 200 && !done; i++) { done = (await api('GET', `/v1/dev/runs/${start.json.runId}/events?after=0`)).json.events.find((e) => e.type === 'done'); await sleep(20); }
    assert.equal(done?.ok, true);
    assert.equal(fs.readFileSync(path.join(project, 'novo.txt'), 'utf8'), 'oi\n');
    assert.equal(flow.manager.get(approval.id).status, STATUS.CONSUMED);
    assert.deepEqual(done.changed, ['novo.txt']);
    assert.equal((await viaChannel('/v1/local/decide', { id: approval.id, approve: true })).status, 409, 'replay recusado');
    assert.ok(flow.events.some((e) => e.event === 'policy.enacted'));

    // negar pela API é permitido e não grava
    fs.rmSync(path.join(project, 'novo.txt'));
    const second = await api('POST', '/v1/dev/projects/p/runs', { message: 'grave novo.txt de novo' });
    let a2;
    for (let i = 0; i < 150 && !a2; i++) { a2 = (await api('GET', `/v1/dev/runs/${second.json.runId}/events?after=0`)).json.events.find((e) => e.type === 'approval'); await sleep(20); }
    assert.equal((await api('POST', `/v1/dev/runs/${second.json.runId}/approvals/${a2.id}`, { approve: false })).status, 200);
    for (let i = 0; i < 200; i++) { if ((await api('GET', `/v1/dev/runs/${second.json.runId}/events?after=0`)).json.events.some((e) => e.type === 'done')) break; await sleep(20); }
    assert.equal(fs.existsSync(path.join(project, 'novo.txt')), false);
    assert.equal(flow.manager.get(a2.id).status, STATUS.REJECTED);
  } finally {
    server.close();
    await flowChannel.close();
    fs.rmSync(project, { recursive: true, force: true });
  }
});

await test('fechar o canal apaga o arquivo do segredo e a porta deixa de responder', async () => {
  await channel.close();
  assert.equal(fs.existsSync(nonceFile), false);
  await assert.rejects(call('GET', '/v1/local/health'), (e) => ['ECONNREFUSED', 'ECONNRESET'].includes(e.code));
});

console.log(`\n${passed} testes OK`);
fs.rmSync(tmp, { recursive: true, force: true });
process.exitCode = 0;
