import type { AgentReply } from '../api/client.ts';

/** Lógica pura das mensagens do chat (sem React), para ser testada em Node. */

export type PendingStatus = 'waiting' | 'approved' | 'cancelled' | 'expired';

export interface ChatMessage {
  id: string;
  role: 'user' | 'yui' | 'system';
  text: string;
  /** Como a Yui produziu a mensagem (usado para o estilo do balão). */
  kind?: 'reply' | 'tool_result' | 'denied' | 'error' | 'confirmation';
  tool?: string;
  /** Ação aguardando confirmação do usuário. */
  pending?: { id: string; status: PendingStatus };
  createdAt: number;
}

export const MAX_HISTORY = 100;
/** A API invalida a confirmação após 2 minutos. */
export const CONFIRM_TTL_MS = 2 * 60 * 1000;

let counter = 0;
export function newId(): string {
  counter += 1;
  return `${Date.now().toString(36)}-${counter}`;
}

export function userMessage(text: string, now = Date.now()): ChatMessage {
  return { id: newId(), role: 'user', text, createdAt: now };
}

export function errorMessage(text: string, now = Date.now()): ChatMessage {
  return { id: newId(), role: 'system', kind: 'error', text, createdAt: now };
}

/** Converte a resposta do /v1/agent em uma mensagem do chat. */
export function fromAgentReply(reply: AgentReply, now = Date.now()): ChatMessage {
  const base = { id: newId(), role: 'yui' as const, text: reply.reply, createdAt: now };
  switch (reply.type) {
    case 'tool_result':
      return { ...base, kind: 'tool_result', tool: reply.tool };
    case 'denied':
      return { ...base, kind: 'denied', tool: reply.tool };
    case 'needs_confirmation':
      return {
        ...base,
        kind: 'confirmation',
        tool: reply.tool,
        pending: reply.pendingId ? { id: reply.pendingId, status: 'waiting' } : undefined,
      };
    default:
      return { ...base, kind: 'reply' };
  }
}

/** Atualiza o estado de uma confirmação pendente sem mutar a lista. */
export function resolvePending(list: ChatMessage[], pendingId: string, status: PendingStatus): ChatMessage[] {
  return list.map((m) => (m.pending && m.pending.id === pendingId ? { ...m, pending: { id: pendingId, status } } : m));
}

/** Marca como expiradas as confirmações antigas (a API as descarta em 2 min). */
export function expireStale(list: ChatMessage[], now = Date.now()): ChatMessage[] {
  let changed = false;
  const out = list.map((m) => {
    if (m.pending?.status === 'waiting' && now - m.createdAt > CONFIRM_TTL_MS) {
      changed = true;
      return { ...m, pending: { id: m.pending.id, status: 'expired' as const } };
    }
    return m;
  });
  return changed ? out : list;
}

export function trimHistory(list: ChatMessage[], max = MAX_HISTORY): ChatMessage[] {
  return list.length > max ? list.slice(list.length - max) : list;
}

/** Restaura o histórico salvo, descartando entradas inválidas. */
export function parseStoredHistory(raw: string | null): ChatMessage[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return trimHistory(
      data.filter(
        (m) =>
          m && typeof m.id === 'string' && typeof m.text === 'string' &&
          (m.role === 'user' || m.role === 'yui' || m.role === 'system') &&
          typeof m.createdAt === 'number'
      )
    );
  } catch {
    return [];
  }
}
