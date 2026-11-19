// UMA chamada HTTP ao Google (etapa 15): prazo curto, UMA tentativa, sem seguir redirecionamento (o cabeçalho de autorização nunca vai para outro endereço),
// resposta com tamanho limitado, e NADA do que sai ou volta (token, corpo, URL com dados) vai para o log ou para um erro: o resultado leva só códigos fixos.
import { PRAZO_DA_CHAMADA_MS } from './config.js';

const MAX_RESPOSTA_BYTES = 2 * 1024 * 1024;
const CODIGO_DO_GOOGLE_RE = /^[a-z][a-z0-9_]{0,39}$/;

/**
 * @param {string} url
 * @param {{ metodo?: string, headers?: object, corpo?: string|null, fetchImpl?: Function, timeoutMs?: number, maxBytes?: number }} [o]
 * @returns {Promise<{ ok: true, status: number, json: any } | { ok: false, status: number, motivo: 'rede'|'tempo'|'http'|'resposta-invalida'|'grande', erro: string|null }>}
 *   `erro`: o código curto que o Google informa em `error` (ex.: "invalid_grant"), só se tiver o formato de um código; nunca o texto da resposta.
 */
export async function pedirJson(url, { metodo = 'GET', headers = {}, corpo = null, fetchImpl = globalThis.fetch, timeoutMs = PRAZO_DA_CHAMADA_MS, maxBytes = MAX_RESPOSTA_BYTES } = {}) {
  if (typeof fetchImpl !== 'function') return { ok: false, status: 0, motivo: 'rede', erro: null };
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), Math.max(200, timeoutMs));
  try {
    let res;
    try {
      res = await fetchImpl(url, { method: metodo, headers: { Accept: 'application/json', ...headers }, body: corpo ?? undefined, redirect: 'error', signal: controlador.signal });
    } catch {
      return { ok: false, status: 0, motivo: controlador.signal.aborted ? 'tempo' : 'rede', erro: null };
    }
    let texto;
    try {
      const declarado = Number(res.headers?.get?.('content-length'));
      if (Number.isFinite(declarado) && declarado > maxBytes) return { ok: false, status: res.status, motivo: 'grande', erro: null };
      texto = await res.text();
    } catch {
      return { ok: false, status: res.status, motivo: controlador.signal.aborted ? 'tempo' : 'rede', erro: null };
    }
    if (texto.length > maxBytes) return { ok: false, status: res.status, motivo: 'grande', erro: null };
    let json = null;
    try { json = texto ? JSON.parse(texto) : null; } catch { json = null; }
    if (!res.ok) {
      const codigo = typeof json?.error === 'string' && CODIGO_DO_GOOGLE_RE.test(json.error) ? json.error : null;
      return { ok: false, status: res.status, motivo: 'http', erro: codigo };
    }
    if (json === null || typeof json !== 'object') return { ok: false, status: res.status, motivo: 'resposta-invalida', erro: null };
    return { ok: true, status: res.status, json };
  } finally {
    clearTimeout(timer);
  }
}
