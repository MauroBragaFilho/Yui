import { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType, getVoiceConnection, createAudioPlayer, createAudioResource, StreamType, entersState, AudioPlayerStatus } from '@discordjs/voice';
import prism from 'prism-media';
import { Readable } from 'node:stream';
import { PermissionFlagsBits, ChannelType } from 'discord.js';
import { transcribeAudio } from '../services/sttService.js';
import {
    disposeGuild,
    getTtsStatus,
    interruptSpeech,
    isParrotRequest,
    isStopCommand,
    noteHumanSpeaking,
    overlapsSpeech,
    wakeWordInFirstWords,
    warmupTts
} from '../services/tts/index.js';
import { buildVoiceKey, voiceToolsAllowed } from '../services/tts/voiceGuards.js';
import { addToQueue } from './llmHandler.js';
import { checkBan } from './banHandler.js';
import { logger } from '../utils/logger.js';
import { isOpusAvailable } from '../utils/binaries.js';
import {
    VOICE_UNAVAILABLE_MESSAGE,
    attachConnectionSafety,
    attachPlayerSafety,
    attachSpeakingListener,
    clampTranscript,
    createSpeakerGuard,
    errMsg
} from '../utils/voiceSafety.js';
const activeConnections = new Map();

// Ouvinte de fala por receiver: evita empilhar ouvintes 'start' quando joinVoiceCall
// é chamado de novo no mesmo canal. A guarda de "quem está sendo captado" fica DENTRO
// do ouvinte (por conexão), então some junto com a conexão (antes era um Set de módulo
// que, se uma chave ficasse presa, ignorava o usuário até reiniciar a Yui).
const receiverListeners = new WeakMap();

// ──────────────────────────────────────────────────────────────────────────────
// Regras puras da voz (sem Discord e sem rede): exportadas para serem testadas.
// ──────────────────────────────────────────────────────────────────────────────

// Palavra de ativação ("Yui" e as variações que o STT costuma gerar). SEM flag g/y: vários chamadores usam .test()
// (inclusive o filtro de "texto que acionaria a Yui de novo") e uma regex com estado erraria de forma intermitente.
export const VOICE_TRIGGER_REGEX = /\b(yui|yuin|yuis|yuih|yuii|yuie|yuia|yuio|yukari|yukare|yukary|yukarii|yukarie|yukaris|yucari|yucare|yucary|yucarii|yucaris|yucario|yucaru|yukar|yukar|ikari|ikare|ikary|ikarii|ikaris|icari|icare|icaro|icary|icarii|icaris|icara|icaras|icaros|ikario|icario|ikaru|icaru|ikar|icar|ricardo|ricard|ricardi|ricari|ricare|rikari|rikare|ricario|ricarto|recari|recaro|ricar|ricardin|ricardinho|ficari|ficare|vicari|vicare|ficardo|vicardo|dicari|dicare|kikari|kicari|ticari|ih\s*cari|e\s*cari|eh\s*cari|i\s*cari|re\s*cari|ri\s*cari|hi\s*cari|he\s*cari|a\s*cari|o\s*cari|ei\s*cari|oh\s*cari|oi\s*cari)\b/i;

// Silêncio que fecha a captura de uma fala (EndBehaviorType.AfterSilence). O trecho só chega ao handleCapturedAudio DEPOIS
// disso: o fim real da fala da pessoa é "agora menos este tempo" (o anti-eco precisa do fim real, não do instante da entrega).
export const CAPTURE_END_SILENCE_MS = 1200;

// Texto fixo (sem IA) quando alguém tenta usar a Yui de papagaio por voz.
export const PARROT_REPLY = 'Essa eu passo.';

// "sai da call", "desconecta do canal"... (rodado sobre o texto sem acento e em minúsculas).
const LEAVE_COMMAND_RE = /^(sai|saia|sair|desconecta|vaza)\b.*\b(call|chamada|voz|canal)/;

// Aviso "Sua solicitação está na fila" que o addToQueue posta pelo reply da mensagem falsa: não é sinal de que o pedido começou.
const QUEUE_NOTICE_RE = /est[áa] na fila/i;

// Limites ANTES da IA: a fila da IA é serial e o STT erra; um eco ou um spam não pode entupi-la.
export const VOICE_LIMITS = Object.freeze({
    debounceMs: 6000, // 1 pedido por usuário a cada 6 s
    perUser: 1, // pedidos de voz esperando na fila da IA, por usuário
    perGuild: 2, // ... e por servidor
    ttlMs: 31000 // a fila da IA descarta pedido de voz com mais de 30 s: depois disso ele não está mais pendente
});

/**
 * Comando de voz resolvido sem IA: 'stop' (calar a Yui), 'parrot' (usar a Yui de papagaio), 'leave' (sair da call)
 * ou 'none' (conversa normal). Recebe o texto DEPOIS da palavra de ativação.
 */
export function parseVoiceCommand(prompt) {
    if (typeof prompt !== 'string' || !prompt.trim()) return 'none';
    if (isStopCommand(prompt)) return 'stop';
    if (isParrotRequest(prompt)) return 'parrot';
    const folded = prompt.slice(0, 300).toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').replace(/^[^a-z0-9]+/, '').trim();
    if (LEAVE_COMMAND_RE.test(folded)) return 'leave';
    return 'none';
}

/**
 * Lê a transcrição do STT. `matched` só quando há palavra de ativação; `prompt` é o que vem depois dela;
 * `speakable` diz se a resposta PODE ser falada (a palavra de ativação precisa abrir a frase: nas 3 primeiras
 * palavras). Fora disso a resposta é só texto, como era antes do TTS.
 */
export function parseVoiceTranscript(text, triggerRegex = VOICE_TRIGGER_REGEX) {
    if (typeof text !== 'string' || !text) return { matched: false };
    const match = text.toLowerCase().match(triggerRegex);
    if (!match) return { matched: false };
    let prompt = text.substring(match.index + match[0].length).replace(/^[,\s.!?-]+/, '').trim();
    if (!prompt) prompt = 'Olá Yui';
    return {
        matched: true,
        prompt,
        command: parseVoiceCommand(prompt),
        speakable: wakeWordInFirstWords(text, triggerRegex, 3)
    };
}

/**
 * Options do addToQueue para o pedido de voz (só no modo voz: ver isVoiceModeOn). TODA transcrição vira item de voz, para que
 * as proteções valham para qualquer pedido que nasceu na call (sem ferramentas, sem memória nem histórico em disco, escopo
 * público, AutoMod sem ban). Sem `speakable` (palavra de ativação no meio da frase) o item ganha `voiceSpeak: false`: tudo
 * igual, só que a resposta NÃO é falada e usa a persona de texto. `disableTools` só desliga a OFERTA de ferramentas; quem barra
 * a execução é o llmHandler (voiceGuards.shouldBlockToolForVoice).
 */
export function buildVoiceOptions({ speakable, prompt, now = Date.now(), env = process.env } = {}) {
    const options = {
        voice: true,
        voiceTranscript: prompt,
        disableTools: !voiceToolsAllowed(env),
        voiceRequestedAt: now
    };
    if (!speakable) options.voiceSpeak = false;
    return options;
}

/**
 * Mensagem falsa que o llmHandler trata como se fosse uma mensagem de texto da pessoa. Mantém o canal de texto REAL
 * (ban e AutoMod olham o canal de verdade; a saída em texto vai para ele) e traz `voiceKey` (histórico, persona e
 * escopo do contexto: um fio por pessoa). `onReply(texto)` avisa cada resposta enviada ao chat.
 */
export function buildVoiceMessage({ userId, username, userTag, prompt, textChannel, guildId, now = Date.now(), onReply = null }) {
    return {
        id: `voice_${now}`,
        isVoice: true,
        voiceKey: buildVoiceKey(guildId, userId),
        content: prompt,
        author: {
            id: userId,
            username: username,
            tag: userTag,
            bot: false
        },
        guild: textChannel.guild,
        guildId,
        channel: textChannel,
        channelId: textChannel.id,
        mentions: { has: () => false, everyone: false },
        reply: async (responsePayload) => {
            let contentText = typeof responsePayload === 'string' ? responsePayload : responsePayload?.content || '';
            try { onReply?.(contentText); } catch (_) { /* o aviso nunca atrapalha a resposta */ }
            if (contentText && !contentText.includes(`<@${userId}>`)) {
                contentText = `<@${userId}> ${contentText}`;
            }
            if (typeof responsePayload === 'object' && responsePayload !== null) {
                responsePayload.content = contentText;
                return textChannel.send(responsePayload);
            }
            return textChannel.send({ content: contentText });
        }
    };
}

/**
 * Debounce por usuário + limite de pedidos de voz pendentes (por usuário e por servidor). `tryAccept` devolve
 * `{ ok, reason, release }`. Pedido de IA ('ai') ocupa uma vaga até `release()` (a resposta começou a ser enviada)
 * ou até `ttlMs` (a fila da IA descarta o pedido velho); comando sem IA ('cmd') só passa pelo debounce.
 * O relógio é injetável para teste.
 */
export function createVoiceLimiter({
    now = () => performance.now(),
    debounceMs = VOICE_LIMITS.debounceMs,
    perUser = VOICE_LIMITS.perUser,
    perGuild = VOICE_LIMITS.perGuild,
    ttlMs = VOICE_LIMITS.ttlMs
} = {}) {
    const lastAt = new Map(); // "servidor:usuário" -> instante do último pedido aceito
    const pending = new Map(); // ficha -> { guildId, userId, at }
    let seq = 0;
    const noop = () => {};

    const prune = (t) => {
        for (const [token, p] of pending) if (t - p.at > ttlMs) pending.delete(token);
        if (lastAt.size > 500) {
            for (const [key, at] of lastAt) if (t - at > debounceMs) lastAt.delete(key);
        }
    };

    return {
        tryAccept(guildId, userId, kind = 'ai') {
            const t = now();
            prune(t);
            const key = `${guildId}:${userId}`;
            const last = lastAt.get(key);
            if (last !== undefined && t - last < debounceMs) return { ok: false, reason: 'debounce', release: noop };
            if (kind === 'ai') {
                let forUser = 0;
                let forGuild = 0;
                for (const p of pending.values()) {
                    if (p.guildId !== guildId) continue;
                    forGuild += 1;
                    if (p.userId === userId) forUser += 1;
                }
                if (forUser >= perUser) return { ok: false, reason: 'user-pending', release: noop };
                if (forGuild >= perGuild) return { ok: false, reason: 'guild-pending', release: noop };
            }
            lastAt.set(key, t);
            if (kind !== 'ai') return { ok: true, reason: 'ok', release: noop };
            const token = ++seq;
            pending.set(token, { guildId, userId, at: t });
            return { ok: true, reason: 'ok', release: () => { pending.delete(token); } };
        },
        pendingCount(guildId, userId = null) {
            prune(now());
            let n = 0;
            for (const p of pending.values()) {
                if (p.guildId === guildId && (userId === null || p.userId === userId)) n += 1;
            }
            return n;
        }
    };
}

/** Mensagem de entrada na call. Com a fala ligada no servidor ela explica como a Yui responde e como calá-la. */
export function buildJoinMessage(channelName, ttsOn) {
    const base = `🎙️ Entrei no canal de voz **${channelName}**! Diga "Yui" seguido da sua pergunta.`;
    const speaking = ' Respondo falando quando você começar com "Yui" e a pergunta. Quem fez o pedido pode falar por cima de mim para me interromper; dizer "Yui, para" também funciona, desde que não seja em cima da minha voz.';
    const cloud = ' Atenção: o áudio da call é enviado a serviços de transcrição na nuvem antes de eu saber se falaram comigo; eu não gravo nada em disco.';
    // Sem o modo voz o histórico de texto do bot continua valendo (a transcrição do pedido pode ficar no histórico), então a promessa
    // vale só para o áudio.
    const cloudOff = ' Atenção: o áudio da call é enviado a serviços de transcrição na nuvem antes de eu saber se falaram comigo; eu não gravo o áudio em disco.';
    return ttsOn ? base + speaking + cloud : base + cloudOff;
}

/**
 * O interruptor `voice_tts` está LIGADO neste servidor? Falha fechado: a ferramenta precisa existir (se faltar, o
 * isToolDisabled devolveria "não desligada") e o isToolDisabled precisa responder exatamente `false`.
 */
export function isTtsSwitchOn(guildId, { isToolDisabled, getAllMcpTools } = {}) {
    try {
        const tools = getAllMcpTools();
        if (!Array.isArray(tools) || !tools.some((t) => t?.function?.name === 'voice_tts')) return false;
        return isToolDisabled(guildId, 'voice_tts') === false;
    } catch (_) {
        return false;
    }
}

/**
 * Modo voz = a Yui pode FALAR neste servidor: o serviço de TTS está de pé (YUI_TTS_ENABLED, Opus, provedor) E o interruptor
 * `voice_tts` está ligado no servidor. É o que separa os dois comportamentos da conversa por voz:
 *  - modo voz LIGADO: toda transcrição é item de voz (sem ferramentas, escopo público, nada em memória/historico.txt) e valem o
 *    comando "Yui, para", o anti-papagaio, o debounce e o limite de pedidos pendentes;
 *  - DESLIGADO (o padrão): a conversa por voz é a de sempre, só em texto, como antes do TTS. Desligar a fala não tira nada da voz.
 * Falha fechado (qualquer dúvida = desligado). `io` existe para os testes: ttsEnabled, isToolDisabled, getAllMcpTools.
 */
export async function isVoiceModeOn(guildId, io = {}) {
    try {
        const ttsEnabled = typeof io.ttsEnabled === 'function' ? io.ttsEnabled : () => getTtsStatus()?.enabled === true;
        if (ttsEnabled() !== true) return false;
        let { isToolDisabled, getAllMcpTools } = io;
        if (typeof isToolDisabled !== 'function' || typeof getAllMcpTools !== 'function') {
            const mod = await import('./llmHandler.js');
            if (typeof isToolDisabled !== 'function') isToolDisabled = mod.isToolDisabled;
            if (typeof getAllMcpTools !== 'function') getAllMcpTools = mod.getAllMcpTools;
        }
        return isTtsSwitchOn(guildId, { isToolDisabled, getAllMcpTools });
    } catch (_) {
        return false;
    }
}

/** Só `true` para quem a Discord confirma como HUMANO (bot ou membro desconhecido não contam). */
export function isConfirmedHuman(client, guildId, voiceChannelId, userId) {
    try {
        const voiceChannel = client?.channels?.cache?.get?.(voiceChannelId);
        const member = voiceChannel?.members?.get?.(userId) ?? client?.guilds?.cache?.get?.(guildId)?.members?.cache?.get?.(userId);
        return member?.user?.bot === false;
    } catch (_) {
        return false;
    }
}

const forbiddenRegexCache = new WeakMap(); // lista de palavras -> { size, items: [{ word, re }] }

function escapeRegExp(text) {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * A lista de palavras do banHandler casa neste texto? Serve SÓ para decidir se a Yui deixa de FALAR; não bane ninguém.
 * Palavra curta ou com "+"/"-" casa como trecho; as demais, como palavra inteira (com acento: nada de \b do JS).
 * Sem lista (dependência ausente) devolve true: sem como conferir, não fala.
 */
export function containsForbiddenWord(text, keywords) {
    if (!Array.isArray(keywords)) return true;
    const lower = String(text ?? '').toLowerCase();
    let cached = forbiddenRegexCache.get(keywords);
    if (!cached || cached.size !== keywords.length) {
        const items = keywords
            .filter((k) => typeof k === 'string' && k.trim())
            .map((k) => {
                const word = k.toLowerCase();
                const asSubstring = word.length <= 3 || word.includes('+') || word.includes('-');
                const re = asSubstring ? null : new RegExp('(?<![\\p{L}\\p{N}])' + escapeRegExp(word) + '(?![\\p{L}\\p{N}])', 'u');
                return { word, re };
            });
        cached = { size: keywords.length, items };
        forbiddenRegexCache.set(keywords, cached);
    }
    for (const { word, re } of cached.items) {
        if (re ? re.test(lower) : lower.includes(word)) return true;
    }
    return false;
}

/**
 * Dependências SÍNCRONAS do serviço de TTS. O serviço não importa llmHandler/banHandler (evita ciclo de imports),
 * então o bootstrap (discord/client.js) injeta aqui o que vem deles. Todas falham FECHADO: qualquer dúvida ou exceção
 * significa "não fale".
 *
 * @param {object} client  cliente do discord.js
 * @param {object} io      { isToolDisabled, getAllMcpTools, checkBan, hasActiveSession, forbiddenKeywords, isOpusAvailable }
 *                         + (testes) getActiveState e getConnection
 */
export function createTtsDeps(client, io = {}) {
    const guildOf = (guildId) => client?.guilds?.cache?.get?.(String(guildId)) ?? null;
    const stateOf = (guildId) => (io.getActiveState ?? getActiveVoiceConnection)(guildId);
    const connectionOf = (guildId) => (io.getConnection ?? getVoiceConnection)(guildId);

    return {
        isEnabled: (guildId) => isTtsSwitchOn(guildId, io),

        // Banido = qualquer ban (usuário, servidor ou o canal de texto da call). Exceção: trata como banido.
        isBanned: (userId, guildId) => {
            try {
                return Boolean(io.checkBan(userId, guildId, stateOf(guildId)?.textChannelId ?? null));
            } catch (_) {
                return true;
            }
        },

        // Só `false` EXATO prova humano (membro desconhecido conta como bot).
        isBot: (userId, guildId) => (isConfirmedHuman(client, guildId, stateOf(guildId)?.voiceChannelId, userId) ? false : true),

        // Na dúvida o rádio manda: a música nunca é coberta.
        isRadioActive: (guildId) => {
            try {
                return Boolean(io.hasActiveSession(guildId));
            } catch (_) {
                return true;
            }
        },

        // A call de IA está registrada, não está saindo e a conexão ATUAL do servidor é a registrada e está pronta
        // (o Modo Rádio troca a conexão e o registro pode ficar com uma conexão morta).
        isAiCallActive: (guildId) => {
            try {
                const state = stateOf(guildId);
                if (!state || state.isLeaving) return false;
                const connection = connectionOf(guildId);
                return Boolean(connection && connection === state.connection && connection.state?.status === VoiceConnectionStatus.Ready);
            } catch (_) {
                return false;
            }
        },

        // Quem pediu está AGORA no mesmo canal de voz da Yui (membro fora do cache = não está).
        isUserInSameVoice: (guildId, userId) => {
            try {
                const state = stateOf(guildId);
                const guild = guildOf(guildId);
                if (!state || !guild) return false;
                const memberChannel = guild.members?.cache?.get?.(userId)?.voice?.channelId;
                const myChannel = guild.members?.me?.voice?.channelId;
                return Boolean(memberChannel && myChannel && memberChannel === myChannel && memberChannel === state.voiceChannelId);
            } catch (_) {
                return false;
            }
        },

        // Permissão de Falar no canal e sem silêncio do servidor (nem supressão em palco).
        canSpeakInChannel: (guildId) => {
            try {
                const state = stateOf(guildId);
                const guild = guildOf(guildId);
                const me = guild?.members?.me;
                const channel = guild?.channels?.cache?.get?.(state?.voiceChannelId);
                if (!state || !me || !channel) return false;
                if (me.voice?.serverMute === true || me.voice?.suppress === true) return false;
                return channel.permissionsFor(me)?.has(PermissionFlagsBits.Speak) === true;
            } catch (_) {
                return false;
            }
        },

        containsForbidden: (text) => {
            try {
                return containsForbiddenWord(text, io.forbiddenKeywords);
            } catch (_) {
                return true;
            }
        },

        // Texto que acionaria a Yui de novo (eco do próprio áudio no microfone) não é falado. Confere também a forma sem acentos:
        // a voz lê "Yuí" como "Yui" e o STT escreve "Yui", mas a regex do gatilho não casa "Yuí".
        matchesTrigger: (text) => {
            const raw = String(text ?? '');
            return VOICE_TRIGGER_REGEX.test(raw) || VOICE_TRIGGER_REGEX.test(raw.normalize('NFD').replace(/\p{M}/gu, ''));
        },

        // Só o cache (síncrono): nome de exibição, cargo ou canal. null = desconhecido (o serviço omite o nome).
        resolveName: (guildId, id, kind) => {
            try {
                const guild = guildOf(guildId);
                if (!guild) return null;
                if (kind === 'role') return guild.roles?.cache?.get?.(id)?.name ?? null;
                if (kind === 'channel') return guild.channels?.cache?.get?.(id)?.name ?? null;
                const member = guild.members?.cache?.get?.(id);
                return member?.displayName ?? member?.user?.globalName ?? member?.user?.username ?? null;
            } catch (_) {
                return null;
            }
        },

        isOpusAvailable: () => {
            try {
                return Boolean(io.isOpusAvailable());
            } catch (_) {
                return false;
            }
        },

        // Palco: o DAVE/E2EE do palco segue regras próprias, o serviço não espera o código de privacidade ali.
        isStageChannel: (guildId, connection) => {
            try {
                const channelId = connection?.joinConfig?.channelId ?? stateOf(guildId)?.voiceChannelId;
                return guildOf(guildId)?.channels?.cache?.get?.(channelId)?.type === ChannelType.GuildStageVoice;
            } catch (_) {
                return false;
            }
        }
    };
}

// Limites ANTES da IA, compartilhados por todas as calls deste processo.
const voiceLimiter = createVoiceLimiter();
// Fora do modo voz não há limite próprio: a "vaga" é só um recibo vazio.
const NO_LIMIT_SLOT = Object.freeze({ ok: true, reason: 'ok', release: () => {} });

// Log de pedidos descartados: no máximo um por chave a cada 30 s (um eco poderia encher o log).
const dropLogAt = new Map();
function shouldLogDrop(key, ms = 30000) {
    const t = Date.now();
    const until = dropLogAt.get(key);
    if (until !== undefined && t < until) return false;
    dropLogAt.set(key, t + ms);
    if (dropLogAt.size > 200) {
        for (const [k, u] of dropLogAt) if (u <= t) dropLogAt.delete(k);
    }
    return true;
}

// Fim de sessão de voz (saiu da call ou caiu de verdade): para a fala, limpa a fila e a janela de eco do servidor e,
// se o llmHandler oferecer, o histórico em RAM da conversa por voz. Nunca lança.
function cleanupVoiceSession(guildId) {
    try {
        disposeGuild(guildId);
    } catch (err) {
        logger.warn(`[VOICE] Falha ao encerrar a fala do servidor ${guildId}: ${errMsg(err)}`);
    }
    import('./llmHandler.js')
        .then((mod) => {
            if (typeof mod.clearVoiceHistory === 'function') mod.clearVoiceHistory(guildId);
        })
        .catch(() => {});
}

function createWavHeader(pcmLength, sampleRate = 48000, numChannels = 2, bitsPerSample = 16) {
    const header = Buffer.alloc(44);
    const byteRate = (sampleRate * numChannels * bitsPerSample) / 8;
    const blockAlign = (numChannels * bitsPerSample) / 8;

    header.write('RIFF', 0);
    header.writeUInt32LE(36 + pcmLength, 4);
    header.write('WAVE', 8);
    header.write('fmt ', 12);
    header.writeUInt32LE(16, 16);
    header.writeUInt16LE(1, 20);
    header.writeUInt16LE(numChannels, 22);
    header.writeUInt32LE(sampleRate, 24);
    header.writeUInt32LE(byteRate, 28);
    header.writeUInt16LE(blockAlign, 32);
    header.writeUInt16LE(bitsPerSample, 34);
    header.write('data', 36);
    header.writeUInt32LE(pcmLength, 40);

    return header;
}

function calculatePcmRms(pcmBuffer) {
    if (!pcmBuffer || pcmBuffer.length < 2) return 0;
    const numSamples = Math.floor(pcmBuffer.length / 2);
    let sumSquares = 0;

    for (let i = 0; i < numSamples; i++) {
        const sample = pcmBuffer.readInt16LE(i * 2);
        sumSquares += sample * sample;
    }

    return Math.sqrt(sumSquares / numSamples);
}

function playInitialSilence(connection, guildId) {
    try {
        const player = createAudioPlayer();
        attachPlayerSafety(player, { label: 'VOICE', guildId, log: logger });
        const silenceFrame = Buffer.from([0xf8, 0xff, 0xfe]);
        const silenceStream = new Readable({
            read() {
                this.push(silenceFrame);
                this.push(null);
            }
        });
        const resource = createAudioResource(silenceStream, { inputType: StreamType.Opus });
        connection.subscribe(player);
        player.play(resource);
    } catch (e) {}
}

async function sendOrReply(msg, textChannel, replyFn) {
    if (replyFn && typeof replyFn === 'function') {
        try {
            await replyFn(msg);
            return;
        } catch (e) {}
    }
    if (textChannel && typeof textChannel.send === 'function') {
        try {
            await textChannel.send(msg);
        } catch (e) {}
    }
}

async function joinVoiceCall(member, textChannel, replyFn = null) {
    if (!member || !member.voice || !member.voice.channel) {
        await sendOrReply('⚠️ Você precisa estar em um canal de voz para me chamar para a call!', textChannel, replyFn);
        return false;
    }

    const voiceChannel = member.voice.channel;
    const guildId = voiceChannel.guild.id;

    const banInfo = checkBan(member.id, guildId, textChannel?.id);
    if (banInfo) {
        logger.info(`[VOICE] Tentativa de conectar na voz negada (banido: ${banInfo.typeName}, usuário ${member.id}, servidor ${guildId}).`);
        await sendOrReply(`🛑 **Acesso Negado**: Você (${banInfo.typeName.toLowerCase()}) está banido da rede Yui e não pode utilizar os serviços de voz.`, textChannel, replyFn);
        return false;
    }

    const { isToolDisabled, getAllMcpTools } = await import('./llmHandler.js');
    if (isToolDisabled(guildId, 'join_voice_call')) {
        await sendOrReply('⚠️ As ferramentas de voz (**Yui Assistant**) estão desativadas neste servidor por padrão. Um administrador pode ativá-las usando o comando `/yui-ferramentas`.', textChannel, replyFn);
        return false;
    }

    // Sem o codificador Opus a voz quebra na primeira fala: recusa agora, com aviso claro.
    if (!isOpusAvailable()) {
        logger.error(`[VOICE] Pedido de entrada na call recusado: voz sem codificador Opus (usuário ${member.id}, servidor ${guildId}).`);
        await sendOrReply(VOICE_UNAVAILABLE_MESSAGE, textChannel, replyFn);
        return false;
    }

    const origem = replyFn ? 'ferramenta da IA (join_voice_call)' : 'comando /entrar-call';
    const me = voiceChannel.guild.members.me;
    let existingConn = getVoiceConnection(guildId) || activeConnections.get(guildId)?.connection;

    if (existingConn && existingConn.state.status === VoiceConnectionStatus.Ready && me?.voice?.channelId === voiceChannel.id) {
        const stateData = activeConnections.get(guildId) || {
            connection: existingConn,
            guildId,
            voiceChannelId: voiceChannel.id,
            textChannelId: textChannel.id,
            isLeaving: false
        };
        activeConnections.set(guildId, stateData);
        // Idempotente: se este receiver já tem ouvinte, só atualiza o estado dele (não empilha outro).
        setupVoiceReceiver(stateData, member.client);
        logger.info(`[VOICE] Pedido de entrada em call já ativa (usuário ${member.id}, servidor ${guildId}, origem: ${origem}).`);
        await sendOrReply('🗣️ Já estou conectada e escutando nesta call!', textChannel, replyFn);
        return true;
    }

    if (existingConn) {
        try { existingConn.destroy(); } catch (e) {}
        activeConnections.delete(guildId);
    }

    if (me?.voice?.channelId) {
        try {
            await me.voice.disconnect();
            await new Promise(r => setTimeout(r, 600));
        } catch (e) {}
    }

    let connection = null;
    try {
        logger.info(`[VOICE] Conectando ao canal de voz ${voiceChannel.id} (servidor ${guildId}), pedido por ${member.id} via ${origem}.`);
        connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });
        // Sem ouvinte de 'error', um erro de rede de voz vira uncaughtException ("Erro grave").
        attachConnectionSafety(connection, { label: 'VOICE', guildId, log: logger });

        const stateData = {
            connection,
            guildId,
            voiceChannelId: voiceChannel.id,
            textChannelId: textChannel.id,
            isLeaving: false
        };

        activeConnections.set(guildId, stateData);

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            // Handler async: nada aqui pode virar Unhandled Rejection.
            try {
                if (stateData.isLeaving) return;
                // Disconnected nem sempre é queda: troca de canal ou de região reconecta sozinha em segundos.
                try {
                    await Promise.race([
                        entersState(connection, VoiceConnectionStatus.Signalling, 5000),
                        entersState(connection, VoiceConnectionStatus.Connecting, 5000)
                    ]);
                    stateData.voiceChannelId = connection.joinConfig?.channelId || stateData.voiceChannelId;
                    return;
                } catch (_) { /* não reconectou: queda de verdade */ }
                // Saiu de propósito nesse meio tempo, ou já existe outra sessão no lugar desta: nada a anunciar.
                if (stateData.isLeaving || activeConnections.get(guildId) !== stateData) return;

                logger.warn(`[VOICE] Desconectada do canal de voz (servidor ${guildId}).`);
                activeConnections.delete(guildId);
                cleanupVoiceSession(guildId);
                if (textChannel && typeof textChannel.send === 'function') {
                    try {
                        await textChannel.send('⚠️ Fui removida do canal de voz.');
                    } catch (err) {}
                }
            } catch (err) {
                logger.warn(`[VOICE] Falha ao tratar a desconexão (servidor ${guildId}): ${errMsg(err)}`);
            }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 15000);
        logger.info(`[VOICE] Conectada e pronta no canal de voz ${voiceChannel.id} (servidor ${guildId}).`);

        playInitialSilence(connection, guildId);
        setupVoiceReceiver(stateData, member.client);

        // Resposta falada ligada neste servidor: aquece o motor de voz e o Opus agora, sem atrasar a entrada
        // (a 1ª fala não paga a partida a frio). Nunca bloqueia nem lança.
        const ttsOn = await isVoiceModeOn(guildId, { isToolDisabled, getAllMcpTools });
        if (ttsOn) {
            try { warmupTts().catch(() => {}); } catch (_) {}
        }

        await sendOrReply(buildJoinMessage(voiceChannel.name, ttsOn), textChannel, replyFn);
        return true;
    } catch (error) {
        logger.error(`[VOICE] Erro ao conectar no canal de voz (servidor ${guildId}): ${errMsg(error)}`);
        activeConnections.delete(guildId);
        // Conexão que não chegou a "Ready" não pode ficar pendurada.
        if (connection) {
            try {
                if (connection.state?.status !== VoiceConnectionStatus.Destroyed) connection.destroy();
            } catch (e) {}
        }
        await sendOrReply('❌ Erro ao tentar entrar no canal de voz.', textChannel, replyFn);
        return false;
    }
}

async function leaveVoiceCall(guildId, textChannel = null, replyFn = null) {
    const existingConn = getVoiceConnection(guildId);
    const stateData = activeConnections.get(guildId);

    if (!stateData && !existingConn) {
        await sendOrReply('ℹ️ Não estou em nenhum canal de voz neste servidor.', textChannel, replyFn);
        return false;
    }

    // Para a fala e limpa fila/janela de eco ANTES de derrubar a conexão (o player para limpo, sem erro de assinatura).
    cleanupVoiceSession(guildId);

    if (stateData) {
        stateData.isLeaving = true;
        try { stateData.listenerHandle?.detach?.(); } catch (err) {}
        try { receiverListeners.get(stateData.connection.receiver)?.notifier?.detach?.(); } catch (err) {}
        try {
            stateData.connection.destroy();
        } catch (err) {}
        activeConnections.delete(guildId);
    }

    if (existingConn) {
        try {
            existingConn.destroy();
        } catch (err) {}
    }

    logger.info(`[VOICE] Saí do canal de voz (servidor ${guildId}).`);
    await sendOrReply('👋 Saí do canal de voz.', textChannel, replyFn);
    return true;
}

function setupVoiceReceiver(stateData, client) {
    const { connection, guildId } = stateData;
    const receiver = connection.receiver;

    // Já existe ouvinte neste receiver (joinVoiceCall repetido no mesmo canal): só atualiza o estado.
    // Se ele foi desligado por falhas seguidas, cai para baixo e cria outro do zero (religa a escuta).
    const existing = receiverListeners.get(receiver);
    if (existing && !existing.handle.guard.isDisabled()) {
        existing.ctx.stateData = stateData;
        stateData.listenerHandle = existing.handle;
        return existing.handle;
    }

    // `segments`: quando começou o trecho de cada pessoa (o onAudio não recebe o início; o anti-eco precisa dele).
    const ctx = { stateData, segments: new Map() };
    const guard = createSpeakerGuard();

    // Avisos de início/fim de fala para o barge-in do TTS: UM par por receiver, mesmo que o ouvinte principal
    // abaixo seja recriado (falhas seguidas o desligam), para nunca empilhar ouvintes.
    const notifier = existing?.notifier || attachSpeechNotifier(receiver, client, () => receiverListeners.get(receiver)?.ctx.stateData);

    // O ouvinte nunca propaga exceção, trata erro de stream/decoder, aplica backoff por usuário
    // e desliga a escuta da sessão depois de falhas seguidas (ver utils/voiceSafety.js).
    const handle = attachSpeakingListener(receiver, {
        label: 'VOICE',
        guildId,
        guard,
        log: logger,
        createDecoder: () => new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 }),
        subscribe: (userId) => receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: CAPTURE_END_SILENCE_MS
            }
        }),
        precheck: (userId) => {
            // Bots (o bot de música da call, por exemplo) e membros que a Discord não confirma como humanos: nunca vão ao STT.
            if (!isConfirmedHuman(client, guildId, ctx.stateData.voiceChannelId, userId)) {
                if (guard.shouldLog(`notHuman:${userId}`)) {
                    logger.info(`[VOICE] Entrada de voz ignorada: bot ou membro não identificado ${userId} (servidor ${guildId}).`);
                }
                return false;
            }
            const banInfo = checkBan(userId, guildId, ctx.stateData.textChannelId);
            if (banInfo) {
                if (guard.shouldLog(`ban:${userId}`)) {
                    logger.info(`[VOICE] Entrada de voz ignorada: usuário banido ${userId} (servidor ${guildId}).`);
                }
                return false;
            }
            ctx.segments.set(userId, Date.now());
            return true;
        },
        onAudio: (userId, pcmBuffer) => {
            const segmentStartedAt = ctx.segments.get(userId);
            ctx.segments.delete(userId);
            return handleCapturedAudio(userId, pcmBuffer, ctx.stateData, client, segmentStartedAt);
        },
        onTrip: () => {
            try {
                const textChannel = client.channels.cache.get(ctx.stateData.textChannelId);
                const sent = textChannel?.send?.('⚠️ Tive problemas repetidos para captar o áudio da call e desliguei a escuta de voz desta sessão. Se quiser tentar de novo, me chame outra vez com `/entrar-call`.');
                sent?.catch?.(() => {});
            } catch (e) {}
        }
    });

    receiverListeners.set(receiver, { handle, ctx, notifier });
    stateData.listenerHandle = handle;
    return handle;
}

/**
 * Avisa o TTS quando um HUMANO começa e para de falar (barge-in: quem fez o pedido pode calar a Yui falando por cima).
 * Fica à parte do ouvinte de captura porque este roda a cada "start" (a captura pode estar ocupada) e porque o fim
 * da fala não é visto por ele. Nunca lança. `getState()` devolve o estado atual da call (muda quando o receiver é reaproveitado).
 */
function attachSpeechNotifier(receiver, client, getState) {
    const emitter = receiver.speaking;
    const onStart = (userId) => {
        try {
            const state = getState();
            if (!state || !isConfirmedHuman(client, state.guildId, state.voiceChannelId, userId)) return;
            noteHumanSpeaking(state.guildId, userId, true);
        } catch (_) { /* o aviso nunca atrapalha a captura */ }
    };
    const onEnd = (userId) => {
        try {
            const state = getState();
            if (state) noteHumanSpeaking(state.guildId, userId, false);
        } catch (_) { /* idem */ }
    };
    emitter.on('start', onStart);
    emitter.on('end', onEnd);
    return {
        detach() {
            try { emitter.off('start', onStart); } catch (_) {}
            try { emitter.off('end', onEnd); } catch (_) {}
        }
    };
}

// Processa a fala já decodificada (PCM): filtros, transcrição e envio ao fluxo de comandos.
// `io` existe só para os testes trocarem as dependências por dublês (padrão: as reais deste módulo).
async function handleCapturedAudio(userId, pcmBuffer, stateData, client, segmentStartedAt = null, io = {}) {
    if (pcmBuffer.length < 9600) return;

    // Anti-eco: trecho que cruza a fala da Yui (mais a margem) é a própria voz dela voltando pelo microfone de alguém,
    // ou gente falando por cima. Não vai ao STT (poupa cota e evita laço).
    // O fim do trecho é o FIM REAL da fala (a captura só fecha CAPTURE_END_SILENCE_MS depois da última palavra): com "agora" quem
    // terminou de falar até 1,2 s antes da Yui começar era tratado como sobreposição e ficava sem resposta, sem aviso.
    if (Number.isFinite(segmentStartedAt)) {
        const segmentEndedAt = Math.max(segmentStartedAt, (io.now ?? Date.now)() - CAPTURE_END_SILENCE_MS);
        if ((io.overlapsSpeech ?? overlapsSpeech)(stateData.guildId, segmentStartedAt, segmentEndedAt)) return;
    }

    const voiceChannel = client.channels.cache.get(stateData.voiceChannelId);
    const member = voiceChannel?.members?.get(userId);
    if (member && (member.voice.selfMute || member.voice.serverMute)) return;

    const rms = calculatePcmRms(pcmBuffer);
    if (rms < 250) return;

    const wavHeader = createWavHeader(pcmBuffer.length, 48000, 2, 16);
    const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

    const result = await (io.transcribeAudio ?? transcribeAudio)(wavBuffer);
    if (result && typeof result === 'object' && result.isRateLimit) {
        const textChannel = client.channels.cache.get(stateData.textChannelId);
        if (textChannel) {
            try {
                const msg = await textChannel.send('⚠️ **Limite de requisições da API de voz (Whisper) atingido!** Aguarde um momento antes de falar novamente.');
                setTimeout(() => { msg?.delete?.().catch(() => {}); }, 15000);
            } catch (_) {}
        }
        return;
    }
    const transcribedText = typeof result === 'string' ? result : '';
    if (transcribedText) {
        await (io.processVoiceTranscription ?? processVoiceTranscription)(userId, transcribedText, stateData, client);
    }
}

// `io` existe só para os testes trocarem as dependências por dublês (padrão: as reais deste módulo).
async function processVoiceTranscription(userId, text, stateData, client, io = {}) {
    // A transcrição chegou agora: é daqui que o prazo de 30 s da fala (e da fila da IA) começa a contar.
    const requestedAt = Date.now();

    const banInfo = (io.checkBan ?? checkBan)(userId, stateData.guildId, stateData.textChannelId);
    if (banInfo) {
        logger.info(`[VOICE] Transcrição de voz ignorada: usuário ${userId} está banido (servidor ${stateData.guildId}).`);
        return;
    }

    try {
        const hasActiveSession = io.hasActiveSession ?? (await import('../music/radioDatabase.js')).hasActiveSession;
        if (hasActiveSession(stateData.guildId)) {
            return;
        }
    } catch (_) {}

    // D7 / TG-35: a transcrição do STT segue ao pipeline com no máximo 1500 caracteres. Só o FIM é descartado (a palavra de
    // ativação e o início do pedido ficam). Em fala real, já limitada a 30 s na captura (utils/voiceSafety.js, maxStreamMs),
    // isso nunca corta nada; pega saída de STT fora do normal (alucinação repetida, por exemplo).
    const fullLength = typeof text === 'string' ? text.length : 0;
    text = clampTranscript(text);
    if (text.length < fullLength && shouldLogDrop(`${stateData.guildId}:${userId}:long-transcript`)) {
        // Sem o conteúdo da fala no log (privacidade): só os tamanhos.
        logger.info(`[VOICE] Transcrição longa cortada de ${fullLength} para ${text.length} caracteres (usuário ${userId}, servidor ${stateData.guildId}).`);
    }

    const lowerText = text.toLowerCase();

    const STT_HALLUCINATIONS = [
        'assistente virtual',
        'legendas pela comunidade',
        'subtítulos',
        'subtitulos',
        'obrigado por assistir',
        'inscreva-se',
        'curta e compartilhe',
        'transcrição',
        'transcricao',
        'amara.org',
        'fale com a yui',
        'fale com yui',
        'falar com a yui',
        'falar com yui',
        'conversar com a yui',
        'conversar com yui',
        'fale com a',
        'falar com a',
        'fale com o',
        'falar com o'
    ];

    if (STT_HALLUCINATIONS.some(h => lowerText.includes(h))) {
        // Sem o texto transcrito no log (privacidade): só o tamanho.
        logger.info(`[VOICE] Alucinação de STT/ruído ignorada (${text.length} caracteres, servidor ${stateData.guildId}).`);
        return;
    }

    const plan = parseVoiceTranscript(text);
    if (!plan.matched) return;

    const guildId = stateData.guildId;
    const prompt = plan.prompt;

    // Modo voz (fala ligada no servidor E serviço de TTS de pé): só nele valem parar, anti-papagaio, debounce e limites, e o pedido
    // vira item de voz. Desligado (o padrão) a conversa por voz é a de sempre, em texto. Veja isVoiceModeOn.
    const voiceMode = await isVoiceModeOn(guildId, io);

    // Comandos fixos (sem IA) só valem quando a palavra de ativação ABRE a frase: "eu falei pro Ricardo sai da call" não é ordem,
    // e "eu acho que Yui para" não cala ninguém. Nesse caso é conversa comum (a IA decide, em texto).
    let command = plan.speakable ? plan.command : 'none';
    if (!voiceMode && (command === 'stop' || command === 'parrot')) command = 'none';

    // Parar a Yui: vale para QUALQUER pessoa que a chame e não passa pelo debounce nem pela IA. Limitação aceita: um
    // "Yui, para" dito por TERCEIRO em cima da voz dela cai na janela anti-eco e é descartado antes do STT (quem fez
    // o pedido interrompe falando por cima; o comando vale quando não se sobrepõe à voz da Yui).
    if (command === 'stop') {
        const stopped = (io.interruptSpeech ?? interruptSpeech)(guildId, 'user-stop');
        logger.info(`[VOICE] Pedido de parada por voz (usuário ${userId}, servidor ${guildId}, havia fala em curso: ${stopped ? 'sim' : 'não'}).`);
        return;
    }

    const textChannel = client.channels.cache.get(stateData.textChannelId);
    if (!textChannel) return;

    // Sair da call por voz só vale com a ferramenta liberada no servidor (como no caminho da IA). Sem ela é conversa comum.
    if (command === 'leave') {
        let leaveBlocked = true;
        try {
            const isToolDisabled = io.isToolDisabled ?? (await import('./llmHandler.js')).isToolDisabled;
            leaveBlocked = isToolDisabled(guildId, 'leave_voice_call') !== false;
        } catch (_) {}
        if (leaveBlocked) command = 'none';
    }

    // Debounce por usuário e teto de pedidos pendentes, ANTES de gastar a IA (só no modo voz: sem a fala não há eco para laçar).
    const slot = voiceMode ? (io.limiter ?? voiceLimiter).tryAccept(guildId, userId, command === 'none' ? 'ai' : 'cmd') : NO_LIMIT_SLOT;
    if (!slot.ok) {
        if (shouldLogDrop(`${guildId}:${userId}:${slot.reason}`)) {
            logger.info(`[VOICE] Pedido de voz descartado (${slot.reason}; usuário ${userId}, servidor ${guildId}).`);
        }
        return;
    }

    const voiceChannel = client.channels.cache.get(stateData.voiceChannelId);
    const member = voiceChannel?.members?.get(userId);
    const username = member?.user?.username || `Usuário_${userId}`;
    const userTag = member?.user?.tag || username;

    // Sem o conteúdo da fala no log (privacidade): quem, onde e o tamanho do pedido.
    logger.info(`[VOICE] Voz ativada por ${userTag} (${userId}) no servidor ${guildId}: pedido de ${prompt.length} caracteres.`);

    // "Repita depois de mim": regra fixa, sem IA (a Yui não vira papagaio de ninguém na call).
    if (command === 'parrot') {
        logger.info(`[VOICE] Pedido para repetir fala recusado por regra fixa (usuário ${userId}, servidor ${guildId}).`);
        try {
            await textChannel.send(`<@${userId}> ${PARROT_REPLY}`);
        } catch (_) {}
        return;
    }

    if (command === 'leave') {
        logger.info(`[VOICE] Saída da call pedida por voz (usuário ${userId}, servidor ${guildId}).`);
        try {
            await (io.leaveVoiceCall ?? leaveVoiceCall)(guildId, textChannel);
        } catch (err) {
            logger.warn(`[VOICE] Falha ao sair da call por voz (servidor ${guildId}): ${errMsg(err)}`);
        }
        return;
    }

    try {
        // O pedido deixa de estar "pendente" quando a primeira resposta (o "Processando...") sai para o chat.
        const voiceContextMessage = buildVoiceMessage({
            userId,
            username,
            userTag,
            prompt,
            textChannel,
            guildId,
            now: requestedAt,
            onReply: (content) => { if (!QUEUE_NOTICE_RE.test(content)) slot.release(); }
        });
        // Modo voz: todo pedido é item de voz; a palavra de ativação nas 3 primeiras palavras decide se a resposta pode ser FALADA
        // (senão voiceSpeak=false: só texto). Fora do modo voz, nada é marcado e tudo segue como sempre foi.
        const options = voiceMode ? buildVoiceOptions({ speakable: plan.speakable, prompt, now: requestedAt }) : {};
        await (io.addToQueue ?? addToQueue)(prompt, voiceContextMessage, 'mention', options);
    } catch (error) {
        slot.release();
        logger.error(`[VOICE] Erro ao processar transcrição (servidor ${guildId}, usuário ${userId}): ${errMsg(error)}`);
        try {
            await textChannel.send(`<@${userId}> Tive um erro ao processar o seu comando de voz.`);
        } catch (e) {}
    }
}

async function handleVoiceStateUpdate(oldState, newState) {
    const guildId = oldState.guild.id;
    if (!activeConnections.has(guildId)) return;

    const stateData = activeConnections.get(guildId);
    const voiceChannel = oldState.guild.channels.cache.get(stateData.voiceChannelId);
    if (!voiceChannel) return;

    const humanMembers = voiceChannel.members.filter(m => !m.user.bot);
    if (humanMembers.size === 0) {
        logger.info(`[VOICE] Todos os usuários saíram da call (servidor ${guildId}). Desconectando por inatividade.`);
        const textChannel = oldState.client.channels.cache.get(stateData.textChannelId);
        if (textChannel) {
            try {
                await textChannel.send('🚪 Todos saíram da call. Desconectando por inatividade.');
            } catch (e) {}
        }
        await leaveVoiceCall(guildId);
    }
}

function getActiveVoiceConnection(guildId) {
    return activeConnections.get(guildId);
}

export { joinVoiceCall, leaveVoiceCall, handleVoiceStateUpdate, getActiveVoiceConnection, handleCapturedAudio, processVoiceTranscription, setupVoiceReceiver };
export default {
    joinVoiceCall,
    leaveVoiceCall,
    handleVoiceStateUpdate,
    getActiveVoiceConnection
};
