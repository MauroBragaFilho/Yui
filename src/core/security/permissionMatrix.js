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
  // Apagar a memória de OUTRA pessoa (decisão da Liz, 18/11/2026): só o dono, COM a confirmação explícita do alvo
  // (core/memory/adminWipe.js; no Discord o botão do /yui-criador memorias; no painel a confirmação do app). Em enforce o dono
  // passa (ASK = segue com a confirmação); qualquer outro papel ou canal público é negado. Era 'CDDDD' (negado para todos fora
  // do PC). Continua `modifies`: com YUI_READ_ONLY=true a regra 1 (somente leitura vence sempre) segue negando.
  ['memory.admin_wipe_user', true, 'SSSDD'],
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
  ['admin.ia_rota_privada', true, 'SSDDD', true],  // pedir a nova verificação da rota privada de IA (uma sonda paga, sem conteúdo): só o dono; nunca desbloqueia direto
  ['admin.reminders_edit', false, 'AAADD', true],
  ['admin.discord_dm', false, 'AADDD', true],
  ['admin.gateway_reset', false, 'AADDD', true],
  ['media.download', false, 'AAAAA', true],   // baixar música/vídeo/torrent (temporários); hoje qualquer não banido
  ['admin.bot_config', true, 'SDSDD', true],    // painel global do bot (config.json): só o dono, no PC ou em DM
  // Lacunas do painel, entrega E (27/11/2026): aprovar ou recusar um plano (item 3 v2; a MESMA decidir() dos botões da DM) e entrar ou sair da live do YouTube
  // (item 4 v2; o MESMO comando da conversa). Só o dono, no PC ou pelo app; as regras são as do serviço. Sem `modifies` de propósito: os planos só leem, e "sair da
  // live" tem de funcionar sempre (inclusive em somente leitura), como na DM e no chat do app, que não passam por esta tabela.
  ['admin.plan_decide', false, 'AADDD', true],
  ['admin.live_control', false, 'AADDD', true],
  // Entrega E, parte 2 (item 9 v2): republicar o GTA mais recente num servidor (o canal configurado, a MESMA publicação do agendador, job.publish). Só o dono,
  // no PC ou pelo app. Sem `modifies`, como a publicação agendada: manda uma mensagem no Discord, não mexe no computador.
  ['admin.gta_republish', false, 'AADDD', true],
  // Entrega F, parte 2 (item 14): reautorizar o Google pelo painel (o início e o retorno). Só o dono, no PC ou pelo app (é para isso que existe: renovar sem o
  // script). ASK porque mexe com credencial: o painel confirma antes de começar, e a decisão fica na auditoria. Com `modifies`: grava o arquivo da autorização
  // no servidor, então o modo somente leitura (YUI_READ_ONLY=true, em enforce) nega, como nega o cofre.
  ['admin.google_reauth', true, 'SSDDD', true],
  // Tarefas automáticas do processo (jobGuard.js): origem LOCAL_PC, papel dono. Só a manutenção altera o computador.
  ['job.publish', false, 'ADDDD', true],
  ['job.notify', false, 'ADDDD', true],
  ['job.data_cleanup', false, 'ADDDD', true],
  ['job.cleanup_files', false, 'ADDDD', true],
  ['job.maintenance', true, 'ADDDD', true],
  // Planos com aprovação (YUI_PLANOS, só leitura): as leituras que ainda não tinham linha. Só o dono.
  ['plan.agenda_read', false, 'AAADD', true],
  ['plan.tasks_read', false, 'AAADD', true],
  ['plan.web_search', false, 'AAADD', true],
  ['plan.reminders_read', false, 'AAADD', true],
  ['plan.lists_read', false, 'AAADD', true],
  ['bds.read', false, 'AAADD', true],
  ['bds.write', true, 'SSDDD', true],
  ['bds.delete', true, 'SSDDD', true],
  ['bds.purge', true, 'SCDDD', true],              // apagar de vez: no PC pede confirmação; remoto (app) é crítico = negado
  // Live dos amigos, etapa 1 (vínculos; docs/PLANO_TECNICO_LIVE_AMIGOS_ETAPA1.md §5, aprovado pela Liz em 27/11/2026). A CAMADA OBRIGATÓRIA
  // (src/core/liveAmigos/camada.js) roda antes, no serviço, e este motor só pode apertar. Revogar e "apagar meus dados" sem `modifies` de propósito, como
  // memory.wipe_own: a exclusão de dados de pessoas tem de funcionar sempre (inclusive em somente leitura). AUTORIZAR cria um vínculo novo e persistente:
  // com `modifies` (parecer da Liz de 28/11/2026), então o modo somente leitura (YUI_READ_ONLY=true, em enforce) nega.
  ['live_amigos.listar', false, 'AAADD', true],
  ['live_amigos.autorizar', true, 'SSSDD', true],
  ['live_amigos.revogar', false, 'SSSDD', true],
  ['live_amigos.apagar_meus_dados', false, 'SSSSS', true],
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
  // Lacunas do painel, item 11: a imagem no chat do app é a MESMA ação do generate_image do Discord (POLICY_CHAT_AUTONOMY aperta as duas).
  'imagem.gerar': 'chat.generate_image',
  // Ações de código (o vocabulário de src/core/dev/actions.js). A aba Código e o agente dela saíram em 27/11/2026; as linhas dev.* e estes apelidos
  // ficam porque são a especificação da Fase 1 (§1.2) e a política que as tarefas do Yui Dev (src/core/dev/tarefas.js, Fase 4, desligadas) vão usar.
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
