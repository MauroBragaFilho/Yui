// O FUSO DO DONO (YUI_FUSO, src/core/fuso.js): a hora, o "hoje", o "amanhã", os lembretes, o relatório matinal, o Google e a data da pesquisa seguem o fuso da pessoa
// (Cuiabá, UTC-4, ou Brasília, UTC-3), nunca o do processo; e a infraestrutura (resets do GTA em UTC, chave da semana, agendadores em UTC, cota, logs) NÃO muda.
// Sem rede, sem Discord, relógio fixo. Execução: npm run test:fusodono
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const raiz = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-fuso-'));
process.env.DATABASE_DIR = tmp;
process.env.YUI_OWNER_ID = '111';
process.env.YUI_OWNER_NAME = 'Mauro';
delete process.env.YUI_PERSONA_PERSONAL_FILE;

const { FUSO_PADRAO, fusoDoDono, fusoValido, reiniciarAvisosDoFuso, partesNoFuso, instanteNoFuso, rotuloDoFuso, chaveDoDia } = await import('../src/core/fuso.js');
const { parseWhen, nextOccurrence, describeWhen } = await import('../src/reminders/when.js');
const { createReminderStore } = await import('../src/reminders/store.js');
const { runDueReminders, formatReminderMessage } = await import('../src/reminders/runner.js');
const { runReminderRequest, formatReminderList } = await import('../src/reminders/assistant.js');
const { buildMorningReport, composeMorningReport, morningSchedule, shouldCatchUp, greeting, dateTitle } = await import('../src/reminders/morning.js');
const { healthReportSchedule } = await import('../src/core/healthReport.js');
const { buildContext } = await import('../src/core/permissions.js');
const { buildPersonaPrompt } = await import('../src/core/persona.js');
const { todayBR } = await import('../src/core/ai/researchAgent.js');
const google = await import('../src/integrations/google/config.js');
const googleFuso = await import('../src/integrations/google/fuso.js');
const { consultarClima } = await import('../src/core/tools/clima.js');
const { previsaoFalsa } = await import('./helpers/climaFalso.js');
const { getSeedValue } = await import('../src/utils/gtaSeed.js');
const { getCurrentWeekKey } = await import('../src/utils/weekKey.js');

let n = 0;
const eq = (a, b, msg) => { assert.deepEqual(a, b, msg); n += 1; };
const ok = (c, msg) => { assert.ok(c, msg); n += 1; };
const iso = (s) => new Date(s);
const isoDe = (d) => new Date(d).toISOString();

const CB = 'America/Cuiaba';
const SP = 'America/Sao_Paulo';
const ENV_ORIGINAL = { YUI_FUSO: process.env.YUI_FUSO, TZ: process.env.TZ };

/** Roda `fn` com o fuso do dono e o do PROCESSO (TZ) escolhidos; devolve ao que era. */
async function emFuso(fuso, tz, fn) {
  const antes = { YUI_FUSO: process.env.YUI_FUSO, TZ: process.env.TZ };
  if (fuso === undefined) delete process.env.YUI_FUSO; else process.env.YUI_FUSO = fuso;
  if (tz === undefined) delete process.env.TZ; else process.env.TZ = tz;
  try { return await fn(); } finally {
    if (antes.YUI_FUSO === undefined) delete process.env.YUI_FUSO; else process.env.YUI_FUSO = antes.YUI_FUSO;
    if (antes.TZ === undefined) delete process.env.TZ; else process.env.TZ = antes.TZ;
  }
}
// O fuso do processo NÃO pode importar: cada caso roda sob estes três (o do próprio computador, UTC e o do Japão, longe dos dois).
const PROCESSOS = [ENV_ORIGINAL.TZ, 'UTC', 'Asia/Tokyo'];
async function emTodosOsProcessos(fuso, fn) {
  const saidas = [];
  for (const tz of PROCESSOS) saidas.push(await emFuso(fuso, tz, fn));
  for (const s of saidas.slice(1)) assert.deepEqual(s, saidas[0], `o resultado mudou com o fuso do processo (${fuso})`);
  n += 1;
  return saidas[0];
}

// Instantes de referência (quinta-feira, 19/11/2026, e a virada do dia):
const T1 = iso('2026-11-19T13:30:00Z'); // Brasília 10:30, Cuiabá 09:30
const T2 = iso('2026-11-20T03:30:00Z'); // Brasília 00:30 de sexta (20), Cuiabá 23:30 de quinta (19)
const T3 = iso('2026-11-19T08:30:00Z'); // Brasília 05:30 (manhã), Cuiabá 04:30 (ainda madrugada)

// ───────────────────────── 1. o módulo do fuso ─────────────────────────
console.log('1. O módulo do fuso (src/core/fuso.js)');
eq(FUSO_PADRAO, SP, 'o padrão do código é America/Sao_Paulo');
eq(fusoDoDono({}), SP, 'sem a chave: o padrão');
eq(fusoDoDono({ YUI_FUSO: '' }), SP); eq(fusoDoDono({ YUI_FUSO: '   ' }), SP);
eq(fusoDoDono({ YUI_FUSO: CB }), CB); eq(fusoDoDono({ YUI_FUSO: ` ${SP} ` }), SP, 'espaços em volta não atrapalham');
{
  reiniciarAvisosDoFuso();
  const avisos = [];
  const aviso = (t) => avisos.push(t);
  eq(fusoDoDono({ YUI_FUSO: 'Marte/Olympus' }, { aviso }), SP, 'valor inválido cai no padrão');
  eq(fusoDoDono({ YUI_FUSO: 'Marte/Olympus' }, { aviso }), SP);
  eq(fusoDoDono({ YUI_FUSO: 'Marte/Olympus' }, { aviso }), SP);
  eq(avisos.length, 1, 'e avisa UMA vez só (não a cada uso)');
  ok(/YUI_FUSO/.test(avisos[0]) && /Marte\/Olympus/.test(avisos[0]) && /America\/Sao_Paulo/.test(avisos[0]), 'o aviso diz a chave, o valor e o fuso usado');
  eq(fusoDoDono({ YUI_FUSO: 'Outro/Lugar' }, { aviso }), SP);
  eq(avisos.length, 2, 'outro valor inválido avisa uma vez também');
  eq(fusoDoDono({ YUI_FUSO: CB }, { aviso }), CB); eq(avisos.length, 2, 'valor bom nunca avisa');
  eq(fusoDoDono({ YUI_FUSO: 'x'.repeat(5000) }, { aviso: () => { throw new Error('aviso quebrado'); } }), SP, 'um aviso que lança não derruba a conversa');
}
ok(fusoValido(CB) && fusoValido('UTC') && !fusoValido('Marte/Olympus') && !fusoValido(''), 'fusoValido');
eq(partesNoFuso(T2, CB), { ano: 2026, mes: 11, dia: 19, hora: 23, minuto: 30, segundo: 0, semana: 4 });
eq(partesNoFuso(T2, SP), { ano: 2026, mes: 11, dia: 20, hora: 0, minuto: 30, segundo: 0, semana: 5 }, 'meia-noite é hora 0, nunca 24');
eq(isoDe(instanteNoFuso(2026, 11, 20, 9, 0, CB)), '2026-11-20T13:00:00.000Z');
eq(isoDe(instanteNoFuso(2026, 11, 20, 9, 0, SP)), '2026-11-20T12:00:00.000Z');
eq(isoDe(instanteNoFuso(2026, 11, 32, 9, 0, CB)), '2026-12-02T13:00:00.000Z', 'dia 32 vira o mês seguinte');
eq(chaveDoDia(T2, CB), '2026-11-19'); eq(chaveDoDia(T2, SP), '2026-11-20');
eq([rotuloDoFuso(SP), rotuloDoFuso(CB), rotuloDoFuso('America/Manaus'), rotuloDoFuso('Asia/Tokyo')], ['horário de Brasília', 'horário de Cuiabá', 'horário de Manaus', 'fuso Asia/Tokyo']);

// ───────────────────────── 2. a persona e a hora que a Yui diz ─────────────────────────
console.log('2. Persona: a hora do fuso configurado, sem afirmar Brasília quando o fuso é outro');
const ctxDono = buildContext({ platform: 'discord', userId: '111', isDM: true });
const persona = (fuso, agora) => emFuso(fuso, undefined, () => buildPersonaPrompt(ctxDono, { now: agora }));
{
  const sp = await persona(undefined, T1); const cb = await persona(CB, T1);
  ok(sp.includes('Hoje é quinta-feira, 19 de novembro de 2026, 10:30 (horário de Brasília).'), sp.slice(-120));
  ok(cb.includes('Hoje é quinta-feira, 19 de novembro de 2026, 09:30 (horário de Cuiabá).'), cb.slice(-120));
  ok(!/Brasília/.test(cb.slice(cb.lastIndexOf('Hoje é'))), 'com Cuiabá a frase final não cita Brasília');
  const manaus = await persona('America/Manaus', T1); ok(manaus.includes('09:30 (horário de Manaus).'));
  const tokyo = await persona('Asia/Tokyo', T1); ok(tokyo.includes('22:30 (fuso Asia/Tokyo).') && !tokyo.slice(tokyo.lastIndexOf('Hoje é')).includes('Brasília'));
  // virada do dia: o MESMO instante é sexta de madrugada num fuso e quinta à noite no outro
  ok((await persona(SP, T2)).includes('Hoje é sexta-feira, 20 de novembro de 2026, 00:30 (horário de Brasília).'));
  ok((await persona(CB, T2)).includes('Hoje é quinta-feira, 19 de novembro de 2026, 23:30 (horário de Cuiabá).'));
  eq(await emTodosOsProcessos(CB, () => buildPersonaPrompt(ctxDono, { now: T2 }).slice(-90)), (await persona(CB, T2)).slice(-90), 'o fuso do processo não importa');
}

// ───────────────────────── 3. lembretes: "amanhã às 9h" e a virada do dia ─────────────────────────
console.log('3. Interpretação de horários no fuso do dono');
const quando = (texto, fuso, agora) => emTodosOsProcessos(fuso, () => { const r = parseWhen(texto, agora); return r.ok ? isoDe(r.at) : `${r.reason}`; });
eq(await quando('amanhã às 9h de pagar a conta', CB, T1), '2026-11-20T13:00:00.000Z', 'Cuiabá: 9h de sexta = 13:00Z');
eq(await quando('amanhã às 9h de pagar a conta', SP, T1), '2026-11-20T12:00:00.000Z', 'Brasília: 9h de sexta = 12:00Z');
eq(await quando('amanhã às 9h', CB, T2), '2026-11-20T13:00:00.000Z', 'perto da meia-noite: em Cuiabá ainda é quinta, "amanhã" é sexta');
eq(await quando('amanhã às 9h', SP, T2), '2026-11-21T12:00:00.000Z', 'perto da meia-noite: em Brasília já é sexta, "amanhã" é sábado');
eq(await quando('hoje às 23:45', CB, T2), '2026-11-20T03:45:00.000Z');
eq(await quando('hoje às 23:45', SP, T2), '2026-11-21T02:45:00.000Z');
eq(await quando('hoje às 23h', CB, T2), 'passado', 'em Cuiabá as 23h de quinta já passaram (23:30)');
eq(await quando('sexta às 10h', CB, T2), '2026-11-20T14:00:00.000Z', 'em Cuiabá ainda é quinta: a sexta é amanhã');
eq(await quando('sexta às 10h', SP, T2), '2026-11-20T13:00:00.000Z', 'em Brasília já é sexta: hoje, 10h');
eq(await quando('depois de amanhã às 8h', CB, T2), '2026-11-21T12:00:00.000Z');
eq(await quando('em 2 horas', CB, T1), '2026-11-19T15:30:00.000Z', 'duração relativa: o mesmo instante em qualquer fuso');
eq(await quando('em 2 horas', SP, T1), '2026-11-19T15:30:00.000Z');
eq(await quando('dia 25 às 14h', CB, T1), '2026-11-25T18:00:00.000Z');
eq(await quando('25/12 às 10h', SP, T1), '2026-12-25T13:00:00.000Z');
eq(await quando('às 15h', CB, T1), '2026-11-19T19:00:00.000Z', 'só a hora, ainda por vir hoje');
eq(await quando('às 8h', CB, T1), '2026-11-20T12:00:00.000Z', 'só a hora, já passou: amanhã');
eq(await quando('todo dia às 8h', CB, T2), '2026-11-20T12:00:00.000Z', 'repetição: a próxima 8h do relógio de Cuiabá');
eq(await quando('todo dia às 8h', SP, T2), '2026-11-20T11:00:00.000Z');
{
  const r = await emFuso(CB, undefined, () => parseWhen('todo dia às 8h de tomar vitamina', T2));
  eq(r.repeat, { kind: 'daily', hour: 8, minute: 0 }, 'a repetição guarda a hora do relógio do dono');
  eq(await emFuso(CB, undefined, () => isoDe(nextOccurrence({ kind: 'weekdays', hour: 9, minute: 0 }, iso('2026-11-20T14:00:00Z')))), '2026-11-23T13:00:00.000Z', 'de segunda a sexta: depois de sexta 10h vem segunda');
  eq(await emFuso(CB, undefined, () => isoDe(nextOccurrence({ kind: 'monthly', day: 31, hour: 9, minute: 0 }, iso('2026-11-30T20:00:00Z')))), '2026-12-31T13:00:00.000Z');
}
eq(await emTodosOsProcessos(CB, () => describeWhen(iso('2026-11-20T13:00:00Z'), T2)), 'amanhã às 09:00');
eq(await emTodosOsProcessos(SP, () => describeWhen(iso('2026-11-20T13:00:00Z'), T2)), 'hoje às 10:00');
eq(await emFuso(CB, undefined, () => describeWhen(iso('2026-11-23T13:00:00Z'), T1)), 'segunda, 23/11 às 09:00');
eq(await emFuso(CB, undefined, () => describeWhen(iso('2027-01-05T13:00:00Z'), T1)), '05/01/2027 às 09:00');
eq(await emFuso(CB, undefined, () => isoDe(parseWhen('amanhã às 9h', T1, { fuso: SP }).at)), '2026-11-20T12:00:00.000Z', 'o fuso também pode ser dado na chamada');

// a conversa de ponta a ponta: o que é GRAVADO e o que a Yui responde
{
  const store = createReminderStore({ file: path.join(tmp, 'novo-cb.json'), now: () => T1.getTime() });
  const resp = await emFuso(CB, 'UTC', () => runReminderRequest({ text: 'me lembra amanhã às 9h de pagar a conta', store, now: T1 }));
  ok(/amanhã às 09:00/.test(resp), resp);
  eq(store.list()[0].at, '2026-11-20T13:00:00.000Z', 'novo lembrete de Cuiabá grava 9h de Cuiabá (13:00Z)');
  const store2 = createReminderStore({ file: path.join(tmp, 'novo-sp.json'), now: () => T1.getTime() });
  await emFuso(undefined, 'UTC', () => runReminderRequest({ text: 'me lembra amanhã às 9h de pagar a conta', store: store2, now: T1 }));
  eq(store2.list()[0].at, '2026-11-20T12:00:00.000Z', 'sem YUI_FUSO: 9h de Brasília (12:00Z), como sempre foi');
}

// ───────────────────────── 4. os lembretes que já existem NÃO se deslocam ─────────────────────────
console.log('4. Lembretes já gravados continuam no mesmo instante depois da troca de fuso');
{
  const arquivo = path.join(tmp, 'lembretes.json');
  const gravado = {
    nextId: 4,
    items: [
      { id: 1, text: 'dentista', at: '2026-11-20T13:00:00.000Z', repeat: null, createdAt: '2026-11-18T12:00:00.000Z', tries: 0, lastFiredAt: null, userId: null },
      { id: 2, text: 'vitamina', at: '2026-11-20T11:00:00.000Z', repeat: { kind: 'daily', hour: 8, minute: 0 }, createdAt: '2026-11-18T12:00:00.000Z', tries: 0, lastFiredAt: null, userId: null },
      { id: 3, text: 'dela', at: '2026-11-21T15:00:00.000Z', repeat: null, createdAt: '2026-11-18T12:00:00.000Z', tries: 0, lastFiredAt: null, userId: '222' },
    ],
  };
  fs.writeFileSync(arquivo, JSON.stringify(gravado, null, 2));
  const antes = await emFuso(SP, undefined, () => createReminderStore({ file: arquivo }).list().map((r) => [r.id, r.at]));
  const depois = await emFuso(CB, undefined, () => createReminderStore({ file: arquivo }).list().map((r) => [r.id, r.at]));
  eq(depois, antes, 'o arquivo guarda instantes UTC: a troca de fuso não mexe em nenhum');
  eq(antes.map((x) => x[1]), ['2026-11-20T11:00:00.000Z', '2026-11-20T13:00:00.000Z', '2026-11-21T15:00:00.000Z']);

  // disparam no MESMO instante nos dois fusos
  for (const fuso of [SP, CB, undefined]) {
    const copia = path.join(tmp, `disparo-${fuso ? fuso.replace('/', '_') : 'padrao'}.json`);
    fs.writeFileSync(copia, JSON.stringify(gravado));
    const enviados = [];
    const resultado = await emFuso(fuso, 'UTC', async () => {
      const store = createReminderStore({ file: copia });
      const linhas = [];
      for (const agora of ['2026-11-20T10:59:00Z', '2026-11-20T11:00:00Z', '2026-11-20T12:59:00Z', '2026-11-20T13:00:00Z']) {
        const antesN = enviados.length;
        await runDueReminders({ store, now: Date.parse(agora), send: async (t, r) => { enviados.push(r.id); return true; } });
        linhas.push([agora, enviados.slice(antesN)]);
      }
      return linhas;
    });
    eq(resultado, [['2026-11-20T10:59:00Z', []], ['2026-11-20T11:00:00Z', [2]], ['2026-11-20T12:59:00Z', []], ['2026-11-20T13:00:00Z', [1]]], `disparo nos mesmos instantes (YUI_FUSO=${fuso})`);
  }

  // só a ESCRITA da hora na lista muda, porque ela é lida no relógio do dono; o instante é o mesmo
  const lista = (fuso) => emFuso(fuso, undefined, () => formatReminderList(createReminderStore({ file: arquivo }).list(), iso('2026-11-20T10:00:00Z')).split('\n').filter((l) => l.includes('#1')).join(''));
  ok(/#1\*\* · hoje às 10:00/.test(await lista(SP)), await lista(SP));
  ok(/#1\*\* · hoje às 09:00/.test(await lista(CB)), await lista(CB));

  // a mensagem de atraso diz a hora do relógio do dono
  const r2 = { id: 2, text: 'vitamina', at: '2026-11-20T11:00:00.000Z', repeat: null };
  const atrasada = (fuso) => emFuso(fuso, 'UTC', () => formatReminderMessage(r2, Date.parse('2026-11-20T12:30:00Z')));
  ok((await atrasada(SP)).includes('Era para as 08:00'), await atrasada(SP));
  ok((await atrasada(CB)).includes('Era para as 07:00'), await atrasada(CB));

  // o que repete: o instante já gravado fica; a PRÓXIMA ocorrência segue a hora do relógio do dono (decisão documentada)
  const proxima = (fuso) => emFuso(fuso, 'UTC', () => {
    const c = path.join(tmp, `proxima-${fuso.replace('/', '_')}.json`); fs.writeFileSync(c, JSON.stringify(gravado));
    const store = createReminderStore({ file: c });
    store.complete(2, Date.parse('2026-11-20T11:00:05Z'));
    return store.get(2).at;
  });
  eq(await proxima(SP), '2026-11-21T11:00:00.000Z', '"todo dia às 8h" em Brasília: 11:00Z');
  eq(await proxima(CB), '2026-11-21T12:00:00.000Z', '"todo dia às 8h" em Cuiabá: 12:00Z (8h do relógio do dono)');
}

// ───────────────────────── 5. o relatório matinal ─────────────────────────
console.log('5. Relatório matinal: saudação, data, "hoje" e o horário do relatório');
{
  const lembretes = [{ id: 1, text: 'dentista', at: '2026-11-20T11:30:00.000Z', repeat: null }, { id: 2, text: 'remédio', at: '2026-11-20T23:00:00.000Z', repeat: { kind: 'daily', hour: 20 } }];
  const rel = (fuso, agora, extra = {}) => emTodosOsProcessos(fuso, () => buildMorningReport({ now: agora, reminders: lembretes, ...extra }));
  // virada do dia: 03:30Z é sexta 00:30 em Brasília e quinta 23:30 em Cuiabá
  const sp = await rel(SP, T2); const cb = await rel(CB, T2);
  ok(sp.startsWith('🌙 **Boa noite!** Sexta-feira, 20 de novembro.'), sp.split('\n')[0]);
  ok(cb.startsWith('🌙 **Boa noite!** Quinta-feira, 19 de novembro.'), cb.split('\n')[0]);
  ok(sp.includes('• 08:30 — dentista') && sp.includes('• 20:00 — remédio'), 'Brasília: os dois são de hoje');
  ok(cb.includes('Nenhum lembrete para hoje.') && cb.includes('-# Amanhã: 2 lembrete(s).'), 'Cuiabá: ainda é quinta, os dois são de amanhã');
  // 10:00Z: manhã nos dois
  const sp2 = await rel(SP, iso('2026-11-20T10:00:00Z')); const cb2 = await rel(CB, iso('2026-11-20T10:00:00Z'));
  ok(sp2.startsWith('☀️ **Bom dia!** Sexta-feira, 20 de novembro.') && cb2.startsWith('☀️ **Bom dia!** Sexta-feira, 20 de novembro.'));
  ok(sp2.includes('• 08:30 — dentista') && cb2.includes('• 07:30 — dentista'), 'a hora do lembrete é a do relógio do dono');
  ok(cb2.includes('• 19:00 — remédio'), cb2);
  // "atrasado" é o que ficou antes do começo do dia DO DONO: 03:30Z é 23:30 de ontem em Cuiabá, mas 00:30 de hoje em Brasília
  const perdido = [{ id: 9, text: 'perdido', at: '2026-11-20T03:30:00.000Z', repeat: null }];
  const manha = iso('2026-11-20T10:00:00Z');
  ok((await emFuso(CB, undefined, () => buildMorningReport({ now: manha, reminders: perdido }))).includes('• (atrasado) perdido'), 'Cuiabá: ficou para trás');
  const spPerdido = await emFuso(SP, undefined, () => buildMorningReport({ now: manha, reminders: perdido }));
  ok(!spPerdido.includes('(atrasado)') && spPerdido.includes('• 00:30 — perdido'), 'Brasília: é de hoje');
  eq(await emFuso(CB, undefined, () => greeting(T3).text), 'Boa noite', 'Cuiabá 04:30 ainda é madrugada');
  eq(await emFuso(SP, undefined, () => greeting(T3).text), 'Bom dia', 'Brasília 05:30 já é manhã');
  eq(await emFuso(CB, undefined, () => dateTitle(T2)), 'Quinta-feira, 19 de novembro');
  // o horário do relatório e do relatório de saúde é no fuso do dono
  eq(morningSchedule({ YUI_FUSO: CB }), { cron: '0 8 * * *', timezone: CB, hour: 8 });
  eq(morningSchedule({}), { cron: '0 8 * * *', timezone: SP, hour: 8 }, 'sem a chave: Brasília, como sempre');
  eq(healthReportSchedule({ YUI_FUSO: CB }), { cron: '0 8 * * *', timezone: CB, hour: 8 });
  eq(healthReportSchedule({}), { cron: '0 8 * * *', timezone: SP, hour: 8 });
  eq(healthReportSchedule({ YUI_FUSO: CB, YUI_HEALTH_REPORT_HOUR: '7' }).cron, '0 7 * * *');
  // a recuperação depois de uma queda usa o relógio do fuso do agendamento
  const agora = iso('2026-11-20T11:30:00Z'); // Brasília 08:30, Cuiabá 07:30
  ok(await emFuso(SP, 'UTC', () => shouldCatchUp(agora, morningSchedule({ YUI_FUSO: SP }), '')), 'Brasília 08:30: já passou das 8h, manda');
  ok(!(await emFuso(CB, 'UTC', () => shouldCatchUp(agora, morningSchedule({ YUI_FUSO: CB }), ''))), 'Cuiabá 07:30: ainda não deu a hora');
  ok(await emFuso(CB, 'UTC', () => shouldCatchUp(iso('2026-11-20T12:30:00Z'), morningSchedule({ YUI_FUSO: CB }), '')), 'Cuiabá 08:30: manda');
  ok(!(await emFuso(CB, 'UTC', () => shouldCatchUp(iso('2026-11-20T12:30:00Z'), morningSchedule({ YUI_FUSO: CB }), '2026-11-20'))), 'já saiu hoje (dia do dono): não repete');
  // composeMorningReport (o caminho real) lê o arquivo gravado
  const store = createReminderStore({ file: path.join(tmp, 'matinal.json') });
  store.add({ text: 'reunião', at: iso('2026-11-20T14:00:00Z') });
  const compo = await emFuso(CB, 'UTC', () => composeMorningReport({ now: iso('2026-11-20T10:00:00Z'), reminderStore: store }));
  ok(compo.includes('• 10:00 — reunião'), compo);
}

// ───────────────────────── 6. a data de hoje na pesquisa ─────────────────────────
console.log('6. Data de hoje na pesquisa');
eq(await emTodosOsProcessos(CB, () => todayBR(T2)), '19/11/2026');
eq(await emTodosOsProcessos(SP, () => todayBR(T2)), '20/11/2026');
eq(await emTodosOsProcessos(undefined, () => todayBR(T2)), '20/11/2026', 'sem a chave: Brasília');

// ───────────────────────── 7. Google: YUI_GOOGLE_FUSO, senão YUI_FUSO ─────────────────────────
console.log('7. Google: YUI_GOOGLE_FUSO se existir, senão YUI_FUSO');
eq(google.fusoDoGoogle({}), SP, 'nenhuma das duas: o padrão');
eq(google.fusoDoGoogle({ YUI_FUSO: CB }), CB, 'só YUI_FUSO: vale ele');
eq(google.fusoDoGoogle({ YUI_FUSO: CB, YUI_GOOGLE_FUSO: 'America/Manaus' }), 'America/Manaus', 'YUI_GOOGLE_FUSO tem a vez');
eq(google.fusoDoGoogle({ YUI_GOOGLE_FUSO: CB }), CB);
eq(google.fusoDoGoogle({ YUI_FUSO: CB, YUI_GOOGLE_FUSO: 'Marte/Olympus' }), CB, 'o do Google inválido cai no do dono');
eq(google.fusoDoGoogle({ YUI_GOOGLE_FUSO: 'Marte/Olympus' }), SP);
eq(google.FUSO_PADRAO, SP);
eq(isoDe(googleFuso.janelaDeConsulta('hoje', T2, google.fusoDoGoogle({ YUI_FUSO: CB })).de), '2026-11-19T04:00:00.000Z', 'a janela de "hoje" começa à meia-noite de Cuiabá');
eq(isoDe(googleFuso.janelaDeConsulta('hoje', T2, google.fusoDoGoogle({})).de), '2026-11-20T03:00:00.000Z', 'e à de Brasília sem a chave');
eq(googleFuso.dataDeHoje(T2, CB), '2026-11-19');
eq(googleFuso.formatarHora(T1, CB), '09:30');
eq(googleFuso.partesNoFuso(T2, CB), partesNoFuso(T2, CB), 'o Google usa as mesmas contas do módulo do fuso');

// ───────────────────────── 8. o clima: o "hoje" é o do LUGAR ─────────────────────────
console.log('8. Clima: o "hoje" segue o lugar (Open-Meteo, timezone=auto), não o fuso do dono');
{
  const pedidos = [];
  const fetchFalso = async (url) => {
    pedidos.push(String(url));
    const u = new URL(url);
    const corpo = u.pathname.endsWith('/geo')
      ? { results: [{ name: 'Manaus', latitude: -3.1019, longitude: -60.025, country: 'Brasil', admin1: 'Amazonas' }] }
      : previsaoFalsa(u.searchParams.get('latitude'), u.searchParams.get('longitude'), '2026-11-19');
    return { status: 200, ok: true, text: async () => JSON.stringify(corpo) };
  };
  const urls = { geocodificacao: 'http://clima.falso/geo', previsao: 'http://clima.falso/forecast' };
  const consulta = (fuso, tz) => emFuso(fuso, tz, () => consultarClima({ local: 'Manaus', quando: { tipo: 'hoje', rotulo: 'hoje' }, fetchImpl: fetchFalso, urls }));
  const a = await consulta(SP, 'UTC'); const b = await consulta(CB, 'Asia/Tokyo'); const c = await consulta(undefined, undefined);
  ok(a.ok && b.ok && c.ok);
  eq(b, a, 'o clima de "hoje" é igual com Cuiabá e com Brasília'); eq(c, a);
  eq(a.dados.dias.map((d) => d.data), ['2026-11-19'], 'o "hoje" é o dia que o Open-Meteo devolve para o lugar');
  ok(pedidos.filter((p) => p.includes('/forecast')).every((p) => new URL(p).searchParams.get('timezone') === 'auto'), 'o pedido manda timezone=auto (o dia é o do lugar)');
}

// ───────────────────────── 9. a infraestrutura NÃO mudou ─────────────────────────
console.log('9. Infraestrutura: resets do GTA, chave da semana, agendadores em UTC, cota e logs seguem o relógio deles');
{
  const infra = async (fuso) => emFuso(fuso, 'UTC', () => ({
    seed: String(getSeedValue(T2)), seed2: String(getSeedValue(iso('2026-11-20T05:59:59Z'))), seed3: String(getSeedValue(iso('2026-11-20T06:00:00Z'))),
    semana: getCurrentWeekKey(iso('2026-11-19T13:30:00Z')),
  }));
  const a = await infra(SP); const b = await infra(CB); const c = await infra(undefined);
  eq(b, a, 'seed do GTA e chave da semana iguais com qualquer YUI_FUSO'); eq(c, a);
  ok(a.seed !== a.seed3 && a.seed2 === a.seed, 'o reset do GTA continua às 06:00 UTC');
  const lerSrc = (rel) => fs.readFileSync(path.join(raiz, rel), 'utf8');
  const NAO_USAM = ['src/utils/gtaSeed.js', 'src/utils/weekKey.js', 'src/scheduler/scheduler.js', 'src/adaptadores/youtube/cota.js', 'src/services/tts/providers/omniroute.js', 'src/services/tts/providers/edge.js', 'src/utils/binaries.js', 'src/search/budget.js', 'src/search/cotaHora.js', 'src/core/audit.js', 'src/database/db.js', 'src/cerebro/monitores/store.js', 'src/cerebro/monitores/executor.js', 'src/core/api/admin.js'];
  for (const f of NAO_USAM) {
    if (f === 'src/core/api/admin.js') continue; // a API só chama o parseWhen/describeWhen, que já seguem o fuso (conferido nas seções 3 e 5)
    ok(!/core\/fuso|YUI_FUSO|fusoDoDono/.test(lerSrc(f)), `${f}: infraestrutura não lê o fuso do dono`);
  }
  eq((lerSrc('src/scheduler/scheduler.js').match(/timezone: 'UTC'/g) || []).length, 3, 'scheduler.js: os 3 agendadores continuam em UTC');
  ok(/timezone: 'UTC'/.test(lerSrc('src/cerebro/lembretes.js')), 'cerebro/lembretes.js: a limpeza de memória continua em UTC');
  ok(/FUSO_DA_COTA = 'America\/Los_Angeles'/.test(lerSrc('src/adaptadores/youtube/cota.js')), 'a cota do YouTube continua no fuso do Pacífico');
  // quem fala com a pessoa usa o módulo; o literal America/Sao_Paulo só pode existir no próprio módulo e no histórico em disco (log)
  const sem = (t) => t.split('\n').filter((l) => !/^\s*(?:\/\/|\*|\/\*)/.test(l)).join('\n');
  const ESPERADO = { 'src/events/messageCreate.js': 2, 'src/events/interactionCreate.js': 1, 'src/handlers/banListHandler.js': 5, 'src/handlers/llmHandler.js': 2, 'src/core/ai/researchAgent.js': 1 };
  for (const [f, q] of Object.entries(ESPERADO)) eq((lerSrc(f).match(/timeZone: fusoDoDono\(\)/g) || []).length, q, `${f}: ${q} ponto(s) de hora usam o fuso do dono`);
  const achados = [];
  const andar = (dir) => { for (const e of fs.readdirSync(path.join(raiz, dir), { withFileTypes: true })) { const rel = `${dir}/${e.name}`; if (e.isDirectory()) andar(rel); else if (/\.m?js$/.test(e.name) && /['"`]America\/Sao_Paulo['"`]/.test(sem(lerSrc(rel)))) achados.push(rel); } };
  andar('src');
  eq(achados.sort(), ['src/core/fuso.js', 'src/handlers/llmHandler.js'], 'nenhum outro arquivo de src/ fixa America/Sao_Paulo (llmHandler: só o histórico em disco, que é log)');
}

// ───────────────────────── 10. a virada do dia, ao segundo, nos dois fusos ─────────────────────────
console.log('10. Virada do dia (meia-noite de Brasília = 03:00Z; meia-noite de Cuiabá = 04:00Z)');
for (const [agora, sp, cb] of [
  ['2026-11-20T02:59:59Z', '2026-11-20T12:00:00.000Z', '2026-11-20T13:00:00.000Z'],
  ['2026-11-20T03:00:00Z', '2026-11-21T12:00:00.000Z', '2026-11-20T13:00:00.000Z'],
  ['2026-11-20T03:59:59Z', '2026-11-21T12:00:00.000Z', '2026-11-20T13:00:00.000Z'],
  ['2026-11-20T04:00:00Z', '2026-11-21T12:00:00.000Z', '2026-11-21T13:00:00.000Z'],
]) {
  eq(await quando('amanhã às 9h', SP, iso(agora)), sp, `Brasília, "amanhã às 9h" dito às ${agora}`);
  eq(await quando('amanhã às 9h', CB, iso(agora)), cb, `Cuiabá, "amanhã às 9h" dito às ${agora}`);
}

// ───────────────────────── 11. REINICIALIZAÇÃO: o que estava gravado vale no mesmo instante com o fuso novo ─────────────────────────
console.log('11. Reinicialização: lembretes, monitores, cotas, auditoria e cota do YouTube gravados antes da troca de YUI_FUSO');
{
  const { criarStoreDeMonitores } = await import('../src/cerebro/monitores/store.js');
  const { createBudget } = await import('../src/search/budget.js');
  const { diaDaCota } = await import('../src/adaptadores/youtube/cota.js');
  const { audit, verifyAudit } = await import('../src/core/audit.js');
  const T0 = Date.parse('2026-11-20T02:30:00Z'); // 22:30 em Cuiabá, 23:30 em Brasília, 02:30 em UTC: perto da meia-noite dos dois
  const dir = fs.mkdtempSync(path.join(tmp, 'reinicio-'));

  // "antes" = processo com YUI_FUSO=America/Sao_Paulo grava tudo; "depois" = processo NOVO com YUI_FUSO=America/Cuiaba lê o mesmo disco
  const lembretes = path.join(dir, 'lembretes.json');
  const monitores = path.join(dir, 'monitores.json');
  const orcamento = path.join(dir, 'search-budget.json');
  const horaArq = path.join(dir, 'search-budget-hora.json');
  const ENV_COTA = { YUI_SEARCH_USER_PER_HOUR: '5', YUI_SEARCH_GLOBAL_PER_HOUR: '20' };
  const FIM_DO_MES = Date.parse('2026-12-01T02:00:00Z'); // 22:00 de 30/11 em Cuiabá, 23:00 em Brasília: já é dezembro em UTC

  const antes = await emFuso(SP, 'UTC', async () => {
    const st = createReminderStore({ file: lembretes, now: () => T0 });
    st.add({ text: 'amanhã cedo', at: parseWhen('amanhã às 9h', iso(T0)).at });
    st.add({ text: 'vitamina', at: iso('2026-11-20T11:00:00Z'), repeat: { kind: 'daily', hour: 8, minute: 0 } });
    const mon = criarStoreDeMonitores({ file: monitores, now: () => T0, env: {} });
    mon.criar({ dono: '111111111111111111', consulta: 'patch novo do jogo' });
    const b = createBudget({ filePath: orcamento, now: () => T0 });
    b.persistirHora(horaArq, T0);
    b.takeUser('u1', ENV_COTA, T0); b.takeUser('u1', ENV_COTA, T0 + 60_000);
    b.registrarProvedor('tavily', FIM_DO_MES);
    return { lembretes: st.list(), monitores: mon.todos(), usado: b.userStatus('u1', ENV_COTA, T0 + 120_000), global: b.globalStatus(ENV_COTA, T0 + 120_000).used, mes: b.used('tavily', FIM_DO_MES) };
  });
  eq(antes.lembretes.map((r) => r.at), ['2026-11-20T11:00:00.000Z', '2026-11-20T12:00:00.000Z'], 'gravado antes da troca: às 23:30 de Brasília, "amanhã às 9h" é 9h de Brasília de 20/11 (12:00Z)');

  for (const processo of PROCESSOS) {
    const depois = await emFuso(CB, processo, async () => {
      const st = createReminderStore({ file: lembretes, now: () => T0 });
      const mon = criarStoreDeMonitores({ file: monitores, now: () => T0, env: {} });
      const b = createBudget({ filePath: orcamento, now: () => T0 });
      b.persistirHora(horaArq, T0 + 120_000);
      const due = st.due(Date.parse('2026-11-20T11:00:00Z')).map((r) => r.id);
      return { lembretes: st.list(), monitores: mon.todos(), usado: b.userStatus('u1', ENV_COTA, T0 + 120_000), global: b.globalStatus(ENV_COTA, T0 + 120_000).used, mes: b.used('tavily', FIM_DO_MES), due };
    });
    eq(depois.lembretes, antes.lembretes, 'lembretes: os mesmos instantes depois de reiniciar com o fuso novo');
    eq(depois.due, [2], 'o lembrete das 11:00Z dispara no mesmo instante');
    eq(depois.monitores, antes.monitores, 'monitores: criadoEm, ate e proximaChecagem (instantes UTC) não se mexem');
    eq([depois.usado.used, depois.global], [antes.usado.used, antes.global], 'cota por hora: as mesmas buscas contadas');
    eq(depois.usado.used, 2);
    eq(depois.mes, antes.mes, 'cota mensal: a conta do mês fica na chave UTC');
  }
  eq(JSON.parse(fs.readFileSync(horaArq, 'utf8')).gravadoEm, new Date(T0 + 60_000).toISOString(), 'cota por hora: o instante gravado é o UTC real, sem deslocamento');
  eq(Object.keys(JSON.parse(fs.readFileSync(orcamento, 'utf8')).months), ['2026-12'], 'a cota mensal continua por mês em UTC (22:00 de 30/11 em Cuiabá já é dezembro para a cota)');
  // a cota do YouTube é do Pacífico, a auditoria é UTC (ISO com Z)
  eq(await emTodosOsProcessos(CB, () => diaDaCota(Date.parse('2026-11-20T07:59:00Z'))), '2026-11-19', 'o dia da cota do YouTube é o do Pacífico, não o do dono');
  eq(await emTodosOsProcessos(SP, () => diaDaCota(Date.parse('2026-11-20T07:59:00Z'))), '2026-11-19');
  const auditFile = path.join(dir, 'audit.jsonl');
  const ts = await emFuso(CB, 'Asia/Tokyo', () => {
    const t = Date.now();
    process.env.YUI_AUDIT_FILE = auditFile; audit('teste.fuso', null, { n: 1 });
    const linha = JSON.parse(fs.readFileSync(auditFile, 'utf8').trim().split('\n').pop());
    return { ts: linha.ts, perto: Math.abs(Date.parse(linha.ts) - t) < 10_000 };
  });
  ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(ts.ts) && ts.perto, `auditoria em UTC (ISO com Z): ${ts.ts}`);
  ok(verifyAudit(auditFile).ok !== false, 'a cadeia da auditoria continua válida');
}

console.log(`\nOK: fuso do dono (${n} verificações)`);
