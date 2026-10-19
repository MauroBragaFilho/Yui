// Corpo grande demais nos servidores HTTP da Yui (TG-32): responder 413 em vez de ECONNRESET.
// Cobre a Yui API (src/core/api/server.js) e o Gateway (src/gateway/server.js).
// Sem rede externa: porta 0 em 127.0.0.1, backends falsos, banco/auditoria em pasta temporária.
// Execução: npm run test:http-413
import assert from 'assert';
import fs from 'fs';
import http from 'http';
import net from 'net';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-413-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
process.env.YUI_MEMORY_ENABLED = 'false';
process.env.LOG_LEVEL = 'error';
delete process.env.AI_BASE_URL;
delete process.env.AI_BACKEND;
process.chdir(tmp); // o logger grava em ./logs (relativo ao cwd): nada vai para os logs reais da Yui

const ai = await import('../src/core/ai/manager.js');
const { createApiServer, parseTokens } = await import('../src/core/api/server.js');
const gateway = await import('../src/gateway/server.js');
const { logger } = await import('../src/utils/logger.js');

// Qualquer rejeição esquecida (ex.: readJson rejeitado depois que o handler terminou) derruba o teste.
const unhandled = [];
process.on('unhandledRejection', (e) => unhandled.push(e));

let passed = 0;
let failed = 0;
const test = async (name, fn) => {
  try {
    await fn();
    passed++;
    console.log(`  ok    ${name}`);
  } catch (err) {
    failed++;
    console.log(`  FALHA ${name}\n        ${err.stack || err.message}`);
  }
};

const OWNER = 'owner-token-0123456789';
const GKEY = 'gateway-key-0123456789';
ai.registerBackend({ name: 'fake', local: false, async chat(args) { return `eco: ${args.prompt}`; } }, { activate: true });

const api = createApiServer({ tokens: parseTokens(`${OWNER}=111`) });
const gw = gateway.createGatewayServer({
  router: {
    status: () => ({ providers: [] }),
    models: () => [],
    chat: async () => ({ ok: true }),
    chatStream: async () => { throw new Error('não usado'); },
  },
  keys: gateway.parseGatewayKeys(GKEY),
});
for (const s of [api, gw]) await new Promise((r) => s.listen(0, '127.0.0.1', r));
const apiPort = api.address().port;
const gwPort = gw.address().port;

/**
 * POST cru (http.request). `body` é um Buffer; `chunked: true` não declara Content-Length.
 * Resolve com { status, json, error }: `error` só se a conexão cair ANTES da resposta chegar.
 */
function post(port, route, token, body, { chunked = false, agent, close = false } = {}) {
  return new Promise((resolve) => {
    const out = { status: null, json: null, error: null };
    const headers = { 'Content-Type': 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    if (!chunked) headers['Content-Length'] = body.length;
    const req = http.request({ host: '127.0.0.1', port, path: route, method: 'POST', headers, agent: close ? false : agent }, (res) => {
      let text = '';
      out.status = res.statusCode;
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { try { out.json = JSON.parse(text); } catch { /* corpo não-JSON */ } resolve(out); });
    });
    req.on('error', (e) => { if (out.status === null) out.error = e.code || e.message; resolve(out); }); // erro DEPOIS da resposta não conta
    if (chunked) { req.write(body); req.end(); } // write antes do end => Transfer-Encoding: chunked
    else req.end(body);
    setTimeout(() => { out.error ??= 'timeout'; req.destroy(); resolve(out); }, 20000).unref();
  });
}
/** HTTP/1.0 cru (sem keep-alive): o servidor fecha a conexão depois de responder. Devolve { statusLine, error }. */
function postHttp10(port, route, token, body) {
  return new Promise((resolve) => {
    const out = { statusLine: null, error: null };
    let got = '';
    const sock = net.connect(port, '127.0.0.1', () => {
      sock.write(`POST ${route} HTTP/1.0\r\nAuthorization: Bearer ${token}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n`);
      sock.write(body);
    });
    sock.on('data', (c) => { got += c.toString('latin1'); });
    sock.on('error', (e) => { out.error = e.code || e.message; });
    sock.on('close', () => { out.statusLine = got.split('\r\n')[0] || null; resolve(out); });
    setTimeout(() => { out.error ??= 'timeout'; sock.destroy(); }, 20000).unref();
  });
}
const filler = (n, ch = 0x61) => Buffer.alloc(n, ch);
/** JSON {"<campo>":"aaa..."} com exatamente `total` bytes. */
function jsonOfSize(total, prefix, suffix) {
  const pad = total - Buffer.byteLength(prefix) - Buffer.byteLength(suffix);
  assert.ok(pad >= 0);
  const b = Buffer.from(prefix + 'a'.repeat(pad) + suffix);
  assert.equal(b.length, total);
  return b;
}
const chat = (message) => Buffer.from(JSON.stringify({ message }));
const mb = (n) => n * 1024 * 1024;

console.log('Yui API: corpo acima de 64 KB');
await test('65 KB com Content-Length -> 413 (nunca ECONNRESET)', async () => {
  const r = await post(apiPort, '/v1/chat', OWNER, filler(65 * 1024));
  assert.equal(r.error, null);
  assert.equal(r.status, 413);
  assert.equal(r.json?.error, 'Corpo muito grande');
});
await test('o mesmo pedido pelo fetch do Node (o que o app usa) -> 413, sem exceção', async () => {
  const res = await fetch(`http://127.0.0.1:${apiPort}/v1/chat`, { method: 'POST', headers: { Authorization: `Bearer ${OWNER}` }, body: 'a'.repeat(70 * 1024) });
  assert.equal(res.status, 413);
  assert.equal((await res.json()).error, 'Corpo muito grande');
});
await test('10 MB -> 413 e o servidor segue vivo', async () => {
  const r = await post(apiPort, '/v1/chat', OWNER, filler(mb(10)));
  assert.equal(r.error, null);
  assert.equal(r.status, 413);
  const ok = await post(apiPort, '/v1/chat', OWNER, chat('oi'));
  assert.equal(ok.status, 200);
  assert.equal(ok.json.reply, 'eco: oi');
});
await test('40 MB (acima do teto de descarte) -> o 413 chega do mesmo jeito; servidor segue vivo', async () => {
  // agente próprio: o servidor corta a conexão depois de 32 MB descartados, e um socket assim não pode voltar para o pool global (reuso de socket morto = ECONNRESET que não é do servidor)
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const r = await post(apiPort, '/v1/chat', OWNER, filler(mb(40)), { agent });
    assert.equal(r.status, 413);
  } finally {
    agent.destroy();
  }
  assert.equal((await post(apiPort, '/v1/chat', OWNER, chat('oi'), { close: true })).status, 200);
});
await test('sem Content-Length (chunked) com 200 KB -> 413', async () => {
  const r = await post(apiPort, '/v1/chat', OWNER, filler(200 * 1024), { chunked: true });
  assert.equal(r.error, null);
  assert.equal(r.status, 413);
});
await test('limite exato: 64 KB passa pela leitura (vira 400 por message > 4000), 64 KB + 1 byte -> 413', async () => {
  const exact = jsonOfSize(64 * 1024, '{"message":"', '"}');
  const r = await post(apiPort, '/v1/chat', OWNER, exact);
  assert.equal(r.status, 400, JSON.stringify(r));
  assert.match(r.json.error, /excede/);
  const over = jsonOfSize(64 * 1024 + 1, '{"message":"', '"}');
  assert.equal((await post(apiPort, '/v1/chat', OWNER, over)).status, 413);
});
await test('conexão keep-alive: depois do 413 a MESMA conexão atende o pedido seguinte', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await post(apiPort, '/v1/chat', OWNER, filler(mb(1)), { agent });
    assert.equal(first.error, null);
    assert.equal(first.status, 413);
    const second = await post(apiPort, '/v1/chat', OWNER, chat('de novo'), { agent });
    assert.equal(second.error, null);
    assert.equal(second.status, 200);
    assert.equal(second.json.reply, 'eco: de novo');
  } finally {
    agent.destroy();
  }
});
await test('cliente SEM keep-alive ("Connection: close") com 1 MB e 10 MB -> 413 (a resposta espera o corpo ser descartado)', async () => {
  for (const n of [mb(1), mb(10)]) {
    const r = await post(apiPort, '/v1/chat', OWNER, filler(n), { close: true });
    assert.equal(r.error, null, `${n} bytes: ${r.error}`);
    assert.equal(r.status, 413, `${n} bytes`);
  }
});
await test('HTTP/1.0 cru com 5 MB -> 413', async () => {
  const r = await postHttp10(apiPort, '/v1/chat', OWNER, filler(mb(5)));
  assert.equal(r.error, null);
  assert.match(r.statusLine, / 413 /);
});
await test('sem token, corpo grande continua 401 (a autenticação vem antes da leitura)', async () => {
  const r = await post(apiPort, '/v1/chat', null, filler(mb(1)));
  assert.equal(r.status, 401);
});
await test('cliente que desiste no meio do envio: nenhum logger.error com pilha, nenhuma rejeição esquecida', async () => {
  const errors = [];
  const original = logger.error;
  logger.error = (...a) => { errors.push(a.join(' ')); };
  try {
    await new Promise((resolve) => {
      const sock = net.connect(apiPort, '127.0.0.1', () => {
        sock.write(`POST /v1/chat HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${OWNER}\r\nContent-Type: application/json\r\nContent-Length: 1000\r\n\r\n{"message":"par`);
        setTimeout(() => sock.destroy(), 40);
      });
      sock.on('error', () => {});
      sock.on('close', resolve);
    });
    await new Promise((r) => setTimeout(r, 150));
  } finally {
    logger.error = original;
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(unhandled, []);
  assert.equal((await post(apiPort, '/v1/chat', OWNER, chat('vivo?'))).status, 200);
});

console.log('Gateway: corpo acima de 2 MB');
const chatBody = (content) => Buffer.from(JSON.stringify({ model: 'auto', messages: [{ role: 'user', content }] }));
await test('3 MB com Content-Length -> 413 no formato de erro da OpenAI', async () => {
  const r = await post(gwPort, '/v1/chat/completions', GKEY, filler(mb(3)));
  assert.equal(r.error, null);
  assert.equal(r.status, 413);
  assert.equal(r.json?.error?.message, 'Corpo muito grande');
  assert.equal(r.json.error.code, 413);
});
await test('o mesmo pedido pelo fetch do Node -> 413, sem exceção', async () => {
  const res = await fetch(`http://127.0.0.1:${gwPort}/v1/chat/completions`, { method: 'POST', headers: { Authorization: `Bearer ${GKEY}` }, body: 'a'.repeat(mb(3)) });
  assert.equal(res.status, 413);
});
await test('40 MB -> 413; servidor segue vivo', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 }); // veja o comentário do teste equivalente da API
  try {
    const r = await post(gwPort, '/v1/chat/completions', GKEY, filler(mb(40)), { agent });
    assert.equal(r.status, 413);
  } finally {
    agent.destroy();
  }
  assert.equal((await post(gwPort, '/v1/chat/completions', GKEY, chatBody('oi'), { close: true })).status, 200);
});
await test('sem Content-Length (chunked) com 3 MB -> 413', async () => {
  const r = await post(gwPort, '/v1/chat/completions', GKEY, filler(mb(3)), { chunked: true });
  assert.equal(r.error, null);
  assert.equal(r.status, 413);
});
await test('limite exato: 2 MB passam e chegam ao roteador, 2 MB + 1 byte -> 413', async () => {
  const prefix = '{"model":"auto","messages":[{"role":"user","content":"';
  const suffix = '"}]}';
  const exact = jsonOfSize(mb(2), prefix, suffix);
  const r = await post(gwPort, '/v1/chat/completions', GKEY, exact);
  assert.equal(r.status, 200, JSON.stringify(r));
  const over = jsonOfSize(mb(2) + 1, prefix, suffix);
  assert.equal((await post(gwPort, '/v1/chat/completions', GKEY, over)).status, 413);
});
await test('keep-alive: depois do 413 a MESMA conexão atende o pedido seguinte', async () => {
  const agent = new http.Agent({ keepAlive: true, maxSockets: 1 });
  try {
    const first = await post(gwPort, '/v1/chat/completions', GKEY, filler(mb(3)), { agent });
    assert.equal(first.error, null);
    assert.equal(first.status, 413);
    const second = await post(gwPort, '/v1/chat/completions', GKEY, chatBody('de novo'), { agent });
    assert.equal(second.error, null);
    assert.equal(second.status, 200);
  } finally {
    agent.destroy();
  }
});
await test('cliente SEM keep-alive ("Connection: close") com 3 MB e 20 MB -> 413', async () => {
  for (const n of [mb(3), mb(20)]) {
    const r = await post(gwPort, '/v1/chat/completions', GKEY, filler(n), { close: true });
    assert.equal(r.error, null, `${n} bytes: ${r.error}`);
    assert.equal(r.status, 413, `${n} bytes`);
  }
});
await test('HTTP/1.0 cru com 5 MB -> 413', async () => {
  const r = await postHttp10(gwPort, '/v1/chat/completions', GKEY, filler(mb(5)));
  assert.equal(r.error, null);
  assert.match(r.statusLine, / 413 /);
});
await test('sem chave, corpo grande continua 401', async () => {
  const r = await post(gwPort, '/v1/chat/completions', null, filler(mb(3)));
  assert.equal(r.status, 401);
});
await test('cliente que desiste no meio do envio: sem rejeição esquecida e o servidor segue vivo', async () => {
  await new Promise((resolve) => {
    const sock = net.connect(gwPort, '127.0.0.1', () => {
      sock.write(`POST /v1/chat/completions HTTP/1.1\r\nHost: x\r\nAuthorization: Bearer ${GKEY}\r\nContent-Type: application/json\r\nContent-Length: 5000\r\n\r\n{"messages":[`);
      setTimeout(() => sock.destroy(), 40);
    });
    sock.on('error', () => {});
    sock.on('close', resolve);
  });
  await new Promise((r) => setTimeout(r, 150));
  assert.deepEqual(unhandled, []);
  assert.equal((await post(gwPort, '/v1/chat/completions', GKEY, chatBody('vivo?'))).status, 200);
});

console.log(`\n${passed} ok, ${failed} falha(s)`);
for (const s of [api, gw]) { s.close(); s.closeAllConnections?.(); }
process.chdir(os.tmpdir());
try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* sobra em %TEMP%: inofensiva */ }
process.exit(failed ? 1 : 0);
