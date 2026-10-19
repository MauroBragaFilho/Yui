/**
 * Orçamento de prompt: cortes que preservam o que importa e a leitura segura de erros de tamanho.
 *
 *  - clipHeadTail: encurta um texto mantendo o INÍCIO e o FIM (70% / 30%) com um marcador no meio;
 *  - buildChatLog: monta o log de conversa do /chat_resumo sem passar de um teto, das mais novas
 *    para as mais antigas, encurtando cada mensagem longa (antes eram até 100 mensagens sem corte,
 *    cerca de 400 KB no prompt);
 *  - isTooLargeError: decide se uma falha de provedor de IA foi por TAMANHO do pedido (413, ou 400/422
 *    de contexto), para não confundir com cota esgotada nem alertar o dono à toa. É SEGURO: nunca
 *    lança e IGNORA corpos que são stream (o LM Studio é lido com responseType 'stream', e fazer
 *    JSON.stringify em um IncomingMessage lança "Converting circular structure to JSON");
 *  - sizeErrorText: a frase ao usuário. Contém, em minúsculas, "erro ao processar seu pedido", que
 *    as checagens existentes (messageCreate.js e isErrorReply do contextStore) tratam como erro.
 *
 * Módulo puro: sem efeito ao importar, sem rede, sem timers. Lê process.env só quando é chamado
 * (e o ambiente é injetável).
 */

/** Trecho que as checagens de "resposta de erro" do projeto já reconhecem. */
export const SIZE_ERROR_MARKER = 'erro ao processar seu pedido';

const CLIP_MARKER = ' [...] ';
const isHighSurrogate = (c) => c >= 0xD800 && c <= 0xDBFF;
const isLowSurrogate = (c) => c >= 0xDC00 && c <= 0xDFFF;

/** Estimativa grosseira de tokens a partir de caracteres (cerca de 3,5 caracteres por token em português). */
export function estimateTokens(chars) {
  const n = Number(chars);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n / 3.5) : 0;
}

/**
 * Encurta `value` para no máximo `max` caracteres mantendo o início (70%) e o fim (30%),
 * separados por " [...] ". Texto que cabe volta idêntico. Não parte par substituto (emoji).
 */
export function clipHeadTail(value, max) {
  const s = String(value ?? '');
  const limit = Math.floor(Number(max));
  if (!(limit > 0)) return '';
  if (s.length <= limit) return s;
  if (limit < CLIP_MARKER.length + 10) return s.slice(0, limit);
  const room = limit - CLIP_MARKER.length;
  const headLen = Math.ceil(room * 0.7);
  const tailLen = room - headLen;
  let head = s.slice(0, headLen);
  if (head && isHighSurrogate(head.charCodeAt(head.length - 1))) head = head.slice(0, -1);
  let tail = tailLen > 0 ? s.slice(s.length - tailLen) : '';
  if (tail && isLowSurrogate(tail.charCodeAt(0))) tail = tail.slice(1);
  return head + CLIP_MARKER + tail;
}

function intFromEnv(env, name, fallback, min, max) {
  const n = Number.parseInt(String(env?.[name] ?? ''), 10);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.max(n, min), max);
}

/**
 * Log de conversa para o /chat_resumo.
 *
 * `msgs`: lista em ordem cronológica (da mais antiga para a mais nova) de { time, user, content }.
 * Mensagens sem texto são ignoradas. Percorre das MAIS NOVAS para as mais antigas e para na primeira
 * que não cabe (a janela fica contínua), então o log nunca passa de `maxChars`. Cada mensagem passa
 * por clipHeadTail(perMsg). Padrões: YUI_SUMMARY_MAX_CHARS (20000) e YUI_SUMMARY_PER_MESSAGE (600).
 *
 * Retorna { log, used, total, clipped, truncated }:
 *  - log: linhas "[hora] usuário: texto" separadas por quebra de linha, sem quebra final;
 *  - used: quantas mensagens entraram; total: quantas tinham texto;
 *  - clipped: quantas foram encurtadas; truncated: used < total (houve mensagens de fora).
 */
export function buildChatLog(msgs, { maxChars, perMsg, env = process.env } = {}) {
  const budget = Number.isFinite(Number(maxChars)) && Number(maxChars) > 0
    ? Math.floor(Number(maxChars))
    : intFromEnv(env, 'YUI_SUMMARY_MAX_CHARS', 20000, 1000, 200000);
  const each = Number.isFinite(Number(perMsg)) && Number(perMsg) > 0
    ? Math.floor(Number(perMsg))
    : intFromEnv(env, 'YUI_SUMMARY_PER_MESSAGE', 600, 50, 4000);
  const items = (Array.isArray(msgs) ? msgs : []).filter((m) => m && String(m.content ?? '').trim());
  const picked = []; // da mais nova para a mais antiga
  let size = 0;
  let clipped = 0;
  for (let i = items.length - 1; i >= 0; i--) {
    const m = items[i];
    const text = String(m.content).trim();
    const body = clipHeadTail(text, each);
    let line = `[${String(m.time ?? '').slice(0, 40)}] ${String(m.user ?? '').slice(0, 64)}: ${body}`;
    const cost = line.length + (picked.length ? 1 : 0);
    if (size + cost > budget) {
      if (picked.length === 0) { // a mais nova sozinha estoura o teto: entra encurtada em vez de sumir
        line = clipHeadTail(line, budget);
        picked.push(line);
        size = line.length;
        clipped++;
      }
      break;
    }
    picked.push(line);
    size += cost;
    if (body.length < text.length) clipped++;
  }
  return {
    log: picked.reverse().join('\n'),
    used: picked.length,
    total: items.length,
    clipped,
    truncated: picked.length < items.length,
  };
}

const STREAM_METHODS = ['pipe', 'getReader', 'on'];

function isStreamLike(raw) {
  for (const m of STREAM_METHODS) if (typeof raw[m] === 'function') return true;
  return typeof raw[Symbol.asyncIterator] === 'function';
}

/**
 * Texto do corpo de erro de uma resposta HTTP (até `maxChars`), lido só se for string, Buffer/bytes ou
 * objeto simples (JSON). Streams (IncomingMessage, ReadableStream) são IGNORADOS. NUNCA lança.
 */
export function errorBodyText(err, maxChars = 2000) {
  try {
    const raw = err?.response?.data;
    if (raw === null || raw === undefined) return '';
    if (typeof raw === 'string') return raw.slice(0, maxChars);
    if (Buffer.isBuffer(raw)) return raw.toString('utf8', 0, maxChars);
    if (raw instanceof ArrayBuffer) return Buffer.from(raw).toString('utf8', 0, maxChars);
    if (ArrayBuffer.isView(raw)) return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8', 0, maxChars);
    if (typeof raw === 'object') {
      if (isStreamLike(raw)) return '';
      const inner = raw.error ?? raw;
      const text = typeof inner === 'string' ? inner : JSON.stringify(inner);
      return typeof text === 'string' ? text.slice(0, maxChars) : '';
    }
  } catch { /* corpo ilegível (circular, getter que lança...): só a mensagem do erro */ }
  return '';
}

/**
 * O corpo do erro de uma resposta pedida como STREAM (o LM Studio é lido assim) chega como um fluxo que errorBodyText ignora; sem o texto, um 400
 * de "contexto estourado" parecia cota esgotada. Lê até `maxBytes` do fluxo (com prazo, `timeoutMs`) e o põe em err.response.data como objeto
 * (se for JSON) ou texto, para errorBodyText e isTooLargeError acharem a mensagem. O fluxo é encerrado ao fim. Devolve true se trocou o corpo.
 * NUNCA lança nem fica pendurado (fluxo que não termina: o prazo corta).
 */
export async function drainErrorBody(err, { maxBytes = 4096, timeoutMs = 800 } = {}) {
  try {
    const raw = err?.response?.data;
    if (!raw || typeof raw !== 'object' || Buffer.isBuffer(raw) || typeof raw.on !== 'function') return false;
    const text = await new Promise((resolve) => {
      const chunks = [];
      let size = 0;
      let settled = false;
      const finish = () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        try {
          raw.removeListener('data', onData);
          raw.on('error', () => {}); // um erro tardio do fluxo já descartado não pode virar exceção solta
          if (typeof raw.destroy === 'function') raw.destroy();
        } catch { /* fluxo já encerrado */ }
        resolve(Buffer.concat(chunks).toString('utf8', 0, maxBytes));
      };
      const onData = (chunk) => {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
        chunks.push(buf);
        size += buf.length;
        if (size >= maxBytes) finish();
      };
      const timer = setTimeout(finish, timeoutMs);
      if (typeof timer.unref === 'function') timer.unref();
      raw.on('data', onData);
      raw.once('end', finish);
      raw.once('close', finish);
      raw.once('error', finish);
    });
    if (!text.trim()) return false;
    let body = text;
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed === 'object') body = parsed;
    } catch { /* não era JSON: fica o texto */ }
    err.response.data = body;
    return true;
  } catch {
    return false;
  }
}

function errorStatus(err) {
  const direct = Number(err?.response?.status ?? err?.status ?? err?.statusCode);
  if (Number.isFinite(direct) && direct > 0) return direct;
  const m = /status code (\d{3})/i.exec(String(typeof err === 'string' ? err : err?.message ?? ''));
  return m ? Number(m[1]) : 0;
}

const SIZE_RE = /context|too long|too large|reduce the length|exceeds the maximum|token count|max_new_tokens|too many tokens|n_ctx|entity too large/;

/**
 * A falha do provedor foi por TAMANHO do pedido?
 *  - 413: sempre;
 *  - 400 ou 422: se o prompt estimado passa de 12000 tokens, ou se a mensagem/corpo fala de contexto/tamanho;
 *  - qualquer outra coisa (429, 5xx, rede, cota): não.
 * Seguro: nunca lança (devolve false se algo no erro for estranho).
 */
export function isTooLargeError(err, approxTokens = 0) {
  try {
    const status = errorStatus(err);
    if (status === 413) return true;
    if (status === 400 || status === 422) {
      if (Number(approxTokens) > 12000) return true;
      const message = String(typeof err === 'string' ? err : err?.message ?? '').slice(0, 1000);
      return SIZE_RE.test(`${message} ${errorBodyText(err)}`.toLowerCase());
    }
    return false;
  } catch {
    return false;
  }
}

/** Frase ao usuário quando todos os provedores recusaram o pedido por tamanho. */
export function sizeErrorText(tokens) {
  const k = Math.round(Number(tokens) / 1000);
  const about = Number.isFinite(k) && k >= 1 ? ` (cerca de ${k} mil tokens)` : '';
  return `Não consegui responder: ${SIZE_ERROR_MARKER}, porque ele ficou grande demais para os modelos${about}. Encurte o texto ou mande em partes.`;
}
