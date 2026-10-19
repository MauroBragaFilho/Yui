import dotenv from 'dotenv';
import { currentGeminiModel, GEMINI_FAST, GEMINI_SMART } from '../utils/geminiModels.js';
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
    // Habilita/desabilita a verificação automática do Rockstar Newswire
    // no scheduler. Padrão: false (desativado). O motor continua disponível
    // para uso manual via /gta-semanal fonte:newswire.
    enabled: process.env.NEWSWIRE_ENABLED === 'true',
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
  youtube: {
    apiKey: process.env.YOUTUBE_API_KEY || '',
    // Polling interval em minutos para checagem de canais cadastrados
    intervalMinutes: parseInt(process.env.YOUTUBE_INTERVAL_MINUTES || '5', 10),
  },
  twitch: {
    clientId: process.env.TWITCH_CLIENT_ID || '',
    clientSecret: process.env.TWITCH_CLIENT_SECRET || '',
    // Polling interval em minutos para checagem de streamers (1-2 min recomendado)
    intervalMinutes: parseInt(process.env.TWITCH_INTERVAL_MINUTES || '2', 10),
  },
  weekly: {
    // Habilita/desabilita a busca semanal do r/gtaonline via Reddit.
    enabled: process.env.GTA_WEEKLY_ENABLED !== 'false',
    // Frequência de verificação em minutos (default: 30).
    intervalMinutes: parseInt(process.env.GTA_WEEKLY_INTERVAL_MINUTES || '30', 10),
    // User-Agent identificável exigido pelo Reddit.
    userAgent:
      process.env.REDDIT_USER_AGENT ||
      'nodejs:yui-gta-bot:1.0 (by /u/your_reddit_username)',
  },
};

// Chaves lidas na hora (getters): o painel pode adicionar chaves sem reiniciar a Yui.
const keyList = (...names) => [...new Set(names.flatMap((n) => String(process.env[n] || '').split(',')).map((key) => key.trim()).filter(Boolean))];

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
  geminiModel: currentGeminiModel(process.env.GEMINI_MODEL, GEMINI_FAST),
  geminiModelFallback: currentGeminiModel(process.env.GEMINI_MODEL_FALLBACK, GEMINI_SMART),
  // Aceita GEMINI_API_KEYS (várias, para rotação) e GEMINI_API_KEY (uma ou várias), como na documentação.
  get geminiApiKeys() { return keyList('GEMINI_API_KEYS', 'GEMINI_API_KEY'); },
  hfApiUrl: process.env.HF_API_URL || 'https://router.huggingface.co/v1/chat/completions',
  hfModel: process.env.HF_MODEL || 'Qwen/Qwen2.5-72B-Instruct',
  get hfToken() { return process.env.HF_TOKEN || ''; },
  get groqApiKeys() { return keyList('GROQ_API_KEY'); },
  groqApiUrl: process.env.GROQ_API_URL || 'https://api.groq.com/openai/v1/chat/completions',
  groqModel: process.env.GROQ_MODEL || 'openai/gpt-oss-120b',
  hordeUrl: process.env.HORDE_URL || 'https://stablehorde.net/api/v2/generate/text/async',
  hordeApiKey: process.env.HORDE_API_KEY || '0000000000',
  braveApiKey: process.env.BRAVE_API_KEY || '',
  get togetherApiKey() { return process.env.TOGETHER_API_KEY || ''; },
  // Aceita STABILITY_API_KEYS (várias) e STABILITY_API_KEY (uma ou várias).
  get stabilityApiKeys() { return keyList('STABILITY_API_KEYS', 'STABILITY_API_KEY'); },
  hordeImageApiKey: process.env.HORDE_IMAGE_API_KEY || '',
  get cloudflareAccountId() { return process.env.CLOUDFLARE_ACCOUNT_ID || ''; },
  get cloudflareApiToken() { return process.env.CLOUDFLARE_API_TOKEN || ''; },
  cloudflareModel: process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast',
  ytdlpCookiesPath: process.env.YTDLP_COOKIES_PATH || '',
  ytdlpExtraFlags: ['--ignore-config', '--js-runtimes', 'node', '--remote-components', 'ejs:github'],
  isOwner: (id) => id && (id === process.env.OWNER_ID || (process.env.OWNER_IDS || '').split(',').map((v) => v.trim()).includes(id)),
  // Usada pelo imageHandler: escolhe uma chave ao acaso (balanceamento de créditos entre várias chaves).
  getStabilityKey: () => {
    const keys = keyList('STABILITY_API_KEYS', 'STABILITY_API_KEY');
    return keys.length ? keys[Math.floor(Math.random() * keys.length)] : null;
  },
  isAutomodWhitelisted: (id) => id && (id === process.env.OWNER_ID || (process.env.OWNER_IDS || '').split(',').map((v) => v.trim()).includes(id)),
};
