// Canal local cérebro ↔ adaptadores (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §4): src/core/channel/.
// Execução: npm run test:channel
//
// Tudo em 127.0.0.1 com porta 0 (o sistema escolhe uma livre) e o arquivo do segredo numa pasta temporária: nada de
// produção, nada em secrets/ do repositório. O log é capturado por um logger de teste para conferir que o segredo e os
// parâmetros nunca aparecem nele.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocket } from 'ws';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-channel-'));
const { startChannelServer, findProxyHeader, isLoopbackHost } = await import('../src/core/channel/server.js');
const { connectChannel } = await import('../src/core/channel/client.js');
const { createIdemCache, CLOSE, ChannelError, PROTOCOL_VERSION } = await import('../src/core/channel/protocol.js');
const { readChannelSecretFile, allowedSecretSids, channelSecretFilePath, channelPortFromEnv } = await import('../src/core/channel/secret.js');
const { readWindowsAcl } = await import('../src/database/snapshot.js');

let passed = 0;
let finished = false;
process.on('exit', (code) => {
  if (!finished && code === 0) { console.error('O teste saiu antes do fim.'); process.exitCode = 1; }
});
const test = async (name, fn) => { await fn(); passed += 1; console.log(`  ✔ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── Log capturado (servidor e clientes) e segredos vistos ───────────────────────────────────────
const logLines = [];
const captureLogger = (tag) => Object.fromEntries(['debug', 'info', 'warn', 'error'].map((lvl) => [lvl, (msg) => logLines.push(`${tag} ${lvl} ${msg}`)]));
const secretsSeen = new Set();
const MARKER = `PARAM-SIGILOSO-${crypto.randomBytes(6).toString('hex')}`;

let fileSeq = 0;
const servers = new Set();
const clients = new Set();
async function startServer(opts = {}) {
  const secretFile = opts.secretFile ?? path.join(tmp, `s${++fileSeq}`, 'channel-secret.json');
  const server = await startChannelServer({ port: 0, secretFile, logger: captureLogger('servidor'), connectTimeoutMs: 2000, ...opts });
  servers.add(server);
  const info = readChannelSecretFile(secretFile);
  secretsSeen.add(info.secret);
  server.secret = info.secret;
  return server;
}
function startClient(server, opts = {}) {
  const client = connectChannel({ role: 'bot', secretFile: server.secretFile, logger: captureLogger('cliente'), minBackoffMs: 50, maxBackoffMs: 400, ...opts });
  clients.add(client);
  return client;
}
async function stopServer(server) { servers.delete(server); await server.close(); }
async function stopClient(client) { clients.delete(client); await client.close(); }

/** Upgrade HTTP cru, com cabeçalhos à escolha. Devolve o status (101 = aceito). */
function rawUpgrade(port, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port, path: '/', method: 'GET',
      headers: {
        Host: `127.0.0.1:${port}`, Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13',
        'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...headers,
      },
    });
    req.on('response', (res) => { res.resume(); resolve(res.statusCode); });
    req.on('upgrade', (res, socket) => { socket.destroy(); resolve(101); });
    req.on('error', reject);
    req.end();
  });
}

/** WebSocket cru (sem o cliente da Yui): manda os quadros que quiser e devolve o código de fechamento. */
function rawSocket(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, { perMessageDeflate: false, maxPayload: 4 * 1024 * 1024 });
  ws.received = [];
  ws.on('message', (d) => ws.received.push(d.toString('utf8')));
  ws.on('error', () => { /* o close vem em seguida */ });
  ws.opened = new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('unexpected-response', (_q, res) => reject(new Error(`status ${res.statusCode}`))); });
  ws.closed = new Promise((resolve) => ws.once('close', (code) => resolve(code)));
  return ws;
}
const connectFrame = (secret, extra = {}) => JSON.stringify({ type: 'connect', role: 'bot', version: PROTOCOL_VERSION, capabilities: [], secret, ...extra });
async function rawCloseCodeAfter(port, ...frames) {
  const ws = rawSocket(port);
  await ws.opened;
  for (const f of frames) ws.send(f);
  return ws.closed;
}
const errorsSeen = [];
async function expectReject(promise, code) {
  try { await promise; } catch (err) { errorsSeen.push(err); assert.equal(err.code, code, `código ${err.code}: ${err.message}`); return err; }
  assert.fail(`esperava erro ${code}`);
}
const waitState = (client, wanted, timeoutMs = 5000) => new Promise((resolve, reject) => {
  if (client.state === wanted) return resolve();
  const timer = setTimeout(() => { off(); reject(new Error(`estado ${wanted} não chegou (está ${client.state})`)); }, timeoutMs);
  const off = client.onState(({ state }) => { if (state === wanted) { clearTimeout(timer); off(); resolve(); } });
});
/** Marca a promessa como tratada já na criação (ela pode ser recusada antes do await, numa queda de conexão). */
const handled = (p) => { p.catch(() => {}); return p; };

try {
  console.log('Canal local cérebro ↔ adaptadores');

  await test('conecta, recebe hello e faz pedido e resposta (com erros de método e de handler)', async () => {
    const server = await startServer();
    server.handle('eco', async (params, meta) => ({ eco: params, role: meta.role, caps: meta.capabilities, idem: meta.idem }));
    server.handle('so.app', async () => 'nao', { roles: ['app'] });
    server.handle('falha', async () => { const e = new Error('não deu'); e.code = 'NAO_DEU'; throw e; });
    const client = startClient(server, { capabilities: ['dm', 'voz'] });
    const hello = await client.ready();
    assert.equal(hello.protocol, 1);
    assert.equal(hello.role, 'bot');
    assert.deepEqual(hello.accepted, ['eco', 'falha'], 'accepted traz só o que o papel bot pode chamar');
    assert.ok(!JSON.stringify(hello).includes(server.secret), 'o hello não devolve o segredo');
    const out = await client.request('eco', { texto: MARKER });
    assert.deepEqual(out, { eco: { texto: MARKER }, role: 'bot', caps: ['dm', 'voz'], idem: null });
    assert.deepEqual(server.connections().map((c) => c.role), ['bot']);
    await expectReject(client.request('nao.existe', {}), 'METHOD_NOT_FOUND');
    await expectReject(client.request('so.app', {}), 'METHOD_NOT_ALLOWED');
    const err = await expectReject(client.request('falha', {}), 'NAO_DEU');
    assert.equal(err.remote, true);
    // Eventos nos dois sentidos.
    const got = [];
    client.on('aviso', (payload, { seq }) => got.push([payload, seq]));
    const fromClient = new Promise((resolve) => server.onEvent('status', (payload, info) => resolve([payload, info.role])));
    assert.equal(server.emit('aviso', { n: 1 }), 1);
    assert.equal(server.emit('aviso', { n: 2 }, { role: 'app' }), 0, 'evento só para o papel app: ninguém recebe');
    assert.equal(client.emit('status', { pronto: true }), true);
    assert.deepEqual(await fromClient, [{ pronto: true }, 'bot']);
    await sleep(50);
    assert.deepEqual(got, [[{ n: 1 }, 1]]);
    await stopClient(client);
    await stopServer(server);
  });

  await test('escuta só em 127.0.0.1; o cliente só aceita endereço de loopback', async () => {
    const server = await startServer();
    const tryConnect = (host) => new Promise((resolve) => {
      const s = net.connect({ host, port: server.port });
      s.once('connect', () => { s.destroy(); resolve('conectou'); });
      s.once('error', (e) => resolve(e.code));
    });
    assert.equal(await tryConnect('127.0.0.1'), 'conectou');
    assert.notEqual(await tryConnect('::1'), 'conectou', 'IPv6 loopback não escuta (só 127.0.0.1)');
    const lan = Object.values(os.networkInterfaces()).flat().find((i) => i && i.family === 'IPv4' && !i.internal);
    if (lan) assert.notEqual(await tryConnect(lan.address), 'conectou', `não escuta no IP da rede (${lan.address})`);
    assert.throws(() => connectChannel({ role: 'bot', url: 'ws://192.168.0.10:3941', secretFile: server.secretFile, logger: captureLogger('cliente') }), /loopback/);
    assert.throws(() => connectChannel({ role: 'bot', url: 'wss://127.0.0.1:3941', secretFile: server.secretFile, logger: captureLogger('cliente') }), /ws:\/\//);
    assert.equal(channelPortFromEnv({}), 3941);
    assert.equal(channelPortFromEnv({ YUI_CHANNEL_PORT: '4000' }), 4000);
    assert.throws(() => channelPortFromEnv({ YUI_CHANNEL_PORT: 'abc' }), RangeError);
    assert.equal(channelSecretFilePath({ YUI_CHANNEL_SECRET_FILE: path.join(tmp, 'x.json') }), path.join(tmp, 'x.json'));
    assert.match(channelSecretFilePath({}), /secrets[\\/]channel-secret\.json$/);
    await stopServer(server);
  });

  await test('segredo errado (ou ausente) fecha com 4001; papel desconhecido 4003; versão errada 4002', async () => {
    const server = await startServer();
    assert.equal(await rawCloseCodeAfter(server.port, connectFrame('0'.repeat(64))), CLOSE.UNAUTHORIZED);
    assert.equal(await rawCloseCodeAfter(server.port, JSON.stringify({ type: 'connect', role: 'bot', version: 1 })), CLOSE.UNAUTHORIZED);
    assert.equal(await rawCloseCodeAfter(server.port, connectFrame(server.secret, { role: 'intruso' })), CLOSE.UNKNOWN_ROLE);
    assert.equal(await rawCloseCodeAfter(server.port, connectFrame(server.secret, { version: 2 })), CLOSE.PROTOCOL);
    assert.equal(server.stats().badSecret, 2);
    assert.equal(server.isConnected('bot'), false);
    // Segredo certo: entra.
    const ws = rawSocket(server.port);
    await ws.opened;
    ws.send(connectFrame(server.secret));
    await sleep(100);
    assert.equal(JSON.parse(ws.received[0]).type, 'hello');
    assert.equal(server.stats().failedAttempts, 0, 'conexão certa zera as tentativas erradas');
    ws.close();
    await ws.closed;
    await stopServer(server);
  });

  await test('primeiro quadro que não é connect fecha com 4002 (pedido, JSON quebrado, binário, connect grande); sem connect, 4008', async () => {
    const server = await startServer({ connectTimeoutMs: 300 });
    server.handle('eco', async (p) => p);
    assert.equal(await rawCloseCodeAfter(server.port, JSON.stringify({ type: 'req', id: 1, method: 'eco', params: {} })), CLOSE.PROTOCOL);
    assert.equal(await rawCloseCodeAfter(server.port, '{quebrado'), CLOSE.PROTOCOL);
    const bin = rawSocket(server.port);
    await bin.opened;
    bin.send(Buffer.from([1, 2, 3]));
    assert.equal(await bin.closed, CLOSE.PROTOCOL);
    assert.equal(await rawCloseCodeAfter(server.port, connectFrame(server.secret, { capabilities: ['x'.repeat(20_000)] })), CLOSE.PROTOCOL);
    const silent = rawSocket(server.port);
    await silent.opened;
    assert.equal(await silent.closed, CLOSE.CONNECT_TIMEOUT);
    await stopServer(server);
  });

  await test('Host que não é loopback é recusado no upgrade (403)', async () => {
    const server = await startServer();
    const p = server.port;
    assert.equal(await rawUpgrade(p, { Host: `yui.example.com:${p}` }), 403);
    assert.equal(await rawUpgrade(p, { Host: `192.168.0.10:${p}` }), 403);
    assert.equal(await rawUpgrade(p, { Host: `127.0.0.1:${p + 1}` }), 403, 'porta diferente da do canal');
    assert.equal(await rawUpgrade(p, { Host: '127.0.0.1' }), 403, 'sem porta');
    assert.equal(await rawUpgrade(p, { Host: `localhost:${p}` }), 101);
    assert.equal(await rawUpgrade(p, { Host: `127.0.0.1:${p}` }), 101);
    assert.equal(isLoopbackHost(`[::1]:${p}`, p), true);
    await stopServer(server);
  });

  await test('cabeçalho de proxy é recusado no upgrade (403)', async () => {
    const server = await startServer();
    for (const h of ['X-Forwarded-For', 'X-Forwarded-Host', 'X-Forwarded-Proto', 'Forwarded', 'Via', 'X-Real-IP', 'Tailscale-User-Login', 'Tailscale-User-Name']) {
      assert.equal(await rawUpgrade(server.port, { [h]: '1.2.3.4' }), 403, h);
    }
    assert.equal(findProxyHeader({ 'x-forwarded-qualquer': '1' }), 'x-forwarded-qualquer');
    assert.equal(findProxyHeader({ host: 'x' }), null);
    assert.ok(server.stats().refusedUpgrade >= 8);
    await stopServer(server);
  });

  await test('Origin presente (navegador) é recusado no upgrade (403)', async () => {
    const server = await startServer();
    assert.equal(await rawUpgrade(server.port, { Origin: 'http://localhost:3000' }), 403);
    assert.equal(await rawUpgrade(server.port, { Origin: 'null' }), 403);
    // O cliente ws (como o do adaptador) não manda Origin: entra.
    const client = startClient(server);
    await client.ready();
    await stopClient(client);
    await stopServer(server);
  });

  await test('trava de 60 s depois de 5 tentativas erradas (nem o segredo certo entra); destrava depois do prazo', async () => {
    let clock = Date.now();
    const server = await startServer({ now: () => clock });
    for (let i = 0; i < 5; i++) assert.equal(await rawCloseCodeAfter(server.port, connectFrame('f'.repeat(64))), CLOSE.UNAUTHORIZED);
    assert.equal(server.stats().locks, 1);
    assert.ok(server.stats().lockedUntil, 'travado');
    assert.equal(await rawUpgrade(server.port), 429, 'travado: recusa já no upgrade');
    const client = startClient(server, { minBackoffMs: 100, maxBackoffMs: 200 });
    await sleep(400);
    assert.equal(client.connected, false, 'nem o adaptador com o segredo certo entra durante a trava');
    clock += 59_000;
    assert.equal(await rawUpgrade(server.port), 429, 'ainda dentro dos 60 s');
    clock += 1_500;
    await client.ready(3000);
    assert.equal(client.connected, true, 'depois de 60 s, o segredo certo entra');
    await stopClient(client);
    await stopServer(server);
  });

  await test('idempotência: o mesmo idem roda o handler 1 vez (em paralelo, em sequência e depois de reconectar)', async () => {
    const server = await startServer();
    let runs = 0;
    server.handle('lista.adicionar', async (params) => { runs += 1; await sleep(100); return { item: params.item, n: runs }; });
    let flaky = 0;
    server.handle('instavel', async () => { flaky += 1; if (flaky === 1) throw Object.assign(new Error('falhou'), { code: 'TEMP' }); return { ok: flaky }; });
    const client = startClient(server);
    await client.ready();
    const [a, b] = await Promise.all([
      client.request('lista.adicionar', { item: MARKER }, { idem: 'k1' }),
      client.request('lista.adicionar', { item: MARKER }, { idem: 'k1' }),
    ]);
    assert.deepEqual(a, b);
    assert.equal(runs, 1, 'dois pedidos simultâneos com o mesmo idem: 1 execução');
    const c = await client.request('lista.adicionar', { item: MARKER }, { idem: 'k1' });
    assert.deepEqual(c, a);
    assert.equal(runs, 1, 'repetição depois de concluído: resposta guardada');
    await client.request('lista.adicionar', { item: 'outro' }, { idem: 'k2' });
    assert.equal(runs, 2, 'idem diferente executa');
    await client.request('lista.adicionar', { item: 'sem idem' });
    await client.request('lista.adicionar', { item: 'sem idem' });
    assert.equal(runs, 4, 'sem idem executa sempre');
    // Erro não fica guardado: a nova tentativa com a mesma chave executa.
    await expectReject(client.request('instavel', {}, { idem: 'k3' }), 'TEMP');
    assert.deepEqual(await client.request('instavel', {}, { idem: 'k3' }), { ok: 2 });
    // A chave vale entre conexões do mesmo papel (pedido refeito depois de reconectar).
    await stopClient(client);
    const client2 = startClient(server);
    await client2.ready();
    assert.deepEqual(await client2.request('lista.adicionar', { item: MARKER }, { idem: 'k1' }), a);
    assert.equal(runs, 4);
    assert.ok(server.stats().idemReplays >= 3);
    await expectReject(client2.request('lista.adicionar', {}, { idem: 'x'.repeat(200) }), 'BAD_IDEM');
    await stopClient(client2);
    await stopServer(server);

    // Limites do cache: últimas `max` chaves, por `ttlMs`.
    let clock = 0;
    const cache = createIdemCache({ max: 3, ttlMs: 1000, now: () => clock });
    let execs = 0;
    const run = (k) => cache.run(k, async () => { execs += 1; return { ok: true, payload: k }; }).promise;
    for (const k of ['a', 'b', 'c', 'd', 'e']) await run(k);
    assert.ok(cache.size <= 3, `tamanho ${cache.size}`);
    await run('e');
    assert.equal(execs, 5, 'chave recente: guardada');
    await run('a');
    assert.equal(execs, 6, 'chave mais antiga saiu do cache');
    clock += 1001;
    await run('e');
    assert.equal(execs, 7, 'depois do prazo, executa de novo');
  });

  await test('mão dupla: o cérebro chama o adaptador (ação do canal), com idempotência do lado do adaptador', async () => {
    const server = await startServer();
    const client = startClient(server);
    let sent = 0;
    client.handle('discord.dm.send', async (params, meta) => { sent += 1; return { entregue: true, para: params.para, quemPediu: meta.role }; });
    await client.ready();
    const r = await server.request('bot', 'discord.dm.send', { para: 'dono', texto: MARKER }, { idem: 'lembrete-1' });
    assert.deepEqual(r, { entregue: true, para: 'dono', quemPediu: 'cerebro' });
    assert.deepEqual(await server.request('bot', 'discord.dm.send', { para: 'dono', texto: MARKER }, { idem: 'lembrete-1' }), r);
    assert.equal(sent, 1, 'a DM repetida com o mesmo idem não sai duas vezes');
    await expectReject(server.request('bot', 'discord.voice.join', {}), 'METHOD_NOT_FOUND');
    await expectReject(server.request('app', 'discord.dm.send', {}), 'NOT_CONNECTED');
    await stopClient(client);
    await stopServer(server);
  });

  await test('prazo esgotado: do lado de quem pede, do lado do handler (que é avisado) e na ação do canal', async () => {
    const server = await startServer({ requestTimeoutMs: 300 });
    let aborted = null;
    server.handle('lento', (params, meta) => new Promise((resolve) => {
      const t = setTimeout(() => resolve('tarde'), 2000);
      meta.signal.addEventListener('abort', () => { clearTimeout(t); aborted = meta.signal.reason?.code ?? 'abortado'; resolve('parou'); });
    }));
    const client = startClient(server, { requestTimeoutMs: 5000 });
    client.handle('travado', () => new Promise(() => { /* nunca responde */ }));
    await client.ready();
    let t0 = Date.now();
    await expectReject(client.request('lento', { x: MARKER }, { timeoutMs: 100 }), 'TIMEOUT');
    assert.ok(Date.now() - t0 < 280, 'o prazo de quem pede vale');
    await sleep(400);
    aborted = null;
    t0 = Date.now();
    const err = await expectReject(client.request('lento', { x: MARKER }), 'TIMEOUT');
    assert.equal(err.remote, true, 'o TIMEOUT veio do cérebro (prazo do handler)');
    assert.ok(Date.now() - t0 < 1500);
    await sleep(50);
    assert.equal(aborted, 'TIMEOUT', 'o handler foi avisado pelo signal');
    await expectReject(server.request('bot', 'travado', { x: MARKER }, { timeoutMs: 150 }), 'TIMEOUT');
    assert.equal(client.connected, true, 'prazo esgotado não derruba a conexão');
    await stopClient(client);
    await stopServer(server);
  });

  await test('quadro grande demais: recusado antes de sair, resposta grande vira erro e quadro cru fecha com 1009', async () => {
    const max = 64 * 1024;
    const server = await startServer({ maxFrameBytes: max });
    server.handle('eco', async (p) => p);
    server.handle('gigante', async () => 'x'.repeat(max + 10));
    const client = startClient(server, { maxFrameBytes: max });
    await client.ready();
    await expectReject(client.request('eco', { texto: 'x'.repeat(max) }), 'FRAME_TOO_LARGE');
    assert.equal(client.connected, true, 'o pedido grande foi barrado no cliente; a conexão segue');
    assert.deepEqual(await client.request('eco', { ok: 1 }), { ok: 1 });
    await expectReject(client.request('gigante', {}), 'RESPONSE_TOO_LARGE');
    // Cliente cru autenticado que manda um quadro grande demais: o servidor fecha (1009).
    const ws = rawSocket(server.port);
    await ws.opened;
    ws.send(connectFrame(server.secret, { role: 'app' }));
    await sleep(100);
    assert.equal(JSON.parse(ws.received[0]).type, 'hello');
    ws.send(JSON.stringify({ type: 'req', id: 1, method: 'eco', params: 'y'.repeat(max * 2) }));
    assert.equal(await ws.closed, CLOSE.TOO_LARGE);
    await stopClient(client);
    await stopServer(server);
  });

  await test('reconexão: queda recusa os pendentes com erro claro; o cliente volta sozinho quando o cérebro reinicia', async () => {
    const secretFile = path.join(tmp, 'reinicio', 'channel-secret.json');
    const serverA = await startServer({ secretFile });
    serverA.handle('espera', (params, meta) => new Promise((resolve) => meta.signal.addEventListener('abort', () => resolve('abortado'))));
    serverA.handle('qual', async () => 'A');
    const port = serverA.port;
    const client = startClient(serverA);
    await client.ready();
    assert.equal(await client.request('qual'), 'A');
    const pending = handled(client.request('espera', { x: MARKER }));
    await sleep(50);
    await stopServer(serverA);
    const err = await expectReject(pending, 'CONNECTION_LOST');
    assert.match(err.message, /caiu/);
    assert.match(err.message, /espera/, 'a mensagem diz qual pedido ficou sem resposta');
    await expectReject(client.request('qual'), 'NOT_CONNECTED');
    assert.equal(fs.existsSync(secretFile), false, 'o arquivo do segredo some quando o cérebro fecha');
    await sleep(300); // algumas tentativas sem ninguém escutando
    const serverB = await startServer({ secretFile, port });
    serverB.handle('qual', async () => 'B');
    assert.notEqual(serverB.secret, serverA.secret, 'segredo novo a cada subida');
    await client.ready(5000);
    assert.equal(await client.request('qual'), 'B');
    assert.equal(client.stats().connects, 2);
    assert.ok(client.stats().reconnectAttempts >= 1);
    // Fechar o cliente recusa o que estiver pendente com CLOSED e não reconecta.
    serverB.handle('espera', () => new Promise(() => {}));
    const p2 = handled(client.request('espera'));
    await stopClient(client);
    await expectReject(p2, 'CLOSED');
    await sleep(200);
    assert.equal(serverB.isConnected('bot'), false);
    await stopServer(serverB);
  });

  await test('conexão nova do mesmo papel substitui a antiga (pendentes da antiga recusados)', async () => {
    const server = await startServer();
    server.handle('espera', () => new Promise(() => {}));
    const a = startClient(server, { maxBackoffMs: 60_000 });
    a.handle('ping', async () => 'a');
    await a.ready();
    a.handle('espera.no.bot', () => new Promise(() => {}));
    const pendingA = a.request('espera', { x: MARKER }).then(() => assert.fail('não devia responder'), (e) => e);
    const pendingFromServer = server.request('bot', 'espera.no.bot', {}).then(() => assert.fail('não devia responder'), (e) => e);
    await sleep(50);
    const lostA = waitState(a, 'disconnected');
    const waitingA = new Promise((resolve) => { const off = a.onState((s) => { if (s.state === 'waiting') { off(); resolve(s); } }); });
    const b = startClient(server);
    b.handle('ping', async () => 'b');
    await b.ready();
    await lostA;
    const closeInfo = await waitingA;
    assert.equal((await pendingA).code, 'CONNECTION_LOST');
    assert.equal((await pendingFromServer).code, 'CONNECTION_LOST');
    assert.match((await pendingFromServer).message, /substituída/);
    assert.ok(closeInfo.retryInMs >= 30_000, `quem foi substituído espera o intervalo máximo (${closeInfo.retryInMs} ms)`);
    assert.equal(await server.request('bot', 'ping'), 'b');
    assert.equal(server.stats().replaced, 1);
    await stopClient(a);
    await stopClient(b);
    await stopServer(server);
  });

  await test('arquivo do segredo com permissão restrita (ACL por SID no Windows); sem restrição, o canal não sobe', async () => {
    const server = await startServer();
    const file = server.secretFile;
    const data = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.deepEqual(Object.keys(data).sort(), ['pid', 'port', 'protocol', 'secret', 'startedAt']);
    assert.equal(data.port, server.port);
    if (process.platform === 'win32') {
      const acl = readWindowsAcl(file);
      const allowed = allowedSecretSids();
      assert.equal(acl.protected, true, `sem herança (${acl.sddl})`);
      assert.ok(acl.aces.every((a) => a.type === 'A' && !a.flags.includes('ID')), `só concessões explícitas (${acl.sddl})`);
      assert.deepEqual([...new Set(acl.aces.map((a) => a.sid))].sort(), [...allowed].sort(), `só usuário atual, SYSTEM e Administradores (${acl.sddl})`);
      assert.ok(!acl.aces.some((a) => ['S-1-1-0', 'S-1-5-11', 'S-1-5-32-545'].includes(a.sid)), 'Todos, Usuários autenticados e Usuários não têm acesso');
    } else {
      assert.equal(fs.statSync(file).mode & 0o777, 0o600);
    }
    await stopServer(server);
    assert.equal(fs.existsSync(file), false);

    const badFile = path.join(tmp, 'sem-acl', 'channel-secret.json');
    await assert.rejects(
      startChannelServer({ port: 0, secretFile: badFile, logger: captureLogger('servidor'), restrictFile: () => { throw new Error('icacls simulado falhou'); } }),
      /NÃO subiu/,
    );
    assert.equal(fs.existsSync(badFile), false, 'o arquivo vazio foi apagado; o segredo nunca foi gravado');
  });

  await test('o segredo e os parâmetros nunca aparecem no log (só método e tamanho)', async () => {
    assert.ok(logLines.length > 20, `log capturado: ${logLines.length} linhas`);
    assert.ok(secretsSeen.size >= 10, `segredos vistos: ${secretsSeen.size}`);
    for (const line of logLines) {
      for (const s of secretsSeen) assert.ok(!line.includes(s), `segredo no log: ${line.slice(0, 120)}`);
      assert.ok(!line.includes(MARKER), `parâmetro no log: ${line.slice(0, 120)}`);
    }
    assert.ok(logLines.some((l) => /lista\.adicionar \(\d+ B/.test(l)), 'o log traz o método e o tamanho');
    assert.ok(logLines.some((l) => /segredo_invalido|canal_segredo_invalido/.test(l)), 'as recusas aparecem no log');
    // Os erros devolvidos a quem chamou (ChannelError) também não carregam o segredo nem os parâmetros.
    assert.ok(errorsSeen.length >= 15, `erros vistos: ${errorsSeen.length}`);
    for (const err of errorsSeen) {
      assert.ok(err instanceof ChannelError, `${err?.name}: ${err?.message}`);
      const text = `${err.message} ${JSON.stringify(err)}`;
      for (const s of secretsSeen) assert.ok(!text.includes(s), `segredo num erro: ${err.message}`);
      assert.ok(!text.includes(MARKER), `parâmetro num erro: ${err.message}`);
    }
  });

  console.log(`\n${passed} verificações do canal passaram.`);
  finished = true;
} finally {
  for (const c of clients) { try { await c.close(); } catch { /* */ } }
  for (const s of servers) { try { await s.close(); } catch { /* */ } }
  fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}
