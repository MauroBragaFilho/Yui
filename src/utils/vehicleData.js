import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const VEHICLES_PATH = path.join(__dirname, '../data/vehicles.json');
const BASE_URL = 'https://raw.githubusercontent.com/DurtyFree/gta-v-data-dumps/master';

let vehiclesData = null;

function readLocal(filePath) {
  if (fs.existsSync(filePath)) {
    try {
      return JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (_) {
      return null;
    }
  }
  return null;
}

vehiclesData = readLocal(VEHICLES_PATH);

/**
 * Baixa o dump completo de veículos (fonte: DurtyFree/gta-v-data-dumps)
 * e salva localmente só os campos que a Yui realmente usa. O arquivo
 * bruto traz ~900 veículos com bones/cores/dimensões que não interessam
 * aqui, então filtramos no download em vez de guardar o JSON inteiro.
 */
export async function downloadVehicleData() {
  try {
    const res = await axios.get(`${BASE_URL}/vehicles.json`, { timeout: 30000 });
    const raw = res.data;

    const trimmed = raw.map((v) => ({
      name: v.Name,
      displayNamePT: v.DisplayName?.Portuguese || v.DisplayName?.English || v.Name,
      displayNameEN: v.DisplayName?.English || v.Name,
      handlingId: v.HandlingId,
      manufacturer: v.ManufacturerDisplayName?.Portuguese || v.ManufacturerDisplayName?.English || null,
      class: v.Class,
      type: v.Type,
      seats: v.Seats,
      monetaryValue: v.MonetaryValue,
      // Valor bruto do handling do jogo (fInitialDriveMaxFlatVel). Para
      // converter em km/h real, multiplique por 1.32 (fórmula documentada
      // pela comunidade de modding — GTAMods Wiki, Handling.meta). Essa
      // conversão é feita no momento do uso, em ask.js.
      maxSpeed: v.MaxSpeed,
      maxTraction: v.MaxTraction,
      acceleration: v.Acceleration,
      agility: v.Agility,
      maxBraking: v.MaxBraking,
      dlcName: v.DlcName,
    }));

    fs.writeFileSync(VEHICLES_PATH, JSON.stringify(trimmed));
    vehiclesData = trimmed;
    logger.info(`[VehicleData] ${trimmed.length} veículos baixados e cacheados com sucesso.`);
  } catch (error) {
    logger.error(`[VehicleData] Falha ao baixar dados de veículos: ${error.message}`);
    if (!vehiclesData) throw error;
    logger.warn('[VehicleData] Usando cache local existente como fallback.');
  }
}

/**
 * Procura veículos cujo nome (PT ou EN) contenha o termo buscado.
 * Retorna no máximo `limit` resultados.
 */
export function searchVehicles(term, limit = 3) {
  if (!vehiclesData || !term || term.length < 3) return [];
  const q = term.toLowerCase().trim();

  return vehiclesData
    .filter((v) => {
      const pt = (v.displayNamePT || '').toLowerCase();
      const en = (v.displayNameEN || '').toLowerCase();
      return pt.includes(q) || en.includes(q);
    })
    .slice(0, limit);
}

export function hasVehicleDataLoaded() {
  return vehiclesData !== null;
}
