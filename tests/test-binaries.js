import { getYtdlpPath, getFfmpegPath, getFfprobePath, validateMediaTools } from '../src/utils/binaries.js';
import { logger } from '../src/utils/logger.js';

async function testBinaries() {
  logger.info('=== [TESTE ISOLADO] BINARIES LAYER ===');
  logger.info(`Platform: ${process.platform}`);
  logger.info(`Resolved yt-dlp: ${getYtdlpPath()}`);
  logger.info(`Resolved ffmpeg: ${getFfmpegPath()}`);
  logger.info(`Resolved ffprobe: ${getFfprobePath()}`);

  const validation = await validateMediaTools();
  logger.info(`Resultado da validação: ${JSON.stringify(validation)}`);
  logger.info('=== TESTE CONCLUÍDO ===');
}

testBinaries();
