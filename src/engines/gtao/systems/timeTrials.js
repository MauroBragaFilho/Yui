import { getSeedValue, getFutureResetDate } from '../../../utils/gtaSeed.js';
import zones from '../../../utils/zonesData.js';
import { logger } from '../../../utils/logger.js';

const RC_ROTATION = [0, 9, 11, 12, 3, 7, 4, 1, 10, 13, 6, 5, 8, 2];
const BIKE_ROTATION = [6, 0, 5, 2, 3, 12, 8, 13, 1, 11, 10, 4, 7, 9];

function getRotationLocation(date, rotation) {
  const index = Number(getSeedValue(date) % 14n);
  return rotation[index];
}

/**
 * Calcula as localizações dos Time Trials (RC Bandito e Junk Energy Bike).
 * @param {number} offsetDays 0 = hoje, N = daqui N dias (previsão futura)
 */
export async function fetchTimeTrials(offsetDays = 0) {
  try {
    const date = offsetDays === 0 ? new Date() : getFutureResetDate(offsetDays);

    const rcLoc = getRotationLocation(date, RC_ROTATION);
    const bikeLoc = getRotationLocation(date, BIKE_ROTATION);

    return {
      rcBandito: {
        locationIndex: rcLoc + 1,
        locationName: zones.rc_time_trial[rcLoc] || 'Localização desconhecida',
      },
      junkEnergyBike: {
        locationIndex: bikeLoc + 1,
        locationName: zones.bike_time_trial[bikeLoc] || 'Localização desconhecida',
      },
      date: date.toISOString(),
    };
  } catch (error) {
    logger.warn(`[GTAO] Falha ao calcular Time Trials: ${error.message}`);
    return null;
  }
}
