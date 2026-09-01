import { setDiscordClient, setOnQueueUpdate } from '../handlers/llmHandler.js';
import { updateBotActivity } from '../utils/activity.js';

export default {
    name: 'ready',
    once: true,
    async execute(client) {
        console.log(`Logado como ${client.user.tag}!`);

        setDiscordClient(client);
        setOnQueueUpdate((queueLength) => updateBotActivity(client, queueLength));

        updateBotActivity(client, 0);
    },
};
