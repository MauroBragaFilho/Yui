// Saída de servidor (events/guildDelete.js): limpa só os dados do servidor; servidor indisponível não apaga nada; nunca lança. Sem banco nem Discord.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { handleGuildDelete } from '../src/events/guildDelete.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }

function mkDeps(over = {}) {
  const calls = { tos: [], repo: [], ctx: [] };
  return {
    calls,
    deps: {
      removeAcceptedServer: (id) => calls.tos.push(id),
      guildRepository: { delete: (id) => calls.repo.push(id) },
      forgetGuildContext: async (id) => { calls.ctx.push(id); return { scopes: 0, turns: 0 }; },
      ...over,
    },
  };
}

await test('o evento está registrado em src/index.js', () => {
  assert.ok(readFileSync(new URL('../src/index.js', import.meta.url), 'utf8').includes("'./events/guildDelete.js'"));
});
await test('remoção real limpa aceite, configurações e contexto do servidor', async () => {
  const { calls, deps } = mkDeps();
  const r = await handleGuildDelete({ id: 'g1', name: 'Nome Secreto', available: true }, deps);
  assert.deepEqual(calls, { tos: ['g1'], repo: ['g1'], ctx: ['g1'] });
  assert.equal(r.settings && r.context && r.tos, true);
});
await test('servidor indisponível (outage) não apaga nada', async () => {
  const { calls, deps } = mkDeps();
  const r = await handleGuildDelete({ id: 'g1', available: false }, deps);
  assert.equal(r.skipped, true);
  assert.deepEqual(calls, { tos: [], repo: [], ctx: [] });
});
await test('sem servidor/id: ignora; falha em cada etapa não lança nem impede as outras', async () => {
  const { calls, deps } = mkDeps();
  assert.equal((await handleGuildDelete(null, deps)).skipped, true);
  assert.equal((await handleGuildDelete({}, deps)).skipped, true);
  const boom = () => { throw new Error('falhou'); };
  const m = mkDeps({ removeAcceptedServer: boom, guildRepository: { delete: boom } });
  const r = await handleGuildDelete({ id: 'g2' }, m.deps);
  assert.equal(r.tos, false); assert.equal(r.settings, false); assert.equal(r.context, true);
  assert.deepEqual(m.calls.ctx, ['g2']);
  const m2 = mkDeps({ forgetGuildContext: async () => { throw new Error('x'); } });
  assert.equal((await handleGuildDelete({ id: 'g3' }, m2.deps)).context, false);
  assert.deepEqual(calls.repo, []);
});
await test('não toca em banimentos nem memória pessoal (código não referencia bans/memória)', () => {
  const src = readFileSync(new URL('../src/events/guildDelete.js', import.meta.url), 'utf8');
  assert.ok(!/bans\.json|banHandler|forgetUserContext|memoryStore/.test(src));
});
await test('contexto: forgetGuild com keepPersonal preserva fios de memória pessoal', async () => {
  const src = readFileSync(new URL('../src/core/context/contextStore.js', import.meta.url), 'utf8');
  assert.ok(/forgetGuild\(guildId, \{ keepPersonal: true \}\)/.test(src));
});
console.log(`${passed} testes passaram.`);
process.exit(0);
