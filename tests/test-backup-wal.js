// Backup consistente com bancos no motor nativo (node:sqlite com WAL): critério A da revisora.
// Execução: node tests/test-backup-wal.js
// Tudo em pastas temporárias (DATABASE_DIR aponta para elas antes de importar src/): nunca toca nos bancos reais, em
// C:\Tools nem na rede. Do backup externo só a função local de fingerprint é usada (nada é enviado).
//   (a) banco clássico: igual a antes (bytes, hash, manifesto);
//   (b) banco WAL recebendo gravações e fechamentos DURANTE o backup (processo filho) + novas tentativas em erro passageiro;
//   (c) restauração numa pasta isolada (com -wal/-shm velhos no destino), original intocado;
//   (d) o fingerprint do backup externo muda quando só o -wal muda;
//   (e) manifesto e SHA-256 conferem.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import initSqlJs from 'sql.js';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-backup-wal-'));
// TEMP isolado (este processo e os filhos): as cópias em claro (yui-snap-*) e a varredura de abandonados ficam aqui,
// nunca no TEMP real.
const isolatedTemp = path.join(tmp, 'TEMP');
fs.mkdirSync(isolatedTemp, { recursive: true });
process.env.TEMP = isolatedTemp;
process.env.TMP = isolatedTemp;
process.env.TMPDIR = isolatedTemp;
assert.equal(os.tmpdir(), isolatedTemp, 'os.tmpdir() aponta para o TEMP isolado do teste');
// Etapa 8 (revisão da Liz): os processos auxiliares deste teste rodam sob o bloqueio de integração externa (rede, DNS, UDP, programas e workers
// falham e ficam registrados; só o icacls e o whoami do Windows, que o retrato restringe a permissão da cópia em claro; sem rede). O registro guarda qual teste abriu cada exceção.
const BLOQUEIO = criarBloqueioTemporario({ teste: 'test:backupwal', liberar: { 'programa:icacls': 'o retrato do backup restringe a permissão da cópia em claro (src/database/snapshot.js; sem rede)', 'programa:whoami': 'o retrato descobre o usuário atual para a permissão da cópia em claro (sem rede)' } });
const filhoEnv = (papel) => ({ ...process.env, NODE_ENV: 'test', ...BLOQUEIO.env(papel) });
process.env.DATABASE_DIR = path.join(tmp, 'database-padrao');
process.env.YUI_BACKUP_DIR = path.join(tmp, 'backups-padrao');
// O backup externo é importado só pela função local sourcesFingerprint; mesmo assim, nada dele aponta para fora daqui.
process.env.YUI_BACKUP_REPO_URL = path.join(tmp, 'nao-existe.git');
process.env.YUI_BACKUP_SSH_KEY = path.join(tmp, 'sem-chave');
process.env.YUI_BACKUP_KEY_FILE = path.join(tmp, 'sem-chave.key');
process.env.YUI_BACKUP_WORKDIR = path.join(tmp, 'offsite-trabalho');
process.env.YUI_BACKUP_LOG = path.join(tmp, 'backup.log');
process.env.YUI_ALERTS = 'false'; // os backups que falham de propósito não avisam ninguém

const {
  snapshotDatabaseFile, readDatabaseSnapshot, isWalDatabaseFile, isTransientSqliteError,
  createPrivateTempDir, restrictDirToOwner, cleanupStaleSnapshotDirs, SID_SYSTEM, SID_ADMINISTRATORS,
} = await import('../src/database/snapshot.js');
const { createMemoryBackup, restoreMemoryBackup, readBackupManifest } = await import('../src/core/memory/backup.js');
const { sourcesFingerprint } = await import('../scripts/backup-offsite.mjs');
const { DatabaseSync } = await import('node:sqlite');
const SQL = await initSqlJs();

let ok = 0;
const check = (cond, msg) => { assert.ok(cond, msg); ok += 1; };
const section = (name) => console.log(`  ▸ ${name}`);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (f) => (fs.existsSync(f) ? sha(fs.readFileSync(f)) : null);
const header = (f) => [...fs.readFileSync(f).subarray(18, 20)];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const key = crypto.randomBytes(32);
const BATCH = 7; // linhas por transação (ímpar: uma transação pela metade dificilmente dá múltiplo)
/** O que sobrou em claro no TEMP do teste: pastas yui-snap-* e arquivos de banco (inclusive -wal/-shm e temporários do SQLite). */
const plaintextLeftovers = () => fs.readdirSync(isolatedTemp, { recursive: true }).map(String)
  .filter((n) => /(^|[\\/])yui-snap-/.test(n) || /\.db($|-wal$|-shm$|-journal$|\.\d+\.tmp$)|etilqs_/.test(n));

const SCHEMA = `
  CREATE TABLE itens (id INTEGER PRIMARY KEY, lote INTEGER NOT NULL, seq INTEGER NOT NULL, texto TEXT);
  CREATE INDEX idx_itens_lote ON itens(lote);
  CREATE TABLE meta (lotes INTEGER NOT NULL);
  INSERT INTO meta VALUES (0);`;

/** Uma transação = BATCH linhas + o contador de lotes. Num retrato consistente: count(*) = lotes * BATCH. */
function insertBatch(db, payload = 'x'.repeat(120)) {
  db.exec('BEGIN IMMEDIATE');
  try {
    const lote = Number(db.prepare('SELECT lotes FROM meta').get().lotes) + 1;
    const ins = db.prepare('INSERT INTO itens (lote, seq, texto) VALUES (?, ?, ?)');
    for (let j = 0; j < BATCH; j++) ins.run(lote, j, payload);
    db.exec('UPDATE meta SET lotes = lotes + 1');
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
/** Banco no formato do motor nativo (WAL). Devolve a conexão aberta. */
function createWalDb(file, { batches = 0 } = {}) {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode=WAL;');
  db.exec(SCHEMA);
  for (let i = 0; i < batches; i++) insertBatch(db);
  return db;
}
/** Banco clássico, como o sql.js grava. */
function createClassicDb(file, batches) {
  const db = new SQL.Database();
  db.run(SCHEMA);
  for (let l = 1; l <= batches; l++) {
    for (let j = 0; j < BATCH; j++) db.run('INSERT INTO itens (lote, seq, texto) VALUES (?, ?, ?)', [l, j, `classico ${l}.${j}`]);
  }
  db.run('UPDATE meta SET lotes = ?', [batches]);
  fs.writeFileSync(file, Buffer.from(db.export()));
  db.close();
}
/** Abre pelo sql.js (o motor antigo): integridade e o invariante count = lotes * BATCH. */
function inspectSqlJs(buf) {
  const db = new SQL.Database(buf);
  try {
    return {
      integrity: db.exec('PRAGMA integrity_check')[0]?.values?.[0]?.[0],
      count: Number(db.exec('SELECT count(*) FROM itens')[0].values[0][0]),
      lotes: Number(db.exec('SELECT lotes FROM meta')[0].values[0][0]),
    };
  } finally {
    db.close();
  }
}
const consistent = (info) => info.integrity === 'ok' && info.count % BATCH === 0 && info.count === info.lotes * BATCH;
function decryptManifest(folder) {
  return readBackupManifest(folder, key).manifest; // manifesto v2: selo conferido e decifrado com a chave
}
/** A mesma fórmula do fingerprint ANTES desta mudança (só o .db), para provar que o clássico não mudou. */
function oldFingerprint(dbDir, dataDir, names) {
  const h = crypto.createHash('sha256');
  for (const f of names.map((n) => path.join(dbDir, n)).concat(['bans.json', 'accepted_servers.json', 'server_settings.json', 'server_tools.json'].map((n) => path.join(dataDir, n)))) {
    if (!fs.existsSync(f)) continue;
    h.update(path.basename(f)).update(fs.readFileSync(f));
  }
  return h.digest('hex');
}
const ALL_DB_NAMES = ['memory-personal.db', 'memory-discord.db', 'memory-context.db', 'memory-context-personal.db', 'core.db', 'social-youtube.db', 'social-twitch.db'];

// ───────────── Cópia em claro no TEMP: ACL restrita, falha da ACL, queda no meio e varredura de abandonados ─────────────
const isWin = process.platform === 'win32';
const sys32 = (exe) => path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', exe);
const SNAP_DIR_RE = /^yui-snap-[A-Za-z0-9]{6}$/;
/** Leitura INDEPENDENTE da ACL (sem o leitor do snapshot.js): `icacls /save` dá o SDDL, com SIDs e não nomes traduzidos. */
function aclOf(target) {
  const out = path.join(tmp, `acl-${crypto.randomBytes(4).toString('hex')}.sddl`);
  execFileSync(sys32('icacls.exe'), [target, '/save', out, '/q'], { windowsHide: true, stdio: 'ignore' });
  const sddl = fs.readFileSync(out).toString('utf16le').split(/\r?\n/).find((l) => l.startsWith('D:')) || '';
  fs.rmSync(out, { force: true });
  const alias = { SY: 'S-1-5-18', BA: 'S-1-5-32-544' };
  // LA = a conta Administrador embutida (RID 500): só vale como o USUÁRIO ATUAL quando o usuário atual é ela (o runner do GitHub Actions roda como essa conta); em qualquer outro caso fica sem mapa e a conferência falha
  if (userSid && /^S-1-5-21(?:-\d+){3}-500$/.test(userSid)) alias.LA = userSid;
  const aces = [...sddl.matchAll(/\(([^;()]*);([^;()]*);([^;()]*);[^;()]*;[^;()]*;([^;()]*)\)/g)]
    .map(([, type, flags, rights, sid]) => ({ type, flags, rights, sid: alias[sid] || sid }));
  return { sddl, inheritanceOff: /^D:[A-Z]*P/.test(sddl), aces };
}
const icaclsText = (target) => execFileSync(sys32('icacls.exe'), [target], { encoding: 'latin1', windowsHide: true });
const userSid = isWin
  ? execFileSync(sys32('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { encoding: 'latin1', windowsHide: true }).match(/"(S-1-\d+(?:-\d+)+)"/)[1]
  : null;
const expectedSids = isWin ? [...new Set([userSid, 'S-1-5-18', 'S-1-5-32-544'])].sort() : [];
const onlyExpected = (acl) => acl.aces.length === expectedSids.length
  && JSON.stringify([...new Set(acl.aces.map((a) => a.sid))].sort()) === JSON.stringify(expectedSids);
const isPlainSqlite = (file) => fs.readFileSync(file).subarray(0, 15).toString('latin1') === 'SQLite format 3';
const ageBack = (paths, ms = 60 * 60 * 1000) => {
  const old = new Date(Date.now() - ms);
  for (const p of paths) fs.utimesSync(p, old, old);
};

async function tempSecurityTests() {
  check(SID_SYSTEM === 'S-1-5-18' && SID_ADMINISTRATORS === 'S-1-5-32-544', 'SIDs fixos de SYSTEM e Administradores');

  // ── [temp a] ACL da pasta temporária ──
  section('[temp a] pasta temporária privada: sem herança e só 3 SIDs (Windows) ou 700 (fora dele)');
  const dirA = createPrivateTempDir();
  check(SNAP_DIR_RE.test(path.basename(dirA)) && path.dirname(dirA) === isolatedTemp, `nome reconhecível dentro do TEMP: ${path.basename(dirA)}`);
  check(fs.readdirSync(dirA).length === 0, 'a pasta nasce vazia');
  if (isWin) {
    const acl = aclOf(dirA);
    const text = icaclsText(dirA).trimEnd().split(/\r?\n/).map((l) => `      ${l}`).join('\n');
    console.log(`    icacls da pasta temporária:\n${text}\n      SDDL: ${acl.sddl}`);
    check(acl.inheritanceOff, `herança desligada (SDDL ${acl.sddl})`);
    check(acl.aces.every((a) => !a.flags.includes('ID')), 'nenhuma entrada herdada do TEMP');
    check(onlyExpected(acl), `só usuário atual, SYSTEM e Administradores (${acl.aces.map((a) => a.sid).join(', ')})`);
    check(acl.aces.every((a) => a.type === 'A' && a.rights === 'FA' && a.flags.includes('OI') && a.flags.includes('CI')), 'controle total, só concessões, herdado por arquivos e subpastas');
    fs.writeFileSync(path.join(dirA, 'teste.db'), 'x');
    const fileAcl = aclOf(path.join(dirA, 'teste.db'));
    check(onlyExpected(fileAcl) && fileAcl.aces.every((a) => a.flags.includes('ID')), `arquivo criado dentro herda só os mesmos SIDs (${fileAcl.sddl})`);
  } else {
    check((fs.statSync(dirA).mode & 0o777) === 0o700, 'pasta com permissão 700');
  }
  fs.rmSync(dirA, { recursive: true, force: true });

  // No caminho real da cópia: a proteção acontece com a pasta VAZIA e a cópia em claro já nasce com a ACL restrita.
  const walA = path.join(tmp, 'temp-a', 'memory-personal.db');
  fs.mkdirSync(path.dirname(walA), { recursive: true });
  createWalDb(walA, { batches: 3 }).close();
  let atProtect = null;
  let seen = null;
  const snapA = await readDatabaseSnapshot(walA, {
    protectDir: (dir) => { atProtect = fs.readdirSync(dir); restrictDirToOwner(dir); },
    afterSnapshot: (file) => {
      seen = { file, plain: isPlainSqlite(file), acl: isWin ? aclOf(file) : null, mode: fs.statSync(path.dirname(file)).mode & 0o777 };
    },
  });
  check(Array.isArray(atProtect) && atProtect.length === 0, 'a pasta foi protegida ainda vazia (antes de qualquer byte)');
  check(seen?.plain && SNAP_DIR_RE.test(path.basename(path.dirname(seen.file))) && path.dirname(path.dirname(seen.file)) === isolatedTemp, 'a cópia em claro só existiu dentro da pasta yui-snap-*');
  if (isWin) check(onlyExpected(seen.acl), `a cópia em claro tinha só a ACL restrita (${seen.acl.sddl})`);
  else check(seen.mode === 0o700, 'a pasta da cópia em claro estava em 700');
  check(snapA.mode === 'wal-snapshot' && consistent(inspectSqlJs(snapA.data)), 'cópia consistente lida');
  check(!fs.existsSync(path.dirname(seen.file)), 'a pasta da cópia em claro foi apagada no fim');

  // ── [temp c] falha da ACL ──
  section('[temp c] falha da proteção da pasta: nada é gravado em claro');
  await assert.rejects(readDatabaseSnapshot(walA, { protectDir: () => { throw new Error('icacls simulado: acesso negado'); } }), /NÃO foi gravada.*icacls simulado/);
  ok += 1;
  check(plaintextLeftovers().length === 0, `sem pasta yui-snap-* nem cópia em claro depois da falha simulada: ${plaintextLeftovers().join(', ')}`);
  // falha de verdade do icacls (ou do chmod) num alvo inexistente passa pelo mesmo caminho
  assert.throws(() => restrictDirToOwner(path.join(isolatedTemp, 'nao-existe')), isWin ? /icacls falhou/ : /ENOENT/);
  ok += 1;
  await assert.rejects(readDatabaseSnapshot(walA, { protectDir: (dir) => restrictDirToOwner(`${dir}-nao-existe`) }), /NÃO foi gravada/);
  ok += 1;
  check(plaintextLeftovers().length === 0, 'sem sobra depois da falha real da proteção');
  // no backup completo: para com erro claro, sem cópia em claro e sem o arquivo cifrado daquele banco
  const dbDirC = path.join(tmp, 'temp-c', 'database');
  const backupDirC = path.join(tmp, 'temp-c', 'backups');
  fs.mkdirSync(dbDirC, { recursive: true });
  createWalDb(path.join(dbDirC, 'memory-personal.db'), { batches: 2 }).close();
  await assert.rejects(
    createMemoryBackup({ dbDir: dbDirC, backupDir: backupDirC, key, snapshotOptions: { protectDir: () => { throw new Error('ACL recusada'); } } }),
    /NÃO foi gravada.*ACL recusada/,
  );
  ok += 1;
  check(plaintextLeftovers().length === 0, 'backup que falhou na ACL não deixou cópia em claro');
  check(!fs.readdirSync(backupDirC, { recursive: true }).map(String).some((n) => n.endsWith('.enc')), 'e não gerou backup daquele banco');

  // ── [temp b] processo morto no meio da cópia ──
  section('[temp b] processo morto à força no meio da cópia: a sobra é recolhida');
  const dirB = path.join(tmp, 'temp-b');
  const crashDb = path.join(dirB, 'database', 'memory-personal.db');
  fs.mkdirSync(path.dirname(crashDb), { recursive: true });
  createWalDb(crashDb, { batches: 5 }).close();
  const marker = path.join(dirB, 'gravado.txt');
  const crashScript = path.join(dirB, 'queda.mjs');
  // Faz a cópia de verdade (readDatabaseSnapshot) e PARA logo depois de gravar a cópia em claro, antes de ler e apagar.
  fs.writeFileSync(crashScript, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [moduleFile, dbFile, marker] = process.argv.slice(2);
const { readDatabaseSnapshot } = await import(pathToFileURL(moduleFile).href);
await readDatabaseSnapshot(dbFile, {
  afterSnapshot(file) {
    fs.writeFileSync(marker + '.tmp', file);
    fs.renameSync(marker + '.tmp', marker);
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // parado aqui, com a cópia em claro no disco
  },
});
fs.writeFileSync(marker + '.fim', 'terminou');
`);
  const snapshotModule = path.resolve(import.meta.dirname, '..', 'src', 'database', 'snapshot.js');
  const crashChild = spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', crashScript, snapshotModule, crashDb, marker], { stdio: ['ignore', 'ignore', 'pipe'], env: filhoEnv('retrato-morto') });
  let crashErr = '';
  crashChild.stderr.on('data', (d) => { crashErr += d; });
  const crashExit = new Promise((resolve) => crashChild.on('exit', (code, signal) => resolve({ code, signal })));
  let plainFile;
  try {
    for (let waited = 0; !fs.existsSync(marker); waited += 20) {
      if (crashChild.exitCode !== null) throw new Error(`o processo da cópia saiu antes da hora: ${crashErr}`);
      if (waited > 20_000) throw new Error('o processo da cópia não chegou ao ponto da queda em 20 s');
      await sleep(20);
    }
    plainFile = fs.readFileSync(marker, 'utf8');
  } finally {
    crashChild.kill('SIGKILL'); // morte forçada do processo que ESTE teste abriu, pelo handle (o finally dele não roda)
  }
  const exitInfo = await crashExit;
  check(exitInfo.signal === 'SIGKILL' || exitInfo.code !== 0, `o processo morreu à força (código ${exitInfo.code}, sinal ${exitInfo.signal})`);
  check(!fs.existsSync(`${marker}.fim`), 'a cópia não terminou: a queda foi no meio');
  const abandoned = path.dirname(plainFile);
  check(SNAP_DIR_RE.test(path.basename(abandoned)) && path.dirname(abandoned) === isolatedTemp, `pasta abandonada no TEMP do teste: ${path.basename(abandoned)}`);
  check(fs.existsSync(plainFile) && isPlainSqlite(plainFile), 'a cópia EM CLARO ficou para trás (o finally do processo morto não rodou)');
  if (isWin) {
    const acl = aclOf(abandoned);
    check(acl.inheritanceOff && onlyExpected(acl), 'mesmo abandonada, a pasta continua com a ACL restrita');
  }

  // Iscas: a varredura só pode apagar PASTAS yui-snap-XXXXXX paradas há tempo; o resto do TEMP fica intocado.
  const junctionTarget = path.join(dirB, 'alvo-da-juncao');
  fs.mkdirSync(junctionTarget);
  fs.writeFileSync(path.join(junctionTarget, 'precioso.txt'), 'não apagar');
  const decoyDirs = ['outra-pasta', 'yui-snap-abc', 'x-yui-snap-ABCDEF'].map((n) => path.join(isolatedTemp, n));
  for (const d of decoyDirs) {
    fs.mkdirSync(d);
    fs.writeFileSync(path.join(d, 'nao-mexer.txt'), 'x');
  }
  const decoyFile = path.join(isolatedTemp, 'yui-snap-ARQ123');
  fs.writeFileSync(decoyFile, 'x');
  const decoyJunction = path.join(isolatedTemp, 'yui-snap-JUNC01');
  fs.symlinkSync(junctionTarget, decoyJunction, 'junction');
  ageBack([...decoyDirs, ...decoyDirs.map((d) => path.join(d, 'nao-mexer.txt')), decoyFile, junctionTarget, path.join(junctionTarget, 'precioso.txt')]);

  let sweep = cleanupStaleSnapshotDirs();
  check(sweep.removed.length === 0 && fs.existsSync(plainFile), 'pasta parada há pouco NÃO é apagada (pode ser uma cópia em andamento)');
  ageBack([plainFile, abandoned]);
  sweep = cleanupStaleSnapshotDirs();
  check(sweep.removed.length === 1 && sweep.removed[0] === abandoned && !fs.existsSync(abandoned), `a varredura recolheu a pasta abandonada (${sweep.removed.map((d) => path.basename(d)).join(', ')})`);
  check(sweep.failed.length === 0, `nenhuma falha na varredura: ${JSON.stringify(sweep.failed)}`);
  check(decoyDirs.every((d) => fs.existsSync(path.join(d, 'nao-mexer.txt'))) && fs.existsSync(decoyFile), 'iscas no TEMP intactas (outro nome, nome curto, prefixo no meio, arquivo)');
  check(fs.existsSync(decoyJunction) && fs.existsSync(path.join(junctionTarget, 'precioso.txt')), 'junção com o nome do prefixo não foi seguida nem apagada');

  // No começo de cada backup a varredura roda sozinha.
  const planted = createPrivateTempDir();
  const plantedFile = path.join(planted, 'memory-personal.db');
  fs.copyFileSync(crashDb, plantedFile);
  ageBack([plantedFile, planted]);
  const b = await createMemoryBackup({ dbDir: path.dirname(crashDb), backupDir: path.join(dirB, 'backups'), key });
  check(b.success && !fs.existsSync(planted), 'o backup seguinte recolheu, no começo, a sobra de um backup interrompido');

  // Tira as iscas (são deste teste) e confere que não sobrou nada em claro.
  fs.rmSync(decoyJunction, { force: true });
  check(fs.existsSync(path.join(junctionTarget, 'precioso.txt')), 'apagar a junção não apagou o alvo');
  for (const d of decoyDirs) fs.rmSync(d, { recursive: true, force: true });
  fs.rmSync(decoyFile, { force: true });
}

try {
  // ───────────────────────── (a) banco clássico: igual a antes ─────────────────────────
  section('(a) banco clássico e JSON: cópia dos bytes, como antes');
  const dirA = path.join(tmp, 'a', 'database');
  const dataA = path.join(tmp, 'a', 'data');
  fs.mkdirSync(dirA, { recursive: true });
  fs.mkdirSync(dataA, { recursive: true });
  createClassicDb(path.join(dirA, 'memory-personal.db'), 3);
  createClassicDb(path.join(dirA, 'core.db'), 2);
  fs.writeFileSync(path.join(dataA, 'bans.json'), JSON.stringify({ users: { 1: true }, guilds: {}, channels: {} }));
  const classicFile = path.join(dirA, 'memory-personal.db');
  const classicBytes = fs.readFileSync(classicFile);
  check(header(classicFile).join() === '1,1', 'banco do sql.js está no formato clássico');
  check(isWalDatabaseFile(classicFile) === false, 'clássico não é tratado como WAL');
  check(isWalDatabaseFile(path.join(dataA, 'bans.json')) === false, 'JSON não é tratado como banco');

  const snapA = await snapshotDatabaseFile(classicFile, path.join(tmp, 'a', 'copia', 'memory-personal.db'));
  check(snapA.mode === 'copia', `modo da cópia do clássico: ${snapA.mode}`);
  check(fs.readFileSync(snapA.path).equals(classicBytes), 'cópia do clássico = bytes do original');
  check(snapA.sha256 === sha(classicBytes) && snapA.bytes === classicBytes.length, 'sha256 e tamanho devolvidos conferem');
  const readA = await readDatabaseSnapshot(classicFile);
  check(readA.mode === 'copia' && readA.data.equals(classicBytes), 'readDatabaseSnapshot do clássico = bytes do arquivo');

  const shaBeforeA = Object.fromEntries(['memory-personal.db', 'core.db'].map((n) => [n, shaFile(path.join(dirA, n))]));
  const backupA = await createMemoryBackup({ dbDir: dirA, dataDir: dataA, backupDir: path.join(tmp, 'a', 'backups'), key, maxKeep: 5 });
  check(backupA.count === 3, `3 arquivos no backup do clássico (veio ${backupA.count})`);
  const manifestA = decryptManifest(backupA.folder);
  check(manifestA.files.every((f) => f.mode === 'copia'), 'manifesto: tudo no modo cópia');
  for (const f of manifestA.files) {
    const src = f.name.endsWith('.json') ? path.join(dataA, f.name) : path.join(dirA, f.name);
    check(f.sha256Original === shaFile(src), `manifesto: sha256 de ${f.name} = o do arquivo original (como antes)`);
  }
  const restoreA = path.join(tmp, 'a', 'restaurado');
  const resA = await restoreMemoryBackup({ backupFolder: backupA.folder, targetDir: restoreA, key });
  for (const r of resA.restored) {
    const src = r.name.endsWith('.json') ? path.join(dataA, r.name) : path.join(dirA, r.name);
    check(fs.readFileSync(r.path).equals(fs.readFileSync(src)), `restaurado ${r.name} = original byte a byte`);
    check(r.sidecarsRemoved === 0, `${r.name}: nada a apagar ao lado do destino limpo`);
  }
  for (const [n, h] of Object.entries(shaBeforeA)) check(shaFile(path.join(dirA, n)) === h, `original clássico ${n} intocado`);
  check(sourcesFingerprint({ dbDir: dirA, dataDir: dataA }) === oldFingerprint(dirA, dataA, ALL_DB_NAMES), 'fingerprint do clássico é exatamente o de antes');

  // ───────────────────────── (d) fingerprint muda quando só o -wal muda ─────────────────────────
  section('(d) fingerprint do backup externo com WAL');
  const dirD = path.join(tmp, 'd', 'database');
  const dataD = path.join(tmp, 'd', 'data');
  fs.mkdirSync(dirD, { recursive: true });
  fs.mkdirSync(dataD, { recursive: true });
  const walFile = path.join(dirD, 'memory-personal.db');
  // A Yui aberta: conexão de escrita que fica aberta; sem checkpoint automático, as escritas novas ficam só no -wal.
  const writer = createWalDb(walFile, { batches: 1 });
  writer.exec('PRAGMA wal_checkpoint(TRUNCATE);'); // .db com o esquema + 1 lote
  writer.exec('PRAGMA wal_autocheckpoint=0;');
  for (let i = 0; i < 3; i++) insertBatch(writer); // 3 lotes só no -wal
  createClassicDb(path.join(dirD, 'core.db'), 1);
  check(isWalDatabaseFile(walFile) && header(walFile).join() === '2,2', 'banco do motor nativo está em WAL');
  const fp1 = sourcesFingerprint({ dbDir: dirD, dataDir: dataD });
  const old1 = oldFingerprint(dirD, dataD, ALL_DB_NAMES);
  const dbHash1 = shaFile(walFile);
  const walHash1 = shaFile(`${walFile}-wal`);
  insertBatch(writer); // mais um lote: muda só o -wal
  check(shaFile(walFile) === dbHash1, 'a escrita nova não tocou no .db (só no -wal)');
  check(shaFile(`${walFile}-wal`) !== walHash1, 'a escrita nova mudou o -wal');
  const fp2 = sourcesFingerprint({ dbDir: dirD, dataDir: dataD });
  check(fp2 !== fp1, 'fingerprint MUDOU quando só o -wal mudou');
  check(oldFingerprint(dirD, dataD, ALL_DB_NAMES) === old1, '(o fingerprint antigo, só do .db, não teria mudado: era o defeito)');
  check(sourcesFingerprint({ dbDir: dirD, dataDir: dataD }) === fp2, 'sem escrita nova, o fingerprint fica igual (não envia à toa)');

  // ───────────────────── (c) + (e) restauração isolada, original intocado, manifesto ─────────────────────
  section('(c) restauração numa pasta isolada com -wal/-shm velhos; (e) manifesto e SHA-256');
  const rawStale = inspectSqlJs(fs.readFileSync(walFile)); // o que a cópia de bytes antiga levaria
  const realLotes = Number(writer.prepare('SELECT lotes FROM meta').get().lotes);
  check(rawStale.lotes === 1 && realLotes === 5, `cópia só do .db ficaria velha (${rawStale.lotes} lote de ${realLotes})`);
  const origDbHash = shaFile(walFile);
  const origWalHash = shaFile(`${walFile}-wal`);

  const backupC = await createMemoryBackup({ dbDir: dirD, backupDir: path.join(tmp, 'c', 'backups'), key, maxKeep: 5 });
  const manifestC = decryptManifest(backupC.folder);
  const entryWal = manifestC.files.find((f) => f.name === 'memory-personal.db');
  const entryClassic = manifestC.files.find((f) => f.name === 'core.db');
  check(entryWal?.mode === 'wal-snapshot', `manifesto: banco WAL no modo wal-snapshot (veio ${entryWal?.mode})`);
  check(entryClassic?.mode === 'copia' && entryClassic.sha256Original === shaFile(path.join(dirD, 'core.db')), 'manifesto: clássico ao lado continua cópia dos bytes');

  // Destino isolado com sobras de OUTRO banco WAL (como depois de uma queda): -wal com transações e -shm qualquer.
  const restoreC = path.join(tmp, 'c', 'restaurado');
  fs.mkdirSync(restoreC, { recursive: true });
  const staleDir = path.join(tmp, 'c', 'velho');
  fs.mkdirSync(staleDir, { recursive: true });
  const staleFile = path.join(staleDir, 'velho.db');
  const stale = createWalDb(staleFile, { batches: 2 });
  stale.exec('PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;');
  for (let i = 0; i < 40; i++) insertBatch(stale, 'velho');
  const target = path.join(restoreC, 'memory-personal.db');
  fs.copyFileSync(staleFile, target);
  fs.copyFileSync(`${staleFile}-wal`, `${target}-wal`);
  fs.writeFileSync(`${target}-shm`, crypto.randomBytes(32768));
  stale.close();
  check(fs.statSync(`${target}-wal`).size > 0, 'destino tem um -wal velho com transações');

  const resC = await restoreMemoryBackup({ backupFolder: backupC.folder, targetDir: restoreC, key });
  const restoredWal = resC.restored.find((r) => r.name === 'memory-personal.db');
  check(restoredWal.sidecarsRemoved === 2, `restauração apagou -wal e -shm velhos (apagou ${restoredWal.sidecarsRemoved})`);
  check(!fs.existsSync(`${target}-wal`) && !fs.existsSync(`${target}-shm`), 'nenhum -wal/-shm velho ao lado do banco restaurado');
  check(header(target).join() === '1,1', 'banco restaurado no formato clássico');
  const infoC = inspectSqlJs(fs.readFileSync(target));
  check(consistent(infoC) && infoC.lotes === realLotes, `sql.js lê o restaurado com TODOS os lotes, inclusive os que estavam só no -wal (${infoC.lotes}/${realLotes})`);
  const nat = new DatabaseSync(target, { readOnly: true });
  const natLotes = Number(nat.prepare('SELECT lotes FROM meta').get().lotes);
  const natCount = Number(nat.prepare('SELECT count(*) AS c FROM itens').get().c);
  nat.close();
  check(natLotes === realLotes && natCount === realLotes * BATCH, 'node:sqlite lê o restaurado igual (o WAL velho não foi reaplicado)');
  check(!fs.existsSync(`${target}-wal`), 'abrir o restaurado só para leitura não criou -wal');
  // (e) manifesto e SHA-256
  for (const r of resC.restored) {
    const f = manifestC.files.find((m) => m.name === r.name);
    check(f && shaFile(r.path) === f.sha256Original && r.sha256 === f.sha256Original, `${r.name}: SHA-256 do restaurado = manifesto`);
    check(fs.statSync(r.path).size === f.sizeOriginal, `${r.name}: tamanho do restaurado = manifesto`);
  }
  // original intocado (a conexão de escrita continua aberta, sem escrever)
  check(shaFile(walFile) === origDbHash, 'original .db intocado (mesmo hash antes e depois do backup e da restauração)');
  check(shaFile(`${walFile}-wal`) === origWalHash, 'original -wal intocado');
  check(Number(writer.prepare('SELECT lotes FROM meta').get().lotes) === realLotes, 'original continua com os mesmos lotes');
  // (e) o que snapshotDatabaseFile devolve confere com o arquivo
  const snapE = await snapshotDatabaseFile(walFile, path.join(tmp, 'e', 'copia.db'));
  check(snapE.mode === 'wal-snapshot' && snapE.sha256 === shaFile(snapE.path) && snapE.bytes === fs.statSync(snapE.path).size, 'snapshotDatabaseFile: path, bytes e sha256 conferem');
  check(shaFile(walFile) === origDbHash && shaFile(`${walFile}-wal`) === origWalHash, 'snapshotDatabaseFile não mexeu na origem');
  writer.close();

  // Banco WAL fechado direito (sem -wal nem -shm): a cópia não muda o .db nem deixa sobras ao lado dele.
  const closedFile = path.join(tmp, 'c', 'fechado.db');
  createWalDb(closedFile, { batches: 4 }).close();
  check(!fs.existsSync(`${closedFile}-wal`) && header(closedFile).join() === '2,2', 'banco WAL fechado: só o .db, cabeçalho WAL');
  const closedHash = shaFile(closedFile);
  const snapClosed = await snapshotDatabaseFile(closedFile, path.join(tmp, 'c', 'fechado-copia.db'));
  check(snapClosed.mode === 'wal-snapshot' && consistent(inspectSqlJs(fs.readFileSync(snapClosed.path))), 'cópia do WAL fechado: consistente');
  check(shaFile(closedFile) === closedHash, 'WAL fechado: .db intocado');
  check(!fs.existsSync(`${closedFile}-wal`) && !fs.existsSync(`${closedFile}-shm`), 'WAL fechado: nenhuma sobra -wal/-shm deixada pela cópia');

  // ───────────── (b) novas tentativas em erro passageiro + gravações e fechamentos DURANTE o backup ─────────────
  section('(b) erro passageiro: novas tentativas');
  check(isTransientSqliteError({ errcode: 5, message: 'database is locked' }), 'BUSY é passageiro');
  check(isTransientSqliteError({ errcode: 522, message: 'disk I/O error' }), 'IOERR estendido (disk I/O error) é passageiro');
  check(isTransientSqliteError({ errcode: 14, message: 'unable to open database file' }), 'CANTOPEN é passageiro');
  check(!isTransientSqliteError({ errcode: 1, message: 'no such table: x' }), 'erro de SQL não é passageiro');
  check(!isTransientSqliteError({ errcode: 26, message: 'file is not a database' }), 'arquivo que não é banco não é passageiro');

  const lockFile = path.join(tmp, 'b', 'travado.db');
  fs.mkdirSync(path.dirname(lockFile), { recursive: true });
  createWalDb(lockFile, { batches: 2 }).close();
  const holderScript = path.join(tmp, 'b', 'trava.mjs');
  fs.writeFileSync(holderScript, `
import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('PRAGMA locking_mode=EXCLUSIVE; BEGIN EXCLUSIVE; UPDATE meta SET lotes = lotes; COMMIT;');
console.log('travado');
setTimeout(() => { db.close(); }, Number(process.argv[3]));
`);
  const holder = spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', holderScript, lockFile, '400'], { stdio: ['ignore', 'pipe', 'pipe'], env: filhoEnv('trava-do-banco') });
  const holderExit = new Promise((resolve) => holder.on('exit', resolve));
  await new Promise((resolve, reject) => { holder.stdout.once('data', resolve); holder.once('exit', () => reject(new Error('o processo da trava saiu antes de travar'))); });
  await assert.rejects(snapshotDatabaseFile(lockFile, path.join(tmp, 'b', 'sem-retry.db'), { busyTimeoutMs: 0, attempts: 1 }), /database is locked/);
  ok += 1;
  check(!fs.existsSync(path.join(tmp, 'b', 'sem-retry.db')), 'sem novas tentativas: falha alta e nenhum destino pela metade');
  const snapRetry = await snapshotDatabaseFile(lockFile, path.join(tmp, 'b', 'com-retry.db'), { busyTimeoutMs: 0 });
  check(snapRetry.attempts > 1 && consistent(inspectSqlJs(fs.readFileSync(snapRetry.path))), `com novas tentativas: deu certo na tentativa ${snapRetry.attempts}`);
  await holderExit;

  section('(b) gravações em lote e fechamentos de conexão DURANTE o backup');
  const dirB = path.join(tmp, 'b', 'database');
  fs.mkdirSync(dirB, { recursive: true });
  const fileB = path.join(dirB, 'memory-personal.db');
  createWalDb(fileB).close();
  createClassicDb(path.join(dirB, 'core.db'), 1);
  const writerScript = path.join(tmp, 'b', 'escritor.mjs');
  // O "processo da Yui": transações de BATCH linhas o tempo todo; a cada 15 lotes fecha a conexão (sendo a última, o
  // SQLite faz o checkpoint e apaga -wal e -shm) e reabre. Para quando aparecer o arquivo "parar".
  fs.writeFileSync(writerScript, `
import fs from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
const [file, stopFile, readyFile, batchStr] = process.argv.slice(2);
const BATCH = Number(batchStr);
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const payload = 'y'.repeat(150);
let lotes = 0, fechamentos = 0;
outer: for (;;) {
  const db = new DatabaseSync(file, { timeout: 10000 });
  db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=NORMAL;');
  const ins = db.prepare('INSERT INTO itens (lote, seq, texto) VALUES (?, ?, ?)');
  for (let i = 0; i < 15; i++) {
    if (fs.existsSync(stopFile)) { db.close(); break outer; }
    db.exec('BEGIN IMMEDIATE');
    try {
      for (let j = 0; j < BATCH; j++) ins.run(lotes + 1, j, payload);
      db.exec('UPDATE meta SET lotes = lotes + 1');
      db.exec('COMMIT');
    } catch (err) { db.exec('ROLLBACK'); throw err; }
    lotes++;
    if (lotes === 3) fs.writeFileSync(readyFile, 'ok');
    pause(1);
  }
  db.close();
  fechamentos++;
}
console.log(JSON.stringify({ lotes, fechamentos }));
`);
  const stopFile = path.join(tmp, 'b', 'parar');
  const readyFile = path.join(tmp, 'b', 'pronto');
  const child = spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', writerScript, fileB, stopFile, readyFile, String(BATCH)], { stdio: ['ignore', 'pipe', 'pipe'], env: filhoEnv('escritor') });
  let childOut = '';
  let childErr = '';
  child.stdout.on('data', (d) => { childOut += d; });
  child.stderr.on('data', (d) => { childErr += d; });
  const childExit = new Promise((resolve) => child.on('exit', (code) => resolve(code)));
  try {
    for (let waited = 0; !fs.existsSync(readyFile); waited += 20) {
      if (child.exitCode !== null) throw new Error(`o escritor saiu antes de começar: ${childErr}`);
      if (waited > 20_000) throw new Error('o escritor não começou em 20 s');
      await sleep(20);
    }
    const seen = [];
    let maxAttempts = 1;
    let backups = 0;
    const ROUNDS = 30;
    for (let i = 0; i < ROUNDS; i++) {
      const snap = await snapshotDatabaseFile(fileB, path.join(tmp, 'b', 'copias', `copia-${i}.db`));
      maxAttempts = Math.max(maxAttempts, snap.attempts ?? 1);
      const buf = fs.readFileSync(snap.path);
      const info = inspectSqlJs(buf);
      check(snap.mode === 'wal-snapshot' && header(snap.path).join() === '1,1', `cópia ${i}: modo wal-snapshot e formato clássico`);
      check(consistent(info), `cópia ${i}: integrity ok e count ${info.count} = ${info.lotes} lotes × ${BATCH} (nunca transação pela metade)`);
      check(sha(buf) === snap.sha256 && buf.length === snap.bytes, `cópia ${i}: sha256 e tamanho conferem`);
      check(seen.length === 0 || info.lotes >= seen.at(-1), `cópia ${i}: nunca volta no tempo (${info.lotes} >= ${seen.at(-1)})`);
      seen.push(info.lotes);
      if (i % 5 === 4) {
        // O backup de verdade (cifrado) no meio das gravações, restaurado numa pasta isolada.
        const b = await createMemoryBackup({ dbDir: dirB, backupDir: path.join(tmp, 'b', 'backups'), key, maxKeep: 50 });
        const m = decryptManifest(b.folder);
        check(m.files.find((f) => f.name === 'memory-personal.db')?.mode === 'wal-snapshot', `backup ${backups}: banco WAL no modo wal-snapshot`);
        const res = await restoreMemoryBackup({ backupFolder: b.folder, targetDir: path.join(tmp, 'b', `restaurado-${backups}`), key });
        const r = res.restored.find((x) => x.name === 'memory-personal.db');
        const rInfo = inspectSqlJs(fs.readFileSync(r.path));
        check(consistent(rInfo), `backup ${backups}: restaurado consistente (${rInfo.lotes} lotes)`);
        check(r.sha256 === m.files.find((f) => f.name === 'memory-personal.db').sha256Original, `backup ${backups}: SHA-256 = manifesto`);
        backups++;
      }
    }
    check(child.exitCode === null, 'o escritor ainda estava gravando quando as cópias terminaram (houve concorrência de verdade)');
    check(new Set(seen).size > 1, `as cópias pegaram estados diferentes do banco (${new Set(seen).size} distintos: ${seen[0]} → ${seen.at(-1)} lotes)`);
    console.log(`    ${ROUNDS} cópias + ${backups} backups; maior número de tentativas numa cópia: ${maxAttempts}`);
  } finally {
    fs.writeFileSync(stopFile, '1');
    const timer = setTimeout(() => { if (child.exitCode === null) child.kill(); }, 30_000); // só o processo que este teste abriu, pelo handle
    await childExit;
    clearTimeout(timer);
  }
  check(child.exitCode === 0, `o escritor terminou sem erro: ${childErr.split('\n').filter((l) => !/ExperimentalWarning|trace-warnings/.test(l)).join(' ').slice(0, 300)}`);
  const final = JSON.parse(childOut.trim().split('\n').pop());
  console.log(`    escritor: ${final.lotes} transações de ${BATCH} linhas, ${final.fechamentos} fechamentos de conexão`);
  check(final.fechamentos > 0, `o escritor fechou e reabriu a conexão durante o teste (${final.fechamentos} vezes)`);
  const orig = new DatabaseSync(fileB);
  const origIntegrity = orig.prepare('PRAGMA integrity_check').all().map((r) => Object.values(r)[0]).join();
  const origLotes = Number(orig.prepare('SELECT lotes FROM meta').get().lotes);
  const origCount = Number(orig.prepare('SELECT count(*) AS c FROM itens').get().c);
  orig.close();
  check(origIntegrity === 'ok', `original íntegro no fim (${origIntegrity})`);
  check(origLotes === final.lotes && origCount === final.lotes * BATCH, `original com todos os ${final.lotes} lotes do escritor (${origCount} linhas)`);

  check(plaintextLeftovers().length === 0, `nenhuma cópia em claro esquecida no TEMP: ${plaintextLeftovers().join(', ')}`);

  await tempSecurityTests();

  check(plaintextLeftovers().length === 0, `no fim, nenhum yui-snap-* nem banco em claro no TEMP: ${plaintextLeftovers().join(', ')}`);
  BLOQUEIO.fechar('test:backupwal'); // falha alto se algum filho tentou rede, DNS, UDP, programa fora da lista ou worker
  console.log(`OK: backup com WAL — ${ok} testes OK`);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
