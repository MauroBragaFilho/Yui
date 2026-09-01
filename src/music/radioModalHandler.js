import {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    StringSelectMenuBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle,
    MessageFlags
} from 'discord.js';
import { getSession, updateSession, addTrackToQueue, nextTrack, toggleVoiceListening, cycleVoiceMode, toggleStreamMode, stopRadio, removeTrackFromPlaylist } from './radioDatabase.js';
import { playTrack, pausePlayer, resumePlayer, stopPlayer, updateEmbed } from './radioAudioPlayer.js';
import { buildQueueEmbed, buildAmbiguousEmbed } from './radioEmbed.js';
import { resolveInput } from './radioProviders.js';
import { leaveRadioCall, radioAmbiguousSessions, scheduleAmbiguousAutoSelect } from './radioManager.js';
import { setLoopMode, toggleShuffle, prevTrack, skipToTrack } from './radioDatabase.js';
import { prefetchNextTrack } from './radioPrefetcher.js';

function isUserInRadioChannel(interaction, session) {
    if (!session) return false;
    const member = interaction.member;
    if (!member?.voice?.channelId) return false;
    return member.voice.channelId === session.voiceChannelId;
}

async function handleRadioButton(interaction, client) {
    try {
        const cid = interaction.customId;
        const guildId = interaction.guildId;
        const session = getSession(guildId);

        if (cid.startsWith('radio_ambiguous_cancel_')) {
            return await handleAmbiguousSelect(interaction, client);
        }

        if (!session) {
            return await interaction.reply({ content: '❌ Nenhuma sessão de rádio ativa.', flags: MessageFlags.Ephemeral });
        }

        if (!isUserInRadioChannel(interaction, session)) {
            return await interaction.reply({ content: '❌ Você precisa estar no canal de voz do rádio para usar os controles.', flags: MessageFlags.Ephemeral });
        }

        if (cid === 'radio_add') {
            const modal = new ModalBuilder()
                .setCustomId('radio_add_modal')
                .setTitle('➕ Adicionar ao Rádio');

            const input = new TextInputBuilder()
                .setCustomId('radio_add_input')
                .setLabel('Nome da música, artista ou link')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ex: Welcome to the Jungle | ou link Deezer/YouTube')
                .setRequired(true)
                .setMaxLength(300);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return await interaction.showModal(modal);
        }

        if (cid === 'radio_remove') {
            if (!session.playlist || session.playlist.length === 0) {
                return await interaction.reply({ content: '❌ A playlist do rádio está vazia.', flags: MessageFlags.Ephemeral });
            }

            const modal = new ModalBuilder()
                .setCustomId('radio_remove_modal')
                .setTitle('🗑️ Remover Música do Rádio');

            const input = new TextInputBuilder()
                .setCustomId('radio_remove_input')
                .setLabel(`Número da faixa na lista (1 a ${session.playlist.length})`)
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('Ex: 1, 2, 5...')
                .setRequired(true)
                .setMaxLength(10);

            modal.addComponents(new ActionRowBuilder().addComponents(input));
            return await interaction.showModal(modal);
        }

        if (cid === 'radio_queue') {
            const embed = buildQueueEmbed(session);
            return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }

        if (cid === 'radio_voice_toggle') {
            const { isToolDisabled } = await import('../handlers/llmHandler.js');
            if (isToolDisabled(guildId, 'radio_voice_stt')) {
                return await interaction.reply({
                    content: '⚠️ **Reconhecimento de Voz (STT) Desativado no Servidor:** A escuta por voz do Rádio está desativada neste servidor por padrão para economia de recursos. Peça a um Administrador do servidor para ativá-la usando o comando `/yui-ferramentas`.',
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        const textChannel = interaction.channel;

        if (cid === 'radio_leave') {
            await interaction.deferUpdate().catch(() => {});
            await leaveRadioCall(guildId, textChannel, client);
            return;
        }

        await interaction.deferUpdate().catch(() => {});

        if (cid === 'radio_playpause') {
            if (session.status === 'PLAYING') {
                await pausePlayer(guildId);
            } else if (session.status === 'PAUSED') {
                await resumePlayer(guildId);
            } else if (session.status === 'STOPPED') {
                if (typeof session.currentIndex === 'number' && session.currentIndex >= (session.playlist?.length || 0)) {
                    updateSession(guildId, { currentIndex: -1 });
                }
                const first = nextTrack(guildId);
                if (first) await playTrack(guildId, first, textChannel, client);
            }
        } else if (cid === 'radio_stop') {
            stopPlayer(guildId);
            stopRadio(guildId);
        } else if (cid === 'radio_next') {
            if (session.status === 'STOPPED' && typeof session.currentIndex === 'number' && session.currentIndex >= (session.playlist?.length || 0)) {
                updateSession(guildId, { currentIndex: -1 });
            }
            const next = nextTrack(guildId);
            if (next) {
                await playTrack(guildId, next, textChannel, client);
            }
        } else if (cid === 'radio_prev') {
            if (session.status === 'STOPPED' && typeof session.currentIndex === 'number' && session.currentIndex >= (session.playlist?.length || 0)) {
                updateSession(guildId, { currentIndex: session.playlist ? session.playlist.length : 0 });
            }
            const prev = prevTrack(guildId);
            if (prev) {
                await playTrack(guildId, prev, textChannel, client);
            }
        } else if (cid === 'radio_shuffle') {
            toggleShuffle(guildId);
        } else if (cid === 'radio_loop') {
            setLoopMode(guildId);
        } else if (cid === 'radio_voice_toggle') {
            cycleVoiceMode(guildId);
        } else if (cid === 'radio_stream_mode') {
            toggleStreamMode(guildId);
        }

        const updatedSession = getSession(guildId);
        if (updatedSession) {
            const { buildRadioEmbed } = await import('./radioEmbed.js');
            const { embeds, components } = buildRadioEmbed(updatedSession);
            await interaction.editReply({ embeds, components }).catch(async () => {
                await updateEmbed(guildId, textChannel, client);
            });
        }
    } catch (err) {
        console.error('[RadioModalHandler] Erro ao tratar botão do rádio:', err);
        try {
            if (!interaction.replied && !interaction.deferred) {
                await interaction.reply({ content: '❌ Ocorreu um erro ao processar esta ação.', flags: MessageFlags.Ephemeral });
            }
        } catch (_) {}
    }
}

async function handleRadioModal(interaction, client) {
    if (interaction.customId !== 'radio_add_modal' && interaction.customId !== 'radio_remove_modal') return false;

    const guildId = interaction.guildId;
    const session = getSession(guildId);

    if (!session) {
        await interaction.reply({ content: '❌ Nenhuma sessão de rádio ativa.', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (!isUserInRadioChannel(interaction, session)) {
        await interaction.reply({ content: '❌ Você precisa estar no canal de voz do rádio.', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (interaction.customId === 'radio_remove_modal') {
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const valStr = interaction.fields.getTextInputValue('radio_remove_input')?.trim();
        const pos = parseInt(valStr, 10);

        if (isNaN(pos) || pos < 1 || pos > (session.playlist?.length || 0)) {
            await interaction.editReply({ content: `❌ Posição inválida. Digite um número entre 1 e ${session.playlist?.length || 0}.` });
            return true;
        }

        const result = removeTrackFromPlaylist(guildId, pos);
        if (!result) {
            await interaction.editReply({ content: '❌ Falha ao remover a faixa selecionada.' });
            return true;
        }

        const textChannel = interaction.channel;
        if (result.isCurrent) {
            stopPlayer(guildId);
            if (result.newCurrentTrack) {
                await playTrack(guildId, result.newCurrentTrack, textChannel, client);
            } else {
                await updateEmbed(guildId, textChannel, client);
            }
        } else {
            await updateEmbed(guildId, textChannel, client);
        }

        await interaction.editReply({ content: `🗑️ Removida a faixa #${pos}: **${result.removedTrack.title}** - ${result.removedTrack.artist}` });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);
        return true;
    }

    await interaction.deferReply({ flags: MessageFlags.Ephemeral });

    const query = interaction.fields.getTextInputValue('radio_add_input').trim();
    const textChannel = interaction.channel;
    const userId = interaction.user.id;

    const resolved = await resolveInput(query, guildId);

    if (resolved.type === 'not_found') {
        await interaction.editReply({ content: `❌ Não encontrei **"${query}"**.` });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);
        return true;
    }

    if (resolved.type === 'ambiguous') {
        const embed = buildAmbiguousEmbed(resolved.results);
        const pendingKey = `radio_ambiguous_${guildId}_${userId}`;
        radioAmbiguousSessions.set(pendingKey, { results: resolved.results, guildId, userId, textChannel, client });

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

        await interaction.editReply({
            content: 'Encontrei várias opções. Qual delas você quer? (Seleção automática da 1ª opção em 10s)',
            embeds: [embed],
            components: [row1, row2]
        });

        scheduleAmbiguousAutoSelect(pendingKey, interaction);
        return true;
    }

    if (resolved.type === 'playlist') {
        const tracks = resolved.tracks;
        const firstNewPos = (session.playlist?.length || 0) + 1;
        tracks.forEach(t => { t.addedBy = userId; addTrackToQueue(guildId, t); });

        const isPlayingOrActive = session.status === 'PLAYING' || session.status === 'BUFFERING' || session.status === 'PAUSED';
        if (!isPlayingOrActive) {
            skipToTrack(guildId, firstNewPos);
            const current = getSession(guildId)?.currentTrack;
            if (current) await playTrack(guildId, current, textChannel, client);
        } else {
            await updateEmbed(guildId, textChannel, client);
            prefetchNextTrack(guildId).catch(() => {});
        }

        await interaction.editReply({ content: `✅ **${tracks.length}** faixas adicionadas à fila!`, embeds: [], components: [] });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);
        return true;
    }

    if (resolved.type === 'track') {
        const track = { ...resolved.track, addedBy: userId };
        const pos = addTrackToQueue(guildId, track);
        const isPlayingOrActive = session.status === 'PLAYING' || session.status === 'BUFFERING' || session.status === 'PAUSED';

        if (!isPlayingOrActive) {
            skipToTrack(guildId, pos);
            const current = getSession(guildId)?.currentTrack;
            if (current) await playTrack(guildId, current, textChannel, client);
            await interaction.editReply({ content: `✅ Tocando **${track.title}** agora!`, embeds: [], components: [] });
        } else {
            await updateEmbed(guildId, textChannel, client);
            prefetchNextTrack(guildId).catch(() => {});
            await interaction.editReply({ content: `✅ **${track.title}** adicionada como **#${pos}** na fila!`, embeds: [], components: [] });
        }
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);
        return true;
    }

    return true;
}

async function handleAmbiguousSelect(interaction, client) {
    const cid = interaction.customId;
    if (!cid.startsWith('radio_ambiguous_select_') && !cid.startsWith('radio_ambiguous_cancel_')) return false;

    const parts = cid.split('_');
    const guildId = parts[3];
    const userId = parts[4];
    const pendingKey = `radio_ambiguous_${guildId}_${userId}`;
    const pending = radioAmbiguousSessions.get(pendingKey);

    if (!pending) {
        await interaction.reply({ content: '❌ Seleção expirada. Faça a busca novamente.', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (interaction.user.id !== userId) {
        await interaction.reply({ content: '❌ Esta seleção pertence a outro usuário.', flags: MessageFlags.Ephemeral });
        return true;
    }

    if (pending.timer) {
        try { clearTimeout(pending.timer); } catch (_) {}
    }

    if (cid.startsWith('radio_ambiguous_cancel_')) {
        radioAmbiguousSessions.delete(pendingKey);
        await interaction.update({ content: '❌ Cancelado.', embeds: [], components: [] });
        setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);
        return true;
    }

    const selectedIdx = parseInt(interaction.values[0], 10);
    const track = { ...pending.results[selectedIdx], addedBy: userId };

    radioAmbiguousSessions.delete(pendingKey);
    await interaction.update({ content: `✅ **${track.title}** selecionada!`, embeds: [], components: [] });
    setTimeout(() => { interaction.deleteReply().catch(() => {}); }, 5000);

    const session = getSession(guildId);
    const textChannel = pending.textChannel;

    const pos = addTrackToQueue(guildId, track);

    const isPlayingOrActive = session && (session.status === 'PLAYING' || session.status === 'BUFFERING' || session.status === 'PAUSED');
    if (!session || !isPlayingOrActive) {
        skipToTrack(guildId, pos);
        const current = getSession(guildId)?.currentTrack;
        if (current) await playTrack(guildId, current, textChannel, client);
    } else {
        await updateEmbed(guildId, textChannel, client);
        prefetchNextTrack(guildId).catch(() => {});
    }

    return true;
}

export { handleRadioButton, handleRadioModal, handleAmbiguousSelect };
export default {
    handleRadioButton,
    handleRadioModal,
    handleAmbiguousSelect
};
