import { joinVoiceChannel, VoiceConnectionStatus, EndBehaviorType, getVoiceConnection, createAudioPlayer, createAudioResource, StreamType, entersState } from '@discordjs/voice.js';
import prism from 'prism-media.js';
import { Readable } from 'stream.js';
import { transcribeAudio } from '../services/sttService.js';
import { addToQueue } from './llmHandler.js';
import { checkBan } from './banHandler.js';
const activeConnections = new Map();
const activeAudioStreams = new Set();

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

function playInitialSilence(connection) {
    try {
        const player = createAudioPlayer();
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
        console.log(`[VOICE] 🛑 Tentativa de conectar na voz negada (Banido: ${banInfo.typeName} - ${member.id})`);
        await sendOrReply(`🛑 **Acesso Negado**: Você (${banInfo.typeName.toLowerCase()}) está banido da rede Yui e não pode utilizar os serviços de voz.`, textChannel, replyFn);
        return false;
    }

    import { isToolDisabled } from './llmHandler.js';
    if (isToolDisabled(guildId, 'join_voice_call')) {
        await sendOrReply('⚠️ As ferramentas de voz (**Yui Assistant**) estão desativadas neste servidor por padrão. Um administrador pode ativá-las usando o comando `/ia_ferramentas`.', textChannel, replyFn);
        return false;
    }

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
        setupVoiceReceiver(stateData, member.client);
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

    try {
        console.log(`[VOICE] 🎙️ Conectando ao canal de voz "${voiceChannel.name}" (Servidor: ${guildId})...`);
        const connection = joinVoiceChannel({
            channelId: voiceChannel.id,
            guildId: voiceChannel.guild.id,
            adapterCreator: voiceChannel.guild.voiceAdapterCreator,
            selfDeaf: false,
            selfMute: false
        });

        const stateData = {
            connection,
            guildId,
            voiceChannelId: voiceChannel.id,
            textChannelId: textChannel.id,
            isLeaving: false
        };

        activeConnections.set(guildId, stateData);

        connection.on(VoiceConnectionStatus.Disconnected, async () => {
            if (!stateData.isLeaving) {
                console.log(`[VOICE] ⚠️ Desconectada do canal de voz em ${guildId}.`);
                activeConnections.delete(guildId);
                if (textChannel && typeof textChannel.send === 'function') {
                    try {
                        await textChannel.send('⚠️ Fui removida do canal de voz.');
                    } catch (err) {}
                }
            }
        });

        await entersState(connection, VoiceConnectionStatus.Ready, 15000);
        console.log(`[VOICE] ✅ Conectada e pronta no canal de voz "${voiceChannel.name}"!`);

        playInitialSilence(connection);
        setupVoiceReceiver(stateData, member.client);

        await sendOrReply(`🎙️ Entrei no canal de voz **${voiceChannel.name}**! Diga "Yui" seguido da sua pergunta.`, textChannel, replyFn);
        return true;
    } catch (error) {
        console.error('[VOICE] ❌ Erro ao conectar no canal de voz:', error.message || error);
        activeConnections.delete(guildId);
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

    if (stateData) {
        stateData.isLeaving = true;
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

    console.log(`[VOICE] 👋 Saí do canal de voz no servidor ${guildId}.`);
    await sendOrReply('👋 Saí do canal de voz.', textChannel, replyFn);
    return true;
}

function setupVoiceReceiver(stateData, client) {
    const { connection, guildId } = stateData;
    const receiver = connection.receiver;

    receiver.speaking.on('start', (userId) => {
        const banInfo = checkBan(userId, guildId, stateData.textChannelId);
        if (banInfo) {
            console.log(`[VOICE] 🛑 Entrada de voz ignorada do usuário banido ${userId}.`);
            return;
        }

        const streamKey = `${guildId}_${userId}`;
        if (activeAudioStreams.has(streamKey)) return;
        activeAudioStreams.add(streamKey);

        const opusStream = receiver.subscribe(userId, {
            end: {
                behavior: EndBehaviorType.AfterSilence,
                duration: 1200
            }
        });

        const decoder = new prism.opus.Decoder({ frameSize: 960, channels: 2, rate: 48000 });
        const pcmChunks = [];

        opusStream.pipe(decoder);

        decoder.on('data', (chunk) => {
            pcmChunks.push(chunk);
        });

        decoder.on('end', async () => {
            activeAudioStreams.delete(streamKey);
            const pcmBuffer = Buffer.concat(pcmChunks);

            if (pcmBuffer.length < 9600) return;

            const voiceChannel = client.channels.cache.get(stateData.voiceChannelId);
            const member = voiceChannel?.members?.get(userId);
            if (member && (member.voice.selfMute || member.voice.serverMute)) return;

            const rms = calculatePcmRms(pcmBuffer);
            if (rms < 250) return;

            const wavHeader = createWavHeader(pcmBuffer.length, 48000, 2, 16);
            const wavBuffer = Buffer.concat([wavHeader, pcmBuffer]);

            const result = await transcribeAudio(wavBuffer);
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
                processVoiceTranscription(userId, transcribedText, stateData, client);
            }
        });

        decoder.on('error', () => {
            activeAudioStreams.delete(streamKey);
        });
    });
}

async function processVoiceTranscription(userId, text, stateData, client) {
    const banInfo = checkBan(userId, stateData.guildId, stateData.textChannelId);
    if (banInfo) {
        console.log(`[VOICE] 🛑 Transcrição de voz ignorada. Usuário ${userId} está banido.`);
        return;
    }

    try {
        import { hasActiveSession } from '../music/radioDatabase.js';
        if (hasActiveSession(stateData.guildId)) {
            return;
        }
    } catch (_) {}

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
        console.log(`[VOICE] 🔇 Alucinação de STT/ruído ignorada: "${text}"`);
        return;
    }

    const triggerRegex = /\b(yui|yuin|yuis|yuih|yuii|yuie|yuia|yuio|yukari|yukare|yukary|yukarii|yukarie|yukaris|yucari|yucare|yucary|yucarii|yucaris|yucario|yucaru|yukar|yukar|ikari|ikare|ikary|ikarii|ikaris|icari|icare|icaro|icary|icarii|icaris|icara|icaras|icaros|ikario|icario|ikaru|icaru|ikar|icar|ricardo|ricard|ricardi|ricari|ricare|rikari|rikare|ricario|ricarto|recari|recaro|ricar|ricardin|ricardinho|ficari|ficare|vicari|vicare|ficardo|vicardo|dicari|dicare|kikari|kicari|ticari|ih\s*cari|e\s*cari|eh\s*cari|i\s*cari|re\s*cari|ri\s*cari|hi\s*cari|he\s*cari|a\s*cari|o\s*cari|ei\s*cari|oh\s*cari|oi\s*cari)\b/i;
    const triggerMatch = lowerText.match(triggerRegex);

    if (!triggerMatch) return;

    const matchedWord = triggerMatch[0];
    const matchIndex = triggerMatch.index;
    let prompt = text.substring(matchIndex + matchedWord.length).replace(/^[,\s.!?-]+/, '').trim();
    if (!prompt) {
        prompt = 'Olá Yui';
    }

    const textChannel = client.channels.cache.get(stateData.textChannelId);
    if (!textChannel) return;

    const voiceChannel = client.channels.cache.get(stateData.voiceChannelId);
    const member = voiceChannel?.members?.get(userId);
    const username = member?.user?.username || `Usuário_${userId}`;
    const userTag = member?.user?.tag || username;

    console.log(`[VOICE] 🗣️ Voz ativada por ${userTag}: "${prompt}"`);

    try {
        const voiceContextMessage = {
            id: `voice_${Date.now()}`,
            isVoice: true,
            content: prompt,
            author: {
                id: userId,
                username: username,
                tag: userTag,
                bot: false
            },
            guild: textChannel.guild,
            guildId: stateData.guildId,
            channel: textChannel,
            channelId: textChannel.id,
            mentions: { has: () => false, everyone: false },
            reply: async (responsePayload) => {
                let contentText = typeof responsePayload === 'string' ? responsePayload : responsePayload?.content || '';
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

        await addToQueue(prompt, voiceContextMessage, 'mention');
    } catch (error) {
        console.error('[VOICE] ❌ Erro ao processar transcrição:', error.message || error);
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
        console.log(`[VOICE] 🚪 Todos os usuários saíram da call no servidor ${guildId}. Desconectando por inatividade.`);
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

export default {
    joinVoiceCall,
    leaveVoiceCall,
    handleVoiceStateUpdate,
    getActiveVoiceConnection
};
