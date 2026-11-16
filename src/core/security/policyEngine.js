import crypto from 'crypto';
import { audit } from '../audit.js';
import { CHANNEL_KINDS, isReadOnlyMode, POLICY_STATES, ROLES } from '../permissions.js';
import { canonicalAction, COLUMNS, MATRIX, ORIGINS, STRICTNESS, stricter } from './permissionMatrix.js';

/**
 * Motor unificado de políticas (Fase 1): UMA decisão para qualquer interface.
 *
 *   evaluate({ action, role, origin, guildAdmin }) -> AUTO | ASK | CRITICAL | DENY
 *
 * Precedência (especificação §6): 1) somente leitura vence sempre; 2) a matriz; 3) o dono pode APERTAR
 * por categoria (POLICY_<CATEGORIA>_AUTONOMY), nunca afrouxar; 4) o que não está na matriz é negado.
 *
 * MODO ATUAL: OBSERVAÇÃO (YUI_POLICY_MODE=observe, padrão). `observe()` decide, compara com o que o
 * código antigo decidiu e REGISTRA na auditoria (`policy.evaluate`), mas NÃO muda nada do que acontece.
 * Serve para ver onde o motor discorda do comportamento atual ANTES de passar a impor as regras.
 * `YUI_POLICY_MODE=off` desliga o registro.
 */

const LEGACY = { allow: POLICY_STATES.AUTO, ask: POLICY_STATES.ASK, deny: POLICY_STATES.DENY };

/** Contexto do Core (permissions.buildContext) + origem -> origem confiável do motor. */
export function originFor({ platform, channelKind, local } = {}) {
  if (platform === 'discord') return channelKind === CHANNEL_KINDS.PUBLIC ? ORIGINS.DISCORD_GUILD : ORIGINS.DISCORD_DM;
  return local ? ORIGINS.LOCAL_PC : ORIGINS.REMOTE;
}

function columnFor({ role, origin, guildAdmin }) {
  if (role === ROLES.OWNER) {
    if (origin === ORIGINS.LOCAL_PC) return 'OWNER_LOCAL';
    if (origin === ORIGINS.REMOTE) return 'OWNER_REMOTE';
    if (origin === ORIGINS.DISCORD_DM) return 'OWNER_DM';
    if (origin === ORIGINS.DISCORD_GUILD) return guildAdmin ? 'ADMIN_GUILD' : 'MEMBER';
    return null;
  }
  if (role === ROLES.BLOCKED || !Object.values(ROLES).includes(role)) return null;
  return origin === ORIGINS.DISCORD_GUILD && guildAdmin ? 'ADMIN_GUILD' : 'MEMBER';
}

function hashTarget(target) {
  return target ? crypto.createHash('sha256').update(String(target)).digest('hex').slice(0, 16) : null;
}

export function createPolicyEngine({ env = process.env, auditFn = audit, readOnly = isReadOnlyMode } = {}) {
  const counters = { total: 0, stricter: 0, looser: 0, unknown: 0, byAction: Object.create(null) };

  /** Tabela ação×papel×origem -> decisão. Nunca lança erro. */
  function evaluate({ action, role, origin, guildAdmin = false } = {}) {
    const name = canonicalAction(action);
    const row = name ? MATRIX.get(name) : null;
    if (!row) return { decision: POLICY_STATES.DENY, reason: 'ação desconhecida (negada por padrão)', action: name ?? String(action ?? ''), known: false };
    const column = columnFor({ role, origin, guildAdmin });
    if (!column || !COLUMNS.includes(column)) return { decision: POLICY_STATES.DENY, reason: 'papel ou origem não reconhecidos', action: name, column, known: true };

    if (row.modifies && readOnly()) return { decision: POLICY_STATES.DENY, reason: 'modo somente leitura', action: name, column, known: true, modifies: true };

    let decision = row.decisions[column];
    let reason = decision === POLICY_STATES.DENY ? 'a matriz nega esta ação para este papel/origem' : null;
    const wanted = String(env[`POLICY_${row.category}_AUTONOMY`] ?? '').trim().toUpperCase();
    if (wanted && Object.hasOwn(STRICTNESS, wanted)) {
      const tightened = stricter(decision, wanted);
      if (tightened !== decision) { decision = tightened; reason = `categoria ${row.category} apertada pelo dono (${wanted})`; }
    }
    return { decision, reason, action: name, column, known: true, modifies: row.modifies };
  }

  /**
   * Compara com a decisão do código atual e registra. Nunca lança e nunca altera o fluxo.
   * @param {{ action: string, ctx: object, origin?: string, guildAdmin?: boolean, legacy: 'allow'|'ask'|'deny', target?: string }} req
   */
  function observe({ action, ctx, origin, guildAdmin = false, legacy, target = null }) {
    try {
      if (String(env.YUI_POLICY_MODE ?? 'observe').trim().toLowerCase() === 'off') return null;
      if (!canonicalAction(action)) return null; // ações ainda fora da matriz não são avaliadas
      const verdict = evaluate({ action, role: ctx?.role, origin: origin ?? originFor({ platform: ctx?.platform, channelKind: ctx?.channelKind }), guildAdmin });
      const old = LEGACY[legacy] ?? null;
      let diverges = null;
      if (old && old !== verdict.decision) diverges = STRICTNESS[verdict.decision] > STRICTNESS[old] ? 'motor mais restritivo' : 'motor mais permissivo';
      counters.total += 1;
      counters.byAction[verdict.action] = (counters.byAction[verdict.action] ?? 0) + 1;
      if (diverges === 'motor mais restritivo') counters.stricter += 1;
      if (diverges === 'motor mais permissivo') counters.looser += 1;
      if (!verdict.known) counters.unknown += 1;
      auditFn('policy.evaluate', ctx, {
        action: verdict.action,
        decision: verdict.decision,
        legacy: old,
        diverges,
        origin: origin ?? originFor({ platform: ctx?.platform, channelKind: ctx?.channelKind }),
        column: verdict.column ?? null,
        reason: verdict.reason,
        targetHash: hashTarget(target),
        mode: 'observe',
      });
      return { ...verdict, legacy: old, diverges };
    } catch {
      return null;
    }
  }

  return { evaluate, observe, stats: () => JSON.parse(JSON.stringify(counters)) };
}

let shared = null;
/** Instância única do processo (usada pelo Agent e pelo módulo Código). */
export function getPolicyEngine() {
  shared ??= createPolicyEngine();
  return shared;
}

export function resetPolicyEngineForTests() {
  shared = null;
}
