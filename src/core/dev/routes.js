import { audit } from '../audit.js';
import { DevError } from './index.js';
import { ProjectError } from './projects.js';
import { WorkspaceError } from './workspace-fs.js';

/**
 * Rotas /v1/dev/* (só o DONO).
 *
 *   GET    /v1/dev/status                              estado, projetos e modos
 *   POST   /v1/dev/projects          { name, path }    cadastra projeto (só no computador da Yui)
 *   DELETE /v1/dev/projects/:id                        remove projeto cadastrado pelo app
 *   GET    /v1/dev/projects/:id/tree?path=             lista uma pasta
 *   GET    /v1/dev/projects/:id/file?path=             lê um arquivo
 *   GET    /v1/dev/projects/:id/history                conversa guardada
 *   DELETE /v1/dev/projects/:id/history                apaga a conversa
 *   POST   /v1/dev/projects/:id/runs { message, mode, activeFile }   inicia (devolve runId)
 *   GET    /v1/dev/runs/:runId/events?after=N          eventos novos
 *   POST   /v1/dev/runs/:runId/approvals/:aid { approve }   aprova/nega (só no computador)
 *   POST   /v1/dev/runs/:runId/cancel
 */

const FORWARD_HEADERS = ['x-forwarded-for', 'x-forwarded-host', 'forwarded', 'tailscale-user-login', 'tailscale-user-name'];

/**
 * O pedido veio do próprio computador? Conexão de loopback SEM cabeçalhos de proxy.
 * (O `tailscale serve` entrega pedidos do celular em 127.0.0.1, mas com X-Forwarded-For
 * e Tailscale-User-*: esses contam como remotos.)
 */
export function isLocalRequest(req) {
  const addr = String(req.socket?.remoteAddress ?? '');
  const loopback = addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1';
  return loopback && !FORWARD_HEADERS.some((h) => req.headers?.[h] !== undefined);
}

const wrapError = (err) => {
  if (err instanceof DevError || err instanceof ProjectError) return { __status: err.status, error: err.message };
  if (err instanceof WorkspaceError) return { __status: err.code === 'NAO_EXISTE' ? 404 : 400, error: err.message };
  throw err;
};

/**
 * @param {object} dev   instância de createDev()
 * @returns {(req, url, ctx, readJson) => Promise<object|undefined>} undefined = não é rota /v1/dev
 */
export function createDevRoutes(dev) {
  return async function devRoute(req, url, ctx, readJson) {
    const p = url.pathname;
    if (!p.startsWith('/v1/dev/')) return undefined;
    if (ctx.role !== 'OWNER') return { __status: 403, error: 'Apenas o dono pode usar o módulo de código.' };
    const m = req.method;
    const local = isLocalRequest(req);
    let r;

    try {
      if (m === 'GET' && p === '/v1/dev/status') return dev.status({ local });
      if (!dev.isEnabled()) return { __status: 503, error: 'O módulo de código está desligado (YUI_DEV_ENABLED=true no .env).' };

      if (m === 'POST' && p === '/v1/dev/projects') {
        if (!local) return { __status: 403, error: 'Cadastrar projetos só é possível no computador da Yui.' };
        const body = await readJson(req);
        const project = dev.projects.add({ name: body.name, path: body.path });
        audit('dev.project.add', ctx, { project: project.id });
        return { ok: true, project: { id: project.id, name: project.name, source: project.source } };
      }
      if ((r = p.match(/^\/v1\/dev\/projects\/([^/]+)$/)) && m === 'DELETE') {
        if (!local) return { __status: 403, error: 'Remover projetos só é possível no computador da Yui.' };
        dev.projects.remove(decodeURIComponent(r[1]));
        audit('dev.project.remove', ctx, { project: decodeURIComponent(r[1]) });
        return { ok: true };
      }
      if ((r = p.match(/^\/v1\/dev\/projects\/([^/]+)\/tree$/)) && m === 'GET') {
        return { items: await dev.tree(decodeURIComponent(r[1]), url.searchParams.get('path') || '') };
      }
      if ((r = p.match(/^\/v1\/dev\/projects\/([^/]+)\/file$/)) && m === 'GET') {
        const file = await dev.readFile(decodeURIComponent(r[1]), url.searchParams.get('path') || '');
        return { file };
      }
      if ((r = p.match(/^\/v1\/dev\/projects\/([^/]+)\/history$/))) {
        if (m === 'GET') return { messages: await dev.history.load(decodeURIComponent(r[1])) };
        if (m === 'DELETE') {
          await dev.history.clear(decodeURIComponent(r[1]));
          return { ok: true };
        }
      }
      if ((r = p.match(/^\/v1\/dev\/projects\/([^/]+)\/runs$/)) && m === 'POST') {
        const body = await readJson(req);
        return dev.startRun({
          projectId: decodeURIComponent(r[1]),
          message: body.message,
          modeId: typeof body.mode === 'string' ? body.mode : 'yui',
          activeFile: typeof body.activeFile === 'string' && body.activeFile ? body.activeFile : null,
          local,
          ctx,
        });
      }
      if ((r = p.match(/^\/v1\/dev\/runs\/([\w-]+)\/events$/)) && m === 'GET') {
        return dev.getEvents(r[1], url.searchParams.get('after') || 0);
      }
      if ((r = p.match(/^\/v1\/dev\/runs\/([\w-]+)\/approvals\/([\w-]+)$/)) && m === 'POST') {
        const body = await readJson(req);
        return dev.answerApproval(r[1], r[2], body.approve === true, { local, ctx });
      }
      if ((r = p.match(/^\/v1\/dev\/runs\/([\w-]+)\/cancel$/)) && m === 'POST') return dev.cancel(r[1]);
    } catch (err) {
      return wrapError(err);
    }
    return { __notFound: true };
  };
}
