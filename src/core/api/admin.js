import fs from 'fs';
import path from 'path';
import * as memory from '../memory/store.js';
import { listTools } from '../agent/tools.js';
import { checkToolAccess, isOwnerId, isReadOnlyMode, ROLES } from '../permissions.js';
import { isMemoryEnabled } from '../discordAdapter.js';
import { audit, auditFilePath } from '../audit.js';
import { listRadio, RADIO_ACTIONS, defaultRadioDeps } from './radioAdmin.js';
import { readLogs } from './panelLogs.js';
import { buildIntegrations, loadGuildDetail, loadIntegrationData } from './integrations.js';
import { addCustom, addCustomKey, setCustomOptions, addKey, AiSettingsError, describeAi, isEditEnabled, removeCustom, removeKey, setCloudflareAccount, setEnabled } from '../aiSettings.js';

/**
 * Administração da Yui pelo painel (somente o DONO).
 *
 * O que o painel controla: visão geral, servidores (AutoMod, canais, avisos de
 * YouTube/Twitch), banimentos, memória dos usuários (SÓ metadados), auditoria,
 * lista de ferramentas, provedores de IA (adicionar chaves e provedores próprios,
 * ligar/desligar; as chaves só ENTRAM, nunca saem; YUI_PANEL_AI_EDIT=false trava)
 * e reinício da Yui.
 *
 * O que o painel NÃO controla, de propósito (só pelo .env): o modo somente
 * leitura, a senha/o login e os tokens de acesso. Assim, um painel comprometido
 * não consegue se desbloquear nem trocar as próprias credenciais de entrada.
 *
 * Toda ação que altera algo é registrada na auditoria (só metadados).
 */

export class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

const ID_RE = /^\d{15,25}$/;
const AUTOMOD_MODES = ['off', 'trigger', 'mcp', 'both'];
const BAN_TYPES = ['user', 'guild', 'channel'];
const MAX_AUDIT = 500;

function requireOwner(ctx) {
  if (ctx?.role !== ROLES.OWNER) throw new AdminError(403, 'Apenas o dono pode usar o painel de administração.');
}

function requireId(value, label = 'ID') {
  const id = String(value ?? '').trim();
  if (!ID_RE.test(id)) throw new AdminError(400, `${label} inválido (use só números, 15 a 25 dígitos).`);
  return id;
}

/** Dependências reais do bot, carregadas só quando necessário (os testes injetam fakes). */
async function defaultDeps() {
  const ban = await import('../../handlers/banHandler.js');
  const tos = await import('../../handlers/tosHandler.js');
  return {
    getBans: ban.getBans,
    addBan: ban.addBan,
    removeBan: ban.removeBan,
    setAutoBlock: ban.setAutoBlock,
    getAutoBlockMode: ban.getAutoBlockMode,
    isServerAccepted: tos.isServerAccepted,
  };
}

/** Lê as últimas `limit` linhas do arquivo de auditoria sem carregá-lo inteiro. */
function tailAudit(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const chunk = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, size - chunk);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.startsWith('{'));
    const rows = [];
    for (const line of lines.slice(-limit)) {
      try { rows.push(JSON.parse(line)); } catch { /* linha cortada no início do trecho */ }
    }
    return rows.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

const CHANNEL_COLUMNS = { noticias: 'news_channel_id', diario: 'daily_channel_id', semanal: 'weekly_channel_id' };

/** Canal de texto/anúncios que existe no servidor (a Yui só publica nesses). */
function requireTextChannel(guild, value) {
  const id = requireId(value, 'ID do canal');
  const ch = guild.channels?.cache?.get?.(id);
  if (!ch || ![0, 5].includes(ch.type)) throw new AdminError(400, 'Esse canal não existe neste servidor ou não é de texto.');
  return id;
}

/** Mensagem útil quando o teste falha: o erro real do provedor (sem chaves) ou o motivo de estar inativo. */
async function explainAiFailure(e, id, deps) {
  const msg = String(e?.message ?? 'falhou');
  if (deps?.aiChat) return msg.slice(0, 200);
  try {
    const { getGateway } = await import('../../gateway/index.js');
    const st = getGateway().status().providers.find((p) => p.id === id);
    if (!st) return 'Provedor inativo: falta chave (ou a chave é curta demais), está desligado ou o ID da conta não foi informado.';
    if (st.cooldownSeconds > 0) {
      const last = st.targets.map((t) => t.lastError).find(Boolean);
      return `Em descanso por ${Math.ceil(st.cooldownSeconds / 60)} min após erro: ${String(last ?? msg).replace(/\s+/g, ' ').slice(0, 170)}`;
    }
    const last = st.targets.map((t) => t.lastError).find(Boolean);
    if (last) return String(last).replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    /* sem detalhes extras */
  }
  return msg.slice(0, 200);
}

async function aiChange(ctx, event, meta, fn) {
  requireOwner(ctx);
  if (!isEditEnabled()) throw new AdminError(403, 'A edição de IA pelo painel está desligada (YUI_PANEL_AI_EDIT=false no .env).');
  let out;
  try {
    out = fn();
  } catch (e) {
    if (e instanceof AiSettingsError) throw new AdminError(e.status, e.message);
    throw e;
  }
  const { resetGateway } = await import('../../gateway/index.js');
  resetGateway();
  audit(event, ctx, meta);
  return { ok: true, ...out };
}

async function defaultSetGuildChannel(guildId, column, channelId) {
  const { guildRepository } = await import('../../database/repositories/guildRepo.js');
  guildRepository.setChannel(guildId, column, channelId);
}

async function defaultAddYoutube({ guildId, input, discordChannelId, roleId, videos, shorts, lives }) {
  const { resolveChannel } = await import('../../handlers/youtubeApiHandler.js');
  const { youtubeRepository } = await import('../../database/repositories/youtubeRepo.js');
  let resolved;
  try {
    resolved = await resolveChannel(input);
  } catch (e) {
    throw new AdminError(502, `Falha ao consultar a API do YouTube: ${e.message}`);
  }
  if (!resolved) throw new AdminError(404, 'Não encontrei esse canal no YouTube. Confira o @handle, o ID (UC...) ou a URL.');
  const r = youtubeRepository.addSubscription({
    guildId,
    youtubeChannelId: resolved.channelId,
    channelName: resolved.title,
    uploadsPlaylistId: resolved.uploadsPlaylistId,
    discordChannelId,
    mentionRoleId: roleId,
    notifyVideos: videos ? 1 : 0,
    notifyShorts: shorts ? 1 : 0,
    notifyLives: lives ? 1 : 0,
  });
  return { added: r.changes > 0, channelId: resolved.channelId, name: resolved.title };
}

async function defaultRemoveYoutube(guildId, youtubeChannelId, discordChannelId) {
  const { youtubeRepository } = await import('../../database/repositories/youtubeRepo.js');
  return youtubeRepository.removeSubscription(guildId, youtubeChannelId, discordChannelId).changes > 0;
}

async function defaultAddTwitch({ guildId, login, discordChannelId, roleId }) {
  const { getTwitchUser } = await import('../../handlers/twitchApiHandler.js');
  const { twitchRepository } = await import('../../database/repositories/twitchRepo.js');
  let user;
  try {
    user = await getTwitchUser(login);
  } catch (e) {
    throw new AdminError(502, `Falha ao consultar a API da Twitch: ${e.message}`);
  }
  if (!user) throw new AdminError(404, 'Não encontrei esse canal na Twitch. Confira o login.');
  const r = twitchRepository.addSubscription({ guildId, twitchLogin: user.login, twitchUserId: user.id, discordChannelId, mentionRoleId: roleId });
  return { added: r.changes > 0, login: user.login, name: user.displayName || user.login };
}

async function defaultRemoveTwitch(guildId, login, discordChannelId) {
  const { twitchRepository } = await import('../../database/repositories/twitchRepo.js');
  return twitchRepository.removeSubscription(guildId, login, discordChannelId).changes > 0;
}

export function createAdmin({
  client = null,
  deps = null,
  auditFile = null,
  exit = () => process.exit(0),
  startedAt = Date.now(),
} = {}) {
  let cached = deps;
  const d = async () => (cached ??= await defaultDeps());

  const guildList = () => (client?.guilds?.cache ? [...client.guilds.cache.values()] : []);
  let radioCache = null;
  const radioDeps = async () => deps?.radio ?? (radioCache ??= await defaultRadioDeps());
  const findGuild = (guildId) => {
    const id = requireId(guildId, 'ID do servidor');
    const g = guildList().find((x) => x.id === id);
    if (!g) throw new AdminError(404, 'A Yui não está nesse servidor.');
    return g;
  };

  return {
    /** Visão geral: estado da Yui e das proteções. */
    async overview(ctx) {
      requireOwner(ctx);
      const dep = await d();
      const bans = dep.getBans();
      const mem = mem_count(ctx);
      return {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        pid: process.pid,
        node: process.version,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        discord: {
          online: Boolean(client?.isReady?.()),
          tag: client?.user?.tag ?? null,
          guilds: guildList().length,
        },
        bans: {
          users: Object.keys(bans.users || {}).length,
          guilds: Object.keys(bans.guilds || {}).length,
          channels: Object.keys(bans.channels || {}).length,
        },
        memoryUsers: mem,
        flags: {
          readOnly: isReadOnlyMode(),
          memoryEnabled: isMemoryEnabled(),
          pcToolsEnabled: String(process.env.YUI_TOOLS_PC_ENABLED || 'false').toLowerCase() === 'true',
        },
      };
    },

    /** Servidores em que a Yui está, com o modo de AutoMod de cada um. */
    async guilds(ctx) {
      requireOwner(ctx);
      const dep = await d();
      return guildList()
        .map((g) => ({
          id: g.id,
          name: g.name,
          members: g.memberCount ?? null,
          automod: dep.getAutoBlockMode(g.id),
          tosAccepted: dep.isServerAccepted(g.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async setAutomod(ctx, guildId, mode) {
      requireOwner(ctx);
      const id = requireId(guildId, 'ID do servidor');
      if (!AUTOMOD_MODES.includes(mode)) throw new AdminError(400, `Modo inválido. Use: ${AUTOMOD_MODES.join(', ')}.`);
      if (client && !guildList().some((g) => g.id === id)) throw new AdminError(404, 'A Yui não está nesse servidor.');
      const dep = await d();
      dep.setAutoBlock(id, mode);
      audit('admin.automod', ctx, { guild: id, mode });
      return { ok: true, guildId: id, automod: dep.getAutoBlockMode(id) };
    },

    async bans(ctx) {
      requireOwner(ctx);
      const dep = await d();
      const b = dep.getBans();
      const list = (obj) =>
        Object.entries(obj || {})
          .map(([id, v]) => ({ id, reason: v?.reason ?? '', timestamp: v?.timestamp ?? null }))
          .sort((x, y) => String(y.timestamp).localeCompare(String(x.timestamp)));
      return { users: list(b.users), guilds: list(b.guilds), channels: list(b.channels) };
    },

    async addBan(ctx, type, id, reason) {
      requireOwner(ctx);
      if (!BAN_TYPES.includes(type)) throw new AdminError(400, `Tipo inválido. Use: ${BAN_TYPES.join(', ')}.`);
      const target = requireId(id);
      if (type === 'user' && isOwnerId(target)) throw new AdminError(400, 'Não é possível banir o dono.');
      const text = String(reason ?? '').trim().slice(0, 200) || 'Banido pelo painel.';
      const dep = await d();
      dep.addBan(type, target, text);
      audit('admin.ban.add', ctx, { type, target });
      return { ok: true };
    },

    async removeBan(ctx, type, id) {
      requireOwner(ctx);
      if (!BAN_TYPES.includes(type)) throw new AdminError(400, `Tipo inválido. Use: ${BAN_TYPES.join(', ')}.`);
      const target = requireId(id);
      const dep = await d();
      dep.removeBan(type, target);
      audit('admin.ban.remove', ctx, { type, target });
      return { ok: true };
    },

    // ── Memória dos usuários (só metadados; o conteúdo nunca é exibido) ──
    async memoryUsers(ctx) {
      requireOwner(ctx);
      return memory.adminListUsers(ctx, { limit: 50 });
    },
    async memoryInspect(ctx, userId) {
      requireOwner(ctx);
      return { memories: memory.adminListMetadata(ctx, requireId(userId, 'ID do usuário'), { limit: 50 }) };
    },
    async memoryForget(ctx, userId, memoryId) {
      requireOwner(ctx);
      const n = Number(memoryId);
      if (!Number.isInteger(n) || n < 1) throw new AdminError(400, 'Número da lembrança inválido.');
      return { ok: memory.adminForget(ctx, requireId(userId, 'ID do usuário'), n) };
    },
    async memoryForgetUser(ctx, userId) {
      requireOwner(ctx);
      return { removed: memory.adminForgetUser(ctx, requireId(userId, 'ID do usuário')) };
    },

    /** Últimos eventos da auditoria (só metadados). */
    async audit(ctx, limit = 100) {
      requireOwner(ctx);
      const n = Math.min(MAX_AUDIT, Math.max(1, parseInt(limit, 10) || 100));
      return { events: tailAudit(auditFile || auditFilePath(), n) };
    },

    /** Ferramentas do Agent e se cada uma está liberada agora. Somente leitura: não dá para alterar por aqui. */
    async tools(ctx) {
      requireOwner(ctx);
      return {
        readOnly: isReadOnlyMode(),
        tools: listTools().map((t) => {
          const a = checkToolAccess(ctx, t.name);
          return { name: t.name, description: t.description, access: t.access, confirm: Boolean(t.confirm), allowed: a.allowed, reason: a.reason ?? null };
        }),
      };
    },

    /** Estado das integrações (YouTube, Twitch, Reddit, IA, voz...), só leitura e sem chaves. */
    async integrations(ctx) {
      requireOwner(ctx);
      const data = deps?.integrationData ? await deps.integrationData() : await loadIntegrationData();
      return buildIntegrations({
        env: process.env,
        client,
        data,
        readOnly: isReadOnlyMode(),
        memoryEnabled: isMemoryEnabled(),
        tools: listTools().length,
      });
    },

    /** Detalhes de um servidor: canais, avisos de YouTube/Twitch e ferramentas liberadas. */
    async guildDetail(ctx, guildId) {
      requireOwner(ctx);
      const id = requireId(guildId, 'ID do servidor');
      const guild = guildList().find((g) => g.id === id);
      if (!guild) throw new AdminError(404, 'A Yui não está nesse servidor.');
      return deps?.guildDetail ? deps.guildDetail(guild) : loadGuildDetail(guild);
    },

    // ── Canais do servidor e avisos de YouTube/Twitch ──
    async setGuildChannel(ctx, guildId, type, channelId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const column = CHANNEL_COLUMNS[type];
      if (!column) throw new AdminError(400, `Tipo de canal inválido. Use: ${Object.keys(CHANNEL_COLUMNS).join(', ')}.`);
      const target = channelId === null || channelId === '' || channelId === undefined ? null : requireTextChannel(guild, channelId);
      const dep = await d();
      await (dep.setGuildChannel ?? defaultSetGuildChannel)(guild.id, column, target);
      audit('admin.guild.channel', ctx, { guild: guild.id, type, channel: target });
      return { ok: true };
    },

    async addYoutubeFollow(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const discordChannelId = requireTextChannel(guild, body.discordChannelId);
      const input = String(body.channel ?? '').trim();
      if (!input || input.length > 200) throw new AdminError(400, 'Informe o canal do YouTube (@handle, ID UC... ou URL).');
      const roleId = body.roleId ? requireId(body.roleId, 'ID do cargo') : null;
      const dep = await d();
      const result = await (dep.addYoutube ?? defaultAddYoutube)({
        guildId: guild.id, input, discordChannelId, roleId,
        videos: body.videos !== false, shorts: body.shorts !== false, lives: body.lives !== false,
      });
      audit('admin.follow.youtube.add', ctx, { guild: guild.id, youtube: result.channelId, channel: discordChannelId });
      return { ok: true, added: result.added, name: result.name };
    },

    async removeYoutubeFollow(ctx, guildId, youtubeChannelId, discordChannelId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      if (!/^[\w-]{3,80}$/.test(String(youtubeChannelId))) throw new AdminError(400, 'ID do canal do YouTube inválido.');
      const dep = await d();
      const removed = await (dep.removeYoutube ?? defaultRemoveYoutube)(guild.id, youtubeChannelId, requireId(discordChannelId, 'ID do canal'));
      audit('admin.follow.youtube.remove', ctx, { guild: guild.id, youtube: youtubeChannelId });
      return { ok: true, removed };
    },

    async addTwitchFollow(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const discordChannelId = requireTextChannel(guild, body.discordChannelId);
      let input = String(body.streamer ?? '').trim();
      const fromUrl = input.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
      if (fromUrl) input = fromUrl[1];
      const login = input.toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new AdminError(400, 'Login da Twitch inválido (3 a 25 letras, números ou _).');
      const roleId = body.roleId ? requireId(body.roleId, 'ID do cargo') : null;
      const dep = await d();
      const result = await (dep.addTwitch ?? defaultAddTwitch)({ guildId: guild.id, login, discordChannelId, roleId });
      audit('admin.follow.twitch.add', ctx, { guild: guild.id, twitch: result.login, channel: discordChannelId });
      return { ok: true, added: result.added, name: result.name };
    },

    async removeTwitchFollow(ctx, guildId, login, discordChannelId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      if (!/^[a-zA-Z0-9_]{3,25}$/.test(String(login))) throw new AdminError(400, 'Login da Twitch inválido.');
      const dep = await d();
      const removed = await (dep.removeTwitch ?? defaultRemoveTwitch)(guild.id, String(login).toLowerCase(), requireId(discordChannelId, 'ID do canal'));
      audit('admin.follow.twitch.remove', ctx, { guild: guild.id, twitch: String(login).toLowerCase() });
      return { ok: true, removed };
    },

    // ── Provedores de IA: chaves e provedores próprios (as chaves só entram, nunca saem) ──
    async ai(ctx) {
      requireOwner(ctx);
      const { getGateway } = await import('../../gateway/index.js');
      return describeAi({ gateway: getGateway().status() });
    },

    async aiAddKey(ctx, providerId, key) {
      return aiChange(ctx, 'admin.ai.key.add', { provider: String(providerId) }, () => addKey(String(providerId), key));
    },
    async aiRemoveKey(ctx, providerId, index) {
      return aiChange(ctx, 'admin.ai.key.remove', { provider: String(providerId) }, () => removeKey(String(providerId), index));
    },
    async aiCloudflare(ctx, accountId) {
      return aiChange(ctx, 'admin.ai.cloudflare', {}, () => setCloudflareAccount(accountId));
    },
    async aiSetEnabled(ctx, providerId, enabled) {
      if (typeof enabled !== 'boolean') throw new AdminError(400, 'Informe enabled: true ou false.');
      return aiChange(ctx, 'admin.ai.enabled', { provider: String(providerId), enabled }, () => setEnabled(String(providerId), enabled));
    },
    async aiAddCustom(ctx, body = {}) {
      return aiChange(ctx, 'admin.ai.custom.add', { id: String(body.id ?? '') }, () => addCustom(body));
    },
    async aiAddCustomKey(ctx, id, key) {
      return aiChange(ctx, 'admin.ai.custom.key', { id: String(id) }, () => addCustomKey(String(id), key));
    },
    async aiCustomOptions(ctx, id, body = {}) {
      return aiChange(ctx, 'admin.ai.custom.options', { id: String(id), first: body.first, anonymous: body.anonymous, models: body.models !== undefined }, () => setCustomOptions(String(id), { first: body.first, anonymous: body.anonymous, models: body.models }));
    },
    async aiRemoveCustom(ctx, id) {
      return aiChange(ctx, 'admin.ai.custom.remove', { id: String(id) }, () => removeCustom(String(id)));
    },

    /** Faz uma pergunta mínima ao provedor para conferir se a chave/endereço funcionam. */
    async aiTest(ctx, providerId) {
      requireOwner(ctx);
      const id = String(providerId);
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw new AdminError(400, 'Provedor inválido.');
      const t0 = Date.now();
      try {
        const chat = deps?.aiChat ?? (async (model) => (await import('../../gateway/index.js')).getGateway().chat(
          { model, messages: [{ role: 'user', content: 'Responda somente: ok' }], max_tokens: 400 }, { sensitive: false }));
        const res = await chat(id);
        audit('admin.ai.test', ctx, { provider: id, ok: true });
        return { ok: true, ms: Date.now() - t0, via: res?.x_gateway?.model ?? null };
      } catch (e) {
        audit('admin.ai.test', ctx, { provider: id, ok: false });
        return { ok: false, ms: Date.now() - t0, error: await explainAiFailure(e, id, deps) };
      }
    },

    // ── Modo Rádio (sessões) e logs ──
    async radio(ctx) {
      requireOwner(ctx);
      const r = await radioDeps();
      const guildOf = (id) => guildList().find((g) => g.id === id);
      const sessions = await listRadio(r, (id) => guildOf(id)?.name ?? null, (id, voiceId) => guildOf(id)?.channels?.cache?.get?.(voiceId)?.name ?? null);
      return { sessions };
    },

    async radioAction(ctx, guildId, action) {
      requireOwner(ctx);
      const id = requireId(guildId, 'ID do servidor');
      if (!RADIO_ACTIONS.includes(action)) throw new AdminError(400, `Ação inválida. Use: ${RADIO_ACTIONS.join(', ')}.`);
      const r = await radioDeps();
      if (!r.getSession(id)) throw new AdminError(404, 'Não há sessão de rádio nesse servidor.');
      let ok = true;
      if (action === 'pause') ok = await r.pause(id);
      else if (action === 'resume') ok = await r.resume(id);
      else if (action === 'stop') await r.stopMusic(id);
      else await r.leave(id);
      if (ok === false) throw new AdminError(409, 'Não há nada tocando agora.');
      audit('admin.radio', ctx, { guild: id, action });
      return { ok: true };
    },

    /** Últimas linhas dos logs (segredos mascarados). Só leitura. */
    async logs(ctx, query = {}) {
      requireOwner(ctx);
      const res = readLogs({
        dir: deps?.logDir ?? process.env.YUI_LOG_DIR ?? path.resolve('logs'),
        kind: query.kind || 'app',
        date: query.date || null,
        level: query.level || null,
        q: query.q || '',
        limit: query.limit,
      });
      if (res.error) throw new AdminError(400, res.error);
      return res;
    },

    /** Saúde do Yui Gateway: provedores, modelos, descansos e contadores (sem chaves). */
    async gateway(ctx) {
      requireOwner(ctx);
      const { getGateway } = await import('../../gateway/index.js');
      return getGateway().status();
    },

    /** Zera os "descansos" dos provedores (útil depois de resolver um problema de chave/crédito). */
    async gatewayReset(ctx) {
      requireOwner(ctx);
      const { getGateway } = await import('../../gateway/index.js');
      getGateway().reset();
      audit('admin.gateway.reset', ctx, {});
      return { ok: true };
    },

    /** Reinicia a Yui (o supervisor da tarefa a religa em ~15 s). Exige confirmação explícita. */
    async restart(ctx, confirm) {
      requireOwner(ctx);
      if (confirm !== true) throw new AdminError(400, 'Confirmação necessária para reiniciar.');
      audit('admin.restart', ctx, {});
      setTimeout(exit, 700);
      return { ok: true, message: 'Reiniciando… volto em alguns segundos.' };
    },
  };
}

function mem_count(ctx) {
  try {
    return memory.adminListUsers(ctx, { limit: 1 }).total;
  } catch {
    return null; // memória desativada/não inicializada
  }
}
