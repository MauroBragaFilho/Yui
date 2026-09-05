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
import { validateMediaTools } from './utils/binaries.js';

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

  // 1.3 Validação e Auto-Download de ferramentas de mídia (yt-dlp, ffmpeg)
  try {
    await validateMediaTools();
  } catch (err) {
    logger.warn(`[Bootstrap] Verificação de ferramentas de mídia: ${err.message}`);
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

  // 4. Iniciar Agendador Central (Cron + Newswire com delay de inicialização)
  startScheduler(client);

  logger.info('✅ Yui inicializada e pronta com sucesso!');
}

// Tratamento global de erros para evitar queda do processo
process.on('unhandledRejection', (reason) => {
  const detail = reason instanceof Error ? reason.stack || reason.message : JSON.stringify(reason);
  logger.error(`Unhandled Rejection: ${detail}`);
});

process.on('uncaughtException', (error) => {
  logger.error(`Uncaught Exception: ${error.stack || error.message}`);
});

bootstrap().catch((err) => {
  logger.error(`❌ Falha fatal ao inicializar a Yui: ${err.stack || err.message}`);
  process.exit(1);
});
