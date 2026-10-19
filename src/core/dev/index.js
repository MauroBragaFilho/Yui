import crypto from 'crypto';
import path from 'path';
import { isReadOnlyMode } from '../permissions.js';
import { audit } from '../audit.js';
import { createAgent } from './agent.js';
import { buildContext, summarizeWorkspace } from './context.js';
import { createHistoryStore } from './history.js';
import { createIndexer } from './indexer.js';
import { createDevLlm } from './llm.js';
import { getMode, listModes, loadPersona } from './modes.js';
import { createProjects } from './projects.js';
import { runCommand } from './terminal.js';
import { createWebSearch } from './web-search.js';
import { createWorkspaceFs } from './workspace-fs.js';

/**
 * Módulo de código da Yui (as funções do Projeto Jarvis dentro da Yui Core).
 *
 * A Yui lê o projeto, responde, edita arquivos e roda comandos, sempre com a
 * política do dev/policy.js. Regras que valem aqui:
 *  - só o DONO usa; só projetos da lista de permissão (YUI_PROJECTS ou cadastro do app);
 *  - o modo somente leitura da Yui (YUI_READ_ONLY, padrão ligado) bloqueia gravação
 *    e comandos, como em todas as outras ferramentas;
 *  - pedidos que não vêm do próprio computador (celular pelo Tailscale) também são
 *    somente leitura, e aprovações só podem ser dadas no computador;
 *  - o código do projeto vai ao modelo como conteúdo sensível (nunca a provedores anônimos).
 */

export class DevError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'DevError';
    this.status = status;
  }
}

const APPROVAL_TIMEOUT_MS = 5 * 60 * 1000;
const RUN_TTL_MS = 30 * 60 * 1000;
const MAX_EVENTS = 600;
const MAX_MESSAGE = 8000;

export function createDev({
  env = process.env,
  llm = createDevLlm({ env }),
  webSearch = createWebSearch(),
  runCommandImpl = runCommand,
  projects = createProjects({ env }),
  historyDir = path.join(process.env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'dev-history'),
  indexDir = path.join(process.env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'dev-index'),
  now = () => Date.now(),
} = {}) {
  const history = createHistoryStore({ dir: historyDir });
  const persona = loadPersona(env.YUI_ROOT_DIR || process.cwd());
  const agent = createAgent({ llm, webSearch, runCommand: runCommandImpl, persona });
  const workspaces = new Map(); // projectId -> { fs, indexer, summary }
  const runs = new Map();
  let activeRun = null;

  const isEnabled = () => String(env.YUI_DEV_ENABLED ?? 'false').trim().toLowerCase() === 'true';
  const configuredApproval = () => (String(env.YUI_DEV_APPROVAL ?? 'ask').trim().toLowerCase() === 'auto' ? 'auto' : 'ask');

  /** Modo de aprovação efetivo para este pedido. */
  function approvalModeFor({ local }) {
    if (isReadOnlyMode() || !local) return 'readonly';
    return configuredApproval();
  }

  function requireProject(id) {
    const project = projects.get(id);
    if (!project) throw new DevError(404, 'Projeto não encontrado.');
    if (!project.exists) throw new DevError(404, 'A pasta deste projeto não existe mais.');
    return project;
  }

  async function workspaceOf(id) {
    const project = requireProject(id);
    const cached = workspaces.get(project.id);
    if (cached && cached.path === project.path) return cached;
    const wfs = await createWorkspaceFs(project.path);
    const indexer = createIndexer({ workspaceFs: wfs, cacheFile: path.join(indexDir, `${project.id}.json`) });
    const entry = { path: project.path, fs: wfs, indexer, summary: await summarizeWorkspace(wfs) };
    workspaces.set(project.id, entry);
    indexer.refresh().catch(() => {});
    return entry;
  }

  function status({ local }) {
    const readOnly = isReadOnlyMode();
    return {
      enabled: isEnabled(),
      coreReadOnly: readOnly,
      local: Boolean(local),
      canWrite: isEnabled() && !readOnly && Boolean(local),
      approval: approvalModeFor({ local }),
      projects: projects.list().map(({ id, name, source, exists }) => ({ id, name, source, exists })),
      modes: listModes(),
    };
  }

  // ───────── arquivos do projeto (leitura) ─────────
  async function tree(projectId, rel = '') {
    return (await workspaceOf(projectId)).fs.listDir(rel);
  }

  async function readFile(projectId, rel) {
    return (await workspaceOf(projectId)).fs.readFile(rel);
  }

  // ───────── execuções ─────────
  const pushEvent = (run, event) => {
    run.seq += 1;
    run.events.push({ seq: run.seq, ...event });
    if (run.events.length > MAX_EVENTS) run.events.splice(0, run.events.length - MAX_EVENTS);
  };

  function prune() {
    const t = now();
    for (const [id, run] of runs) if (run.status !== 'running' && t - run.finishedAt > RUN_TTL_MS) runs.delete(id);
  }

  /**
   * Inicia uma conversa de código e devolve o id da execução na hora; o trabalho
   * segue em segundo plano e o app acompanha pelos eventos (getEvents).
   */
  async function startRun({ projectId, message, modeId = 'yui', activeFile = null, local = false, ctx = null }) {
    if (!isEnabled()) throw new DevError(503, 'O módulo de código está desligado (YUI_DEV_ENABLED=true no .env).');
    const text = String(message ?? '').trim();
    if (!text) throw new DevError(400, 'Mensagem vazia.');
    if (text.length > MAX_MESSAGE) throw new DevError(400, `A mensagem passa de ${MAX_MESSAGE} caracteres.`);
    if (activeRun && activeRun.status === 'running') throw new DevError(409, 'A Yui ainda está trabalhando em outro pedido. Aguarde ou cancele.');
    const project = requireProject(projectId);
    const workspace = await workspaceOf(project.id);
    prune();

    const approvalMode = approvalModeFor({ local });
    const run = {
      id: crypto.randomUUID(),
      projectId: project.id,
      status: 'running',
      seq: 0,
      events: [],
      pending: new Map(),
      controller: new AbortController(),
      startedAt: now(),
      finishedAt: 0,
      approvalMode,
      local: Boolean(local),
    };
    runs.set(run.id, run);
    activeRun = run;
    audit('dev.run.start', ctx, { project: project.id, mode: modeId, chars: text.length, approval: approvalMode });

    const requestApproval = (request) => new Promise((resolve) => {
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        if (run.pending.delete(id)) {
          pushEvent(run, { type: 'approval_done', id, approved: false, reason: 'expirou' });
          resolve(false);
        }
      }, APPROVAL_TIMEOUT_MS);
      run.pending.set(id, (approved) => {
        clearTimeout(timer);
        run.pending.delete(id);
        pushEvent(run, { type: 'approval_done', id, approved: Boolean(approved) });
        audit('dev.approval', ctx, { project: project.id, action: request.action, approved: Boolean(approved) });
        resolve(Boolean(approved));
      });
      pushEvent(run, { type: 'approval', id, action: request.action, summary: request.summary, preview: request.preview });
    });

    const emit = (event) => {
      pushEvent(run, event);
      if (event.type === 'tool' && event.status && !['waiting', 'running'].includes(event.status)) {
        audit('dev.tool', ctx, { project: project.id, action: event.action, status: event.status });
      }
    };

    (async () => {
      try {
        const past = await history.load(project.id);
        const context = (await buildContext({ workspaceFs: workspace.fs, indexer: workspace.indexer, query: text, activeFile, budget: 6000 })).text;
        const result = await agent.run({
          message: text,
          history: past,
          workspace,
          context,
          modeId,
          approvalMode,
          webSearchEnabled: false,
          emit,
          requestApproval,
          signal: run.controller.signal,
          settings: { maxIterations: Number(env.YUI_DEV_MAX_STEPS) || 12, temperature: 0.3, maxTokens: 4096, historyChars: 24000 },
        });
        if (result.cancelled) {
          run.status = 'cancelled';
          pushEvent(run, { type: 'done', ok: true, cancelled: true, changed: result.changed });
        } else {
          await history.save(project.id, [...past, { role: 'user', content: text, at: now() }, { role: 'assistant', content: result.text, at: now() }]);
          if (result.changed.length) workspace.indexer.refresh().catch(() => {});
          run.status = 'done';
          pushEvent(run, { type: 'done', ok: true, changed: result.changed, limitReached: Boolean(result.limitReached) });
        }
      } catch (err) {
        run.status = run.controller.signal.aborted ? 'cancelled' : 'error';
        pushEvent(run, { type: 'done', ok: false, error: String(err?.message ?? err).slice(0, 600), cancelled: run.controller.signal.aborted });
      } finally {
        for (const resolve of [...run.pending.values()]) resolve(false);
        run.finishedAt = now();
        if (activeRun === run) activeRun = null;
      }
    })();

    return { runId: run.id, approval: approvalMode };
  }

  function getRun(runId) {
    const run = runs.get(String(runId));
    if (!run) throw new DevError(404, 'Execução não encontrada (ou já expirou).');
    return run;
  }

  /** Eventos novos desde `after` (número de sequência). */
  function getEvents(runId, after = 0) {
    const run = getRun(runId);
    const from = Number(after) || 0;
    return { status: run.status, last: run.seq, approval: run.approvalMode, events: run.events.filter((e) => e.seq > from) };
  }

  function answerApproval(runId, approvalId, approve, { local = false, ctx = null } = {}) {
    if (!local) throw new DevError(403, 'Aprovações só podem ser dadas no computador da Yui.');
    const run = getRun(runId);
    const resolve = run.pending.get(String(approvalId));
    if (!resolve) throw new DevError(404, 'Esse pedido de aprovação não existe mais.');
    resolve(Boolean(approve));
    void ctx;
    return { ok: true };
  }

  function cancel(runId) {
    const run = getRun(runId);
    if (run.status !== 'running') return { ok: true, already: true };
    run.controller.abort(new Error('cancelado'));
    for (const resolve of [...run.pending.values()]) resolve(false);
    return { ok: true };
  }

  return {
    isEnabled,
    status,
    projects,
    tree,
    readFile,
    history: {
      load: (projectId) => history.load(requireProject(projectId).id),
      clear: (projectId) => history.clear(requireProject(projectId).id),
    },
    startRun,
    getEvents,
    answerApproval,
    cancel,
    modes: listModes,
    getMode,
    isBusy: () => Boolean(activeRun && activeRun.status === 'running'),
  };
}
