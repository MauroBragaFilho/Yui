import { initDatabase } from '../src/database/db.js';
import { NEWSWIRE_SCHEMA } from '../src/database/schemas.js';
import { newswireEngine } from '../src/engines/newswire/index.js';
import { logger } from '../src/utils/logger.js';
import { getSystemMetrics } from '../src/utils/systemMetrics.js';

async function runNewswireTest() {
  logger.info('=== [TESTE ISOLADO] NEWSIWIRE ENGINE & PUPPETEER ===');
  
  await initDatabase('newswire', NEWSWIRE_SCHEMA);

  const metricsBefore = getSystemMetrics();
  logger.info(`Memória RAM antes da execução: ${metricsBefore.rssMB} MB`);

  try {
    const newArticles = await newswireEngine.checkLatestNews();
    logger.info(`Artigos retornados: ${newArticles.length}`);
    console.log(JSON.stringify(newArticles, null, 2));
  } catch (error) {
    logger.error(`Erro no teste do Newswire: ${error.message}`);
  }

  const metricsAfter = getSystemMetrics();
  logger.info(`Memória RAM após término e fechamento do Chromium: ${metricsAfter.rssMB} MB`);
  logger.info('=== TESTE CONCLUÍDO ===');
}

runNewswireTest();
