// UMA leitura da API do Google com o access token do autenticador (etapa 15): a base de agenda.js, tarefas.js e gmail.js. Só GET (a integração é somente leitura).
// O resultado leva só códigos fixos (nunca o corpo da resposta, o token nem a URL).
import { pedirJson } from './http.js';
import { PRAZO_DA_CHAMADA_MS } from './config.js';

/**
 * @param {{ autenticador: ReturnType<import('./auth.js').criarAutenticador>, recurso: 'agenda'|'tarefas'|'gmail', url: string, fetchImpl?: Function, timeoutMs?: number }} p
 * @returns {Promise<{ ok: true, json: any } | { ok: false, motivo: 'desligado'|'nao-conectado'|'arquivo-invalido'|'precisa-autorizar'|'rede'|'negado'|'cota'|'erro' }>}
 */
export async function lerDoGoogle({ autenticador, recurso, url, fetchImpl = globalThis.fetch, timeoutMs = PRAZO_DA_CHAMADA_MS }) {
  const t = await autenticador.obterToken({ recurso });
  if (!t.ok) return { ok: false, motivo: t.motivo };
  const r = await pedirJson(url, { fetchImpl, timeoutMs, headers: { Authorization: `Bearer ${t.token}` } });
  if (r.ok) return { ok: true, json: r.json };
  if (r.status === 401) { autenticador.descartarToken?.(); return { ok: false, motivo: 'erro' }; }
  if (r.status === 403) return { ok: false, motivo: 'negado' };
  if (r.status === 429) return { ok: false, motivo: 'cota' };
  if (r.motivo === 'rede' || r.motivo === 'tempo' || r.status >= 500) return { ok: false, motivo: 'rede' };
  return { ok: false, motivo: 'erro' };
}
