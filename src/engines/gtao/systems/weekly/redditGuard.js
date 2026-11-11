/**
 * Proteção do Chrome do Weekly: o Reddit bloqueia o notebook (403 / timeout) e cada ciclo abria o Chrome à toa
 * (até 3 vezes por ciclo, a cada 30 min), deixando a CPU em 100% por minutos num PC de 4 GB.
 *
 *  - Recuo (backoff): depois de uma falha, o Chrome só volta a abrir depois de uma espera que dobra a cada falha
 *    seguida (padrão 60 min, 120, 240... até 12 h). Um sucesso zera.
 *  - Um Chrome por vez: se já há uma busca rodando, quem chegar depois espera o mesmo resultado em vez de abrir outro.
 *  - Prazo total: a busca inteira (abrir + navegar) tem um limite; passou dele, o Chrome é encerrado.
 *
 * REDDIT_BACKOFF_MIN (padrão 60) e REDDIT_BACKOFF_MAX_MIN (padrão 720) ajustam a espera. Estado só em memória.
 */

const MIN = 60_000;

export function createRedditGuard({ baseMs, maxMs, now = Date.now } = {}) {
  const base = baseMs ?? Math.max(1, Number(process.env.REDDIT_BACKOFF_MIN) || 60) * MIN;
  const max = maxMs ?? Math.max(1, Number(process.env.REDDIT_BACKOFF_MAX_MIN) || 720) * MIN;
  let failures = 0;
  let blockedUntil = 0;
  let inFlight = null;

  return {
    /** { ok: true } ou { ok: false, retryInMs } enquanto estiver esperando o recuo. */
    canTry() {
      const wait = blockedUntil - now();
      return wait > 0 ? { ok: false, retryInMs: wait } : { ok: true, retryInMs: 0 };
    },
    recordFailure() {
      failures += 1;
      const wait = Math.min(max, base * 2 ** (failures - 1));
      blockedUntil = now() + wait;
      return wait;
    },
    recordSuccess() {
      failures = 0;
      blockedUntil = 0;
    },
    get failures() { return failures; },
    /** Roda `fn` uma vez só: chamadas simultâneas dividem o mesmo resultado (um Chrome por vez). */
    run(fn) {
      if (inFlight) return inFlight;
      inFlight = Promise.resolve().then(fn).finally(() => { inFlight = null; });
      return inFlight;
    },
    reset() { failures = 0; blockedUntil = 0; inFlight = null; },
  };
}

/** Guarda único do processo (o scheduler e o comando /weekly usam o mesmo). */
export const redditGuard = createRedditGuard();

/** Rejeita com `code` se `promise` passar de `ms`; o chamador é quem fecha o que abriu. */
export function withDeadline(promise, ms, code = 'REDDIT_DEADLINE', label = 'Reddit') {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`${label} passou do prazo de ${Math.round(ms / 1000)} s`);
      err.code = code;
      reject(err);
    }, ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}
