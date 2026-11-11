import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { alertOwner } from '../alerts.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';

const MAGIC_HEADER = 'YUI_BACKUP_V1';
const NONCE_LEN = 24; // XChaCha20 nonce size: 24 bytes

/**
 * Normaliza ou obtém a chave de 32 bytes para cifragem.
 * A chave NUNCA é colocada em log ou no repositório.
 * Pode ser passada explicitamente via options.key, pela variável de ambiente YUI_BACKUP_KEY
 * (como string hex de 64 caracteres ou base64 de 32 bytes) ou por arquivo de chave externo via YUI_BACKUP_KEY_FILE.
 */
export function resolveBackupKey(options = {}) {
  const direct = options.key || process.env.YUI_BACKUP_KEY;
  if (direct) {
    if (Buffer.isBuffer(direct) || direct instanceof Uint8Array) {
      if (direct.length === 32) return Uint8Array.from(direct);
    } else if (typeof direct === 'string') {
      const trimmed = direct.trim();
      if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
        return Uint8Array.from(Buffer.from(trimmed, 'hex'));
      }
      try {
        const b = Buffer.from(trimmed, 'base64');
        if (b.length === 32) return Uint8Array.from(b);
      } catch {
        // falha silenciosa de base64
      }
      // Se for uma passphrase arbitrária, deriva 32 bytes via SHA-256
      return Uint8Array.from(crypto.createHash('sha256').update(trimmed, 'utf8').digest());
    }
  }

  const keyFile = options.keyFile || process.env.YUI_BACKUP_KEY_FILE;
  if (keyFile && fs.existsSync(keyFile)) {
    const raw = fs.readFileSync(keyFile);
    if (raw.length === 32) return Uint8Array.from(raw);
    const trimmed = raw.toString('utf8').trim();
    if (/^[0-9a-fA-F]{64}$/.test(trimmed)) {
      return Uint8Array.from(Buffer.from(trimmed, 'hex'));
    }
    return Uint8Array.from(crypto.createHash('sha256').update(trimmed, 'utf8').digest());
  }

  throw new Error('Chave de backup não configurada. Defina YUI_BACKUP_KEY ou YUI_BACKUP_KEY_FILE fora do repositório.');
}

/**
 * Cifra um buffer com XChaCha20-Poly1305.
 * Formato do payload: MAGIC (13 bytes) + SHA256_PLAINTEXT (32 bytes) + NONCE (24 bytes) + CIPHERTEXT_WITH_TAG
 */
export function encryptBackupBuffer(plaintextBuffer, key) {
  const keyBytes = Uint8Array.from(key);
  if (keyBytes.length !== 32) {
    throw new Error('A chave de backup deve ter exatamente 32 bytes.');
  }

  const hash = crypto.createHash('sha256').update(plaintextBuffer).digest(); // 32 bytes
  const nonce = crypto.randomBytes(NONCE_LEN); // 24 bytes
  const cipher = xchacha20poly1305(keyBytes, Uint8Array.from(nonce));
  const ciphertext = cipher.encrypt(Uint8Array.from(plaintextBuffer));

  const magicBuf = Buffer.from(MAGIC_HEADER, 'utf8');
  return Buffer.concat([magicBuf, hash, nonce, Buffer.from(ciphertext)]);
}

/**
 * Decifra e valida a integridade do buffer cifrado.
 */
export function decryptBackupBuffer(encryptedBuffer, key) {
  const keyBytes = Uint8Array.from(key);
  if (keyBytes.length !== 32) {
    throw new Error('A chave de backup deve ter exatamente 32 bytes.');
  }

  const magicBuf = Buffer.from(MAGIC_HEADER, 'utf8');
  if (encryptedBuffer.length < magicBuf.length + 32 + NONCE_LEN) {
    throw new Error('Arquivo de backup inválido ou truncado.');
  }

  const magic = encryptedBuffer.subarray(0, magicBuf.length);
  if (!magic.equals(magicBuf)) {
    throw new Error('Cabeçalho de backup incompatível ou corrompido.');
  }

  let offset = magicBuf.length;
  const expectedHash = encryptedBuffer.subarray(offset, offset + 32);
  offset += 32;

  const nonce = encryptedBuffer.subarray(offset, offset + NONCE_LEN);
  offset += NONCE_LEN;

  const ciphertext = encryptedBuffer.subarray(offset);

  const cipher = xchacha20poly1305(keyBytes, Uint8Array.from(nonce));
  let decryptedBytes;
  try {
    decryptedBytes = cipher.decrypt(Uint8Array.from(ciphertext));
  } catch (err) {
    throw new Error(`Falha na autenticação/decifragem do backup (chave incorreta ou dado adulterado): ${err.message}`);
  }

  const decryptedBuf = Buffer.from(decryptedBytes);
  const actualHash = crypto.createHash('sha256').update(decryptedBuf).digest();

  if (!actualHash.equals(expectedHash)) {
    throw new Error('Integridade violada: o hash do conteúdo decifrado não confere com o original.');
  }

  return {
    data: decryptedBuf,
    sha256: actualHash.toString('hex'),
  };
}

/**
 * Lista dos bancos de memória que devem ser incluídos no backup.
 */
export const MEMORY_DATABASES = [
  'memory-personal.db',
  'memory-discord.db',
  'memory-context.db',
  'memory-context-personal.db',
];

/** Outros bancos que não se refazem sozinhos (seguidos do YouTube/Twitch e o core). Entram no backup junto com os de memória. */
export const EXTRA_DATABASES = ['core.db', 'social-youtube.db', 'social-twitch.db'];

/** Arquivos de configuração da Yui em src/data que se perderiam com o disco (bloqueios, termos aceitos, ajustes por servidor). Só entram com `dataDir`. */
export const DATA_FILES = ['bans.json', 'accepted_servers.json', 'server_settings.json', 'server_tools.json'];

/**
 * Executa o backup consistente e cifrado dos bancos de memória.
 * @param {object} options
 * @param {string} [options.dbDir] Diretório dos bancos originais (padrão: config.database.dir)
 * @param {string} [options.backupDir] Destino do backup (padrão: process.env.YUI_BACKUP_DIR ou ../yui-backups fora do repo)
 * @param {number} [options.maxKeep] Quantidade de backups retidos (padrão: 7)
 * @param {string} [options.dataDir] Pasta src/data: quando informada, DATA_FILES entram no backup (e os EXTRA_DATABASES sempre entram)
 * @param {string|Buffer|Uint8Array} [options.key] Chave de 32 bytes
 */
export async function createMemoryBackup(options = {}) {
  const dbDir = options.dbDir || path.resolve(config.database?.dir || 'database');
  const backupDir = options.backupDir || (process.env.YUI_BACKUP_DIR
    ? path.resolve(process.env.YUI_BACKUP_DIR)
    : path.resolve(process.cwd(), '../yui-backups'));
  const maxKeep = options.maxKeep || parseInt(process.env.YUI_BACKUP_MAX_KEEP || '7', 10) || 7;

  try {
    const key = resolveBackupKey(options);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const manifest = {
      version: 1,
      createdAt: new Date().toISOString(),
      files: [],
    };

    let backedUpCount = 0;
    const backupBatchFolder = path.join(backupDir, `backup-${timestamp}`);
    fs.mkdirSync(backupBatchFolder, { recursive: true });

    const sources = [
      ...[...MEMORY_DATABASES, ...EXTRA_DATABASES].map((name) => ({ name, srcPath: path.join(dbDir, name) })),
      ...(options.dataDir ? DATA_FILES.map((name) => ({ name, srcPath: path.join(options.dataDir, name) })) : []),
    ];
    for (const { name: dbName, srcPath } of sources) {
      if (!fs.existsSync(srcPath)) {
        continue;
      }

      // Leitura consistente do arquivo
      const content = fs.readFileSync(srcPath);
      const originalHash = crypto.createHash('sha256').update(content).digest('hex');
      const encrypted = encryptBackupBuffer(content, key);

      const destFile = path.join(backupBatchFolder, `${dbName}.enc`);
      fs.writeFileSync(destFile, encrypted);

      manifest.files.push({
        name: dbName,
        encName: `${dbName}.enc`,
        sizeOriginal: content.length,
        sizeEncrypted: encrypted.length,
        sha256Original: originalHash,
      });
      backedUpCount++;
    }

    if (backedUpCount === 0) {
      throw new Error(`Nenhum banco de memória encontrado em ${dbDir} para efetuar backup.`);
    }

    // Salva o manifesto cifrado do lote
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const encryptedManifest = encryptBackupBuffer(manifestBuf, key);
    fs.writeFileSync(path.join(backupBatchFolder, 'manifest.json.enc'), encryptedManifest);

    // Rotação: manter os últimos maxKeep backups
    rotateBackups(backupDir, maxKeep);

    logger.info(`[Backup] Backup de memória concluído com sucesso: ${backupBatchFolder} (${backedUpCount} bancos).`);
    return {
      success: true,
      folder: backupBatchFolder,
      timestamp,
      count: backedUpCount,
      manifest,
    };
  } catch (err) {
    logger.error(`[Backup] Falha ao realizar backup de memória: ${err.message}`);
    alertOwner('memory.backup.fail', 'Falha no backup da memória', `Ocorreu um erro ao executar o backup dos bancos de memória: ${err.message}`, { level: 'error' });
    throw err;
  }
}

/**
 * Remove backups antigos que excederem o limite maxKeep.
 */
function rotateBackups(backupDir, maxKeep) {
  try {
    const entries = fs.readdirSync(backupDir, { withFileTypes: true });
    const backupFolders = entries
      .filter((e) => e.isDirectory() && e.name.startsWith('backup-'))
      .map((e) => ({
        name: e.name,
        fullPath: path.join(backupDir, e.name),
        mtime: fs.statSync(path.join(backupDir, e.name)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime); // Mais recentes primeiro

    if (backupFolders.length > maxKeep) {
      const toDelete = backupFolders.slice(maxKeep);
      for (const item of toDelete) {
        fs.rmSync(item.fullPath, { recursive: true, force: true });
        logger.info(`[Backup] Rotação: backup antigo removido: ${item.name}`);
      }
    }
  } catch (err) {
    logger.warn(`[Backup] Falha na rotação de backups antigos: ${err.message}`);
  }
}

/**
 * Restaura um lote de backup para um diretório alvo, conferindo hash e decifrando tudo.
 * @param {object} options
 * @param {string} options.backupFolder Diretório específico do backup (ex: .../backup-2026-...)
 * @param {string} options.targetDir Diretório de destino limpo onde os arquivos .db serão restaurados
 * @param {string|Buffer|Uint8Array} [options.key] Chave de decifragem
 */
export async function restoreMemoryBackup(options = {}) {
  const { backupFolder, targetDir } = options;
  if (!backupFolder || !fs.existsSync(backupFolder)) {
    throw new Error(`Pasta de backup não encontrada: ${backupFolder}`);
  }
  if (!targetDir) {
    throw new Error('Diretório de destino (targetDir) não informado.');
  }

  const key = resolveBackupKey(options);

  const manifestEncPath = path.join(backupFolder, 'manifest.json.enc');
  if (!fs.existsSync(manifestEncPath)) {
    throw new Error('Manifesto do backup (manifest.json.enc) não encontrado.');
  }

  const manifestEncBuf = fs.readFileSync(manifestEncPath);
  const { data: manifestPlain } = decryptBackupBuffer(manifestEncBuf, key);
  const manifest = JSON.parse(manifestPlain.toString('utf8'));

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const restored = [];

  for (const item of manifest.files) {
    const encFilePath = path.join(backupFolder, item.encName);
    if (!fs.existsSync(encFilePath)) {
      throw new Error(`Arquivo cifrado ${item.encName} ausente no pacote de backup.`);
    }

    const encData = fs.readFileSync(encFilePath);
    const { data: dbData, sha256 } = decryptBackupBuffer(encData, key);

    if (sha256 !== item.sha256Original) {
      throw new Error(`Hash verificado de ${item.name} (${sha256}) difere do manifesto (${item.sha256Original}).`);
    }

    const targetFile = path.join(targetDir, item.name);
    fs.writeFileSync(targetFile, dbData);
    restored.push({ name: item.name, path: targetFile, sha256 });
  }

  logger.info(`[Backup] Restauração concluída com sucesso em ${targetDir} (${restored.length} bancos).`);
  return {
    success: true,
    targetDir,
    restored,
    manifest,
  };
}
