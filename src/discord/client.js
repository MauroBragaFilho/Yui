import { Client, GatewayIntentBits, Collection } from 'discord.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { setupCommand } from './commands/setup.js';
import { statusCommand } from './commands/status.js';
import { dailyCommand } from './commands/daily.js';
import { weeklyCommand } from './commands/weekly.js';
import { newsCommand } from './commands/news.js';
import { askCommand } from './commands/ask.js';
import { handlePrefixCommand } from './prefixRouter.js';

export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      // Necessário para ler o texto de mensagens comuns (comandos por
      // prefixo, ex: "+yui diario"). É um "Privileged Intent" — precisa
      // ser ativado manualmente em "Bot" > "Privileged Gateway Intents"
      // > "Message Content Intent" no Discord Developer Portal.
      GatewayIntentBits.MessageContent,
    ],
  });

  client.commands = new Collection();
  const commandList = [setupCommand, statusCommand, dailyCommand, weeklyCommand, newsCommand, askCommand];
  for (const cmd of commandList) {
    client.commands.set(cmd.data.name, cmd);
  }

  client.once('ready', () => {
    logger.info(`[DiscordClient] Bot logado e pronto como: ${client.user.tag}`);
    if (config.discord.prefix) {
      logger.info(`[DiscordClient] Comandos por prefixo ativos: "${config.discord.prefix} <comando>"`);
    }
  });

  client.on('interactionCreate', async (interaction) => {
    if (!interaction.isChatInputCommand()) return;

    const command = client.commands.get(interaction.commandName);
    if (!command) return;

    try {
      await command.execute(interaction);
    } catch (error) {
      logger.error(`[DiscordClient] Erro ao executar /${interaction.commandName}: ${error.message}`);
      const replyOptions = {
        content: '❌ Ocorreu um erro interno ao processar este comando.',
        ephemeral: true,
      };

      if (interaction.replied || interaction.deferred) {
        await interaction.followUp(replyOptions).catch(() => null);
      } else {
        await interaction.reply(replyOptions).catch(() => null);
      }
    }
  });

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!config.discord.prefix) return;
    if (!message.content.toLowerCase().startsWith(config.discord.prefix.toLowerCase())) return;

    await handlePrefixCommand(message);
  });

  return client;
}
