// Testes do módulo de código (as funções do Jarvis dentro da Yui Core).
// Execução: npm run test:dev
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dev-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';
process.env.YUI_READ_ONLY = 'true';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
for (const k of ['YUI_PANEL_USER', 'YUI_PANEL_PASSWORD', 'YUI_PANEL_PASSWORD_HASH', 'YUI_PANEL_USER_ID']) delete process.env[k];

const { createProjects, checkProjectPath, ProjectError } = await import('../../src/core/dev/projects.js');
const { createDevLlm } = await import('../../src/core/dev/llm.js');
const { createDev, DevError } = await import('../../src/core/dev/index.js');
const { createDevRoutes, isLocalRequest } = await import('../../src/core/dev/routes.js');
const { trimToBudget, createHistoryStore } = await import('../../src/core/dev/history.js');
const { createApiServer, parseTokens } = await import('../../src/core/api/server.js');
const { initMemory } = await import('../../src/core/index.js');
await initMemory();

const mk = () => fs.mkdtempSync(path.join(os.tmpdir(), 'yui-dev-p-'));
const json = (action, params, thought = '') => JSON.stringify({ action, params, thought });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function makeProject(extra = {}) {
  const root = mk();
  fs.mkdirSync(path.join(root, 'src'));
  fs.writeFileSync(path.join(root, 'src', 'soma.js'), 'function soma(a, b) {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(root, '.env'), 'SEGREDO=1');
  for (const [name, content] of Object.entries(extra)) fs.writeFileSync(path.join(root, name), content);
  return root;
}

function scriptedLlm(replies) {
  const calls = [];
  return {
    calls,
    async chat(request) {
      calls.push(JSON.parse(JSON.stringify(request.messages)));
      return { text: replies[Math.min(calls.length - 1, replies.length - 1)], provider: 'fake', model: 'm' };
    },
  };
}

function devWith({ replies, enabled = true, readOnly = true, extraEnv = {} } = {}) {
  const root = makeProject();
  const env = { YUI_DEV_ENABLED: enabled ? 'true' : 'false', YUI_PROJECTS: `Demo=${root}`, YUI_DEV_PROJECTS_FILE: path.join(mk(), 'p.json'), ...extraEnv };
  process.env.YUI_READ_ONLY = readOnly ? 'true' : 'false';
  const llm = scriptedLlm(replies ?? ['ok']);
  const dev = createDev({ env, llm, historyDir: path.join(mk(), 'h'), indexDir: path.join(mk(), 'i'), runCommandImpl: async (c) => ({ code: 0, stdout: `ran:${c}`, stderr: '' }) });
  return { dev, root, llm, env };
}

async function waitDone(dev, runId, ms = 5000) {
  const t0 = Date.now();
  let after = 0;
  const events = [];
  while (Date.now() - t0 < ms) {
    const r = dev.getEvents(runId, after);
    events.push(...r.events);
    after = r.last;
    if (r.status !== 'running' && events.some((e) => e.type === 'done')) return { status: r.status, events };
    await sleep(20);
  }
  throw new Error('execução não terminou');
}

// ───────── projetos ─────────

test('projetos: lê YUI_PROJECTS e o cadastro do app; ids sem acento/espaço', () => {
  const root = mk();
  const file = path.join(mk(), 'p.json');
  const p = createProjects({ env: { YUI_PROJECTS: `Meu Projeto=${root}|LAC=${root}`, YUI_DEV_PROJECTS_FILE: file }, file });
  assert.deepEqual(p.list().map((x) => x.id), ['meu-projeto', 'lac']);
  assert.equal(p.get('LAC').source, 'env');
  assert.equal(p.get('naoexiste'), null);
});

test('projetos: cadastro recusa raiz do disco, pasta pessoal, sistema, credenciais e inexistentes', () => {
  const env = { SystemRoot: 'C:\\Windows', ProgramFiles: 'C:\\Program Files' };
  assert.throws(() => checkProjectPath(path.parse(os.tmpdir()).root, env), /raiz do disco/);
  assert.throws(() => checkProjectPath(os.homedir(), env), /pasta pessoal/);
  assert.throws(() => checkProjectPath(path.join(mk(), 'nao-existe'), env), /não existe/);
  assert.throws(() => checkProjectPath('', env), /Informe/);
  const ssh = path.join(mk(), '.ssh');
  fs.mkdirSync(ssh);
  assert.throws(() => checkProjectPath(ssh, env), /credenciais/);
  const file = mk() + '/arquivo.txt';
  fs.writeFileSync(file, 'x');
  assert.throws(() => checkProjectPath(file, env), /não é uma pasta/);
  if (process.platform === 'win32' && fs.existsSync('C:\\Windows')) assert.throws(() => checkProjectPath('C:\\Windows\\System32', env), /sistema/);
});

test('projetos: adicionar, duplicado, remover; projetos do .env não se removem pelo app', () => {
  const envRoot = mk();
  const file = path.join(mk(), 'p.json');
  const p = createProjects({ env: { YUI_PROJECTS: `Fixo=${envRoot}` }, file });
  const folder = mk();
  const added = p.add({ name: 'Novo App', path: folder });
  assert.equal(added.id, 'novo-app');
  assert.equal(fs.existsSync(file), true);
  assert.throws(() => p.add({ name: 'novo app', path: folder }), (e) => e instanceof ProjectError && e.status === 409);
  assert.throws(() => p.add({ name: '../x', path: folder }), /Nome inválido/);
  assert.throws(() => p.remove('fixo'), /\.env/);
  assert.deepEqual(p.remove('novo-app'), { ok: true });
  assert.equal(p.get('novo-app'), null);
  assert.throws(() => p.remove('novo-app'), (e) => e.status === 404);
});

// ───────── IA do módulo ─────────

test('IA do código: LM Studio primeiro; se cair, usa o Gateway marcando o código como SENSÍVEL', async () => {
  const calls = [];
  const gateway = { hasTargets: () => true, chat: async (body, opts) => { calls.push({ body, opts }); return { choices: [{ message: { content: 'do gateway' } }], x_gateway: { provider: 'groq', model: 'm' } }; } };
  const down = createDevLlm({ env: {}, fetchImpl: async () => { throw Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }); }, getGateway: async () => gateway });
  const r = await down.chat({ messages: [{ role: 'user', content: 'oi' }] });
  assert.equal(r.text, 'do gateway');
  assert.equal(r.provider, 'groq');
  assert.equal(calls[0].opts.sensitive, true, 'código nunca vai a provedor anônimo');

  const up = createDevLlm({ env: {}, fetchImpl: async () => ({ ok: true, json: async () => ({ model: 'qwen', choices: [{ message: { content: 'do LM Studio' } }] }) }), getGateway: async () => { throw new Error('não devia chamar'); } });
  assert.equal((await up.chat({ messages: [] })).text, 'do LM Studio');
});

test('IA do código: se nada responde, o erro lista as duas tentativas; cancelar interrompe', async () => {
  const none = createDevLlm({ env: {}, fetchImpl: async () => { throw new Error('offline'); }, getGateway: async () => ({ hasTargets: () => false }) });
  await assert.rejects(none.chat({ messages: [] }), /LM Studio.*Yui Gateway|Nenhuma IA respondeu/s);
  const c = new AbortController();
  c.abort();
  await assert.rejects(none.chat({ messages: [] }, { signal: c.signal }), /Cancelado/);
});

test('histórico: corta por tamanho, guarda só texto e apaga', async () => {
  const msgs = Array.from({ length: 20 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', content: 'x'.repeat(100) }));
  const kept = trimToBudget(msgs, 450);
  assert.equal(kept[0].role, 'user');
  assert.ok(kept.reduce((n, m) => n + m.content.length, 0) <= 450);
  const store = createHistoryStore({ dir: path.join(mk(), 'h') });
  await store.save('p1', [...msgs.slice(0, 2), { role: 'tool', content: 'x' }]);
  assert.equal((await store.load('p1')).length, 2);
  await store.clear('p1');
  assert.deepEqual(await store.load('p1'), []);
});

// ───────── execuções ─────────

test('execução: desligado (YUI_DEV_ENABLED) recusa com 503', async () => {
  const { dev } = devWith({ enabled: false });
  await assert.rejects(dev.startRun({ projectId: 'demo', message: 'oi', local: true }), (e) => e instanceof DevError && e.status === 503);
  assert.equal(dev.status({ local: true }).enabled, false);
});

test('execução: lê o projeto e responde; eventos têm sequência e o histórico é guardado', async () => {
  const { dev, llm } = devWith({ replies: [json('read_file', { path: 'src/soma.js' }, 'ver'), 'Ela soma dois números.'] });
  const { runId } = await dev.startRun({ projectId: 'demo', message: 'o que faz soma.js?', local: true });
  const { status, events } = await waitDone(dev, runId);
  assert.equal(status, 'done');
  assert.deepEqual(events.map((e) => e.seq), events.map((_, i) => i + 1));
  assert.equal(events.find((e) => e.type === 'final').text, 'Ela soma dois números.');
  assert.ok(events.some((e) => e.type === 'tool' && e.action === 'read_file' && e.status === 'ok'));
  assert.equal(dev.getEvents(runId, events.at(-1).seq).events.length, 0, 'cursor "after" só devolve o que é novo');
  assert.match(llm.calls[1].at(-1).content, /1\| function soma/);
  assert.equal((await dev.history.load('demo')).length, 2);

  const second = await dev.startRun({ projectId: 'demo', message: 'e o que mais?', local: true });
  await waitDone(dev, second.runId);
  assert.ok(llm.calls.at(-1).some((m) => m.role === 'assistant' && m.content === 'Ela soma dois números.'), 'a conversa anterior volta ao modelo');
});

test('execução: com YUI_READ_ONLY ligado (padrão) gravar e rodar comando são NEGADOS, mesmo no computador', async () => {
  const { dev, root } = devWith({ readOnly: true, replies: [json('write_file', { path: 'x.js', content: 'hack' }), json('run_terminal', { command: 'npm install' }), 'Não deu.'] });
  const { runId, approval } = await dev.startRun({ projectId: 'demo', message: 'crie x.js', local: true });
  assert.equal(approval, 'readonly');
  const { events } = await waitDone(dev, runId);
  assert.equal(fs.existsSync(path.join(root, 'x.js')), false);
  assert.ok(events.filter((e) => e.type === 'tool' && e.status === 'denied').length >= 2);
  assert.equal(events.some((e) => e.type === 'approval'), false, 'nem chega a perguntar');
  assert.equal(dev.status({ local: true }).canWrite, false);
});

test('execução: sem somente leitura, no computador, grava SÓ depois de aprovar (e só do computador)', async () => {
  const { dev, root } = devWith({ readOnly: false, replies: [json('write_file', { path: 'novo.js', content: 'ok\n' }), 'Criei.'] });
  const { runId, approval } = await dev.startRun({ projectId: 'demo', message: 'crie novo.js', local: true });
  assert.equal(approval, 'ask');
  let approvalEvent;
  for (let i = 0; i < 100 && !approvalEvent; i++) { approvalEvent = dev.getEvents(runId, 0).events.find((e) => e.type === 'approval'); await sleep(20); }
  assert.ok(approvalEvent, 'pedido de aprovação aparece');
  assert.match(approvalEvent.preview, /novo\.js/);
  assert.equal(fs.existsSync(path.join(root, 'novo.js')), false, 'nada gravado antes de aprovar');
  assert.throws(() => dev.answerApproval(runId, approvalEvent.id, true, { local: false }), (e) => e.status === 403);
  assert.equal(dev.answerApproval(runId, approvalEvent.id, true, { local: true }).ok, true);
  const { events } = await waitDone(dev, runId);
  assert.equal(fs.readFileSync(path.join(root, 'novo.js'), 'utf8'), 'ok\n');
  assert.deepEqual(events.find((e) => e.type === 'done').changed, ['novo.js']);
  assert.ok(events.some((e) => e.type === 'approval_done' && e.approved === true));
  assert.throws(() => dev.answerApproval(runId, approvalEvent.id, true, { local: true }), (e) => e.status === 404, 'só vale uma vez');
});

test('execução: negar a aprovação não grava', async () => {
  const { dev, root } = devWith({ readOnly: false, replies: [json('write_file', { path: 'x.js', content: 'x' }), 'Ok, não gravei.'] });
  const { runId } = await dev.startRun({ projectId: 'demo', message: 'x', local: true });
  let a;
  for (let i = 0; i < 100 && !a; i++) { a = dev.getEvents(runId, 0).events.find((e) => e.type === 'approval'); await sleep(20); }
  dev.answerApproval(runId, a.id, false, { local: true });
  await waitDone(dev, runId);
  assert.equal(fs.existsSync(path.join(root, 'x.js')), false);
});

test('execução: pedido que NÃO vem do computador (celular) é somente leitura mesmo com tudo liberado', async () => {
  const { dev, root } = devWith({ readOnly: false, replies: [json('write_file', { path: 'x.js', content: 'x' }), 'Entendi.'] });
  const { runId, approval } = await dev.startRun({ projectId: 'demo', message: 'x', local: false });
  assert.equal(approval, 'readonly');
  const { events } = await waitDone(dev, runId);
  assert.equal(fs.existsSync(path.join(root, 'x.js')), false);
  assert.ok(events.some((e) => e.type === 'tool' && e.status === 'denied'));
  assert.equal(dev.status({ local: false }).canWrite, false);
  assert.equal(dev.status({ local: true }).canWrite, true);
});

test('execução: só uma por vez; cancelar libera; execução inexistente dá 404', async () => {
  const slow = { async chat(_r, { signal }) { await new Promise((resolve, reject) => { const t = setTimeout(resolve, 5000); signal.addEventListener('abort', () => { clearTimeout(t); reject(new Error('cancelado')); }); }); return { text: 'x', provider: 'f', model: 'm' }; } };
  const root = makeProject();
  const dev = createDev({ env: { YUI_DEV_ENABLED: 'true', YUI_PROJECTS: `Demo=${root}`, YUI_DEV_PROJECTS_FILE: path.join(mk(), 'p.json') }, llm: slow, historyDir: path.join(mk(), 'h'), indexDir: path.join(mk(), 'i') });
  const { runId } = await dev.startRun({ projectId: 'demo', message: 'a', local: true });
  await assert.rejects(dev.startRun({ projectId: 'demo', message: 'b', local: true }), (e) => e.status === 409);
  assert.equal(dev.isBusy(), true);
  assert.equal(dev.cancel(runId).ok, true);
  const { status } = await waitDone(dev, runId);
  assert.equal(status, 'cancelled');
  assert.equal(dev.isBusy(), false);
  assert.throws(() => dev.getEvents('nao-existe'), (e) => e.status === 404);
  await assert.rejects(dev.startRun({ projectId: 'outro', message: 'x', local: true }), (e) => e.status === 404);
  await assert.rejects(dev.startRun({ projectId: 'demo', message: '   ', local: true }), (e) => e.status === 400);
});

test('execução: erro da IA vira evento "done" com erro (não derruba a Yui)', async () => {
  const root = makeProject();
  const llm = { chat: async () => { throw new Error('Nenhuma IA respondeu: tudo fora'); } };
  const dev = createDev({ env: { YUI_DEV_ENABLED: 'true', YUI_PROJECTS: `Demo=${root}`, YUI_DEV_PROJECTS_FILE: path.join(mk(), 'p.json') }, llm, historyDir: path.join(mk(), 'h'), indexDir: path.join(mk(), 'i') });
  const { runId } = await dev.startRun({ projectId: 'demo', message: 'oi', local: true });
  const { status, events } = await waitDone(dev, runId);
  assert.equal(status, 'error');
  assert.match(events.at(-1).error, /Nenhuma IA respondeu/);
  assert.equal((await dev.history.load('demo')).length, 0, 'conversa com erro não vira histórico');
});

test('projeto: lista pastas e lê arquivos; .env e fora do projeto são recusados', async () => {
  const { dev } = devWith();
  assert.deepEqual((await dev.tree('demo')).map((i) => i.name), ['src']);
  assert.equal((await dev.readFile('demo', 'src/soma.js')).language, 'javascript');
  await assert.rejects(dev.readFile('demo', '.env'), /sensível/);
  await assert.rejects(dev.readFile('demo', '../fora.txt'), /fora do projeto/);
});

// ───────── API (HTTP) ─────────

function startApi(dev) {
  const OWNER = 'owner-token-0123456789';
  const MEMBER = 'member-token-0123456789';
  const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`), dev, loginDelayMs: 0 });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    const call = (method, route, { token = OWNER, body, headers = {} } = {}) => new Promise((res, rej) => {
      const data = body === undefined ? null : JSON.stringify(body);
      const req = http.request(base + route, { method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(data ? { 'Content-Type': 'application/json' } : {}), ...headers } }, (r) => {
        let raw = '';
        r.on('data', (c) => { raw += c; });
        r.on('end', () => res({ status: r.statusCode, json: raw ? JSON.parse(raw) : null }));
      });
      req.on('error', rej);
      if (data) req.write(data);
      req.end();
    });
    resolve({ call, MEMBER, close: () => server.close() });
  }));
}

const REMOTE = { 'X-Forwarded-For': '100.64.0.9', 'Tailscale-User-Login': 'mauro@exemplo.com' };

test('API: só o dono; sem token é 401; membro é 403 em TODAS as rotas /v1/dev', async () => {
  const { dev } = devWith();
  const api = await startApi(dev);
  const routes = [['GET', '/v1/dev/status'], ['POST', '/v1/dev/projects', { name: 'x', path: 'x' }], ['DELETE', '/v1/dev/projects/demo'], ['GET', '/v1/dev/projects/demo/tree'], ['GET', '/v1/dev/projects/demo/file?path=a'], ['GET', '/v1/dev/projects/demo/history'], ['DELETE', '/v1/dev/projects/demo/history'], ['POST', '/v1/dev/projects/demo/runs', { message: 'oi' }], ['GET', '/v1/dev/runs/abc/events'], ['POST', '/v1/dev/runs/abc/approvals/def', { approve: true }], ['POST', '/v1/dev/runs/abc/cancel', {}]];
  for (const [m, r, b] of routes) {
    assert.equal((await api.call(m, r, { token: api.MEMBER, body: b })).status, 403, `${m} ${r}`);
    assert.equal((await api.call(m, r, { token: null, body: b })).status, 401, `${m} ${r} sem token`);
  }
  api.close();
});

test('API: status mostra desligado sem erro; o resto responde 503 quando YUI_DEV_ENABLED=false', async () => {
  const { dev } = devWith({ enabled: false });
  const api = await startApi(dev);
  const st = await api.call('GET', '/v1/dev/status');
  assert.equal(st.status, 200);
  assert.equal(st.json.enabled, false);
  assert.equal((await api.call('GET', '/v1/dev/projects/demo/tree')).status, 503);
  assert.equal((await api.call('POST', '/v1/dev/projects/demo/runs', { body: { message: 'oi' } })).status, 503);
  api.close();
});

test('API: conversa completa pelo HTTP (iniciar, acompanhar eventos, ler arquivo, histórico)', async () => {
  const { dev } = devWith({ replies: [json('list_dir', {}), 'O projeto tem a pasta src.'] });
  const api = await startApi(dev);
  const st = (await api.call('GET', '/v1/dev/status')).json;
  assert.equal(st.enabled, true);
  assert.equal(st.local, true);
  assert.deepEqual(st.projects.map((p) => p.id), ['demo']);
  assert.ok(st.modes.some((m) => m.id === 'reviewer' && m.readOnly));

  assert.equal((await api.call('GET', '/v1/dev/projects/demo/tree')).json.items[0].name, 'src');
  assert.equal((await api.call('GET', '/v1/dev/projects/demo/file?path=src/soma.js')).json.file.language, 'javascript');
  assert.equal((await api.call('GET', '/v1/dev/projects/demo/file?path=.env')).status, 400);
  assert.equal((await api.call('GET', '/v1/dev/projects/demo/file?path=../../x')).status, 400);
  assert.equal((await api.call('GET', '/v1/dev/projects/naoexiste/tree')).status, 404);

  const start = await api.call('POST', '/v1/dev/projects/demo/runs', { body: { message: 'liste o projeto', mode: 'yui' } });
  assert.equal(start.status, 200);
  let after = 0;
  let done = false;
  const seen = [];
  for (let i = 0; i < 200 && !done; i++) {
    const ev = (await api.call('GET', `/v1/dev/runs/${start.json.runId}/events?after=${after}`)).json;
    for (const e of ev.events) { seen.push(e.type); after = e.seq; if (e.type === 'done') done = true; }
    await sleep(20);
  }
  assert.ok(done);
  assert.ok(seen.includes('final'));
  assert.equal((await api.call('GET', '/v1/dev/projects/demo/history')).json.messages.length, 2);
  assert.equal((await api.call('DELETE', '/v1/dev/projects/demo/history')).status, 200);
  assert.equal((await api.call('GET', '/v1/dev/projects/demo/history')).json.messages.length, 0);
  api.close();
});

test('API: pelo celular (Tailscale) não cadastra projeto, não aprova e a execução é somente leitura', async () => {
  const { dev, root } = devWith({ readOnly: false, replies: [json('write_file', { path: 'x.js', content: 'x' }), 'ok'] });
  const api = await startApi(dev);
  const remoteStatus = (await api.call('GET', '/v1/dev/status', { headers: REMOTE })).json;
  assert.equal(remoteStatus.local, false);
  assert.equal(remoteStatus.canWrite, false);
  assert.equal((await api.call('POST', '/v1/dev/projects', { headers: REMOTE, body: { name: 'novo', path: root } })).status, 403);
  assert.equal((await api.call('DELETE', '/v1/dev/projects/demo', { headers: REMOTE })).status, 403);

  const start = await api.call('POST', '/v1/dev/projects/demo/runs', { headers: REMOTE, body: { message: 'x' } });
  assert.equal(start.json.approval, 'readonly');
  await waitDone(dev, start.json.runId);
  assert.equal(fs.existsSync(path.join(root, 'x.js')), false);
  assert.equal((await api.call('POST', `/v1/dev/runs/${start.json.runId}/approvals/qualquer`, { headers: REMOTE, body: { approve: true } })).status, 403);
  api.close();
});

test('API: cadastrar projeto no computador valida a pasta e entra na lista', async () => {
  const { dev } = devWith();
  const api = await startApi(dev);
  const folder = mk();
  const ok = await api.call('POST', '/v1/dev/projects', { body: { name: 'Pasta Nova', path: folder } });
  assert.equal(ok.status, 200);
  assert.equal(ok.json.project.id, 'pasta-nova');
  assert.ok((await api.call('GET', '/v1/dev/status')).json.projects.some((p) => p.id === 'pasta-nova'));
  assert.equal((await api.call('POST', '/v1/dev/projects', { body: { name: 'Raiz', path: path.parse(folder).root } })).status, 400);
  assert.equal((await api.call('POST', '/v1/dev/projects', { body: { name: 'Pasta Nova', path: folder } })).status, 409);
  assert.equal((await api.call('DELETE', '/v1/dev/projects/demo')).status, 400, 'projeto do .env não sai pelo app');
  assert.equal((await api.call('DELETE', '/v1/dev/projects/pasta-nova')).status, 200);
  assert.equal((await api.call('GET', '/v1/dev/foo')).status, 404);
  api.close();
});

test('isLocalRequest: loopback sem cabeçalhos de proxy', () => {
  const req = (addr, headers = {}) => ({ socket: { remoteAddress: addr }, headers });
  assert.equal(isLocalRequest(req('127.0.0.1')), true);
  assert.equal(isLocalRequest(req('::1')), true);
  assert.equal(isLocalRequest(req('::ffff:127.0.0.1')), true);
  assert.equal(isLocalRequest(req('192.168.0.5')), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'x-forwarded-for': '1.2.3.4' })), false);
  assert.equal(isLocalRequest(req('127.0.0.1', { 'tailscale-user-login': 'a@b' })), false);
  assert.ok(createDevRoutes);
});
