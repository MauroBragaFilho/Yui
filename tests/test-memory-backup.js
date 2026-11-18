import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { criarBloqueioTemporario } from './helpers/bloqueioExternoTeste.js';
import {
  createMemoryBackup,
  restoreMemoryBackup,
  encryptBackupBuffer,
  decryptBackupBuffer,
  resolveBackupKey,
  MEMORY_DATABASES,
  MANIFEST_NAME,
  BACKUP_FOLDER_RE,
  inspectBackupFolder,
  listBackups,
  findLatestCompleteBackup,
  findIncompleteBackups,
  cleanupIncompleteBackups,
  readBackupManifest,
  verifyMemoryBackup,
} from '../src/core/memory/backup.js';
import { configureAlerts } from '../src/core/alerts.js';

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
// Etapa 8 (revisão da Liz): o processo auxiliar deste teste (o backup morto no meio) roda sob o bloqueio de integração externa (rede, DNS, UDP,
// programas e workers falham e ficam registrados). O backup restringe a permissão da cópia em claro com o icacls e o whoami do Windows (sem rede).
const BLOQUEIO = criarBloqueioTemporario({ teste: 'test:backup', liberar: { 'programa:icacls': 'o backup restringe a permissão da cópia em claro (src/database/snapshot.js; sem rede)', 'programa:whoami': 'o backup descobre o usuário atual para a permissão da cópia em claro (sem rede)' } });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** Cópia de um lote para outro nome (para montar cenários sem refazer backups). */
const copyBackup = (from, to) => { fs.cpSync(from, to, { recursive: true }); return to; };
/** Troca o último byte de um arquivo (corrupção de 1 byte). */
const flipLastByte = (file) => { const b = fs.readFileSync(file); b[b.length - 1] ^= 0xff; fs.writeFileSync(file, b); };
/** Envelhece uma pasta e o que está direto nela (links pela própria data, sem seguir). */
function ageTree(dir, ms = 2 * 60 * 60 * 1000) {
  const old = new Date(Date.now() - ms);
  for (const entry of fs.readdirSync(dir)) {
    const p = path.join(dir, entry);
    if (fs.lstatSync(p).isSymbolicLink()) fs.lutimesSync(p, old, old);
    else fs.utimesSync(p, old, old);
  }
  fs.utimesSync(dir, old, old);
}

test('Backup e Restauração Cifrada de Memória (R05)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-backup-test-'));
  // TEMP isolado: a varredura de temporários do backup e as cópias em claro dos filhos ficam aqui, nunca no TEMP real.
  const isolatedTemp = path.join(tmpRoot, 'temp');
  fs.mkdirSync(isolatedTemp);
  process.env.TEMP = isolatedTemp;
  process.env.TMP = isolatedTemp;
  process.env.TMPDIR = isolatedTemp;
  const fakeDbDir = path.join(tmpRoot, 'database');
  const fakeBackupDir = path.join(tmpRoot, 'backups');
  const fakeRestoreDir = path.join(tmpRoot, 'restored');
  fs.mkdirSync(fakeDbDir, { recursive: true });

  const testKey = crypto.randomBytes(32);
  const testKeyHex = testKey.toString('hex');

  // Cria bancos fictícios para teste com conteúdo conhecido
  const testContents = {};
  for (const dbName of MEMORY_DATABASES) {
    const data = Buffer.from(`CONTEÚDO_SECRETO_DE_${dbName}_${crypto.randomBytes(64).toString('hex')}`);
    fs.writeFileSync(path.join(fakeDbDir, dbName), data);
    testContents[dbName] = {
      buffer: data,
      sha256: crypto.createHash('sha256').update(data).digest('hex'),
    };
  }

  await t.test('resolveBackupKey aceita chave direta, hex e hash de passphrase', () => {
    const rawKey = resolveBackupKey({ key: testKey });
    assert.deepEqual(rawKey, Uint8Array.from(testKey));

    const hexKey = resolveBackupKey({ key: testKeyHex });
    assert.deepEqual(hexKey, Uint8Array.from(testKey));

    const passKey = resolveBackupKey({ key: 'minha-senha-segura' });
    const expectedHash = crypto.createHash('sha256').update('minha-senha-segura', 'utf8').digest();
    assert.deepEqual(passKey, Uint8Array.from(expectedHash));
  });

  await t.test('encryptBackupBuffer e decryptBackupBuffer garantem confidencialidade e integridade', () => {
    const original = Buffer.from('Mensagem de teste para cifragem');
    const encrypted = encryptBackupBuffer(original, testKey);

    assert.notDeepEqual(encrypted, original);
    const decrypted = decryptBackupBuffer(encrypted, testKey);
    assert.equal(decrypted.data.toString('utf8'), 'Mensagem de teste para cifragem');
    assert.equal(decrypted.sha256, crypto.createHash('sha256').update(original).digest('hex'));

    // Chave errada deve falhar
    const wrongKey = crypto.randomBytes(32);
    assert.throws(() => {
      decryptBackupBuffer(encrypted, wrongKey);
    }, /Falha na autenticação/);

    // Adulteração de dados deve falhar
    const tampered = Buffer.from(encrypted);
    tampered[tampered.length - 1] ^= 0xff;
    assert.throws(() => {
      decryptBackupBuffer(tampered, testKey);
    }, /Falha na autenticação|Integridade violada/);
  });

  let backupResult;
  await t.test('createMemoryBackup executa cópia cifrada em diretório configurável e rotaciona', async () => {
    backupResult = await createMemoryBackup({
      dbDir: fakeDbDir,
      backupDir: fakeBackupDir,
      key: testKey,
      maxKeep: 2,
    });

    assert.equal(backupResult.success, true);
    assert.equal(backupResult.count, MEMORY_DATABASES.length);
    assert(fs.existsSync(backupResult.folder));
    assert(fs.existsSync(path.join(backupResult.folder, 'manifest.json.enc')));

    for (const dbName of MEMORY_DATABASES) {
      assert(fs.existsSync(path.join(backupResult.folder, `${dbName}.enc`)));
    }
  });

  await t.test('restauração em diretório limpo reproduz exatamente os arquivos verificados por hash', async () => {
    // Simula corrupção/perda no diretório original
    for (const dbName of MEMORY_DATABASES) {
      fs.writeFileSync(path.join(fakeDbDir, dbName), Buffer.from('CORRUPTED_TRUNCATED_GARBAGE'));
    }

    const restoreResult = await restoreMemoryBackup({
      backupFolder: backupResult.folder,
      targetDir: fakeRestoreDir,
      key: testKey,
    });

    assert.equal(restoreResult.success, true);
    assert.equal(restoreResult.restored.length, MEMORY_DATABASES.length);

    for (const item of restoreResult.restored) {
      const original = testContents[item.name];
      const restoredData = fs.readFileSync(item.path);
      const restoredHash = crypto.createHash('sha256').update(restoredData).digest('hex');

      assert.equal(restoredHash, original.sha256, `Hash de ${item.name} coincide com o original pré-corrupção`);
      assert.deepEqual(restoredData, original.buffer);
    }
  });

  await t.test('manifesto gravado por último (v2): selo, backup concluído e SHA-256 de cada arquivo cifrado', () => {
    const raw = fs.readFileSync(path.join(backupResult.folder, MANIFEST_NAME));
    assert.equal(raw.subarray(0, 16).toString('utf8'), 'YUI_MANIFEST_V2\n', 'manifesto com selo');
    assert.equal(raw.subarray(16, 80).toString('latin1'), sha(raw.subarray(81)), 'o selo é o SHA-256 do conteúdo cifrado');
    const info = inspectBackupFolder(backupResult.folder);
    assert.equal(info.complete, true);
    assert.equal(info.manifestVersion, 2);
    const { manifest } = readBackupManifest(backupResult.folder, testKey);
    assert.equal(manifest.version, 2);
    assert.equal(manifest.complete, true, 'o manifesto marca o backup como concluído');
    assert.ok(manifest.completedAt);
    for (const f of manifest.files) {
      const enc = fs.readFileSync(path.join(backupResult.folder, f.encName));
      assert.equal(f.sha256Encrypted, sha(enc), `SHA-256 do cifrado ${f.encName} no manifesto`);
      assert.equal(f.sizeEncrypted, enc.length);
    }
    assert.deepEqual(fs.readdirSync(backupResult.folder).filter((n) => n.endsWith('.tmp')), [], 'nenhum temporário do manifesto sobrou');
    assert.equal(verifyMemoryBackup({ backupFolder: backupResult.folder, key: testKey }).files.length, MEMORY_DATABASES.length);
  });

  let killedFolder;
  await t.test('backup interrompido no meio (processo morto antes do manifesto) fica incompleto', async () => {
    const dir = path.join(tmpRoot, 'interrompido');
    const dbDir = path.join(dir, 'database');
    const backupDir = path.join(dir, 'backups');
    fs.mkdirSync(dbDir, { recursive: true });
    // 1º da lista: arquivo comum, vira .enc antes da queda. Depois: banco WAL, cuja cópia consistente tem o ponto de parada.
    fs.writeFileSync(path.join(dbDir, 'memory-personal.db'), crypto.randomBytes(4096));
    const { DatabaseSync } = await import('node:sqlite');
    const w = new DatabaseSync(path.join(dbDir, 'core.db'));
    w.exec('PRAGMA journal_mode=WAL; CREATE TABLE t (x); INSERT INTO t VALUES (1);');
    w.close();
    const marker = path.join(dir, 'parado.txt');
    const script = path.join(dir, 'backup-interrompido.mjs');
    fs.writeFileSync(script, `
import fs from 'node:fs';
import { pathToFileURL } from 'node:url';
const [moduleFile, dbDir, backupDir, marker] = process.argv.slice(2);
const { createMemoryBackup } = await import(pathToFileURL(moduleFile).href);
await createMemoryBackup({ dbDir, backupDir, snapshotOptions: { afterSnapshot() {
  fs.writeFileSync(marker + '.tmp', 'parado');
  fs.renameSync(marker + '.tmp', marker);
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0); // parado no meio do backup, antes do manifesto
} } });
fs.writeFileSync(marker + '.fim', 'terminou');
`);
    const backupModule = path.resolve(import.meta.dirname, '..', 'src', 'core', 'memory', 'backup.js');
    const child = spawn(process.execPath, [...BLOQUEIO.argv, '--no-warnings', script, backupModule, dbDir, backupDir, marker], {
      cwd: dir, env: { ...process.env, NODE_ENV: 'test', YUI_BACKUP_KEY: testKeyHex, YUI_ALERTS: 'false', DATABASE_DIR: dbDir, ...BLOQUEIO.env('backup-morto-no-meio') }, stdio: ['ignore', 'ignore', 'pipe'],
    });
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
    try {
      for (let waited = 0; !fs.existsSync(marker); waited += 20) {
        if (child.exitCode !== null) throw new Error(`o backup saiu antes do ponto de parada: ${stderr}`);
        if (waited > 30_000) throw new Error('o backup não chegou ao ponto de parada em 30 s');
        await sleep(20);
      }
    } finally {
      child.kill('SIGKILL'); // morte forçada do processo que ESTE teste abriu, pelo handle
    }
    const exit = await exited;
    assert.ok(exit.signal === 'SIGKILL' || exit.code !== 0, `processo morto à força (${JSON.stringify(exit)})`);
    assert.ok(!fs.existsSync(`${marker}.fim`), 'o backup não terminou');
    const folders = fs.readdirSync(backupDir).filter((n) => BACKUP_FOLDER_RE.test(n));
    assert.equal(folders.length, 1, 'ficou um lote');
    killedFolder = path.join(backupDir, folders[0]);
    assert.ok(fs.existsSync(path.join(killedFolder, 'memory-personal.db.enc')), 'o 1º arquivo cifrado chegou a ser gravado');
    assert.ok(!fs.existsSync(path.join(killedFolder, MANIFEST_NAME)), 'mas o manifesto não');
    const info = inspectBackupFolder(killedFolder);
    assert.equal(info.complete, false, 'o lote é identificado como incompleto');
    assert.match(info.reason, /sem manifesto/);
    assert.equal(findIncompleteBackups(backupDir).length, 0, 'recente: ainda não é tratado como abandonado (pode ser um backup em andamento)');
    assert.deepEqual(findIncompleteBackups(backupDir, { maxAgeMs: 0 }).map((b) => b.path), [killedFolder]);
  });

  await t.test('restauração e conferência recusam incompleto, manifesto ilegível ou corrompido e arquivo que não confere', async () => {
    const dir = path.join(tmpRoot, 'recusas');
    fs.mkdirSync(dir);
    const target = path.join(dir, 'destino');
    const restore = (folder, key = testKey) => restoreMemoryBackup({ backupFolder: folder, targetDir: target, key });

    // sem manifesto (o lote do processo morto)
    await assert.rejects(restore(killedFolder), /Backup incompleto: .* não tem o manifesto/);
    assert.throws(() => verifyMemoryBackup({ backupFolder: killedFolder, key: testKey }), /Backup incompleto/);

    // selo que não confere (1 byte do manifesto trocado)
    const sealBroken = copyBackup(backupResult.folder, path.join(dir, 'backup-2026-02-01T00-00-00-000Z'));
    flipLastByte(path.join(sealBroken, MANIFEST_NAME));
    assert.match(inspectBackupFolder(sealBroken).reason, /selo SHA-256 do manifesto não confere/);
    await assert.rejects(restore(sealBroken), /manifesto de backup-2026-02-01T00-00-00-000Z está ilegível \(o selo SHA-256/);

    // manifesto truncado no meio (gravação interrompida de um backup antigo, sem rename)
    const truncated = copyBackup(backupResult.folder, path.join(dir, 'backup-2026-02-02T00-00-00-000Z'));
    const mPath = path.join(truncated, MANIFEST_NAME);
    fs.writeFileSync(mPath, fs.readFileSync(mPath).subarray(0, 120));
    assert.equal(inspectBackupFolder(truncated).complete, false);
    await assert.rejects(restore(truncated), /está ilegível/);

    // manifesto ilegível (lixo)
    const garbage = copyBackup(backupResult.folder, path.join(dir, 'backup-2026-02-03T00-00-00-000Z'));
    fs.writeFileSync(path.join(garbage, MANIFEST_NAME), 'isto não é um manifesto');
    assert.match(inspectBackupFolder(garbage).reason, /ilegível/);
    await assert.rejects(restore(garbage), /está ilegível/);

    // manifesto íntegro, mas um arquivo cifrado adulterado: sem a chave parece completo; com a chave, recusado
    const tampered = copyBackup(backupResult.folder, path.join(dir, 'backup-2026-02-04T00-00-00-000Z'));
    flipLastByte(path.join(tampered, `${MEMORY_DATABASES[1]}.enc`));
    assert.equal(inspectBackupFolder(tampered).complete, true);
    await assert.rejects(restore(tampered), new RegExp(`${MEMORY_DATABASES[1]}\\.enc não confere com o manifesto`));
    assert.throws(() => verifyMemoryBackup({ backupFolder: tampered, key: testKey }), /não confere com o manifesto/);

    // arquivo cifrado faltando
    const missing = copyBackup(backupResult.folder, path.join(dir, 'backup-2026-02-05T00-00-00-000Z'));
    fs.rmSync(path.join(missing, `${MEMORY_DATABASES[0]}.enc`));
    await assert.rejects(restore(missing), /está no manifesto .* mas não existe na pasta/);

    // chave errada
    await assert.rejects(restore(backupResult.folder, crypto.randomBytes(32)), /não pôde ser decifrado/);

    assert.ok(!fs.existsSync(target), 'nenhuma recusa gravou qualquer arquivo no destino (tudo é conferido antes)');
  });

  await t.test('backup antigo (manifesto v1, sem selo) continua válido e restaurando', async () => {
    const legacy = path.join(tmpRoot, 'legado', 'backup-2025-06-01T00-00-00-000Z');
    fs.mkdirSync(legacy, { recursive: true });
    const content = Buffer.from(`BANCO ANTIGO ${crypto.randomBytes(16).toString('hex')}`);
    const enc = encryptBackupBuffer(content, testKey);
    fs.writeFileSync(path.join(legacy, 'memory-personal.db.enc'), enc);
    const manifestV1 = { version: 1, createdAt: '2025-06-01T00:00:00.000Z', files: [{ name: 'memory-personal.db', encName: 'memory-personal.db.enc', sizeOriginal: content.length, sizeEncrypted: enc.length, sha256Original: sha(content) }] };
    fs.writeFileSync(path.join(legacy, MANIFEST_NAME), encryptBackupBuffer(Buffer.from(JSON.stringify(manifestV1)), testKey));
    const info = inspectBackupFolder(legacy);
    assert.equal(info.complete, true);
    assert.equal(info.manifestVersion, 1);
    const res = await restoreMemoryBackup({ backupFolder: legacy, targetDir: path.join(tmpRoot, 'legado', 'destino'), key: testKey });
    assert.deepEqual(fs.readFileSync(res.restored[0].path), content);
  });

  await t.test('o "mais recente" pula os incompletos e não segue junção', () => {
    const dir = path.join(tmpRoot, 'escolha');
    fs.mkdirSync(dir);
    const ok1 = copyBackup(backupResult.folder, path.join(dir, 'backup-2026-03-01T00-00-00-000Z'));
    copyBackup(backupResult.folder, path.join(dir, 'backup-2026-03-02T00-00-00-000Z'));
    copyBackup(killedFolder, path.join(dir, 'backup-2026-03-03T00-00-00-000Z')); // incompleto mais novo
    flipLastByte(path.join(copyBackup(backupResult.folder, path.join(dir, 'backup-2026-03-04T00-00-00-000Z')), MANIFEST_NAME)); // selo quebrado
    fs.symlinkSync(ok1, path.join(dir, 'backup-2026-03-05T00-00-00-000Z'), 'junction'); // junção com nome de lote, mais nova
    fs.mkdirSync(path.join(dir, 'backup-nao-e-data'));
    const { latest, skipped } = findLatestCompleteBackup(dir);
    assert.equal(latest.name, 'backup-2026-03-02T00-00-00-000Z');
    assert.deepEqual(skipped.map((b) => b.name), ['backup-2026-03-03T00-00-00-000Z', 'backup-2026-03-04T00-00-00-000Z']);
    assert.deepEqual(listBackups(dir).map((b) => b.name), ['backup-2026-03-01T00-00-00-000Z', 'backup-2026-03-02T00-00-00-000Z', 'backup-2026-03-03T00-00-00-000Z', 'backup-2026-03-04T00-00-00-000Z'], 'junção e nome fora do padrão ficam fora');
    assert.equal(findLatestCompleteBackup(path.join(tmpRoot, 'nao-existe')).latest, null);
  });

  await t.test('limpeza apaga só incompleto abandonado: nunca completo, recente, link ou outra coisa', async () => {
    const dir = path.join(tmpRoot, 'limpeza');
    fs.mkdirSync(dir);
    const at = (n) => path.join(dir, n);
    const completeOld = copyBackup(backupResult.folder, at('backup-2025-01-01T00-00-00-000Z'));
    const damagedOld = copyBackup(backupResult.folder, at('backup-2025-01-02T00-00-00-000Z'));
    flipLastByte(path.join(damagedOld, `${MEMORY_DATABASES[0]}.enc`)); // manifesto íntegro: não é "incompleto", não se apaga
    const legacyOld = copyBackup(path.join(tmpRoot, 'legado', 'backup-2025-06-01T00-00-00-000Z'), at('backup-2025-01-03T00-00-00-000Z'));
    const incompleteOld = copyBackup(killedFolder, at('backup-2025-01-04T00-00-00-000Z'));
    const brokenOld = copyBackup(backupResult.folder, at('backup-2025-01-05T00-00-00-000Z'));
    flipLastByte(path.join(brokenOld, MANIFEST_NAME));
    const incompleteRecent = copyBackup(killedFolder, at('backup-2025-01-06T00-00-00-000Z'));
    const precious = path.join(tmpRoot, 'precioso');
    fs.mkdirSync(precious);
    fs.writeFileSync(path.join(precious, 'nao-apagar.txt'), 'x');
    const withJunction = copyBackup(killedFolder, at('backup-2025-01-07T00-00-00-000Z'));
    fs.symlinkSync(precious, path.join(withJunction, 'link-para-fora'), 'junction'); // incompleto com junção dentro
    const junctionTarget = path.join(tmpRoot, 'alvo-sem-manifesto');
    fs.mkdirSync(junctionTarget);
    fs.writeFileSync(path.join(junctionTarget, 'x.enc'), 'x');
    const junctionFolder = at('backup-2025-01-08T00-00-00-000Z');
    fs.symlinkSync(junctionTarget, junctionFolder, 'junction'); // junção com nome de lote, apontando para pasta sem manifesto
    const otherName = at('outra-pasta');
    fs.mkdirSync(otherName);
    fs.writeFileSync(path.join(otherName, 'x.enc'), 'x');
    const fileNamed = at('backup-2025-01-09T00-00-00-000Z');
    fs.writeFileSync(fileNamed, 'arquivo, não pasta');
    for (const p of [completeOld, damagedOld, legacyOld, incompleteOld, brokenOld, withJunction, junctionTarget, otherName]) ageTree(p);

    const expected = [incompleteOld, brokenOld, withJunction].map((p) => path.basename(p)).sort();
    assert.deepEqual(findIncompleteBackups(dir).map((b) => b.name).sort(), expected, 'só os incompletos velhos são abandonados');
    const { removed, failed } = cleanupIncompleteBackups(dir);
    assert.deepEqual(removed.map((p) => path.basename(p)).sort(), expected);
    assert.deepEqual(failed, []);
    for (const p of [completeOld, damagedOld, legacyOld, incompleteRecent, otherName, fileNamed]) assert.ok(fs.existsSync(p), `intacto: ${path.basename(p)}`);
    assert.ok(fs.lstatSync(junctionFolder).isSymbolicLink() && fs.existsSync(path.join(junctionTarget, 'x.enc')), 'junção com nome de lote: nem ela nem o alvo foram tocados');
    assert.ok(fs.existsSync(path.join(precious, 'nao-apagar.txt')), 'a junção DENTRO do incompleto não foi seguida');
    assert.equal(inspectBackupFolder(completeOld).complete && inspectBackupFolder(legacyOld).complete, true, 'completos continuam completos');

    // o createMemoryBackup chama a limpeza no começo
    const planted = copyBackup(killedFolder, at('backup-2025-01-10T00-00-00-000Z'));
    ageTree(planted);
    const res = await createMemoryBackup({ dbDir: path.join(tmpRoot, 'interrompido', 'database'), backupDir: dir, key: testKey, maxKeep: 50 });
    assert.ok(!fs.existsSync(planted), 'o backup seguinte apagou, no começo, o incompleto abandonado');
    assert.ok(fs.existsSync(incompleteRecent) && fs.existsSync(completeOld), 'e só ele');
    assert.equal(inspectBackupFolder(res.folder).complete, true);
  });

  await t.test('falha no meio do backup apaga o próprio lote parcial (nada incompleto fica para trás)', async () => {
    const backupDir = path.join(tmpRoot, 'falha-no-meio');
    await assert.rejects(createMemoryBackup({
      dbDir: path.join(tmpRoot, 'interrompido', 'database'), backupDir, key: testKey,
      snapshotOptions: { protectDir: () => { throw new Error('ACL recusada'); } }, // falha no 2º arquivo (o banco WAL)
    }), /ACL recusada/);
    assert.deepEqual(fs.readdirSync(backupDir), [], 'o lote parcial (com o 1º .enc) foi apagado');
  });

  await t.test('alerta de falha é disparado se o backup falhar', async () => {
    let alertSent = null;
    configureAlerts({
      notify: async (ownerId, text) => {
        alertSent = { ownerId, text };
      },
      ownerId: '1234567890',
      env: { YUI_ALERTS: 'true' },
    });

    await assert.rejects(async () => {
      // Força falha passando diretório inexistente sem bancos
      await createMemoryBackup({
        dbDir: path.join(tmpRoot, 'diretorio_vazio'),
        backupDir: fakeBackupDir,
        key: testKey,
      });
    });

    assert(alertSent !== null, 'Deveria ter disparado alerta');
    assert(alertSent.text.includes('Falha no backup da memória'));
  });

  // Limpeza
  try {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  } catch {}
});

test('o processo auxiliar não tentou nenhuma integração externa (rede, DNS, UDP, programa fora da lista ou worker)', () => {
  BLOQUEIO.fechar('test:backup');
});
