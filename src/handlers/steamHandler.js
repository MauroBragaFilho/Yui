import axios from 'axios';
import * as cheerio from 'cheerio';

// Remove tags HTML de uma string e retorna texto limpo
function stripHtml(html) {
    if (!html || typeof html !== 'string') return null;
    const $ = cheerio.load('<div>' + html + '</div>');
    return $.text().replace(/\s+/g, ' ').trim() || null;
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
        console.log(`[STEAM] Buscando jogo: ${query}`);
        const searchRes = await axios.get(`https://store.steampowered.com/api/storesearch/?term=${encodeURIComponent(query)}&l=brazilian&cc=BR`, { timeout: 8000 });
        
        if (!searchRes.data || !searchRes.data.items || searchRes.data.items.length === 0) {
            return { error: `Não encontrei nenhum jogo com o nome "${query}" na Steam.` };
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
        const pcRequirements = data.pc_requirements ? {
            minimum: {
                os: data.pc_requirements.minimum ? stripHtml(data.pc_requirements.minimum) : null,
                processor: extractRequirement(data.pc_requirements.minimum, 'processor'),
                memory: extractRequirement(data.pc_requirements.minimum, 'memory'),
                graphics: extractRequirement(data.pc_requirements.minimum, 'graphics'),
                storage: extractRequirement(data.pc_requirements.minimum, 'storage')
            },
            recommended: data.pc_requirements.recommended ? {
                os: stripHtml(data.pc_requirements.recommended),
                processor: extractRequirement(data.pc_requirements.recommended, 'processor'),
                memory: extractRequirement(data.pc_requirements.recommended, 'memory'),
                graphics: extractRequirement(data.pc_requirements.recommended, 'graphics'),
                storage: extractRequirement(data.pc_requirements.recommended, 'storage')
            } : null
        } : null;

        return {
            success: true,
            name: data.name,
            appId: appId,
            price: price,
            originalPrice: originalPrice,
            discount: discount,
            description: desc,
            url: `https://store.steampowered.com/app/${appId}/`,
            headerImage: data.header_image,
            developers: data.developers ? data.developers.join(', ') : 'Desconhecido',
            publishers: data.publishers ? data.publishers.join(', ') : 'Desconhecido',
            releaseDate: data.release_date && data.release_date.date ? data.release_date.date : 'Desconhecida',
            metacritic: data.metacritic ? data.metacritic.score : null,
            pcRequirements: pcRequirements
        };
        
    } catch (error) {
        console.error('[STEAM] Erro na API:', error.message);
        return { error: `Deu um erro na conexão com a Steam: ${error.message}` };
    }
}

export { getSteamGameInfo };
export default {
    getSteamGameInfo
};
