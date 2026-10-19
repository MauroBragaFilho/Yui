import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Limites da busca na web.
 *
 * - Por usuário (em memória): N buscas por hora (YUI_SEARCH_USER_PER_HOUR, padrão 5; 0 = sem limite).
 * - GLOBAL (em memória): N buscas por hora SOMANDO todo mundo (YUI_SEARCH_GLOBAL_PER_HOUR, padrão 20; 0 = sem teto). É o freio
 *   anti-abuso (várias contas, vários pedidos) e vale SEMPRE: também sem userId (ex.: 2º passo do agente de pesquisa com
 *   YUI_RESEARCH_CHARGE_ALL=false) e mesmo com o limite por usuário desligado. Recusa antes de gastar o provedor.
 * - Por provedor, por mês (em arquivo, sobrevive a reinício): YUI_SEARCH_MONTHLY_CAP_<PROVEDOR>
 *   (padrão 900 para Brave e Tavily, que têm cota gratuita; 0 = sem teto; demais provedores: sem teto).
 *
 * O arquivo fica em secrets/search-budget.json (a pasta secrets/ é ignorada pelo git) e é gravado de
 * forma atômica (arquivo temporário + rename). Qualquer falha de disco é engolida: a busca não cai por
 * causa do contador (ele continua valendo em memória até o processo terminar).
 *
 * Tudo é injetável (relógio e caminho do arquivo) para teste.
 */

const HOUR_MS = 60 * 60 * 1000;
const DEFAULT_USER_PER_HOUR = 5;
const DEFAULT_GLOBAL_PER_HOUR = 20;
const DEFAULT_CAPS = { brave: 900, tavily: 900 };
const KEEP_MONTHS = 3;
const MAX_TRACKED_USERS = 2000;

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_FILE = path.resolve(HERE, '..', '..', 'secrets', 'search-budget.json');

function intEnv(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? Math.floor(n) : fallback;
}

/** Buscas por hora permitidas a cada usuário (0 = sem limite). */
export function userLimitPerHour(env = process.env) {
  return intEnv(env.YUI_SEARCH_USER_PER_HOUR, DEFAULT_USER_PER_HOUR);
}

/** Teto GLOBAL de buscas por hora, somando todos os usuários (0 = sem teto). */
export function globalLimitPerHour(env = process.env) {
  return intEnv(env.YUI_SEARCH_GLOBAL_PER_HOUR, DEFAULT_GLOBAL_PER_HOUR);
}

/** Teto mensal de buscas de um provedor (0 = sem teto). */
export function monthlyCap(provider, env = process.env) {
  const name = String(provider).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return intEnv(env[`YUI_SEARCH_MONTHLY_CAP_${name}`], DEFAULT_CAPS[String(provider).toLowerCase()] ?? 0);
}

/** Chave do mês em UTC ("2026-10"). */
export function monthKey(ms) {
  return new Date(ms).toISOString().slice(0, 7);
}

export function createBudget({ filePath = process.env.YUI_SEARCH_BUDGET_FILE || DEFAULT_FILE, now = () => Date.now() } = {}) {
  const users = new Map(); // userId -> timestamps (ms) das buscas na última hora
  let globalStamps = []; // timestamps (ms) das buscas aceitas na última hora, de TODO mundo (no máximo o teto global)
  let months = null; // { "2026-10": { tavily: 12, brave: 3 } }, carregado sob demanda

  /** Buscas aceitas na última hora (poda as velhas). */
  function recentGlobal(at) {
    if (globalStamps.length) globalStamps = globalStamps.filter((t) => at - t < HOUR_MS);
    return globalStamps;
  }

  function load() {
    if (months) return months;
    months = {};
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const source = raw && typeof raw === 'object' ? raw.months : null;
      if (source && typeof source === 'object') {
        for (const [key, counters] of Object.entries(source)) {
          if (!/^\d{4}-\d{2}$/.test(key) || !counters || typeof counters !== 'object') continue;
          months[key] = {};
          for (const [provider, n] of Object.entries(counters)) {
            if (Number.isFinite(n) && n >= 0) months[key][provider] = Math.floor(n);
          }
        }
      }
    } catch {
      // arquivo ausente ou corrompido: começa do zero
    }
    return months;
  }

  function save() {
    const tmp = `${filePath}.${process.pid}.${Date.now()}.tmp`;
    try {
      const keep = Object.keys(months).sort().slice(-KEEP_MONTHS);
      const pruned = {};
      for (const key of keep) pruned[key] = months[key];
      months = pruned;
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(tmp, JSON.stringify({ version: 1, months }, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
    } catch {
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // nada a fazer
      }
    }
  }

  function sweepUsers(at) {
    for (const [id, stamps] of users) {
      const alive = stamps.filter((t) => at - t < HOUR_MS);
      if (alive.length) users.set(id, alive);
      else users.delete(id);
    }
  }

  return {
    filePath,

    /**
     * Conta uma busca se ainda houver cota na última hora: primeiro o teto GLOBAL (todo mundo, inclusive sem userId), depois o limite
     * do usuário. Quem recusa não gasta cota de nenhum dos dois.
     * `limit`/`used` são sempre os do USUÁRIO; `globalLimit`/`globalUsed` os do teto global (0 = desligado).
     * `scope` diz quem recusou: 'user' | 'global' (null quando ok). Os dois recusando: 'user', com o maior tempo de espera.
     * @returns {{ ok: boolean, scope: 'user'|'global'|null, limit: number, used: number, retryAfterMs: number, globalLimit: number, globalUsed: number }}
     */
    takeUser(userId, env = process.env, at = now()) {
      const limit = userLimitPerHour(env);
      const globalLimit = globalLimitPerHour(env);
      // O teto global vem ANTES de qualquer retorno antecipado: sem userId ou com o limite por usuário desligado ele continua valendo.
      const recent = recentGlobal(at);
      const globalFull = globalLimit > 0 && recent.length >= globalLimit;
      const globalRetry = globalFull ? Math.max(0, recent[0] + HOUR_MS - at) : 0;
      const id = userId === undefined || userId === null || userId === '' ? null : String(userId);
      const tracked = limit > 0 && id !== null;
      const stamps = tracked ? (users.get(id) ?? []).filter((t) => at - t < HOUR_MS) : null;
      if (tracked && stamps.length >= limit) {
        users.set(id, stamps);
        return { ok: false, scope: 'user', limit, used: stamps.length, retryAfterMs: Math.max(0, stamps[0] + HOUR_MS - at, globalRetry), globalLimit, globalUsed: recent.length };
      }
      if (globalFull) {
        if (tracked) users.set(id, stamps); // grava a poda, sem gastar a cota do usuário
        return { ok: false, scope: 'global', limit, used: stamps ? stamps.length : 0, retryAfterMs: globalRetry, globalLimit, globalUsed: recent.length };
      }
      if (tracked) {
        stamps.push(at);
        users.set(id, stamps);
        if (users.size > MAX_TRACKED_USERS) sweepUsers(at);
      }
      if (globalLimit > 0) recent.push(at);
      return { ok: true, scope: null, limit, used: stamps ? stamps.length : 0, retryAfterMs: 0, globalLimit, globalUsed: globalLimit > 0 ? recent.length : 0 };
    },

    /** Situação do teto global agora (não gasta nada): quantas buscas na última hora e quando abre vaga. */
    globalStatus(env = process.env, at = now()) {
      const limit = globalLimitPerHour(env);
      const recent = recentGlobal(at);
      const full = limit > 0 && recent.length >= limit;
      return { limit, used: recent.length, full, retryAfterMs: full ? Math.max(0, recent[0] + HOUR_MS - at) : 0 };
    },

    /** Uso do mês corrente de um provedor. */
    used(provider, at = now()) {
      return load()[monthKey(at)]?.[provider] ?? 0;
    },

    /** O provedor ainda pode ser chamado neste mês? */
    canUseProvider(provider, env = process.env, at = now()) {
      const cap = monthlyCap(provider, env);
      const used = this.used(provider, at);
      return { ok: !cap || used < cap, used, cap };
    },

    /** Registra uma chamada ao provedor (grava em disco, sem nunca lançar erro). */
    recordProvider(provider, at = now()) {
      const key = monthKey(at);
      const all = load();
      all[key] ??= {};
      all[key][provider] = (all[key][provider] ?? 0) + 1;
      save();
      return all[key][provider];
    },

    /** Zera tudo (só para testes). */
    reset() {
      users.clear();
      globalStamps = [];
      months = {};
    },
  };
}

let defaultBudget = null;

/** Instância compartilhada do processo (arquivo YUI_SEARCH_BUDGET_FILE ou secrets/search-budget.json). */
export function getDefaultBudget() {
  defaultBudget ??= createBudget();
  return defaultBudget;
}
