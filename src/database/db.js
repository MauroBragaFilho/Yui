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

export function saveDatabase(name) {
  const entry = instances.get(name);
  if (!entry) return;
  try {
    const data = entry.db.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(entry.path, buffer);
  } catch (err) {
    logger.error(`[Database] "${name}" — falha ao persistir banco em disco: ${err.message}`);
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
          // Dentro de uma transação, o salvamento em disco é feito UMA ÚNICA
          // VEZ, após o COMMIT (veja transaction() abaixo) — nunca a cada linha.
          if (!entry.inTransaction) {
            saveDatabase(name);
          }
          return { changes: entry.db.getRowsModified() };
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
