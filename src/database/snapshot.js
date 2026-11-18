// Cópia CONSISTENTE de um arquivo de banco para o backup (critério A do backup com o motor nativo).
//
// Dois formatos de arquivo convivem em database/ (ver src/database/db.js):
//  - clássico (sql.js, o padrão): o .db é regravado inteiro e trocado de forma atômica, então copiar os bytes já dá
//    uma cópia íntegra. Continua sendo feito assim, sem mudança nenhuma.
//  - WAL (motor nativo, YUI_DB_NATIVE): as escritas recentes ficam no <arquivo>-wal até o checkpoint; copiar só o .db
//    dá uma cópia velha ou inconsistente. Aqui a cópia sai de um `VACUUM INTO` feito pelo próprio SQLite, que lê o
//    .db + o -wal dentro de UMA transação de leitura (retrato consistente, nunca transação pela metade) e grava o
//    destino no formato clássico, que o sql.js lê. O destino é conferido (cabeçalho clássico + PRAGMA integrity_check)
//    antes de entrar no lugar.
//
// O node:sqlite só é carregado quando o arquivo é WAL (ele ainda avisa "experimental" no Node 24).
// Este módulo não importa o db.js de propósito: o db.js cria a pasta de bancos e carrega o sql.js ao ser importado, e o
// backup externo (scripts/backup-offsite.mjs) roda fora da Yui. A detecção de WAL abaixo segue a mesma regra do isWalFile.
//
// Cópia EM CLARO no disco (só a do banco WAL, que precisa de um arquivo para o VACUUM INTO): fica numa pasta temporária
// PRIVADA `yui-snap-XXXXXX` dentro de os.tmpdir(), protegida ANTES de receber qualquer byte (no Windows: sem herança e
// controle total só para o usuário atual, SYSTEM e Administradores, por SID; fora dele: chmod 700). Se a proteção falhar,
// nada é gravado. A pasta é apagada no finally; se o processo morrer no meio, cleanupStaleSnapshotDirs recolhe a sobra
// no começo do backup seguinte. As conexões usam temp_store=MEMORY: o SQLite não espalha pedaços do banco no TEMP.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';

const SQLITE_MAGIC = Buffer.from('SQLite format 3\0', 'latin1');

/** Prefixo das pastas temporárias privadas (o mkdtemp acrescenta 6 caracteres). Só pastas com este nome são varridas. */
export const SNAPSHOT_DIR_PREFIX = 'yui-snap-';
const SNAPSHOT_DIR_RE = /^yui-snap-[A-Za-z0-9]{6}$/;
/** Idade a partir da qual uma pasta yui-snap-* sem atividade é considerada sobra de um processo morto. */
export const STALE_SNAPSHOT_MAX_AGE_MS = 10 * 60 * 1000;

// SIDs fixos (o nome muda com o idioma do Windows: o notebook é pt-BR, "AUTORIDADE NT\SISTEMA", "Administradores").
export const SID_SYSTEM = 'S-1-5-18';
export const SID_ADMINISTRATORS = 'S-1-5-32-544';
const SDDL_ALIASES = { SY: SID_SYSTEM, BA: SID_ADMINISTRATORS };

/** Ferramenta do Windows pelo caminho completo em System32 (não pelo PATH, que poderia apontar para outra). */
function windowsTool(exe) {
  const candidate = path.join(process.env.SystemRoot || process.env.windir || 'C:\\Windows', 'System32', exe);
  return fs.existsSync(candidate) ? candidate : exe;
}
const toolOptions = { encoding: 'latin1', windowsHide: true, timeout: 20_000, stdio: ['ignore', 'pipe', 'pipe'] };
const toolError = (err) => String(err?.stderr || err?.stdout || err?.message || err).replace(/\s+/g, ' ').trim().slice(0, 200);

let cachedUserSid = null;
/** SID do usuário que roda o processo (`whoami /user /fo csv /nh`); como SYSTEM (produção) é S-1-5-18. */
export function currentUserSid() {
  if (cachedUserSid) return cachedUserSid;
  let out;
  try {
    out = execFileSync(windowsTool('whoami.exe'), ['/user', '/fo', 'csv', '/nh'], toolOptions);
  } catch (err) {
    throw new Error(`whoami falhou: ${toolError(err)}`);
  }
  const match = String(out).match(/"(S-1-\d+(?:-\d+)+)"/);
  if (!match) throw new Error(`não achei o SID do usuário na saída do whoami: ${String(out).trim().slice(0, 120)}`);
  cachedUserSid = match[1];
  return cachedUserSid;
}

/**
 * ACL de uma pasta no Windows, lida pelo `icacls /save` (formato SDDL, que traz SIDs e não nomes traduzidos).
 * @returns {{sddl: string, protected: boolean, aces: Array<{type: string, flags: string, rights: string, sid: string}>}}
 */
export function readWindowsAcl(target) {
  const tmpFile = path.join(os.tmpdir(), `yui-acl-${process.pid}-${crypto.randomBytes(4).toString('hex')}.sddl`);
  try {
    execFileSync(windowsTool('icacls.exe'), [target, '/save', tmpFile, '/q'], toolOptions);
    const sddl = fs.readFileSync(tmpFile).toString('utf16le').replace(/^\uFEFF/, '').split(/\r?\n/).find((l) => l.startsWith('D:')) || '';
    const head = sddl.match(/^D:([A-Z]*)/);
    const aces = [...sddl.matchAll(/\(([^;()]*);([^;()]*);([^;()]*);[^;()]*;[^;()]*;([^;()]*)\)/g)].map(([, type, flags, rights, sid]) => ({ type, flags, rights, sid: SDDL_ALIASES[sid] || sid }));
    return { sddl, protected: !!head && head[1].includes('P'), aces };
  } catch (err) {
    throw new Error(`não foi possível ler a ACL de ${target}: ${toolError(err)}`);
  } finally {
    try { fs.rmSync(tmpFile, { force: true }); } catch { /* arquivo de trabalho do icacls (sem dado do banco) */ }
  }
}

/**
 * Deixa a pasta acessível só ao dono do processo. No Windows: `icacls /inheritance:r /grant:r` com controle total (herdado
 * pelos arquivos de dentro) só para o usuário atual, SYSTEM e Administradores, e CONFERE lendo a ACL de volta (sem
 * herança, só esses SIDs, só permissão de concessão). Fora do Windows: chmod 700 conferido. Lança erro se não conseguir.
 */
export function restrictDirToOwner(dir) {
  if (process.platform !== 'win32') {
    fs.chmodSync(dir, 0o700);
    const mode = fs.statSync(dir).mode & 0o777;
    if (mode !== 0o700) throw new Error(`a pasta ficou com permissão ${mode.toString(8)} em vez de 700`);
    return;
  }
  const allowed = [...new Set([currentUserSid(), SID_SYSTEM, SID_ADMINISTRATORS])];
  try {
    execFileSync(windowsTool('icacls.exe'), [dir, '/inheritance:r', '/grant:r', ...allowed.map((sid) => `*${sid}:(OI)(CI)F`), '/q'], toolOptions);
  } catch (err) {
    throw new Error(`icacls falhou: ${toolError(err)}`);
  }
  const acl = readWindowsAcl(dir);
  const sids = new Set(acl.aces.map((a) => a.sid));
  const wrong = acl.aces.filter((a) => a.type !== 'A' || a.flags.includes('ID') || !allowed.includes(a.sid));
  if (!acl.protected || wrong.length || sids.size !== allowed.length) {
    throw new Error(`a ACL não ficou restrita (${acl.sddl || 'vazia'})`);
  }
}

/**
 * Cria a pasta temporária privada `yui-snap-XXXXXX` e a protege ANTES de qualquer gravação. Se a proteção falhar, apaga
 * a pasta (ainda vazia) e lança erro: a cópia em claro não é gravada.
 * @param {{tmpDir?: string, protectDir?: (dir: string) => void}} [options] protectDir troca a proteção (só em testes)
 */
export function createPrivateTempDir({ tmpDir = os.tmpdir(), protectDir = restrictDirToOwner } = {}) {
  const dir = fs.mkdtempSync(path.join(tmpDir, SNAPSHOT_DIR_PREFIX));
  try {
    protectDir(dir);
  } catch (err) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw new Error(`Não foi possível proteger a pasta temporária ${dir}; a cópia em claro NÃO foi gravada. ${err.message}`);
  }
  return dir;
}

/**
 * Recolhe pastas `yui-snap-XXXXXX` abandonadas por um processo que morreu no meio da cópia (o finally não rodou).
 * Só apaga PASTAS (nunca link nem junção) com exatamente esse nome, direto em `tmpDir`, cuja atividade mais recente
 * (a pasta e os arquivos de dentro) é mais velha que `maxAgeMs`: uma cópia em andamento em outro processo é preservada.
 * Nada mais no TEMP é tocado. Devolve o que apagou e o que não conseguiu apagar.
 */
export function cleanupStaleSnapshotDirs({ tmpDir = os.tmpdir(), maxAgeMs = STALE_SNAPSHOT_MAX_AGE_MS, now = Date.now() } = {}) {
  const removed = [];
  const failed = [];
  let names;
  try {
    names = fs.readdirSync(tmpDir);
  } catch {
    return { removed, failed };
  }
  for (const name of names) {
    if (!SNAPSHOT_DIR_RE.test(name)) continue;
    const dir = path.join(tmpDir, name);
    try {
      const st = fs.lstatSync(dir);
      if (!st.isDirectory() || st.isSymbolicLink()) continue;
      let newest = st.mtimeMs;
      for (const entry of fs.readdirSync(dir)) {
        try { newest = Math.max(newest, fs.lstatSync(path.join(dir, entry)).mtimeMs); } catch { /* sumiu agora */ }
      }
      if (now - newest < maxAgeMs) continue;
      fs.rmSync(dir, { recursive: true, force: true });
      removed.push(dir);
    } catch (err) {
      failed.push({ dir, error: err.code || err.message });
    }
  }
  return { removed, failed };
}

const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** Os primeiros 20 bytes do arquivo (onde ficam a assinatura do SQLite e os bytes 18 e 19), ou null se não der para ler. */
function readHeader(file) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const header = Buffer.alloc(20);
    const read = fs.readSync(fd, header, 0, 20, 0);
    return read === 20 ? header : null;
  } catch {
    return null;
  } finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* já fechado */ }
  }
}

/**
 * O arquivo está no formato do motor nativo (WAL)? Mesma regra do isWalFile do db.js: um <arquivo>-wal ao lado conta
 * (pode ter escritas que ainda não estão no .db); senão, os bytes 18 e 19 do cabeçalho SQLite (1 = clássico, 2 = WAL).
 * Aqui o cabeçalho só vale se o arquivo tiver a assinatura do SQLite (um JSON do backup nunca é tratado como banco).
 */
export function isWalDatabaseFile(file) {
  if (fs.existsSync(`${file}-wal`)) return true;
  const header = readHeader(file);
  return !!header && header.subarray(0, 16).equals(SQLITE_MAGIC) && (header[18] === 2 || header[19] === 2);
}

/** Cabeçalho SQLite no formato clássico (bytes 18 e 19 iguais a 1)? */
export function isClassicDatabaseFile(file) {
  const header = readHeader(file);
  return !!header && header.subarray(0, 16).equals(SQLITE_MAGIC) && header[18] === 1 && header[19] === 1;
}

/**
 * Apaga <arquivo>-wal, -shm e -journal ao lado de um banco que vai ser substituído. Sem isso o SQLite reaplicaria um
 * WAL (ou desfaria um diário) velho por cima do arquivo novo. Falha alta se não conseguir apagar (no Windows, sinal de
 * que o banco está aberto): nunca deixa um .db novo ao lado de um -wal antigo. Devolve os caminhos apagados.
 */
export function removeSqliteSidecars(dbPath) {
  const removed = [];
  for (const suffix of ['-wal', '-shm', '-journal']) {
    const file = `${dbPath}${suffix}`;
    try {
      fs.unlinkSync(file);
      removed.push(file);
    } catch (err) {
      if (err.code === 'ENOENT') continue;
      throw new Error(`Não foi possível apagar ${file} (${err.code || err.message}). O banco está aberto? Pare a Yui antes de restaurar por cima dele.`);
    }
  }
  return removed;
}

// Erros passageiros ao abrir ou ler um banco WAL que outro processo está usando: BUSY (5), LOCKED (6), IOERR (10, inclusive
// os estendidos, como o "disk I/O error" quando o -shm está sendo apagado ou recriado no instante da abertura),
// CANTOPEN (14) e PROTOCOL (15, disputa de trava do WAL). Vale tentar de novo depois de uma espera curta.
const TRANSIENT_CODES = new Set([5, 6, 10, 14, 15]);
const TRANSIENT_RE = /disk I\/O error|unable to open|database is locked|database table is locked|locking protocol|SQLITE_(BUSY|LOCKED|IOERR|CANTOPEN|PROTOCOL)/i;
export function isTransientSqliteError(err) {
  const code = Number(err?.errcode);
  if (Number.isInteger(code) && TRANSIENT_CODES.has(code & 0xff)) return true;
  return TRANSIENT_RE.test(String(err?.message ?? err));
}

function removeQuietly(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* sobra de tentativa anterior: a próxima tentativa ou o finally tira */ }
}

/**
 * `VACUUM INTO` da origem num arquivo novo, com novas tentativas para os erros passageiros.
 * A conexão abre no modo NORMAL (sem readOnly) de propósito: uma conexão somente leitura não consegue recriar o -shm e
 * dá "disk I/O error" quando o processo que escreve fecha (e apaga -wal e -shm) no instante da abertura; além disso ela
 * deixaria um -wal vazio e um -shm para trás. A conexão só LÊ: o VACUUM INTO não altera a origem. A única gravação
 * possível é a do próprio SQLite ao fechar a última conexão de um banco WAL: o checkpoint, que passa para o .db as
 * transações já confirmadas que estavam no -wal (o conteúdo lógico não muda) e apaga -wal e -shm. Com a Yui aberta
 * (o caso normal) esta conexão nunca é a última, então nada é gravado.
 */
async function vacuumInto(origem, tmp, { attempts = 8, baseDelayMs = 25, busyTimeoutMs = 5000 } = {}) {
  const { DatabaseSync } = await import('node:sqlite');
  let lastErr = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    removeQuietly(tmp); // o VACUUM INTO exige destino inexistente ou vazio
    removeQuietly(`${tmp}-journal`);
    let db = null;
    try {
      db = new DatabaseSync(origem, { timeout: busyTimeoutMs });
      db.exec('PRAGMA temp_store=MEMORY;'); // ordenações do VACUUM na memória, não em arquivos etilqs_* no TEMP
      // Parâmetro ligado: o caminho nunca entra no texto do SQL (aspas simples, barras do Windows e acentos passam sem escape).
      db.prepare('VACUUM INTO ?').run(tmp);
      return attempt;
    } catch (err) {
      lastErr = err;
    } finally {
      if (db) try { db.close(); } catch { /* a cópia é conferida à parte; fechar com erro não a invalida */ }
    }
    // Espera com a conexão já fechada (não segura -wal/-shm de ninguém enquanto espera).
    if (!isTransientSqliteError(lastErr) || attempt === attempts) break;
    await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), 1000));
  }
  const tries = lastErr && isTransientSqliteError(lastErr) ? ` depois de ${attempts} tentativa(s)` : '';
  throw new Error(`Falha ao gerar a cópia consistente de ${origem}${tries}: ${lastErr?.message ?? lastErr}`);
}

/** Confere a cópia gerada: formato clássico (bytes 18 e 19 = 1) e PRAGMA integrity_check = ok. Falha alta se não. */
async function verifySnapshot(file) {
  if (!isClassicDatabaseFile(file)) {
    throw new Error(`A cópia ${file} não saiu no formato clássico (bytes 18 e 19 do cabeçalho diferentes de 1).`);
  }
  const { DatabaseSync } = await import('node:sqlite');
  // Arquivo clássico aberto só para leitura: não cria -wal, -shm nem -journal.
  const db = new DatabaseSync(file, { readOnly: true });
  let result;
  try {
    db.exec('PRAGMA temp_store=MEMORY;');
    result = db.prepare('PRAGMA integrity_check').all().map((row) => Object.values(row)[0]);
  } finally {
    db.close();
  }
  if (result.length !== 1 || result[0] !== 'ok') {
    throw new Error(`A cópia ${file} não passou no integrity_check: ${result.slice(0, 3).join('; ')}`);
  }
}

/**
 * Copia o banco `origem` para `destino` de forma consistente. Nunca grava na origem (a única exceção é o checkpoint que
 * o próprio SQLite faz ao fechar a última conexão de um banco WAL; ver vacuumInto).
 *  - arquivo clássico (ou qualquer arquivo que não seja banco WAL, como os JSON do backup): copia os bytes, como sempre;
 *  - arquivo WAL: `VACUUM INTO` num temporário ao lado do destino, confere formato clássico + integrity_check e só então
 *    põe no lugar (rename). -wal/-shm/-journal velhos ao lado do destino são apagados antes.
 * @param {string} origem
 * @param {string} destino
 * @param {{attempts?: number, baseDelayMs?: number, busyTimeoutMs?: number}} [options] novas tentativas do modo WAL
 * @returns {Promise<{path: string, bytes: number, sha256: string, mode: 'copia' | 'wal-snapshot', attempts?: number}>}
 */
export async function snapshotDatabaseFile(origem, destino, options = {}) {
  const src = path.resolve(origem);
  const dest = path.resolve(destino);
  if (src === dest) throw new Error('A origem e o destino da cópia são o mesmo arquivo.');
  if (!fs.existsSync(src)) throw new Error(`Arquivo de origem não encontrado: ${src}`);
  fs.mkdirSync(path.dirname(dest), { recursive: true });

  // Mesmo padrão de nome dos temporários do db.js (`core.db.1234.tmp`), que ele limpa se sobrar de um processo morto.
  const tmp = `${dest}.${process.pid}.tmp`;
  try {
    if (!isWalDatabaseFile(src)) {
      const data = fs.readFileSync(src);
      fs.writeFileSync(tmp, data);
      removeSqliteSidecars(dest);
      fs.renameSync(tmp, dest);
      return { path: dest, bytes: data.length, sha256: sha256(data), mode: 'copia' };
    }
    const attempts = await vacuumInto(src, tmp, options);
    await verifySnapshot(tmp);
    removeSqliteSidecars(dest);
    fs.renameSync(tmp, dest);
    const data = fs.readFileSync(dest);
    return { path: dest, bytes: data.length, sha256: sha256(data), mode: 'wal-snapshot', attempts };
  } finally {
    removeQuietly(tmp);
    removeQuietly(`${tmp}-journal`);
  }
}

/**
 * Lê o conteúdo consistente de um arquivo para o backup, sem deixar cópia em claro no disco.
 *  - clássico: lê os bytes direto da origem (exatamente o que o backup sempre fez); nada é gravado em lugar nenhum;
 *  - WAL: gera a cópia consistente na pasta temporária PRIVADA `yui-snap-XXXXXX` (protegida antes de qualquer gravação;
 *    nunca na pasta do backup, que no backup externo é um clone git), lê e apaga a pasta, com sucesso ou com erro.
 * @param {string} origem
 * @param {{tmpDir?: string, protectDir?: (dir: string) => void, afterSnapshot?: (file: string) => void}} [options]
 *   tmpDir: onde criar a pasta (padrão os.tmpdir()); protectDir e afterSnapshot (chamado com a cópia em claro já gravada,
 *   antes de ler e apagar) existem para os testes de falha da ACL e de queda no meio da cópia.
 * @returns {Promise<{data: Buffer, bytes: number, sha256: string, mode: 'copia' | 'wal-snapshot', attempts?: number}>}
 */
export async function readDatabaseSnapshot(origem, options = {}) {
  if (!isWalDatabaseFile(origem)) {
    const data = fs.readFileSync(origem);
    return { data, bytes: data.length, sha256: sha256(data), mode: 'copia' };
  }
  const dir = createPrivateTempDir({ tmpDir: options.tmpDir, protectDir: options.protectDir });
  let result = null;
  let failure = null;
  try {
    const snap = await snapshotDatabaseFile(origem, path.join(dir, path.basename(origem)), options);
    options.afterSnapshot?.(snap.path);
    const data = fs.readFileSync(snap.path);
    const hash = sha256(data);
    if (hash !== snap.sha256) throw new Error(`A cópia consistente de ${origem} mudou entre a gravação e a leitura.`);
    result = { data, bytes: data.length, sha256: hash, mode: snap.mode, attempts: snap.attempts };
  } catch (err) {
    failure = err;
  }
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  } catch (err) {
    // Não esconde o erro original; se a cópia deu certo, falha mesmo assim: sobrou cópia em claro (a varredura recolhe).
    failure ||= new Error(`Não foi possível apagar a cópia em claro em ${dir} (${err.code || err.message}); cleanupStaleSnapshotDirs recolhe depois.`);
  }
  if (failure) throw failure;
  return result;
}
