import { logger } from '../../../../utils/logger.js';

/**
 * Parser do selftext do post semanal do r/gtaonline ("Weekly Bonuses and
 * Discounts").
 *
 * Trabalha por SEÇÕES/TÍTULOS, não por posições fixas de linha:
 *   1. identifica uma seção (ex: "3X GTA$ & RP", "Discounts", "Podium
 *      Vehicle");
 *   2. coleta o conteúdo até a próxima seção;
 *   3. interpreta o conteúdo.
 *
 * Assim é tolerante a pequenas alterações de formatação e à ordem das
 * seções no post.
 *
 * Regras:
 *  - Não depende de número fixo de linhas.
 *  - Não inventa o período: se não conseguir identificar, deixa null.
 *  - Se não identificar NENHUMA seção válida, retorna dados vazios que
 *    poderão ser rejeitados pela validação do serviço.
 */

// ── Utilidades de texto ───────────────────────────────────────────────
/** Remove marcação markdown (negrito, itálico, code) de uma linha. */
function stripMarkdown(text) {
  return (text || '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/~~/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s*/, '')
    .trim();
}

/** Deduplica linhas lendo as opções ("* X" / "• X" / "- X"). */
function cleanBulletLines(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const item = stripMarkdown(raw).replace(/^[•\-*▪]\s*/, '').trim();
    if (!item) continue;
    if (seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ── Período ───────────────────────────────────────────────────────────
const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthNumber(name) {
  if (!name) return null;
  return MONTHS[name.toLowerCase().slice(0, 3)] ?? null;
}

/** Reconhece "August 27, 2026" -> "2026-08-27" (ou nulo). */
function parseMonthNameDate(text) {
  const m = text.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s*(\d{4})/i);
  if (!m) return null;
  const month = monthNumber(m[1]);
  const day = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!month || !day || !year || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Reconhece "27/08/2026" ou "27-08-2026" -> "2026-08-27" (ou nulo). */
function parseNumericDate(text) {
  const m = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!day || !month || !year || month > 12 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/**
 * Extrai o período da semana. Procura por um par de datas no texto com um
 * separador de intervalo ("-", "to", "through", "until"). Retorna
 * { inicio, fim } com "YYYY-MM-DD" ou null em cada campo não encontrado.
 */
function extractPeriod(text) {
  const yearGuess = null; // usaremos apenas datas explícitas no texto
  const dateSpans = text.match(
    /([A-Za-z]{3,9}\s+\d{1,2}[a-z]*[,]?\s+\d{4}|\d{1,2}[/-]\d{1,2}[/-]\d{4})/gi
  );
  if (!dateSpans || dateSpans.length < 2) {
    return { inicio: null, fim: null };
  }

  const dates = dateSpans.map((d) => parseMonthNameDate(d) || parseNumericDate(d)).filter(Boolean);
  if (dates.length < 2) {
    return { inicio: null, fim: null };
  }

  // Ordena e assume o menor como início e o maior como fim.
  dates.sort();
  return { inicio: dates[0], fim: dates[dates.length - 1] };
}

export { extractPeriod, cleanBulletLines };

// ── Reconhecimento de seções ──────────────────────────────────────────
// Cada seção é definida por um teste de cabeçalho e um parser de conteúdo.
// O fluxo principal percorre as linhas, e toda vez que uma linha "abre"
// uma seção, o conteúdo subsequente até a próxima seção é coletado.

/**
 * Identifica se uma linha é um cabeçalho de multiplicador de bônus
 * ("[N]X GTA$ & RP"). Retorna o multiplicador ou null.
 */
function matchBonusHeader(line) {
  const m = line.match(/^\s*(\d{1,2})\s*[xX]\s*GTA\$?/i);
  if (!m) return null;
  const mult = parseInt(m[1], 10);
  // Números absurdos (>10) no título provavelmente não são multiplicadores
  // reais do formato de bônus do post; ainda assim aceitamos até 12.
  return mult >= 2 && mult <= 12 ? mult : null;
}

/**
 * Identifica se o conteúdo de um bloco de "Discounts" contém um par
 * "veículo - X%" e separa nome/percentual.
 */
function parseDiscountLine(line) {
  const m = line.match(/^(.*?)[:\-–—]\s*(\d{1,3}\s*%)$/i);
  if (!m) return null;
  const name = stripMarkdown(m[1]).trim();
  const pct = m[2].trim();
  if (!name || /\d{4}/.test(name)) return null;
  return { name, pct };
}

// ── Roteador de seções ────────────────────────────────────────────────
/**
 * Dado o texto limpo de uma seção (sem cabeçalho) e a chave da seção,
 * interpreta o conteúdo. Retorna um objeto com campos específicos.
 */
function interpretSection(key, blockLines) {
  const clean = cleanBulletLines(blockLines);

  switch (key) {
    case 'podium': {
      // Linha(s) descrevendo o veículo do pódio.
      const v = clean.map((l) => l.replace(/^podium\s*:\s*/i, '').trim()).find(Boolean);
      return { vehicle: v || null };
    }
    case 'prizeRide': {
      const v = clean.map((l) => l.replace(/^prize\s*ride\s*:\s*/i, '').trim()).find(Boolean);
      return { vehicle: v || null };
    }
    case 'gunVan': {
      return { items: clean };
    }
    case 'gtaPlus': {
      return { items: clean };
    }
    case 'discounts': {
      const discounts = [];
      for (const line of clean) {
        const parsed = parseDiscountLine(line);
        if (parsed) {
          discounts.push(`${parsed.name} (${parsed.pct})`);
        } else {
          discounts.push(line);
        }
      }
      return { items: discounts };
    }
    case 'challenge':
    case 'rewards':
    case 'desafios':
    case 'recompensas':
    default: {
      return { items: clean };
    }
  }
}


/**
 * Classifica um cabeçalho de seção (linha limpa) em uma chave conhecida,
 * ou retorna null se não for um cabeçalho de seção. Também retorna o
 * multiplicador quando a seção é de bônus.
 */
function classifyHeader(line) {
  const l = line.trim();

  // Multiplicador de bônus primeiro (ex: "3X GTA$ & RP").
  const mult = matchBonusHeader(l);
  if (mult) {
    return { key: 'bonus', mult };
  }

  const lower = l.toLowerCase();

  if (/podium\s*(vehicle)?/i.test(lower) && /(\bvehicle\b|podium)/i.test(lower)) {
    return { key: 'podium' };
  }
  if (/prize\s*ride/i.test(lower)) {
    return { key: 'prizeRide' };
  }
  if (/discount/i.test(lower)) {
    return { key: 'discounts' };
  }
  if (/gun\s*van/i.test(lower)) {
    return { key: 'gunVan' };
  }
  if (/gta\s*\+/i.test(lower)) {
    return { key: 'gtaPlus' };
  }
  if (/weekly\s*challenge/i.test(lower) || /challenge/i.test(lower)) {
    return { key: 'challenge' };
  }
  if (/reward/i.test(lower)) {
    return { key: 'rewards' };
  }
  return null;
}

/**
 * Converte a lista bruta de seções interpretadas no JSON final do Weekly.
 */
function assembleResult({ period, bonusMap, podium, prizeRide, discounts, gunVan, gtaPlus, desafios, recompensas }) {
  const bonus = [...bonusMap.entries()]
    .filter(([, acts]) => acts.length > 0)
    .map(([mult, atividades]) => ({ multiplicador: mult, atividades }))
    .sort((a, b) => b.multiplicador - a.multiplicador);

  return {
    periodo: period,
    bonus,
    desafios: desafios,
    recompensas: recompensas,
    descontos: discounts,
    veiculos: {
      podium: podium || null,
      prizeRide: prizeRide || null,
    },
    gunVan: gunVan,
    gtaPlus: gtaPlus,
    atualizadoEm: new Date().toISOString(),
  };
}

/**
 * Ponto de entrada: transforma o `selftext` (string) em dados estruturados.
 *
 * @param {string} selftext
 * @returns {object} JSON normalizado do Weekly (ver assembleResult).
 */
export function parseWeekly(selftext) {
  const text = (selftext || '').trim();
  if (!text) {
    logger.warn('[Weekly][Parser] selftext vazio.');
    return assembleResult({
      period: { inicio: null, fim: null },
      bonusMap: new Map(),
      podium: null,
      prizeRide: null,
      discounts: [],
      gunVan: [],
      gtaPlus: {},
      desafios: [],
      recompensas: [],
    });
  }

  const period = extractPeriod(text);

  const bonusMap = new Map();
  const sections = []; // { header, key, mult, lines[] }

  let current = null;
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const line = stripMarkdown(rawLine);

    // Tenta classificar a linha como cabeçalho de seção.
    const header = classifyHeader(line);
    if (header) {
      // Fecha a seção anterior e abre a nova. Se a seção é de bônus com
      // mesmo multiplicador, acumulamos (pode aparecer "3X GTA$ & RP" mais
      // de uma vez com sub-bloco).
      sections.push({
        key: header.key === 'bonus' ? 'bonus' : header.key,
        mult: header.mult || null,
        lines: [],
      });
      current = sections[sections.length - 1];
      continue;
    }

    // Caso ainda não haja seção aberta, ignora (cabeçalho do post, etc).
    if (!current) continue;

    // Linha de conteúdo deve ter algum texto relevante.
    if (!line || line.length === 0) continue;
    current.lines.push(rawLine);
  }

  // ── Interpretação ────────────────────────────────────────────────────
  let podium = null;
  let prizeRide = null;
  const discounts = [];
  const gunVan = [];
  const gtaPlus = {};
  const desafios = [];
  const recompensas = [];

  for (const section of sections) {
    const interpreted = interpretSection(section.key, section.lines);

    switch (section.key) {
      case 'bonus': {
        if (section.mult) {
          if (!bonusMap.has(section.mult)) bonusMap.set(section.mult, []);
          for (const act of interpreted.items) bonusMap.get(section.mult).push(act);
        }
        break;
      }
      case 'podium': {
        if (interpreted.vehicle) podium = interpreted.vehicle;
        break;
      }
      case 'prizeRide': {
        if (interpreted.vehicle) prizeRide = interpreted.vehicle;
        break;
      }
      case 'discounts': {
        discounts.push(...interpreted.items);
        break;
      }
      case 'gunVan': {
        gunVan.push(...interpreted.items);
        break;
      }
      case 'gtaPlus': {
        gtaPlus.items = gtaPlus.items ? [...gtaPlus.items, ...interpreted.items] : interpreted.items;
        break;
      }
      case 'challenge': {
        desafios.push(...interpreted.items);
        break;
      }
      case 'rewards': {
        recompensas.push(...interpreted.items);
        break;
      }
      default:
        break;
    }
  }

  const result = assembleResult({
    period,
    bonusMap,
    podium,
    prizeRide,
    discounts,
    gunVan,
    gtaPlus,
    desafios,
    recompensas,
  });

  const hasAny = result.bonus.length > 0 || result.descontos.length > 0 ||
    result.veiculos.podium || result.veiculos.prizeRide || result.gunVan.length > 0;
  if (!hasAny) {
    logger.warn('[Weekly][Parser] Nenhuma seção válida identificada no post.');
  } else {
    logger.info(`[Weekly][Parser] Parser concluído (${result.bonus.length} bônus, ${result.descontos.length} descontos).`);
  }

  return result;
}

export default { parseWeekly, extractPeriod };

