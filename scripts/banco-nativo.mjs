// Migração de um banco da Yui do sql.js para o motor nativo (node:sqlite com WAL) e volta. Etapa 2 do cérebro único.
//
//   node scripts/banco-nativo.mjs estado    <arquivo.db>                 formato, integridade, tabelas e contagens
//   node scripts/banco-nativo.mjs migrar    <arquivo.db> [--backup PASTA] backup verificável (SHA-256 + manifesto) e passa para WAL
//   node scripts/banco-nativo.mjs reverter  <arquivo.db>                 checkpoint + volta ao diário clássico; confere que o sql.js lê
//   node scripts/banco-nativo.mjs restaurar <backup.db> <arquivo.db>     confere o SHA-256 do backup e o põe no lugar (apaga -wal/-shm)
//
// PARE A YUI antes de migrar, reverter ou restaurar um banco que ela usa. Depois de migrar, inclua o nome do banco em
// YUI_DB_NATIVE (ex.: YUI_DB_NATIVE=newswire); depois de reverter, tire. Sai com código 1 em qualquer falha de conferência.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const sqliteMod = () => import('node:sqlite');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const headerMode = (file) => {
  const b = fs.readFileSync(file).subarray(18, 20);
  return b[0] === 2 || b[1] === 2 ? 'WAL' : 'clássico';
};
const fail = (msg) => { console.error(`ERRO: ${msg}`); process.exit(1); };

/**
 * Inspeção completa (critério B da revisora), igual nos dois motores: `all(sql)` devolve as linhas como arrays.
 *  - integridade (integrity_check) e chaves estrangeiras (foreign_key_check);
 *  - todos os objetos do esquema (tabelas, índices, triggers, views) com o SQL de cada um;
 *  - sqlite_sequence (contadores do AUTOINCREMENT);
 *  - por tabela: contagem e hash de TIPO + VALOR de cada célula (typeof() e quote() do próprio SQLite, na ordem do rowid),
 *    então "5", 5 e 5.0 dão hashes diferentes. O hash do esquema sozinho não é a única evidência.
 */
function inspectWith(all) {
  const q = (name) => `"${String(name).replaceAll('"', '""')}"`;
  const objects = all("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY type, name")
    .map(([type, name, tbl, sql]) => ({ type, name, tbl, sql }));
  const byType = (t) => objects.filter((o) => o.type === t).map((o) => o.name);
  const counts = {};
  const contentHash = {};
  for (const t of byType('table')) {
    const cols = all(`PRAGMA table_info(${q(t)})`).map((r) => r[1]);
    counts[t] = Number(all(`SELECT count(*) FROM ${q(t)}`)[0][0]);
    const sel = cols.map((c) => `typeof(${q(c)}), quote(${q(c)})`).join(', ') || '1';
    let rows;
    try { rows = all(`SELECT ${sel} FROM ${q(t)} ORDER BY rowid`); } catch { rows = all(`SELECT ${sel} FROM ${q(t)} ORDER BY 1`); }
    const h = crypto.createHash('sha256');
    for (const r of rows) h.update(JSON.stringify(r.map((v) => (typeof v === 'bigint' ? String(v) : v))));
    contentHash[t] = h.digest('hex').slice(0, 16);
  }
  const hasSeq = all("SELECT count(*) FROM sqlite_master WHERE name = 'sqlite_sequence'")[0][0] > 0;
  const sequence = hasSeq ? Object.fromEntries(all('SELECT name, seq FROM sqlite_sequence ORDER BY name').map(([n, v]) => [n, Number(v)])) : {};
  return {
    integrity: String(all('PRAGMA integrity_check')[0][0]),
    foreignKeyViolations: all('PRAGMA foreign_key_check').length,
    tables: byType('table'), indexes: byType('index'), triggers: byType('trigger'), views: byType('view'),
    schemaHash: crypto.createHash('sha256').update(JSON.stringify(objects)).digest('hex'),
    counts, sequence, contentHash,
  };
}
/** Pelo node:sqlite (motor novo). */
const inspect = (db) => inspectWith((sql) => db.prepare(sql).all().map((r) => Object.values(r)));

/** Pelo sql.js (o motor antigo), para provar que ele lê o arquivo revertido com o MESMO conteúdo. */
async function inspectWithSqlJs(file) {
  const { default: initSqlJs } = await import('sql.js');
  const SQL = await initSqlJs();
  const db = new SQL.Database(fs.readFileSync(file));
  try {
    return inspectWith((sql) => db.exec(sql)[0]?.values ?? []);
  } finally {
    db.close();
  }
}

/** Duas inspeções descrevem o mesmo banco? Devolve a lista de diferenças (vazia = iguais). */
function differences(a, b) {
  const diffs = [];
  for (const k of ['integrity', 'foreignKeyViolations', 'schemaHash']) if (a[k] !== b[k]) diffs.push(k);
  for (const k of ['tables', 'indexes', 'triggers', 'views', 'counts', 'sequence', 'contentHash']) if (JSON.stringify(a[k]) !== JSON.stringify(b[k])) diffs.push(k);
  return diffs;
}

async function estado(file) {
  if (!fs.existsSync(file)) fail(`arquivo não existe: ${file}`);
  const { DatabaseSync } = await sqliteMod();
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    const info = inspect(db);
    console.log(JSON.stringify({ arquivo: file, formato: headerMode(file), wal: fs.existsSync(`${file}-wal`), ...info }, null, 2));
  } finally {
    db.close();
  }
}

async function migrar(file, backupDir) {
  if (!fs.existsSync(file)) fail(`arquivo não existe: ${file}`);
  if (headerMode(file) === 'WAL' || fs.existsSync(`${file}-wal`)) fail('o banco já está no formato nativo (WAL)');
  const { DatabaseSync } = await sqliteMod();
  // 1. Backup verificável ANTES de tocar no arquivo.
  const dir = backupDir || path.join(path.dirname(file), 'backup-motor-nativo');
  fs.mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backup = path.join(dir, `${path.basename(file, '.db')}-${stamp}.db`);
  fs.copyFileSync(file, backup);
  const hash = sha256(file);
  if (sha256(backup) !== hash) fail('a cópia de backup não confere com o original');
  const before = (() => { const db = new DatabaseSync(file, { readOnly: true }); try { return inspect(db); } finally { db.close(); } })();
  if (before.integrity !== 'ok') fail(`o banco original não passou na verificação de integridade: ${before.integrity}`);
  const manifest = { arquivo: path.resolve(file), backup: path.resolve(backup), sha256: hash, data: new Date().toISOString(), ...before };
  fs.writeFileSync(`${backup}.json`, JSON.stringify(manifest, null, 2));
  // 2. Passa para WAL e confere que nada mudou.
  const db = new DatabaseSync(file);
  let after;
  try {
    const mode = db.prepare('PRAGMA journal_mode=WAL').get().journal_mode;
    if (mode !== 'wal') fail(`o SQLite não aceitou o modo WAL (ficou "${mode}")`);
    after = inspect(db);
  } finally {
    db.close();
  }
  if (after.integrity !== 'ok') fail(`integridade depois da migração: ${after.integrity}`);
  const diff = differences(before, after);
  if (diff.length) fail(`a migração mudou: ${diff.join(', ')}`);
  if (after.foreignKeyViolations) fail(`${after.foreignKeyViolations} violação(ões) de chave estrangeira`);
  console.log(JSON.stringify({ ok: true, formato: headerMode(file), backup, manifesto: `${backup}.json`, contagens: after.counts, indices: after.indexes, triggers: after.triggers, views: after.views, sequence: after.sequence, contentHash: after.contentHash }, null, 2));
  console.log(`Agora inclua "${path.basename(file, '.db')}" em YUI_DB_NATIVE.`);
}

async function reverter(file) {
  if (!fs.existsSync(file)) fail(`arquivo não existe: ${file}`);
  const { DatabaseSync } = await sqliteMod();
  const db = new DatabaseSync(file);
  let before;
  try {
    before = inspect(db);
    db.exec('PRAGMA wal_checkpoint(TRUNCATE);');
    const mode = db.prepare('PRAGMA journal_mode=DELETE').get().journal_mode;
    if (mode !== 'delete') fail(`não voltou ao diário clássico (ficou "${mode}")`);
  } finally {
    db.close();
  }
  for (const extra of [`${file}-wal`, `${file}-shm`]) if (fs.existsSync(extra) && fs.statSync(extra).size === 0) fs.unlinkSync(extra);
  if (headerMode(file) !== 'clássico' || fs.existsSync(`${file}-wal`)) fail('o arquivo ainda está no formato WAL');
  const old = await inspectWithSqlJs(file);
  const diff = differences(before, old);
  if (old.integrity !== 'ok' || diff.length) fail(`o sql.js leu o arquivo revertido diferente (${diff.join(', ') || old.integrity})`);
  console.log(JSON.stringify({ ok: true, formato: 'clássico', sqljs: { counts: old.counts, contentHash: old.contentHash, integrity: old.integrity } }, null, 2));
  console.log(`Agora tire "${path.basename(file, '.db')}" de YUI_DB_NATIVE.`);
}

async function restaurar(backup, file) {
  if (!fs.existsSync(backup)) fail(`backup não existe: ${backup}`);
  const manifestFile = `${backup}.json`;
  if (fs.existsSync(manifestFile)) {
    const m = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
    if (sha256(backup) !== m.sha256) fail('o SHA-256 do backup não confere com o manifesto');
  }
  for (const extra of [`${file}-wal`, `${file}-shm`, `${file}-journal`]) if (fs.existsSync(extra)) fs.unlinkSync(extra);
  fs.copyFileSync(backup, file);
  const old = await inspectWithSqlJs(file);
  if (old.integrity !== 'ok') fail(`o banco restaurado não passou na integridade: ${old.integrity}`);
  console.log(JSON.stringify({ ok: true, restaurado: file, sqljs: old }, null, 2));
}

const [cmd, a, b, c] = process.argv.slice(2);
const backupArg = b === '--backup' ? c : null;
if (cmd === 'estado' && a) await estado(a);
else if (cmd === 'migrar' && a) await migrar(a, backupArg);
else if (cmd === 'reverter' && a) await reverter(a);
else if (cmd === 'restaurar' && a && b) await restaurar(a, b);
else fail('uso: node scripts/banco-nativo.mjs estado|migrar|reverter <arquivo.db> | restaurar <backup.db> <arquivo.db>');
