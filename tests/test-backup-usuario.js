// Lembretes e listas no backup cifrado: ida e volta, arquivo ruim não derruba o resto, planos incluídos, avisos/monitores de fora. Sem rede.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-backup-usuario-'));
process.env.TEMP = process.env.TMP = process.env.TMPDIR = root;
const { createMemoryBackup, restoreMemoryBackup, verifyMemoryBackup } = await import('../src/core/memory/backup.js');
const { configureAlerts } = await import('../src/core/alerts.js');
const { sourcesFingerprint } = await import('../scripts/backup-offsite.mjs');
const { createReminderStore } = await import('../src/reminders/store.js');
configureAlerts?.({ send: async () => {} });

const dbDir = path.join(root, 'database');
fs.mkdirSync(path.join(dbDir, 'listas'), { recursive: true });
const put = (rel, text) => fs.writeFileSync(path.join(dbDir, rel), text);
const key = crypto.randomBytes(32);
let n = 0;
const fazer = () => createMemoryBackup({ dbDir, backupDir: path.join(root, `b${++n}`), key });
const voltar = async (res) => { const to = path.join(root, `r${n}`); await restoreMemoryBackup({ backupFolder: res.folder, targetDir: to, key }); return to; };
const impressao = () => sourcesFingerprint({ dbDir, dataDir: path.join(root, 'data') });

put('memory-personal.db', 'banco');
const antigo = await fazer(); // sem lembretes nem listas: o formato de antes
const impressaoSem = impressao();
put('lembretes.json', '{"nextId":2,"items":[]}');
put('listas/123456789.json', '{"lists":{}}');
put('listas/123456789.json.corrompido-1', 'x');
put('planos.json', '{"versao":1,"planos":[]}');
for (const f of ['avisos-fila.json', 'monitores.json']) put(f, '{}');
assert.notEqual(impressao(), impressaoSem, 'o envio externo percebe a mudança');

const res = await fazer();
assert.deepEqual(res.manifest.files.map((f) => f.name), ['memory-personal.db', 'lembretes.json', 'planos.json', 'listas__123456789.json']);
verifyMemoryBackup({ backupFolder: res.folder, key });
const to = await voltar(res);
for (const rel of ['lembretes.json', 'planos.json', 'listas/123456789.json']) assert.equal(fs.readFileSync(path.join(to, rel), 'utf8'), fs.readFileSync(path.join(dbDir, rel), 'utf8'));

// JSON quebrado e pasta no lugar do arquivo: ficam de fora, o resto vai.
put('lembretes.json', '{quebrado');
fs.mkdirSync(path.join(dbDir, 'listas', '987654321.json'));
const parcial = await fazer();
assert.deepEqual(parcial.skipped.map((s) => s.name).sort(), ['lembretes.json', 'listas__987654321.json']);
assert.deepEqual(parcial.manifest.files.map((f) => f.name), ['memory-personal.db', 'planos.json', 'listas__123456789.json']);
impressao();

const velho = await voltar(antigo);
assert.deepEqual(fs.readdirSync(velho), ['memory-personal.db'], 'backup antigo continua restaurando');

// Vencido na restauração não volta a ser avisado: o único sai, o que repete avança, e os originais ficam guardados.
fs.rmSync(path.join(dbDir, 'listas', '987654321.json'), { recursive: true });
const item = (id, at, repeat = null) => ({ id, text: `t${id}`, at, repeat, tries: 0 });
put('lembretes.json', JSON.stringify({ nextId: 4, items: [item(1, '2020-01-01T12:00:00.000Z'), item(2, '2020-01-01T12:00:00.000Z', { kind: 'daily', hour: 9, minute: 0 }), item(3, '2099-01-01T12:00:00.000Z')] }));
const comVencidos = await fazer();
const alvo = path.join(root, 'restaurado-vencidos');
const r = await restoreMemoryBackup({ backupFolder: comVencidos.folder, targetDir: alvo, key });
const store = createReminderStore({ file: path.join(alvo, 'lembretes.json') });
assert.deepEqual(store.list().map((x) => x.id).sort(), [2, 3]);
assert.deepEqual(store.due(), [], 'nada sai sozinho ao subir');
assert.deepEqual(r.vencidos.ids, [1, 2]);
assert.equal(JSON.parse(fs.readFileSync(r.vencidos.arquivo, 'utf8')).items.length, 2);

fs.rmSync(root, { recursive: true, force: true, maxRetries: 3 });
console.log('4 testes OK');
