// Fachada da memória que o bot do Discord usa (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §2 e §4).
//
//  - PROCESSO ÚNICO (o padrão): cada função chama o store.js direto e devolve o MESMO valor de sempre, de forma síncrona.
//    `await` num valor que não é promessa não muda nada, então os pontos de chamada com `await` funcionam igual.
//  - CÉREBRO SEPARADO (YUI_CEREBRO_EXTERNO=true no bot): o bot instala o cliente do canal com setMemoryRemote(). A memória é
//    do cérebro (dono dos bancos memory-*): cada função vira um pedido pelo canal (memory.recall, memory.remember...) e
//    devolve uma PROMESSA. Se o cérebro estiver fora, a promessa é recusada com o código MEMORY_UNAVAILABLE e uma mensagem
//    clara; quem chama trata como "memória indisponível agora" e a conversa segue sem memória.
//
// O contexto vai pelo canal só com os dados de origem (plataforma, pessoa, servidor, canal, DM, bloqueado). O cérebro
// MONTA o contexto de novo (papel, tipo de canal e escopo da memória) com as regras dele: o bot não escolhe escopo.
// As funções puras (retenção, formatação) continuam locais: dependem só do ambiente, que é o mesmo nos dois processos.
import crypto from 'node:crypto';
import * as store from './store.js';
import { CHANNEL_KINDS, ROLES } from '../permissions.js';
import { authorizeAdminWipe, confirmacaoParaCanal } from './adminWipe.js';

export * from './store.js';

export const MEMORY_UNAVAILABLE = 'MEMORY_UNAVAILABLE';
export const MEMORY_UNAVAILABLE_TEXT = 'Memória indisponível agora: o cérebro da Yui não está conectado. Tente de novo daqui a pouco.';
/** Códigos do canal que significam "o cérebro não está lá" (e não um erro do pedido em si). */
const UNAVAILABLE_CODES = new Set(['NOT_CONNECTED', 'CONNECTION_LOST', 'TIMEOUT', 'CLOSED', 'SECRET_UNAVAILABLE', 'BUSY']);

let remote = null;

/**
 * Liga (cliente do canal, com `request(método, parâmetros, opções)`) ou desliga (null) a memória remota.
 * Só o bot com o cérebro separado chama isto.
 */
export function setMemoryRemote(client) {
  remote = client && typeof client.request === 'function' ? client : null;
}

/** A memória deste processo está no cérebro (pedido pelo canal)? */
export function isMemoryRemote() {
  return remote !== null;
}

/** Os dados de ORIGEM do contexto (o cérebro remonta papel, tipo de canal e escopo com as regras dele). */
export function wireContext(ctx) {
  if (!ctx?.userId) throw new Error('Contexto sem userId.');
  return {
    platform: ctx.platform || 'discord',
    userId: String(ctx.userId),
    guildId: ctx.guildId ? String(ctx.guildId) : null,
    channelId: ctx.channelId ? String(ctx.channelId) : null,
    isDM: ctx.channelKind === CHANNEL_KINDS.DM,
    isBlocked: ctx.role === ROLES.BLOCKED,
  };
}

function unavailable(cause) {
  const err = new Error(MEMORY_UNAVAILABLE_TEXT);
  err.code = MEMORY_UNAVAILABLE;
  err.cause = cause;
  return err;
}

/** Pedido ao cérebro. Pedidos com efeito levam chave de idempotência (contrato do canal, §4). */
async function ask(method, params, { effect = false } = {}) {
  const client = remote;
  if (!client) throw unavailable(null);
  try {
    return await client.request(method, params, effect ? { idem: `${method}:${crypto.randomUUID()}` } : {});
  } catch (err) {
    if (UNAVAILABLE_CODES.has(err?.code)) throw unavailable(err);
    const out = new Error(String(err?.message ?? err ?? 'Erro na memória.'));
    out.code = typeof err?.code === 'string' ? err.code : 'MEMORY_ERROR';
    throw out;
  }
}

export function recall(ctx, query, { limit = 8, type = null } = {}) {
  if (!remote) return store.recall(ctx, query, { limit, type });
  return ask('memory.recall', { ctx: wireContext(ctx), query: String(query ?? ''), limit, type });
}

export function remember(ctx, item = {}) {
  if (!remote) return store.remember(ctx, item);
  const { type = 'fact', content, tags = [], source = '', importance = 1 } = item;
  return ask('memory.remember', { ctx: wireContext(ctx), type, content: String(content ?? ''), tags: [].concat(tags).map(String), source: String(source ?? ''), importance }, { effect: true });
}

export function forget(ctx, id) {
  if (!remote) return store.forget(ctx, id);
  return ask('memory.forget', { ctx: wireContext(ctx), id: Number(id) }, { effect: true });
}

export function forgetAll(ctx) {
  if (!remote) return store.forgetAll(ctx);
  return ask('memory.forgetAll', { ctx: wireContext(ctx) }, { effect: true });
}

export function listMemories(ctx, { limit = 50 } = {}) {
  if (!remote) return store.listMemories(ctx, { limit });
  return ask('memory.list', { ctx: wireContext(ctx), limit });
}

export function touchUser(ctx, { minIntervalMs = 0, onlyExisting = false } = {}) {
  if (!remote) return store.touchUser(ctx, { minIntervalMs, onlyExisting });
  return ask('memory.touch', { ctx: wireContext(ctx), minIntervalMs, onlyExisting }, { effect: true }).then(() => undefined);
}

/** A limpeza diária roda no processo dono da memória (o cérebro); o bot com o cérebro separado não a agenda. */
export function purgeExpired() {
  if (!remote) return store.purgeExpired();
  throw new Error('A limpeza da memória roda no cérebro (dono dos bancos de memória), não no bot.');
}

// ── Administração (somente o dono; o cérebro confere o papel de novo) ──
export function adminListUsers(ctx, { limit = 25 } = {}) {
  if (!remote) return store.adminListUsers(ctx, { limit });
  return ask('memory.adminListUsers', { ctx: wireContext(ctx), limit });
}

export function adminListMetadata(ctx, userId, { limit = 25 } = {}) {
  if (!remote) return store.adminListMetadata(ctx, userId, { limit });
  return ask('memory.adminListMetadata', { ctx: wireContext(ctx), userId: String(userId), limit });
}

export function adminListContent(ctx, userId, { limit = 100 } = {}) {
  if (!remote) return store.adminListContent(ctx, userId, { limit });
  return ask('memory.adminListContent', { ctx: wireContext(ctx), userId: String(userId), limit });
}

// Apagar a memória de OUTRA pessoa (memory.admin_wipe_user): só o dono, com a confirmação explícita do alvo
// (`{ confirmacao: { alvo, via } }`), pela política e com auditoria, igual nos dois modos (adminWipe.js). No processo único a
// regra roda aqui, antes do store; com o cérebro separado, no cérebro (dono da memória), que não confia no bot.
export function adminForget(ctx, userId, id, { confirmacao = null } = {}) {
  if (!remote) {
    authorizeAdminWipe({ ctx, alvo: userId, confirmacao, item: Number(id) || null });
    return store.adminForget(ctx, userId, id);
  }
  return ask('memory.adminForget', { ctx: wireContext(ctx), userId: String(userId), id: Number(id), confirmacao: confirmacaoParaCanal(confirmacao) }, { effect: true });
}

export function adminForgetUser(ctx, userId, { confirmacao = null } = {}) {
  if (!remote) {
    authorizeAdminWipe({ ctx, alvo: userId, confirmacao });
    return store.adminForgetUser(ctx, userId);
  }
  return ask('memory.adminForgetUser', { ctx: wireContext(ctx), userId: String(userId), confirmacao: confirmacaoParaCanal(confirmacao) }, { effect: true });
}
