// Testes da lógica da tela "Lembretes" (sem React e sem rede). Execução: npm test (dentro de apps/yui-app)
import test from 'node:test';
import assert from 'node:assert/strict';
import { createClient } from '../src/api/client.ts';
import { TABS, tabVisible } from '../src/tabs.ts';
import { groupReminders, QUICK_WHEN, summarizeReminders, reminderInputProblem } from '../src/remindersLogic.ts';

const NOW = new Date(2026, 10, 11, 14, 30, 0);
const at = (d, h, m = 0) => new Date(2026, 10, d, h, m).toISOString();
const R = (id, iso, repeat = null) => ({ id, text: `r${id}`, at: iso, repeat });

test('lembretes: atrasados, hoje e próximos, cada grupo por horário', () => {
  const g = groupReminders([R(5, at(14, 8)), R(2, at(11, 18)), R(1, at(11, 9)), R(3, at(11, 15)), R(4, at(12, 7)), R(6, 'lixo')], NOW);
  assert.deepEqual(g.overdue.map((r) => r.id), [1], 'as 9h de hoje já passaram');
  assert.deepEqual(g.today.map((r) => r.id), [3, 2], '15h e 18h, em ordem');
  assert.deepEqual(g.upcoming.map((r) => r.id), [4, 5], 'amanhã e depois');
  assert.deepEqual(groupReminders([], NOW), { overdue: [], today: [], upcoming: [] });
});

test('lembretes: resumo do cartão do Início', () => {
  assert.equal(summarizeReminders([], NOW), 'Nenhum lembrete');
  assert.equal(summarizeReminders([R(1, at(11, 18)), R(2, at(12, 8)), R(3, at(13, 8))], NOW), '1 hoje, 2 depois');
  assert.equal(summarizeReminders([R(1, at(11, 9))], NOW), '1 atrasado(s)');
});

test('lembretes: atalhos de "quando" são frases que o servidor entende', () => {
  assert.ok(QUICK_WHEN.length >= 4);
  for (const q of QUICK_WHEN) assert.ok(q.label && q.when, q.label);
  assert.ok(QUICK_WHEN.some((q) => q.when === 'amanhã às 9h'));
});

test('lembretes: validação do que foi digitado', () => {
  assert.equal(reminderInputProblem('pagar a conta', 'amanhã às 9h'), null);
  assert.match(reminderInputProblem('  ', 'amanhã às 9h'), /do que devo te lembrar/i);
  assert.match(reminderInputProblem('x', ' '), /Diga quando/);
  assert.match(reminderInputProblem('x'.repeat(301), 'amanhã'), /longo demais/);
});

test('a aba Lembretes existe e só o dono vê', () => {
  assert.ok(TABS.some((t) => t.key === 'reminders' && t.label === 'Lembretes'));
  assert.equal(tabVisible('reminders', { showAdmin: false }), false);
  assert.equal(tabVisible('reminders', { showAdmin: true }), true);
});

test('cliente: chamadas dos lembretes pela API da Yui', async () => {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), method: init?.method, body: init?.body ? JSON.parse(init.body) : null });
    return new Response(JSON.stringify({ ok: true, reminders: [], text: 'RESUMO' }), { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  const c = createClient({ baseUrl: 'http://yui.local:3939', token: 'tok-1234567890123456', fetchImpl });
  await c.reminders.list();
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/reminders');
  await c.reminders.add('pagar a conta', 'amanhã às 9h');
  assert.deepEqual(calls.at(-1).body, { text: 'pagar a conta', when: 'amanhã às 9h' });
  assert.equal(calls.at(-1).method, 'POST');
  await c.reminders.snooze(7, { minutes: 30 });
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/reminders/7/snooze');
  assert.deepEqual(calls.at(-1).body, { minutes: 30 });
  await c.reminders.snooze(7, { when: 'amanhã às 9h' });
  assert.deepEqual(calls.at(-1).body, { when: 'amanhã às 9h' });
  await c.reminders.remove(7);
  assert.equal(calls.at(-1).method, 'DELETE');
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/reminders/7');
  assert.equal((await c.reminders.morningPreview()).text, 'RESUMO');
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/morning');
  await c.reminders.morningSend();
  assert.equal(calls.at(-1).url, 'http://yui.local:3939/v1/admin/morning/send');
  assert.equal(calls.at(-1).method, 'POST');
});
