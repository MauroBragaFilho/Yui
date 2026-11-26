// YuiCerebro: o processo do CÉREBRO da Yui, separado do bot do Discord (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §1).
//
// Roda: persona, memória (dono dos bancos memory-*), política, agente, IA (backend "gateway", SEM a ponte do bot), a Yui API
// (app e painel) sem o cliente do Discord, o Gateway de IA, os lembretes e o relatório matinal (o aviso sai pelo bot) e o
// servidor do canal local (src/core/channel) por onde o bot pede memória, pesquisa e lembretes e recebe as ações do Discord.
// Etapa 5: a CONVERSA do Discord também é respondida aqui (chat.turn e chat.commit, src/cerebro/conversa.js): o cérebro é o dono do
// contexto por horas e da montagem do histórico; o bot manda só os fatos e executa as ferramentas que precisam do Discord.
//
// Subida:  node src/cerebro.js   (o bot sobe à parte com YUI_CEREBRO_EXTERNO=true: node src/index.js)
// Papel dos bancos: sempre YUI_DB_OWNER_ROLE=cerebro (se o ambiente disser outro papel, o cérebro não sobe).
// Auditoria: o arquivo principal (YUI_AUDIT_FILE ou logs/core-audit.jsonl); o bot separado grava no dele.
// Desligamento limpo (SIGINT, SIGTERM, SIGBREAK ou a mensagem {tipo:'desligar'} de quem abriu o processo com IPC): fecha o
// canal, a API e o Gateway e chama closeAllDatabases() (que solta as travas de dono).
// Este arquivo e src/cerebro/ NÃO podem alcançar o Discord, nem por import dinâmico (tests/test-core-import-graph.js).
import './utils/netDefaultsBoot.js'; // prazo padrão de rede (fetch e axios): precisa vir antes de tudo
import './core/painelConfigBoot.js'; // valores salvos no painel (secrets/painel-config.json) por cima do .env, antes de a configuração ser lida
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { appComandosLigado } from './handlers/listAssistant.js';
import { closeAllDatabases, databaseOwnerStats, databaseStats } from './database/db.js';
import { initMemory } from './core/memory/store.js';
import { isMemoryEnabled } from './core/discordAdapter.js';
import * as ai from './core/ai/manager.js';
import { applyAiSettings } from './core/aiSettings.js';
import { startApi } from './core/api/server.js';
import { ownerUserId } from './core/api/auth.js';
import { startGatewayServer } from './gateway/index.js';
import { startChannelServer } from './core/channel/server.js';
import { configureAlerts, alertOwner, crashAlertKey, describeReason, formatCrashDetail } from './core/alerts.js';
import { criarFiltroDeAvisos, definirFiltroDoProcesso, iniciarDescarga, registrarMetodoDosAvisos } from './core/avisos/fila.js';
import { jobAllowed } from './core/security/jobGuard.js';
import { audit } from './core/audit.js';
import { contextEnabled, contextFilesExist, initContextStore } from './core/context/contextStore.js';
import { registerCerebroMethods } from './cerebro/metodos.js';
import { registerChatMethods } from './cerebro/conversa.js';
import { registerResearchMethods, reservaDaCota } from './cerebro/pesquisa.js';
import { registerCommentMethods } from './cerebro/comentario.js';
import { activateFakeSearch } from './cerebro/buscaFalsa.js';
import { createRetomadaDePesquisa } from './cerebro/pesquisaRetomada.js';
import { getDefaultBudget, userLimitPerHour } from './search/budget.js';
import { ligarCotaHora, estadoDaCotaHora } from './search/cotaHora.js';
import { tabelaDeLimites, tetoGlobal, ajustesDoCerebro, avisarConfigDosLimites, diagnosticoDosLimites } from './core/ai/limitesTokens.js';
import { loadProviders } from './gateway/providers.js';
import { createCerebroAdmin } from './cerebro/painel.js';
import { startCerebroReminders } from './cerebro/lembretes.js';
import { planosLigados } from './core/planos/pedido.js';
import { criarStoreDePlanos } from './core/planos/store.js';
import { registrarPlanos } from './cerebro/planos.js';
import { youtubeLigado } from './adaptadores/youtube/adaptador.js';
import { definirPortaDaLive } from './adaptadores/youtube/porta.js';
import { criarServicoDaLive } from './core/live/servico.js';
import { isOwnerId } from './core/permissions.js';
import { iniciarMonitores } from './cerebro/monitores/index.js';
import { iniciarEventos } from './cerebro/eventos.js';
import { activateFakeAi } from './cerebro/iaFalsa.js';
import { ligarAoSupervisor } from './operacao/filho.js';
// Etapa 9: o motor do agente (só a interface: o Mastra não está implementado) e os perfis de IA (a rota privada precisa de uma verificação prévia).
import { escolherMotorAgente, estadoDoMotor } from './core/ai/motorAgente.js';
import { diagnosticoLocalPrivada } from './core/ai/localPrivada.js';
import { privadoDeclarado } from './core/ai/perfis.js';
import { selecionarPerfil } from './cerebro/seletorPerfil.js';

export const CEREBRO_ROLE = 'cerebro';

let channel = null;
let api = null;
let gateway = null;
let reminders = null;
let chat = null;
let pesquisa = null;
let retomada = null;
let comentarios = null;
let cotaHora = null;
let monitores = null; // etapa 16 (proatividade, YUI_MONITORES): os monitores "me avisa quando..." do dono (null = desligados)
let eventos = null; // etapa 16 (YUI_ALERTAS_EVENTOS): os alertas por evento (disco, memória, internet, religadas do supervisor)
let descarga = null; // a descarga da fila dos avisos (YUI_AVISOS_FILTRO=ligar)
let planos = null; // planos com aprovação (YUI_PLANOS; null = desligados)
let live = null; // a live do YouTube (YUI_YOUTUBE_LIVE; null = desligada)
let shuttingDown = false;
const startedAt = Date.now();

/** O cérebro é sempre o dono dos bancos de memória: YUI_DB_OWNER_ROLE=cerebro (outro valor no ambiente = não sobe). */
export function ensureCerebroRole(env = process.env) {
  const current = String(env.YUI_DB_OWNER_ROLE ?? '').trim().toLowerCase();
  if (current && current !== CEREBRO_ROLE) {
    throw Object.assign(new Error(`YUI_DB_OWNER_ROLE=${current} no ambiente, mas este é o processo do cérebro. Tire a variável do .env (cada processo define o próprio papel).`), { code: 'YUI_CEREBRO_PAPEL' });
  }
  env.YUI_DB_OWNER_ROLE = CEREBRO_ROLE;
}

/**
 * Backend de IA do cérebro, escolhido AQUI (sem mudar o AI_BACKEND global, que o bot continua lendo como "legacy-chain"):
 * YUI_CEREBRO_AI_BACKEND, ou o AI_BACKEND se não for o legacy-chain (que precisa da ponte do bot), ou "gateway".
 */
export function chooseCerebroBackend(env = process.env, available = ai.listBackends().map((b) => b.name)) {
  const explicit = String(env.YUI_CEREBRO_AI_BACKEND ?? '').trim();
  if (explicit && available.includes(explicit) && explicit !== 'legacy-chain') return explicit;
  const global = String(env.AI_BACKEND ?? '').trim();
  if (global && global !== 'legacy-chain' && available.includes(global)) return global;
  return 'gateway';
}

function closeHttp(server) {
  if (!server) return Promise.resolve();
  return new Promise((resolve) => {
    try {
      server.close(() => resolve());
      server.closeAllConnections?.();
    } catch { resolve(); }
    setTimeout(resolve, 3000).unref?.();
  });
}

/** Saúde do cérebro (método `health` do canal e parte do /v1/health). Só números e estados, nada de conteúdo. */
function cerebroHealth() {
  const active = ai.listBackends().find((b) => b.active)?.name ?? null;
  return {
    ok: true,
    role: CEREBRO_ROLE,
    pid: process.pid,
    uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
    memoria: isMemoryEnabled(),
    ponteDoBot: ai.hasLegacyBridge(),
    backend: active,
    bot: { conectado: channel?.isConnected('bot') ?? false, discordOnline: reminders?.status().botDiscordOnline ?? null },
    canal: channel?.stats() ?? null,
    lembretes: reminders?.status() ?? null,
    conversa: chat?.stats() ?? null,
    pesquisa: pesquisa?.stats() ?? null,
    // Os comentários fora da fila (etapa 7): só números (pedidos, respondidos, privados, recusados por ocupado ou bloqueado).
    comentarios: comentarios?.stats() ?? null,
    // A cota de busca por hora (só números, sem ids): a retomada da pesquisa devolve a ela as buscas já feitas por um processo anterior.
    cotaBusca: cotaParaSaude(),
    // Limites de tokens da resposta por provedor (etapa 6): só números, para conferir qual limite vale em cada um.
    limitesTokens: limitesParaSaude(),
    // Erros de configuração dos limites (ex.: AI_MAX_TOKENS inválido): o padrão que vale no lugar não esconde o erro (Liz, §12).
    avisosDeConfiguracao: diagnosticoDosLimites(),
    // Etapa 9: o motor do agente (nativo; o Mastra é recusado) e o estado dos perfis de IA (só contadores e palavras fixas: sem chave, cabeçalho, prompt nem conteúdo).
    motorAgente: estadoDoMotor(),
    perfisDeIa: ai.estadoDosPerfis(),
    // A rota privada com IA local (só com YUI_IA_LOCAL_PRIVADA ligada; desligada, a saúde é idêntica à de antes): só números e palavras fixas (o tipo do endereço, nunca o endereço).
    ...(diagnosticoLocalPrivada().estado !== 'desligada' ? { iaLocalPrivada: diagnosticoLocalPrivada() } : {}),
    // Etapa 16 (proatividade): só aparecem com a chave ligada (sem ela a saúde é idêntica à de antes). Só números.
    ...(monitores ? { monitores: monitores.status() } : {}),
    ...(eventos ? { alertasPorEvento: eventos.status() } : {}),
    travas: databaseOwnerStats(),
    bancos: databaseStats().map((b) => ({ name: b.name, engine: b.engine, open: b.open, owner: b.owner ?? null, ownerLock: b.ownerLock ?? null, openFailures: b.openFailures })),
  };
}

/**
 * Os números do cérebro para a aba Diagnóstico do app (etapa 8): só números e booleanos (o src/core/diagnostico.js ainda confere por uma lista de
 * permitidos). Nada de texto de conversa, de pesquisa, de id de pessoa ou de segredo. Nunca lança.
 */
function cerebroParaDiagnostico() {
  const f = (fn) => { try { return fn(); } catch { return null; } };
  return {
    uptimeSegundos: Math.round((Date.now() - startedAt) / 1000),
    backend: f(() => ai.listBackends().find((b) => b.active)?.name ?? null),
    ponteDoBot: f(() => ai.hasLegacyBridge()),
    canal: f(() => channel?.stats() ?? null),
    conversa: f(() => chat?.stats() ?? null),
    pesquisa: f(() => pesquisa?.stats() ?? null),
    retomada: f(() => retomada?.stats() ?? null),
    comentarios: f(() => comentarios?.stats() ?? null),
    lembretes: f(() => reminders?.status() ?? null),
    travasPerdidas: f(() => databaseOwnerStats()?.lock?.lost ?? 0) ?? 0,
    reservaPercentual: f(() => reservaDaCota()),
  };
}

/** A cota de busca por hora agora (global; e o limite por pessoa). Só números. Nunca lança. */
function cotaParaSaude() {
  try {
    const cota = getDefaultBudget();
    const g = cota.globalStatus();
    // `hora`: os contadores por hora em disco (segunda revisão da Liz, §12): gravações, falhas e quantas buscas voltaram na subida; e (etapa 8)
    // quem é o dono do arquivo e se a trava está firme (src/search/cotaHora.js).
    const dono = estadoDaCotaHora();
    // `pesquisaDisponivel` e `codigo`: sem o dono da cota (a trava) a pesquisa fica indisponível (a Yui avisa); `hora.reutilizadas`: buscas que só aproveitaram uma já feita.
    return { globalUsadas: g.used, globalLimite: g.limit, limitePorPessoa: userLimitPerHour(), hora: { ...(cota.hourlyStats?.() ?? {}), dono: dono.dono ?? null, aguardandoTrava: dono.aguardandoTrava === true, motivo: dono.motivo ?? null, codigo: dono.codigo ?? null, pesquisaDisponivel: dono.pesquisaDisponivel !== false } };
  } catch {
    return null;
  }
}

/** A tabela dos limites de tokens por provedor do Gateway (configuração, capacidade, teto). Nunca lança. */
function limitesParaSaude() {
  try {
    return { teto: tetoGlobal(), provedores: tabelaDeLimites(loadProviders().providers), erro: ajustesDoCerebro().erro };
  } catch {
    return null;
  }
}

/** Mensagem privada pelo bot (ação do canal). Lança se o bot não estiver conectado ou não conseguir. */
function dmThroughBot(userId, text, motivo) {
  if (!channel) return Promise.reject(Object.assign(new Error('Canal do cérebro ainda não subiu.'), { code: 'NOT_CONNECTED' }));
  return channel.request('bot', 'discord.dm.send', { userId: String(userId), text: String(text ?? ''), motivo }, { idem: `${motivo}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}` });
}

async function bootstrap() {
  logger.info('====================================================');
  logger.info('🧠 Inicializando o cérebro da Yui (YuiCerebro)...');
  logger.info(`Ambiente: ${config.environment} | Node: ${process.version} | SO: ${process.platform} | PID: ${process.pid}`);
  logger.info('====================================================');

  ensureCerebroRole(process.env);

  // 0. O motor do agente (etapa 9, só a interface): YUI_MOTOR_AGENTE=mastra NÃO está implementado: o cérebro recusa, registra e segue no nativo.
  escolherMotorAgente(process.env, { logger });

  // 1. IA: backend do cérebro (gateway), sem a ponte do bot. A IA falsa só existe nos testes (NODE_ENV=test).
  applyAiSettings(); // chaves e provedores salvos pelo painel, antes de qualquer provedor
  if (activateFakeAi(ai, { logger }) !== 'on') {
    const name = chooseCerebroBackend();
    ai.setActiveBackend(name);
    logger.info(`[Cérebro] Backend de IA: ${name} (o bot continua no caminho dele; o AI_BACKEND global não muda).`);
  }

  // 2. Memória: o cérebro é o dono (pega a trava de dono antes de abrir; outro cérebro vivo na mesma pasta = recusa).
  await initMemory();
  logger.info('[Cérebro] Memória aberta (dono: cérebro).');
  // Contexto por horas: os arquivos são do cérebro (a limpeza horária roda aqui). O bot separado só pede o apagar.
  if (contextEnabled() || contextFilesExist()) {
    initContextStore().catch((err) => logger.warn(`[Context] início falhou: ${String(err?.message ?? err).slice(0, 120)}`));
  }

  // 3. Canal local com o bot (127.0.0.1, segredo em arquivo restrito).
  channel = await startChannelServer({
    onViolation: (type) => { try { audit('channel.violation', null, { type }); } catch { /* */ } },
    onConnect: ({ role }) => {
      if (role !== 'bot') return;
      // O bot pode ter perdido uma troca de chaves de IA feita no painel enquanto estava fora: relê ao conectar.
      try { channel?.emit('ai.settingsChanged', { tipo: 'reconexao' }, { role: 'bot' }); } catch { /* */ }
      // Quem grava as listas (YUI_APP_COMANDOS só muda na subida, e o supervisor pode religar um processo só).
      try { channel?.emit('listas.dono', { cerebro: appComandosLigado(process.env) }, { role: 'bot' }); } catch { /* */ }
      setTimeout(() => { reminders?.tick('bot conectou').catch(() => {}); }, 100).unref?.();
      setTimeout(() => { monitores?.passada('bot conectou'); }, 300).unref?.();
      setTimeout(() => { planos?.tick(); }, 400).unref?.();
    },
  });
  // Avisos na hora certa (modo ligar): a fila é do cérebro; o bot entrega o aviso por este método.
  const avisos = criarFiltroDeAvisos({ env: process.env, logger });
  definirFiltroDoProcesso(avisos);
  registrarMetodoDosAvisos(channel, avisos);
  const lembretesMudaram = () => { setTimeout(() => { reminders?.tick('pedido do dono').catch(() => {}); }, 50).unref?.(); };
  const methods = registerCerebroMethods(channel, { health: cerebroHealth, lembretesMudaram });
  // A conversa do Discord (etapa 5): chat.turn, chat.commit e chat.forgetVoice. O cérebro é o dono do contexto por horas e do histórico.
  // A pesquisa do Discord (etapa 6): research.turn (a da fila) e chat.yui (o /yui inteiro); a busca automática roda no passo do chat.turn.
  // A busca falsa só existe nos testes (NODE_ENV=test).
  const busca = activateFakeSearch({ logger }) ?? undefined;
  // A cota de busca POR HORA em disco (segunda revisão da Liz, §12): o cérebro é o dono da cota (um escritor só). Antes de qualquer busca, relê
  // as buscas da última hora de um processo anterior (cada uma no instante dela: a janela de 1 h continua certa) e passa a gravar cada busca
  // aceita (gravação atômica) antes de ela sair. YUI_COTA_HORA_DISCO=false volta a só memória. Etapa 8: o dono e a trava do arquivo (o processo
  // único faz o mesmo com o papel `unico`; o bot separado nunca grava) estão em src/search/cotaHora.js.
  cotaHora = ligarCotaHora({ papel: 'cerebro', budget: getDefaultBudget(), logger });
  // A retomada da pesquisa (ajustes da Liz na etapa 6): o diário em <DATABASE_DIR>/pesquisa-retomada (dono: o cérebro). Na subida, a busca que
  // ficou enviada sem resultado vira "incerta"; a mesma chave repetida pelo bot retoma de onde parou, sem repetição cega.
  retomada = createRetomadaDePesquisa({ logger, budget: getDefaultBudget() });
  // Os monitores (etapa 16, proatividade; YUI_MONITORES, padrão desligado = null): DEPOIS da cota por hora (as buscas deles passam pela mesma porta e
  // pela reserva própria) e ANTES da conversa (a pré-rota do chat.turn os usa). O aviso sai pelo bot, como o dos lembretes.
  // (uma função opcional que não sobe, por exemplo por um arquivo de estado que não abre, nunca derruba o cérebro: o erro vai para o log e o resto segue)
  try { monitores = iniciarMonitores({ channel, logger, ownerId: ownerUserId(), budget: getDefaultBudget(), avisos }); } catch (err) { monitores = null; logger.error(`[Cérebro] os monitores não subiram (${err?.code ?? err?.message ?? 'erro'}); o resto segue sem eles.`); }
  const conversa = registerChatMethods(channel, { busca, retomada, ...(monitores ? { monitores } : {}) });
  chat = conversa.brain;
  const pesquisas = registerResearchMethods(channel, { chat, busca, retomada });
  pesquisa = pesquisas.brain;
  // Os comentários fora da fila (etapa 7): chat.comentario, o comentário curto embaixo do embed do /steam_jogo e do /converter_moeda (chamada
  // isolada, sem histórico, sem memória e sem gravar nada).
  const comentario = registerCommentMethods(channel, {});
  comentarios = comentario.brain;
  // Erros de configuração dos limites de tokens (AI_MAX_TOKENS, YUI_CEREBRO_MAX_TOKENS, teto...): no log UMA vez e no diagnóstico (saúde).
  avisarConfigDosLimites(process.env, logger);
  logger.info(`[Cérebro] Canal com ${methods.length + conversa.methods.length + pesquisas.methods.length + comentario.methods.length} método(s) para o bot (a conversa, a pesquisa e os comentários do Discord passam por aqui).`);

  // 4. Avisos ao dono: saem pelo bot (discord.dm.send). Sem o bot conectado, o aviso falha e fica na auditoria (alert.fail).
  const ownerId = ownerUserId();
  configureAlerts({ ownerId, notify: (id, text) => dmThroughBot(id, text, 'alerta'), filtro: avisos });

  // 4b. Perfis de IA (etapa 9): se o dono declarou o perfil PRIVADO, a rota dele só liga depois de uma verificação prévia (uma sonda sem conteúdo privado,
  // pela mesma rota e chave do perfil, com o cabeçalho de decisão lido pelo leitor estrito). Em segundo plano: a subida não espera o OmniRoute. Sem a
  // sonda válida, a conversa privada não sai pelo perfil e responde a falha fechada. Sem perfil privado declarado, nada acontece aqui.
  if (privadoDeclarado()) {
    ai.verificarRotaPrivada().then((r) => logger.info(`[Cérebro] Rota privada da IA: ${r.estado}${r.motivo ? ` (${r.motivo})` : ''}.`)).catch(() => {});
  }

  // 5. Lembretes e relatório matinal (o cérebro é o dono do lembretes.json).
  reminders = startCerebroReminders({ channel, logger, ownerId, avisos });
  descarga = iniciarDescarga(avisos, {
    podeAlertas: () => jobAllowed('alerts.send'),
    podeResumo: () => jobAllowed('reminders.morning'),
    enviar: async (texto, { idem }) => {
      if (!ownerId || !channel.isConnected('bot')) return false;
      if ((await channel.request('bot', 'discord.status', {}, { timeoutMs: 5_000 }))?.online !== true) return false;
      const r = await channel.request('bot', 'discord.dm.send', { userId: String(ownerId), text: texto, motivo: 'alerta' }, { idem, timeoutMs: 30_000 });
      if (r?.incerto) return { incerto: true };
      return r?.sent === true || r?.repetido === true;
    },
  });
  // Planos com aprovação (YUI_PLANOS, padrão desligado). Desligado, só se apaga o que sobrou de antes depois de 7 dias.
  try {
    if (planosLigados(process.env)) planos = registrarPlanos({ channel, logger });
    else criarStoreDePlanos().limpar();
  } catch (err) { planos = null; logger.error(`[Cérebro] os planos não subiram (${err?.code ?? err?.message ?? 'erro'}); o resto segue sem eles.`); }
  // Live do YouTube (YUI_YOUTUBE_LIVE, padrão desligado): o serviço roda aqui; o bot pede pelo canal (youtube.comando). Depois de um reinício ela não volta: só avisa.
  try {
    if (youtubeLigado(process.env)) {
      live = criarServicoDaLive({ logger, ehDono: (id) => isOwnerId(id) || id === String(ownerId), avisarDono: async (texto) => { const r = await dmThroughBot(ownerId, texto, 'alerta'); return r?.sent !== false && r?.incerto !== true; } });
      definirPortaDaLive(live);
      channel.handle('youtube.comando', async (p) => live.rotear({ userId: String(p?.userId ?? ''), texto: String(p?.texto ?? '').slice(0, 400), canal: 'discord_dm' }), { roles: ['bot'], timeoutMs: 60_000 });
      live.avisarReinicio();
    }
  } catch (err) { live = null; logger.error(`[Cérebro] a live não subiu (${err?.code ?? err?.message ?? 'erro'}); o resto segue sem ela.`); }
  // 5b. Alertas por evento (etapa 16; YUI_ALERTAS_EVENTOS, padrão desligado = null): disco, memória, internet e religadas do supervisor, pelo alertOwner.
  try { eventos = iniciarEventos({ logger }); } catch (err) { eventos = null; logger.error(`[Cérebro] os alertas por evento não subiram (${err?.code ?? err?.message ?? 'erro'}); o resto segue sem eles.`); }

  // 6. Yui API sem o cliente do Discord: as telas do Discord viram pedidos ao bot; o aviso por DM vai pelo bot.
  api = startApi(null, {
    lembretesMudaram,
    aoApagarMemoria: (userId) => { try { channel?.emit('continuidade.descartar', { userId: String(userId) }, { role: 'bot' }); } catch { /* o aviso nunca derruba o apagamento */ } },
    // `reinicio` (etapa 10, piloto do app): "Reiniciar a Yui" pede ao SUPERVISOR o reinício dos dois processos (bot e cérebro); sem supervisor o pedido é recusado
    // e nada reinicia (o `process.exit` de sempre nunca é usado aqui: ninguém religaria o cérebro, e o bot ficaria sem ele).
    admin: createCerebroAdmin({ channel, diagnostico: cerebroParaDiagnostico, reinicio: (pedido) => supervisor.pedirReinicio(pedido), monitores }),
    notify: (id, text) => dmThroughBot(id, text, 'painel'),
    // Etapa 10 (piloto do app): o chat do app escolhe o perfil de IA com o MESMO seletor determinístico do Discord (a conversa do dono vai pelo privado se ele estiver
    // declarado e verificado; a escalada para o raciocínio pelos sinais de sempre). Sem nenhum perfil configurado o seletor devolve null e a chamada fica idêntica à de antes.
    selecionarPerfil: (fatos) => selecionarPerfil(fatos, { env: process.env }),
    // `discord.online` fica null de propósito: o supervisor de hoje religa "a Yui" com o Discord fora, e aqui isso religaria
    // o cérebro por causa do bot. A situação do bot vai em `cerebro.bot` (o watchdog dos dois processos é a etapa 5).
    // `lembretes`: os números dos avisos com a entrega incerta ou ainda a confirmar (visíveis também na lista do dono).
    health: () => ({ discord: { online: null }, cerebro: { bot: channel?.isConnected('bot') ?? false, ponteDoBot: ai.hasLegacyBridge(), backend: ai.listBackends().find((b) => b.active)?.name ?? null, lembretes: reminders?.status().entrega ?? null } }),
  });

  // 7. Yui Gateway (servidor de IA compatível com OpenAI; opcional: YUI_GATEWAY_ENABLED=true).
  gateway = startGatewayServer();

  logger.info(`✅ YuiCerebro pronto (canal em 127.0.0.1:${channel.port}; API ${api ? 'ligada' : 'desligada'}; Gateway ${gateway ? 'ligado' : 'desligado'}).`);
  supervisor.pronto();
}

/** Saúde curta para o supervisor (IPC): só números e estados. */
function saudeParaSupervisor() {
  const travas = databaseOwnerStats();
  return {
    pronto: channel !== null && !shuttingDown,
    canal: channel ? { porta: channel.port, botConectado: channel.isConnected('bot') } : null,
    bot: { conectado: channel?.isConnected('bot') ?? false, discordOnline: reminders?.status().botDiscordOnline ?? null },
    travasPerdidas: travas?.lost ?? 0,
    // A retomada da pesquisa e a cota de busca por hora (só números): o supervisor e os testes conferem as novas tentativas e a cota.
    pesquisa: retomada ? { retomada: retomada.stats(), cota: cotaParaSaude(), yui: pesquisa?.stats()?.yuiDecisoes ?? null } : null,
  };
}

async function shutdown(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Cérebro] Desligando (${reason})...`);
  const hard = setTimeout(() => process.exit(1), 10_000);
  hard.unref?.();
  try { reminders?.stop(); } catch { /* */ }
  try { descarga?.parar(); } catch { /* */ }
  try { planos?.parar(); } catch { /* */ }
  try { live?.parar(); } catch { /* */ }
  try { monitores?.parar(); } catch { /* */ }
  try { eventos?.parar(); } catch { /* */ }
  try { cotaHora?.parar(); } catch { /* */ }
  try { await channel?.close(); } catch (err) { logger.warn(`[Cérebro] canal: ${err.message}`); }
  await closeHttp(api);
  await closeHttp(gateway);
  let closed = 0;
  try { closed = closeAllDatabases(); } catch (err) { logger.warn(`[Cérebro] bancos: ${err.message}`); }
  logger.info(`[Cérebro] Desligado: canal, API e Gateway fechados; ${closed} banco(s) fechado(s) e travas de dono soltas.`);
  await new Promise((r) => setTimeout(r, 150)); // deixa a última linha do log sair
  process.exit(0);
}

for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
  try { process.on(signal, () => { shutdown(signal); }); } catch { /* sinal inexistente nesta plataforma */ }
}
// Quem abriu o processo com IPC (o supervisor src/supervisor.js, os testes) pede o desligamento limpo com {tipo:'desligar'}
// (no Windows o kill() não deixa o processo rodar nada antes de sair), pergunta a saúde com {tipo:'saude'} e recebe
// {tipo:'pronto'} quando a subida termina. Se o pai sumir, o cérebro se desliga sozinho, de forma limpa.
const supervisor = ligarAoSupervisor({ papel: CEREBRO_ROLE, saude: saudeParaSupervisor, desligar: (motivo) => { shutdown(motivo); } });

process.on('unhandledRejection', (reason) => {
  try {
    logger.error(`[Cérebro] Unhandled Rejection: ${describeReason(reason)}`);
    alertOwner(crashAlertKey(reason), 'Erro inesperado no cérebro (promessa rejeitada)', formatCrashDetail(reason, { maxLines: 3 }), { level: 'error' });
  } catch { /* */ }
});
process.on('uncaughtException', (error) => {
  try {
    logger.error(`[Cérebro] Uncaught Exception: ${describeReason(error)}`);
    alertOwner(crashAlertKey(error), 'Erro grave no cérebro', formatCrashDetail(error, { maxLines: 4 }), { level: 'error' });
  } catch { /* */ }
});

bootstrap().catch(async (err) => {
  logger.error(`❌ Falha fatal ao iniciar o cérebro${err?.code ? ` [${err.code}]` : ''}: ${err?.message ?? err}`);
  try { await channel?.close(); } catch { /* */ }
  await closeHttp(api);
  try { closeAllDatabases(); } catch { /* */ }
  await new Promise((r) => setTimeout(r, 150));
  process.exit(1);
});
