// Métodos que o YuiCerebro atende pelo canal local (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §4): cérebro <- bot.
//
//  - memory.*: o cérebro é o dono dos bancos de memória. O contexto chega só com os dados de ORIGEM e é MONTADO DE NOVO aqui
//    (buildContext): papel, tipo de canal e escopo da memória saem das regras do cérebro, nunca do que o bot mandou.
//  - context.forgetUser / context.forgetGuild: o direito de exclusão do contexto por horas (os arquivos memory-context* são do
//    cérebro). A leitura e a gravação das falas são da conversa (chat.turn e chat.commit, etapa 5): ver src/cerebro/conversa.js.
//  - reminders.route / reminders.list: os lembretes são do cérebro (lembretes.json); o pedido por conversa no Discord
//    ("me lembra amanhã às 9h de ...") é interpretado e gravado aqui.
//  - research.run: o adaptador de pesquisa do Core (src/core/ai/research.js), com as vagas simultâneas do manager.
//  - health: a situação do cérebro (bancos, travas, canal).
// Todo pedido COM EFEITO passa pelo motor de políticas (policyEngine.gate) com a origem do contexto (Discord DM ou servidor)
// e o papel do canal no alvo; em `observe` (o padrão) só registra, em `enforce` DENY e CRITICAL recusam (ASK segue: o fluxo do
// Discord já confirma, como no discordGuard). Os parâmetros nunca vão para o log.
import { buildContext, isOwnerId, POLICY_STATES } from '../core/permissions.js';
import * as memoryStore from '../core/memory/store.js';
import { getPolicyEngine, originFor } from '../core/security/policyEngine.js';
import { forgetUserContext, forgetGuildContext } from '../core/context/contextStore.js';
import { routeReminders, getReminderStore, scopedReminderStore } from '../reminders/assistant.js';
import { descartarContinuidade } from '../core/continuidade.js';
import { routeLists } from '../handlers/listAssistant.js';
import { researchSlots, RESEARCH_BUSY_REPLY } from '../core/ai/manager.js';
import { ChannelError } from '../core/channel/protocol.js';
import { authorizeAdminWipe, AdminWipeError } from '../core/memory/adminWipe.js';
import { audit } from '../core/audit.js';

const ID_RE = /^\d{5,25}$/;
const BOT_ONLY = { roles: ['bot'] };

const bad = (message) => new ChannelError('BAD_PARAMS', message);
const clampInt = (value, min, max, fallback) => {
  const n = Number(value);
  return Number.isInteger(n) ? Math.min(max, Math.max(min, n)) : fallback;
};
const optionalId = (value, label) => {
  if (value === null || value === undefined || value === '') return null;
  const id = String(value);
  if (!ID_RE.test(id)) throw bad(`${label} inválido.`);
  return id;
};

/**
 * Contexto do Core a partir dos dados de origem que o bot mandou. Só a plataforma 'discord' (o papel bot é o adaptador do
 * Discord); a pessoa e o servidor precisam ser IDs do Discord.
 */
export function contextFromWire(wire, meta = {}) {
  if (!wire || typeof wire !== 'object') throw bad('Contexto ausente.');
  if (meta.role === 'bot' && (wire.platform ?? 'discord') !== 'discord') throw bad('O adaptador do Discord só manda contexto do Discord.');
  const userId = String(wire.userId ?? '');
  if (!ID_RE.test(userId)) throw bad('Pessoa inválida no contexto.');
  return buildContext({
    platform: 'discord',
    userId,
    guildId: optionalId(wire.guildId, 'Servidor'),
    channelId: optionalId(wire.channelId, 'Canal'),
    isDM: wire.isDM === true,
    isBlocked: wire.isBlocked === true,
  });
}

/**
 * Passa a ação pelo motor de políticas. Devolve nada (segue) ou lança ChannelError (POLICY_DENIED / POLICY_CRITICAL).
 * O código antigo libera (as regras de dono e de escopo ficam no store): legacy = allow, como no discordGuard.
 */
export function gateAction(engine, action, ctx, meta = {}) {
  const { decision, enforced, verdict } = engine.gate({ action, ctx, origin: originFor({ platform: ctx.platform, channelKind: ctx.channelKind }), legacy: 'allow', target: `canal:${meta.role ?? '?'}` });
  if (!enforced) return;
  if (decision === POLICY_STATES.DENY) throw new ChannelError('POLICY_DENIED', `Não permitido pela política de segurança (${verdict?.reason ?? 'política'}).`);
  if (decision === POLICY_STATES.CRITICAL) throw new ChannelError('POLICY_CRITICAL', 'Ação crítica: só pode ser feita no computador da Yui.');
}

/** memory.admin_wipe_user pelo canal: a regra única (adminWipe.js), com os erros convertidos para o canal. */
export function wipeGate({ ctx, alvo, confirmacao, item = null, engine, meta = {} }) {
  try {
    authorizeAdminWipe({ ctx, alvo, confirmacao, item, engine });
  } catch (err) {
    if (err instanceof AdminWipeError) throw new ChannelError(err.code, err.message, { canal: meta.role ?? null });
    throw err;
  }
}

/**
 * Registra os métodos do cérebro no servidor do canal. Tudo injetável para teste.
 * @param {{handle: Function}} server  o servidor do canal (startChannelServer)
 * @param {{ store?: object, engine?: object, research?: () => Promise<{runResearchFor: Function}>, reminderStore?: () => object,
 *           composeReport?: () => Promise<string>, health?: () => object, slots?: object }} [deps]
 * @returns {string[]} os métodos registrados
 */
export function registerCerebroMethods(server, deps = {}) {
  const store = deps.store ?? memoryStore;
  const engine = deps.engine ?? getPolicyEngine();
  const slots = deps.slots ?? researchSlots;
  const reminderStore = deps.reminderStore ?? getReminderStore;
  const loadResearch = deps.research ?? (async () => (await import('../core/ai/research.js')).createCoreResearch());
  const health = deps.health ?? (() => ({}));
  const methods = [];
  const handle = (method, fn) => { server.handle(method, fn, BOT_ONLY); methods.push(method); };

  // ── Memória ──
  handle('memory.recall', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    return store.recall(ctx, String(p?.query ?? '').slice(0, 4000), { limit: clampInt(p?.limit, 1, 50, 8), type: typeof p?.type === 'string' ? p.type : null });
  });
  handle('memory.list', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    return store.listMemories(ctx, { limit: clampInt(p?.limit, 1, 500, 50) });
  });
  handle('memory.remember', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    gateAction(engine, 'memory.write_own', ctx, meta);
    const tags = Array.isArray(p?.tags) ? p.tags.slice(0, 20).map((t) => String(t).slice(0, 60)) : [];
    return store.remember(ctx, { type: String(p?.type ?? 'fact'), content: String(p?.content ?? ''), tags, source: String(p?.source ?? '').slice(0, 100), importance: clampInt(p?.importance, 1, 5, 1) });
  });
  handle('memory.forget', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    gateAction(engine, 'memory.forget_item', ctx, meta);
    const id = Number(p?.id);
    if (!Number.isInteger(id) || id < 1) throw bad('Número da lembrança inválido.');
    return store.forget(ctx, id);
  });
  handle('memory.forgetAll', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    gateAction(engine, 'memory.wipe_own', ctx, meta);
    descartarContinuidade(ctx.userId); // a proposta do app vive neste processo
    return store.forgetAll(ctx);
  });
  handle('memory.touch', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    gateAction(engine, 'memory.write_own', ctx, meta);
    store.touchUser(ctx, { minIntervalMs: clampInt(p?.minIntervalMs, 0, 86_400_000, 0), onlyExisting: p?.onlyExisting === true });
    return { ok: true };
  });
  // Administração: só o dono (o store confere o papel de novo e recusa qualquer outro).
  handle('memory.adminListUsers', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    gateAction(engine, 'memory.admin_inspect', ctx, meta);
    return store.adminListUsers(ctx, { limit: clampInt(p?.limit, 1, 100, 25) });
  });
  handle('memory.adminListMetadata', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    gateAction(engine, 'memory.admin_inspect', ctx, meta);
    return store.adminListMetadata(ctx, optionalId(p?.userId, 'Usuário') ?? '', { limit: clampInt(p?.limit, 1, 100, 25) });
  });
  handle('memory.adminListContent', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    gateAction(engine, 'memory.admin_inspect', ctx, meta);
    return store.adminListContent(ctx, optionalId(p?.userId, 'Usuário') ?? '', { limit: clampInt(p?.limit, 1, 200, 100) });
  });
  // Apagar a memória de OUTRA pessoa: as mesmas regras do processo único (core/memory/adminWipe.js): só o dono, com a
  // confirmação explícita do alvo, pela política (origem real do contexto) e com auditoria. O cérebro confere tudo de novo:
  // não confia no que o bot afirmou.
  handle('memory.adminForget', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    const id = Number(p?.id);
    if (!Number.isInteger(id) || id < 1) throw bad('Número da lembrança inválido.');
    const alvo = optionalId(p?.userId, 'Usuário') ?? '';
    wipeGate({ ctx, alvo, confirmacao: p?.confirmacao, item: id, engine, meta });
    return store.adminForget(ctx, alvo, id);
  });
  handle('memory.adminForgetUser', async (p, meta) => {
    const ctx = contextFromWire(p?.ctx, meta);
    const alvo = optionalId(p?.userId, 'Usuário') ?? '';
    wipeGate({ ctx, alvo, confirmacao: p?.confirmacao, engine, meta });
    return store.adminForgetUser(ctx, alvo);
  });

  // ── Contexto por horas: só o direito de exclusão (apagar-tudo e saída de servidor) ──
  handle('context.forgetUser', async (p, meta) => {
    const userId = optionalId(p?.userId, 'Usuário');
    if (!userId) throw bad('Usuário ausente.');
    gateAction(engine, 'memory.wipe_own', buildContext({ platform: 'discord', userId, isDM: true }), meta);
    descartarContinuidade(userId);
    return forgetUserContext(userId);
  });
  handle('context.forgetGuild', async (p) => {
    const guildId = optionalId(p?.guildId, 'Servidor');
    if (!guildId) throw bad('Servidor ausente.');
    return forgetGuildContext(guildId);
  });

  // ── Lembretes (o cérebro é o dono do lembretes.json) ──
  // A conversa do Discord manda o texto da PRÓPRIA pessoa; as regras de sempre (cada um só mexe nos próprios lembretes, só o
  // dono cria para outra pessoa e vê o resumo do dia) valem aqui, pelo código do assistente de lembretes.
  handle('reminders.route', async (p) => {
    const userId = optionalId(p?.userId, 'Usuário');
    if (!userId) return { handled: false };
    const text = String(p?.text ?? '').slice(0, 2000);
    const authorName = String(p?.authorName ?? '').slice(0, 64);
    const report = deps.composeReport ?? (async () => (await import('../reminders/service.js')).createMorningComposer()());
    // "reenvia/descarta o lembrete N" (aviso de entrega incerta) vai para a auditoria do cérebro e dispara uma passada na hora.
    return routeReminders({ text, userId, authorName }, { store: reminderStore(), report, audit: deps.audit ?? audit, aoMudar: deps.lembretesMudaram ?? null });
  });
  handle('reminders.list', async (p) => {
    const userId = optionalId(p?.userId, 'Usuário');
    if (!userId) throw bad('Usuário ausente.');
    return scopedReminderStore(reminderStore(), userId, isOwnerId(userId)).list();
  });

  // ── Listas pessoais: com YUI_APP_COMANDOS ligado o cérebro é o único escritor (o app e o bot passam por aqui) ──
  handle('lists.route', async (p) => {
    const userId = optionalId(p?.userId, 'Usuário');
    if (!userId) return { handled: false };
    return routeLists({ text: String(p?.text ?? '').slice(0, 4000), userId }, deps.listStore ? { store: deps.listStore } : {});
  });

  // ── Pesquisa (adaptador do Core, sem a ponte do bot) ──
  handle('research.run', async (p) => {
    const userId = optionalId(p?.userId, 'Usuário');
    const release = slots.tryAcquire();
    if (!release) return { ok: false, kind: 'refused', text: RESEARCH_BUSY_REPLY, private: false, historyLine: null, usedSearch: false, sources: [] };
    try {
      const { runResearchFor } = await loadResearch();
      const out = await runResearchFor({
        question: String(p?.question ?? '').slice(0, 2000),
        query: String(p?.query ?? '').slice(0, 500),
        intent: String(p?.intent ?? '').slice(0, 500),
        userId,
        sensitive: p?.sensitive === true,
        // Quem é o dono sai das regras do cérebro, nunca do que o bot afirmou.
        isOwner: userId ? isOwnerId(userId) : false,
        channelId: optionalId(p?.channelId, 'Canal'),
        guildId: optionalId(p?.guildId, 'Servidor'),
        ...(p?.disabled === true ? { disabled: true } : {}),
      });
      // Só o que o adaptador precisa (o trace e as estatísticas internas ficam no cérebro).
      return { ok: out?.ok === true, kind: out?.kind ?? 'failed', text: String(out?.text ?? ''), private: out?.private === true, historyLine: out?.historyLine ?? null, usedSearch: out?.usedSearch === true, sources: Array.isArray(out?.sources) ? out.sources.slice(0, 10) : [] };
    } finally {
      release();
    }
  });

  // ── Saúde ──
  handle('health', async () => health());

  return methods;
}
