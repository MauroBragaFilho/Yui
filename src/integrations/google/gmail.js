// O GMAIL, SOMENTE LEITURA e TRAVADO (etapa 15): o código mínimo de listar e ler mensagens (gmail.readonly) existe, mas NUNCA roda sem as DUAS condições:
//   1. a chave YUI_GOOGLE_GMAIL=true (padrão: false), com o Google ligado; e
//   2. a rota privada de IA VALIDADA (`estadoDaRotaPrivada().estado === 'validada'`): o conteúdo de um e-mail é o dado mais sensível que a Yui poderia ler, e só
//      pode ir a um provedor autenticado, autorizado e verificado. Hoje o perfil privado está desligado: então o Gmail NUNCA funciona.
// Falha FECHADA: sem as duas condições, nenhuma chamada ao Google é feita (o e-mail nem é baixado), nada entra no prompt e a Yui responde uma frase curta.
// O texto de um e-mail é DADO não confiável (veja dados.js).
import { estadoDaRotaPrivada } from '../../core/ai/rotaPerfil.js';
import { hostsDoGoogle } from './endpoints.js';
import { lerDoGoogle } from './cliente.js';
import { portaoDoRecurso, FRASE_GMAIL_SEM_ROTA } from './portao.js';

export const FRASE_SEM_ROTA = FRASE_GMAIL_SEM_ROTA; // 'Ainda não leio e-mails: falta a rota privada de IA.'
export const FRASE_GMAIL_DESLIGADO = 'Ainda não leio e-mails: essa parte está desligada.';
export const MAX_MENSAGENS = 10;
const MAX_CORPO = 4000;
const ID_RE = /^[0-9a-f]{8,32}$/i;

/**
 * O Gmail está liberado agora? { liberado, motivo: 'ok' | 'chave-desligada' | 'sem-rota-privada' }. A rota privada é consultada AQUI, a cada uso (ela pode ser bloqueada a qualquer momento).
 * O Gmail NUNCA tem exceção: nem a YUI_GOOGLE_SEM_ROTA_PRIVADA (que vale só para a Agenda e as Tarefas) o dispensa (portao.js).
 */
export function gmailLiberado({ env = process.env, estadoDaRota = estadoDaRotaPrivada } = {}) {
  return portaoDoRecurso({ recurso: 'gmail', env, estadoDaRota });
}

/** A frase curta para cada motivo de o Gmail estar fechado. */
export function fraseDoGmailFechado(motivo) {
  return motivo === 'chave-desligada' ? FRASE_GMAIL_DESLIGADO : FRASE_SEM_ROTA;
}

const cabecalho = (headers, nome) => {
  const h = Array.isArray(headers) ? headers.find((x) => String(x?.name ?? '').toLowerCase() === nome) : null;
  return typeof h?.value === 'string' ? h.value.slice(0, 300) : '';
};

/**
 * As mensagens mais recentes da caixa de entrada: remetente, assunto, data e o trecho que o Gmail devolve. Só cabeçalhos: o corpo não é baixado aqui.
 * @returns {Promise<{ ok: true, mensagens: object[], truncado: boolean } | { ok: false, motivo: string }>}
 */
export async function listarMensagens({ autenticador, env = process.env, estadoDaRota = estadoDaRotaPrivada, fetchImpl, hosts = hostsDoGoogle, max = MAX_MENSAGENS, consulta = 'in:inbox', timeoutMs }) {
  const gate = gmailLiberado({ env, estadoDaRota });
  if (!gate.liberado) return { ok: false, motivo: gate.motivo };
  const lista = await lerDoGoogle({
    autenticador, recurso: 'gmail', fetchImpl, timeoutMs,
    url: `${hosts().gmail}/users/me/messages?${new URLSearchParams({ maxResults: String(max + 1), q: String(consulta).slice(0, 200), fields: 'messages(id)' })}`,
  });
  if (!lista.ok) return lista;
  const ids = (Array.isArray(lista.json?.messages) ? lista.json.messages : []).map((m) => String(m?.id ?? '')).filter((id) => ID_RE.test(id));
  const truncado = ids.length > max;
  const mensagens = [];
  for (const id of ids.slice(0, max)) {
    const q = new URLSearchParams({ format: 'metadata', fields: 'id,snippet,payload/headers' });
    for (const h of ['From', 'Subject', 'Date']) q.append('metadataHeaders', h);
    const m = await lerDoGoogle({ autenticador, recurso: 'gmail', fetchImpl, timeoutMs, url: `${hosts().gmail}/users/me/messages/${id}?${q}` });
    if (!m.ok) return m;
    const hs = m.json?.payload?.headers;
    mensagens.push({ id, de: cabecalho(hs, 'from'), assunto: cabecalho(hs, 'subject') || '(sem assunto)', data: cabecalho(hs, 'date'), trecho: typeof m.json?.snippet === 'string' ? m.json.snippet.slice(0, 300) : '' });
  }
  return { ok: true, mensagens, truncado };
}

function textoDoCorpo(parte, fundo = 0) {
  if (!parte || typeof parte !== 'object' || fundo > 6) return '';
  if (parte.mimeType === 'text/plain' && typeof parte.body?.data === 'string') {
    try { return Buffer.from(parte.body.data, 'base64url').toString('utf8'); } catch { return ''; }
  }
  for (const p of Array.isArray(parte.parts) ? parte.parts : []) {
    const t = textoDoCorpo(p, fundo + 1);
    if (t) return t;
  }
  return '';
}

/** Lê UMA mensagem (o texto simples, cortado). Mesmas travas de listarMensagens. */
export async function lerMensagem({ autenticador, id, env = process.env, estadoDaRota = estadoDaRotaPrivada, fetchImpl, hosts = hostsDoGoogle, timeoutMs }) {
  const gate = gmailLiberado({ env, estadoDaRota });
  if (!gate.liberado) return { ok: false, motivo: gate.motivo };
  if (!ID_RE.test(String(id ?? ''))) return { ok: false, motivo: 'erro' };
  const m = await lerDoGoogle({ autenticador, recurso: 'gmail', fetchImpl, timeoutMs, url: `${hosts().gmail}/users/me/messages/${id}?${new URLSearchParams({ format: 'full', fields: 'id,snippet,payload(headers,mimeType,body/data,parts)' })}` });
  if (!m.ok) return m;
  const hs = m.json?.payload?.headers;
  const corpo = textoDoCorpo(m.json?.payload) || (typeof m.json?.snippet === 'string' ? m.json.snippet : '');
  return { ok: true, mensagem: { id, de: cabecalho(hs, 'from'), assunto: cabecalho(hs, 'subject') || '(sem assunto)', data: cabecalho(hs, 'date'), corpo: corpo.slice(0, MAX_CORPO) } };
}
