import { fetchWeeklyEventFromGtaForums } from '../src/engines/gtao/systems/gtaForumsScraper.js';
import { fetchWeeklyEvent, fetchWeeklyEventFromNewswire } from '../src/engines/gtao/systems/weeklyEvents.js';
import { logger } from '../src/utils/logger.js';

async function run() {
  logger.info('=== [TESTE ISOLADO] GTAFORUMS WEEKLY EVENT SCRAPER ===');

  logger.info('\n1. Testando SOMENTE o scraper do GTAForums (fonte principal)...');
  const forumsResult = await fetchWeeklyEventFromGtaForums();
  if (forumsResult) {
    logger.info('✅ GTAForums retornou dados com sucesso:');
    console.log(JSON.stringify(forumsResult, null, 2));
  } else {
    logger.warn('⚠️ GTAForums retornou NULL (bloqueio anti-bot, seletor desatualizado, ou sem tópico compatível).');
  }

  logger.info('\n2. Testando fetchWeeklyEvent() (fluxo completo com fallback automático)...');
  const finalResult = await fetchWeeklyEvent();
  if (finalResult) {
    logger.info(`✅ Resultado final obtido via fonte: "${finalResult.source}"`);
    console.log(JSON.stringify(finalResult, null, 2));
  } else {
    logger.error('❌ Nem GTAForums nem Newswire retornaram dados. Verifique conexão/seletores.');
  }

  logger.info('\n3. (Opcional) Testando SOMENTE o fallback do Newswire isoladamente...');
  const newswireResult = await fetchWeeklyEventFromNewswire();
  if (newswireResult) {
    logger.info('✅ Fallback do Newswire funcionando normalmente (independente do GTAForums).');
  } else {
    logger.info('ℹ️ Newswire não achou artigo semanal agora (pode ser normal se ainda não postaram esta semana).');
  }

  logger.info('\n=== TESTE CONCLUÍDO ===');
}

run();
