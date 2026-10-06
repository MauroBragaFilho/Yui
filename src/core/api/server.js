import http from 'http';
import crypto from 'crypto';
import { buildContext, isReadOnlyMode } from '../permissions.js';
import * as memory from '../memory/store.js';
import * as ai from '../ai/manager.js';
import { buildMemoryBlock, captureFromUserText, isMemoryEnabled } from '../discordAdapter.js';
import { audit } from '../audit.js';
import { runAgent, resolvePending } from '../agent/agent.js';
import { registerBuiltinTools } from '../agent/tools.js';
import { logger } from '../../utils/logger.js';

/**
 * Yui API — interface HTTP do Yui Core para apps (mobile/desktop).
 *
 * Segurança:
 *  - Escuta em 127.0.0.1 por padrão. Para acesso remoto use o IP do Tailscale
 *    (YUI_API_HOST); nunca exponha à internet.
 *  - Toda rota (exceto /v1/health) exige `Authorization: Bearer <token>`.
 *  - Token → userId vem de YUI_API_TOKENS ("token=userId,token2=userId2").
 *    O papel (OWNER/MEMBER...) é resolvido pelo backend a partir do userId;
 *    o cliente não escolhe papel nem escopo de memória.
 *  - Corpo limitado, rate limit por token e comparação de token em tempo constante.
 *
 * Cada cliente da API é uma conversa 1:1 privada (equivale a uma DM), então o
 * dono usa a memória pessoal aqui.
 */

const MAX_BODY = 64 * 1024;
const MAX_MESSAGE = 4000;
const RATE_LIMIT = { windowMs: 60_000, max: 30 };
const MAX_HISTORY_TURNS = 10;

const sha = (s) => crypto.createHash('sha256').update(String(s)).digest();

export function parseTokens(raw = process.env.YUI_API_TOKENS) {
  const entries = [];
  for (const pair of String(raw || '').split(',')) {
    const i = pair.indexOf('=');
    if (i <= 0) continue;
    const token = pair.slice(0, i).trim();
    const userId = pair.slice(i + 1).trim();
    if (token.length >= 16 && userId) entries.push({ hash: sha(token), userId });
  }
  return entries;
}

function authenticate(req, tokens) {
  const header = req.headers.authorization || '';
  const m = header.match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  const given = sha(m[1].trim());
  let found = null;
  for (const t of tokens) {
    // percorre todos para não vazar, pelo tempo, qual token existe
    if (crypto.timingSafeEqual(given, t.hash)) found = t;
  }
  return found;
}

/** Origens web autorizadas (CORS), de YUI_API_CORS_ORIGINS="http://a,http://b". Vazio = CORS desligado. */
export function parseCorsOrigins(raw = process.env.YUI_API_CORS_ORIGINS) {
  return new Set(String(raw || '').split(',').map((o) => o.trim().replace(/\/+$/, '')).filter(Boolean));
}

/** Aplica cabeçalhos CORS somente para origens da allowlist (nunca "*"). */
function applyCors(req, res, origins) {
  const origin = req.headers.origin;
  if (!origin || !origins.has(origin)) return false;
  res.setHeader('Access-Control-Allow-Origin', origin);
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Headers', 'Authorization, Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
  res.setHeader('Access-Control-Max-Age', '600');
  return true;
}

function send(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(data),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) { reject(Object.assign(new Error('Corpo muito grande'), { status: 413 })); req.destroy(); return; }
      chunks.push(c);
    });
    req.on('end', () => {
      if (!chunks.length) return resolve({});
      try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
      catch { reject(Object.assign(new Error('JSON inválido'), { status: 400 })); }
    });
    req.on('error', reject);
  });
}

export function createApiServer({ tokens = parseTokens(), corsOrigins = parseCorsOrigins() } = {}) {
  const hits = new Map();       // userId -> [timestamps]
  const histories = new Map();  // userId -> [{role, content}]

  function rateLimited(userId) {
    const now = Date.now();
    const list = (hits.get(userId) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
    list.push(now);
    hits.set(userId, list);
    return list.length > RATE_LIMIT.max;
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://localhost');
      const route = `${req.method} ${url.pathname}`;

      // CORS (apps web). A pré-verificação OPTIONS não leva token, então é
      // respondida antes da autenticação; origens fora da allowlist não recebem cabeçalhos.
      const corsOk = applyCors(req, res, corsOrigins);
      if (req.method === 'OPTIONS') {
        res.writeHead(corsOk ? 204 : 403);
        return res.end();
      }

      if (route === 'GET /v1/health') {
        return send(res, 200, { ok: true, memory: isMemoryEnabled(), readOnly: isReadOnlyMode(), backends: ai.listBackends() });
      }

      const session = authenticate(req, tokens);
      if (!session) return send(res, 401, { error: 'não autorizado' });
      if (rateLimited(session.userId)) return send(res, 429, { error: 'muitas requisições' });

      const ctx = buildContext({ platform: 'api', userId: session.userId, isDM: true });
      if (ctx.role === 'BLOCKED') return send(res, 403, { error: 'acesso negado' });

      if (route === 'GET /v1/me') {
        return send(res, 200, { userId: ctx.userId, role: ctx.role, memoryScope: ctx.memoryScope });
      }

      if (route === 'POST /v1/chat') {
        const body = await readJson(req);
        const message = String(body.message ?? '').trim();
        if (!message) return send(res, 400, { error: 'message obrigatória' });
        if (message.length > MAX_MESSAGE) return send(res, 400, { error: `message excede ${MAX_MESSAGE} caracteres` });

        const history = histories.get(ctx.userId) || [];
        const memoryBlock = buildMemoryBlock(ctx, message);
        const reply = await ai.chat({ prompt: message, history: [...history], ctx, memoryBlock });

        history.push({ role: 'user', content: message.slice(0, 500) }, { role: 'assistant', content: String(reply).slice(0, 800) });
        histories.set(ctx.userId, history.slice(-MAX_HISTORY_TURNS * 2));
        captureFromUserText(ctx, message);
        audit('api.chat', ctx, { chars: message.length });
        return send(res, 200, { reply, memoryScope: ctx.memoryScope });
      }

      if (route === 'POST /v1/agent') {
        const body = await readJson(req);
        const message = String(body.message ?? '').trim();
        if (!message) return send(res, 400, { error: 'message obrigatória' });
        if (message.length > MAX_MESSAGE) return send(res, 400, { error: `message excede ${MAX_MESSAGE} caracteres` });

        const history = histories.get(ctx.userId) || [];
        const memoryBlock = buildMemoryBlock(ctx, message);
        const out = await runAgent(ctx, message, { history: [...history], memoryBlock });

        history.push({ role: 'user', content: message.slice(0, 500) }, { role: 'assistant', content: String(out.reply).slice(0, 800) });
        histories.set(ctx.userId, history.slice(-MAX_HISTORY_TURNS * 2));
        captureFromUserText(ctx, message);
        return send(res, 200, out);
      }

      if (route === 'POST /v1/agent/confirm') {
        const body = await readJson(req);
        if (!body.id) return send(res, 400, { error: 'id obrigatório' });
        return send(res, 200, await resolvePending(ctx, body.id, body.approve !== false));
      }

      if (route === 'GET /v1/memory') {
        if (!isMemoryEnabled()) return send(res, 503, { error: 'memória desativada' });
        return send(res, 200, { scope: ctx.memoryScope, memories: memory.listMemories(ctx, { limit: 100 }) });
      }

      if (route === 'POST /v1/memory') {
        if (!isMemoryEnabled()) return send(res, 503, { error: 'memória desativada' });
        const body = await readJson(req);
        memory.remember(ctx, {
          type: body.type || 'note',
          content: body.content,
          tags: body.tags || [],
          importance: body.importance || 3,
          source: 'api',
        });
        return send(res, 201, { ok: true, scope: ctx.memoryScope });
      }

      const del = url.pathname.match(/^\/v1\/memory\/(\d+)$/);
      if (req.method === 'DELETE' && del) {
        if (!isMemoryEnabled()) return send(res, 503, { error: 'memória desativada' });
        return send(res, 200, { ok: memory.forget(ctx, Number(del[1])) });
      }

      if (route === 'DELETE /v1/memory') {
        if (!isMemoryEnabled()) return send(res, 503, { error: 'memória desativada' });
        return send(res, 200, { removed: memory.forgetAll(ctx) });
      }

      return send(res, 404, { error: 'rota não encontrada' });
    } catch (err) {
      const status = err.status || 500;
      if (status === 500) logger.error(`[API] ${err.stack || err.message}`);
      return send(res, status, { error: status === 500 ? 'erro interno' : err.message });
    }
  });

  server.requestTimeout = 120_000; // respostas de LLM podem demorar
  return server;
}

/** Sobe a API se YUI_API_ENABLED=true. Retorna o server ou null. */
export function startApi() {
  if (String(process.env.YUI_API_ENABLED || 'false').toLowerCase() !== 'true') return null;
  const tokens = parseTokens();
  if (!tokens.length) {
    logger.warn('[API] YUI_API_ENABLED=true mas YUI_API_TOKENS está vazio/inválido (token com 16+ caracteres). API não iniciada.');
    return null;
  }
  const registered = registerBuiltinTools();
  if (registered.length) logger.info(`[Agent] Ferramentas registradas: ${registered.join(', ')}`);
  const host = process.env.YUI_API_HOST || '127.0.0.1';
  const port = parseInt(process.env.YUI_API_PORT || '3939', 10);
  const server = createApiServer({ tokens });
  server.listen(port, host, () => logger.info(`[API] Yui API ouvindo em http://${host}:${port} (${tokens.length} token(s))`));
  server.on('error', (err) => logger.error(`[API] Falha ao iniciar: ${err.message}`));
  return server;
}
