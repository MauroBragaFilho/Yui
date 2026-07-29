const {
    joinVoiceChannel,
    getVoiceConnection,
    VoiceConnectionStatus,
    entersState,
    EndBehaviorType
} = require('@discordjs/voice');
const prism = require('prism-media');
const { transcribeAudio } = require('../services/sttService');
const {
    createSession,
    getSession,
    destroySession,
    updateSession,
    nextTrack,
    addTrackToQueue,
    toggleVoiceListening
} = require('./radioDatabase');
const { playTrack, stopPlayer, updateEmbed } = require('./radioAudioPlayer');
const { buildRadioEmbed } = require('./radioEmbed');
const { resolveInput } = require('./radioProviders');

const radioAmbiguousSessions = new Map();
const userLastVoiceCommand = new Map();

const RADIO_TRIGGER_REGEX = /\b(hikari|hikare|hikary|hikarii|hikarie|hikaris|hicari|hicare|hicary|hicarii|hicaris|hikario|hicario|hikaru|hicaru|hikar|hicar|ikari|ikare|ikary|ikarii|ikaris|icari|icare|icaro|icary|icarii|icaris|icara|icaras|icaros|ikario|icario|ikaru|icaru|ikar|icar|ricardo|ricard|ricardi|ricari|ricare|rikari|rikare|ricario|ricarto|recari|recaro|ricar|ricardin|ricardinho|ficari|ficare|vicari|vicare|ficardo|vicardo|dicari|dicare|kikari|kicari|ticari|ih\s*cari|e\s*cari|eh\s*cari|i\s*cari|re\s*cari|ri\s*cari|hi\s*cari|he\s*cari|a\s*cari|o\s*cari|ei\s*cari|oh\s*cari|oi\s*cari)\b/i;

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

async function startRadioMode(member, textChannel, client) {
    const voiceChannel = member?.voice?.channel;
    if (!voiceChannel) return { success: false, error: '⚠️ Você precisa estar em um canal de voz para ativar o Modo Rádio.' };

    const guildId = voiceChannel.guild.id;
    const existingSession = getSession(guildId);

    const existingConn = getVoiceConnection(guildId);

    if (existingSession) {
        if (existingSession.voiceChannelId !== voiceChannel.id) {
            return { success: false, error: '⚠️ Já estou em outro canal de voz em modo rádio neste servidor.' };
        }

        const { embeds, components } = buildRadioEmbed(existingSession);
        const msg = await textChannel.send({ embeds, components });

        if (existingSession.embedMessageId) {
            try {
                const oldMsg = await textChannel.messages.fetch(existingSession.embedMessageId);
                await oldMsg.delete().catch(() => {});
            } catch (_) {}
        }

        updateSession(guildId, { embedMessageId: msg.id, textChannelId: textChannel.id });
        return { success: true };
    }

    if (existingConn) {
        try { existingConn.destroy(); } catch (_) {}
    }

    const connection = joinVoiceChannel({
        channelId: voiceChannel.id,
        guildId,
        adapterCreator: voiceChannel.guild.voiceAdapterCreator,
        selfDeaf: false,
        selfMute: false
    });

    await entersState(connection, VoiceConnectionStatus.Ready, 15000);

    const session = createSession(guildId, voiceChannel.id, textChannel.id);
    const { embeds, components } = buildRadioEmbed(session);
    const msg = await textChannel.send({ embeds, components });
    updateSession(guildId, { embedMessageId: msg.id });

    connection.on(VoiceConnectionStatus.Disconnected, async () => {
        const s = getSession(guildId);
        if (s && !s._leaving) {
            stopPlayer(guildId);
            destroySession(guildId);
        }
    });

    setupRadioVoiceReceiver(connection, guildId, textChannel, client, voiceChannel);

    connection.on(VoiceConnectionStatus.Ready, () => {
        monitorEmptyChannel(guildId, voiceChannel, textChannel);
    });
    monitorEmptyChannel(guildId, voiceChannel, textChannel);

    return { success: true };
}

function setupRadioVoiceReceiver(connection, guildId, textChannel, client, voiceChannel) {
    const activeStreams = new Set();
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
        const session = getSession(guildId);
        if (!session || !session.voiceListening) return;

        const streamKey = `${guildId}_${userId}`;
        if (activeStreams.has(streamKey)) return;
        activeStreams.add(streamKey);

        const member = voiceChannel.members?.get(userId);
        if (member && (member.voice.selfMute || member.voice.serverMute)) {
            activeStreams.delete(streamKey);
            return;
        }

        const opusStream = receiver.subscribe(userId, {
            end: { behavior: EndBehaviorType.AfterSilence, duration: 1200 }
        });

        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const pcmChunks = [];

        opusStream.pipe(decoder);
        decoder.on('data', chunk => pcmChunks.push(chunk));

        decoder.on('end', async () => {
            activeStreams.delete(streamKey);
            const pcmBuffer = Buffer.concat(pcmChunks);
            if (pcmBuffer.length < 9600) return;

            const rms = calculatePcmRms(pcmBuffer);
            if (rms < 250) return;

            const wavHeader = createWavHeader(pcmBuffer.length);
            const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);
            const result = await transcribeAudio(wavBuffer);
            if (!result) return;

            if (typeof result === 'object' && result.isRateLimit) {
                console.warn(`[RadioVoice] ⚠️ Limite de API Whisper/Groq atingido (${result.status}). Desativando escuta por 1 minuto.`);
                updateSession(guildId, { voiceListening: false });
                await updateEmbed(guildId, textChannel, client);

                if (textChannel) {
                    try {
                        const msg = await textChannel.send('⚠️ **Limite de requisições da API de voz (Whisper) atingido!** A escuta por voz do Rádio foi desativada temporariamente por **1 minuto**.');
                        setTimeout(() => { msg?.delete?.().catch(() => {}); }, 15000);
                    } catch (_) {}
                }

                setTimeout(async () => {
                    const currentSession = getSession(guildId);
                    if (currentSession) {
                        updateSession(guildId, { voiceListening: true });
                        await updateEmbed(guildId, textChannel, client);
                        if (textChannel) {
                            try {
                                const msg = await textChannel.send('✅ **Escuta de voz do Rádio reativada!** Você já pode enviar comandos por voz novamente.');
                                setTimeout(() => { msg?.delete?.().catch(() => {}); }, 10000);
                            } catch (_) {}
                        }
                    }
                }, 60000);

                return;
            }

            const text = typeof result === 'string' ? result : '';
            if (!text) return;

            const lower = text.toLowerCase();

            const STT_HALLUCINATIONS = [
                'assistente virtual',
                'legendas pela comunidade',
                'subtítulos',
                'obrigado por assistir',
                'inscreva-se',
                'curta e compartilhe',
                'transcrição',
                'amara.org'
            ];

            if (STT_HALLUCINATIONS.some(h => lower.includes(h))) {
                console.log(`[RadioVoice] 🔇 Alucinação de STT/ruído ignorada: "${text}"`);
                return;
            }

            const triggerMatch = lower.match(RADIO_TRIGGER_REGEX);
            if (!triggerMatch) return;

            const matchedWord = triggerMatch[0];
            console.log(`[RadioVoice] 🎯 Gatilho RADIO_TRIGGER_REGEX ativado por: "${matchedWord}" | Transcrição: "${text}"`);

            const userKey = `${guildId}_${userId}`;
            const now = Date.now();
            const lastTime = userLastVoiceCommand.get(userKey) || 0;
            if (now - lastTime < 3000) {
                console.log(`[RadioVoice] ⏳ Comando de voz de ${userId} ignorado por debounce (menos de 3s).`);
                return;
            }

            const matchIndex = triggerMatch.index;
            let prompt = text.substring(matchIndex + matchedWord.length).replace(/^[,\s.!?-]+/, '').trim();
            prompt = prompt.replace(RADIO_TRIGGER_REGEX, '').replace(/^[,\s.!?-]+/, '').trim();

            if (!prompt || prompt.length < 2) {
                console.log(`[RadioVoice] ℹ️ Prompt sem comando após gatilho ignorado: "${text}"`);
                return;
            }

            userLastVoiceCommand.set(userKey, now);
            await processRadioVoiceCommand(prompt, userId, guildId, textChannel, client);
        });

        decoder.on('error', () => activeStreams.delete(streamKey));
    });
}

async function processRadioVoiceCommand(prompt, userId, guildId, textChannel, client) {
    const fs = require('fs');
    const path = require('path');

    const radioMCPToolsPath = path.join(__dirname, 'radioMCPTools.json');
    const radioMCPTools = JSON.parse(fs.readFileSync(radioMCPToolsPath, 'utf-8'));

    const { addToQueue } = require('../handlers/llmHandler');

    const contextMessage = {
        id: `radio_voice_${Date.now()}`,
        isVoice: true,
        isRadioMode: true,
        radioGuildId: guildId,
        radioTextChannel: textChannel,
        radioClient: client,
        radioUserId: userId,
        content: prompt,
        author: {
            id: userId,
            username: textChannel.guild?.members?.cache?.get(userId)?.user?.username || `user_${userId}`,
            bot: false
        },
        guild: textChannel.guild,
        guildId,
        channel: textChannel,
        channelId: textChannel.id,
        mentions: { has: () => false, everyone: false },
        reply: async (payload) => {
            const content = typeof payload === 'string' ? payload : payload?.content || '';
            if (content) {
                try {
                    const msg = await textChannel.send({ content });
                    setTimeout(() => { msg.delete().catch(() => {}); }, 5000);
                    return msg;
                } catch (_) {}
            }
            return null;
        }
    };

    await addToQueue(prompt, contextMessage, 'mention', {
        radioMode: true,
        radioMCPTools,
        guildId
    });
}

async function leaveRadioCall(guildId, textChannel) {
    const session = getSession(guildId);
    if (session) {
        updateSession(guildId, { _leaving: true });
    }

    stopPlayer(guildId);

    const conn = getVoiceConnection(guildId);
    if (conn) {
        try { conn.destroy(); } catch (_) {}
    }

    destroySession(guildId);

    if (textChannel) {
        try { await textChannel.send('👋 Modo Rádio encerrado. Até logo!'); } catch (_) {}
    }
}

function monitorEmptyChannel(guildId, voiceChannel, textChannel) {
    const CHECK_INTERVAL = 10000;
    const interval = setInterval(() => {
        const session = getSession(guildId);
        if (!session) {
            clearInterval(interval);
            return;
        }
        const humanMembers = voiceChannel.members?.filter(m => !m.user.bot) || new Map();
        if (humanMembers.size === 0) {
            clearInterval(interval);
            leaveRadioCall(guildId, textChannel);
        }
    }, CHECK_INTERVAL);
}

function scheduleAmbiguousAutoSelect(pendingKey, messageTarget) {
    setTimeout(async () => {
        const pending = radioAmbiguousSessions.get(pendingKey);
        if (!pending) return;

        radioAmbiguousSessions.delete(pendingKey);

        const firstTrack = { ...pending.results[0], addedBy: pending.userId };

        try {
            if (messageTarget && typeof messageTarget.edit === 'function') {
                await messageTarget.edit({
                    content: `⏱️ **Tempo esgotado (20s).** Selecionada automaticamente a 1ª opção: **${firstTrack.title}**`,
                    embeds: [],
                    components: []
                });
            } else if (messageTarget && typeof messageTarget.editReply === 'function') {
                await messageTarget.editReply({
                    content: `⏱️ **Tempo esgotado (20s).** Selecionada automaticamente a 1ª opção: **${firstTrack.title}**`,
                    embeds: [],
                    components: []
                });
            }
        } catch (_) {}

        const session = getSession(pending.guildId);
        addTrackToQueue(pending.guildId, firstTrack);

        if (!session || session.status === 'STOPPED') {
            const first = nextTrack(pending.guildId);
            if (first) await playTrack(pending.guildId, first, pending.textChannel, pending.client);
        } else {
            await updateEmbed(pending.guildId, pending.textChannel, pending.client);
        }
    }, 20000);
}

module.exports = {
    startRadioMode,
    leaveRadioCall,
    setupRadioVoiceReceiver,
    radioAmbiguousSessions,
    scheduleAmbiguousAutoSelect
};
