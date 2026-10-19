import axios from 'axios';
import { contextFromDiscord, buildMemoryBlock, captureFromUserText } from '../core/discordAdapter.js';
import { resolveMentions, neutralizeMassMentions } from '../discord/mentions.js';
import { alertOwner } from '../core/alerts.js';
import { applyPersona, applyVoicePersona, buildPersonaPrompt, publicPersonaText } from '../core/persona.js';
import { getGateway, gatewayInChain } from '../gateway/index.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'node:url';
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { smartSearchDetailed, createWebContextMemo, searchForAgent, fetchPageContent, isBlacklisted } from './searchManager.js';
import { searchWeb } from '../search/providers.js';
// Agente de pesquisa: detectores puros (searchIntent) e laço limitado com resposta final garantida (researchAgent). Nenhum dos dois importa este arquivo (sem ciclo).
import { runResearch, readResearchConfig, createUserGuard, privateSearchAllowed } from './researchAgent.js';
import { preRouteDecision, recoveryPlan, inspectFinalGuard, finalGuard, finalGuardDetailed, userNeedsAnswer, buildNoPromiseRetryPrompt, buildSearchQuery, isRawToolLeak, NEED_TOPIC_REPLY, VOICE_REFUSAL } from './searchIntent.js';
import { isOwnerId } from '../core/permissions.js';
// Lista de mods (Minecraft): o CÓDIGO procura cada nome no Modrinth e monta a lista com os links (Porta M, antes da Porta A).
import { routeModList } from './modListResolver.js';
import { routeLists } from './listAssistant.js';
import { logger } from '../utils/logger.js';
import { getMediaUserMessage, formatDeezerDelivery, codeSafe, isUploadTooLargeError, MEDIA_MESSAGES } from '../utils/mediaUrls.js';
// Textos grandes: corte que não parte emoji, limite de upload, orçamento de prompt e leitor de linhas do stream SSE (TG-02, 05, 08, 11, 16, 37).
import { clampText } from '../discord/embedLimits.js';
import { getUploadLimitBytes, limitLabelMB, formatUploadLimit, formatMB } from '../utils/uploadLimit.js';
import { estimateTokens, isTooLargeError, sizeErrorText, drainErrorBody } from '../utils/promptBudget.js';
import { createLineSplitter, sseDataOf } from '../utils/sseLines.js';
// Fala (TTS) da Yui na call: o gancho e as regras puras de voz. O serviço recebe tudo por `deps` e não importa este arquivo (sem ciclo).
import { interruptSpeech, speakVoiceReply } from '../services/tts/index.js';
import { getTtsConfig } from '../services/tts/config.js';
import {
    VOICE_TOOL_REFUSAL,
    isVoiceItem,
    buildVoiceKey,
    shouldBlockToolForVoice,
    isStaleVoiceItem,
    clipForChat
} from '../services/tts/voiceGuards.js';
import {
    buildWebContextPrompt,
    buildSearchToolPrompt,
    providersAllowed,
    isAnonymousProvider,
    webSearchGate,
    describeSearchOutcome,
    memoryCaptureText,
    authorOwnText,
    promptForDiskHistory,
    downloadPlaylistNote,
    scrubLogText,
    GEMINI_SEARCH_RULE,
    SENSITIVE_SEARCH_REFUSAL,
    extractFirstJsonObject,
    canonicalToolName,
    normalizeToolCall,
    NEVER_PROMISE_RULE,
    STRICT_MODE_SEARCH_LINE,
    STRICT_MODE_REPLY_LINE,
    TOOLS_INTRO_LINE,
    TOOLS_SEARCH_DECISION,
    SEARCH_WEB_EXTRA_EXAMPLES
} from './llmSafety.js';
import {
    createUnifiedReply,
    parseMaxParts,
    parseReplyMaxTokens,
    isTruncatedFinish,
    looksLikeToolJson,
    recoverReplyContent,
    mergeContinuation,
    applyPromiseNotice,
    antiEchoExempt,
    historyCopy,
    formatDeliveryLog,
    CONTINUE_INSTRUCTION,
    TRUNCATION_NOTICE,
    MAX_CONTINUATIONS,
    MAX_CONTINUED_CHARS
} from '../discord/longReply.js';
import { AttachmentBuilder, EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, StringSelectMenuOptionBuilder, WebhookClient, ButtonBuilder, ButtonStyle } from 'discord.js';
import {
    downloadAudio,
    downloadVideo,
    cleanupDownload,
    sanitizeFilenameForDiscord,
    isUserBusy,
    getBusyReason,
    lockUser,
    unlockUser,
    canBypass,
    storeVideoForCompression,
    formatVideoSuccessMessage
} from './youtubeAudioHandler.js';
import { searchGames, getTorrentOrMagnet, createPaginationComponents, normalizeString } from './gameHandler.js';
import { generateImage } from './imageHandler.js';
import { getSteamGameInfo } from './steamHandler.js';
import { convertCurrency } from './currencyHandler.js';
import { getGameInfoWithSteamFallback, compareSpecs, formatVerdict } from './gameInfoHandler.js';
import { handleMusicSearchAndDownload } from './deezerMusicHandler.js';
import dotenv from 'dotenv';
dotenv.config();
import config from '../config/index.js';
import { getSession } from '../music/radioDatabase.js';
import { handleRadioMCPCall } from '../music/radioMCPHandler.js';
import { getCurrentMusicFromUser } from '../services/activityMusicService.js';
import { buildHelpHomePayload, buildHelpCreatorPayload, buildHelpRulesPayload, buildHelpCommandListPayload } from './helpPanelHandler.js';
import { joinVoiceCall, leaveVoiceCall } from './voiceHandler.js';
import {
    contextEnabled,
    contextFilesExist,
    purgeCorruptContextFiles,
    resolveContextTarget,
    isDirectCall,
    initContextStore,
    runWithContext,
    currentContext,
    readContextTurns,
    recordContextExchange,
    ERROR_MARKER,
    isErrorReply,
    isUnsafeForContext
} from '../core/context/contextStore.js';
const geminiCooldowns = {};
// A regra "toda resposta é FINAL" do [REGRAS] sem citar nenhuma ferramenta: chamadas com as ferramentas fechadas (voz, /yui, a síntese da pesquisa, pesquisa desligada)
// não podem ter "search_web" no prompt de sistema (a IA entenderia que a oferece). Com a ferramenta disponível vale a NEVER_PROMISE_RULE completa, do llmSafety.
const NEVER_PROMISE_RULE_NO_TOOLS = 'Toda resposta tem de ser FINAL: nunca diga que vai pesquisar, verificar ou voltar depois ("vou pesquisar", "um segundo", "já volto"), porque você não consegue mandar nada depois. Responda com o que sabe ou diga que não sabe.';
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
function isToolDisabled(guildId, toolName) {
    let checkName = toolName;
    if (checkName === 'get_help') checkName = 'show_bot_menu';
    const tool = ALL_MCP_TOOLS.find(t => t.function.name === checkName);
    const isDefaultDisabled = !!(tool && tool.meta && tool.meta.defaultDisabled);
    if (!guildId) return isDefaultDisabled;

    const cfg = serverToolsConfig[guildId];
    if (!cfg) return isDefaultDisabled;

    if (Array.isArray(cfg)) {
        if (cfg.includes(checkName)) return true;
        return isDefaultDisabled;
    }

    if (cfg.enabled && cfg.enabled.includes(checkName)) return false;
    if (cfg.disabled && cfg.disabled.includes(checkName)) return true;

    return isDefaultDisabled;
}

function getDisabledTools(guildId) {
    return ALL_MCP_TOOLS
        .filter(t => isToolDisabled(guildId, t.function.name))
        .map(t => t.function.name);
}

const VOICE_TOOLS = ['join_voice_call', 'leave_voice_call'];

function setServerToolEnabled(guildId, toolName, enabled) {
    const targetTools = (VOICE_TOOLS.includes(toolName) || toolName === 'voice_assistant')
        ? VOICE_TOOLS
        : [toolName];

    for (const tName of targetTools) {
        const tool = ALL_MCP_TOOLS.find(t => t.function.name === tName);
        if (!tool) continue;
        if (!tool.meta.disableable && !enabled) continue;

        if (!serverToolsConfig[guildId] || Array.isArray(serverToolsConfig[guildId])) {
            const oldDisabled = Array.isArray(serverToolsConfig[guildId]) ? serverToolsConfig[guildId] : [];
            serverToolsConfig[guildId] = {
                disabled: oldDisabled,
                enabled: []
            };
        }

        const cfg = serverToolsConfig[guildId];
        const isDefaultDisabled = !!(tool.meta && tool.meta.defaultDisabled);

        if (enabled) {
            const dIdx = cfg.disabled.indexOf(tName);
            if (dIdx !== -1) cfg.disabled.splice(dIdx, 1);

            if (isDefaultDisabled && !cfg.enabled.includes(tName)) {
                cfg.enabled.push(tName);
            }
        } else {
            const eIdx = cfg.enabled.indexOf(tName);
            if (eIdx !== -1) cfg.enabled.splice(eIdx, 1);

            if (!isDefaultDisabled && !cfg.disabled.includes(tName)) {
                cfg.disabled.push(tName);
            }
        }
    }

    if (serverToolsConfig[guildId] && serverToolsConfig[guildId].disabled.length === 0 && serverToolsConfig[guildId].enabled.length === 0) {
        delete serverToolsConfig[guildId];
    }

    saveServerTools();
    if (toolName === 'voice_tts' && !enabled) stopSpeechOfSwitchedOffGuild(guildId);
    return true;
}

function resetServerTools(guildId) {
    // O padrão do voice_tts é DESLIGADO: se estava ligado, voltar ao padrão também corta a fala em curso.
    const voiceWasOn = ALL_MCP_TOOLS.some((t) => t.function.name === 'voice_tts') && isToolDisabled(guildId, 'voice_tts') === false;
    delete serverToolsConfig[guildId];
    saveServerTools();
    if (voiceWasOn) stopSpeechOfSwitchedOffGuild(guildId);
}
// Desligar a resposta por voz corta a fala em curso NA HORA (e descarta a fila de fala do servidor), por qualquer caminho que mude o
// interruptor (painel, /yui-ferramentas, painel do dono). Sem isso a frase que está tocando terminava. Nunca lança.
function stopSpeechOfSwitchedOffGuild(guildId) {
    try { interruptSpeech(guildId, 'switch-off'); } catch (_) { /* a fala nunca atrapalha a configuração */ }
}
function sanitizeToolsForApi(tools) {
    if (!Array.isArray(tools) || tools.length === 0) return undefined;
    return tools.map(t => ({
        type: t.type || 'function',
        function: {
            name: t.function?.name || t.name,
            description: t.function?.description || t.description,
            parameters: t.function?.parameters || t.parameters
        }
    }));
}

// A pesquisa na web é OFERECIDA ao modelo nesta conversa? Em conversa sensível (DM, canal privado do dono, app) só quando o YUI_PRIVATE_SEARCH libera este usuário;
// senão a ferramenta seria recusada na hora e o modelo prometeria pesquisar (C7). Nunca lança.
// Conversa espontânea (`chatter`: a Yui entrando sozinha no canal) nunca pesquisa nem gasta a cota de quem só falou: a ferramenta nem é oferecida (só com o agente ligado;
// com YUI_RESEARCH_ENABLED=false vale o ramo antigo, que não distinguia). Com o agente desligado o privado também sempre recusa, então a ferramenta não é oferecida lá.
function searchOfferedFor({ sensitive = false, userId = null, chatter = false } = {}) {
    try {
        const cfg = readResearchConfig();
        if (chatter === true && cfg.enabled) return false;
        if (sensitive !== true) return true;
        return cfg.enabled && privateSearchAllowed(cfg.privateSearch, { isOwner: isOwnerId(userId) });
    } catch (_) { return sensitive !== true; }
}
// `sensitive`: conversa privada. Sem liberação do YUI_PRIVATE_SEARCH, search_web sai da oferta (o interruptor do servidor continua valendo à parte).
function buildToolsPayload(guildId, userId = null, { sensitive = false, chatter = false } = {}) {
    const disabled = searchOfferedFor({ sensitive, userId, chatter }) ? getDisabledTools(guildId) : [...getDisabledTools(guildId), 'search_web'];
    const mode = getAutoBlockMode(guildId);
    const automodActive = mode !== 'off';
    return ALL_MCP_TOOLS
        .filter(t => !disabled.includes(t.function.name))
        .filter(t => !(t.meta && t.meta.switchOnly)) // interruptor (ex.: voice_tts): só existe no painel, a IA nunca o vê
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
function buildToolsDefinition(guildId, userId = null, { sensitive = false, chatter = false } = {}) {
    const disabled = searchOfferedFor({ sensitive, userId, chatter }) ? getDisabledTools(guildId) : [...getDisabledTools(guildId), 'search_web'];
    const mode = getAutoBlockMode(guildId);
    const automodActive = mode !== 'off';
    const activeTools = ALL_MCP_TOOLS
        .filter(t => !disabled.includes(t.function.name))
        .filter(t => !(t.meta && t.meta.switchOnly)) // interruptor (ex.: voice_tts): só existe no painel, a IA nunca o vê
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
        toolList += `\n${idx}. **${f.name}**: ${f.description}\n`;
        toolList += `   - ${f.textual_triggers}\n`;
        toolList += `   - Args: ${f.textual_args}\n`;
        idx++;
    }
    const examplesMap = {
        download_audio:  'User: "Baixe pra mim https://youtu.be/..."\nResponse: { "thought": "User quer baixar audio.", "tool": "download_audio", "args": { "url": "https://youtu.be/..." } }',
        download_video:  'User: "Baixa esse vídeo https://www.instagram.com/reel/..."\nResponse: { "thought": "User quer baixar vídeo.", "tool": "download_video", "args": { "url": "https://www.instagram.com/reel/..." } }',
        search_game:     'User: "Arruma o torrent do GTA V"\nResponse: { "thought": "User quer jogo GTA V.", "tool": "search_game", "args": { "game_name": "Grand Theft Auto V" } }',
        search_web:      'User: "Pesquise sobre Hytale"\nResponse: { "thought": "User quer info externa (Web).", "tool": "search_web", "args": { "query": "Hytale game information news" } }\n' + SEARCH_WEB_EXTRA_EXAMPLES,
        show_bot_menu:   'User: "Yui, abra o menu interativo de ajuda por favor"\nResponse: { "thought": "User pediu explicitamente para abrir o menu visual de ajuda.", "tool": "show_bot_menu", "args": { "context": "geral" } }',
        generate_image:  'User: "gera uma imagem de um gato spacial"\nResponse: { "thought": "User quer uma imagem gerada por IA.", "tool": "generate_image", "args": { "prompt": "a space cat floating in galaxy, cinematic, detailed fur, neon lights", "negative_prompt": "nsfw, nude, explicit, gore, violence, blood, adult content, 18+, pornographic, sexual, disturbing, hentai, r18" } }',
        check_steam:     'User: "Elden Ring ta em promo na steam?"\nResponse: { "thought": "User quer saber preço de Elden Ring.", "tool": "check_steam", "args": { "game": "Elden Ring" } }',
        check_game_info: 'User: "qual a nota de Elden Ring?"\nResponse: { "thought": "User quer info geral do jogo.", "tool": "check_game_info", "args": { "game": "Elden Ring" } }\nUser: "quanto tempo pra zerar Baldur\u0027s Gate 3?"\nResponse: { "thought": "User quer tempo de jogo.", "tool": "check_game_info", "args": { "game": "Baldur\u0027s Gate 3" } }',
        check_pc_compatibility: 'User: "meu pc com rtx 3060 e 16gb roda cyberpunk?"\nResponse: { "thought": "User quer saber se roda.", "tool": "check_pc_compatibility", "args": { "game": "Cyberpunk 2077", "gpu": "RTX 3060", "ram": "16 GB" } }\nUser: "requisitos de GTA VI"\nResponse: { "thought": "User quer requisitos do jogo.", "tool": "check_pc_compatibility", "args": { "game": "GTA VI" } }',
        convert_currency:'User: "quanto ta 50 dolares em reais?"\nResponse: { "thought": "User quer converter 50 USD para BRL.", "tool": "convert_currency", "args": { "amount": 50, "from": "USD", "to": "BRL" } }',
        get_current_music:'User: "Yui, baixe a musica do meu status"\nResponse: { "thought": "User quer baixar música tocando no seu status.", "tool": "get_current_music", "args": { "download": true } }\nUser: "oq eu to escutando no status"\nResponse: { "thought": "User quer saber música do seu status.", "tool": "get_current_music", "args": { "download": true } }',
    };
    for (const [name, example] of Object.entries(examplesMap)) {
        if (!disabled.includes(name)) exampleList += `\n${example}\n`;
    }
    // Pesquisa ligada no servidor: a introdução cita a web e a 3ª regra manda chamar search_web NA HORA (nunca "vou pesquisar"). Desligada: nada disso entra.
    const searchOn = !disabled.includes('search_web');
    const introLine = searchOn ? TOOLS_INTRO_LINE : 'Use-as quando o usuário pedir para baixar algo ou buscar um jogo.';
    const searchDecisionLine = searchOn ? `\n${TOOLS_SEARCH_DECISION}` : '';
    return `\n--- FERRAMENTAS DISPONÍVEIS ---\nVocê tem acesso às seguintes ferramentas para executar ações reais.\n${introLine}\n${toolList}\n--- INSTRUÇÃO DE PENSAMENTO E DECISÃO ---\nAntes de responder, ANALISE:\n1. O usuário quer apenas conversar ou uma informação que você já sabe? -> Responda apenas com texto (Sem JSON).\n2. O usuário quer uma AÇÃO ESPECÍFICA (Download, Busca Web)? -> Responda com JSON.${searchDecisionLine}\n\nFORMATO PARA USO DE FERRAMENTA (JSON):\n{\n  "thought": "Pensamento ultra-curto (1 a 3 palavras para economizar tokens, ex: 'baixar audio')",\n  "tool": "nome_da_ferramenta",\n  "args": { ...argumentos... }\n}\n\nEXEMPLOS:${exampleList}\nUser: "Como você está?"\nResponse: Estou bem, e você?\n\n---------------------------------------\n`;
}
loadServerTools();
const providerSettings = {
    local:        { timeout: 60000, temperature: 0.7, max_tokens: 1024, top_p: 0.9 },
    gemini:       { timeout: 60000, temperature: 0.7, max_tokens: 2048, top_p: 1.0 },
    cloudflare:   { timeout: 30000, temperature: 0.7, max_tokens: 1024 },
    pollinations: { timeout: 60000, temperature: 0.7, max_tokens: 1024 },
    hf:           { timeout: 60000, temperature: 0.7, max_tokens: 512 },
    groq:         { timeout: 30000, temperature: 0.7, max_tokens: 1024 },
    gateway:      { timeout: 60000, temperature: 0.7, max_tokens: 1024 },
    horde:        { timeout: 60000, temperature: 0.7, max_tokens: 256 }
};
/**
 * YUI_REPLY_MAX_TOKENS (opcional, 64 a 8192): sobe o max_tokens de saída de todos os provedores (o Horde fica em até 512).
 * Sem a variável nada muda; o painel ainda pode ajustar cada provedor depois (updateProviderSetting).
 */
function applyReplyMaxTokensEnv(env = process.env) {
    const override = parseReplyMaxTokens(env);
    if (override === null) return false;
    for (const [name, settings] of Object.entries(providerSettings)) {
        settings.max_tokens = name === 'horde' ? Math.min(override, 512) : override;
    }
    return true;
}
applyReplyMaxTokensEnv();
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
// Histórico em RAM por canal (ou chave de voz). Map para a ordem de inserção valer (chaves numéricas pequenas de um objeto são reordenadas)
// e para poder descartar o fio mais antigo: sem teto, 1000 canais ocupavam cerca de 15 MB (TG-36).
const conversationHistory = new Map();
const lastModelByChannel = {};
const MAX_HISTORY = 10;
const DEFAULT_MAX_HISTORY_KEYS = 500;
// Teto de fios guardados (YUI_HISTORY_MAX_CHANNELS, de 10 a 100000; padrão 500). Lido a cada uso, nunca no import.
function maxHistoryKeys(env = process.env) {
    const n = Number.parseInt(String(env?.YUI_HISTORY_MAX_CHANNELS ?? ''), 10);
    return Number.isFinite(n) && n >= 10 ? Math.min(n, 100000) : DEFAULT_MAX_HISTORY_KEYS;
}
// CONTEXTO POR HORAS (src/core/context/contextStore.js). DESLIGADO por padrão (YUI_CONTEXT_ENABLED=false) e, ligado, só para o dono
// (YUI_CONTEXT_SCOPE=owner). Desligado, ou fora do escopo, vale o buffer abaixo, por canal e só em RAM, exatamente como sempre foi.
// Ligado, o item da fila roda dentro de um AsyncLocalStorage com a chave do fio de UMA pessoa (dm:<userId> ou ch:<canal>:u:<userId>):
// getHistory lê dele e o buffer do canal NÃO é tocado (não mistura pessoas nem guarda conversa pessoal ali). A chave nunca substitui
// o channelId: ele continua valendo para a persona do canal e para o rodapé do modelo. O histórico guardado só chega aos provedores
// pelo campo `history`; nunca é colado no texto do prompt.
function contextActive() {
    return currentContext()?.active === true;
}
// Grava a troca (fala do autor + resposta curta) no contexto por horas. Uma gravação por troca; nunca lança.
function commitContext(target, assistantText) {
    if (!target?.active || target.committed || !target.record || !target.userText) return false;
    target.committed = true;
    return recordContextExchange(target, { userText: target.userText, assistantText });
}
// Frase curta da Yui para ferramentas e downloads (nunca o prompt inteiro, nunca título ou texto vindo de fora).
function setContextLine(line) {
    const target = currentContext();
    if (target?.active && line) target.line = String(line);
}
// Troca de um ramo de ferramenta. Só depois da ENTREGA: `target.deliveredOk` (preenchido na fila) olha o último envio do unifiedReply,
// e se ele falhou (ex.: anexo acima do limite do servidor, "Unknown Message") a frase "baixei e enviei o arquivo" NÃO entra no contexto.
// Os ramos que editam a mensagem direto (replyMessage.edit / interaction.editReply) só chamam esta função DEPOIS do edit, que lança se falhar.
function recordContextTurn(fallbackLine) {
    const target = currentContext();
    if (!target?.active) return false;
    if (typeof target.deliveredOk === 'function' && target.deliveredOk() === false) {
        logger.info('[Context] o envio da resposta da ferramenta falhou: troca não gravada.');
        return false;
    }
    return commitContext(target, target.line || fallbackLine);
}
// Troca principal: só depois da ENTREGA confirmada (envio falhou => nada entra). Erro da IA grava o PAR (fala + "erro da ia").
// Resposta com busca na web e texto com marcador de ferramenta não são guardados (seriam uma injeção persistida).
function recordMainExchange(processedResponse, delivery, { webSearchUsed = false, genMeta = {} } = {}) {
    const target = currentContext();
    if (!target?.active || target.committed || !target.record) return false;
    if (!delivery?.ok) return false;
    const text = String(processedResponse ?? '');
    if (isErrorReply(text)) return commitContext(target, ERROR_MARKER);
    if (webSearchUsed || genMeta?.usedSearch === true || /^-# .*🔎/m.test(text)) return false;
    if (isUnsafeForContext(text)) return false;
    return commitContext(target, historyCopy(text, { parts: delivery.parts, maxChars: 1500 }));
}
function recordErrorExchange(delivery) {
    const target = currentContext();
    if (!target?.active || target.committed || !target.record || !delivery?.ok) return false;
    return commitContext(target, ERROR_MARKER);
}
// ═══ Textos grandes: limites e pequenos helpers puros (exportados para teste) ═══════════════════════════════════════════════════════
function envInt(value, fallback, min, max) {
    const n = Number.parseInt(String(value ?? '').trim(), 10);
    return Number.isFinite(n) ? Math.min(Math.max(n, min), max) : fallback;
}

// Erro de provedor com o STATUS HTTP preservado. Os provedores que juntam várias chaves ou embrulham o erro perdiam o status, e sem ele
// não dá para separar "pedido grande demais" de cota esgotada (TG-08).
function providerError(message, cause = null, extra = {}) {
    const err = new Error(message);
    const status = Number(cause?.response?.status ?? cause?.status);
    if (Number.isFinite(status) && status > 0) err.status = status;
    return Object.assign(err, extra);
}
// Provedor que nem chegou a ser tentado (sem chave, desativado): não diz nada sobre tamanho nem sobre cota, e não conta como "tentado" no prazo.
const notConfigured = (message) => providerError(message, null, { notTried: true });
// O provedor LOCAL (LM Studio) nem respondeu (desligado, fora da rede ou sem Ack)? Isso também não diz nada sobre tamanho nem sobre cota:
// com o LM Studio fora do ar, o pedido grande demais para todas as nuvens ainda deve receber a frase de tamanho, e não a de cota (F2).
const UNREACHABLE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET', 'ETIMEDOUT', 'ECONNABORTED']);
function localUnreachable(provider, error) {
    if (provider?.func !== tryLocal || error?.response) return false;
    return error?.unreachable === true || UNREACHABLE_CODES.has(String(error?.code ?? ''));
}

/**
 * Marcadores de "isto é uma resposta de erro/aviso do SISTEMA", nunca um comentário da Yui (TG-16/C13). Inclui a frase de pedido grande
 * demais (sizeErrorText), senão ela viraria o comentário de Steam, jogo ou imagem.
 */
// Só pelo TEXTO das respostas de sistema que o generateResponse devolve ("Limites de Processamento Atingidos", o aviso de pedido grande
// demais, "SYSTEM ERROR"). Um comentário da Yui que começa com emoji ("⚡ Que preço bom!") é comentário de verdade e NÃO é descartado.
const SYSTEM_REPLY_MARKER = /SYSTEM ERROR|Limites de Processamento|erro ao processar seu pedido/i;
// Resposta que COMEÇA com emoji de erro/aviso: vale só para o texto do check_game_info (gameInfoErrorText), nunca para comentário.
const ERROR_EMOJI_START = /^[\s*_]*(?:⚠|⚡|❌|🛑|🚨)/;
function isSystemReply(text) {
    return SYSTEM_REPLY_MARKER.test(String(text ?? ''));
}

const COMMENT_MAX_CHARS = 400;
const NO_MENTIONS = Object.freeze({ parse: [] }); // o comentário da IA nunca marca ninguém
/**
 * Comentário curto da IA que vai no `content` de uma mensagem com embed (Steam, câmbio, jogo, compatibilidade, imagem): cortado em 400
 * (sem partir emoji) e sem @everyone/@here. Quem envia ainda passa `allowedMentions: NO_MENTIONS` (nenhuma menção: o texto da IA pode ter vindo de nome de jogo de terceiros). Nunca lança (TG-16).
 */
function commentText(text) {
    const s = typeof text === 'string' ? text : (typeof text === 'number' || typeof text === 'boolean' ? String(text) : '');
    return neutralizeMassMentions(clampText(s, COMMENT_MAX_CHARS));
}

const REPLY_TEXT_KEYS = ['content', 'text', 'reply', 'response', 'message', 'resposta', 'mensagem', 'answer'];
/**
 * Texto de um valor que a IA pôs no lugar da resposta da ferramenta generate_reply (que deveria ser texto): lista vira texto com espaços,
 * objeto vira o texto da primeira chave conhecida (ou os textos de seus valores). Nada utilizável => ''. Nunca lança (TG-29).
 */
function coerceReplyContent(value, depth = 0) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'string') return value;
    if (typeof value === 'number' || typeof value === 'boolean' || typeof value === 'bigint') return String(value);
    if (depth >= 3) return '';
    if (Array.isArray(value)) {
        return value.map((v) => coerceReplyContent(v, depth + 1)).filter(Boolean).join(' ').trim();
    }
    if (typeof value === 'object') {
        for (const key of REPLY_TEXT_KEYS) {
            const inner = coerceReplyContent(value[key], depth + 1);
            if (inner) return inner;
        }
        return Object.values(value).map((v) => coerceReplyContent(v, depth + 1)).filter(Boolean).join(' ').trim();
    }
    return '';
}

const THOUGHT_MAX_CHARS = 600;
const TOOL_ARG_MAX_CHARS = Object.freeze({ query: 300, game: 200, game_name: 200 });
/**
 * Corta os textos que a IA põe nos embeds de "Executando Ação": `thought` (600), `args.query` (300), `args.game` e `args.game_name` (200).
 * O `thought` do generate_reply não é cortado (nesse caso ele pode ser a própria resposta). Valor que não é texto vira texto (número) ou
 * vazio (objeto), para o embed nunca mostrar "[object Object]". Altera e devolve o próprio objeto (TG-05).
 */
function clampToolData(toolData) {
    if (!toolData || typeof toolData !== 'object') return toolData;
    const tidy = (value, max) => {
        if (typeof value === 'string') return clampText(value, max);
        if (typeof value === 'number' || typeof value === 'boolean') return String(value);
        return '';
    };
    if (toolData.thought !== undefined && toolData.thought !== null && toolData.tool !== 'generate_reply') {
        toolData.thought = tidy(toolData.thought, THOUGHT_MAX_CHARS);
    }
    const args = toolData.args;
    if (args && typeof args === 'object' && !Array.isArray(args)) {
        for (const [key, max] of Object.entries(TOOL_ARG_MAX_CHARS)) {
            if (args[key] !== undefined && args[key] !== null) args[key] = tidy(args[key], max);
        }
    }
    return toolData;
}

// Frase quando a ferramenta FALHOU depois de o JSON da IA ter sido lido (C8). Contém "erro ao processar seu pedido", que as checagens de
// resposta de erro do projeto (messageCreate e contextStore) já reconhecem: ela não vira "contexto" nem memória como se fosse resposta.
const TOOL_FAILED_TEXT = '⚠️ Não consegui concluir essa ação agora (houve um erro ao processar seu pedido). Tente de novo ou use os comandos /buscar_jogo, /baixar_musica ou /baixar_video.';

/** "título - artista" de uma faixa para frases entregues: sem crase nem quebra de linha e com corte (200 e 100). */
function musicLabel(track) {
    const title = clampText(codeSafe(track?.title), 200);
    const artist = clampText(codeSafe(track?.artist), 100);
    return artist ? `${title} - ${artist}` : title;
}

/** Frase de "download em andamento": o usuário já tem um rodando, ou o teto global de downloads simultâneos foi atingido. */
function busyMessage(userId) {
    return getBusyReason(userId) === 'global'
        ? '⏳ Há muitos downloads acontecendo ao mesmo tempo agora. Tente de novo em instantes.'
        : '⏳ Você já tem um download em andamento. Aguarde.';
}

/**
 * Limite de envio para a frase "tem X, mas o limite é Y". "10 MB" é o número que o Discord anuncia; o teto efetivo tem 5% de folga
 * (9,5 MB). Se o arquivo está entre os dois, mostra o teto efetivo, para a frase não parecer contraditória (9,6 MB contra 10 MB).
 */
function uploadLimitLabel(limitBytes, fileBytes) {
    const nominalBytes = limitLabelMB(limitBytes) * 1024 * 1024;
    return Number(fileBytes) <= nominalBytes ? formatMB(limitBytes) : formatUploadLimit(limitBytes);
}

/**
 * Veredito de envio de um vídeo baixado: cabe no limite do servidor (getUploadLimitBytes) ou precisa de compressão? Devolve os textos já
 * formatados ("12,3 MB" e "10 MB") para a frase "tem X, mas o limite deste servidor é Y". Sem guild vale a base de 10 MB (TG-02).
 */
function videoUploadVerdict(guild, fileSize) {
    const limitBytes = getUploadLimitBytes(guild);
    return { fits: Number(fileSize) <= limitBytes, limitBytes, sizeText: formatMB(fileSize), limitText: uploadLimitLabel(limitBytes, fileSize) };
}

// Frases quando o envio do ARQUIVO falhou por outro motivo que não o tamanho. Nenhuma cita a origem do arquivo.
const UPLOAD_NO_PERMISSION_TEXT = '❌ Não consegui enviar o arquivo: preciso da permissão **Anexar arquivos** neste canal.';
const UPLOAD_FAILED_TEXT = '❌ Não consegui enviar o arquivo agora. Tente de novo em instantes.';
function isMissingPermissionError(err) {
    const code = Number(err?.code ?? err?.rawError?.code);
    const status = Number(err?.status ?? err?.httpStatus);
    return code === 50013 || code === 50001 || status === 403;
}

/**
 * O envio de um ARQUIVO falhou? Então diz isso em uma frase curta, em vez de deixar a mensagem para sempre em "Executando Ação": tamanho
 * (erro 40005 / HTTP 413), falta da permissão "Anexar arquivos" (50013 / 403) ou qualquer outra falha. A entrega com falha é restaurada em
 * lastDelivery depois do aviso, para o contexto por horas NÃO gravar "baixei e enviei o arquivo". Devolve true se explicou. Nunca lança.
 */
async function explainFailedUpload(unifiedReply, sendError) {
    const failed = unifiedReply?.lastDelivery;
    if (!failed || failed.ok !== false) return false;
    const text = isUploadTooLargeError(sendError)
        ? `❌ ${MEDIA_MESSAGES.UPLOAD_TOO_LARGE}`
        : (isMissingPermissionError(sendError) ? UPLOAD_NO_PERMISSION_TEXT : UPLOAD_FAILED_TEXT);
    try { await unifiedReply(text); } catch (_) { /* sem plano C */ }
    unifiedReply.lastDelivery = failed;
    return true;
}

// Prazo total da cadeia de provedores (YUI_AI_DEADLINE_SECONDS; padrão 240 s; aceita de 0,1 a 3600). Só vale ENTRE um provedor e o próximo,
// nunca no meio de uma geração, e nunca pula o primeiro provedor que não seja o local (C4). Lido a cada chamada.
function aiDeadlineMs(env = process.env) {
    const secs = Number(String(env?.YUI_AI_DEADLINE_SECONDS ?? '').trim().replace(',', '.'));
    if (!Number.isFinite(secs) || secs <= 0) return 240_000;
    return Math.round(Math.min(Math.max(secs, 0.1), 3600) * 1000);
}

// Provedores anônimos de texto (Pollinations, Horde) não recebem pedido grande: acima de cerca de 6000 caracteres de texto do usuário
// MAIS histórico (SEM o prompt de sistema, que sozinho tem cerca de 14,5 mil) o Horde corta o início (a persona) e o conteúdo iria a um
// terceiro anônimo (D8).
const ANON_MAX_CHARS = 6000;
function anonymousTextTooBig(prompt, history) {
    const historyChars = (Array.isArray(history) ? history : []).reduce((n, h) => n + String(h?.content ?? '').length, 0);
    return String(prompt ?? '').length + historyChars > ANON_MAX_CHARS;
}

function addToHistory(channelId, role, content) {
    if (!channelId) return;
    if (contextActive()) return; // com o contexto por horas ativo o buffer do canal fica intocado
    const key = String(channelId);
    let list = conversationHistory.get(key) || [];
    conversationHistory.delete(key); // reinserir: o fio mexido por último fica no fim e o mais antigo no começo
    list.push({ role, content });
    if (list.length > MAX_HISTORY) list = list.slice(-MAX_HISTORY);
    conversationHistory.set(key, list);
    const cap = maxHistoryKeys();
    while (conversationHistory.size > cap) conversationHistory.delete(conversationHistory.keys().next().value);
}
// Buffer antigo (contexto por horas desligado ou fora do escopo) nos ramos de ferramenta: só a fala do PRÓPRIO autor, curta, e uma linha
// da Yui. Nunca o prompt inteiro (o bloco CONTEXTO traz falas de OUTRAS pessoas, que seriam reenviadas como "user" ao próximo que falar
// no canal) nem marcadores [Tool Use: ...]. Sem fala própria (ownText nulo), nada é guardado.
function addToolExchangeToHistory(channelId, ownText, assistantLine) {
    if (!ownText || !assistantLine) return;
    addToHistory(channelId, 'user', clampText(ownText, 300, { ellipsis: '' }));
    addToHistory(channelId, 'assistant', assistantLine);
}
function getHistory(channelId, { sensitive = false } = {}) {
    const target = currentContext();
    if (target?.active) return readContextTurns(target, { sensitive });
    return conversationHistory.get(String(channelId)) || [];
}
// Histórico em RAM da voz: chaves `voice:<servidor>:<pessoa>` (voiceGuards.buildVoiceKey), nunca o canal de texto. Sai junto com a fala
// do servidor (quem chama disposeGuild do TTS limpa isto também). Devolve quantos fios apagou.
function clearVoiceHistory(guildId) {
    if (!guildId) return 0;
    const prefix = `voice:${guildId}:`;
    let removed = 0;
    for (const key of [...conversationHistory.keys()]) {
        if (key.startsWith(prefix)) { conversationHistory.delete(key); removed++; }
    }
    for (const key of Object.keys(lastModelByChannel)) {
        if (key.startsWith(prefix)) delete lastModelByChannel[key];
    }
    return removed;
}
function setDiscordClient(client) {
    discordClient = client;
    // Com o contexto por horas ligado (ou com arquivos de contexto de quando esteve ligado), abre os arquivos já no início e liga a
    // limpeza horária, em vez de esperar a 1ª mensagem: a conversa vencida sai do disco mesmo se ninguém falar com a Yui.
    // Desligado e sem arquivo, não faz nada (nem cria banco).
    purgeCorruptContextFiles(); // quarentena de arquivo corrompido com mais de 48 h (mesmo com o recurso desligado; nunca lança)
    if (contextEnabled() || contextFilesExist()) {
        initContextStore().catch((err) => logger.warn(`[Context] aquecimento falhou (segue sob demanda): ${scrubLogText(err?.message, 100)}`));
    }
}
function getDiscordClient() {
    return discordClient;
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
// Nomes de ferramenta que o modelo pode "vazar" como texto. Só estes (ou um marcador explícito tool_code/default_api.)
// são apagados da resposta: "Mod(1.20)" e "Ovos(12 unidades)" são texto normal.
const EXTRA_TOOL_NAMES = new Set([
    'generate_reply', 'gerar_resposta', 'default_api', 'get_help', 'search_and_download_music', 'get_current_music',
    'check_game_info', 'check_pc_compatibility', 'search_game', 'search_web', 'download_audio', 'download_video',
    'generate_image', 'check_steam', 'convert_currency', 'show_bot_menu', 'ia_automod', 'join_voice_call', 'leave_voice_call'
]);
function isKnownToolName(name) {
    const n = String(name ?? '');
    if (!n) return false;
    if (EXTRA_TOOL_NAMES.has(n.toLowerCase()) || /^radio_/i.test(n)) return true;
    return ALL_MCP_TOOLS.some(t => t?.function?.name === n);
}
function isToolCallText(fullMatch, name) {
    return isKnownToolName(name) || /tool_code|default_api\./i.test(String(fullMatch ?? ''));
}
// Tira os blocos <think>...</think> (e um <think> sem fechamento, até o fim do texto) numa passagem só. O par de expressões antigo varria o texto inteiro a
// partir de CADA "<think>": uma saída degenerada de 100 mil caracteres com "<think>" repetido custava mais de 1 s e parava o laço de eventos (resíduo F1).
// Mesmo resultado de antes: um bloco vai da PRIMEIRA abertura pendente até o primeiro "</think>" depois dela; "</think>" sem abertura fica como está.
function removeThinkBlocks(text) {
    const tag = /<(\/?)think>/gi;
    let out = '';
    let last = 0;
    let openAt = -1;
    let m;
    while ((m = tag.exec(text)) !== null) {
        if (m[1] === '') {
            if (openAt === -1) openAt = m.index;
        } else if (openAt !== -1) {
            out += text.slice(last, openAt);
            last = m.index + m[0].length;
            openAt = -1;
        }
    }
    if (openAt !== -1) { out += text.slice(last, openAt); last = text.length; }
    return out + text.slice(last);
}
// A heurística "Thought: ... Response: ..." (expressões sem âncora) só vale para respostas curtas: numa saída degenerada de dezenas de milhares de caracteres
// ("thought: (((((...") ela custava vários segundos. Um texto maior que isto segue sem essa limpeza.
const THINK_LABEL_SCAN_MAX = 12000;
function stripThinking(text) {
    if (!text) return text;
    text = removeThinkBlocks(text);
    text = text.replace(/<ctrl\d+>[\s\S]*?(?=\n\n|$)/gi, '');
    text = text.replace(/<ctrl\d+>/gi, '');
    const jsonResponseKeys = ['response', 'reply', 'content', 'answer', 'text', 'resposta', 'mensagem', 'message'];
    const trimmed = text.trim();
    if (trimmed.startsWith('{') && trimmed.endsWith('}')) {
        try {
            const parsed = JSON.parse(trimmed);
            if (parsed.generate_reply) {
                if (typeof parsed.generate_reply === 'string') return parsed.generate_reply.trim();
                if (typeof parsed.generate_reply === 'object' && parsed.generate_reply.content) return parsed.generate_reply.content.trim();
            }
            if (parsed.tool === 'generate_reply' || parsed.name === 'generate_reply' || parsed.action === 'generate_reply') {
                const c = parsed.args?.content || parsed.args?.text || parsed.arguments?.content || parsed.action_input?.content || parsed.content || parsed.text;
                if (c && typeof c === 'string') return c.trim();
            }
            if (!parsed.tool && !parsed.thought) {
                for (const key of jsonResponseKeys) {
                    if (parsed[key] && typeof parsed[key] === 'string') {
                        return parsed[key].trim();
                    }
                }
            }
        } catch (e) {}
    }
    let cleanVal = text.trim();
    const genReplyRegex = /(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(?:generate_reply|gerar_resposta|gerar\s+resposta)(?:\(|\s+)+(?:content=)?(['"]{1,3})([\s\S]*?)\1\)?\)?(?:[\s\n]*```)?/i;
    const matchGenReply = cleanVal.match(genReplyRegex);
    if (matchGenReply) {
        return matchGenReply[2].trim();
    }
    const prefixRegex = /^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(?:generate_reply|gerar_resposta|gerar\s+resposta)(?:\(|\s+)+(?:content=)?(['"]{1,3})/i;
    const prefixMatch = cleanVal.match(prefixRegex);
    if (prefixMatch) {
        const quoteChar = prefixMatch[1];
        cleanVal = cleanVal.replace(prefixRegex, '');
        const escapedQuote = quoteChar.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
        const suffixRegex = new RegExp(escapedQuote + '\\)?\\)?(?:\\s*```)?$', 'i');
        cleanVal = cleanVal.replace(suffixRegex, '');
        return cleanVal.trim();
    }
    // O nome da ferramenta tem no máximo 64 caracteres (\w{1,64}, não \w+): com \w+ uma resposta de UMA palavra só e longa (loop degenerado
    // "aaaa...") custava O(n²) e parava o laço de eventos (100 mil caracteres = 5 s). Nenhuma ferramenta tem nome com mais de 64.
    const toolCodeGeneric = text.match(/^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(\w{1,64})\(([^]*?)\)\)?(?:[\s\n]*```)?$/i);
    if (toolCodeGeneric && isToolCallText(toolCodeGeneric[0], toolCodeGeneric[1])) {
        return '';
    }
    // O padrão exige um ")" depois de cada "nome(": sem nenhum, não há o que apagar. Cada candidato varre até o primeiro ")" seguinte, então só o trecho até o
    // ÚLTIMO ")" (mais a cerca de código que pode fechá-lo) é examinado: ")" seguido de "a(" repetido (100 mil caracteres) custava 1,9 s, porque cada "a("
    // percorria o texto inteiro atrás de um ")" que não existia. Daí em diante a varredura é linear.
    const lastParen = text.lastIndexOf(')');
    if (lastParen !== -1) {
        const scanEnd = Math.min(text.length, lastParen + 1 + 16);
        text = text.slice(0, scanEnd).replace(/(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(\w{1,64})\([^]*?\)\)?(?:[\s\n]*```)?/gi, (full, name) => (isToolCallText(full, name) ? '' : full)) + text.slice(scanEnd);
    }
    const mcpToolNames = ['search_game', 'search_web', 'generate_reply', 'download_audio', 'download_video', 'generate_image', 'check_steam', 'convert_currency', 'show_bot_menu', 'ia_automod', 'join_voice_call', 'leave_voice_call', 'default_api'];
    const toolMentionRegex = new RegExp('(?:`?' + mcpToolNames.join('`?|`?') + '`?)', 'i');
    const thinkingIndicators = /(?:usar a ferramenta|chamar a ferramenta|a resposta deve ser|a ferramenta mais adequada|o melhor seria usar|preciso (?:saber|analisar|verificar)|vou (?:usar|chamar)|devo (?:usar|chamar))\b/i;
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
        console.warn('[StripThinking] Não foi possível isolar raciocínio MCP. Mantendo resposta original.');
    }
    let clean = text.trim();
    if (clean.length <= THINK_LABEL_SCAN_MAX && /^[\(\[\*]*\s*(?:thought|thinking|pensamento|pensamentos|thinking\s+process|racioc[íi]nio|plan|planejamento)s?[\*\)\]]*\s*:?/i.test(clean)) {
        const labelMatch = clean.match(/[\(\[\*]*\s*(?:response|reply|resposta|fala|yui|output|text|speech|final\s+speech)\s*[\*\)\]]*\s*:\s*([\s\S]+)$/i);
        if (labelMatch) {
            clean = labelMatch[1].replace(/^[\(\[\*]*\s*(?:fala|resposta|yui|speech)\s*[\*\)\]]*\s*:\s*/i, '').trim();
        } else {
            const lines = clean.split('\n').map(l => l.trim()).filter(l => l.length > 0);
            if (lines.length > 1) {
                let lastLine = lines[lines.length - 1];
                lastLine = lastLine.replace(/^(?:looks good|lgtm|perfect|done|all set)[\.!\s]*/i, '');
                lastLine = lastLine.replace(/^(?:let's go with|going with|using)\s+[^.]+[\.!\s]*/i, '');
                const concatMatch = lastLine.match(/^(?:i'll|i will|i should|i need to|let's|so i'll|therefore|i must)\s+[\s\S]+?[\.!\?]\s*([A-Z\u00C0-\u00DC\d].*)$/i);
                if (concatMatch) {
                    clean = concatMatch[1].trim();
                } else {
                    clean = lastLine.replace(/^[\(\[\*]*\s*(?:fala|resposta|yui|speech)\s*[\*\)\]]*\s*:\s*/i, '').trim();
                }
            }
        }
    }
    clean = clean.replace(/^[\(\[\*]*\s*(?:gerar\s*resposta|gerar_resposta|resposta|fala|yui|output|text|speech)\s*[\*\)\]]*\s*:\s*/i, '').trim();
    const quotedMatch = clean.match(/^(['"]{1,3})([\s\S]+?)\1/);
    if (quotedMatch) {
        clean = quotedMatch[2].trim();
    }
    return clean;
}

import { checkBan, addBan, removeBan, getBans, checkAutoBan, getAutoBlock, getAutoBlockMode, forbiddenKeywords } from './banHandler.js';
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
                { name: '💬 Prompt do Usuário', value: `\`\`\`${clampText(prompt, 800)}\`\`\`` },
                { name: '🤖 Resposta da IA', value: `\`\`\`${clampText(aiResponse, 800)}\`\`\`` }
            ],
            footer: { text: 'Yui Security System' }
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
            { name: '💬 Prompt do Usuário', value: `\`\`\`${clampText(prompt || "N/A", 800)}\`\`\`` }
        ],
        footer: { text: 'Yui Monitoring System' }
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
// Voz: nada vai para o historico.txt (a transcrição é fala de terceiros), mas a moderação de conteúdo suspeito segue valendo.
function moderateVoiceExchange(prompt, userTag, userId, aiResponse, interaction) {
    Promise.resolve(checkAndReportNSFW(prompt, userTag, userId, aiResponse, interaction)).catch(() => {});
}
function savePromptToHistoryOnDisk(prompt, userTag, userId, aiResponse, interaction) {
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
/**
 * Resultados da cadeia de busca (Tavily, Brave, SearXNG, DuckDuckGo, Bing) + leitura das melhores páginas.
 * A leitura de páginas usa o fetchPageContent do searchManager (safeFetch: sem SSRF, com limite de bytes e prazo total).
 * Tudo que sai daqui é texto da web = DADO NÃO CONFIÁVEL (quem chama cerca com buildSearchToolPrompt).
 */
async function buildSearchContext(found) {
    const quick = found.results.filter(r => r.url === '#quick-answer').map(r => `[DESTAQUE/RESPOSTA RÁPIDA]: ${r.snippet}`);
    const results = found.results.filter(r => r.url !== '#quick-answer');
    if (!results.length && !quick.length) return null;
    const basicSummary = [...quick, ...results.map(r => `Título: ${r.title}\nResumo: ${r.snippet}\nLink: ${r.url}`)].join('\n---\n');
    const linksToRead = results
        .map(r => r.url)
        .filter(url => /^https?:/.test(url) && !url.includes('youtube.com') && !isBlacklisted(url))
        .filter(url => {
            try {
                const p = new URL(url).pathname;
                return !(p === '/' || p.length < 3 || p.includes('/search') || p.includes('/login') || p.includes('/tag/'));
            } catch (e) { return false; }
        })
        .slice(0, 3);
    let finalContext = `[RESUMO GERAL DOS RESULTADOS]:\n${basicSummary}\n`;
    if (linksToRead.length) {
        logger.info(`[Search] leitura profunda de ${linksToRead.length} página(s) em paralelo`);
        const pageContents = await Promise.all(linksToRead.map(url => fetchPageContent(url, { maxChars: 1200 })));
        finalContext += '\n=== CONTEÚDO DETALHADO (Extraído das páginas) ===\n';
        pageContents.forEach((content, i) => {
            if (content && content.length > 200) {
                finalContext += `\n[FONTE DEEP: ${linksToRead[i]}]:\n${content}\n----------------\n`;
            }
        });
    }
    return finalContext + `\n\n-# Fonte: ${found.provider}`;
}
/**
 * Pesquisa da ferramenta search_web. Devolve { context, status, message }:
 *  status 'ok' (context preenchido), 'sensitive' (conversa privada: não pesquisa), 'limited' (limite por usuário) ou 'none'.
 * Passa userId (limite por usuário) e sensitive até o searchWeb; a consulta nunca vai para o log.
 */
async function performWebSearch(query, { userId = null, sensitive = false } = {}) {
    const gate = webSearchGate({ sensitive });
    if (!gate.allowed) return { context: null, status: 'sensitive', message: gate.message };
    logger.info(`[Search] ferramenta search_web (consulta com ${String(query ?? '').length} caracteres)`);
    const found = await searchWeb(query, { max: 5, userId, sensitive });
    const context = found.results.length ? await buildSearchContext(found) : null;
    return { context, ...describeSearchOutcome(found, { hasContext: Boolean(context) }) };
}
// ── Agente de pesquisa (researchAgent.js + searchIntent.js) ──────────────────────────────────────────────────────────────────────────
// O CÓDIGO, e não o modelo, é dono do laço "consulta -> buscadores -> leitura de páginas -> síntese" e da entrega: todo pedido de pesquisa termina
// em resposta sintetizada, resumo com links ou mensagem com o motivo; nunca em "vou pesquisar" parado. As chaves são lidas a cada uso (nunca no
// import): YUI_RESEARCH_ENABLED (mestra: false mantém o ramo ANTIGO de search_web), YUI_RESEARCH_GUARD (on | observe | off), YUI_RESEARCH_PRE_ROUTE,
// YUI_PRIVATE_SEARCH (off | owner | all) e as YUI_RESEARCH_* de prazo, passos e páginas.
const researchUserGuard = createUserGuard(); // uma pesquisa por pessoa por vez (o /yui, que roda fora da fila, usa a mesma trava)
const researchConfigNow = () => readResearchConfig();
const RESEARCH_FAILED_TEXT = 'Deu um problema aqui na pesquisa. Tente de novo em instantes.';
// O modelo chamou search_web numa conversa espontânea e nem a nova resposta serviu: nada de pesquisa (nem cota) para quem não chamou a Yui.
const SPONTANEOUS_NO_SEARCH_TEXT = 'Eu só pesquiso na web quando alguém me chama de verdade. Me menciona com o pedido que eu pesquiso.';

/**
 * Liga o agente aos buscadores (searchForAgent), à leitura de páginas (safeFetch) e ao generateResponse. NUNCA lança; o texto devolvido nunca é vazio.
 *  - `question`: SÓ a fala do próprio autor (options.searchPrompt), nunca o bloco CONTEXTO com falas de outras pessoas;
 *  - `query` e `intent`: a consulta e a promessa do modelo (ignoradas na pesquisa PRIVADA);
 *  - `sensitive`: conversa privada (DM/canal privado do dono, app). Só pesquisa se o YUI_PRIVATE_SEARCH liberar este usuário; aí valem as proteções do
 *    modo privado: pedido explícito, consulta SÓ do texto literal da mensagem, scrubQuery e palavras proibidas, síntese com sensitive:true (nunca
 *    provedor anônimo), sem histórico nem memória, e log sem a consulta. `isOwner` (padrão: o dono configurado) só importa no modo "owner";
 *  - a síntese roda SEM ferramentas, SEM busca, SEM histórico e SEM memória: recebe só a pergunta e a evidência cercada como dado não confiável.
 * Devolve { kind: 'answer'|'summary'|'refused'|'failed', text, private, historyLine, usedSearch, sources, stats, ... } (ver runResearch).
 */
async function runResearchFor({ question = '', query = '', intent = '', userId = null, sensitive = false, isOwner, channelId = null, guildId = null, disabled, progress = null, deadlineMs, userGuard = researchUserGuard } = {}) {
    const cfg = researchConfigNow();
    const privateMode = sensitive === true && privateSearchAllowed(cfg.privateSearch, { isOwner: isOwner === undefined ? isOwnerId(userId) : isOwner === true });
    try {
        return await runResearch(
            {
                question, query, intent, userId,
                sensitive: sensitive === true,
                privateSearch: privateMode,
                disabled: disabled === undefined ? isToolDisabled(guildId, 'search_web') : disabled === true,
                deadlineMs,
                config: { totalDeadlineMs: cfg.totalDeadlineMs, maxSteps: cfg.maxSteps, maxPages: cfg.maxPages, chargeRefinements: cfg.chargeRefinements, showSources: cfg.showSources }
            },
            {
                // searchForAgent: sensitive é sempre false (o agente já aplicou as regras do privado) e o teto GLOBAL por hora volta como limited:'global'.
                search: (q, o) => searchForAgent(q, { ...(o?.max ? { max: o.max } : {}), userId: o?.userId ?? null, signal: o?.signal ?? null }),
                // `private` (modo privado): a leitura não registra nem o host da página no log (o host denuncia o assunto de uma pesquisa privada).
                readPage: (url, o) => fetchPageContent(url, { ...(o?.maxChars ? { maxChars: o.maxChars } : {}), ...(o?.totalDeadlineMs ? { totalDeadlineMs: o.totalDeadlineMs } : {}), ...(o?.signal ? { signal: o.signal } : {}), ...(o?.private ? { quiet: true } : {}) }),
                // Sem ferramentas, sem busca, SEM histórico (noHistory) e sem memória. No modo privado nem o canal entra (nada de persona de canal).
                synthesize: (prompt, o) => generateResponse(prompt, privateMode ? null : channelId, {
                    allowSearch: false, disableTools: true, noHistory: true, guildId: privateMode ? null : guildId, userId,
                    sensitive: o?.sensitive === true, deadlineAt: o?.deadlineAt
                }),
                forbiddenKeywords,
                isBlacklisted,
                onProgress: progress,
                userGuard,
                log: (level, message) => { try { logger[level]?.(message); } catch (_) { /* o log nunca derruba a pesquisa */ } }
            }
        );
    } catch (err) {
        logger.error(`[Pesquisa] falha inesperada no adaptador: ${scrubLogText(err?.message, 120)}`);
        return {
            ok: false, kind: 'failed', text: RESEARCH_FAILED_TEXT, sources: [], usedSearch: true, private: privateMode, query: '',
            historyLine: privateMode ? 'Tentei pesquisar na web a pedido do usuário (conversa privada), mas não deu certo agora.' : 'Tentei pesquisar, mas não deu certo agora.',
            stats: {}, trace: []
        };
    }
}

/**
 * A mensagem foi dirigida à Yui (menção, o nome dela, resposta a ela, DM, comando de barra ou app)? Conversa espontânea (chatter) NUNCA dispara pesquisa
 * sozinha nem gasta a cota de quem só falou no canal. Mesmo critério do contexto por horas (contextTargetFor). Nunca lança.
 */
function isDirectToYui(interaction, type, options = null) {
    if (options?.chatter === true) return false;
    const guildId = interaction?.guild?.id || interaction?.guildId;
    if (type !== 'mention' || !guildId) return true;
    try {
        const bot = interaction?.client?.user || getDiscordClient()?.user || null;
        if (bot && interaction.mentions?.has?.(bot, { ignoreEveryone: true })) return true;
        if (getServerSettings(guildId)?.respondToEveryone && interaction?.mentions?.everyone) return true;
        if (bot?.id && interaction?.mentions?.repliedUser?.id === bot.id) return true;
        const botName = String(config.botName || 'Yui').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`\\b${botName}\\b`, 'i').test(String(interaction?.content ?? ''));
    } catch (_) {
        return false;
    }
}

// Pesquisa tentada e que NÃO deu certo na busca automática do generateResponse (/yui): o modelo recebe o aviso e não promete pesquisar (D1, D2).
// Só os motivos de "tentou e falhou"; "não era para pesquisar" (no_trigger, otimizador, sensível) não geram aviso.
const SEARCH_FAILURE_NOTES = Object.freeze({
    user_limited: 'o limite de pesquisas por hora deste usuário foi atingido',
    global_limited: 'o limite de pesquisas desta hora foi atingido',
    deadline: 'o buscador demorou demais',
    no_providers: 'não há buscador configurado',
    providers_rest: 'os buscadores estão em descanso ou sem cota',
    providers_error: 'os buscadores deram erro',
    no_results: 'não achou nada',
    filtered: 'os resultados achados não serviram',
    no_content: 'os resultados vieram sem conteúdo',
    error: 'houve um erro na pesquisa',
    sensitive_data: 'a consulta tinha dado pessoal ou segredo',
    forbidden: 'a consulta tinha palavra proibida'
});
function searchFailureNote(reason) {
    const why = Object.hasOwn(SEARCH_FAILURE_NOTES, reason) ? SEARCH_FAILURE_NOTES[reason] : '';
    if (!why) return '';
    return `[AVISO DO SISTEMA: a pesquisa na web foi tentada agora e NÃO deu certo (${why}). Não diga que vai pesquisar, verificar ou voltar depois: você não consegue mandar nada depois. Responda com o que você já sabe e avise, em uma frase, que não conseguiu pesquisar agora.]`;
}

/** Resposta de texto para a cotação (a promessa "vou ver o dólar" vira a conversão de verdade, sem embed). Nunca lança. */
async function currencyAnswerText(args) {
    try {
        const info = await convertCurrency(args?.amount, args?.from, args?.to);
        if (!info || info.error) return String(info?.error || 'Não consegui consultar a cotação agora. Tente de novo em instantes.');
        const amount = Number(info.amount).toLocaleString('pt-BR');
        const result = Number(info.result).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        const rate = Number(info.rate).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 4 });
        return `${amount} ${info.from} equivale a ${result} ${info.to} (1 ${info.from} = ${rate} ${info.to}).`;
    } catch (err) {
        logger.warn(`[Pesquisa] cotação falhou: ${scrubLogText(err?.message, 100)}`);
        return 'Não consegui consultar a cotação agora. Tente de novo em instantes.';
    }
}

// ── Chamada de ferramenta escrita como TEXTO ────────────────────────────────────────────────────────────────────────────────────────
// Limite do que as expressões sobre a resposta CRUA do modelo examinam: uma saída degenerada de 40 a 100 mil caracteres custava mais de 1 s nas
// expressões com varredura preguiçosa até o fim do texto (resíduo F1). Uma chamada de ferramenta escrita como texto é curta.
const TOOLCALL_SCAN_MAX = 12000;
const CALL_KWARG_RE = /([A-Za-z_][A-Za-z0-9_]{0,30})\s*=\s*(?:"((?:[^"\\]|\\.){0,2000})"|'((?:[^'\\]|\\.){0,2000})'|([^\s,)]{1,200}))/g;
const CALL_KWARG_SKIP = new Set(['__proto__', 'constructor', 'prototype']);
// O texto COMEÇA com "print(" (depois de cerca de código, "python" ou "tool_code" opcionais): a resposta inteira é uma chamada escrita.
const WRITTEN_CALL_START = /^(?:<ctrl\d+>[\s\S]{0,200}?)?[`\s]*(?:python\s*)?(?:tool_code\s*)?[`\s]*print\(/i;
/** `query="x", max=3` (argumentos nomeados, estilo Python) -> { query: 'x', max: '3' }. No máximo 12 pares; textos cortados. */
function parseCallKwargs(rawArgs) {
    const out = {};
    let n = 0;
    for (const m of String(rawArgs ?? '').slice(0, TOOLCALL_SCAN_MAX).matchAll(CALL_KWARG_RE)) {
        if (n++ >= 12) break;
        if (CALL_KWARG_SKIP.has(m[1])) continue;
        out[m[1]] = String(m[2] ?? m[3] ?? m[4] ?? '').replace(/\\(["'\\])/g, '$1');
    }
    return out;
}
/**
 * `print(default_api.search_web(query="x"))`, `default_api.generate_reply(content="oi")`, `tool_code` e variantes (com ou sem cerca de código) viram o
 * JSON {thought, tool, args} que o despachante entende. null quando o texto não é uma chamada escrita (ou passa de TOOLCALL_SCAN_MAX caracteres).
 * É a conversão que o despachante já fazia, agora também ANTES do stripThinking (que apagava a chamada, dava o provedor por falho e deixava só a
 * cerca ```), e com a entrada limitada (resíduo F1). Texto depois de um bloco </think> é o que vale.
 */
function writtenToolCallToJson(text) {
    let raw = typeof text === 'string' ? text : '';
    if (raw.includes('</think>')) raw = raw.slice(raw.lastIndexOf('</think>') + 8);
    raw = raw.trim();
    if (!raw || raw.length > TOOLCALL_SCAN_MAX) return null;
    const m = raw.match(/(?:<ctrl\d+>[\s\S]*?)?(?:print\(|default_api\.)\(?(\w+)(?:\(|\s+)+([^]*?)\)?$/i) ||
              raw.match(/(?:<ctrl\d+>[\s\S]*?)?\(?(generate_reply)(?:\(|\s+)+([^]*?)\)?$/i) ||
              raw.match(/(?:<ctrl\d+>[\s\S]*?)?\(?(\w{1,64})\(([^]*?)\)\)?$/i); // \w{1,64}: com \w+ uma palavra longa sem espaços era O(n²)
    if (!m) return null;
    // Chaves no texto: só vale a chamada de uma ferramenta CONHECIDA com um objeto JSON de argumentos entre parênteses (default_api.search_web({"query": "x"})) e sem "{"
    // antes dela. Um JSON solto ({"tool": ...}) continua sendo do despachante, não desta conversão.
    if (raw.includes('{')) {
        const knownName = isKnownToolName(m[1]) || canonicalToolName(m[1]) !== m[1];
        if (!knownName || !String(m[2] ?? '').trim().startsWith('{') || raw.slice(0, m.index).includes('{')) return null;
    }
    // Nome conhecido (ou apelido de search_web: web_search, google_search...), ou o marcador de código do modelo. "print(" só vale no COMEÇO do texto: uma resposta
    // normal que explica código ("Exemplo: print(soma(1,2))") não pode virar uma ferramenta inventada.
    if (!(isKnownToolName(m[1]) || canonicalToolName(m[1]) !== m[1] || WRITTEN_CALL_START.test(raw) || /default_api\.|tool_code/i.test(raw))) return null;
    const tool = m[1];
    let rawArgs = m[2].trim();
    // print(default_api.search_web({"query": "x"})): o ")" do print fica na cauda dos argumentos; o objeto JSON termina na última "}"
    if (rawArgs.startsWith('{')) rawArgs = rawArgs.replace(/\}[\s)]*$/, '}');
    let args = {};
    if (rawArgs.startsWith('{') && rawArgs.endsWith('}')) {
        try { args = JSON.parse(rawArgs); } catch (e) { args = {}; }
    } else if (tool === 'generate_reply') {
        const strMatch = rawArgs.match(/^(?:content=)?(['"]{1,3})([\s\S]*?)\1\)?$/i);
        if (strMatch) {
            args = { content: strMatch[2] };
        } else {
            let cleanArgs = rawArgs.replace(/^(?:content=)?(['"]{1,3})/i, '');
            cleanArgs = cleanArgs.replace(/(['"]{1,3})\)?$/i, '');
            args = { content: cleanArgs };
        }
    } else if (/^[A-Za-z_]\w*\s*=/.test(rawArgs)) {
        args = parseCallKwargs(rawArgs); // search_web(query="x")
    } else if (canonicalToolName(tool) === 'search_web') {
        const q = rawArgs.match(/^(['"]{1,3})([\s\S]*?)\1\)?$/);
        if (q) args = { query: q[2] };
    }
    return JSON.stringify({ thought: 'Executando ação ' + tool, tool, args });
}

// Chamada de ferramenta `generate_reply` (modo de ferramentas): devolve o TEXTO da resposta e se ela foi cortada pelo
// limite de tokens, como o ramo de texto puro, para a continuação e o aviso de corte valerem também aqui. Se o JSON dos
// argumentos veio cortado, recupera o `content` parcial. null = não é generate_reply ou não há texto aproveitável
// (o chamador segue com o JSON da ferramenta, como sempre).
function replyFromToolCall(name, argumentsText, finishReason, modelName) {
    if (name !== 'generate_reply') return null;
    const rec = recoverReplyContent(argumentsText);
    if (!rec.content.trim()) return null;
    const cut = isTruncatedFinish(finishReason);
    return { text: rec.content, modelName, truncated: rec.parsed ? cut : cut && !rec.complete, finishReason: finishReason ?? null };
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
        const rawTools = options.radioMCPTools || buildToolsPayload(options.guildId || null, options.userId || null, { sensitive: options.sensitive === true || options.privateChat === true, chatter: options.chatter === true });
        payload.tools = sanitizeToolsForApi(rawTools);
    }
    const cancelSource = axios.CancelToken.source();
    let activeTimer = null;
    let streamRef = null; // o stream aberto: o prazo da pesquisa (options.deadlineAt) precisa conseguir cortá-lo (P9)
    const generation = new Promise(async (resolve, reject) => {
        activeTimer = setTimeout(() => {
            cancelSource.cancel('Timeout de Conexão/Ack');
            reject(Object.assign(new Error(`LM Studio não respondeu o Ack em ${connectionTimeout}ms`), { unreachable: true }));
        }, connectionTimeout);
        try {
            const response = await axios.post(config.localLlmUrl, payload, {
                headers,
                responseType: 'stream',
                cancelToken: cancelSource.token,
                timeout: 0
            });
            const stream = response.data;
            streamRef = stream;
            let collectedContent = '';
            let collectedToolCalls = {};
            let finalModelName = config.localLlmModel;
            let finishReason = null;
            let ackReceived = false;
            // As linhas do SSE ("data: {...}") chegam em pedaços de rede que podem terminar no meio de uma linha ou de um caractere de
            // 2 bytes (ç, ã, emoji). Os bytes passam por um decodificador UTF-8 e a sobra sem quebra espera o pedaço seguinte; no fim do
            // fluxo flush() entrega a última linha que ficou sem quebra (TG-11). Antes o pedaço partido sumia em silêncio.
            const splitter = createLineSplitter();
            let unreadableLines = 0;
            const handleLine = (line) => {
                const trimmed = line.trim();
                if (!trimmed) return;
                const dataText = sseDataOf(trimmed);
                if (dataText === '[DONE]') return;
                if (!ackReceived) {
                    ackReceived = true;
                    if (activeTimer) clearTimeout(activeTimer);
                    logger.info('[LM Studio] Ack recebido: timeout estendido para 180s.');
                    activeTimer = setTimeout(() => {
                        cancelSource.cancel('Timeout de Geração');
                        stream.destroy();
                        reject(new Error('LM Studio estourou o limite de 3 minutos na geração.'));
                    }, processingTimeout);
                }
                if (dataText === null) return; // comentário, keep-alive ou outro campo do SSE
                try {
                    const data = JSON.parse(dataText);
                    if (data.model) finalModelName = data.model;
                    if (data.choices && data.choices.length > 0) {
                        // O chunk final traz o finish_reason ('length' = cortada pelo limite de tokens).
                        if (data.choices[0].finish_reason) finishReason = data.choices[0].finish_reason;
                        const delta = data.choices[0].delta || {};
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
                    unreadableLines++; // linha que não é JSON: contada e avisada no fim, sem o conteúdo
                }
            };
            stream.on('data', (chunk) => {
                for (const line of splitter.push(chunk)) handleLine(line);
            });
            stream.on('end', () => {
                for (const line of splitter.flush()) handleLine(line); // a última linha, se o fluxo terminou sem quebra
                if (activeTimer) clearTimeout(activeTimer);
                if (unreadableLines > 0) logger.warn(`[LM Studio] ${unreadableLines} linha(s) do stream não eram JSON válido (ignoradas).`);
                const toolKeys = Object.keys(collectedToolCalls);
                if (useMcp && toolKeys.length > 0) {
                    const firstTool = collectedToolCalls[toolKeys[0]];
                    console.log(`[MCP 2.0] Tool Finalizada (Stream): ${firstTool.name}`);
                    const asReply = replyFromToolCall(firstTool.name, firstTool.arguments, finishReason, `Modelo: ${finalModelName} (Stream)`);
                    if (asReply) {
                        resolve(asReply);
                        return;
                    }
                    let args = {};
                    try {
                        args = JSON.parse(firstTool.arguments);
                    } catch (e) {
                        logger.warn(`[MCP] Argumentos da ferramenta com JSON inválido (${firstTool.name}, finish=${finishReason ?? 'n/d'})`);
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
                        modelName: `Modelo: ${finalModelName} (Stream)`,
                        truncated: isTruncatedFinish(finishReason),
                        finishReason
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
                // Resposta de erro HTTP pedida como stream: lê a mensagem ("context length exceeded"...) para o pedido grande demais não
                // virar cota esgotada (F2). Com prazo curto; nunca lança.
                await drainErrorBody(error);
                reject(error);
            }
        }
    });
    // Prazo da pesquisa (P9): sem isto o Promise.race do agente abandonava a síntese, mas o LM Studio seguia gerando por até 180 s e disputava a
    // placa com o item seguinte da fila. Com `options.deadlineAt` o prazo cancela a requisição e destrói o stream.
    const limit = Number(options.deadlineAt);
    if (!Number.isFinite(limit)) return generation;
    let deadlineTimer = null;
    const deadline = new Promise((_, reject) => {
        deadlineTimer = setTimeout(() => {
            if (activeTimer) clearTimeout(activeTimer);
            cancelSource.cancel('Prazo da pesquisa');
            try { streamRef?.destroy(); } catch (_) { /* já fechado */ }
            reject(Object.assign(new Error('Prazo da pesquisa esgotado no provedor local.'), { code: 'TIMEOUT', deadline: true }));
        }, Math.max(1, limit - Date.now()));
    });
    return Promise.race([generation, deadline]).finally(() => clearTimeout(deadlineTimer));
}
async function tryGemini(prompt, systemPrompt, options = {}) {
    console.log(`[IA] 2/5 Tentando Google Gemini...`);
    const apiKeys = config.geminiApiKeys;
    if (apiKeys.length === 0) throw notConfigured('Nenhuma chave Gemini configurada.');
    const modelsToTry = [config.geminiModel];
    if (config.geminiModelFallback && config.geminiModelFallback !== config.geminiModel) {
        modelsToTry.push(config.geminiModelFallback);
    }
    let lastError = null;
    let lastStatus = null; // status HTTP da última falha com resposta
    let sizeFails = 0;     // falhas por tamanho do pedido (413, ou 400 de contexto)
    let otherFails = 0;    // todas as outras (cota, rede, formato)
    for (const modelName of modelsToTry) {
        for (let i = 0; i < apiKeys.length; i++) {
            const currentKey = apiKeys[i];
            if (geminiCooldowns[currentKey] && geminiCooldowns[currentKey][modelName] && Date.now() < geminiCooldowns[currentKey][modelName]) {
                console.log(`[Gemini] Ignorando chave ${i + 1}/${apiKeys.length} para o modelo ${modelName} (cooldown ativo).`);
                continue; // chave em cooldown não foi tentada: não diz nada sobre o tamanho do pedido (F2)
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
                    const rawTools = options.radioMCPTools || buildToolsPayload(options.guildId || null, options.userId || null, { sensitive: options.sensitive === true || options.privateChat === true, chatter: options.chatter === true });
                    payload.tools = sanitizeToolsForApi(rawTools);
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
                        const asReply = replyFromToolCall(firstTool.name, firstTool.arguments, choice.finish_reason, 'Gemini');
                        if (asReply) return asReply;
                        let args = {};
                        try {
                            args = JSON.parse(firstTool.arguments);
                        } catch (e) {
                            logger.warn(`[Gemini MCP] Argumentos da ferramenta com JSON inválido (${firstTool.name}, finish=${choice.finish_reason ?? 'n/d'})`);
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
                        const genReplyMatch = cleanVal.match(/(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?generate_reply(?:\(|\s+)+(?:content=)?(['"]{1,3})([\s\S]*?)\1/i);
                        if (genReplyMatch) {
                            content = genReplyMatch[2].trim();
                        } else {
                            const prefixRegex = /^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?generate_reply(?:\(|\s+)+(?:content=)?(['"]{1,3})/i;
                            const prefixMatch = cleanVal.match(prefixRegex);
                            if (prefixMatch) {
                                const quoteChar = prefixMatch[1];
                                cleanVal = cleanVal.replace(prefixRegex, '');
                                const escapedQuote = quoteChar.replace(/[-\/\\^$*+?.()|[\]{}]/g, '\\$&');
                                const suffixRegex = new RegExp(escapedQuote + '\\)?\\)?(?:\\s*```)?$', 'i');
                                cleanVal = cleanVal.replace(suffixRegex, '');
                                content = cleanVal.trim();
                            } else if (/^(?:tool_code[\s\n]*)?(?:```(?:python)?[\s\n]*)?(?:print\()?\(?(?:default_api\.)?(\w+)\(/i.test(cleanVal) || /tool_code[\s\n]*(?:```)?/i.test(content)) {
                                // A chamada escrita é a de uma PESQUISA (search_web ou apelido: web_search, google_search...)? Não é lixo: o generateResponse a converte no JSON da
                                // ferramenta (F4) e o despachante executa. Qualquer outra chamada escrita como texto segue sendo formato inválido (o próximo provedor responde).
                                const writtenSearch = options.disableTools ? null : writtenToolCallToJson(content);
                                let isSearchCall = false;
                                try { isSearchCall = Boolean(writtenSearch) && canonicalToolName(JSON.parse(writtenSearch).tool) === 'search_web'; } catch (_) { isSearchCall = false; }
                                if (!isSearchCall) throw new Error('Gemini retornou tool_code como texto (formato inválido)');
                            }
                        }
                        return {
                            text: content,
                            modelName: 'Gemini',
                            truncated: isTruncatedFinish(choice.finish_reason),
                            finishReason: choice.finish_reason ?? null
                        };
                    }
                }
                otherFails++; // resposta sem texto nem ferramenta aproveitável: falha que não é de tamanho
            } catch (error) {
                const status = error.response ? error.response.status : 'Unknown';
                const msg = error.response?.data?.error?.message || error.message;
                if (error.response) lastStatus = error.response.status;
                if (isTooLargeError(error, options.approxTokens || 0)) sizeFails++; else otherFails++;
                logger.warn(`[Gemini] Falha na chave ${i + 1} com o modelo ${modelName} (Status: ${status}): ${scrubLogText(msg, 200)}`);
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
    throw providerError(`Todas as chaves Gemini falharam em todos os modelos. Último erro: ${lastError ? lastError.message : 'Nenhuma chave válida'}`, null, {
        ...(lastStatus ? { status: lastStatus } : {}),
        // Todas as chaves em cooldown: nada foi tentado (notTried). Senão, vale só o que as chaves tentadas responderam.
        ...(sizeFails + otherFails === 0 ? { notTried: true } : { tooLarge: sizeFails > 0 && otherFails === 0 })
    });
}

async function tryCloudflare(prompt, systemPrompt, options = {}) {
    const accountId = config.cloudflareAccountId || process.env.CLOUDFLARE_ACCOUNT_ID;
    const apiToken = config.cloudflareApiToken || process.env.CLOUDFLARE_API_TOKEN;
    const model = config.cloudflareModel || process.env.CLOUDFLARE_MODEL || '@cf/meta/llama-3.1-8b-instruct-fast';

    if (!accountId || !apiToken) {
        throw notConfigured('Cloudflare Workers AI não configurado (falta CLOUDFLARE_ACCOUNT_ID ou CLOUDFLARE_API_TOKEN)');
    }

    console.log(`[IA] Tentando Cloudflare Workers AI (${model})...`);

    const url = `https://api.cloudflare.com/client/v4/accounts/${accountId}/ai/run/${model}`;
    const headers = {
        'Authorization': `Bearer ${apiToken}`,
        'Content-Type': 'application/json'
    };

    const messages = [
        { role: 'system', content: systemPrompt },
        ...(options.history || []),
        { role: 'user', content: prompt }
    ];

    try {
        const response = await axios.post(url, {
            messages,
            max_tokens: providerSettings.cloudflare.max_tokens,
            temperature: providerSettings.cloudflare.temperature
        }, {
            headers,
            timeout: providerSettings.cloudflare.timeout
        });

        const result = response.data?.result;
        const text = result?.response || response.data?.response;

        if (text) {
            return {
                text: text.trim(),
                modelName: `Cloudflare (${model.split('/').pop()})`
            };
        }

        throw new Error('Cloudflare retornou resposta vazia');
    } catch (error) {
        const msg = error.response?.data?.errors?.[0]?.message || error.response?.data?.error || error.message;
        throw providerError(`Cloudflare AI Error: ${msg}`, error);
    }
}

async function tryPollinations(prompt, systemPrompt) {
    logger.info('[IA] Tentando Pollinations...');
    // Só POST. O GET de reserva colocava o prompt de sistema inteiro (cerca de 14 mil caracteres) na URL, que nunca cabia (TG-30/D8).
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
    throw new Error('Pollinations devolveu resposta vazia');
}
/**
 * Yui Gateway (servidor de IA próprio): tenta, com failover automático, todos os
 * provedores configurados (Groq, Gemini, Hugging Face, OpenRouter, Cloudflare...).
 * Fica logo depois do LM Studio na cadeia. Conversas sensíveis (contexto pessoal)
 * nunca vão para provedores anônimos.
 */
async function tryGateway(prompt, systemPrompt, options = {}) {
    console.log(`[IA] Tentando Yui Gateway...`);
    if (!gatewayInChain()) {
        throw notConfigured('Yui Gateway desativado ou sem provedores configurados');
    }
    const result = await getGateway().chat({
        model: 'auto',
        messages: [
            { role: 'system', content: systemPrompt },
            ...(options.history || []),
            { role: 'user', content: prompt }
        ],
        max_tokens: providerSettings.gateway.max_tokens,
        temperature: providerSettings.gateway.temperature
    }, { sensitive: Boolean(options.sensitive) });
    const text = result?.choices?.[0]?.message?.content;
    if (!text) {
        throw new Error('Gateway devolveu resposta vazia');
    }
    const via = result.x_gateway || {};
    const finishReason = result?.choices?.[0]?.finish_reason ?? null;
    return { text, modelName: `Gateway → ${via.provider || '?'} (${via.model || '?'})`, truncated: isTruncatedFinish(finishReason), finishReason };
}
async function tryHuggingFace(prompt, systemPrompt, options = {}) {
    console.log(`[IA] Tentando HuggingFace Public (Router)...`);
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
            const finishReason = response.data.choices[0].finish_reason ?? null;
            return {
                text: response.data.choices[0].message.content,
                modelName: `HuggingFace (${modelName.split('/').pop()} via Router)`,
                truncated: isTruncatedFinish(finishReason),
                finishReason
            };
        }
    } catch (error) {
        const msg = error.response?.data?.error?.message || error.message;
        throw providerError(`HF Router Error: ${msg}`, error);
    }
    throw new Error('HF retornou formato inválido');
}
async function tryGroq(prompt, systemPrompt, options = {}) {
    console.log(`[IA] Tentando GROQ...`);
    const apiKeys = config.groqApiKeys;
    if (apiKeys.length === 0) {
        throw notConfigured('Nenhuma chave GROQ configurada (GROQ_API_KEY)');
    }
    const modelName = config.groqModel || 'openai/gpt-oss-120b';
    let lastError = null;
    let lastStatus = null; // status HTTP da última falha com resposta
    let sizeFails = 0;     // falhas por tamanho do pedido (413, ou 400 de contexto)
    let otherFails = 0;    // todas as outras (cota, rede, formato)
    for (let i = 0; i < apiKeys.length; i++) {
        const currentKey = apiKeys[i];
        if (geminiCooldowns[`groq_${currentKey}`] && Date.now() < geminiCooldowns[`groq_${currentKey}`]) {
            console.log(`[GROQ] Ignorando chave ${i + 1}/${apiKeys.length} (cooldown ativo).`);
            continue; // chave em cooldown não foi tentada: não diz nada sobre o tamanho do pedido (F2)
        }
        try {
            if (apiKeys.length > 1) {
                console.log(`[GROQ] Usando chave ${i + 1}/${apiKeys.length} com modelo ${modelName}...`);
            }
            const response = await axios.post(config.groqApiUrl, {
                model: modelName,
                messages: [
                    { role: 'system', content: systemPrompt },
                    ...options.history || [],
                    { role: 'user', content: prompt }
                ],
                max_tokens: providerSettings.groq.max_tokens,
                temperature: providerSettings.groq.temperature,
                stream: false
            }, {
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${currentKey}`
                },
                timeout: providerSettings.groq.timeout
            });
            if (response.data?.choices?.[0]?.message?.content) {
                if (apiKeys.length > 1) {
                    console.log(`[GROQ] Resposta recebida via chave ${i + 1}/${apiKeys.length}.`);
                }
                const finishReason = response.data.choices[0].finish_reason ?? null;
                return {
                    text: response.data.choices[0].message.content,
                    modelName: `GROQ (${modelName})`,
                    truncated: isTruncatedFinish(finishReason),
                    finishReason
                };
            }
            otherFails++; // resposta sem texto aproveitável: falha que não é de tamanho
        } catch (error) {
            const status = error.response ? error.response.status : 'Unknown';
            const msg = error.response?.data?.error?.message || error.message;
            if (error.response) lastStatus = error.response.status;
            if (isTooLargeError(error, options.approxTokens || 0)) sizeFails++; else otherFails++;
            logger.warn(`[GROQ] Falha na chave ${i + 1} (Status: ${status}): ${scrubLogText(msg, 200)}`);
            if (status === 429) {
                geminiCooldowns[`groq_${currentKey}`] = Date.now() + 120000;
                console.log(`[GROQ] Chave ${i + 1} em cooldown de 2 minutos.`);
            }
            lastError = new Error(`Chave ${i + 1}: ${msg}`);
        }
    }
    throw providerError(`Todas as chaves GROQ falharam. Último erro: ${lastError ? lastError.message : 'Nenhuma chave válida'}`, null, {
        ...(lastStatus ? { status: lastStatus } : {}),
        // Todas as chaves em cooldown: nada foi tentado (notTried). Senão, vale só o que as chaves tentadas responderam.
        ...(sizeFails + otherFails === 0 ? { notTried: true } : { tooLarge: sizeFails > 0 && otherFails === 0 })
    });
}
// O GET do status do Horde tinha timeout NENHUM: um servidor pendurado segurava a fila inteira (o pedido seguinte virava "Posição: 1" e nada rodava). Agora
// cada consulta tem 15 s, o conjunto tem teto de espera e o prazo da pesquisa (options.deadlineAt) também corta a espera.
const HORDE_STATUS_TIMEOUT_MS = 15_000;
const HORDE_MAX_WAIT_MS = 240_000;
async function tryKoboldHorde(prompt, systemPrompt, options = {}) {
    console.log(`[IA] Tentando Kobold Horde...`);
    const hordeHeaders = {
        'Content-Type': 'application/json',
        'Client-Agent': 'YuiBot:2.1:Maint'
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
    const hordeStartedAt = Date.now();
    while (attempts < 60) {
        if (Number.isFinite(options?.deadlineAt) && Date.now() >= options.deadlineAt) throw new Error('Horde: prazo da pesquisa esgotado');
        if (Date.now() - hordeStartedAt > HORDE_MAX_WAIT_MS) throw new Error('Kobold Horde Timeout (espera máxima)');
        await new Promise(r => setTimeout(r, 3000));
        const statusCheck = await axios.get(`https://stablehorde.net/api/v2/generate/text/status/${jobId}`, {
            headers: hordeHeaders,
            timeout: HORDE_STATUS_TIMEOUT_MS
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
    // Voz sem ferramentas liberadas (YUI_VOICE_TOOLS != true): a OFERTA fecha aqui também, para quem chamar generateResponse direto.
    if (shouldBlockToolForVoice(options)) options = { ...options, disableTools: true };
    // Conversa sensível (DM do dono / canal privado): provedores anônimos (Pollinations, Horde e o
    // Hugging Face sem token) ficam de fora da cadeia e nunca recebem a memória pessoal.
    const sensitive = options.sensitive === true;
    const hfAnonymous = !(config.hfToken && config.hfToken.length > 5);
    const providerMeta = new Map([
        [tryLocal, { id: 'local' }],
        [tryGateway, { id: 'gateway' }],
        [tryHuggingFace, { id: 'hf', anonymous: hfAnonymous }],
        [tryGroq, { id: 'groq' }],
        [tryGemini, { id: 'gemini' }],
        [tryCloudflare, { id: 'cloudflare' }],
        [tryPollinations, { id: 'pollinations', anonymous: true }],
        [tryKoboldHorde, { id: 'horde', anonymous: true }]
    ]);
    const allProviders = [
        { func: tryLocal, supportsSearch: true },
        { func: tryGateway, supportsSearch: false },
        { func: tryHuggingFace, supportsSearch: false },
        { func: tryGroq, supportsSearch: false },
        { func: tryGemini, supportsSearch: true },
        { func: tryCloudflare, supportsSearch: false },
        { func: tryPollinations, supportsSearch: false },
        { func: tryKoboldHorde, supportsSearch: false }
    ].map(p => ({ ...p, ...providerMeta.get(p.func) }));
    // O pedido leva o texto de um ANEXO lido (messageCreate): um .log pode ter chave e dado de terceiros; como na conversa sensível, nada
    // disso vai para provedor anônimo (Pollinations, Horde), qualquer que seja o tamanho do pedido.
    const noAnonymous = typeof options.attachmentBlock === 'string' && options.attachmentBlock.length > 0;
    const providers = providersAllowed(allProviders, { sensitive, noAnonymous });
    if (providers.length < allProviders.length) {
        logger.info(`[IA] ${sensitive ? 'Conversa sensível' : 'Pedido com anexo de texto'}: ${allProviders.length - providers.length} provedor(es) anônimo(s) fora da cadeia.`);
    }
    const guildId = options.guildId || options.guild?.id || null;
    // search_web fora da oferta (e fora das regras de prompt que mandam chamá-la): desligada no servidor, ou conversa privada que o YUI_PRIVATE_SEARCH não liberou.
    const searchHiddenHere = isToolDisabled(guildId, 'search_web') || !searchOfferedFor({ sensitive: sensitive || options.privateChat === true, userId: options.userId, chatter: options.chatter === true });
    const serverCustomPrompt = getServerPrompt(guildId);
    let baseSystemPrompt = (serverCustomPrompt || config.systemPrompt || config.ai?.systemPrompt || "") + "\n[IDENTIDADE — REGRA DE PRIORIDADE MÁXIMA]: " + publicPersonaText() + "\n[IMAGEM/VISÃO]: Você cria imagens novas com generate_image (pedido vago: invente um prompt criativo). Não enxerga nem edita imagens enviadas.\n[ANTI-REPETIÇÃO]: Não repita frases entre mensagens seguidas.";
    // Personalidade por contexto (Yui Core): só há override para o dono em DM/canal
    // privado e para o app; no Discord público segue a persona original.
    baseSystemPrompt = applyPersona(baseSystemPrompt, options.persona);
    if (config.sendEnvironmentInfo && (options.guildName || options.channelName)) {
        baseSystemPrompt += `\n[CONTEXTO DO AMBIENTE]: Você está conversando no servidor Discord "${options.guildName || 'DM'}" no canal/chat "#${options.channelName || 'Chat'}".`;
    }
    if (guildId) {
        try {
            const radioSession = getSession(guildId);
            if (radioSession && (radioSession.status === 'PLAYING' || radioSession.status === 'PAUSED' || radioSession.status === 'BUFFERING') && radioSession.currentTrack) {
                const track = radioSession.currentTrack;
                const statusStr = radioSession.status === 'PAUSED' ? 'pausada' : radioSession.status === 'BUFFERING' ? 'carregando' : 'tocando';
                const posStr = radioSession.currentIndex >= 0 ? `#${radioSession.currentIndex + 1}` : '';
                const totalStr = Array.isArray(radioSession.playlist) ? `${radioSession.playlist.length}` : '0';
                let musicInfo = `\n[MODO RÁDIO / MÚSICA ATUAL NO SERVIDOR]:\n- Você está conectada na chamada de voz deste servidor com o Modo Rádio ativo.\n- Status da reprodução: ${statusStr}.\n- Faixa atual (${posStr} de ${totalStr}): "${track.title}" — Artista: "${track.artist}"`;
                if (track.album) musicInfo += ` (Álbum: "${track.album}")`;
                if (Array.isArray(radioSession.playlist) && radioSession.playlist.length > 1) {
                    const nextIdx = radioSession.currentIndex + 1;
                    if (nextIdx < radioSession.playlist.length) {
                        const nextTrack = radioSession.playlist[nextIdx];
                        musicInfo += `.\n- Próxima música da fila: "${nextTrack.title}" — Artista: "${nextTrack.artist}"`;
                    }
                }
                musicInfo += `.\n[INSTRUÇÕES SOBRE O MODO RÁDIO NO CHAT]:\n1) Se o usuário perguntar o que está tocando, qual música é essa, quem está cantando ou sobre a playlist atual, responda informando os dados acima de forma natural.\n2) Se o usuário pedir no chat para você controlar o rádio (ex: pular música, pausar, passar para a próxima, parar) ou adicionar/tocar uma música nova no rádio, informe a ele que para controlar ou adicionar músicas no rádio ele deve usar os botões do menu do Modo Rádio (o painel de embed) ou o comando de voz na call.`;
                baseSystemPrompt += musicInfo;
            }
        } catch (_) {}
    }
    baseSystemPrompt += "\n[REGRAS]: Você não tem acesso a cargos, membros, logs nem regras do servidor (diga que não sabe). Código aberto: https://github.com/MauroBragaFilho/Yui (cite se pedirem). Se o histórico tiver 'erro da ia', a resposta anterior falhou: peça desculpas rápido e pergunte de novo. " + ((options.disableTools || searchHiddenHere) ? NEVER_PROMISE_RULE_NO_TOOLS : NEVER_PROMISE_RULE) + "\n[RESPOSTAS LONGAS E LIMITES]: Se pedirem uma lista ou um texto longo, escreva COMPLETO, sem se limitar ao \"curto\": o sistema divide em várias mensagens sozinho. NUNCA escreva \"Parte N de M\" nem peça para o usuário mandar um ponto ou um \"continua\" para você seguir. Você não envia DM, não agenda avisos nem guarda nada por conta própria (listas salvas só o sistema faz, quando a pessoa pede «anota na lista X: itens»); não prometa isso (nada de \"te aviso depois\", \"anotei\", \"te mando mais tarde\"). Se a pessoa mandar o conteúdo na própria mensagem (lista, texto), trabalhe com ele agora e entregue o resultado na resposta: não recuse nem prometa guardar. Nunca invente link de download: sem fonte confirmada, diga que não consegue confirmar o link.";
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
    // A memória (pessoal ou não) só vai para provedores identificados, nunca para os anônimos.
    let systemPromptNoMemory = baseSystemPrompt;
    if (options.memoryBlock) {
        baseSystemPrompt += options.memoryBlock;
    }
    // Voz: o bloco [MODO VOZ] é o ÚLTIMO do prompt de sistema (depois do override do canal e da memória, que é texto de terceiros e
    // não pode diluir as regras de fala). Vale para os dois prompts: com e sem memória (provedores anônimos).
    // (voiceSpeak=false: pedido de voz cuja resposta fica só no texto; ele não ganha a persona curta de fala)
    if (options.voice === true && options.voiceSpeak !== false) {
        baseSystemPrompt = applyVoicePersona(baseSystemPrompt);
        systemPromptNoMemory = applyVoicePersona(systemPromptNoMemory);
    }
    let lastError = null;
    let webContextCache = null; // contexto da web já obtido nesta chamada (vale para os provedores seguintes)
    // O resultado da busca desta chamada (inclusive o negativo) vale para TODOS os provedores seguintes, mesmo os que não "decidem" pesquisar: se o
    // Local pesquisou e caiu na geração, Groq, HF, Cloudflare e Pollinations recebem o contexto em vez de prometer pesquisar (D5), sem gastar a cota duas vezes.
    const webMemo = createWebContextMemo();
    // Prazo da pesquisa (options.deadlineAt, em ms desde 1970): depois dele nenhum outro provedor é aberto e o alerta falso "ai-down" ao dono não sai.
    const researchDeadline = Number.isFinite(options.deadlineAt) ? Number(options.deadlineAt) : null;
    let researchDeadlineHit = false;
    // Prazo total da cadeia (C4): só é conferido ENTRE um provedor e o próximo e nunca pula o primeiro provedor que não seja o local
    // (um LM Studio lento que falha não pode deixar Gemini e Groq, saudáveis, sem nem serem tentados).
    const deadlineAt = Date.now() + aiDeadlineMs();
    let nonLocalTried = 0; // provedores que não são o local e foram de fato tentados
    let sizeErrors = 0;    // provedores que recusaram o pedido por TAMANHO (TG-08)
    let otherErrors = 0;   // falhas de qualquer outro tipo (cota, rede, formato, prazo)
    let maxEstTokens = 0;  // maior estimativa de tokens do pedido entre as tentativas
    for (const provider of providers) {
        if (options.skipLocal && provider.func === tryLocal) {
            logger.info('[IA] Pulando provedor Local conforme solicitado.');
            continue;
        }
        if (researchDeadline !== null && Date.now() >= researchDeadline) {
            researchDeadlineHit = true;
            lastError = 'prazo da pesquisa esgotado';
            otherErrors++;
            logger.warn('[IA] Prazo da pesquisa esgotado: a cadeia de provedores parou.');
            break;
        }
        if (Date.now() > deadlineAt && nonLocalTried > 0) {
            lastError = 'prazo total esgotado';
            otherErrors++;
            logger.warn(`[IA] Prazo total de ${Math.round(aiDeadlineMs() / 1000)}s esgotado: a cadeia de provedores parou.`);
            break;
        }
        // Pollinations e Horde são anônimos: pedido grande (texto do usuário + histórico, sem o prompt de sistema) não vai para eles (D8).
        if ((provider.func === tryPollinations || provider.func === tryKoboldHorde) && anonymousTextTooBig(prompt, options.noHistory === true ? [] : getHistory(channelId, { sensitive }))) {
            logger.info(`[IA] Pulando ${provider.id}: texto grande demais para um provedor anônimo.`);
            continue;
        }
        let attemptTokens = 0;
        try {
            const providerKey = provider.func === tryLocal ? 'local' :
                                provider.func === tryGateway ? 'gateway' :
                                provider.func === tryHuggingFace ? 'hf' :
                                provider.func === tryGroq ? `groq 1/${config.groqApiKeys.length || 1}` :
                                provider.func === tryGemini ? `gemini 1/${config.geminiApiKeys.length || 1}` :
                                provider.func === tryCloudflare ? 'cloudflare' :
                                provider.func === tryPollinations ? 'pollinations' :
                                provider.func === tryKoboldHorde ? 'horde' : 'unknown';
            if (options.onProviderAttempt) {
                try {
                    await options.onProviderAttempt(providerKey);
                } catch (e) {
                    console.warn(`Erro ao atualizar mensagem de processamento para ${providerKey}:`, e.message);
                }
            }
            const useNativeMCP = (provider.func === tryLocal && config.lmStudioApiKey) || (provider.func === tryGemini);
            const promptForProvider = isAnonymousProvider(provider) ? systemPromptNoMemory : baseSystemPrompt;
            let effectiveSystemPrompt = promptForProvider;
            if (!options.disableTools) {
                if (options.radioMode) {
                    effectiveSystemPrompt = "Você é o controlador automático do player de rádio de música (Modo Alexa).\n" +
                        "Sua ÚNICA função é selecionar a ferramenta MCP correta para controlar a música.\n" +
                        "É ESTRITAMENTE PROIBIDO responder com saudações, conversas casuais ou frases como 'E aí, blz?', 'oi', 'oque você precisa'.\n" +
                        "Você DEVE SEMPRE chamar uma ferramenta MCP em formato JSON.\n\n" +
                        "MAPEAMENTO DE COMANDOS:\n" +
                        "- 'para', 'pare', 'parar', 'pause', 'pausa', 'desliga', 'stop', 'silêncio' -> radio_pause_resume\n" +
                        "- 'toca X', 'coloca X', 'play X', 'música X', 'som' -> radio_play_music\n" +
                        "- 'pula', 'passa', 'próxima', 'next' -> radio_next_track\n" +
                        "- 'volta', 'anterior' -> radio_prev_track\n" +
                        "- 'sai', 'tchau', 'vaza', 'desconecta' -> radio_leave_call\n" +
                        "- 'fila', 'lista' -> radio_show_queue\n" +
                        "- 'embaralha', 'aleatório', 'shuffle' -> radio_toggle_shuffle\n" +
                        "- Qualquer outro assunto, conversa casual ou fala não-musical -> radio_unknown_command\n\n" +
                        "RETORNE APENAS A CHAMADA DE FERRAMENTA MCP EM JSON. NUNCA GERE TEXTO CONVERSACIONAL.";
                } else if (provider.func === tryLocal && config.lmStudioApiKey) {
                    // A linha de pesquisa manda chamar search_web NA HORA (anunciar "vou pesquisar" com generate_reply não pesquisa nada) e só entra com a ferramenta ligada.
                    effectiveSystemPrompt += "\n[SYSTEM NOTICE]: You operate in STRICT TOOL MODE. You MUST ALWAYS call a tool.\n- If the user wants an action (search, download, help), use the specific tool.\n" + (searchHiddenHere ? '' : STRICT_MODE_SEARCH_LINE + "\n") + STRICT_MODE_REPLY_LINE + "\n- DO NOT output plain text. ALWAYS output a tool call.";
                } else if (provider.func === tryGemini) {
                    effectiveSystemPrompt += "\n[REGRAS DE FERRAMENTAS (TOOLS)]:\nVocê possui ferramentas poderosas. REGRA CRÍTICA DE OURO: Se o usuário pedir uma AÇÃO que pode ser feita por uma ferramenta, você DEVE chamar a ferramenta imediatamente. NUNCA responda com texto prometendo fazer a ação (ex: PROIBIDO dizer 'blz vou baixar', 'vou procurar', 'ok, buscando' quando houver uma ferramenta aplicável — isso é falso atendimento. Aja ou recuse, nunca prometa).\n- Pediu para BAIXAR MÚSICA POR NOME/ARTISTA (sem URL)? → OBRIGATÓRIO chamar search_and_download_music com o nome. NUNCA diga que vai baixar sem chamar.\n- Pediu para GERAR/CRIAR/DESENHAR uma imagem? → OBRIGATÓRIO chamar generate_image. Crie um prompt detalhado e criativo mesmo se o pedido for vago.\n- Pediu para BAIXAR áudio/vídeo e deu um link URL? → Chame download_audio ou download_video.\n- Pediu para entrar na call, canal de voz ou conversar por voz? → OBRIGATÓRIO chamar join_voice_call.\n- Pediu para sair da call, canal de voz ou desconectar da voz? → OBRIGATÓRIO chamar leave_voice_call.\n" + (searchHiddenHere ? '' : GEMINI_SEARCH_RULE + "\n") + "- Pediu jogo/torrent ou para baixar/crackear qualquer jogo de PC? → Chame search_game obrigatoriamente.\n- Pediu preço na Steam? → Chame check_steam.\n- Pediu conversão de moeda/cotação? → Chame convert_currency.\n- Conversa casual sem ação (oi, piada, pergunta simples, pergunta sobre você)? → Responda com texto puro direto, NUNCA chame ferramenta.\n\n[ANTI-LOOP DE CONTEXTO]: O histórico da conversa pode conter chamadas de ferramenta anteriores (como downloads de música). Isso NÃO significa que você deve chamar essas ferramentas novamente. Analise APENAS a mensagem mais recente do usuário para decidir qual ação tomar.\n\n[FORMATO DA RESPOSTA]:\n- Para texto: escreva APENAS a fala final pro usuário. Sem análise interna, sem mencionar ferramentas.\n- NUNCA escreva 'tool_code', 'print()', 'default_api.' ou código na resposta.\n- NUNCA encapsule em JSON como {\"response\": \"...\"}. Texto puro sempre.\n- NUNCA exponha qual ferramenta vai usar ou seu raciocínio de decisão.\n- NUNCA repita literalmente o que o usuário acabou de dizer nem o que você disse na mensagem anterior.";
                } else {
                    effectiveSystemPrompt += buildToolsDefinition(guildId, options.userId || null, { sensitive: sensitive || options.privateChat === true, chatter: options.chatter === true });
                }
            }
            let finalPrompt = prompt;
            let searchContext = "";
            let usedSearch = false;
            let searchFailure = '';   // motivo da busca automática que foi tentada e NÃO deu certo (onMeta: quem chama não repete a pesquisa)
            let searchRetryAfterMs = 0; // quando o motivo é o limite por usuário/global: daqui a quanto tempo tentar de novo
            let webContextUsed = '';  // o contexto da web desta chamada (onMeta: o /yui o reaproveita se a síntese só prometer)
            // Busca na web: nunca em conversa sensível; userId e sensitive seguem até o limite por usuário. Só o Local e o Gemini DECIDEM pesquisar
            // (supportsSearch), mas o resultado da busca desta chamada (webMemo) vale também para os provedores seguintes: nenhum deles perde a busca
            // já feita nem a refaz. A consulta passa pelo filtro de palavras do banHandler (forbiddenKeywords).
            // search_web desligada no servidor vale também para a busca automática (o /yui e o +yui chegam aqui com allowSearch: true).
            if ((provider.supportsSearch || webMemo.done) && webSearchGate({ sensitive, allowSearch: options.allowSearch }).allowed && !isToolDisabled(guildId, 'search_web')) {
                const textForSearch = options.searchPrompt || prompt;
                let webOutcome = null;
                try {
                    webOutcome = await smartSearchDetailed(textForSearch, provider.func, { userId: options.userId ?? null, sensitive, forbiddenKeywords, memo: webMemo });
                } catch (searchError) {
                    logger.warn(`[IA] Busca na web falhou, seguindo sem contexto: ${scrubLogText(searchError?.message)}`);
                }
                searchContext = webOutcome?.context ?? null;
                if (searchContext) webContextCache = searchContext;
                if (searchContext) {
                    usedSearch = true;
                    webContextUsed = searchContext;
                    // O texto da web é dado não confiável (vem cercado pela marca) e, com ele no prompt, as ferramentas ficam desligadas.
                    finalPrompt = buildWebContextPrompt({ context: searchContext, userPrompt: prompt });
                    effectiveSystemPrompt = promptForProvider;
                    logger.info('[IA] Contexto SmartSearch injetado (ferramentas desligadas nesta chamada).');
                } else {
                    // A pesquisa foi tentada e não deu certo (limite, cota, erro, nada achado): o modelo é avisado e não promete pesquisar (D1, D2).
                    const note = searchFailureNote(webOutcome?.reason);
                    if (note) {
                        finalPrompt = `${prompt}\n\n${note}`;
                        searchFailure = String(webOutcome?.reason ?? '');
                        searchRetryAfterMs = Number(webOutcome?.retryAfterMs) || 0;
                    }
                }
            }
            // noHistory: a síntese da pesquisa vê SÓ a pergunta e a evidência cercada (nunca o histórico do canal nem o contexto por horas): o que foi lido aqui
            // NÃO segue para o provedor (sentHistory fica vazio e é o que vai nas requisições, na estimativa de tokens e na continuação).
            const history = getHistory(channelId, { sensitive });
            const sentHistory = options.noHistory === true ? [] : history;
            attemptTokens = estimateTokens(effectiveSystemPrompt.length + finalPrompt.length + sentHistory.reduce((n, h) => n + String(h?.content ?? '').length, 0));
            maxEstTokens = Math.max(maxEstTokens, attemptTokens);
            const historyOptions = { ...options, sensitive, history: sentHistory, approxTokens: attemptTokens, ...(usedSearch ? { disableTools: true } : {}) };
            const result = await provider.func(finalPrompt, effectiveSystemPrompt, historyOptions);
            if (!result || !result.text || result.text.trim().length === 0) throw new Error('Resposta vazia');
            logger.info(`[IA] Sucesso! Provedor: ${result.modelName}`);
            // F4: o modelo escreveu a CHAMADA da ferramenta como texto (print(default_api.search_web(query="x")), com ou sem cerca de código). A conversão para o
            // JSON da ferramenta vem ANTES do stripThinking: ele apagava a chamada (ou deixava só a cerca ```), o provedor era dado como falho e a cadeia seguia até
            // "Limites de Processamento". Com as ferramentas ligadas o JSON vai ao despachante da fila, que executa. A entrada é limitada (TOOLCALL_SCAN_MAX).
            const writtenCall = options.disableTools ? null : writtenToolCallToJson(result.text);
            const strippedText = writtenCall || stripThinking(result.text);
            result.text = strippedText;
            if (!result.text) throw new Error('Resposta vazia após remoção de thinking block');
            let finalOutput = result.text.trim();
            // Resposta cortada pelo limite de tokens (finish_reason 'length'): pede a continuação AO MESMO provedor,
            // no máximo 2 vezes e com teto de 8000 caracteres; se ainda assim ficar cortada, avisa com honestidade.
            let truncated = result.truncated === true;
            let lastFinish = result.finishReason ?? (truncated ? 'length' : null);
            let continuations = 0;
            const toolish = looksLikeToolJson(finalOutput);
            while (truncated && !toolish && continuations < MAX_CONTINUATIONS && finalOutput.length < MAX_CONTINUED_CHARS) {
                continuations++;
                try {
                    const more = await provider.func(CONTINUE_INSTRUCTION, promptForProvider, {
                        ...historyOptions,
                        onProviderAttempt: undefined,
                        disableTools: true,
                        history: [...sentHistory, { role: 'user', content: finalPrompt }, { role: 'assistant', content: finalOutput }]
                    });
                    const extraText = more?.text ? stripThinking(more.text) : '';
                    if (!extraText || !extraText.trim()) break;
                    finalOutput = mergeContinuation(finalOutput, extraText).trim();
                    truncated = more.truncated === true;
                    lastFinish = more.finishReason ?? lastFinish;
                } catch (contError) {
                    logger.warn(`[IA] Continuação ${continuations} falhou no provedor ${provider.id}: ${scrubLogText(contError?.message, 100)}`);
                    break;
                }
            }
            if (truncated && !toolish) {
                finalOutput += `\n\n${TRUNCATION_NOTICE}`;
            }
            if (typeof options.onMeta === 'function') {
                try { options.onMeta({ provider: provider.id, model: result.modelName, finishReason: lastFinish ?? 'n/d', continuations, nativeTools: Boolean(useNativeMCP) && !options.disableTools, truncated: truncated && !toolish, usedSearch, searchFailure, searchRetryAfterMs, ...(usedSearch ? { webContext: webContextUsed } : {}) }); } catch (_) { /* só telemetria */ }
            }
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
            errorDetails = scrubLogText(errorDetails, 300);
            logger.warn(`[IA] Falha no provedor ${provider.id}. Motivo: ${errorDetails.substring(0, 100)}...`);
            lastError = errorDetails;
            if (error?.notTried !== true) {
                if (provider.func !== tryLocal) nonLocalTried++;
                // O provedor com várias chaves diz se TODAS as tentativas foram por tamanho; os demais são julgados pelo próprio erro.
                const tooLarge = typeof error?.tooLarge === 'boolean' ? error.tooLarge : isTooLargeError(error, attemptTokens);
                // LM Studio desligado ou sem Ack nem respondeu: não conta como "outra falha" (F2). Quem respondeu é que decide.
                if (tooLarge) sizeErrors++; else if (!localUnreachable(provider, error)) otherErrors++;
            }
        }
    }
    // TG-08: se TODOS os provedores tentados recusaram o pedido por tamanho, o problema é o pedido (e não cota nem queda): frase própria e
    // nenhum alerta ao dono. Qualquer outra falha misturada mantém o aviso e o texto de antes.
    if (sizeErrors > 0 && otherErrors === 0) {
        logger.warn(`[IA] Pedido grande demais para ${sizeErrors} provedor(es) (cerca de ${maxEstTokens} tokens): sem alerta ao dono.`);
        return sizeErrorText(maxEstTokens);
    }
    logger.error(`[IA] ERRO CRÍTICO: Todos os ${providers.length} provedores falharam.`);
    // Quando foi o PRAZO da pesquisa que cortou a cadeia, não é queda dos provedores: sem alerta ao dono.
    if (!researchDeadlineHit) alertOwner('ai-down', 'Todos os provedores de IA falharam', String(lastError ?? 'sem detalhes'), { level: 'error', cooldownMinutes: 15 });
    return `⚡ **Limites de Processamento Atingidos:** Todos os nossos provedores de IA atingiram a cota temporária de tokens ou estão temporariamente indisponíveis. Tente interagir novamente daqui algumas horas! ✨`;
}
// ── Voz (TTS): regras puras, exportadas para teste ───────────────────────────────────────────────────────────────────

/** Prazo de validade de um pedido de voz, em segundos (YUI_TTS_STALE_SECONDS; padrão 30). */
function voiceStaleSeconds() {
    try { return getTtsConfig().staleSeconds; } catch (_) { return 30; }
}

/**
 * Guarda de EXECUÇÃO de ferramenta para pedido de voz. `disableTools` só tira a ferramenta da OFERTA; o modelo (ou uma transcrição
 * hostil) ainda pode devolver o JSON de uma chamada, e quem despacha é a fila. Com `options.voice` e YUI_VOICE_TOOLS != true toda
 * ferramenta é descartada (a resposta vira o texto fixo VOICE_TOOL_REFUSAL), menos `generate_reply`, que é só o texto da resposta.
 */
function voiceToolBlocked(toolName, options, env = process.env) {
    if (!toolName || toolName === 'generate_reply') return false;
    return shouldBlockToolForVoice(options, env);
}

/**
 * Texto de sucesso do download de música. Se o plano B (YouTube) entrou, vale o aviso do plano B (formatDeezerDelivery) no lugar da
 * frase normal; sem plano B, a frase de sempre. Nunca lança.
 */
function musicDeliveryText(musicResult, normalText) {
    try {
        if (musicResult && musicResult.fallback) {
            const delivery = formatDeezerDelivery(musicResult);
            if (delivery.viaFallback) return delivery.text;
        }
    } catch (_) { /* cai na frase normal */ }
    return normalText;
}

/**
 * Mensagem do ramo de erro da ferramenta check_game_info (jogo sem dados). Sempre devolve um texto amigável e SEM detalhe técnico:
 *  1) a resposta natural da IA (`fallbackText`), se for texto de verdade (nada de JSON de ferramenta, erro de sistema ou aviso de limite);
 *  2) a frase do gameInfoHandler (`infoError`), se for curta e não parecer erro técnico;
 *  3) uma frase fixa com o nome do jogo limpo.
 */
function gameInfoErrorText({ infoError, fallbackText, gameQuery } = {}) {
    const oneLine = (value, max) => clampText(String(value ?? '').replace(/\s+/g, ' ').trim(), max, { ellipsis: '' });
    const technical = /\b(?:error|exception|stack|axios|econn\w*|enotfound|etimedout|status code)\b|https?:\/\/|[{}]|\bat\s+\S+\s*\(/i;
    const technicalName = /\b[A-Z][A-Za-z]*(?:Error|Exception)\b/; // TypeError, AxiosError... ("terror" de jogo de terror não casa)
    const reply = String(fallbackText ?? '').trim();
    if (reply && reply.length <= 1500 && !looksLikeToolJson(reply) && !isSystemReply(reply) && !ERROR_EMOJI_START.test(reply)) return reply;
    const known = oneLine(infoError, 200);
    if (known && !technical.test(known) && !technicalName.test(known)) return known;
    const name = oneLine(gameQuery, 60).replace(/[`"@*_~|<>\\]/g, '');
    return name
        ? `Não consegui achar informações sobre "${name}" agora. Tente outro nome ou peça uma pesquisa na web.`
        : 'Não consegui achar informações desse jogo agora. Tente outro nome ou peça uma pesquisa na web.';
}

// Aviso curto a quem pediu por voz e teve o pedido descartado por idade (sem isso a pessoa só via "Sua solicitação está na fila" e mais nada).
// Sai pelo próprio reply da mensagem de voz (menciona a pessoa e libera a vaga de pedido pendente). Nunca lança nem atrasa a fila.
const VOICE_STALE_NOTICE = 'Demorei demais para responder e perdi o fio. Pode pedir de novo?';
function notifyStaleVoiceItem(item) {
    try {
        Promise.resolve(item?.interaction?.reply?.(VOICE_STALE_NOTICE)).catch(() => {});
    } catch (_) { /* o aviso nunca atrapalha a fila */ }
}

// Alvo do contexto por horas para este item da fila (null => vale o buffer antigo). Só chamada DIRETA à Yui entra: mensagem
// espontânea (chatter), voz, rádio e log de terceiros (/chat_resumo) ficam de fora, salvo `options.contextRecord === true`
// (parâmetro para o TTS futuro; desligado por padrão). Nunca lança.
function contextTargetFor({ prompt, interaction, type, userId, channelId, options }) {
    if (!contextEnabled()) return null;
    // Voz nunca entra no contexto por horas (nem lê, nem grava), mesmo com `contextRecord`: a transcrição é fala de terceiros.
    if (options?.voice === true) return null;
    try {
        const opts = options || {};
        const guildId = interaction?.guild?.id || interaction?.guildId || null;
        const thirdPartyPrompt = opts.thirdPartyPrompt === true;
        const isVoice = interaction?.isVoice === true;
        let mentionsBot = false;
        let repliesToBot = false;
        let hasBotName = false;
        if (type === 'mention' && guildId) {
            const botUser = interaction?.client?.user || getDiscordClient()?.user || null;
            try { mentionsBot = Boolean(botUser && interaction.mentions?.has?.(botUser, { ignoreEveryone: true })); } catch (_) { /* sem menção */ }
            if (!mentionsBot && getServerSettings(guildId)?.respondToEveryone && interaction?.mentions?.everyone) mentionsBot = true;
            repliesToBot = Boolean(botUser?.id && interaction?.mentions?.repliedUser?.id === botUser.id);
            const botName = String(config.botName || 'Yui').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            hasBotName = new RegExp(`\\b${botName}\\b`, 'i').test(String(interaction?.content ?? ''));
        }
        if (!isDirectCall({ type, isDM: !guildId, mentionsBot, hasBotName, repliesToBot, thirdPartyPrompt, radioMode: opts.radioMode === true, isVoice, optIn: opts.contextRecord === true })) return null;
        const ownText = authorOwnText({ searchPrompt: opts.searchPrompt, prompt, thirdPartyPrompt, isVoice });
        const personal = contextFromDiscord({ userId, guildId, channelId }).memoryScope === 'personal';
        const target = resolveContextTarget({ userId, channelId, guildId, personal, record: Boolean(ownText), userText: ownText });
        return target.active ? target : null;
    } catch (err) {
        logger.warn(`[Context] não consegui decidir o contexto deste pedido (segue sem ele): ${scrubLogText(err?.message, 100)}`);
        return null;
    }
}
async function processQueue() {
    // Voz: pedido que passou do prazo (a fila da IA é serial) nem chega à IA, ninguém mais espera essa resposta. Log só com IDs.
    while (processingQueue.length > 0 && isStaleVoiceItem(processingQueue[0]?.options, Date.now(), voiceStaleSeconds())) {
        const stale = processingQueue.shift();
        logger.info(`[Voz] Pedido de voz descartado por idade, sem chamar a IA (servidor=${scrubLogText(stale?.interaction?.guild?.id || stale?.interaction?.guildId || '-', 32)} usuario=${scrubLogText(stale?.userId || '-', 32)}).`);
        notifyStaleVoiceItem(stale);
    }
    if (processingQueue.length === 0) {
        isProcessing = false;
        notifyQueueUpdate();
        return;
    }
    isProcessing = true;
    const item = processingQueue.shift();
    const target = contextTargetFor(item);
    if (target) {
        try { await initContextStore(); } catch (_) { /* nunca lança; na dúvida, o contexto fica só em RAM */ }
    }
    // Sempre dentro de runWithContext: com alvo null o item NÃO herda o contexto do pedido anterior (o setTimeout do finally herda o store).
    return runWithContext(target, () => processQueueItem(item));
}
async function processQueueItem({ prompt, interaction, type, userTag, userId, channelId: realChannelId, options }) {
    const guildId = interaction?.guild?.id || interaction?.guildId;
    // Voz (TTS): item de voz = veio da chamada E o voiceHandler marcou options.voice (o radioManager também marca isVoice, por isso
    // options.voice é o portão real). Regras puras em services/tts/voiceGuards.js.
    const isVoice = isVoiceItem(options, interaction);
    // Voz FALADA: a palavra de ativação abriu a frase (o voiceHandler não marca voiceSpeak=false). Sem ela o pedido continua sendo de voz
    // (sem ferramentas, escopo público, nada em memória nem historico.txt) e a resposta sai só no texto: sem persona curta e sem fala.
    const voiceSpeak = isVoice && options.voiceSpeak !== false;
    // `disableTools` só fecha a OFERTA de ferramentas; a EXECUÇÃO é barrada no despacho (voiceToolBlocked). Aqui as duas ficam coerentes.
    if (shouldBlockToolForVoice(options)) options = { ...options, disableTools: true };
    // Pedido com o texto de um ANEXO lido (options.attachmentBlock, posto pelo messageCreate): o arquivo é de terceiros (um .log ou .txt
    // recebido de outra pessoa) e pode trazer instruções. Como no pedido com busca na web, as ferramentas ficam desligadas: o modelo só
    // responde com texto e nada do arquivo consegue acionar ban, download, entrada em call etc. (M1)
    if (typeof options.attachmentBlock === 'string' && options.attachmentBlock.length > 0) options = { ...options, disableTools: true };
    // Chave do histórico em RAM, da persona de canal e do escopo: um fio por pessoa em cada servidor (nunca o canal de texto).
    // Ban e AutoMod continuam no canal de texto REAL (realChannelId): a chave de voz não é um canal e contornaria o ban de canal.
    const channelId = isVoice ? buildVoiceKey(guildId, userId) : realChannelId;
    // Voz: a transcrição de terceiros NUNCA vai para o historico.txt; só a moderação (alerta de conteúdo suspeito) continua valendo.
    const savePromptToHistoryBase = isVoice ? moderateVoiceExchange : savePromptToHistoryOnDisk;
    // O texto de um anexo lido (options.attachmentBlock) é de terceiros: não chega ao historico.txt (sem rotação) nem ao alerta ao dono
    // (promptForDiskHistory troca o trecho por um marcador). Todos os ramos de ferramenta gravam por aqui. (M2)
    const savePromptToHistory = (promptToSave, ...rest) => savePromptToHistoryBase(
        promptForDiskHistory(promptToSave, { attachmentBlock: options.attachmentBlock }), ...rest);
    const guildName = interaction?.guild?.name || "DM";
    const serverIdentifier = interaction?.guild?.id || interaction?.guildId || "N/A";
    const channelName = interaction?.channel?.name || "Chat";
    const channelIdentifier = interaction?.channel?.id || "N/A";
    console.log(`----------------------`);
    console.log(`{${guildName} - ${serverIdentifier}} {${channelName} - ${channelIdentifier}}`);
    console.log(`----------------------`);
    notifyQueueUpdate();
    let replyMessage = null;
    let lastSendError = null; // último erro de envio do unifiedReply (para distinguir "arquivo grande demais" de outras falhas)
    // Envio com divisão automática de respostas longas (src/discord/longReply.js). Contrato antigo preservado:
    // devolve a mensagem que carrega botões/embeds/arquivos (na resposta dividida, a última parte) ou null.
    const unifiedReply = createUnifiedReply({
        interaction,
        type,
        userId,
        radioMode: options.radioMode === true,
        getReplyMessage: () => replyMessage,
        setReplyMessage: (msg) => { replyMessage = msg; },
        resolveMentions,
        logger,
        onError: (err) => {
            lastSendError = err;
            logger.error(`[UnifiedReply] Erro ao responder: ${scrubLogText(err?.message, 200)}`);
        },
        limits: { maxParts: parseMaxParts() }
    });
    // Se o envio de um ARQUIVO falhou por tamanho (erro 40005 / HTTP 413), diz isso em vez de deixar a mensagem em "Executando Ação".
    const explainTooLargeUpload = () => explainFailedUpload(unifiedReply, lastSendError);
    // Contexto por horas: os ramos de ferramenta só gravam se o ÚLTIMO envio deu certo (lastDelivery nulo = ainda nada enviado).
    const ctxTarget = currentContext();
    if (ctxTarget?.active) ctxTarget.deliveredOk = () => unifiedReply.lastDelivery?.ok !== false;
    try {
        // Prompt que é LOG de terceiros (/chat_resumo): as palavras de outras pessoas não podem banir quem chamou o comando.
        const triggerSource = options.thirdPartyPrompt === true ? '' : (options.searchPrompt || prompt);
        const _automodMode = getAutoBlockMode(guildId);
        const _automodActive = _automodMode !== 'off';
        const _isWhitelisted = config.isAutomodWhitelisted(userId);
        const _triggerEnabled = !_isWhitelisted && _automodActive && (_automodMode === 'trigger' || _automodMode === 'both');
        const autoBanTrigger = _triggerEnabled ? checkAutoBan(triggerSource, guildName, guildId, channelName, realChannelId, userId) : null;
        if (autoBanTrigger) {
            const isAutoBlockOn = typeof getAutoBlock === 'function' && getAutoBlock(guildId);
            // Voz: a transcrição do STT erra e a call é ouvida por todos; ban global automático por uma palavra mal transcrita seria
            // injusto e difícil de desfazer. Em voz o gatilho só ALERTA o dono (com os botões de banir/ignorar). (Decisão D4, provisória.)
            if (isAutoBlockOn && guildId && !isVoice) {
                const alreadyBanned = checkBan(autoBanTrigger.type === 'user' ? userId : null, autoBanTrigger.type === 'guild' ? guildId : null, autoBanTrigger.type === 'channel' ? realChannelId : null);
                if (!alreadyBanned) {
                    addBan(autoBanTrigger.type, autoBanTrigger.id, autoBanTrigger.reason);
                    console.warn(`[AUTO-BAN] ${autoBanTrigger.type} bloqueado. Gatilho: ${autoBanTrigger.keyword}`);
                    const banEmbed = new EmbedBuilder()
                        .setColor(0xE11D48)
                        .setTitle('🚨 DISPOSITIVO DE SEGURANÇA ACIONADO — VOCÊ FOI BANIDO!')
                        .setDescription(`🛑 **UM BLOQUEIO PERMANENTE E IMEDIATO FOI APLICADO.**

Sua última ação violou gravemente as diretrizes de segurança da **IA Yui**. O sistema de moderação automática identificou uma conduta inaceitável e perigosa.

**DETALHES DO BANIMENTO DA YUI:**
- **ALVO PENALIZADO:** ${autoBanTrigger.type === 'user' ? 'Seu perfil de usuário (Banido Globalmente)' : autoBanTrigger.type === 'guild' ? 'Este servidor (Bot Inutilizado)' : 'Este canal (Canal Bloqueado)'}
- **STATUS:** 🔴 TOTALMENTE BANIDO E BLOQUEADO.

O acesso aos serviços foi completamente revogado e a Yui não irá responder a você. Qualquer nova tentativa de burlar a segurança agravará a punição.

Se você julga que isso é um erro grave do bot, você pode tentar apelar pelo botão abaixo para que o desenvolvedor avalie a gravidade.

---
✨ **Dica:** Deseja uma versão da **IA Yui** totalmente aberta, sem filtros ou bloqueios de segurança?
Você pode hospedar sua própria versão privada facilmente!
🚀 **Hospede sua própria Yui:** [Clique aqui para ver o GitHub](https://github.com/MauroBragaFilho/Yui)`)
                        .setFooter({ text: 'Yui Security & Moderation • by oBraga' })
                        .setTimestamp();
                    const githubButton = new ButtonBuilder()
                        .setLabel('Página do Projeto')
                        .setURL('https://github.com/MauroBragaFilho/Yui')
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
                await reportAutoBanViolation(autoBanTrigger, interaction, promptForDiskHistory(prompt, { attachmentBlock: options.attachmentBlock }), userTag, userId);
            }
        }
        const banInfo = checkBan(userId, guildId, realChannelId);
        if (banInfo) {
            logger.warn(`[BAN] Uso bloqueado para ${banInfo.type} (ID: ${userId || guildId || realChannelId}). Motivo com ${String(banInfo.reason ?? '').length} caracteres.`);
            const banEmbed = new EmbedBuilder()
                .setColor(0xE11D48)
                .setTitle('🛑 ACESSO NEGADO — VOCÊ ESTÁ BANIDO!')
                .setDescription(`Sua tentativa de interação foi abortada. O acesso à **IA Yui** está permanentemente bloqueado para você.

**DETALHES DO SEU BANIMENTO:**
- **ALVO:** ${banInfo.typeName || banInfo.type}
- **MOTIVO DO BANIMENTO:** ${clampText(String(banInfo.reason || "Violação severa dos Termos de Uso da IA Yui."), 300)}
- **STATUS ATUAL:** 🔴 TOTALMENTE RESTRITO / SUSPENSO.

Você perdeu todos os privilégios de utilização dos nossos serviços. Não adianta insistir.

Se você acredita que isso é um erro, solicite um desbanimento pelo botão abaixo.

---
💡 **Quer usar a Yui sem restrições?**
Como o projeto é open-source, você pode hospedar sua própria versão e ter controle total!
🚀 **Repositório:** [MauroBragaFilho/Yui](https://github.com/MauroBragaFilho/Yui)`)
                .setFooter({ text: 'Yui Security & Moderation • by oBraga' })
                .setTimestamp();
            const appealButton = new ButtonBuilder()
                .setCustomId(`appeal_ban_user_${userId}`)
                .setLabel('⚖️ Solicitar Apelação')
                .setStyle(ButtonStyle.Secondary);
            const githubButton = new ButtonBuilder()
                .setLabel('Página do Projeto')
                .setURL('https://github.com/MauroBragaFilho/Yui')
                .setStyle(ButtonStyle.Link)
                .setEmoji('🚀');
            const banRow = new ActionRowBuilder().addComponents(appealButton, githubButton);
            return await unifiedReply(null, [], [banRow], [banEmbed]);
        }
        if (!options.radioMode) {
            await unifiedReply('🧠 **Processando...**');
        }
        const startTime = Date.now();
        // Só metadados: o texto do usuário nunca vai para o log.
        logger.info(`[IA] Pedido em processamento: tipo=${type} caracteres=${prompt.length} canal=${guildId ? 'servidor' : 'DM'}`);
        let rawResponse;
        let isBlocked = false;
        let attemptsLeft = getErrorRetries();
        // Yui Core: contexto (papel/canal/escopo) decidido pelo backend + memória relevante.
        const coreCtx = contextFromDiscord({
            userId,
            guildId: guildId || null,
            // Voz: sem canal => escopo PÚBLICO mesmo para o dono (a call é ouvida por todos; nada de memória pessoal por voz).
            channelId: isVoice ? null : channelId,
            isBlocked: Boolean(checkBan(userId, guildId || null, null)),
        });
        // Conversa sensível (DM do dono / canal privado): sem provedores anônimos e sem busca na web, em TODAS as chamadas abaixo.
        const sensitiveChat = coreCtx.memoryScope === 'personal';
        // Conversa PRIVADA para a PESQUISA: a sensível (dono em DM ou canal privado) e também a DM de QUALQUER pessoa (decisão do dono: "DM e app para todos, com as
        // proteções"). Só a pesquisa usa isto (portão do YUI_PRIVATE_SEARCH, consulta literal, síntese sem provedor anônimo, nada gravado); a cadeia de provedores, a memória
        // e o histórico continuam decididos por `sensitiveChat`.
        const privateChat = sensitiveChat || (!(options.guildId || guildId) && !isVoice && !options.radioMode);
        // Só a fala do PRÓPRIO autor entra na memória e no histórico (o prompt pode ser o log de outras pessoas).
        const ownText = authorOwnText({ searchPrompt: options.searchPrompt, prompt, thirdPartyPrompt: options.thirdPartyPrompt === true, isVoice: interaction?.isVoice === true });
        const memoryBlock = (options.radioMode || options.thirdPartyPrompt === true) ? '' : buildMemoryBlock(coreCtx, options.searchPrompt || prompt);
        const thoughtLeakRegex = /\{\s*"thought"\s*:/i;
        let lastAttemptTime = 0;
        let lastAttemptKey = '';
        let genMeta = {};
        let webSearchUsed = false; // a resposta desta troca veio de uma busca na web (não vai para o contexto por horas)
        // ── Agente de pesquisa ────────────────────────────────────────────────────────────────────────────────────────────────────────────
        const researchCfg = researchConfigNow();  // YUI_RESEARCH_*: lidas uma vez por pedido (nunca no import)
        let researchHandled = false;              // o agente já respondeu (vale para o anti-eco, o anti-repetição e as guardas de promessa)
        let searchSkipped = false;                // o modelo chamou search_web mas a pesquisa foi pulada (conversa espontânea): a guarda final ainda vale para o texto
        let researchHistoryLine = null;           // linha curta para o histórico em RAM (nunca a promessa nem o texto derivado da web)
        let researchPrivate = false;              // a pesquisa foi em conversa PRIVADA: o resultado não vai ao historico.txt (só a linha neutra)
        const directToYui = isDirectToYui(interaction, type, options); // menção, o nome da Yui, resposta a ela, DM, comando ou app; conversa espontânea nunca
        const searchAvailable = !isToolDisabled(options.guildId || guildId, 'search_web');
        const ownQuestion = typeof options.searchPrompt === 'string' ? options.searchPrompt : ''; // SÓ a fala do próprio autor (nunca `searchPrompt || prompt`)
        // Pedido de pesquisa EXPLÍCITO e ESTRITO: sem voz, rádio, ferramentas desligadas nem /chat_resumo; só texto de até 600 caracteres e 8 linhas, sem link,
        // sem negação, sem ferramenta própria, sem música nem jogo. A pré-rota (Porta A) só liga com YUI_RESEARCH_PRE_ROUTE=true.
        const explicitReq = researchCfg.enabled
            ? preRouteDecision(ownQuestion, { voice: isVoice, direct: directToYui, radioMode: options.radioMode === true, disableTools: options.disableTools === true, thirdPartyPrompt: options.thirdPartyPrompt === true })
            : { explicit: false, reason: 'desligado' };
        const preResearch = researchCfg.preRoute && searchAvailable ? explicitReq : { explicit: false, reason: 'pré-rota desligada' };
        // O "Processando..." vira progresso (no máximo 3 edições, mínimo de 1,2 s entre elas): o embed "Executando Ação" não existe mais na pesquisa.
        const researchProgress = (line) => {
            try {
                return typeof unifiedReply.progress?.show === 'function' ? unifiedReply.progress.show(line) : unifiedReply(`🧠 **Processando...**\n${line}`);
            } catch (_) { return false; }
        };
        // Pede UMA resposta final ao modelo, sem ferramentas e com prazo (promessa sem pesquisa e conversa espontânea que tentou pesquisar). '' se não serviu.
        const askFinalAnswer = async () => {
            if (!ownQuestion) return '';
            try {
                const again = await generateResponse(buildNoPromiseRetryPrompt(ownQuestion), channelId, {
                    allowSearch: false, disableTools: true, guildId, userId, sensitive: sensitiveChat, memoryBlock,
                    persona: buildPersonaPrompt(coreCtx), deadlineAt: Date.now() + researchCfg.totalDeadlineMs, ...(voiceSpeak ? { voice: true } : {})
                });
                const text = stripThinking(String(again ?? '')).trim();
                return text && !isSystemReply(text) && !looksLikeToolJson(text) ? text : '';
            } catch (err) {
                logger.warn(`[Pesquisa] nova resposta (sem ferramentas) falhou: ${scrubLogText(err?.message, 100)}`);
                return '';
            }
        };
        // Porta L (listas pessoais): "anota na lista X: ...", "mostra a lista X", "tira o item 3...": o CÓDIGO executa no arquivo da própria pessoa; nada vai ao histórico nem ao contexto.
        if (directToYui && !isVoice && options.radioMode !== true && options.thirdPartyPrompt !== true && ownQuestion) {
            const listRouted = await routeLists({ text: ownQuestion, userId });
            if (listRouted.handled) {
                await unifiedReply(listRouted.text);
                return;
            }
        }
        // Porta M (lista de mods): 5+ linhas de nomes + "mods" + pedido de link/download/lista => o CÓDIGO procura cada nome no Modrinth (a IA não inventa link).
        // Só pedido DIRETO à Yui, em texto (nada de voz, rádio nem log de terceiros). Entrega completa e sai: nada vai ao histórico, à memória nem ao contexto.
        // Falso positivo (o Modrinth respondeu e não achou nada) ou erro: segue para o modelo, como antes. YUI_MODLIST_ENABLED=false desliga.
        if (directToYui && !isVoice && options.radioMode !== true && options.thirdPartyPrompt !== true && ownQuestion) {
            const modRouted = await routeModList({
                text: ownQuestion, sensitive: privateChat, isOwner: isOwnerId(userId), userId, guildId: options.guildId || guildId, channelId,
                progress: (line, progressOpts) => { try { return unifiedReply.progress?.show?.(line, progressOpts) ?? false; } catch (_) { return false; } }
            }, { llm: { isToolDisabled }, forbiddenKeywords, deadlineCapMs: 45_000 }); // dentro da fila serial: prazo curto, a fila inteira espera por este trabalho
            if (modRouted.handled) {
                await unifiedReply(modRouted.text);
                const modDelivery = unifiedReply.lastDelivery || { ok: false, mode: 'failed', parts: 1, sentParts: 0, durationMs: 0 };
                logger.info(formatDeliveryLog({
                    chars: modRouted.text.length, parts: modDelivery.parts, sentParts: modDelivery.sentParts, mode: modDelivery.mode, ok: modDelivery.ok,
                    channelKind: guildId ? 'servidor' : 'DM', durationMs: Date.now() - startTime, deliveryMs: modDelivery.durationMs
                }));
                return;
            }
        }
        if (preResearch.explicit) {
            // Porta A: o código decide pesquisar, sem a primeira chamada ao modelo. O JSON passa pelo despachante normal (voz, ferramenta desligada e privado valem).
            rawResponse = JSON.stringify({ thought: 'pesquisa explícita', tool: 'search_web', args: { query: preResearch.query } });
        } else do {
            rawResponse = await generateResponse(prompt, channelId, {
                ...options,
                onMeta: (meta) => { genMeta = meta; },
                guildId: options.guildId || guildId,
                // allowSearch FICA false de propósito: a busca automática do generateResponse rodaria o otimizador antigo em TODA menção (e ligaria o contexto
                // da web no lugar das ferramentas). O pedido explícito é tratado por código (pré-rota, Porta A) e a promessa pela guarda (Porta C).
                allowSearch: false,
                userId,
                memoryBlock,
                persona: buildPersonaPrompt(coreCtx),
                sensitive: coreCtx.memoryScope === 'personal',
                privateChat, // só a OFERTA de search_web olha isto (DM de qualquer pessoa: o YUI_PRIVATE_SEARCH decide); o resto segue o `sensitive`
                guildName,
                channelName,
                onProviderAttempt: async (providerKey) => {
                    if (getShowModelThinking() && !options.radioMode) {
                        const now = Date.now();
                        if (now - lastAttemptTime > 1500 || providerKey !== lastAttemptKey) {
                            lastAttemptTime = now;
                            lastAttemptKey = providerKey;
                            await unifiedReply(`-# 🧠 **Processando...**\n-# 🧠 (${providerKey}) Processando...`);
                        }
                    }
                }
            });
            isBlocked = false;
            if (rawResponse) {
                // Chamada de ferramenta escrita como texto (print(default_api.x(...)), default_api.x(...), generate_reply "..."): vira o JSON da ferramenta.
                // writtenToolCallToJson limita a entrada (resíduo F1) e é a mesma conversão que o generateResponse já fez antes do stripThinking (F4).
                const convertedCall = writtenToolCallToJson(rawResponse);
                if (convertedCall) rawResponse = convertedCall;
                const toolUseMatch = rawResponse.length <= TOOLCALL_SCAN_MAX ? rawResponse.match(/\[Tool Use:\s*(\w+)\s+args\s*=\s*(\{[\s\S]*?\})\s*\]/i) : null;
                if (toolUseMatch) {
                    const tuTool = toolUseMatch[1];
                    let tuArgs = {};
                    try { tuArgs = JSON.parse(toolUseMatch[2]); } catch (e) {}
                    rawResponse = JSON.stringify({
                        thought: "Executando ação " + tuTool,
                        tool: tuTool,
                        args: tuArgs
                    });
                    console.log(`[Tool Use Parser] Convertido formato [Tool Use:] para JSON: ${tuTool}`);
                }
                // Primeiro objeto JSON por chaves BALANCEADAS (o regex guloso pegava até a última "}" do texto e quebrava com "{json} e depois {chaves}"; M7).
                const parsedJsonCheck = (() => {
                    const jm = extractFirstJsonObject(rawResponse);
                    if (!jm) return null;
                    try { return JSON.parse(jm); } catch (e) { return null; }
                })();
                const isValidToolOrResponseJson = parsedJsonCheck && (
                    parsedJsonCheck.tool ||
                    parsedJsonCheck.name ||
                    parsedJsonCheck.action ||
                    parsedJsonCheck.generate_reply ||
                    parsedJsonCheck.response ||
                    parsedJsonCheck.reply ||
                    parsedJsonCheck.content ||
                    parsedJsonCheck.text ||
                    parsedJsonCheck.resposta ||
                    parsedJsonCheck.mensagem
                );
                if (!isValidToolOrResponseJson && (rawResponse.includes('[Tool Use:') || thoughtLeakRegex.test(rawResponse) || /tool_code[\s\n]*(?:```)?/i.test(rawResponse))) {
                    isBlocked = true;
                    logger.warn(`[SECURITY BLOCK] Bloqueado vazamento de Tool Use/JSON Raw/tool_code (${rawResponse.length} caracteres)`);
                } else if (rawResponse.includes('{') && !parsedJsonCheck) {
                    isBlocked = true;
                    logger.warn(`[PARSER ERROR] JSON malformado detectado na resposta da IA (${rawResponse.length} caracteres)`);
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
        if (!options.radioMode && !options.disableTools) {
            // Equivale a /\{[\s\S]*\}/.test(...), mas em tempo linear (o regex era quadrático com muitas "{" e nenhuma "}" depois delas).
            const rawHasJson = rawResponse.indexOf('{') !== -1 && rawResponse.lastIndexOf('}') > rawResponse.indexOf('{');
            const lowerRaw = rawResponse.toLowerCase().replace(/\n-# .*$/gm, '').trim();
            const lowerSearchPrompt = (options.searchPrompt || prompt).toLowerCase();
            const hasUrl = /https?:\/\//i.test(lowerSearchPrompt);
            const urlInPrompt = (options.searchPrompt || prompt).match(/https?:\/\/\S+/i)?.[0] || '';
            const ACTION_TOOLS = [
                {
                    tool: 'download_audio',
                    test: () => hasUrl && /\b(áudio|audio|mp3|som|baixa|download)\b/.test(lowerSearchPrompt) && !/\b(vídeo|video|mp4)\b/.test(lowerSearchPrompt),
                    args: () => ({ url: urlInPrompt })
                },
                {
                    tool: 'download_video',
                    test: () => hasUrl && /\b(vídeo|video|mp4|reel|short|tiktok)\b/.test(lowerSearchPrompt),
                    args: () => ({ url: urlInPrompt })
                },
                {
                    tool: 'search_and_download_music',
                    test: () => !hasUrl && /\b(baixa|baixe|download|quero|me manda)\b.{0,30}\b(música|musica|music|song|faixa)\b|\b(música|musica|music|song)\b.{0,30}\b(baixa|baixe|download)\b/i.test(lowerSearchPrompt),
                    args: () => {
                        const src = options.searchPrompt || prompt;
                        const m = src.match(/(?:baixa|baixe|baixar|download|quero|me manda)[^:]*?(?:música|musica|music|song|faixa)?[:\s]+(.+)/i)
                            || src.match(/(?:música|musica|song)\s+(.+)/i);
                        return { query: clampText((m ? m[1] : src).trim(), 120, { ellipsis: '' }) };
                    }
                },
                {
                    tool: 'search_game',
                    test: () => /\b(baixa|baixe|download|torrent|crack|pirat)\b.{0,40}\b(jogo|game)\b|\b(jogo|game)\b.{0,40}\b(baixa|baixe|download|torrent|crack)\b/i.test(lowerSearchPrompt) && !/\b(mobile|android|ios|console|playstation|xbox)\b/i.test(lowerSearchPrompt),
                    args: () => {
                        const src = options.searchPrompt || prompt;
                        const m = src.match(/(?:jogo|game)[:\s]+(.+)/i) || src.match(/(?:baixa|torrent|crack)\s+(?:o\s+)?(?:jogo\s+)?(.+)/i);
                        return { game_name: clampText((m ? m[1] : src).trim(), 80, { ellipsis: '' }), direct: true };
                    }
                },
                {
                    tool: 'generate_image',
                    test: () => /\b(gera|cria|crie|faz|desenha|gerar|criar|fazer)\b.{0,30}\b(imagem|foto|arte|ilustra|desenho|wallpaper|pfp|avatar|banner)\b/i.test(lowerSearchPrompt),
                    args: () => {
                        const src = options.searchPrompt || prompt;
                        const m = src.match(/(?:imagem|foto|arte|ilustra|desenho|wallpaper|pfp|avatar|banner)[:\sde]+(.+)/i);
                        return { prompt: clampText((m ? m[1] : src).trim(), 200, { ellipsis: '' }), negative_prompt: 'nsfw, nude, explicit, gore, violence, blood, adult content, 18+, pornographic' };
                    }
                }
            ];
            const PROMISE_PATTERNS = /\b(vou baixar|vou procurar|vou buscar|irei baixar|irei procurar|aguarde enquanto|deixa eu baixar|ok,? vou|blz,? vou|tá,? vou|tô baixando|to baixando|estou baixando|estou buscando|vou te mandar|já te mando|te mando já|vou pesquisar|vou verificar|vou tentar baixar)\b/i;
            if (!rawHasJson && PROMISE_PATTERNS.test(lowerRaw)) {
                const matched = ACTION_TOOLS.find(t => t.test());
                if (matched && !isToolDisabled(options?.guildId || guildId, matched.tool)) {
                    console.log(`[FALLBACK DET.] Falso atendimento interceptado. Chamando: ${matched.tool}`);
                    rawResponse = JSON.stringify({ thought: 'auto-fallback', tool: matched.tool, args: matched.args() });
                    processedResponse = rawResponse;
                }
            }
            const CASUAL_ONLY = /^(oi|olá|ola|hey|hi|bom dia|boa tarde|boa noite|tudo bem|tudo bom|e aí|e ai|como vai|como você tá|como vc tá|tá bem|ta bem|blz|beleza|legal|massa|top|show|kk|haha|rs|lol|obrigad|vlw|valeu|tmj|flw|falou)[\s!?.]*$/i;
            const rawPromptText = (options.searchPrompt || prompt).trim();
            const isCasualMessage = CASUAL_ONLY.test(rawPromptText) && rawPromptText.length < 35;
            if (isCasualMessage && rawHasJson) {
                const parsedCancel = (() => { try { return JSON.parse(extractFirstJsonObject(rawResponse)); } catch (e) { return null; } })();
                if (parsedCancel?.tool && !['generate_reply'].includes(parsedCancel.tool)) {
                    console.warn(`[ANTI-LOOP] Cancelando ferramenta ${parsedCancel.tool} — mensagem casual curta.`);
                    rawResponse = await generateResponse(`(responda casualmente em personagem): ${options.searchPrompt || prompt}`, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat });
                    processedResponse = rawResponse;
                }
            }

        }
        // toolData fica FORA do try: o catch distingue "o JSON da IA era inválido" (toolData ainda nulo) de "a ferramenta falhou depois de
        // lida" (C8). Antes o catch era vazio e qualquer falha em cerca de 1000 linhas de ferramenta virava "formato do MCP saiu inválido".
        let toolData = null;
        let toolBlockFailed = false;
        try {
            const jsonText = extractFirstJsonObject(rawResponse); // chaves balanceadas (M7); o texto do objeto, ou null
            if (jsonText) {
                toolData = JSON.parse(jsonText);
                if (toolData.generate_reply) {
                    if (typeof toolData.generate_reply === 'string') {
                        toolData.tool = 'generate_reply';
                        toolData.args = { content: toolData.generate_reply };
                    } else if (typeof toolData.generate_reply === 'object') {
                        toolData.tool = 'generate_reply';
                        toolData.args = toolData.generate_reply;
                    }
                }
                if (!toolData.tool && toolData.name) toolData.tool = toolData.name;
                if (!toolData.tool && toolData.action) toolData.tool = toolData.action;
                if (!toolData.args && toolData.arguments) toolData.args = toolData.arguments;
                if (!toolData.args && toolData.action_input) toolData.args = toolData.action_input;
                // Nome inventado (web_search, google_search, pesquisar, default_api.web_search...) vira search_web. Em search_web, `args` vira SEMPRE um objeto com a
                // consulta: de args.query (ou q, search, consulta, term, lista, JSON em texto), de `query` fora de args ou, no fim, da fala do próprio autor.
                // Nunca "undefined" (C9, M1, M6, M8). Na pesquisa PRIVADA a consulta é só a do texto literal do usuário: o que o modelo escreveu é ignorado.
                if (typeof toolData.tool === 'string' && canonicalToolName(toolData.tool) === 'search_web') {
                    const ownSpeech = typeof options.searchPrompt === 'string' ? options.searchPrompt : '';
                    const privateOnly = privateChat && privateSearchAllowed(researchCfg.privateSearch, { isOwner: isOwnerId(userId) });
                    const normalizedCall = normalizeToolCall(toolData, { fallbackQuery: buildSearchQuery(ownSpeech), preferFallback: privateOnly });
                    toolData.tool = 'search_web';
                    toolData.args = normalizedCall.args;
                }
                clampToolData(toolData); // thought, query e game curtos: eles vão para embeds de "Executando Ação" (TG-05)
                const keys = Object.keys(toolData).reduce((acc, k) => {
                    acc[k.toLowerCase()] = toolData[k];
                    return acc;
                }, {});
                if (keys.tool && (typeof keys.tool === 'string') && (keys.tool.toLowerCase() === 'none' || keys.tool.toLowerCase() === 'null')) {
                    keys.tool = null;
                    if (toolData.tool) toolData.tool = null;
                }
                // Voz: a ferramenta NUNCA executa (inclusive as que o parser default_api/[Tool Use:] converteu em JSON acima) e o JSON nunca é
                // falado: a resposta vira o texto fixo VOICE_TOOL_REFUSAL. Roda antes da checagem de disableTools para a recusa ser a da voz.
                let voiceToolDropped = false;
                if (voiceToolBlocked(toolData.tool, options)) {
                    logger.warn(`[MCP TOOL] Ferramenta '${scrubLogText(String(toolData.tool), 40)}' descartada: pedido de voz sem ferramentas liberadas.`);
                    toolData.tool = null;
                    keys.tool = null;
                    voiceToolDropped = true;
                }
                // Pedido com as ferramentas desligadas (ex.: /chat_resumo, cujo prompt é o log de outras pessoas): um JSON de
                // ferramenta na resposta é só texto e NUNCA executa (texto de terceiros poderia induzir o modelo a pedir uma ação).
                let toolIgnored = false;
                if (options.disableTools === true && toolData.tool && toolData.tool !== 'generate_reply') {
                    logger.warn(`[MCP TOOL] Ferramenta '${scrubLogText(String(toolData.tool), 40)}' ignorada: pedido com ferramentas desligadas.`);
                    toolData.tool = null;
                    keys.tool = null;
                    toolIgnored = true;
                }
                // A IA às vezes põe objeto ou lista no lugar do texto ({"response": {...}}, {"content": ["a", "b"]}): vira texto, como no generate_reply.
                // Antes lançava "text.replace is not a function" e o usuário recebia "tive um erro" (F6).
                const userResponseRaw = keys.response || keys.reply || keys.content || keys.answer || keys.text || keys.resposta || keys.mensagem;
                const userResponse = typeof userResponseRaw === 'string' ? userResponseRaw : coerceReplyContent(userResponseRaw);
                if (voiceToolDropped) {
                    processedResponse = VOICE_TOOL_REFUSAL; // texto fixo: nunca o JSON da ferramenta
                }
                else if (userResponse && !keys.tool) {
                    processedResponse = userResponse;
                    if (modelFooter) processedResponse += modelFooter;
                }
                else if (toolIgnored) {
                    processedResponse = '⚠️ O modelo não gerou uma resposta válida.';
                }
                else if (keys.thought && !keys.tool) {
                    const cleanText = rawResponse.replace(jsonText, '').trim();
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
                    logger.warn(`[Parser] JSON da IA contém apenas pensamento (${Object.keys(toolData).length} chave(s))`);
                    processedResponse = keys.thought_trace || "⚠️ O modelo não gerou uma resposta válida.";
                }
                if (toolData.tool && toolData.args) {
                    const targetGuildId = options?.guildId || guildId;
                    if (isToolDisabled(targetGuildId, toolData.tool)) {
                        logger.warn(`[MCP TOOL] Ferramenta '${scrubLogText(String(toolData.tool), 40)}' está desativada no servidor ${scrubLogText(String(targetGuildId), 32)}. Execução abortada.`);
                        const disabledToolText = `⚠️ A ferramenta \`${toolData.tool}\` está desativada neste servidor.`;
                        processedResponse = disabledToolText;
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: BLOCKED - ${toolData.tool}]`, interaction);
                        // F5: sem esta resposta a mensagem ficava em "Processando..." para sempre (o `return` saía sem enviar nada).
                        await unifiedReply(disabledToolText);
                        return;
                    }
                    if (isVoice) {
                        // Voz: o raciocínio do modelo pode repetir o que a pessoa disse; só o nome da ferramenta e o tamanho vão para o log.
                        logger.info(`[MCP TOOL] Detectado: ${scrubLogText(String(toolData.tool), 40)} (raciocínio de ${String(toolData.thought ?? '').length} caracteres)`);
                    } else {
                        // O raciocínio do modelo costuma repetir o pedido (às vezes uma pesquisa privada): nem o console nem o arquivo de log levam o texto, só o tamanho.
                        logger.info(`[MCP TOOL] Detectado: ${scrubLogText(String(toolData.tool), 40)} (raciocínio de ${String(toolData.thought ?? '').length} caracteres)`);
                    }
                    if (options && options.radioMode && toolData.tool && toolData.tool.startsWith('radio_')) {
                        const radioGuildId = options.guildId || interaction.guildId;
                        const radioTextChannel = interaction.radioTextChannel || interaction.channel;
                        const radioUserId = interaction.radioUserId || userId;
                        const radioResult = await handleRadioMCPCall(
                            toolData.tool,
                            toolData.args,
                            radioUserId,
                            radioGuildId,
                            radioTextChannel,
                            interaction.radioClient || null
                        );
                        if (radioResult) await unifiedReply(radioResult);
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: RADIO_MCP]`, interaction);
                        return;
                    }
                    if (toolData.tool === 'download_audio') {
                        const audioUserId = userId;
                        if (!canBypass(audioUserId) && isUserBusy(audioUserId)) {
                            await unifiedReply(busyMessage(userId));
                            return;
                        }
                        lockUser(audioUserId);
                        let audioData = null;
                        try {
                            if (type === 'mention' && interaction.suppressEmbeds) {
                                try { await interaction.suppressEmbeds(true); } catch (e) {}
                            }
                            const audioEmbed = new EmbedBuilder()
                                .setColor(0x7C3AED)
                                .setTitle('🎧 Executando Ação')
                                .setDescription(`A Yui está baixando o áudio solicitado.\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Detectado link de música'}*`)
                                .setFooter({ text: 'Yui Media • Tool Use: download_audio' });
                            await unifiedReply(null, [], [], [audioEmbed]);
                            audioData = await downloadAudio(toolData.args.url, { source: 'MCP', userId, userTag, guildName: interaction.guild?.name || 'DM', guild: interaction.guild });
                            if (audioData && audioData.filePath) {
                                const { filePath, metadata } = audioData;
                                const displayFileName = sanitizeFilenameForDiscord(metadata.title || 'audio');
                                const attachment = new AttachmentBuilder(filePath, { name: `${displayFileName}.mp3` });
                                // Mesma linha discreta do /baixar_musica quando o link trazia uma playlist (campos ausentes => sem aviso).
                                await unifiedReply(`✅ Áudio: \`${clampText(codeSafe(metadata.title) || 'áudio', 200)}\`${downloadPlaylistNote(audioData)}`, [attachment]);
                                await explainTooLargeUpload();
                                setContextLine('Baixei o áudio do link pedido e enviei o arquivo.');
                            }
                        } catch (audioError) {
                            logger.warn(`[DownloadAudio] Falha (código: ${audioError?.code || 'n/d'}): ${scrubLogText(audioError?.message, 200)}`);
                            await unifiedReply(`❌ ${getMediaUserMessage(audioError, 'Não consegui baixar o áudio agora. Tente de novo em instantes.')}`);
                        } finally {
                            unlockUser(audioUserId);
                            cleanupDownload(audioData); // apaga a subpasta temporária do pedido (idempotente)
                        }
                        recordContextTurn('O download do áudio falhou.');
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: DOWNLOAD_AUDIO]`, interaction);
                        return;
                    }
                    if (toolData.tool === 'get_current_music') {
                        const discordClient = getDiscordClient();
                        const musicInfo = await getCurrentMusicFromUser(userId, discordClient);
                        if (!musicInfo.success) {
                            let msg = `🎵 ${musicInfo.message}`;
                            if (musicInfo.helpInstructions || musicInfo.reason === 'no_presence') {
                                msg += '\n\n> **Como ativar:**\n> Vá em **Configurações do Discord → Privacidade e Segurança → Atividade de Status** e ative a opção **"Exibir atividade atual como mensagem de status"**.';
                            }
                            await unifiedReply(msg);
                            recordContextTurn('Não consegui identificar a música que você está ouvindo agora.');
                            savePromptToHistory(prompt, userTag, userId, `[TOOL: GET_CURRENT_MUSIC - FAIL:${musicInfo.reason}]`, interaction);
                            return;
                        }
                        const infoEmbed = new EmbedBuilder()
                            .setColor(0x1DB954)
                            .setTitle(`${musicInfo.platformEmoji} Música Identificada`)
                            .setDescription(`**${musicInfo.title}**\n🎤 ${musicInfo.artist}${musicInfo.album ? `\n💿 ${musicInfo.album}` : ''}`)
                            .addFields({ name: 'Plataforma', value: musicInfo.platformLabel, inline: true })
                            .setFooter({ text: 'Yui Music' })
                            .setTimestamp();
                        if (musicInfo.coverUrl) infoEmbed.setThumbnail(musicInfo.coverUrl);
                        const musicUserId = userId;
                        if (!canBypass(musicUserId) && isUserBusy(musicUserId)) {
                            await unifiedReply(busyMessage(userId));
                            return;
                        }
                        lockUser(musicUserId);
                        try {
                            const keepEmbed = config.keepMusicEmbed !== false;
                            const downloadingEmbed = EmbedBuilder.from(infoEmbed);
                            if (keepEmbed) {
                                downloadingEmbed.addFields({ name: 'Status', value: '⏳ Baixando música, aguarde...', inline: true });
                            }
                            await unifiedReply(null, [], [], [downloadingEmbed]);
                            const musicResult = await handleMusicSearchAndDownload(
                                musicInfo.searchQuery,
                                null,
                                { user: interaction.user, userId, userTag, guild: interaction.guild, infoEmbed: keepEmbed ? infoEmbed : null, forceDownload: true }
                            );
                            if (musicResult.error) {
                                await unifiedReply(`❌ ${musicResult.error}`);
                            } else if (musicResult.isAmbiguous) {
                                setContextLine('Mostrei opções de músicas para você escolher.');
                                const noMatchEmbed = EmbedBuilder.from(infoEmbed)
                                    .spliceFields(0, 25)
                                    .addFields(
                                        { name: 'Plataforma', value: musicInfo.platformLabel, inline: true },
                                        { name: 'Aviso', value: '⚠️ Não encontrei um arquivo compatível. Escolha abaixo:', inline: false }
                                    );
                                await unifiedReply(musicResult.textList, [], musicResult.components, [noMatchEmbed]);
                            } else if (musicResult.success) {
                                setContextLine('Baixei a música que você está ouvindo e enviei o arquivo.');
                                // O cartão que acompanha o MP3 não indica a origem (o campo "Plataforma" saiu daqui; V-1): só a faixa identificada.
                                const finalEmbed = EmbedBuilder.from(infoEmbed).spliceFields(0, 25);
                                if (musicResult.lowConfidence) {
                                    finalEmbed.addFields({ name: 'Aviso', value: '⚠️ Correspondência baixa — pode não ser o arquivo exato.', inline: false });
                                }
                                // Plano B (YouTube): musicDeliveryText troca a frase pelo aviso do plano B; sem plano B, a frase de sempre.
                                const deliveredText = musicDeliveryText(musicResult, `✅ \`${musicLabel(musicResult.track)}\``);
                                if (keepEmbed) {
                                    await unifiedReply(deliveredText, [musicResult.attachment], [], [finalEmbed]);
                                } else {
                                    await unifiedReply(deliveredText, [musicResult.attachment]);
                                }
                                await explainTooLargeUpload();
                                if (typeof musicResult.cleanup === 'function') musicResult.cleanup();
                            }
                        } catch (err) {
                            logger.warn(`[GetCurrentMusic] Erro: ${scrubLogText(err?.message, 150)}`);
                            await unifiedReply(`❌ ${getMediaUserMessage(err, 'Não consegui baixar a música agora. Tente de novo em instantes.')}`);
                        } finally {
                            unlockUser(musicUserId);
                        }
                        recordContextTurn('O download da música falhou.');
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: GET_CURRENT_MUSIC - ${musicInfo.title}]`, interaction);
                        return;
                    }
                    if (toolData.tool === 'search_and_download_music') {
                        const musicUserId = userId;
                        if (!canBypass(musicUserId) && isUserBusy(musicUserId)) {
                            await unifiedReply(busyMessage(userId));
                            return;
                        }
                        lockUser(musicUserId);
                        try {
                            const musicEmbed = new EmbedBuilder()
                                .setColor(0x9B59B6)
                                .setTitle('🎵 Buscando Música')
                                .setDescription(`Buscando no catalogo de musicas...\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Pesquisando faixa de música'}*`)
                                .setFooter({ text: 'Sistema de Áudio' });
                            await unifiedReply(null, [], [], [musicEmbed]);

                            const musicResult = await handleMusicSearchAndDownload(
                                toolData.args.query,
                                toolData.args.selected_index,
                                { user: interaction.user, userId, userTag, guild: interaction.guild }
                            );

                            if (musicResult.error) {
                                await unifiedReply(`❌ ${musicResult.error}`);
                            } else if (musicResult.isAmbiguous) {
                                setContextLine('Mostrei opções de músicas para você escolher.');
                                await unifiedReply(musicResult.textList, [], musicResult.components, [musicResult.embed]);
                            } else if (musicResult.success) {
                                setContextLine('Baixei a música pedida e enviei o arquivo.');
                                await unifiedReply(musicDeliveryText(musicResult, `✅ Música: \`${musicLabel(musicResult.track)}\``), [musicResult.attachment]);
                                await explainTooLargeUpload();
                                if (typeof musicResult.cleanup === 'function') {
                                    musicResult.cleanup();
                                }
                            }
                        } catch (musicError) {
                            logger.warn(`[SearchAndDownloadMusic] Erro: ${scrubLogText(musicError?.message, 150)}`);
                            await unifiedReply(`❌ ${getMediaUserMessage(musicError, 'Não consegui processar a música agora. Tente de novo em instantes.')}`);
                        } finally {
                            unlockUser(musicUserId);
                        }
                        recordContextTurn('O download da música falhou.');
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: SEARCH_AND_DOWNLOAD_MUSIC]`, interaction);
                        return;
                    }
                    if (toolData.tool === 'download_video') {
                        const videoUserId = userId;
                        if (!canBypass(videoUserId) && isUserBusy(videoUserId)) {
                            await unifiedReply(busyMessage(userId));
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
                                .setDescription(`A Yui está baixando o vídeo solicitado.\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Detectado link de vídeo'}*`)
                                .setFooter({ text: 'Yui Media • Tool Use: download_video' });
                            await unifiedReply(null, [], [], [videoEmbed]);
                            const videoData = await downloadVideo(toolData.args.url, { source: 'MCP', userId, userTag, guildName: interaction.guild?.name || 'DM' });
                            const guild = interaction.guild || interaction?.guild;
                            // Limite de envio pelo helper único (10 MB sem boost, com folga de 5%), no lugar dos 25 MB fixos que o Discord recusava (TG-02).
                            const verdict = videoUploadVerdict(guild, videoData.fileSize);
                            if (verdict.fits) {
                                const displayFileName = sanitizeFilenameForDiscord(videoData.metadata.title || 'video');
                                const attachment = new AttachmentBuilder(videoData.filePath, { name: `${displayFileName}.mp4` });
                                const showDetails = toolData.args.include_description === true || toolData.args.descricao === true;
                                await unifiedReply(formatVideoSuccessMessage(videoData, showDetails), [attachment]);
                                await explainTooLargeUpload();
                                setContextLine('Baixei o vídeo do link pedido e enviei o arquivo.');
                                try { if (fs.existsSync(videoData.filePath)) fs.unlinkSync(videoData.filePath); } catch (e) {}
                            } else {
                                const fileId = storeVideoForCompression(videoData.filePath);
                                const compressEmbed = new EmbedBuilder()
                                    .setColor(0xF59E0B)
                                    .setTitle('📦 Vídeo Grande Demais')
                                    .setDescription(`O vídeo **${clampText(codeSafe(videoData.metadata.title), 200)}** tem **${verdict.sizeText}**, mas o limite deste servidor é **${verdict.limitText}**.\n\nClique no botão abaixo para tentar comprimir o vídeo automaticamente.\n\n⏰ *O arquivo ficará disponível por 6 horas.*`)
                                    .setFooter({ text: 'Yui Media • by oBraga' })
                                    .setTimestamp();
                                const row = new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setCustomId(`compress_video_${fileId}`).setLabel('🔄 Tentar Compressão').setStyle(ButtonStyle.Primary)
                                );
                                const payload = { content: '', embeds: [compressEmbed], components: [row] };
                                if (type === 'mention') await replyMessage.edit(payload);
                                else await interaction.editReply(payload);
                                setContextLine('O vídeo passou do limite de tamanho do servidor; ofereci tentar comprimir.');
                            }
                        } catch (videoError) {
                            logger.warn(`[DownloadVideo] Erro (código: ${videoError?.code || 'n/d'}): ${scrubLogText(videoError?.message, 150)}`);
                            await unifiedReply(`❌ ${getMediaUserMessage(videoError, 'Não consegui baixar o vídeo agora. Tente de novo em instantes.')}`);
                        } finally {
                            unlockUser(videoUserId);
                        }
                        recordContextTurn('O download do vídeo falhou.');
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
                            .setDescription(`Buscando arquivo de download do jogo: **${gameName}**\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Buscando torrent'}*`)
                            .setFooter({ text: 'Yui Game Search • Tool Use: search_game' });
                        await unifiedReply(null, [], [], [gameEmbed]);
                        const results = await searchGames(gameName, provider);
                        addToolExchangeToHistory(channelId, ownText, 'Busquei o jogo pedido nas fontes de download.');
                        
                        if (results.length > 0) {
                            const queryNorm = normalizeString(gameName);
                            const firstTitleNorm = normalizeString(results[0].title);
                            const isExactMatch = firstTitleNorm.includes(queryNorm) && (results.length === 1 || firstTitleNorm === queryNorm || firstTitleNorm.startsWith(queryNorm));
                            
                            if (direct && isExactMatch) {
                                const bestGame = results[0];
                                const torrentInfo = await getTorrentOrMagnet(bestGame);
                                const attachment = new AttachmentBuilder(torrentInfo.buffer, { name: torrentInfo.fileName });
                                const gameEmbed = new EmbedBuilder()
                                    .setTitle(`🚀 Download: ${clampText(String(bestGame.title ?? ''), 235)}`)
                                    .setDescription(`> *${toolData.thought}*\n\n${torrentInfo.message}`)
                                    .setColor(torrentInfo.color)
                                    .addFields({ name: '🔗 Magnet Link (Backup)', value: `\`\`\`${clampText(String(bestGame.magnet ?? ''), 1000)}\`\`\`` })
                                    .setFooter({ text: 'Yui Torrent Search • by oBraga' });
                                const payload = { content: '', embeds: [gameEmbed], files: [attachment], components: [] };
                                if (type === 'mention') await replyMessage.edit(payload);
                                else await interaction.editReply(payload);
                                recordContextTurn('Busquei o jogo pedido e enviei o arquivo de download.');
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
                                        const safeTitle = clampText(String(game.title ?? ''), 70);
                                        const displayIndex = startIndex + index + 1;
                                        description += `**#${displayIndex}** ${game.emoji} **${safeTitle}**\n`;
                                        description += `\`📦 ${game.fileSize}\`  •  \`📅 ${date}\`  •  \`${game.provider}\`\n\n`;
                                    });
                                    
                                    const embed = new EmbedBuilder()
                                        .setTitle(clampText(titleText, 256))
                                        .setDescription(description)
                                        .setColor(0x7C3AED)
                                        .setFooter({ text: 'Yui Torrent Search • by oBraga' });
                                    
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
                                                .setTitle(`🚀 Download Pronto: ${clampText(String(selectedGame.title ?? ''), 235)}`)
                                                .setDescription(result.message)
                                                .setColor(result.color)
                                                .addFields({ name: '🔗 Magnet Link (Backup)', value: `\`\`\`${clampText(String(selectedGame.magnet ?? ''), 1000)}\`\`\`` })
                                                .setFooter({ text: 'Yui Torrent Search • by oBraga' });
                                                
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
                                recordContextTurn('Busquei o jogo pedido e mostrei uma lista de opções para escolher.');
                                savePromptToHistory(prompt, userTag, userId, `[TOOL: SEARCH_GAME - ${gameName}]`, interaction);
                                return;
                            }
                        } else {
                            processedResponse = `❌ Não encontrei "${gameName}" nas fontes (FitGirl/DODI). Tente novamente com outro nome (lembre-se que é apenas jogos de PC)`;
                        }
                    }
                    if (toolData.tool === 'show_bot_menu' || toolData.tool === 'get_help') {
                        try {
                            let payload;
                            if (toolData.args && toolData.args.context) {
                                const ctx = toolData.args.context;
                                if (ctx === 'sobre') payload = buildHelpCreatorPayload();
                                else if (ctx === 'regras') payload = buildHelpRulesPayload();
                                else if (ctx === 'comandos' || ctx === 'geral') payload = buildHelpCommandListPayload();
                            }
                            if (!payload) payload = buildHelpHomePayload();
                            await unifiedReply('', [], payload.components, payload.embeds);
                            savePromptToHistory(prompt, userTag, userId, `[TOOL: GET_HELP]`, interaction);
                            return;
                        } catch (err) {
                            processedResponse = `❌ Erro ao abrir ajuda: ${err.message}`;
                        }
                    }
                }
                if (toolData.tool === 'join_voice_call') {
                    const member = interaction.member;
                    const textChannel = interaction.channel;
                    if (!member) {
                        await unifiedReply('⚠️ Não foi possível identificar seu usuário para entrar no canal de voz.');
                        return;
                    }
                    await joinVoiceCall(member, textChannel, unifiedReply);
                    savePromptToHistory(prompt, userTag, userId, `[TOOL: JOIN_VOICE_CALL]`, interaction);
                    return;
                }
                if (toolData.tool === 'leave_voice_call') {
                    const guildId = interaction.guildId;
                    const textChannel = interaction.channel;
                    if (!guildId) {
                        await unifiedReply('⚠️ Este comando só pode ser usado dentro de um servidor.');
                        return;
                    }
                    await leaveVoiceCall(guildId, textChannel, unifiedReply);
                    savePromptToHistory(prompt, userTag, userId, `[TOOL: LEAVE_VOICE_CALL]`, interaction);
                    return;
                }
                if (toolData.tool === 'generate_reply') {
                    let content = toolData.args ? (toolData.args.content || toolData.args.text || toolData.args.reply || toolData.args.response || toolData.args.message || toolData.args.resposta || toolData.args.mensagem) : null;
                    if (!content && typeof toolData.content === 'string') content = toolData.content;
                    if (!content && typeof toolData.response === 'string') content = toolData.response;
                    if (!content && typeof toolData.text === 'string') content = toolData.text;
                    if (!content && typeof toolData.reply === 'string') content = toolData.reply;
                    if (!content && typeof toolData.args === 'string') content = toolData.args;
                    if (!content && toolData.thought) content = toolData.thought;
                    // O conteúdo pode ter vindo como lista, objeto ou número: vira texto (antes um objeto dava TypeError no .replace e o usuário via "tive um erro").
                    content = coerceReplyContent(content);
                    if (!content) content = "⚠️ Não foi possível extrair a mensagem.";
                    const hallucinatedFooterRegex = /\n-# Modelo: .*$/;
                    if (hallucinatedFooterRegex.test(content)) {
                        content = content.replace(hallucinatedFooterRegex, '');
                    }
                    processedResponse = content;
                    if (modelFooter) {
                        processedResponse += `${modelFooter} | ⏱️ ${duration}`;
                    } else {
                        processedResponse += `\n-# ⏱️ ${duration}`;
                    }
                    // Sair da call por aqui só vale com a ferramenta leave_voice_call LIBERADA no servidor (desligada por padrão) e fora de pedido
                    // de voz sem ferramentas: o modelo respondeu "generate_reply" e o texto do pedido não pode contornar o interruptor.
                    if (/yui.*\b(saia|sai|desconecta)\s+(da|do)?\s*(call|voz)\b/i.test(prompt)) {
                        if (interaction.guildId && !isToolDisabled(interaction.guildId, 'leave_voice_call') && !voiceToolBlocked('leave_voice_call', options)) {
                            await leaveVoiceCall(interaction.guildId, interaction.channel);
                        }
                    }
                    logger.info(`[MCP CHAT] Resposta gerada via ferramenta generate_reply (${processedResponse.length} caracteres)`);
                }
                if (toolData.tool === 'search_web' && researchCfg.enabled && isVoice) {
                    // Voz NUNCA pesquisa, nem com YUI_VOICE_TOOLS=true (a fala de terceiros na call viraria consulta a buscadores): recusa honesta.
                    processedResponse = VOICE_REFUSAL;
                    researchHandled = true;
                    logger.info('[Pesquisa] search_web por voz: recusado (voz não pesquisa)');
                } else if (toolData.tool === 'search_web' && researchCfg.enabled && !directToYui) {
                    // Conversa espontânea (chatter): ninguém chamou a Yui, então nada de pesquisa nem de cota gasta por quem só falou no canal. Pede a resposta final sem
                    // ferramentas; a guarda final ainda confere o texto (searchSkipped).
                    logger.info('[Pesquisa] search_web em conversa espontânea: sem pesquisa e sem cota; pedindo a resposta final');
                    searchSkipped = true;
                    processedResponse = (await askFinalAnswer()) || SPONTANEOUS_NO_SEARCH_TEXT;
                } else if (toolData.tool === 'search_web' && researchCfg.enabled) {
                    // AGENTE DE PESQUISA (Porta B): o modelo chamou search_web. O código faz o resto e SEMPRE entrega uma resposta (síntese, resumo com links ou o
                    // motivo). A conversa privada só abre pelo YUI_PRIVATE_SEARCH e só em pedido EXPLÍCITO (webSearchGate); a recusa é imediata, sem progresso nem busca.
                    const searchGate = webSearchGate({ sensitive: privateChat, privateMode: researchCfg.privateSearch, isOwner: isOwnerId(userId), explicit: explicitReq.explicit });
                    const wantedQuery = typeof toolData.args?.query === 'string' ? toolData.args.query.trim() : '';
                    if (!searchGate.allowed) {
                        processedResponse = searchGate.message || SENSITIVE_SEARCH_REFUSAL;
                    } else if (!searchGate.private && !wantedQuery) {
                        processedResponse = NEED_TOPIC_REPLY; // sem assunto nem no pedido: pergunta, em vez de pesquisar "undefined"
                    } else {
                        const found = await runResearchFor({
                            question: ownQuestion || wantedQuery, query: wantedQuery, userId, sensitive: privateChat,
                            channelId, guildId: options.guildId || guildId, progress: researchProgress
                        });
                        processedResponse = found.text;
                        researchHandled = true;
                        webSearchUsed = true;
                        researchHistoryLine = found.historyLine;
                        researchPrivate = found.private === true;
                    }
                } else if (toolData.tool === 'search_web') {
                    // YUI_RESEARCH_ENABLED=false (chave mestra): o ramo ANTIGO de search_web, exatamente como era antes do agente.
                    const query = toolData.args.query;
                    const searchGate = webSearchGate({ sensitive: sensitiveChat });
                    if (!searchGate.allowed) {
                        // Conversa privada: a consulta sairia para buscadores de terceiros. Não pesquisa (e não mostra o embed).
                        processedResponse = searchGate.message;
                    } else {
                        const searchEmbed = new EmbedBuilder()
                            .setColor(0x7C3AED)
                            .setTitle('🔎 Executando Ação')
                            .setDescription(`Pesquisando na web por: **"${query}"**\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Buscando informações'}*`)
                            .setFooter({ text: 'Yui Search • Tool Use: search_web' });
                        await unifiedReply(null, [], [], [searchEmbed]);
                        const search = await performWebSearch(query, { userId, sensitive: sensitiveChat });
                        if (search.context) {
                            // O resultado da web é dado não confiável: entra cercado pela marca e a chamada não tem ferramentas.
                            webSearchUsed = true;
                            const contextPrompt = buildSearchToolPrompt({ results: search.context, userPrompt: prompt });
                            processedResponse = await generateResponse(contextPrompt, channelId, { allowSearch: false, disableTools: true, guildId, userId, sensitive: sensitiveChat, voice: voiceSpeak });
                            processedResponse += `\n-# 🔎 Search`;
                        } else if (search.message) {
                            processedResponse = search.message;
                        } else {
                            processedResponse = `❌ Não encontrei nada relevante sobre "${query}" na busca rápida.`;
                        }
                    }
                }
                if (toolData.tool === 'check_steam') {
                    const query = toolData.args.game;
                    const steamSearchEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('🎮 Executando Ação')
                        .setDescription(`Consultando dados sobre **"${query}"** na Steam\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Consultando a Steam'}*`)
                        .setFooter({ text: 'Yui Steam • Tool Use: check_steam' });
                    await unifiedReply(null, [], [], [steamSearchEmbed]);
                    const steamInfo = await getSteamGameInfo(query);
                    
                    if (steamInfo.error) {
                        processedResponse = steamInfo.error;
                    } else {
                        let finalDesc = steamInfo.description || "Sem sinopse válida.";
                        finalDesc = clampText(finalDesc, 3900);
                        
                        const steamEmbed = new EmbedBuilder()
                                                            .setColor(0x7C3AED)
                            .setTitle(clampText(steamInfo.name, 256))
                            .setURL(steamInfo.url)
                            .setDescription(finalDesc)
                            .addFields(
                                { name: 'Preço', value: steamInfo.discount > 0 ? `~~${steamInfo.originalPrice}~~ **${steamInfo.price}** (-${steamInfo.discount}%)` : steamInfo.price, inline: true },
                                { name: 'Lançamento', value: steamInfo.releaseDate, inline: true },
                                { name: 'Desenvolvedor', value: clampText(steamInfo.developers, 1000), inline: true }
                            )
                            .setFooter({ text: 'Fonte: Loja da Steam • Yui • by oBraga' })
                            .setTimestamp();
                            
                        if (steamInfo.headerImage) {
                            steamEmbed.setImage(steamInfo.headerImage);
                        }
                        if (steamInfo.metacritic) {
                            steamEmbed.addFields({ name: 'Metacritic', value: `${steamInfo.metacritic}/100 🌟`, inline: true });
                        }
                        
                        let yuiComment = `Ok, puxei as informações sobre **${steamInfo.name}** pra você! Está custando ${steamInfo.price}.`;
                        
                        try {
                            const commentPrompt = `Eu acabei de consultar o jogo "${steamInfo.name}" na Steam. O preço atual é ${steamInfo.price} e o lançamento foi em ${steamInfo.releaseDate}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, colocando o valor na resposta, na sua personalidade de forma natural. (NÃO gere json nem responda pedindo, apenas diga a fala natural).`;
                            const rawComment = await generateResponse(commentPrompt, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat, isInternalComment: true });
                            if (rawComment && !isSystemReply(rawComment)) {
                                let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                                const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                                if (jsonMatch) {
                                    try {
                                        const parsed = JSON.parse(jsonMatch[0]);
                                        cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || (Object.keys(parsed).length === 1 ? Object.values(parsed)[0] : cleanData);
                                    } catch (e) {}
                                }
                                yuiComment = cleanData;
                            }
                        } catch (e) {
                            console.warn('Erro ao gerar comentario steam', e.message);
                        }

                        const payload = { content: commentText(yuiComment), embeds: [steamEmbed], files: [], allowedMentions: NO_MENTIONS };
                        if (type === 'mention') await replyMessage.edit(payload);
                        else await interaction.editReply(payload);
                        
                        addToolExchangeToHistory(channelId, ownText, `[Consulta Steam: ${steamInfo.name}] ${commentText(yuiComment)}`);
                        recordContextTurn('Consultei a Steam e mostrei os dados do jogo pedido.');
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
                        .setFooter({ text: 'Yui Finance • Tool Use: convert_currency' });
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
                            .setFooter({ text: 'Fonte: AwesomeAPI • Yui • by oBraga' })
                            .setTimestamp();
                            
                        let yuiComment = `Pronto! Deu **${resultFormatted} ${convInfo.to}** na cotação atual.`;
                        
                        try {
                            const commentPrompt = `Eu acabei de converter ${convInfo.amount} ${convInfo.from} para ${convInfo.to}. O resultado foi ${resultFormatted}. Faça um comentário CURTO (máximo 15 palavras) e bem casual sobre isso, na sua personalidade. (NÃO gere json nem responda pedindo, apenas diga a fala natural).`;
                            const rawComment = await generateResponse(commentPrompt, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat, isInternalComment: true });
                            if (rawComment && !isSystemReply(rawComment)) {
                                let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                                const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                                if (jsonMatch) {
                                    try {
                                        const parsed = JSON.parse(jsonMatch[0]);
                                        cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || (Object.keys(parsed).length === 1 ? Object.values(parsed)[0] : cleanData);
                                    } catch (e) {}
                                }
                                yuiComment = cleanData;
                            }
                        } catch (e) {
                            console.warn('Erro ao gerar comentario currency', e.message);
                        }

                        const payload = { content: commentText(yuiComment), embeds: [convEmbed], files: [], allowedMentions: NO_MENTIONS };
                        if (type === 'mention') await replyMessage.edit(payload);
                        else await interaction.editReply(payload);
                        
                        addToolExchangeToHistory(channelId, ownText, `[Converteu ${convInfo.amount} ${convInfo.from} para ${convInfo.to} -> ${resultFormatted}] ${commentText(yuiComment)}`);
                        recordContextTurn('Converti o valor pedido e mostrei a cotação.');
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: CONVERT_CURRENCY - "${amount} ${from} -> ${to}"]`, interaction);
                        return;
                    }
                }
                if (toolData.tool === 'check_game_info') {
                    const gameQuery = toolData.args.game || '';
                    const infoEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('🎮 Executando Ação')
                        .setDescription(`Consultando informações sobre **${gameQuery}**\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Buscando dados do jogo'}*`)
                        .setFooter({ text: 'Yui Games • Tool Use: check_game_info' });
                    await unifiedReply(null, [], [], [infoEmbed]);

                    const gameInfo = await getGameInfoWithSteamFallback(gameQuery);
                    if (!gameInfo || gameInfo.error) {
                        let fallbackText = null;
                        try {
                            const fallbackPrompt = `O usuário perguntou sobre o jogo "${gameQuery}" mas não encontrei dados (RAWG/HowLongToBeat). Responda naturalmente na sua personalidade, de forma curta, dizendo que não achei infos completas e sugira buscar em outra fonte ou usar o search_web. Não use JSON.`;
                            // (DM de qualquer pessoa é privada para a pesquisa: a busca automática do fallback só roda em conversa pública)
                            const fallbackResp = await generateResponse(fallbackPrompt, channelId, { allowSearch: !privateChat, searchPrompt: `pesquise informações sobre o jogo ${gameQuery}`, disableTools: true, guildId, userId, sensitive: sensitiveChat });
                            if (fallbackResp && !isSystemReply(fallbackResp)) fallbackText = fallbackResp;
                        } catch (e) {}
                        // Texto amigável e sem detalhe técnico (gameInfoErrorText). Antes o ramo só guardava a mensagem e dava return:
                        // o usuário ficava apenas com o embed "Executando Ação". Agora a mensagem é ENTREGUE.
                        const errMsg = gameInfoErrorText({ infoError: gameInfo && gameInfo.error, fallbackText, gameQuery });
                        processedResponse = errMsg;
                        await unifiedReply(errMsg);
                        addToolExchangeToHistory(channelId, ownText, errMsg);
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: CHECK_GAME_INFO - "${gameQuery}" -> erro]`, interaction);
                        return;
                    }

                    const fields = [];
                    if (gameInfo.rating != null) fields.push({ name: '⭐ Nota da comunidade', value: `${gameInfo.rating} / 10`, inline: true });
                    if (gameInfo.metacritic != null) fields.push({ name: '🎯 Metacritic', value: `${gameInfo.metacritic}/100`, inline: true });
                    if (gameInfo.genres && gameInfo.genres.length > 0) fields.push({ name: '🎭 Gêneros', value: gameInfo.genres.slice(0, 6).join(', '), inline: false });
                    if (gameInfo.platforms && gameInfo.platforms.length > 0) fields.push({ name: '🖥️ Plataformas', value: gameInfo.platforms.slice(0, 8).join(', '), inline: false });
                    if (gameInfo.released) fields.push({ name: '📅 Lançamento', value: gameInfo.released, inline: true });
                    if (gameInfo.developers && gameInfo.developers.length > 0) fields.push({ name: '🏗️ Desenvolvedora', value: gameInfo.developers.join(', '), inline: true });

                    if (gameInfo.hltb) {
                        const hltbParts = [];
                        if (gameInfo.hltb.mainStory) hltbParts.push(`**Campanha:** ${gameInfo.hltb.mainStory}`);
                        if (gameInfo.hltb.mainExtras) hltbParts.push(`**+ Extras:** ${gameInfo.hltb.mainExtras}`);
                        if (gameInfo.hltb.completionist) hltbParts.push(`**100%:** ${gameInfo.hltb.completionist}`);
                        if (hltbParts.length > 0) fields.push({ name: '⏱️ Tempo médio de jogo', value: hltbParts.join('\n'), inline: false });
                    }

                    const resultEmbed = new EmbedBuilder()
                        .setColor(0x10B981)
                        .setTitle(clampText(`🎮 ${gameInfo.name}`, 256))
                        .setDescription(clampText(gameInfo.description || 'Sem sinopse disponível.', 4000))
                        .addFields(fields.map((f) => ({ ...f, value: clampText(f.value, 1000) })))
                        .setFooter({ text: 'Fontes: RAWG.io & HowLongToBeat • Yui' })
                        .setTimestamp();
                    if (gameInfo.backgroundImage) resultEmbed.setThumbnail(gameInfo.backgroundImage);

                    let yuiComment = gameInfo.rating != null ? `Nota ${gameInfo.rating}/10 na comunidade. Quer que eu detalhe algo específico desse jogo?` : 'Achei essas informações pra você.';
                    try {
                        const commentPrompt = `Você (Yui) acabou de buscar informações do jogo "${gameInfo.name}". Faça um comentário MUITO CURTO (máx 15 palavras), casual e de amiga gamer sobre o jogo. Não use JSON nem ferramentas.`;
                        const rawComment = await generateResponse(commentPrompt, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat, isInternalComment: true });
                        if (rawComment && !isSystemReply(rawComment)) {
                            let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                            const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                            if (jsonMatch) { try { const parsed = JSON.parse(jsonMatch[0]); cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || cleanData; } catch (e) {} }
                            yuiComment = cleanData;
                        }
                    } catch (e) {}

                    const payload = { content: commentText(yuiComment), embeds: [resultEmbed], files: [], allowedMentions: NO_MENTIONS };
                    if (type === 'mention') await replyMessage.edit(payload);
                    else await interaction.editReply(payload);

                    addToolExchangeToHistory(channelId, ownText, `[Consultou info de "${gameInfo.name}"]`);
                    recordContextTurn('Mostrei as informações do jogo pedido.');
                    savePromptToHistory(prompt, userTag, userId, `[TOOL: CHECK_GAME_INFO - "${gameQuery}"]`, interaction);
                    return;
                }

                if (toolData.tool === 'check_pc_compatibility') {
                    const gameQuery = toolData.args.game || '';
                    const inlineCpu = toolData.args.cpu || null;
                    const inlineGpu = toolData.args.gpu || null;
                    const inlineRam = toolData.args.ram || null;

                    const compatEmbed = new EmbedBuilder()
                        .setColor(0x7C3AED)
                        .setTitle('💻 Executando Ação')
                        .setDescription(`Verificando requisitos de **${gameQuery}**\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Comparando specs'}*`)
                        .setFooter({ text: 'Yui Games • Tool Use: check_pc_compatibility' });
                    await unifiedReply(null, [], [], [compatEmbed]);

                    let savedSpecs = null;
                    try {
                        const specsPath = path.join(__dirname, '../data/user_pc_specs.json');
                        if (fs.existsSync(specsPath)) {
                            const allSpecs = JSON.parse(fs.readFileSync(specsPath, 'utf8'));
                            savedSpecs = allSpecs[userId] || allSpecs[userTag] || null;
                        }
                    } catch (e) {}

                    const spec = (value) => (value ? clampText(String(value), 120) : null); // specs vêm da IA/arquivo: curtas no embed
                    const userSpecs = {
                        cpu: spec(inlineCpu || (savedSpecs && savedSpecs.cpu)),
                        gpu: spec(inlineGpu || (savedSpecs && savedSpecs.gpu)),
                        ram: spec(inlineRam || (savedSpecs && savedSpecs.ram))
                    };

                    const steamInfo = await getSteamGameInfo(gameQuery);
                    const reqs = steamInfo && steamInfo.success && steamInfo.pcRequirements ? steamInfo.pcRequirements : null;
                    const specsKnown = userSpecs.cpu || userSpecs.gpu || userSpecs.ram;

if (!specsKnown) {
                        const fields = [];
                        if (reqs && reqs.minimum) {
                            const minParts = [
                                reqs.minimum.os ? `**Sistema:** ${reqs.minimum.os}` : null,
                                reqs.minimum.processor ? `**CPU:** ${reqs.minimum.processor}` : null,
                                reqs.minimum.memory ? `**RAM:** ${reqs.minimum.memory}` : null,
                                reqs.minimum.graphics ? `**GPU:** ${reqs.minimum.graphics}` : null,
                                reqs.minimum.storage ? `**Armazenamento:** ${reqs.minimum.storage}` : null
                            ].filter(Boolean);
                            if (minParts.length > 0) fields.push({ name: '🖥️ Requisitos Mínimos', value: clampText(minParts.join('\n'), 1000), inline: false });
                        }
                        if (reqs && reqs.recommended) {
                            const recParts = [
                                reqs.recommended.os ? `**Sistema:** ${reqs.recommended.os}` : null,
                                reqs.recommended.processor ? `**CPU:** ${reqs.recommended.processor}` : null,
                                reqs.recommended.memory ? `**RAM:** ${reqs.recommended.memory}` : null,
                                reqs.recommended.graphics ? `**GPU:** ${reqs.recommended.graphics}` : null,
                                reqs.recommended.storage ? `**Armazenamento:** ${reqs.recommended.storage}` : null
                            ].filter(Boolean);
                            if (recParts.length > 0) fields.push({ name: '🚀 Requisitos Recomendados', value: clampText(recParts.join('\n'), 1000), inline: false });
                        }

                        const resultEmbed = new EmbedBuilder()
                            .setColor(0xF59E0B)
                            .setTitle(clampText(`💻 Requisitos de ${steamInfo && steamInfo.success ? steamInfo.name : gameQuery}`, 256))
                            .setDescription(fields.length > 0 ? 'Esses são os requisitos. Me conta suas specs (CPU, GPU e RAM) que eu te digo se roda!' : 'Não consegui achar os requisitos técnicos desse jogo pela Steam.')
                            .addFields(fields)
                            .setFooter({ text: 'Fonte: Steam • Yui' })
                            .setTimestamp();

                        const payload = { content: fields.length > 0 ? 'Não sei se seu PC roda sem saber suas specs. Me fala o processador, a placa de vídeo e a RAM que eu comparo!' : 'Não achei requisitos pra esse jogo.', embeds: [resultEmbed], files: [] };
                        if (type === 'mention') await replyMessage.edit(payload);
                        else await interaction.editReply(payload);

                        addToolExchangeToHistory(channelId, ownText, `[Mostrou requisitos de "${gameQuery}"]`);
                        recordContextTurn('Mostrei os requisitos do jogo e pedi as specs do PC para comparar.');
                        savePromptToHistory(prompt, userTag, userId, `[TOOL: CHECK_PC_COMPATIBILITY - "${gameQuery}" -> sem specs]`, interaction);
                        return;
                    }
const reqsForCompare = reqs || { minimum: {}, recommended: {} };
                    const comparison = compareSpecs(userSpecs, reqsForCompare);
                    const verdictText = formatVerdict(comparison);

                    const compFields = [];
                    compFields.push({ name: '🖥️ Requisitos Mínimos', value: [
                        reqsForCompare.minimum.os ? `**Sistema:** ${reqsForCompare.minimum.os}` : null,
                        reqsForCompare.minimum.processor ? `**CPU:** ${reqsForCompare.minimum.processor}` : null,
                        reqsForCompare.minimum.memory ? `**RAM:** ${reqsForCompare.minimum.memory}` : null,
                        reqsForCompare.minimum.graphics ? `**GPU:** ${reqsForCompare.minimum.graphics}` : null,
                        reqsForCompare.minimum.storage ? `**Armazenamento:** ${reqsForCompare.minimum.storage}` : null
                    ].filter(Boolean).join('\n') || 'Não disponível', inline: false });
                    if (reqsForCompare.recommended) {
                        compFields.push({ name: '🚀 Requisitos Recomendados', value: [
                            reqsForCompare.recommended.os ? `**Sistema:** ${reqsForCompare.recommended.os}` : null,
                            reqsForCompare.recommended.processor ? `**CPU:** ${reqsForCompare.recommended.processor}` : null,
                            reqsForCompare.recommended.memory ? `**RAM:** ${reqsForCompare.recommended.memory}` : null,
                            reqsForCompare.recommended.graphics ? `**GPU:** ${reqsForCompare.recommended.graphics}` : null,
                            reqsForCompare.recommended.storage ? `**Armazenamento:** ${reqsForCompare.recommended.storage}` : null
                        ].filter(Boolean).join('\n') || 'Não disponível', inline: false });
                    }

                    for (const field of compFields) field.value = clampText(field.value, 1000); // cada campo do embed aceita até 1024
                    const verdictColor = comparison.verdict === 'comfortable' ? 0x22C55E : comparison.verdict === 'minimum' ? 0x3B82F6 : comparison.verdict === 'struggling' ? 0xF59E0B : 0xEF4444;
                    const resultEmbed = new EmbedBuilder()
                        .setColor(verdictColor)
                        .setTitle(clampText(`💻 ${steamInfo && steamInfo.success ? steamInfo.name : gameQuery} no seu PC`, 256))
                        .setDescription(`**Veredito: ${verdictText}**\n\n**Suas specs:** CPU ${userSpecs.cpu || 'não informado'} • GPU ${userSpecs.gpu || 'não informado'} • RAM ${userSpecs.ram || 'não informado'}`)
                        .addFields(compFields)
                        .setFooter({ text: 'Fonte: Steam • Yui' })
                        .setTimestamp();
let yuiComment = `Teu PC **${verdictText}** com esse jogo. Quer que eu veja outro?`;
                    try {
                        const commentPrompt = `Você (Yui) acabou de comparar as specs de um usuário com o jogo "${gameQuery}" e o veredito foi: ${verdictText}. Faça um comentário MUITO CURTO (máx 15 palavras), casual e de amiga gamer. Não use JSON nem ferramentas.`;
                        const rawComment = await generateResponse(commentPrompt, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat, isInternalComment: true });
                        if (rawComment && !isSystemReply(rawComment)) {
                            let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                            const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                            if (jsonMatch) { try { const parsed = JSON.parse(jsonMatch[0]); cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || cleanData; } catch (e) {} }
                            yuiComment = cleanData;
                        }
                    } catch (e) {}

                    const payload = { content: commentText(yuiComment), embeds: [resultEmbed], files: [], allowedMentions: NO_MENTIONS };
                    if (type === 'mention') await replyMessage.edit(payload);
                    else await interaction.editReply(payload);

                    addToolExchangeToHistory(channelId, ownText, `[Comparou specs com "${gameQuery}" -> ${verdictText}]`);
                    recordContextTurn('Comparei as specs do PC com os requisitos do jogo pedido e mostrei o veredito.');
                    savePromptToHistory(prompt, userTag, userId, `[TOOL: CHECK_PC_COMPATIBILITY - "${gameQuery}" -> ${verdictText}]`, interaction);
                    return;
                }

                if (toolData.tool === 'generate_image') {
                    const imagePrompt = typeof toolData.args.prompt === 'string' ? toolData.args.prompt : '';
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
                        logger.warn(`[GenerateImage] Bloqueado pedido NSFW (${imagePrompt.length} caracteres)`);
                        const scoldPrompt = `O usuário te pediu para gerar uma imagem com conteúdo NSFW/impróprio: "${clampText(imagePrompt, 100, { ellipsis: '' })}". Dê uma bronca curta e natural nele, na sua personalidade Yui, sem gerar a imagem. Seja direta, sem rodeios, pode ser um pouco irônica.`;
                        const scoldResponse = await generateResponse(scoldPrompt, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat });
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
                            .setDescription(`Gerando imagem com IA\n\n💬 **Prompt:**\n> *"${clampText(imagePrompt, 100)}"*\n\n🧠 **Pensamento da IA:**\n> *${toolData.thought || 'Criando ilustração'}*`)
                            .setFooter({ text: 'Yui Art • Tool Use: generate_image' });
                        await unifiedReply(null, [], [], [imageEmbed]);
                        try {
                            const imageData = await generateImage(imagePrompt, imageNegative, width, height);
                            if (imageData && (imageData.imageUrl || imageData.localFilePath)) {
                                let yuiComment = 'olha, ficou bem interessante isso daí...';
                                try {
                                    logger.info('[ImageHandler] Pedindo comentário para a Yui sobre a imagem gerada.');
                                    const commentPrompt = `Você (Yui) acabou de gerar uma imagem com o prompt: "${imagePrompt}". Faça um comentário MUITO CURTO (máximo 15 palavras), natural e casual sobre essa ideia/resultado. NÃO use JSON. NÃO use ferramentas. Apenas texto puro. Seja direta e use seu estilo de fala.`;
                                    const rawComment = await generateResponse(commentPrompt, channelId, {
                                        allowSearch: false,
                                        disableTools: true,
                                        guildId,
                                        sensitive: sensitiveChat,
                                        isInternalComment: true
                                    });
                                    if (rawComment && !isSystemReply(rawComment)) {
                                        let cleanData = rawComment.replace(/\n-# .*$/gm, '').trim();
                                        const jsonMatch = cleanData.match(/\{[\s\S]*\}/);
                                        if (jsonMatch) {
                                            try {
                                                const parsed = JSON.parse(jsonMatch[0]);
                                                cleanData = parsed.response || parsed.content || parsed.text || parsed.reply || parsed.resposta || parsed.mensagem || (Object.keys(parsed).length === 1 ? Object.values(parsed)[0] : cleanData);
                                            } catch (e) {}
                                        }
                                        yuiComment = cleanData;
                                        logger.info(`[ImageHandler] Comentário gerado (${String(yuiComment).length} caracteres)`);
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
                                    .setFooter({ text: `Prompt: ${clampText(imagePrompt, 100)} • by oBraga` })
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
                                const supportBtnRow = new ActionRowBuilder().addComponents(
                                    new ButtonBuilder().setLabel('Apoiar projeto').setURL('https://bio.site/oBraga').setStyle(ButtonStyle.Link).setEmoji('💖')
                                );
                                const payload = { content: commentText(yuiComment), embeds: [imageEmbed], files: imageFiles, components: [supportBtnRow], allowedMentions: NO_MENTIONS };
                                if (type === 'mention') await replyMessage.edit(payload);
                                else await interaction.editReply(payload);
                                addToolExchangeToHistory(channelId, ownText, `[Gerou imagem via ${imageData.modelName}] ${commentText(yuiComment)}`);
                                recordContextTurn('Gerei uma imagem a partir do pedido e enviei.');
                                savePromptToHistory(prompt, userTag, userId, `[TOOL: GENERATE_IMAGE - "${imagePrompt}"]`, interaction);
                                return;
                            } else {
                                processedResponse = '❌ Não consegui gerar a imagem agora. Pode ser que o serviço esteja lotado, ou acabou a quota, tente novamente mais tarde!';
                            }
                        } catch (imgError) {
                            logger.warn(`[GenerateImage Tool] Erro: ${scrubLogText(imgError?.message, 150)}`);
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
                                addBan('user', userId, clampText(String(reason || 'Violação dos Termos detectada pela IA Yui.'), 300));
                                logger.warn(`[IA_AUTOMOD] Usuário (${userId}) banido pela IA. Severidade: ${scrubLogText(String(severity ?? 'n/d'), 20)}. Motivo com ${String(reason ?? '').length} caracteres.`);
                                const banEmbed = new EmbedBuilder()
                                    .setColor(0xE11D48)
                                    .setTitle('🚨 DISPOSITIVO DE SEGURANÇA ACIONADO — VOCÊ FOI BANIDO!')
                                    .setDescription(`🛑 **UM BLOQUEIO PERMANENTE E IMEDIATO FOI APLICADO.**\n\nO sistema de inteligência da Yui analisou o contexto desta conversa e identificou uma conduta que viola gravemente os Termos de Uso.\n\n**DETALHES DO BANIMENTO:**\n- **ALVO PENALIZADO:** Seu perfil de usuário (Banido Globalmente)\n- **STATUS:** 🔴 TOTALMENTE BANIDO E BLOQUEADO.\n\nO acesso aos serviços foi completamente revogado. Qualquer nova tentativa de burlar a segurança agravará a punição.\n\nSe você julga que isso é um erro, utilize o botão de apelação abaixo.\n\n---\n✨ **Dica:** Quer a Yui sem filtros? Hospede sua própria versão!\n🚀 **GitHub:** [MauroBragaFilho/Yui](https://github.com/MauroBragaFilho/Yui)`)
                                    .setFooter({ text: 'Yui AI AutoMod • by oBraga' })
                                    .setTimestamp();
                                const githubButton = new ButtonBuilder()
                                    .setLabel('Página do Projeto')
                                    .setURL('https://github.com/MauroBragaFilho/Yui')
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
            // Só é falha da FERRAMENTA se o JSON da IA já tinha sido lido; JSON malformado segue com a frase de antes (C8). Só nome e mensagem curtos no log.
            toolBlockFailed = toolData !== null;
            if (toolBlockFailed) {
                logger.warn(`[MCP TOOL] Falha ao executar a ferramenta '${scrubLogText(String(toolData?.tool ?? 'n/d'), 40)}' (${scrubLogText(String(e?.name ?? 'Error'), 40)}): ${scrubLogText(e?.message, 200)}`);
            } else {
                logger.warn(`[MCP TOOL] JSON da IA ilegível (${scrubLogText(String(e?.name ?? 'Error'), 40)}) em ${String(rawResponse ?? '').length} caracteres.`);
            }
        }
        // O texto do agente de pesquisa já saiu limpo dele (cleanAnswer): stripThinking e a caça a "[Tool Use:" apagariam ou trocariam por erro um parágrafo que só CITA uma
        // ferramenta (uma página pode escrever isso). Só o texto do modelo passa por aqui.
        if (processedResponse && !researchHandled) {
            processedResponse = stripThinking(processedResponse);
        }
        const leakedToolText = !researchHandled && Boolean(processedResponse) && (processedResponse.includes('[Tool Use:') || thoughtLeakRegex.test(processedResponse));
        if (!researchHandled && toolBlockFailed && processedResponse && (leakedToolText || looksLikeToolJson(processedResponse))) {
            // A resposta ainda é o JSON da ferramenta: ela falhou ao executar. A frase conta isso, em vez de acusar o formato do MCP.
            processedResponse = TOOL_FAILED_TEXT;
        } else if (leakedToolText) {
            logger.warn(`[SECURITY BLOCK] Bloqueado vazamento de Tool Use/JSON Raw (${processedResponse.length} caracteres)`);
            processedResponse = "⚠️ **Erro de Processamento:** A IA tentou usar uma ferramenta mas o formato do MCP saiu inválido, isso é normal, não é um bug. Tente novamente ou use os comandos /buscar_jogo, /baixar_musica ou /baixar_video";
        }
        if (options && options.radioMode) {
            const cleanPrompt = (prompt || '').toLowerCase().trim();
            let fallbackTool = null;
            let fallbackArgs = {};

            if (/^(para|pare|parar|pause|pausa|desliga|stop|silencio|silêncio|cancela|desativa)$/i.test(cleanPrompt) || cleanPrompt.includes('para') || cleanPrompt.includes('pare') || cleanPrompt.includes('desliga')) {
                fallbackTool = 'radio_pause_resume';
            } else if (/^(pula|passa|proxima|próxima|next|skip)$/i.test(cleanPrompt) || cleanPrompt.includes('pula') || cleanPrompt.includes('passa')) {
                fallbackTool = 'radio_next_track';
            } else if (/^(volta|anterior|back)$/i.test(cleanPrompt) || cleanPrompt.includes('volta') || cleanPrompt.includes('anterior')) {
                fallbackTool = 'radio_prev_track';
            } else if (/^(sai da call|desconecta da call|encerra o rádio|tchau yui)$/i.test(cleanPrompt) || cleanPrompt.includes('sai da call') || cleanPrompt.includes('desconecta da call')) {
                fallbackTool = 'radio_leave_call';
            } else if (/^(fila|lista|playlist)$/i.test(cleanPrompt)) {
                fallbackTool = 'radio_show_queue';
            } else if (/^(toca|coloca|play|bota)/i.test(cleanPrompt)) {
                const match = cleanPrompt.match(/^(toca|coloca|play|bota)\s*(.*)$/i);
                const q = (match && match[2]?.trim()) ? match[2].trim() : 'músicas populares';
                fallbackTool = 'radio_play_music';
                fallbackArgs = { query: q };
            }

            if (fallbackTool) {
                const radioGuildId = options.guildId || interaction.guildId;
                const radioTextChannel = interaction.radioTextChannel || interaction.channel;
                const radioUserId = interaction.radioUserId || userId;
                const radioResult = await handleRadioMCPCall(
                    fallbackTool,
                    fallbackArgs,
                    radioUserId,
                    radioGuildId,
                    radioTextChannel,
                    interaction.radioClient || null
                );
                if (radioResult) await unifiedReply(radioResult);
                savePromptToHistory(prompt, userTag, userId, `[TOOL: DETERMINISTIC_${fallbackTool.toUpperCase()}]`, interaction);
                return;
            } else {
                return;
            }
        }

        const cleanPromptLower = (prompt || '').toLowerCase().trim();
        const hasUrl = /https?:\/\//i.test(cleanPromptLower);
        const isAskingYui = /(?:voc[eê]|vc|yui|bot)\s+t[aá]\s+(?:me\s+)?(escutando|ouvindo)|t[aá]\s+me\s+(escutando|ouvindo)|t[aá]\s+ouvindo\s+(?:a\s+gente|n[oó]s)/i.test(cleanPromptLower);
        const matchesCurrentMusicIntent = !hasUrl && !isAskingYui && (
            /(?:oq|o\s+que|qual\s+m[uú]sica|baixa|puxa|identifica|salva)\s+.*(?:eu\s+t[oô]|eu\s+estou)\s+(escutando|ouvindo)/i.test(cleanPromptLower) ||
            /(?:oq|o\s+que|qual\s+m[uú]sica)\s+(?:eu\s+)?t[oô]\s+(escutando|ouvindo)/i.test(cleanPromptLower) ||
            /baixa\s+.*(?:do\s+meu\s+status|do\s+meu\s+spotify|que\s+eu\s+t[oô]\s+(?:escutando|ouvindo))/i.test(cleanPromptLower) ||
            /(?:minha\s+m[uú]sica\s+do\s+status|m[uú]sica\s+do\s+meu\s+status)/i.test(cleanPromptLower)
        );
        // Voz sem ferramentas liberadas: este atalho (baixar a música do status) também é uma ferramenta e não roda por voz.
        const musicShortcutVoiceBlocked = voiceToolBlocked('get_current_music', options);
        // Pedido com as ferramentas desligadas (o log de terceiros do /chat_resumo, o texto de um anexo lido): o atalho é uma ferramenta e o
        // prompt desses pedidos traz texto de outras pessoas, que não pode acioná-lo.
        const musicShortcutOff = !musicShortcutVoiceBlocked && options.disableTools === true;
        const isCurrentMusicIntent = matchesCurrentMusicIntent && !musicShortcutVoiceBlocked && !musicShortcutOff;
        if (matchesCurrentMusicIntent && musicShortcutVoiceBlocked) processedResponse = VOICE_TOOL_REFUSAL;

        if (isCurrentMusicIntent) {
            const discordClient = getDiscordClient();
            const musicInfo = await getCurrentMusicFromUser(userId, discordClient);
            if (!musicInfo.success) {
                let msg = `🎵 ${musicInfo.message}`;
                if (musicInfo.helpInstructions || musicInfo.reason === 'no_presence') {
                    msg += '\n\n> **Como ativar:**\n> Vá em **Configurações do Discord → Privacidade e Segurança → Atividade de Status** e ative a opção **"Exibir atividade atual como mensagem de status"**.';
                }
                await unifiedReply(msg);
                recordContextTurn('Não consegui identificar a música que você está ouvindo agora.');
                savePromptToHistory(prompt, userTag, userId, `[TOOL: DETERMINISTIC_GET_CURRENT_MUSIC - FAIL:${musicInfo.reason}]`, interaction);
                return;
            }
            const infoEmbed = new EmbedBuilder()
                .setColor(0x1DB954)
                .setTitle(`${musicInfo.platformEmoji} Música Identificada`)
                .setDescription(`**${musicInfo.title}**\n🎤 ${musicInfo.artist}${musicInfo.album ? `\n💿 ${musicInfo.album}` : ''}`)
                .addFields({ name: 'Plataforma', value: musicInfo.platformLabel, inline: true })
                .setFooter({ text: 'Yui Music' })
                .setTimestamp();
            if (musicInfo.coverUrl) infoEmbed.setThumbnail(musicInfo.coverUrl);
            const musicUserId = userId;
            if (!canBypass(musicUserId) && isUserBusy(musicUserId)) {
                await unifiedReply(busyMessage(userId));
                return;
            }
            lockUser(musicUserId);
            try {
                const keepEmbed = config.keepMusicEmbed !== false;
                const downloadingEmbed = EmbedBuilder.from(infoEmbed);
                if (keepEmbed) {
                    downloadingEmbed.addFields({ name: 'Status', value: '⏳ Baixando música, aguarde...', inline: true });
                }
                await unifiedReply(null, [], [], [downloadingEmbed]);
                const musicResult = await handleMusicSearchAndDownload(
                    musicInfo.searchQuery,
                    null,
                    { user: interaction.user, userId, userTag, guild: interaction.guild, infoEmbed: keepEmbed ? infoEmbed : null, forceDownload: true }
                );
                if (musicResult.error) {
                    await unifiedReply(`❌ ${musicResult.error}`);
                } else if (musicResult.isAmbiguous) {
                    setContextLine('Mostrei opções de músicas para você escolher.');
                    const noMatchEmbed = EmbedBuilder.from(infoEmbed)
                        .spliceFields(0, 25)
                        .addFields(
                            { name: 'Plataforma', value: musicInfo.platformLabel, inline: true },
                            { name: 'Aviso', value: '⚠️ Não encontrei um arquivo compatível. Escolha abaixo:', inline: false }
                        );
                    await unifiedReply(musicResult.textList, [], musicResult.components, [noMatchEmbed]);
                } else if (musicResult.success) {
                    setContextLine('Baixei a música que você está ouvindo e enviei o arquivo.');
                    // O cartão que acompanha o MP3 não indica a origem (o campo "Plataforma" saiu daqui; V-1): só a faixa identificada.
                    const finalEmbed = EmbedBuilder.from(infoEmbed).spliceFields(0, 25);
                    if (musicResult.lowConfidence) {
                        finalEmbed.addFields({ name: 'Aviso', value: '⚠️ Correspondência baixa — pode não ser o arquivo exato.', inline: false });
                    }
                    // Plano B (YouTube): musicDeliveryText troca a frase pelo aviso do plano B; sem plano B, a frase de sempre.
                    const deliveredText = musicDeliveryText(musicResult, `✅ \`${musicLabel(musicResult.track)}\``);
                    if (keepEmbed) {
                        await unifiedReply(deliveredText, [musicResult.attachment], [], [finalEmbed]);
                    } else {
                        await unifiedReply(deliveredText, [musicResult.attachment]);
                    }
                    await explainTooLargeUpload();
                    if (typeof musicResult.cleanup === 'function') musicResult.cleanup();
                }
            } catch (err) {
                logger.warn(`[GetCurrentMusic] Erro: ${scrubLogText(err?.message, 150)}`);
                await unifiedReply(`❌ ${getMediaUserMessage(err, 'Não consegui baixar a música agora. Tente de novo em instantes.')}`);
            } finally {
                unlockUser(musicUserId);
            }
            recordContextTurn('O download da música falhou.');
            savePromptToHistory(prompt, userTag, userId, `[TOOL: DETERMINISTIC_GET_CURRENT_MUSIC - ${musicInfo.title}]`, interaction);
            return;
        }

        // ── Agente de pesquisa: rede de segurança (Porta C e a pesquisa por código para provedores sem ferramentas) ─────────────────────────────────────
        // toolRan: alguma ferramenta além de generate_reply rodou (search_web não faz `return`) ou o agente já respondeu: o texto não é promessa vazia.
        let toolRan = researchHandled || Boolean(toolData && typeof toolData.tool === 'string' && toolData.tool && toolData.tool !== 'generate_reply' && !(searchSkipped && toolData.tool === 'search_web'));
        if (researchCfg.enabled && researchCfg.guard !== 'off' && processedResponse && !toolRan && !options.radioMode) {
            const privateOk = privateChat && privateSearchAllowed(researchCfg.privateSearch, { isOwner: isOwnerId(userId) });
            // Porta C: a resposta só PROMETE pesquisar ou voltar ("Vou buscar dados...") e nenhuma pesquisa rodou. O plano diz o que fazer: pesquisar (com a consulta do
            // pedido ou da própria promessa), rotear para a cotação, recusar com honestidade, perguntar o assunto, pedir a resposta final ao modelo ou deixar passar.
            // Só vale com chamada DIRETA à Yui e com a fala do próprio autor (searchPrompt); conversa espontânea nunca pesquisa nem gasta cota.
            // Voz: o disableTools de um pedido de voz é FORÇADO pela trava de voz (shouldBlockToolForVoice, no começo desta função), não pedido por quem chamou; se ele fosse repassado
            // o plano devolveria "sem pesquisa" antes de olhar a voz, e a promessa falada cairia na guarda final em vez da recusa honesta de voz. Fora da voz vale o que o chamador pediu.
            let rPlan = recoveryPlan({
                reply: processedResponse, userText: ownQuestion, sensitive: privateChat, privateSearch: privateOk, searchAvailable, voice: isVoice,
                direct: directToYui, radioMode: options.radioMode === true, disableTools: options.disableTools === true && !isVoice, thirdPartyPrompt: options.thirdPartyPrompt === true
            });
            // Pesquisa por código para quem NÃO tem ferramentas nativas (Groq, HF, Cloudflare, Pollinations, Horde, Gateway ou o Local sem chave): num pedido
            // EXPLÍCITO e estrito ele quase nunca escreve o JSON de search_web e responde "de cabeça". O código pesquisa (no privado, só se o YUI_PRIVATE_SEARCH liberou).
            if (rPlan.action === 'none' && explicitReq.explicit && searchAvailable && genMeta.nativeTools === false && (!privateChat || privateOk)) {
                rPlan = { action: 'search', query: explicitReq.query, private: privateChat, reason: 'pedido explícito (provedor sem ferramentas)' };
            }
            if (rPlan.action !== 'none') {
                if (researchCfg.guard === 'observe') {
                    // Modo observe: só registra metadados (ação e motivo), sem mexer na resposta.
                    logger.info(`[Pesquisa] guarda (observe): acao=${rPlan.action} motivo=${rPlan.reason}`);
                } else {
                    logger.info(`[Pesquisa] guarda: acao=${rPlan.action} motivo=${rPlan.reason}`);
                    if (rPlan.action === 'search') {
                        const found = await runResearchFor({
                            question: ownQuestion, query: rPlan.query, intent: rPlan.intent, userId, sensitive: privateChat,
                            channelId, guildId: options.guildId || guildId, progress: researchProgress
                        });
                        processedResponse = found.text;
                        researchHandled = true;
                        webSearchUsed = true;
                        researchHistoryLine = found.historyLine;
                        researchPrivate = found.private === true;
                    } else if (rPlan.action === 'route') {
                        processedResponse = await currencyAnswerText(rPlan.args);
                        researchHandled = true;
                    } else if (rPlan.action === 'refuse' || rPlan.action === 'ask') {
                        processedResponse = rPlan.message;
                        researchHandled = true;
                    } else if (rPlan.action === 'regenerate' && ownQuestion) {
                        // Pede UMA vez a resposta final (sem ferramentas, com prazo). Se ainda vier promessa, a guarda final (Porta D) troca pelo aviso.
                        const regeneratedText = await askFinalAnswer();
                        if (regeneratedText) processedResponse = regeneratedText;
                    }
                    toolRan = researchHandled || toolRan;
                }
            }
        }

        // Última rede contra JSON de ferramenta cru: {"tool":"search_game"} sem argumentos, {"reply":""}, {}, JSON de search_web cortado ou só uma cerca ``` nunca vão ao
        // usuário (o despachante só trata JSON completo e com argumentos). Texto do agente de pesquisa e da rádio não passam por aqui.
        // (YUI_RESEARCH_GUARD: on troca; observe só registra; off deixa como era)
        let toolJsonReplaced = false;
        if (processedResponse && !researchHandled && !options.radioMode && researchCfg.guard !== 'off' && isRawToolLeak(processedResponse)) {
            if (researchCfg.guard === 'observe') {
                logger.info(`[Parser] (observe) a resposta é JSON de ferramenta cru ou vazio (${processedResponse.length} caracteres): seria trocada pelo aviso`);
            } else {
                logger.warn(`[Parser] a resposta ainda era JSON de ferramenta cru ou vazio (${processedResponse.length} caracteres): trocada pelo aviso`);
                processedResponse = TOOL_FAILED_TEXT;
                toolJsonReplaced = true;
            }
        }

        if (processedResponse) {
            const SPEAKER_PREFIX = /^(voc[eê]\s*\(yui\)|yui|you\s*\(yui\)|assistant|assistente)[:\s]+/i;
            processedResponse = processedResponse.replace(SPEAKER_PREFIX, '').trim();
            const userBareText = (options.searchPrompt || '').replace(/[-# ]+ctx.*$/si, '').trim().toLowerCase().substring(0, 80);
            const responseLower = processedResponse.toLowerCase().substring(0, 80);
            if (!researchHandled && userBareText.length > 10 && !antiEchoExempt(options.searchPrompt) && responseLower.startsWith(userBareText.substring(0, Math.min(userBareText.length, 40)))) {
                logger.warn('[ANTI-ECO] Resposta inicia com eco do usuário — descartando e regenerando.');
                processedResponse = await generateResponse(`(responda de forma diferente à mensagem): ${options.searchPrompt || prompt}`, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat, voice: voiceSpeak });
            }
            const lastAssistantEntries = getHistory(channelId, { sensitive: sensitiveChat }).filter(h => h.role === 'assistant').slice(-2);
            if (!researchHandled && lastAssistantEntries.length > 0) {
                const lastClean = lastAssistantEntries[lastAssistantEntries.length - 1].content?.replace(/\n-# .*$/gm, '').trim().toLowerCase() || '';
                const curClean = processedResponse.replace(/\n-# .*$/gm, '').trim().toLowerCase();
                // (a recusa fixa de voz, repetida em seguida, continua sendo a mesma frase: não se regenera)
                if (lastClean.length > 15 && curClean === lastClean && processedResponse !== VOICE_TOOL_REFUSAL) {
                    logger.warn('[ANTI-REPEAT] Resposta idêntica à anterior — descartando e regenerando.');
                    processedResponse = await generateResponse(`(responda de forma diferente, com outras palavras): ${options.searchPrompt || prompt}`, channelId, { allowSearch: false, disableTools: true, guildId, sensitive: sensitiveChat, voice: voiceSpeak });
                }
            }
            // Histórico da conversa: só a fala do próprio autor (sem ela, ex.: /chat_resumo, não grava nada).
            if (ownText) addToHistory(channelId, 'user', clampText(ownText, 300, { ellipsis: '' }));
            const floodSingle = /(.)\1{40,}/;
            const floodAlternating = /(.{1,3})\1{20,}/;
            if (floodSingle.test(processedResponse) || floodAlternating.test(processedResponse)) {
                logger.warn('[ANTI-FLOOD] Repetição excessiva detectada — colapsando.');
                processedResponse = processedResponse
                    .replace(/(.)\1{15,}/g, (_, ch) => ch.repeat(6))
                    .replace(/(.{1,3})\1{10,}/g, (_, pat) => pat.repeat(4));
            }
            // Sem corte silencioso: o envio divide a resposta em partes ou manda o texto completo em anexo (longReply.js).
            // Memória: SÓ a fala do próprio autor (nunca o log de terceiros do /chat_resumo nem o texto sem searchPrompt).
            // Roda ANTES do envio para saber se algo foi gravado de verdade (a promessa "anotei" só vale nesse caso).
            // Voz: o divisor de respostas longas não vale; o texto que vai ao chat é limitado (corte em fim de frase). O que será FALADO o
            // TTS decide depois, sobre o texto entregue.
            if (isVoice) processedResponse = clipForChat(processedResponse, 1900);
            // Voz: a transcrição é fala de terceiros ouvida por todos na call; nunca vira memória.
            const captureText = isVoice ? null : memoryCaptureText({ radioMode: options.radioMode === true, searchPrompt: options.searchPrompt, prompt, thirdPartyPrompt: options.thirdPartyPrompt === true, isVoice: interaction?.isVoice === true });
            const savedMemories = captureText ? captureFromUserText(coreCtx, captureText) : 0;
            // A Yui não envia DM, não agenda e não guarda listas fora da memória: promessa dessas sai com aviso fixo.
            // Porta D — guarda final: uma resposta que ainda é SÓ promessa ("Vou pesquisar isso!") sem nenhuma ação feita nunca vai ao usuário. Vira um pedido de desculpas
            // que contém "Desculpe, tive um erro" (marcador que o histórico e o contexto já tratam como erro da IA, então a promessa não é guardada). Ofertas e
            // "já volto kkk" solto passam. YUI_RESEARCH_GUARD=observe só registra metadados; off desliga.
            let guardReplaced = false; // a guarda final trocou a promessa pelo aviso: no histórico em RAM isso conta como "erro da ia", nunca como fala da Yui
            if (researchCfg.guard !== 'off') {
                const guardInput = { hadAction: toolRan, userNeedsAnswer: directToYui && userNeedsAnswer(ownQuestion) };
                if (researchCfg.guard === 'observe') {
                    const seen = inspectFinalGuard(processedResponse, guardInput);
                    if (seen.replace) logger.info(`[Pesquisa] guarda final (observe): trocaria a resposta (motivo=${seen.reason} tipo=${seen.kind ?? '-'} forca=${seen.strength ?? '-'})`);
                    else if (seen.trim) logger.info(`[Pesquisa] guarda final (observe): tiraria a promessa que fecha a resposta (tipo=${seen.kind ?? '-'} forca=${seen.strength ?? '-'})`);
                } else {
                    const guarded = finalGuardDetailed(processedResponse, guardInput);
                    if (guarded.action === 'replace') {
                        logger.info('[Pesquisa] guarda final: a resposta era só uma promessa e foi trocada pelo aviso');
                        guardReplaced = true;
                    } else if (guarded.action === 'trim') {
                        logger.info('[Pesquisa] guarda final: a resposta fechava com uma promessa de pesquisa; só essa frase saiu');
                    }
                    processedResponse = guarded.text;
                }
            }
            processedResponse = applyPromiseNotice(processedResponse, { savedSomething: savedMemories > 0 });
            const sentMessage = await unifiedReply(processedResponse);
            const delivery = unifiedReply.lastDelivery || { ok: false, mode: 'failed', parts: 1, sentParts: 0, durationMs: 0 };
            // [TTS-HOOK] Fala da resposta SÓ depois da entrega confirmada no chat (rastreabilidade: o texto escrito, com a menção de quem
            // pediu, sempre existe). Sem await: a síntese roda em segundo plano e nunca atrasa nem derruba a resposta. Só item de voz.
            if (voiceSpeak && delivery.ok && sentMessage) {
                try {
                    speakVoiceReply({ guildId, userId, text: processedResponse, transcript: options.voiceTranscript, sensitive: coreCtx.memoryScope === 'personal', requestedAt: options.voiceRequestedAt, fromVoice: true });
                } catch (_) { /* a fala nunca derruba a resposta de texto */ }
            }
            // PONTO "APÓS ENTREGA" do histórico: a resposta só entra no buffer se foi entregue, e em cópia aparada
            // (não o texto inteiro de 20 mil caracteres). Se o envio falhou, fica o marcador de erro.
            if (ownText) {
                // Pesquisa: no histórico entra só a linha curta do agente (nunca a promessa nem o texto derivado da web; no privado, uma linha neutra).
                // (a guarda final trocou a promessa pelo aviso: no histórico isso vale "erro da ia", nunca a fala do aviso)
                addToHistory(channelId, 'assistant', delivery.ok ? historyCopy((guardReplaced || toolJsonReplaced) ? ERROR_MARKER : (researchHistoryLine ?? processedResponse), { parts: delivery.parts }) : 'erro da ia');
                recordMainExchange(processedResponse, delivery, { webSearchUsed, genMeta });
            }
            // Uma linha por entrega, só metadados (nunca o conteúdo).
            logger.info(formatDeliveryLog({
                chars: processedResponse.length,
                parts: delivery.parts,
                sentParts: delivery.sentParts,
                mode: delivery.mode,
                ok: delivery.ok,
                channelKind: guildId ? 'servidor' : 'DM',
                durationMs: Date.now() - startTime,
                deliveryMs: delivery.durationMs,
                provider: genMeta.provider,
                model: genMeta.model,
                finishReason: genMeta.finishReason,
                continuations: genMeta.continuations ?? 0
            }));
            // Pesquisa em conversa PRIVADA: o resultado (texto derivado da web, a pedido de alguém na DM ou no app) não é gravado no historico.txt; entra só a linha neutra.
            savePromptToHistory(promptForDiskHistory(prompt, { thirdPartyPrompt: options.thirdPartyPrompt === true }), userTag, userId, researchPrivate ? (researchHistoryLine || 'Pesquisei na web a pedido do usuário (conversa privada) e respondi.') : processedResponse, interaction);

        }

    } catch (error) {
        // logger (não console): a tarefa roda o node em janela oculta e o console se perde; o log de arquivo guarda só código e mensagem limpa.
        logger.error(`[Fila] Erro ao processar o pedido (tipo=${type}, código=${error?.code || error?.response?.status || 'n/d'}): ${scrubLogText(error?.message, 200)}`);
        addToHistory(channelId, 'assistant', 'erro da ia');
        await unifiedReply('⚠️ Desculpe, tive um erro ao processar seu pedido. Tente novamente.');
        recordErrorExchange(unifiedReply.lastDelivery);
    } finally {
        setTimeout(runQueueSafely, 1000);
    }
}
// processQueue sem await: uma exceção ANTES do try do item (ou dentro do próprio processQueue) virava "unhandled rejection" e deixava isProcessing preso
// (nenhum pedido seguinte era processado). Aqui a fila é liberada e o próximo item é agendado; o item que falhou já saiu da fila (sem laço).
function runQueueSafely() {
    let pending;
    try { pending = processQueue(); } catch (err) { pending = Promise.reject(err); }
    Promise.resolve(pending).catch((err) => {
        logger.error(`[Fila] A fila falhou fora do tratamento do item (a fila foi liberada): ${scrubLogText(err?.message, 160)}`);
        if (processingQueue.length > 0) {
            // Ainda há gente esperando: a fila continua "ocupada" até o próximo ciclo. Com isProcessing falso, um pedido novo dentro desse 1 s abria um SEGUNDO consumidor
            // (o addToQueue chama runQueueSafely quando não está processando) e o temporizador abria outro: itens rodando ao mesmo tempo.
            isProcessing = true;
            notifyQueueUpdate();
            const timer = setTimeout(runQueueSafely, 1000);
            if (typeof timer.unref === 'function') timer.unref();
        } else {
            isProcessing = false;
            notifyQueueUpdate();
        }
    });
}
// ── Limites da fila da IA (TG-10/C10) ──────────────────────────────────────────────────────────────────────────────
// A fila é serial e antes não tinha teto: um usuário (ou uma enxurrada de menções) podia segurar todos os outros.
const QUEUE_REFUSAL_TEXT = 'Você já tem pedidos na fila, ou a fila está cheia. Espere a resposta e tente de novo.';
const QUEUE_NOTICE_COOLDOWN_MS = 30_000; // no máximo um aviso de recusa a cada 30 s por usuário
const QUEUE_NOTICE_DELETE_MS = 10_000;   // o aviso some sozinho
const queueNoticeAt = new Map();         // usuário -> instante do último aviso de recusa
const queueMax = (env = process.env) => envInt(env?.YUI_QUEUE_MAX, 30, 1, 1000);
const queueMaxPerUser = (env = process.env) => envInt(env?.YUI_QUEUE_MAX_PER_USER, 2, 1, 100);

/**
 * A fila recusa este pedido? Sim quando já há YUI_QUEUE_MAX (30) pedidos esperando ou YUI_QUEUE_MAX_PER_USER (2) deste usuário.
 * Voz e rádio ficam de fora (têm limitador e prazo próprios). O item que está sendo processado já saiu da fila e não conta.
 * Devolve { total, mine } ou null.
 */
const exemptFromQueueLimit = (options) => options?.voice === true || options?.radioMode === true;
function queueRefusalFor(userId, options, env = process.env) {
    if (exemptFromQueueLimit(options)) return null;
    // Os itens de voz e de rádio esperam na mesma fila, mas têm limitador e prazo próprios: não gastam as vagas dos pedidos de texto.
    const waiting = processingQueue.filter((it) => !exemptFromQueueLimit(it.options));
    const mine = waiting.reduce((n, it) => n + (it.userId === userId ? 1 : 0), 0);
    if (waiting.length >= queueMax(env) || mine >= queueMaxPerUser(env)) return { total: waiting.length, mine };
    return null;
}

/** Este usuário ainda pode receber um aviso de recusa? No máximo um a cada 30 s (as demais recusas só vão para o log). Sem timer. */
function shouldAnnounceRefusal(userId, now = Date.now()) {
    const last = queueNoticeAt.get(userId) ?? -Infinity;
    if (now - last < QUEUE_NOTICE_COOLDOWN_MS) return false;
    queueNoticeAt.set(userId, now);
    if (queueNoticeAt.size > 500) {
        for (const [id, at] of queueNoticeAt) if (now - at >= QUEUE_NOTICE_COOLDOWN_MS) queueNoticeAt.delete(id);
    }
    return true;
}

async function refuseQueueRequest(interaction, type, userId, refusal, options = {}) {
    logger.info(`[Fila] Pedido recusado: fila=${refusal.total} do_usuario=${refusal.mine} tipo=${type}`);
    // Conversa espontânea (chatter): a pessoa não chamou a Yui, então um "você já tem pedidos na fila" não faz sentido. Só o log.
    if (options?.chatter === true) return;
    try {
        if (type === 'mention') {
            // Quem manda 100 menções não recebe 98 respostas do bot (isso chegaria ao limite de taxa do Discord): só a primeira de cada 30 s.
            if (!shouldAnnounceRefusal(userId)) return;
            const notice = await interaction.reply({ content: QUEUE_REFUSAL_TEXT, allowedMentions: { parse: [] }, fetchReply: true, failIfNotExists: false });
            if (notice && typeof notice.delete === 'function') {
                const timer = setTimeout(() => {
                    try { notice.delete().catch(() => {}); } catch (_) { /* aviso já apagado */ }
                }, QUEUE_NOTICE_DELETE_MS);
                if (typeof timer.unref === 'function') timer.unref();
            }
            return;
        }
        // Comando de barra: a interação precisa ser respondida (senão o Discord mostra "O aplicativo não respondeu").
        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: QUEUE_REFUSAL_TEXT, allowedMentions: { parse: [] } });
        } else {
            await interaction.reply({ content: QUEUE_REFUSAL_TEXT, ephemeral: true, allowedMentions: { parse: [] } });
        }
    } catch (err) {
        logger.warn(`[Fila] Aviso de recusa não enviado: ${scrubLogText(err?.message, 100)}`);
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
    }
    // Fila cheia ou usuário com pedidos demais: recusa ANTES de adiar a resposta, com aviso limitado (um a cada 30 s por usuário).
    const refusal = queueRefusalFor(userId, options);
    if (refusal) {
        await refuseQueueRequest(interaction, type, userId, refusal, options);
        return;
    }
    if (type !== 'mention' && !interaction.deferred && !interaction.replied) {
        const isPublic = options.public === true;
        await interaction.deferReply({ ephemeral: !isPublic });
        // O defer cede o turno ao laço de eventos: comandos de barra simultâneos do mesmo usuário passavam TODOS pela checagem de cima antes
        // de algum deles entrar na fila (o teto de 2 por usuário e o de 30 no total não valiam). Confere de novo; daqui até o push não há
        // mais nenhum await. Já adiado, a recusa edita a resposta. (B1)
        const again = queueRefusalFor(userId, options);
        if (again) {
            await refuseQueueRequest(interaction, type, userId, again, options);
            return;
        }
    }
    processingQueue.push({ prompt, interaction, type, userTag, userId, channelId, options });
    notifyQueueUpdate();
    if (!isProcessing) {
        runQueueSafely();
    } else {
        if (type === 'mention' && !options.radioMode && !options.chatter) {
            const queuePosition = processingQueue.length;
            try {
                const queueMsg = await interaction.reply({
                    content: `Sua solicitação está na fila. Posição: ${queuePosition}.`,
                    fetchReply: true,
                    failIfNotExists: false
                });
                if (queueMsg && typeof queueMsg.delete === 'function') {
                    setTimeout(() => {
                        try { queueMsg.delete().catch(() => {}); } catch (_) {}
                    }, 10000);
                }
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
let globalShowModelThinking = false;
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
export const getAllMcpTools = () => ALL_MCP_TOOLS;
export {
    stripThinking, addToQueue, setOnQueueUpdate, setDiscordClient,
    setChannelPersona, setChannelChatter, getChannelSettings,
    updateProviderSetting, getProviderSettings, updateShowModel, getShowModel,
    updateShowModelThinking, getShowModelThinking, updateErrorRetries,
    getErrorRetries, generateResponse, getServerPrompt, setServerPrompt,
    resetServerPrompt, getDisabledTools, isToolDisabled, setServerToolEnabled,
    resetServerTools, getServerSettings, setServerEveryoneMention,
    setServerUpdateChannel, setServerLastChannel, applyReplyMaxTokensEnv,
    buildToolsPayload, buildToolsDefinition, voiceToolBlocked, clearVoiceHistory,
    gameInfoErrorText, musicDeliveryText,
    coerceReplyContent, clampToolData, commentText, isSystemReply, aiDeadlineMs, anonymousTextTooBig,
    queueRefusalFor, refuseQueueRequest, uploadLimitLabel, videoUploadVerdict, explainFailedUpload, musicLabel,
    addToHistory, getHistory,
    // Agente de pesquisa: runResearchFor é a entrada única para quem pesquisa fora da fila (ask.js, app/API); o resto é exportado para teste.
    runResearchFor, isDirectToYui, writtenToolCallToJson, searchFailureNote, TOOLCALL_SCAN_MAX
};

export default {
    stripThinking,
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
    isToolDisabled,
    setServerToolEnabled,
    resetServerTools,
    getServerSettings,
    setServerEveryoneMention,
    setServerUpdateChannel,
    setServerLastChannel,
    clearVoiceHistory,
};
