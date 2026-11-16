import crypto from 'crypto';
import { audit } from '../audit.js';
import { ROLES } from '../permissions.js';
import { ORIGINS } from './permissionMatrix.js';

/**
 * Tickets de aprovação (Fase 1, especificação §3 e §4).
 *
 * Toda ação que precisa de um "sim" humano vira um ApprovalPlan imutável. O ticket:
 *  - tem validade (CRITICAL 60 s, ASK 120 s) e vale UMA vez: ao ser consumido vira CONSUMED no mesmo tick;
 *  - guarda o hash SHA-256 canônico dos parâmetros. Na hora de executar, `consume()` recalcula o hash com o que
 *    realmente vai ser executado: qualquer diferença de um caractere cancela o ticket (adulteração);
 *  - leva uma assinatura HMAC feita com uma chave que só existe na memória deste processo;
 *  - nível CRITICAL só pode ser aprovado por origem LOCAL_PC (canal local autenticado). Pedido vindo da API,
 *    do Tailscale ou do Discord é recusado e registrado como violação;
 *  - ticket expirado, recusado ou consumido não volta a valer (replay): o id fica guardado por 1 hora só para
 *    reconhecer a tentativa.
 * Tudo é auditado (`policy.approval_created`, `policy.approved`, `policy.rejected`, `policy.expired`,
 * `policy.enacted`, `policy.violation`). A decisão de QUAL nível uma ação exige é do motor de políticas.
 */

export const LEVELS = Object.freeze({ ASK: 'ASK', CRITICAL: 'CRITICAL' });
export const TTL_MS = Object.freeze({ ASK: 120_000, CRITICAL: 60_000 });
export const STATUS = Object.freeze({ PENDING: 'PENDING', APPROVED: 'APPROVED', REJECTED: 'REJECTED', EXPIRED: 'EXPIRED', CONSUMED: 'CONSUMED' });
const POLICY_VERSION = '1.0.0';
const RETAIN_MS = 60 * 60 * 1000;
const MAX_RETAINED = 2000;

export class ApprovalError extends Error {
  constructor(message, status = 400, code = 'ERRO') {
    super(message);
    this.name = 'ApprovalError';
    this.status = status;
    this.code = code;
  }
}

/** JSON determinístico: chaves em ordem alfabética (recursivo), sem campos indefinidos. */
export function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value === undefined ? null : value);
  if (Array.isArray(value)) return `[${value.map((v) => canonicalJson(v)).join(',')}]`;
  return `{${Object.keys(value).filter((k) => value[k] !== undefined).sort().map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
}

export const hashParams = (params) => crypto.createHash('sha256').update(canonicalJson(params ?? {})).digest('hex');

const clip = (s, n) => String(s ?? '').slice(0, n);
const clone = (v) => JSON.parse(JSON.stringify(v ?? {}));

export function createApprovalManager({ auditFn = audit, now = () => Date.now(), key = crypto.randomBytes(32) } = {}) {
  const records = new Map(); // id -> { ticket, sig, waiters, timer }
  const stats = { created: 0, approved: 0, rejected: 0, expired: 0, consumed: 0, violations: 0 };

  const sign = (t) => crypto.createHmac('sha256', key).update([t.id, t.action, t.paramsHash, t.levelRequired, t.expiresAt, t.requesterId, t.requesterOrigin].join('|')).digest('hex');
  const ctxOf = (t) => ({ userId: t.requesterId ?? null, role: t.requesterRole ?? null, platform: 'policy', channelKind: null });
  const view = (t) => ({
    id: t.id, policyVersion: t.policyVersion, createdAt: t.createdAt, expiresAt: t.expiresAt, requesterId: t.requesterId, requesterRole: t.requesterRole,
    requesterOrigin: t.requesterOrigin, sessionId: t.sessionId, action: t.action, canonicalTarget: t.canonicalTarget, paramsHash: t.paramsHash,
    levelRequired: t.levelRequired, allowedApprovalOrigin: t.allowedApprovalOrigin, summary: t.summary, preview: t.preview, status: t.status,
    approvedAt: t.approvedAt, approverId: t.approverId, approverOrigin: t.approverOrigin,
  });

  function violation(ticket, violationType, extra = {}) {
    stats.violations += 1;
    try {
      auditFn('policy.violation', ticket ? ctxOf(ticket) : null, { approvalId: ticket?.id ?? extra.approvalId ?? null, action: ticket?.action ?? null, violationType, attemptedOrigin: extra.attemptedOrigin ?? null });
    } catch { /* auditoria nunca derruba a política */ }
  }

  function settle(rec) {
    clearTimeout(rec.timer);
    const v = view(rec.ticket);
    for (const resolve of rec.waiters.splice(0)) resolve(v);
  }

  function prune() {
    const t = now();
    for (const [id, rec] of records) {
      if (rec.ticket.status !== STATUS.PENDING && t - (rec.settledAt ?? t) > RETAIN_MS) records.delete(id);
    }
    if (records.size > MAX_RETAINED) {
      for (const [id, rec] of records) {
        if (records.size <= MAX_RETAINED) break;
        if (rec.ticket.status !== STATUS.PENDING) records.delete(id);
      }
    }
  }

  function expire(rec) {
    if (rec.ticket.status !== STATUS.PENDING && rec.ticket.status !== STATUS.APPROVED) return;
    rec.ticket.status = STATUS.EXPIRED;
    rec.settledAt = now();
    stats.expired += 1;
    try { auditFn('policy.expired', ctxOf(rec.ticket), { approvalId: rec.ticket.id, action: rec.ticket.action, timeoutMs: rec.ticket.expiresAt - rec.ticket.createdAt }); } catch { /* */ }
    settle(rec);
  }

  /**
   * Abre um ticket PENDING.
   * @param {{ action: string, params?: object, level: 'ASK'|'CRITICAL', requester?: object, origin?: string, sessionId?: string, canonicalTarget?: string, summary?: string, preview?: string }} plan
   */
  function request(plan) {
    const level = plan?.level;
    if (!Object.values(LEVELS).includes(level)) throw new ApprovalError('nível de aprovação inválido', 400, 'NIVEL');
    if (!plan.action || typeof plan.action !== 'string') throw new ApprovalError('ação ausente', 400, 'ACAO');
    prune();
    const t0 = now();
    const params = clone(plan.params);
    const ticket = {
      id: crypto.randomUUID(),
      policyVersion: POLICY_VERSION,
      createdAt: t0,
      expiresAt: t0 + TTL_MS[level],
      requesterId: plan.requester?.userId ?? null,
      requesterRole: plan.requester?.role ?? null,
      requesterOrigin: plan.origin ?? null,
      sessionId: plan.sessionId ?? null,
      action: plan.action,
      canonicalTarget: clip(plan.canonicalTarget, 500),
      paramsHash: hashParams(params),
      levelRequired: level,
      allowedApprovalOrigin: level === LEVELS.CRITICAL ? 'LOCAL_ONLY' : 'ANY_OWNER_CHANNEL',
      summary: clip(plan.summary, 300),
      preview: clip(plan.preview, 2000),
      status: STATUS.PENDING,
      approvedAt: null,
      approverId: null,
      approverOrigin: null,
      consumptionNonce: null,
    };
    const rec = { ticket, sig: sign(ticket), waiters: [], timer: null, settledAt: null };
    rec.timer = setTimeout(() => expire(rec), TTL_MS[level]);
    rec.timer.unref?.();
    records.set(ticket.id, rec);
    stats.created += 1;
    try { auditFn('policy.approval_created', ctxOf(ticket), { approvalId: ticket.id, action: ticket.action, paramsHash: ticket.paramsHash, expiresAt: ticket.expiresAt, levelRequired: level }); } catch { /* */ }
    return view(ticket);
  }

  /** Resolve quando o ticket deixa de estar PENDING (aprovado, recusado ou expirado). */
  function waitFor(id) {
    const rec = records.get(String(id));
    if (!rec) return Promise.reject(new ApprovalError('ticket inexistente', 404, 'NAO_EXISTE'));
    if (rec.ticket.status !== STATUS.PENDING) return Promise.resolve(view(rec.ticket));
    return new Promise((resolve) => rec.waiters.push(resolve));
  }

  /**
   * Aprova ou recusa. CRITICAL só é aprovado por origem LOCAL_PC; recusar é permitido de qualquer origem do dono.
   * @param {{ approve: boolean, approverId?: string, approverRole?: string, approverOrigin?: string }} decision
   */
  function decide(id, { approve, approverId = null, approverRole = null, approverOrigin = null } = {}) {
    const rec = records.get(String(id));
    if (!rec) { violation(null, 'ticket_desconhecido', { approvalId: String(id).slice(0, 64), attemptedOrigin: approverOrigin }); throw new ApprovalError('Esse pedido de aprovação não existe (ou já foi descartado).', 404, 'NAO_EXISTE'); }
    const t = rec.ticket;
    if (t.status === STATUS.PENDING && now() >= t.expiresAt) expire(rec);
    if (t.status !== STATUS.PENDING) {
      violation(t, t.status === STATUS.EXPIRED ? 'ticket_expirado' : 'ticket_replay', { attemptedOrigin: approverOrigin });
      throw new ApprovalError(t.status === STATUS.EXPIRED ? 'Esse pedido de aprovação expirou.' : 'Esse pedido de aprovação já foi respondido.', t.status === STATUS.EXPIRED ? 410 : 409, t.status);
    }
    if (approverRole !== ROLES.OWNER) { violation(t, 'aprovador_nao_e_dono', { attemptedOrigin: approverOrigin }); throw new ApprovalError('Só o dono pode aprovar.', 403, 'PAPEL'); }
    if (approve && t.levelRequired === LEVELS.CRITICAL && approverOrigin !== ORIGINS.LOCAL_PC) {
      violation(t, 'aprovacao_critica_fora_do_pc', { attemptedOrigin: approverOrigin });
      throw new ApprovalError('Aprovação crítica só vale no computador da Yui (use o comando yui-aprovar).', 403, 'ORIGEM');
    }
    t.status = approve ? STATUS.APPROVED : STATUS.REJECTED;
    t.approvedAt = approve ? now() : null;
    t.approverId = approverId;
    t.approverOrigin = approverOrigin;
    if (approve) stats.approved += 1; else stats.rejected += 1;
    try { auditFn(approve ? 'policy.approved' : 'policy.rejected', { userId: approverId, role: approverRole, platform: 'policy', channelKind: null }, { approvalId: t.id, action: t.action, approverId, approverRole, approverOrigin, ...(approve ? {} : { reason: 'recusado' }) }); } catch { /* */ }
    if (!approve) rec.settledAt = now();
    settle(rec);
    return view(t);
  }

  /**
   * Usa a aprovação para executar AGORA, uma única vez. Confere de novo ação e parâmetros.
   * Síncrono de propósito: verificar e marcar CONSUMED acontece no mesmo tick (sem corrida).
   * @returns {{ ok: true, nonce: string } | { ok: false, reason: string }}
   */
  function consume(id, { action, params } = {}) {
    const rec = records.get(String(id));
    if (!rec) { violation(null, 'ticket_desconhecido', { approvalId: String(id).slice(0, 64) }); return { ok: false, reason: 'aprovação inexistente' }; }
    const t = rec.ticket;
    if (t.status === STATUS.APPROVED && now() >= t.expiresAt) expire(rec);
    if (t.status !== STATUS.APPROVED) {
      if (t.status === STATUS.CONSUMED || t.status === STATUS.REJECTED || t.status === STATUS.EXPIRED) violation(t, t.status === STATUS.CONSUMED ? 'ticket_replay' : 'ticket_nao_aprovado');
      return { ok: false, reason: t.status === STATUS.CONSUMED ? 'aprovação já usada' : t.status === STATUS.EXPIRED ? 'aprovação expirada' : 'sem aprovação válida' };
    }
    if (!crypto.timingSafeEqual(Buffer.from(rec.sig), Buffer.from(sign(t)))) {
      t.status = STATUS.REJECTED; rec.settledAt = now(); violation(t, 'assinatura_invalida');
      return { ok: false, reason: 'ticket adulterado' };
    }
    if (String(action) !== t.action || hashParams(clone(params)) !== t.paramsHash) {
      t.status = STATUS.REJECTED; rec.settledAt = now(); violation(t, 'parametros_adulterados');
      return { ok: false, reason: 'o que seria executado difere do que foi aprovado' };
    }
    t.status = STATUS.CONSUMED;
    t.consumptionNonce = crypto.randomUUID();
    rec.settledAt = now();
    stats.consumed += 1;
    return { ok: true, nonce: t.consumptionNonce };
  }

  /** Registra a execução concluída (ligada ao ticket consumido). */
  function enacted(id, { executionTimeMs = null, exitCode = null } = {}) {
    const rec = records.get(String(id));
    if (!rec) return;
    try { auditFn('policy.enacted', ctxOf(rec.ticket), { approvalId: rec.ticket.id, action: rec.ticket.action, executionTimeMs, exitCode }); } catch { /* */ }
  }

  /** Recusa tudo que ainda está pendente de uma sessão (execução cancelada ou terminada). */
  function cancelPending(sessionId) {
    let n = 0;
    for (const rec of records.values()) {
      if (rec.ticket.sessionId === sessionId && rec.ticket.status === STATUS.PENDING) {
        rec.ticket.status = STATUS.REJECTED; rec.settledAt = now(); stats.rejected += 1; n += 1;
        try { auditFn('policy.rejected', ctxOf(rec.ticket), { approvalId: rec.ticket.id, action: rec.ticket.action, reason: 'sessão encerrada' }); } catch { /* */ }
        settle(rec);
      }
    }
    return n;
  }

  /** Cópias para exibição (sem os parâmetros brutos). */
  function list({ status = STATUS.PENDING } = {}) {
    prune();
    const out = [];
    for (const rec of records.values()) {
      if (rec.ticket.status === STATUS.PENDING && now() >= rec.ticket.expiresAt) expire(rec);
      if (!status || rec.ticket.status === status) out.push(view(rec.ticket));
    }
    return out.sort((a, b) => a.createdAt - b.createdAt);
  }

  const get = (id) => { const rec = records.get(String(id)); return rec ? view(rec.ticket) : null; };

  return { request, waitFor, decide, consume, enacted, cancelPending, list, get, stats: () => ({ ...stats }), verifySignature: (id) => { const rec = records.get(String(id)); return Boolean(rec) && rec.sig === sign(rec.ticket); } };
}

let shared = null;
/** Gerenciador único do processo (o canal local e o módulo Código usam o mesmo). */
export function getApprovalManager() {
  shared ??= createApprovalManager();
  return shared;
}
export function resetApprovalManagerForTests() {
  shared = null;
}
