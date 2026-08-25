import { fetchGunVan } from './systems/gunvan.js';
import { fetchStreetDealers } from './systems/streetDealers.js';
import { fetchDailyCollectibles } from './systems/collectibles.js';
import { fetchTimeTrials } from './systems/timeTrials.js';
import { fetchWeeklyEvent } from './systems/weeklyEvents.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { logger } from '../../utils/logger.js';

export const gtaoEngine = {
  /**
   * Coleta todos os sistemas diários e salva o snapshot do reset no SQLite
   */
  async collectDaily() {
    const todayStr = new Date().toISOString().split('T')[0];
    logger.info(`[GTAOEngine] Iniciando coleta de sistemas diários para a data: ${todayStr}`);

    const [gunVan, streetDealers, collectibles, timeTrials] = await Promise.all([
      fetchGunVan(),
      fetchStreetDealers(),
      fetchDailyCollectibles(),
      fetchTimeTrials(),
    ]);

    const dailyPayload = {
      date: todayStr,
      collectedAt: new Date().toISOString(),
      gunVan,
      streetDealers,
      collectibles,
      timeTrials,
    };

    gtaoRepository.saveDaily(todayStr, dailyPayload);
    logger.info(`[GTAOEngine] Snapshot diário de ${todayStr} salvo com sucesso no banco.`);
    return dailyPayload;
  },

  /**
   * Coleta os dados do evento semanal e salva no SQLite
   */
  async collectWeekly() {
    const d = new Date();
    // Identificador aproximado do ano e semana
    const year = d.getUTCFullYear();
    const onejan = new Date(year, 0, 1);
    const week = Math.ceil((((d - onejan) / 86400000) + onejan.getDay() + 1) / 7);
    const weekKey = `${year}-W${String(week).padStart(2, '0')}`;

    logger.info(`[GTAOEngine] Iniciando coleta semanal para a semana: ${weekKey}`);
    const weeklyData = await fetchWeeklyEvent();

    if (weeklyData) {
      gtaoRepository.saveWeekly(weekKey, weeklyData);
      logger.info(`[GTAOEngine] Snapshot semanal [${weekKey}] salvo com sucesso no banco.`);
    }

    return weeklyData;
  },
};
