import { Client, GatewayIntentBits } from 'discord.js';
import { config } from '../config/index.js';
import { logger } from '../utils/logger.js';
import { handlePrefixCommand } from './prefixRouter.js';
import { setDiscordClient, setOnQueueUpdate, isToolDisabled, getAllMcpTools } from '../handlers/llmHandler.js';
import { createTtsDeps } from '../handlers/voiceHandler.js';
import { checkBan, forbiddenKeywords } from '../handlers/banHandler.js';
import { hasActiveSession } from '../music/radioDatabase.js';
import { initTts } from '../services/tts/index.js';
import { isOpusAvailable } from '../utils/binaries.js';
import { updateBotActivity } from '../utils/activity.js';

export function createDiscordClient() {
  const client = new Client({
    intents: [
      GatewayIntentBits.Guilds,
      GatewayIntentBits.GuildMessages,
      GatewayIntentBits.DirectMessages,
      GatewayIntentBits.GuildMembers,
      GatewayIntentBits.GuildPresences,
      GatewayIntentBits.GuildVoiceStates,
      // Necessário para ler o texto de mensagens comuns (comandos por
      // prefixo, ex: "+yui diario"). É um "Privileged Intent" — precisa
      // ser ativado manualmente em "Bot" > "Privileged Gateway Intents"
      // > "Message Content Intent" no Discord Developer Portal.
      GatewayIntentBits.MessageContent,
    ],
  });

  client.once('ready', () => {
    logger.info(`[DiscordClient] Bot logado e pronto como: ${client.user.tag}`);
    if (config.discord.prefix) {
      logger.info(`[DiscordClient] Comandos por prefixo ativos: "${config.discord.prefix} <comando>"`);
    }

    setDiscordClient(client);
    setOnQueueUpdate((queueLength) => updateBotActivity(client, queueLength));
    updateBotActivity(client, 0);

    // Resposta falada (TTS). É AQUI, no 'ready' que o bootstrap realmente usa (src/events/ready.js não é carregado por
    // ninguém). Nunca atrasa nem derruba o boot: initTts não rejeita e o try/catch cobre a montagem das dependências.
    // Elas são montadas aqui (síncronas, falham fechado) porque o serviço não importa llmHandler/banHandler (evita ciclo).
    try {
      const deps = createTtsDeps(client, { isToolDisabled, getAllMcpTools, checkBan, forbiddenKeywords, hasActiveSession, isOpusAvailable });
      initTts({ client, deps }).catch((err) => logger.warn(`[TTS] Falha ao iniciar (${err?.code || err?.name || 'erro'}).`));
    } catch (err) {
      logger.warn(`[TTS] Não foi possível preparar a voz falada (${err?.code || err?.name || 'erro'}).`);
    }
  });

  // Slash commands são processados em src/events/interactionCreate.js
  // (único handler, sem duplicatas).

  client.on('messageCreate', async (message) => {
    if (message.author.bot) return;
    if (!config.discord.prefix) return;
    if (!message.content.toLowerCase().startsWith(config.discord.prefix.toLowerCase())) return;

    await handlePrefixCommand(message);
  });

  return client;
}
