// Rádio por conversa: travas de runRadioChatIntent (sem Discord nem voz). Só caminhos que recusam/seguem adiante.
import assert from 'node:assert/strict';
import { runRadioChatIntent } from '../src/music/radioManager.js';

let passed = 0;
async function test(name, fn) { await fn(); passed++; console.log(`ok - ${name}`); }
const chan = { send: async () => { throw new Error('não deve enviar'); } };
const mem = (voiceId) => ({ id: '1', guild: { id: 'g-radio-teste' }, voice: { channelId: voiceId } });

await test('DM (sem servidor) e sem rádio ligada: segue para o modelo', async () => {
  assert.equal((await runRadioChatIntent({ kind: 'play', query: 'lofi', member: { id: '1' }, textChannel: chan })).handled, false);
  assert.equal((await runRadioChatIntent({ kind: 'pause', member: mem('v1'), textChannel: chan })).handled, false);
  assert.equal((await runRadioChatIntent({ kind: 'stop', member: mem(null), textChannel: chan })).handled, false);
});
await test('"tocar" fora da call: resposta franca, nada é ligado', async () => {
  const r = await runRadioChatIntent({ kind: 'play', query: 'lofi', member: mem(null), textChannel: chan });
  assert.equal(r.handled, true);
  assert.match(r.text, /canal de voz/);
});
await test('busca vazia não age', async () => {
  assert.equal((await runRadioChatIntent({ kind: 'play', query: ' ! ', member: mem('v1'), textChannel: chan })).handled, false);
});
console.log(`${passed} testes passaram.`);
process.exit(0);
