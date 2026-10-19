/**
 * Cliente da Yui API (ver docs/content_pt/YUI_API.md).
 *
 * Mantido SEM dependências de React/Expo para ser testado em Node contra a
 * API real. Evita recursos de TypeScript que não são só "tipos" (enums,
 * parameter properties) para rodar direto com a remoção de tipos do Node.
 */

export type Role = 'OWNER' | 'TRUSTED' | 'MEMBER' | 'GUEST' | 'BLOCKED';
export type MemoryScope = 'personal' | 'public';

export interface Me {
  userId: string;
  role: Role;
  memoryScope: MemoryScope;
  /** Como esta conexão foi autenticada: token fixo ou sessão de login. */
  auth?: 'token' | 'session';
}

export interface LoginResult {
  token: string;
  /** Quando a sessão expira (epoch em ms). */
  expiresAt: number;
  userId: string;
}

// ── Painel de administração (somente o dono) ──
export interface AdminOverview {
  uptimeSeconds: number;
  pid: number;
  node: string;
  memoryMB: number;
  discord: { online: boolean; tag: string | null; guilds: number };
  bans: { users: number; guilds: number; channels: number };
  memoryUsers: number | null;
  flags: { readOnly: boolean; memoryEnabled: boolean; pcToolsEnabled: boolean };
}
export type AutomodMode = 'off' | 'trigger' | 'mcp' | 'both';
export interface AdminGuild { id: string; name: string; members: number | null; automod: AutomodMode; tosAccepted: boolean }
export type BanType = 'user' | 'guild' | 'channel';
export interface BanEntry { id: string; reason: string; timestamp: string | null }
export interface AdminBans { users: BanEntry[]; guilds: BanEntry[]; channels: BanEntry[] }
export interface AdminMemoryUser { userId: string; count: number; lastSeen: number; expiresAt: number | null }
export interface AdminMemoryMeta { id: number; type: string; chars: number; source: string; createdAt: number; expiresAt: number | null }
export interface AuditEvent { ts: string; event: string; userId: string | null; role: string | null; platform: string | null; [k: string]: unknown }
export interface GatewayTarget {
  id: string; model: string; tier: string; available: boolean; cooldownSeconds: number;
  failures: number; ok: number; fail: number; lastError: string | null; lastOkSecondsAgo: number | null;
}
export interface GatewayProvider {
  id: string; label: string; anonymous: boolean; priority: number; keys: number; keysCoolingDown: number;
  cooldownSeconds: number; targets: GatewayTarget[];
}
export interface GatewayStatus { totals: { requests: number; ok: number; failed: number }; combos: string[]; providers: GatewayProvider[] }
export type IntegrationStatus = 'ok' | 'off' | 'missing';
export interface IntegrationItem { key: string; name: string; status: IntegrationStatus; detail: string }
export interface IntegrationGroup { title: string; items: IntegrationItem[] }
export interface ChannelRef { id: string; name: string | null }
export interface AdminGuildDetail {
  id: string; name: string; members: number | null;
  channels: { noticias: ChannelRef | null; diario: ChannelRef | null; semanal: ChannelRef | null; atualizacoes: ChannelRef | null };
  respondToEveryone: boolean | null;
  textChannels: { id: string; name: string }[];
  roles: { id: string; name: string }[];
  youtube: { id: string; name: string; role: string | null; channel: ChannelRef | null; videos: boolean; shorts: boolean; lives: boolean }[];
  twitch: { id: string; name: string; role: string | null; channel: ChannelRef | null }[];
  tools: { enabled: string[]; disabled: string[] } | null;
}
export type GuildChannelType = 'noticias' | 'diario' | 'semanal';
export interface FollowYoutubeInput { channel: string; discordChannelId: string; roleId?: string | null; videos: boolean; shorts: boolean; lives: boolean }
export interface AiKeyHint { index: number; hint: string }
export interface AiProvider {
  id: string; label: string; url: string | null; needsAccount: boolean; accountConfigured: boolean | null;
  envKeys: number; ignoredEnvKeys?: number; panelKeys: AiKeyHint[]; enabled: boolean; toggle: boolean; active: boolean | null; keyless?: boolean;
}
export interface AiCustomProvider {
  id: string; label: string; baseUrl: string; models: string[]; keys: AiKeyHint[]; anonymous: boolean; first?: boolean;
  enabled: boolean; active: boolean; source: 'panel' | 'env';
}
export interface AiTemplate { id: string; label: string; baseUrl: string; models: string[]; needsKey: boolean; first?: boolean; anonymous?: boolean }
export interface AiOverview { editable: boolean; providers: AiProvider[]; custom: AiCustomProvider[]; templates: AiTemplate[] }
export interface AiCustomInput { id: string; label: string; baseUrl: string; models: string; key?: string; first?: boolean; anonymous?: boolean }
export interface AiTestResult { ok: boolean; ms: number; via?: string | null; error?: string }
export interface RadioTrack { title: string; artist: string; album: string | null }
export interface RadioSession {
  guildId: string; guildName: string | null; voiceChannel: string | null; status: string; connected: boolean;
  current: RadioTrack | null; next: RadioTrack | null; queueLength: number; position: string | null;
  shuffle: boolean; loopMode: string; voiceMode: string; streamMode: string;
}
export type RadioAction = 'pause' | 'resume' | 'stop' | 'leave';
export type LogKind = 'app' | 'error';
export type LogLevel = 'error' | 'warn' | 'info' | 'debug';
export interface LogEntry { time: string; level: string; text: string }
export interface LogFile { name: string; kind: LogKind; date: string; size: number }
export interface LogsResult { files: LogFile[]; file: string | null; entries: LogEntry[]; truncated: boolean }
export interface LogsQuery { kind?: LogKind; date?: string | null; level?: LogLevel | null; q?: string; limit?: number }
// ── Código (as funções do Jarvis dentro da Yui) ──
export interface DevProject { id: string; name: string; source: 'env' | 'panel'; exists: boolean }
export interface DevMode { id: string; label: string; description: string; readOnly: boolean }
export interface DevStatus {
  enabled: boolean;
  coreReadOnly: boolean;
  /** O pedido veio do próprio computador da Yui (só nele dá para aprovar e cadastrar projetos). */
  local: boolean;
  canWrite: boolean;
  approval: 'ask' | 'auto' | 'readonly';
  projects: DevProject[];
  modes: DevMode[];
}
export interface DevTreeItem { name: string; isDirectory: boolean; path: string }
export interface DevFile { name: string; path: string; content: string; language: string }
export interface DevHistoryMessage { role: 'user' | 'assistant'; content: string }
export type DevEvent =
  | { seq: number; type: 'step'; iteration: number; text: string }
  | { seq: number; type: 'thought'; text: string }
  | { seq: number; type: 'tool'; action: string; status: 'waiting' | 'running' | 'ok' | 'denied' | 'error'; summary: string; preview?: string }
  | { seq: number; type: 'approval'; id: string; action: string; summary: string; preview: string }
  | { seq: number; type: 'approval_done'; id: string; approved: boolean; reason?: string }
  | { seq: number; type: 'final'; text: string; provider?: string; model?: string }
  | { seq: number; type: 'done'; ok: boolean; changed?: string[]; cancelled?: boolean; error?: string; limitReached?: boolean };
export interface DevEvents { status: 'running' | 'done' | 'error' | 'cancelled'; last: number; approval: string; events: DevEvent[] }
export interface AdminTool { name: string; description: string; access: string; confirm: boolean; allowed: boolean; reason: string | null }

export interface Backend {
  name: string;
  local: boolean;
  active: boolean;
}

export interface Health {
  ok: boolean;
  memory: boolean;
  /** Modo somente leitura: a Yui não pode apagar, gravar nem executar programas. */
  readOnly?: boolean;
  backends: Backend[];
}

export type AgentReplyType = 'reply' | 'tool_result' | 'needs_confirmation' | 'denied';

export interface AgentReply {
  type: AgentReplyType;
  reply: string;
  tool?: string;
  pendingId?: string;
}

export interface MemoryItem {
  id: number;
  type: string;
  content: string;
  tags: string;
  importance: number;
  created_at: number;
  updated_at: number;
  expires_at: number | null;
}

export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

/**
 * Normaliza o endereço do servidor digitado pelo usuário:
 *  - sem esquema: usa https para *.ts.net (Tailscale Serve) e http nos demais;
 *  - remove barras finais e um eventual "/v1".
 */
export function normalizeBaseUrl(input: string): string {
  let raw = String(input ?? '').trim();
  if (!raw) throw new ApiError(0, 'Informe o endereço do servidor.');
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(raw)) {
    raw = `${/\.ts\.net(?::\d+)?(\/|$)/i.test(raw) ? 'https' : 'http'}://${raw}`;
  }
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ApiError(0, 'Endereço do servidor inválido.');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw new ApiError(0, 'Use um endereço http:// ou https://.');
  }
  const path = url.pathname.replace(/\/+$/, '').replace(/\/v1$/, '');
  return `${url.protocol}//${url.host}${path}`;
}

export interface ClientOptions {
  baseUrl: string;
  token: string;
  fetchImpl?: typeof fetch;
  /** Tempo máximo por requisição (respostas de IA podem demorar). */
  timeoutMs?: number;
  /** Chamado quando o servidor recusa a sessão/token (401): o app volta para o login. */
  onUnauthorized?: () => void;
}

function messageForStatus(status: number, serverMessage?: string): string {
  if (status === 401) return serverMessage && serverMessage !== 'não autorizado' ? serverMessage : 'Token ou sessão inválidos ou expirados.';
  if (status === 403) return 'Acesso negado para este usuário.';
  if (status === 429) return serverMessage && /^muit/i.test(serverMessage) && serverMessage !== 'muitas requisições' ? serverMessage : 'Muitas requisições. Aguarde um instante e tente de novo.';
  if (status === 503) return serverMessage || 'Recurso indisponível no servidor.';
  return serverMessage || `Erro do servidor (HTTP ${status}).`;
}

export function createClient(options: ClientOptions) {
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const token = String(options.token ?? '').trim();
  const doFetch: typeof fetch = options.fetchImpl ?? ((...args) => fetch(...args));
  const defaultTimeout = options.timeoutMs ?? 130_000;

  async function request<T>(method: string, path: string, body?: unknown, timeoutMs = defaultTimeout): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    let res: Response;
    try {
      res = await doFetch(`${baseUrl}${path}`, {
        method,
        headers: {
          Accept: 'application/json',
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        signal: controller.signal,
      });
    } catch (err) {
      const aborted = err instanceof Error && err.name === 'AbortError';
      throw new ApiError(
        0,
        aborted
          ? 'O servidor demorou demais para responder.'
          : 'Não foi possível conectar ao servidor. Verifique o endereço, o Tailscale e se o PC está ligado.'
      );
    } finally {
      clearTimeout(timer);
    }

    let data: unknown = null;
    try {
      data = await res.json();
    } catch {
      /* corpo vazio ou não-JSON */
    }
    if (res.status === 401 && token && options.onUnauthorized) options.onUnauthorized();
    if (!res.ok) {
      const serverMessage = data && typeof data === 'object' && 'error' in data ? String((data as { error: unknown }).error) : undefined;
      throw new ApiError(res.status, messageForStatus(res.status, serverMessage));
    }
    return data as T;
  }

  return {
    baseUrl,
    health: () => request<Health>('GET', '/v1/health', undefined, 15_000),
    me: () => request<Me>('GET', '/v1/me', undefined, 15_000),
    /** Conversa pelo Agent: responde, executa ferramenta ou pede confirmação. */
    send: (message: string) => request<AgentReply>('POST', '/v1/agent', { message }),
    confirm: (id: string, approve: boolean) => request<AgentReply>('POST', '/v1/agent/confirm', { id, approve }),
    memories: async () => (await request<{ scope: MemoryScope; memories: MemoryItem[] }>('GET', '/v1/memory', undefined, 20_000)),
    addMemory: (content: string, type = 'note') =>
      request<{ ok: boolean; scope: MemoryScope }>('POST', '/v1/memory', { content, type }, 20_000),
    deleteMemory: (id: number) => request<{ ok: boolean }>('DELETE', `/v1/memory/${id}`, undefined, 20_000),
    clearMemories: () => request<{ removed: number }>('DELETE', '/v1/memory', undefined, 20_000),

    // ── Login por usuário e senha ──
    authStatus: () => request<{ passwordLogin: boolean; discordKey: boolean }>('GET', '/v1/auth/status', undefined, 15_000),
    /** Pede uma chave de uso único; ela chega por DM no Discord do dono (não volta nesta resposta). */
    discordRequest: () => request<{ ok: boolean; expiresInSeconds: number }>('POST', '/v1/auth/discord/request', {}, 30_000),
    /** Troca a chave recebida por DM por uma sessão. */
    discordVerify: (code: string) => request<LoginResult>('POST', '/v1/auth/discord/verify', { code }, 20_000),
    login: (user: string, password: string) => request<LoginResult>('POST', '/v1/auth/login', { user, password }, 20_000),
    logout: () => request<{ ok: boolean; revoked: boolean }>('POST', '/v1/auth/logout', {}, 10_000),

    // ── Código: projetos, conversa com ferramentas e aprovações (só o dono) ──
    dev: {
      status: () => request<DevStatus>('GET', '/v1/dev/status', undefined, 20_000),
      addProject: (name: string, path: string) => request<{ ok: boolean; project: DevProject }>('POST', '/v1/dev/projects', { name, path }, 20_000),
      removeProject: (id: string) => request<{ ok: boolean }>('DELETE', `/v1/dev/projects/${encodeURIComponent(id)}`, undefined, 20_000),
      tree: async (id: string, path = '') =>
        (await request<{ items: DevTreeItem[] }>('GET', `/v1/dev/projects/${encodeURIComponent(id)}/tree?path=${encodeURIComponent(path)}`, undefined, 20_000)).items,
      file: async (id: string, path: string) =>
        (await request<{ file: DevFile }>('GET', `/v1/dev/projects/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`, undefined, 20_000)).file,
      history: async (id: string) => (await request<{ messages: DevHistoryMessage[] }>('GET', `/v1/dev/projects/${encodeURIComponent(id)}/history`, undefined, 20_000)).messages,
      clearHistory: (id: string) => request<{ ok: boolean }>('DELETE', `/v1/dev/projects/${encodeURIComponent(id)}/history`, undefined, 20_000),
      startRun: (id: string, input: { message: string; mode: string; activeFile?: string | null }) =>
        request<{ runId: string; approval: string }>('POST', `/v1/dev/projects/${encodeURIComponent(id)}/runs`, input, 30_000),
      events: (runId: string, after: number) => request<DevEvents>('GET', `/v1/dev/runs/${runId}/events?after=${after}`, undefined, 20_000),
      approve: (runId: string, approvalId: string, approve: boolean) =>
        request<{ ok: boolean }>('POST', `/v1/dev/runs/${runId}/approvals/${approvalId}`, { approve }, 20_000),
      cancel: (runId: string) => request<{ ok: boolean }>('POST', `/v1/dev/runs/${runId}/cancel`, {}, 20_000),
    },

    // ── Painel de administração (somente o dono) ──
    admin: {
      overview: () => request<AdminOverview>('GET', '/v1/admin/overview', undefined, 20_000),
      guilds: async () => (await request<{ guilds: AdminGuild[] }>('GET', '/v1/admin/guilds', undefined, 20_000)).guilds,
      setAutomod: (guildId: string, mode: AutomodMode) =>
        request<{ ok: boolean; automod: AutomodMode }>('POST', `/v1/admin/guilds/${guildId}/automod`, { mode }, 20_000),
      bans: () => request<AdminBans>('GET', '/v1/admin/bans', undefined, 20_000),
      addBan: (type: BanType, id: string, reason: string) => request<{ ok: boolean }>('POST', '/v1/admin/bans', { type, id, reason }, 20_000),
      removeBan: (type: BanType, id: string) => request<{ ok: boolean }>('DELETE', `/v1/admin/bans/${type}/${id}`, undefined, 20_000),
      memoryUsers: () => request<{ users: AdminMemoryUser[]; total: number }>('GET', '/v1/admin/memory/users', undefined, 20_000),
      memoryInspect: async (userId: string) =>
        (await request<{ memories: AdminMemoryMeta[] }>('GET', `/v1/admin/memory/users/${userId}`, undefined, 20_000)).memories,
      memoryForget: (userId: string, memoryId: number) =>
        request<{ ok: boolean }>('DELETE', `/v1/admin/memory/users/${userId}/${memoryId}`, undefined, 20_000),
      memoryForgetUser: (userId: string) => request<{ removed: number }>('DELETE', `/v1/admin/memory/users/${userId}`, undefined, 20_000),
      audit: async (limit = 100) => (await request<{ events: AuditEvent[] }>('GET', `/v1/admin/audit?limit=${limit}`, undefined, 20_000)).events,
      tools: () => request<{ readOnly: boolean; tools: AdminTool[] }>('GET', '/v1/admin/tools', undefined, 20_000),
      integrations: async () => (await request<{ groups: IntegrationGroup[] }>('GET', '/v1/admin/integrations', undefined, 20_000)).groups,
      guildDetail: (guildId: string) => request<AdminGuildDetail>('GET', `/v1/admin/guilds/${guildId}`, undefined, 20_000),
      setGuildChannel: (guildId: string, type: GuildChannelType, channelId: string | null) =>
        request<{ ok: boolean }>('PUT', `/v1/admin/guilds/${guildId}/channels`, { type, channelId }, 20_000),
      followYoutube: (guildId: string, input: FollowYoutubeInput) =>
        request<{ ok: boolean; added: boolean; name: string }>('POST', `/v1/admin/guilds/${guildId}/youtube`, input, 30_000),
      unfollowYoutube: (guildId: string, youtubeId: string, discordChannelId: string) =>
        request<{ ok: boolean }>('DELETE', `/v1/admin/guilds/${guildId}/youtube/${encodeURIComponent(youtubeId)}/${discordChannelId}`, undefined, 20_000),
      followTwitch: (guildId: string, input: { streamer: string; discordChannelId: string; roleId?: string | null }) =>
        request<{ ok: boolean; added: boolean; name: string }>('POST', `/v1/admin/guilds/${guildId}/twitch`, input, 30_000),
      unfollowTwitch: (guildId: string, login: string, discordChannelId: string) =>
        request<{ ok: boolean }>('DELETE', `/v1/admin/guilds/${guildId}/twitch/${encodeURIComponent(login)}/${discordChannelId}`, undefined, 20_000),
      ai: () => request<AiOverview>('GET', '/v1/admin/ai', undefined, 20_000),
      aiAddKey: (provider: string, key: string) => request<{ ok: boolean }>('POST', '/v1/admin/ai/keys', { provider, key }, 20_000),
      aiRemoveKey: (provider: string, index: number) => request<{ ok: boolean }>('DELETE', `/v1/admin/ai/keys/${provider}/${index}`, undefined, 20_000),
      aiCloudflare: (accountId: string) => request<{ ok: boolean }>('PUT', '/v1/admin/ai/cloudflare', { accountId }, 20_000),
      aiSetEnabled: (provider: string, enabled: boolean) => request<{ ok: boolean }>('POST', `/v1/admin/ai/providers/${provider}`, { enabled }, 20_000),
      aiAddCustom: (input: AiCustomInput) => request<{ ok: boolean }>('POST', '/v1/admin/ai/custom', input, 20_000),
      aiAddCustomKey: (id: string, key: string) => request<{ ok: boolean }>('POST', `/v1/admin/ai/custom/${id}/keys`, { key }, 20_000),
      aiCustomOptions: (id: string, options: { first?: boolean; anonymous?: boolean; models?: string }) => request<{ ok: boolean; first: boolean; anonymous: boolean }>('POST', `/v1/admin/ai/custom/${id}/options`, options, 20_000),
      aiRemoveCustom: (id: string) => request<{ ok: boolean }>('DELETE', `/v1/admin/ai/custom/${id}`, undefined, 20_000),
      aiTest: (provider: string) => request<AiTestResult>('POST', `/v1/admin/ai/test/${provider}`, {}, 60_000),
      sendDiscordDm: (message: string) => request<{ ok: boolean }>('POST', '/v1/admin/discord/dm', { message }, 30_000),
      radio: async () => (await request<{ sessions: RadioSession[] }>('GET', '/v1/admin/radio', undefined, 20_000)).sessions,
      radioAction: (guildId: string, action: RadioAction) => request<{ ok: boolean }>('POST', `/v1/admin/radio/${guildId}`, { action }, 30_000),
      logs: (query: LogsQuery = {}) => {
        const qs = new URLSearchParams();
        if (query.kind) qs.set('kind', query.kind);
        if (query.date) qs.set('date', query.date);
        if (query.level) qs.set('level', query.level);
        if (query.q) qs.set('q', query.q);
        if (query.limit) qs.set('limit', String(query.limit));
        return request<LogsResult>('GET', `/v1/admin/logs${qs.toString() ? `?${qs}` : ''}`, undefined, 20_000);
      },
      gateway: () => request<GatewayStatus>('GET', '/v1/admin/gateway', undefined, 20_000),
      gatewayReset: () => request<{ ok: boolean }>('POST', '/v1/admin/gateway/reset', {}, 20_000),
      restart: () => request<{ ok: boolean; message: string }>('POST', '/v1/admin/restart', { confirm: true }, 20_000),
    },
  };
}

export type YuiClient = ReturnType<typeof createClient>;
