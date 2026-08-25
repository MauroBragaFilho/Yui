import { reportNewGuild } from '../handlers/tosHandler.js';
import { setAutoBlock } from '../handlers/banHandler.js';
import config from '../config/index.js';

export default {
    name: 'guildCreate',
    once: false,
    async execute(guild) {
        console.log(`[EVENT] Yui foi adicionada ao servidor: ${guild.name} (${guild.id})`);
        const defaultMode = config.defaultAutoMod !== false ? (config.automodMode || 'both') : 'off';
        setAutoBlock(guild.id, defaultMode);
        await reportNewGuild(guild);
    },
};
