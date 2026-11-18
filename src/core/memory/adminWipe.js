// Apagar a memória de OUTRA pessoa (`memory.admin_wipe_user`): as mesmas regras nos dois modos (etapa 4, decisão da Liz de
// 18/11/2026; docs/RELATORIO_ETAPA4_OPERACAO.md §5).
//
//  1. só o DONO (Braga) pode pedir: qualquer outro papel é recusado, nunca a pedido de outro usuário;
//  2. CONFIRMAÇÃO EXPLÍCITA DO USUÁRIO-ALVO: o pedido precisa trazer `confirmacao: { alvo: '<id>' }` com o MESMO id que vai ser
//     apagado (no Discord, o botão "Confirmar" do /yui-criador memorias carrega o id do alvo e só vale para quem pediu);
//  3. passa pelo MOTOR DE POLÍTICAS com a origem real (DM, servidor, PC, app): em `observe` (o padrão) só registra; em
//     `enforce`, DENY e CRITICAL recusam. Na matriz o dono tem ASK (permitido COM esta confirmação) e os outros papéis DENY;
//     com YUI_READ_ONLY=true a regra 1 da especificação ("somente leitura vence sempre") continua negando;
//  4. tudo vai para a AUDITORIA (pedido sem confirmação, recusa, autorização), só com metadados (nunca o conteúdo).
// Quem chama: no processo único, a fachada da memória (facade.js) antes do store; com o cérebro separado, o método do canal
// (src/cerebro/metodos.js) no cérebro, dono da memória. O painel (API) passa pelo routeGuard com a mesma ação e confirma do
// lado do app, como as outras rotas ASK.
import { audit } from '../audit.js';
import { POLICY_STATES, ROLES } from '../permissions.js';
import { getPolicyEngine, originFor } from '../security/policyEngine.js';

export const ADMIN_WIPE_ACTION = 'memory.admin_wipe_user';
export const CONFIRMACAO_NECESSARIA = 'CONFIRMACAO_NECESSARIA';
export const CONFIRMACAO_TEXTO = 'Confirme explicitamente o usuário-alvo antes de apagar a memória dele.';

export class AdminWipeError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'AdminWipeError';
    this.code = code;
  }
}

/** A confirmação nomeia exatamente o alvo? */
export function confirmacaoValida(confirmacao, alvo) {
  const target = String(alvo ?? '').trim();
  return Boolean(target) && Boolean(confirmacao) && typeof confirmacao === 'object' && String(confirmacao.alvo ?? '').trim() === target;
}

/** Só o necessário da confirmação para viajar pelo canal (sem nada além do alvo e de onde veio). */
export function confirmacaoParaCanal(confirmacao) {
  if (!confirmacao || typeof confirmacao !== 'object') return null;
  return { alvo: String(confirmacao.alvo ?? '').slice(0, 25), via: String(confirmacao.via ?? '').slice(0, 40) };
}

/**
 * Autoriza apagar a memória de outra pessoa. Lança AdminWipeError (FORBIDDEN, CONFIRMACAO_NECESSARIA, POLICY_DENIED,
 * POLICY_CRITICAL); devolve a decisão do motor quando pode seguir.
 * @param {{ ctx: object, alvo: string, confirmacao?: {alvo: string, via?: string}|null, item?: number|null, origin?: string,
 *           engine?: object, auditFn?: Function }} p
 */
export function authorizeAdminWipe({ ctx, alvo, confirmacao = null, item = null, origin, engine = getPolicyEngine(), auditFn = audit }) {
  const target = String(alvo ?? '').trim();
  const safeAudit = (event, data) => { try { auditFn(event, ctx, data); } catch { /* auditoria nunca derruba a decisão */ } };
  if (ctx?.role !== ROLES.OWNER) {
    safeAudit('memory.admin.wipe_recusado', { target, item, motivo: 'nao_e_o_dono' });
    throw new AdminWipeError('FORBIDDEN', 'Apenas o dono pode apagar a memória de outra pessoa.');
  }
  if (!confirmacaoValida(confirmacao, target)) {
    safeAudit('memory.admin.wipe_sem_confirmacao', { target, item });
    throw new AdminWipeError(CONFIRMACAO_NECESSARIA, CONFIRMACAO_TEXTO);
  }
  const resolvedOrigin = origin ?? originFor({ platform: ctx.platform, channelKind: ctx.channelKind });
  const { decision, enforced, verdict } = engine.gate({ action: ADMIN_WIPE_ACTION, ctx, origin: resolvedOrigin, legacy: 'allow', target });
  if (enforced && (decision === POLICY_STATES.DENY || decision === POLICY_STATES.CRITICAL)) {
    safeAudit('memory.admin.wipe_recusado', { target, item, motivo: 'politica', decision, reason: verdict?.reason ?? null });
    if (decision === POLICY_STATES.CRITICAL) throw new AdminWipeError('POLICY_CRITICAL', 'Ação crítica: só pode ser feita no computador da Yui.');
    throw new AdminWipeError('POLICY_DENIED', `Não permitido pela política de segurança (${verdict?.reason ?? 'política'}).`);
  }
  safeAudit('memory.admin.wipe_confirmado', { target, item, via: String(confirmacao.via ?? '').slice(0, 40) || null, origin: resolvedOrigin, decision, mode: enforced ? 'enforce' : 'observe' });
  return { decision, enforced };
}
