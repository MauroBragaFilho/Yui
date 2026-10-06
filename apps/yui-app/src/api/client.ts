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
}

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
}

function messageForStatus(status: number, serverMessage?: string): string {
  if (status === 401) return 'Token inválido ou ausente.';
  if (status === 403) return 'Acesso negado para este usuário.';
  if (status === 429) return 'Muitas requisições. Aguarde um instante e tente de novo.';
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
  };
}

export type YuiClient = ReturnType<typeof createClient>;
