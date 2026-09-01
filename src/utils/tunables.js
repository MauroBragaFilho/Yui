import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const TUNABLES_PATH = path.join(__dirname, '../data/tunables-decrypted.json');
const LABELS_PT_PATH = path.join(__dirname, '../data/labelsPT.json');

// Fonte real e conhecida da comunidade GTA (RDO.GG Tunables, mantido por Senexis),
// a mesma referenciada nos créditos do GTAO-Bot original.
const TUNABLES_URL = 'https://api.rdo.gg/tunables/gta/pcros/';

let tunablesData = null;
const labelsDataPT = JSON.parse(fs.readFileSync(LABELS_PT_PATH, 'utf8'));

function readTunablesFile() {
  if (fs.existsSync(TUNABLES_PATH)) {
    return JSON.parse(fs.readFileSync(TUNABLES_PATH, 'utf8'));
  }
  return null;
}

tunablesData = readTunablesFile();

export async function downloadTunables() {
  try {
    const response = await axios.get(TUNABLES_URL, { timeout: 15000 });
    fs.writeFileSync(TUNABLES_PATH, JSON.stringify(response.data, null, 2));
    tunablesData = readTunablesFile();
    logger.info('[Tunables] Baixados e cacheados com sucesso a partir do RDO.GG.');
    return TUNABLES_PATH;
  } catch (error) {
    logger.error(`[Tunables] Falha ao baixar tunables: ${error.message}`);
    // Se já existir um cache local, seguimos usando-o em vez de quebrar o bot.
    if (tunablesData) {
      logger.warn('[Tunables] Usando cache local existente como fallback.');
      return TUNABLES_PATH;
    }
    throw error;
  }
}

export function getTunable(tunable) {
  if (!tunablesData) {
    logger.warn('[Tunables] Nenhum dado carregado ainda. Chame downloadTunables() no startup.');
    return 'invalid';
  }

  const tunableValue = tunablesData?.contents?.tunables?.BASE_GLOBALS?.[tunable];

  if (tunableValue !== undefined) {
    if (typeof tunableValue === 'string') {
      // Traduz a chave do tunable para português usando o labelsPT.json.
      if (labelsDataPT[tunableValue] !== undefined) {
        return labelsDataPT[tunableValue];
      }
    }
    return tunableValue;
  }
  return 'invalid';
}

export function hasTunablesLoaded() {
  return tunablesData !== null;
}
