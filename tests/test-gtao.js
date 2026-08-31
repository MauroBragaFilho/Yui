import { initDatabase } from '../src/database/db.js';
import { GTA_DAILY_SCHEMA, GTA_WEEKLY_SCHEMA } from '../src/database/schemas.js';
import { gtaoEngine } from '../src/engines/gtao/index.js';
import { logger } from '../src/utils/logger.js';

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

runGTAOTest();
