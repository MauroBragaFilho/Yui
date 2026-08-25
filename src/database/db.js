import initSqlJs from 'sql.js';
import path from 'path';
import fs from 'fs';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';

const dbPath = path.resolve(config.database.path);
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

let dbInstance = null;
let inTransaction = false;

export async function initDatabase() {
  if (dbInstance) return dbInstance;

  const SQL = await initSqlJs();

  if (fs.existsSync(dbPath)) {
    const fileBuffer = fs.readFileSync(dbPath);
    dbInstance = new SQL.Database(fileBuffer);
    logger.info(`[Database] SQLite (WASM/Zero-C++) carregado de: ${dbPath}`);
  } else {
    dbInstance = new SQL.Database();
    logger.info('[Database] Novo banco SQLite (WASM/Zero-C++) criado.');
  }

  initSchema();
  return dbInstance;
}

export function saveDatabase() {
  if (!dbInstance) return;
  try {
    const data = dbInstance.export();
    const buffer = Buffer.from(data);
    fs.writeFileSync(dbPath, buffer);
  } catch (err) {
    logger.error(`[Database] Falha ao persistir banco em disco: ${err.message}`);
  }
}

export const dbWrapper = {
  prepare(sql) {
    return {
      get(...params) {
        if (!dbInstance) throw new Error('Database não inicializado');
        const stmt = dbInstance.prepare(sql);
        stmt.bind(params);
        let result = null;
        if (stmt.step()) {
          result = stmt.getAsObject();
        }
        stmt.free();
        return result;
      },

      all(...params) {
        if (!dbInstance) throw new Error('Database não inicializado');
        const stmt = dbInstance.prepare(sql);
        stmt.bind(params);
        const results = [];
        while (stmt.step()) {
          results.push(stmt.getAsObject());
        }
        stmt.free();
        return results;
      },

      run(...params) {
        if (!dbInstance) throw new Error('Database não inicializado');
        // Suporte para parâmetros como array ou objeto
        if (params.length === 1 && typeof params[0] === 'object' && !Array.isArray(params[0])) {
          dbInstance.run(sql, params[0]);
        } else {
          dbInstance.run(sql, params);
        }
        // Dentro de uma transação, o salvamento em disco é feito UMA ÚNICA VEZ,
        // após o COMMIT (veja transaction() abaixo) — nunca a cada linha.
        if (!inTransaction) {
          saveDatabase();
        }
        return { changes: dbInstance.getRowsModified() };
      },
    };
  },

  transaction(fn) {
    return (...args) => {
      if (!dbInstance) throw new Error('Database não inicializado');
      if (inTransaction) {
        // Transações aninhadas não são suportadas pelo SQLite por padrão.
        // Em vez de deixar o BEGIN falhar de forma confusa, executamos a
        // função diretamente dentro da transação externa já ativa.
        return fn(...args);
      }

      dbInstance.run('BEGIN TRANSACTION');
      inTransaction = true;

      let res;
      try {
        res = fn(...args);
      } catch (err) {
        inTransaction = false;
        try {
          dbInstance.run('ROLLBACK');
        } catch (rollbackErr) {
          // Se o rollback falhar (ex: transação já havia sido finalizada por
          // outro motivo), não mascaramos o erro original — só registramos.
          logger.warn(`[Database] Falha ao reverter transação: ${rollbackErr.message}`);
        }
        throw err;
      }

      try {
        dbInstance.run('COMMIT');
      } finally {
        inTransaction = false;
      }

      saveDatabase();
      return res;
    };
  },
};

function initSchema() {
  const schemaSql = `
    -- Configuração de canais por servidor
    CREATE TABLE IF NOT EXISTS guild_settings (
      guild_id TEXT PRIMARY KEY,
      news_channel_id TEXT,
      daily_channel_id TEXT,
      weekly_channel_id TEXT,
      vehicles_channel_id TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Histórico de notícias do Rockstar Newswire
    CREATE TABLE IF NOT EXISTS news_articles (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      category TEXT,
      thumbnail_url TEXT,
      published_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Estado dos Resets Diários do GTA Online
    CREATE TABLE IF NOT EXISTS daily_resets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      reset_date TEXT UNIQUE NOT NULL,
      data_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Estado dos Eventos Semanais do GTA Online
    CREATE TABLE IF NOT EXISTS weekly_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      event_week TEXT UNIQUE NOT NULL,
      data_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    -- Rastreamento de mensagens enviadas no Discord
    CREATE TABLE IF NOT EXISTS published_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      content_type TEXT NOT NULL,
      content_id TEXT NOT NULL,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      published_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_news_published_at ON news_articles (published_at DESC);
    CREATE INDEX IF NOT EXISTS idx_published_lookup ON published_messages (content_type, content_id, guild_id);
  `;

  dbInstance.run(schemaSql);
  saveDatabase();
  logger.info('[Database] Esquema SQLite verificado e salvo com sucesso.');
}
