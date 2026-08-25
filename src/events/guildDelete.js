const { removeAcceptedServer } = require('../handlers/tosHandler');

module.exports = {
    name: 'guildDelete',
    once: false,
    async execute(guild) {
        if (!guild || !guild.id) return;
        console.log(`[EVENT] Yui foi removida do servidor: ${guild.name} (${guild.id})`);
        removeAcceptedServer(guild.id);
    },
};
