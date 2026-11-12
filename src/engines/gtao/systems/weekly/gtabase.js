/**
 * Fonte do semanal: página "GTA Online Weekly Update" do GTABase (gtabase.com).
 *
 * É um site de terceiros (não oficial), mas o HTML já vem pronto do servidor, sem Chrome nem login, e traz os mesmos dados
 * estruturados do post do Reddit: bônus com multiplicador, descontos com percentual, pódio, carro premiado, desafio da semana e
 * descontos da Van de Armas. Por isso entra como 2ª opção (Reddit -> GTABase -> Newswire).
 *
 * Cuidados: só a parte do evento é lida (o que vem depois, como os comentários dos leitores, é texto de terceiros e fica de fora);
 * a página só é aceita se o período dela cobre hoje; uma busca por vez e o resultado fica guardado por NEWSWIRE_CACHE_HOURS no banco.
 */
import axios from 'axios';
import * as cheerio from 'cheerio';
import { logger } from '../../../../utils/logger.js';
import { extractPeriod } from './parser.js';

export const GTABASE_URL = 'https://www.gtabase.com/gta-online/weekly-update-bonuses-discounts';

/** Só para os testes: troca a chamada HTTP (o padrão é o axios). */
export const gtabaseDeps = { get: (...args) => axios.get(...args) };

const clean = (s) => String(s ?? '').replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
const MAX_ITEMS = 60;

function parseBonuses($) {
  const byMult = new Map();
  $('li.field-entry.gta5-bonuses li.gta-bonuses').slice(0, MAX_ITEMS).each((_, el) => {
    const li = $(el);
    const name = clean(li.find('.item-info h3').first().text());
    const rp = clean(li.find('.bonus-multiplier.rp').first().text()).replace(/x$/i, '');
    const cash = clean(li.find('.bonus-multiplier.cash').first().text()).replace(/x$/i, '');
    if (!name || (!rp && !cash)) return;
    const mult = rp && cash && rp === cash ? rp : String(Math.max(Number(rp) || 0, Number(cash) || 0));
    const label = rp && cash && rp !== cash ? `${name} (GTA$ ${cash}x, RP ${rp}x)` : name;
    if (!byMult.has(mult)) byMult.set(mult, []);
    byMult.get(mult).push(label);
  });
  return [...byMult.entries()]
    .sort((a, b) => Number(b[0]) - Number(a[0]))
    .map(([multiplicador, atividades]) => ({ multiplicador, atividades }));
}

function parseDiscounts($) {
  const lines = [];
  const detail = [];
  $('li.field-entry.gta5-discounts li.gta-bonuses').slice(0, MAX_ITEMS).each((_, el) => {
    const li = $(el);
    const name = clean(li.find('.item-info h3').first().text());
    const pct = clean(li.find('.badge').first().text()).match(/(\d{1,3})\s*%/);
    if (!name || !pct) return;
    lines.push(`${name} (${pct[1]}%)`);
    const was = clean(li.find('.article-info s').first().text());
    const now = clean(li.find('.discounted-price').first().text()).replace(/^[-\d%\s]+/, '');
    detail.push(`${name} -${pct[1]}%${was && now ? ` (${was} -> ${now})` : ''}`);
  });
  return { lines, detail };
}

function parseShowrooms($) {
  let podium = null;
  let prizeRide = null;
  const groups = new Map();
  $('li.field-entry.showrooms-test-rides li.gta-bonuses').slice(0, MAX_ITEMS).each((_, el) => {
    const li = $(el);
    const type = clean(li.find('.item-type').first().text());
    const name = clean(li.find('.item-info h3').first().text());
    if (!name) return;
    if (li.find('.podium-vehicle').length) podium = name;
    else if (li.find('.prize-ride').length) prizeRide = name;
    else if (type) {
      if (!groups.has(type)) groups.set(type, []);
      groups.get(type).push(name);
    }
  });
  return { podium, prizeRide, lojas: [...groups.entries()].map(([titulo, itens]) => ({ titulo, itens })) };
}

/** Lê o que vem depois de "Weekly Challenge": o texto do desafio e as listas por título (alvos, corridas, Van de Armas...). */
function parseExtras($) {
  const anchor = $('span#weekly-challenge').first().closest('h3');
  const challenge = [];
  const extras = [];
  if (!anchor.length) return { challenge, extras };
  let current = null;
  let node = anchor.next();
  for (let guard = 0; node.length && guard < 40; guard += 1, node = node.next()) {
    const tag = (node.prop('tagName') || '').toLowerCase();
    if (tag === 'h3' || tag === 'h2') break;
    if (tag === 'h4') {
      current = { titulo: clean(node.text()), itens: [] };
      extras.push(current);
    } else if (tag === 'ul') {
      const itens = node.find('li').slice(0, 20).map((_, li) => clean($(li).text())).get().filter(Boolean);
      if (current) current.itens.push(...itens);
      else challenge.push(...itens);
    } else if (tag === 'p') {
      const text = clean(node.text());
      if (!text) continue;
      if (/previous\s+GTA 5 Weekly Updates|visit our news section/i.test(text)) break; // rodapé da página
      if (current) current.itens.push(text); else challenge.push(text);
    }
  }
  return { challenge: challenge.slice(0, 6), extras: extras.filter((e) => e.itens.length) };
}

/**
 * Lê o HTML da página e devolve o semanal no MESMO formato do post do Reddit (periodo, bonus, veiculos, descontos, gunVan,
 * gtaPlus, desafios), mais `extras` e o texto em inglês `fullText` para a análise da IA. Devolve null se não achar o conteúdo.
 */
export function parseGtabaseHtml(html, { url = GTABASE_URL } = {}) {
  if (!html || typeof html !== 'string') return null;
  const $ = cheerio.load(html);
  // Só o corpo do artigo; os comentários dos leitores (texto de terceiros) ficam de fora.
  $('#comments-section, .module.comments, #jlexcomment, script, style, template').remove();

  const bonus = parseBonuses($);
  const { lines: descontos, detail } = parseDiscounts($);
  const { podium, prizeRide, lojas } = parseShowrooms($);
  const { challenge, extras } = parseExtras($);
  if (bonus.length === 0 && descontos.length === 0 && !podium && !prizeRide) return null;

  const title = clean($('h2.section-title .heading_text').first().text()) || clean($('title').first().text()).replace(/&nbsp;/g, ' ');
  const intro = clean($('article').first().text()).slice(0, 1500);
  const rangeText = (intro.match(/active\s+from\s+([A-Za-z]+\s+\d{1,2})\s+to\s+([A-Za-z]+\s+\d{1,2}),?\s+(\d{4})/i) || []);
  const periodo = rangeText.length
    ? extractPeriod(`${rangeText[1]} to ${rangeText[2]} ${rangeText[3]}`)
    : extractPeriod(title);

  const gunVanBlock = extras.find((e) => /gun\s*van/i.test(e.titulo));
  const gunVan = gunVanBlock ? gunVanBlock.itens : [];
  const gtaPlusItems = gunVan.filter((l) => /gta\s*\+/i.test(l));

  const text = [];
  text.push(`Source: GTABase weekly update page (${url})`);
  if (periodo.inicio) text.push(`Active from ${periodo.inicio} to ${periodo.fim ?? '?'}`);
  for (const b of bonus) text.push(`${b.multiplicador}x GTA$ & RP: ${b.atividades.join(', ')}`);
  if (detail.length) text.push(`Discounts: ${detail.join('; ')}`);
  if (podium) text.push(`Podium Vehicle: ${podium}`);
  if (prizeRide) text.push(`LS Car Meet Prize Ride: ${prizeRide}`);
  for (const l of lojas) text.push(`${l.titulo}: ${l.itens.join(', ')}`);
  if (challenge.length) text.push(`Weekly Challenge: ${challenge.join(' ')}`);
  for (const e of extras) text.push(`${e.titulo}: ${e.itens.join('; ')}`);

  return {
    id: `gtabase-${periodo.inicio ?? 'sem-data'}`,
    url,
    title,
    source: 'gtabase',
    fullText: text.join('\n'),
    periodo,
    bonus,
    desafios: challenge,
    recompensas: [],
    descontos,
    discounts: descontos,
    veiculos: { podium, prizeRide },
    gunVan,
    gtaPlus: gtaPlusItems.length ? { items: gtaPlusItems } : {},
    lojas,
    extras,
    atualizadoEm: new Date().toISOString(),
  };
}

/** O período da página cobre hoje (com 1 dia de folga)? Página que ainda mostra a semana passada não serve. */
export function isCurrentPeriod(periodo, now = new Date()) {
  if (!periodo?.fim) return true; // sem data não dá para negar; os outros testes (conteúdo) é que decidem
  const limit = new Date(`${periodo.fim}T23:59:59Z`).getTime() + 86_400_000;
  const start = periodo.inicio ? new Date(`${periodo.inicio}T00:00:00Z`).getTime() - 2 * 86_400_000 : -Infinity;
  const t = now.getTime();
  return t <= limit && t >= start;
}

/** Busca a página e devolve o semanal, ou null (erro de rede, página mudou ou ainda é a semana passada). Nunca lança. */
export async function fetchGtabaseWeekly({ now = new Date() } = {}) {
  try {
    const res = await gtabaseDeps.get(GTABASE_URL, {
      timeout: 15000,
      maxContentLength: 3_000_000,
      responseType: 'text',
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; YuiDiscordBot/1.0)', 'Accept-Language': 'en-US,en;q=0.8' },
    });
    const weekly = parseGtabaseHtml(res?.data);
    if (!weekly) {
      logger.warn('[GTABase] Não achei bônus nem descontos na página (o layout pode ter mudado).');
      return null;
    }
    if (!isCurrentPeriod(weekly.periodo, now)) {
      logger.warn(`[GTABase] A página ainda mostra outro período (${weekly.periodo.inicio} a ${weekly.periodo.fim}); ignorando.`);
      return null;
    }
    logger.info(`[GTABase] Semanal lido: ${weekly.bonus.length} grupos de bônus, ${weekly.descontos.length} descontos.`);
    return weekly;
  } catch (err) {
    logger.warn(`[GTABase] Falha ao buscar a página: ${String(err?.message ?? err).slice(0, 100)}`);
    return null;
  }
}
