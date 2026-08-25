import { get_daily_collectible_locations, get_objective_day } from '../../../utils/collectablesData.js';
import { getUnixSeconds } from '../../../utils/gtaSeed.js';
import zones from '../../../utils/zonesData.js';
import { logger } from '../../../utils/logger.js';

/**
 * Calcula todos os colecionáveis diários (Treasure Chests, Hidden Caches,
 * Shipwreck, Buried Stashes, Skydives, LS Tags). A rotação segue um ciclo
 * fixo de 84 dias, então também pode ser calculada para datas futuras.
 * @param {number} offsetDays 0 = hoje, N = daqui N dias (previsão futura)
 */
export async function fetchDailyCollectibles(offsetDays = 0) {
  try {
    const date = offsetDays === 0 ? new Date() : new Date(Date.now() + offsetDays * 86400000);
    const unixSeconds = getUnixSeconds(date);

    const locations = get_daily_collectible_locations(unixSeconds);
    const cycleDay = get_objective_day(unixSeconds);

    const mapLoc = (arr, zoneKey) =>
      (arr || []).map((idx) => ({
        locationIndex: idx + 1,
        locationName: zones[zoneKey]?.[idx] || 'Localização desconhecida',
      }));

    return {
      treasureChests: mapLoc(locations.treasure_chests, 'treasure_chests'),
      hiddenCaches: mapLoc(locations.hidden_caches, 'hidden_caches'),
      shipwreck: {
        locationIndex: locations.shipwrecked + 1,
        locationName: zones.shipwrecked[locations.shipwrecked] || 'Localização desconhecida',
      },
      buriedStashes: mapLoc(locations.buried_stashes, 'buried_stashes'),
      skydives: mapLoc(locations.skydives, 'skydives'),
      lsTags: mapLoc(locations.ls_tags, 'ls_tags'),
      cycleDay,
      date: date.toISOString(),
    };
  } catch (error) {
    logger.warn(`[GTAO] Falha ao calcular colecionáveis diários: ${error.message}`);
    return null;
  }
}
