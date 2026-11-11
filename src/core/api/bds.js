import crypto from 'node:crypto';
import { Readable } from 'node:stream';
import { readBdsConfig } from '../../services/bdsLibrary.js';

/**
 * Ponte entre o painel da Yui e o BDS Server (servidor de arquivos): a Yui vira a única porta de entrada para o dono.
 *
 * O painel nunca fala com o BDS Server direto: tudo passa pela API da Yui (login do dono), que repassa ao BDS Server por dentro do
 * notebook (YUI_BDS_URL, por padrão http://127.0.0.1). Listar, buscar, criar pasta, renomear, apagar (vai para a lixeira do BDS),
 * restaurar, esvaziar, enviar e baixar/assistir com Range. Os arquivos grandes (filmes) passam em fluxo, sem carregar na memória.
 *
 * Vídeo, áudio e foto precisam de um endereço que o navegador abra sem cabeçalho de login: `mintLink` gera um link curto
 * (10 min) amarrado a UM caminho; só o dono consegue gerá-lo.
 *
 * Tudo aqui é injetável (config, fetch, relógio) para testar sem rede.
 */

export const BDS_JSON_TIMEOUT_MS = 30_000;
export const LINK_TTL_MS = 10 * 60 * 1000;
export const MAX_LINKS = 200;
const MAX_PATH = 1000;

export class BdsProxyError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

/** Cabeçalhos que voltam do BDS Server para o navegador (nada de Set-Cookie nem cabeçalhos internos). */
const PASS_HEADERS = ['content-type', 'content-length', 'content-range', 'accept-ranges', 'content-disposition', 'etag', 'last-modified'];

function checkPath(value, label = 'caminho') {
  const v = String(value ?? '');
  if (!v.trim()) throw new BdsProxyError(400, `Informe o ${label}.`);
  if (v.length > MAX_PATH) throw new BdsProxyError(400, `O ${label} é longo demais.`);
  if (v.includes('\0')) throw new BdsProxyError(400, `O ${label} é inválido.`);
  return v;
}

export function createBdsProxy({ readConfig = readBdsConfig, fetchImpl = (...a) => fetch(...a), now = Date.now, token = () => crypto.randomBytes(24).toString('base64url') } = {}) {
  const links = new Map(); // token -> { caminho, inline, expires }

  function cfg() {
    const c = readConfig();
    if (!c.enabled) throw new BdsProxyError(503, 'O BDS Server não está configurado nesta Yui (defina YUI_BDS_URL no .env).');
    return c;
  }

  function headersFor(c, { write = false, extra = {} } = {}) {
    const h = { ...extra };
    if (c.key) h.Authorization = `Bearer ${c.key}`;
    if (write) h['X-BDS-Client'] = 'web'; // o BDS Server exige este cabeçalho em escrita sem chave de API
    return h;
  }

  async function failFrom(res) {
    let msg = `O BDS Server respondeu ${res.status}.`;
    try { const j = await res.json(); if (j?.erro) msg = String(j.erro).slice(0, 300); } catch { /* corpo não é JSON */ }
    return new BdsProxyError(res.status >= 400 && res.status < 600 ? res.status : 502, msg);
  }

  function unreachable(err) {
    if (err instanceof BdsProxyError) return err;
    const timeout = err?.name === 'TimeoutError' || err?.name === 'AbortError';
    return new BdsProxyError(504, timeout ? 'O BDS Server demorou demais para responder.' : 'Não consegui falar com o BDS Server (ele está ligado?).');
  }

  /** Chamada JSON (GET/POST). `query` vira parâmetros da URL. */
  async function json(method, sub, { query = {}, body = undefined } = {}) {
    const c = cfg();
    const qs = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) if (v !== undefined && v !== null && v !== '') qs.set(k, String(v));
    const url = `${c.url}/api/${sub}${qs.size ? `?${qs}` : ''}`;
    try {
      const res = await fetchImpl(url, {
        method,
        headers: headersFor(c, { write: method !== 'GET', extra: { Accept: 'application/json', ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) } }),
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: AbortSignal.timeout(BDS_JSON_TIMEOUT_MS),
        redirect: 'error',
      });
      if (!res.ok) throw await failFrom(res);
      return await res.json();
    } catch (err) {
      throw unreachable(err);
    }
  }

  /**
   * Baixar/assistir: devolve { status, headers, stream } para o servidor da Yui escrever na resposta. Repassa o Range.
   * `abort` deve ser acionado quando o navegador desistir (fecha a conexão com o BDS Server).
   */
  async function openDownload({ caminho, inline = false, range = '', abort }) {
    const c = cfg();
    checkPath(caminho);
    const qs = new URLSearchParams({ caminho });
    if (inline) qs.set('inline', '1');
    try {
      const res = await fetchImpl(`${c.url}/api/files/download?${qs}`, {
        method: 'GET',
        headers: headersFor(c, { extra: range ? { Range: String(range).slice(0, 100) } : {} }),
        signal: abort?.signal, // sem prazo total: filme grande leva o tempo que precisar; o fim vem do navegador
        redirect: 'error',
      });
      if (res.status === 416) {
        return { status: 416, headers: { 'Content-Range': res.headers.get('content-range') || '' }, stream: null };
      }
      if (!res.ok) throw await failFrom(res);
      const headers = {};
      for (const h of PASS_HEADERS) { const v = res.headers.get(h); if (v) headers[h] = v; }
      headers['cache-control'] = 'no-store';
      headers['x-content-type-options'] = 'nosniff';
      return { status: res.status, headers, stream: res.body ? Readable.fromWeb(res.body) : null };
    } catch (err) {
      throw unreachable(err);
    }
  }

  /** Enviar: repassa o corpo da requisição (em fluxo) para o BDS Server. `req` é a requisição Node; `abort` fecha se o navegador desistir. */
  async function upload({ caminho, req, abort }) {
    const c = cfg();
    checkPath(caminho);
    const length = req.headers['content-length'];
    try {
      const res = await fetchImpl(`${c.url}/api/files/upload?${new URLSearchParams({ caminho })}`, {
        method: 'PUT',
        headers: headersFor(c, { write: true, extra: { 'Content-Type': 'application/octet-stream', ...(length ? { 'Content-Length': String(length) } : {}) } }),
        body: Readable.toWeb(req),
        duplex: 'half',
        signal: abort?.signal,
        redirect: 'error',
      });
      if (!res.ok) throw await failFrom(res);
      return await res.json();
    } catch (err) {
      throw unreachable(err);
    }
  }

  // ── Links curtos para o navegador abrir vídeo, áudio, foto e PDF sem cabeçalho de login ──
  function prune() {
    const t = now();
    for (const [k, v] of links) if (v.expires <= t) links.delete(k);
    while (links.size > MAX_LINKS) links.delete(links.keys().next().value);
  }

  function mintLink({ caminho, inline = true }) {
    cfg();
    checkPath(caminho);
    prune();
    const t = token();
    links.set(t, { caminho, inline: Boolean(inline), expires: now() + LINK_TTL_MS });
    return { token: t, path: `/v1/bds/get/${t}`, expiresInSec: Math.round(LINK_TTL_MS / 1000) };
  }

  function resolveLink(t) {
    prune();
    const v = links.get(String(t ?? ''));
    return v && v.expires > now() ? { caminho: v.caminho, inline: v.inline } : null;
  }

  return { enabled: () => readConfig().enabled, json, openDownload, upload, mintLink, resolveLink, _links: links };
}

/** Rotas do painel -> rota do BDS Server (só as permitidas; nada além disto passa). */
export const JSON_ROUTES = Object.freeze({
  'GET status': { sub: 'status' },
  'GET audit': { sub: 'audit', query: ['limite'] },
  'GET roots': { sub: 'files/roots' },
  'GET list': { sub: 'files/list', query: ['caminho'] },
  'GET search': { sub: 'files/search', query: ['q'] },
  'GET recent': { sub: 'files/recent', query: ['limite'] },
  'GET usage': { sub: 'files/usage' },
  'GET trash': { sub: 'files/trash' },
  'POST mkdir': { sub: 'files/mkdir', body: ['caminho'] },
  'POST rename': { sub: 'files/rename', body: ['de', 'para'] },
  'POST delete': { sub: 'files/delete', body: ['caminho', 'confirmar'] },
  'POST restore': { sub: 'files/restore', body: ['caminho'] },
  'POST purge': { sub: 'files/purge', body: ['caminho', 'confirmar'] },
});
