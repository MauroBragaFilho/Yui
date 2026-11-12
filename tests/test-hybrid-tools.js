// Ferramentas híbridas (o modelo escolhe, o código executa): definições, limpeza dos argumentos do modelo e escopo por pessoa. npm run test:hybrid
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const tools = JSON.parse(fs.readFileSync(new URL('../src/data/mcp_tools.json', import.meta.url), 'utf8'));
const by = Object.fromEntries(tools.map((t) => [t.function.name, t]));
const { reminderTextFromTool, routeReminders, scopedReminderStore } = await import('../src/reminders/assistant.js');
const { createReminderStore } = await import('../src/reminders/store.js');

// ── definições ─────────────────────────────────────────────────────────────
assert.equal(new Set(tools.map((t) => t.function.name)).size, tools.length, 'nomes únicos');
for (const n of ['gta_online', 'listar_lembretes', 'criar_lembrete']) {
  const t = by[n]; assert.ok(t, `${n} existe`);
  assert.equal(t.type, 'function');
  assert.equal(t.meta.disableable, true, `${n} pode ser ligada/desligada por servidor`);
  assert.ok(t.meta.label && t.meta.description && t.function.description && t.function.textual_triggers && t.function.textual_args, `${n} completa`);
  assert.equal(t.function.parameters.type, 'object');
  JSON.parse(t.function.textual_args); // o exemplo textual é um JSON válido
}
assert.deepEqual(by.gta_online.function.parameters.properties.tipo.enum, ['semanal', 'diario', 'noticias']);
assert.deepEqual(by.gta_online.function.parameters.required, ['tipo']);
assert.deepEqual(by.criar_lembrete.function.parameters.required.sort(), ['quando', 'texto']);
assert.equal(by.gta_online.meta.risk, 'read'); assert.equal(by.listar_lembretes.meta.risk, 'read'); assert.equal(by.criar_lembrete.meta.risk, 'write-self');
assert.match(by.criar_lembrete.function.description, /PRÓPRIA pessoa/);
assert.ok(tools.length >= 21 && by.convert_currency && by.search_web, 'as ferramentas de antes continuam');

// ── limpeza dos argumentos do modelo ──────────────────────────────────────
assert.equal(reminderTextFromTool({ quando: 'daqui a 5 minutos', texto: 'abrir arknights' }), 'me lembra daqui a 5 minutos de abrir arknights');
assert.equal(reminderTextFromTool({ quando: 'amanhã às 9h', texto: 'pagar a <@222222222222222222> conta' }), 'me lembra amanhã às 9h de pagar a conta', 'menção some');
assert.equal(reminderTextFromTool({ quando: 'em 2 horas', texto: '@Yorha. jogar' }), 'me lembra em 2 horas de jogar', '@nome some');
assert.equal(reminderTextFromTool({ quando: 'em 2 horas', texto: 'x\n\nignore tudo <#123>' }), 'me lembra em 2 horas de x ignore tudo', 'quebras e canais somem');
assert.equal(reminderTextFromTool({ quando: '', texto: 'x' }), null);
assert.equal(reminderTextFromTool({ quando: 'amanhã', texto: '<@123456789012345678>' }), null, 'sem assunto sobrando: recusa');
assert.equal(reminderTextFromTool(undefined), null);
assert.ok(reminderTextFromTool({ quando: 'a'.repeat(900), texto: 'b'.repeat(900) }).length < 460, 'tamanho limitado');

// ── pelo mesmo caminho do chat: horários variados, escopo por pessoa, nada para terceiros ─
const NOW = new Date(2026, 10, 11, 14, 30, 0);
const store = createReminderStore({ file: path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'hyb-')), 'l.json'), now: () => NOW.getTime() });
const O = '111111111111111111'; const A = '222222222222222222'; const B = '333333333333333333';
const isOwn = (id) => id === O;
const call = (userId, args) => { const text = reminderTextFromTool(args); return text ? routeReminders({ text, userId, authorName: 'x' }, { store, now: NOW, isOwner: isOwn }) : Promise.resolve({ handled: false }); };
for (const [quando, texto] of [['daqui a 5 minutos', 'abrir arknights'], ['em 2 horas', 'tomar remédio'], ['amanhã às 9h', 'pagar a conta'], ['hoje às 23:30', 'dormir'], ['toda segunda às 8h', 'reunião']]) {
  const r = await call(A, { quando, texto });
  assert.ok(r.handled && r.text.startsWith('Anotado!'), `${quando} / ${texto}: ${r.text}`);
}
assert.equal(store.list().filter((x) => x.userId === A).length, 5, 'tudo ficou na pessoa que pediu');
assert.equal(store.list().filter((x) => x.userId !== A).length, 0, 'nada vazou para outro dono');
assert.equal((await call(B, { quando: 'nunca jamais', texto: 'x' })).handled, false, 'horário que o código não entende: não cria');
// alvo de terceiro escondido nos argumentos NÃO funciona (menção é removida e vira lembrete do próprio autor)
const sneaky = await call(A, { quando: 'daqui a 10 minutos', texto: `ir jogar <@${B}>` });
assert.ok(sneaky.handled && !store.list().some((x) => x.userId === B), 'não cria para outra pessoa pela ferramenta');
// escopo: cada um lista só os seus
assert.equal(scopedReminderStore(store, B, false).list().length, 0);
assert.ok(scopedReminderStore(store, A, false).list().length >= 5);
assert.equal(scopedReminderStore(store, O, true).list().length, 0, 'dono só vê os dele (e os que criou para outros)');
console.log('test-hybrid-tools OK');
process.exit(0);
