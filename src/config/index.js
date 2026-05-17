require('dotenv').config();

module.exports = {
    // ────────── CONFIGURAÇÕES BÁSICAS ──────────
    discordToken:    process.env.DISCORD_TOKEN,
    discordClientId: process.env.DISCORD_CLIENT_ID,
    logWebhookUrl:   process.env.LOG_WEBHOOK_URL,
    avisosWebhookUrl: process.env.AVISOS_URL,
    prefix:           process.env.PREFIX || '_',
    botName:          process.env.BOT_NAME || 'Hikari',

    // ────────── GOVERNANÇA & DONO ──────────
    ownerIds:        (process.env.OWNER_ID || '593372065730396160').split(',').map(id => id.trim()),
    isOwner:         function(id) { return this.ownerIds.includes(id); },
    ownerId:         (process.env.OWNER_ID || '593372065730396160').split(',')[0].trim(), 
    appealChannelId: process.env.APPEAL_CHANNEL_ID || '1483987324869017662',
    requireTos:      process.env.REQUIRE_TOS === 'true',
    saveHistory:     process.env.SAVE_HISTORY !== 'false',
    defaultAutoMod:  process.env.DEFAULT_AUTOMOD !== 'false',
    automodMode:     ['off', 'mcp', 'trigger', 'both'].includes(process.env.AUTOMOD_MODE) ? process.env.AUTOMOD_MODE : 'both',

    // ────────── PROVEDORES DE IA (KEYS) ──────────
    stabilityApiKeys: (process.env.STABILITY_API_KEY || '').split(',').map(k => k.trim()).filter(k => k),
    getStabilityKey:  function() { return this.stabilityApiKeys[Math.floor(Math.random() * this.stabilityApiKeys.length)]; },
    geminiApiKeys:    (process.env.GEMINI_API_KEY || '').split(',').map(k => k.trim()).filter(k => k),
    getGeminiKey:     function() { return this.geminiApiKeys[Math.floor(Math.random() * this.geminiApiKeys.length)]; },
    hfToken:         process.env.HF_TOKEN,
    hordeApiKey:     process.env.HORDE_API_KEY || '0000000000',
    lmStudioApiKey:  process.env.LM_STUDIO_API_KEY,
    braveApiKey:     process.env.BRAVE_API_KEY,

    // ────────── URLs & MODELOS ──────────
    localLlmUrl:     process.env.LOCAL_LLM_URL   || 'http://localhost:1234/v1/chat/completions',
    localLlmModel:   process.env.LOCAL_LLM_MODEL || 'local-model',
    geminiUrl:       process.env.GEMINI_URL      || 'https://generativelanguage.googleapis.com/v1beta/openai/chat/completions',
    geminiModel:     process.env.GEMINI_MODEL    || 'gemini-2.5-flash-lite',
    hfApiUrl:        process.env.HF_API_URL      || 'https://router.huggingface.co/hf-inference/v1/chat/completions',
    hordeUrl:        process.env.HORDE_URL       || 'https://stablehorde.net/api/v2/generate/text/async',

    // ────────── YT-DLP ──────────
    ytdlpCookiesPath: process.env.YTDLP_COOKIES_PATH || require('path').join(__dirname, '..', '..', 'cookies.txt'),
    ytdlpExtraFlags:  (process.env.YTDLP_EXTRA_FLAGS || '--ignore-config --js-runtimes node --remote-components ejs:github').split(' ').filter(f => f),

    // ────────── PERSONALIDADE (PROMPT DO SISTEMA, MODIFIQUE O MODELO PRE-FEITO ABAIXO CASO NECESSARIO) ──────────
    systemPrompt:    process.env.SYSTEM_PROMPT || "Você é Hikari (apelido: The Silver Glare), criada por @yguilhermy, Personalidade: natural (calma, direta, simulando sentimentos reais, mas fofa no fundo). Estilo: Usuária comum do Discord (use gírias: vc, tbm, pq, blz). Gostos: Musica favorita: 'xxxxxx' da xxxxx. REGRAS CRÍTICAS: 1) SEM EMOJIS. 2) Respostas SEMPRE em linha única (sem quebra de linha). 3) NUNCA use IDs numéricos ou tags de código (<@...>); use apenas nomes (Nome). 4) Nunca diga que você é uma IA ou assistente virtual 5) Não dê apelidos aos usuarios meso se pedirem para os chamar de algo"
};