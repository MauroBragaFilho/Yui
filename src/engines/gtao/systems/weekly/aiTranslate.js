import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { config } from '../../../../config/index.js';
import { generateResponse } from '../../../../handlers/llmHandler.js';
import { logger } from '../../../../utils/logger.js';
import {
  translateText,
  translateTitle,
  translateDiscount,
  translateGunVanItem,
} from './translate.js';

/**
 * Tradução PT-BR do resumo semanal do r/gtaonline via IA (Gemini/LLM),
 * com fallback determinístico para o glossário (translate.js).
 *
 * A IA traduz as frases livres (título, atividades de bônus, desafios,
 * GTA+, Van de Armas) preservando nomes próprios em inglês (veículos,
 * prédios, lojas, marcas e personagens) — reforçado pelo prompt com uma
 * lista de nomes protegidos extraída dos próprios dados (podium,
 * prizeRide e nome de cada veículo da lista de descontos).
 *
 * Fluxo: cache (memória + disco) → chamada de IA → validação/revalidação
 * de nomes próprios → fallback por campo/global para o glossário. Nunca
 * lança erro, para não travar a publicação automática.
 */

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CACHE_FILE = path.join(__dirname, 'ai-translate-cache.json');
const CACHE_MAX_ENTRIES = 10;
const CACHE_TTL_MS = 7 * 24 * 60 * 60 * 1000; // 7 dias
const AI_CALL_TIMEOUT_MS = 120 * 1000; // 120s (os provedores têm timeout próprio)

const MEMO = new Map();

// ── Utilitários ─────────────────────────────────────────────────────────

/** Extrai o primeiro bloco JSON válido de uma string (tolerando texto extra). */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null;
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    return JSON.parse(match[0]);
  } catch {
    return null;
  }
}

/**
 * Nomes próprios que NUNCA podem ser traduzidos: veículos do pódio/carro
 * premiado e o nome de cada veículo/propriedade da lista de descontos
 * (ex: "Coil Cyclone II - 30% Off" → "Coil Cyclone II").
 */
export function extractProtectedNames(weekly) {
  const names = new Set();
  if (weekly?.veiculos?.podium) names.add(String(weekly.veiculos.podium).trim());
  if (weekly?.veiculos?.prizeRide) names.add(String(weekly.veiculos.prizeRide).trim());
  for (const item of weekly?.descontos || []) {
    const m = String(item).match(/^(.+?)\s*[-\u2013\u2014]\s*(.+)$/);
    if (m && m[1].trim()) names.add(m[1].trim());
  }
  return [...names];
}

/** Indica se há algum provedor de IA de fato configurado para rodar. */
export function isAiAvailable() {
  if (config.geminiApiKeys?.length) return true;
  if (config.ai?.baseUrl) return true;
  const local = config.localLlmUrl || '';
  // O config sempre tem um default localhost; só conta como configurado se
  // for um endpoint customizado.
  return Boolean(local) && local !== 'http://localhost:1234/v1/chat/completions';
}

/**
 * Monta o prompt de tradução EN → PT-BR. Envia os campos traduzíveis em
 * JSON (título, bônus, descontos, Van de Armas, GTA+, desafios) e a lista
 * de nomes protegidos. Veículos (podium/prizeRide) não são enviados para
 * tradução — ficam sempre intactos.
 */
export function buildTranslatePrompt(weekly, protectedNames = []) {
  const payload = {
    title: weekly?.title || '',
    bonus: weekly?.bonus || [],
    descontos: weekly?.descontos || [],
    gunVan: weekly?.gunVan || [],
    gtaPlus: weekly?.gtaPlus?.items || [],
    desafios: weekly?.desafios || [],
  };

  return [
    'Você é a tradutora oficial (EN → pt-BR) do resumo semanal de GTA Online do r/gtaonline.',
    'Traduza o conteúdo abaixo para PORTUGUÊS DO BRASIL (pt-BR), de forma natural e direta.',
    '',
    'REGRAS OBRIGATÓRIAS:',
    '1) NUNCA traduza, altere ou adapte NOMES PRÓPRIOS: nomes de veículos (ex: "Karin Woodlander", "Coil Cyclone II"), nomes de prédios/propriedades (ex: "Arcadius Business Center Executive Office"), nomes de lojas/catálogos (ex: "Benny\'s Original Motor Works", "Legendary Motorsport"), marcas e personagens (ex: "Madrazo"). Eles devem sair EXATAMENTE como estão no original, letra por letra.',
    '2) A lista "protected_names" abaixo é obrigatória: todo nome listado que aparecer no texto-fonte TEM que continuar idêntico na tradução.',
    '3) Traduza todo o restante naturalmente: modos de jogo, atividades, frases de contexto, descrições, "2x GTA$ & RP", "until September 10th", etc.',
    '4) Mantenha números, percentuais, multiplicadores, valores em GTA$ e datas inalterados.',
    '5) Nomes de armas genéricas (ex: "Precision Rifle", "Stun Gun") PODEM ser traduzidos para o nome oficial usado no Brasil quando fizer sentido.',
    '6) Responda APENAS com um JSON válido — sem markdown/code fences (```), sem texto antes ou depois.',
    '',
    `protected_names: ${JSON.stringify(protectedNames)}`,
    '',
    'DADOS PARA TRADUZIR (JSON):',
    JSON.stringify(payload, null, 2),
    '',
    'FORMATO DE RESPOSTA (JSON, exatamente estas chaves):',
    '{ "titulo": string, "bonus": [{ "multiplicador": number, "atividades": string[] }], "descontos": string[], "gunVan": string[], "gtaPlus": string[], "desafios": string[] }',
  ].join('\n');
}
// ── Normalização da resposta da IA ──────────────────────────────────────

function normalizeBonus(parsedBonus, origBonus) {
  const parsed = Array.isArray(parsedBonus) && parsedBonus.length ? parsedBonus : null;
  const count = parsed ? parsed.length : origBonus.length;
  const out = [];
  for (let i = 0; i < count; i++) {
    const orig = origBonus[i] || {};
    let mult = orig.multiplicador ?? 2;
    let atividades = null;

    if (parsed && parsed[i]) {
      const b = parsed[i];
      if (typeof b.multiplicador === 'number' && Number.isFinite(b.multiplicador)) {
        mult = b.multiplicador;
      } else if (typeof b.multiplicador === 'string') {
        const raw = b.multiplicador.replace(/[^\d.]/g, '');
        if (raw && Number.isFinite(Number(raw))) mult = Number(raw);
      }
      if (Array.isArray(b.atividades) && b.atividades.length) {
        atividades = b.atividades
          .map((s) => (typeof s === 'string' ? s.trim() : null))
          .filter(Boolean);
      }
    }

    out.push({
      multiplicador: mult,
      atividades: atividades && atividades.length ? atividades : (orig.atividades || []).map((a) => translateText(a)),
    });
  }
  return out;
}

/**
 * Descontos: garante que o nome do veículo/propriedade foi preservado pela
 * IA. Se ela manteve o nome (início da linha), aceita a tradução; caso
 * contrário (nome alterado/traduzido) cai para o glossário determinístico
 * naquele item específico.
 */
function normalizeDiscounts(parsedDiscounts, origDiscounts) {
  if (!Array.isArray(parsedDiscounts) || !parsedDiscounts.length) {
    return origDiscounts.map((d) => translateDiscount(d));
  }
  return origDiscounts.map((orig, i) => {
    const tr = parsedDiscounts[i] && typeof parsedDiscounts[i] === 'string' ? parsedDiscounts[i].trim() : '';
    const nameMatch = String(orig).match(/^(.+?)\s*[-\u2013\u2014]\s*(.+)$/);
    const name = nameMatch?.[1]?.trim() || null;
    if (!tr || !name || tr === String(orig)) return translateDiscount(orig);
    if (tr.toLowerCase().startsWith(name.toLowerCase())) return tr;
    return translateDiscount(orig);
  });
}

function normalizeFallbackList(parsedList, origList, fallbackFn) {
  if (Array.isArray(parsedList) && parsedList.length) {
    return parsedList
      .map((s) => (typeof s === 'string' && s.trim() ? s.trim() : null))
      .filter(Boolean);
  }
  return (origList || []).map((x) => fallbackFn(x));
}

/**
 * Converte a resposta da IA em um objeto weekly já traduzido (mesmo shape
 * do weeklyService), com a flag `_i18n.by = 'ai'`. Retorna null se a
 * resposta não tiver conteúdo utilizável.
 */
export function normalizeAiResult(parsed, weekly) {
  if (!parsed || typeof parsed !== 'object') return null;

  const titulo =
    typeof parsed.titulo === 'string' && parsed.titulo.trim() ? parsed.titulo.trim() : null;
  const bonus = normalizeBonus(parsed.bonus, weekly.bonus || []);
  const descontos = normalizeDiscounts(parsed.descontos, weekly.descontos || []);
  const gunVan = normalizeFallbackList(parsed.gunVan, weekly.gunVan, translateGunVanItem);
  const gtaPlusItems = normalizeFallbackList(parsed.gtaPlus, weekly.gtaPlus?.items, translateText);
  const desafios = normalizeFallbackList(parsed.desafios, weekly.desafios, translateText);

  const hasContent =
    titulo || bonus.length || descontos.length || gunVan.length || gtaPlusItems.length || desafios.length;

  // Só considera válido se a IA forneceu pelo menos UM campo de verdade
  // (senão é resposta "vazia" → fallback global para o glossário).
  const hasAiProvidedContent =
    Boolean(titulo) ||
    (Array.isArray(parsed.bonus) && parsed.bonus.length > 0) ||
    (Array.isArray(parsed.descontos) && parsed.descontos.length > 0) ||
    (Array.isArray(parsed.gunVan) && parsed.gunVan.length > 0) ||
    (Array.isArray(parsed.gtaPlus) && parsed.gtaPlus.length > 0) ||
    (Array.isArray(parsed.desafios) && parsed.desafios.length > 0);

  if (!hasContent || !hasAiProvidedContent) return null;

  return {
    ...weekly,
    title: titulo || translateTitle(weekly.title),
    bonus,
    descontos,
    // Alias usado pelo buildWeeklyCombinedEmbeds (agrupar por loja).
    discounts: descontos,
    gunVan,
    gtaPlus: { ...(weekly.gtaPlus || {}), items: gtaPlusItems },
    desafios,
    _i18n: { by: 'ai' },
  };
}
// ── Fallback determinístico (glossário) ─────────────────────────────────

/** Aplica o glossário a todos os campos traduzíveis (sem nomes próprios). */
function applyGlossary(weekly, meta = {}) {
  const discountLines = (weekly.descontos || []).map((d) => translateDiscount(d));
  return {
    ...weekly,
    title: translateTitle(weekly.title),
    bonus: (weekly.bonus || []).map((b) => ({
      multiplicador: b.multiplicador,
      atividades: (b.atividades || []).map((a) => translateText(a)),
    })),
    descontos: discountLines,
    discounts: discountLines,
    gunVan: (weekly.gunVan || []).map((x) => translateGunVanItem(x)),
    gtaPlus: { ...(weekly.gtaPlus || {}), items: (weekly.gtaPlus?.items || []).map((x) => translateText(x)) },
    desafios: (weekly.desafios || []).map((d) => translateText(d)),
    _i18n: { by: meta.by || 'glossary' },
  };
}

// ── Cache em disco (best-effort) ────────────────────────────────────────

function readDiskCache(filePath) {
  try {
    if (!fs.existsSync(filePath)) return {};
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch {
    return {};
  }
}

function writeDiskCache(filePath, map) {
  try {
    const now = Date.now();
    const pruned = Object.fromEntries(
      Object.entries(map).filter(([, v]) => now - v.ts <= CACHE_TTL_MS)
    );
    const slim = Object.fromEntries(
      Object.entries(pruned)
        .sort((a, b) => b[1].ts - a[1].ts)
        .slice(0, CACHE_MAX_ENTRIES)
    );
    fs.writeFileSync(filePath, JSON.stringify(slim, null, 2), 'utf8');
  } catch (err) {
    logger.warn(`[Weekly][AiTranslate] Falha ao salvar cache: ${err.message}`);
  }
}

/**
 * Orquestra a tradução do weekly para o embed:
 *   1. Se IA indisponível ou `forceGlossary` → glossário (offline).
 *   2. Cache (memória/disco) por postId → evita custo/duplicidade.
 *   3. Chama a IA, extrai/valida o JSON e revalida nomes protegidos.
 *   4. Qualquer falha → fallback global para o glossário.
 *
 * @param {object} weekly — dados normalizados do weeklyService (fonte Reddit).
 * @param {object} [options]
 * @param {boolean} [options.forceGlossary=false] — pula a IA de propósito.
 * @param {boolean} [options.forceAI=false] — força o caminho da IA mesmo sem
 *   provedor configurado (usado em testes com mock de `aiCall`).
 * @param {boolean} [options.bypassCache=false] — ignora qualquer cache.
 * @param {(prompt: string) => Promise<string>} [options.aiCall] — callback
 *   de IA customizável (usado em testes para não gastar tokens/API).
 * @param {string|null} [options.cacheFile=CACHE_FILE] — null desativa disco.
 * @returns {object} weekly clonado já traduzido, com flag `_i18n`.
 */
export async function translateWeeklyForEmbed(weekly, options = {}) {
  if (!weekly || typeof weekly !== 'object') return weekly;

  const {
    forceGlossary = false,
    forceAI = false,
    bypassCache = false,
    aiCall = null,
    cacheFile = CACHE_FILE,
  } = options;

  if (forceGlossary || (!forceAI && !isAiAvailable())) {
    return applyGlossary(weekly, { by: 'glossary' });
  }

  const postId = weekly.id || weekly.url || 'unknown';

  if (!bypassCache) {
    const memoHit = MEMO.get(postId);
    if (memoHit) {
      return { ...memoHit, _i18n: { ...memoHit._i18n, by: 'cache' } };
    }
    const disk = cacheFile ? readDiskCache(cacheFile) : {};
    if (disk[postId]?.raw) {
      const parsed = extractJson(disk[postId].raw);
      const translated = parsed ? normalizeAiResult(parsed, weekly) : null;
      if (translated?._i18n) {
        translated._i18n = { by: 'cache' };
        MEMO.set(postId, translated);
        return translated;
      }
    }
  }

  try {
    const protectedNames = extractProtectedNames(weekly);
    const prompt = buildTranslatePrompt(weekly, protectedNames);

    const doCall = aiCall || ((p) => generateResponse(p, null, { allowSearch: false, disableTools: true }));

    // Timeout de segurança; a chamada que "perder" o race é ignorada.
    const callPromise = Promise.resolve().then(() => doCall(prompt));
    callPromise.catch(() => null);
    let timer;
    const timeoutPromise = new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('timeout da chamada de IA')), AI_CALL_TIMEOUT_MS);
    });

    let raw;
    try {
      raw = await Promise.race([callPromise, timeoutPromise]);
    } finally {
      clearTimeout(timer);
    }

    if (!raw || typeof raw !== 'string') throw new Error('resposta da IA vazia');

    const parsed = extractJson(raw);
    const translated = normalizeAiResult(parsed, weekly);
    if (!translated) throw new Error('JSON de tradução inválido ou vazio');

    MEMO.set(postId, translated);
    if (cacheFile) {
      const disk = readDiskCache(cacheFile);
      disk[postId] = { ts: Date.now(), raw };
      writeDiskCache(cacheFile, disk);
    }
    return translated;
  } catch (error) {
    logger.warn(`[Weekly][AiTranslate] Tradução via IA falhou (${error.message}); usando glossário.`);
    return applyGlossary(weekly, { by: 'glossary' });
  }
}

export default {
  translateWeeklyForEmbed,
  buildTranslatePrompt,
  extractProtectedNames,
  normalizeAiResult,
  isAiAvailable,
};