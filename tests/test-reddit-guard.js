import assert from 'node:assert/strict';
import { createRedditGuard, withDeadline } from '../src/engines/gtao/systems/weekly/redditGuard.js';

const MIN = 60_000;
let t = 0;
const clock = () => t;

// Recuo: dobra a cada falha seguida, respeita o teto e zera no sucesso
const g = createRedditGuard({ baseMs: 60 * MIN, maxMs: 240 * MIN, now: clock });
assert.equal(g.canTry().ok, true, 'começa livre');
assert.equal(g.recordFailure(), 60 * MIN);
t = 30 * MIN;
let gate = g.canTry();
assert.equal(gate.ok, false);
assert.equal(gate.retryInMs, 30 * MIN, 'faltam 30 min dos 60');
t = 60 * MIN;
assert.equal(g.canTry().ok, true, 'passou a espera');
assert.equal(g.recordFailure(), 120 * MIN, '2ª falha seguida: 120 min');
assert.equal(g.recordFailure(), 240 * MIN, '3ª: 240 min (teto)');
assert.equal(g.recordFailure(), 240 * MIN, 'nunca passa do teto');
g.recordSuccess();
assert.equal(g.canTry().ok, true, 'sucesso libera na hora');
assert.equal(g.failures, 0);
assert.equal(g.recordFailure(), 60 * MIN, 'depois do sucesso volta ao começo');

// Um Chrome por vez: chamadas simultâneas dividem o mesmo resultado
const g2 = createRedditGuard({ now: clock });
let runs = 0;
const slow = () => new Promise((r) => setTimeout(() => { runs += 1; r('feed'); }, 30));
const [a, b, c] = await Promise.all([g2.run(slow), g2.run(slow), g2.run(slow)]);
assert.deepEqual([a, b, c], ['feed', 'feed', 'feed']);
assert.equal(runs, 1, 'só uma busca de verdade');
assert.equal(await g2.run(async () => 'outra'), 'outra', 'depois de terminar, uma nova busca pode rodar');
await assert.rejects(g2.run(async () => { throw new Error('boom'); }), /boom/);
assert.equal(await g2.run(async () => 'volta'), 'volta', 'falha não trava as próximas');

// Prazo
await assert.rejects(withDeadline(new Promise(() => {}), 20, 'X_DEADLINE', 'Teste'), (e) => e.code === 'X_DEADLINE' && /prazo/.test(e.message));
assert.equal(await withDeadline(Promise.resolve(7), 1000), 7);
await assert.rejects(withDeadline(Promise.reject(new Error('antes')), 1000), /antes/);

console.log('OK: redditGuard');
