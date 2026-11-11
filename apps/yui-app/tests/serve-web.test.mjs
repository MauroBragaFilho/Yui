// Servidor do painel: arquivos, fallback de SPA e repasse de /api/* ao BDS Server (de mentira). Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWebServer, parsePorts } from '../scripts/serve-web.mjs';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-serve-'));
fs.writeFileSync(path.join(root, 'index.html'), '<html>PAINEL DA YUI</html>');
fs.mkdirSync(path.join(root, 'fonts'));
fs.writeFileSync(path.join(root, 'fonts', 'a.woff2'), 'fonte');

const seen = [];
const FILE = Buffer.from('0123456789'.repeat(100));
const upstream = http.createServer(async (req, res) => {
  const rec = { method: req.method, url: req.url, headers: req.headers, bytes: 0 };
  seen.push(rec);
  for await (const c of req) rec.bytes += c.length;
  if (req.url.startsWith('/api/files/download')) {
    const m = /bytes=(\d+)-(\d+)/.exec(req.headers.range || '');
    if (m) { res.writeHead(206, { 'Content-Range': `bytes ${m[1]}-${m[2]}/${FILE.length}`, 'Content-Type': 'video/mp4', 'Accept-Ranges': 'bytes' }); return res.end(FILE.subarray(Number(m[1]), Number(m[2]) + 1)); }
    res.writeHead(200, { 'Content-Type': 'video/mp4' });
    return res.end(FILE);
  }
  if (req.url.startsWith('/api/files/upload')) { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end(JSON.stringify({ ok: true, bytes: rec.bytes })); }
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({ ok: true, via: 'bds' }));
});
await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
const upUrl = `http://127.0.0.1:${upstream.address().port}`;

async function start(opts) {
  const s = createWebServer({ root, ...opts });
  await new Promise((r) => s.listen(0, '127.0.0.1', r));
  return { s, base: `http://127.0.0.1:${s.address().port}` };
}

test('serve o painel, os arquivos e o fallback de SPA; bloqueia sair da pasta', async () => {
  const { s, base } = await start();
  try {
    assert.match(await (await fetch(base + '/')).text(), /PAINEL DA YUI/);
    assert.equal(await (await fetch(base + '/fonts/a.woff2')).text(), 'fonte');
    assert.equal((await fetch(base + '/fonts/a.woff2')).headers.get('content-type'), 'font/woff2');
    assert.match(await (await fetch(base + '/rota/qualquer')).text(), /PAINEL DA YUI/, 'SPA: rota desconhecida volta ao index');
    // sem BDS configurado, /api não é repassado: cai no painel (comportamento antigo)
    assert.match(await (await fetch(base + '/api/health')).text(), /PAINEL DA YUI/);
    const traversal = await new Promise((resolve) => {
      const r = http.request({ host: '127.0.0.1', port: s.address().port, path: '/..%2f..%2fetc%2fpasswd' }, (res) => { res.resume(); resolve(res.statusCode); });
      r.end();
    });
    assert.ok(traversal === 403 || traversal === 200, 'nunca serve fora da pasta'); // 200 só se cair no index
    assert.equal((await (await fetch(base + '/..%2f..%2fpackage.json')).text()).includes('"name"'), false);
  } finally { s.close(); }
});

test('com BDS_API_UPSTREAM: /api/* vai para o BDS Server, o resto continua sendo o painel', async () => {
  const { s, base } = await start({ upstream: upUrl });
  try {
    assert.match(await (await fetch(base + '/')).text(), /PAINEL DA YUI/);
    const h = await (await fetch(base + '/api/health')).json();
    assert.deepEqual(h, { ok: true, via: 'bds' });
    const rec = seen.at(-1);
    assert.equal(rec.url, '/api/health');
    assert.equal(rec.headers.host, base.replace('http://', ''), 'o Host original segue (o BDS confere o nome)');
    assert.match(rec.headers['x-forwarded-for'], /127\.0\.0\.1/);
    assert.equal(rec.headers.connection === 'close' || rec.headers.connection === 'keep-alive' || rec.headers.connection === undefined, true);
  } finally { s.close(); }
});

test('envio de 3 MB em fluxo, download com Range e métodos de escrita passam pelo repasse', async () => {
  const { s, base } = await start({ upstream: upUrl });
  try {
    const body = Buffer.alloc(3 * 1024 * 1024, 5);
    const up = await (await fetch(base + '/api/files/upload?caminho=x', { method: 'PUT', body, headers: { 'X-BDS-Client': 'web' } })).json();
    assert.equal(up.bytes, body.length);
    assert.equal(seen.at(-1).headers['x-bds-client'], 'web', 'cabeçalhos do cliente atravessam');
    const part = await fetch(base + '/api/files/download?caminho=x', { headers: { Range: 'bytes=10-19' } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get('content-range'), `bytes 10-19/${FILE.length}`);
    assert.equal(Buffer.from(await part.arrayBuffer()).toString(), '0123456789');
    const post = await fetch(base + '/api/files/mkdir', { method: 'POST', body: JSON.stringify({ caminho: 'a' }), headers: { 'content-type': 'application/json' } });
    assert.equal(post.status, 200);
    assert.equal(seen.at(-1).method, 'POST');
  } finally { s.close(); }
});

test('BDS Server fora do ar: 502 com mensagem clara, sem derrubar o painel', async () => {
  const { s, base } = await start({ upstream: 'http://127.0.0.1:9' });
  try {
    const r = await fetch(base + '/api/status');
    assert.equal(r.status, 502);
    assert.match((await r.json()).erro, /BDS Server/);
    assert.match(await (await fetch(base + '/')).text(), /PAINEL DA YUI/, 'o painel segue de pé');
  } finally { s.close(); }
});

test('portas: uma ou várias, sem repetir, ignorando lixo', () => {
  assert.deepEqual(parsePorts({}), [8081]);
  assert.deepEqual(parsePorts({ PORT: '3000' }), [3000]);
  assert.deepEqual(parsePorts({ PORTS: '80, 8081,80' }), [80, 8081]);
  assert.deepEqual(parsePorts({ PORTS: 'abc,0,99999' }), [8081]);
});

test.after(() => { upstream.close(); upstream.closeAllConnections?.(); fs.rmSync(root, { recursive: true, force: true }); });
