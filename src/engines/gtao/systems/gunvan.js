import { SeedRandomNumberGenerator } from '../../../utils/rng.js';
import { getSeedValue, getFutureResetDate } from '../../../utils/gtaSeed.js';
import { getTunable, hasTunablesLoaded } from '../../../utils/tunables.js';
import zones from '../../../utils/zonesData.js';
import { getWeaponLabelPT } from '../../../utils/labels.js';
import { logger } from '../../../utils/logger.js';

const DISABLED_LOCATION = 4;

function getGunVanLocation(date) {
  const rng = new SeedRandomNumberGenerator(getSeedValue(date));
  let loc = rng.getRandomIntRanged(0n, 29n);

  while (loc === BigInt(DISABLED_LOCATION)) {
    loc = rng.getRandomIntRanged(0n, 29n);
  }

  return Number(loc);
}

/**
 * Calcula a localização e o estoque da Van de Armas.
 * @param {number} offsetDays 0 = hoje, 1 = amanhã, 7 = daqui uma semana...
 *   A localização é sempre determinística e pode ser calculada com
 *   antecedência para qualquer dia futuro.
 */
export async function fetchGunVan(offsetDays = 0) {
  try {
    const date = offsetDays === 0 ? new Date() : getFutureResetDate(offsetDays);
    const loc = getGunVanLocation(date);

    const weapons = [];
    for (let i = 0; i <= 9; i++) {
      const name = getTunable(`XM22_GUN_VAN_SLOT_WEAPON_TYPE_${i}`);
      const discount = getTunable(`XM22_GUN_VAN_SLOT_WEAPON_DISCOUNT_${i}`);
      // Slots sem arma retornam 0/null (não uma string) — ignora para não
      // exibir "Desconhecido" no embed.
      if (typeof name === 'string' && name.trim() && name !== 'invalid') {
        weapons.push({
          name: getWeaponLabelPT(name),
          discountPercent: typeof discount === 'number' ? discount * 100 : null,
        });
      }
    }

    const throwables = [];
    for (let i = 0; i <= 2; i++) {
      const name = getTunable(`XM22_GUN_VAN_SLOT_THROWABLE_TYPE_${i}`);
      const discount = getTunable(`XM22_GUN_VAN_SLOT_THROWABLE_DISCOUNT_${i}`);
      if (typeof name === 'string' && name.trim() && name !== 'invalid') {
        throwables.push({
          name: getWeaponLabelPT(name),
          discountPercent: typeof discount === 'number' ? discount * 100 : null,
        });
      }
    }

    return {
      locationIndex: loc + 1,
      locationName: zones.gun_van[loc] || 'Localização desconhecida',
      weapons,
      throwables,
      stockAvailable: hasTunablesLoaded(),
      date: date.toISOString(),
    };
  } catch (error) {
    logger.warn(`[GTAO] Falha ao calcular dados da Van de Armas: ${error.message}`);
    return null;
  }
}
