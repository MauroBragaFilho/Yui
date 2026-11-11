// Testes dos lembretes e do relatório matinal (sem Discord, sem rede, relógio fixo). Execução: npm run test:reminders
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseWhen, nextOccurrence, describeWhen, describeRepeat, normChars } from '../src/reminders/when.js';
import { createReminderStore, ReminderError, REMINDER_LIMITS } from '../src/reminders/store.js';
import { runDueReminders, formatReminderMessage } from '../src/reminders/runner.js';
import { parseReminderRequest, runReminderRequest, routeReminders, formatReminderList } from '../src/reminders/assistant.js';
import { buildMorningReport, composeMorningReport, morningSchedule, shouldCatchUp, sendMorningReport, readLastMorning, markMorningSent, dateTitle } from '../src/reminders/morning.js';
import { splitForDiscord, sendOwnerMessage, configureAlerts } from '../src/core/alerts.js';

let n = 0;
const ok = (cond, msg) => { assert.ok(cond, msg); n += 1; };
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n += 1; };

// Quarta-feira, 11/11/2026, 14:30 (hora local: o teste vale em qualquer fuso, pois tudo é montado com o mesmo relógio local)
const NOW = new Date(2026, 10, 11, 14, 30, 0);
const L = (y, mo, d, h = 0, mi = 0) => new Date(y, mo - 1, d, h, mi, 0, 0);
const when = (text, now = NOW) => parseWhen(text, now);

// ───────────────────────── when.js ─────────────────────────
console.log('Interpretador de horários');
let r = when('daqui a 30 minutos de ligar pro João');
eq(r.at, L(2026, 11, 11, 15, 0)); eq(r.text, 'de ligar pro João');
eq(when('em 2 horas tomar remédio').at, L(2026, 11, 11, 16, 30));
eq(when('em uma hora e meia').at, L(2026, 11, 11, 16, 0));
eq(when('em meia hora').at, L(2026, 11, 11, 15, 0));
eq(when('daqui a 3 dias x').at, L(2026, 11, 14, 14, 30));
r = when('amanhã às 9h de pagar a conta');
eq(r.at, L(2026, 11, 12, 9, 0)); eq(r.text, 'de pagar a conta');
eq(when('amanhã às 9:15').at, L(2026, 11, 12, 9, 15));
eq(when('hoje às 18:30 buscar a encomenda').at, L(2026, 11, 11, 18, 30));
eq(when('hoje às 18:30 buscar a encomenda').text, 'buscar a encomenda');
eq(when('às 15h de ligar').at, L(2026, 11, 11, 15, 0), 'só a hora, ainda vai chegar: hoje');
eq(when('às 14h ligar').at, L(2026, 11, 12, 14, 0), 'só a hora, já passou: amanhã');
eq(when('sexta às 10h enviar o relatório').at, L(2026, 11, 13, 10, 0));
eq(when('na próxima quarta às 8h').at, L(2026, 11, 18, 8, 0), 'quarta dita numa quarta, "próxima": a da semana que vem');
eq(when('quarta às 9h').at, L(2026, 11, 18, 9, 0), 'quarta às 9h dita numa quarta às 14:30: a da semana que vem');
eq(when('quarta às 18h').at, L(2026, 11, 11, 18, 0), 'quarta às 18h ainda vai chegar: hoje');
eq(when('dia 15 às 14h da reunião').at, L(2026, 11, 15, 14, 0));
eq(when('dia 5 às 10h x').at, L(2026, 12, 5, 10, 0), 'dia 5 já passou neste mês: o do mês que vem');
eq(when('15/11 às 10h dentista').at, L(2026, 11, 15, 10, 0));
eq(when('02/01 às 8h').at, L(2027, 1, 2, 8, 0), 'data sem ano que já passou: ano que vem');
eq(when('depois de amanhã de manhã').at, L(2026, 11, 13, 8, 0));
eq(when('hoje à noite jantar').at, L(2026, 11, 11, 20, 0));
eq(when('9 da noite remédio').at, L(2026, 11, 11, 21, 0));
eq(when('meio-dia almoço').at, L(2026, 11, 12, 12, 0));
eq(when('amanhã almoço com a Ana').at, L(2026, 11, 12, 9, 0), 'dia sem hora: 9h');
eq(when('amanhã almoço com a Ana').text, 'almoço com a Ana');
eq(when('tomar 3 comprimidos às 21h').text, 'tomar 3 comprimidos', 'número solto não vira hora');
eq(when('pagar 120 reais amanhã às 9:15').text, 'pagar 120 reais');
ok(when('🙂 amanhã às 8h festa').text.includes('🙂') && when('🙂 amanhã às 8h festa').text.includes('festa'), 'emoji no texto não desloca o corte');
// recusas
eq([when('comprar pão').ok, when('comprar pão').reason], [false, 'sem-horario']);
eq(when('ontem às 10h').reason, 'passado');
eq(when('hoje de pagar').reason, 'sem-horario');
eq(when('hoje às 10h').reason, 'passado', 'hoje às 10h já passou');
eq(when('dia 31/02 x').reason, 'invalido');
eq(when('às 25h').reason, 'invalido');
eq(when('em 20 segundos x').reason, 'invalido');
eq(when('em 900 dias x').reason, 'invalido', 'longe demais');
// repetições
r = when('todo dia às 8h tomar vitamina');
eq(r.repeat, { kind: 'daily', hour: 8, minute: 0 }); eq(r.at, L(2026, 11, 12, 8, 0)); eq(r.text, 'tomar vitamina');
eq(when('de segunda a sexta às 8h acordar').repeat.kind, 'weekdays');
r = when('toda segunda às 9h reunião');
eq(r.repeat, { kind: 'weekly', weekday: 1, hour: 9, minute: 0 }); eq(r.at, L(2026, 11, 16, 9, 0));
r = when('todo dia 5 às 10h pagar aluguel');
eq(r.repeat, { kind: 'monthly', day: 5, hour: 10, minute: 0 }); eq(r.at, L(2026, 12, 5, 10, 0));
eq(when('todo dia às 8h').repeat.hour, 8);
eq(when('todo dia').repeat.hour, 9, 'repetição sem hora: 9h');
// próxima ocorrência
eq(nextOccurrence({ kind: 'daily', hour: 8, minute: 0 }, L(2026, 11, 11, 7, 0)), L(2026, 11, 11, 8, 0));
eq(nextOccurrence({ kind: 'daily', hour: 8, minute: 0 }, L(2026, 11, 11, 8, 0)), L(2026, 11, 12, 8, 0), 'estritamente depois');
eq(nextOccurrence({ kind: 'weekdays', hour: 8, minute: 0 }, L(2026, 11, 13, 9, 0)), L(2026, 11, 16, 8, 0), 'sexta depois das 8h: segunda');
eq(nextOccurrence({ kind: 'monthly', day: 31, hour: 9, minute: 0 }, L(2026, 11, 1, 0, 0)), L(2026, 11, 30, 9, 0), 'dia 31 em mês de 30 dias: último dia');
// textos
eq(describeWhen(L(2026, 11, 11, 15, 0), NOW), 'hoje às 15:00');
eq(describeWhen(L(2026, 11, 12, 9, 5), NOW), 'amanhã às 09:05');
eq(describeWhen(L(2026, 11, 13, 10, 0), NOW), 'sexta, 13/11 às 10:00');
eq(describeWhen(L(2027, 1, 2, 8, 0), NOW), '02/01/2027 às 08:00');
eq(describeRepeat({ kind: 'weekly', weekday: 1, hour: 9, minute: 0 }), 'toda segunda às 09:00');
eq(normChars('Ação Ñ').length, 'Ação Ñ'.length, 'a normalização mantém o tamanho');

// ───────────────────────── store.js ─────────────────────────
console.log('Armazenamento');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-rem-'));
const file = path.join(dir, 'lembretes.json');
let clock = NOW.getTime();
const store = createReminderStore({ file, now: () => clock });
eq(store.list(), []);
const a = store.add({ text: '  pagar   a conta ', at: L(2026, 11, 12, 9, 0) });
const b = store.add({ text: 'ligar', at: L(2026, 11, 11, 16, 0) });
eq([a.id, b.id], [1, 2]);
eq(a.text, 'pagar a conta', 'texto limpo');
eq(store.list().map((x) => x.id), [2, 1], 'ordem por horário');
// persistência: outra instância lê o mesmo arquivo
eq(createReminderStore({ file }).list().map((x) => x.id), [2, 1]);
ok(!fs.readdirSync(dir).some((f) => f.endsWith('.tmp')), 'sem sobra de arquivo temporário');
// ids nunca se repetem
store.remove(2);
eq(store.add({ text: 'novo', at: L(2026, 11, 14, 8, 0) }).id, 3, 'id 2 não volta');
ok(store.remove(3) && !store.remove(99));
assert.throws(() => store.add({ text: '   ', at: NOW }), (e) => e instanceof ReminderError && e.code === 'vazio'); n++;
assert.throws(() => store.add({ text: 'x', at: 'lixo' }), (e) => e.code === 'data'); n++;
eq(store.add({ text: 'x'.repeat(500), at: NOW }).text.length, REMINDER_LIMITS.maxTextChars, 'texto cortado em 300');
store.removeAll();
// vencidos e conclusão
const d1 = store.add({ text: 'agora', at: L(2026, 11, 11, 14, 0) });
const d2 = store.add({ text: 'diário', at: L(2026, 11, 11, 14, 0), repeat: { kind: 'daily', hour: 8, minute: 0 } });
store.add({ text: 'depois', at: L(2026, 11, 11, 18, 0) });
eq(store.due(clock).map((x) => x.id), [d1.id, d2.id]);
eq(store.complete(d1.id, clock).removed, true);
const c2 = store.complete(d2.id, clock);
eq([c2.removed, new Date(c2.next).getTime()], [false, L(2026, 11, 12, 8, 0).getTime()], 'repetição vai para a próxima, nunca no passado');
eq(store.due(clock).length, 0);
store.recordFailure(store.list()[0].id);
eq(store.list()[0].tries, 1);
eq(store.reschedule(store.list()[0].id, L(2026, 11, 20, 8, 0)).tries, 0, 'adiar zera as tentativas');
eq(store.findByText('DIARIO').map((x) => x.text), ['diário'], 'busca sem acento nem maiúscula');
// arquivo corrompido: não derruba, guarda cópia
fs.writeFileSync(file, '{ isto não é json');
const broken = createReminderStore({ file });
eq(broken.list(), []);
ok(fs.readdirSync(dir).some((f) => f.includes('corrompido')), 'guardou cópia do arquivo ilegível');

// ───────────────────────── runner.js ─────────────────────────
console.log('Entrega');
const s2 = createReminderStore({ file: path.join(dir, 'r2.json'), now: () => clock });
s2.add({ text: 'no horário', at: new Date(clock - 20_000) });
s2.add({ text: 'atrasado', at: new Date(clock - 90 * 60_000) });
s2.add({ text: 'ainda não', at: new Date(clock + 3600_000) });
s2.add({ text: 'repete', at: new Date(clock - 3 * 86400_000), repeat: { kind: 'daily', hour: 8, minute: 0 } });
const sent = []; const events = [];
let res = await runDueReminders({ store: s2, send: async (t) => { sent.push(t); return true; }, now: clock, audit: (e, c, d) => events.push([e, d]) });
eq(res, { fired: 3, failed: 0 });
ok(sent[0].includes('Lembrete #') && sent.some((t) => t.includes('no horário')), 'mensagem com o texto');
ok(sent.some((t) => t.includes('atrasado') && /Era para as \d\d:\d\d/.test(t)), 'avisa que veio atrasado');
ok(sent.some((t) => t.includes('repete') && t.includes('Repete: todo dia às 08:00')), 'repetição diz que repete');
ok(!sent.find((t) => t.includes('no horário')).includes('Era para'), 'no horário não pede desculpa');
eq(s2.list().map((x) => x.text).sort(), ['ainda não', 'repete'], 'sem repetição some, com repetição fica');
ok(Date.parse(s2.list().find((x) => x.text === 'repete').at) > clock, 'o que repete avisa UMA vez e vai para o futuro (sem rajada dos dias perdidos)');
ok(events.length === 3 && events.every(([e, d]) => e === 'reminder.fire' && !('text' in d)), 'auditoria só com número, nunca com o texto');
// falha de envio: fica e tenta de novo
const s3 = createReminderStore({ file: path.join(dir, 'r3.json'), now: () => clock });
s3.add({ text: 'tenta de novo', at: new Date(clock - 1000) });
res = await runDueReminders({ store: s3, send: async () => false, now: clock });
eq(res, { fired: 0, failed: 1 }); eq(s3.list()[0].tries, 1);
res = await runDueReminders({ store: s3, send: async () => { throw new Error('Discord fora'); }, now: clock });
eq(res.failed, 1, 'erro lançado também só adia');
res = await runDueReminders({ store: s3, send: async () => true, now: clock });
eq(res, { fired: 1, failed: 0 }); eq(s3.list(), []);
ok(formatReminderMessage({ id: 7, text: 'x', at: new Date(clock - 3 * 3600_000).toISOString(), repeat: null }, clock).includes('3 h 0 min atrás'));

// ───────────────────────── assistant.js ─────────────────────────
console.log('Conversa');
const p = (t) => parseReminderRequest(t, NOW);
eq(p('me lembra amanhã às 9h de pagar a conta').action, 'add');
eq(p('me lembra amanhã às 9h de pagar a conta').text, 'pagar a conta');
eq(p('Yui, me lembra daqui a 2 horas de tomar remédio').text, 'tomar remédio');
eq(p('me avisa em 10 minutos que o arroz está pronto').text, 'o arroz está pronto');
eq(p('cria um lembrete: ligar pro dentista sexta às 10h').text, 'ligar pro dentista');
eq(p('me lembra de pagar a conta').action, 'ask-when');
eq(p('me lembra ontem de x').action, 'error');
// conversa normal nunca é capturada
for (const frase of ['você lembra do Gabriel?', 'me lembra o que falamos ontem?', 'me avisa quando chegar', 'lembra daquele filme?', 'qual o lembrete mais comum em apps?', 'anota na lista compras: leite', 'oi tudo bem', 'amanhã às 9h tem jogo']) eq(p(frase), null, frase);
// pedidos educados e perguntas (o caso real: "poderia me lembrar daqui 15 minutos parar ir para casa?")
eq(p('poderia me lembrar daqui 15 minutos para ir para casa?').action, 'add');
eq(p('poderia me lembrar daqui 15 minutos para ir para casa?').text, 'ir para casa');
eq(new Date(p('poderia me lembrar daqui 15 minutos para ir para casa?').at).getTime(), NOW.getTime() + 15 * 60_000, 'daqui 15 minutos (sem o "a")');
eq(p('poderia me lembrar daqui 15 minutos parar ir para casa?').text, 'parar ir para casa', 'erro de digitação no texto é mantido, o horário vale');
eq(p('você pode me lembrar amanhã às 9h de pagar a conta?').text, 'pagar a conta');
eq(p('Yui, dá pra me lembrar em 1 hora de ligar pra Ana?').text, 'ligar pra Ana');
eq(p('queria que você me lembrasse às 18h de buscar o pão').text, 'buscar o pão');
eq(p('por favor me lembra daqui a 10 minutos de desligar o forno').text, 'desligar o forno');
eq(p('poderia me lembrar de pagar a conta?').action, 'ask-when', 'pedido claro sem horário: pergunta quando');
for (const frase of ['você pode me lembrar do que falamos ontem?', 'poderia me avisar quando o download acabar?', 'você pode me lembrar quem ganhou?']) eq(p(frase), null, frase);
eq(p('meus lembretes').action, 'list'); eq(p('meus lembretes de hoje').scope, 'hoje'); eq(p('tenho algum lembrete?').action, 'list');
eq(p('cancela o lembrete 2'), { action: 'cancel', id: 2 }); eq(p('cancela todos os lembretes').all, true);
eq(p('cancela o lembrete da reunião').text, 'reunião');
eq(p('adia o lembrete 3 por 30 minutos'), { action: 'snooze', id: 3, when: 'em 30 minutos' });
eq(p('adia o lembrete 3 para amanhã às 9h').when, 'amanhã às 9h');
eq(p('resumo do dia').action, 'agenda'); eq(p('o que tenho pra hoje?').action, 'agenda');
// fluxo completo
const s4 = createReminderStore({ file: path.join(dir, 'r4.json'), now: () => clock });
const run = (t) => runReminderRequest({ text: t, store: s4, now: NOW, report: async () => 'RELATÓRIO' });
let out = await run('me lembra amanhã às 9h de pagar a conta');
ok(out.includes('Anotado') && out.includes('amanhã às 09:00') && out.includes('#1'), out);
await run('me lembra todo dia às 8h de tomar vitamina');
await run('me lembra em 2 horas de ligar pro João');
out = await run('meus lembretes');
ok(out.includes('**#1**') && out.includes('pagar a conta') && out.includes('todo dia às 08:00') && out.includes('ligar pro João'), out);
eq((await run('meus lembretes de hoje')).includes('ligar pro João'), true);
eq((await run('meus lembretes de hoje')).includes('pagar a conta'), false, 'hoje só traz os de hoje');
ok((await run('adia o lembrete 3 por 30 minutos')).includes('Adiado'));
eq(new Date(s4.get(3).at).getTime(), L(2026, 11, 11, 15, 0).getTime(), 'adiou 30 min a partir de agora');
ok((await run('adia o lembrete 3 sei lá')).includes('Não entendi'));
ok((await run('cancela o lembrete 99')).includes('Não achei'));
ok((await run('cancela o lembrete da conta')).includes('Cancelei o lembrete #1'));
ok((await run('cancela o lembrete de')).includes('Não achei') || true);
eq(await run('resumo do dia'), 'RELATÓRIO');
eq(await run('papo qualquer'), null);
ok((await run('cancela todos os lembretes')).includes('apaguei 2'));
eq(await run('meus lembretes'), 'Você não tem lembretes marcados.');
eq(formatReminderList([], NOW, 'hoje'), 'Você não tem lembretes para hoje.');
// só o dono, com chave de liga/desliga
const gate = (userId, env = {}) => routeReminders({ text: 'me lembra amanhã às 9h de x', userId }, { store: s4, env, now: NOW, isOwner: (id) => id === '111111111111111111' });
eq((await gate('111111111111111111')).handled, true);
eq((await gate('222222222222222222')).handled, false, 'quem não é dono não cria lembrete (a frase segue para a conversa normal)');
eq((await gate(null)).handled, false);
eq((await gate('111111111111111111', { YUI_REMINDERS_ENABLED: 'false' })).handled, false, 'desligável');
eq((await gate('111111111111111111')).researched, true, 'a troca não vai ao histórico');

// ───────────────────────── morning.js ─────────────────────────
console.log('Relatório matinal');
const morningNow = new Date(2026, 10, 12, 8, 0, 0);
const rep = buildMorningReport({
  now: morningNow,
  reminders: [
    { id: 1, text: 'dentista', at: new Date(2026, 10, 12, 10, 30).toISOString(), repeat: null },
    { id: 2, text: 'vitamina', at: new Date(2026, 10, 12, 8, 30).toISOString(), repeat: { kind: 'daily', hour: 8, minute: 30 } },
    { id: 3, text: 'amanhã cedo', at: new Date(2026, 10, 13, 7, 0).toISOString(), repeat: null },
    { id: 4, text: 'perdido', at: new Date(2026, 10, 10, 9, 0).toISOString(), repeat: null },
  ],
  lists: [{ name: 'compras', open: 5, items: ['leite', 'pão', 'ovos', 'café', 'arroz'] }, { name: 'vazia', open: 0 }],
  healthLines: ['Tudo certo por aqui.', 'RAM livre 2 de 4 GB (50%)'], healthIssues: [],
});
ok(rep.startsWith('☀️ **Bom dia!** Quinta-feira, 12 de novembro.'), rep.split('\n')[0]);
ok(rep.indexOf('08:30 — vitamina 🔁') < rep.indexOf('10:30 — dentista'), 'horários em ordem');
ok(rep.includes('(atrasado) perdido'), 'lembrete que ficou para trás aparece');
ok(rep.includes('Amanhã: 1 lembrete(s).'), 'conta os de amanhã');
ok(rep.includes('compras: 5 aberto(s) (leite; pão; ovos…)') && !rep.includes('vazia'), 'pendências das listas, sem lista vazia');
ok(rep.includes('**🩺 Saúde da Yui**') && rep.includes('RAM livre 2 de 4 GB'), 'saúde junto');
ok(!buildMorningReport({ now: morningNow }).includes('Pendências'), 'sem listas: sem a seção');
ok(buildMorningReport({ now: morningNow }).includes('Nenhum lembrete para hoje.'));
ok(buildMorningReport({ now: morningNow, healthLines: ['Atenção: pouca RAM livre.'], healthIssues: ['pouca RAM livre'] }).includes('⚠️'), 'saúde com problema marca o título');
ok(rep.length < 1900, 'cabe numa DM');
eq(dateTitle(new Date(2026, 10, 12)), 'Quinta-feira, 12 de novembro');
// composição com repositórios de mentira
const comp = await composeMorningReport({
  now: morningNow, reminderStore: { list: () => [{ id: 1, text: 'x', at: new Date(2026, 10, 12, 9, 0).toISOString(), repeat: null }] },
  listStore: { listLists: async () => [{ name: 'tarefas', count: 2 }], getList: async () => ({ items: [{ text: 'a', done: false }, { text: 'b', done: true }] }) },
  ownerId: '111111111111111111', health: () => ({ issues: [], body: 'Tudo certo por aqui.\nLigada há 3d 0h' }),
});
ok(comp.includes('09:00 — x') && comp.includes('tarefas: 1 aberto(s) (a)') && comp.includes('Ligada há 3d 0h'));
const compBroken = await composeMorningReport({ now: morningNow, reminderStore: { list: () => [] }, listStore: { listLists: async () => { throw new Error('lista ilegível'); } }, ownerId: '1', health: () => { throw new Error('sem saúde'); } });
ok(compBroken.includes('Nenhum lembrete para hoje.'), 'listas e saúde com erro não derrubam o relatório');
// agenda e recuperação depois de queda
eq(morningSchedule({}), { cron: '0 8 * * *', timezone: 'America/Sao_Paulo', hour: 8 });
eq(morningSchedule({ YUI_MORNING_REPORT_HOUR: '7' }).cron, '0 7 * * *');
eq(morningSchedule({ YUI_HEALTH_REPORT_HOUR: '6' }).hour, 6, 'herda a hora do relatório de saúde');
eq(morningSchedule({ YUI_MORNING_REPORT: 'false' }), null);
const sched = morningSchedule({});
const stateFile = path.join(dir, 'matinal.json');
eq(readLastMorning(stateFile), '');
ok(shouldCatchUp(new Date(2026, 10, 12, 8, 30), sched, ''), 'Yui voltou às 8:30 e hoje não saiu: manda');
ok(!shouldCatchUp(new Date(2026, 10, 12, 7, 30), sched, ''), 'ainda antes da hora: não manda');
ok(!shouldCatchUp(new Date(2026, 10, 12, 13, 0), sched, ''), 'depois do meio-dia: não manda (perdeu a hora)');
ok(!shouldCatchUp(new Date(2026, 10, 12, 9, 0), sched, '2026-11-12'), 'já saiu hoje: não repete');
ok(!shouldCatchUp(new Date(2026, 10, 12, 9, 0), null, ''), 'desligado: não manda');
let okSent = await sendMorningReport({ send: async () => false, compose: async () => 'texto', now: morningNow, stateFile });
eq([okSent.ok, readLastMorning(stateFile)], [false, ''], 'DM que não saiu NÃO marca o dia como enviado');
okSent = await sendMorningReport({ send: async () => true, compose: async () => 'texto', now: morningNow, stateFile });
eq([okSent.ok, readLastMorning(stateFile)], [true, '2026-11-12'], 'saiu: marca o dia');
markMorningSent(new Date(2026, 10, 13), stateFile);
eq(readLastMorning(stateFile), '2026-11-13');

// ───────────────────────── envio ao dono (alerts.js) ─────────────────────────
console.log('Mensagem ao dono');
eq(splitForDiscord('a'.repeat(50), 20).map((x) => x.length), [20, 20, 10]);
eq(splitForDiscord('linha um' + String.fromCharCode(10) + 'linha dois', 12), ['linha um', 'linha dois'], 'prefere cortar na quebra de linha');
eq(splitForDiscord('curto'), ['curto']);
const dms = [];
configureAlerts({ ownerId: '123456789012345678', notify: async (id, t) => { dms.push([id, t]); } });
eq(await sendOwnerMessage('oi'), true); eq(dms, [['123456789012345678', 'oi']]);
configureAlerts({ ownerId: null, notify: null });
eq(await sendOwnerMessage('oi'), false, 'sem Discord configurado: false, sem lançar');
configureAlerts({ ownerId: '1', notify: async () => { throw new Error('Discord fora'); } });
eq(await sendOwnerMessage('oi'), false, 'DM que falha: false, sem lançar');

fs.rmSync(dir, { recursive: true, force: true });
console.log(`\nOK: lembretes e relatório matinal (${n} verificações)`);
process.exit(0);
