// O LINK DE CONSENTIMENTO DO GOOGLE e o PKCE (etapa 15). Compartilhado em 27/11/2026 (lacunas do painel, entrega F, item 14): a MESMA montagem serve ao script de
// autorização (scripts/google-autorizar.mjs, no PC do dono) e à reautorização pelo painel (reautorizar.js, no servidor da Yui). Antes vivia dentro do script; o
// comportamento é o mesmo, e o script reexporta estas funções.
// Leve de propósito: só node:crypto (o script não carrega o log nem nada do resto da Yui). Nada aqui fala com o Google: só monta o endereço e os valores aleatórios.
// Os endereços vêm sempre de fora (endpoints.js: hostsDoGoogle), nunca escritos aqui.
import crypto from 'node:crypto';

const base64url = (buf) => Buffer.from(buf).toString('base64url');

/** O formato do código de autorização que o Google devolve no retorno (`?code=...`). */
export const CODIGO_DE_AUTORIZACAO_RE = /^[A-Za-z0-9._~/+-]{10,1024}$/;

/** O PKCE (S256): o verificador fica só com quem gerou (o script, ou a memória do servidor); o desafio vai na URL. */
export function criarPkce() {
  const verificador = base64url(crypto.randomBytes(48));
  return { verificador, desafio: base64url(crypto.createHash('sha256').update(verificador).digest()) };
}

/** A URL de consentimento. */
export function montarUrlDeConsentimento({ hosts, clientId, redirectUri, escopos, desafio, state }) {
  const q = new URLSearchParams({
    client_id: clientId, redirect_uri: redirectUri, response_type: 'code', scope: escopos.join(' '),
    code_challenge: desafio, code_challenge_method: 'S256', state, access_type: 'offline', prompt: 'consent',
  });
  return `${hosts.autorizacao}?${q}`;
}

/** Compara dois textos em tempo constante (o `state` do retorno). Tamanhos diferentes = diferentes. */
export function iguaisEmTempoConstante(a, b) {
  const x = Buffer.from(String(a ?? '')); const y = Buffer.from(String(b ?? ''));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
}
