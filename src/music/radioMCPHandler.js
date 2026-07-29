const {
    getSession,
    updateSession,
    addTrackToQueue,
    nextTrack,
    prevTrack,
    skipToTrack,
    setLoopMode,
    toggleShuffle,
    destroySession,
    stopRadio
} = require('./radioDatabase');
const {
    playTrack,
    pausePlayer,
    resumePlayer,
    stopPlayer,
    updateEmbed
} = require('./radioAudioPlayer');
const { resolveInput } = require('./radioProviders');
const { buildQueueEmbed, buildAmbiguousEmbed } = require('./radioEmbed');

async function sendTempMessage(textChannel, content, delayMs = 5000) {
    try {
        const msg = await textChannel.send(content);
        setTimeout(() => {
            msg?.delete?.().catch(() => {});
        }, delayMs);
    } catch (_) {}
}

async function handleRadioMCPCall(toolName, toolArgs, userId, guildId, textChannel, client) {
    const session = getSession(guildId);
    if (!session) return `❌ Nenhuma sessão de rádio ativa neste servidor.`;

    const userMention = `<@${userId}>`;

    if (toolName === 'radio_play_music') {
        const query = toolArgs.query || '';
        if (!query) return `❌ Nenhuma música informada.`;

        const resolved = await resolveInput(query);

        if (resolved.type === 'not_found') {
            return `${userMention} Não encontrei **"${query}"** no Deezer nem no YouTube.`;
        }

        if (resolved.type === 'ambiguous') {
            const embed = buildAmbiguousEmbed(resolved.results);
            const pendingKey = `radio_ambiguous_${guildId}_${userId}`;
            const { radioAmbiguousSessions, scheduleAmbiguousAutoSelect } = require('./radioManager');
            radioAmbiguousSessions.set(pendingKey, { results: resolved.results, guildId, userId, textChannel, client });
            try {
                const { ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
                const selectMenu = new StringSelectMenuBuilder()
                    .setCustomId(`radio_ambiguous_select_${guildId}_${userId}`)
                    .setPlaceholder('Escolha a música...')
                    .addOptions(resolved.results.map((t, i) => ({
                        label: `${i + 1}. ${t.title.substring(0, 40)}`,
                        description: `${t.artist.substring(0, 45)}`,
                        value: String(i)
                    })));
                const cancelBtn = new ButtonBuilder()
                    .setCustomId(`radio_ambiguous_cancel_${guildId}_${userId}`)
                    .setLabel('Cancelar')
                    .setStyle(ButtonStyle.Danger);
                const row1 = new ActionRowBuilder().addComponents(selectMenu);
                const row2 = new ActionRowBuilder().addComponents(cancelBtn);
                const ephemeralMsg = await textChannel.send({
                    content: `${userMention} Encontrei várias opções para "${query}". Qual delas você quer? (Seleção automática da 1ª opção em 10s)`,
                    embeds: [embed],
                    components: [row1, row2]
                });
                scheduleAmbiguousAutoSelect(pendingKey, ephemeralMsg);
            } catch (_) {}
            return null;
        }

        if (resolved.type === 'playlist') {
            const tracks = resolved.tracks;
            if (!tracks || tracks.length === 0) return `${userMention} Playlist vazia ou não encontrada.`;
            tracks.forEach(t => {
                t.addedBy = userId;
                addTrackToQueue(guildId, t);
            });
            if (session.status === 'STOPPED') {
                const firstTrack = nextTrack(guildId);
                if (firstTrack) await playTrack(guildId, firstTrack, textChannel, client);
            } else {
                await updateEmbed(guildId, textChannel, client);
            }
            await sendTempMessage(textChannel, `🎶 ${userMention} Adicionei **${tracks.length}** faixas da playlist à fila.`);
            return null;
        }

        if (resolved.type === 'track') {
            const track = { ...resolved.track, addedBy: userId };
            const queuePos = addTrackToQueue(guildId, track);

            if (session.status === 'STOPPED') {
                const first = nextTrack(guildId);
                if (first) await playTrack(guildId, first, textChannel, client);
                await sendTempMessage(textChannel, `🎵 ${userMention} Tocando **${track.title}** - ${track.artist}`);
            } else {
                await updateEmbed(guildId, textChannel, client);
                await sendTempMessage(textChannel, `➕ ${userMention} Adicionado à fila (#${queuePos}): **${track.title}** - ${track.artist}`);
            }
            return null;
        }
    }

    if (toolName === 'radio_pause_resume') {
        if (session.status === 'PLAYING') {
            await pausePlayer(guildId);
            await updateEmbed(guildId, textChannel, client);
            await sendTempMessage(textChannel, `⏸️ ${userMention} Música pausada.`);
        } else if (session.status === 'PAUSED') {
            await resumePlayer(guildId);
            await updateEmbed(guildId, textChannel, client);
            await sendTempMessage(textChannel, `▶️ ${userMention} Continuando reprodução.`);
        }
        return null;
    }

    if (toolName === 'radio_stop_music') {
        stopPlayer(guildId);
        stopRadio(guildId);
        await updateEmbed(guildId, textChannel, client);
        await sendTempMessage(textChannel, `⏹️ ${userMention} Reprodução parada.`);
        return null;
    }

    if (toolName === 'radio_next_track') {
        const next = nextTrack(guildId);
        if (next) {
            await playTrack(guildId, next, textChannel, client);
            await sendTempMessage(textChannel, `⏭️ ${userMention} Tocando próxima: **${next.title}** - ${next.artist}`);
        } else {
            await sendTempMessage(textChannel, `ℹ️ ${userMention} Fila vazia, sem próxima faixa.`);
        }
        return null;
    }

    if (toolName === 'radio_prev_track') {
        const prev = prevTrack(guildId);
        if (prev) {
            await playTrack(guildId, prev, textChannel, client);
            await sendTempMessage(textChannel, `⏮️ ${userMention} Voltando para: **${prev.title}** - ${prev.artist}`);
        } else {
            await sendTempMessage(textChannel, `ℹ️ ${userMention} Sem histórico de músicas anteriores.`);
        }
        return null;
    }

    if (toolName === 'radio_skip_to') {
        const pos = parseInt(toolArgs.position || 1, 10);
        const updatedSession = skipToTrack(guildId, pos);
        if (!updatedSession) {
            await sendTempMessage(textChannel, `⚠️ ${userMention} A posição **#${pos}** não existe na fila.`);
            return null;
        }
        const target = updatedSession.currentTrack;
        if (target) {
            await playTrack(guildId, target, textChannel, client);
            await sendTempMessage(textChannel, `🔢 ${userMention} Pulando para a música **#${pos}**: **${target.title}**`);
        }
        return null;
    }

    if (toolName === 'radio_toggle_shuffle') {
        const enabled = toggleShuffle(guildId);
        await updateEmbed(guildId, textChannel, client);
        await sendTempMessage(textChannel, `🔀 ${userMention} Modo aleatório ${enabled ? 'ativado' : 'desativado'}.`);
        return null;
    }

    if (toolName === 'radio_set_repeat') {
        const newMode = setLoopMode(guildId);
        const label = newMode === 'TRACK' ? 'repetir faixa atual 🔂' : newMode === 'QUEUE' ? 'repetir playlist 🔁' : 'desativada ❌';
        await updateEmbed(guildId, textChannel, client);
        await sendTempMessage(textChannel, `🔁 ${userMention} Repetição: ${label}`);
        return null;
    }

    if (toolName === 'radio_show_queue') {
        const embed = buildQueueEmbed(session);
        try { await textChannel.send({ embeds: [embed] }); } catch (_) {}
        return null;
    }

    if (toolName === 'radio_leave_call') {
        const { leaveRadioCall } = require('./radioManager');
        await leaveRadioCall(guildId, textChannel);
        await sendTempMessage(textChannel, `👋 ${userMention} Rádio encerrado. Até mais!`);
        return null;
    }

    if (toolName === 'radio_unknown_command') {
        console.log(`[RadioMCP] ❓ Comando não reconhecido. Enviando aviso ao chat.`);
        await sendTempMessage(textChannel, `❓ ${userMention} Não entendi, tente de novo!`);
        return null;
    }

    await sendTempMessage(textChannel, `❓ ${userMention} Não entendi, tente de novo!`);
    return null;
}

module.exports = { handleRadioMCPCall };
