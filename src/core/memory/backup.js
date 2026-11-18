import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { xchacha20poly1305 } from '@noble/ciphers/chacha.js';
import { alertOwner } from '../alerts.js';
import { logger } from '../../utils/logger.js';
import { config } from '../../config/index.js';
import { readDatabaseSnapshot, removeSqliteSidecars, cleanupStaleSnapshotDirs } from '../../database/snapshot.js';

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

// ── Conclusão do backup ─────────────────────────────────────────────────────────────────────────────────────────────
// Um lote `backup-<data>` só está CONCLUÍDO quando tem o manifesto íntegro. O manifesto é gravado por ÚLTIMO, de forma
// atômica (temporário + fsync + rename), depois de todos os arquivos cifrados já estarem no disco, e lista o SHA-256 de
// cada arquivo cifrado. Formato v2 do manifest.json.enc:
//   "YUI_MANIFEST_V2\n" + SHA-256 (hex) do conteúdo cifrado + "\n" + conteúdo cifrado (XChaCha20-Poly1305, como os bancos)
// O selo (o hash na 2ª linha) deixa conferir SEM a chave que o manifesto está inteiro: é o que a limpeza e o backup externo
// usam, e por isso uma troca de chave nunca faz um backup completo parecer incompleto. A conferência COM a chave (decifrar,
// SHA-256 de cada .enc e do conteúdo original) é a da restauração e da verificação.
// Backups antigos (v1: manifesto cifrado sem selo, gravado sem rename) continuam valendo e restaurando.
export const MANIFEST_NAME = 'manifest.json.enc';
const MANIFEST_V2_MAGIC = Buffer.from('YUI_MANIFEST_V2\n', 'utf8');
/** Nome das pastas de lote: `backup-` + toISOString() com ":" e "." trocados por "-". Só esses nomes são considerados. */
export const BACKUP_FOLDER_RE = /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/;
/** Idade a partir da qual um lote sem manifesto íntegro é considerado abandonado (nenhum backup leva tanto tempo). */
export const STALE_BACKUP_MAX_AGE_MS = 30 * 60 * 1000;
const MIN_ENCRYPTED_LEN = Buffer.byteLength(MAGIC_HEADER) + 32 + NONCE_LEN + 16;
const SAFE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const sha256Hex = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const looksEncrypted = (buf) => buf.length >= MIN_ENCRYPTED_LEN && buf.subarray(0, Buffer.byteLength(MAGIC_HEADER)).equals(Buffer.from(MAGIC_HEADER, 'utf8'));

/** Grava e força para o disco (fsync) antes de fechar. */
function writeFileDurable(file, data) {
  const fd = fs.openSync(file, 'w');
  try {
    for (let off = 0; off < data.length;) off += fs.writeSync(fd, data, off, data.length - off);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Grava o manifesto de forma atômica: temporário com fsync e rename. Quem lê vê o manifesto inteiro ou nenhum. */
function writeManifestAtomic(folder, data) {
  const finalPath = path.join(folder, MANIFEST_NAME);
  const tmpPath = `${finalPath}.${process.pid}.tmp`;
  try {
    writeFileDurable(tmpPath, data);
    fs.renameSync(tmpPath, finalPath);
  } finally {
    fs.rmSync(tmpPath, { force: true });
  }
  if (process.platform !== 'win32') {
    try { const fd = fs.openSync(folder, 'r'); try { fs.fsyncSync(fd); } finally { fs.closeSync(fd); } } catch { /* fsync de pasta é opcional */ }
  }
}

/**
 * Lê o envelope do manifesto SEM a chave: no v2 confere o selo SHA-256; no v1 (backups antigos) confere a estrutura.
 * @returns {{version: 1 | 2, encrypted: Buffer}} Lança erro com o motivo se o manifesto estiver ilegível ou corrompido.
 */
export function readManifestEnvelope(buf) {
  if (buf.subarray(0, MANIFEST_V2_MAGIC.length).equals(MANIFEST_V2_MAGIC)) {
    const hashEnd = MANIFEST_V2_MAGIC.length + 64;
    const declared = buf.subarray(MANIFEST_V2_MAGIC.length, hashEnd).toString('latin1');
    if (buf.length <= hashEnd || buf[hashEnd] !== 0x0a || !/^[0-9a-f]{64}$/.test(declared)) {
      throw new Error('cabeçalho do manifesto ilegível');
    }
    const encrypted = buf.subarray(hashEnd + 1);
    if (sha256Hex(encrypted) !== declared) throw new Error('o selo SHA-256 do manifesto não confere (manifesto corrompido ou truncado)');
    if (!looksEncrypted(encrypted)) throw new Error('conteúdo do manifesto ilegível');
    return { version: 2, encrypted };
  }
  if (looksEncrypted(buf)) return { version: 1, encrypted: buf };
  throw new Error('manifesto ilegível (formato desconhecido ou truncado)');
}

/** Atividade mais recente de uma pasta: a própria pasta e os arquivos de dentro (lstat, sem seguir link). */
function lastActivityMs(folder, st) {
  let newest = st.mtimeMs;
  try {
    for (const entry of fs.readdirSync(folder)) {
      try { newest = Math.max(newest, fs.lstatSync(path.join(folder, entry)).mtimeMs); } catch { /* sumiu agora */ }
    }
  } catch { /* pasta ilegível: fica a data dela */ }
  return newest;
}

/**
 * Situação de UMA pasta de lote, sem a chave: `complete` só quando o manifesto existe e está íntegro.
 * @returns {{name: string, path: string, isFolder: boolean, complete: boolean, reason: string | null, manifestVersion: 1 | 2 | null, lastActivityMs: number}}
 */
export function inspectBackupFolder(folder) {
  const info = { name: path.basename(folder), path: folder, isFolder: false, complete: false, reason: null, manifestVersion: null, lastActivityMs: 0 };
  let st;
  try {
    st = fs.lstatSync(folder);
  } catch (err) {
    info.reason = `pasta inacessível (${err.code || err.message})`;
    return info;
  }
  if (st.isSymbolicLink() || !st.isDirectory()) {
    info.reason = 'não é uma pasta comum (arquivo, link ou junção)';
    return info;
  }
  info.isFolder = true;
  info.lastActivityMs = lastActivityMs(folder, st);
  const manifestPath = path.join(folder, MANIFEST_NAME);
  let mst;
  try {
    mst = fs.lstatSync(manifestPath);
  } catch {
    info.reason = 'sem manifesto (o backup não chegou ao fim)';
    return info;
  }
  if (!mst.isFile()) {
    info.reason = 'o manifesto não é um arquivo comum';
    return info;
  }
  try {
    info.manifestVersion = readManifestEnvelope(fs.readFileSync(manifestPath)).version;
    info.complete = true;
  } catch (err) {
    info.reason = err.message;
  }
  return info;
}

/** Lotes `backup-<data>` de uma pasta de backups (só pastas comuns; link e junção ficam de fora), do mais antigo ao mais novo. */
export function listBackups(backupDir) {
  let names;
  try {
    names = fs.readdirSync(backupDir);
  } catch {
    return [];
  }
  return names
    .filter((n) => BACKUP_FOLDER_RE.test(n))
    .sort()
    .map((n) => inspectBackupFolder(path.join(backupDir, n)))
    .filter((b) => b.isFolder);
}

/** O backup COMPLETO mais recente (pelo nome, que é a data) e os incompletos mais novos que ele, que foram pulados. */
export function findLatestCompleteBackup(backupDir) {
  const all = listBackups(backupDir);
  const complete = all.filter((b) => b.complete);
  const latest = complete.length ? complete[complete.length - 1] : null;
  const skipped = all.filter((b) => !b.complete && (!latest || b.name > latest.name));
  return { latest, skipped };
}

/** Lotes sem manifesto íntegro parados há pelo menos `maxAgeMs` (um backup em andamento em outro processo fica de fora). */
export function findIncompleteBackups(backupDir, { maxAgeMs = STALE_BACKUP_MAX_AGE_MS, now = Date.now() } = {}) {
  return listBackups(backupDir).filter((b) => !b.complete && now - b.lastActivityMs >= maxAgeMs);
}

/**
 * Apaga os lotes abandonados de findIncompleteBackups. Só pastas comuns com nome `backup-<data>` e sem manifesto íntegro,
 * conferidas de novo logo antes de apagar; nunca um backup completo, nunca link ou junção (nem o que está do outro lado).
 * @returns {{removed: string[], failed: Array<{folder: string, error: string}>}}
 */
export function cleanupIncompleteBackups(backupDir, { maxAgeMs = STALE_BACKUP_MAX_AGE_MS, now = Date.now() } = {}) {
  const removed = [];
  const failed = [];
  for (const b of findIncompleteBackups(backupDir, { maxAgeMs, now })) {
    const again = inspectBackupFolder(b.path); // o manifesto pode ter acabado de chegar
    if (!again.isFolder || again.complete || now - again.lastActivityMs < maxAgeMs) continue;
    try {
      fs.rmSync(b.path, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      removed.push(b.path);
    } catch (err) {
      failed.push({ folder: b.path, error: err.code || err.message });
    }
  }
  return { removed, failed };
}

/** Confere a forma do manifesto decifrado (nomes sem caminho, hashes, v2 marcado como concluído). */
function validateManifest(manifest, version, where) {
  const bad = (why) => new Error(`Backup inválido: manifesto de ${where} ${why}.`);
  if (!manifest || !Array.isArray(manifest.files) || manifest.files.length === 0) throw bad('sem a lista de arquivos');
  if (version >= 2 && (manifest.version !== 2 || manifest.complete !== true)) throw bad('não marca o backup como concluído');
  const seen = new Set();
  for (const item of manifest.files) {
    if (!SAFE_NAME_RE.test(String(item?.name)) || item.encName !== `${item.name}.enc` || seen.has(item.name)) throw bad(`com nome de arquivo inválido (${String(item?.name).slice(0, 60)})`);
    seen.add(item.name);
    if (!/^[0-9a-f]{64}$/.test(String(item.sha256Original))) throw bad(`sem o SHA-256 de ${item.name}`);
    if (version >= 2 && (!/^[0-9a-f]{64}$/.test(String(item.sha256Encrypted)) || !Number.isInteger(item.sizeEncrypted))) {
      throw bad(`sem o SHA-256 do arquivo cifrado ${item.encName}`);
    }
  }
}

/**
 * Lê e decifra o manifesto de um lote, com a chave. Recusa lote sem manifesto, manifesto ilegível, com selo que não
 * confere, que não decifra ou que não marca o backup como concluído.
 */
export function readBackupManifest(backupFolder, key) {
  const where = path.basename(String(backupFolder));
  if (!backupFolder || !fs.existsSync(backupFolder)) throw new Error(`Pasta de backup não encontrada: ${backupFolder}`);
  const manifestPath = path.join(backupFolder, MANIFEST_NAME);
  if (!fs.existsSync(manifestPath)) {
    throw new Error(`Backup incompleto: ${where} não tem o manifesto (${MANIFEST_NAME}); o backup não chegou ao fim e não é usado.`);
  }
  let envelope;
  try {
    envelope = readManifestEnvelope(fs.readFileSync(manifestPath));
  } catch (err) {
    throw new Error(`Backup inválido: o manifesto de ${where} está ilegível (${err.message}).`);
  }
  let manifest;
  try {
    manifest = JSON.parse(decryptBackupBuffer(envelope.encrypted, key).data.toString('utf8'));
  } catch (err) {
    throw new Error(`Backup inválido: o manifesto de ${where} não pôde ser decifrado ou lido (${err.message}).`);
  }
  validateManifest(manifest, envelope.version, where);
  return { manifest, version: envelope.version };
}

/** Confere o lote inteiro com a chave (manifesto + cada arquivo cifrado e decifrado) e devolve os conteúdos. Não grava nada. */
function loadVerifiedBackup(backupFolder, key) {
  const where = path.basename(String(backupFolder));
  const { manifest, version } = readBackupManifest(backupFolder, key);
  const files = [];
  for (const item of manifest.files) {
    const encFilePath = path.join(backupFolder, item.encName);
    if (!fs.existsSync(encFilePath)) {
      throw new Error(`Backup inválido: ${item.encName} está no manifesto de ${where} mas não existe na pasta.`);
    }
    const encData = fs.readFileSync(encFilePath);
    if (version >= 2 && (encData.length !== item.sizeEncrypted || sha256Hex(encData) !== item.sha256Encrypted)) {
      throw new Error(`Backup inválido: ${item.encName} não confere com o manifesto de ${where} (tamanho ou SHA-256 do arquivo cifrado).`);
    }
    let decrypted;
    try {
      decrypted = decryptBackupBuffer(encData, key);
    } catch (err) {
      throw new Error(`Backup inválido: ${item.encName} não pôde ser decifrado (${err.message}).`);
    }
    if (decrypted.sha256 !== item.sha256Original) {
      throw new Error(`Hash verificado de ${item.name} (${decrypted.sha256}) difere do manifesto (${item.sha256Original}).`);
    }
    files.push({ item, data: decrypted.data, sha256: decrypted.sha256 });
  }
  return { manifest, version, files };
}

/**
 * Confere um lote de backup inteiro com a chave, sem restaurar nada (manifesto íntegro e concluído, cada arquivo cifrado
 * igual ao manifesto, cada conteúdo decifrado com o SHA-256 original). Lança erro claro se algo não conferir.
 * @param {{backupFolder: string, key?: string|Buffer|Uint8Array, keyFile?: string}} options
 */
export function verifyMemoryBackup(options = {}) {
  const key = resolveBackupKey(options);
  const { manifest, version, files } = loadVerifiedBackup(options.backupFolder, key);
  return { manifest, version, files: files.map((f) => ({ name: f.item.name, sha256: f.sha256, bytes: f.data.length })) };
}

/**
 * Executa o backup consistente e cifrado dos bancos de memória.
 * @param {object} options
 * @param {string} [options.dbDir] Diretório dos bancos originais (padrão: config.database.dir)
 * @param {string} [options.backupDir] Destino do backup (padrão: process.env.YUI_BACKUP_DIR ou ../yui-backups fora do repo)
 * @param {number} [options.maxKeep] Quantidade de backups retidos (padrão: 7)
 * @param {string} [options.dataDir] Pasta src/data: quando informada, DATA_FILES entram no backup (e os EXTRA_DATABASES sempre entram)
 * @param {string|Buffer|Uint8Array} [options.key] Chave de 32 bytes
 * @param {object} [options.snapshotOptions] Opções da cópia consistente dos bancos WAL (readDatabaseSnapshot): tmpDir e,
 *   só em testes, protectDir/afterSnapshot
 */
export async function createMemoryBackup(options = {}) {
  const dbDir = options.dbDir || path.resolve(config.database?.dir || 'database');
  const backupDir = options.backupDir || (process.env.YUI_BACKUP_DIR
    ? path.resolve(process.env.YUI_BACKUP_DIR)
    : path.resolve(process.cwd(), '../yui-backups'));
  const maxKeep = options.maxKeep || parseInt(process.env.YUI_BACKUP_MAX_KEEP || '7', 10) || 7;
  const snapshotOptions = options.snapshotOptions || {};

  // Sobras de um backup anterior interrompido (processo morto no meio da cópia de um banco WAL): pastas yui-snap-* com
  // cópia em claro que o finally não chegou a apagar. Só essas pastas, e só as paradas há mais de alguns minutos.
  try {
    const { removed, failed } = cleanupStaleSnapshotDirs({ tmpDir: snapshotOptions.tmpDir });
    if (removed.length) logger.warn(`[Backup] ${removed.length} pasta(s) temporária(s) abandonada(s) por um backup interrompido foram apagadas.`);
    if (failed.length) logger.warn(`[Backup] ${failed.length} pasta(s) temporária(s) abandonada(s) não puderam ser apagadas: ${failed.map((f) => `${path.basename(f.dir)} (${f.error})`).join(', ')}`);
  } catch (err) {
    logger.warn(`[Backup] Varredura de temporários abandonados falhou: ${err.message}`);
  }
  // Lotes `backup-<data>` sem manifesto íntegro deixados por um backup que morreu no meio (parados há mais de 30 min).
  try {
    const { removed, failed } = cleanupIncompleteBackups(backupDir);
    if (removed.length) logger.warn(`[Backup] ${removed.length} backup(s) incompleto(s) abandonado(s) foram apagados: ${removed.map((f) => path.basename(f)).join(', ')}`);
    if (failed.length) logger.warn(`[Backup] ${failed.length} backup(s) incompleto(s) não puderam ser apagados: ${failed.map((f) => `${path.basename(f.folder)} (${f.error})`).join(', ')}`);
  } catch (err) {
    logger.warn(`[Backup] Limpeza de backups incompletos falhou: ${err.message}`);
  }

  let backupBatchFolder = null;
  let completed = false;
  try {
    const key = resolveBackupKey(options);

    if (!fs.existsSync(backupDir)) {
      fs.mkdirSync(backupDir, { recursive: true });
    }

    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const manifest = {
      version: 2,
      complete: false, // vira true só no manifesto gravado no fim
      createdAt: new Date().toISOString(),
      files: [],
    };

    let backedUpCount = 0;
    const batchFolder = path.join(backupDir, `backup-${timestamp}`);
    fs.mkdirSync(batchFolder); // sem recursive: se o nome já existir, falha em vez de misturar dois lotes
    backupBatchFolder = batchFolder;

    const sources = [
      ...[...MEMORY_DATABASES, ...EXTRA_DATABASES].map((name) => ({ name, srcPath: path.join(dbDir, name) })),
      ...(options.dataDir ? DATA_FILES.map((name) => ({ name, srcPath: path.join(options.dataDir, name) })) : []),
    ];
    for (const { name: dbName, srcPath } of sources) {
      if (!fs.existsSync(srcPath)) {
        continue;
      }

      // Leitura consistente: arquivo clássico (sql.js) e JSON = os bytes, como sempre; banco no motor nativo (WAL) =
      // retrato consistente do .db + -wal pelo VACUUM INTO, conferido e no formato clássico (src/database/snapshot.js).
      const snapshot = await readDatabaseSnapshot(srcPath, snapshotOptions);
      const content = snapshot.data;
      const originalHash = snapshot.sha256;
      const encrypted = encryptBackupBuffer(content, key);

      const destFile = path.join(batchFolder, `${dbName}.enc`);
      writeFileDurable(destFile, encrypted); // no disco antes do manifesto que o declara

      manifest.files.push({
        name: dbName,
        encName: `${dbName}.enc`,
        sizeOriginal: content.length,
        sizeEncrypted: encrypted.length,
        sha256Original: originalHash,
        sha256Encrypted: sha256Hex(encrypted),
        mode: snapshot.mode, // 'copia' (bytes do arquivo) ou 'wal-snapshot' (cópia consistente de um banco WAL)
      });
      backedUpCount++;
    }

    if (backedUpCount === 0) {
      throw new Error(`Nenhum banco de memória encontrado em ${dbDir} para efetuar backup.`);
    }

    // Conclusão: o manifesto (com o SHA-256 de cada arquivo cifrado) é a ÚLTIMA coisa gravada, de forma atômica.
    manifest.complete = true;
    manifest.completedAt = new Date().toISOString();
    const manifestBuf = Buffer.from(JSON.stringify(manifest, null, 2), 'utf8');
    const encryptedManifest = encryptBackupBuffer(manifestBuf, key);
    writeManifestAtomic(batchFolder, Buffer.concat([
      MANIFEST_V2_MAGIC,
      Buffer.from(`${sha256Hex(encryptedManifest)}\n`, 'utf8'),
      encryptedManifest,
    ]));

    // Confere o lote recém-gravado com a chave, como a restauração fará: só então ele conta como concluído.
    loadVerifiedBackup(batchFolder, key);
    completed = true;

    // Rotação: manter os últimos maxKeep backups COMPLETOS (os incompletos têm a limpeza própria)
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
    // Lote que não chegou ao fim (ou não passou na conferência) não fica para trás confundindo uma restauração. Se não der
    // para apagar agora, a limpeza de incompletos do próximo backup recolhe.
    if (backupBatchFolder && !completed) {
      try {
        fs.rmSync(backupBatchFolder, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 });
      } catch (rmErr) {
        logger.warn(`[Backup] Não foi possível apagar o lote incompleto ${backupBatchFolder}: ${rmErr.message}`);
      }
    }
    logger.error(`[Backup] Falha ao realizar backup de memória: ${err.message}`);
    alertOwner('memory.backup.fail', 'Falha no backup da memória', `Ocorreu um erro ao executar o backup dos bancos de memória: ${err.message}`, { level: 'error' });
    throw err;
  }
}

/**
 * Remove os backups COMPLETOS mais antigos além de maxKeep (pela data no nome). Incompletos não contam aqui: nunca
 * empurram um completo para fora; quem os apaga é cleanupIncompleteBackups.
 */
function rotateBackups(backupDir, maxKeep) {
  try {
    const complete = listBackups(backupDir).filter((b) => b.complete).reverse(); // mais recentes primeiro
    for (const item of complete.slice(maxKeep)) {
      fs.rmSync(item.path, { recursive: true, force: true });
      logger.info(`[Backup] Rotação: backup antigo removido: ${item.name}`);
    }
  } catch (err) {
    logger.warn(`[Backup] Falha na rotação de backups antigos: ${err.message}`);
  }
}

/**
 * Restaura um lote de backup para um diretório alvo. O lote inteiro é conferido ANTES de gravar qualquer arquivo:
 * recusa lote sem manifesto (incompleto), manifesto ilegível ou corrompido, arquivo cifrado que não confere com o
 * manifesto e conteúdo decifrado com SHA-256 diferente.
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
  const { manifest, files } = loadVerifiedBackup(backupFolder, key);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  const restored = [];

  for (const { item, data: dbData, sha256 } of files) {
    // Grava num temporário e só depois troca: -wal/-shm/-journal velhos ao lado do destino são apagados ANTES de o banco
    // restaurado entrar no lugar (senão o SQLite reaplicaria um WAL antigo por cima dele). Se não der para apagar
    // (banco aberto), a restauração para e o arquivo de destino fica como estava.
    const targetFile = path.join(targetDir, item.name);
    const tmpFile = `${targetFile}.${process.pid}.tmp`;
    let sidecarsRemoved;
    try {
      fs.writeFileSync(tmpFile, dbData);
      sidecarsRemoved = removeSqliteSidecars(targetFile).length;
      fs.renameSync(tmpFile, targetFile);
    } finally {
      fs.rmSync(tmpFile, { force: true });
    }
    restored.push({ name: item.name, path: targetFile, sha256, sidecarsRemoved });
  }

  logger.info(`[Backup] Restauração concluída com sucesso em ${targetDir} (${restored.length} bancos).`);
  return {
    success: true,
    targetDir,
    restored,
    manifest,
  };
}
