import crypto from 'crypto';
import fs from 'fs';
import http from 'http';
import path from 'path';
import { execFileSync } from 'child_process';
import { audit } from '../audit.js';
import { ROLES } from '../permissions.js';
import { ApprovalError } from './approvalManager.js';
import { ORIGINS } from './permissionMatrix.js';

/**
 * Canal de aprovação crítica LOCAL (Fase 1, especificação §2 / R02).
 *
 * Aprovar uma ação crítica (gravar código, rodar comando) NÃO passa pela API principal (:3939), que pode ser
 * alcançada por proxy, Tailscale ou celular. Existe um canal separado:
 *  - escuta só em 127.0.0.1 (porta própria, padrão 3940);
 *  - exige o segredo efêmero (nonce) gerado quando a Yui sobe. O segredo fica num arquivo com permissão restrita
 *    (0600 no Linux; no Windows só SYSTEM, Administradores e o usuário que roda a Yui). Quem consegue ler o
 *    arquivo está FISICAMENTE no computador, com direito de acesso ao disco; um cliente remoto não consegue;
 *  - recusa pedidos com cabeçalhos de proxy (X-Forwarded-*, Forwarded, Tailscale-*) e Host que não seja o loopback
 *    (defesa contra DNS rebinding);
 *  - trava por 60 s depois de 5 tentativas com segredo errado.
 * Só a origem LOCAL_PC sai daqui. A CLI `scripts/yui-aprovar.mjs` é o cliente.
 */

const ROOT = path.resolve(import.meta.dirname, '..', '..', '..');
const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'x-forwarded-proto', 'x-real-ip', 'forwarded', 'via', 'tailscale-user-login', 'tailscale-user-name', 'tailscale-user-profile-pic'];
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const MAX_BODY = 4096;
const MAX_FAILS = 5;
const LOCK_MS = 60_000;

export function nonceFilePath(env = process.env) {
  const configured = String(env.YUI_APPROVAL_NONCE_FILE ?? '').trim();
  return configured ? path.resolve(configured) : path.join(ROOT, 'secrets', 'approval-channel.json');
}

function ownerId(env) {
  return String(env.YUI_OWNER_ID || env.OWNER_ID || '').split(',')[0].trim() || null;
}

/** Restringe o arquivo do segredo. Devolve true se conseguiu. */
function restrictFile(file) {
  try {
    if (process.platform === 'win32') {
      // Caminho completo do System32: um "whoami"/"icacls" de outro lugar do PATH não pode ser usado aqui.
      const sys32 = path.join(process.env.SystemRoot || 'C:\Windows', 'System32');
      const me = execFileSync(path.join(sys32, 'whoami.exe'), ['/user', '/fo', 'csv', '/nh'], { windowsHide: true, encoding: 'utf8' }).trim().split('","')[1]?.replace(/"/g, '').trim();
      const grants = ['*S-1-5-18:F', '*S-1-5-32-544:F', ...(me && /^S-1-5-[\d-]+$/.test(me) ? [`*${me}:F`] : [])];
      execFileSync(path.join(sys32, 'icacls.exe'), [file, '/inheritance:r', '/grant:r', ...grants], { windowsHide: true, stdio: 'ignore' });
    } else {
      fs.chmodSync(file, 0o600);
    }
    return true;
  } catch {
    return false;
  }
}

const safeEqual = (a, b) => {
  const x = Buffer.from(String(a));
  const y = Buffer.from(String(b));
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * @param {{ manager: object, env?: object, auditFn?: Function, port?: number, now?: () => number }} options
 * @returns {Promise<{ port: number, file: string, restricted: boolean, nonce: string, close: () => Promise<void> }>}
 */
export function startLocalApprovalChannel({ manager, env = process.env, auditFn = audit, port = Number(env.YUI_APPROVAL_PORT ?? 3940), now = () => Date.now() } = {}) {
  const nonce = crypto.randomBytes(32).toString('hex');
  const file = nonceFilePath(env);
  let fails = 0;
  let lockedUntil = 0;
  const owner = ownerId(env);

  const violation = (type, details = {}) => { try { auditFn('policy.violation', null, { violationType: type, attemptedOrigin: 'LOCAL_CHANNEL', ...details }); } catch { /* */ } };

  function send(res, status, body) {
    const text = JSON.stringify(body);
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Length': Buffer.byteLength(text) });
    res.end(text);
  }

  function readJson(req) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const chunks = [];
      req.on('data', (c) => { size += c.length; if (size > MAX_BODY) { reject(new ApprovalError('corpo grande demais', 413)); req.destroy(); } else chunks.push(c); });
      req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch { reject(new ApprovalError('JSON inválido', 400)); } });
      req.on('error', reject);
    });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const addr = String(req.socket.remoteAddress ?? '');
      if (!LOOPBACK.has(addr)) { violation('canal_local_origem_nao_loopback'); return send(res, 403, { error: 'Somente deste computador.' }); }
      if (FORWARD_HEADERS.some((h) => req.headers[h] !== undefined)) { violation('canal_local_cabecalho_de_proxy'); return send(res, 403, { error: 'Pedido encaminhado por proxy não é aceito.' }); }
      const host = String(req.headers.host ?? '').toLowerCase();
      if (!new Set([`127.0.0.1:${server.address().port}`, `localhost:${server.address().port}`, `[::1]:${server.address().port}`]).has(host)) { violation('canal_local_host_invalido'); return send(res, 403, { error: 'Host inválido.' }); }
      if (req.headers.origin !== undefined) { violation('canal_local_origem_de_navegador'); return send(res, 403, { error: 'Navegadores não podem usar este canal.' }); }

      if (now() < lockedUntil) { res.setHeader('Retry-After', String(Math.ceil((lockedUntil - now()) / 1000))); return send(res, 429, { error: 'Muitas tentativas. Aguarde.' }); }
      if (!safeEqual(req.headers['x-yui-local-nonce'] ?? '', nonce)) {
        fails += 1;
        violation('canal_local_segredo_invalido');
        if (fails >= MAX_FAILS) { lockedUntil = now() + LOCK_MS; fails = 0; }
        return send(res, 401, { error: 'Segredo local inválido.' });
      }
      fails = 0;

      const url = new URL(req.url, 'http://x');
      if (req.method === 'GET' && url.pathname === '/v1/local/health') return send(res, 200, { ok: true });
      if (req.method === 'GET' && url.pathname === '/v1/local/pending') return send(res, 200, { approvals: manager.list({ status: 'PENDING' }) });
      if (req.method === 'POST' && url.pathname === '/v1/local/decide') {
        const body = await readJson(req);
        if (typeof body.id !== 'string' || typeof body.approve !== 'boolean') return send(res, 400, { error: 'Informe id e approve (true/false).' });
        const t = manager.decide(body.id, { approve: body.approve, approverId: owner, approverRole: ROLES.OWNER, approverOrigin: ORIGINS.LOCAL_PC });
        return send(res, 200, { ok: true, status: t.status, id: t.id });
      }
      return send(res, 404, { error: 'Rota não encontrada.' });
    } catch (err) {
      if (err instanceof ApprovalError) return send(res, err.status, { error: err.message, code: err.code });
      return send(res, 500, { error: 'Erro interno.' });
    }
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject);
      const actual = server.address().port;
      let restricted = false;
      try {
        fs.mkdirSync(path.dirname(file), { recursive: true });
        fs.writeFileSync(file, JSON.stringify({ port: actual, nonce, pid: process.pid, startedAt: new Date().toISOString() }), { mode: 0o600 });
        restricted = restrictFile(file);
      } catch (err) {
        server.close();
        return reject(err);
      }
      resolve({
        port: actual,
        file,
        restricted,
        nonce,
        close: () => new Promise((done) => { try { fs.rmSync(file, { force: true }); } catch { /* */ } server.close(() => done()); server.closeAllConnections?.(); }),
      });
    });
  });
}
