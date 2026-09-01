import axios from 'axios';
import * as cheerio from 'cheerio';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ──────────────────────────────────────────────
// RAWG.io API
// ──────────────────────────────────────────────

const RAWG_CACHE_PATH = path.join(__dirname, '../data/rawg_cache.json');
const RAWG_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function loadRawgCache() {
    try {
        if (fs.existsSync(RAWG_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(RAWG_CACHE_PATH, 'utf8'));
        }
    } catch (_) {}
    return {};
}

function saveRawgCache(cache) {
    try {
        fs.mkdirSync(path.dirname(RAWG_CACHE_PATH), { recursive: true });
        fs.writeFileSync(RAWG_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch (_) {}
}

function rawgCacheKey(name) {
    return name.toLowerCase().trim().replace(/\s+/g, '-');
}

async function getGameInfoFromRAWG(gameName) {
    const apiKey = process.env.RAWG_API_KEY;
    if (!apiKey) {
        console.warn('[RAWG] RAWG_API_KEY não configurada no .env. Pulando RAWG.');
        return null;
    }

    const cache = loadRawgCache();
    const key = rawgCacheKey(gameName);
    const cached = cache[key];
    if (cached && (Date.now() - (cached.timestamp || 0)) < RAWG_CACHE_TTL_MS) {
        console.log(`[RAWG] Cache hit para "${gameName}".`);
        return cached.data;
    }

    try {
        console.log(`[RAWG] Buscando jogo: ${gameName}`);
        const searchRes = await axios.get(
            `https://api.rawg.io/api/games?search=${encodeURIComponent(gameName)}&key=${apiKey}&page_size=1`,
            { timeout: 8000 }
        );

        if (!searchRes.data || !searchRes.data.results || searchRes.data.results.length === 0) {
            console.log(`[RAWG] Nenhum resultado para "${gameName}".`);
            return null;
        }

        const slug = searchRes.data.results[0].slug;
        const detailRes = await axios.get(
            `https://api.rawg.io/api/games/${slug}?key=${apiKey}`,
            { timeout: 8000 }
        );

        const d = detailRes.data;
        const result = {
            name: d.name,
            slug: d.slug,
            rating: d.rating || null,
            metacritic: d.metacritic || null,
            genres: (d.genres || []).map(g => g.name),
            platforms: (d.platforms || []).map(p => p.platform.name),
            released: d.released || null,
            developers: (d.developers || []).map(dev => dev.name),
            publishers: (d.publishers || []).map(pub => pub.name),
            description: (d.description_raw || d.description || '').substring(0, 1000),
            backgroundImage: d.background_image || null,
            website: d.website || null,
            playtime: d.playtime || null,
            esrbRating: d.esrb_rating ? d.esrb_rating.name : null
        };

        cache[key] = { timestamp: Date.now(), data: result };
        saveRawgCache(cache);
        console.log(`[RAWG] Dados obtidos para "${result.name}" — Rating: ${result.rating}`);
        return result;
    } catch (error) {
        console.error(`[RAWG] Erro ao buscar "${gameName}":`, error.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// HowLongToBeat (scraping)
// ──────────────────────────────────────────────

const HLTB_CACHE_PATH = path.join(__dirname, '../data/hltb_cache.json');
const HLTB_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

function loadHltbCache() {
    try {
        if (fs.existsSync(HLTB_CACHE_PATH)) {
            return JSON.parse(fs.readFileSync(HLTB_CACHE_PATH, 'utf8'));
        }
    } catch (_) {}
    return {};
}

function saveHltbCache(cache) {
    try {
        fs.mkdirSync(path.dirname(HLTB_CACHE_PATH), { recursive: true });
        fs.writeFileSync(HLTB_CACHE_PATH, JSON.stringify(cache, null, 2), 'utf8');
    } catch (_) {}
}

async function getPlaytimeFromHLTB(gameName) {
    const cache = loadHltbCache();
    const key = gameName.toLowerCase().trim();
    const cached = cache[key];
    if (cached && (Date.now() - (cached.timestamp || 0)) < HLTB_CACHE_TTL_MS) {
        console.log(`[HLTB] Cache hit para "${gameName}".`);
        return cached.data;
    }

    const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

    try {
        console.log(`[HLTB] Buscando tempo de jogo: ${gameName}`);

        // The HowLongToBeat API exige um "init" que libera token + hp para a busca
        const initRes = await axios.get(`https://howlongtobeat.com/api/search/site/init?t=${Date.now()}`, {
            timeout: 10000,
            headers: { 'User-Agent': UA, 'Referer': 'https://howlongtobeat.com/' }
        });
        const initData = initRes.data;
        if (!initData || !initData.token) {
            console.warn('[HLTB] Init sem token (site pode ter mudado).');
            return null;
        }
        const userAgent = initData.userAgent || UA;

        const payload = {
            [initData.hpKey]: initData.hpVal,
            searchType: 'games',
            searchTerms: gameName.split(/\s+/),
            searchPage: 1,
            size: 20,
            searchOptions: {
                games: {
                    userId: 0,
                    platform: '',
                    sortCategory: 'popular',
                    rangeCategory: 'main',
                    rangeTime: { min: 0, max: 0 },
                    gameplay: { perspective: '', flow: '', genre: '', difficulty: '' },
                    rangeYear: { min: '', max: '' },
                    modifier: ''
                },
                users: { sortCategory: 'postcount' },
                lists: { sortCategory: 'follows' },
                filter: '',
                sort: 0,
                randomizer: 0
            },
            useCache: true
        };

        const searchRes = await axios.post('https://howlongtobeat.com/api/search/site', payload, {
            timeout: 15000,
            headers: {
                'Content-Type': 'application/json',
                'User-Agent': userAgent,
                'Accept': '*/*',
                'Referer': 'https://howlongtobeat.com/',
                'X-Auth-Token': initData.token,
                'X-Hp-Key': initData.hpKey,
                'X-Hp-Val': initData.hpVal
            }
        });

        if (!searchRes.data || !searchRes.data.data || searchRes.data.data.length === 0) {
            console.log(`[HLTB] Nenhum resultado para "${gameName}".`);
            return null;
        }

        const game = searchRes.data.data[0];
        const fmt = (s) => (!s || s <= 0) ? null : `${Math.round(s / 3600)}h`;
        const result = {
            name: game.game_name || gameName,
            mainStory: fmt(game.comp_main),
            mainExtras: fmt(game.comp_plus),
            completionist: fmt(game.comp_100),
            allStyles: fmt(game.comp_all)
        };

        cache[key] = { timestamp: Date.now(), data: result };
        saveHltbCache(cache);
        console.log(`[HLTB] Tempos: "${result.name}" — Story=${result.mainStory}, Extras=${result.mainExtras}, 100%=${result.completionist}`);
        return result;
    } catch (error) {
        console.error(`[HLTB] Erro ao buscar "${gameName}":`, error.response ? `status ${error.response.status}` : error.message);
        return null;
    }
}

// ──────────────────────────────────────────────
// Função consolidada
// ──────────────────────────────────────────────

async function getGameInfo(gameName) {
    if (!gameName || !gameName.trim()) {
        return { error: 'Preciso do nome do jogo pra consultar.' };
    }
    const trimmed = gameName.trim();
    const [rawgData, hltbData] = await Promise.all([
        getGameInfoFromRAWG(trimmed),
        getPlaytimeFromHLTB(trimmed)
    ]);

    if (!rawgData && !hltbData) {
        return { error: `Não consegui encontrar dados sobre "${trimmed}" em nenhuma fonte.` };
    }

    return {
        success: true,
        name: (rawgData && rawgData.name) || trimmed,
        rating: rawgData ? rawgData.rating : null,
        metacritic: rawgData ? rawgData.metacritic : null,
        genres: rawgData ? rawgData.genres : [],
        platforms: rawgData ? rawgData.platforms : [],
        released: rawgData ? rawgData.released : null,
        developers: rawgData ? rawgData.developers : [],
        description: rawgData ? rawgData.description : null,
        backgroundImage: rawgData ? rawgData.backgroundImage : null,
        esrbRating: rawgData ? rawgData.esrbRating : null,
        playtime: rawgData ? rawgData.playtime : null,
        hltb: hltbData || null
    };
}

/**
 * Busca detalhes de um jogo via RAWG + HLTB, com fallback para a Steam
 * (gratuita, sem key) quando a RAWG não está configurada/disponível.
 */
async function getGameInfoWithSteamFallback(gameName) {
    const base = await getGameInfo(gameName);
    if (!base || base.error) return base;
    if (base.rating != null || base.metacritic != null) return base;

    // Fallback: Steam fornece sinopse e Metacritic sem key
    try {
        const { getSteamGameInfo } = await import('./steamHandler.js');
        const steam = await getSteamGameInfo(base.name);
        if (steam && steam.success) {
            base.metacritic = base.metacritic ?? steam.metacritic;
            base.description = base.description || steam.description;
            base.steamPrice = steam.price;
            base.steamUrl = steam.url;
            base.steamHeaderImage = steam.headerImage || null;
        }
    } catch (e) {
        console.warn('[GameInfo] Fallback Steam falhou:', e.message);
    }
    return base;
}

// ──────────────────────────────────────────────
// Comparação de specs de PC
// ──────────────────────────────────────────────

function parseSpecValue(str) {
    if (!str || typeof str !== 'string') return null;
    const match = str.match(/([\d.,]+)\s*(GB|MB|TB|GHz|MHz)?/i);
    if (!match) return null;
    let value = parseFloat(match[1].replace(',', '.'));
    const unit = (match[2] || '').toUpperCase();
    if (unit === 'TB') value *= 1024;
    if (unit === 'MB') value /= 1024;
    if (unit === 'MHz') value /= 1000;
    return { value, unit: unit || null, raw: str.trim() };
}

function compareSpecs(userSpecs, gameReqs) {
    if (!userSpecs || !gameReqs) {
        return { verdict: 'unknown', details: 'Dados insuficientes para comparação.' };
    }
    const min = gameReqs.minimum || {};
    const rec = gameReqs.recommended || {};
    const issues = [];
    const strengths = [];

    // Comparar RAM
    if (userSpecs.ram && min.memory) {
        const userRam = parseSpecValue(userSpecs.ram);
        const minRam = parseSpecValue(min.memory);
        if (userRam && minRam) {
            if (userRam.value < minRam.value) {
                issues.push(`RAM: ${userSpecs.ram} menor que o mínimo (${min.memory})`);
            } else {
                const recRam = rec.memory ? parseSpecValue(rec.memory) : null;
                if (recRam && userRam.value >= recRam.value) {
                    strengths.push(`RAM: ${userSpecs.ram} acima do recomendado`);
                } else {
                    strengths.push(`RAM: ${userSpecs.ram} atende o mínimo`);
                }
            }
        }
    }

    // Comparar GPU (por nome)
    if (userSpecs.gpu && min.graphics) {
        const userGpuLower = userSpecs.gpu.toLowerCase();
        const minGpuWords = min.graphics.toLowerCase().split(/\s+/).filter(w => w.length > 3);
        const matchesMin = minGpuWords.filter(w => userGpuLower.includes(w)).length;
        if (matchesMin < 1 && !userGpuLower.includes('rtx') && !userGpuLower.includes('gtx')) {
            issues.push(`GPU: ${userSpecs.gpu} pode ser inferior ao mínimo (${min.graphics})`);
        } else {
            strengths.push(`GPU: ${userSpecs.gpu} parece atender`);
        }
    }

    // Comparar CPU (por cores se disponível)
    if (userSpecs.cpu && min.processor) {
        const userCoreMatch = userSpecs.cpu.match(/(\d+)\s*(?:core|cores|núcleo|nucleos)/i);
        const minCoreMatch = (min.processor || '').match(/(\d+)\s*(?:core|cores|núcleo|nucleos)/i);
        if (userCoreMatch && minCoreMatch) {
            const userCores = parseInt(userCoreMatch[1]);
            const minCores = parseInt(minCoreMatch[1]);
            if (userCores < minCores) {
                issues.push(`CPU: ${userSpecs.cpu} tem menos cores que o mínimo (${min.processor})`);
            } else {
                strengths.push(`CPU: ${userSpecs.cpu} atende`);
            }
        } else {
            strengths.push(`CPU: ${userSpecs.cpu} (verificar manualmente)`);
        }
    }

    // Determinar veredito
    let verdict;
    if (issues.length === 0 && strengths.length > 0) {
        const hasRec = strengths.some(s => s.includes('acima do recomendado'));
        verdict = hasRec ? 'comfortable' : 'minimum';
    } else if (issues.length === 1) {
        verdict = 'struggling';
    } else if (issues.length >= 2) {
        verdict = 'wont_run';
    } else {
        verdict = 'unknown';
    }

    return {
        verdict, issues, strengths,
        minimum: { processor: min.processor, memory: min.memory, graphics: min.graphics, storage: min.storage },
        recommended: { processor: rec.processor, memory: rec.memory, graphics: rec.graphics, storage: rec.storage }
    };
}

function formatVerdict(comparison) {
    const labels = {
        comfortable: 'roda tranquilo',
        minimum: 'roda no mínimo',
        struggling: 'vai sofrer',
        wont_run: 'não vai rodar',
        unknown: 'não consegui determinar com certeza'
    };
    return labels[comparison.verdict] || labels.unknown;
}

export { getGameInfo, getGameInfoWithSteamFallback, getGameInfoFromRAWG, getPlaytimeFromHLTB, compareSpecs, formatVerdict };
export default { getGameInfo, getGameInfoWithSteamFallback, getGameInfoFromRAWG, getPlaytimeFromHLTB, compareSpecs, formatVerdict };


