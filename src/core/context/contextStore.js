// Contexto da conversa por algumas horas (S3).
//
// O QUE É: a "memória de curto prazo" do fio de conversa entre UMA pessoa e a Yui num canal (ou na DM),
// para ela não perder o raciocínio entre uma mensagem e outra. Não é a memória de fatos duráveis
// (src/core/memory): aqui só há falas recentes, que VENCEM sozinhas.
//
// REGRAS DE PRIVACIDADE (todas aplicadas pelo código, não pela IA):
//  - Padrão DESLIGADO (YUI_CONTEXT_ENABLED=false). Desligado, nada é lido nem gravado e o módulo nem abre banco.
//  - Escopo YUI_CONTEXT_SCOPE=owner (padrão): só o dono. "all" liga para todos (faça só depois de avisar no TOS).
//  - Um fio por PESSOA em cada canal: DM = "dm:<userId>"; servidor/canal/thread = "ch:<channelId>:u:<userId>".
//  - Cada fala vence pela PRÓPRIA idade (TTL padrão 6 h, limitado a 1-48 h). Não é prazo deslizante: quem manda
//    mensagem a cada 5 h não mantém dias de conversa.
//  - Conteúdo PESSOAL (dono em DM ou em canal de YUI_PRIVATE_CHANNEL_IDS) fica em arquivo SEPARADO
//    (database/memory-context-personal.db), como a memória pessoal fica separada da pública. Esse contexto só
//    sai pelo campo `history` das chamadas sensíveis (que já excluem provedores anônimos) e nunca é colado no prompt.
//  - Nenhum comando ou painel lê o CONTEÚDO de outras pessoas; a auditoria só recebe contagens.
//  - Banco com problema (arquivo corrompido, disco cheio): o módulo cai para RAM e a conversa segue. Nada aborta.
//
// ARMAZENAMENTO: banco do projeto (src/database/db.js), cache em RAM, uma transação por troca (usuário + resposta).
// No sql.js (o padrão) o arquivo INTEIRO é reescrito a cada escrita, então grava-se uma vez por troca, nunca por fala.
// No motor nativo (YUI_DB_NATIVE com memory-context e/ou memory-context-personal: node:sqlite com WAL) as escritas vão
// para o -wal; depois de apagar, o -wal é esvaziado (veja flushWal) para o texto apagado não ficar nele.
// Não depende de foreign_keys: as falas do fio são apagadas explicitamente.
//
// VARIÁVEIS: YUI_CONTEXT_ENABLED, YUI_CONTEXT_SCOPE, YUI_CONTEXT_TTL_HOURS, YUI_CONTEXT_MAX_CHARS, YUI_CONTEXT_MAX_TURNS.
import { AsyncLocalStorage } from 'node:async_hooks';
import fs from 'node:fs';
import path from 'node:path';
import { config } from '../../config/index.js';
import { isOwnerId } from '../permissions.js';
import { logger as defaultLogger } from '../../utils/logger.js';
import { jobAllowed } from '../security/jobGuard.js';

const HOUR_MS = 60 * 60 * 1000;

/** Marcador do histórico quando a IA falhou (o prompt de sistema e o messageCreate dependem exatamente deste texto). */
export const ERROR_MARKER = 'erro da ia';

export const LIMITS = Object.freeze({
  ttlHours: { def: 6, min: 1, max: 48 },
  maxChars: { def: 6000, min: 1000, max: 30000 },
  maxTurns: { def: 20, min: 2, max: 60 },
  userChars: 1200,       // fala do usuário: acima disso guarda começo + fim
  assistantChars: 1500,  // resposta da IA, sem o rodapé "-# modelo"
});

// ───────────────────────────── Configuração (lida a cada uso: nada de estado escondido) ─────────────────────────────

export function contextEnabled(env = process.env) {
  return String(env.YUI_CONTEXT_ENABLED ?? 'false').trim().toLowerCase() === 'true';
}

/** 'owner' (padrão) ou 'all'. */
export function contextScope(env = process.env) {
  return String(env.YUI_CONTEXT_SCOPE ?? 'owner').trim().toLowerCase() === 'all' ? 'all' : 'owner';
}

function clampNumber(raw, { def, min, max }, { integer = false } = {}) {
  const n = integer ? parseInt(raw, 10) : parseFloat(raw);
  if (!Number.isFinite(n)) return def;
  return Math.min(max, Math.max(min, n));
}

export function contextTtlHours(env = process.env) {
  return clampNumber(env.YUI_CONTEXT_TTL_HOURS, LIMITS.ttlHours);
}

export function contextTtlMs(env = process.env) {
  return Math.round(contextTtlHours(env) * HOUR_MS);
}

export function contextMaxChars(env = process.env) {
  return clampNumber(env.YUI_CONTEXT_MAX_CHARS, LIMITS.maxChars, { integer: true });
}

/** Total de falas (usuário + IA). Sempre PAR: o fio é feito de trocas. */
export function contextMaxTurns(env = process.env) {
  const n = clampNumber(env.YUI_CONTEXT_MAX_TURNS, LIMITS.maxTurns, { integer: true });
  return n - (n % 2);
}

// ───────────────────────────── Textos ─────────────────────────────

const ELLIPSIS = '[…]';

const isHighSurrogate = (code) => code >= 0xD800 && code <= 0xDBFF;
const isLowSurrogate = (code) => code >= 0xDC00 && code <= 0xDFFF;

/** s.slice(0, end) sem partir um par substituto (emoji). */
function sliceStart(s, end) {
  let e = Math.max(0, Math.min(end, s.length));
  if (e > 0 && e < s.length && isHighSurrogate(s.charCodeAt(e - 1))) e -= 1;
  return s.slice(0, e);
}

/** Os últimos `count` caracteres de s, sem partir um par substituto. */
function sliceEnd(s, count) {
  if (count <= 0) return '';
  let start = Math.max(0, s.length - count);
  if (start > 0 && start < s.length && isLowSurrogate(s.charCodeAt(start))) start += 1;
  return s.slice(start);
}

/** Fala do usuário: até `max` caracteres; acima disso guarda o COMEÇO e o FIM (o miolo vira "[…]"). */
export function clipUserText(text, max = LIMITS.userChars) {
  const s = String(text ?? '').replace(/\r\n?/g, '\n').trim();
  if (s.length <= max) return s;
  const marker = ` ${ELLIPSIS} `;
  const room = Math.max(0, max - marker.length);
  const head = Math.ceil(room * 0.7);
  return sliceStart(s, head) + marker + sliceEnd(s, room - head);
}

/** Resposta da IA: sem rodapé "-# ...", sem o "Processando...", até `max` caracteres (corta o fim). */
export function clipAssistantText(text, max = LIMITS.assistantChars) {
  let s = String(text ?? '').replace(/\r\n?/g, '\n');
  s = s.replace(/^-# .*$/gm, '').replace(/🧠 \*\*Processando\.\.\.\*\*/g, '').replace(/\n{3,}/g, '\n\n').trim();
  if (s.length <= max) return s;
  const marker = ` ${ELLIPSIS}`;
  return sliceStart(s, Math.max(0, max - marker.length)).trimEnd() + marker;
}

/**
 * A resposta NÃO pode ser guardada: carrega marcador de ferramenta ou JSON de chamada (texto assim, persistido,
 * seria uma injeção que volta a cada pergunta).
 */
export function isUnsafeForContext(text) {
  const t = String(text ?? '');
  return /\[Tool Use\s*:/i.test(t)
    || /\btool_code\b/i.test(t)
    || /\bdefault_api\./i.test(t)
    || /^\s*\{[\s\S]*"(?:tool|thought|generate_reply)"\s*:/i.test(t);
}

/** Respostas de erro do próprio bot: no contexto viram o marcador "erro da ia". */
export function isErrorReply(text) {
  const t = String(text ?? '').trim();
  if (!t) return false;
  return t === ERROR_MARKER
    || /Limites de Processamento Atingidos/i.test(t)
    || /O modelo não gerou uma resposta válida/i.test(t)
    || /Erro de Processamento/i.test(t)
    || /Desculpe, tive um erro/i.test(t)
    || /erro ao processar seu pedido/i.test(t);
}

// ───────────────────────────── Sequência de falas ─────────────────────────────

/**
 * Garante a sequência que os provedores esperam: começa por "user", alterna os papéis e TERMINA em "assistant"
 * (a próxima mensagem é do usuário). Papéis repetidos seguidos ficam com o mais novo.
 */
export function normalizeTurns(turns) {
  const out = [];
  for (const t of Array.isArray(turns) ? turns : []) {
    if (!t || (t.role !== 'user' && t.role !== 'assistant')) continue;
    if (typeof t.content !== 'string' || !t.content.trim()) continue;
    if (out.length === 0 && t.role !== 'user') continue;
    if (out.length && out[out.length - 1].role === t.role) {
      out[out.length - 1] = t;
      continue;
    }
    out.push(t);
  }
  while (out.length && out[out.length - 1].role === 'user') out.pop();
  return out;
}

/** Fica com as trocas MAIS RECENTES que cabem no total de caracteres e de falas (sem buraco no meio). */
export function trimToBudget(turns, { maxChars = LIMITS.maxChars.def, maxTurns = LIMITS.maxTurns.def } = {}) {
  const list = normalizeTurns(turns);
  const kept = [];
  let chars = 0;
  for (let i = list.length - 1; i >= 1; i -= 2) {
    const user = list[i - 1];
    const assistant = list[i];
    const size = user.content.length + assistant.content.length;
    if (kept.length + 2 > maxTurns || chars + size > maxChars) break;
    kept.unshift(user, assistant);
    chars += size;
  }
  return kept;
}

/** Vence por IDADE DE CADA FALA, depois normaliza e aplica o orçamento. `at` é em ms. */
export function pruneTurns(turns, { nowMs, ttlMs, maxChars, maxTurns }) {
  const cutoff = nowMs - Math.min(ttlMs, LIMITS.ttlHours.max * HOUR_MS);
  const alive = (Array.isArray(turns) ? turns : []).filter((t) => Number.isFinite(t?.at) && t.at >= cutoff);
  return trimToBudget(alive, { maxChars, maxTurns });
}

// ───────────────────────────── Chave e alvo do contexto ─────────────────────────────

export function buildContextKey({ userId, channelId = null, isDM = false } = {}) {
  if (!userId) return null;
  if (isDM) return `dm:${userId}`;
  if (!channelId) return null;
  return `ch:${channelId}:u:${userId}`;
}

/**
 * Decide se este pedido usa o contexto por horas. Devolve { active: false, reason } ou o ALVO:
 * { active, key, personal, userId, channelId, guildId, record, userText, committed }.
 *  - desligado (padrão)  => inactive
 *  - escopo "owner"      => só o dono
 *  - record=false        => só LÊ o contexto (ex.: pedido sem fala própria)
 */
export function resolveContextTarget({
  userId, channelId = null, guildId = null, personal = false, record = true, userText = null,
  env = process.env, isOwner = isOwnerId,
} = {}) {
  if (!contextEnabled(env)) return { active: false, reason: 'disabled' };
  if (!userId) return { active: false, reason: 'no-user' };
  if (contextScope(env) === 'owner' && !isOwner(String(userId))) return { active: false, reason: 'scope' };
  const isDM = !guildId;
  const key = buildContextKey({ userId: String(userId), channelId: channelId ? String(channelId) : null, isDM });
  if (!key) return { active: false, reason: 'no-key' };
  return {
    active: true,
    key,
    personal: personal === true,
    userId: String(userId),
    channelId: channelId ? String(channelId) : null,
    guildId: guildId ? String(guildId) : null,
    record: record !== false,
    userText: typeof userText === 'string' ? userText : null,
    committed: false,
  };
}

/**
 * O pedido é uma CHAMADA DIRETA à Yui? Mensagem espontânea (chatter), voz, rádio e log de terceiros (/chat_resumo)
 * não leem nem gravam o contexto por horas, a menos que o fluxo peça (optIn, ex.: TTS futuro).
 */
export function isDirectCall({
  type, isDM = false, mentionsBot = false, hasBotName = false, repliesToBot = false,
  thirdPartyPrompt = false, radioMode = false, isVoice = false, optIn = false,
} = {}) {
  if (thirdPartyPrompt) return false;
  if (radioMode || isVoice) return optIn === true;
  if (type !== 'mention') return false;
  if (isDM) return true;
  return Boolean(mentionsBot || hasBotName || repliesToBot);
}

// ───────────────────────────── Contexto assíncrono (AsyncLocalStorage) ─────────────────────────────
// `generateResponse(prompt, channelId, options)` usa channelId também para a persona do canal e para o rodapé do
// modelo, e a fila chama generateResponse em ~11 pontos com objetos de opções novos. Por isso a chave do contexto
// NÃO viaja em `channelId` nem em `options`: fica aqui, preenchida na fila.

const als = new AsyncLocalStorage();

/** Roda `fn` com o alvo (ou SEM alvo, se null: um setTimeout herdaria o contexto do pedido anterior). */
export function runWithContext(target, fn) {
  return als.run(target ?? null, fn);
}

export function currentContext() {
  return als.getStore() ?? null;
}

// ───────────────────────────── Armazenamento (sql.js ou motor nativo, via src/database/db.js) ─────────────────────────────

const DB_NAMES = Object.freeze({ public: 'memory-context', personal: 'memory-context-personal' });

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS context_scopes (
    scope_key  TEXT PRIMARY KEY,
    user_id    TEXT NOT NULL,
    channel_id TEXT,
    guild_id   TEXT,
    personal   INTEGER NOT NULL DEFAULT 0,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS context_turns (
    id        INTEGER PRIMARY KEY AUTOINCREMENT,
    scope_key TEXT NOT NULL,
    role      TEXT NOT NULL,
    content   TEXT NOT NULL,
    at        INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_context_turns_scope ON context_turns(scope_key, at);
  CREATE INDEX IF NOT EXISTS idx_context_turns_at ON context_turns(at);
  CREATE INDEX IF NOT EXISTS idx_context_scopes_user ON context_scopes(user_id);
  CREATE INDEX IF NOT EXISTS idx_context_scopes_guild ON context_scopes(guild_id);
`;

const CORRUPT_RE = /not a database|malformed|corrupt|disk image|encrypted/i;
/** Erros do db.js que vêm de um banco VÁLIDO (formato do motor nativo, banco de outro processo dono): nunca vão à quarentena. */
const NEVER_CORRUPT_CODES = new Set(['YUI_DB_WAL_NO_SQLJS', 'YUI_DB_NOT_OWNER', 'YUI_DB_OWNER_HELD', 'YUI_DB_OWNER_HUNG', 'YUI_DB_BAD_ROLE']);

function databaseFilePath(name) {
  return path.join(path.resolve(config.database.dir), `${name}.db`);
}

/** Existe algum arquivo de contexto no disco? (apagar-tudo precisa apagar mesmo com o recurso desligado.) */
export function contextFilesExist() {
  try {
    return Object.values(DB_NAMES).some((name) => fs.existsSync(databaseFilePath(name)));
  } catch {
    return false;
  }
}

// Arquivo corrompido vai para a "quarentena": é renomeado para memory-context[-personal].corrupt-<ts>.db. O nome TERMINA em
// .db e começa com memory-, então o .gitignore (database/memory-*.db) o cobre e um `git add` não versiona falas pessoais.
// No motor nativo o -wal e o -shm vão junto (…corrupt-<ts>.db-wal / .db-shm, cobertos por database/*.db-wal e *.db-shm).
// A quarentena não é eterna: a limpeza apaga o que tem mais de 48 h (a cada hora e na partida) e o apagar-tudo apaga tudo.
// Também reconhece o nome antigo (memory-context.db.corrupt-<ts>) para limpar o que a versão anterior deixou.
const CORRUPT_FILE_RE = /^memory-context(?:-personal)?(?:\.db)?\.corrupt-\d+(?:\.db(?:-wal|-shm)?)?$/;
const CORRUPT_KEEP_MS = 48 * HOUR_MS;

/** O banco `name` é (ou seria) aberto no motor nativo? Vale também quando a abertura falhou e ele nem está aberto. */
function usesNativeEngine(dbApi, name) {
  try {
    const engine = dbApi.getDatabaseEngine?.(name) ?? null;
    if (engine) return engine === 'native';
    const names = dbApi.nativeDatabaseNames?.();
    return Boolean(names && (names.has('*') || names.has(name)));
  } catch {
    return false;
  }
}

/** Leva o -wal e o -shm do arquivo corrompido para junto dele na quarentena; o que não puder ser movido é apagado. */
function moveWalSidecars(file, dest, name, logger) {
  for (const suffix of ['-wal', '-shm']) {
    const from = `${file}${suffix}`;
    if (!fs.existsSync(from)) continue;
    try {
      fs.renameSync(from, `${dest}${suffix}`);
    } catch {
      try {
        fs.unlinkSync(from);
      } catch (err) {
        logger.warn(`[Context] "${name}": não consegui mover nem apagar o ${suffix} do arquivo corrompido: ${String(err?.message ?? err).slice(0, 100)}`);
      }
    }
  }
}

/**
 * Guarda de lado o arquivo corrompido do banco `name` (vira `<name>.corrupt-<ts>.db`). Nunca lança.
 *  - sql.js: só renomeia o .db, como sempre (o sql.js leu o arquivo para a memória e não o deixa aberto).
 *  - nativo (`native`): o arquivo pode estar ABERTO (o erro pode aparecer só na primeira leitura, depois da abertura) e o
 *    Windows recusa renomear arquivo aberto (EBUSY/EPERM): fecha o banco ANTES com `closeDatabase(name)`. Leva junto o
 *    -wal e o -shm, para um WAL velho não ficar ao lado do banco novo.
 * @returns {string|null} o caminho na quarentena, ou null (não havia arquivo, ou o rename falhou)
 */
export function quarantineCorruptContextFile(name, { native = false, closeDatabase = null, dir = null, nowMs = Date.now(), logger = defaultLogger } = {}) {
  try {
    const base = dir ? path.resolve(dir) : path.resolve(config.database.dir);
    const file = path.join(base, `${name}.db`);
    if (!fs.existsSync(file)) return null;
    if (native && closeDatabase) {
      try { closeDatabase(name); } catch { /* já fechado, ou nunca chegou a abrir */ }
    }
    const dest = path.join(base, `${name}.corrupt-${nowMs}.db`);
    fs.renameSync(file, dest);
    if (native) moveWalSidecars(file, dest, name, logger);
    logger.warn(`[Context] "${name}": arquivo corrompido guardado de lado (.corrupt-*.db, apagado em 48 h); o próximo início recria o banco.`);
    return dest;
  } catch (renameErr) {
    logger.warn(`[Context] "${name}": não consegui guardar o arquivo corrompido de lado: ${String(renameErr?.message ?? renameErr).slice(0, 100)}`);
    return null;
  }
}

/**
 * Apaga da pasta de bancos os arquivos em quarentena com mais de `maxAgeMs` (idade pela última gravação; 0 = todos).
 * Nunca lança. Devolve quantos apagou.
 */
export function purgeCorruptContextFiles({ nowMs = Date.now(), maxAgeMs = CORRUPT_KEEP_MS, dir = null, logger = defaultLogger } = {}) {
  let removed = 0;
  try {
    const base = dir ? path.resolve(dir) : path.resolve(config.database.dir);
    if (!fs.existsSync(base)) return 0;
    for (const file of fs.readdirSync(base)) {
      if (!CORRUPT_FILE_RE.test(file)) continue;
      const full = path.join(base, file);
      try {
        const stat = fs.statSync(full);
        if (!stat.isFile()) continue;
        if (maxAgeMs > 0 && nowMs - stat.mtimeMs <= maxAgeMs) continue;
        fs.unlinkSync(full);
        removed++;
      } catch (err) {
        logger.warn(`[Context] não consegui apagar o arquivo em quarentena: ${String(err?.message ?? err).slice(0, 100)}`);
      }
    }
  } catch (err) {
    logger.warn(`[Context] limpeza da quarentena falhou: ${String(err?.message ?? err).slice(0, 100)}`);
  }
  if (removed) logger.info(`[Context] ${removed} arquivo(s) corrompido(s) em quarentena apagado(s).`);
  return removed;
}

// APAGAR DE VERDADE: um DELETE comum do SQLite só marca as páginas como livres e o texto continua legível dentro do
// arquivo. `secure_delete` zera o conteúdo apagado. O sql.js volta os pragmas ao padrão a cada export() (a cada gravação
// no disco), então ele é ligado DENTRO de cada transação de escrita, antes dos DELETE. (No motor nativo o pragma fica
// ligado na conexão; religar a cada transação não muda nada e mantém um código só.) Depois de apagar a pedido, o
// VACUUM reconstrói o arquivo e elimina de vez as páginas livres.
function secureDelete(db) {
  db.prepare('PRAGMA secure_delete = ON').run();
}
function vacuum(db) {
  try {
    db.prepare('VACUUM').run();
  } catch {
    // o texto já foi zerado pelo secure_delete; o VACUUM só reduz o arquivo
  }
}

// MOTOR NATIVO (WAL): cada escrita acrescenta ao -wal a versão NOVA das páginas, e as versões ANTIGAS continuam lá até o
// checkpoint. O secure_delete e o VACUUM zeram o texto na versão nova, mas a antiga, com o texto, segue legível no -wal (e
// um checkpoint comum não encolhe o -wal: os bytes antigos ficam até serem sobrescritos). O checkpoint TRUNCATE copia para o
// .db as páginas atuais (já sem o texto) e deixa o -wal com 0 byte. O -shm é só o índice do -wal (números de página).
// Devolve false se o -wal não pôde ser esvaziado (outra conexão lendo naquele instante).
function checkpointWal(db) {
  try {
    const row = db.prepare('PRAGMA wal_checkpoint(TRUNCATE)').get();
    return Number(row?.busy ?? 0) === 0;
  } catch {
    return false;
  }
}

/** Abre um arquivo de contexto. Devolve null (=> só RAM) se não conseguir; nunca lança. */
async function openDbSink({ dbApi, name, logger }) {
  try {
    await dbApi.initDatabase(name, SCHEMA);
    const db = dbApi.getDbWrapper(name);
    db.prepare('SELECT COUNT(*) AS n FROM context_turns').get(); // arquivo corrompido falha aqui
    // Só no motor nativo: esvazia o -wal depois de apagar (veja checkpointWal). No sql.js não há -wal e nada roda.
    let lastWalWarn = 0;
    const flushWal = () => {
      if (dbApi.getDatabaseEngine?.(name) !== 'native') return;
      if (checkpointWal(db)) return;
      const t = Date.now();
      if (t - lastWalWarn < 10 * 60_000) return;
      lastWalWarn = t;
      logger.warn(`[Context] "${name}": não consegui esvaziar o -wal depois de apagar (outra conexão lendo?); a próxima limpeza tenta de novo.`);
    };
    return {
      name,
      load() {
        return {
          scopes: db.prepare('SELECT scope_key, user_id, channel_id, guild_id, created_at, updated_at FROM context_scopes').all(),
          turns: db.prepare('SELECT scope_key, role, content, at FROM context_turns ORDER BY at ASC, id ASC').all(),
        };
      },
      /** Troca TODAS as falas do fio de uma vez (uma transação = uma reescrita do arquivo). */
      replaceScope(meta, turns) {
        const dropped = db.transaction(() => {
          secureDelete(db);
          const before = db.prepare('DELETE FROM context_turns WHERE scope_key = ?').run(meta.key).changes;
          db.prepare(
            `INSERT INTO context_scopes (scope_key, user_id, channel_id, guild_id, personal, created_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?)
             ON CONFLICT(scope_key) DO UPDATE SET updated_at = excluded.updated_at`
          ).run(meta.key, meta.userId, meta.channelId, meta.guildId, meta.personal ? 1 : 0, meta.createdAt, meta.updatedAt);
          for (const t of turns) {
            db.prepare('INSERT INTO context_turns (scope_key, role, content, at) VALUES (?, ?, ?, ?)').run(meta.key, t.role, t.content, t.at);
          }
          // `turns` = as falas antigas que ficaram + a troca nova (2 falas). Saíram mais falas do que voltaram: alguma fala
          // antiga deixou o fio (limite de falas/caracteres ou prazo) e o texto dela não pode ficar no -wal.
          return before > turns.length - 2;
        })();
        if (dropped) flushWal();
      },
      deleteScopes(keys) {
        if (!keys.length) return;
        db.transaction(() => {
          secureDelete(db);
          for (const key of keys) {
            db.prepare('DELETE FROM context_turns WHERE scope_key = ?').run(key);
            db.prepare('DELETE FROM context_scopes WHERE scope_key = ?').run(key);
          }
        })();
        vacuum(db); // apagar de verdade: também limpa páginas livres que algum DELETE antigo possa ter deixado
        flushWal();
      },
      /** Apaga do disco as falas mais velhas que o corte e os fios que ficaram vazios. */
      purge(cutoffMs) {
        const removed = db.transaction(() => {
          secureDelete(db);
          const n = db.prepare('DELETE FROM context_turns WHERE at < ?').run(cutoffMs).changes;
          db.prepare('DELETE FROM context_scopes WHERE scope_key NOT IN (SELECT DISTINCT scope_key FROM context_turns)').run();
          return n;
        })();
        if (removed > 0) vacuum(db);
        flushWal(); // nativo: a limpeza horária esvazia o -wal mesmo sem apagar nada agora (rede de segurança)
        return removed;
      },
    };
  } catch (err) {
    const msg = String(err?.message ?? err);
    logger.warn(`[Context] "${name}" indisponível, seguindo só em RAM: ${msg.slice(0, 160)}`);
    // A trava do db.js (banco VÁLIDO no formato do motor nativo aberto pelo sql.js) nunca é corrupção; e o caminho do arquivo
    // sai da mensagem antes do teste, para uma pasta com "corrupt" ou "encrypted" no nome não mandar um banco bom à quarentena.
    const semCaminho = msg.replace(/"(?:[A-Za-z]:[\\/]|[\\/])[^"]*"/g, '"…"');
    // A recusa por DONO (cérebro e bot separados: banco de outro processo, trava com outro dono) também nunca é corrupção.
    if (!NEVER_CORRUPT_CODES.has(err?.code) && CORRUPT_RE.test(semCaminho)) {
      // Arquivo corrompido: guarda de lado para o próximo início começar limpo. O nome novo casa com o .gitignore
      // (memory-*.db) e a limpeza apaga a quarentena depois de 48 h. No nativo fecha o banco antes e leva -wal/-shm junto.
      quarantineCorruptContextFile(name, { native: usesNativeEngine(dbApi, name), closeDatabase: dbApi.closeDatabase, logger });
    }
    return null;
  }
}

/** Abre os dois arquivos (público e pessoal). Cada um pode falhar sozinho (null => RAM). */
export async function createDbBackends({ logger = defaultLogger } = {}) {
  let dbApi;
  try {
    dbApi = await import('../../database/db.js');
  } catch (err) {
    logger.warn(`[Context] banco indisponível, seguindo só em RAM: ${String(err?.message ?? err).slice(0, 160)}`);
    return { public: null, personal: null };
  }
  return {
    public: await openDbSink({ dbApi, name: DB_NAMES.public, logger }),
    personal: await openDbSink({ dbApi, name: DB_NAMES.personal, logger }),
  };
}

// ───────────────────────────── O store ─────────────────────────────

/**
 * @param {object} [o]
 * @param {() => number} [o.now]     relógio (injetável nos testes)
 * @param {object} [o.env]           onde ler TTL/limites (a cada operação)
 * @param {object} [o.backends]      { public, personal } com load/replaceScope/deleteScopes/purge; null => só RAM
 */
export function createContextStore({ now = Date.now, env = process.env, logger = defaultLogger, backends = null } = {}) {
  /** @type {Map<string, {key:string, personal:boolean, userId:string, channelId:?string, guildId:?string, createdAt:number, updatedAt:number, turns:Array}>} */
  const scopes = new Map();
  let sinks = backends ?? { public: null, personal: null };
  let lastWriteWarn = 0;

  const budget = () => ({ maxChars: contextMaxChars(env), maxTurns: contextMaxTurns(env) });
  const prune = (turns, nowMs) => pruneTurns(turns, { nowMs, ttlMs: contextTtlMs(env), ...budget() });
  const sinkOf = (scope) => (scope.personal ? sinks.personal : sinks.public);

  function warnWrite(err) {
    const t = Date.now();
    if (t - lastWriteWarn < 60_000) return; // sem enxurrada de aviso se o disco estiver cheio
    lastWriteWarn = t;
    logger.warn(`[Context] falha ao gravar no disco (a conversa segue em RAM): ${String(err?.message ?? err).slice(0, 120)}`);
  }

  function persist(scope) {
    const sink = sinkOf(scope);
    if (!sink) return;
    try {
      sink.replaceScope(
        { key: scope.key, userId: scope.userId, channelId: scope.channelId, guildId: scope.guildId, personal: scope.personal, createdAt: scope.createdAt, updatedAt: scope.updatedAt },
        scope.turns
      );
    } catch (err) {
      warnWrite(err);
    }
  }

  function dropFromDisk(keysBySink) {
    for (const [sink, keys] of keysBySink) {
      if (!sink || !keys.length) continue;
      try { sink.deleteScopes(keys); } catch (err) { warnWrite(err); }
    }
  }

  function removeScopes(list) {
    const bySink = new Map();
    let turns = 0;
    for (const scope of list) {
      turns += scope.turns.length;
      scopes.delete(scope.key);
      const sink = sinkOf(scope);
      if (!bySink.has(sink)) bySink.set(sink, []);
      bySink.get(sink).push(scope.key);
    }
    dropFromDisk(bySink);
    return { scopes: list.length, turns };
  }

  return {
    /** Troca os arquivos (o singleton só os abre depois, de forma preguiçosa). */
    attach(next) {
      sinks = next ?? { public: null, personal: null };
    },

    /** Lê o que está no disco e já descarta o que venceu. */
    load() {
      const t = now();
      let loadedTurns = 0;
      for (const [kind, sink] of [['public', sinks.public], ['personal', sinks.personal]]) {
        if (!sink) continue;
        let rows;
        try {
          rows = sink.load();
        } catch (err) {
          logger.warn(`[Context] não consegui ler "${sink.name}": ${String(err?.message ?? err).slice(0, 120)}`);
          if (kind === 'public') sinks = { ...sinks, public: null }; else sinks = { ...sinks, personal: null };
          continue;
        }
        const byKey = new Map();
        for (const s of rows.scopes) {
          byKey.set(s.scope_key, {
            key: s.scope_key, personal: kind === 'personal', userId: String(s.user_id),
            channelId: s.channel_id ?? null, guildId: s.guild_id ?? null,
            createdAt: Number(s.created_at), updatedAt: Number(s.updated_at), turns: [],
          });
        }
        for (const r of rows.turns) {
          const scope = byKey.get(r.scope_key);
          if (scope) scope.turns.push({ role: r.role, content: r.content, at: Number(r.at) });
        }
        const gone = [];
        for (const scope of byKey.values()) {
          scope.turns = prune(scope.turns, t);
          if (scope.turns.length === 0) { gone.push(scope.key); continue; }
          scopes.set(scope.key, scope);
          loadedTurns += scope.turns.length;
        }
        if (gone.length) { try { sink.deleteScopes(gone); } catch (err) { warnWrite(err); } }
      }
      return { scopes: scopes.size, turns: loadedTurns };
    },

    /** Histórico pronto para o campo `history` dos provedores ([{role, content}], começa por user, alterna). */
    read(key) {
      const scope = scopes.get(key);
      if (!scope) return [];
      const turns = prune(scope.turns, now());
      if (turns.length === 0) { scopes.delete(key); return []; }
      scope.turns = turns; // só RAM: o disco é acertado na próxima troca ou na limpeza horária
      return turns.map(({ role, content }) => ({ role, content }));
    },

    /**
     * Grava UMA troca (fala do usuário + resposta) de uma vez. `assistantText` pode ser ERROR_MARKER.
     * Devolve true se gravou.
     */
    record(target, { userText, assistantText, userAt = null, assistantAt = null } = {}) {
      if (!target?.active || target.record === false || !target.key) return false;
      const { maxChars } = budget();
      const user = clipUserText(userText, Math.min(LIMITS.userChars, Math.floor(maxChars * 0.4)));
      const assistant = clipAssistantText(assistantText, Math.min(LIMITS.assistantChars, Math.floor(maxChars * 0.5)));
      if (!user || !assistant) return false;
      const t = now();
      let scope = scopes.get(target.key);
      if (scope && scope.personal !== (target.personal === true)) {
        removeScopes([scope]); // o canal virou privado (ou deixou de ser): o fio recomeça no arquivo certo
        scope = null;
      }
      if (!scope) {
        scope = {
          key: target.key, personal: target.personal === true, userId: target.userId,
          channelId: target.channelId ?? null, guildId: target.guildId ?? null, createdAt: t, updatedAt: t, turns: [],
        };
        scopes.set(scope.key, scope);
      }
      const userAtMs = Number.isFinite(userAt) ? Math.min(userAt, t) : t;
      // `assistantAt` (cérebro separado): o MESMO instante da fala, para a troca ficar junta na ordem do disco (at, id) mesmo quando a
      // resposta é gravada depois da mensagem seguinte da pessoa ter chegado. Sem ele, como sempre: o instante da gravação.
      const assistantAtMs = Number.isFinite(assistantAt) ? Math.max(userAtMs, Math.min(assistantAt, t)) : t;
      scope.turns.push({ role: 'user', content: user, at: userAtMs }, { role: 'assistant', content: assistant, at: assistantAtMs });
      scope.updatedAt = t;
      scope.turns = prune(scope.turns, t);
      if (scope.turns.length === 0) { removeScopes([scope]); return false; } // nada cabe no orçamento: não guarda fio vazio
      persist(scope);
      return true;
    },

    /**
     * A troca deste alvo já está no fio? (a fala do usuário com o MESMO instante e o MESMO texto, depois do mesmo corte de tamanho que a
     * gravação usa). É a chave natural de um turno: o instante é o da mensagem do Discord. Vale depois de um reinício (o fio veio do disco).
     */
    hasExchange(target, { userText, userAt = null } = {}) {
      if (!target?.active || !target.key || !Number.isFinite(userAt)) return false;
      const scope = scopes.get(target.key);
      if (!scope) return false;
      const { maxChars } = budget();
      const user = clipUserText(userText, Math.min(LIMITS.userChars, Math.floor(maxChars * 0.4)));
      const at = Math.min(userAt, now());
      return scope.turns.some((t) => t.role === 'user' && t.at === at && t.content === user);
    },

    /** Direito de exclusão: apaga todos os fios de uma pessoa (DM e canais, público e pessoal). */
    forgetUser(userId) {
      const id = String(userId);
      return removeScopes([...scopes.values()].filter((s) => s.userId === id));
    },

    /** Saída de servidor: apaga os fios daquele servidor. */
    /** `keepPersonal`: fios marcados como memória pessoal ficam (a saída de um servidor não apaga o que é da pessoa). */
    forgetGuild(guildId, { keepPersonal = false } = {}) {
      const id = String(guildId);
      return removeScopes([...scopes.values()].filter((s) => s.guildId === id && !(keepPersonal && s.personal)));
    },

    forgetKey(key) {
      const scope = scopes.get(key);
      return scope ? removeScopes([scope]) : { scopes: 0, turns: 0 };
    },

    /** Limpeza (a cada hora): falas vencidas saem da RAM e do disco. */
    purgeExpired() {
      const t = now();
      let removedTurns = 0;
      let removedScopes = 0;
      for (const scope of [...scopes.values()]) {
        const before = scope.turns.length;
        const turns = prune(scope.turns, t);
        if (turns.length === before) continue;
        removedTurns += before - turns.length;
        if (turns.length === 0) { scopes.delete(scope.key); removedScopes++; } else { scope.turns = turns; }
      }
      const cutoff = t - contextTtlMs(env);
      for (const sink of [sinks.public, sinks.personal]) {
        if (!sink) continue;
        try { sink.purge(cutoff); } catch (err) { warnWrite(err); }
      }
      return { turns: removedTurns, scopes: removedScopes };
    },

    /** Só números (auditoria e painel). */
    counts() {
      let turns = 0;
      let personal = 0;
      for (const s of scopes.values()) { turns += s.turns.length; if (s.personal) personal++; }
      return { scopes: scopes.size, turns, personalScopes: personal, persisted: { public: Boolean(sinks.public), personal: Boolean(sinks.personal) } };
    },
  };
}

// ───────────────────────────── Instância única (inicialização PREGUIÇOSA) ─────────────────────────────

let defaultStore = null;
let initPromise = null;
let purgeTimer = null;

// ── Cérebro separado (etapa 3): os arquivos de contexto são do CÉREBRO ──
// O bot com YUI_CEREBRO_EXTERNO=true instala aqui o pedido ao cérebro ({ forgetUser(userId), forgetGuild(guildId) }, que
// devolvem { scopes, turns }). Com ele: o apagar-tudo e a saída de servidor vão ao cérebro pelo canal, e este processo nunca
// abre os arquivos de contexto (o store fica só em RAM). A leitura e a gravação do contexto por horas são do cérebro (etapa 5): a conversa
// do Discord vira um turno do cérebro (chat.turn/chat.commit, src/cerebro/conversa.js) e o bot nunca lê nem grava falas aqui.
let contextRemote = null;
export function setContextRemote(remote) {
  contextRemote = remote && typeof remote.forgetUser === 'function' && typeof remote.forgetGuild === 'function' ? remote : null;
}
export function isContextRemote() {
  return contextRemote !== null;
}

export function getContextStore() {
  if (!defaultStore) defaultStore = createContextStore({});
  return defaultStore;
}

function startPurgeTimer(store) {
  if (purgeTimer) return;
  purgeTimer = setInterval(() => {
    if (!jobAllowed('cleanup.context')) return;
    try {
      const r = store.purgeExpired();
      if (r.turns > 0) defaultLogger.info(`[Context] limpeza horária: ${r.turns} fala(s) vencida(s) removida(s).`);
      purgeCorruptContextFiles();
    } catch (err) {
      defaultLogger.warn(`[Context] limpeza horária falhou: ${String(err?.message ?? err).slice(0, 120)}`);
    }
  }, HOUR_MS);
  purgeTimer.unref?.(); // nunca segura o processo vivo
}

/** Abre os arquivos e carrega as falas ainda válidas. Idempotente e NUNCA lança (na dúvida, fica só em RAM). */
export function initContextStore() {
  if (!initPromise) {
    initPromise = (async () => {
      const store = getContextStore();
      if (contextRemote) {
        store.attach(null); // os arquivos são do cérebro: este processo fica só em RAM e não agenda a limpeza deles
        return store;
      }
      try {
        purgeCorruptContextFiles(); // quarentena velha de uma partida anterior
        store.attach(await createDbBackends({ logger: defaultLogger }));
        const loaded = store.load();
        defaultLogger.info(`[Context] pronto: ${loaded.scopes} conversa(s) ativa(s), ${loaded.turns} fala(s).`);
      } catch (err) {
        defaultLogger.warn(`[Context] início falhou, seguindo só em RAM: ${String(err?.message ?? err).slice(0, 160)}`);
        store.attach(null);
      }
      startPurgeTimer(store);
      return store;
    })();
  }
  return initPromise;
}

/** Histórico do alvo para o campo `history`. Contexto pessoal só sai em chamada sensível. */
export function readContextTurns(target, { sensitive = false } = {}) {
  if (!target?.active || !defaultStore) return [];
  if (target.personal && sensitive !== true) return [];
  try {
    return defaultStore.read(target.key);
  } catch (err) {
    defaultLogger.warn(`[Context] leitura falhou: ${String(err?.message ?? err).slice(0, 120)}`);
    return [];
  }
}

/** Grava uma troca. Nunca lança (o contexto jamais pode derrubar uma resposta). */
export function recordContextExchange(target, payload) {
  if (!target?.active || !defaultStore) return false;
  try {
    return defaultStore.record(target, payload);
  } catch (err) {
    defaultLogger.warn(`[Context] gravação falhou: ${String(err?.message ?? err).slice(0, 120)}`);
    return false;
  }
}

/**
 * Grava uma troca UMA vez (cérebro separado, etapa 5: o chat.commit do turno). Com `userAt` (o instante da mensagem do Discord), uma troca
 * que já está no fio não entra de novo, nem depois de um reinício (o fio é relido do disco). A gravação em si é uma transação só (a fala e a
 * resposta juntas). Nunca lança. Devolve { recorded, duplicate }.
 */
export function recordContextExchangeOnce(target, payload = {}) {
  if (!target?.active || !defaultStore) return { recorded: false, duplicate: false };
  try {
    if (Number.isFinite(payload.userAt) && defaultStore.hasExchange(target, payload)) return { recorded: false, duplicate: true };
    return { recorded: defaultStore.record(target, payload), duplicate: false };
  } catch (err) {
    defaultLogger.warn(`[Context] gravação falhou: ${String(err?.message ?? err).slice(0, 120)}`);
    return { recorded: false, duplicate: false };
  }
}

/**
 * Apaga todos os fios de uma pessoa (usado pelo `/yui-memoria apagar-tudo`). Funciona mesmo com o recurso desligado
 * se houver arquivo de contexto no disco; sem recurso e sem arquivo não cria nada.
 */
export async function forgetUserContext(userId) {
  if (!userId) return { scopes: 0, turns: 0 };
  if (contextRemote) return contextRemote.forgetUser(String(userId)); // o cérebro é o dono dos arquivos (pode lançar: quem chama trata)
  // Arquivo corrompido guardado de lado pode ter falas dela e ninguém o lê mais: no apagar-tudo some inteiro (não espera as 48 h).
  purgeCorruptContextFiles({ maxAgeMs: 0 });
  if (!contextEnabled() && !contextFilesExist() && !defaultStore) return { scopes: 0, turns: 0 };
  const store = await initContextStore();
  return store.forgetUser(userId);
}

/** Chamado na saída de servidor (events/guildDelete.js): apaga só o contexto do servidor, nunca o de memória pessoal. */
export async function forgetGuildContext(guildId) {
  if (!guildId) return { scopes: 0, turns: 0 };
  if (contextRemote) return contextRemote.forgetGuild(String(guildId));
  if (!contextEnabled() && !contextFilesExist() && !defaultStore) return { scopes: 0, turns: 0 };
  const store = await initContextStore();
  return store.forgetGuild(guildId, { keepPersonal: true });
}

export function purgeExpiredContext() {
  purgeCorruptContextFiles();
  return defaultStore ? defaultStore.purgeExpired() : { turns: 0, scopes: 0 };
}

export function contextCounts() {
  return defaultStore ? defaultStore.counts() : { scopes: 0, turns: 0, personalScopes: 0, persisted: { public: false, personal: false } };
}
