import legacyConfig from '../config/index.js';

/**
 * Camada de permissões da Yui Core.
 *
 * Regra de ouro: a autoridade vem SEMPRE do backend (ID do usuário reportado
 * pela plataforma + configuração do servidor). Nada que o LLM ou o texto da
 * mensagem diga altera o papel ou o escopo de memória de alguém.
 */

export const ROLES = Object.freeze({
  OWNER: 'OWNER',
  TRUSTED: 'TRUSTED',
  MEMBER: 'MEMBER',
  GUEST: 'GUEST',
  BLOCKED: 'BLOCKED',
});

const ROLE_RANK = { BLOCKED: 0, GUEST: 1, MEMBER: 2, TRUSTED: 3, OWNER: 4 };

/** Tipos de canal reconhecidos. Só 'dm' e 'private' liberam a memória pessoal. */
export const CHANNEL_KINDS = Object.freeze({
  DM: 'dm',
  PRIVATE: 'private',
  PUBLIC: 'public',
});

export const MEMORY_SCOPES = Object.freeze({
  PERSONAL: 'personal',
  PUBLIC: 'public',
});

function csv(value) {
  return (value || '').split(',').map((v) => v.trim()).filter(Boolean);
}

const trustedIds = () => new Set(csv(process.env.YUI_TRUSTED_IDS));
const privateChannelIds = () => new Set(csv(process.env.YUI_PRIVATE_CHANNEL_IDS));

export function isOwnerId(userId) {
  if (!userId) return false;
  const id = String(userId);
  return id === process.env.YUI_OWNER_ID || Boolean(legacyConfig.isOwner(id));
}

/**
 * Resolve o papel de um usuário. `isBlocked` deve vir do sistema de bans
 * existente (banHandler) — o Core não duplica essa lista.
 */
export function resolveRole(userId, { isBlocked = false } = {}) {
  if (!userId) return ROLES.GUEST;
  if (isOwnerId(userId)) return ROLES.OWNER; // o dono nunca é bloqueado por engano
  if (isBlocked) return ROLES.BLOCKED;
  if (trustedIds().has(String(userId))) return ROLES.TRUSTED;
  return ROLES.MEMBER;
}

/**
 * Classifica o canal. DM é sempre privado; canais só contam como privados
 * se estiverem em YUI_PRIVATE_CHANNEL_IDS (decisão do dono, não da IA).
 */
export function resolveChannelKind({ isDM = false, channelId = null } = {}) {
  if (isDM) return CHANNEL_KINDS.DM;
  if (channelId && privateChannelIds().has(String(channelId))) return CHANNEL_KINDS.PRIVATE;
  return CHANNEL_KINDS.PUBLIC;
}

/** Escopo de memória permitido para este papel + canal. */
export function resolveMemoryScope(role, channelKind) {
  if (role === ROLES.OWNER && channelKind !== CHANNEL_KINDS.PUBLIC) {
    return MEMORY_SCOPES.PERSONAL;
  }
  return MEMORY_SCOPES.PUBLIC;
}

/**
 * Monta o contexto de execução de uma requisição. É o único objeto que o
 * restante do Core aceita para decidir acesso; ele não deve ser montado a
 * partir de dados vindos do prompt.
 */
export function buildContext({ platform, userId, channelId = null, guildId = null, isDM = false, isBlocked = false }) {
  const role = resolveRole(userId, { isBlocked });
  const channelKind = resolveChannelKind({ isDM, channelId });
  return Object.freeze({
    platform: platform || 'unknown',
    userId: userId ? String(userId) : null,
    channelId: channelId ? String(channelId) : null,
    guildId: guildId ? String(guildId) : null,
    role,
    channelKind,
    memoryScope: resolveMemoryScope(role, channelKind),
  });
}

// ──────────────────────────── Ferramentas ────────────────────────────

const toolPolicies = new Map();

/**
 * Registra a política de uma ferramenta. Ferramentas sem política são
 * NEGADAS (default deny).
 *
 * @param {string} name
 * @param {{ minRole?: string, privateOnly?: boolean, confirm?: boolean }} policy
 *   - minRole: papel mínimo (padrão OWNER)
 *   - privateOnly: exige DM/canal privado (padrão true a partir de TRUSTED)
 *   - confirm: exige confirmação explícita do usuário antes de executar
 */
/**
 * O que a ferramenta FAZ ao computador (declarado por quem registra):
 *  - read:    só lê/consulta (informações do sistema, busca de arquivos).
 *  - open:    abre uma pasta/projeto da allowlist no editor ou explorador.
 *  - execute: inicia programas (um programa pode alterar arquivos).
 *  - write:   cria, altera, move ou apaga arquivos/dados.
 *
 * Quem NÃO declara é tratado como "write" (o mais restritivo): ferramenta
 * nova nunca escapa do modo somente leitura por esquecimento.
 */
export const TOOL_ACCESS = Object.freeze({ READ: 'read', OPEN: 'open', EXECUTE: 'execute', WRITE: 'write' });
const VALID_ACCESS = new Set(Object.values(TOOL_ACCESS));

/**
 * MODO SOMENTE LEITURA — LIGADO POR PADRÃO (desligue só com YUI_READ_ONLY=false).
 * Enquanto ligado, o backend nega qualquer ferramenta "execute" ou "write",
 * para qualquer papel (inclusive o dono), antes de rodar qualquer coisa.
 */
export function isReadOnlyMode() {
  return String(process.env.YUI_READ_ONLY ?? 'true').trim().toLowerCase() !== 'false';
}

export function registerToolPolicy(name, { minRole = ROLES.OWNER, privateOnly, confirm = false, access = TOOL_ACCESS.WRITE } = {}) {
  toolPolicies.set(name, {
    minRole,
    privateOnly: privateOnly ?? ROLE_RANK[minRole] >= ROLE_RANK.TRUSTED,
    confirm,
    access: VALID_ACCESS.has(access) ? access : TOOL_ACCESS.WRITE,
  });
}

/** Remove todas as políticas de ferramentas (usado por clearTools e testes). */
export function clearToolPolicies() {
  toolPolicies.clear();
}

export function getToolPolicy(name) {
  return toolPolicies.get(name) || null;
}

/** @returns {{ allowed: boolean, reason?: string, confirm?: boolean }} */
export function checkToolAccess(ctx, toolName) {
  const policy = toolPolicies.get(toolName);
  if (!policy) return { allowed: false, reason: 'ferramenta sem política registrada' };
  if (ctx.role === ROLES.BLOCKED || ROLE_RANK[ctx.role] === undefined) {
    return { allowed: false, reason: 'usuário bloqueado' };
  }
  if (ROLE_RANK[ctx.role] < ROLE_RANK[policy.minRole]) {
    return { allowed: false, reason: `requer papel ${policy.minRole}` };
  }
  if (policy.privateOnly && ctx.channelKind === CHANNEL_KINDS.PUBLIC) {
    return { allowed: false, reason: 'ferramenta só disponível em DM/canal privado' };
  }
  if (isReadOnlyMode() && (policy.access === TOOL_ACCESS.WRITE || policy.access === TOOL_ACCESS.EXECUTE)) {
    return { allowed: false, reason: 'modo somente leitura: esta ferramenta pode alterar arquivos' };
  }
  return { allowed: true, confirm: policy.confirm };
}

/** Lista as ferramentas visíveis para o contexto (use para montar o payload do LLM). */
export function listAllowedTools(ctx) {
  return [...toolPolicies.keys()].filter((name) => checkToolAccess(ctx, name).allowed);
}
