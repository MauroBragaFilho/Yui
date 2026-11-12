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

// ── persistência: reiniciar não zera a contagem ──
{
  const fs = await import('node:fs');
  const os = await import('node:os');
  const path = await import('node:path');
  const { initInteractionStats, saveInteractionStats } = await import('../src/core/interactionStats.js');
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-stats-'));
  const f = path.join(dir, 'interaction-stats.json');
  const base = Date.UTC(2026, 10, 12, 12, 30);

  resetInteractionStats(base);
  assert.equal(initInteractionStats(f, base), true);
  recordInteraction(base); recordInteraction(base); recordInteraction(base - 3 * H);
  assert.equal(saveInteractionStats(), true);
  assert.ok(fs.existsSync(f) && !fs.existsSync(`${f}.tmp`), 'escrita atômica: sem arquivo temporário');

  resetInteractionStats(base + 60_000); // "reinício": a memória zera
  assert.equal(interactionSeries(base).total, 0);
  initInteractionStats(f, base + 60_000); // volta a carregar do disco
  const again = interactionSeries(base + 60_000);
  assert.equal(again.total, 3, 'depois do reinício a contagem continua');
  assert.equal(again.series[23].count, 2);
  assert.equal(again.since, new Date(base).toISOString(), 'since volta do arquivo (não é o horário do reinício)');

  // arquivo velho: horas fora da janela de 24 h somem; arquivo ilegível não derruba
  resetInteractionStats(base + 30 * H);
  initInteractionStats(f, base + 30 * H);
  assert.equal(interactionSeries(base + 30 * H).total, 0);
  fs.writeFileSync(f, '{lixo');
  resetInteractionStats(base);
  assert.doesNotThrow(() => initInteractionStats(f, base));
  assert.equal(interactionSeries(base).total, 0);
  resetInteractionStats(base); // desliga o arquivo (os testes seguintes não gravam)
  fs.rmSync(dir, { recursive: true, force: true });
}
