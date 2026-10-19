import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { initDatabase } from './database/db.js';
import { CORE_SCHEMA, NEWSWIRE_SCHEMA, GTA_DAILY_SCHEMA, GTA_WEEKLY_SCHEMA, YOUTUBE_SCHEMA, TWITCH_SCHEMA } from './database/schemas.js';
import { createDiscordClient } from './discord/client.js';
import { startScheduler } from './scheduler/scheduler.js';
import { deploySlashCommands } from './discord/deployCommands.js';
import { downloadTunables } from './utils/tunables.js';
import { downloadVehicleData } from './utils/vehicleData.js';
import { downloadWeaponData } from './utils/weaponData.js';
import { updateVehicles as updateGtaCarsVehicles } from './services/gta/vehicles/gtacars/service.js';
import { validateMediaTools, startYtdlpAutoUpdate } from './utils/binaries.js';
import { initMemory } from './core/index.js';
import { startApi } from './core/api/server.js';
import { startGatewayServer } from './gateway/index.js';
import { applyAiSettings } from './core/aiSettings.js';
import { alertOwner, configureAlerts, crashAlertKey, describeReason, formatCrashDetail } from './core/alerts.js';
import { ownerUserId } from './core/api/auth.js';

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

  // 1. Inicializar os bancos de dados SQLite (WASM / Puro JS - Sem C++).
  logger.info('[Bootstrap] Inicializando bancos de dados...');
  await initDatabase('core', CORE_SCHEMA);
  await initDatabase('newswire', NEWSWIRE_SCHEMA);
  await initDatabase('gta-diario', GTA_DAILY_SCHEMA);
  await initDatabase('gta-semanal', GTA_WEEKLY_SCHEMA);
  await initDatabase('social-youtube', YOUTUBE_SCHEMA);
  await initDatabase('social-twitch', TWITCH_SCHEMA);
  // Junta as chaves/provedores salvos pelo painel com o .env (antes de qualquer provedor de IA).
  applyAiSettings();

  await initMemory();
  logger.info('[Bootstrap] Todos os bancos de dados inicializados com sucesso.');

  // 1.1 Baixar/atualizar os tunables (RDO.GG) para a Van de Armas
  try {
    await downloadTunables();
  } catch (err) {
    logger.warn(`[Bootstrap] Não foi possível baixar tunables e não há cache local: ${err.message}`);
  }

  // 1.2 Baixar/atualizar os dumps de veículos e armas
  try {
    await downloadVehicleData();
  } catch (err) {
    logger.warn(`[Bootstrap] Vehicle data indisponível, seguindo sem: ${err.message}`);
  }
  try {
    await downloadWeaponData();
  } catch (err) {
    logger.warn(`[Bootstrap] Weapon data indisponível, seguindo sem: ${err.message}`);
  }

  // 1.2.1 Atualizar base de veículos do GTACars (fonte independente). O cache
  // já é carregado no import do service; este update garante frescor (24h).
  try {
    const report = await updateGtaCarsVehicles();
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
  await registerHikariEvents(client);

  try {
    await client.login(config.discord.token);
  } catch (err) {
    logger.error(
      `❌ Falha ao logar no Discord. Verifique se o DISCORD_TOKEN no .env está correto e não expirou. Detalhe: ${err.message}`
    );
    process.exit(1);
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
  startScheduler(client);

  // 5. Yui API (opcional; YUI_API_ENABLED=true) — interface HTTP do Core para os apps
  startApi(client);

  // 6. Yui Gateway (servidor de IA compatível com OpenAI; opcional: YUI_GATEWAY_ENABLED=true)
  startGatewayServer();

  logger.info('✅ Yui inicializada e pronta com sucesso!');
}

// Tratamento global de erros para evitar queda do processo
// A chave do aviso é a causa-raiz (igual para exceção e rejeição: uma causa, uma DM) e o corpo inclui
// o primeiro frame da pilha que está em src/ (veja core/alerts.js). Os handlers nunca lançam.
process.on('unhandledRejection', (reason) => {
  try {
    logger.error(`Unhandled Rejection: ${describeReason(reason)}`);
    alertOwner(crashAlertKey(reason), 'Erro inesperado (promessa rejeitada)', formatCrashDetail(reason, { maxLines: 3 }), { level: 'error' });
  } catch (err) {
    logger.error(`Falha ao tratar uma promessa rejeitada: ${err.message}`);
  }
});

process.on('uncaughtException', (error) => {
  try {
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
