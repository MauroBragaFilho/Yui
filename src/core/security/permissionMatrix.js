import { POLICY_STATES } from '../permissions.js';

/**
 * Matriz canônica Ação × Papel × Origem do motor de políticas (Fase 1).
 * Fonte: docs/ESPECIFICACAO_MOTOR_POLITICAS_FASE1.md §1.2. Linhas com `proposed: true` NÃO estão na
 * especificação: são a proposta para as ferramentas que já existem no Agent e dependem de aprovação do dono.
 *
 * Colunas (nesta ordem em cada linha):
 *   OWNER_LOCAL   dono no próprio PC (canal local autenticado)
 *   OWNER_REMOTE  dono por API remota (Tailscale/rede local)
 *   OWNER_DM      dono no Discord, em DM ou canal privado
 *   ADMIN_GUILD   quem tem ManageGuild num canal público do Discord
 *   MEMBER        demais papéis (TRUSTED, MEMBER, GUEST) e o dono em canal público sem ManageGuild
 *
 * Códigos: A = AUTO, S = ASK, C = CRITICAL, D = DENY.
 * `modifies`: ação que grava, apaga, executa ou bane. Com YUI_READ_ONLY=true vira DENY, sempre.
 */

export const ORIGINS = Object.freeze({
  LOCAL_PC: 'LOCAL_PC',
  REMOTE: 'REMOTE',
  DISCORD_DM: 'DISCORD_DM',
  DISCORD_GUILD: 'DISCORD_GUILD',
});

export const COLUMNS = Object.freeze(['OWNER_LOCAL', 'OWNER_REMOTE', 'OWNER_DM', 'ADMIN_GUILD', 'MEMBER']);

const CODE = { A: POLICY_STATES.AUTO, S: POLICY_STATES.ASK, C: POLICY_STATES.CRITICAL, D: POLICY_STATES.DENY };

/** [ação, modifies, 'LRDAM em códigos', proposed?] */
const ROWS = [
  ['memory.read_own', false, 'AAAAA'],
  ['memory.forget_item', false, 'AAAAA'],
  // Apagar a PRÓPRIA memória hoje funciona também em somente leitura (é dado do usuário, não do computador): decisão a confirmar.
  ['memory.wipe_own', false, 'SSSSS'],
  ['memory.admin_inspect', false, 'AAADD'],
  ['memory.admin_wipe_user', true, 'CDDDD'],
  ['chat.generate_image', false, 'AAAAA'],
  ['chat.summarize', false, 'AAAAA'],
  ['radio.play_control', false, 'AAAAA'],
  ['radio.download_track', false, 'AAAAD'],
  ['admin.guild_configure', false, 'AAAAD'],
  ['admin.follow_social', false, 'AAASD'],
  ['admin.ban_user', true, 'AACDD'],
  ['dev.read_file_search', false, 'AAADD'],
  ['dev.write_apply_diff', true, 'CDDDD'],
  ['dev.run_terminal', true, 'CDDDD'],
  // Ferramentas do Agent que já existem (proposta):
  ['system.info', false, 'AAADD', true],
  ['files.search', false, 'AAADD', true],
  ['projects.open', false, 'AAADD', true],
  ['commands.list', false, 'AAADD', true],
  ['commands.run', true, 'CDDDD', true],
  ['apps.open', true, 'SSSDD', true],
  ['skills.use', false, 'AAADD', true],
  // Rotas da API (Fase 1, frente "API admin, BDS e memória"). Colunas OWNER_*: o painel é só do dono.
  ['memory.write_own', false, 'AAAAA', true],
  ['admin.ai_configure', true, 'SCDDD', true],     // chaves, provedores e baseUrl de IA: no PC pede confirmação; remoto (app) é crítico = negado
  ['admin.restart', true, 'SSDDD', true],
  ['admin.reminders_edit', false, 'AAADD', true],
  ['admin.discord_dm', false, 'AADDD', true],
  ['admin.gateway_reset', false, 'AADDD', true],
  ['media.download', false, 'AAAAA', true],   // baixar música/vídeo/torrent (temporários); hoje qualquer não banido
  ['admin.bot_config', true, 'SDSDD', true],    // painel global do bot (config.json): só o dono, no PC ou em DM
  // Tarefas automáticas do processo (jobGuard.js): origem LOCAL_PC, papel dono. Só a manutenção altera o computador.
  ['job.publish', false, 'ADDDD', true],
  ['job.notify', false, 'ADDDD', true],
  ['job.data_cleanup', false, 'ADDDD', true],
  ['job.cleanup_files', false, 'ADDDD', true],
  ['job.maintenance', true, 'ADDDD', true],
  ['bds.read', false, 'AAADD', true],
  ['bds.write', true, 'SSDDD', true],
  ['bds.delete', true, 'SSDDD', true],
  ['bds.purge', true, 'SCDDD', true],              // apagar de vez: no PC pede confirmação; remoto (app) é crítico = negado
];

export const MATRIX = Object.freeze(new Map(ROWS.map(([action, modifies, codes, proposed = false]) => {
  const decisions = Object.fromEntries(COLUMNS.map((col, i) => [col, CODE[codes[i]]]));
  return [action, Object.freeze({ action, category: action.split('.')[0].toUpperCase(), modifies, decisions: Object.freeze(decisions), proposed })];
})));

/** Ferramentas e ações antigas -> ação canônica (as que não aparecem aqui não são avaliadas ainda). */
export const ACTION_ALIASES = Object.freeze({
  // Agent do chat
  'system.info': 'system.info',
  'files.search': 'files.search',
  'projects.open': 'projects.open',
  'apps.open': 'apps.open',
  'commands.list': 'commands.list',
  'commands.run': 'commands.run',
  // Módulo Código (ações do agente de desenvolvimento)
  'dev:list_dir': 'dev.read_file_search',
  'dev:read_file': 'dev.read_file_search',
  'dev:search_code': 'dev.read_file_search',
  'dev:web_search': 'dev.read_file_search',
  'dev:write_file': 'dev.write_apply_diff',
  'dev:apply_diff': 'dev.write_apply_diff',
  'dev:run_terminal': 'dev.run_terminal',
});

export function canonicalAction(name) {
  const key = String(name ?? '');
  if (MATRIX.has(key)) return key;
  return Object.hasOwn(ACTION_ALIASES, key) ? ACTION_ALIASES[key] : null;
}

/** Ordem de rigor: AUTO < ASK < CRITICAL < DENY. */
export const STRICTNESS = Object.freeze({ [POLICY_STATES.AUTO]: 0, [POLICY_STATES.ASK]: 1, [POLICY_STATES.CRITICAL]: 2, [POLICY_STATES.DENY]: 3 });
export const stricter = (a, b) => (STRICTNESS[a] >= STRICTNESS[b] ? a : b);
