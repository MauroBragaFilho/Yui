// Bancos numa pasta temporária (DATABASE_DIR), nunca nos .db reais de database/. A variável é definida ANTES de
// importar src/ (o config a lê na importação), por isso os módulos do projeto entram por import() dinâmico.
import path from 'path';
import { useIsolatedDatabaseDir, assertNotRealDatabaseDir } from './helpers/isolatedDatabaseDir.js';

const isolated = useIsolatedDatabaseDir('yui-test-gtao-');
const { config } = await import('../src/config/index.js');
assertNotRealDatabaseDir(path.resolve(config.database.dir)); // confere o diretório efetivo antes de abrir qualquer banco
const { initDatabase } = await import('../src/database/db.js');
const { GTA_DAILY_SCHEMA, GTA_WEEKLY_SCHEMA } = await import('../src/database/schemas.js');
const { gtaoEngine } = await import('../src/engines/gtao/index.js');
const { logger } = await import('../src/utils/logger.js');

async function runGTAOTest() {
  logger.info('=== [TESTE ISOLADO] GTAO ENGINE (DIÁRIO & SEMANAL) ===');

  await initDatabase('gta-diario', GTA_DAILY_SCHEMA);
  await initDatabase('gta-semanal', GTA_WEEKLY_SCHEMA);

  try {
    logger.info('1. Testando coleta diária (Gun Van, Dealers, Shipwreck, Time Trials)...');
    const dailyResult = await gtaoEngine.collectDaily();
    logger.info(`Coleta diária concluída para: ${dailyResult.date}`);
    console.log(JSON.stringify(dailyResult, null, 2));

    logger.info('\n2. Testando coleta semanal (Bônus, Descontos, Pódio)...');
    const weeklyResult = await gtaoEngine.collectWeekly();
    logger.info('Coleta semanal concluída:');
    console.log(JSON.stringify(weeklyResult, null, 2));
  } catch (error) {
    logger.error(`Erro no teste do GTAO Engine: ${error.message}`);
  }

  logger.info('=== TESTE CONCLUÍDO ===');
}

runGTAOTest().finally(() => isolated.cleanup());
