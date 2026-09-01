import { ApplicationIntegrationType, InteractionContextType } from 'discord.js';

/**
 * Aplica o contexto global (DM + User Install + Guild) a um SlashCommandBuilder.
 * Isso permite que o comando apareça e funcione em:
 *   - Servidores (Guild)
 *   - DMs do bot (BotDM)
 *   - Canais privados de grupo (PrivateChannel)
 *   - User Install (aplicação instalada pelo usuário)
 */
export const setGlobalContext = (builder) => {
    return builder
        .setIntegrationTypes([
            ApplicationIntegrationType.GuildInstall,
            ApplicationIntegrationType.UserInstall
        ])
        .setContexts([
            InteractionContextType.BotDM,
            InteractionContextType.Guild,
            InteractionContextType.PrivateChannel
        ]);
};
