import { ActivityType } from 'discord.js';

const PREMID_YTMUSIC_APP_ID = '463151177836658699';

const PLATFORM_PRIORITY = [
    {
        id: 'spotify',
        label: 'Spotify',
        emoji: '🟢',
        match: (a) => a.name === 'Spotify' && a.type === ActivityType.Listening,
        extract: (a) => ({
            title: a.details,
            artist: a.state?.replace(/^by\s+/i, '') || null,
            album: a.assets?.largeText || null,
            coverUrl: a.assets?.largeImage?.startsWith('spotify:')
                ? `https://i.scdn.co/image/${a.assets.largeImage.replace('spotify:', '')}`
                : null,
        }),
    },
    {
        id: 'ytmusic',
        label: 'YouTube Music',
        emoji: '▶️',
        match: (a) =>
            (a.applicationId === PREMID_YTMUSIC_APP_ID ||
                a.name?.toLowerCase() === 'youtube music') &&
            a.details,
        extract: (a) => ({
            title: a.details,
            artist: a.state || null,
            album: a.assets?.largeText || null,
            coverUrl: typeof a.assets?.largeImage === 'string' && a.assets.largeImage.startsWith('http')
                ? a.assets.largeImage
                : null,
        }),
    },
    {
        id: 'other',
        label: 'Outros',
        emoji: '🎵',
        match: (a) => a.type === ActivityType.Listening && a.details,
        extract: (a) => ({
            title: a.details,
            artist: a.state || null,
            album: a.assets?.largeText || null,
            coverUrl: typeof a.assets?.largeImage === 'string' && a.assets.largeImage.startsWith('http')
                ? a.assets.largeImage
                : null,
        }),
    },
];

async function resolveMember(userId, client, preferGuildId = null) {
    const cleanId = String(userId).replace(/[<@!>]/g, '').trim();
    let candidateMember = null;

    if (preferGuildId) {
        const guild = client.guilds.cache.get(preferGuildId);
        if (guild) {
            try {
                const member = await guild.members.fetch({ user: cleanId, force: true, withPresences: true }).catch(() => null);
                if (member) {
                    if (member.presence) return member;
                    candidateMember = member;
                }
            } catch (_) {}
        }
    }

    for (const guild of client.guilds.cache.values()) {
        if (preferGuildId && guild.id === preferGuildId) continue;
        try {
            const member = await guild.members.fetch({ user: cleanId, force: true, withPresences: true }).catch(() => null);
            if (member) {
                if (member.presence) return member;
                if (!candidateMember) candidateMember = member;
            }
        } catch (_) {}
    }
    return candidateMember;
}

async function getCurrentMusicFromUser(userId, client, preferGuildId = null) {
    const cleanId = String(userId).replace(/[<@!>]/g, '').trim();
    const member = await resolveMember(cleanId, client, preferGuildId);

    if (!member) {
        return {
            success: false,
            reason: 'no_guild',
            message: `Não consegui encontrar a presença do usuário (${cleanId}) em nenhum servidor comum.`,
        };
    }

    if (!member.presence) {
        return {
            success: false,
            reason: 'no_presence',
            message: `A presença do usuário ${member.user.displayName || member.user.username} está invisível ou indisponível.`,
            helpInstructions: true,
        };
    }

    const activities = member.presence.activities || [];

    for (const platform of PLATFORM_PRIORITY) {
        const activity = activities.find(a => platform.match(a));
        if (!activity) continue;

        const data = platform.extract(activity);
        if (!data.title) continue;

        const artistName = data.artist || 'Artista desconhecido';
        const platformLabel = platform.label || 'Outros';

        const searchQuery = [data.title, data.artist].filter(Boolean).join(' ');
        return {
            success: true,
            platform: platform.id,
            platformLabel,
            platformEmoji: platform.emoji,
            title: data.title,
            artist: artistName,
            album: data.album || null,
            coverUrl: data.coverUrl || null,
            targetUser: {
                id: member.user.id,
                username: member.user.username,
                displayName: member.user.globalName || member.user.username,
            },
            searchQuery,
        };
    }

    return {
        success: false,
        reason: 'no_music',
        message: `O usuário ${member.user.displayName || member.user.username} não está ouvindo nenhuma música no momento.`,
    };
}

export default { getCurrentMusicFromUser };
