import axios from 'axios';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { logger } from './logger.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const WEAPONS_PATH = path.join(__dirname, '../data/weaponsDump.json');
const BASE_URL = 'https://raw.githubusercontent.com/DurtyFree/gta-v-data-dumps/master';

let weaponsData = null;

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

weaponsData = readLocal(WEAPONS_PATH);

const CATEGORY_LABELS_PT = {
  GROUP_PISTOL: 'Pistola',
  GROUP_SMG: 'Submetralhadora',
  GROUP_MG: 'Metralhadora',
  GROUP_RIFLE: 'Rifle',
  GROUP_SHOTGUN: 'Espingarda',
  GROUP_SNIPER: 'Fuzil de Precisão',
  GROUP_HEAVY: 'Arma Pesada',
  GROUP_THROWN: 'Arremessável',
  GROUP_MELEE: 'Corpo a Corpo',
  GROUP_UNARMED: 'Desarmado',
};

/**
 * Baixa o dump de armas (fonte: DurtyFree/gta-v-data-dumps) e salva
 * localmente apenas os campos relevantes. O arquivo bruto inclui todos
 * os componentes/tints traduzidos em 14 idiomas por arma, o que deixa o
 * JSON gigante desnecessariamente para o nosso uso.
 *
 * Nota: este dump NÃO traz dano numérico/alcance/precisão (isso fica em
 * weaponinfo.meta, que não está neste repositório) — só categoria, tipo
 * de munição e tipo de dano.
 */
export async function downloadWeaponData() {
  try {
    const res = await axios.get(`${BASE_URL}/weapons.json`, { timeout: 30000 });
    const raw = res.data;

    const trimmed = raw
      .filter((w) => w.Name && w.Name !== 'WEAPON_UNARMED' && w.Name !== 'WEAPON_ANIMAL')
      .map((w) => ({
        name: w.Name,
        labelPT: w.TranslatedLabel?.Portuguese || w.TranslatedLabel?.English || w.Name,
        category: w.Category,
        categoryLabelPT: CATEGORY_LABELS_PT[w.Category] || w.Category,
        ammoType: w.AmmoType,
        damageType: w.DamageType,
        maxAmmoMp: w.DefaultMaxAmmoMp,
        componentCount: Array.isArray(w.Components) ? w.Components.length : 0,
      }));

    fs.writeFileSync(WEAPONS_PATH, JSON.stringify(trimmed));
    weaponsData = trimmed;
    logger.info(`[WeaponData] ${trimmed.length} armas baixadas e cacheadas com sucesso.`);
  } catch (error) {
    logger.error(`[WeaponData] Falha ao baixar dados de armas: ${error.message}`);
    if (!weaponsData) throw error;
    logger.warn('[WeaponData] Usando cache local existente como fallback.');
  }
}

/**
 * Busca armas por nome interno (WEAPON_...) ou pelo nome PT-BR traduzido.
 * Retorna no máximo `limit` resultados.
 */
export function searchWeapons(term, limit = 3) {
  if (!weaponsData || !term || term.length < 3) return [];
  const q = term.toLowerCase().trim();

  return weaponsData
    .filter((w) => {
      const key = w.name.toLowerCase();
      const pt = w.labelPT.toLowerCase();
      return key.includes(q) || pt.includes(q);
    })
    .slice(0, limit);
}

export function hasWeaponDataLoaded() {
  return weaponsData !== null;
}
