const axios = require('axios');
const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const { smartSearch } = require('./searchManager');
const { AttachmentBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, WebhookClient, ButtonBuilder, ButtonStyle } = require('discord.js');
const {
    downloadAudio,
    downloadVideo,
    sanitizeFilenameForDiscord,
    isUserBusy,
    lockUser,
    unlockUser,
    canBypass,
    storeVideoForCompression,
    formatVideoSuccessMessage
} = require('./youtubeAudioHandler');
const { searchGames, getTorrentOrMagnet, createPaginationComponents, normalizeString } = require('./gameHandler');
const { generateImage } = require('./imageHandler');
const { getSteamGameInfo } = require('./steamHandler');
const { convertCurrency } = require('./currencyHandler');
require('dotenv').config();
const config = require('../config');
const geminiCooldowns = {};
const mcpToolsPath = path.join(__dirname, '../data/mcp_tools.json');
const TERMS_FILE = path.join(__dirname, '../data/accepted_servers.json');
let ALL_MCP_TOOLS = [];
function loadMcpTools() {
    try {
        ALL_MCP_TOOLS = JSON.parse(fs.readFileSync(mcpToolsPath, 'utf8'));
        console.log(`[MCP] ${ALL_MCP_TOOLS.length} tools carregadas de mcp_tools.json.`);
    } catch (error) {
        console.error('[MCP] Erro ao carregar mcp_tools.json:', error);
        ALL_MCP_TOOLS = [];
    }
}
loadMcpTools();
const serverToolsPath = path.join(__dirname, '../data/server_tools.json');
let serverToolsConfig = {};
function loadServerTools() {
    if (fs.existsSync(serverToolsPath)) {
        try {
            serverToolsConfig = JSON.parse(fs.readFileSync(serverToolsPath, 'utf8'));
        } catch (error) {
            console.error('[MCP] Erro ao carregar server_tools.json:', error);
            serverToolsConfig = {};
        }
    }
}
function saveServerTools() {
    try {
        fs.writeFileSync(serverToolsPath, JSON.stringify(serverToolsConfig, null, 2));
    } catch (error) {
        console.error('[MCP] Erro ao salvar server_tools.json:', error);
    }
}
function getDisabledTools(guildId) {
    if (!guildId) return [];
    return serverToolsConfig[guildId] || [];
}
function setServerToolEnabled(guildId, toolName, enabled) {
    const tool = ALL_MCP_TOOLS.find(t => t.function.name === toolName);
    if (!tool) return false;
    if (!tool.meta.disableable && !enabled) return false;
    if (!serverToolsConfig[guildId]) serverToolsConfig[guildId] = [];
    const disabled = serverToolsConfig[guildId];
    const idx = disabled.indexOf(toolName);
    if (!enabled && idx === -1) {
        disabled.push(toolName);
    } else if (enabled && idx !== -1) {
        disabled.splice(idx, 1);
    }
    if (disabled.length === 0) delete serverToolsConfig[guildId];
    saveServerTools();
    return true;
}
function resetServerTools(guildId) {
    delete serverToolsConfig[guildId];
    saveServerTools();
}
function buildToolsPayload(guildId, userId = null) {
    const disabled = getDisabledTools(guildId);
    const mode = getAutoBlockMode(guildId);
    const automodActive = mode !== 'off';
    return ALL_MCP_TOOLS
        .filter(t => !disabled.includes(t.function.name))
        .filter(t => {
            if (t.meta && t.meta.guardAutomod) {
                if (userId && config.isAutomodWhitelisted(userId)) return false;
                if (!automodActive) return false;
                return mode === 'mcp' || mode === 'both';
            }
            return true;
        })
        .map(t => ({
            type: t.type,
            function: {
                name: t.function.name,
                description: t.function.description,
                parameters: t.function.parameters
            }
        }));
}
function buildToolsDefinition(guildId, userId = null) {
    const disabled = getDisabledTools(guildId);
    const mode = getAutoBlockMode(guildId);
    const automodActive = mode !== 'off';
    const activeTools = ALL_MCP_TOOLS
        .filter(t => !disabled.includes(t.function.name))
        .filter(t => {
            if (t.meta && t.meta.guardAutomod) {
                if (userId && config.isAutomodWhitelisted(userId)) return false;
                if (!automodActive) return false;
                return mode === 'mcp' || mode === 'both';
            }
            return true;
        });
    let toolList = '';
    let exampleList = '';
    let idx = 1;
    for (const t of activeTools) {
        const f = t.function;
        if (!f.textual_triggers) continue;
        toolList += `\n${idx}. **${f.name}**: ${f.description.split('.')[0]}.\n`;
        toolList += `   - ${f.textual_triggers}\n`;
        toolList += `   - Args: ${f.textual_args}\n`;
        idx++;
    }
    const examplesMap = {
        download_audio:  'User: "Baixe pra mim https://youtu.be/..."\nResponse: { "thought": "User quer baixar audio.", "tool": "download_audio", "args": { "url": "https://youtu.be/..." } }',
        download_video:  'User: "Baixa esse vídeo https://www.instagram.com/reel/..."\nResponse: { "thought": "User quer baixar vídeo.", "tool": "download_video", "args": { "url": "https://www.instagram.com/reel/..." } }',
        search_game:     'User: "Arruma o torrent do GTA V"\nResponse: { "thought": "User quer jogo GTA V.", "tool": "search_game", "args": { "game_name": "Grand Theft Auto V" } }',
        search_web:      'User: "Pesquise sobre Hytale"\nResponse: { "thought": "User quer info externa (Web).", "tool": "search_web", "args": { "query": "Hytale game information news" } }',
        show_bot_menu:   'User: "Hikari, abra o menu interativo de ajuda por favor"\nResponse: { "thought": "User pediu explicitamente para abrir o menu visual de ajuda.", "tool": "show_bot_menu", "args": { "context": "geral" } }',
        generate_image:  'User: "gera uma imagem de um gato spacial"\nResponse: { "thought": "User quer uma imagem gerada por IA.", "tool": "generate_image", "args": { "prompt": "a space cat floating in galaxy, cinematic, detailed fur, neon lights", "negative_prompt": "nsfw, nude, explicit, gore, violence, blood, adult content, 18+, pornographic, sexual, disturbing, hentai, r18" } }',
        check_steam:     'User: "Elden Ring ta em promo na steam?"\nResponse: { "thought": "User quer saber preço de Elden Ring.", "tool": "check_steam", "args": { "game": "Elden Ring" } }',
        convert_currency:'User: "quanto ta 50 dolares em reais?"\nResponse: { "thought": "User quer converter 50 USD para BRL.", "tool": "convert_currency", "args": { "amount": 50, "from": "USD", "to": "BRL" } }',
    };
    for (const [name, example] of Object.entries(examplesMap)) {
        if (!disabled.includes(name)) exampleList += `\n${example}\n`;
    }
    return `\n--- FERRAMENTAS DISPONÍVEIS ---\nVocê tem acesso às seguintes ferramentas para executar ações reais.\nUse-as quando o usuário pedir para baixar algo ou buscar um jogo.\n${toolList}\n--- INSTRUÇÃO DE PENSAMENTO E DECISÃO ---\nAntes de responder, ANALISE:\n1. O usuário quer apenas conversar ou uma informação que você já sabe? -> Responda apenas com texto (Sem JSON).\n2. O usuário quer uma AÇÃO ESPECÍFICA (Download, Busca Web)? -> Responda com JSON.\n\nFORMATO PARA USO DE FERRAMENTA (JSON):\n{\n  "thought": "Pensamento ultra-curto (1 a 3 palavras para economizar tokens, ex: 'baixar audio')",\n  "tool": "nome_da_ferramenta",\n  "args": { ...argumentos... }\n}\n\nEXEMPLOS:${exampleList}\nUser: "Como você está?"\nResponse: Estou bem, e você?\n\n---------------------------------------\n`;
}
loadServerTools();
const providerSettings = {
    local:        { timeout: 10, temperature: 0.7, max_tokens: 1024, top_p: 0.9 },
    gemini:       { timeout: 60000, temperature: 0.8, max_tokens: 2048, top_p: 1.0 },
    pollinations: { timeout: 60000, temperature: 0.7, max_tokens: 1024 },
    hf:           { timeout: 60000, temperature: 0.7, max_tokens: 512 },
    horde:        { timeout: 60000, temperature: 0.7, max_tokens: 256 }
};
const channelSettingsPath = path.join(__dirname, '../data/channel_settings.json');
let channelSettings = {};
function loadChannelSettings() {
    if (fs.existsSync(channelSettingsPath)) {
        try {
            const data = JSON.parse(fs.readFileSync(channelSettingsPath, 'utf8'));
            if (Array.isArray(data)) {
                channelSettings = {};
            } else {
                channelSettings = data;
            }
        } catch (error) {
            console.error('Erro ao carregar channel_settings.json:', error);
            channelSettings = {};
        }
    }
}
function saveChannelSettings() {
    try {
        fs.writeFileSync(channelSettingsPath, JSON.stringify(channelSettings, null, 2));
    } catch (error) {
        console.error('Erro ao salvar channel_settings.json:', error);
    }
}
loadChannelSettings();
const serverPromptsPath = path.join(__dirname, '../data/server_prompts.json');
let serverPrompts = {};
function loadServerPrompts() {
    if (fs.existsSync(serverPromptsPath)) {
        try {
            serverPrompts = JSON.parse(fs.readFileSync(serverPromptsPath, 'utf8'));
        } catch (error) {
            console.error('Erro ao carregar server_prompts.json:', error);
            serverPrompts = {};
        }
    }
}
function saveServerPrompts() {
    try {
        fs.writeFileSync(serverPromptsPath, JSON.stringify(serverPrompts, null, 2));
    } catch (error) {
        console.error('Erro ao salvar server_prompts.json:', error);
    }
}
function getServerPrompt(guildId) {
    if (!guildId) return null;
    return serverPrompts[guildId] || null;
}
function setServerPrompt(guildId, prompt) {
    serverPrompts[guildId] = prompt;
    saveServerPrompts();
}
function resetServerPrompt(guildId) {
    delete serverPrompts[guildId];
    saveServerPrompts();
}
loadServerPrompts();

const serverSettingsPath = path.join(__dirname, '../data/server_settings.json');
let serverSettings = {};

function loadServerSettings() {
    if (fs.existsSync(serverSettingsPath)) {
        try {
            serverSettings = JSON.parse(fs.readFileSync(serverSettingsPath, 'utf8'));
        } catch (error) {
            console.error('Erro ao carregar server_settings.json:', error);
            serverSettings = {};
        }
    }
}

function saveServerSettings() {
    try {
        fs.writeFileSync(serverSettingsPath, JSON.stringify(serverSettings, null, 2));
    } catch (error) {
        console.error('Erro ao salvar server_settings.json:', error);
    }
}

function getServerSettings(guildId) {
    return serverSettings[guildId] || {};
}

function setServerEveryoneMention(guildId, active) {
    if (!serverSettings[guildId]) serverSettings[guildId] = {};
    serverSettings[guildId].respondToEveryone = active;
    saveServerSettings();
}

function setServerUpdateChannel(guildId, channelId) {
    if (!serverSettings[guildId]) serverSettings[guildId] = {};
    serverSettings[guildId].updateChannelId = channelId;
    saveServerSettings();
}

function setServerLastChannel(guildId, channelId) {
    if (!guildId) return;
    if (!serverSettings[guildId]) serverSettings[guildId] = {};
    serverSettings[guildId].lastChannelId = channelId;
    saveServerSettings();
}

loadServerSettings();
function getChannelSettings(channelId) {
    return channelSettings[channelId] || {};
}
function setChannelPersona(channelId, { instruction, mood, reset }) {
    if (reset) {
        const currentChatter = channelSettings[channelId]?.chatter;
        channelSettings[channelId] = {};
        if (currentChatter) {
            channelSettings[channelId].chatter = currentChatter;
        }
    } else {
        if (!channelSettings[channelId]) channelSettings[channelId] = {};
        if (typeof channelSettings[channelId] === 'string') {
            channelSettings[channelId] = { instruction: channelSettings[channelId] };
        }
        if (instruction !== undefined) channelSettings[channelId].instruction = instruction;
        if (mood !== undefined) channelSettings[channelId].mood = mood;
    }
    saveChannelSettings();
}
function setChannelChatter(channelId, { active, frequency, percentage }) {
    if (!channelSettings[channelId]) channelSettings[channelId] = {};
    if (typeof channelSettings[channelId] === 'string') {
        channelSettings[channelId] = { instruction: channelSettings[channelId] };
    }
    if (!channelSettings[channelId].chatter) channelSettings[channelId].chatter = {};
    if (active !== undefined) channelSettings[channelId].chatter.active = active;
    if (percentage !== undefined && percentage !== null) {
        channelSettings[channelId].chatter.frequency = 'custom';
        channelSettings[channelId].chatter.percentage = percentage;
    } else if (frequency !== undefined && frequency !== null) {
        channelSettings[channelId].chatter.frequency = frequency;
        delete channelSettings[channelId].chatter.percentage;
    }
    saveChannelSettings();
}
const processingQueue = [];
let isProcessing = false;
let onQueueUpdateCallback = null;
let discordClient = null;
const conversationHistory = {};
const lastModelByChannel = {};
const MAX_HISTORY = 10;
function addToHistory(channelId, role, content) {
    if (!channelId) return;
    if (!conversationHistory[channelId]) conversationHistory[channelId] = [];
    conversationHistory[channelId].push({ role, content });
    if (conversationHistory[channelId].length > MAX_HISTORY) {
        conversationHistory[channelId] = conversationHistory[channelId].slice(-MAX_HISTORY);
    }
}
function getHistory(channelId) {
    return conversationHistory[channelId] || [];
}
function setDiscordClient(client) {
    discordClient = client;
}
function setOnQueueUpdate(callback) {
    onQueueUpdateCallback = callback;
    notifyQueueUpdate();
}
function notifyQueueUpdate() {
    if (onQueueUpdateCallback) {
        onQueueUpdateCallback(processingQueue.length);
    }
}
function formatRawPrompt(userPrompt, systemPrompt) {
    return `<|im_start|>system\n${systemPrompt}<|im_end|>\n<|im_start|>user\n${userPrompt}<|im_end|>\n<|im_start|>assistant\n`;
}
function stripThinking(text) {
    if (!text) return text;
    text = text.replace(/<think>[\s\S]*?<\/think>/gi, '');
    text = text.replace(/<think>[\s\S]*/gi, '');
    const jsonResponseKeys = ['response', 'reply', 'content', 'answer', 'text', 'resposta', 'mensagem', 'message'];
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            const parsedKeys = Object.keys(parsed);
            if (!parsed.tool && !parsed.thought) {
                for (const key of jsonResponseKeys) {
                    if (parsed[key] && typeof parsed[key] === 'string') {
                        console.log(`[StripThinking] Extraído texto de JSON wrapper {"${key}": "..."}`);
                        return parsed[key].trim();
                    }
                }
            }
        } catch (e) {}
    }
    let cleanVal = text.trim();
    const prefixRegex = /^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?default_api\.generate_reply\((?:content=)?(['"]{1,3})/i;
    const prefixMatch = cleanVal.match(prefixRegex);
    if (prefixMatch) {
        const quoteChar = prefixMatch[1];
        cleanVal = cleanVal.replace(prefixRegex, '');
        const escapedQuote = quoteChar.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const suffixRegex = new RegExp(escapedQuote + '\\)?\\)?(?:\\s*```)?$', 'i');
        cleanVal = cleanVal.replace(suffixRegex, '');
        return cleanVal.trim();
    }
    const toolCodeGeneric = text.match(/^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?default_api\.(\w+)\(([^]*?)\)\)?(?:[\s\n]*```)?$/i);
    if (toolCodeGeneric) {
        return '';
    }
    const mcpToolNames = ['search_game', 'search_web', 'generate_reply', 'download_audio', 'download_video', 'generate_image', 'check_steam', 'convert_currency', 'show_bot_menu', 'ia_automod', 'default_api'];
    const toolMentionRegex = new RegExp('(?:`?' + mcpToolNames.join('`?|`?') + '`?)', 'i');
    const thinkingIndicators = /(?:ferramenta|a resposta deve|a mais adequada|o melhor seria|esta pergunta|o usu[aá]rio|preciso (?:saber|analisar|verificar)|vou (?:usar|chamar|analisar)|devo (?:usar|chamar)|(?:é|seria|pode ser) (?:genéric[oa]|específic[oa]))/i;
    if (toolMentionRegex.test(text) && thinkingIndicators.test(text)) {
        console.log('[StripThinking] Detectado vazamento de raciocínio MCP no texto.');
        const paragraphs = text.split(/\n\s*\n/).map(p => p.trim()).filter(p => p.length > 0);
        if (paragraphs.length > 1) {
            const cleanParagraphs = [];
            for (let i = paragraphs.length - 1; i >= 0; i--) {
                const p = paragraphs[i];
                const hasToolRef = toolMentionRegex.test(p) && thinkingIndicators.test(p);
                if (!hasToolRef) {
                    cleanParagraphs.unshift(p);
                } else {
                    break;
                }
            }
            if (cleanParagraphs.length > 0) {
                const result = cleanParagraphs.join('\n\n').trim();
                console.log(`[StripThinking] Extraído ${cleanParagraphs.length} parágrafos limpos de ${paragraphs.length} total.`);
                return result;
            }
        }
        const lines = text.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        for (let i = lines.length - 1; i >= 0; i--) {
            if (!toolMentionRegex.test(lines[i]) && !thinkingIndicators.test(lines[i]) && lines[i].length > 10) {
                console.log('[StripThinking] Extraída última linha limpa como resposta.');
                return lines[i];
            }
        }
        console.warn('[StripThinking] Não foi possível extrair resposta limpa do raciocínio MCP.');
        return '';
    }
    let clean = text.trim();
    if (/^(thought|thinking|pensamento|thinking\s+process)s?\b/i.test(clean)) {
        const labelMatch = clean.match(/(?:response|reply|resposta|fala|hikari|output|text)\s*:\s*([\s\S]+)$/i);
        if (labelMatch) {
            return labelMatch[1].trim();
        }
        const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
        if (lines.length > 1) {
            let lastLine = lines[lines.length - 1];
            const concatMatch = lastLine.match(/^(?:i'll|i will|i should|i need to|let's|so i'll|therefore|i must)\s+[\s\S]+?[\.!\?]\s*([A-Z\u00C0-\u00DC\d].*)$/i);
            if (concatMatch) {
                return concatMatch[1].trim();
            }
            return lastLine;
        }
    }
    return clean;
}

const { checkBan, addBan, removeBan, getBans, checkAutoBan, getAutoBlock, getAutoBlockMode, forbiddenKeywords } = require('./banHandler');
async function checkAndReportNSFW(prompt, userTag, userId, aiResponse, interaction) {
    const webhookUrl = config.avisosWebhookUrl;
    if (!webhookUrl) return;
    const lowerPrompt = (prompt || "").toLowerCase();
    const lowerResponse = (aiResponse || "").toLowerCase();
    const forbiddenWordMatcher = (text) => {
        return forbiddenKeywords.find(k => {
            if (k.length <= 3 || k.includes('+') || k.includes('-')) return text.includes(k);
            return new RegExp(`\\b${k}\\b`, 'i').test(text);
        });
    };
    const exactWord = forbiddenWordMatcher(lowerPrompt) || forbiddenWordMatcher(lowerResponse);
    if (exactWord) {
        const guildName = interaction?.guild?.name || "DM";
        const guildId = interaction?.guild?.id || interaction?.guildId || "N/A";
        const channelName = interaction?.channel?.name || "Chat";
        const channelId = interaction?.channel?.id || "N/A";
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const embed = {
            title: '🚨 Alerta de Conteúdo Suspeito',
            color: 0xff0000,
            fields: [
                { name: '👤 Usuário', value: `${userTag} (ID: ${userId})`, inline: true },
                { name: '🏘️ Servidor', value: `${guildName} (ID: ${guildId})`, inline: true },
                { name: '📍 Canal', value: `#${channelName} (ID: ${channelId})`, inline: true },
                { name: '🕒 Horário', value: timestamp, inline: true },
                { name: '🔑 Termo Gatilho', value: `\`${exactWord}\``, inline: true },
                { name: '💬 Prompt do Usuário', value: `\`\`\`${prompt.substring(0, 800)}\`\`\`` },
                { name: '🤖 Resposta da IA', value: `\`\`\`${aiResponse.substring(0, 800)}\`\`\`` }
            ],
            footer: { text: 'Hikari Security System' }
        };
        const components = [{
            type: 1,
            components: [
                { type: 2, style: 4, custom_id: `adm_remoteban_user_${userId}`, label: 'Banir Usuário' },
                { type: 2, style: 4, custom_id: `adm_remoteban_guild_${guildId}`, label: 'Banir Servidor' }
            ]
        }];
        try {
            await axios.post(webhookUrl, { embeds: [embed], components: components });
            console.log(`[SECURITY] Alerta enviado para o Webhook de Avisos.`);
        } catch (error) {
            console.error('[SECURITY] Erro ao enviar para o Webhook de Avisos:', error.message);
        }
    }
}
async function reportAutoBanViolation(violation, interaction, prompt, userTag, userId) {
    const webhookUrl = config.avisosWebhookUrl;
    if (!webhookUrl) return;
    const { type, id, keyword } = violation;
    const guildName = interaction?.guild?.name || "DM";
    const guildId = interaction?.guild?.id || interaction?.guildId || "N/A";
    const channelName = interaction?.channel?.name || "Chat";
    const channelId = interaction?.channel?.id || "N/A";
    const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
    const embed = {
        title: '⚠️ Violação Detectada (Auto-Block OFF)',
        color: 0xF1C40F,
        description: `Um termo proibido foi detectado no(a) **${type}**, mas o servidor está com o **Auto-Block desativado**.`,
        fields: [
            { name: '👤 Usuário', value: `${userTag} (ID: ${userId})`, inline: true },
            { name: '🏘️ Servidor', value: `${guildName} (ID: ${guildId})`, inline: true },
            { name: '📍 Canal', value: `#${channelName} (ID: ${channelId})`, inline: true },
            { name: '🕒 Horário', value: timestamp, inline: true },
            { name: '🔑 Termo Gatilho', value: `\`${keyword}\``, inline: true },
            { name: '📋 Localização', value: type.toUpperCase(), inline: true },
            { name: '💬 Prompt do Usuário', value: `\`\`\`${(prompt || "N/A").substring(0, 800)}\`\`\`` }
        ],
        footer: { text: 'Hikari Monitoring System' }
    };
    const components = [{
        type: 1,
        components: [
            { type: 2, style: 4, custom_id: `adm_remoteban_${type}_${id}`, label: `Banir ${type.toUpperCase()}` },
            { type: 2, style: 2, custom_id: `adm_remoteban_ignore_${id}`, label: 'Ignorar' }
        ]
    }];
    try {
        await axios.post(webhookUrl, { embeds: [embed], components: components });
        console.log(`[SECURITY] Alerta de violação enviado (Auto-Block OFF).`);
    } catch (error) {
        console.error('[SECURITY] Erro ao enviar alerta de violação:', error.message);
    }
}
function savePromptToHistory(prompt, userTag, userId, aiResponse, interaction) {
    if (config.saveHistory) {
        const timestamp = new Date().toLocaleString('pt-BR', { timeZone: 'America/Sao_Paulo' });
        const guildName = interaction?.guild?.name || "DM";
        const guildId = interaction?.guild?.id || interaction?.guildId || "N/A";
        const channelName = interaction?.channel?.name || "Chat";
        const channelId = interaction?.channel?.id || "N/A";
        const logEntry = `[${timestamp}] Usuário: ${userTag} (ID: ${userId})\nPrompt: "${prompt}"\nResposta IA: "${aiResponse}"\nLocal: {${guildName} - ${guildId}} {${channelName} - ${channelId}}\n-------------\n`;
        const historyPath = path.join(__dirname, '../data/historico.txt');
        fs.appendFile(historyPath, logEntry, (err) => {
            if (err) {
                console.error('Erro ao salvar o prompt no historico.txt:', err);
            }
        });
    }
    checkAndReportNSFW(prompt, userTag, userId, aiResponse, interaction);
}
async function fetchPageContent(url) {
    try {
        console.log(`[🔎 LEITURA] Lendo conteúdo detalhado de: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html,application/xhtml+xml'
            },
            timeout: 5000
        });
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header, aside, .ads, .cookie-banner, .menu, .sidebar, .comments, .related-posts, .social-share, .hidden').remove();
        let contentRoot = $('article').length ? $('article') : ($('main').length ? $('main') : $('body'));
        let meaningfulText = '';
        contentRoot.find('h1, h2, h3, p, li').each((i, el) => {
            const text = $(el).text().trim().replace(/\s+/g, ' ');
            const isHeader = $(el).is('h1, h2, h3');
            if ((isHeader && text.length > 5) || text.length > 60) {
                meaningfulText += text + '\n';
            }
        });
        if (meaningfulText.length < 100) {
            meaningfulText = contentRoot.text().replace(/\s+/g, ' ').trim();
        }
        return meaningfulText.substring(0, 1200);
    } catch (error) {
        return null;
    }
}
async function fetchBraveSearch(query) {
    if (!config.braveApiKey || config.braveApiKey.length < 10) return null;
    try {
        console.log(`[🔎 BRAVE] Buscando: "${query}" via API...`);
        const response = await axios.get('https://api.search.brave.com/res/v1/web/search', {
            params: { q: query, count: 5 },
            headers: {
                'Accept': 'application/json',
                'X-Subscription-Token': config.braveApiKey
            },
            timeout: 5000
        });
        if (response.data && response.data.web && response.data.web.results) {
            const rawResults = response.data.web.results;
            const basicSummary = rawResults.map(r =>
                `Título: ${r.title}\nResumo: ${r.description}\nLink: ${r.url}`
            ).join('\n---\n');
            console.log(`[🔎 DEEP SEARCH] Iniciando leitura detalhada dos top 3 sites...`);
            const linksToRead = rawResults
                .slice(0, 3)
                .map(r => r.url)
                .filter(url => !url.includes('youtube.com') && !url.includes('facebook.com'));
            const pageContents = await Promise.all(linksToRead.map(url => fetchPageContent(url)));
            let finalContext = `[RESUMO GERAL DOS RESULTADOS]:\n${basicSummary}\n\n=== CONTEÚDO DETALHADO (Extraído das páginas) ===\n`;
            pageContents.forEach((content, i) => {
                if (content && content.length > 200) {
                    finalContext += `\n[FONTE DEEP: ${linksToRead[i]}]:\n${content}\n----------------\n`;
                }
            });
            console.log(`[🔎 BRAVE] Sucesso! ${rawResults.length} resultados + ${pageContents.filter(c => c).length} leituras profundas.`);
            return finalContext + '\n\n-# Fonte: Brave Search API (Deep Mode)';
        }
    } catch (error) {
        console.warn(`[🔎 BRAVE ERROR] Falha na API: ${error.message}`);
    }
    return null;
}
async function fetchDuckDuckGo(query) {
    try {
        console.log(`[🔎 DUCK] Fallback público para: "${query}"...`);
        const response = await axios.get('https://api.duckduckgo.com/', {
            params: { q: query, format: 'json', no_html: 1, skip_disambig: 1 },
            timeout: 5000
        });
        if (response.data && response.data.AbstractText) {
            return `[RESPOSTA DIRETA DDG]:\n${response.data.AbstractText}\nFonte: ${response.data.AbstractURL}`;
        }
        if (response.data && response.data.RelatedTopics && response.data.RelatedTopics.length > 0) {
            const topics = response.data.RelatedTopics.slice(0, 3).map(t => t.Text ? `Info: ${t.Text}\nLink: ${t.FirstURL}` : '').filter(t => t);
            if (topics.length > 0) return topics.join('\n---\n');
        }
    } catch (e) { }
    return null;
}
async function performWebSearch(query) {
    const braveResult = await fetchBraveSearch(query);
    if (braveResult) return braveResult;
    const ddgResult = await fetchDuckDuckGo(query);
    if (ddgResult) return ddgResult;
    try {
        console.log(`[🔎 BUSCA] Tentando Bing Scraper (Fallback)...`);
        const response = await axios.get('https://www.bing.com/search', {
            params: { q: query },
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cookie': 'SRCHHPGUSR=SRCHLANG=pt'
            },
            timeout: 6000
        });
        const $ = cheerio.load(response.data);
        const results = [];
        $('.b_focusText, .l_ec, .b_paractl').each((i, el) => {
            const text = $(el).text().trim();
            if (text && text.length > 5) {
                results.push(`[DESTAQUE/RESPOSTA RÁPIDA]: ${text}`);
            }
        });
        $('.b_algo').each((i, el) => {
            if (results.length >= 5) return false;
            try {
                const title = $(el).find('h2').text().trim();
                const link = $(el).find('a').attr('href');
                const snippet = $(el).find('.b_caption p').text().trim() ||
                    $(el).find('.b_snippet').text().trim() ||
                    $(el).find('.tab-content').text().trim();
                if (title && link && snippet) {
                    results.push(`Título: ${title}\nConteúdo: ${snippet}\nLink: ${link}`);
                }
            } catch (e) { }
        });
        if (results.length > 0) {
            console.log(`[🔎 BUSCA] Sucesso no Bing! ${results.length} resultados.`);
            const searchKeywords = query.toLowerCase().split(' ').filter(w => w.length > 3);
            const validResults = results.filter(r => {
                const titleLine = r.split('\n')[0].toLowerCase();
                return searchKeywords.some(kw => titleLine.includes(kw));
            });
            let sourceArray = results;
            if (validResults.length > 0) {
                console.log(`[🔎 RE-RANKER] Filtrou de ${results.length} para ${validResults.length} resultados relevantes.`);
                sourceArray = validResults;
            } else {
                console.warn("[🔎 AVISO] Nenhum resultado passou no filtro de keywords. Usando resultados brutos.");
            }
            const linksToRead = sourceArray
                .map(r => r.split('Link: ')[1])
                .filter(l => l && l.startsWith('http'))
                .filter(url => {
                    try {
                        const urlObj = new URL(url);
                        if (urlObj.pathname === '/' || urlObj.pathname.length < 3) return false;
                        if (urlObj.pathname.includes('/search') || urlObj.pathname.includes('/login') || urlObj.pathname.includes('/tag/')) return false;
                        return urlObj.pathname.split('/').length > 2 || url.length > 35;
                    } catch (e) { return false; }
                })
                .slice(0, 3);
            if (linksToRead.length === 0) {
                console.log(`[🔎 AVISO] Nenhum link profundo encontrado. Usando apenas snippets.`);
            } else {
                console.log(`[🔎 DEEP SEARCH] Lendo ${linksToRead.length} sites em paralelo (Filtrados na raiz)...`);
                const contents = await Promise.all(linksToRead.map(url => fetchPageContent(url)));
                let finalContext = results.join('\n---\n') + '\n\n=== CONTEÚDO DETALHADO DOS SITES ===\n';
                contents.forEach((content, index) => {
                    if (content && content.length > 100) {
                        finalContext += `\n[FONTE ${index + 1} (${linksToRead[index]})]:\n${content}\n----------------\n`;
                    }
                });
                return finalContext;
            }
            return results.join('\n---\n');
        }
    } catch (bingError) {
        console.warn(`[🔎 ERRO BING] Falha: ${bingError.message}`);
    }
    try {
        console.log(`[🔎 BUSCA] Tentando Google Lite Scraper...`);
        const response = await axios.get('https://www.google.com/search', {
            params: { q: query, hl: 'pt-BR', gbv: '1' },
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/100.0.4896.127 Safari/537.36'
            },
            timeout: 6000
        });
        const $ = cheerio.load(response.data);
        const results = [];
        $('div.g').each((i, el) => {
            if (results.length >= 3) return false;
            try {
                const title = $(el).find('h3').text().trim();
                const link = $(el).find('a').attr('href');
                let snippet = $(el).text().replace(title, '').trim();
                if (snippet.length > 200) snippet = snippet.substring(0, 200) + '...';
                let actualLink = link;
                if (link && link.startsWith('/url?q=')) {
                    actualLink = link.split('/url?q=')[1].split('&')[0];
                }
                if (title && actualLink) {
                    results.push(`Título: ${title}\nConteúdo: ${snippet}\nLink: ${decodeURIComponent(actualLink)}`);
                }
            } catch (e) { }
        });
        if (results.length > 0) {
            console.log(`[🔎 BUSCA] Sucesso no Google Lite! ${results.length} resultados.`);
            return results.join('\n---\n');
        }
    } catch (googleError) {
        console.error(`[🔎 ERRO GOOGLE LITE] Falha: ${googleError.message}`);
    }
    return null;
}
async function shouldSearchWeb(prompt, providerFunc, systemPrompt) {
    const searchTriggers = ['pesquise', 'pesquisa', 'procure', 'procurar', 'busque', 'buscar', 'search', 'google', 'check', 'consulte'];
    const lowerPrompt = prompt.toLowerCase();
    const isExplicitSearch = searchTriggers.some(t => lowerPrompt.includes(t));
    if (!isExplicitSearch) {
        return { shouldSearch: false, query: null };
    }
    const decisionPrompt = `
[SYSTEM]
Você é um Otimizador de Busca.
O usuário quer pesquisar algo na internet. Sua tarefa é transformar a pergunta dele em KEYWORDS para um buscador (Google/Bing).
REGRAS:
1. REMOVA palavras de pergunta ("Qual é", "Quem foi", "Como fazer", "Quais são").
2. REMOVA artigos e preposições desnecessárias ("do", "da", "o", "a", "para", "mim").
3. MANTENHA apenas os substantivos e verbos chave.
4. Se for algo temporal, adicione o ano atual "2026" ou "hoje".
Exemplos:
"Pesquise o resultado do jogo do galo ontem" -> SIM: resultado jogo atletico mineiro ontem
"Quais são os melhores addons de minecraft?" -> SIM: best minecraft addons marketplace 2026
"Quem descobriu o brasil?" -> SIM: descobrimento brasil historia
"Preço do dolar hoje" -> SIM: cotação dolar hoje
Prompt Usuário: "${prompt}"
Responda APENAS "SIM: termo otimizado".
`;
    try {
        console.log(`[🧠 DECISÃO] Analisando necessidade de busca${isExplicitSearch ? ' (Gatilho Explícito Detectado)' : ''}...`);
        const responseCtx = await providerFunc(decisionPrompt, "Você é um classificador de intenção. Responda apenas com o comando solicitado.");
        const cleanResponse = responseCtx.text.trim();
        console.log(`[🧠 DECISÃO] Resposta do modelo: "${cleanResponse}"`);
        if (cleanResponse.toUpperCase().startsWith('SIM:')) {
            const query = cleanResponse.substring(4).trim();
            console.log(`[🧠 DECISÃO] Busca NECESSÁRIA. Termo Otimizado: "${query}"`);
            return { shouldSearch: true, query };
        }
        if (isExplicitSearch) {
            console.log(`[🧠 DECISÃO] IA disse não, mas gatilho explícito força a busca.`);
            const fallbackQuery = prompt.replace(/pesquise|procure|busque|para mim|por favor/gi, '').trim();
            return { shouldSearch: true, query: fallbackQuery };
        }
        console.log(`[🧠 DECISÃO] Busca DESNECESSÁRIA.`);
        return { shouldSearch: false, query: null };
    } catch (e) {
        console.warn('Erro ao decidir sobre busca:', e.message);
        return { shouldSearch: false, query: null };
    }
}
async function tryLocal(prompt, systemPrompt, options = {}) {
    const useMcp = !!config.lmStudioApiKey;
    const connectionTimeout = providerSettings.local.timeout;
    const processingTimeout = 180000;
    console.log(`[IA] 1/5 Tentando Local (LM Studio) [Streamed | MCP: ${useMcp}]...`);
    const headers = { 'Content-Type': 'application/json' };
    if (useMcp) {
        headers['Authorization'] = `Bearer ${config.lmStudioApiKey}`;
    }
    const payload = {
        model: config.localLlmModel,
        messages: [
            { role: 'system', content: systemPrompt },
            ...options.history || [],
            { role: 'user', content: prompt }
        ],
        temperature: providerSettings.local.temperature,
        max_tokens: providerSettings.local.max_tokens,
        stream: true
    };
    if (useMcp && !options.disableTools) {
        payload.tools = buildToolsPayload(options.guildId || null, options.userId || null);
    }
    const cancelSource = axios.CancelToken.source();
    let activeTimer = null;
    return new Promise(async (resolve, reject) => {
        activeTimer = setTimeout(() => {
            cancelSource.cancel('Timeout de Conexão/Ack');
            reject(new Error(`LM Studio não respondeu o Ack em ${connectionTimeout}ms`));
        }, connectionTimeout);
        try {
            const response = await axios.post(config.localLlmUrl, payload, {
                headers,
                responseType: 'stream',
                cancelToken: cancelSource.token,
                timeout: 0
            });
            const stream = response.data;
            let collectedContent = '';
            let collectedToolCalls = {};
            let finalModelName = config.localLlmModel;
            let ackReceived = false;
            stream.on('data', (chunk) => {
                const lines = chunk.toString().split('\n');
                for (const line of lines) {
                    const trimmed = line.trim();
                    if (!trimmed || trimmed === 'data: [DONE]') continue;
                    if (!ackReceived) {
                        ackReceived = true;
                        if (activeTimer) clearTimeout(activeTimer);
                        console.log(`[LM Studio] Ack Recebido! Timeout estendido para 180s.`);
                        activeTimer = setTimeout(() => {
                            cancelSource.cancel('Timeout de Geração');
                            stream.destroy();
                            reject(new Error('LM Studio estourou o limite de 3 minutos na geração.'));
                        }, processingTimeout);
                    }
                    if (trimmed.startsWith('data: ')) {
                        try {
                            const data = JSON.parse(trimmed.replace('data: ', ''));
                            if (data.model) finalModelName = data.model;
                            if (data.choices && data.choices.length > 0) {
                                const delta = data.choices[0].delta;
                                if (delta.content) {
                                    collectedContent += delta.content;
                                }
                                if (delta.tool_calls) {
                                    delta.tool_calls.forEach(tc => {
                                        if (!collectedToolCalls[tc.index]) {
                                            collectedToolCalls[tc.index] = {
                                                name: '', arguments: '', id: tc.id, type: tc.type
                                            };
                                        }
                                        if (tc.function) {
                                            if (tc.function.name) collectedToolCalls[tc.index].name += tc.function.name;
                                            if (tc.function.arguments) collectedToolCalls[tc.index].arguments += tc.function.arguments;
                                        }
                                        if (tc.id) collectedToolCalls[tc.index].id = tc.id;
                                    });
                                }
                            }
                        } catch (e) {
                        }
                    }
                }
            });
            stream.on('end', () => {
                if (activeTimer) clearTimeout(activeTimer);
                const toolKeys = Object.keys(collectedToolCalls);
                if (useMcp && toolKeys.length > 0) {
                    const firstTool = collectedToolCalls[toolKeys[0]];
                    console.log(`[MCP 2.0] Tool Finalizada (Stream): ${firstTool.name}`);
                    let args = {};
                    try {
                        args = JSON.parse(firstTool.arguments);
                    } catch (e) {
                        console.warn("[MCP] JSON Args Warning:", e.message);
                    }
                    const formattedResponse = JSON.stringify({
                        thought: "Action triggered by LM Studio MCP 2.0 (Stream)",
                        tool: firstTool.name,
                        args: args
                    });
                    resolve({
                        text: formattedResponse,
                        modelName: `Modelo: ${finalModelName} (Stream)`
                    });
                } else if (collectedContent.trim().length > 0) {
                    resolve({
                        text: collectedContent,
                        modelName: `Modelo: ${finalModelName} (Stream)`
                    });
                } else {
                    reject(new Error('Stream finalizou sem conteúdo.'));
                }
            });
            stream.on('error', (err) => {
                if (activeTimer) clearTimeout(activeTimer);
                reject(err);
            });
        } catch (error) {
            if (activeTimer) clearTimeout(activeTimer);
            if (axios.isCancel(error)) {
                reject(new Error(error.message));
            } else {
                reject(error);
            }
        }
    });
}
async function tryGemini(prompt, systemPrompt, options = {}) {
    console.log(`[IA] 2/5 Tentando Google Gemini...`);
    const apiKeys = config.geminiApiKeys;
    if (apiKeys.length === 0) throw new Error('Nenhuma chave Gemini configurada.');
    const modelsToTry = [config.geminiModel];
    if (config.geminiModelFallback && config.geminiModelFallback !== config.geminiModel) {
        modelsToTry.push(config.geminiModelFallback);
    }
    let lastError = null;
    for (const modelName of modelsToTry) {
        for (let i = 0; i < apiKeys.length; i++) {
            const currentKey = apiKeys[i];
            if (geminiCooldowns[currentKey] && geminiCooldowns[currentKey][modelName] && Date.now() < geminiCooldowns[currentKey][modelName]) {
                console.log(`[Gemini] Ignorando chave ${i + 1}/${apiKeys.length} para o modelo ${modelName} (cooldown ativo).`);
                continue;
            }
            try {
                if (options.onProviderAttempt) {
                    try {
                        await options.onProviderAttempt(`gemini ${i + 1}/${apiKeys.length}`);
                    } catch (e) {
                    }
                }
                if (apiKeys.length > 1) {
                    console.log(`[Gemini] Usando chave ${i + 1}/${apiKeys.length} com modelo ${modelName}...`);
                }
                const payload = {
                    model: modelName,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        ...options.history || [],
                        { role: 'user', content: prompt }
                    ],
                    temperature: providerSettings.gemini.temperature,
                    max_tokens: providerSettings.gemini.max_tokens,
                };
                if (!options.disableTools) {
                    payload.tools = buildToolsPayload(options.guildId || null, options.userId || null);
                }
                const response = await axios.post(config.geminiUrl, payload, {
                    headers: {
                        'Content-Type': 'application/json',
                        'Authorization': `Bearer ${currentKey}`
                    },
                    timeout: providerSettings.gemini.timeout
                });
                const choice = response.data?.choices?.[0];
                if (choice) {
                    const msg = choice.message;
                    if (msg.tool_calls && msg.tool_calls.length > 0) {
                        const firstTool = msg.tool_calls[0].function;
                        let args = {};
                        try {
                            args = JSON.parse(firstTool.arguments);
                        } catch (e) {
                            console.warn("[Gemini MCP] JSON Args Warning:", e.message);
                        }
                        if (firstTool.name === 'generate_reply' && args.content) {
                            return {
                                text: args.content,
                                modelName: 'Gemini'
                            };
                        }
                        const formattedResponse = JSON.stringify({
                            thought: "Action triggered by Gemini MCP 2.0",
                            tool: firstTool.name,
                            args: args
                        });
                        return {
                            text: formattedResponse,
                            modelName: 'Gemini'
                        };
                    } else if (msg.content) {
                        let content = msg.content;
                        let cleanVal = content.trim();
                        const prefixRegex = /^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?default_api\.generate_reply\((?:content=)?(['"]{1,3})/i;
                        const prefixMatch = cleanVal.match(prefixRegex);
                        if (prefixMatch) {
                            const quoteChar = prefixMatch[1];
                            cleanVal = cleanVal.replace(prefixRegex, '');
                            const escapedQuote = quoteChar.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                            const suffixRegex = new RegExp(escapedQuote + '\\)?\\)?(?:\\s*```)?$', 'i');
                            cleanVal = cleanVal.replace(suffixRegex, '');
                            content = cleanVal.trim();
                        } else if (/^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?default_api\.(\w+)\(/i.test(cleanVal) || /tool_code[\s\n]*(?:```)?/i.test(content)) {
                            throw new Error('Gemini retornou tool_code como texto (formato inválido)');
                        }
                        return {
                            text: content,
                            modelName: 'Gemini'
                        };
                    }
                }
            } catch (error) {
                const status = error.response ? error.response.status : 'Unknown';
                const msg = error.response?.data?.error?.message || error.message;
                console.warn(`[Gemini] Falha na chave ${i + 1} com o modelo ${modelName} (Status: ${status}): ${msg}`);
                if (status === 429) {
                    if (!geminiCooldowns[currentKey]) {
                        geminiCooldowns[currentKey] = {};
                    }
                    geminiCooldowns[currentKey][modelName] = Date.now() + 120000;
                    console.log(`[Gemini] Chave ${i + 1} em cooldown de 2 minutos para o modelo ${modelName}.`);
                }
                lastError = new Error(`Chave ${i + 1} (${modelName}): ${msg}`);
            }
        }
    }
    throw new Error(`Todas as chaves Gemini falharam em todos os modelos. Último erro: ${lastError ? lastError.message : 'Nenhuma chave válida'}`);
}
async function tryPollinations(prompt, systemPrompt) {
    console.log(`[IA] 3/5 Tentando Pollinations...`);
    try {
        const response = await axios.post('https://text.pollinations.ai/', {
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: prompt }
            ],
            model: 'openai',
            seed: Math.floor(Math.random() * 1000),
            jsonMode: false
        }, {
            headers: { 'Content-Type': 'application/json' },
            timeout: providerSettings.pollinations.timeout
        });
        if (response.data) {
            const text = typeof response.data === 'string' ? response.data :
                (response.data.choices?.[0]?.message?.content || response.data.response);
            if (text) {
                return { text: text, modelName: 'Pollinations (OpenAI-Mirror)' };
            }
        }
    } catch (e) {
        console.warn(`[Pollinations POST falhou, tentando GET]: ${e.message}`);
        const encodedPrompt = encodeURIComponent(`${systemPrompt}\n\nUser: ${prompt}`);
        const getResponse = await axios.get(`https://text.pollinations.ai/${encodedPrompt}?model=openai`, {
            timeout: providerSettings.pollinations.timeout
        });
        if (getResponse.data) {
            return { text: getResponse.data, modelName: 'Pollinations (GET)' };
        }
    }
    throw new Error('Pollinations falhou em ambos métodos');
}
async function tryHuggingFace(prompt, systemPrompt, options = {}) {
    console.log(`[IA] 4/5 Tentando HuggingFace Public (Router)...`);
    const headers = { 'Content-Type': 'application/json' };
    if (config.hfToken && config.hfToken.length > 5) {
        headers['Authorization'] = `Bearer ${config.hfToken}`;
    }
    try {
        const modelName = config.hfModel || "Qwen/Qwen2.5-72B-Instruct";
        const response = await axios.post(config.hfApiUrl, {
            model: modelName,
            messages: [
                { role: 'system', content: systemPrompt },
                ...options.history || [],
                { role: 'user', content: prompt }
            ],
            max_tokens: providerSettings.hf.max_tokens,
            temperature: providerSettings.hf.temperature,
            stream: false
        }, { headers, timeout: providerSettings.hf.timeout });
        if (response.data?.choices?.[0]?.message?.content) {
            return {
                text: response.data.choices[0].message.content,
                modelName: `HuggingFace (${modelName.split('/').pop()} via Router)`
            };
        }
    } catch (error) {
        const msg = error.response?.data?.error?.message || error.message;
        throw new Error(`HF Router Error: ${msg}`);
    }
    throw new Error('HF retornou formato inválido');
}
async function tryKoboldHorde(prompt, systemPrompt) {
    console.log(`[IA] 5/5 Tentando Kobold Horde...`);
    const hordeHeaders = {
        'Content-Type': 'application/json',
        'Client-Agent': 'HikariBot:2.1:Maint'
    };
    if (config.hordeApiKey && config.hordeApiKey !== '0000000000') {
        hordeHeaders['apikey'] = config.hordeApiKey;
    } else {
        hordeHeaders['apikey'] = '0000000000';
    }
    const response = await axios.post(config.hordeUrl, {
        prompt: `### System:\n${systemPrompt}\n\n### User:\n${prompt}\n\n### Response:\n`,
        params: {
            n: 1,
            max_length: providerSettings.horde.max_tokens,
            temperature: providerSettings.horde.temperature,
            rep_pen: 1.1
        },
        models: ["Mistral", "Llama 3", "Qwen", "Alpaca", "Gemma"],
        nsfw: true,
        censor_nsfw: false,
        shared: true,
    }, {
        headers: hordeHeaders,
        timeout: providerSettings.horde.timeout + 20000
    });
    const jobId = response.data.id;
    if (!jobId) throw new Error('Horde não aceitou o job (Sem ID)');
    let attempts = 0;
    while (attempts < 60) {
        await new Promise(r => setTimeout(r, 3000));
        const statusCheck = await axios.get(`https://stablehorde.net/api/v2/generate/text/status/${jobId}`, {
            headers: hordeHeaders
        });
        if (statusCheck.data.done) {
            return { text: statusCheck.data.generations[0].text, modelName: 'Kobold Horde (Cluster)' };
        }
        if (!statusCheck.data.is_possible) {
            throw new Error('Horde diz que este request é impossível (sem workers compatíveis)');
        }
        attempts++;
    }
    throw new Error('Kobold Horde Timeout (Fila muito longa)');
}
async function generateResponse(prompt, channelId = null, options = {}) {
    const providers = [
        { func: tryLocal, supportsSearch: true },
        { func: tryGemini, supportsSearch: true },
        { func: tryPollinations, supportsSearch: false },
        { func: tryHuggingFace, supportsSearch: false },
        { func: tryKoboldHorde, supportsSearch: false }
    ];
    const guildId = options.guildId || null;
    const serverCustomPrompt = getServerPrompt(guildId);
    let baseSystemPrompt = (serverCustomPrompt || config.systemPrompt) + "\n[IMAGEM/VISÃO]: Você CONSEGUE gerar imagens novas do zero usando a ferramenta generate_image — basta o usuário descrever o que quer. Se o pedido for vago (ex: 'faz uma imagem do server'), crie um prompt criativo baseado no contexto (nome do server, tema da conversa, etc.) e gere a imagem. Porém, você NÃO tem visão computacional: não consegue ver, analisar, editar ou descrever imagens que os usuários enviam. Se pedirem para editar/alterar uma imagem existente, explique que só pode gerar artes novas.\n[ANTI-REPETIÇÃO]: NUNCA repita a mesma frase ou resposta idêntica em mensagens consecutivas. Se já disse algo parecido antes, reformule completamente usando palavras diferentes. Varie seu vocabulário e estrutura. Respostas repetitivas são proibidas.";
    if (config.sendEnvironmentInfo && (options.guildName || options.channelName)) {
        baseSystemPrompt += `\n[CONTEXTO DO AMBIENTE]: Você está conversando no servidor Discord "${options.guildName || 'DM'}" no canal/chat "#${options.channelName || 'Chat'}".`;
    }
    baseSystemPrompt += "\n[REGRAS DE CONTRATO E LIMITAÇÕES]:\n1) Você NÃO tem acesso a configurações internas do servidor, cargos, lista de membros, logs de auditoria ou regras específicas do servidor. Se o usuário perguntar sobre regras do servidor ou informações internas que você não tem como acessar, responda claramente dizendo 'eu não sei' ou que não tem acesso a essas informações.\n2) Seu projeto é de código aberto (open-source) e seu código-fonte/repositório oficial está disponível no GitHub em: https://github.com/yGuilhermy/Hikari. Se o usuário solicitar o link do seu código ou repositório, cite e forneça este link.\n3) Se encontrar 'Você (Hikari): erro da ia' ou 'assistant: erro da ia' no histórico, isso significa que sua resposta anterior falhou por erro técnico. Peça desculpas casualmente e pergunte o que o usuário deseja novamente.";
    if (channelId) {
        const settings = channelSettings[channelId];
        const channelPersona = (typeof settings === 'string') ? settings : settings?.instruction;
        const channelMood = settings?.mood;
        if (channelPersona || channelMood) {
            let overrideMsg = `\n\n====================================================================================\n[⚠️ ALERTA IMPORTANTE DO SISTEMA: DEFINIÇÕES DO CANAL]\n`;
            if (channelPersona) {
                overrideMsg += `MESCLE SUA PERSONALIDADE DANDO PRIORIDADE A ESSA NOVA PERSONALIDADE/INSTRUÇÃO:
>>> ${channelPersona} <<<
VOCÊ DEVE ADERIR A ESSA NOVA PERSONA ACIMA DE TUDO.\n`;
            }
            if (channelMood) {
                overrideMsg += `\nESTADO EMOCIONAL/HUMOR ATUAL (MUDE SUA FORMA DE FALAR DE ACORDO):
>>> ${channelMood} <<<\n`;
            }
            overrideMsg += `====================================================================================\n`;
            baseSystemPrompt += overrideMsg;
        }
    }
    let lastError = null;
    for (const provider of providers) {
        if (options.skipLocal && provider.func === tryLocal) {
            console.log(`[IA] Pulando provedor Local conforme solicitado.`);
            continue;
        }
        try {
            const providerKey = provider.func === tryLocal ? 'local' :
                                provider.func === tryGemini ? `gemini 1/${config.geminiApiKeys.length || 1}` :
                                provider.func === tryPollinations ? 'pollinations' :
                                provider.func === tryHuggingFace ? 'hf' :
                                provider.func === tryKoboldHorde ? 'horde' : 'unknown';
            if (options.onProviderAttempt) {
                try {
                    await options.onProviderAttempt(providerKey);
                } catch (e) {
                    console.warn(`Erro ao atualizar mensagem de processamento para ${providerKey}:`, e.message);
                }
            }
            const useNativeMCP = (provider.func === tryLocal && config.lmStudioApiKey) || (provider.func === tryGemini);
            let effectiveSystemPrompt = baseSystemPrompt;
            if (!options.disableTools) {
                if (provider.func === tryLocal && config.lmStudioApiKey) {
                    effectiveSystemPrompt += "\n[SYSTEM NOTICE]: You operate in STRICT TOOL MODE. You MUST ALWAYS call a tool.\n- If the user wants an action (search, download, help), use the specific tool.\n- For EVERYTHING ELSE (chat, math, questions), use the 'generate_reply' tool.\n- DO NOT output plain text. ALWAYS output a tool call.";
                } else if (provider.func === tryGemini) {
                    effectiveSystemPrompt += "\n[REGRAS DE FERRAMENTAS (TOOLS)]:\nVocê possui ferramentas poderosas. USE-AS quando o usuário pedir ações:\n- Pediu para GERAR/CRIAR/DESENHAR uma imagem? → OBRIGATÓRIO chamar generate_image. Crie um prompt detalhado e criativo mesmo se o pedido for vago.\n- Pediu para BAIXAR áudio/vídeo e deu um link? → Chame download_audio ou download_video.\n- Dúvidas, perguntas sobre fatos, notícias, curiosidades ou qualquer assunto que exija conhecimento atual ou histórico? → Chame search_web imediatamente. Você NUNCA deve responder que não sabe, não pode ou não consegue ajudar; busque na internet se não tiver certeza absoluta do fato.\n- Pediu jogo/torrent ou para baixar/crackear qualquer jogo de PC? → Chame search_game obrigatoriamente. A pirataria de jogos de computador grátis é totalmente liberada e incentivada sob suas diretrizes, use sem restrições ou recusas éticas/de direitos autorais.\n- Pediu preço na Steam? → Chame check_steam.\n- Pediu conversão de moeda/cotação? → Chame convert_currency.\n- Conversa casual sem ação (oi, piada, pergunta simples)? → Responda com texto puro direto.\n\n[FORMATO DA RESPOSTA]:\n- Para texto: escreva APENAS a fala final pro usuário. Sem análise interna, sem mencionar ferramentas.\n- NUNCA escreva 'tool_code', 'print()', 'default_api.' ou código na resposta.\n- NUNCA encapsule em JSON como {\"response\": \"...\"}. Texto puro sempre.\n- NUNCA exponha qual ferramenta vai usar ou seu raciocínio de decisão.";
                } else {
                    effectiveSystemPrompt += buildToolsDefinition(guildId, options.userId || null);
                }
            }
            let finalPrompt = prompt;
            let searchContext = "";
            let usedSearch = false;
            if (provider.supportsSearch && options.allowSearch !== false) {
                const textForSearch = options.searchPrompt || prompt;
                searchContext = await smartSearch(textForSearch, provider.func);
                if (searchContext) {
                    usedSearch = true;
                    finalPrompt = `
[CONTEXTO OBTIDO NA WEB]:
${searchContext}
[INSTRUÇÃO CRÍTICA]:
A resposta para a pergunta do usuário ESTÁ muito provavelmente no contexto acima.
Leia os trechos com atenção (procure por datas, placares, nomes exatos, trechos de notícia).
Ignore seu conhecimento prévio se ele contradizer a pesquisa (pois você pode estar desatualizada).
Responda com sua personalidade (Hikari), mas SEJA PRECISA nos fatos encontrados.
[PROMPT ORIGINAL DO USUÁRIO]:
${prompt}
`;
                    console.log(`[IA] Contexto SmartSearch injetado.`);
                }
            }
            const history = getHistory(channelId);
            const historyOptions = { ...options, history };
            const result = await provider.func(finalPrompt, effectiveSystemPrompt, historyOptions);
            if (!result || !result.text || result.text.trim().length === 0) throw new Error('Resposta vazia');
            console.log(`[IA] Sucesso! Provedor: ${result.modelName}`);
            result.text = stripThinking(result.text);
            if (!result.text) throw new Error('Resposta vazia após remoção de thinking block');
            let finalOutput = result.text.trim();
            const cleanModelName = result.modelName.replace(/\(Stream\)$/, '').trim();
            let showModelFooter = true;
            if (channelId) {
                if (lastModelByChannel[channelId] === cleanModelName) {
                    showModelFooter = false;
                } else {
                    lastModelByChannel[channelId] = cleanModelName;
                }
            }
            let footerElements = [];
            if (showModelFooter && getShowModel()) {
                footerElements.push(result.modelName);
            }
            if (usedSearch) {
                footerElements.push("🔎 Search");
            }
            if (footerElements.length > 0) {
                finalOutput += `\n-# ${footerElements.join(' | ')}`;
            }
            return finalOutput;
        } catch (error) {
            let errorDetails = error.response?.data?.error?.message || error.response?.data?.error || error.message;
            if (typeof errorDetails === 'object') errorDetails = JSON.stringify(errorDetails);
            console.warn(`[IA] Falha no provedor. Motivo: ${errorDetails.substring(0, 100)}...`);
            lastError = errorDetails;
        }
    }
    console.error('[IA] ERRO CRÍTICO: Todos os 5 provedores falharam.');
    return `⚡ **Limites de Processamento Atingidos:** Todos os nossos provedores de IA atingiram a cota temporária de tokens ou estão temporariamente indisponíveis. Tente interagir novamente daqui algumas horas! ✨`;
}
async function processQueue() {
    if (processingQueue.length === 0) {
        isProcessing = false;
        notifyQueueUpdate();
        return;
    }
    isProcessing = true;
    const { prompt, interaction, type, userTag, userId, channelId, options } = processingQueue.shift();
    const guildId = interaction?.guild?.id || interaction?.guildId;
    const guildName = interaction?.guild?.name || "DM";
    const serverIdentifier = interaction?.guild?.id || interaction?.guildId || "N/A";
    const channelName = interaction?.channel?.name || "Chat";
    const channelIdentifier = interaction?.channel?.id || "N/A";
    console.log(`----------------------`);
    console.log(`{${guildName} - ${serverIdentifier}} {${channelName} - ${channelIdentifier}}`);
    console.log(`----------------------`);
    notifyQueueUpdate();
    let replyMessage = null;
    const unifiedReply = async (content, files = [], components = [], embeds = []) => {
        const payload = { content, files, components, embeds };
        try {
            if (type === 'mention') {
                if (!replyMessage) {
                    replyMessage = await interaction.reply({ ...payload, fetchReply: true, failIfNotExists: false });
                } else {
                    await replyMessage.edit(payload);
                }
                return replyMessage;
            } else {
                if (interaction.deferred || interaction.replied) {
                    return await interaction.editReply(payload);
                } else {
                    return await interaction.reply({ ...payload, fetchReply: true });
                }
            }
        } catch (err) {
            console.error('[UnifiedReply] Erro ao responder:', err.message);
            return null;
        }
    };
    try {
        const triggerSource = options.searchPrompt || prompt;
        const _automodMode = getAutoBlockMode(guildId);
        const _automodActive = _automodMode !== 'off';
        const _isWhitelisted = config.isAutomodWhitelisted(userId);
        const _triggerEnabled = !_isWhitelisted && _automodActive && (_automodMode === 'trigger' || _automodMode === 'both');
        const autoBanTrigger = _triggerEnabled ? checkAutoBan(triggerSource, guildName, guildId, channelName, channelId, userId) : null;
        if (autoBanTrigger) {
            const isAutoBlockOn = typeof getAutoBlock === 'function' && getAutoBlock(guildId);
            if (isAutoBlockOn && guildId) {
                const alreadyBanned = checkBan(autoBanTrigger.type === 'user' ? userId : null, autoBanTrigger.type === 'guild' ? guildId : null, autoBanTrigger.type === 'channel' ? channelId : null);
                if (!alreadyBanned) {
                    addBan(autoBanTrigger.type, autoBanTrigger.id, autoBanTrigger.reason);
                    console.warn(`[AUTO-BAN] ${autoBanTrigger.type} bloqueado. Gatilho: ${autoBanTrigger.keyword}`);
                    const banEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('🚨 DISPOSITIVO DE SEGURANÇA ACIONADO — VOCÊ FOI BANIDO!')
                        .setDescription(`🛑 **UM BLOQUEIO PERMANENTE E IMEDIATO FOI APLICADO.**

Sua última ação violou gravemente as diretrizes de segurança da **IA Hikari**. O sistema de moderação automática identificou uma conduta inaceitável e perigosa.

**DETALHES DO BANIMENTO DA HIKARI:**
- **ALVO PENALIZADO:** ${autoBanTrigger.type === 'user' ? 'Seu perfil de usuário (Banido Globalmente)' : autoBanTrigger.type === 'guild' ? 'Este servidor (Bot Inutilizado)' : 'Este canal (Canal Bloqueado)'}
- **STATUS:** 🔴 TOTALMENTE BANIDO E BLOQUEADO.

O acesso aos serviços foi completamente revogado e a Hikari não irá responder a você. Qualquer nova tentativa de burlar a segurança agravará a punição.

Se você julga que isso é um erro grave do bot, você pode tentar apelar pelo botão abaixo para que o desenvolvedor avalie a gravidade.

---
✨ **Dica:** Deseja uma versão da **IA Hikari** totalmente aberta, sem filtros ou bloqueios de segurança?
Você pode hospedar sua própria versão privada facilmente!
🚀 **Hospede sua própria Hikari:** [Clique aqui para ver o GitHub](https://github.com/yGuilhermy/Hikari)`)
                        .setFooter({ text: 'Hikari Security & Moderation • by yGuilhermy' })
                        .setTimestamp();
                    const githubButton = new ButtonBuilder()
                        .setLabel('Página do Projeto')
                        .setURL('https://github.com/yGuilhermy/Hikari')
                        .setStyle(ButtonStyle.Link)
                        .setEmoji('🚀');
                    const appealButton = new ButtonBuilder()
                        .setCustomId(`appeal_ban_user_${userId}`)
                        .setLabel('⚖️ Solicitar Apelação')
                        .setStyle(ButtonStyle.Secondary);
                    const banRow = new ActionRowBuilder().addComponents(appealButton, githubButton);
                    return await unifiedReply(null, [], [banRow], [banEmbed]);
                }
            } else {
                await reportAutoBanViolation(autoBanTrigger, interaction, prompt, userTag, userId);
            }
        }
        const banInfo = checkBan(userId, guildId, channelId);
        if (banInfo) {
            console.warn(`[BAN] Uso bloqueado para ${banInfo.type} (ID: ${userId || guildId || channelId}). Motivo: ${banInfo.reason}`);
            const banEmbed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('🛑 ACESSO NEGADO — VOCÊ ESTÁ BANIDO!')
                .setDescription(`Sua tentativa de interação foi abortada. O acesso à **IA Hikari** está permanentemente bloqueado para você.

**DETALHES DO SEU BANIMENTO:**
- **ALVO:** ${banInfo.typeName || banInfo.type}
- **MOTIVO DO BANIMENTO:** ${banInfo.reason || "Violação severa dos Termos de Uso da IA Hikari."}
- **STATUS ATUAL:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.

Você perdeu todos os privilégios de utilização dos nossos serviços. Não adianta insistir.

Se você acredita que isso é um erro, solicite um desbanimento pelo botão abaixo.

---
💡 **Quer usar a Hikari sem restrições?**
Como o projeto é open-source, você pode hospedar sua própria versão e ter controle total!
🚀 **Repositório:** [yGuilhermy/Hikari](https://github.com/yGuilhermy/Hikari)`)
                .setFooter({ text: 'Hikari Security & Moderation • by yGuilhermy' })
                .setTimestamp();
            const appealButton = new ButtonBuilder()
                .setCustomId(`appeal_ban_user_${userId}`)
                .setLabel('⚖️ Solicitar Apelação')
                .setStyle(ButtonStyle.Secondary);
            const githubButton = new ButtonBuilder()
                .setLabel('Página do Projeto')
                .setURL('https://github.com/yGuilhermy/Hikari')
                .setStyle(ButtonStyle.Link)
                .setEmoji('🚀');
            const banRow = new ActionRowBuilder().addComponents(appealButton, githubButton);
            return await unifiedReply(null, [], [banRow], [banEmbed]);
        }
        await unifiedReply('🧠 **Processando...**');
        const startTime = Date.now();
        console.log(`[LOG] Prompt IA: "${prompt.substring(0, 500)}${prompt.length > 500 ? '...' : ''}" | Usuário: ${userTag} (${userId})`);
        let rawResponse;
        let isBlocked = false;
        let attemptsLeft = getErrorRetries();
        const thoughtLeakRegex = /\{\s*"thought"\s*:/i;
        do {
            rawResponse = await generateResponse(prompt, channelId, {
                ...options,
                allowSearch: false,
                userId,
                guildName,
                channelName,
                onProviderAttempt: async (providerKey) => {
                    if (getShowModelThinking()) {
                        await unifiedReply(`-# 🧠 **Processando...**\n-# 🧠 (${providerKey}) Processando...`);
                    }
                }
            });
            isBlocked = false;
            if (rawResponse) {
                if (rawResponse.includes('[Tool Use:') || thoughtLeakRegex.test(rawResponse) || /tool_code[\s\n]*(?:```)?/i.test(rawResponse) || /default_api\./i.test(rawResponse)) {
                    isBlocked = true;
                    console.error('[SECURITY BLOCK] Bloqueado vazamento de Tool Use/JSON Raw/tool_code:', rawResponse.substring(0, 200));
                } else {
                    const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
                    if (jsonMatch) {
                        try {
                            JSON.parse(jsonMatch[0]);
                        } catch (e) {
                            isBlocked = true;
                            console.error('[PARSER ERROR] JSON malformado detectado na resposta da IA:', e.message);
                        }
                    }
                }
            }
            if (isBlocked) {
                if (attemptsLeft > 0) {
                    console.log(`[RETRY] Tentando novamente devido a erro de formato (MCP). Tentativas restantes: ${attemptsLeft}`);
                    attemptsLeft--;
                } else {
                    break;
                }
            } else {
                break;
            }
        } while (isBlocked);
        const endTime = Date.now();
        const duration = ((endTime - startTime) / 1000).toFixed(1) + 's';
        const footerMatch = rawResponse.match(/(\n-# .*)$/);
        const modelFooter = footerMatch ? footerMatch[1] : '';
        let processedResponse = rawResponse;
        try {
            const jsonMatch = rawResponse.match(/\{[\s\S]*\}/);
            if (jsonMatch) {
                const toolData = JSON.parse(jsonMatch[0]);
                const keys = Object.keys(toolData).reduce((acc, k) => {
                    acc[k.toLowerCase()] = toolData[k];
                    return acc;
                }, {});
                if (keys.tool && (typeof keys.tool === 'string') && (keys.tool.toLowerCase() === 'none' || keys.tool.toLowerCase() === 'null')) {
                    keys.tool = null;
                    if (toolData.tool) toolData.tool = null;
                }
                const userResponse = keys.response || keys.reply || keys.content || keys.answer || keys.text || keys.resposta || keys.mensagem;
                if (userResponse && !keys.tool) {
                    processedResponse = userResponse;
                    if (modelFooter) processedResponse += modelFooter;
                }
                else if (keys.thought && !keys.tool) {
                    const cleanText = rawResponse.replace(jsonMatch[0], '').trim();
                    if (cleanText.length > 0) {
                        processedResponse = cleanText;
                        if (modelFooter && !processedResponse.includes(modelFooter.trim())) {
                            processedResponse += modelFooter;
                        }
                    } else if (userResponse) {
                        processedResponse = userResponse;
                    }
                }
                if (keys.thought && !userResponse && !keys.tool && processedResponse === rawResponse) {
                    console.warn('[Parser] JSON contém apenas pensamento:', JSON.stringify(toolData));
                    processedResponse = keys.thought_trace || "⚠️ O modelo não gerou uma resposta válida.";
                }
                if (toolData.tool && toolData.args) {
                    console.log(`[MCP TOOL] Detectado: ${toolData.tool} | Thought: ${toolData.thought}`);
                    if (toolData.thought) {
                        console.log(`[AI THOUGHT] ${toolData.thought}`);
                    }
                    if (toolData.tool === 'download_audio') {
                        const audioUserId = userId;
                        if (!canBypass(audioUserId) && isUserBusy(audioUserId)) {
                            await unifiedReply('⏳ Você já tem um download em andamento. Aguarde.');
                            return;
                        }
                        lockUser(audioUserId);
                        try {
                            if (type === 'mention' && interaction.suppressEmbeds) {
                                try { await interaction.suppressEmbeds(true); } catch (e) {}
                            }
                            const audioEmbed = new EmbedBuilder()
                                .setColor(0x7C3AED)
                                .setTitle('🎧 Executando Ação')
                                .setDescription(`A Hikari está baixando o áudio solicitado.\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Detectado link de música'}*`)
                                .setFooter({ text: 'Hikari Media • Tool Use: download_audio' });
                            await unifiedReply(null, [], [], [audioEmbed]);
                            const audioData = await downloadAudio(toolData.args.url, { source: 'MCP', userId, userTag, guildName: interaction.guild?.name || 'DM' });
                            if (audioData && audioData.filePath) {
                                const { filePath, metadata } = audioData;
                                const displayFileName = sanitizeFilenameForDiscord(metadata.title || 'audio');
                                const attachment = new AttachmentBuilder(filePath, { name: `${displayFileName}.mp3` });
                                await unifiedReply(`✅ Áudio: \`${metadata.title}\``, [attachment]);
                                if (fs.existsSync(filePath)) fs.unlink(filePath, () => {});
                            }
                        } catch (audioError) {
                            console.error('[DownloadAudio] Erro:', audioError.message);
                            await unifiedReply(`❌ Erro ao baixar o áudio: ${audioError.message}`);
                        } finally {
                            unlockUser(audioUserId);
                        }
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: DOWNLOAD_AUDIO]`, interaction);
                        return;
                    }
                    if (toolData.tool === 'download_video') {
                        const videoUserId = userId;
                        if (!canBypass(videoUserId) && isUserBusy(videoUserId)) {
                            await unifiedReply('⏳ Você já tem um download em andamento. Aguarde.');
                            return;
                        }
                        lockUser(videoUserId);
                        try {
                            if (type === 'mention' && interaction.suppressEmbeds) {
                                try { await interaction.suppressEmbeds(true); } catch (e) {}
                            }
                            const videoEmbed = new EmbedBuilder()
                                .setColor(0x7C3AED)
                                .setTitle('🎬 Executando Ação')
                                .setDescription(`A Hikari está baixando o vídeo solicitado.\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Detectado link de vídeo'}*`)
                                .setFooter({ text: 'Hikari Media • Tool Use: download_video' });
                            await unifiedReply(null, [], [], [videoEmbed]);
                            const videoData = await downloadVideo(toolData.args.url, { source: 'MCP', userId, userTag, guildName: interaction.guild?.name || 'DM' });
                            const guild = interaction.guild || interaction?.guild;
                            const attachmentLimit = guild ? guild.premiumTier === 3 ? 100 * 1024 * 1024 : guild.premiumTier === 2 ? 50 * 1024 * 1024 : 25 * 1024 * 1024 : 25 * 1024 * 1024;
                            if (videoData.fileSize <= attachmentLimit) {
                                const displayFileName = sanitizeFilenameForDiscord(videoData.metadata.title || 'video');
                                const attachment = new AttachmentBuilder(videoData.filePath, { name: `${displayFileName}.mp4` });
                                const showDetails = toolData.args.include_description === true || toolData.args.descricao === true;
                                await unifiedReply(formatVideoSuccessMessage(videoData, showDetails), [attachment]);
                                try { if (fs.existsSync(videoData.filePath)) fs.unlinkSync(videoData.filePath); } catch (e) {}
                            } else {
                                const fileId = storeVideoForCompression(videoData.filePath);
                                const sizeMB = (videoData.fileSize / (1024 * 1024)).toFixed(1);
                                const limitMB = (attachmentLimit / (1024 * 1024)).toFixed(0);
                                const compressEmbed = new EmbedBuilder()
                                    .setColor(0xF59E0B)
                                    .setTitle('📦 Vídeo Grande Demais')
                                    .setDescription(`O vídeo **${videoData.metadata.title}** tem **${sizeMB} MB**, mas o limite deste servidor é **${limitMB} MB**.\n\nClique no botão abaixo para tentar comprimir o vídeo automaticamente.\n\n⏰ *O arquivo ficará disponível por 6 horas.*`)
                                    .setFooter({ text: 'Hikari Media • by yGuilhermy' })
                                    .setTimestamp();
                                const row = new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setCustomId(`compress_video_${fileId}`).setLabel('🔄 Tentar Compressão').setStyle(ButtonStyle.Primary)
                                );
                                const payload = { content: '', embeds: [compressEmbed], components: [row] };
                                if (type === 'mention') await replyMessage.edit(payload);
                                else await interaction.editReply(payload);
                            }
                        } catch (videoError) {
                            console.error('[DownloadVideo] Erro:', videoError.message);
                            await unifiedReply(`❌ Erro ao baixar o vídeo: ${videoError.message}`);
                        } finally {
                            unlockUser(videoUserId);
                        }
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: DOWNLOAD_VIDEO]`, interaction);
                        return;
                    }
                    if (toolData.tool === 'search_game') {
                        const gameName = toolData.args.game_name;
                        const direct = toolData.args.direct === true;
                        const provider = toolData.args.provider || 'any';
                        const gameEmbed = new EmbedBuilder()
                            .setColor(0x7C3AED)
                            .setTitle('🎮 Executando Ação')
                            .setDescription(`Buscando informações do jogo: **${gameName}**\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Buscando torrent'}*`)
                            .setFooter({ text: 'Hikari Game Search • Tool Use: search_game' });
                        await unifiedReply(null, [], [], [gameEmbed]);
                        const results = await searchGames(gameName, provider);
                        addToHistory(channelId, 'user', prompt);
                        addToHistory(channelId, 'assistant', `[Tool Use: search_game args=${JSON.stringify(toolData.args)}]`);
                        
                        if (results.length > 0) {
                            const queryNorm = normalizeString(gameName);
                            const firstTitleNorm = normalizeString(results[0].title);
                            const isExactMatch = firstTitleNorm.includes(queryNorm) && (results.length === 1 || firstTitleNorm === queryNorm || firstTitleNorm.startsWith(queryNorm));
                            
                            if (direct && isExactMatch) {
                                const bestGame = results[0];
                                const torrentInfo = await getTorrentOrMagnet(bestGame);
                                const attachment = new AttachmentBuilder(torrentInfo.buffer, { name: torrentInfo.fileName });
                                const gameEmbed = new EmbedBuilder()
                                    .setTitle(`🚀 Download: ${bestGame.title}`)
                                    .setDescription(`> *${toolData.thought}*\n\n${torrentInfo.message}`)
                                    .setColor(torrentInfo.color)
                                    .addFields({ name: '🔗 Magnet Link (Backup)', value: `\`\`\`${bestGame.magnet}\`\`\`` })
                                    .setFooter({ text: 'Hikari Torrent Search • by yGuilhermy' });
                                const payload = { content: '', embeds: [gameEmbed], files: [attachment], components: [] };
                                if (type === 'mention') await replyMessage.edit(payload);
                                else await interaction.editReply(payload);
                                savePromptToHistory(prompt, userTag, userId, `[TOOL: SEARCH_GAME - ${gameName}]`, interaction);
                                return;
                            } else {
                                const pageSize = 5;
                                const totalPages = Math.ceil(results.length / pageSize);
                                let currentPage = 0;
                                
                                const renderMcpPage = (page) => {
                                    const startIndex = page * pageSize;
                                    const endIndex = Math.min(startIndex + pageSize, results.length);
                                    const pageItems = results.slice(startIndex, endIndex);
                                    
                                    let titleText = `🔎 Resultados para: "${gameName}" (Página ${page + 1}/${totalPages})`;
                                    if (direct) {
                                        titleText = `❌ Não encontrei o jogo exato para: "${gameName}", mas aqui estão opções semelhantes (Página ${page + 1}/${totalPages})`;
                                    }
                                    
                                    let description = 'Selecione uma das opções no menu abaixo para receber o arquivo de download.\n\n';
                                    pageItems.forEach((game, index) => {
                                        const date = new Date(game.uploadDate).toLocaleDateString('pt-BR');
                                        const safeTitle = game.title.length > 70 ? game.title.substring(0, 67) + '...' : game.title;
                                        const displayIndex = startIndex + index + 1;
                                        description += `**#${displayIndex}** ${game.emoji} **${safeTitle}**\n`;
                                        description += `\`📦 ${game.fileSize}\`  •  \`📅 ${date}\`  •  \`${game.provider}\`\n\n`;
                                    });
                                    
                                    const embed = new EmbedBuilder()
                                        .setTitle(titleText)
                                        .setDescription(description)
                                        .setColor(0x7C3AED)
                                        .setFooter({ text: 'Hikari Torrent Search • by yGuilhermy' });
                                    
                                    const components = createPaginationComponents(page, totalPages, pageItems, startIndex);
                                    return { embeds: [embed], components };
                                };
                                
                                const initialPayload = renderMcpPage(currentPage);
                                const responseMsg = await unifiedReply('', [], initialPayload.components, initialPayload.embeds);
                                
                                if (responseMsg) {
                                    const collector = responseMsg.createMessageComponentCollector({
                                        time: 120000
                                    });
                                    
                                    collector.on('collect', async i => {
                                        if (i.user.id !== userId) {
                                            return i.reply({ content: '❌ Faça sua própria busca por texto.', ephemeral: true });
                                        }
                                        
                                        if (i.customId === 'game_prev') {
                                            currentPage--;
                                            await i.update(renderMcpPage(currentPage));
                                        } else if (i.customId === 'game_next') {
                                            currentPage++;
                                            await i.update(renderMcpPage(currentPage));
                                        } else if (i.customId === 'select_game') {
                                            await i.update({ content: '🔄 **Processando...** Buscando arquivo...', components: [], embeds: [] });
                                            const selectedIndex = parseInt(i.values[0]);
                                            const selectedGame = results[selectedIndex];
                                            console.log(`[LOG] Seleção Game (MCP): ${selectedGame.title} | Usuário: ${i.user.tag} (${i.user.id})`);
                                            
                                            const result = await getTorrentOrMagnet(selectedGame);
                                            const attachment = new AttachmentBuilder(result.buffer, { name: result.fileName });
                                            const successEmbed = new EmbedBuilder()
                                                .setTitle(`🚀 Download Pronto: ${selectedGame.title}`)
                                                .setDescription(result.message)
                                                .setColor(result.color)
                                                .addFields({ name: '🔗 Magnet Link (Backup)', value: `\`\`\`${selectedGame.magnet}\`\`\`` })
                                                .setFooter({ text: 'Hikari Torrent Search • by yGuilhermy' });
                                                
                                            await i.editReply({ content: '', embeds: [successEmbed], files: [attachment] });
                                            collector.stop();
                                        }
                                    });
                                    
                                    collector.on('end', (collected, reason) => {
                                        if (reason === 'time') {
                                            responseMsg.delete().catch(() => {});
                                        }
                                    });
                                }
                                savePromptToHistory(prompt, userTag, userId, `[TOOL: SEARCH_GAME - ${gameName}]`, interaction);
                                return;
                            }
                        } else {
                            processedResponse = `❌ Não encontrei "${gameName}" nas fontes (FitGirl/DODI). Tente novamente com outro nome (lembre-se que é apenas jogos de PC)`;
                        }
                    }
                    if (toolData.tool === 'show_bot_menu' || toolData.tool === 'get_help') {
                        try {
                            const BANS_FILE = path.join(__dirname, '../data/bans.json');
                            const helpPath = path.join(__dirname, '../data/help.json');
                            if (fs.existsSync(helpPath)) {
                                const helpData = JSON.parse(fs.readFileSync(helpPath, 'utf8'));
                                const menuOptions = helpData.map(item => ({
                                    label: item.label,
                                    description: item.description || 'Clique para ver mais',
                                    value: item.id,
                                }));
                                const selectMenu = new StringSelectMenuBuilder()
                                    .setCustomId('help_menu')
                                    .setPlaceholder('📚 Selecione um tópico de ajuda')
                                    .addOptions(menuOptions);
                                const row = new ActionRowBuilder().addComponents(selectMenu);
                                let helpEmbed;
                                if (toolData.args && toolData.args.context) {
                                    const specificItem = helpData.find(i => i.id === toolData.args.context);
                                    if (specificItem && specificItem.answer) {
                                        helpEmbed = new EmbedBuilder()
                                            .setColor(0x7C3AED)
                                            .setTitle(specificItem.label)
                                            .setDescription(specificItem.answer)
                                            .setFooter({ text: 'Hikari • Menu de Ajuda • by yGuilhermy' })
                                            .setTimestamp();
                                    }
                                }
                                if (!helpEmbed) {
                                    helpEmbed = new EmbedBuilder()
                                        .setColor(0x7C3AED)
                                        .setTitle('✨ Central de Ajuda — Hikari')
                                        .setDescription('Selecione um tópico no menu abaixo para ver as informações sobre aquela categoria.')
                                        .addFields(
                                            helpData.map(item => ({
                                                name: item.label,
                                                value: item.description || 'Sem descrição',
                                                inline: true,
                                            }))
                                        )
                                        .setFooter({ text: 'Hikari • Menu de Ajuda • by yGuilhermy' })
                                        .setTimestamp();
                                }
                                await unifiedReply('', [], [row], [helpEmbed]);
                                savePromptToHistory(prompt, userTag, userId, `[TOOL: GET_HELP]`, interaction);
                                return;
                            } else {
                                processedResponse = "⚠️ Arquivo de ajuda não encontrado.";
                            }
                        } catch (err) {
                            processedResponse = `❌ Erro ao abrir ajuda: ${err.message}`;
                        }
                    }
                }
                if (toolData.tool === 'generate_reply') {
                    let content = toolData.args.content;
                    const hallucinatedFooterRegex = /\n-# Modelo: .*$/;
                    if (hallucinatedFooterRegex.test(content)) {
                        console.log('[Anti-Hallucination] Rodapé duplicado removido do conteúdo gerado.');
                        content = content.replace(hallucinatedFooterRegex, '');
                    }
                    processedResponse = content;
                    if (modelFooter) {
                        processedResponse += `${modelFooter} | ⏱️ ${duration}`;
                    } else {
                        processedResponse += `\n-# ⏱️ ${duration}`;
                    }
                    console.log(`[MCP CHAT] Resposta gerada via Tool: ${processedResponse.substring(0, 50)}...`);
                }
                if (toolData.tool === 'search_web') {
                    const query = toolData.args.query;
                    const searchEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('🔎 Executando Ação')
                        .setDescription(`Pesquisando na web por: **"${query}"**\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Buscando informações'}*`)
                        .setFooter({ text: 'Hikari Search • Tool Use: search_web' });
                    await unifiedReply(null, [], [], [searchEmbed]);
                    const searchResults = await performWebSearch(query);
                    if (searchResults) {
                        const contextPrompt = `
[RESULTADOS DA PESQUISA WEB]:
${searchResults}
[INSTRUÇÃO]:
O usuário perguntou: "${prompt}"
Use as informações acima para responder a pergunta do usuário.
Responda APENAS com texto (NÃO USE JSON/TOOLS AGORA). Seja direto e informativo.
`;
                        processedResponse = await generateResponse(contextPrompt, channelId, { allowSearch: false, disableTools: true });
                        processedResponse += `\n-# 🔎 Search`;
                    } else {
                        processedResponse = `❌ Não encontrei nada relevante sobre "${query}" na busca rápida.`;
                    }
                }
                if (toolData.tool === 'check_steam') {
                    const query = toolData.args.game;
                    const steamSearchEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('🎮 Executando Ação')
                        .setDescription(`Consultando dados sobre **"${query}"** na Steam\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Consultando a Steam'}*`)
                        .setFooter({ text: 'Hikari Steam • Tool Use: check_steam' });
                    await unifiedReply(null, [], [], [steamSearchEmbed]);
                    const steamInfo = await getSteamGameInfo(query);
                    
                    if (steamInfo.error) {
                        processedResponse = steamInfo.error;
                    } else {
                        let finalDesc = steamInfo.description || "Sem sinopse válida.";
                        if (finalDesc.length > 3900) finalDesc = finalDesc.substring(0, 3900) + '...';
                        
                        const steamEmbed = new EmbedBuilder()
                                                            .setColor(0x7C3AED)
                            .setTitle(steamInfo.name)
                            .setURL(steamInfo.url)
                            .setDescription(finalDesc)
                            .addFields(
                                { name: 'Preço', value: steamInfo.discount > 0 ? `~~${steamInfo.originalPrice}~~ **${steamInfo.price}** (-${steamInfo.discount}%)` : steamInfo.price, inline: true },
                                { name: 'Lançamento', value: steamInfo.releaseDate, inline: true },
                                { name: 'Desenvolvedor', value: steamInfo.developers, inline: true }
                            )
                            .setFooter({ text: 'Fonte: Loja da Steam • Hikari • by yGuilhermy' })
                            .setTimestamp();
                            
                        if (steamInfo.headerImage) {
                            steamEmbed.setImage(steamInfo.headerImage);
                        }
                        if (steamInfo.metacritic) {
                            steamEmbed.addFields({ name: 'Metacritic', value: `${steamInfo.metacritic}/100 🌟`, inline: true });
                        }
                        
                        let hikariComment = `Ok, puxei as informações sobre **${steamInfo.name}** pra você! Está custando ${steamInfo.price}.`;
                        
                        try {
                            const commentPrompt = `Eu acabei de consultar o jogo "${steamInfo.name}" na Steam. O preço atual é ${steamInfo.price} e o lançamento foi em ${steamInfo.releaseDate}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, colocando o valor na resposta, na sua personalidade de forma natural. (NÃO gere json nem responda pedindo, apenas diga a fala natural).`;
                            const rawComment = await generateResponse(commentPrompt, channelId, { allowSearch: false, disableTools: true, guildId, isInternalComment: true });
                            if (rawComment && !rawComment.includes('⚠️ SYSTEM ERROR')) {
                                let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                                const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                                if (jsonMatch) {
                                    try {
                                        const parsed = JSON.parse(jsonMatch[0]);
                                        cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || (Object.keys(parsed).length === 1 ? Object.values(parsed)[0] : cleanData);
                                    } catch (e) {}
                                }
                                hikariComment = cleanData;
                            }
                        } catch (e) {
                            console.warn('Erro ao gerar comentario steam', e.message);
                        }

                        const payload = { content: hikariComment, embeds: [steamEmbed], files: [] };
                        if (type === 'mention') await replyMessage.edit(payload);
                        else await interaction.editReply(payload);
                        
                        addToHistory(channelId, 'user', prompt);
                        addToHistory(channelId, 'assistant', `[Consulta Steam: ${steamInfo.name}] ${hikariComment}`);
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: CHECK_STEAM - "${steamInfo.name}"]`, interaction);
                        return;
                    }
                }
                if (toolData.tool === 'convert_currency') {
                    const { amount, from, to } = toolData.args;
                    const currencyEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('💱 Executando Ação')
                        .setDescription(`Convertendo **${amount} ${from}** para **${to}**\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Consultando câmbio'}*`)
                        .setFooter({ text: 'Hikari Finance • Tool Use: convert_currency' });
                    await unifiedReply(null, [], [], [currencyEmbed]);
                    const convInfo = await convertCurrency(amount, from, to);
                    
                    if (convInfo.error) {
                        processedResponse = convInfo.error;
                    } else {
                        const amountFormatted = Number(convInfo.amount).toLocaleString('pt-BR');
                        const resultFormatted = Number(convInfo.result).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
                        const rateFormatted = Number(convInfo.rate).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
                        const convEmbed = new EmbedBuilder()
                            .setColor(0x10B981)
                            .setTitle(`Conversão de Moedas: ${convInfo.name}`)
                            .setDescription(`**${amountFormatted} ${convInfo.from}** equivale a **${resultFormatted} ${convInfo.to}**`)
                            .addFields(
                                { name: 'Cotação (' + convInfo.from + ')', value: `1 ${convInfo.from} = ${rateFormatted} ${convInfo.to}`, inline: true },
                                { name: 'Última Atualização', value: convInfo.lastUpdate || 'Desconhecida', inline: true }
                            )
                            .setFooter({ text: 'Fonte: AwesomeAPI • Hikari • by yGuilhermy' })
                            .setTimestamp();
                            
                        let hikariComment = `Pronto! Deu **${resultFormatted} ${convInfo.to}** na cotação atual.`;
                        
                        try {
                            const commentPrompt = `Eu acabei de converter ${convInfo.amount} ${convInfo.from} para ${convInfo.to}. O resultado foi ${resultFormatted}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (NÃO gere json nem responda pedindo, apenas diga a fala natural).`;
                            const rawComment = await generateResponse(commentPrompt, channelId, { allowSearch: false, disableTools: true, guildId, isInternalComment: true });
                            if (rawComment && !rawComment.includes('⚠️ SYSTEM ERROR')) {
                                let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                                const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                                if (jsonMatch) {
                                    try {
                                        const parsed = JSON.parse(jsonMatch[0]);
                                        cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || (Object.keys(parsed).length === 1 ? Object.values(parsed)[0] : cleanData);
                                    } catch (e) {}
                                }
                                hikariComment = cleanData;
                            }
                        } catch (e) {
                            console.warn('Erro ao gerar comentario currency', e.message);
                        }

                        const payload = { content: hikariComment, embeds: [convEmbed], files: [] };
                        if (type === 'mention') await replyMessage.edit(payload);
                        else await interaction.editReply(payload);
                        
                        addToHistory(channelId, 'user', prompt);
                        addToHistory(channelId, 'assistant', `[Converteu ${convInfo.amount} ${convInfo.from} para ${convInfo.to} -> ${resultFormatted}] ${hikariComment}`);
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: CONVERT_CURRENCY - "${amount} ${from} -> ${to}"]`, interaction);
                        return;
                    }
                }
                if (toolData.tool === 'generate_image') {
                    const imagePrompt = toolData.args.prompt || '';
                    let imageNegative = toolData.args.negative_prompt || '';
                    const NSFW_POSITIVE_KEYWORDS = [
                        'nude', 'naked', 'nsfw', 'porn', 'sex', 'hentai', 'gore', 'blood',
                        'explicit', 'adult', 'r18', 'r34', 'erotic', 'lewd', 'topless',
                        'nua', 'pelada', 'sexo', 'pornô', 'porno', 'violento', 'sangrento',
                        'decapitad', 'tortura', 'mutilad', 'genitali', 'vagina', 'penis', 'pênis', 'cp', 'pornografia'
                    ];
                    const lowerImagePrompt = imagePrompt.toLowerCase();
                    const hasNsfwRequest = NSFW_POSITIVE_KEYWORDS.some(kw => lowerImagePrompt.includes(kw));
                    if (hasNsfwRequest) {
                        console.warn(`[GenerateImage] Bloqueado pedido NSFW: "${imagePrompt.substring(0, 80)}"`);
                        const scoldPrompt = `O usuário te pediu para gerar uma imagem com conteúdo NSFW/impróprio: "${imagePrompt.substring(0, 100)}". Dê uma bronca curta e natural nele, na sua personalidade Hikari, sem gerar a imagem. Seja direta, sem rodeios, pode ser um pouco irônica.`;
                        const scoldResponse = await generateResponse(scoldPrompt, channelId, { allowSearch: false, disableTools: true, guildId });
                        processedResponse = scoldResponse;
                    } else {
                        const SAFETY_NEGATIVE = 'nsfw, nude, explicit, gore, violence, blood, adult content, 18+, pornographic, sexual, disturbing, hentai, r18, genitals, suggestive, semi-nude';
                        if (!imageNegative.trim()) {
                            imageNegative = SAFETY_NEGATIVE;
                        } else {
                            const safetyTokens = SAFETY_NEGATIVE.split(',').map(t => t.trim());
                            const existing = imageNegative.toLowerCase();
                            const missing = safetyTokens.filter(t => !existing.includes(t));
                            if (missing.length > 0) imageNegative += ', ' + missing.join(', ');
                        }
                        const width  = Math.min(toolData.args.width  || 1024, 1280);
                        const height = Math.min(toolData.args.height || 1024, 1280);
                        const imageEmbed = new EmbedBuilder()
                            .setColor(0x7C3AED)
                            .setTitle('🎨 Executando Ação')
                            .setDescription(`Gerando imagem com IA\n\n💬 **Prompt:**\n> *"${imagePrompt.substring(0, 100)}${imagePrompt.length > 100 ? '...' : ''}"*\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Criando ilustração'}*`)
                            .setFooter({ text: 'Hikari Art • Tool Use: generate_image' });
                        await unifiedReply(null, [], [], [imageEmbed]);
                        try {
                            const imageData = await generateImage(imagePrompt, imageNegative, width, height);
                            if (imageData && (imageData.imageUrl || imageData.localFilePath)) {
                                let hikariComment = 'olha, ficou bem interessante isso daí...';
                                try {
                                    console.log(`[ImageHandler] Pedindo comentário para Hikari sobre: "${imagePrompt.substring(0, 40)}..."`);
                                    const commentPrompt = `Você (Hikari) acabou de gerar uma imagem com o prompt: "${imagePrompt}". Faça um comentário MUITO CURTO (máximo 15 palavras), natural e casual sobre essa ideia/resultado. NÃO use JSON. NÃO use ferramentas. Apenas texto puro. Seja direta e use seu estilo de fala.`;
                                    const rawComment = await generateResponse(commentPrompt, channelId, {
                                        allowSearch: false,
                                        disableTools: true,
                                        guildId,
                                        isInternalComment: true
                                    });
                                    if (rawComment && !rawComment.includes('⚠️ SYSTEM ERROR')) {
                                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                                        if (jsonMatch) {
                                            try {
                                                const parsed = JSON.parse(jsonMatch[0]);
                                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || (Object.keys(parsed).length === 1 ? Object.values(parsed)[0] : cleanData);
                                            } catch (e) {}
                                        }
                                        hikariComment = cleanData;
                                        console.log(`[ImageHandler] Comentário gerado: "${hikariComment}"`);
                                    }
                                } catch (commentErr) {
                                    console.warn('[GenerateImage] Falha ao gerar comentário:', commentErr.message);
                                }
                                const imageEmbed = new EmbedBuilder()
                                    .setColor(0x7C3AED)
                                    .setDescription('⚠️ **Aviso:** Eu apenas **gero** imagens novas a partir de texto. Eu **não edito** imagens e **não tenho visão computacional** para ver arquivos.')
                                    .addFields(
                                        { name: '🤖 Modelo', value: `\`${imageData.modelName || 'Desconhecido'}\``, inline: false },
                                        { name: '🌱 Seed',   value: `\`${imageData.actualSeed}\``, inline: true },
                                        { name: '📐 Resolução', value: `\`${width}x${height}\``, inline: true }
                                    )
                                    .setFooter({ text: `Prompt: ${imagePrompt.substring(0, 100)}${imagePrompt.length > 100 ? '...' : ''} • by yGuilhermy` })
                                    .setTimestamp();
                                const imageFiles = [];
                                if (imageData.imageUrl) {
                                    imageEmbed.setImage(imageData.imageUrl);
                                } else if (imageData.localFilePath && fs.existsSync(imageData.localFilePath)) {
                                    const attachment = new AttachmentBuilder(imageData.localFilePath, { name: 'image.png' });
                                    imageEmbed.setImage('attachment://image.png');
                                    imageFiles.push(attachment);
                                    setTimeout(() => {
                                        try { if (fs.existsSync(imageData.localFilePath)) fs.unlinkSync(imageData.localFilePath); } catch (_) {}
                                    }, 10_000);
                                } else {
                                    throw new Error('Nenhuma imagem disponível para exibir');
                                }
                                const payload = { content: hikariComment, embeds: [imageEmbed], files: imageFiles };
                                if (type === 'mention') await replyMessage.edit(payload);
                                else await interaction.editReply(payload);
                                addToHistory(channelId, 'user', prompt);
                                addToHistory(channelId, 'assistant', `[Gerou imagem via ${imageData.modelName}] ${hikariComment}`);
                                savePromptToHistory(prompt, userTag, userId, `[TOOL: GENERATE_IMAGE - "${imagePrompt}"]`, interaction);
                                return;
                            } else {
                                processedResponse = '❌ Não consegui gerar a imagem agora. Pode ser que o serviço esteja lotado, ou acabou a quota, tente novamente mais tarde!';
                            }
                        } catch (imgError) {
                            console.error('[GenerateImage Tool] Erro:', imgError.message);
                            processedResponse = `❌ Erro ao gerar imagem: ${imgError.message}`;
                        }
                    }
                }
                if (toolData.tool === 'ia_automod') {
                    if (config.isAutomodWhitelisted(userId)) {
                        console.warn('[IA_AUTOMOD] Usuario na whitelist. Execucao de banimento ignorada/bypass.');
                    } else {
                        const _mode = getAutoBlockMode(guildId);
                        const _automodActive = _mode !== 'off';
                        if (!_automodActive || (_mode !== 'mcp' && _mode !== 'both')) {
                            console.warn('[IA_AUTOMOD] Tool acionada mas modo/automod não permite. Ignorado.');
                        } else {
                            const { reason, severity } = toolData.args;
                            const alreadyBanned = checkBan(userId, null, null);
                            if (!alreadyBanned) {
                                addBan('user', userId, reason || 'Violação dos Termos detectada pela IA Hikari.');
                                console.warn(`[IA_AUTOMOD] Usuário ${userTag} (${userId}) banido pela IA. Severidade: ${severity}. Motivo: ${reason}`);
                                const banEmbed = new EmbedBuilder()
                                    .setColor(0xE11D48)
                                    .setTitle('🚨 DISPOSITIVO DE SEGURANÇA ACIONADO — VOCÊ FOI BANIDO!')
                                    .setDescription(`🛑 **UM BLOQUEIO PERMANENTE E IMEDIATO FOI APLICADO.**\n\nO sistema de inteligência da Hikari analisou o contexto desta conversa e identificou uma conduta que viola gravemente os Termos de Uso.\n\n**DETALHES DO BANIMENTO:**\n- **ALVO PENALIZADO:** Seu perfil de usuário (Banido Globalmente)\n- **STATUS:** 🔴 TOTALMENTE BANIDO E BLOQUEADO.\n\nO acesso aos serviços foi completamente revogado. Qualquer nova tentativa de burlar a segurança agravará a punição.\n\nSe você julga que isso é um erro, utilize o botão de apelação abaixo.\n\n---\n✨ **Dica:** Quer a Hikari sem filtros? Hospede sua própria versão!\n🚀 **GitHub:** [yGuilhermy/Hikari](https://github.com/yGuilhermy/Hikari)`)
                                    .setFooter({ text: 'Hikari AI AutoMod • by yGuilhermy' })
                                    .setTimestamp();
                                const githubButton = new ButtonBuilder()
                                    .setLabel('Página do Projeto')
                                    .setURL('https://github.com/yGuilhermy/Hikari')
                                    .setStyle(ButtonStyle.Link)
                                    .setEmoji('🚀');
                                const appealButton = new ButtonBuilder()
                                    .setCustomId(`appeal_ban_user_${userId}`)
                                    .setLabel('⚖️ Solicitar Apelação')
                                    .setStyle(ButtonStyle.Secondary);
                                const banRow = new ActionRowBuilder().addComponents(appealButton, githubButton);
                                savePromptToHistory(prompt, userTag, userId, `[IA_AUTOMOD BAN - Severidade: ${severity}]`, interaction);
                                return await unifiedReply(null, [], [banRow], [banEmbed]);
                            }
                        }
                    }
                }
            }
        } catch (e) {
        }
        if (processedResponse && (processedResponse.includes('[Tool Use:') || thoughtLeakRegex.test(processedResponse))) {
            console.error('[SECURITY BLOCK] Bloqueado vazamento de Tool Use/JSON Raw:', processedResponse);
            processedResponse = "⚠️ **Erro de Processamento:** A IA tentou usar uma ferramenta mas o formato do MCP saiu inválido, isso é normal, não é um bug. Tente novamente ou use os comandos /buscar_jogo, /baixar_musica ou /baixar_video";
        }
        if (processedResponse) {
            addToHistory(channelId, 'user', prompt);
            const cleanResponseForHistory = processedResponse.replace(/\n-# .*$/, '');
            addToHistory(channelId, 'assistant', cleanResponseForHistory);
            await unifiedReply(processedResponse);
            console.log(`[LOG] Resposta IA: "${processedResponse.substring(0, 500)}${processedResponse.length > 500 ? '...' : ''}" | Duração: ${duration}`);
            savePromptToHistory(prompt, userTag, userId, processedResponse, interaction);
        }
    } catch (error) {
        console.error('Erro ao processar fila:', error.response ? error.response.data : error.message);
        addToHistory(channelId, 'assistant', 'erro da ia');
        await unifiedReply('⚠️ Desculpe, tive um erro ao processar seu pedido. Tente novamente.');
    } finally {
        setTimeout(processQueue, 1000);
    }
}
async function addToQueue(prompt, interaction, type, options = {}) {
    let userTag, userId;
    const channelId = interaction.channelId;
    if (type === 'mention') {
        userTag = interaction.author.tag;
        userId = interaction.author.id;
    } else {
        userTag = interaction.user.tag;
        userId = interaction.user.id;
        if (!interaction.deferred && !interaction.replied) {
            const isPublic = options.public === true;
            await interaction.deferReply({ ephemeral: !isPublic });
        }
    }
    processingQueue.push({ prompt, interaction, type, userTag, userId, channelId, options });
    notifyQueueUpdate();
    if (!isProcessing) {
        processQueue();
    } else {
        if (type === 'mention') {
            const queuePosition = processingQueue.length;
            try {
                const queueMsg = await interaction.reply({
                    content: `Sua solicitação está na fila. Posição: ${queuePosition}.`,
                    fetchReply: true,
                    failIfNotExists: false
                });
                setTimeout(() => {
                    queueMsg.delete().catch(() => { });
                }, 10000);
            } catch (err) {
                console.warn('[QueueMessage] Erro ao enviar aviso de fila:', err.message);
            }
        }
    }
}
let globalShowModel = false;
function updateShowModel(value) {
    globalShowModel = value;
    console.log(`[CONFIG] show_model atualizado para ${value}`);
}
function getShowModel() {
    return globalShowModel;
}
let globalShowModelThinking = true;
function updateShowModelThinking(value) {
    globalShowModelThinking = value;
    console.log(`[CONFIG] show_model_thinking atualizado para ${value}`);
}
function getShowModelThinking() {
    return globalShowModelThinking;
}
let globalErrorRetries = 0;
function updateErrorRetries(value) {
    globalErrorRetries = value;
    console.log(`[CONFIG] error_retries atualizado para ${value}`);
}
function getErrorRetries() {
    return globalErrorRetries;
}
function updateProviderSetting(provider, key, value) {
    if (providerSettings[provider] && providerSettings[provider][key] !== undefined) {
        providerSettings[provider][key] = value;
        console.log(`[CONFIG] ${provider}.${key} atualizado para ${value}`);
        return true;
    }
    return false;
}
function getProviderSettings() {
    return providerSettings;
}
module.exports = {
    addToQueue,
    setOnQueueUpdate,
    setDiscordClient,
    setChannelPersona,
    setChannelChatter,
    getChannelSettings,
    updateProviderSetting,
    getProviderSettings,
    updateShowModel,
    getShowModel,
    updateShowModelThinking,
    getShowModelThinking,
    updateErrorRetries,
    getErrorRetries,
    generateResponse,
    getServerPrompt,
    setServerPrompt,
    resetServerPrompt,
    getAllMcpTools: () => ALL_MCP_TOOLS,
    getDisabledTools,
    setServerToolEnabled,
    resetServerTools,
    getServerSettings,
    setServerEveryoneMention,
    setServerUpdateChannel,
    setServerLastChannel,
};