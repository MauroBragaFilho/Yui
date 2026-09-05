/**
 * Cache local do GTACars — arquivo JSON em `src/data/gtacars/vehicles.json`.
 *
 * Este cache é apenas um espelho da base de veículos baixada (fonte
 * primária é sempre a API do GTACars). Ele permite que a Yui responda
 * consultas de veículos imediatamente após iniciar, sem precisar baixar
 * ~967 veículos a cada boot.
 *
 * Regras de segurança:
 *   - Escrita é atômica (arquivo temporário + rename) para nunca deixar
 *     um JSON truncado/corrompido no lugar do cache válido.
 *   - Leitura tolerante: arquivo ausente/corrompido → retorna null (nunca
 *     lança erro que derrube o processo).
 *   - Validação de estrutura no carregamento (meta + array de vehicles).
 */

import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from '../../../../utils/logger.js';
import { SOURCE_ID } from './parser.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, '../../../../data/gtacars');
export const CACHE_PATH = path.join(DATA_DIR, 'vehicles.json');

export const CACHE_GAME = 'gta5';

/**
 * Valida a estrutura mínima de um cache carregado do disco.
 * Verifica se o objeto tem meta esperada e um array de veículos com id/name.
 */
export function isValidCache(cache) {
  if (!cache || typeof cache !== 'object') return false;
  if (cache.source !== SOURCE_ID) return false;
  if (!Array.isArray(cache.vehicles)) return false;
  return cache.vehicles.every(
    (v) => v && typeof v === 'object' && typeof v.id === 'string' && typeof v.name === 'string'
  );
}

/** Lê o cache do disco; retorna o objeto completo ou null (ausente/corrompido). */
export function readCache() {
  try {
    if (!fs.existsSync(CACHE_PATH)) return null;
    const raw = JSON.parse(fs.readFileSync(CACHE_PATH, 'utf8'));
    if (!isValidCache(raw)) {
      logger.warn('[GTACars][Cache] Cache local ignorado: estrutura inválida.');
      return null;
    }
    return raw;
  } catch (err) {
    logger.warn(`[GTACars][Cache] Falha ao ler cache local (${err.message}); ignorado.`);
    return null;
  }
}

/**
 * Salva o cache no disco de forma atômica (tmp + rename).
 * Retorna o objeto salvo (com meta) ou null em caso de erro (nunca lança).
 */
export function saveCache(vehicles, { updatedAt = new Date().toISOString() } = {}) {
  try {
    if (!Array.isArray(vehicles)) {
      logger.error('[GTACars][Cache] saveCache recusado: vehicles não é um array.');
      return null;
    }

    fs.mkdirSync(DATA_DIR, { recursive: true });

    const payload = {
      source: SOURCE_ID,
      game: CACHE_GAME,
      updatedAt,
      count: vehicles.length,
      vehicles,
    };

    const tmpPath = `${CACHE_PATH}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2), 'utf8');
    fs.renameSync(tmpPath, CACHE_PATH);

    logger.info(
      `[GTACars][Cache] ${vehicles.length} veículos salvos em ${path.relative(process.cwd(), CACHE_PATH)}.`
    );
    return payload;
  } catch (err) {
    logger.error(`[GTACars][Cache] Falha ao salvar cache local: ${err.message}`);
    // Tenta limpar arquivo temporário que tenha sobrado.
    try {
      if (fs.existsSync(`${CACHE_PATH}.tmp`)) fs.unlinkSync(`${CACHE_PATH}.tmp`);
    } catch (_) {
      /* ignora */
    }
    return null;
  }
}