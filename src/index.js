import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { initDatabase } from './database/db.js';
import { createDiscordClient } from './discord/client.js';
import { startScheduler } from './scheduler/scheduler.js';
import { newswireEngine } from './engines/newswire/index.js';
import { discordPublisher } from './discord/publisher.js';
import { deploySlashCommands } from './discord/deployCommands.js';
import { downloadTunables } from './utils/tunables.js';

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
  logger.info(`Ambiente: ${config.environment} | Node: ${process.version}`);
  logger.info('====================================================');

  // 1. Inicializar banco de dados SQLite (WASM / Puro JS - Sem C++)
  await initDatabase();

  // 1.1 Baixar/atualizar os tunables (fonte real: RDO.GG) usados pela Gun Van.
  // Se falhar e já existir cache local, o bot continua com os dados antigos.
  try {
    await downloadTunables();
  } catch (err) {
    logger.warn(`[Bootstrap] Não foi possível baixar tunables e não há cache local: ${err.message}`);
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

  // 4. Iniciar Agendador Central (Cron)
  startScheduler(client);

  // 5. Catch-up de Inicialização (Verifica se há notícias perdidas durante o tempo que o bot esteve desligado)
  logger.info('[Bootstrap] Executando verificação inicial de sincronização...');
  try {
    const unpostedNews = await newswireEngine.checkLatestNews();
    if (unpostedNews.length > 0) {
      logger.info(`[Bootstrap] Publicando ${unpostedNews.length} notícia(s) acumulada(s)...`);
      await discordPublisher.publishNews(client, unpostedNews);
    }
  } catch (err) {
    logger.warn(`[Bootstrap] Falha na sincronização inicial do Newswire: ${err.message}`);
  }

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
