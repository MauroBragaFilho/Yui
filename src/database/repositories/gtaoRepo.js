import { dailyRepository } from './dailyRepo.js';
import { weeklyRepository } from './weeklyRepo.js';

/**
 * Mantido por compatibilidade: todo o código existente do projeto importa
 * `gtaoRepository` de um único lugar (comandos, publisher, scheduler, etc).
 * Internamente, agora delega para dois repositórios separados que apontam
 * para bancos de dados diferentes:
 *
 *   dailyRepository  -> database/gta-diario.db
 *   weeklyRepository -> database/gta-semanal.db
 *
 * Nenhum outro arquivo do projeto precisa ser alterado por causa dessa
 * separação — a assinatura (nomes de métodos) permanece idêntica.
 */
export const gtaoRepository = {
  getDaily: dailyRepository.getDaily,
  getLatestDaily: dailyRepository.getLatestDaily,
  saveDaily: dailyRepository.saveDaily,

  getWeekly: weeklyRepository.getWeekly,
  getLatestWeekly: weeklyRepository.getLatestWeekly,
  saveWeekly: weeklyRepository.saveWeekly,
};
