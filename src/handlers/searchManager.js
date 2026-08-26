import axios from 'axios';
import * as cheerio from 'cheerio';
import dotenv from 'dotenv';
dotenv.config();
const SEARCH_CONFIG = {
    BING_ENDPOINT: 'https://www.bing.com/search',
    MAX_RESULTS_SCRAPE: 8,
    MAX_DEEP_READ: 3,
    MIN_CONTENT_LENGTH: 100,
    MAX_CONTENT_LENGTH: 2000,
    TIMEOUT_MS: 6000,
    DOMAIN_BLACKLIST: [
        'facebook.com', 'instagram.com', 'twitter.com', 'tiktok.com',
        'amazon.com', 'mercadolivre.com.br', 'shopee.com.br',
        'orders.google.com', 'myaccount.google.com', 'accounts.google.com'
    ],
    DOMAIN_WHITELIST: [
        'wikipedia.org', 'stackoverflow.com', 'github.com',
        'g1.globo.com', 'uol.com.br', 'techtudo.com.br',
        'cnnbrasil.com.br', 'bbc.com', 'mcpedl.com'
    ]
};
async function analyzeSearchIntent(prompt, providerFunc) {
    const searchTriggers = ['pesquise', 'pesquisa', 'procure', 'procurar', 'busque', 'buscar', 'search', 'google', 'check', 'consulte', 'verifique', 'quem', 'qual', 'quanto', 'como'];
    const lowerPrompt = prompt.toLowerCase();
    if (!searchTriggers.some(t => lowerPrompt.includes(t))) {
        return { shouldSearch: false, query: null };
    }
    const optimizerPrompt = `
[SYSTEM]
Você é um Otimizador de Busca SearchEngine (SEO).
Sua missão: Transformar o pedido do usuário em uma QUERY PERFEITA para o Bing/Google.
ENTRADA: "${prompt}"
REGRAS:
1. Ignore saudações e polidez ("por favor", "bom dia").
2. Identifique o NÚCLEO da busca (O que o usuário quer saber?).
3. Converta para palavras-chave diretas (se for técnico, prefira inglês).
4. Se for notícias/fatos, adicione o ano atual (2026).
5. REMOVA ASPAS da resposta final.
SAÍDA (Apenas uma linha):
SIM: termo da busca
ou
NAO
`;
    try {
        console.log(`[🔎 INTENT] Analisando intenção de busca...`);
        const responseCtx = await providerFunc(optimizerPrompt, "Responda apenas com o comando solicitado.");
        let cleanResponse = responseCtx.text.trim();
        cleanResponse = cleanResponse.replace(/"/g, '').replace(/\*/g, '');
        if (cleanResponse.toUpperCase().startsWith('SIM:')) {
            const query = cleanResponse.substring(4).trim();
            console.log(`[🔎 INTENT] Busca Aprovada. Query: "${query}"`);
            return { shouldSearch: true, query };
        }
        return { shouldSearch: false, query: null };
    } catch (e) {
        if (lowerPrompt.includes('pesquise') || lowerPrompt.includes('procure')) {
            const fallback = prompt.replace(/pesquise|procure|por favor|para mim/gi, '').trim();
            return { shouldSearch: true, query: fallback };
        }
        return { shouldSearch: false, query: null };
    }
}
async function executeBingSearch(query) {
    try {
        console.log(`[🔎 BING] Buscando: "${query}"`);
        const response = await axios.get(SEARCH_CONFIG.BING_ENDPOINT, {
            params: { q: query },
            headers: {
                'User-Agent': 'Mozilla/5.0 (iPhone; CPU iPhone OS 14_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/14.0 Mobile/15E148 Safari/604.1',
                'Accept-Language': 'pt-BR,pt;q=0.9,en-US;q=0.8,en;q=0.7',
                'Cookie': 'SRCHHPGUSR=SRCHLANG=pt'
            },
            timeout: SEARCH_CONFIG.TIMEOUT_MS
        });
        const $ = cheerio.load(response.data);
        const results = [];
        $('.b_algo').each((i, el) => {
            if (results.length >= SEARCH_CONFIG.MAX_RESULTS_SCRAPE) return false;
            const title = $(el).find('h2').text().trim();
            const link = $(el).find('a').attr('href');
            const snippet = $(el).find('.b_caption p').text().trim() ||
                $(el).find('.b_snippet').text().trim() ||
                $(el).find('.tab-content').text().trim() ||
                $(el).text().substring(0, 150);
            if (title && link) {
                results.push({ title, link, snippet, score: 0 });
            }
        });
        $('.b_focusText, .l_ec, .b_paractl, .rwrl').each((i, el) => {
            const text = $(el).text().trim();
            if (text.length > 10) {
                results.unshift({
                    title: "RESPOSTA RÁPIDA BING",
                    link: "#quick-answer",
                    snippet: text,
                    score: 999
                });
            }
        });
        return results;
    } catch (e) {
        console.error(`[🔎 BING ERROR] ${e.message}`);
        return [];
    }
}
function rankAndFilterResults(rawResults, query) {
    const keywords = query.toLowerCase().split(' ').filter(w => w.length > 2);
    const validResults = [];
    rawResults.forEach(r => {
        if (r.link === "#quick-answer") {
            r.score = 999;
            validResults.push(r);
            return;
        }
        let score = 0;
        const lowerTitle = r.title.toLowerCase();
        const lowerSnippet = r.snippet.toLowerCase();
        const lowerLink = r.link.toLowerCase();
        if (SEARCH_CONFIG.DOMAIN_BLACKLIST.some(d => lowerLink.includes(d))) {
            return;
        }
        try {
            const urlObj = new URL(r.link);
            if ((urlObj.pathname === '/' || urlObj.pathname.length < 2) && !lowerTitle.includes(keywords[0])) return;
            if (urlObj.pathname.includes('/login') || urlObj.pathname.includes('/signin')) return;
        } catch (e) { return; }
        keywords.forEach(kw => {
            if (lowerTitle.includes(kw)) score += 10;
        });
        keywords.forEach(kw => {
            if (lowerLink.includes(kw)) score += 15;
        });
        keywords.forEach(kw => {
            if (lowerSnippet.includes(kw)) score += 5;
        });
        if (lowerTitle.includes(query.toLowerCase())) {
            score += 20;
        }
        if (SEARCH_CONFIG.DOMAIN_WHITELIST.some(d => lowerLink.includes(d))) {
            score += 10;
        }
        if (r.link.split('/').length < 4) {
            score -= 5;
        }
        if (score > 10) {
            r.score = score;
            validResults.push(r);
        }
    });
    return validResults.sort((a, b) => b.score - a.score);
}
async function fetchPageContent(url) {
    try {
        console.log(`[🔎 READ] Lendo: ${url}`);
        const response = await axios.get(url, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                'Accept': 'text/html'
            },
            timeout: 5000
        });
        const $ = cheerio.load(response.data);
        $('script, style, nav, footer, header, aside, .ads, .menu, .sidebar, .comments, .related, .modal, .popup').remove();
        let root = $('article');
        if (root.length === 0) root = $('main');
        if (root.length === 0) root = $('#content, .content, #main, .main');
        if (root.length === 0) root = $('body');
        let text = '';
        root.find('p, h1, h2, h3, li').each((i, el) => {
            const t = $(el).text().replace(/\s+/g, ' ').trim();
            if (t.length > 40 || $(el).is('h1, h2')) {
                text += t + '\n';
            }
        });
        const finalContent = text.substring(0, SEARCH_CONFIG.MAX_CONTENT_LENGTH);
        const tokens = Math.ceil(finalContent.length / 4);
        console.log(`[🔎 STATS] ${url} -> ${finalContent.length} chars (~${tokens} tokens)`);
        return finalContent;
    } catch (e) {
        console.warn(`[🔎 FAIL] Falha ao ler ${url}: ${e.message}`);
        return null;
    }
}
async function smartSearch(prompt, providerFunc) {
    const decision = await analyzeSearchIntent(prompt, providerFunc);
    if (!decision.shouldSearch) return null;
    const rawResults = await executeBingSearch(decision.query);
    if (rawResults.length === 0) return null;
    const bestResults = rankAndFilterResults(rawResults, decision.query);
    console.log(`[🔎 FUNNEL] ${rawResults.length} Raw -> ${bestResults.length} Filtrados.`);
    if (bestResults.length === 0) {
        console.warn(`[🔎 FUNNEL WARN] Filtro removeu tudo. Usando fallback RAW.`);
        rawResults.slice(0, 2).forEach(r => bestResults.push(r));
    }
    const targets = bestResults.slice(0, SEARCH_CONFIG.MAX_DEEP_READ);
    console.log(`[🔎 TARGETS] Sites selecionados para leitura:`);
    targets.forEach(t => console.log(` - ${t.link.substring(0, 60)}... (${t.score} pts)`));
    const deepContents = await Promise.all(
        targets.map(async (r) => {
            if (r.link === "#quick-answer") return `[RESPOSTA RÁPIDA]: ${r.snippet}`;
            const content = await fetchPageContent(r.link);
            if (!content) return `[FONTE (Resumo): ${r.title}]\nURL: ${r.link}\nRESUMO (Site bloqueado/erro): ${r.snippet}\n--------------------`;
            return `[FONTE: ${r.title}]\nURL: ${r.link}\nCONTEÚDO: ${content}\n--------------------`;
        })
    );
    const finalContext = deepContents.filter(c => c).join('\n\n');
    const totalTokens = Math.ceil(finalContext.length / 4);
    console.log(`[🔎 CONTEXTO] Total Contexto Gerado: ${finalContext.length} chars (~${totalTokens} tokens)`);
    return finalContext.length > 0 ? finalContext : null;
}
export { smartSearch };
export default {
    smartSearch
};
