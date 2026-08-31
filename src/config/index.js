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
    // Pasta onde ficam os arquivos .db, um por domínio (ex: core.db,
    // newswire.db, gta-diario.db, gta-semanal.db). Cada jogo/domínio novo
    // adicionado no futuro ganha seu próprio arquivo dentro desta pasta,
    // sem misturar tabelas de jogos diferentes no mesmo banco.
    dir: process.env.DATABASE_DIR || './database',
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
  binaries: {
    ytdlpPath: process.env.YTDLP_PATH || '',
    ffmpegPath: process.env.FFMPEG_PATH || '',
    ffprobePath: process.env.FFPROBE_PATH || '',
  },
};

// Compatibilidade com os módulos legados da Hikari, que usam configuração
// achatada e importação default.
export default {
  ...config,
  discordToken: config.discord.token,
  discordClientId: config.discord.clientId,
  prefix: config.discord.prefix,
  botName: config.ai.botName,
  ownerId: process.env.OWNER_ID || '',
  ownerIds: (process.env.OWNER_IDS || '').split(',').map((id) => id.trim()).filter(Boolean),
  requireTos: process.env.REQUIRE_TOS !== 'false',
  saveHistory: true,
  defaultAutoMod: true,
  automodMode: 'both',
  sendEnvironmentInfo: true,
  localLlmUrl: process.env.LOCAL_LLM_URL || process.env.AI_BASE_URL || 'http://localhost:1234/v1/chat/completions',
  localLlmModel: process.env.LOCAL_LLM_MODEL || process.env.AI_MODEL || 'local-model',
  lmStudioApiKey: process.env.LM_STUDIO_API_KEY || process.env.AI_API_KEY || '',
  geminiUrl: process.env.GEMINI_URL || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
  geminiModel: process.env.GEMINI_MODEL || 'gemini-2.5-flash-lite',
  geminiModelFallback: process.env.GEMINI_MODEL_FALLBACK || 'gemini-2.5-flash',
  geminiApiKeys: (process.env.GEMINI_API_KEYS || '').split(',').map((key) => key.trim()).filter(Boolean),
  hfApiUrl: process.env.HF_API_URL || 'https://router.huggingface.co/v1/chat/completions',
  hfModel: process.env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
  hfToken: process.env.HF_TOKEN || '',
  hordeUrl: process.env.HORDE_URL || 'https://stablehorde.net/api/v2/generate/text/async',
  hordeApiKey: process.env.HORDE_API_KEY || '0000000000',
  braveApiKey: process.env.BRAVE_API_KEY || '',
  togetherApiKey: process.env.TOGETHER_API_KEY || '',
  stabilityApiKeys: (process.env.STABILITY_API_KEYS || '').split(',').map((key) => key.trim()).filter(Boolean),
  hordeImageApiKey: process.env.HORDE_IMAGE_API_KEY || '',
  cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID || '',
  cloudflareApiToken: process.env.CLOUDFLARE_API_TOKEN || '',
  cloudflareModel: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast',
  ytdlpCookiesPath: process.env.YTDLP_COOKIES_PATH || '',
  ytdlpExtraFlags: ['--ignore-config', '--js-runtimes', 'node', '--remote-components', 'ejs:github'],
  isOwner: (id) => id && (id === process.env.OWNER_ID || (process.env.OWNER_IDS || '').split(',').map((v) => v.trim()).includes(id)),
  isAutomodWhitelisted: (id) => id && (id === process.env.OWNER_ID || (process.env.OWNER_IDS || '').split(',').map((v) => v.trim()).includes(id)),
};
