import { fetchWeeklyEventFromReddit } from '../src/engines/gtao/systems/redditWeeklyScraper.js';
import { fetchWeeklyEvent, fetchWeeklyEventFromNewswire } from '../src/engines/gtao/systems/weeklyEvents.js';
import { logger } from '../src/utils/logger.js';

async function run() {
  logger.info('=== [TESTE ISOLADO] REDDIT WEEKLY EVENT SCRAPER (Stealth Puppeteer) ===');

  logger.info('\n1. Testando SOMENTE o scraper do Reddit (fonte principal)...');
  const redditResult = await fetchWeeklyEventFromReddit();
  if (redditResult) {
    logger.info('✅ Reddit retornou dados com sucesso:');
    console.log(JSON.stringify(redditResult, null, 2));
  } else {
    logger.warn('⚠️ Reddit retornou NULL (post ainda não saiu essa semana, ou bloqueio/429).');
  }

  logger.info('\n2. Testando fetchWeeklyEvent() (fluxo completo com fallback automático)...');
  const finalResult = await fetchWeeklyEvent();
  if (finalResult) {
    logger.info(`✅ Resultado final obtido via fonte: "${finalResult.source}"`);
    console.log(JSON.stringify(finalResult, null, 2));
  } else {
    logger.error('❌ Nem Reddit nem Newswire retornaram dados.');
  }

  logger.info('\n3. (Opcional) Testando SOMENTE o fallback do Newswire isoladamente...');
  const newswireResult = await fetchWeeklyEventFromNewswire();
  if (newswireResult) {
    logger.info('✅ Fallback do Newswire funcionando normalmente (independente do Reddit).');
  } else {
    logger.info('ℹ️ Newswire não achou artigo semanal agora (pode ser normal).');
  }

  logger.info('\n=== TESTE CONCLUÍDO ===');
}

run();
