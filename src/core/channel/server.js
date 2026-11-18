// Servidor do canal local cérebro ↔ adaptadores (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §4). Roda no YuiCerebro.
//
// Proteções, todas antes de qualquer pedido chegar a um handler:
//  - escuta só em 127.0.0.1 (porta própria: YUI_CHANNEL_PORT, padrão 3941); nunca passa pelo `tailscale serve`;
//  - no upgrade HTTP, recusa: origem que não seja o loopback, qualquer cabeçalho de proxy (X-Forwarded-*, Forwarded, Via,
//    X-Real-IP, Tailscale-*), Host que não seja 127.0.0.1/localhost/[::1] na porta do canal (DNS rebinding) e Origin
//    presente (navegador);
//  - o primeiro quadro tem de ser `connect` com o segredo do arquivo restrito (secret.js), um papel conhecido e a versão
//    do protocolo; qualquer outra coisa fecha a conexão. 5 tentativas erradas travam o canal por 60 s;
//  - limite de tamanho de quadro (1 MB por padrão; o connect, antes da autenticação, só 16 KB), prazo por pedido e
//    limite de pedidos simultâneos por conexão;
//  - idempotência: `idem` repetido devolve a resposta guardada sem chamar o handler de novo (últimas 1000, por 10 min).
// Mão dupla: o cérebro também chama métodos do adaptador com server.request(papel, método, parâmetros).
// O log nunca recebe o segredo nem os parâmetros: só método, tamanho e código de erro.
import http from 'node:http';
import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';
import { logger as defaultLogger } from '../../utils/logger.js';
import {
  PROTOCOL_VERSION, CHANNEL_ROLES, DEFAULT_MAX_FRAME_BYTES, DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_IDEM_MAX, DEFAULT_IDEM_TTL_MS,
  MAX_CONNECT_FRAME_BYTES, CLOSE, METHOD_RE, ChannelError, createIdemCache, createPeer, normalizeCapabilities,
} from './protocol.js';
import {
  channelSecretFilePath, channelPortFromEnv, writeChannelSecretFile, removeChannelSecretFile, restrictFileToOwner,
} from './secret.js';

const LOOPBACK_ADDRESSES = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const PROXY_HEADERS = new Set(['forwarded', 'via', 'x-real-ip', 'true-client-ip', 'cf-connecting-ip', 'x-original-forwarded-for', 'x-client-ip']);

/** Nome do cabeçalho de proxy encontrado (ou null). */
export function findProxyHeader(headers) {
  for (const name of Object.keys(headers || {})) {
    const h = name.toLowerCase();
    if (PROXY_HEADERS.has(h) || h.startsWith('x-forwarded-') || h.startsWith('tailscale-')) return h;
  }
  return null;
}

/** O Host do pedido é o loopback na porta do canal? */
export function isLoopbackHost(host, port) {
  const h = String(host ?? '').trim().toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}` || h === `[::1]:${port}`;
}

const sha256 = (s) => crypto.createHash('sha256').update(String(s)).digest();
const safeEqual = (a, b) => crypto.timingSafeEqual(sha256(a), sha256(b));

/**
 * Sobe o servidor do canal.
 * @param {{
 *   env?: object, port?: number, secretFile?: string, logger?: object, roles?: string[],
 *   maxFrameBytes?: number, requestTimeoutMs?: number, connectTimeoutMs?: number,
 *   idemMax?: number, idemTtlMs?: number, maxFails?: number, lockMs?: number, pingIntervalMs?: number,
 *   maxInFlight?: number, now?: () => number, restrictFile?: (file: string) => void,
 *   onViolation?: (type: string, details: object) => void,
 *   onConnect?: (info: object) => void, onDisconnect?: (info: object) => void,
 * }} [options]
 */
export async function startChannelServer({
  env = process.env,
  port = channelPortFromEnv(env),
  secretFile = channelSecretFilePath(env),
  logger = defaultLogger,
  roles = CHANNEL_ROLES,
  maxFrameBytes = DEFAULT_MAX_FRAME_BYTES,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  connectTimeoutMs = 5_000,
  idemMax = DEFAULT_IDEM_MAX,
  idemTtlMs = DEFAULT_IDEM_TTL_MS,
  maxFails = 5,
  lockMs = 60_000,
  pingIntervalMs = 30_000,
  maxInFlight = 256,
  now = Date.now,
  restrictFile = restrictFileToOwner,
  onViolation = null,
  onConnect = null,
  onDisconnect = null,
} = {}) {
  const secret = crypto.randomBytes(32).toString('hex');
  const knownRoles = new Set(roles);
  /** @type {Map<string, {fn: Function, roles: Set<string>|null}>} */
  const handlers = new Map();
  /** @type {Map<string, Set<Function>>} */
  const eventListeners = new Map();
  /** Conexão autenticada atual de cada papel. */
  const byRole = new Map();
  const sockets = new Set();
  const idem = createIdemCache({ max: idemMax, ttlMs: idemTtlMs, now });
  let fails = 0;
  let lockedUntil = 0;
  let closing = false;
  let actualPort = 0;
  const counters = { connections: 0, refusedUpgrade: 0, refusedConnect: 0, badSecret: 0, locks: 0, replaced: 0 };

  const violation = (type, details = {}) => {
    try { onViolation?.(type, details); } catch { /* o registro da violação não derruba o canal */ }
  };

  const acceptedFor = (role) => [...handlers].filter(([, h]) => !h.roles || h.roles.has(role)).map(([m]) => m).sort();

  function resolveHandlerFor(role) {
    return (method) => {
      const h = handlers.get(method);
      if (!h) return { error: { code: 'METHOD_NOT_FOUND', message: `O cérebro não tem o método ${method}.` } };
      if (h.roles && !h.roles.has(role)) return { error: { code: 'METHOD_NOT_ALLOWED', message: `O papel ${role} não pode chamar ${method}.` } };
      return { fn: h.fn, timeoutMs: h.timeoutMs };
    };
  }

  function rejectUpgrade(socket, status, text, type, extraHeaders = '') {
    counters.refusedUpgrade += 1;
    logger.warn?.(`[canal] conexão recusada no upgrade (${type})`);
    violation(type);
    const body = Buffer.from(text, 'utf8');
    try {
      socket.end(`HTTP/1.1 ${status} ${http.STATUS_CODES[status] || ''}\r\nConnection: close\r\nContent-Type: text/plain; charset=utf-8\r\nCache-Control: no-store\r\n${extraHeaders}Content-Length: ${body.length}\r\n\r\n${text}`);
    } catch { /* socket já fechado */ }
    setTimeout(() => socket.destroy(), 1000).unref?.();
  }

  const httpServer = http.createServer((req, res) => {
    res.writeHead(426, { 'Content-Type': 'text/plain; charset=utf-8', Connection: 'close', 'Cache-Control': 'no-store' });
    res.end('Canal local da Yui: use WebSocket.');
  });
  httpServer.on('clientError', (err, socket) => { try { socket.destroy(); } catch { /* */ } });

  const wss = new WebSocketServer({ noServer: true, maxPayload: maxFrameBytes, perMessageDeflate: false, clientTracking: false });

  httpServer.on('upgrade', (req, socket, head) => {
    socket.on('error', () => { /* conexão recusada ou derrubada: nada a fazer */ });
    if (closing) return rejectUpgrade(socket, 503, 'Canal desligando.', 'canal_desligando');
    const addr = String(req.socket.remoteAddress ?? '');
    if (!LOOPBACK_ADDRESSES.has(addr)) return rejectUpgrade(socket, 403, 'Somente deste computador.', 'canal_origem_nao_loopback');
    const proxy = findProxyHeader(req.headers);
    if (proxy) return rejectUpgrade(socket, 403, 'Pedido encaminhado por proxy não é aceito.', 'canal_cabecalho_de_proxy');
    if (!isLoopbackHost(req.headers.host, actualPort)) return rejectUpgrade(socket, 403, 'Host inválido.', 'canal_host_invalido');
    if (req.headers.origin !== undefined) return rejectUpgrade(socket, 403, 'Navegadores não podem usar este canal.', 'canal_origem_de_navegador');
    if (now() < lockedUntil) {
      return rejectUpgrade(socket, 429, 'Muitas tentativas. Aguarde.', 'canal_travado', `Retry-After: ${Math.ceil((lockedUntil - now()) / 1000)}\r\n`);
    }
    wss.handleUpgrade(req, socket, head, (ws) => onConnection(ws));
  });

  function closeWs(ws, code, reason) {
    try { ws.close(code, reason); } catch { /* */ }
    setTimeout(() => { try { ws.terminate(); } catch { /* */ } }, 2000).unref?.();
  }

  function failedHandshake(ws, code, reason, type, countsAsFail) {
    counters.refusedConnect += 1;
    if (countsAsFail) {
      fails += 1;
      if (code === CLOSE.UNAUTHORIZED) counters.badSecret += 1;
      if (fails >= maxFails) {
        lockedUntil = now() + lockMs;
        fails = 0;
        counters.locks += 1;
        logger.warn?.(`[canal] ${maxFails} tentativas erradas: canal travado por ${Math.round(lockMs / 1000)} s`);
        violation('canal_travado_por_tentativas');
      }
    }
    logger.warn?.(`[canal] conexão recusada (${type})`);
    violation(type);
    closeWs(ws, code, reason);
  }

  function onConnection(ws) {
    sockets.add(ws);
    const connectionId = crypto.randomBytes(4).toString('hex');
    let conn = null; // preenchido depois do connect válido
    const timer = setTimeout(() => failedHandshake(ws, CLOSE.CONNECT_TIMEOUT, 'connect nao chegou a tempo', 'canal_connect_sem_resposta', false), connectTimeoutMs);
    timer.unref?.();

    ws.on('error', () => { /* o 'close' vem em seguida */ });
    ws.on('pong', () => { if (conn) conn.alive = true; });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        if (!conn) { clearTimeout(timer); return failedHandshake(ws, CLOSE.PROTOCOL, 'quadro binario', 'canal_quadro_binario', true); }
        logger.warn?.(`[canal] ${conn.role}: quadro binário recusado`);
        return closeWs(ws, CLOSE.PROTOCOL, 'quadro binario');
      }
      if (!conn) {
        clearTimeout(timer);
        return handleConnect(ws, data, connectionId, (c) => { conn = c; });
      }
      if (!conn.peer.receive(data.toString('utf8'))) closeWs(ws, CLOSE.PROTOCOL, 'quadro invalido');
    });
    ws.on('close', (code) => {
      clearTimeout(timer);
      sockets.delete(ws);
      if (!conn) return;
      conn.peer.close(new ChannelError('CONNECTION_LOST', `A conexão do adaptador ${conn.role} caiu.`));
      if (byRole.get(conn.role) === conn) byRole.delete(conn.role);
      logger.info?.(`[canal] ${conn.role} desconectado (conexão ${connectionId}, código ${code})`);
      try { onDisconnect?.({ role: conn.role, connectionId, code }); } catch { /* */ }
    });
  }

  function handleConnect(ws, data, connectionId, setConn) {
    if (data.length > MAX_CONNECT_FRAME_BYTES) return failedHandshake(ws, CLOSE.PROTOCOL, 'connect grande demais', 'canal_connect_grande', true);
    let frame;
    try { frame = JSON.parse(data.toString('utf8')); } catch { frame = null; }
    if (!frame || typeof frame !== 'object' || frame.type !== 'connect') {
      return failedHandshake(ws, CLOSE.PROTOCOL, 'primeiro quadro precisa ser connect', 'canal_primeiro_quadro_invalido', true);
    }
    if (now() < lockedUntil) return failedHandshake(ws, CLOSE.LOCKED, 'canal travado', 'canal_travado', false);
    if (typeof frame.secret !== 'string' || !safeEqual(frame.secret, secret)) {
      return failedHandshake(ws, CLOSE.UNAUTHORIZED, 'segredo invalido', 'canal_segredo_invalido', true);
    }
    // Daqui em diante o segredo está certo: os erros são de configuração, não contam para a trava.
    if (typeof frame.role !== 'string' || !knownRoles.has(frame.role)) {
      return failedHandshake(ws, CLOSE.UNKNOWN_ROLE, 'papel desconhecido', 'canal_papel_desconhecido', false);
    }
    if (frame.version !== PROTOCOL_VERSION) {
      return failedHandshake(ws, CLOSE.PROTOCOL, 'versao do protocolo incompativel', 'canal_versao_incompativel', false);
    }
    const capabilities = normalizeCapabilities(frame.capabilities);
    if (!capabilities) return failedHandshake(ws, CLOSE.PROTOCOL, 'capacidades invalidas', 'canal_capacidades_invalidas', false);
    fails = 0;

    const role = frame.role;
    const conn = { role, capabilities, connectionId, since: new Date(now()).toISOString(), alive: true, ws, peer: null };
    conn.peer = createPeer({
      send: (text) => ws.send(text),
      label: role,
      idPrefix: 's',
      logger,
      resolveHandler: resolveHandlerFor(role),
      meta: { role, capabilities, connectionId },
      idem,
      idemScope: role,
      maxFrameBytes,
      requestTimeoutMs,
      handlerTimeoutMs: requestTimeoutMs,
      maxInFlight,
      onEvent: (event, payload, seq) => {
        for (const fn of eventListeners.get(event) ?? []) {
          try { fn(payload, { role, connectionId, seq }); } catch { /* ouvinte com erro não derruba o canal */ }
        }
      },
    });
    const previous = byRole.get(role);
    byRole.set(role, conn);
    setConn(conn);
    if (previous) {
      counters.replaced += 1;
      previous.peer.close(new ChannelError('CONNECTION_LOST', `A conexão do adaptador ${role} foi substituída por uma nova.`));
      closeWs(previous.ws, CLOSE.REPLACED, 'substituida por conexao nova');
    }
    counters.connections += 1;
    ws.send(JSON.stringify({ type: 'hello', protocol: PROTOCOL_VERSION, role, accepted: acceptedFor(role), maxFrameBytes, connectionId }));
    logger.info?.(`[canal] ${role} conectado (conexão ${connectionId}, ${capabilities.length} capacidade(s))`);
    try { onConnect?.({ role, capabilities, connectionId }); } catch { /* */ }
    return undefined;
  }

  // Batimento: derruba conexões meio abertas (sem pong desde o último ping).
  const pingTimer = setInterval(() => {
    for (const conn of byRole.values()) {
      if (!conn.alive) { try { conn.ws.terminate(); } catch { /* */ } continue; }
      conn.alive = false;
      try { conn.ws.ping(); } catch { /* */ }
    }
  }, pingIntervalMs);
  pingTimer.unref?.();

  await new Promise((resolve, reject) => {
    httpServer.once('error', reject);
    httpServer.listen(port, '127.0.0.1', () => { httpServer.off('error', reject); resolve(); });
  }).catch((err) => { clearInterval(pingTimer); throw err; });
  actualPort = httpServer.address().port;

  try {
    writeChannelSecretFile(secretFile, { port: actualPort, secret, pid: process.pid, startedAt: new Date(now()).toISOString(), protocol: PROTOCOL_VERSION }, { restrict: restrictFile });
  } catch (err) {
    clearInterval(pingTimer);
    await new Promise((r) => httpServer.close(() => r()));
    throw err;
  }
  logger.info?.(`[canal] ouvindo em 127.0.0.1:${actualPort} (segredo em arquivo restrito)`);

  async function close() {
    if (closing) return;
    closing = true;
    clearInterval(pingTimer);
    for (const conn of byRole.values()) conn.peer.close(new ChannelError('CONNECTION_LOST', 'O cérebro está desligando o canal.'));
    const waits = [...sockets].map((ws) => new Promise((resolve) => {
      if (ws.readyState === ws.CLOSED) return resolve();
      ws.once('close', resolve);
      try { ws.close(CLOSE.GOING_AWAY, 'cerebro desligando'); } catch { resolve(); }
      setTimeout(() => { try { ws.terminate(); } catch { /* */ } resolve(); }, 1000).unref?.();
    }));
    await Promise.all(waits);
    removeChannelSecretFile(secretFile, secret);
    await new Promise((resolve) => { httpServer.close(() => resolve()); httpServer.closeAllConnections?.(); });
    logger.info?.('[canal] servidor fechado');
  }

  return {
    get port() { return actualPort; },
    get url() { return `ws://127.0.0.1:${actualPort}`; },
    secretFile,
    /**
     * Registra o handler de um método (cérebro ← adaptador). `roles` limita quais papéis podem chamar; `timeoutMs` troca o prazo do
     * handler só deste método (ex.: chat.turn, que espera a IA; sem ele vale o prazo do canal).
     * @param {string} method
     * @param {(params: unknown, meta: {role: string, capabilities: string[], connectionId: string, requestId: string|number, idem: string|null, signal: AbortSignal}) => Promise<unknown>} fn
     * @param {{roles?: string[], timeoutMs?: number}} [options]
     * @returns {() => void} remove o handler
     */
    handle(method, fn, { roles: allowed, timeoutMs: methodTimeoutMs } = {}) {
      if (typeof method !== 'string' || !METHOD_RE.test(method)) throw new TypeError(`Nome de método inválido: ${method}`);
      if (typeof fn !== 'function') throw new TypeError('O handler precisa ser uma função.');
      const entry = { fn, roles: allowed ? new Set(allowed) : null, timeoutMs: Number.isInteger(methodTimeoutMs) && methodTimeoutMs > 0 ? methodTimeoutMs : null };
      handlers.set(method, entry);
      return () => { if (handlers.get(method) === entry) handlers.delete(method); };
    },
    /**
     * Pede ao adaptador conectado com o papel `role` (ação do canal: ex.: o cérebro pedindo ao bot para mandar DM).
     * @returns {Promise<unknown>} o payload da resposta
     */
    request(role, method, params, { idem: idemKey, timeoutMs = requestTimeoutMs } = {}) {
      const conn = byRole.get(role);
      if (!conn) return Promise.reject(new ChannelError('NOT_CONNECTED', `Nenhum adaptador ${role} conectado ao canal.`, { method }));
      return conn.peer.request(method, params, { idem: idemKey, timeoutMs });
    },
    /** Evento para os adaptadores (todos, ou só o do papel `role`). Devolve quantos receberam. */
    emit(event, payload, { role } = {}) {
      let sent = 0;
      for (const conn of byRole.values()) {
        if (role && conn.role !== role) continue;
        if (conn.peer.emit(event, payload)) sent += 1;
      }
      return sent;
    },
    /** Ouve eventos enviados pelos adaptadores. */
    onEvent(event, fn) {
      if (!eventListeners.has(event)) eventListeners.set(event, new Set());
      eventListeners.get(event).add(fn);
      return () => eventListeners.get(event)?.delete(fn);
    },
    isConnected: (role) => byRole.has(role),
    connections: () => [...byRole.values()].map((c) => ({ role: c.role, capabilities: [...c.capabilities], connectionId: c.connectionId, since: c.since })),
    stats: () => ({
      ...counters,
      connected: byRole.size,
      lockedUntil: lockedUntil > now() ? new Date(lockedUntil).toISOString() : null,
      failedAttempts: fails,
      idemEntries: idem.size,
      idemReplays: idem.replays,
    }),
    close,
  };
}
