import axios from 'axios';
import * as cheerio from 'cheerio';
import { clampText } from '../discord/embedLimits.js';
import { logger } from '../utils/logger.js';

// Cada requisito vira uma linha de um campo de embed (1024 caracteres): 5 linhas de até 160 + rótulos cabem.
const REQ_VALUE_MAX = 160;
const clampReq = (value) => (typeof value === 'string' ? clampText(value, REQ_VALUE_MAX) : value);
const clampStr = (value, max) => (typeof value === 'string' ? clampText(value, max) : value);

// Rótulo de sistema operacional no começo de um item ("OS *: Windows 10", "SO: Windows 10").
// A forma curta é sensível a maiúsculas: "Os" / "os" são artigos do português ("Os requisitos...").
const OS_LABEL_SHORT = /^\s*(?:OS|SO|S\.O\.)\s*\*?\s*:/;
const OS_LABEL_LONG = /^\s*(?:sistema operacional|operating system)\b/i;
const isOsLine = (text) => OS_LABEL_SHORT.test(text) || OS_LABEL_LONG.test(text);

// Extrai só a linha de sistema operacional de um bloco HTML de requisitos. Antes o campo `os` recebia o
// bloco inteiro sem tags (duplicava processador, memória etc. e estourava o campo do embed).
function extractOs(html) {
    if (!html || typeof html !== 'string') return null;

    // 1º: itens de lista (<li>), o formato mais comum na Steam.
    const $ = cheerio.load('<div>' + html + '</div>');
    let found = null;
    $('li').each((i, el) => {
        if (found) return;
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text && isOsLine(text)) found = text;
    });
    if (found) return clampReq(found);

    // 2º: segmentos separados por <br>.
    const plain = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[^>]+>/g, ' ')
        .replace(/\r/g, '');
    const segment = plain.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).find(s => s && isOsLine(s));
    return segment ? clampReq(segment) : null;
}

// Extrai um campo específico (ex: "processor", "memory") de um bloco HTML de requisitos
const REQ_PATTERNS = {
    processor: /processador|processor|cpu/i,
    memory: /mem[oó]ria|memory|ram/i,
    graphics: /placa de v[íi]deo|gr[áa]fico|graphics|gpu|video/i,
    storage: /armazenamento|storage|espa[çc]o|hd|ssd/i
};

function extractRequirement(html, key) {
    if (!html || typeof html !== 'string') return null;
    const regex = REQ_PATTERNS[key];
    if (!regex) return null;

    // 1º: itens de lista (<li>) — formato mais comum na Steam
    // Prioriza itens com ":" (rótulo: valor) para evitar avisos genéricos
    // como "Requer um processador e sistema operacional de 64 bits".
    const $ = cheerio.load('<div>' + html + '</div>');
    let found = null;
    const liItems = [];
    $('li').each((i, el) => {
        const text = $(el).text().replace(/\s+/g, ' ').trim();
        if (text && regex.test(text)) liItems.push(text);
    });
    // Prefere li que contém ":" (formato "Rótulo: valor"). Se nenhum tiver ":", usa o primeiro.
    found = liItems.find(t => t.includes(':')) || liItems[0] || null;
    if (found) return found;

    // 2º: quebrar o texto por <br> e testar cada segmento
    const plain = html
        .replace(/<br\s*\/?>/gi, '\n')
        .replace(/<\/?[^>]+>/g, ' ')
        .replace(/\r/g, '');
    const segments = plain.split('\n').map(s => s.replace(/\s+/g, ' ').trim()).filter(Boolean);
    if (segments.length > 1) {
        // Prefere segmento com ":" (rótulo: valor)
        const withColon = segments.find(seg => regex.test(seg) && seg.includes(':'));
        if (withColon) return withColon;
        const anyMatch = segments.find(seg => regex.test(seg));
        if (anyMatch) return anyMatch;
    }

    // 3º: fallback — bloco único com vários requisitos juntos ("Processor: X Memory: Y")
    const singleLine = plain.replace(/\n/g, ' ').replace(/\s+/g, ' ').trim();
    const m = singleLine.match(regex);
    if (m) {
        let start = singleLine.indexOf(m[0]) + m[0].length;
        let end = singleLine.length;
        for (const otherKey of Object.keys(REQ_PATTERNS)) {
            if (otherKey === key) continue;
            const relIdx = singleLine.slice(start).search(REQ_PATTERNS[otherKey]);
            if (relIdx >= 0 && start + relIdx < end) end = start + relIdx;
        }
        const value = singleLine.slice(start, end).replace(/^[:.\s-]+/, '').trim();
        if (value) return value;
    }
    return null;
}


async function getSteamGameInfo(query) {
    try {
        // Só o tamanho no log (o nome vem do usuário) e a busca vai com no máximo 150 caracteres.
        logger.info(`[STEAM] Buscando jogo (${String(query ?? '').length} caracteres)`);
        const searchTerm = String(query ?? '').slice(0, 150);
        const searchRes = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(searchTerm)}&l=brazilian&cc=BR`, { timeout: 8000 });
        
        if (!searchRes.data || !searchRes.data.items || searchRes.data.items.length === 0) {
            return { error: `Não encontrei nenhum jogo com o nome "${clampText(query, 100)}" na Steam.` };
        }
        
        const game = searchRes.data.items[0]; 
        const appId = game.id;
        
        const detailsRes = await axios.get(`https://store.steampowered.com/api/appdetails?appids=${appId}&l=brazilian&cc=BR`, { timeout: 8000 });
        
        if (!detailsRes.data || !detailsRes.data[appId] || !detailsRes.data[appId].success) {
             return { error: `Encontrei o jogo na busca, mas não consegui puxar os detalhes do AppID ${appId}.` };
        }
        
        const data = detailsRes.data[appId].data;
        
        let desc = data.short_description || "";
        if (desc.includes('<')) {
            const $ = cheerio.load(desc);
            desc = $.text();
        }

        const price = data.price_overview ? data.price_overview.final_formatted : (data.is_free ? 'Gratuito' : 'Preço não disponível');
        const originalPrice = data.price_overview && data.price_overview.initial > data.price_overview.final ? data.price_overview.initial_formatted : null;
        const discount = data.price_overview ? data.price_overview.discount_percent : 0;
        
        // Requisitos de PC (já retornados pela Steam API, agora expostos)
        const requirementsOf = (html) => ({
            os: extractOs(html),
            processor: clampReq(extractRequirement(html, 'processor')),
            memory: clampReq(extractRequirement(html, 'memory')),
            graphics: clampReq(extractRequirement(html, 'graphics')),
            storage: clampReq(extractRequirement(html, 'storage'))
        });
        const pcRequirements = data.pc_requirements ? {
            minimum: requirementsOf(data.pc_requirements.minimum),
            recommended: data.pc_requirements.recommended ? requirementsOf(data.pc_requirements.recommended) : null
        } : null;

        return {
            success: true,
            name: clampStr(data.name, 200),
            appId: appId,
            price: price,
            originalPrice: originalPrice,
            discount: discount,
            description: desc,
            url: `https://store.steampowered.com/app/${appId}/`,
            headerImage: data.header_image,
            developers: data.developers ? clampStr(data.developers.join(', '), 300) : 'Desconhecido',
            publishers: data.publishers ? clampStr(data.publishers.join(', '), 300) : 'Desconhecido',
            releaseDate: data.release_date && data.release_date.date ? clampStr(data.release_date.date, 60) : 'Desconhecida',
            metacritic: data.metacritic ? data.metacritic.score : null,
            pcRequirements: pcRequirements
        };
        
    } catch (error) {
        logger.warn(`[STEAM] Erro na API: ${clampText(error?.message, 160)}`);
        return { error: `Deu um erro na conexão com a Steam: ${clampText(error?.message, 200)}` };
    }
}

export { getSteamGameInfo };
export default {
    getSteamGameInfo
};
