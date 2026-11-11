import assert from 'node:assert/strict';
import { recordInteraction, interactionSeries, resetInteractionStats } from '../src/core/interactionStats.js';
import { countProblems } from '../src/core/api/admin.js';

const H = 3600_000;
const t0 = Date.UTC(2026, 10, 11, 12, 30);
resetInteractionStats(t0);

let s = interactionSeries(t0);
assert.equal(s.series.length, 24);
assert.equal(s.total, 0);
assert.ok(s.series.every((x) => x.count === 0), 'sem resposta, tudo zero (nada inventado)');

recordInteraction(t0); recordInteraction(t0 + 10 * 60_000); recordInteraction(t0 - 2 * H);
s = interactionSeries(t0 + 20 * 60_000);
assert.equal(s.total, 3);
assert.equal(s.series[23].count, 2, 'a hora atual é a última barra');
assert.equal(s.series[21].count, 1, 'duas horas antes');

// sai da janela depois de 24 h
s = interactionSeries(t0 + 25 * H);
assert.equal(s.total, 0);
assert.equal(s.series.length, 24);

// o contador nunca lança, mesmo com valor estranho
assert.doesNotThrow(() => recordInteraction(Number.NaN));

// problemas das últimas 24 h na auditoria
const now = Date.now();
const iso = (ms) => new Date(now - ms).toISOString();
const p = countProblems([
  { ts: iso(1000), event: 'auth.login.fail' }, { ts: iso(2000), event: 'auth.login.fail' },
  { ts: iso(3000), event: 'agent.tool.error' }, { ts: iso(4000), event: 'agent.tool.denied' }, { ts: iso(5000), event: 'alert.fail' },
  { ts: iso(25 * H), event: 'auth.login.fail' }, // velho demais
  { ts: 'lixo', event: 'auth.login.fail' }, { event: 'agent.tool.error' }, { ts: iso(100), event: 'memory.write' },
], now);
assert.deepEqual(p, { loginFail: 2, toolError: 1, toolDenied: 1, alertFail: 1 });
assert.deepEqual(countProblems(null), { loginFail: 0, toolError: 0, toolDenied: 0, alertFail: 0 });

console.log('OK: interactionStats');
