/**
 * O dicionário ÚNICO dos eventos da auditoria (Fase 1 do painel, regra R9 da matriz): a "Atividade recente" do Início e a seção Auditoria do Admin
 * mostram o mesmo nome para o mesmo evento. Só muda a APRESENTAÇÃO: os eventos gravados e os identificadores não mudam, e um evento antigo ou
 * desconhecido continua legível (nome do grupo pelo prefixo e, na Auditoria, o identificador técnico ao lado).
 * Sem React e sem rede (testável em Node).
 */

export interface EventView {
  label: string;
  icon: string;
  tone: 'normal' | 'good' | 'bad';
  /** true = o evento está no dicionário; false = nome do grupo (prefixo) ou o próprio identificador. */
  exato: boolean;
}

type Vista = Omit<EventView, 'exato'>;
const v = (label: string, icon: string, tone: Vista['tone'] = 'normal'): Vista => ({ label, icon, tone });

const EXATOS: Record<string, Vista> = {
  // Conversa e memória
  'api.chat': v('Conversa pelo app', 'chat_bubble'),
  'api.prerota': v('Comando reconhecido no app', 'chat_bubble'),
  'api.agent': v('Pedido ao agente pelo app', 'chat_bubble'),
  'api.imagem': v('Imagem pelo Chat do app', 'chat_bubble'),
  'memory.write': v('Memória atualizada', 'psychology'),
  'memory.read': v('Memória consultada', 'psychology'),
  'memory.forget': v('Lembrança apagada', 'delete'),
  'memory.forgetAll': v('Memória apagada', 'delete'),
  'context.forgetAll': v('Contexto das conversas apagado', 'delete'),
  'memory.admin.list': v('Pessoas com memória consultadas', 'psychology'),
  'memory.admin.inspect': v('Memória de uma pessoa consultada', 'psychology'),
  'memory.admin.content': v('Conteúdo da memória de uma pessoa consultado', 'psychology'),
  'memory.admin.forget': v('Lembrança de uma pessoa apagada', 'delete'),
  'memory.admin.forgetUser': v('Memória de uma pessoa apagada', 'delete'),
  // Agente e ferramentas
  'agent.tool.ok': v('Ferramenta executada', 'build', 'good'),
  'agent.tool.error': v('Ferramenta com erro', 'warning', 'bad'),
  'agent.tool.denied': v('Ferramenta negada', 'lock', 'bad'),
  'agent.tool.pending': v('Ferramenta aguardando aprovação', 'schedule'),
  'agent.tool.cancelled': v('Ferramenta cancelada', 'cancel'),
  'agent.tool.badargs': v('Ferramenta com argumentos inválidos', 'warning', 'bad'),
  'agent.skill': v('Skill usada', 'bolt'),
  // Entrada no painel
  'auth.login.ok': v('Login no painel', 'lock', 'good'),
  'auth.login.fail': v('Tentativa de login recusada', 'lock', 'bad'),
  'auth.logout': v('Saída do painel', 'logout'),
  login: v('Login no painel', 'lock', 'good'), // nome antigo do registro
  logout: v('Saída do painel', 'logout'), // nome antigo do registro
  'auth.discord.request': v('Chave de entrada pedida pelo Discord', 'lock'),
  'auth.discord.request.fail': v('Falha ao enviar a chave pelo Discord', 'lock', 'bad'),
  'auth.discord.verify.ok': v('Entrada pelo Discord', 'lock', 'good'),
  'auth.discord.verify.fail': v('Chave do Discord recusada', 'lock', 'bad'),
  // Alertas e lembretes
  'alert.sent': v('Alerta enviado ao dono', 'notifications'),
  'alert.fail': v('Falha ao enviar alerta', 'warning', 'bad'),
  'alert.adiado': v('Aviso ao dono adiado', 'notifications'),
  'reminder.fire': v('Lembrete enviado', 'alarm'),
  'reminder.drop': v('Lembrete descartado', 'alarm', 'bad'),
  'monitor.cancelado': v('Monitor cancelado', 'cancel'),
  // Segurança (motor de política, aprovações e canal interno)
  'policy.evaluate': v('Permissão conferida', 'lock'),
  'policy.violation': v('Tentativa barrada pela segurança', 'lock', 'bad'),
  'policy.approval_created': v('Aprovação pedida ao dono', 'schedule'),
  'policy.approved': v('Aprovação concedida', 'check_circle', 'good'),
  'policy.rejected': v('Aprovação recusada', 'cancel'),
  'policy.expired': v('Aprovação expirou', 'schedule'),
  'policy.enacted': v('Ação aprovada executada', 'check_circle', 'good'),
  'channel.violation': v('Pedido barrado no canal interno', 'lock', 'bad'),
  'channel.dm_incerta': v('Mensagem privada com entrega incerta', 'warning', 'bad'),
  'ia.rota_privada_bloqueada': v('Rota privada da IA bloqueada', 'lock', 'bad'),
  // Planos
  'plan.created': v('Plano criado', 'schedule'),
  'plan.approved': v('Plano aprovado', 'check_circle', 'good'),
  'plan.rejected': v('Plano recusado', 'cancel'),
  'plan.cancelled': v('Plano cancelado', 'cancel'),
  'plan.interrupted': v('Plano interrompido', 'warning', 'bad'),
  'plan.step': v('Passo de um plano executado', 'build'),
  'plan.panel_blocked': v('Aprovação de plano pelo painel bloqueada', 'lock', 'bad'),
  // Administração pelo painel
  'admin.restart': v('Yui reiniciada pelo painel', 'refresh'),
  'admin.restart.recusado': v('Reinício pedido e recusado pelo supervisor (nada reiniciou)', 'warning', 'bad'),
  'admin.negado': v('Ação do painel negada', 'lock', 'bad'),
  'admin.config.set': v('Ajuste alterado em Configuração e chaves', 'tune'),
  'admin.config.remove': v('Ajuste desfeito em Configuração e chaves', 'tune'),
  'admin.confirmacao.pedida': v('Chave de confirmação pedida pela DM', 'lock'),
  'admin.confirmacao.usada': v('Chave de confirmação usada', 'lock', 'good'),
  'admin.confirmacao.recusada': v('Chave de confirmação recusada', 'lock', 'bad'),
  'admin.confirmacao.falhou': v('Falha ao enviar a chave de confirmação', 'warning', 'bad'),
  'admin.discord.dm': v('Mensagem enviada por DM pelo painel', 'notifications'),
  'admin.discord.dm.fail': v('Falha ao enviar mensagem por DM', 'warning', 'bad'),
  'admin.ai.key.add': v('Chave de IA adicionada', 'key'),
  'admin.ai.key.remove': v('Chave de IA removida', 'key'),
  'admin.ai.enabled': v('Provedor de IA ligado ou desligado', 'tune'),
  'admin.ai.cloudflare': v('Conta do Cloudflare (IA) alterada', 'key'),
  'admin.ai.custom.add': v('Provedor de IA próprio adicionado', 'key'),
  'admin.ai.custom.key': v('Chave do provedor de IA próprio alterada', 'key'),
  'admin.ai.custom.options': v('Opções do provedor de IA próprio alteradas', 'tune'),
  'admin.ai.custom.remove': v('Provedor de IA próprio removido', 'key'),
  'admin.ai.test': v('Provedor de IA testado', 'bolt'),
  'admin.gateway.reset': v('Descansos do Gateway zerados', 'refresh'),
  'admin.ia.rota_privada.verificar': v('Verificação da rota privada da IA pedida', 'lock'),
  'admin.ia.rota_privada.recusado': v('Verificação da rota privada da IA recusada', 'lock', 'bad'),
  'admin.ban.add': v('Bloqueio aplicado', 'lock'),
  'admin.ban.remove': v('Bloqueio removido', 'lock'),
  'admin.automod': v('AutoMod do servidor alterado', 'shield'),
  'admin.guild.tool': v('Função do servidor alterada', 'tune'),
  'admin.guild.tools.reset': v('Funções do servidor restauradas', 'tune'),
  'admin.guild.tos.accept': v('Termos de uso aceitos pelo painel', 'gavel'),
  'admin.guild.tos.revoke': v('Aceite dos termos de uso revogado', 'gavel'),
  'admin.guild.persona': v('Persona de um canal alterada', 'tune'),
  'admin.guild.persona.reset': v('Persona de um canal restaurada', 'tune'),
  'admin.guild.chatter': v('Falas espontâneas alteradas', 'tune'),
  'admin.guild.mentions': v('Resposta a @everyone e @here alterada', 'tune'),
  'admin.guild.channel': v('Canal do servidor alterado', 'tune'),
  'admin.follow.youtube.liveMode': v('Modo do aviso de transmissão alterado', 'tune'),
  'admin.follow.youtube.add': v('Canal do YouTube adicionado', 'hub'),
  'admin.follow.youtube.remove': v('Canal do YouTube removido', 'hub'),
  'admin.follow.twitch.add': v('Streamer da Twitch adicionado', 'hub'),
  'admin.follow.twitch.remove': v('Streamer da Twitch removido', 'hub'),
  'admin.gta.republicar': v('GTA republicado pelo painel', 'refresh'),
  'admin.live.enter': v('Yui entrou na live', 'live_tv'),
  'admin.live.leave': v('Yui saiu da live', 'live_tv'),
  // Live dos amigos, etapa 1 (vínculos): só o código do vínculo, nunca IDs.
  'live_amigos.autorizar': v('Amigo autorizado na live', 'live_tv'),
  'live_amigos.listar': v('Amigos da live listados', 'live_tv'),
  'live_amigos.revogar': v('Amigo da live revogado', 'live_tv'),
  'live_amigos.apagar_meus_dados': v('Amigo da live pediu para apagar os dados', 'delete'),
  'live_amigos.encerramento': v('Vínculo de amigo da live encerrado', 'delete'),
  'live_amigos.limpeza_dm': v('Mensagem com IDs limpa na DM', 'delete'),
  'live_amigos.negado': v('Pedido de amigo da live negado', 'lock', 'bad'),
  'admin.radio': v('Comando do rádio pelo painel', 'radio'),
  'admin.monitor.remove': v('Monitor cancelado pelo painel', 'cancel'),
  'admin.reminder.add': v('Lembrete criado pelo painel', 'alarm'),
  'admin.reminder.remove': v('Lembrete apagado pelo painel', 'alarm'),
  'admin.reminder.snooze': v('Lembrete adiado pelo painel', 'alarm'),
  'admin.morning.send': v('Resumo do dia enviado pelo painel', 'wb_sunny'),
  'admin.continuidade.remove': v('Projeto ou decisão apagado', 'delete'),
  'admin.bds.upload': v('Arquivo enviado ao servidor de arquivos', 'folder'),
  'admin.bds.link': v('Link de arquivo gerado', 'folder'),
  'admin.bds.mkdir': v('Pasta criada no servidor de arquivos', 'folder'),
  'admin.bds.rename': v('Item renomeado no servidor de arquivos', 'folder'),
  'admin.bds.delete': v('Item enviado para a lixeira', 'delete'),
  'admin.bds.restore': v('Item restaurado da lixeira', 'folder'),
  'admin.bds.purge': v('Item apagado de vez', 'delete', 'bad'),
  'google.reauth.start': v('Reautorização do Google iniciada', 'lock'),
  'google.reauth.ok': v('Google reautorizado', 'lock', 'good'),
  'google.reauth.fail': v('Reautorização do Google não concluída', 'lock', 'bad'),
};

/** Grupos pelo prefixo, para eventos que não estão no dicionário (antigos ou novos): o mais específico primeiro. */
const PREFIXOS: [string, Vista][] = [
  ['auth.discord', v('Entrada pelo Discord', 'lock')],
  ['auth.', v('Entrada no painel', 'lock')],
  ['policy.', v('Verificação de segurança', 'lock')],
  ['reminder.', v('Lembrete', 'alarm')],
  ['plan.', v('Plano', 'schedule')],
  ['live_amigos.', v('Amigos da live', 'live_tv')],
  ['memory.admin', v('Administração de memória', 'psychology')],
  ['memory.', v('Memória da Yui', 'psychology')],
  ['google.', v('Google', 'lock')],
  ['dev.', v('Módulo de código', 'code')],
  ['admin.bds.', v('Servidor de arquivos', 'folder')],
  ['admin.', v('Ajuste feito no painel', 'tune')],
];

/** O tipo cru do começo do nome ("chat", "tool"...) em português, para o que nem o prefixo cobre (antes ficava só na tela do Início). */
const TIPOS: Record<string, string> = {
  chat: 'Conversa', tool: 'Ferramenta', reminder: 'Lembrete', reminders: 'Lembrete', memory: 'Memória da Yui', auth: 'Acesso', admin: 'Painel',
  agent: 'Agente', skill: 'Skill', alert: 'Alerta', dev: 'Código', voice: 'Voz', context: 'Contexto', api: 'App', files: 'Arquivos', bds: 'Arquivos',
};

/** Como um evento da auditoria aparece (Início e Auditoria): nome em português, ícone e tom. Desconhecido: o grupo pelo prefixo, o tipo ou o próprio nome. */
export function describeEvent(event: string): EventView {
  const key = String(event ?? '');
  const exato = Object.prototype.hasOwnProperty.call(EXATOS, key) ? EXATOS[key] : null;
  if (exato) return { ...exato, exato: true };
  for (const [prefix, view] of PREFIXOS) if (key.startsWith(prefix)) return { ...view, exato: false };
  if (!key) return { label: 'Evento', icon: 'history', tone: 'normal', exato: false };
  const tipo = /^[a-z0-9._-]+$/.test(key) ? (TIPOS[key] ?? TIPOS[key.split('.')[0]]) : undefined;
  const label = tipo ?? (/^[a-z0-9._-]+$/.test(key) ? key.charAt(0).toUpperCase() + key.slice(1) : key);
  return { label, icon: 'history', tone: 'normal', exato: false };
}

/** Os eventos que o dicionário conhece (para os testes conferirem a cobertura). */
export const EVENTOS_CONHECIDOS: readonly string[] = Object.freeze(Object.keys(EXATOS));
