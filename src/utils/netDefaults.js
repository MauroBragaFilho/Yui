import axios from 'axios';

/**
 * Prazo padrão para toda chamada de rede que não definiu o seu.
 *
 * Por quê: na queda de Wi-Fi de 10/11/2026 a checagem do YouTube ficou cerca de 33 min presa num `fetch` sem prazo, e o `fetch`
 * do Node e o `axios` esperam para sempre por padrão. Aqui o `fetch` global ganha um `AbortSignal.timeout` e o `axios`, um
 * `timeout` padrão. Quem já passa o seu (`signal` no fetch, `timeout` no axios, por exemplo os provedores de IA com 90 s) não muda.
 *
 * YUI_HTTP_TIMEOUT_MS ajusta (padrão 45000; 0 desliga).
 */
export const DEFAULT_HTTP_TIMEOUT_MS = 45_000;

let installed = false;

export function installDefaultTimeouts({ ms, fetchTarget = globalThis, axiosTarget = axios } = {}) {
  const wanted = ms ?? (process.env.YUI_HTTP_TIMEOUT_MS !== undefined ? Number(process.env.YUI_HTTP_TIMEOUT_MS) : DEFAULT_HTTP_TIMEOUT_MS);
  const timeoutMs = Number.isFinite(wanted) && wanted > 0 ? wanted : 0;
  if (!timeoutMs) return { installed: false, timeoutMs: 0 };
  if (installed && fetchTarget === globalThis) return { installed: true, timeoutMs };

  const original = fetchTarget.fetch;
  if (typeof original === 'function' && !original.__yuiTimeout) {
    const wrapped = function fetchWithDefaultTimeout(input, init) {
      // Request já traz o seu signal; e quem passou `signal` decide sozinho.
      if ((init && init.signal) || (typeof Request !== 'undefined' && input instanceof Request)) return original.call(this, input, init);
      return original.call(this, input, { ...(init || {}), signal: AbortSignal.timeout(timeoutMs) });
    };
    wrapped.__yuiTimeout = true;
    fetchTarget.fetch = wrapped;
  }
  if (axiosTarget?.defaults && !axiosTarget.defaults.timeout) axiosTarget.defaults.timeout = timeoutMs;
  if (fetchTarget === globalThis) installed = true;
  return { installed: true, timeoutMs };
}
