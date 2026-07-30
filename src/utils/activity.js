const { ActivityType } = require('discord.js');
function updateBotActivity(clientInstance, queueLength) {
    if (!clientInstance || !clientInstance.user) return;
    if (queueLength === 0) {
        clientInstance.user.setActivity('Novo modo radio! | "Hikari" (光) em japonês significa "luz"', { type: ActivityType.Watching });
        clientInstance.user.setStatus('dnd');
    }
}
function startActivityUpdater(client) {
    updateBotActivity(client, 0);
}
module.exports = { updateBotActivity, startActivityUpdater };