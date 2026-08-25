import { REST, Routes } from 'discord.js';
import { setDiscordClient, setOnQueueUpdate } from '../handlers/llmHandler.js';
import { updateBotActivity } from '../utils/activity.js';
import { registerCommands, commands } from '../commands/slashCommands.js';
import config from '../config/index.js';

export default {
    name: 'ready',
    once: true,
    async execute(client) {
        console.log(`Logado como ${client.user.tag}!`);

        setDiscordClient(client);
        setOnQueueUpdate((queueLength) => updateBotActivity(client, queueLength));

        const rest = new REST({ version: '10' }).setToken(config.discord.token);

        try {
            console.log('Iniciando registro de comandos...');
            await rest.put(
                Routes.applicationCommands(client.user.id),
                { body: commands },
            );
            console.log('Comandos registrados com sucesso.');
        } catch (error) {
            console.error('Erro ao registrar comandos:', error);
        }

        updateBotActivity(client, 0);
    },
};
