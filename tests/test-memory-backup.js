import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import {
  createMemoryBackup,
  restoreMemoryBackup,
  encryptBackupBuffer,
  decryptBackupBuffer,
  resolveBackupKey,
  MEMORY_DATABASES,
} from '../src/core/memory/backup.js';
import { configureAlerts } from '../src/core/alerts.js';

test('Backup e Restauração Cifrada de Memória (R05)', async (t) => {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-backup-test-'));
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
