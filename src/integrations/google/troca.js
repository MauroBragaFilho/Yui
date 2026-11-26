// A TROCA do código de autorização pelos tokens (etapa 15), a parte LEVE que o script de autorização (scripts/google-autorizar.mjs, no PC do dono) também usa:
// só HTTP e os endereços; nada do resto da Yui (log, alertas, auditoria) é carregado. Nunca devolve nem lança texto de resposta: só códigos fixos.
import { hostsDoGoogle } from './endpoints.js';
import { PRAZO_DA_CHAMADA_MS } from './config.js';
import { pedirJson } from './http.js';

/** O corpo `application/x-www-form-urlencoded` de um pedido ao endereço de token. */
export const formulario = (campos) => new URLSearchParams(campos).toString();

/**
 * Troca o código de autorização (com o verificador do PKCE) pelos tokens.
 * @returns {Promise<{ ok: true, refreshToken: string|null, escopos: string[], expiraEmS: number } | { ok: false, motivo: string, erro: string|null }>}
 */
export async function trocarCodigoPorTokens({ hosts = hostsDoGoogle(), fetchImpl = globalThis.fetch, clientId, clientSecret, codigo, verificador, redirectUri, timeoutMs = PRAZO_DA_CHAMADA_MS }) {
  const r = await pedirJson(hosts.token, {
    metodo: 'POST', fetchImpl, timeoutMs,
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    corpo: formulario({ code: codigo, client_id: clientId, client_secret: clientSecret, redirect_uri: redirectUri, grant_type: 'authorization_code', code_verifier: verificador }),
  });
  if (!r.ok) return { ok: false, motivo: r.motivo, erro: r.erro };
  const refresh = typeof r.json.refresh_token === 'string' && r.json.refresh_token ? r.json.refresh_token : null;
  const escopos = typeof r.json.scope === 'string' ? r.json.scope.split(/\s+/).filter(Boolean) : [];
  return { ok: true, refreshToken: refresh, accessToken: typeof r.json.access_token === 'string' ? r.json.access_token : null, escopos, expiraEmS: Number(r.json.expires_in) || 0 };
}
