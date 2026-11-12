import { removeAcceptedServer } from '../handlers/tosHandler.js';
import { logger } from '../utils/logger.js';

const errText = (err) => (err && err.message ? err.message : String(err));

/**
 * Yui saiu (ou foi removida) de um servidor: limpa SÓ os dados daquele servidor (aceite dos termos, configurações de canais em
 * guild_settings e fios de contexto por horas que não são de memória pessoal). Não mexe em memória pessoal, listas, lembretes
 * nem banimentos. Nunca lança; cada etapa falha sozinha. As dependências entram por parâmetro para testar sem banco nem Discord.
 */
export async function handleGuildDelete(guild, deps = {}) {
    const result = { skipped: false, tos: false, settings: false, context: false };
    try {
        if (!guild || !guild.id) { result.skipped = true; return result; }
        // guildDelete também dispara quando o servidor só ficou indisponível (outage): a Yui continua lá, então nada é apagado.
        if (guild.available === false) {
            logger.info(`[EVENT] Servidor ${guild.id} ficou indisponível (queda do Discord); nada foi apagado.`);
            result.skipped = true;
            return result;
        }
        const id = String(guild.id);
        logger.info(`[EVENT] Yui foi removida do servidor ${id}; limpando os dados dele.`);
        try { (deps.removeAcceptedServer || removeAcceptedServer)(id); result.tos = true; }
        catch (err) { logger.warn(`[EVENT] guildDelete: não consegui remover o aceite dos termos (${id}): ${errText(err)}`); }
        try {
            const repo = deps.guildRepository || (await import('../database/repositories/guildRepo.js')).guildRepository;
            repo.delete(id);
            result.settings = true;
        } catch (err) { logger.warn(`[EVENT] guildDelete: não consegui apagar as configurações do servidor ${id}: ${errText(err)}`); }
        try {
            const forget = deps.forgetGuildContext || (await import('../core/context/contextStore.js')).forgetGuildContext;
            await forget(id);
            result.context = true;
        } catch (err) { logger.warn(`[EVENT] guildDelete: não consegui apagar o contexto do servidor ${id}: ${errText(err)}`); }
    } catch (err) {
        try { logger.warn(`[EVENT] guildDelete falhou: ${errText(err)}`); } catch (_) { /* nunca lança */ }
    }
    return result;
}

export default {
    name: 'guildDelete',
    once: false,
    async execute(guild) {
        await handleGuildDelete(guild);
    },
};
