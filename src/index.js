import { config } from './config/index.js';
import { logger } from './utils/logger.js';
import { initDatabase } from './database/db.js';
import { CORE_SCHEMA, NEWSWIRE_SCHEMA, GTA_DAILY_SCHEMA, GTA_WEEKLY_SCHEMA } from './database/schemas.js';
import { createDiscordClient } from './discord/client.js';
import { startScheduler } from './scheduler/scheduler.js';
import { newswireEngine } from './engines/newswire/index.js';
import { discordPublisher } from './discord/publisher.js';
import { deploySlashCommands } from './discord/deployCommands.js';
import { downloadTunables } from './utils/tunables.js';
import { downloadVehicleData } from './utils/vehicleData.js';
import { downloadWeaponData } from './utils/weaponData.js';

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

  // 1. Inicializar os bancos de dados SQLite (WASM / Puro JS - Sem C++).
  // Cada domínio de dados vive no seu próprio arquivo dentro de
  // `database/`, preparando terreno para suportar outros jogos além do
  // GTA Online no futuro sem misturar tabelas:
  //   database/core.db        -> configuração de canais / dedup de publicações (compartilhado entre jogos)
  //   database/newswire.db    -> histórico de notícias do Rockstar Newswire
  //   database/gta-diario.db  -> resets diários do GTA Online
  //   database/gta-semanal.db -> eventos semanais do GTA Online
  logger.info('[Bootstrap] Inicializando bancos de dados...');
  await initDatabase('core', CORE_SCHEMA);
  await initDatabase('newswire', NEWSWIRE_SCHEMA);
  await initDatabase('gta-diario', GTA_DAILY_SCHEMA);
  await initDatabase('gta-semanal', GTA_WEEKLY_SCHEMA);
  logger.info('[Bootstrap] Todos os bancos de dados inicializados com sucesso.');

  // 1.1 Baixar/atualizar os tunables (fonte real: RDO.GG) usados pela Van
  // de Armas. Se falhar e já existir cache local, o bot continua com os
  // dados antigos.
  try {
    await downloadTunables();
  } catch (err) {
    logger.warn(`[Bootstrap] Não foi possível baixar tunables e não há cache local: ${err.message}`);
  }

  // 1.2 Baixar/atualizar os dumps de veículos e armas (fonte:
  // DurtyFree/gta-v-data-dumps), usados pelo /yui-perguntar para
  // responder com dados técnicos reais do jogo. Falha não é fatal — o
  // bot segue funcionando normalmente sem esses dados, só sem essa
  // funcionalidade específica até o próximo restart bem-sucedido.
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
