// Banco numa pasta temporária (DATABASE_DIR), nunca no newswire.db real de database/. A variável é definida ANTES de
// importar src/ (o config a lê na importação), por isso os módulos do projeto entram por import() dinâmico.
// Com o banco vazio, todo artigo coletado conta como inédito (é traduzido e gravado só na pasta temporária).
import path from 'path';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';

const isolated = useIsolatedDatabaseDir('yui-test-newswire-');
const { config } = await import('../src/config/index.js');
assertNotRealDatabaseDir(path.resolve(config.database.dir)); // confere o diretório efetivo antes de abrir qualquer banco
const { initDatabase } = await import('../src/database/db.js');
const { NEWSWIRE_SCHEMA } = await import('../src/database/schemas.js');
const { newswireEngine } = await import('../src/engines/newswire/index.js');
const { logger } = await import('../src/utils/logger.js');
const { getSystemMetrics } = await import('../src/utils/systemMetrics.js');

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

runNewswireTest().finally(() => isolated.cleanup());
