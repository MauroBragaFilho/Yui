import { logger } from '../../../../utils/logger.js';

/**
 * Parser do selftext do post semanal do r/gtaonline.
 * Suporta dois formatos: **Header** / * Item e # Header / * [Key](url): Value.
 */

// ── Utilidades de texto ───────────────────────────────────────────────

function stripLinks(text) {
  return (text || '').replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');
}

function stripMarkdown(text) {
  return stripLinks(text || '')
    .replace(/\*\*/g, '')
    .replace(/\*/g, '')
    .replace(/~~/g, '')
    .replace(/`/g, '')
    .replace(/^#+\s*/, '')
    .trim();
}

function isBulletLine(rawLine) {
  return /^\s*[\-*\u2022\u25AA]\s/.test(rawLine);
}

function cleanBulletLines(lines) {
  const seen = new Set();
  const out = [];
  for (const raw of lines) {
    const item = stripMarkdown(raw).replace(/^[\u2022\-*\u25AA]\s*/, '').trim();
    if (!item || seen.has(item)) continue;
    seen.add(item);
    out.push(item);
  }
  return out;
}

// ── Periodo ───────────────────────────────────────────────────────────

const MONTHS = {
  jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6,
  jul: 7, aug: 8, sep: 9, oct: 10, nov: 11, dec: 12,
};

function monthNumber(name) {
  if (!name) return null;
  return MONTHS[name.toLowerCase().slice(0, 3)] ?? null;
}

function parseMonthNameDate(text, yearHint) {
  let m = text.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?[,]?\s*(\d{4})/i);
  if (m) {
    const month = monthNumber(m[1]);
    const day = parseInt(m[2], 10);
    const year = parseInt(m[3], 10);
    if (!month || !day || !year || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  m = text.match(/([A-Za-z]{3,9})\s+(\d{1,2})(?:st|nd|rd|th)?(?:[,\s]|$)/i);
  if (m) {
    const month = monthNumber(m[1]);
    const day = parseInt(m[2], 10);
    const year = yearHint || new Date().getFullYear();
    if (!month || !day || day > 31) return null;
    return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
  }
  return null;
}

function parseNumericDate(text) {
  const m = text.match(/(\d{1,2})[/-](\d{1,2})[/-](\d{4})/);
  if (!m) return null;
  const day = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const year = parseInt(m[3], 10);
  if (!day || !month || !year || month > 12 || day > 31) return null;
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

export function extractPeriod(text) {
  if (!text) return { inicio: null, fim: null };
  const yearMatch = text.match(/\b(20\d{2})\b/);
  const yearHint = yearMatch ? parseInt(yearMatch[1], 10) : new Date().getFullYear();

  const rangePattern = /([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:[,]?\s+\d{4})?)\s+(?:to|through|until|-|\u2013|\u2014)\s+([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:[,]?\s+\d{4})?)/gi;
  const rangeMatch = rangePattern.exec(text);
  if (rangeMatch) {
    const inicio = parseMonthNameDate(rangeMatch[1], yearHint) || parseNumericDate(rangeMatch[1]);
    const fim = parseMonthNameDate(rangeMatch[2], yearHint) || parseNumericDate(rangeMatch[2]);
    if (inicio && fim) return { inicio, fim };
  }

  const datePattern = /([A-Za-z]{3,9}\s+\d{1,2}(?:st|nd|rd|th)?(?:[,]?\s+\d{4})?|\d{1,2}[/-]\d{1,2}[/-]\d{4})/gi;
  const allDates = [];
  let match;
  while ((match = datePattern.exec(text)) !== null) {
    const d = parseMonthNameDate(match[1], yearHint) || parseNumericDate(match[1]);
    if (d) allDates.push({ date: d, index: match.index });
  }
  if (allDates.length >= 2) {
    allDates.sort((a, b) => a.date.localeCompare(b.date));
    return { inicio: allDates[0].date, fim: allDates[allDates.length - 1].date };
  }
  return { inicio: null, fim: null };
}

// ── Classificacao de cabecalhos ───────────────────────────────────────

function matchBonusHeader(text) {
  const m = text.match(/(\d+[Xx])\s*(?:GTA\$|RP|GTA\$\s*&\s*RP)/i);
  if (!m) return null;
  const mult = parseInt(m[1], 10);
  return Number.isFinite(mult) && mult > 0 ? { key: 'bonus', mult } : null;
}

function classifyHeader(rawLine, strippedLine) {
  if (isBulletLine(rawLine)) return null;
  const lower = strippedLine.toLowerCase().trim();
  if (!lower) return null;

  const bonus = matchBonusHeader(lower);
  if (bonus) return bonus;

  if (/^podium\s*(vehicle)?$/i.test(lower)) return { key: 'podium' };
  if (/^prize\s*ride/i.test(lower)) return { key: 'prizeRide' };
  if (/^discounts?$/i.test(lower)) return { key: 'discounts' };
  if (/gun\s*van/i.test(lower)) return { key: 'gunVan' };
  if (/gta\s*\+/i.test(lower)) return { key: 'gtaPlus' };
  if (/^weekly\s+challenge$/i.test(lower) || /this\s*week'?s?\s*challenge/i.test(lower)) {
    return { key: 'challenge' };
  }
  if (/\brewards?\b/i.test(lower) && /\blogin\b/i.test(lower)) {
    return { key: 'rewards' };
  }

  // Headers genericos do post real (absorvem conteudo sem afetar output)
  if (/weekly\s+challenges?\s+and\s+vehicles/i.test(lower)) return { key: 'info' };
  if (/this\s*week'?s?\s+(?:most\s+wanted|fib|salvage|kortz)/i.test(lower)) return { key: 'info' };
  if (/luxury\s*autos/i.test(lower)) return { key: 'info' };
  if (/premium\s*deluxe\s*motorsports/i.test(lower)) return { key: 'info' };
  if (/daily\s*objectives?/i.test(lower)) return { key: 'info' };

  // Footer / recursos: ignora
  if (/other\s*resources?/i.test(lower)) return { key: 'ignore' };
  if (/official\s*rockstar/i.test(lower)) return { key: 'ignore' };
  if (/thanks\s*to/i.test(lower)) return { key: 'ignore' };

  return null;
}

// ── Extracao de itens-chave do conteudo ───────────────────────────────

function extractKeyValueItems(allLines) {
  const map = new Map();
  for (const raw of allLines) {
    const stripped = stripMarkdown(raw).replace(/^[\u2022\-*\u25AA]\s*/, '').trim();
    const kvMatch = stripped.match(/^([^:]+?):\s*(.+)$/);
    if (kvMatch) {
      const key = kvMatch[1].trim().toLowerCase();
      const val = kvMatch[2].trim();
      if (val && !map.has(key)) map.set(key, val);
    }
  }
  return map;
}

function interpretDiscounts(rawLines) {
  const items = [];
  let currentDiscount = null;

  for (const raw of rawLines) {
    const stripped = stripMarkdown(raw).replace(/^[\u2022\-*\u25AA]\s*/, '').trim();
    if (!stripped) continue;

    const discountHeaderMatch = stripped.match(/^(free|\d{1,3}%\s*off)$/i);
    if (discountHeaderMatch) {
      currentDiscount = discountHeaderMatch[1].trim();
      continue;
    }

    const inlineMatch = stripped.match(/^(\d{1,3}%\s*off)\s*[\u2013\u2014\-]\s*(.+)$/i);
    if (inlineMatch) {
      items.push(`${inlineMatch[2].trim()} - ${inlineMatch[1].trim()}`);
      continue;
    }

    if (currentDiscount) {
      items.push(`${stripped} - ${currentDiscount}`);
      continue;
    }

    items.push(stripped);
  }

  return items;
}

// ── Interpretacao de secoes ───────────────────────────────────────────

function interpretSection(key, rawLines) {
  const clean = cleanBulletLines(rawLines);

  switch (key) {
    case 'bonus':
      return { items: clean };
    case 'podium': {
      const v = clean.find(Boolean) || null;
      return { vehicle: v };
    }
    case 'prizeRide': {
      const v = clean.find(Boolean) || null;
      return { vehicle: v };
    }
    case 'discounts': {
      const paired = interpretDiscounts(rawLines);
      return { items: paired.length > 0 ? paired : clean };
    }
    case 'gunVan':
      return { items: clean };
    case 'gtaPlus': {
      const filtered = clean.filter((item) => {
        if (/^https?:\/\//i.test(item)) return false;
        if (/^\-+$/.test(item)) return false;
        if (/^\\?\-+$/.test(item)) return false;
        if (/^[\\/]+$/.test(item)) return false;
        return true;
      });
      return { items: filtered };
    }
    case 'challenge': {
      const filtered = clean.filter((item) => {
        if (/^tba$/i.test(item)) return false;
        if (/^\-+$/.test(item)) return false;
        if (/^\*+$/.test(item)) return false;
        return true;
      });
      return { items: filtered };
    }
    case 'rewards':
      return { items: clean };
    default:
      return { items: clean };
  }
}

// ── Montagem do resultado ─────────────────────────────────────────────

function assembleResult({
  period, bonusMap, podium, prizeRide, discounts,
  gunVan, gtaPlus, desafios, recompensas,
}) {
  const bonus = [];
  for (const [mult, activities] of bonusMap) {
    bonus.push({ multiplicador: mult, atividades: activities });
  }
  return {
    periodo: period,
    bonus,
    veiculos: { podium, prizeRide },
    descontos: discounts,
    gunVan,
    gtaPlus,
    desafios,
    recompensas,
    atualizadoEm: new Date().toISOString(),
  };
}

// ── API publica ───────────────────────────────────────────────────────

export function parseWeekly(text, titleText) {
  if (!text || typeof text !== 'string') {
    logger.warn('[Weekly][Parser] text vazio ou invalido.');
    return assembleResult({
      period: { inicio: null, fim: null },
      bonusMap: new Map(),
      podium: null, prizeRide: null, discounts: [],
      gunVan: [], gtaPlus: {}, desafios: [], recompensas: [],
    });
  }

  const periodText = (titleText ? titleText + '\n' : '') + text;
  const period = extractPeriod(periodText);
  const bonusMap = new Map();
  const sections = [];
  const allContentLines = [];
  let current = null;
  const lines = text.split('\n');

  for (const rawLine of lines) {
    const stripped = stripMarkdown(rawLine);
    const header = classifyHeader(rawLine, stripped);
    if (header) {
      sections.push({
        key: header.key === 'bonus' ? 'bonus' : header.key,
        mult: header.mult || null,
        lines: [],
      });
      current = sections[sections.length - 1];
      continue;
    }
    if (!stripped || stripped.length === 0) continue;
    allContentLines.push(rawLine);
    if (current) current.lines.push(rawLine);
  }

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
      case 'podium':
        if (interpreted.vehicle) podium = interpreted.vehicle;
        break;
      case 'prizeRide':
        if (interpreted.vehicle) prizeRide = interpreted.vehicle;
        break;
      case 'discounts':
        discounts.push(...interpreted.items);
        break;
      case 'gunVan':
        gunVan.push(...interpreted.items);
        break;
      case 'gtaPlus':
        gtaPlus.items = gtaPlus.items
          ? [...gtaPlus.items, ...interpreted.items]
          : interpreted.items;
        break;
      case 'challenge':
        desafios.push(...interpreted.items);
        break;
      case 'rewards':
        recompensas.push(...interpreted.items);
        break;
      default:
        break;
    }
  }

  // Extracao pos-secao: pares chave-valor como [Podium Vehicle](url): Name
  const kvMap = extractKeyValueItems(allContentLines);
  if (!podium) {
    for (const [key, val] of kvMap) {
      if (/podium\s*(vehicle)?/i.test(key)) { podium = val; break; }
    }
  }
  if (!prizeRide) {
    for (const [key, val] of kvMap) {
      if (/^prize\s*ride(?:\s+vehicle)?$/i.test(key)) { prizeRide = val; break; }
    }
  }

  const result = assembleResult({
    period, bonusMap, podium, prizeRide, discounts,
    gunVan, gtaPlus, desafios, recompensas,
  });

  const hasAny = result.bonus.length > 0 || result.descontos.length > 0 ||
    result.veiculos.podium || result.veiculos.prizeRide || result.gunVan.length > 0;
  if (!hasAny) {
    logger.warn('[Weekly][Parser] Nenhuma secao valida identificada no post.');
  } else {
    logger.info(
      `[Weekly][Parser] Parser concluido (${result.bonus.length} bonus, ` +
      `${result.descontos.length} descontos).`
    );
  }
  return result;
}

export default { parseWeekly, extractPeriod };

