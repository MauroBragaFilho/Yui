// Porta G (GTA Online por conversa): executa o MESMO que /gta-diario, /gta-semanal e /gta-noticias e devolve TEXTO para o chat.
// O CÓDIGO coleta (cache do banco, coleta só se faltar), a conversa só mostra o resultado: nada de a IA inventar os bônus.
// Dependências por parâmetro (banco, motores, embeds) para testar offline; os imports reais só acontecem em runGtaIntent sem deps.

export const GTA_CHAT_MAX_CHARS = 3800;

/** Converte embeds do discord.js (ou objetos iguais ao toJSON) em texto simples, na ordem. */
export function embedsToText(embeds, { maxChars = GTA_CHAT_MAX_CHARS } = {}) {
    const blocks = [];
    for (const e of embeds ?? []) {
        const j = typeof e?.toJSON === 'function' ? e.toJSON() : (e ?? {});
        const lines = [];
        if (j.title) lines.push(`**${j.title}**`);
        if (j.description) lines.push(String(j.description));
        for (const f of j.fields ?? []) {
            if (!f?.name && !f?.value) continue;
            lines.push(`${f.name ? `**${f.name}**\n` : ''}${f.value ?? ''}`.trim());
        }
        if (lines.length) blocks.push(lines.join('\n'));
    }
    let text = blocks.join('\n\n').replace(/\n{3,}/g, '\n\n').trim();
    if (text.length > maxChars) {
        text = `${text.slice(0, maxChars).replace(/\s+\S*$/, '').trimEnd()}\n\n-# Resumo cortado: para ver tudo, use /gta-semanal.`;
    }
    return text;
}

async function realDeps() {
    const [{ gtaoRepository }, { gtaoEngine }, { weeklyService }, weeklyAnalysis, { getCurrentWeekKey }, { createDailyEmbed }, { newsRepository }, { newswireEngine }, { createNewswireEmbed }] = await Promise.all([
        import('../database/repositories/gtaoRepo.js'),
        import('../engines/gtao/index.js'),
        import('../engines/gtao/systems/weekly/service.js'),
        import('../engines/gtao/weeklyAnalysis.js'),
        import('../utils/weekKey.js'),
        import('../discord/embeds/dailyEmbed.js'),
        import('../database/repositories/newsRepo.js'),
        import('../engines/newswire/index.js'),
        import('../discord/embeds/newswireEmbed.js'),
    ]);
    return {
        gtaoRepository, gtaoEngine, weeklyService, getCurrentWeekKey, createDailyEmbed, newsRepository, newswireEngine, createNewswireEmbed,
        buildWeeklyCombinedEmbeds: weeklyAnalysis.buildWeeklyCombinedEmbeds,
    };
}

/**
 * @param {'daily'|'weekly'|'news'} kind
 * @returns {Promise<{ ok: boolean, text: string }>}   nunca lança
 */
export async function runGtaIntent(kind, { deps = null, logger = null } = {}) {
    const warn = (m) => { try { logger?.warn?.(m); } catch { /* ok */ } };
    try {
        const d = deps ?? await realDeps();
        if (kind === 'daily') {
            const todayStr = new Date().toISOString().split('T')[0];
            let data = d.gtaoRepository.getDaily(todayStr)?.data;
            if (!data) data = await d.gtaoEngine.collectDaily();
            if (!data) return { ok: false, text: 'Não consegui carregar o reset diário do GTA Online agora. Tenta de novo daqui a pouco.' };
            return { ok: true, text: embedsToText([d.createDailyEmbed(data)]) };
        }
        if (kind === 'weekly') {
            const weekKey = d.getCurrentWeekKey();
            const latest = d.gtaoRepository.getLatestWeekly();
            let data = latest?.data;
            let needsCollect = !latest || latest.event_week !== weekKey;
            if (!needsCollect && data?.source === 'reddit' && data?.id) {
                try {
                    const post = await d.weeklyService.getLatest();
                    if (post && post.id !== data.id) needsCollect = true; // saiu post novo no Reddit desde o cache
                } catch (err) { warn(`[GTA-Chat] Reddit indisponível para conferir (${String(err?.message ?? err).slice(0, 80)}); uso o cache.`); }
            }
            if (needsCollect) {
                try { data = await d.gtaoEngine.collectWeekly({ source: 'reddit' }); } catch (err) { warn(`[GTA-Chat] Falha ao coletar o semanal: ${String(err?.message ?? err).slice(0, 80)}`); }
                if (!data && latest?.data && latest.event_week === weekKey) data = latest.data;
                // Reddit bloqueado/fora: tenta o Rockstar Newswire (a outra fonte do /gta-semanal) antes de desistir.
                if (!data) { try { data = await d.gtaoEngine.collectWeekly({ source: 'newswire' }); } catch (err) { warn(`[GTA-Chat] Newswire também falhou: ${String(err?.message ?? err).slice(0, 80)}`); } }
            }
            if (!data) return { ok: false, text: 'Não consegui carregar o evento semanal do GTA Online agora. Tenta de novo em alguns minutos.' };
            const daily = d.gtaoRepository.getLatestDaily()?.data;
            return { ok: true, text: embedsToText(d.buildWeeklyCombinedEmbeds(data, daily)) };
        }
        if (kind === 'news') {
            let list = d.newsRepository.getLatest(2);
            if (!list || list.length === 0) { await d.newswireEngine.checkLatestNews(); list = d.newsRepository.getLatest(2); }
            if (!list || list.length === 0) return { ok: false, text: 'Não achei notícias do Rockstar Newswire no momento.' };
            return { ok: true, text: embedsToText(list.map((a) => d.createNewswireEmbed(a))) };
        }
        return { ok: false, text: '' };
    } catch (err) {
        warn(`[GTA-Chat] Erro inesperado: ${String(err?.message ?? err).slice(0, 100)}`);
        return { ok: false, text: 'Tive um problema ao buscar isso do GTA Online. Tenta de novo daqui a pouco.' };
    }
}
