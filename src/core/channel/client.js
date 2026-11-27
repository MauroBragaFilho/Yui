// Cliente do canal local cérebro ↔ adaptadores (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §4). Roda no adaptador
// (YuiBot, app, PC, YouTube Live).
//
//  - lê o segredo (e a porta) do arquivo restrito que o cérebro grava a cada subida; relê a CADA tentativa de conexão,
//    porque o segredo muda quando o cérebro reinicia;
//  - só conecta em endereço de loopback (o segredo nunca sai deste computador);
//  - reconecta sozinho com espera crescente (250 ms, 500 ms, 1 s... até 30 s, com variação aleatória);
//  - quando a conexão cai, os pedidos pendentes são recusados na hora com erro claro (CONNECTION_LOST); pedidos feitos
//    com o canal desconectado são recusados com NOT_CONNECTED (nada fica preso esperando);
//  - mão dupla: client.handle(método, fn) atende os pedidos do cérebro (ações do canal), com a mesma idempotência.
// O log nunca recebe o segredo nem os parâmetros: só método, tamanho e código de erro.
import { WebSocket } from 'ws';
import { logger as defaultLogger } from '../../utils/logger.js';
import {
  PROTOCOL_VERSION, DEFAULT_MAX_FRAME_BYTES, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_IDEM_MAX, DEFAULT_IDEM_TTL_MS,
  METHOD_RE, CLOSE, ChannelError, createIdemCache, createPeer, normalizeCapabilities,
} from './protocol.js';
import { channelSecretFilePath, readChannelSecretFile } from './secret.js';

const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]', '::1']);
/** Fechamentos em que reconectar logo não adianta: substituída por outra conexão do papel, papel desconhecido, protocolo. */
const SLOW_RETRY_CODES = new Set([CLOSE.REPLACED, CLOSE.UNKNOWN_ROLE, CLOSE.PROTOCOL]);

function assertLoopbackUrl(url) {
  let u;
  try { u = new URL(url); } catch { throw new TypeError(`URL do canal inválida: ${url}`); }
  if (u.protocol !== 'ws:') throw new TypeError('O canal local usa ws:// (loopback).');
  if (!LOOPBACK_HOSTS.has(u.hostname.toLowerCase())) throw new TypeError(`O canal só conecta no loopback (recebi ${u.hostname}).`);
  return u.toString();
}

/**
 * Conecta ao canal do cérebro. Devolve o cliente na hora; a conexão segue em segundo plano (use `ready()`).
 * @param {{
 *   role: string, capabilities?: string[], url?: string, secretFile?: string, env?: object, logger?: object,
 *   requestTimeoutMs?: number, maxFrameBytes?: number, reconnect?: boolean, minBackoffMs?: number, maxBackoffMs?: number,
 *   connectTimeoutMs?: number, idemMax?: number, idemTtlMs?: number, now?: () => number,
 * }} options
 */
export function connectChannel({
  role,
  capabilities = [],
  url = null,
  secretFile = null,
  env = process.env,
  logger = defaultLogger,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  reconnect = true,
  minBackoffMs = 250,
  maxBackoffMs = 30_000,
  connectTimeoutMs = 5_000,
  idemMax = DEFAULT_IDEM_MAX,
  idemTtlMs = DEFAULT_IDEM_TTL_MS,
  now = Date.now,
} = {}) {
  if (typeof role !== 'string' || !role) throw new TypeError('connectChannel: informe o papel (role).');
  const caps = normalizeCapabilities(capabilities);
  if (!caps) throw new TypeError('connectChannel: capacidades inválidas (lista de textos curtos).');
  const fixedUrl = url ? assertLoopbackUrl(url) : null;
  const file = secretFile || channelSecretFilePath(env);

  /** @type {Map<string, Function>} */
  const handlers = new Map();
  /** @type {Map<string, Set<Function>>} */
  const listeners = new Map();
  const stateListeners = new Set();
  const idem = createIdemCache({ max: idemMax, ttlMs: idemTtlMs, now });
  let ws = null;
  let peer = null;
  let hello = null;
  let state = 'idle';
  let closed = false;
  let attempt = 0;
  let reconnectTimer = null;
  let helloTimer = null;
  let readyWaiters = [];
  const counters = { connects: 0, disconnects: 0, reconnectAttempts: 0 };

  function setState(next, extra = {}) {
    state = next;
    for (const fn of stateListeners) { try { fn({ state: next, ...extra }); } catch { /* */ } }
  }

  function settleReady(err) {
    const waiters = readyWaiters;
    readyWaiters = [];
    for (const w of waiters) { clearTimeout(w.timer); if (err) w.reject(err); else w.resolve(hello); }
  }

  function scheduleReconnect(reason) {
    if (closed || !reconnect || reconnectTimer) return;
    const base = Math.min(maxBackoffMs, minBackoffMs * 2 ** Math.min(attempt, 20));
    const wait = Math.round(base * (0.8 + Math.random() * 0.4));
    attempt += 1;
    counters.reconnectAttempts += 1;
    logger.info?.(`[canal] ${role}: nova tentativa em ${wait} ms (${reason})`);
    setState('waiting', { retryInMs: wait, reason });
    reconnectTimer = setTimeout(() => { reconnectTimer = null; open(); }, wait);
    reconnectTimer.unref?.();
  }

  function open() {
    if (closed) return;
    let info;
    try {
      info = readChannelSecretFile(file);
    } catch (err) {
      logger.warn?.(`[canal] ${role}: ${err.message}`);
      scheduleReconnect('arquivo do segredo indisponível');
      return;
    }
    let target;
    try {
      target = fixedUrl || assertLoopbackUrl(`ws://127.0.0.1:${info.port}`);
    } catch (err) {
      logger.warn?.(`[canal] ${role}: ${err.message}`);
      scheduleReconnect('endereço inválido');
      return;
    }
    setState('connecting');
    const socket = new WebSocket(target, {
      perMessageDeflate: false,
      maxPayload: maxFrameBytes,
      handshakeTimeout: connectTimeoutMs,
      followRedirects: false,
    });
    ws = socket;
    let thisPeer = null;

    socket.on('open', () => {
      // O segredo só vai neste quadro e só para o loopback. Nunca entra em log.
      socket.send(JSON.stringify({ type: 'connect', role, version: PROTOCOL_VERSION, capabilities: caps, secret: info.secret }));
      helloTimer = setTimeout(() => {
        logger.warn?.(`[canal] ${role}: o cérebro não respondeu ao connect`);
        try { socket.terminate(); } catch { /* */ }
      }, connectTimeoutMs);
      helloTimer.unref?.();
    });

    socket.on('message', (data, isBinary) => {
      if (isBinary) { try { socket.close(4002, 'quadro binario'); } catch { /* */ } return; }
      const text = data.toString('utf8');
      if (!thisPeer) {
        let frame;
        try { frame = JSON.parse(text); } catch { frame = null; }
        if (!frame || frame.type !== 'hello' || frame.protocol !== PROTOCOL_VERSION) {
          logger.warn?.(`[canal] ${role}: resposta inesperada ao connect`);
          try { socket.close(4002, 'hello invalido'); } catch { /* */ }
          return;
        }
        clearTimeout(helloTimer);
        hello = { protocol: frame.protocol, role: frame.role, accepted: Array.isArray(frame.accepted) ? frame.accepted : [], maxFrameBytes: frame.maxFrameBytes, connectionId: frame.connectionId };
        const effectiveMax = Number.isInteger(frame.maxFrameBytes) && frame.maxFrameBytes > 0 ? Math.min(frame.maxFrameBytes, maxFrameBytes) : maxFrameBytes;
        thisPeer = createPeer({
          send: (t) => socket.send(t),
          label: `${role}↔cérebro`,
          idPrefix: 'c',
          logger,
          resolveHandler: (method) => {
            const entry = handlers.get(method);
            return entry ? { fn: entry.fn, timeoutMs: entry.timeoutMs } : { error: { code: 'METHOD_NOT_FOUND', message: `O adaptador ${role} não tem o método ${method}.` } };
          },
          meta: { role: 'cerebro', connectionId: hello.connectionId },
          idem,
          idemScope: 'cerebro',
          maxFrameBytes: effectiveMax,
          requestTimeoutMs,
          handlerTimeoutMs: requestTimeoutMs,
          onEvent: (event, payload, seq) => {
            for (const fn of listeners.get(event) ?? []) {
              try { fn(payload, { seq }); } catch { /* ouvinte com erro não derruba o canal */ }
            }
          },
        });
        peer = thisPeer;
        attempt = 0;
        counters.connects += 1;
        logger.info?.(`[canal] ${role}: conectado ao cérebro (conexão ${hello.connectionId})`);
        setState('open', { hello });
        settleReady(null);
        return;
      }
      if (!thisPeer.receive(text)) { try { socket.close(4002, 'quadro invalido'); } catch { /* */ } }
    });

    socket.on('error', (err) => {
      // Mensagens do ws (ex.: "Unexpected server response: 403", ECONNREFUSED) não carregam o que foi enviado.
      logger.debug?.(`[canal] ${role}: erro na conexão (${err?.code || String(err?.message || 'erro').slice(0, 80)})`);
    });

    socket.on('close', (code) => {
      clearTimeout(helloTimer);
      if (ws === socket) ws = null;
      const hadPeer = !!thisPeer;
      if (thisPeer) {
        thisPeer.close(new ChannelError(closed ? 'CLOSED' : 'CONNECTION_LOST', closed ? 'O cliente do canal foi fechado.' : `A conexão com o cérebro caiu (código ${code}).`));
        if (peer === thisPeer) peer = null;
        counters.disconnects += 1;
        logger.info?.(`[canal] ${role}: desconectado do cérebro (código ${code})`);
      }
      if (closed) { setState('closed'); return; }
      if (SLOW_RETRY_CODES.has(code)) {
        // Outra conexão assumiu este papel, ou a configuração não bate (papel/versão): não fica disputando em laço;
        // tenta de novo só no intervalo máximo.
        logger.warn?.(`[canal] ${role}: o cérebro fechou a conexão com o código ${code}; próxima tentativa no intervalo máximo`);
        attempt = Math.max(attempt, 30);
      }
      setState('disconnected', { code, wasOpen: hadPeer });
      scheduleReconnect(hadPeer ? `conexão caiu (código ${code})` : `conexão recusada (código ${code})`);
    });
  }

  open();

  return {
    /** Pede ao cérebro. Resolve com o payload; rejeita com ChannelError (NOT_CONNECTED, TIMEOUT, CONNECTION_LOST, código do cérebro...). */
    request(method, params, { idem: idemKey, timeoutMs = requestTimeoutMs } = {}) {
      if (!peer || state !== 'open') {
        return Promise.reject(new ChannelError(closed ? 'CLOSED' : 'NOT_CONNECTED', `Canal com o cérebro desconectado: o pedido ${method} não foi enviado.`, { method }));
      }
      return peer.request(method, params, { idem: idemKey, timeoutMs });
    },
    /**
     * Atende um método chamado pelo cérebro (ação do canal). `timeoutMs` (opcional): o prazo deste método, quando ele precisa de mais que o do canal
     * (ex.: imagem.gerar, que espera o provedor de imagem); sem ele vale o prazo do canal, como sempre.
     */
    handle(method, fn, { timeoutMs } = {}) {
      if (typeof method !== 'string' || !METHOD_RE.test(method)) throw new TypeError(`Nome de método inválido: ${method}`);
      if (typeof fn !== 'function') throw new TypeError('O handler precisa ser uma função.');
      const entry = { fn, timeoutMs: Number.isInteger(timeoutMs) && timeoutMs > 0 ? timeoutMs : undefined };
      handlers.set(method, entry);
      return () => { if (handlers.get(method) === entry) handlers.delete(method); };
    },
    /** Ouve um evento enviado pelo cérebro. Devolve a função que para de ouvir. */
    on(event, fn) {
      if (!listeners.has(event)) listeners.set(event, new Set());
      listeners.get(event).add(fn);
      return () => listeners.get(event)?.delete(fn);
    },
    /** Envia um evento ao cérebro (sem resposta). false se desconectado. */
    emit(event, payload) {
      return peer && state === 'open' ? peer.emit(event, payload) : false;
    },
    /** Acompanha o estado da conexão: idle, connecting, open, disconnected, waiting, closed. */
    onState(fn) {
      stateListeners.add(fn);
      return () => stateListeners.delete(fn);
    },
    /** Espera a conexão ficar pronta (hello recebido). */
    ready(timeoutMs = 10_000) {
      if (state === 'open' && peer) return Promise.resolve(hello);
      if (closed) return Promise.reject(new ChannelError('CLOSED', 'O cliente do canal foi fechado.'));
      return new Promise((resolve, reject) => {
        const w = { resolve, reject, timer: null };
        w.timer = setTimeout(() => {
          readyWaiters = readyWaiters.filter((x) => x !== w);
          reject(new ChannelError('TIMEOUT', `O canal não conectou em ${timeoutMs} ms.`));
        }, timeoutMs);
        readyWaiters.push(w);
      });
    },
    get state() { return state; },
    get connected() { return state === 'open' && !!peer; },
    get hello() { return hello ? { ...hello, accepted: [...hello.accepted] } : null; },
    stats: () => ({ ...counters, state, attempt, ...(peer ? peer.stats() : {}) }),
    /** Fecha de vez (sem reconectar). Pedidos pendentes são recusados com CLOSED. */
    async close() {
      if (closed) return;
      closed = true;
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
      settleReady(new ChannelError('CLOSED', 'O cliente do canal foi fechado.'));
      const socket = ws;
      if (!socket) { peer?.close(new ChannelError('CLOSED', 'O cliente do canal foi fechado.')); setState('closed'); return; }
      await new Promise((resolve) => {
        socket.once('close', resolve);
        try { socket.close(1000, 'adaptador saindo'); } catch { resolve(); }
        setTimeout(() => { try { socket.terminate(); } catch { /* */ } resolve(); }, 1000).unref?.();
      });
    },
  };
}
