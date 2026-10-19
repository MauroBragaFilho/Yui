import http from 'http';
import crypto from 'crypto';

/**
 * Servidor HTTP do Yui Gateway: endpoint compatível com a API OpenAI.
 *
 *   GET  /health                 público (só diz se está no ar)
 *   GET  /v1/models              lista modelos virtuais (auto, smart, fast, combos) e reais
 *   POST /v1/chat/completions    com ou sem "stream": true (SSE)
 *   GET  /v1/gateway/status      saúde dos provedores (sem chaves)
 *
 * Segurança: exige `Authorization: Bearer <chave>` SEMPRE (chaves em
 * YUI_GATEWAY_KEYS, 16+ caracteres, comparadas em tempo constante); escuta em
 * 127.0.0.1 por padrão; corpo limitado; limite de requisições por chave; não
 * registra prompts nem respostas.
 */

const MAX_BODY = 2 * 1024 * 1024;
const MAX_MESSAGES = 200;
const RATE = { windowMs: 60_000, max: 120 };
const ROLES = new Set(['system', 'user', 'assistant', 'tool', 'developer']);

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function parseGatewayKeys(raw = process.env.YUI_GATEWAY_KEYS) {
  return String(raw || '')
    .split(',')
    .map((k) => k.trim())
    .filter((k) => k.length >= 16)
    .map((k) => ({ hash: sha(k), id: sha(k).toString('hex').slice(0, 8) }));
}

function authenticate(req, keys) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const given = sha(m[1].trim());
  let found = null;
  for (const k of keys) if (crypto.timingSafeEqual(given, k.hash)) found = k; // percorre todas
  return found;
}

function send(res, status, body, extraHeaders = {}) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...extraHeaders,
  });
  res.end(data);
}

/** Erro no formato OpenAI. */
function sendError(res, status, message, type = 'gateway_error', extra = {}) {
  const headers = extra.retryAfter ? { 'Retry-After': String(extra.retryAfter) } : {};
  send(res, status, { error: { message, type, code: status, ...(extra.attempts ? { attempts: extra.attempts } : {}) } }, headers);
}

// Teto do que se joga fora de um corpo recusado (413): sem isto, um cliente que
// envia sem parar prenderia a conexão até o requestTimeout.
const DRAIN_MAX_BYTES = 32 * 1024 * 1024;
const DRAIN_MAX_MS = 15_000;

/**
 * Descarta o resto de um corpo recusado SEM derrubar a conexão. Fechar o socket
 * com dados ainda a caminho faz o cliente receber ECONNRESET em vez do 413
 * (TG-32); lendo e jogando fora, o 413 chega e a conexão continua utilizável.
 * Devolve uma promessa que se resolve quando o corpo acabou de ser descartado
 * (ou quando o teto de bytes/tempo cortou a conexão).
 */
function drainBody(req) {
  return new Promise((resolve) => {
    let drained = 0;
    const finish = () => { clearTimeout(timer); resolve(); };
    const cut = () => { finish(); if (!req.complete) req.destroy(); }; // nunca derruba um socket já reaproveitado por outra requisição
    const timer = setTimeout(cut, DRAIN_MAX_MS);
    timer.unref();
    req.removeAllListeners('data');
    req.on('data', (c) => {
      drained += c.length;
      if (drained > DRAIN_MAX_BYTES) cut();
    });
    req.once('end', finish);
    req.once('close', finish);
    req.resume();
  });
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    let settled = false;
    const chunks = [];
    const fail = (err) => {
      if (settled) return;
      settled = true;
      chunks.length = 0;
      reject(err);
    };
    const tooLarge = () => {
      const err = Object.assign(new Error('Corpo muito grande'), { status: 413 });
      err.bodyDrained = drainBody(req); // o tratador de erro espera por isto quando a conexão vai fechar depois da resposta
      fail(err);
    };
    // Cliente que desistiu no meio do envio: não há a quem responder.
    const aborted = () => fail(Object.assign(new Error('Requisição abortada pelo cliente'), { status: 400, aborted: true }));

    req.on('error', (err) => (err?.message === 'aborted' || err?.code === 'ECONNRESET' ? aborted() : fail(err)));
    req.on('close', () => { if (!req.complete) aborted(); });
    if (Number(req.headers['content-length']) > MAX_BODY) return tooLarge(); // recusa sem ler nada
    req.on('data', (c) => {
      if (settled) return;
      size += c.length;
      if (size > MAX_BODY) return tooLarge();
      chunks.push(c);
    });
    req.on('end', () => {
      if (settled) return;
      settled = true;
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
  });
}

/** Valida o corpo de /v1/chat/completions. Retorna uma mensagem de erro ou null. */
export function validateChatBody(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return 'O corpo deve ser um objeto JSON.';
  if (!Array.isArray(body.messages) || !body.messages.length) return 'O campo "messages" é obrigatório.';
  if (body.messages.length > MAX_MESSAGES) return `No máximo ${MAX_MESSAGES} mensagens.`;
  for (const m of body.messages) {
    if (!m || typeof m !== 'object' || !ROLES.has(m.role)) return 'Cada mensagem precisa de um "role" válido.';
    if (m.content !== null && m.content !== undefined && typeof m.content !== 'string' && !Array.isArray(m.content)) return 'O "content" deve ser texto ou lista.';
  }
  if (body.model !== undefined && typeof body.model !== 'string') return 'O "model" deve ser texto.';
  return null;
}

export function createGatewayServer({ router, keys = parseGatewayKeys() } = {}) {
  const hits = new Map();
  const limited = (id) => {
    const t = Date.now();
    const list = (hits.get(id) || []).filter((x) => t - x < RATE.windowMs);
    list.push(t);
    hits.set(id, list);
    return list.length > RATE.max;
  };

  return http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;

      if (route === 'GET /health') return send(res, 200, { ok: true, providers: router.status().providers.length });

      const key = authenticate(req, keys);
      if (!key) return sendError(res, 401, 'Chave de API ausente ou inválida.', 'invalid_api_key');
      if (limited(key.id)) return sendError(res, 429, 'Muitas requisições. Aguarde um instante.', 'rate_limit', { retryAfter: 30 });

      if (route === 'GET /v1/models') return send(res, 200, { object: 'list', data: router.models() });
      if (route === 'GET /v1/gateway/status') return send(res, 200, router.status());

      if (route === 'POST /v1/chat/completions') {
        const body = await readJson(req);
        const problem = validateChatBody(body);
        if (problem) return sendError(res, 400, problem, 'invalid_request_error');

        if (!body.stream) {
          try {
            return send(res, 200, await router.chat(body, { sensitive: false }));
          } catch (err) {
            return sendError(res, err.status || 502, err.message, 'gateway_error', { retryAfter: err.retryAfter, attempts: err.attempts });
          }
        }

        // ── streaming (SSE): o failover acontece ANTES do primeiro byte ──
        let out;
        try {
          out = await router.chatStream(body, { sensitive: false });
        } catch (err) {
          return sendError(res, err.status || 502, err.message, 'gateway_error', { retryAfter: err.retryAfter, attempts: err.attempts });
        }
        res.writeHead(200, {
          'Content-Type': 'text/event-stream; charset=utf-8',
          'Cache-Control': 'no-store',
          Connection: 'keep-alive',
          'X-Accel-Buffering': 'no',
          'X-Gateway-Provider': out.provider,
          'X-Gateway-Model': out.model,
        });
        res.write(Buffer.from(out.first));
        req.on('close', () => out.reader.cancel().catch(() => {}));
        try {
          for (;;) {
            const { done, value } = await out.reader.read();
            if (done) break;
            res.write(Buffer.from(value));
          }
        } catch {
          // Falha no meio do stream: não dá para trocar de provedor (já enviamos bytes). Avisa e encerra.
          res.write('data: {"error":{"message":"stream interrompido pelo provedor"}}\n\n');
        }
        return res.end();
      }

      return sendError(res, 404, 'Rota não encontrada.', 'not_found');
    } catch (err) {
      if (err?.aborted) return; // o cliente fechou a conexão no meio do envio: não há a quem responder
      // Cliente que não reaproveita a conexão (HTTP/1.0 ou "Connection: close"): o servidor fecha o socket
      // logo depois da resposta, e fechar com o corpo ainda a caminho vira ECONNRESET. Então esse cliente só
      // recebe a resposta depois que o corpo foi descartado; com keep-alive a resposta sai já.
      if (err?.bodyDrained && !res.shouldKeepAlive) await err.bodyDrained;
      const status = err.status || 500;
      if (!res.headersSent) sendError(res, status, status === 500 ? 'Erro interno.' : err.message, 'gateway_error');
      else res.end();
    }
  });
}
