import http from 'http';
import crypto from 'crypto';
import { alertOwner } from '../alerts.js';
import { buildContext, isReadOnlyMode } from '../permissions.js';
import * as memory from '../memory/store.js';
import * as ai from '../ai/manager.js';
import { buildMemoryBlock, captureFromUserText, isMemoryEnabled } from '../discordAdapter.js';
import { audit } from '../audit.js';
import { runAgent, resolvePending } from '../agent/agent.js';
import { registerBuiltinTools } from '../agent/tools.js';
import { logger } from '../../utils/logger.js';
import { loadPanelCredentials, createSessionStore, createLoginLimiter, createPairing, ownerUserId } from './auth.js';
import { createAdmin } from './admin.js';
import { createDev } from '../dev/index.js';
import { createDevRoutes } from '../dev/routes.js';

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
// Dois baldes por usuário: rotas de IA (custam tokens) e todo o resto (painel, memória, status).
const RATE_LIMIT = { windowMs: 60_000, ai: 30, other: 240 };
const AI_ROUTES = new Set(['POST /v1/chat', 'POST /v1/agent', 'POST /v1/agent/confirm']);
const isDevRunStart = (route) => /^POST \/v1\/dev\/projects\/[^/]+\/runs$/.test(route);
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

function bearerOf(req) {
  const m = (req.headers.authorization || '').match(/^Bearer\s+(.+)$/i);
  return m ? m[1].trim() : null;
}

/** Aceita token estático (YUI_API_TOKENS) ou sessão de login (usuário/senha). */
function authenticate(req, tokens, sessions) {
  const bearer = bearerOf(req);
  if (!bearer) return null;
  const given = sha(bearer);
  let found = null;
  for (const t of tokens) {
    // percorre todos para não vazar, pelo tempo, qual token existe
    if (crypto.timingSafeEqual(given, t.hash)) found = { userId: t.userId, via: 'token' };
  }
  if (found) return found;
  const s = sessions?.get(bearer);
  return s ? { userId: s.userId, via: 'session' } : null;
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
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
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
    // Cliente que desistiu no meio do envio: não é erro nosso (nada de log de erro com pilha).
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

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {object} [options]
 * @param {Array}  [options.tokens]       tokens estáticos (YUI_API_TOKENS)
 * @param {Set}    [options.corsOrigins]  origens web permitidas
 * @param {object} [options.panel]        credenciais do painel (loadPanelCredentials)
 * @param {object} [options.sessions]     armazenamento de sessões
 * @param {object} [options.limiter]      limite de tentativas de login
 * @param {object} [options.admin]        funções de administração (createAdmin)
 * @param {object} [options.dev]          módulo de código (createDev); rotas /v1/dev/*
 * @param {number} [options.loginDelayMs] atraso após uma falha de login (reduz força bruta)
 * @param {Function} [options.notify]     envia uma mensagem privada: (userId, texto) => Promise. Liga a "chave por DM".
 * @param {object} [options.pairing]      chave de uso único (createPairing)
 * @param {string} [options.ownerId]      para quem a chave é enviada (o dono)
 */
export function createApiServer({
  tokens = parseTokens(),
  corsOrigins = parseCorsOrigins(),
  panel = loadPanelCredentials(),
  sessions = createSessionStore(),
  limiter = createLoginLimiter(),
  admin = createAdmin(),
  dev = createDev(),
  loginDelayMs = 400,
  notify = null,
  pairing = createPairing(),
  requestLimiter = createLoginLimiter({ max: 3, windowMs: 10 * 60 * 1000 }), // pedidos de chave (evita encher a DM)
  codeLimiter = createLoginLimiter({ max: 5, windowMs: 15 * 60 * 1000 }),    // chaves erradas
  ownerId = ownerUserId(),
} = {}) {
  const discordKeyEnabled = Boolean(notify && ownerId);
  const hits = new Map();       // userId -> [timestamps]
  const histories = new Map();  // userId -> [{role, content}]

  const devRoute = createDevRoutes(dev);
  let dmHits = []; // mensagens ao Discord pedidas pelo painel (limite de 5 a cada 10 min)

  /** Rotas /v1/admin/* (só o dono). Retorna undefined se a rota não for de admin. */
  async function adminRoute(req, url, ctx) {
    const p = url.pathname;
    if (!p.startsWith('/v1/admin/')) return undefined;
    const m = req.method;
    let r;

    if (m === 'GET' && p === '/v1/admin/overview') return admin.overview(ctx);
    if (m === 'GET' && p === '/v1/admin/guilds') return { guilds: await admin.guilds(ctx) };
    if (m === 'GET' && p === '/v1/admin/bans') return admin.bans(ctx);
    if (m === 'GET' && p === '/v1/admin/memory/users') return admin.memoryUsers(ctx);
    if (m === 'GET' && p === '/v1/admin/audit') return admin.audit(ctx, url.searchParams.get('limit'));
    if (m === 'GET' && p === '/v1/admin/tools') return admin.tools(ctx);
    if (m === 'GET' && p === '/v1/admin/gateway') return admin.gateway(ctx);
    if (m === 'GET' && p === '/v1/admin/integrations') return admin.integrations(ctx);
    if ((r = p.match(/^\/v1\/admin\/guilds\/(\d+)$/)) && m === 'GET') return admin.guildDetail(ctx, r[1]);
    if (m === 'GET' && p === '/v1/admin/radio') return admin.radio(ctx);
    if ((r = p.match(/^\/v1\/admin\/radio\/(\d+)$/)) && m === 'POST') {
      const body = await readJson(req);
      return admin.radioAction(ctx, r[1], body.action);
    }
    if (m === 'GET' && p === '/v1/admin/logs') {
      const sp = url.searchParams;
      return admin.logs(ctx, { kind: sp.get('kind'), date: sp.get('date'), level: sp.get('level'), q: sp.get('q'), limit: sp.get('limit') });
    }
    if ((r = p.match(/^\/v1\/admin\/guilds\/(\d+)\/channels$/)) && m === 'PUT') {
      const body = await readJson(req);
      return admin.setGuildChannel(ctx, r[1], body.type, body.channelId ?? null);
    }
    if ((r = p.match(/^\/v1\/admin\/guilds\/(\d+)\/youtube$/)) && m === 'POST') return admin.addYoutubeFollow(ctx, r[1], await readJson(req));
    if ((r = p.match(/^\/v1\/admin\/guilds\/(\d+)\/youtube\/([\w-]+)\/(\d+)$/)) && m === 'DELETE') return admin.removeYoutubeFollow(ctx, r[1], r[2], r[3]);
    if ((r = p.match(/^\/v1\/admin\/guilds\/(\d+)\/twitch$/)) && m === 'POST') return admin.addTwitchFollow(ctx, r[1], await readJson(req));
    if ((r = p.match(/^\/v1\/admin\/guilds\/(\d+)\/twitch\/(\w+)\/(\d+)$/)) && m === 'DELETE') return admin.removeTwitchFollow(ctx, r[1], r[2], r[3]);

    if (m === 'GET' && p === '/v1/admin/ai') return admin.ai(ctx);
    if (m === 'POST' && p === '/v1/admin/ai/keys') {
      const body = await readJson(req);
      return admin.aiAddKey(ctx, body.provider, body.key);
    }
    if ((r = p.match(/^\/v1\/admin\/ai\/keys\/([a-z0-9-]+)\/(\d+)$/)) && m === 'DELETE') return admin.aiRemoveKey(ctx, r[1], r[2]);
    if (m === 'PUT' && p === '/v1/admin/ai/cloudflare') {
      const body = await readJson(req);
      return admin.aiCloudflare(ctx, body.accountId);
    }
    if ((r = p.match(/^\/v1\/admin\/ai\/providers\/([a-z0-9-]+)$/)) && m === 'POST') {
      const body = await readJson(req);
      return admin.aiSetEnabled(ctx, r[1], body.enabled);
    }
    if (m === 'POST' && p === '/v1/admin/ai/custom') return admin.aiAddCustom(ctx, await readJson(req));
    if ((r = p.match(/^\/v1\/admin\/ai\/custom\/([a-z0-9-]+)\/keys$/)) && m === 'POST') {
      const body = await readJson(req);
      return admin.aiAddCustomKey(ctx, r[1], body.key);
    }
    if ((r = p.match(/^\/v1\/admin\/ai\/custom\/([a-z0-9-]+)\/options$/)) && m === 'POST') return admin.aiCustomOptions(ctx, r[1], await readJson(req));
    if ((r = p.match(/^\/v1\/admin\/ai\/custom\/([a-z0-9-]+)$/)) && m === 'DELETE') return admin.aiRemoveCustom(ctx, r[1]);
    if ((r = p.match(/^\/v1\/admin\/ai\/test\/([a-z0-9-]+)$/)) && m === 'POST') return admin.aiTest(ctx, r[1]);
    if (m === 'POST' && p === '/v1/admin/gateway/reset') return admin.gatewayReset(ctx);

    if ((r = p.match(/^\/v1\/admin\/guilds\/(\d+)\/automod$/)) && m === 'POST') {
      const body = await readJson(req);
      return admin.setAutomod(ctx, r[1], body.mode);
    }
    if (m === 'POST' && p === '/v1/admin/bans') {
      const body = await readJson(req);
      return admin.addBan(ctx, body.type, body.id, body.reason);
    }
    if ((r = p.match(/^\/v1\/admin\/bans\/(user|guild|channel)\/(\d+)$/)) && m === 'DELETE') {
      return admin.removeBan(ctx, r[1], r[2]);
    }
    if ((r = p.match(/^\/v1\/admin\/memory\/users\/(\d+)$/))) {
      if (m === 'GET') return admin.memoryInspect(ctx, r[1]);
      if (m === 'DELETE') return admin.memoryForgetUser(ctx, r[1]);
    }
    if ((r = p.match(/^\/v1\/admin\/memory\/users\/(\d+)\/(\d+)$/)) && m === 'DELETE') {
      return admin.memoryForget(ctx, r[1], r[2]);
    }
    if (m === 'POST' && p === '/v1/admin/restart') {
      const body = await readJson(req);
      return admin.restart(ctx, body.confirm === true);
    }
    if (m === 'POST' && p === '/v1/admin/discord/dm') {
      if (ctx.role !== 'OWNER') return { __status: 403, error: 'Apenas o dono pode usar o painel de administração.' };
      if (!notify || !ownerId) return { __status: 503, error: 'A Yui não está conectada ao Discord para enviar mensagens.' };
      const body = await readJson(req);
      const text = String(body.message ?? '').trim().slice(0, 1500) || 'Teste: esta mensagem foi pedida pelo painel da Yui.';
      const now = Date.now();
      dmHits = dmHits.filter((t) => now - t < 10 * 60 * 1000);
      if (dmHits.length >= 5) return { __status: 429, error: 'Limite de 5 mensagens a cada 10 minutos. Tente mais tarde.' };
      dmHits.push(now);
      try {
        await notify(ownerId, `📣 **Mensagem do painel da Yui**\n\n${text}`);
      } catch (err) {
        audit('admin.discord.dm.fail', ctx, { error: String(err?.message || err).slice(0, 120) });
        return { __status: 502, error: 'Não consegui enviar. Confira se a Yui pode te mandar DM (privacidade do Discord).' };
      }
      audit('admin.discord.dm', ctx, { length: text.length });
      return { ok: true };
    }
    return { __notFound: true };
  }

  function rateLimited(userId, bucket) {
    const now = Date.now();
    const key = `${userId}:${bucket}`;
    const list = (hits.get(key) || []).filter((t) => now - t < RATE_LIMIT.windowMs);
    list.push(now);
    hits.set(key, list);
    return list.length > RATE_LIMIT[bucket];
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

      // ── Login por usuário e senha (públicas) ──
      if (route === 'GET /v1/auth/status') {
        return send(res, 200, { passwordLogin: panel.enabled, discordKey: discordKeyEnabled });
      }

      // ── Chave de uso único enviada por DM no Discord (só para o dono) ──
      if (route === 'POST /v1/auth/discord/request') {
        if (!discordKeyEnabled) return send(res, 503, { error: 'O envio de chave pelo Discord não está disponível neste servidor.' });
        const wait = requestLimiter.lockedForSeconds();
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          return send(res, 429, { error: `Muitos pedidos de chave. Tente de novo em ${Math.ceil(wait / 60)} min.`, retryAfter: wait });
        }
        requestLimiter.fail(); // todo pedido conta, mesmo os que dão certo
        const issued = pairing.issue();
        const minutes = Math.max(1, Math.round(issued.expiresInSeconds / 60));
        const text = [
          '🔐 **Chave de acesso da Yui**',
          '',
          `\`${issued.code}\``,
          '',
          `Digite no app para entrar. Vale por **${minutes} minutos** e só pode ser usada **uma vez**.`,
          'Se não foi você que pediu, ignore esta mensagem: sem a chave ninguém entra.',
        ].join('\n');
        try {
          await notify(ownerId, text);
        } catch (err) {
          pairing.revoke(); // não deixa uma chave que o dono nunca recebeu
          audit('auth.discord.request.fail', null, { error: String(err?.message || err).slice(0, 120) });
          return send(res, 502, { error: 'Não consegui enviar a mensagem no Discord. Confira se a Yui pode te mandar DM.' });
        }
        audit('auth.discord.request', null, {});
        // A chave NUNCA volta na resposta: só chega pelo Discord.
        return send(res, 200, { ok: true, expiresInSeconds: issued.expiresInSeconds });
      }

      if (route === 'POST /v1/auth/discord/verify') {
        if (!discordKeyEnabled) return send(res, 503, { error: 'O envio de chave pelo Discord não está disponível neste servidor.' });
        const wait = codeLimiter.lockedForSeconds();
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          return send(res, 429, { error: `Muitas tentativas. Tente de novo em ${Math.ceil(wait / 60)} min.`, retryAfter: wait });
        }
        const body = await readJson(req);
        if (!pairing.verify(String(body.code ?? '').slice(0, 64))) {
          codeLimiter.fail();
          if (codeLimiter.lockedForSeconds() > 0) alertOwner('lock-key', 'Chaves por DM bloqueadas', 'Muitas chaves erradas seguidas. A verificação ficou travada por 15 minutos. Se não foi você, fique atento.', { level: 'error' });
          audit('auth.discord.verify.fail', null, { failures: codeLimiter.count() });
          await sleep(loginDelayMs);
          return send(res, 401, { error: 'Chave inválida ou expirada. Peça outra.' });
        }
        codeLimiter.reset();
        const sess = sessions.create(ownerId);
        audit('auth.discord.verify.ok', { userId: ownerId, platform: 'api' }, {});
        return send(res, 200, { token: sess.token, expiresAt: sess.expiresAt, userId: ownerId });
      }

      if (route === 'POST /v1/auth/login') {
        if (!panel.enabled) return send(res, 503, { error: 'Login por senha não está configurado neste servidor.' });
        const wait = limiter.lockedForSeconds();
        if (wait > 0) {
          res.setHeader('Retry-After', String(wait));
          return send(res, 429, { error: `Muitas tentativas. Tente de novo em ${Math.ceil(wait / 60)} min.`, retryAfter: wait });
        }
        const body = await readJson(req);
        const user = String(body.user ?? '').slice(0, 200);
        const password = String(body.password ?? '').slice(0, 200);
        if (!panel.check(user, password)) {
          limiter.fail();
          audit('auth.login.fail', null, { failures: limiter.count() });
          if (limiter.lockedForSeconds() > 0) alertOwner('lock-login', 'Login do painel bloqueado', 'Houve várias tentativas de senha erradas seguidas. O login ficou travado por 15 minutos. Se não foi você, vale trocar a senha.', { level: 'error' });
          await sleep(loginDelayMs);
          return send(res, 401, { error: 'Usuário ou senha inválidos.' });
        }
        limiter.reset();
        const s = sessions.create(panel.userId);
        audit('auth.login.ok', { userId: panel.userId, platform: 'api' }, {});
        return send(res, 200, { token: s.token, expiresAt: s.expiresAt, userId: panel.userId });
      }

      const session = authenticate(req, tokens, sessions);
      if (!session) return send(res, 401, { error: 'não autorizado' });
      if (rateLimited(session.userId, AI_ROUTES.has(route) || isDevRunStart(route) ? 'ai' : 'other')) return send(res, 429, { error: 'muitas requisições' });

      const ctx = buildContext({ platform: 'api', userId: session.userId, isDM: true });
      if (ctx.role === 'BLOCKED') return send(res, 403, { error: 'acesso negado' });

      if (route === 'POST /v1/auth/logout') {
        const revoked = session.via === 'session' ? sessions.revoke(bearerOf(req)) : false;
        audit('auth.logout', ctx, { revoked });
        return send(res, 200, { ok: true, revoked });
      }

      if (route === 'GET /v1/me') {
        return send(res, 200, { userId: ctx.userId, role: ctx.role, memoryScope: ctx.memoryScope, auth: session.via });
      }

      // ── Painel de administração (só o dono) ──
      const adminResult = await adminRoute(req, url, ctx);
      if (adminResult !== undefined) {
        if (adminResult && adminResult.__notFound) return send(res, 404, { error: 'rota não encontrada' });
        if (adminResult && adminResult.__status) return send(res, adminResult.__status, { error: adminResult.error });
        return send(res, 200, adminResult);
      }

      // ── Módulo de código (só o dono; as funções do Jarvis dentro da Yui) ──
      const devResult = await devRoute(req, url, ctx, readJson);
      if (devResult !== undefined) {
        if (devResult && devResult.__notFound) return send(res, 404, { error: 'rota não encontrada' });
        if (devResult && devResult.__status) return send(res, devResult.__status, { error: devResult.error });
        return send(res, 200, devResult);
      }

      if (route === 'POST /v1/chat') {
        const body = await readJson(req);
        const message = String(body.message ?? '').trim();
        if (!message) return send(res, 400, { error: 'message obrigatória' });
        if (message.length > MAX_MESSAGE) return send(res, 400, { error: `message excede ${MAX_MESSAGE} caracteres` });

        const history = histories.get(ctx.userId) || [];
        const memoryBlock = buildMemoryBlock(ctx, message);
        // Pesquisa na web do app (mesmo agente da fila; o app é conversa PRIVADA e vale o YUI_PRIVATE_SEARCH): ver chatTurn no AI Manager.
        const turn = await ai.chatTurn({ prompt: message, history: [...history], ctx, memoryBlock, text: message });
        const reply = turn.text;

        // Resposta de pesquisa vai ao histórico em RAM como uma linha neutra (nunca o texto derivado da web).
        history.push({ role: 'user', content: message.slice(0, 500) }, { role: 'assistant', content: String(turn.historyLine ?? reply).slice(0, 800) });
        histories.set(ctx.userId, history.slice(-MAX_HISTORY_TURNS * 2));
        captureFromUserText(ctx, message);
        audit('api.chat', ctx, { chars: message.length, ...(turn.researched ? { research: turn.kind } : {}) });
        return send(res, 200, { reply, memoryScope: ctx.memoryScope });
      }

      if (route === 'POST /v1/agent') {
        const body = await readJson(req);
        const message = String(body.message ?? '').trim();
        if (!message) return send(res, 400, { error: 'message obrigatória' });
        if (message.length > MAX_MESSAGE) return send(res, 400, { error: `message excede ${MAX_MESSAGE} caracteres` });

        const history = histories.get(ctx.userId) || [];
        const memoryBlock = buildMemoryBlock(ctx, message);
        // É esta a rota que o app usa. Pesquisa na web (mesmo agente da fila, conversa PRIVADA): a pré-rota responde sem consultar o agente de
        // ferramentas; uma resposta de conversa que só PROMETE pesquisar passa pela guarda de promessa. Ação de ferramenta nunca é mexida.
        let out;
        let historyLine = null;
        const routed = await ai.appResearchRoute({ ctx, text: message });
        if (routed.handled) {
          out = { type: 'reply', reply: routed.text };
          historyLine = routed.historyLine;
        } else {
          out = await runAgent(ctx, message, { history: [...history], memoryBlock });
          if (out?.type === 'reply') {
            const reviewed = await ai.appReviewReply({ ctx, text: message, reply: out.reply, history: [...history], memoryBlock });
            out = { ...out, reply: reviewed.text };
            historyLine = reviewed.historyLine;
          }
        }

        history.push({ role: 'user', content: message.slice(0, 500) }, { role: 'assistant', content: String(historyLine ?? out.reply).slice(0, 800) });
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
      if (err?.aborted) return; // o cliente fechou a conexão no meio do envio: não há a quem responder
      // Cliente que não reaproveita a conexão (HTTP/1.0 ou "Connection: close"): o servidor fecha o socket
      // logo depois da resposta, e fechar com o corpo ainda a caminho vira ECONNRESET. Então esse cliente só
      // recebe a resposta depois que o corpo foi descartado; com keep-alive a resposta sai já.
      if (err?.bodyDrained && !res.shouldKeepAlive) await err.bodyDrained;
      const status = err.status || 500;
      if (status === 500) logger.error(`[API] ${err.stack || err.message}`);
      return send(res, status, { error: status === 500 ? 'erro interno' : err.message });
    }
  });

  server.requestTimeout = 120_000; // respostas de LLM podem demorar
  return server;
}

/** Sobe a API se YUI_API_ENABLED=true. Retorna o server ou null. */
export function startApi(client = null, overrides = {}) {
  if (String(process.env.YUI_API_ENABLED || 'false').toLowerCase() !== 'true') return null;
  const tokens = parseTokens();
  const panel = loadPanelCredentials();
  if (!tokens.length && !panel.enabled) {
    logger.warn('[API] YUI_API_ENABLED=true mas não há acesso configurado: defina YUI_API_TOKENS (token com 16+ caracteres) e/ou o login do painel (YUI_PANEL_USER + YUI_PANEL_PASSWORD_HASH).');
    return null;
  }
  if (!panel.enabled && panel.reasons.length) {
    logger.warn(`[API] Login do painel NÃO ativado: ${panel.reasons.join('; ')}.`);
  }
  for (const w of panel.warnings) logger.warn(`[API] ${w}`);

  const registered = registerBuiltinTools();
  if (registered.length) logger.info(`[Agent] Ferramentas registradas: ${registered.join(', ')}`);

  const host = process.env.YUI_API_HOST || '127.0.0.1';
  const port = parseInt(process.env.YUI_API_PORT || '3939', 10);
  if (panel.enabled && !['127.0.0.1', '::1', 'localhost'].includes(host)) {
    logger.warn(`[API] O login por senha está ativo e a API escuta em ${host} (sem HTTPS próprio). Use HTTPS (tailscale serve) para a senha não trafegar em texto.`);
  }

  const hours = Number(process.env.YUI_PANEL_SESSION_HOURS) > 0 ? Number(process.env.YUI_PANEL_SESSION_HOURS) : 12;
  const server = createApiServer({
    tokens,
    panel,
    sessions: createSessionStore({ ttlMs: hours * 60 * 60 * 1000 }),
    admin: overrides.admin ?? createAdmin({ client }),
    dev: overrides.dev ?? createDev(),
    // Chave por DM: usa o próprio bot do Discord para falar com o dono em privado (fora de qualquer servidor).
    notify: overrides.notify ?? (client ? async (userId, text) => (await client.users.fetch(userId)).send(text) : null),
  });
  server.listen(port, host, () =>
    logger.info(`[API] Yui API ouvindo em http://${host}:${port} (${tokens.length} token(s); login por senha ${panel.enabled ? 'ATIVO' : 'desativado'})`)
  );
  server.on('error', (err) => logger.error(`[API] Falha ao iniciar: ${err.message}`));
  return server;
}
