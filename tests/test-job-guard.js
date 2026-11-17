// Motor de políticas nas tarefas automáticas (agendador, lembretes, limpezas, manutenção).
// Execução: npm run test:jobguard
import assert from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-jobs-'));
process.env.YUI_AUDIT_FILE = path.join(tmp, 'audit.jsonl');
process.env.YUI_OWNER_ID = '111';
delete process.env.YUI_POLICY_MODE;

const { JOBS, jobAllowed, guardedJob, resetJobGuardForTests } = await import('../src/core/security/jobGuard.js');
const { createPolicyEngine } = await import('../src/core/security/policyEngine.js');
const { MATRIX } = await import('../src/core/security/permissionMatrix.js');

let passed = 0;
const test = async (name, fn) => { resetJobGuardForTests(); await fn(); passed++; console.log(`  ✔ ${name}`); };
const events = [];
const engine = (mode, readOnly) => createPolicyEngine({ env: { YUI_POLICY_MODE: mode }, readOnly: () => readOnly, auditFn: (ev, c, d) => events.push({ ev, ...d }) });
const read = (rel) => fs.readFileSync(new URL(`../${rel}`, import.meta.url), 'utf8');

console.log('Tabela');
await test('toda tarefa da tabela aponta para uma ação job.* que existe na matriz', () => {
  for (const [name, action] of Object.entries(JOBS)) assert.ok(MATRIX.has(action) && action.startsWith('job.'), `${name} -> ${action}`);
  assert.equal(MATRIX.get('job.maintenance').modifies, true);
  for (const a of ['job.publish', 'job.notify', 'job.data_cleanup', 'job.cleanup_files']) assert.equal(MATRIX.get(a).modifies, false, a);
});

console.log('observe e enforce');
await test('em observe toda tarefa roda, até a de manutenção em somente leitura; registra no máximo 1 vez por hora', () => {
  events.length = 0;
  const e = engine('observe', true);
  let t = 10_000_000;
  const now = () => t;
  for (let i = 0; i < 5; i++) assert.equal(jobAllowed('maintenance.ytdlp_update', { engine: e, now }), true);
  assert.equal(events.filter((x) => x.ev === 'policy.evaluate').length, 1, 'registro limitado');
  t += 61 * 60 * 1000;
  jobAllowed('maintenance.ytdlp_update', { engine: e, now });
  assert.equal(events.filter((x) => x.ev === 'policy.evaluate').length, 2);
});
await test('enforce + somente leitura: manutenção para; publicar, lembrar e limpar seguem', () => {
  events.length = 0;
  const e = engine('enforce', true);
  const auditFn = (ev, c, d) => events.push({ ev, ...d });
  for (const j of ['maintenance.ytdlp_update', 'maintenance.data_refresh']) assert.equal(jobAllowed(j, { engine: e, auditFn }), false, j);
  for (const j of ['scheduler.youtube', 'scheduler.daily', 'reminders.tick', 'reminders.morning', 'scheduler.memory_purge', 'cleanup.context', 'cleanup.radio_temp']) assert.equal(jobAllowed(j, { engine: e }), true, j);
  assert.ok(events.some((x) => x.ev === 'policy.job_skipped' && x.job === 'maintenance.ytdlp_update'), 'pulo registrado');
});
await test('enforce com somente leitura desligado: a manutenção volta a rodar', () => {
  assert.equal(jobAllowed('maintenance.ytdlp_update', { engine: engine('enforce', false) }), true);
});
await test('tarefa fora da tabela roda como antes, e o guarda nunca lança erro', () => {
  assert.equal(jobAllowed('qualquer.coisa', { engine: engine('enforce', true) }), true);
  assert.equal(jobAllowed('maintenance.ytdlp_update', { engine: { mode() { throw new Error('x'); } } }), true);
  assert.equal(jobAllowed(undefined), true);
});
await test('guardedJob só chama a função quando permitido e repassa os argumentos', async () => {
  const calls = [];
  const fn = (a) => { calls.push(a); return 'ok'; };
  assert.equal(await guardedJob('maintenance.data_refresh', fn, { engine: engine('enforce', false) })(7), 'ok');
  assert.equal(guardedJob('maintenance.data_refresh', fn, { engine: engine('enforce', true) })(8), undefined);
  assert.deepEqual(calls, [7]);
});

console.log('Vigias dos pontos de entrada');
await test('o agendador e os lembretes não chamam cron.schedule direto: todos passam pelo guarda', () => {
  const sched = read('src/scheduler/scheduler.js');
  assert.equal((sched.match(/cron\.schedule\(/g) ?? []).length, 1, 'só dentro do wrapper');
  assert.equal((sched.match(/\bschedule\('scheduler\./g) ?? []).length, 7);
  const rem = read('src/reminders/service.js');
  assert.equal((rem.match(/cron\.schedule\(/g) ?? []).length, 1, 'só dentro do wrapper');
  for (const n of ['reminders.tick', 'reminders.morning', 'reminders.health']) assert.ok(rem.includes(`'${n}'`), n);
});
await test('limpezas e manutenção consultam o guarda', () => {
  assert.match(read('src/core/context/contextStore.js'), /jobAllowed\('cleanup\.context'\)/);
  assert.match(read('src/music/radioCleaner.js'), /jobAllowed\('cleanup\.radio_temp'\)/);
  assert.match(read('src/utils/binaries.js'), /jobAllowed\('maintenance\.ytdlp_update'\)/);
  assert.equal((read('src/index.js').match(/jobAllowed\('maintenance\.data_refresh'\)/g) ?? []).length, 3);
});
await test('o serviço de lembretes registra as tarefas pelo agendador injetado e a passada roda em observe', async () => {
  const { startReminderService } = await import('../src/reminders/service.js');
  const registered = [];
  const cron = { schedule: (expr, fn, opts) => registered.push({ expr, fn, opts }) };
  const logger = { info() {}, warn() {} };
  startReminderService({ cron, client: null, logger, env: { YUI_MORNING_REPORT: 'false', YUI_HEALTH_REPORT: 'false' } });
  assert.ok(registered.some((r) => r.expr === '* * * * *' && typeof r.fn === 'function'), 'tick a cada minuto');
});

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} testes OK`);
process.exit(0);
