import { audit } from '../audit.js';
import { POLICY_STATES } from '../permissions.js';
import { getPolicyEngine } from './policyEngine.js';
import { ORIGINS } from './permissionMatrix.js';

/**
 * Guarda das ROTAS HTTP da API que mudam estado (Fase 1, frente "API admin, BDS e memória").
 *
 * Cada rota (método + caminho) é ligada a uma ação da matriz. O motor decide com o papel do token e a origem
 * (LOCAL_PC ou REMOTE, por `isLocalRequest`).
 *  - YUI_POLICY_MODE=observe (padrão): só REGISTRA `policy.evaluate`; a rota segue exatamente como antes.
 *  - YUI_POLICY_MODE=enforce: DENY (inclui o modo somente leitura) vira 403; CRITICAL vira 403 "só no computador
 *    da Yui" (aprovação por ticket para rotas do painel é um passo futuro); ASK segue, porque o painel já confirma
 *    do lado do cliente (a decisão fica registrada na auditoria).
 * Rota que não está na tabela não é avaliada (leituras e rotas de outros módulos).
 */

const ROUTES = [
  // memória do próprio usuário
  ['POST', /^\/v1\/memory$/, 'memory.write_own'],
  ['DELETE', /^\/v1\/memory\/\d+$/, 'memory.forget_item'],
  ['DELETE', /^\/v1\/memory$/, 'memory.wipe_own'],
  // administração (só dono)
  ['PUT', /^\/v1\/admin\/guilds\/\d+\/channels$/, 'admin.guild_configure'],
  ['POST', /^\/v1\/admin\/guilds\/\d+\/automod$/, 'admin.guild_configure'],
  ['PUT', /^\/v1\/admin\/guilds\/\d+\/mcp-tools\/[a-z0-9_]+$/, 'admin.guild_configure'],
  ['POST', /^\/v1\/admin\/guilds\/\d+\/mcp-tools\/reset$/, 'admin.guild_configure'],
  ['POST', /^\/v1\/admin\/guilds\/\d+\/tos$/, 'admin.guild_configure'],
  ['DELETE', /^\/v1\/admin\/guilds\/\d+\/tos$/, 'admin.guild_configure'],
  ['PUT', /^\/v1\/admin\/guilds\/\d+\/channels\/\d+\/(persona|espontaneo)$/, 'admin.guild_configure'],
  ['DELETE', /^\/v1\/admin\/guilds\/\d+\/channels\/\d+\/persona$/, 'admin.guild_configure'],
  ['PUT', /^\/v1\/admin\/guilds\/\d+\/mentions$/, 'admin.guild_configure'],
  ['POST', /^\/v1\/admin\/guilds\/\d+\/(youtube|twitch)$/, 'admin.follow_social'],
  ['PUT', /^\/v1\/admin\/guilds\/\d+\/youtube\/[\w-]+\/\d+$/, 'admin.follow_social'],
  ['DELETE', /^\/v1\/admin\/guilds\/\d+\/(youtube|twitch)\/[\w-]+\/\d+$/, 'admin.follow_social'],
  ['POST', /^\/v1\/admin\/bans$/, 'admin.ban_user'],
  ['DELETE', /^\/v1\/admin\/bans\/(user|guild|channel)\/\d+$/, 'admin.ban_user'],
  ['GET', /^\/v1\/admin\/memory\/users\/\d+$/, 'memory.admin_inspect'],
  ['DELETE', /^\/v1\/admin\/memory\/users\/\d+(\/\d+)?$/, 'memory.admin_wipe_user'],
  ['POST', /^\/v1\/admin\/radio\/\d+$/, 'radio.play_control'],
  ['POST', /^\/v1\/admin\/reminders(\/\d+(\/snooze)?)?$/, 'admin.reminders_edit'],
  ['DELETE', /^\/v1\/admin\/reminders\/\d+$/, 'admin.reminders_edit'],
  ['DELETE', /^\/v1\/admin\/monitores\/\d+$/, 'admin.reminders_edit'], // etapa 16: cancelar um monitor de busca (mesma família dos lembretes)
  // lacunas do painel, item 12: apagar UM projeto ou decisão do dono (um item da memória PESSOAL dele, a mesma ação do DELETE /v1/memory/:id)
  ['DELETE', /^\/v1\/admin\/continuidade\/\d+$/, 'memory.forget_item'],
  // lacunas do painel, entrega E: aprovar ou recusar UM plano (item 3 v2, a mesma decidir() da DM) e entrar ou sair da live do YouTube (item 4 v2, o mesmo comando da conversa)
  ['POST', /^\/v1\/admin\/planos\/[^/]+\/decisao$/, 'admin.plan_decide'],
  ['POST', /^\/v1\/admin\/live\/(entrar|sair)$/, 'admin.live_control'],
  // lacunas do painel, entrega F, parte 2 (item 14): reautorizar o Google pelo painel (o início devolve só o link de consentimento; o retorno recebe o endereço
  // colado, troca o código e grava o arquivo da autorização no servidor). As duas pontas são a mesma ação: mexe com credencial.
  ['POST', /^\/v1\/admin\/google\/autorizar\/(inicio|retorno)$/, 'admin.google_reauth'],
  // correção C2 do parecer da Liz: pedir a chave de confirmação pela DM (aprovar plano, reautorizar o Google). Manda uma DM ao dono: a mesma família da DM de teste.
  ['POST', /^\/v1\/admin\/confirmacao\/pedir$/, 'admin.discord_dm'],
  // lacunas do painel, entrega E parte 2: republicar o GTA mais recente num servidor (item 9 v2; o canal configurado, as mesmas funções do agendador).
  // O rádio completo (item 10: iniciar, pular, tocar e escolher) usa o MESMO POST /v1/admin/radio/:guildId de sempre (radio.play_control, acima).
  ['POST', /^\/v1\/admin\/gta\/republicar$/, 'admin.gta_republish'],
  ['POST', /^\/v1\/admin\/morning\/send$/, 'admin.reminders_edit'],
  ['POST', /^\/v1\/admin\/ai\/(keys|providers\/[\w-]+|custom(\/[\w-]+\/(keys|options))?)$/, 'admin.ai_configure'],
  ['PUT', /^\/v1\/admin\/ai\/cloudflare$/, 'admin.ai_configure'],
  ['DELETE', /^\/v1\/admin\/ai\/(keys\/[\w-]+\/\d+|custom\/[\w-]+)$/, 'admin.ai_configure'],
  ['POST', /^\/v1\/admin\/ai\/test\/[\w-]+$/, 'admin.ai_configure'],
  // Configuração e chaves pelo painel (cofre de src/core/painelConfig.js): a mesma política das chaves de IA (no PC pede confirmação; remoto, a matriz decide).
  ['PUT', /^\/v1\/admin\/config\/[A-Z0-9_]{3,80}$/, 'admin.ai_configure'],
  ['DELETE', /^\/v1\/admin\/config\/[A-Z0-9_]{3,80}$/, 'admin.ai_configure'],
  ['POST', /^\/v1\/admin\/gateway\/reset$/, 'admin.gateway_reset'],
  ['POST', /^\/v1\/admin\/restart$/, 'admin.restart'],
  ['POST', /^\/v1\/admin\/ia\/rota-privada\/verificar$/, 'admin.ia_rota_privada'],
  ['POST', /^\/v1\/admin\/discord\/dm$/, 'admin.discord_dm'],
  // arquivos do BDS
  ['PUT', /^\/v1\/admin\/bds\/upload$/, 'bds.write'],
  ['POST', /^\/v1\/admin\/bds\/(mkdir|rename)$/, 'bds.write'],
  ['POST', /^\/v1\/admin\/bds\/(delete|restore)$/, 'bds.delete'],
  ['POST', /^\/v1\/admin\/bds\/purge$/, 'bds.purge'],
  ['GET', /^\/v1\/admin\/bds\/[\w/-]+$/, 'bds.read'],
  ['POST', /^\/v1\/admin\/bds\/link$/, 'bds.read'],
];

export function actionForRoute(method, pathname) {
  const m = String(method ?? '').toUpperCase();
  for (const [rm, re, action] of ROUTES) if (rm === m && re.test(pathname)) return action;
  return null;
}

/**
 * @returns {null | { status: number, body: object }} null = pode seguir; senão a resposta a devolver.
 */
export function guardRoute({ ctx, method, pathname, local = false, engine = getPolicyEngine(), auditFn = audit }) {
  const action = actionForRoute(method, pathname);
  if (!action) return null;
  const origin = local ? ORIGINS.LOCAL_PC : ORIGINS.REMOTE;
  // Hoje o código antigo libera a rota (as checagens de dono ficam dentro dos handlers): legacy = allow.
  const { decision, enforced, verdict } = engine.gate({ action, ctx, origin, legacy: 'allow', target: pathname });
  if (!enforced) return null;
  if (decision === POLICY_STATES.DENY) {
    const reason = verdict?.reason ?? 'política de segurança';
    try { auditFn('policy.route_blocked', ctx, { action, origin, reason, decision }); } catch { /* */ }
    return { status: 403, body: { error: `Não permitido pela política de segurança (${reason}).`, policy: { action, decision } } };
  }
  if (decision === POLICY_STATES.CRITICAL) {
    try { auditFn('policy.route_blocked', ctx, { action, origin, reason: 'ação crítica exige aprovação local', decision }); } catch { /* */ }
    return { status: 403, body: { error: 'Ação crítica: só pode ser feita no computador da Yui.', requiresLocalApproval: true, policy: { action, decision } } };
  }
  return null;
}
