import assert from 'node:assert/strict';
import http from 'node:http';
import { installDefaultTimeouts } from '../src/utils/netDefaults.js';

// servidor que aceita a conexao e nunca responde (a queda de Wi-Fi do dia 10/11 em miniatura)
const server = http.createServer(() => { /* nunca responde */ });
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const url = `http://127.0.0.1:${server.address().port}/`;

const fakeAxios = { defaults: {} };
const target = { fetch: (input, init) => globalThis.fetch(input, init) };
const original = target.fetch;
const r = installDefaultTimeouts({ ms: 200, fetchTarget: target, axiosTarget: fakeAxios });
assert.deepEqual(r, { installed: true, timeoutMs: 200 });
assert.equal(fakeAxios.defaults.timeout, 200, 'axios ganha o timeout padrao');
assert.notEqual(target.fetch, original, 'fetch foi embrulhado');
assert.equal(target.fetch.__yuiTimeout, true);

// 1) sem signal: estoura no prazo (rapido), com TimeoutError
let t0 = Date.now();
await assert.rejects(target.fetch(url), (e) => e.name === 'TimeoutError' || e.cause?.name === 'TimeoutError' || /timeout|aborted/i.test(String(e.message)));
assert.ok(Date.now() - t0 < 3000, 'estourou perto de 200 ms, nao ficou preso');

// 2) quem passa o proprio signal manda: o prazo padrao nao se aplica
const ctl = new AbortController();
setTimeout(() => ctl.abort(), 600);
t0 = Date.now();
await assert.rejects(target.fetch(url, { signal: ctl.signal }), (e) => e.name === 'AbortError' || /abort/i.test(String(e.message)));
assert.ok(Date.now() - t0 >= 450, 'respeitou o signal do chamador (600 ms), sem cortar aos 200 ms');

// 3) axios que ja tem timeout nao e alterado; instalar de novo nao embrulha duas vezes
const ax2 = { defaults: { timeout: 90000 } };
const tg2 = { fetch: target.fetch };
installDefaultTimeouts({ ms: 200, fetchTarget: tg2, axiosTarget: ax2 });
assert.equal(ax2.defaults.timeout, 90000);
assert.equal(tg2.fetch, target.fetch, 'nao embrulha de novo');

// 4) 0 desliga
const ax3 = { defaults: {} };
const tg3 = { fetch: original };
assert.deepEqual(installDefaultTimeouts({ ms: 0, fetchTarget: tg3, axiosTarget: ax3 }), { installed: false, timeoutMs: 0 });
assert.equal(tg3.fetch, original);
assert.equal(ax3.defaults.timeout, undefined);

server.closeAllConnections?.();
server.close();
console.log('OK: netDefaults');
