/**
 * Cálculo do "seed" diário usado pelo GTA Online para determinar as
 * rotações do dia (Gun Van, Street Dealers, Time Trials, etc).
 * O reset acontece às 06:00 UTC — por isso subtraímos 6h (21600s)
 * antes de dividir pelo tamanho de um dia (86400s).
 *
 * Aceita uma data customizada, o que permite calcular a rotação de
 * QUALQUER dia — passado, hoje, ou futuro — de forma 100% determinística.
 */
export function getSeedValue(date = new Date()) {
  const cloudTime = BigInt(Math.floor(date.getTime() / 1000));
  return (cloudTime - 21600n) / 86400n;
}

export function getUnixSeconds(date = new Date()) {
  return Math.floor(date.getTime() / 1000);
}

/**
 * Retorna a data (00:00 UTC) do N-ésimo próximo reset diário (06:00 UTC).
 * offsetDays = 0 -> hoje, 1 -> amanhã, 7 -> daqui 1 semana, etc.
 * Útil para prever rotações futuras.
 */
export function getFutureResetDate(offsetDays = 0) {
  const now = new Date();
  const future = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + offsetDays, 6, 0, 5)
  );
  return future;
}
