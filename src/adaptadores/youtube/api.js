// CLIENTE DA API DO YOUTUBE para o adaptador de live (docs/CANAIS_NOVOS.md §3.2). DESLIGADO: sem `ligado` nada sai; o `fetch` é INJETADO (os testes usam um servidor FALSO em
// 127.0.0.1; nada daqui chama a API de verdade). Três chamadas, e só elas:
//   buscarLive(videoId)                  videos.list              achar o activeLiveChatId (e saber se a live já acabou)
//   lerMensagens({ liveChatId, pageToken })  liveChatMessages.list    ler o chat, devolvendo o pollingIntervalMillis que a API manda respeitar
//   enviarMensagem({ liveChatId, texto })    liveChatMessages.insert  escrever no chat (até 200 caracteres)
// O token OAuth vem de `obterToken` (injetado; o de verdade ficará em secrets/, fora do Git): nunca é lido, guardado, copiado para o erro nem escrito em log aqui.
// O endereço base só pode ser o da API do Google (https) ou o loopback (http, para o servidor falso dos testes): a Yui não manda o token a nenhum outro lugar.
import { YOUTUBE_MAX_CARACTERES } from '../../core/canais/contrato.js';
import { sanitizeUntrusted } from '../../core/ai/llmSafety.js';

export const BASE_PADRAO = 'https://www.googleapis.com/youtube/v3';
export const INTERVALO_PADRAO_MS = 10_000;
export const INTERVALO_MIN_MS = 1000;
export const INTERVALO_MAX_MS = 120_000;
const HOSTS_DA_API = new Set(['www.googleapis.com', 'youtube.googleapis.com']);
const RESPOSTA_MAX_CARACTERES = 1_500_000;

/** Erro do cliente, com código estável. `permanente`: não passa sozinho (o adaptador para e avisa o dono). */
export class ErroYoutube extends Error {
  constructor(code, { status = null, reason = null, permanente = false } = {}) {
    super(code);
    this.name = 'ErroYoutube';
    this.code = code;
    this.status = status;
    this.reason = reason;
    this.permanente = permanente;
  }
}

const ehLoopback = (h) => h === 'localhost' || h === '::1' || h === '[::1]' || /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(h);

/** O endereço base é aceito (a API do Google em https, ou o loopback em http para teste)? */
export function validarBaseUrl(url) {
  let u;
  try { u = new URL(String(url)); } catch { return { ok: false, codigo: 'base-invalida' }; }
  if (u.username || u.password || u.search || u.hash) return { ok: false, codigo: 'base-invalida' };
  const host = u.hostname.toLowerCase();
  const permitido = (u.protocol === 'https:' && HOSTS_DA_API.has(host) && !u.port) || (u.protocol === 'http:' && ehLoopback(host));
  if (!permitido) return { ok: false, codigo: 'base-nao-permitida' };
  return { ok: true, base: `${u.origin}${u.pathname.replace(/\/+$/, '')}` };
}

/** Traduz o erro HTTP da API (status e a razão do corpo) num código estável. */
export function mapearErroHttp(status, corpo) {
  const razao = String(corpo?.error?.errors?.[0]?.reason ?? corpo?.error?.status ?? '');
  const opts = { status, reason: razao || null };
  if (status === 401) return new ErroYoutube('NAO_AUTENTICADO', { ...opts, permanente: true });
  if (/^(quotaExceeded|dailyLimitExceeded)$/.test(razao)) return new ErroYoutube('COTA_ESGOTADA', { ...opts, permanente: true });
  if (/^(rateLimitExceeded|userRateLimitExceeded)$/.test(razao) || status === 429) return new ErroYoutube('LIMITE_DE_TAXA', opts);
  if (razao === 'liveChatEnded') return new ErroYoutube('LIVE_ACABOU', opts);
  if (razao === 'liveChatDisabled') return new ErroYoutube('CHAT_DESLIGADO', { ...opts, permanente: true });
  if (razao === 'liveChatNotFound') return new ErroYoutube('CHAT_NAO_ENCONTRADO', opts);
  if (status === 403 || /^(forbidden|insufficientPermissions|userBanned|liveChatForbidden)$/.test(razao)) return new ErroYoutube('SEM_PERMISSAO', { ...opts, permanente: true });
  if (status === 404) return new ErroYoutube('NAO_ENCONTRADO', opts);
  if (status >= 500) return new ErroYoutube('FALHA_TEMPORARIA', opts);
  return new ErroYoutube('ERRO_HTTP', opts);
}

const limitar = (n) => (Number.isFinite(n) ? Math.min(INTERVALO_MAX_MS, Math.max(INTERVALO_MIN_MS, Math.round(n))) : INTERVALO_PADRAO_MS);

/**
 * @param {{ ligado: boolean, obterToken: () => Promise<string>, baseUrl?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} o
 */
export function criarClienteYoutube({ ligado, obterToken, baseUrl = BASE_PADRAO, fetchImpl = globalThis.fetch, timeoutMs = 15_000 } = {}) {
  const base = validarBaseUrl(baseUrl);

  async function chamar(metodo, caminho, { consulta = {}, corpo } = {}) {
    if (ligado !== true) throw new ErroYoutube('DESLIGADO', { permanente: true });
    if (!base.ok) throw new ErroYoutube('BASE_INVALIDA', { permanente: true });
    if (typeof fetchImpl !== 'function' || typeof obterToken !== 'function') throw new ErroYoutube('SEM_CREDENCIAL', { permanente: true });
    let token;
    try { token = await obterToken(); } catch (e) { if (e instanceof ErroYoutube) throw e; token = null; } // falha passageira da renovação não vira erro permanente
    if (typeof token !== 'string' || !token) throw new ErroYoutube('NAO_AUTENTICADO', { permanente: true });
    const url = new URL(`${base.base}${caminho}`);
    for (const [k, v] of Object.entries(consulta)) if (v !== undefined && v !== null && v !== '') url.searchParams.set(k, String(v));
    let res;
    try {
      res = await fetchImpl(url, {
        method: metodo,
        headers: { authorization: `Bearer ${token}`, accept: 'application/json', ...(corpo ? { 'content-type': 'application/json' } : {}) },
        body: corpo ? JSON.stringify(corpo) : undefined,
        redirect: 'error',
        signal: AbortSignal.timeout(timeoutMs),
      });
    } catch (e) {
      throw new ErroYoutube(e?.name === 'TimeoutError' || e?.name === 'AbortError' ? 'TIMEOUT' : 'REDE');
    }
    let texto = '';
    try { texto = await res.text(); } catch { throw new ErroYoutube('REDE'); }
    if (texto.length > RESPOSTA_MAX_CARACTERES) throw new ErroYoutube('RESPOSTA_GRANDE_DEMAIS');
    let json = null;
    if (texto) { try { json = JSON.parse(texto); } catch { json = null; } }
    if (!res.ok) throw mapearErroHttp(res.status, json);
    if (json === null || typeof json !== 'object') throw new ErroYoutube('RESPOSTA_INVALIDA', { status: res.status });
    return json;
  }

  return {
    /**
     * Acha o chat da live do vídeo. `eLive`: o vídeo tem dados de transmissão ao vivo; `terminou`: já tem horário de fim; `liveChatId`: o activeLiveChatId (só existe durante a live).
     * @returns {Promise<{ videoId: string, eLive: boolean, terminou: boolean, liveChatId: string|null, titulo: string }>}
     */
    async buscarLive(videoId) {
      const j = await chamar('GET', '/videos', { consulta: { part: 'snippet,liveStreamingDetails', id: videoId } });
      const item = Array.isArray(j.items) ? j.items[0] : null;
      if (!item) throw new ErroYoutube('VIDEO_NAO_ENCONTRADO', { status: 200 });
      const d = item.liveStreamingDetails;
      const terminou = Boolean(d?.actualEndTime);
      const chat = typeof d?.activeLiveChatId === 'string' && d.activeLiveChatId ? d.activeLiveChatId : null;
      return { videoId, eLive: Boolean(d), terminou, liveChatId: terminou ? null : chat, titulo: sanitizeUntrusted(String(item.snippet?.title ?? '')).replace(/\s+/g, ' ').trim().slice(0, 150) };
    },
    /**
     * Lê uma página do chat. `intervaloMs` é o pollingIntervalMillis da API (limitado a 1 s a 2 min): o adaptador NUNCA lê mais rápido que isso.
     * @returns {Promise<{ mensagens: object[], proximaPagina: string|null, intervaloMs: number }>}
     */
    async lerMensagens({ liveChatId, pageToken = null }) {
      const j = await chamar('GET', '/liveChat/messages', { consulta: { liveChatId, part: 'snippet,authorDetails', maxResults: 200, pageToken } });
      return { mensagens: Array.isArray(j.items) ? j.items : [], proximaPagina: typeof j.nextPageToken === 'string' ? j.nextPageToken : null, intervaloMs: limitar(j.pollingIntervalMillis) };
    },
    /** Escreve no chat. O texto precisa caber nos 200 caracteres (o adaptador já ajustou; aqui é a última barreira: nunca sai maior). */
    async enviarMensagem({ liveChatId, texto }) {
      if (typeof texto !== 'string' || !texto.trim() || texto.length > YOUTUBE_MAX_CARACTERES) throw new ErroYoutube('TEXTO_INVALIDO');
      const j = await chamar('POST', '/liveChat/messages', {
        consulta: { part: 'snippet' },
        corpo: { snippet: { liveChatId, type: 'textMessageEvent', textMessageDetails: { messageText: texto } } },
      });
      return { id: typeof j.id === 'string' ? j.id : null };
    },
  };
}
