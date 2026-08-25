const { reportNewGuild } = require('../handlers/tosHandler');
const { setAutoBlock } = require('../handlers/banHandler');
const config = require('../config');
module.exports = {
    name: 'guildCreate',
    once: false,
    async execute(guild) {
        console.log(`[EVENT] Yui foi adicionada ao servidor: ${guild.name} (${guild.id})`);
        const defaultMode = config.defaultAutoMod !== false ? (config.automodMode || 'both') : 'off';
        setAutoBlock(guild.id, defaultMode);
        await reportNewGuild(guild);
    },
};