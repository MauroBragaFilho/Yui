import { REST, Routes } from 'discord.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { dailyCommand } from './commands/daily.js';
import { weeklyCommand } from './commands/weekly.js';
import { newsCommand } from './commands/news.js';
import { askCommand } from './commands/ask.js';
import { baixarMusicaCommand } from './commands/baixarMusica.js';
import { commands as hikariCommands } from '../commands/slashCommands.js';
import { seguirYoutubeCommand } from './commands/seguirYoutube.js';
import { seguirTwitchCommand } from './commands/seguirTwitch.js';
import { pararSeguirCommand } from './commands/pararSeguir.js';
import { listarSeguindoCommand } from './commands/listarSeguindo.js';

const commands = [
  setupCommand.data.toJSON(),
  statusCommand.data.toJSON(),
  dailyCommand.data.toJSON(),
  weeklyCommand.data.toJSON(),
  newsCommand.data.toJSON(),
  askCommand.data.toJSON(),
  baixarMusicaCommand.data.toJSON(),
  seguirYoutubeCommand.data.toJSON(),
  seguirTwitchCommand.data.toJSON(),
  pararSeguirCommand.data.toJSON(),
  listarSeguindoCommand.data.toJSON(),
  ...hikariCommands.map((command) => typeof command.toJSON === 'function' ? command.toJSON() : command),
];

export async function deploySlashCommands() {
  if (!config.discord.token || !config.discord.clientId) {
    logger.warn('[DeployCommands] Token ou Client ID ausentes no .env. Registro de comandos ignorado.');
    return;
  }

  const rest = new REST({ version: '10' }).setToken(config.discord.token);

  try {
    if (config.discord.guildId) {
      logger.info(
        `[DeployCommands] Registrando ${commands.length} comandos no servidor ${config.discord.guildId} (instantâneo)...`
      );
      await rest.put(
        Routes.applicationGuildCommands(config.discord.clientId, config.discord.guildId),
        { body: commands }
      );
      logger.info('[DeployCommands] Slash Commands registrados no servidor com sucesso!');

      try {
        const existingGlobal = await rest.get(Routes.applicationCommands(config.discord.clientId));
        if (existingGlobal.length > 0) {
          await rest.put(Routes.applicationCommands(config.discord.clientId), { body: [] });
          logger.info(
            `[DeployCommands] ${existingGlobal.length} comando(s) global(is) antigo(s) removido(s) para evitar duplicatas.`
          );
        }
      } catch (cleanupError) {
        logger.warn(`[DeployCommands] Não foi possível verificar/limpar comandos globais: ${cleanupError.message}`);
      }
    } else {
      logger.info(`[DeployCommands] Iniciando registro de ${commands.length} comandos Slash globais...`);
      logger.warn(
        '[DeployCommands] DISCORD_GUILD_ID não definido no .env — o registro será GLOBAL e pode levar até 1 hora para aparecer no Discord. Para testes instantâneos, defina DISCORD_GUILD_ID no .env.'
      );
      await rest.put(
        Routes.applicationCommands(config.discord.clientId),
        { body: commands }
      );
      logger.info('[DeployCommands] Slash Commands registrados globalmente com sucesso!');
    }
  } catch (error) {
    logger.error(`[DeployCommands] Falha ao registrar comandos: ${error.message}`);
  }
}

if (process.argv[1]?.endsWith('deployCommands.js')) {
  deploySlashCommands();
}
