const { ActivityType } = require('discord.js');

const lyrics = [
    "Baby, I don't wanna move, guess I'd rather rot in my room",
    "I forget how to live, I can only sing on a tune",
    "I can't, I can't think of what to say and my brain goes boom",
    "I hate reality, wish I could live in a cartoon",
    "Let me be your perfect princess",
    "Magic sparkles in my eyes",
    "Write me into your existence",
    "Program me just like AI"
];

let currentIndex = 0;
let activityInterval = null;

function applyStatus(clientInstance) {
    if (!clientInstance || !clientInstance.user) return;
    const currentLine = `"${lyrics[currentIndex]}"; Program me - Robopup`;
    clientInstance.user.setPresence({
        activities: [{
            name: currentLine,
            state: currentLine,
            type: ActivityType.Custom
        }],
        status: 'dnd'
    });
    currentIndex = (currentIndex + 1) % lyrics.length;
}

function startActivityUpdater(client) {
    if (activityInterval) {
        clearInterval(activityInterval);
    }
    currentIndex = 0;
    if (client && client.user) {
        applyStatus(client);
    }
    activityInterval = setInterval(() => {
        applyStatus(client);
    }, 4000);
}

function updateBotActivity(clientInstance, queueLength) {
    if (!clientInstance || !clientInstance.user) return;
    if (!activityInterval) {
        startActivityUpdater(clientInstance);
    }
}

module.exports = { updateBotActivity, startActivityUpdater };