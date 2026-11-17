import { audit } from '../audit.js';
import { buildContext, POLICY_STATES } from '../permissions.js';
import { getPolicyEngine } from './policyEngine.js';
import { ORIGINS } from './permissionMatrix.js';

/**
 * Guarda das INTERAÇÕES do Discord (Fase 1): comandos, botões, menus e modais que gravam, banem, configuram ou
 * baixam. Um único ponto (o início de `events/interactionCreate.js`) liga cada interação a uma ação da matriz.
 *  - YUI_POLICY_MODE=observe (padrão): só registra `policy.evaluate`; nada muda para o usuário.
 *  - YUI_POLICY_MODE=enforce: DENY (somente leitura, papel ou origem) e CRITICAL (só no computador da Yui)
 *    respondem com mensagem privada e a interação não executa. ASK segue (o próprio fluxo já confirma).
 * Interação que não está na tabela não é avaliada.
 */

// Comandos de barra -> ação. Para /yui-criador a ação depende do subcomando.
const SLASH = {
  'yui-servidor': 'admin.guild_configure',
  'yui-ferramentas': 'admin.guild_configure',
  'yui-configurar': 'admin.guild_configure',
  'yui-seguir-youtube': 'admin.follow_social',
  'yui-seguir-twitch': 'admin.follow_social',
  'yui-parar-seguir': 'admin.follow_social',
  'yui-config_ia': 'admin.ai_configure',
  'yui-imagem': 'chat.generate_image',
  'baixar_musica': 'media.download',
  'baixar_video': 'media.download',
  'baixar_musica_atual': 'media.download',
};
const CRIADOR_SUB = { banir: 'admin.ban_user', desbanir: 'admin.ban_user', memorias: 'memory.admin_inspect', bot_config: 'admin.bot_config' };

// customId (prefixo) -> ação, só para o que muda algo (a navegação de painéis não é avaliada).
const CUSTOM_ID = [
  ['adm_remoteban_', 'admin.ban_user'],
  ['adm_manageguild_leave_', 'admin.guild_configure'],
  ['banlist_unban_', 'admin.ban_user'],
  ['unban_', 'admin.ban_user'],
  ['keepban_', 'admin.ban_user'],
  ['crtcfg_modal_ban', 'admin.ban_user'],
  ['crtcfg_', 'admin.guild_configure'],
  ['cfgpanel_toggle_', 'admin.bot_config'],
  ['cfgmodal_', 'admin.bot_config'],
  ['srvcfg_', 'admin.guild_configure'],
  ['srvmcp_', 'admin.guild_configure'],
  ['tos_decline', 'admin.guild_configure'],
  ['compress_video_', 'media.download'],
];

/** @param {{ kind: 'slash'|'component', name?: string, sub?: string|null, customId?: string }} data */
export function actionForInteraction({ kind, name = '', sub = null, customId = '' } = {}) {
  if (kind === 'slash') {
    if (name === 'yui-criador') return (sub && CRIADOR_SUB[sub]) || 'admin.guild_configure';
    return Object.hasOwn(SLASH, name) ? SLASH[name] : null;
  }
  for (const [prefix, action] of CUSTOM_ID) if (String(customId).startsWith(prefix)) return action;
  return null;
}

/**
 * @returns {null | { message: string }} null = segue; senão a mensagem privada a mostrar (a interação NÃO executa).
 */
export function guardInteraction({ data, userId, channelId = null, guildId = null, isDM = false, guildAdmin = false, engine = getPolicyEngine(), auditFn = audit } = {}) {
  try {
    const action = actionForInteraction(data);
    if (!action) return null;
    const ctx = buildContext({ platform: 'discord', userId, channelId, guildId, isDM });
    const origin = isDM ? ORIGINS.DISCORD_DM : ORIGINS.DISCORD_GUILD;
    // O código antigo decide dentro de cada handler (dono, ManageGuild...): para o motor, legacy = allow.
    const { decision, enforced, verdict } = engine.gate({ action, ctx, origin, guildAdmin, legacy: 'allow', target: data.customId || data.name });
    if (!enforced) return null;
    if (decision === POLICY_STATES.DENY) {
      try { auditFn('policy.interaction_blocked', ctx, { action, origin, decision, reason: verdict?.reason ?? null }); } catch { /* */ }
      return { message: '🛑 Isso não é permitido pela política de segurança da Yui neste momento.' };
    }
    if (decision === POLICY_STATES.CRITICAL) {
      try { auditFn('policy.interaction_blocked', ctx, { action, origin, decision, reason: 'ação crítica exige aprovação local' }); } catch { /* */ }
      return { message: '🔐 Ação crítica: só pode ser feita no computador da Yui, não pelo Discord.' };
    }
    return null;
  } catch {
    return null; // o guarda nunca derruba uma interação
  }
}

// Ferramentas que a IA pode chamar por conversa -> ação da matriz (ia_automod tem o próprio modo review: propõe, o dono decide).
const LLM_TOOLS = {
  download_audio: 'media.download',
  download_video: 'media.download',
  search_and_download_music: 'media.download',
  generate_image: 'chat.generate_image',
};

/** Guarda das ferramentas chamadas pela IA na conversa. Mesmo contrato de guardInteraction (null = segue). */
export function guardToolCall({ tool, userId, channelId = null, guildId = null, isDM = false, guildAdmin = false, engine = getPolicyEngine(), auditFn = audit } = {}) {
  try {
    const action = Object.hasOwn(LLM_TOOLS, tool) ? LLM_TOOLS[tool] : null;
    if (!action) return null;
    const ctx = buildContext({ platform: 'discord', userId, channelId, guildId, isDM });
    const origin = isDM ? ORIGINS.DISCORD_DM : ORIGINS.DISCORD_GUILD;
    const { decision, enforced, verdict } = engine.gate({ action, ctx, origin, guildAdmin, legacy: 'allow', target: tool });
    if (!enforced || decision === POLICY_STATES.AUTO || decision === POLICY_STATES.ASK) return null;
    try { auditFn('policy.interaction_blocked', ctx, { action, origin, decision, reason: verdict?.reason ?? null, tool }); } catch { /* */ }
    return { message: decision === POLICY_STATES.CRITICAL ? '🔐 Ação crítica: só pode ser feita no computador da Yui.' : '🛑 Isso não é permitido pela política de segurança da Yui neste momento.' };
  } catch {
    return null;
  }
}
