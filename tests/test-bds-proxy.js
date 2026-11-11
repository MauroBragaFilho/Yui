// Testes da ponte do painel da Yui com o BDS Server (BDS de mentira em HTTP, sem rede de verdade).
// Execução: npm run test:bdsproxy
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-bds-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'true';

const { initMemory } = await import('../src/core/index.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const { createBdsProxy, LINK_TTL_MS } = await import('../src/core/api/bds.js');
await initMemory();

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };

// ── BDS Server de mentira ──
const seen = [];
const FILE = Buffer.from('0123456789'.repeat(100)); // 1000 bytes
const fake = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  const rec = { method: req.method, route: url.pathname, query: Object.fromEntries(url.searchParams), headers: req.headers, body: '' };
  seen.push(rec);
  const json = (s, o) => { res.writeHead(s, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(o)); };
  if (url.pathname === '/api/files/upload' && req.method === 'PUT') {
    let n = 0; for await (const c of req) n += c.length;
    rec.bytes = n;
    return json(200, { ok: true, caminho: url.searchParams.get('caminho'), bytes: n });
  }
  for await (const c of req) rec.body += c;
  if (url.pathname === '/api/files/download') {
    if (url.searchParams.get('caminho') === 'C:\\BDS\\nao-existe.mp4') return json(404, { erro: 'Arquivo nao encontrado.' });
    const range = /bytes=(\d+)-(\d*)/.exec(req.headers.range || '');
    if (range) {
      const a = Number(range[1]); const b = range[2] ? Number(range[2]) : FILE.length - 1;
      res.writeHead(206, { 'Content-Type': 'video/mp4', 'Content-Length': b - a + 1, 'Content-Range': `bytes ${a}-${b}/${FILE.length}`, 'Accept-Ranges': 'bytes', 'Set-Cookie': 'segredo=1' });
      return res.end(FILE.subarray(a, b + 1));
    }
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': FILE.length, 'Accept-Ranges': 'bytes' });
    return res.end(FILE);
  }
  if (url.pathname === '/api/files/delete') {
    const b = JSON.parse(rec.body || '{}');
    if (b.confirmar !== true) return json(400, { erro: 'Confirmacao necessaria para excluir.' });
    return json(200, { ok: true, movidoPara: 'lixeira' });
  }
  if (url.pathname === '/api/files/list') return json(200, { caminho: url.searchParams.get('caminho'), itens: [{ nome: 'Filmes', tipo: 'pasta' }] });
  if (url.pathname === '/api/status') return json(200, { versao: 'x', disco: { usado: 1 } });
  return json(200, { ok: true });
});
await new Promise((r) => fake.listen(0, '127.0.0.1', r));
const fakeUrl = `http://127.0.0.1:${fake.address().port}`;

let clock = 1_000_000;
let cfg = { enabled: true, url: fakeUrl, key: '', timeoutMs: 8000 };
const bds = createBdsProxy({ readConfig: () => cfg, now: () => clock });

const OWNER = 'owner-token-0123456789';
const MEMBER = 'member-token-0123456789';
const server = createApiServer({ tokens: parseTokens(`${OWNER}=111,${MEMBER}=222`), bds });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, route, { token = OWNER, body, headers = {}, raw } = {}) {
  const res = await fetch(base + route, {
    method,
    headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers },
    body: raw ?? (body ? JSON.stringify(body) : undefined),
  });
  const text = await res.text();
  let json = null; try { json = JSON.parse(text); } catch { /* não é JSON */ }
  return { status: res.status, json, text, headers: res.headers };
}
const last = () => seen[seen.length - 1];

console.log('Ponte Yui <-> BDS Server');

await test('só o dono entra; sem token não entra', async () => {
  assert.equal((await call('GET', '/v1/admin/bds/roots', { token: MEMBER })).status, 403);
  assert.equal((await call('GET', '/v1/admin/bds/roots', { token: null })).status, 401);
});

await test('listar repassa o caminho; leitura não leva o cabeçalho de escrita', async () => {
  const r = await call('GET', `/v1/admin/bds/list?caminho=${encodeURIComponent('C:\\BDS-Dados\\Filmes')}`);
  assert.equal(r.status, 200);
  assert.equal(r.json.itens[0].nome, 'Filmes');
  assert.equal(last().route, '/api/files/list');
  assert.equal(last().query.caminho, 'C:\\BDS-Dados\\Filmes');
  assert.equal(last().headers['x-bds-client'], undefined, 'GET não leva X-BDS-Client');
  assert.equal((await call('GET', '/v1/admin/bds/status')).json.versao, 'x');
});

await test('escrita leva X-BDS-Client; só as chaves permitidas passam; a chave do BDS vai como Bearer quando existe', async () => {
  cfg = { ...cfg, key: 'chave-do-bds' };
  const r = await call('POST', '/v1/admin/bds/mkdir', { body: { caminho: 'C:\\BDS-Dados\\Nova', intruso: 'x', outro: 1 } });
  assert.equal(r.status, 200);
  assert.equal(last().headers['x-bds-client'], 'web');
  assert.equal(last().headers.authorization, 'Bearer chave-do-bds');
  assert.deepEqual(JSON.parse(last().body), { caminho: 'C:\\BDS-Dados\\Nova' }, 'campos fora da lista não passam');
  cfg = { ...cfg, key: '' };
  await call('POST', '/v1/admin/bds/rename', { body: { de: 'a', para: 'b', x: 1 } });
  assert.deepEqual(JSON.parse(last().body), { de: 'a', para: 'b' });
});

await test('apagar exige confirmação e o erro do BDS volta com a mesma mensagem e status', async () => {
  const sem = await call('POST', '/v1/admin/bds/delete', { body: { caminho: 'C:\\x\\a.txt' } });
  assert.equal(sem.status, 400);
  assert.match(sem.json.error, /Confirmacao necessaria/);
  const com = await call('POST', '/v1/admin/bds/delete', { body: { caminho: 'C:\\x\\a.txt', confirmar: true } });
  assert.equal(com.status, 200);
  assert.equal(com.json.movidoPara, 'lixeira');
});

await test('rota desconhecida: 404; BDS fora do ar: 504 com mensagem clara; sem YUI_BDS_URL: 503', async () => {
  assert.equal((await call('GET', '/v1/admin/bds/executar')).status, 404);
  const old = cfg;
  cfg = { ...old, url: 'http://127.0.0.1:9' };
  const off = await call('GET', '/v1/admin/bds/status');
  assert.equal(off.status, 504);
  assert.match(off.json.error, /BDS Server/);
  cfg = { ...old, enabled: false };
  const none = await call('GET', '/v1/admin/bds/status');
  assert.equal(none.status, 503);
  assert.match(none.json.error, /YUI_BDS_URL/);
  cfg = old;
});

await test('enviar arquivo grande em fluxo: o BDS recebe todos os bytes (3 MB) sem passar pelo limite de 64 KB', async () => {
  const body = Buffer.alloc(3 * 1024 * 1024, 7);
  const r = await call('PUT', `/v1/admin/bds/upload?caminho=${encodeURIComponent('C:\\BDS-Dados\\Filmes\\f.mp4')}`, { raw: body, headers: { 'Content-Type': 'application/octet-stream' } });
  assert.equal(r.status, 200, r.text);
  assert.equal(r.json.bytes, body.length);
  assert.equal(last().bytes, body.length);
  assert.equal(last().headers['x-bds-client'], 'web');
  assert.equal(last().headers['content-length'], String(body.length));
  assert.equal((await call('PUT', '/v1/admin/bds/upload', { raw: Buffer.from('x') })).status, 400, 'sem caminho: recusa');
});

await test('link curto: abre sem login, repassa Range, não vaza Set-Cookie e fica preso a UM caminho', async () => {
  const l = await call('POST', '/v1/admin/bds/link', { body: { caminho: 'C:\\BDS-Dados\\Filmes\\f.mp4', inline: true } });
  assert.equal(l.status, 200);
  assert.match(l.json.url, /^\/v1\/bds\/get\/[\w-]{20,}$/);
  // sem Authorization (é o que o <video> faz)
  const full = await fetch(base + l.json.url);
  assert.equal(full.status, 200);
  assert.equal(full.headers.get('content-type'), 'video/mp4');
  assert.equal((await full.arrayBuffer()).byteLength, FILE.length);
  assert.equal(last().query.inline, '1');
  const part = await fetch(base + l.json.url, { headers: { Range: 'bytes=10-19' } });
  assert.equal(part.status, 206);
  assert.equal(part.headers.get('content-range'), `bytes 10-19/${FILE.length}`);
  assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '0123456789');
  assert.equal(last().headers.range, 'bytes=10-19');
  assert.equal(part.headers.get('set-cookie'), null, 'cookie do BDS não passa');
  assert.equal(part.headers.get('cache-control'), 'no-store');
});

await test('link inválido, vencido ou de membro não funciona', async () => {
  assert.equal((await fetch(base + '/v1/bds/get/token-que-nao-existe-123456')).status, 404);
  assert.equal((await call('POST', '/v1/admin/bds/link', { token: MEMBER, body: { caminho: 'C:\\x' } })).status, 403);
  const l = await call('POST', '/v1/admin/bds/link', { body: { caminho: 'C:\\BDS-Dados\\Filmes\\f.mp4' } });
  assert.equal((await fetch(base + l.json.url)).status, 200);
  clock += LINK_TTL_MS + 1000; // passou o tempo
  assert.equal((await fetch(base + l.json.url)).status, 404, 'vencido');
  assert.equal((await call('POST', '/v1/admin/bds/link', { body: {} })).status, 400, 'sem caminho');
});

await test('arquivo que não existe no BDS: o link devolve o erro dele (404), sem travar', async () => {
  const l = await call('POST', '/v1/admin/bds/link', { body: { caminho: 'C:\\BDS\\nao-existe.mp4' } });
  const r = await fetch(base + l.json.url);
  assert.equal(r.status, 404);
  assert.match((await r.json()).error, /nao encontrado/i);
});

await test('as escritas ficam na auditoria da Yui (sem o caminho dos arquivos)', async () => {
  const lines = fs.readFileSync(process.env.YUI_AUDIT_FILE, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  const events = lines.map((e) => e.event);
  for (const ev of ['admin.bds.mkdir', 'admin.bds.rename', 'admin.bds.delete', 'admin.bds.upload', 'admin.bds.link']) assert.ok(events.includes(ev), ev);
  assert.equal(JSON.stringify(lines).includes('Filmes'), false, 'nenhum caminho vai para a auditoria');
});

server.close(); fake.close(); fake.closeAllConnections?.();
console.log(`\n${passed} testes OK`);
process.exit(0);
