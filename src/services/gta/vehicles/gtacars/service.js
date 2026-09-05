/**
 * Serviço de veículos GTACars (fonte independente).
 *
 * Responsabilidades:
 *   - Manter a base de veículos em memória (carregada do cache no boot).
 *   - Expor consultas públicas: findVehicle / searchVehicles /
 *     getVehicleById / getAllVehicles / getVehiclesByDlc.
 *   - Atualizar a base a partir da API real (fetch → parse → validação →
 *     cache), sem travar o processo em caso de indisponibilidade da fonte.
 *
 * Esta fonte é INDEPENDENTE do dump DurtyFree (src/utils/vehicleData.js)
 * e não o substitui — os dois convivem.
 */

import { logger } from '../../../../utils/logger.js';
import { fetchAllVehicles } from './client.js';
import { parseVehicles } from './parser.js';
import { readCache, saveCache } from './cache.js';

/** Idade máxima do cache antes de ser considerado "velho" (ms). */
export const CACHE_MAX_AGE_DEFAULT = 24 * 60 * 60 * 1000; // 24h

const state = {
  vehicles: [],
  count: 0,
  updatedAt: null,
  loaded: false,
  loading: null, // Promise em andamento (evita atualizações concorrentes)
};

/* ------------------------------------------------------------------ *
 * Estado / carga inicial
 * ------------------------------------------------------------------ */

/** Carrega o cache do disco para a memória (idempotente). */
export function loadCache() {
  if (state.loaded) return state.loaded;
  const cache = readCache();
  if (cache && Array.isArray(cache.vehicles)) {
    state.vehicles = cache.vehicles;
    state.count = cache.vehicles.length;
    state.updatedAt = cache.updatedAt || null;
    state.loaded = true;
    logger.info(
      `[GTACars] Base carregada do cache local: ${state.count} veículos (atualizada em ${state.updatedAt}).`
    );
  } else {
    state.loaded = true; // marcado como carregado (mesmo vazio) para não reler toda hora
    logger.warn('[GTACars] Nenhum cache local válido encontrado; consulte a API para popular.');
  }
  return state.loaded;
}

// Carrega no import para que isLoaded() já responda true na inicialização.
loadCache();

/** True se a base já está disponível em memória (mesmo que vazia). */
export function isLoaded() {
  return state.loaded;
}

/** Metadados atuais da base para logs/status. */
export function getStatus() {
  return {
    loaded: state.loaded,
    count: state.count,
    updatedAt: state.updatedAt,
    source: 'gtacars',
  };
}

/** True se o cache está velho demais (ou ausente) e merece atualização. */
export function isStale({ maxAgeMs = CACHE_MAX_AGE_DEFAULT, now = Date.now() } = {}) {
  if (!state.loaded || state.count === 0) return true;
  if (!state.updatedAt) return true;
  const age = now - new Date(state.updatedAt).getTime();
  return Number.isNaN(age) ? true : age > maxAgeMs;
}

/** Normaliza um termo de busca do usuário (mesma regra do parser). */
function normalize(term) {
  if (!term) return '';
  return String(term)
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^a-z0-9\s]/gi, ' ')
    .toLowerCase()
    .trim()
    .replace(/\s+/g, ' ');
}

/* ------------------------------------------------------------------ *
 * Busca
 * ------------------------------------------------------------------ */

/**
 * Pontua um veículo contra um termo normalizado (0..1).
 * Usada tanto pelo findVehicle (ordenação) quanto pelo searchVehicles.
 */
function scoreVehicle(vehicle, normTerm) {
  if (!normTerm || !vehicle) return 0;

  const nameNorm = vehicle.normalizedName || normalize(vehicle.name);
  if (!nameNorm) return 0;

  if (nameNorm === normTerm) return 1;

  const queryTokens = normTerm.split(' ');
  const nameTokens = nameNorm.split(' ');

  // Containment (query contida no nome OU nome contido na query — semântica
  // de autocomplete vs. nome oficial curto/abreviado).
  let containment = 0;
  if (nameNorm.includes(normTerm)) containment = 0.85;
  else if (normTerm.includes(nameNorm) && normTerm.length >= 3) containment = 0.75;

  // Cobertura de tokens da query no nome (todas as palavras presentes?).
  const covered = queryTokens.filter((tk) =>
    nameTokens.some((nt) => nt === tk || nt.startsWith(tk) || tk.startsWith(nt))
  ).length;
  const coverage = queryTokens.length ? covered / queryTokens.length : 0;

  // Ordem dos tokens (bônus se seguem a sequência do nome).
  let orderBonus = 0;
  if (coverage > 0) {
    let prev = -1;
    let ordered = 0;
    for (const tk of queryTokens) {
      const idx = nameTokens.findIndex(
        (nt, i) => i > prev && (nt === tk || nt.startsWith(tk) || tk.startsWith(nt))
      );
      if (idx >= 0) {
        ordered += 1;
        prev = idx;
      }
    }
    orderBonus = queryTokens.length ? ordered / queryTokens.length : 0;
  }

  return containment * 0.4 + coverage * 0.4 + orderBonus * 0.2;
}

/**
 * Busca exata de veículo por nome (com tolerância a acentos, maiúsculas e
 * variações), ou por id/slug. Retorna UM veículo ou null.
 *
 * Estratégia:
 *   1. Igualdade normalizada exata (ex.: "karin sultan classic").
 *   2. Igualdade por id ou slug.
 *   3. Único candidato com score ≥ 0.8 que seja claramente melhor que o segundo.
 */
export function findVehicle(searchTerm) {
  const normTerm = normalize(searchTerm);
  if (!normTerm) return null;
  if (!state.loaded || state.count === 0) return null;

  // 1. Exato por nome normalizado.
  let exact = state.vehicles.find((v) => v.normalizedName === normTerm);
  if (exact) return exact;

  // 2. Exato por id/slug (útil para "sultan2", "karin-sultan-classic", etc.).
  exact = state.vehicles.find((v) => v.id === normTerm || v.slug === normTerm);
  if (exact) return exact;

  // 3. Score: exige que o melhor seja bem superior ao segundo colocado
  //    (evita retornar "Adder" quando o usuário procura "11").
  let best = null;
  let bestScore = 0;
  let secondScore = 0;
  for (const v of state.vehicles) {
    const s = scoreVehicle(v, normTerm);
    if (s > bestScore) {
      secondScore = bestScore;
      bestScore = s;
      best = v;
    } else if (s > secondScore) {
      secondScore = s;
    }
  }

  if (!best || bestScore < 0.8) return null;

  // Empate técnico próximo (ex.: "10F" e "10F Widebody"): escolhe o de nome
  // mais curto — o candidato mais provável do usuário.
  const tied = state.vehicles.filter((v) => scoreVehicle(v, normTerm) >= bestScore - 0.2);
  if (tied.length > 1) {
    tied.sort((a, b) => a.normalizedName.length - b.normalizedName.length);
    return tied[0];
  }
  return best;
}

/**
 * Busca por similaridade, retornando até `limit` veículos ordenados por
 * relevância. Requer termo com pelo menos 2 caracteres.
 */
export function searchVehicles(searchTerm, limit = 5) {
  const normTerm = normalize(searchTerm);
  if (!normTerm || normTerm.length < 2) return [];
  if (!state.loaded || state.count === 0) return [];

  return state.vehicles
    .map((v) => ({ vehicle: v, score: scoreVehicle(v, normTerm) }))
    .filter((entry) => entry.score > 0.25)
    .sort(
      (a, b) =>
        b.score - a.score || a.vehicle.normalizedName.length - b.vehicle.normalizedName.length
    )
    .slice(0, limit)
    .map((entry) => entry.vehicle);
}

/** Retorna o veículo com o id exato, ou null. */
export function getVehicleById(id) {
  if (!id || !state.loaded) return null;
  return state.vehicles.find((v) => v.id === String(id).toLowerCase()) || null;
}

/** Retorna a base completa de veículos (referência interna — não alterar). */
export function getAllVehicles() {
  return state.vehicles;
}

/** Retorna veículos liberados em determinado DLC (slug do update). */
export function getVehiclesByDlc(dlcId) {
  if (!dlcId || !state.loaded) return [];
  return state.vehicles.filter((v) => v.dlcId === dlcId);
}

/* ------------------------------------------------------------------ *
 * Atualização
 * ------------------------------------------------------------------ */

/**
 * Baixa a base completa do GTACars, valida, salva no cache e atualiza o
 * estado em memória. Nunca lança — retorna um relatório:
 *   { ok, count, updatedAt, saved, reason? }
 */
export async function updateVehicles({ force = false } = {}) {
  // Evita atualizações simultâneas (chamadas concorrentes reutilizam a Promise).
  if (state.loading) return state.loading;

  if (!force && !isStale()) {
    return { ok: true, count: state.count, updatedAt: state.updatedAt, reason: 'cache-fresco' };
  }

  state.loading = (async () => {
    const previous = { count: state.count, updatedAt: state.updatedAt };
    try {
      logger.info('[GTACars] Atualizando base de veículos a partir da API...');

      const rawVehicles = await fetchAllVehicles({
        onPage: ({ page, received, total }) => {
          logger.info(
            `[GTACars] Página ${page}: ${received} veículos${total ? ` (total ${total})` : ''}.`
          );
        },
      });

      const parsed = parseVehicles(rawVehicles);

      // Guarda 1: resultado vazio.
      if (parsed.length === 0) {
        logger.warn('[GTACars] API retornou 0 veículos; cache existente preservado.');
        return { ok: false, count: state.count, reason: 'api-vazia' };
      }

      // Guarda 2: resultado suspeitosamente menor que o cache anterior
      // (paginação quebrada ou API parcial) — preserva a base boa.
      if (state.count > 0 && parsed.length < state.count * 0.5) {
        logger.warn(
          `[GTACars] API retornou apenas ${parsed.length} vs ${state.count} em cache; base antiga preservada.`
        );
        return { ok: false, count: state.count, reason: 'resposta-parcial' };
      }

      // Guarda 3: ids duplicados (dedupe conservando o primeiro).
      const seen = new Set();
      const unique = parsed.filter((v) => {
        if (seen.has(v.id)) {
          logger.warn(`[GTACars] Id duplicado ignorado: ${v.id}`);
          return false;
        }
        seen.add(v.id);
        return true;
      });

      const updatedAt = new Date().toISOString();
      const saved = saveCache(unique, { updatedAt });

      state.vehicles = unique;
      state.count = unique.length;
      state.updatedAt = saved?.updatedAt ?? updatedAt;
      state.loaded = true;

      logger.info(
        `[GTACars] Base atualizada: ${state.count} veículos (era ${previous.count}).`
      );
      return { ok: true, count: state.count, updatedAt: state.updatedAt, saved: Boolean(saved) };
    } catch (err) {
      logger.warn(`[GTACars] Falha ao atualizar base (${err.message}); mantendo dados atuais.`);
      return { ok: false, count: state.count, updatedAt: state.updatedAt, error: err.message };
    } finally {
      state.loading = null;
    }
  })();

  return state.loading;
}