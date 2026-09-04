import { logger } from '../../../../utils/logger.js';

/**
 * Validador do Weekly (Reddit → Parser → Validator).
 *
 * Verifica se um resultado do parser é válido o suficiente para ser
 * publicado, evitando sobrescrever dados válidos com vazios ou publicar
 * conteúdo incompleto.
 *
 * O validador sendo um módulo separado mantém a separação Reddit / Parser /
 * Validator / Service prevista na arquitetura.
 */

/**
 * Valida o resultado do parser.
 *
 * @param {object} weekly - JSON produzido por parseWeekly()
 * @param {object} post - post normalizado do Reddit (id/title/selftext)
 * @returns {{ ok: boolean, reasons: string[] }}
 */
export function validateWeekly(weekly, post) {
  const reasons = [];

  // 1. Post com metadados mínimos
  if (!post) {
    reasons.push('Post de origem ausente.');
    return { ok: false, reasons };
  }
  if (!post.id) reasons.push('Post sem id.');
  if (!post.title) reasons.push('Post sem title.');
  if (!post.selftext) reasons.push('Post sem selftext.');

  // 2. O parser precisa ter identificado pelo menos alguma seção válida.
  const hasContent =
    (weekly?.bonus && weekly.bonus.length > 0) ||
    (weekly?.desafios && weekly.desafios.length > 0) ||
    (weekly?.recompensas && weekly.recompensas.length > 0) ||
    (weekly?.descontos && weekly.descontos.length > 0) ||
    Boolean(weekly?.veiculos?.podium) ||
    Boolean(weekly?.veiculos?.prizeRide) ||
    (weekly?.gunVan && weekly.gunVan.length > 0);

  if (!hasContent) {
    reasons.push('Parser não identificou nenhuma seção válida.');
  }

  // 3. Período, quando identificado, deve ser plausível (não aceitamos
  //    datas absurdas como ano 0000 ou 9999).
  const period = weekly?.periodo || {};
  if (period.inicio && !isPlausibleDate(period.inicio)) {
    reasons.push(`Período de início implausível: ${period.inicio}`);
  }
  if (period.fim && !isPlausibleDate(period.fim)) {
    reasons.push(`Período de fim implausível: ${period.fim}`);
  }
  if (period.inicio && period.fim && period.inicio > period.fim) {
    reasons.push('Período inválido (início depois do fim).');
  }

  return { ok: reasons.length === 0, reasons };
}

/** Data válida "YYYY-MM-DD" entre 2020 e 2100 (janela plausível p/ GTAO). */
export function isPlausibleDate(dateStr) {
  if (typeof dateStr !== 'string') return false;
  const m = dateStr.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (!m) return false;
  const year = parseInt(m[1], 10);
  const month = parseInt(m[2], 10);
  const day = parseInt(m[3], 10);
  if (year < 2020 || year > 2100) return false;
  if (month < 1 || month > 12) return false;
  if (day < 1 || day > 31) return false;
  return true;
}

/**
 * Wrapper de log: registra o motivo da rejeição. Retorna booleano.
 */
export function isValidWeekly(weekly, post) {
  const result = validateWeekly(weekly, post);
  if (!result.ok) {
    logger.warn(`[Weekly][Validator] Weekly rejeitado pela validação: ${result.reasons.join(' | ')}`);
  }
  return result.ok;
}

export default { validateWeekly, isValidWeekly, isPlausibleDate };
