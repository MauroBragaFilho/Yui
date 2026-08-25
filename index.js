import dotenv from 'dotenv';
dotenv.config();

import { Client, GatewayIntentBits, Partials, Collection } from 'discord.js';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import config from './src/config.js';
import { hookConsoleAndStreams } from './src/utils/logger.js';
import { startActivityUpdater } from './src/utils/activity.js';
import { setDiscordClient } from './src/handlers/llmHandler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildPresences,
        GatewayIntentBits.GuildVoiceStates,
    ],
    partials: [Partials.Channel, Partials.Message, Partials.User],
});

hookConsoleAndStreams(config.logWebhookUrl);
setDiscordClient(client);

const eventsPath = path.join(__dirname, 'src/events');
const eventFiles = fs.readdirSync(eventsPath).filter(file => file.endsWith('.js'));

(async () => {
    for (const file of eventFiles) {
        const filePath = path.join(eventsPath, file);
        const event = await import(filePath);
        if (event.once) {
            client.once(event.default.name, (...args) => event.default.execute(...args, client));
        } else {
            client.on(event.default.name, (...args) => event.default.execute(...args, client));
        }
    }

    startActivityUpdater(client);

    client.login(config.discordToken).catch(err => {
        console.error('Falha no login:', err);
    });
})();