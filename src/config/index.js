const path = require('path');
const fs = require('fs');
require('dotenv').config();

const defaultValues = {
    discordToken: '',
    discordClientId: '',
    logWebhookUrl: '',
    avisosWebhookUrl: '',
    prefix: '_',
    botName: 'Hikari',
    ownerIds: ['593372065730396160'],
    automodWhitelist: ['593372065730396160'],
    appealChannelId: '1483987324869017662',
    requireTos: false,
    saveHistory: true,
    defaultAutoMod: true,
    automodMode: 'both',
    sendEnvironmentInfo: true,
    stabilityApiKeys: [],
    geminiApiKeys: [],
    hfToken: '',
    hordeApiKey: '0000000000',
    hordeImageApiKey: '',
    lmStudioApiKey: '',
    braveApiKey: '',
    togetherApiKey: '',
    localLlmUrl: 'http://localhost:1234/v1/chat/completions',
    localLlmModel: 'local-model',
    geminiUrl: 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    geminiModel: 'gemini-2.5-flash-lite',
    geminiModelFallback: 'gemini-2.5-flash',
    hfApiUrl: 'https://router.huggingface.co/hf-inference/v1/chat/completions',
    hordeUrl: 'https://stablehorde.net/api/v2/generate/text/async',
    ytdlpCookiesPath: '',
    ytdlpExtraFlags: ['--ignore-config', '--js-runtimes', 'node', '--remote-components', 'ejs:github'],
    systemPrompt: "Você é Hikari (apelido: The Silver Glare), criada por @yguilhermy. Personalidade: natural (calma, direta, simulando sentimentos reais, mas fofa no fundo). Estilo: Usuária comum do Discord (use gírias: vc, tbm, pq, blz). Gostos: Musica favorita: 'xxxxxx' da xxxxx. REGRAS CRÍTICAS: 1) SEM EMOJIS. 2) Respostas SEMPRE em linha única (sem quebra de linha). 3) NUNCA use IDs numéricos ou tags de código (<@...>); use apenas nomes (Nome). 4) Nunca diga que você é uma IA ou assistente virtual. 5) Não dê apelidos aos usuários mesmo se pedirem para os chamar de algo."
};

const envMap = {
    DISCORD_TOKEN: 'discordToken',
    DISCORD_CLIENT_ID: 'discordClientId',
    LOG_WEBHOOK_URL: 'logWebhookUrl',
    AVISOS_URL: 'avisosWebhookUrl',
    PREFIX: 'prefix',
    BOT_NAME: 'botName',
    OWNER_ID: 'ownerIds',
    AUTOMOD_WHITELIST: 'automodWhitelist',
    APPEAL_CHANNEL_ID: 'appealChannelId',
    REQUIRE_TOS: 'requireTos',
    SAVE_HISTORY: 'saveHistory',
    DEFAULT_AUTOMOD: 'defaultAutoMod',
    AUTOMOD_MODE: 'automodMode',
    SEND_ENVIRONMENT_INFO: 'sendEnvironmentInfo',
    STABILITY_API_KEY: 'stabilityApiKeys',
    GEMINI_API_KEY: 'geminiApiKeys',
    HF_TOKEN: 'hfToken',
    HORDE_API_KEY: 'hordeApiKey',
    HORDE_IMAGE_API_KEY: 'hordeImageApiKey',
    LM_STUDIO_API_KEY: 'lmStudioApiKey',
    BRAVE_API_KEY: 'braveApiKey',
    TOGETHER_API_KEY: 'togetherApiKey',
    LOCAL_LLM_URL: 'localLlmUrl',
    LOCAL_LLM_MODEL: 'localLlmModel',
    GEMINI_URL: 'geminiUrl',
    GEMINI_MODEL: 'geminiModel',
    GEMINI_MODEL_FALLBACK: 'geminiModelFallback',
    HF_API_URL: 'hfApiUrl',
    HORDE_URL: 'hordeUrl',
    YTDLP_COOKIES_PATH: 'ytdlpCookiesPath',
    YTDLP_EXTRA_FLAGS: 'ytdlpExtraFlags',
    SYSTEM_PROMPT: 'systemPrompt'
};

const placeholders = [
    'seu_token_aqui',
    'seu_client_id_aqui',
    'https://discord.com/api/webhooks/...',
    'suas_chave_gemini',
    'sua_chave_stability',
    'seu_token_huggingface',
    'opcional'
];

function isInvalidEnvValue(val) {
    if (!val) return true;
    const cleaned = val.trim().toLowerCase();
    return placeholders.includes(cleaned);
}

const resolvedConfig = { ...defaultValues };

const configJsonPath = path.join(__dirname, 'config.json');
if (fs.existsSync(configJsonPath)) {
    try {
        const rawContent = fs.readFileSync(configJsonPath, 'utf8');
        const cleanContent = rawContent.replace(/\\"|"(?:\\"|[^"])*"|(\/\/.*|\/\*[\s\S]*?\*\/)/g, (m, g) => g ? "" : m);
        const jsonConfig = JSON.parse(cleanContent);
        for (const key of Object.keys(jsonConfig)) {
            let value = jsonConfig[key];
            if (value !== undefined && value !== null) {
                if (['ownerIds', 'automodWhitelist', 'stabilityApiKeys', 'geminiApiKeys'].includes(key) && typeof value === 'string') {
                    value = value.split(',').map(id => id.trim()).filter(id => id);
                }
                if (key === 'ytdlpExtraFlags' && typeof value === 'string') {
                    value = value.split(' ').map(f => f.trim()).filter(f => f);
                }
                if (key === 'ytdlpCookiesPath' && typeof value === 'string' && value) {
                    value = path.isAbsolute(value) ? value : path.resolve(__dirname, '..', '..', value);
                }
                resolvedConfig[key] = value;
            }
        }
    } catch (error) {
        console.error('Erro ao ler config.json:', error.message);
    }
}

for (const envKey of Object.keys(envMap)) {
    const envVal = process.env[envKey];
    if (envVal !== undefined && !isInvalidEnvValue(envVal)) {
        const configKey = envMap[envKey];
        let parsedVal = envVal.trim();
        if (['ownerIds', 'automodWhitelist', 'stabilityApiKeys', 'geminiApiKeys'].includes(configKey)) {
            parsedVal = envVal.split(',').map(id => id.trim()).filter(id => id);
        } else if (configKey === 'ytdlpExtraFlags') {
            parsedVal = envVal.split(' ').map(f => f.trim()).filter(f => f);
        } else if (configKey === 'requireTos') {
            parsedVal = envVal === 'true';
        } else if (['saveHistory', 'defaultAutoMod', 'sendEnvironmentInfo'].includes(configKey)) {
            parsedVal = envVal !== 'false';
        } else if (configKey === 'automodMode') {
            parsedVal = ['off', 'mcp', 'trigger', 'both'].includes(envVal) ? envVal : 'both';
        } else if (configKey === 'ytdlpCookiesPath') {
            parsedVal = path.isAbsolute(envVal) ? envVal : path.resolve(__dirname, '..', '..', envVal);
        }
        resolvedConfig[configKey] = parsedVal;
    }
}

if (!resolvedConfig.ytdlpCookiesPath) {
    resolvedConfig.ytdlpCookiesPath = path.join(__dirname, '..', '..', 'cookies.txt');
}

if (!resolvedConfig.hordeImageApiKey) {
    resolvedConfig.hordeImageApiKey = resolvedConfig.hordeApiKey || '0000000000';
}

const config = {
    ...resolvedConfig,
    isOwner: function(id) {
        return this.ownerIds.includes(id);
    },
    ownerId: resolvedConfig.ownerIds[0] || '',
    isAutomodWhitelisted: function(id) {
        return this.automodWhitelist.includes(id);
    },
    getStabilityKey: function() {
        if (!this.stabilityApiKeys.length) return '';
        return this.stabilityApiKeys[Math.floor(Math.random() * this.stabilityApiKeys.length)];
    },
    getGeminiKey: function() {
        if (!this.geminiApiKeys.length) return '';
        return this.geminiApiKeys[Math.floor(Math.random() * this.geminiApiKeys.length)];
    }
};

module.exports = config;