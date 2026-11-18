import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import os from 'os';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { acquireOwnerLock, defaultQueryProcess, ownerLockStats, OWNER_HELD } from './ownerLock.js';
import { databaseOwner, ownerLockTiming, ownerRoleFromEnv, ownershipError } from './owners.js';

const databaseDir = path.resolve(config.database.dir);

if (!fs.existsSync(databaseDir)) {
  fs.mkdirSync(databaseDir, { recursive: true });
}

// Cada entrada: { db, path, inTransaction: bool, engine: 'sqljs' | 'native', stmts?: Map, ownerLock?: trava de dono (YUI_DB_OWNER_ROLE) }
//   sqljs  -> db é a instância do sql.js (banco na memória, o arquivo é regravado inteiro a cada escrita)
//   native -> db é um DatabaseSync do node:sqlite (arquivo de verdade, WAL, escrita incremental)
const instances = new Map();
/** Aberturas em andamento (nome -> promessa): chamadas simultâneas ao initDatabase do mesmo banco esperam a mesma. */
const opening = new Map();
let SQL = null;

// ── Motor nativo (etapa 2 do cérebro único: docs/ANALISE_COMPARATIVA_CEREBRO_YUI.md §6.1) ──
// YUI_DB_NATIVE lista os bancos que abrem no node:sqlite com WAL (ex.: "newswire" ou "newswire,core"; "*" = todos).
// Vazio (o padrão) = todos no sql.js, como sempre. O banco migra por nome, um de cada vez; a volta é o
// scripts/banco-nativo.mjs reverter (checkpoint + journal_mode=DELETE), que devolve o arquivo ao formato que o sql.js lê.
export function nativeDatabaseNames(env = process.env) {
  return new Set(String(env.YUI_DB_NATIVE || '').split(',').map((s) => s.trim()).filter(Boolean));
}
function isNative(name) {
  const set = nativeDatabaseNames();
  return set.has('*') || set.has(name);
}

/**
 * O arquivo está no formato do motor nativo (WAL)? Bytes 18 e 19 do cabeçalho SQLite: 1 = diário clássico, 2 = WAL.
 * Um -wal ao lado também conta: ele pode ter escritas que ainda não estão no .db.
 */
export function isWalFile(dbPath, fsImpl = fs) {
  try {
    if (fsImpl.existsSync(`${dbPath}-wal`)) return true;
    const fd = fsImpl.openSync(dbPath, 'r');
    try {
      const header = Buffer.alloc(20);
      const read = fsImpl.readSync(fd, header, 0, 20, 0);
      return read === 20 && (header[18] === 2 || header[19] === 2);
    } finally {
      fsImpl.closeSync(fd);
    }
  } catch {
    return false;
  }
}

// O node:sqlite só é carregado quando um banco nativo é pedido (ele ainda avisa "experimental" no Node 24).
let nodeSqlite = null;
async function loadNodeSqlite() {
  if (!nodeSqlite) nodeSqlite = await import('node:sqlite');
  return nodeSqlite;
}

// No Windows, abrir um banco WAL no instante em que OUTRO processo (o último a fechar) apaga o -wal e o -shm pode dar
// "disk I/O error" ou "unable to open". É passageiro: tenta de novo com espera curta (25, 50, 100, 200, 400 ms).
const OPEN_RETRY_RE = /disk I.O error|unable to open database|database is locked|SQLITE_IOERR|SQLITE_BUSY|SQLITE_CANTOPEN/i;
const OPEN_RETRY_WAITS_MS = [25, 50, 100, 200, 400];

async function openNative(name, dbPath, schemaSql) {
  const { DatabaseSync } = await loadNodeSqlite();
  const existed = fs.existsSync(dbPath);
  let db;
  for (let attempt = 0; ; attempt++) {
    db = null;
    try {
      db = new DatabaseSync(dbPath);
      db.exec('PRAGMA busy_timeout=5000;'); // outro processo escrevendo: espera até 5 s em vez de falhar na hora
      db.exec('PRAGMA journal_mode=WAL;');
      db.exec('PRAGMA synchronous=NORMAL;'); // com WAL: sobrevive à morte do processo; só uma queda de energia pode perder a última transação
      if (schemaSql) db.exec(schemaSql);
      break;
    } catch (err) {
      try { db?.close(); } catch { /* já fechado */ }
      if (attempt < OPEN_RETRY_WAITS_MS.length && OPEN_RETRY_RE.test(String(err?.message ?? err))) {
        statsOf(name).openRetries += 1;
        await new Promise((r) => setTimeout(r, OPEN_RETRY_WAITS_MS[attempt]));
        continue;
      }
      throw err;
    }
  }
  instances.set(name, { db, path: dbPath, inTransaction: false, engine: 'native', stmts: new Map() });
  logger.info(`[Database] "${name}" — ${existed ? 'carregado' : 'novo banco criado'} no motor nativo (node:sqlite, WAL): ${dbPath}`);
  return db;
}

// Parâmetros no motor nativo com o MESMO efeito do sql.js: booleano vira 0/1 (o node:sqlite recusa booleano) e inteiro de
// 32 bits vai como inteiro (o node:sqlite manda todo número como REAL, e uma coluna TEXT receberia "5.0" em vez de "5").
// Número fora de 32 bits continua REAL, como no sql.js. undefined continua dando erro nos dois.
function nativeParam(value) {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (typeof value === 'number' && Number.isInteger(value) && value >= -2147483648 && value <= 2147483647) return BigInt(value);
  return value;
}
function nativeNamed(obj) {
  const out = {};
  for (const [k, v] of Object.entries(obj)) out[k] = nativeParam(v);
  return out;
}
function nativeStatement(entry, sql) {
  let stmt = entry.stmts.get(sql);
  if (!stmt) {
    stmt = entry.db.prepare(sql);
    entry.stmts.set(sql, stmt);
  }
  return stmt;
}
const isNamedParams = (params) => params.length === 1 && params[0] !== null && typeof params[0] === 'object'
  && !Array.isArray(params[0]) && !(params[0] instanceof Uint8Array);

// ── Observabilidade (critério E da Liz): por banco, contagens e tempos de leitura e gravação, bloqueios e erros.
// Nunca guarda SQL nem parâmetros (podem ter texto pessoal): só o código e um trecho curto da mensagem do erro.
const opStats = new Map();
function statsOf(name) {
  let st = opStats.get(name);
  if (!st) {
    st = { reads: 0, writes: 0, readMs: 0, writeMs: 0, maxWriteMs: 0, busy: 0, errors: 0, lastError: null, openFailures: 0, openRetries: 0, ownerLost: 0 };
    opStats.set(name, st);
  }
  return st;
}
const BUSY_RE = /database is locked|database table is locked|SQLITE_BUSY|SQLITE_LOCKED/i;
function track(name, kind, fn) {
  const st = statsOf(name);
  const t0 = performance.now();
  try {
    return fn();
  } catch (err) {
    st.errors += 1;
    if (BUSY_RE.test(String(err?.message ?? err)) || err?.errcode === 5 || err?.errcode === 6) st.busy += 1;
    st.lastError = { at: new Date().toISOString(), code: err?.code ?? null, message: String(err?.message ?? err).slice(0, 120) };
    throw err;
  } finally {
    const ms = performance.now() - t0;
    if (kind === 'write') {
      st.writes += 1;
      st.writeMs += ms;
      if (ms > st.maxWriteMs) st.maxWriteMs = ms;
    } else {
      st.reads += 1;
      st.readMs += ms;
    }
  }
}
const fileSize = (p) => { try { return fs.statSync(p).size; } catch { return 0; } };

/**
 * Situação de cada banco aberto, para o relatório de saúde: motor, tamanho do .db, do -wal e do -shm, ponto de
 * checkpoint automático (nativo), contagens e tempos médios de leitura e gravação, maior gravação, bloqueios e erros.
 */
export function databaseStats() {
  const round = (n) => Math.round(n * 100) / 100;
  // Abertos + os que falharam ao abrir ou perderam a trava de dono (estes não estão em `instances`, mas o relatório precisa deles).
  const names = new Set([...instances.keys(), ...[...opStats.entries()].filter(([, st]) => st.openFailures > 0 || st.ownerLost > 0).map(([n]) => n)]);
  return [...names].map((name) => {
    const entry = instances.get(name) ?? { engine: null, path: path.join(databaseDir, `${name}.db`), db: null };
    const st = statsOf(name);
    let walAutocheckpoint = null;
    if (entry.engine === 'native') {
      try { walAutocheckpoint = Number(entry.db.prepare('PRAGMA wal_autocheckpoint').get().wal_autocheckpoint); } catch { /* fechado */ }
    }
    return {
      name,
      engine: entry.engine, // null = não está aberto (falhou ao abrir)
      open: instances.has(name),
      sizes: { db: fileSize(entry.path), wal: fileSize(`${entry.path}-wal`), shm: fileSize(`${entry.path}-shm`) },
      walAutocheckpoint,
      reads: st.reads,
      writes: st.writes,
      avgReadMs: st.reads ? round(st.readMs / st.reads) : 0,
      avgWriteMs: st.writes ? round(st.writeMs / st.writes) : 0,
      maxWriteMs: round(st.maxWriteMs),
      busy: st.busy,
      errors: st.errors,
      lastError: st.lastError,
      openFailures: st.openFailures,
      openRetries: st.openRetries,
      // Dono do banco (src/database/owners.js) e a trava deste processo (só com YUI_DB_OWNER_ROLE; null no processo único).
      owner: databaseOwner(name),
      ownerLock: entry.ownerLock ? { role: entry.ownerLock.record?.role ?? null, held: entry.ownerLock.held, takeover: entry.ownerLock.takeover } : null,
      ownerLost: st.ownerLost,
    };
  });
}

// ── Dono de cada banco (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §3; mapa em src/database/owners.js) ──
// Só com YUI_DB_OWNER_ROLE definido (cerebro ou bot). Sem ela (o processo único de hoje) nada disto roda.
const ownerCounters = { notOwner: 0, waitedForDeadOwner: 0, lost: 0 };

/** O registro da trava é de um processo DESTE computador que não existe mais? (sinal 0: só pergunta, nunca encerra nada) */
function ownerIsDead(owner) {
  if (!owner || !Number.isInteger(owner.pid) || owner.pid === process.pid) return false;
  if (owner.hostname && owner.hostname !== os.hostname()) return false;
  try { return defaultQueryProcess(owner.pid).alive === false; } catch { return false; }
}

/** A trava sumiu ou passou a ter outro dono: fecha o banco SEM gravar (dois processos escrevendo no mesmo arquivo perdem dados). */
function onOwnerLockLost(name, info) {
  ownerCounters.lost += 1;
  const st = statsOf(name);
  st.ownerLost += 1;
  st.lastError = { at: new Date().toISOString(), code: 'YUI_DB_OWNER_LOST', message: String(info?.reason ?? 'trava perdida').slice(0, 120) };
  logger.error(`[Database] "${name}": a trava de dono foi PERDIDA (${info?.reason ?? '?'}). O banco foi fechado sem gravar, para não haver dois processos escrevendo no mesmo arquivo; reinicie este processo.`);
  const entry = instances.get(name);
  if (!entry) return;
  instances.delete(name);
  try { entry.db.close(); } catch { /* já fechado */ }
}

/**
 * Com YUI_DB_OWNER_ROLE: recusa o banco de outro papel (YUI_DB_NOT_OWNER) e pega a trava de dono antes de abrir.
 * Trava de um processo deste computador que JÁ MORREU (queda, kill) com batimento ainda recente: espera o prazo de abandono
 * (até staleMs + um batimento) e tenta uma vez mais, em vez de recusar a subida logo depois de uma queda. Dono vivo = recusa.
 * @returns {Promise<ReturnType<typeof acquireOwnerLock>|null>} null sem a chave (processo único)
 */
async function acquireOwnership(name, dbPath) {
  const role = ownerRoleFromEnv();
  if (!role) return null;
  const refusal = ownershipError(name, role);
  if (refusal) {
    ownerCounters.notOwner += 1;
    recordOpenFailure(name, refusal);
    logger.error(`[Database] ${refusal.message}`);
    throw refusal;
  }
  const timing = ownerLockTiming();
  const options = { role, ...timing, onLost: (info) => onOwnerLockLost(name, info) };
  try {
    return acquireOwnerLock(dbPath, options);
  } catch (err) {
    if (err?.code !== OWNER_HELD || !ownerIsDead(err.owner)) {
      recordOpenFailure(name, err);
      throw err;
    }
    const waitMs = Math.max(0, timing.staleMs - (Number(err.heartbeatAgeMs) || 0)) + timing.heartbeatMs;
    ownerCounters.waitedForDeadOwner += 1;
    logger.warn(`[Database] "${name}": a trava é de um processo que não existe mais (PID ${err.owner.pid}); aguardando ${Math.round(waitMs / 1000)} s para retomá-la.`);
    await new Promise((r) => setTimeout(r, waitMs));
    try {
      return acquireOwnerLock(dbPath, options);
    } catch (again) {
      recordOpenFailure(name, again);
      throw again;
    }
  }
}

/**
 * Papel deste processo e conflitos de dono desde a subida (para o relatório de saúde): recusas por banco de outro papel,
 * as contagens da trava (posses, recusas, retomadas, travas presas, perdidas) e o último conflito.
 */
export function databaseOwnerStats() {
  let role = null;
  try { role = ownerRoleFromEnv(); } catch { role = 'inválido'; }
  return {
    role,
    ...ownerCounters,
    lock: ownerLockStats(),
    held: [...instances.entries()].filter(([, e]) => e.ownerLock).map(([name, e]) => ({ name, held: e.ownerLock.held })),
  };
}

/** Abertura ou recuperação que falhou (arquivo corrompido, WAL ilegível, trava do motor): conta para o relatório de saúde. */
function recordOpenFailure(name, err) {
  const st = statsOf(name);
  st.openFailures += 1;
  st.lastError = { at: new Date().toISOString(), code: err?.code ?? 'open', message: String(err?.message ?? err).slice(0, 120) };
}

/**
 * Fecha TODOS os bancos abertos (no nativo, com checkpoint do WAL; no sql.js, gravando antes). Serve para um desligamento
 * limpo e para quem precisa apagar a pasta dos bancos: no Windows um arquivo do motor nativo aberto não pode ser apagado.
 * @returns {number} quantos bancos foram fechados
 */
export function closeAllDatabases() {
  let closed = 0;
  for (const name of [...instances.keys()]) if (closeDatabase(name)) closed += 1;
  return closed;
}

/** Motor de um banco já aberto: 'sqljs', 'native' ou null (não aberto). */
export function getDatabaseEngine(name) {
  return instances.get(name)?.engine ?? null;
}

/**
 * Fecha um banco aberto (para trocar de motor, mover ou pôr o arquivo em quarentena sem o Windows recusar o rename).
 * No sql.js grava antes de fechar; no nativo faz o checkpoint do WAL. Devolve false se o banco não estava aberto.
 */
export function closeDatabase(name) {
  const entry = instances.get(name);
  if (!entry) return false;
  if (entry.engine === 'native') {
    try { entry.db.exec('PRAGMA wal_checkpoint(TRUNCATE);'); } catch (err) { logger.warn(`[Database] "${name}" — checkpoint ao fechar falhou: ${err.message}`); }
  } else {
    saveDatabase(name);
  }
  try { entry.db.close(); } catch { /* já fechado */ }
  instances.delete(name);
  // Só depois de gravar e fechar: solta a trava de dono (apaga o .owner se ainda for nosso).
  if (entry.ownerLock) {
    try { entry.ownerLock.release(); } catch { /* a trava sai sozinha na saída do processo */ }
  }
  return true;
}

async function getSqlJs() {
  if (!SQL) {
    SQL = await initSqlJs();
  }
  return SQL;
}

/**
 * Inicializa (ou retorna, se já inicializado) um banco de dados nomeado.
 * Cada domínio de dados vive no seu próprio arquivo .db dentro de
 * `database/`, permitindo separar GTA Online de futuros jogos sem
 * misturar tabelas:
 *
 *   database/core.db         -> guild_settings, published_messages
 *   database/newswire.db     -> news_articles
 *   database/gta-diario.db   -> daily_resets
 *   database/gta-semanal.db  -> weekly_events
 *
 * Com YUI_DB_OWNER_ROLE (cérebro e bot em processos separados): só abre os bancos do próprio papel, e pega a trava de dono
 * antes (src/database/owners.js). Sem a variável, nada muda.
 *
 * @param {string} name Nome lógico do banco (também usado como nome do arquivo: {name}.db)
 * @param {string} schemaSql SQL de criação de tabelas/índices deste domínio (idempotente, usa IF NOT EXISTS)
 */
export async function initDatabase(name, schemaSql) {
  if (instances.has(name)) {
    return instances.get(name).db;
  }
  // Duas chamadas ao mesmo tempo para o mesmo banco esperam a MESMA abertura (nunca dois objetos para um arquivo).
  if (opening.has(name)) return opening.get(name);
  const pending = openNamed(name, schemaSql).finally(() => opening.delete(name));
  opening.set(name, pending);
  return pending;
}

async function openNamed(name, schemaSql) {
  if (!staleTempsChecked) {
    staleTempsChecked = true;
    cleanStaleTempFiles(); // sobras de uma gravação interrompida por processo morto (TG-20)
  }

  const dbPath = path.join(databaseDir, `${name}.db`);
  const ownerLock = await acquireOwnership(name, dbPath);
  try {
    const db = await openFile(name, dbPath, schemaSql);
    const entry = instances.get(name);
    if (ownerLock && entry) entry.ownerLock = ownerLock;
    return db;
  } catch (err) {
    // Aberto mas o esquema falhou: o banco continua registrado (como sempre foi) e fica com a trava. Não abriu: solta.
    const entry = instances.get(name);
    if (ownerLock && entry) entry.ownerLock = ownerLock;
    else if (ownerLock) {
      try { ownerLock.release(); } catch { /* sai sozinha na saída do processo */ }
    }
    throw err;
  }
}

async function openFile(name, dbPath, schemaSql) {
  if (isNative(name)) {
    try {
      return await openNative(name, dbPath, schemaSql);
    } catch (err) {
      recordOpenFailure(name, err);
      throw err;
    }
  }

  // O sql.js NUNCA abre um arquivo do motor nativo: leria só o .db (sem o que está no -wal) e, na próxima gravação,
  // regravaria o arquivo inteiro por cima, perdendo dados. Volte o banco antes com `node scripts/banco-nativo.mjs reverter`.
  if (fs.existsSync(dbPath) && isWalFile(dbPath)) {
    recordOpenFailure(name, { code: 'wal-no-sqljs', message: 'banco no formato do motor nativo aberto pelo sql.js' });
    const err = new Error(`Database "${name}" está no formato do motor nativo (WAL). Inclua "${name}" em YUI_DB_NATIVE ou reverta com: node scripts/banco-nativo.mjs reverter "${dbPath}"`);
    err.code = 'YUI_DB_WAL_NO_SQLJS'; // banco VÁLIDO no formato novo: quem chama nunca deve tratá-lo como corrompido
    throw err;
  }

  const sql = await getSqlJs();
  let db;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new sql.Database(fileBuffer);
    logger.info(`[Database] "${name}" carregado de: ${dbPath}`);
  } else {
    db = new sql.Database();
    logger.info(`[Database] "${name}" — novo banco criado em: ${dbPath}`);
  }

  instances.set(name, { db, path: dbPath, inTransaction: false, engine: 'sqljs' });

  if (schemaSql) {
    db.run(schemaSql);
    saveDatabase(name);
    logger.info(`[Database] "${name}" — esquema verificado e salvo com sucesso.`);
  }

  return db;
}

// ── Gravação atômica (TG-20) ──────────────────────────────────────────────
// O sql.js mantém o banco na memória e reescreve o arquivo INTEIRO a cada
// escrita. Gravar direto em cima do .db deixava uma janela (cresce com o
// tamanho do banco) em que um processo morto (reinício pelo supervisor, queda
// de energia, disco cheio) deixava o arquivo truncado, e um .db truncado
// derruba o bootstrap em laço. Agora o conteúdo vai para um arquivo temporário
// NA MESMA PASTA (mesmo volume) e só então é renomeado sobre o .db: o rename
// troca o arquivo de uma vez, então quem lê (ou quem sobe depois de uma morte)
// vê o estado antigo completo ou o novo completo, nunca um pedaço.
//   - O nome do temporário leva o PID (`core.db.1234.tmp`): dois processos na
//     mesma pasta não pisam no temporário um do outro. `*.tmp` já está no .gitignore.
//   - Não há fsync de propósito: ele protege de queda de energia, não de
//     processo morto, e custaria dezenas de ms em CADA escrita.
//   - Se o rename falhar de forma persistente (antivírus/indexador segurando o
//     arquivo no Windows), grava direto como antes: melhor persistir sem
//     atomicidade do que deixar o dado só na memória.
const STALE_TMP_MAX_AGE_MS = 5 * 60 * 1000; // uma gravação leva milissegundos: temporário mais velho que isto é sobra de processo morto
const TMP_FILE_RE = /\.db(?:\.\d+)?\.tmp$/;
const RENAME_RETRY_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']); // trancos passageiros típicos do Windows
const RENAME_RETRY_WAITS_MS = [5, 25];
const FALLBACK_WARN_EVERY_MS = 10 * 60 * 1000;
const lastFallbackWarn = new Map();
let staleTempsChecked = false;

function sleepSync(ms) {
  try {
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
  } catch {
    // sem SharedArrayBuffer/Atomics.wait: tenta de novo sem esperar
  }
}

function removeQuietly(fsImpl, file) {
  try {
    fsImpl.unlinkSync(file);
  } catch {
    // já não existe, ou está em uso: a limpeza de temporários antigos resolve depois
  }
}

/**
 * Apaga sobras `*.db.<pid>.tmp` (ou `*.db.tmp`) mais velhas que `maxAgeMs`:
 * ficam quando o processo morre entre a escrita do temporário e o rename. Só
 * toca nesses temporários, nunca num .db, e o limite de idade evita apagar o
 * temporário de outro processo que esteja gravando agora. Roda uma vez por
 * processo, no primeiro initDatabase.
 * @returns {string[]} nomes removidos
 */
export function cleanStaleTempFiles(dir = databaseDir, { fsImpl = fs, now = Date.now(), maxAgeMs = STALE_TMP_MAX_AGE_MS } = {}) {
  const removed = [];
  let names;
  try {
    names = fsImpl.readdirSync(dir);
  } catch {
    return removed;
  }
  for (const file of names) {
    if (!TMP_FILE_RE.test(file)) continue;
    const full = path.join(dir, file);
    try {
      const st = fsImpl.statSync(full);
      if (!st.isFile() || now - st.mtimeMs < maxAgeMs) continue;
      fsImpl.unlinkSync(full);
      removed.push(file);
    } catch {
      // sumiu ou está em uso: fica para a próxima subida
    }
  }
  if (removed.length) logger.info(`[Database] ${removed.length} arquivo(s) temporário(s) antigo(s) de gravação removido(s).`);
  return removed;
}

/**
 * Persiste o banco nomeado em disco, de forma atômica (veja o bloco acima).
 * Nunca lança: falhas vão para o log e o retorno é `false`. Em qualquer falha
 * ANTES do rename o .db anterior continua intacto.
 *
 * @param {string} name Nome lógico do banco
 * @param {object} [options] Injeção para testes
 * @param {object} [options.fsImpl] Substituto do módulo fs (writeFileSync, renameSync, unlinkSync)
 * @param {Function} [options.sleep] Espera síncrona entre as novas tentativas de rename: (ms) => void
 * @returns {boolean} true se o banco foi gravado
 */
export function saveDatabase(name, { fsImpl = fs, sleep = sleepSync } = {}) {
  const entry = instances.get(name);
  if (!entry) return false;
  if (entry.engine === 'native') return true; // no motor nativo cada escrita já está no arquivo (WAL): não há o que regravar
  const tmp = `${entry.path}.${process.pid}.tmp`;
  try {
    const data = entry.db.export();
    // Visão sobre o mesmo buffer (sem a cópia de Buffer.from(data)): com o temporário + rename, é isto que mantém o custo da gravação no nível de antes.
    const buffer = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    fsImpl.writeFileSync(tmp, buffer); // se falhar aqui (disco cheio...), o .db original nem foi tocado

    let renameErr = null;
    for (let attempt = 0; ; attempt++) {
      try {
        fsImpl.renameSync(tmp, entry.path);
        renameErr = null;
        break;
      } catch (err) {
        renameErr = err;
        if (RENAME_RETRY_CODES.has(err?.code) && attempt < RENAME_RETRY_WAITS_MS.length) {
          sleep(RENAME_RETRY_WAITS_MS[attempt]);
          continue;
        }
        break;
      }
    }
    if (renameErr) {
      const now = Date.now();
      if (now - (lastFallbackWarn.get(name) ?? 0) >= FALLBACK_WARN_EVERY_MS) {
        lastFallbackWarn.set(name, now);
        logger.warn(`[Database] "${name}" — rename atômico falhou (${renameErr.code || renameErr.message}); gravando direto no arquivo.`);
      }
      fsImpl.writeFileSync(entry.path, buffer);
      removeQuietly(fsImpl, tmp);
    }
    return true;
  } catch (err) {
    removeQuietly(fsImpl, tmp);
    logger.error(`[Database] "${name}" — falha ao persistir banco em disco: ${err.message}`);
    return false;
  }
}

/**
 * Retorna um wrapper (prepare/transaction) escopado para um banco
 * específico. Deve ser chamado somente APÓS initDatabase(name, ...) ter
 * sido executado no bootstrap da aplicação.
 */
export function getDbWrapper(name) {
  function requireEntry() {
    const entry = instances.get(name);
    if (!entry) {
      throw new Error(
        `Database "${name}" não inicializado. Chame initDatabase('${name}', schemaSql) no bootstrap antes de usar este repositório.`
      );
    }
    return entry;
  }

  // Motor nativo: mesmo contrato do sql.js abaixo (get → objeto comum ou null; all → objetos comuns; run → { changes }).
  function nativeOps(entry, sql) {
    const stmt = nativeStatement(entry, sql);
    return {
      get: (params) => {
        const row = isNamedParams(params) ? stmt.get(nativeNamed(params[0])) : stmt.get(...params.map(nativeParam));
        return row ? { ...row } : null;
      },
      all: (params) => (isNamedParams(params) ? stmt.all(nativeNamed(params[0])) : stmt.all(...params.map(nativeParam))).map((r) => ({ ...r })),
      run: (params) => {
        const res = isNamedParams(params) ? stmt.run(nativeNamed(params[0])) : stmt.run(...params.map(nativeParam));
        return { changes: Number(res.changes) };
      },
    };
  }

  return {
    prepare(sql) {
      // Implementações em funções internas (sem `this`): o chamador pode separar o método do objeto (const run = stmt.run).
      const getImpl = (params) => {
          const entry = requireEntry();
          if (entry.engine === 'native') return nativeOps(entry, sql).get(params);
          const { db } = entry;
          const stmt = db.prepare(sql);
          stmt.bind(params);
          let result = null;
          if (stmt.step()) {
            result = stmt.getAsObject();
          }
          stmt.free();
          return result;
      };
      const allImpl = (params) => {
          const entry = requireEntry();
          if (entry.engine === 'native') return nativeOps(entry, sql).all(params);
          const { db } = entry;
          const stmt = db.prepare(sql);
          stmt.bind(params);
          const results = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
      };
      const runImpl = (params) => {
          const entry = requireEntry();
          if (entry.engine === 'native') return nativeOps(entry, sql).run(params);
          if (params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])) {
            entry.db.run(sql, params[0]);
          } else {
            entry.db.run(sql, params);
          }
          // Captura o contador ANTES de salvar em disco: o saveDatabase() chama
          // db.export() (sqlite3_serialize do sql.js), que ZERA o contador
          // interno de getRowsModified(). Sem essa ordem, `.changes` sempre
          // retorna 0 para operações fora de transação.
          const changes = entry.db.getRowsModified();
          // Dentro de uma transação, o salvamento em disco é feito UMA ÚNICA
          // VEZ, após o COMMIT (veja transaction() abaixo) — nunca a cada linha.
          if (!entry.inTransaction) {
            saveDatabase(name);
          }
          return { changes };
      };
      return {
        get: (...params) => track(name, 'read', () => getImpl(params)),
        all: (...params) => track(name, 'read', () => allImpl(params)),
        run: (...params) => track(name, 'write', () => runImpl(params)),
      };
    },

    transaction(fn) {
      return (...args) => {
        const entry = requireEntry();
        if (entry.inTransaction) {
          // Transações aninhadas não são suportadas pelo SQLite por padrão.
          // Em vez de deixar o BEGIN falhar de forma confusa, executamos a
          // função diretamente dentro da transação externa já ativa.
          return fn(...args);
        }

        // sql.js: db.run(sql); node:sqlite: db.exec(sql). O resto da transação é igual nos dois motores.
        const exec = (stmtSql) => (entry.engine === 'native' ? entry.db.exec(stmtSql) : entry.db.run(stmtSql));
        exec('BEGIN TRANSACTION');
        entry.inTransaction = true;

        let res;
        try {
          res = fn(...args);
        } catch (err) {
          entry.inTransaction = false;
          try {
            exec('ROLLBACK');
          } catch (rollbackErr) {
            logger.warn(`[Database] "${name}" — falha ao reverter transação: ${rollbackErr.message}`);
          }
          throw err;
        }

        try {
          exec('COMMIT');
        } finally {
          entry.inTransaction = false;
        }

        saveDatabase(name);
        return res;
      };
    },
  };
}
