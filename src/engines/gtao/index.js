import { fetchGunVan } from './systems/gunvan.js';
import { fetchStreetDealers } from './systems/streetDealers.js';
import { fetchDailyCollectibles } from './systems/collectibles.js';
import { fetchTimeTrials } from './systems/timeTrials.js';
import { fetchWeeklyEvent } from './systems/weeklyEvents.js';
import { generateWeeklyAnalysis } from './weeklyAnalysis.js';
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
   * Coleta os dados do evento semanal, gera a análise da IA (destaques,
   * itens gratuitos, veículos em desconto, novidades, melhor farm e
   * avaliação da semana) e salva TUDO junto no SQLite — assim o comando
   * /gta-semanal não precisa chamar a IA de novo a cada uso, só lê o cache.
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

    if (!weeklyData) {
      return null;
    }

    // Usa o snapshot diário já salvo (ou coleta um novo se ainda não existir
    // hoje) para dar contexto de Van de Armas / Comerciantes / Desafios
    // Contra o Relógio à IA, e para extrair as armas com desconto ativo.
    const todayStr = d.toISOString().split('T')[0];
    let dailyData = gtaoRepository.getDaily(todayStr)?.data;
    if (!dailyData) {
      dailyData = await this.collectDaily();
    }

    logger.info('[GTAOEngine] Gerando análise semanal via IA (destaques, gratuitos, descontos, farm, avaliação)...');
    const analysis = await generateWeeklyAnalysis(weeklyData, dailyData);

    if (analysis) {
      weeklyData.analysis = analysis;
      logger.info('[GTAOEngine] Análise semanal da IA gerada e anexada com sucesso.');
    } else {
      logger.warn('[GTAOEngine] Análise semanal da IA falhou — salvando apenas os dados brutos do artigo.');
    }

    gtaoRepository.saveWeekly(weekKey, weeklyData);
    logger.info(`[GTAOEngine] Snapshot semanal [${weekKey}] (com análise) salvo com sucesso no banco.`);

    return weeklyData;
  },
};
