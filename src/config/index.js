import dotenv from 'dotenv';
import path from 'path';

dotenv.config();

export const config = {
  discord: {
    token: process.env.DISCORD_TOKEN || '',
    clientId: process.env.DISCORD_CLIENT_ID || '',
    guildId: process.env.DISCORD_GUILD_ID || '',
    // Prefixo para comandos por mensagem de texto (ex: "+yui diario").
    // Deixe vazio para desativar esse modo e usar só os Slash Commands (/yui-...).
    prefix: process.env.COMMAND_PREFIX ?? '+yui',
  },
  database: {
    path: process.env.DATABASE_PATH || './data/yui.db',
  },
  logging: {
    level: process.env.LOG_LEVEL || 'info',
  },
  environment: process.env.NODE_ENV || 'development',
  newswire: {
    intervalMinutes: parseInt(process.env.NEWSWIRE_INTERVAL_MINUTES || '30', 10),
  },
  ai: {
    // Compatível com qualquer endpoint no formato OpenAI /chat/completions:
    // LM Studio local (ex: http://localhost:1234/v1), OpenAI, OpenRouter, etc.
    baseUrl: process.env.AI_BASE_URL || '',
    apiKey: process.env.AI_API_KEY || '',
    model: process.env.AI_MODEL || '',
    maxTokens: parseInt(process.env.AI_MAX_TOKENS || '1500', 10),
    // Nome que a IA vai usar para se referir a si mesma e a "personalidade"
    // base dela. Pode ser customizado livremente aqui no .env, sem tocar
    // em código.
    botName: process.env.AI_BOT_NAME || 'Yui',
    systemPrompt: process.env.AI_SYSTEM_PROMPT || '',
    // Pasta onde você pode soltar arquivos .txt/.md com dicas, builds,
    // buffs/debuffs, etc. A Yui lê tudo automaticamente antes de responder.
    knowledgeDir: process.env.AI_KNOWLEDGE_DIR || './knowledge',
  },
};
