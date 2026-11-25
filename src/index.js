import './utils/netDefaultsBoot.js'; // prazo padrão de rede (fetch e axios): precisa vir antes de tudo
import './core/painelConfigBoot.js'; // valores salvos no painel (secrets/painel-config.json) por cima do .env, antes de a configuração ser lida
import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { initDatabase, closeAllDatabases } from './database/db.js';
import { CORE_SCHEMA, NEWSWIRE_SCHEMA, GTA_DAILY_SCHEMA, GTA_WEEKLY_SCHEMA, YOUTUBE_SCHEMA, TWITCH_SCHEMA } from './database/schemas.js';
import { createDiscordClient } from './discord/client.js';
import { startScheduler } from './scheduler/scheduler.js';
import { deploySlashCommands } from './discord/deployCommands.js';
import { ensureYoutubeSchema } from './database/repositories/youtubeRepo.js';
import { downloadTunables } from './utils/tunables.js';
import { downloadVehicleData } from './utils/vehicleData.js';
import { downloadWeaponData } from './utils/weaponData.js';
import { updateVehicles as updateGtaCarsVehicles } from './services/gta/vehicles/gtacars/service.js';
import { validateMediaTools, startYtdlpAutoUpdate } from './utils/binaries.js';
import { initMemory } from './core/index.js';
import { startApi } from './core/api/server.js';
import { initInteractionStats } from './core/interactionStats.js';
import path from 'node:path';
import { startGatewayServer } from './gateway/index.js';
import { applyAiSettings } from './core/aiSettings.js';
import { isChromeProfileCleanupError } from './utils/chromeProfile.js';
import { alertOwner, configureAlerts, crashAlertKey, describeReason, formatCrashDetail, isHarmlessNetworkCrash } from './core/alerts.js';
import { ownerUserId } from './core/api/auth.js';
import { jobAllowed } from './core/security/jobGuard.js';
import { setLegacyBridge } from './core/ai/manager.js';
import { avisarConfigDosLimites } from './core/ai/limitesTokens.js';
import { ligarCotaHora } from './search/cotaHora.js';
import { cerebroExterno, prepareSeparatedBot } from './discord/modoSeparado.js';

// Ponte do Core para a cadeia de IA legada do bot (llmHandler): o Core não importa o bot, quem roda o bot instala.
// Sem ela o app (POST /v1/chat e /v1/agent) ficaria sem o backend "legacy-chain" e sem a pesquisa que depende dele.
setLegacyBridge(() => import('./handlers/llmHandler.js'));

// Cérebro separado (etapa 3, YUI_CEREBRO_EXTERNO=true): este processo é só o adaptador do Discord. A memória, os lembretes, a
// API e o Gateway ficam no cérebro (node src/cerebro.js); o bot conversa com ele pelo canal local. Sem a chave: tudo aqui, como sempre.
const SEPARADO = cerebroExterno();
let discordClient = null;

// ── Só com o cérebro separado (etapa 4: operação dos dois processos). No processo único nada disto é ligado. ──────────
// Desligamento limpo (SIGINT, SIGTERM, SIGBREAK ou {tipo:'desligar'} pelo IPC do supervisor): fecha o canal com o cérebro,
// desconecta do Discord e fecha os bancos do bot (solta as travas de dono). Se o supervisor sumir, o bot se desliga sozinho:
// nunca sobra um bot órfão com o token.
let cerebroChannel = null;
let botPronto = false;
let shuttingDown = false;
let supervisorLink = { ativo: false, pronto() {} };

async function shutdownSeparado(reason) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info(`[Bot] Desligando (${reason})...`);
  const hard = setTimeout(() => process.exit(1), 10_000);
  hard.unref?.();
  try { await cerebroChannel?.close(); } catch (err) { logger.warn(`[Bot] canal: ${err.message}`); }
  try { await discordClient?.destroy?.(); } catch (err) { logger.warn(`[Bot] Discord: ${err.message}`); }
  let closed = 0;
  try { closed = closeAllDatabases(); } catch (err) { logger.warn(`[Bot] bancos: ${err.message}`); }
  logger.info(`[Bot] Desligado: canal com o cérebro fechado, Discord desconectado; ${closed} banco(s) fechado(s) e travas de dono soltas.`);
  await new Promise((r) => setTimeout(r, 150)); // deixa a última linha do log sair
  process.exit(0);
}

if (SEPARADO) {
  for (const signal of ['SIGINT', 'SIGTERM', 'SIGBREAK']) {
    try { process.on(signal, () => { shutdownSeparado(signal); }); } catch { /* sinal inexistente nesta plataforma */ }
  }
  const { ligarAoSupervisor } = await import('./operacao/filho.js');
  supervisorLink = ligarAoSupervisor({
    papel: 'bot',
    saude: () => ({ pronto: botPronto && !shuttingDown, canal: cerebroChannel?.connected ?? false, discord: Boolean(discordClient?.isReady?.()), discordFalso: Boolean(discordClient?.falso) }),
    desligar: (motivo) => { shutdownSeparado(motivo); },
  });
}

/** Só o bot separado (etapa 6): avisa nas mensagens "Processando..." que ficaram paradas numa queda e apaga os registros. Nunca lança. */
async function avisarProcessandoParados(client) {
  try {
    const { processandoStore, recuperarProcessando } = await import('./discord/processandoGuardado.js');
    const store = processandoStore();
    if (!store?.size) return;
    await recuperarProcessando({ store, client, logger });
  } catch (err) {
    logger.warn(`[Bootstrap] Não consegui avisar as mensagens "Processando..." paradas: ${String(err?.message ?? err).slice(0, 120)}`);
  }
}

async function registerHikariEvents(client) {
  const eventFiles = [
    './events/guildCreate.js',
    './events/guildDelete.js',
    './events/voiceStateUpdate.js',
    './events/interactionCreate.js',
    './events/messageCreate.js',
  ];

  for (const eventFile of eventFiles) {
    const event = (await import(eventFile)).default;
    const listener = (...args) => event.execute(...args, client);
    if (event.once) client.once(event.name, listener);
    else client.on(event.name, listener);
  }
  logger.info(`[Yui] ${eventFiles.length} eventos integrados.`);
}

async function bootstrap() {
  logger.info('====================================================');
  logger.info('🚀 Inicializando Yui...');
  logger.info(`Ambiente: ${config.environment} | Node: ${process.version} | SO: ${process.platform}`);
  logger.info('====================================================');

  if (SEPARADO) {
    try {
      const { auditFile } = prepareSeparatedBot();
      logger.info(`[Bootstrap] Cérebro separado (YUI_CEREBRO_EXTERNO=true): este processo é o adaptador do Discord; bancos só do bot; auditoria em ${auditFile}.`);
    } catch (err) {
      logger.error(`❌ ${err.message}`);
      process.exit(1);
    }
  }

  // 1. Inicializar os bancos de dados SQLite (WASM / Puro JS - Sem C++).
  logger.info('[Bootstrap] Inicializando bancos de dados...');
  await initDatabase('core', CORE_SCHEMA);
  await initDatabase('newswire', NEWSWIRE_SCHEMA);
  await initDatabase('gta-diario', GTA_DAILY_SCHEMA);
  await initDatabase('gta-semanal', GTA_WEEKLY_SCHEMA);
  await initDatabase('social-youtube', YOUTUBE_SCHEMA);
  try { if (ensureYoutubeSchema()) logger.info('[Bootstrap] Banco do YouTube atualizado: modo de live por inscrição (as já existentes ficam em "new").'); } catch (err) { logger.warn(`[Bootstrap] Não consegui atualizar o banco do YouTube: ${err.message}`); }
  await initDatabase('social-twitch', TWITCH_SCHEMA);
  // Junta as chaves/provedores salvos pelo painel com o .env (antes de qualquer provedor de IA).
  applyAiSettings();
  // Erros de configuração dos limites de tokens (ex.: AI_MAX_TOKENS inválido): no log UMA vez e no diagnóstico (segunda revisão da Liz, §12).
  avisarConfigDosLimites(process.env, logger);

  if (SEPARADO) {
    // Cota de busca por hora em disco (etapa 8): com o cérebro separado o dono do arquivo é o CÉREBRO; o bot nunca grava (nem tenta pegar a trava).
    ligarCotaHora({ papel: 'bot-separado', logger });
    // A memória é do cérebro: o bot não abre os bancos memory-* e pede pelo canal (fachada da memória).
    const { startBotChannel } = await import('./discord/canalCerebro.js');
    const cerebro = startBotChannel({ getClient: () => discordClient });
    cerebroChannel = cerebro;
    // Etapa 6: o "Processando..." de cada turno fica guardado (DATABASE_DIR/processando-bot.json) até o fim do turno; os que sobraram de uma
    // queda são avisados quando o Discord estiver pronto (avisarProcessandoParados, mais abaixo).
    const { ligarProcessando } = await import('./discord/processandoGuardado.js');
    const processando = ligarProcessando({ logger });
    if (processando.size) logger.info(`[Bootstrap] ${processando.size} mensagem(ns) "Processando..." ficaram de uma queda: serão avisadas assim que o Discord estiver pronto.`);
    try {
      await cerebro.ready(5_000);
      logger.info('[Bootstrap] Conectado ao cérebro pelo canal local.');
    } catch {
      logger.warn('[Bootstrap] O cérebro não respondeu: memória e lembretes ficam indisponíveis até ele voltar (o bot reconecta sozinho).');
    }
    // Só nos testes de operação (NODE_ENV=test + YUI_TESTE_DISCORD_FALSO=true): sem login, as DMs vão para um arquivo.
    const { fakeDiscordMode, createFakeDiscordClient, startFakeInbox } = await import('./discord/discordFalso.js');
    const fakeMode = fakeDiscordMode();
    if (fakeMode === 'refused') logger.error('[Bootstrap] YUI_TESTE_DISCORD_FALSO=true ignorado: o Discord falso só liga com NODE_ENV=test e o cérebro separado.');
    if (fakeMode === 'on') {
      discordClient = createFakeDiscordClient();
      // Etapa 8 (tests/test-steam-jogo-processos.js): a loja da Steam também falsa (só com YUI_TESTE_STEAM_FALSA=true e NODE_ENV=test): nenhuma rede.
      try { const { ativarSteamFalsa } = await import('./discord/steamFalsa.js'); const { default: axiosDoBot } = await import('axios'); ativarSteamFalsa({ axios: axiosDoBot, logger }); } catch (err) { logger.warn(`[Bootstrap] Steam falsa não ligou: ${String(err?.message ?? err).slice(0, 100)}`); }
      logger.warn(`[Bootstrap] DISCORD FALSO ligado (só teste): sem login; as DMs vão para ${discordClient.arquivo}.`);
      await avisarProcessandoParados(discordClient);
      // Conversa (etapa 5): mensagens falsas pelo messageCreate de verdade (fila do llmHandler -> turno do cérebro), se o teste pedir.
      if (String(process.env.YUI_TESTE_DISCORD_FALSO_ENTRADA ?? '').trim()) {
        const messageCreate = (await import('./events/messageCreate.js')).default;
        // Etapa 7: também comandos de barra falsos pelo interactionCreate de verdade (os comentários fora da fila).
        const interactionCreate = (await import('./events/interactionCreate.js')).default;
        const inbox = startFakeInbox({ client: discordClient, onMessage: (m) => messageCreate.execute(m, discordClient), onInteraction: (i) => interactionCreate.execute(i, discordClient), logger });
        logger.warn(`[Bootstrap] Discord falso: mensagens de ${inbox.arquivo}; respostas em ${inbox.saida}.`);
      }
      botPronto = true;
      supervisorLink.pronto();
      logger.info('✅ Yui inicializada (Discord falso, teste de operação).');
      return;
    }
  } else {
    await initMemory();
    // Cota de busca por hora em disco TAMBÉM no processo único (etapa 8, revisão da Liz): o dono do arquivo é este próprio processo (com uma
    // trava de dono no arquivo: nunca dois processos gravando o mesmo). YUI_COTA_HORA_DISCO=false volta a só memória.
    ligarCotaHora({ papel: 'unico', logger });
  }
  logger.info('[Bootstrap] Todos os bancos de dados inicializados com sucesso.');

  // 1.1 Baixar/atualizar os tunables (RDO.GG) para a Van de Armas
  try {
    if (jobAllowed('maintenance.data_refresh')) await downloadTunables();
  } catch (err) {
    logger.warn(`[Bootstrap] Não foi possível baixar tunables e não há cache local: ${err.message}`);
  }

  // 1.2 Baixar/atualizar os dumps de veículos e armas
  try {
    if (jobAllowed('maintenance.data_refresh')) await downloadVehicleData();
  } catch (err) {
    logger.warn(`[Bootstrap] Vehicle data indisponível, seguindo sem: ${err.message}`);
  }
  try {
    if (jobAllowed('maintenance.data_refresh')) await downloadWeaponData();
  } catch (err) {
    logger.warn(`[Bootstrap] Weapon data indisponível, seguindo sem: ${err.message}`);
  }

  // 1.2.1 Atualizar base de veículos do GTACars (fonte independente). O cache
  // já é carregado no import do service; este update garante frescor (24h).
  try {
    const report = jobAllowed('maintenance.gtacars_update') ? await updateGtaCarsVehicles() : { ok: true };
    if (!report?.ok) {
      logger.warn(`[Bootstrap] GTACars sem atualização: ${report?.reason || 'desconhecido'} (${report?.error || ''})`);
    }
  } catch (err) {
    logger.warn(`[Bootstrap] GTACars indisponível, seguindo com o cache local: ${err.message}`);
  }

  // 1.3 Validação e Auto-Download de ferramentas de mídia (yt-dlp, ffmpeg) e checagem de voz (Opus, criptografia)
  let mediaStatus = null;
  try {
    mediaStatus = await validateMediaTools();
    const sim = (ok) => (ok ? 'OK' : 'AUSENTE');
    logger.info(
      `[Bootstrap] Mídia: yt-dlp=${sim(mediaStatus.ytdlpOk)} ffmpeg=${sim(mediaStatus.ffmpegOk)} ` +
      `opus=${sim(mediaStatus.opusOk)} cripto-voz=${sim(mediaStatus.cryptoOk)} dave=${sim(mediaStatus.daveOk)}`
    );
    if (!mediaStatus.opusOk) {
      logger.warn('[Bootstrap] Voz/rádio sem codificador Opus: entrar na call e o Modo Rádio serão recusados até instalar opusscript (ou @discordjs/opus) e reiniciar.');
    }
  } catch (err) {
    logger.warn(`[Bootstrap] Verificação de ferramentas de mídia: ${err.message}`);
  }

  // 1.3.1 O yt-dlp fica defasado com facilidade (os sites mudam): atualiza em segundo plano na
  // inicialização e uma vez por dia em horário de pouco uso. Não bloqueia o boot; falha vira só aviso no log.
  try {
    startYtdlpAutoUpdate();
  } catch (err) {
    logger.warn(`[Bootstrap] Atualização automática do yt-dlp não agendada: ${err.message}`);
  }

  // 2. Criar e logar cliente Discord
  if (!config.discord.token) {
    logger.error('❌ DISCORD_TOKEN não encontrado no arquivo .env! Configure as credenciais.');
    process.exit(1);
  }

  const client = createDiscordClient();
  discordClient = client;
  await registerHikariEvents(client);

  try {
    await client.login(config.discord.token);
  } catch (err) {
    logger.error(
      `❌ Falha ao logar no Discord. Verifique se o DISCORD_TOKEN no .env está correto e não expirou. Detalhe: ${err.message}`
    );
    process.exit(1);
  }

  // Cérebro separado (etapa 6): as mensagens "Processando..." que ficaram paradas numa queda recebem o aviso quando o Discord estiver pronto.
  if (SEPARADO) {
    if (client.isReady?.()) avisarProcessandoParados(client);
    else client.once('ready', () => { avisarProcessandoParados(client); });
  }

  // 3. Registrar Slash Commands automaticamente se configurado
  if (config.discord.clientId) {
    await deploySlashCommands();
  }

  // 3.1 Avisos automáticos ao dono (DM) quando algo der errado
  const alertOwnerId = ownerUserId();
  configureAlerts({ ownerId: alertOwnerId, notify: async (id, text) => (await client.users.fetch(id)).send(text) });
  alertOwner('boot', 'Estou no ar', 'A Yui acabou de iniciar (ou reiniciar) e já está conectada ao Discord.', { level: 'info', cooldownMinutes: 5 });
  if (mediaStatus && !mediaStatus.opusOk) {
    alertOwner(
      'media:opus',
      'Voz e rádio sem codificador Opus',
      'O codificador Opus não foi encontrado: entrar na call e o Modo Rádio ficam desativados (a Yui avisa quem tentar). Instale opusscript@0.0.8 (ou @discordjs/opus) e reinicie.',
      { cooldownMinutes: 720 }
    );
  }
  // Reconexões do Discord são normais e frequentes: só vão para o log (o aviso por DM é só na inicialização).
  client.on('shardResume', () => logger.info('[Discord] Conexão retomada.'));
  setInterval(async () => {
    try {
      const { getGateway, gatewayInChain } = await import('./gateway/index.js');
      if (!gatewayInChain()) return;
      for (const p of getGateway().status().providers) {
        // Descanso longo = erro que não passa sozinho (sem crédito, chave inválida, modelo removido).
        if (p.cooldownSeconds > 600) {
          const last = p.targets.map((t) => t.lastError).find(Boolean) || 'sem detalhes';
          alertOwner('provider:' + p.id, p.label + ' parou de responder', 'Em descanso por ' + Math.ceil(p.cooldownSeconds / 60) + ' min. Último erro: ' + last, { cooldownMinutes: 360 });
        }
      }
    } catch (err) {
      logger.warn('[Alertas] Falha ao verificar provedores: ' + err.message);
    }
  }, 10 * 60 * 1000).unref();

  // 4. Iniciar Agendador Central (Cron + Newswire com delay de inicialização)
  //    Com o cérebro separado, os lembretes, o relatório matinal e a limpeza da memória rodam no cérebro.
  if (SEPARADO) startScheduler(client, { reminders: false, memoryPurge: false });
  else startScheduler(client);

  if (SEPARADO) {
    logger.info('[Bootstrap] Yui API e Gateway: sobem no cérebro (node src/cerebro.js), não aqui.');
  } else {
    // 5. Yui API (opcional; YUI_API_ENABLED=true) — interface HTTP do Core para os apps
    startApi(client);

    // 6. Yui Gateway (servidor de IA compatível com OpenAI; opcional: YUI_GATEWAY_ENABLED=true)
    startGatewayServer();
  }

  logger.info('✅ Yui inicializada e pronta com sucesso!');
  if (SEPARADO) {
    botPronto = true;
    supervisorLink.pronto();
  }
}

// Tratamento global de erros para evitar queda do processo
// A chave do aviso é a causa-raiz (igual para exceção e rejeição: uma causa, uma DM) e o corpo inclui
// o primeiro frame da pilha que está em src/ (veja core/alerts.js). Os handlers nunca lançam.
// Falha de rede numa conexão do Discord já descartada (isHarmlessNetworkCrash) vira só aviso no log, sem DM.
function logHarmlessNetworkCrash(reason) {
  logger.warn(`[Discord] Falha de rede numa conexão já descartada (${reason.message}). Sem efeito: a Yui reconecta sozinha.`);
}

process.on('unhandledRejection', (reason) => {
  try {
    if (isHarmlessNetworkCrash(reason)) return logHarmlessNetworkCrash(reason);
    if (isChromeProfileCleanupError(reason)) {
      return logger.warn('[Chrome] Não deu para apagar o perfil temporário (arquivo em uso). Sem efeito: a Yui limpa numa próxima varredura.');
    }
    logger.error(`Unhandled Rejection: ${describeReason(reason)}`);
    alertOwner(crashAlertKey(reason), 'Erro inesperado (promessa rejeitada)', formatCrashDetail(reason, { maxLines: 3 }), { level: 'error' });
  } catch (err) {
    logger.error(`Falha ao tratar uma promessa rejeitada: ${err.message}`);
  }
});

process.on('uncaughtException', (error) => {
  try {
    if (isHarmlessNetworkCrash(error)) return logHarmlessNetworkCrash(error);
    if (isChromeProfileCleanupError(error)) return logger.warn('[Chrome] Perfil temporário em uso na limpeza. Sem efeito.');
    logger.error(`Uncaught Exception: ${describeReason(error)}`);
    alertOwner(crashAlertKey(error), 'Erro grave na Yui', formatCrashDetail(error, { maxLines: 4 }), { level: 'error' });
  } catch (err) {
    logger.error(`Falha ao tratar uma exceção não capturada: ${err.message}`);
  }
});

bootstrap().catch((err) => {
  logger.error(`❌ Falha fatal ao inicializar a Yui: ${err.stack || err.message}`);
  process.exit(1);
});
