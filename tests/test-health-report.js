import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// O relatório lê databaseStats() do src/database/db.js: pasta temporária ANTES de importar src/ (nunca toca nos bancos reais).
const dbDir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-health-db-'));
process.env.DATABASE_DIR = dbDir;
process.env.YUI_DB_NATIVE = '';
const { parseLogLine, readSupervisorStats, readLogStats, readLastUpdate, collectHealth, buildHealthReport, sendHealthReport, healthReportSchedule, formatUptime, formatBytes, summarizeDatabases } = await import('../src/core/healthReport.js');

let ok = 0;
const eq = (a, b, m) => { assert.deepEqual(a, b, m); ok += 1; };
const pad = (n) => String(n).padStart(2, '0');
const stamp = (ms) => { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`; };
const day = (ms) => stamp(ms).slice(0, 10);

// linha de log
const l = parseLogLine('[2026-11-11 04:06:47] [error] [Weekly] Erro ao consultar Reddit: 403');
eq([l.level, l.tag], ['error', 'Weekly']);
eq(parseLogLine('lixo sem formato'), null);
eq(parseLogLine('[2026-11-11 04:06:47] [info] sem etiqueta aqui').tag, 'geral');

// logs de verdade em pasta temporaria
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-health-'));
const now = Date.now();
const H = 3600_000;
fs.writeFileSync(path.join(dir, `error-${day(now)}.log`), [
  `[${stamp(now - 1 * H)}] [error] [Weekly] falha 1`,
  `[${stamp(now - 2 * H)}] [error] [Weekly] falha 2`,
  `[${stamp(now - 3 * H)}] [error] [Scheduler] falha 3`,
  `[${stamp(now - 30 * H)}] [error] [Weekly] velha demais`,
  `[${stamp(now - 4 * H)}] [warn] [Weekly] aviso nao conta`,
].join('\n'));
fs.writeFileSync(path.join(dir, `app-${day(now)}.log`), [
  `[${stamp(now - 5 * H)}] [info] [Discord] Conexão retomada.`,
  `[${stamp(now - 6 * H)}] [info] [Discord] Conexão retomada.`,
  `[${stamp(now - 7 * H)}] [info] [YoutubeEngine] Checando canal X`,
].join('\n'));
const s = readLogStats({ logDir: dir, now });
eq(s.errors, 3, 'só erros das últimas 24 h');
eq(s.byTag, { Weekly: 2, Scheduler: 1 });
eq(s.reconnects, 2);
eq(readLogStats({ logDir: path.join(dir, 'nao-existe'), now }), { errors: 0, byTag: {}, reconnects: 0 }, 'sem pasta de log não quebra');

// log do atualizador
const up = path.join(dir, 'atualizar.log');
fs.writeFileSync(up, ['2026-11-10 04:03:03 OK: Yui rodando na versao dbb175a.', '2026-11-11 12:22:21 OK: Yui rodando na versao 045674b.'].join('\n'));
eq(readLastUpdate({ file: up }).ok, true);
assert.match(readLastUpdate({ file: up }).text, /045674b.*11\/11 12:22/); ok += 1;
fs.writeFileSync(up, '2026-11-11 04:02:29 ERRO: a Yui nao ficou de pe. Voltando a versao anterior...\n2026-11-11 04:02:29 Rollback concluido. A versao nova NAO foi marcada.');
eq(readLastUpdate({ file: up }).ok, false, 'rollback conta como falha');
eq(readLastUpdate({ file: path.join(dir, 'nada.log') }), null);

eq(formatUptime(93784), '1d 2h');

// relatório: tudo certo
const fakeOs = { totalmem: () => 4 * 1024 ** 3, freemem: () => 2 * 1024 ** 3 };
const fakeFs = { statfsSync: () => ({ blocks: 1000, bsize: 1024 ** 3 / 1000 * 465, bavail: 900 }) };
const base = collectHealth({ now, osImpl: fakeOs, fsImpl: fakeFs, logDir: dir, uptimeSeconds: 3 * 86400, rssBytes: 60 * 1024 ** 2, interactions: () => ({ total: 124 }), updateLog: '', discordOnline: true });
const r = buildHealthReport(base);
eq(r.level, 'info');
assert.match(r.body, /^Tudo certo/); ok += 1;
assert.match(r.body, /RAM livre 2 de 4 GB \(50%\)/); ok += 1;
assert.match(r.body, /Respostas da IA \(24 h\): 124/); ok += 1;
assert.match(r.body, /Reconexões do Discord \(24 h\): 2/); ok += 1;
assert.match(r.body, /Erros no log \(24 h\): 3 \(Weekly 2, Scheduler 1\)/); ok += 1;
assert.ok(r.body.length <= 480, 'cabe no aviso');

// relatório: com problemas
const bad = buildHealthReport({ ...base, discordOnline: false, ramFreeGB: 0.2, errors: 40, reconnects: 7, uptimeSeconds: 600, lastUpdate: { ok: false, text: 'ERRO (11/11 04:02)' } });
eq(bad.level, 'warn');
for (const t of ['Discord desconectado', 'pouca RAM livre', '40 erros no log', '7 reconexões', 'a última atualização falhou', 'reiniciou há 10min']) assert.ok(bad.issues.includes(t), t);
ok += 6;

// envio: usa o alerta injetado, com cooldown de ~10 h e nivel certo
const sent = [];
const rep = await sendHealthReport({ alert: (...a) => sent.push(a), collect: () => base });
eq(sent.length, 1);
eq(sent[0][0], 'health-daily');
eq(sent[0][3], { level: 'info', cooldownMinutes: 600 });
eq(rep.level, 'info');

// agenda
eq(healthReportSchedule({}), { cron: '0 8 * * *', timezone: 'America/Sao_Paulo', hour: 8 });
eq(healthReportSchedule({ YUI_HEALTH_REPORT_HOUR: '7' }).cron, '0 7 * * *');
eq(healthReportSchedule({ YUI_HEALTH_REPORT_HOUR: '99' }).hour, 8, 'hora inválida volta ao padrão');
eq(healthReportSchedule({ YUI_HEALTH_REPORT: 'false' }), null, 'desligável');

// backup fora do notebook
const bk = path.join(dir, 'backup.log');
fs.writeFileSync(bk, `${stamp(now - 5 * H).slice(0, 10)} ${stamp(now - 5 * H).slice(11)} OK: backup cifrado enviado (7 arquivos, pasta backup-x).`);
const withBk = collectHealth({ now, osImpl: fakeOs, fsImpl: fakeFs, logDir: dir, uptimeSeconds: 3 * 86400, rssBytes: 1, interactions: () => ({ total: 1 }), updateLog: '', backupLog: bk });
eq(withBk.lastBackup.ok, true);
assert.match(buildHealthReport(withBk).body, /Backup fora do notebook: OK: backup cifrado enviado/); ok += 1;
eq(buildHealthReport(withBk).level, 'info', 'backup recente não é problema');
const oldBk = buildHealthReport({ ...withBk, lastBackup: { ok: true, at: now - 40 * H, text: 'OK (09/11 05:00)' } });
assert.ok(oldBk.issues.includes('o backup fora do notebook está atrasado (mais de 36 h)')); ok += 1;
const badBk = buildHealthReport({ ...withBk, lastBackup: { ok: false, at: now, text: 'ERRO: x' } });
assert.ok(badBk.issues.includes('o último backup falhou')); ok += 1;
eq(buildHealthReport({ ...withBk, lastBackup: null }).body.includes('Backup fora do notebook'), false, 'sem log de backup a linha some');

// supervisor
const sv = path.join(dir, 'supervisor.log');
const dt = (ms) => stamp(ms);
fs.writeFileSync(sv, [`${dt(now - 30 * H)} RELIGADA: velha demais`, `${dt(now - 5 * H)} RELIGADA: a API nao respondeu 3 vezes seguidas`, `${dt(now - 4 * H)} ATENCAO: API sem resposta (1 de 3)`, `${dt(now - 1 * H)} RELIGADA: o Discord esta fora ha 11 min`].join(String.fromCharCode(10)));
const st = readSupervisorStats({ file: sv, now });
eq(st, { count: 2, last: 'o Discord esta fora ha 11 min' }, 'conta só RELIGADA das últimas 24 h');
eq(readSupervisorStats({ file: path.join(dir, 'nao-existe.log'), now }), null, 'sem log = supervisor não instalado');
const rs = buildHealthReport({ ...withBk, supervisor: st });
assert.ok(rs.issues.some((i) => /supervisor religou a Yui 2x/.test(i))); ok += 1;
assert.match(rs.body, /Religadas pelo supervisor \(24 h\): 2/); ok += 1;
eq(buildHealthReport({ ...withBk, supervisor: { count: 0, last: null } }).level, 'info', 'zero religadas não é problema');
eq(buildHealthReport({ ...withBk, supervisor: null }).body.includes('supervisor'), false, 'sem supervisor a linha some');

// bancos (critério E): dublê de databaseStats(), um item por banco aberto
eq(base.databases, [], 'sem banco aberto no teste: lista vazia do db.js de verdade');
eq(buildHealthReport(base).body.includes('Bancos'), false, 'sem banco aberto a linha some');
eq([formatBytes(512), formatBytes(820 * 1024), formatBytes(2.3 * 1024 ** 2), formatBytes(2 * 1024 ** 2), formatBytes(1.2 * 1024 ** 3)], ['512 B', '820 KB', '2,3 MB', '2 MB', '1,2 GB']);
const MB = 1024 ** 2;
const bank = (name, extra = {}) => ({
  name, engine: 'sqljs', sizes: { db: 0.22 * MB, wal: 0, shm: 0 }, walAutocheckpoint: null, reads: 100, writes: 10,
  avgReadMs: 0.1, avgWriteMs: 3, maxWriteMs: 20, busy: 0, errors: 0, lastError: null, openFailures: 0, ...extra,
});
const normal = () => [...Array.from({ length: 9 }, (_, i) => bank(`banco${i}`)), bank('newswire', { engine: 'native', walAutocheckpoint: 1000, sizes: { db: 0.2 * MB, wal: 0.07 * MB, shm: 0.03 * MB } })];
const withDb = (list) => collectHealth({ now, osImpl: fakeOs, fsImpl: fakeFs, logDir: dir, uptimeSeconds: 3 * 86400, rssBytes: 1, interactions: () => ({ total: 1 }), updateLog: '', backupLog: '', supervisorLog: '', dbStats: () => list });
const lineOf = (rep) => rep.body.split('\n').find((x) => x.startsWith('Bancos:'));

// tudo normal: linha curta, nível info
const okDb = buildHealthReport(withDb(normal()));
eq(lineOf(okDb), 'Bancos: 10 (9 sql.js, 1 nativo), 2,3 MB, sem alertas');
eq(okDb.level, 'info', 'bancos normais não são problema');

// -wal grande (acima de 64 MB) e checkpoint parado (-wal além de wal_autocheckpoint x 4096 x 4 = 16 MB)
const walBig = buildHealthReport(withDb([...normal().slice(0, 9), bank('newswire', { engine: 'native', walAutocheckpoint: 1000, sizes: { db: 5 * MB, wal: 80 * MB, shm: 32768 } })]));
eq(walBig.level, 'warn');
assert.ok(walBig.issues.includes('alerta no banco newswire'), walBig.issues.join('|')); ok += 1;
assert.match(lineOf(walBig), /^Bancos: 10 \(9 sql\.js, 1 nativo\), .*\. newswire: -wal 80 MB, checkpoint parado$/); ok += 1;
const walStuck = summarizeDatabases([bank('core', { engine: 'native', walAutocheckpoint: 1000, sizes: { db: MB, wal: 20 * MB, shm: 32768 } })]);
assert.match(walStuck.line, /core: -wal 20 MB, checkpoint parado$/, 'abaixo de 64 MB, mas o checkpoint não acompanha'); ok += 1;
eq(summarizeDatabases([bank('core', { engine: 'native', walAutocheckpoint: 1000, sizes: { db: MB, wal: 4 * MB, shm: 32768 } })]).alertNames, [], '-wal pequeno não alerta');

// bloqueios e erros, com código e mensagem curta do último erro, numa linha só
const busy = buildHealthReport(withDb([bank('core', { busy: 3, errors: 4, lastError: { at: '2026-11-17T08:00:00.000Z', code: 'ERR_SQLITE_ERROR', message: 'database is locked\nlinha 2' } }), bank('memoria')]));
eq(busy.level, 'warn');
eq(lineOf(busy), 'Bancos: 2 (2 sql.js), 451 KB. core: 3 bloqueios, 4 erros (ERR_SQLITE_ERROR: database is locked linha 2)');
assert.ok(!busy.body.split('\n').some((x) => x.startsWith('linha 2')), 'mensagem sem quebra de linha'); ok += 1;

// falhas ao abrir ou recuperar
const openFail = summarizeDatabases([bank('lembretes', { openFailures: 2, lastError: { at: 'x', code: 'open', message: 'file is not a database' } })]);
eq(openFail.alertNames, ['lembretes']);
assert.match(openFail.line, /lembretes: 2 falhas ao abrir ou recuperar \(open: file is not a database\)$/); ok += 1;

// gravação lenta (média acima de 50 ms ou máxima acima de 1 s)
assert.match(summarizeDatabases([bank('core', { avgWriteMs: 80.4, maxWriteMs: 300 })]).line, /core: gravação lenta \(média 80 ms, máx\. 300 ms\)$/); ok += 1;
assert.match(summarizeDatabases([bank('core', { maxWriteMs: 1500 })]).line, /core: gravação lenta \(média 3 ms, máx\. 1500 ms\)$/); ok += 1;

// mais de 3 bancos com alerta: mostra 3 e conta o resto
const many = buildHealthReport(withDb(['a', 'b', 'c', 'd', 'e'].map((n) => bank(n, { busy: 1 }))));
assert.ok(many.issues.includes('alerta nos bancos a, b, c e mais 2'), many.issues.join('|')); ok += 1;
assert.match(lineOf(many), /c: 1 bloqueio; mais 2 com alerta$/); ok += 1;

// texto suspeito no erro: sem SQL de valor, cortado em 120, sem quebra de linha
const secret = summarizeDatabases([bank('core', { errors: 1, lastError: { at: 'x', code: 'ERR_SQLITE_ERROR', message: `SELECT * FROM notas WHERE texto = 'segredo do dono'\r\nAND id = 1 ${'x'.repeat(200)}` } })]);
const shownMsg = /\(ERR_SQLITE_ERROR: (.*)\)$/.exec(secret.line)[1];
assert.ok(!secret.line.includes('segredo'), 'valor entre aspas não aparece'); ok += 1;
assert.ok(!/[\r\n]/.test(secret.line), 'sem quebra de linha'); ok += 1;
assert.ok(shownMsg.length <= 120 && shownMsg.startsWith("SELECT * FROM notas WHERE texto = '…' AND id = 1 x"), shownMsg); ok += 1;
const cut = summarizeDatabases([bank('core', { errors: 1, lastError: { at: 'x', code: null, message: "UPDATE notas SET texto = 'segredo cortado no meio" } })]);
assert.match(cut.line, /core: 1 erro \(UPDATE notas SET texto = '…'\)$/, 'aspas sem fechar (mensagem já cortada) também somem'); ok += 1;

// cabe no aviso: a linha dos bancos tem teto e o corpo leva só linhas inteiras (a dos bancos fica, as de "OK" do fim podem sair)
const longMsg = { at: 'x', code: 'ERR_SQLITE_ERROR', message: 'y'.repeat(200) };
const huge = summarizeDatabases(['a', 'b', 'c'].map((n) => bank(n, { busy: 9, errors: 9, openFailures: 2, avgWriteMs: 90, maxWriteMs: 2000, lastError: longMsg })));
assert.ok(huge.line.length <= 300 && huge.line.endsWith('…'), String(huge.line.length)); ok += 1;
const crowded = buildHealthReport({ ...withDb([...normal().slice(0, 9), bank('core', { busy: 3, errors: 4, lastError: { code: 'ERR_SQLITE_ERROR', message: 'database is locked' } }), bank('newswire', { engine: 'native', walAutocheckpoint: 1000, sizes: { db: 5 * MB, wal: 80 * MB, shm: 32768 }, avgWriteMs: 72, maxWriteMs: 1430 })]),
  lastUpdate: { ok: true, text: 'OK: Yui rodando na versao 045674b. (11/11 12:22)' }, lastBackup: { ok: true, at: now, text: 'OK: backup cifrado enviado (7 arquivos, pasta backup-x). (17/11 03:00)' }, supervisor: { count: 0, last: null } });
assert.ok(crowded.body.length <= 480); ok += 1;
assert.match(lineOf(crowded), /newswire: -wal 80 MB, checkpoint parado, gravação lenta \(média 72 ms, máx\. 1430 ms\)$/); ok += 1;
for (const x of crowded.body.split('\n').filter((y) => /^(Atualizador|Backup)/.test(y))) assert.match(x, /\(\d\d\/\d\d \d\d:\d\d\)$/, `linha cortada no meio: ${x}`);
ok += 1;

// databaseStats lançando ou ausente: relatório sai inteiro, sem a seção
const notList = withDb(null);
const boom = collectHealth({ now, osImpl: fakeOs, fsImpl: fakeFs, logDir: dir, uptimeSeconds: 3 * 86400, rssBytes: 1, interactions: () => ({ total: 1 }), updateLog: '', backupLog: '', supervisorLog: '', dbStats: () => { throw new Error('banco fechado'); } });
eq(boom.databases, null, 'erro do databaseStats não derruba a coleta');
eq(buildHealthReport(boom).body.includes('Bancos'), false, 'sem a seção');
eq(buildHealthReport(boom).level, 'info');
eq(collectHealth({ now, osImpl: fakeOs, fsImpl: fakeFs, logDir: dir, uptimeSeconds: 3 * 86400, rssBytes: 1, interactions: () => ({ total: 1 }), updateLog: '', dbStats: null }).databases, null, 'sem databaseStats (db.js antigo) a seção some');
eq(notList.databases, null, 'retorno que não é lista é ignorado');
eq(buildHealthReport({ ...boom, databases: [null, 42, { name: 'x', sizes: 'lixo', busy: 'NaN' }] }).body.includes('Bancos: 1 (1 não abriu), 0 B, sem alertas'), true, 'item estranho não quebra');
const sentDb = [];
await sendHealthReport({ alert: (...a) => sentDb.push(a), collect: () => boom });
eq(sentDb.length, 1, 'o relatório sai mesmo sem a seção dos bancos');

fs.rmSync(dir, { recursive: true, force: true });
fs.rmSync(dbDir, { recursive: true, force: true });
console.log(`OK: health-report (${ok} verificações)`);
