// Testes da proteção de reconexão do Discord (src/discord/gatewayGuard.js) e do filtro de
// "erro grave" para falhas de rede conhecidas (isHarmlessNetworkCrash em src/core/alerts.js).
//
// Reproduz o defeito real da @discordjs/ws: um servidor local aceita a conexão e nunca responde ao
// aperto de mão; o prazo do "hello" vence antes do prazo do handshake, o destroy() solta o tratador
// de erro da conexão em andamento e, quando o handshake expira, sobra uma exceção não capturada.
// Nada aqui toca o Discord de verdade.
// Execução: npm run test:discordreconnect
import assert from 'assert';
import net from 'net';
import os from 'os';
import path from 'path';
import fs from 'fs';
import { createRequire } from 'module';

process.env.YUI_AUDIT_FILE = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'yui-reconnect-')), 'audit.jsonl');
const { guardConnection, installGatewayGuard } = await import('../src/discord/gatewayGuard.js');
const { isHarmlessNetworkCrash } = await import('../src/core/alerts.js');

// A mesma instância que o discord.js usa.
const requireFromDiscordJs = createRequire(createRequire(import.meta.url).resolve('discord.js'));
const { WebSocketShard } = requireFromDiscordJs('@discordjs/ws');

let passed = 0;
const test = async (name, fn) => { await fn(); passed++; console.log(`  ✔ ${name}`); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const fakeLog = () => { const lines = []; return { lines, warn: (m) => lines.push(String(m)) }; };

// Servidor que aceita a conexão TCP e nunca responde (simula a rede travada no meio do handshake).
const held = [];
const server = net.createServer((socket) => { held.push(socket); socket.on('error', () => {}); });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `ws://127.0.0.1:${server.address().port}`;

// Exceções não capturadas do processo, para conferir o defeito e a correção.
const uncaught = [];
process.on('uncaughtException', (err) => uncaught.push(err));

/** Um shard real com prazos curtos: hello (100 ms) vence antes do handshake (400 ms). Reconecta uma vez só. */
function startShard() {
  let calls = 0;
  const strategy = {
    options: { version: '10', encoding: 'json', compression: null, handshakeTimeout: 400, helloTimeout: 100, readyTimeout: 1000, shardCount: 1, gatewayInformation: { url } },
    // 2ª chamada (a reconexão) fica pendurada: para o ciclo depois de um único destroy.
    retrieveSessionInfo: () => (calls++ === 0 ? Promise.resolve(null) : new Promise(() => {})),
    updateSessionInfo: async () => {},
  };
  const shard = new WebSocketShard(strategy, 0);
  shard.on('error', () => {});
  void shard.internalConnect().catch(() => {});
  return shard;
}

console.log('O defeito da @discordjs/ws (sem a proteção)');
let realError = null;
await test('a rede travada no handshake vira exceção não capturada "Opening handshake has timed out"', async () => {
  startShard();
  await sleep(900);
  assert.equal(uncaught.length, 1, `esperava 1 exceção, veio ${uncaught.length}`);
  assert.equal(uncaught[0].message, 'Opening handshake has timed out');
  realError = uncaught[0];
});

console.log('Filtro do aviso de erro grave');
await test('o erro real (pilha só no pacote ws) é reconhecido como falha de rede sem efeito', async () => {
  assert.ok(realError, 'o teste anterior precisa ter capturado o erro');
  assert.equal(isHarmlessNetworkCrash(realError), true);
});
await test('o erro do aviso que chegou ao dono (pilha copiada da DM) também é reconhecido', async () => {
  const err = new Error('Opening handshake has timed out');
  err.stack = [
    'Error: Opening handshake has timed out',
    '    at ClientRequest.<anonymous> (C:\\Yui\\node_modules\\ws\\lib\\websocket.js:890:7)',
    '    at ClientRequest.emit (node:events:508:28)',
    '    at TLSSocket.emitRequestTimeout (node:_http_client:927:9)',
  ].join('\n');
  assert.equal(isHarmlessNetworkCrash(err, { root: 'C:\\Yui' }), true);
});
await test('com uma linha da pilha em src/ da Yui continua sendo erro grave', async () => {
  const err = new Error('Opening handshake has timed out');
  err.stack = [
    'Error: Opening handshake has timed out',
    '    at ClientRequest.<anonymous> (C:\\Yui\\node_modules\\ws\\lib\\websocket.js:890:7)',
    '    at conectar (C:\\Yui\\src\\services\\tts\\edge.js:42:9)',
  ].join('\n');
  assert.equal(isHarmlessNetworkCrash(err, { root: 'C:\\Yui' }), false);
});
await test('outras mensagens, pilhas fora do ws e valores que não são Error continuam sendo erro grave', async () => {
  const other = new Error('Unknown interaction');
  other.stack = 'Error: Unknown interaction\n    at x (C:\\Yui\\node_modules\\ws\\lib\\websocket.js:1:1)';
  assert.equal(isHarmlessNetworkCrash(other, { root: 'C:\\Yui' }), false);
  const noWs = new Error('Opening handshake has timed out');
  noWs.stack = 'Error: Opening handshake has timed out\n    at x (C:\\Yui\\node_modules\\outro\\index.js:1:1)';
  assert.equal(isHarmlessNetworkCrash(noWs, { root: 'C:\\Yui' }), false);
  assert.equal(isHarmlessNetworkCrash('Opening handshake has timed out'), false);
  assert.equal(isHarmlessNetworkCrash(undefined), false);
});

console.log('guardConnection');
await test('só protege conexão em andamento ou fechando, e uma vez só', async () => {
  const mk = (readyState) => { const c = { readyState, n: 0, on(ev, fn) { if (ev === 'error') { this.n++; this.fn = fn; } } }; return c; };
  const log = fakeLog();
  const connecting = mk(0);
  assert.equal(guardConnection(connecting, { log }), true);
  assert.equal(guardConnection(connecting, { log }), false);
  assert.equal(connecting.n, 1);
  connecting.fn(new Error('qualquer'));
  assert.match(log.lines[0], /conexão antiga.*qualquer.*reconectando/);
  assert.equal(guardConnection(mk(2), { log }), true);
  assert.equal(guardConnection(mk(1), { log }), false);
  assert.equal(guardConnection(mk(3), { log }), false);
  assert.equal(guardConnection(null, { log }), false);
  assert.equal(guardConnection({ readyState: 0 }, { log }), false);
});

console.log('installGatewayGuard');
await test('se a biblioteca mudar, só avisa no log e nunca lança', async () => {
  const log = fakeLog();
  assert.equal(installGatewayGuard({ WebSocketShard: class {}, log }), false);
  assert.match(log.lines[0], /não instalada/);
  const log2 = fakeLog();
  const Bad = { get prototype() { throw new Error('quebrou'); } };
  assert.equal(installGatewayGuard({ WebSocketShard: Bad, log: log2 }), false);
  assert.match(log2.lines[0], /quebrou/);
});
await test('envolve o destroy original uma vez só e repassa os argumentos e o retorno', async () => {
  const calls = [];
  class Fake { constructor() { this.connection = { readyState: 0, on() {} }; } destroy(o) { calls.push(o); return 'ok'; } }
  const log = fakeLog();
  assert.equal(installGatewayGuard({ WebSocketShard: Fake, log }), true);
  const wrapped = Fake.prototype.destroy;
  assert.equal(installGatewayGuard({ WebSocketShard: Fake, log }), true);
  assert.equal(Fake.prototype.destroy, wrapped);
  assert.equal(new Fake().destroy({ recover: 0 }), 'ok');
  assert.deepEqual(calls, [{ recover: 0 }]);
});

console.log('Com a proteção (a @discordjs/ws real, carregada como o discord.js carrega)');
await test('a mesma rede travada não gera mais exceção; a falha vai só para o log', async () => {
  // Sem injetar a classe: prova que a proteção acha a mesma @discordjs/ws que o discord.js usa.
  const log = fakeLog();
  assert.equal(installGatewayGuard({ log }), true);
  uncaught.length = 0;
  startShard();
  await sleep(900);
  assert.equal(uncaught.length, 0, `não esperava exceção, veio: ${uncaught.map((e) => e.message).join(', ')}`);
  assert.equal(log.lines.length, 1, 'a falha da conexão antiga devia ir para o log uma vez');
  assert.match(log.lines[0], /Opening handshake has timed out/);
});

for (const s of held) s.destroy();
server.close();
console.log(`\n${passed} testes passaram.`);
process.exit(0);
