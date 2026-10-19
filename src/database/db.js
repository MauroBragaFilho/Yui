import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const databaseDir = path.resolve(config.database.dir);

if (!fs.existsSync(databaseDir)) {
  fs.mkdirSync(databaseDir, { recursive: true });
}

// Cada entrada: { db: <instância sql.js>, path: <caminho do arquivo>, inTransaction: bool }
const instances = new Map();
let SQL = null;

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
 * @param {string} name Nome lógico do banco (também usado como nome do arquivo: {name}.db)
 * @param {string} schemaSql SQL de criação de tabelas/índices deste domínio (idempotente, usa IF NOT EXISTS)
 */
export async function initDatabase(name, schemaSql) {
  if (instances.has(name)) {
    return instances.get(name).db;
  }

  if (!staleTempsChecked) {
    staleTempsChecked = true;
    cleanStaleTempFiles(); // sobras de uma gravação interrompida por processo morto (TG-20)
  }

  const sql = await getSqlJs();
  const dbPath = path.join(databaseDir, `${name}.db`);

  let db;
  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    db = new sql.Database(fileBuffer);
    logger.info(`[Database] "${name}" carregado de: ${dbPath}`);
  } else {
    db = new sql.Database();
    logger.info(`[Database] "${name}" — novo banco criado em: ${dbPath}`);
  }

  instances.set(name, { db, path: dbPath, inTransaction: false });

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

  return {
    prepare(sql) {
      return {
        get(...params) {
          const { db } = requireEntry();
          const stmt = db.prepare(sql);
          stmt.bind(params);
          let result = null;
          if (stmt.step()) {
            result = stmt.getAsObject();
          }
          stmt.free();
          return result;
        },

        all(...params) {
          const { db } = requireEntry();
          const stmt = db.prepare(sql);
          stmt.bind(params);
          const results = [];
          while (stmt.step()) {
            results.push(stmt.getAsObject());
          }
          stmt.free();
          return results;
        },

        run(...params) {
          const entry = requireEntry();
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
        },
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

        entry.db.run('BEGIN TRANSACTION');
        entry.inTransaction = true;

        let res;
        try {
          res = fn(...args);
        } catch (err) {
          entry.inTransaction = false;
          try {
            entry.db.run('ROLLBACK');
          } catch (rollbackErr) {
            logger.warn(`[Database] "${name}" — falha ao reverter transação: ${rollbackErr.message}`);
          }
          throw err;
        }

        try {
          entry.db.run('COMMIT');
        } finally {
          entry.inTransaction = false;
        }

        saveDatabase(name);
        return res;
      };
    },
  };
}
