import { initDatabase, getDbWrapper } from '../../database/db.js';
import { MEMORY_PERSONAL_SCHEMA, MEMORY_DISCORD_SCHEMA } from './schemas.js';
import { MEMORY_SCOPES, ROLES } from '../permissions.js';
import { audit } from '../audit.js';

const DAY_MS = 24 * 60 * 60 * 1000;
const DB_PERSONAL = 'memory-personal';
const DB_PUBLIC = 'memory-discord';
const VALID_TYPES = new Set(['fact', 'preference', 'project', 'decision', 'summary', 'note']);
const MAX_CONTENT = 2000;

const STOPWORDS = new Set([
  'que', 'com', 'uma', 'para', 'por', 'dos', 'das', 'nos', 'nas', 'como', 'mais', 'mas',
  'foi', 'ser', 'tem', 'isso', 'esse', 'essa', 'sobre', 'the', 'and', 'you', 'yui', 'lembra',
]);

export function retentionDays() {
  const n = parseInt(process.env.MEMORY_RETENTION_DAYS || '30', 10);
  return Number.isFinite(n) && n > 0 ? n : 30;
}

export async function initMemory() {
  await initDatabase(DB_PERSONAL, MEMORY_PERSONAL_SCHEMA);
  await initDatabase(DB_PUBLIC, MEMORY_DISCORD_SCHEMA);
}

/**
 * Escolhe o banco SOMENTE a partir do contexto resolvido pelo backend.
 * Não existe parâmetro que permita ao chamador (ou ao LLM) pedir outro escopo.
 */
function dbFor(ctx) {
  if (!ctx?.userId) throw new Error('Contexto sem userId.');
  if (ctx.role === ROLES.BLOCKED) throw new Error('Usuário bloqueado: memória indisponível.');
  return ctx.memoryScope === MEMORY_SCOPES.PERSONAL
    ? { db: getDbWrapper(DB_PERSONAL), personal: true }
    : { db: getDbWrapper(DB_PUBLIC), personal: false };
}

function normalize(text) {
  return String(text).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '');
}

function tokenize(query) {
  return [...new Set(normalize(query).split(/[^a-z0-9]+/).filter((t) => t.length >= 3 && !STOPWORDS.has(t)))];
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

/** Registra atividade e renova a retenção de todas as memórias do usuário. */
export function touchUser(ctx) {
  const { db, personal } = dbFor(ctx);
  if (personal) return;
  const now = Date.now();
  db.prepare(
    `INSERT INTO memory_users (user_id, first_seen, last_seen) VALUES (?, ?, ?)
     ON CONFLICT(user_id) DO UPDATE SET last_seen = excluded.last_seen`
  ).run(ctx.userId, now, now);
  db.prepare('UPDATE memories SET expires_at = ? WHERE user_id = ?').run(now + retentionDays() * DAY_MS, ctx.userId);
}

export function remember(ctx, { type = 'fact', content, tags = [], source = '', importance = 1 }) {
  const text = String(content ?? '').trim();
  if (!text) throw new Error('Conteúdo da memória vazio.');
  if (!VALID_TYPES.has(type)) throw new Error(`Tipo de memória inválido: ${type}`);

  const { db, personal } = dbFor(ctx);
  const now = Date.now();
  const expiresAt = personal ? null : now + retentionDays() * DAY_MS;

  // Idempotente: o mesmo texto do mesmo usuário não vira outra linha, só renova.
  // A comparação é feita em JS (normalizada): o lower() do SQLite não trata maiúsculas acentuadas.
  const key = normalize(text.slice(0, MAX_CONTENT));
  const existing = db.prepare('SELECT id, content, importance FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT 500')
    .all(ctx.userId)
    .find((r) => normalize(r.content) === key);
  if (existing) {
    db.prepare('UPDATE memories SET updated_at = ?, expires_at = ?, importance = ? WHERE id = ?')
      .run(now, expiresAt, Math.max(existing.importance, Math.min(5, Math.max(1, importance | 0))), existing.id);
    if (!personal) touchUser(ctx);
    audit('memory.write', ctx, { scope: ctx.memoryScope, type, deduplicated: true });
    return { changes: 1, deduplicated: true };
  }

  const result = db.prepare(
    `INSERT INTO memories (user_id, type, content, tags, source, importance, created_at, updated_at, expires_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    ctx.userId, type, text.slice(0, MAX_CONTENT), normalize([].concat(tags).join(',')),
    String(source).slice(0, 100), Math.min(5, Math.max(1, importance | 0)), now, now, expiresAt
  );
  if (!personal) touchUser(ctx);
  audit('memory.write', ctx, { scope: ctx.memoryScope, type });
  return result;
}

/**
 * Busca memórias relevantes para uma pergunta. Pontua por tokens em
 * conteúdo/tags + importância + recência. (O sql.js não tem FTS5; embeddings
 * podem substituir este ranking numa fase futura.)
 */
export function recall(ctx, query, { limit = 8, type = null } = {}) {
  const { db, personal } = dbFor(ctx);
  const now = Date.now();
  const tokens = tokenize(query ?? '');

  const where = ['user_id = ?'];
  const params = [ctx.userId];
  if (!personal) { where.push('(expires_at IS NULL OR expires_at > ?)'); params.push(now); }
  if (type) { where.push('type = ?'); params.push(type); }
  if (tokens.length) {
    const clause = "(lower(content) LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')";
    where.push('(' + tokens.map(() => clause).join(' OR ') + ')');
    for (const t of tokens) params.push(`%${escapeLike(t)}%`, `%${escapeLike(t)}%`);
  }

  const rows = db.prepare(
    `SELECT id, type, content, tags, importance, created_at, updated_at FROM memories
     WHERE ${where.join(' AND ')} ORDER BY updated_at DESC LIMIT 200`
  ).all(...params);

  const scored = rows.map((r) => {
    const hay = normalize(`${r.content} ${r.tags}`);
    const hits = tokens.reduce((n, t) => n + (hay.includes(t) ? 1 : 0), 0);
    const ageDays = (now - r.updated_at) / DAY_MS;
    return { ...r, score: hits * 3 + r.importance + 1 / (1 + ageDays) };
  }).sort((a, b) => b.score - a.score).slice(0, limit);

  if (personal) audit('memory.read', ctx, { scope: ctx.memoryScope, results: scored.length });
  return scored;
}

/** Texto pronto para injetar no prompt como contexto de memória. */
export function formatForPrompt(memories) {
  if (!memories.length) return '';
  return memories.map((m) => `- [${m.type}] ${m.content}`).join('\n');
}

export function forget(ctx, id) {
  const { db } = dbFor(ctx);
  const { changes } = db.prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, ctx.userId);
  audit('memory.forget', ctx, { id });
  return changes > 0;
}

/** Apaga TODA a memória do próprio usuário (direito de exclusão). */
export function forgetAll(ctx) {
  const { db, personal } = dbFor(ctx);
  const { changes } = db.prepare('DELETE FROM memories WHERE user_id = ?').run(ctx.userId);
  if (!personal) db.prepare('DELETE FROM memory_users WHERE user_id = ?').run(ctx.userId);
  audit('memory.forgetAll', ctx, { removed: changes });
  return changes;
}

export function listMemories(ctx, { limit = 50 } = {}) {
  const { db, personal } = dbFor(ctx);
  const now = Date.now();
  return personal
    ? db.prepare('SELECT * FROM memories WHERE user_id = ? ORDER BY updated_at DESC LIMIT ?').all(ctx.userId, limit)
    : db.prepare('SELECT * FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?) ORDER BY updated_at DESC LIMIT ?')
        .all(ctx.userId, now, limit);
}

/** Remove memórias públicas expiradas e usuários inativos. Chamar do scheduler (ex.: 1x/dia). */
export function purgeExpired() {
  const db = getDbWrapper(DB_PUBLIC);
  const now = Date.now();
  const { changes } = db.prepare('DELETE FROM memories WHERE expires_at IS NOT NULL AND expires_at <= ?').run(now);
  db.prepare('DELETE FROM memory_users WHERE last_seen <= ?').run(now - retentionDays() * DAY_MS);
  return changes;
}

// ───────────────────────── Administração (somente o dono) ─────────────────────────
// Operam APENAS na memória pública/temporária dos usuários do Discord e expõem
// apenas METADADOS (nunca o conteúdo). A memória pessoal do dono fica fora daqui.

function requireOwner(ctx) {
  if (ctx?.role !== ROLES.OWNER) throw new Error('Apenas o dono pode administrar memórias.');
}

function publicDb() {
  return getDbWrapper(DB_PUBLIC);
}

/** Usuários com memória ativa: id, quantidade, última interação e próxima expiração. */
export function adminListUsers(ctx, { limit = 25 } = {}) {
  requireOwner(ctx);
  const now = Date.now();
  const rows = publicDb().prepare(
    `SELECT u.user_id AS userId, u.last_seen AS lastSeen,
            COUNT(m.id) AS count, MIN(m.expires_at) AS expiresAt
     FROM memory_users u
     LEFT JOIN memories m ON m.user_id = u.user_id AND (m.expires_at IS NULL OR m.expires_at > ?)
     GROUP BY u.user_id ORDER BY u.last_seen DESC LIMIT ?`
  ).all(now, limit);
  const total = publicDb().prepare('SELECT COUNT(*) AS n FROM memory_users').get().n;
  audit('memory.admin.list', ctx, { users: rows.length });
  return { users: rows, total };
}

/** Metadados das memórias de um usuário (sem o conteúdo). */
export function adminListMetadata(ctx, userId, { limit = 25 } = {}) {
  requireOwner(ctx);
  const now = Date.now();
  const rows = publicDb().prepare(
    `SELECT id, type, length(content) AS chars, source, created_at AS createdAt, expires_at AS expiresAt
     FROM memories WHERE user_id = ? AND (expires_at IS NULL OR expires_at > ?)
     ORDER BY updated_at DESC LIMIT ?`
  ).all(String(userId), now, limit);
  audit('memory.admin.inspect', ctx, { target: String(userId), results: rows.length });
  return rows;
}

export function adminForget(ctx, userId, id) {
  requireOwner(ctx);
  const { changes } = publicDb().prepare('DELETE FROM memories WHERE id = ? AND user_id = ?').run(id, String(userId));
  audit('memory.admin.forget', ctx, { target: String(userId), id });
  return changes > 0;
}

export function adminForgetUser(ctx, userId) {
  requireOwner(ctx);
  const db = publicDb();
  const { changes } = db.prepare('DELETE FROM memories WHERE user_id = ?').run(String(userId));
  db.prepare('DELETE FROM memory_users WHERE user_id = ?').run(String(userId));
  audit('memory.admin.forgetUser', ctx, { target: String(userId), removed: changes });
  return changes;
}
