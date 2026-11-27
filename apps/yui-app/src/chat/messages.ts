import type { AgentReply } from '../api/client.ts';

/** Lógica pura das mensagens do chat (sem React), para ser testada em Node. */

export type PendingStatus = 'waiting' | 'approved' | 'cancelled' | 'expired';

/** Imagem gerada pela Yui (lacunas do painel, item 11): endereço completo do link curto, texto alternativo e quando o link vence. */
export interface ChatImage { uri: string; alt: string; expiresAt: number }

export interface ChatMessage {
  id: string;
  role: 'user' | 'yui' | 'system';
  text: string;
  /** Como a Yui produziu a mensagem (usado para o estilo do balão). */
  kind?: 'reply' | 'tool_result' | 'denied' | 'error' | 'confirmation';
  tool?: string;
  /** Ação aguardando confirmação do usuário. */
  pending?: { id: string; status: PendingStatus };
  /** Imagem gerada pelo chat (o link curto do servidor; vence em minutos). */
  image?: ChatImage;
  /** O limite de imagens por hora barrou o pedido: o balão mostra o aviso. */
  imageLimit?: { minutes: number };
  createdAt: number;
}

/** O único formato de link de imagem aceito do servidor: caminho relativo, código curto (nunca um caminho de arquivo nem outro site). */
export const IMAGE_PATH_RE = /^\/v1\/imagem\/[A-Za-z0-9_-]{16,64}$/;
/** Sem prazo informado, o app assume o do servidor (10 min). */
export const IMAGE_DEFAULT_TTL_SEC = 600;
export const IMAGE_ALT_MAX = 160;

/**
 * A imagem da resposta do agente, pronta para a tela. Recusa (null) o que não for o caminho curto do servidor ou endereço base que não seja http(s):
 * a tela nunca abre um endereço que o servidor não emitiu daquele jeito.
 */
export function imageFromReply(reply: Pick<AgentReply, 'imagem'> | null | undefined, baseUrl: string | null | undefined, now = Date.now()): ChatImage | null {
  const img = reply?.imagem;
  if (!img || typeof img.url !== 'string' || !IMAGE_PATH_RE.test(img.url)) return null;
  const base = String(baseUrl ?? '').replace(/\/+$/, '');
  if (!/^https?:\/\/[^/\s]+(\/[^\s?#]*)?$/i.test(base)) return null;
  const ttl = typeof img.expiresInSec === 'number' && Number.isFinite(img.expiresInSec) && img.expiresInSec > 0 ? Math.min(img.expiresInSec, 3600) : IMAGE_DEFAULT_TTL_SEC;
  const alt = String(img.alt ?? '').replace(/\s+/g, ' ').trim().slice(0, IMAGE_ALT_MAX) || 'Imagem gerada pela Yui';
  return { uri: `${base}${img.url}`, alt, expiresAt: now + ttl * 1000 };
}

/** O link da imagem já venceu? (a tela troca a imagem pelo texto alternativo e um aviso). */
export function imageExpired(image: ChatImage | null | undefined, now = Date.now()): boolean {
  return !image || now >= image.expiresAt;
}

/** O aviso do limite de imagens por hora, em português simples. */
export function imageLimitText(limit: { minutes: number } | null | undefined): string | null {
  if (!limit) return null;
  const m = Math.max(1, Math.round(Number(limit.minutes) || 60));
  return `Limite de imagens por hora atingido. Tente de novo em ${m} min.`;
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

/**
 * Converte a resposta do /v1/agent em uma mensagem do chat. `baseUrl` (o endereço do servidor) só é usado para a imagem do chat, quando vem
 * (o link curto é relativo); sem ele a imagem não aparece, só o texto.
 */
export function fromAgentReply(reply: AgentReply, now = Date.now(), baseUrl?: string): ChatMessage {
  const image = imageFromReply(reply, baseUrl, now);
  const limit = reply.limiteImagem && Number.isFinite(Number(reply.limiteImagem.minutos)) ? { minutes: Math.max(1, Math.round(Number(reply.limiteImagem.minutos))) } : null;
  const base = { id: newId(), role: 'yui' as const, text: reply.reply, createdAt: now, ...(image ? { image } : {}), ...(limit ? { imageLimit: limit } : {}) };
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

/** A imagem guardada só volta se tiver a forma certa (endereço http(s) terminando no caminho curto); senão sai da mensagem e fica o texto. */
function storedImage(img: unknown): ChatImage | null {
  const i = img as Partial<ChatImage> | null;
  if (!i || typeof i.uri !== 'string' || typeof i.alt !== 'string' || typeof i.expiresAt !== 'number') return null;
  const m = /^(https?:\/\/[^\s?#]+?)(\/v1\/imagem\/[A-Za-z0-9_-]{16,64})$/i.exec(i.uri);
  return m && IMAGE_PATH_RE.test(m[2]) ? { uri: i.uri, alt: i.alt.slice(0, IMAGE_ALT_MAX), expiresAt: i.expiresAt } : null;
}

/** Restaura o histórico salvo, descartando entradas inválidas. */
export function parseStoredHistory(raw: string | null): ChatMessage[] {
  if (!raw) return [];
  try {
    const data = JSON.parse(raw);
    if (!Array.isArray(data)) return [];
    return trimHistory(
      data
        .filter(
          (m) =>
            m && typeof m.id === 'string' && typeof m.text === 'string' &&
            (m.role === 'user' || m.role === 'yui' || m.role === 'system') &&
            typeof m.createdAt === 'number'
        )
        .map((m) => {
          if (m.image === undefined) return m;
          const image = storedImage(m.image);
          const { image: _fora, ...resto } = m;
          return image ? { ...resto, image } : resto;
        })
    );
  } catch {
    return [];
  }
}
