import { fetchGunVan } from './systems/gunvan.js';
import { fetchStreetDealers } from './systems/streetDealers.js';
import { fetchDailyCollectibles } from './systems/collectibles.js';
import { fetchTimeTrials } from './systems/timeTrials.js';
import { fetchWeeklyEvent } from './systems/weeklyEvents.js';
import { weeklyService } from './systems/weekly/service.js';
import { generateWeeklyAnalysis } from './weeklyAnalysis.js';
import { gtaoRepository } from '../../database/repositories/gtaoRepo.js';
import { logger } from '../../utils/logger.js';
import { getCurrentWeekKey } from '../../utils/weekKey.js';

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
   * Coleta os dados do evento semanal de uma fonte específica, gera a
   * análise da IA e salva tudo no SQLite.
   *
   * @param {object} opts
   * @param {'reddit'|'newswire'} [opts.source='reddit'] — Fonte dos dados.
   *   - reddit: usa o post semanal do r/gtaonline (padrão, mais rápido e confiável).
   *   - newswire: usa o Rockstar Newswire (tradução automática via API).
   */
  async collectWeekly({ source = 'reddit' } = {}) {
    const weekKey = getCurrentWeekKey();

    logger.info(`[GTAOEngine] Iniciando coleta semanal [${weekKey}] (fonte: ${source})`);

    let weeklyData;

    if (source === 'reddit') {
      // ── Fonte: Reddit (r/gtaonline) ───────────────────────────────
      // O weeklyService já busca, parseia e valida o post mais recente.
      // Retorna JSON normalizado com selftext preservado para a IA.
      weeklyData = await weeklyService.getLatest();
    } else {
      // ── Fonte: Rockstar Newswire ──────────────────────────────────
      // Busca o artigo, traduz para PT-BR e monta o texto para a IA.
      weeklyData = await fetchWeeklyEvent();
    }

    if (!weeklyData) {
      logger.warn(`[GTAOEngine] Nenhum dado semanal obtido da fonte "${source}".`);
      return null;
    }

    // Garante que source está definido (defesa contra dados legados no cache)
    weeklyData.source = weeklyData.source || source;

    // Usa o snapshot diário já salvo (ou coleta um novo se ainda não existir
    // hoje) para dar contexto de Van de Armas / Comerciantes / Desafios
    // Contra o Relógio à IA, e para extrair as armas com desconto ativo.
    const todayStr = new Date().toISOString().split('T')[0];
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
      logger.warn('[GTAOEngine] Análise semanal da IA falhou — salvando apenas os dados brutos da fonte.');
    }

    gtaoRepository.saveWeekly(weekKey, weeklyData);
    logger.info(`[GTAOEngine] Snapshot semanal [${weekKey}] (fonte: ${source}) salvo com sucesso no banco.`);

    return weeklyData;
  },
};
