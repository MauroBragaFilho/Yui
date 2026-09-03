import puppeteerExtra from 'puppeteer-extra';
import StealthPlugin from 'puppeteer-extra-plugin-stealth';
import { translateToPortuguese } from '../../../utils/translate.js';
import { logger } from '../../../utils/logger.js';

const REDDIT_NEW_URL = 'https://www.reddit.com/r/gtaonline/new/';

// O slug canônico do post semanal que os moderadores do r/gtaonline criam toda semana.
const WEEKLY_SLUG_REGEX = /weekly_bonuses_and_discounts/i;

const PUPPETEER_ARGS = [
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-dev-shm-usage',
  '--disable-accelerated-2d-canvas',
  '--no-first-run',
  '--no-zygote',
  '--disable-gpu',
  '--disable-blink-features=AutomationControlled',
];

const REALISTIC_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/**
 * Normaliza um nome de veículo/enfeite removendo formatação markdown, bullets
 * e espaços extras, deixando apenas o texto limpo.
 */
function cleanLabel(text) {
  return (text || '')
    .replace(/[*_`>]/g, '')
    .replace(/^\s*[-•▪–]\s+/, '') // remove bullet de lista
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Extrai campos estruturados do post semanal do r/gtaonline a partir do
 * texto bruto da página. O formato dos posts dos moderadores é razoavelmente
 * padronizado (seções tipo "Podium Vehicle", "Event Bonuses (2x GTA$ & RP)",
 * "Discounts", etc.), embora varie de semana para semana — por isso usamos
 * heurísticas flexíveis e nunca quebramos o fluxo se algo não for encontrado.
 *
 * Retorna:
 *  - podiumVehicle: string | null
 *  - prizeRide:     string | null
 *  - bonuses:       string[] (itens com bônus ativos, ex: "Business Battle crates — recompensas de roupas garantidas")
 *  - discounts:     string[] (itens com desconto, incluindo o percentual quando disponível)
 *  - testRides:     string[] | null
 */
export function parseWeeklyPost(text) {
  const result = {
    podiumVehicle: null,
    prizeRide: null,
    bonuses: [],
    discounts: [],
    testRides: null,
  };

  if (!text || typeof text !== 'string') return result;

  const lines = text
    .split(/\n/)
    .map((l) => l.replace(/[*_`>]/g, '').trim())
    .filter(Boolean);

  // Localiza o cabeçalho REAL de uma seção. Ignora a primeira linha do post
  // (o título), que frequentemente contém "bonus"/"discount" e enganaria o
  // headerIndex. Prioriza linhas curtas (cabeçalhos de seção) em vez de
  // menções soltas ao termo dentro de um parágrafo longo.
  const headerIndex = (name) => {
    const needle = name.toLowerCase();
    for (let i = 1; i < lines.length; i++) {
      const clean = lines[i].toLowerCase().replace(/[^a-z0-9& ]/g, ' ');
      if (!clean.includes(needle)) continue;
      const isShortHeader = lines[i].length <= 60;
      const isMarkdownHeader = /^#{1,6}\s/.test(lines[i]);
      if (isShortHeader || isMarkdownHeader) return i;
    }
    return -1;
  };

  const sectionContent = (startIdx, endIdx) => {
    const end = endIdx ?? lines.length;
    return lines.slice(startIdx + 1, end).filter((l) => {
      // Descarta linhas que são apenas cabeçalhos de outras seções ou repetições
      if (/^#+\s/.test(l)) return false;
      return l.length > 1;
    });
  };

  // 1) Podium Vehicle (veículo do cassino) — formato real: "Podium Vehicle: <Veículo>"
  let idx = headerIndex('podium vehicle');
  if (idx !== -1) {
    result.podiumVehicle = extractInlineOrNext(lines, idx, /^podium vehicle\s*:?\s*(.*)$/i, /prize ride|test ride|challenge/i);
  }

  // 2) Prize Ride (veículo do Evento de Carros LS) — formato real: "Prize Ride Vehicle: <Veículo>"
  idx = headerIndex('prize ride');
  if (idx !== -1) {
    // Prefere a linha "Prize Ride Vehicle:" quando existir. A partir do índice
    // do header, procura uma linha com esse rótulo antes de qualquer outra seção.
    const vehicleIdx = lines.findIndex(
      (l, i) => i >= idx && /^prize ride\s*vehicle\s*:/i.test(l)
    );
    const targetIdx = vehicleIdx !== -1 ? vehicleIdx : idx;
    result.prizeRide = extractInlineOrNext(lines, targetIdx, /^prize ride\s*(?:vehicle)?\s*:?\s*(.*)$/i, /test ride|podium vehicle/i);
  }

  // 3) Bonuses — linhas que listam atividades/modos com bônus ativo.
  //    Captura tanto "4X GTA$ & RP" quanto recompensas especiais (ex: roupas).
  idx = headerIndex('bonus');
  if (idx !== -1) {
    const endIdx = lines.findIndex((l, i) => i > idx && /discounts|test ride|sale|this week|notes|newswire/i.test(l));
    const content = sectionContent(idx, endIdx === -1 ? null : endIdx);
    for (const line of content) {
      if (/^https?:/i.test(line)) continue;
      if (/discount|sale/gi.test(line) && !/\b(4x|3x|2x|1\.5x|\brp\b)/i.test(line)) continue;
      const cleaned = cleanLabel(line);
      if (cleaned.length > 2 && !/^(bonus|rewards|event bonus)/i.test(cleaned)) {
        result.bonuses.push(cleaned);
      }
    }
    // Remove duplicados preservando ordem
    result.bonuses = [...new Set(result.bonuses)].slice(0, 25);
  }

  // 4) Discounts — veículos/armas com percentual de desconto, incluindo o
  //    percentual do grupo em que cada veículo está listado.
  idx = headerIndex('discount');
  if (idx !== -1) {
    const endIdx = lines.findIndex((l, i) => i > idx && /test ride|prize ride|podium vehicle|bonus|this week|notes|newswire/i.test(l));
    const content = sectionContent(idx, endIdx === -1 ? null : endIdx);
    let currentGroup = null;
    let inGunVan = false;
    for (const line of content) {
      if (/^https?:/i.test(line)) continue;
      const cleaned = cleanLabel(line);
      // Cabeçalhos de seção que não são itens de desconto — resetam o grupo atual.
      if (/^(gun van inventory)/i.test(cleaned)) {
        inGunVan = true;
        currentGroup = null;
        continue;
      }
      if (/^(premium deluxe motorsports|luxury autos|ls car meet|hangar|weaponized|benny|the krotz center|daily objectives|this week)/i.test(cleaned)) {
        inGunVan = false;
        currentGroup = null;
        continue;
      }
      const groupMatch = cleaned.match(/^(\d{1,3}\s*%)\s*(?:off)?\s*(?:discount)?\s*$/i);
      if (groupMatch) {
        currentGroup = groupMatch[1];
        continue;
      }
      if (/^free$/i.test(cleaned)) {
        currentGroup = 'Grátis';
        continue;
      }
      // Armas da Gun Van Inventory já são tratadas pelo scraper separado — ignora.
      if (inGunVan) continue;
      const itemDiscount = cleaned.match(/(\d{1,3}\s*%)/i);
      const label = itemDiscount ? cleaned : currentGroup ? `${cleaned} - ${currentGroup}` : cleaned;
      const itemClean = cleanLabel(label);
      if (!itemClean || /^(discount|sales?)/i.test(itemClean)) continue;
      // Item sem percentual nem grupo (opcional) — só inclui se tiver grupo.
      if (!itemDiscount && !currentGroup) continue;
      result.discounts.push(itemClean);
    }
    result.discounts = [...new Set(result.discounts)].slice(0, 35);
  }

  // 5) Test Rides — formato real: "Test Ride N: <Veículo>"
  idx = headerIndex('test ride');
  if (idx !== -1) {
    const rides = [];
    for (let i = idx; i < lines.length && i < idx + 15; i++) {
      const m = lines[i].match(/^test ride\s*\d*\s*:?\s*(.+)$/i);
      if (m) {
        const clean = cleanLabel(m[1]);
        if (clean && !/^https?:/i.test(clean) && clean.length <= 45) rides.push(clean);
      } else if (/^(discounts?|podium vehicle|prize ride|bonuses?|this week|notes|newswire)/i.test(lines[i])) {
        break;
      }
    }
    result.testRides = [...new Set(rides)].slice(0, 6);
    if (result.testRides.length === 0) result.testRides = null;
  }

  return result;
}

/**
 * Extrai o valor de um item que pode aparecer em dois formatos:
 *   - inline:  "Rótulo: Valor"
 *   - bloco:   "Rótulo" seguido de "Valor" na próxima linha não-vazia.
 * valuesLine é ignorado quando encontramos um novo cabeçalho de outra seção.
 */
function extractInlineOrNext(lines, idx, inlineRegex, stopRegex) {
  const inline = lines[idx].match(inlineRegex);
  const inlineVal = inline && inline[1] ? cleanLabel(inline[1]) : null;
  if (inlineVal && inlineVal.length > 0) return inlineVal;

  for (let i = idx + 1; i < lines.length; i++) {
    const l = lines[i];
    if (stopRegex.test(l)) break;
    if (/(\d+\s*%|https?:|^\W+$)/.test(l)) continue;
    const v = cleanLabel(l);
    if (v.length > 0 && !/^#+\s/.test(l)) return v;
  }
  return null;
}

/**
 * Busca no Reddit (r/gtaonline) o post mais recente de
 * "Weekly Bonuses and Discounts". Usa Puppeteer com stealth para
 * navegar na página HTML do subreddit (a API JSON está bloqueada
 * pelo Reddit em nível de rede/TLS fingerprint).
 */
export async function fetchWeeklyEventFromReddit() {
  let browser = null;

  try {
    logger.info('[GTAOEngine] Buscando evento semanal no Reddit (r/gtaonline)...');

    browser = await puppeteerExtra.launch({
      headless: 'new',
      args: PUPPETEER_ARGS,
    });

    const page = await browser.newPage();
    await page.setUserAgent(REALISTIC_UA);
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    // Abre a lista /new do subreddit
    await page.goto(REDDIT_NEW_URL, { waitUntil: 'networkidle2', timeout: 40000 });
    await page
      .waitForFunction(
        () => document.querySelectorAll('a[href*="/r/gtaonline/comments/"]').length > 0,
        { timeout: 25000 }
      )
      .catch(() => null);
    await new Promise((r) => setTimeout(r, 1500));

    // Extrai os posts (título + URL + slug) da página HTML
    const posts = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const results = [];
      const seen = new Set();
      const allLinks = Array.from(
        document.querySelectorAll('a[href*="/r/gtaonline/comments/"]')
      );
      for (const a of allLinks) {
        const href = a.getAttribute('href') || '';
        let url = href;
        if (url.startsWith('/r/')) url = `https://www.reddit.com${url}`;
        const slugMatch = url.match(/\/comments\/[a-z0-9]+\/([^/]+)\/?/);
        if (!slugMatch || seen.has(url)) continue;
        const slug = slugMatch[1];
        if (slug.length < 10) continue;
        let title = (a.getAttribute('aria-label') || a.textContent || '').trim();
        title = title.replace(/\s+/g, ' ');
        // O novo Reddit às vezes duplica o texto dentro do link
        if (title.length > 10) {
          const half = Math.floor(title.length / 2);
          const first = title.slice(0, half).trim();
          const second = title.slice(half).trim();
          if (first === second) title = first;
        }
        seen.add(url);
        results.push({ title, url, slug });
      }
      return results.slice(0, 20);
      /* eslint-enable no-undef */
    });

    if (posts.length === 0) {
      logger.warn('[GTAOEngine] Reddit: nenhum post encontrado na página /new.');
      return null;
    }
    logger.info(`[GTAOEngine] Reddit: ${posts.length} posts encontrados na página /new.`);

    // Localiza o post semanal pelo slug canônico
    const target = posts.find(
      (p) => WEEKLY_SLUG_REGEX.test(p.slug) || /weekly bonuses and discounts/i.test(p.title)
    );

    if (!target) {
      logger.warn('[GTAOEngine] Reddit: nenhum post "Weekly Bonuses and Discounts" encontrado.');
      return null;
    }
    logger.info(`[GTAOEngine] Reddit: post semanal encontrado — "${target.title}"`);

    // Abre a página do post e extrai o conteúdo
    await page.goto(target.url, { waitUntil: 'networkidle2', timeout: 40000 });
    await new Promise((r) => setTimeout(r, 2000));

    const postContent = await page.evaluate(() => {
      /* eslint-disable no-undef */
      const postBody =
        document.querySelector('[id^="t3_"] .md') ||
        document.querySelector('[id^="t3_"] [data-click-id="text"]') ||
        document.querySelector('article .RichTextJSON-root') ||
        document.querySelector('[slot="text-body"]');
      if (postBody) return postBody.innerText;
      const h1 = document.querySelector('h1');
      return h1 ? h1.innerText : null;
      /* eslint-enable no-undef */
    });

    if (!postContent || postContent.trim().length < 50) {
      logger.warn('[GTAOEngine] Reddit: post encontrado, mas sem conteúdo legível.');
      return null;
    }

    // Limpa e processa o texto (mantém a estrutura em seções)
    const rawClean = postContent.replace(/\r/g, '');
    const paragraphs = rawClean
      .split(/\n{2,}/)
      .map((p) => p.replace(/[*_#>]/g, '').trim())
      .filter((p) => p.length > 1);

    // Extrai campos estruturados do post (Pódio, Prize Ride, Bônus, Descontos, Test Rides)
    const structured = parseWeeklyPost(rawClean);

    // Traduz título e conteúdo para PT-BR
    const effectiveTitle = target.title || 'Weekly Bonuses and Discounts';
    const translatedTitle = await translateToPortuguese(effectiveTitle);
    const translatedParagraphs = [];
    for (const paragraph of paragraphs.slice(0, 14)) {
      // eslint-disable-next-line no-await-in-loop
      translatedParagraphs.push(await translateToPortuguese(paragraph));
    }
    const fullSummary = translatedParagraphs.join('\n\n');
    const summary = fullSummary.length > 1000 ? `${fullSummary.slice(0, 1000).trim()}…` : fullSummary;

    const weeklyData = {
      title: translatedTitle,
      url: target.url,
      summary,
      // Texto integral em inglês — usado no prompt da LLM em weeklyAnalysis.js
      // (mais contexto => melhor análise e melhores páginas do embed).
      // Com limite de segurança para não estourar a janela de contexto.
      fullText: rawClean.trim().slice(0, 15000),
      // Campos estruturados usados por weeklyEmbed.js quando presente.
      podiumVehicle: structured.podiumVehicle,
      prizeRide: structured.prizeRide,
      bonuses: structured.bonuses,
      discounts: structured.discounts,
      testRides: structured.testRides,
      thumbnailUrl: '',
      publishedAt: new Date().toISOString(),
      source: 'reddit',
    };

    logger.info(`[GTAOEngine] Reddit: evento semanal capturado — "${translatedTitle}"`);
    return weeklyData;
  } catch (error) {
    logger.error(`[GTAOEngine] Erro ao buscar evento semanal no Reddit: ${error.message}`);
    return null;
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch (err) {
        logger.warn(`[GTAOEngine] Falha ao encerrar browser (Reddit): ${err.message}`);
      }
    }
  }
}

