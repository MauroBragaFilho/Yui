// Protocolo do canal local cérebro ↔ adaptadores (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §4).
//
// Quadros (JSON em texto, um por mensagem WebSocket):
//  - connect: { type: 'connect', role, version, capabilities: [...], secret }   (primeiro quadro, do cliente)
//  - hello:   { type: 'hello', protocol: 1, role, accepted: [...], maxFrameBytes, connectionId } (resposta do cérebro)
//  - pedido:  { type: 'req', id, method, params, idem? }
//  - resposta:{ type: 'res', id, ok, payload | error: { code, message }, replay? }
//  - evento:  { type: 'event', event, payload, seq }
//
// Este arquivo tem as constantes, a validação dos quadros, o cache de idempotência e o "par" (createPeer): o motor de
// pedidos e respostas usado igualzinho pelos dois lados (o cérebro chama o bot e o bot chama o cérebro).
// Nada aqui escreve o segredo nem os parâmetros no log: só o método e o tamanho em bytes.
import { setTimeout as delay } from 'node:timers/promises';

export const PROTOCOL_VERSION = 1;
export const CHANNEL_ROLES = Object.freeze(['bot', 'app', 'pc', 'youtube']);
export const DEFAULT_CHANNEL_PORT = 3941;
export const DEFAULT_MAX_FRAME_BYTES = 1024 * 1024;
export const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
export const DEFAULT_IDEM_MAX = 1000;
export const DEFAULT_IDEM_TTL_MS = 10 * 60_000;
/** O quadro connect (antes da autenticação) é pequeno: qualquer coisa maior que isso é recusada sem nem ler. */
export const MAX_CONNECT_FRAME_BYTES = 16 * 1024;

/** Códigos de fechamento (4000 a 4999 são de uso da aplicação). */
export const CLOSE = Object.freeze({
  NORMAL: 1000,
  GOING_AWAY: 1001,
  TOO_LARGE: 1009,
  UNAUTHORIZED: 4001,
  PROTOCOL: 4002,
  UNKNOWN_ROLE: 4003,
  CONNECT_TIMEOUT: 4008,
  REPLACED: 4009,
  LOCKED: 4029,
});

export const METHOD_RE = /^[A-Za-z][A-Za-z0-9_.:-]{0,63}$/;
const MAX_ID_LENGTH = 64;
const MAX_IDEM_LENGTH = 128;
const MAX_CAPABILITIES = 64;

/** Erro do canal, com código estável (o adaptador decide pelo código, não pela mensagem). */
export class ChannelError extends Error {
  constructor(code, message, details = {}) {
    super(message);
    this.name = 'ChannelError';
    this.code = code;
    Object.assign(this, details);
  }
}

export const byteLength = (text) => Buffer.byteLength(text, 'utf8');

const validId = (id) => (typeof id === 'string' && id.length > 0 && id.length <= MAX_ID_LENGTH) || Number.isSafeInteger(id);

/** Capacidades declaradas no connect: lista de textos curtos. Devolve a lista limpa ou null se inválida. */
export function normalizeCapabilities(caps) {
  if (caps === undefined) return [];
  if (!Array.isArray(caps) || caps.length > MAX_CAPABILITIES) return null;
  if (!caps.every((c) => typeof c === 'string' && c.length > 0 && c.length <= 64)) return null;
  return [...new Set(caps)];
}

/**
 * Lê e valida um quadro já autenticado (req, res ou event). Lança ChannelError('BAD_FRAME') se não servir.
 * @param {string} text
 */
export function parseFrame(text) {
  let frame;
  try {
    frame = JSON.parse(text);
  } catch {
    throw new ChannelError('BAD_FRAME', 'quadro não é JSON');
  }
  if (!frame || typeof frame !== 'object' || Array.isArray(frame)) throw new ChannelError('BAD_FRAME', 'quadro não é objeto');
  switch (frame.type) {
    case 'req':
      if (!validId(frame.id)) throw new ChannelError('BAD_FRAME', 'pedido sem id válido');
      if (typeof frame.method !== 'string' || !METHOD_RE.test(frame.method)) throw new ChannelError('BAD_FRAME', 'pedido sem método válido');
      if (frame.idem !== undefined && (typeof frame.idem !== 'string' || !frame.idem || frame.idem.length > MAX_IDEM_LENGTH)) throw new ChannelError('BAD_FRAME', 'chave de idempotência inválida');
      return frame;
    case 'res':
      if (!validId(frame.id)) throw new ChannelError('BAD_FRAME', 'resposta sem id válido');
      if (typeof frame.ok !== 'boolean') throw new ChannelError('BAD_FRAME', 'resposta sem ok');
      if (!frame.ok && (!frame.error || typeof frame.error !== 'object' || typeof frame.error.code !== 'string')) throw new ChannelError('BAD_FRAME', 'resposta de erro sem código');
      return frame;
    case 'event':
      if (typeof frame.event !== 'string' || !METHOD_RE.test(frame.event)) throw new ChannelError('BAD_FRAME', 'evento sem nome válido');
      if (!Number.isSafeInteger(frame.seq) || frame.seq < 0) throw new ChannelError('BAD_FRAME', 'evento sem seq');
      return frame;
    default:
      throw new ChannelError('BAD_FRAME', 'tipo de quadro inesperado');
  }
}

/**
 * Cache de idempotência: guarda a resposta de cada chave (as últimas `max`, por `ttlMs` depois de concluída).
 * Um pedido repetido enquanto o primeiro ainda roda espera o mesmo resultado (não executa de novo).
 * Só respostas de SUCESSO ficam guardadas: um erro deixa a próxima tentativa com a mesma chave executar.
 */
export function createIdemCache({ max = DEFAULT_IDEM_MAX, ttlMs = DEFAULT_IDEM_TTL_MS, now = Date.now } = {}) {
  /** @type {Map<string, {promise: Promise<object>, done: boolean, at: number}>} */
  const entries = new Map();
  let replays = 0;
  const expired = (e) => e.done && now() - e.at > ttlMs;
  function evict() {
    for (const [key, e] of entries) {
      if (entries.size <= max) return;
      if (e.done) entries.delete(key); // pedidos em andamento nunca são descartados
    }
  }
  return {
    /**
     * Roda `exec` uma vez por chave. `exec` devolve {ok, payload|error} e nunca rejeita.
     * @returns {{promise: Promise<object>, replay: boolean}}
     */
    run(key, exec) {
      const existing = entries.get(key);
      if (existing && !expired(existing)) {
        replays += 1;
        return { promise: existing.promise, replay: true };
      }
      if (existing) entries.delete(key);
      const entry = { promise: null, done: false, at: now() };
      entry.promise = Promise.resolve().then(exec).then((out) => {
        if (out?.ok) { entry.done = true; entry.at = now(); evict(); } else if (entries.get(key) === entry) entries.delete(key);
        return out;
      });
      entries.set(key, entry);
      evict();
      return { promise: entry.promise, replay: false };
    },
    get size() { return entries.size; },
    get replays() { return replays; },
  };
}

function errorOut(code, message) {
  return { ok: false, error: { code, message } };
}

/** Converte o erro de um handler numa resposta: código estável e mensagem curta (o log só recebe o código). */
function handlerErrorOut(err) {
  const code = typeof err?.code === 'string' && /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/.test(err.code) ? err.code : 'HANDLER_ERROR';
  const message = err?.expose === false ? 'Erro interno.' : String(err?.message ?? err ?? 'Erro').slice(0, 500);
  return errorOut(code, message);
}

/**
 * O "par" de uma conexão autenticada: pedidos de saída (com prazo), pedidos de entrada (com handler, prazo,
 * idempotência e limite de pedidos simultâneos) e eventos. Usado pelo servidor e pelo cliente.
 * @param {{
 *   send: (text: string) => void,
 *   label: string,
 *   idPrefix: string,
 *   logger: {debug?: Function, info?: Function, warn?: Function},
 *   resolveHandler: (method: string) => ({fn: Function, timeoutMs?: number} | {error: {code: string, message: string}}),
 *   meta: object,
 *   idem: ReturnType<typeof createIdemCache>,
 *   idemScope: string,
 *   maxFrameBytes: number,
 *   requestTimeoutMs: number,
 *   handlerTimeoutMs: number,
 *   maxInFlight?: number,
 *   onEvent?: (event: string, payload: unknown, seq: number) => void,
 * }} options
 */
export function createPeer({
  send, label, idPrefix, logger, resolveHandler, meta, idem, idemScope,
  maxFrameBytes, requestTimeoutMs, handlerTimeoutMs, maxInFlight = 256, onEvent = null,
}) {
  const pending = new Map();
  const running = new Set(); // AbortControllers dos handlers em andamento
  let seq = 0;
  let eventSeq = 0;
  let closedError = null;
  const counters = { sent: 0, received: 0, handled: 0, failed: 0, timeouts: 0, replays: 0 };

  function sendText(text) {
    if (closedError) return false;
    try { send(text); return true; } catch { return false; }
  }

  /** Pedido de saída. Resolve com o payload; rejeita com ChannelError (código do outro lado, TIMEOUT, CONNECTION_LOST...). */
  function request(method, params, { idem: idemKey, timeoutMs = requestTimeoutMs } = {}) {
    if (closedError) return Promise.reject(new ChannelError(closedError.code, closedError.message, { method }));
    if (typeof method !== 'string' || !METHOD_RE.test(method)) return Promise.reject(new ChannelError('BAD_METHOD', 'Nome de método inválido.', { method }));
    if (idemKey !== undefined && (typeof idemKey !== 'string' || !idemKey || idemKey.length > MAX_IDEM_LENGTH)) {
      return Promise.reject(new ChannelError('BAD_IDEM', 'Chave de idempotência inválida (texto de 1 a 128 caracteres).', { method }));
    }
    const id = `${idPrefix}${++seq}`;
    const frame = { type: 'req', id, method };
    if (params !== undefined) frame.params = params;
    if (idemKey !== undefined) frame.idem = idemKey;
    let text;
    try { text = JSON.stringify(frame); } catch { return Promise.reject(new ChannelError('BAD_PARAMS', `Os parâmetros de ${method} não viram JSON.`, { method })); }
    const bytes = byteLength(text);
    if (bytes > maxFrameBytes) {
      return Promise.reject(new ChannelError('FRAME_TOO_LARGE', `O pedido ${method} tem ${bytes} bytes; o limite do quadro é ${maxFrameBytes}.`, { method, bytes }));
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(id);
        counters.timeouts += 1;
        logger.warn?.(`[canal] ${label}: ${method} passou do prazo de ${timeoutMs} ms`);
        reject(new ChannelError('TIMEOUT', `O pedido ${method} passou do prazo de ${timeoutMs} ms.`, { method }));
      }, timeoutMs);
      timer.unref?.();
      pending.set(id, { resolve, reject, timer, method });
      counters.sent += 1;
      logger.debug?.(`[canal] ${label} → ${method} (${bytes} B${idemKey ? ', idem' : ''})`);
      if (!sendText(text)) {
        clearTimeout(timer);
        pending.delete(id);
        reject(new ChannelError('CONNECTION_LOST', `A conexão do canal caiu antes de enviar ${method}.`, { method }));
      }
    });
  }

  /** Evento de saída (sem resposta). */
  function emit(event, payload) {
    if (typeof event !== 'string' || !METHOD_RE.test(event)) throw new ChannelError('BAD_EVENT', 'Nome de evento inválido.');
    const text = JSON.stringify({ type: 'event', event, payload, seq: ++eventSeq });
    if (byteLength(text) > maxFrameBytes) throw new ChannelError('FRAME_TOO_LARGE', `O evento ${event} passa do limite do quadro.`);
    return sendText(text);
  }

  function sendResponse(id, out, replay) {
    const res = { type: 'res', id, ok: out.ok };
    if (out.ok) res.payload = out.payload; else res.error = out.error;
    if (replay) res.replay = true;
    let text;
    try { text = JSON.stringify(res); } catch { text = JSON.stringify({ type: 'res', id, ok: false, error: { code: 'BAD_RESPONSE', message: 'A resposta não vira JSON.' } }); }
    if (byteLength(text) > maxFrameBytes) {
      text = JSON.stringify({ type: 'res', id, ok: false, error: { code: 'RESPONSE_TOO_LARGE', message: `A resposta passa do limite do quadro (${maxFrameBytes} bytes).` } });
    }
    sendText(text);
  }

  async function handleRequest(frame, bytes) {
    const started = Date.now();
    logger.debug?.(`[canal] ${label} ← ${frame.method} (${bytes} B${frame.idem ? ', idem' : ''})`);
    if (running.size >= maxInFlight) {
      sendResponse(frame.id, errorOut('BUSY', `Pedidos demais em andamento (${maxInFlight}).`));
      return;
    }
    const target = resolveHandler(frame.method);
    if (!target.fn) {
      logger.warn?.(`[canal] ${label}: ${frame.method} recusado (${target.error.code})`);
      sendResponse(frame.id, errorOut(target.error.code, target.error.message));
      return;
    }
    let controller = null;
    const exec = async () => {
      controller = new AbortController();
      running.add(controller);
      try {
        const payload = await target.fn(frame.params, { ...meta, requestId: frame.id, idem: frame.idem ?? null, signal: controller.signal });
        return { ok: true, payload: payload === undefined ? null : payload };
      } catch (err) {
        return handlerErrorOut(err);
      } finally {
        running.delete(controller);
      }
    };
    const { promise, replay } = frame.idem
      ? idem.run(`${idemScope}\u0000${frame.method}\u0000${frame.idem}`, exec)
      : { promise: exec(), replay: false };
    if (replay) counters.replays += 1;
    // Prazo do handler: o do método, quando ele declarou um (ex.: chat.turn, que espera a IA), ou o do canal.
    const limitMs = Number.isInteger(target.timeoutMs) && target.timeoutMs > 0 ? target.timeoutMs : handlerTimeoutMs;
    const deadline = new AbortController();
    let timedOut = false;
    const out = await Promise.race([
      promise,
      delay(limitMs, null, { signal: deadline.signal, ref: false })
        .then(() => { timedOut = true; return errorOut('TIMEOUT', `O handler de ${frame.method} passou do prazo de ${limitMs} ms.`); })
        .catch(() => null),
    ]).finally(() => deadline.abort());
    // Sem idem ninguém vai aproveitar o resultado: avisa o handler para parar. Com idem, deixa terminar (a resposta fica
    // guardada para a nova tentativa com a mesma chave).
    if (timedOut && !frame.idem && controller) controller.abort(new ChannelError('TIMEOUT', 'Prazo do pedido esgotado.'));
    if (!out) return; // não acontece: a corrida sempre tem um vencedor com resposta
    if (out.ok) counters.handled += 1; else counters.failed += 1;
    if (!out.ok) logger.warn?.(`[canal] ${label}: ${frame.method} falhou (${out.error.code}) em ${Date.now() - started} ms`);
    sendResponse(frame.id, out, replay);
  }

  /**
   * Recebe um quadro já autenticado (texto). Devolve false se o quadro é inválido (quem chamou fecha a conexão).
   */
  function receive(text) {
    let frame;
    try {
      frame = parseFrame(text);
    } catch (err) {
      logger.warn?.(`[canal] ${label}: quadro inválido (${err.message})`);
      return false;
    }
    counters.received += 1;
    if (frame.type === 'req') {
      handleRequest(frame, byteLength(text)).catch((err) => logger.warn?.(`[canal] ${label}: erro ao responder (${err?.code || err?.name || 'erro'})`));
    } else if (frame.type === 'res') {
      const p = pending.get(frame.id);
      if (!p) return true; // resposta tardia de pedido que já passou do prazo: ignora
      pending.delete(frame.id);
      clearTimeout(p.timer);
      if (frame.ok) p.resolve(frame.payload);
      else p.reject(new ChannelError(frame.error.code, String(frame.error.message ?? frame.error.code), { method: p.method, remote: true }));
    } else if (frame.type === 'event') {
      try { onEvent?.(frame.event, frame.payload, frame.seq); } catch { /* ouvinte com erro não derruba o canal */ }
    }
    return true;
  }

  /** Fecha o par: recusa os pedidos pendentes com erro claro e avisa os handlers em andamento (signal). */
  function close(error = new ChannelError('CONNECTION_LOST', 'A conexão do canal caiu.')) {
    if (closedError) return;
    closedError = error;
    for (const [id, p] of pending) {
      clearTimeout(p.timer);
      p.reject(new ChannelError(error.code, `${error.message} O pedido ${p.method} ficou sem resposta.`, { method: p.method }));
      pending.delete(id);
    }
    for (const c of running) c.abort(error);
  }

  return {
    request,
    emit,
    receive,
    close,
    get pending() { return pending.size; },
    get running() { return running.size; },
    get closed() { return closedError !== null; },
    stats: () => ({ ...counters, pending: pending.size, running: running.size }),
  };
}
