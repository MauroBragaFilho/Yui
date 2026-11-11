import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { parseLogLine, readLogStats, readLastUpdate, collectHealth, buildHealthReport, sendHealthReport, healthReportSchedule, formatUptime } from '../src/core/healthReport.js';

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

fs.rmSync(dir, { recursive: true, force: true });
console.log(`OK: health-report (${ok} verificações)`);
