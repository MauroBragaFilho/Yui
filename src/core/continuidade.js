// Continuidade (projetos e decisões do dono), YUI_CONTINUIDADE=true (padrão: desligado).
//
// Usado pela DM do dono (llmHandler) e pelo chat do app (API). Nada é gravado direto: o pedido EXPLÍCITO vira uma proposta com o
// texto exato, e só um "sim" sozinho grava. Qualquer outra mensagem descarta a proposta (um "sim" depois não grava nada).
// A proposta fica em RAM, vale 2 minutos e é presa à interface onde nasceu ('dm' ou 'app').
//
// Regras: só o DONO, memória pessoal e conversa privada 1:1 (nunca servidor, call ou voz). Quem chama só passa a fala do próprio
// autor (nunca texto de terceiros ou citação). Módulo sem Discord e sem rede: a memória entra por parâmetro.
import { ROLES, MEMORY_SCOPES, CHANNEL_KINDS } from './permissions.js';

export const VALIDADE_MS = 2 * 60 * 1000;
const MAX_PEDIDO = 600;
const MAX_CONTEUDO = 500;
const MAX_LISTA = 1800;
const MAX_LINHA = 180;
const TIPOS = ['project', 'decision'];

export function continuidadeLigada(env = process.env) {
  return String(env?.YUI_CONTINUIDADE ?? '').trim().toLowerCase() === 'true';
}

/** Só o dono, na memória pessoal e numa conversa 1:1 (DM do Discord ou o app, que equivale a uma DM). */
export function podeContinuidade(ctx) {
  return Boolean(ctx?.userId) && ctx.role === ROLES.OWNER && ctx.memoryScope === MEMORY_SCOPES.PERSONAL && ctx.channelKind === CHANNEL_KINDS.DM;
}

const semAcento = (t) => String(t).normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();

/** Tira a menção e o nome da Yui do começo. */
function limpar(texto) {
  return String(texto ?? '').normalize('NFC').replace(/^\s*(?:<@!?\d+>\s*)+/, '').trim()
    .replace(/^@?yui\b[\s,:!-]*/i, '').trim();
}

const PEDIDOS = [
  { re: /^registr[ae]\s+(?:a\s+|essa\s+|esta\s+|uma\s+)?decis[aã]o\s*:\s*(.+)$/i, type: 'decision', conteudo: (m) => m[1] },
  { re: /^((?:n[oó]s\s+)?decid(?:imos|i)\s+que\s+.+)$/i, type: 'decision', livre: true, conteudo: (m) => m[1] },
  { re: /^novo\s+projeto\s*:\s*(.+)$/i, type: 'project', livre: true, conteudo: (m) => m[1] },
  { re: /^registr[ae]\s+no\s+projeto\s+([^:]{1,60}?)\s*:\s*(.+)$/i, type: 'project', conteudo: (m) => `Projeto ${m[1].trim()}: ${m[2].trim()}` },
];

// "decidi que ..., me indica ..." é pedido de ajuda, não registro: o pedido abre a frase ou uma oração dela.
const PEDE_AJUDA_RE = /(?:^|[,.;:!]\s*|\s(?:e|mas|entao|agora)\s+)(?:(?:e|mas|entao|agora|por favor)\s+)?(?:me\s+(?:ajud[ae]|indi(?:ca|que)|pass[ae]|diz|diga|da|de|expli(?:ca|que)|sugere|sugira|mand[ae]|ensin[ae]|recomend[ae]|fala|fale|cont[ae]|mostr[ae]|faz|faca)|(?:voce )?(?:pode|poderia) me|preciso de (?:ajuda|dicas?)|quero (?:ajuda|dicas?)|ajud[ae][ -]me)\b/;

const CONSULTAS = [
  { re: /^(?:quais (?:sao )?(?:os )?meus projetos|(?:lista|liste|mostra|mostre) (?:os )?meus projetos)\s*[?.!]*$/, type: 'project' },
  { re: /^(?:quais (?:sao )?(?:as )?(?:minhas )?decisoes(?: (?:que )?(?:eu )?(?:ja )?registrei)?|quais (?:sao )?(?:as )?minhas decisoes|(?:lista|liste|mostra|mostre) (?:as )?minhas decisoes)\s*[?.!]*$/, type: 'decision' },
];

const SIM_RE = /^(?:sim(?:[\s,]+(?:pode|pode guardar|pode registrar|confirmo|guarda|guardar|registra))?|confirmo|pode guardar|pode registrar)[\s.!]*$/;
const NAO_RE = /^(?:nao(?:[\s,]+(?:obrigado|guarda|guarde|registra|registre|precisa))?|cancela|cancelar|cancele|deixa|deixa pra la)[\s.!]*$/;

/**
 * Pedido explícito, conservador (ancorado no começo, uma linha só, sem pergunta).
 * @returns {null | {kind:'propor', type:'project'|'decision', content:string} | {kind:'longo'} | {kind:'listar', type:string}}
 */
export function detectarPedido(texto) {
  const t = limpar(texto);
  if (!t || t.length > MAX_PEDIDO || /[\r\n]/.test(t)) return null;
  const dobrado = semAcento(t);
  const consulta = CONSULTAS.find((c) => c.re.test(dobrado));
  if (consulta) return { kind: 'listar', type: consulta.type };
  if (t.includes('?')) return null;
  for (const p of PEDIDOS) {
    const m = t.match(p.re);
    if (!m) continue;
    const content = p.conteudo(m).replace(/\s+/g, ' ').trim();
    if (content.length < 3) return null;
    // Só nas formas de fala corrente; "registra ...:" é ordem explícita.
    if (p.livre && PEDE_AJUDA_RE.test(semAcento(content))) return null;
    return content.length > MAX_CONTEUDO ? { kind: 'longo' } : { kind: 'propor', type: p.type, content };
  }
  return null;
}

const pendentes = new Map(); // `${interface}:${userId}` -> { type, content, ate }
const chave = (interfaceId, userId) => `${interfaceId}:${userId}`;

/** Descarta a proposta desta pessoa (sem `interfaceId`, a de todas as interfaces). */
export function descartarContinuidade(userId, interfaceId = null) {
  for (const i of interfaceId ? [interfaceId] : ['dm', 'app']) pendentes.delete(chave(i, userId));
}
export function __resetContinuidadeForTests() { pendentes.clear(); }

/**
 * Para a porta de entrada das mensagens: o que não for "sim"/"não" sozinho descarta a proposta, mesmo que a mensagem nunca chegue a
 * `rotearContinuidade` (comando por prefixo, anexo, fila recusada).
 */
export function observarMensagem(userId, interfaceId, text, { comAnexo = false } = {}) {
  const dito = semAcento(limpar(text));
  if (comAnexo || !(SIM_RE.test(dito) || NAO_RE.test(dito))) descartarContinuidade(userId, interfaceId);
}

const nome = (type) => (type === 'project' ? 'projeto' : 'decisão');
const resposta = (kind, text) => ({ handled: true, kind, text });
const NAO_TRATADO = Object.freeze({ handled: false });

async function listar(ctx, memory, type) {
  const rows = (await memory.listMemories(ctx, { limit: 500 })).filter((r) => r.type === type);
  const titulo = type === 'project' ? 'Seus projetos' : 'Suas decisões';
  if (!rows.length) {
    return type === 'project'
      ? 'Você ainda não registrou nenhum projeto. Para registrar: "novo projeto: nome do projeto".'
      : 'Você ainda não registrou nenhuma decisão. Para registrar: "registra a decisão: o que foi decidido".';
  }
  const linhas = [];
  let usado = 0;
  for (const r of rows) {
    const linha = `#${r.id} - ${String(r.content).replace(/\s+/g, ' ').trim().slice(0, MAX_LINHA)}`;
    if (usado + linha.length + 1 > MAX_LISTA) break;
    linhas.push(linha);
    usado += linha.length + 1;
  }
  const resto = rows.length - linhas.length;
  return `${titulo}:\n${linhas.join('\n')}${resto > 0 ? `\n(mais ${resto} não exibido(s))` : ''}\nPara apagar: "esquece a lembrança #número".`;
}

/**
 * Trata a mensagem. `handled:false` = segue o fluxo normal. Nunca lança.
 * `semProposta`: a mensagem tem anexo ou não é só texto do autor: não confirma nem cria nada (e descarta a proposta pendente).
 * @returns {Promise<{handled:false} | {handled:true, kind:string, text:string}>}
 */
export async function rotearContinuidade({ text, ctx, interfaceId, memory, enabled = false, semProposta = false, env = process.env, now = Date.now() } = {}) {
  if (!continuidadeLigada(env) || !podeContinuidade(ctx)) return NAO_TRATADO;
  const k = chave(interfaceId, ctx.userId);
  const pendente = pendentes.get(k);
  pendentes.delete(k); // qualquer mensagem consome a proposta
  if (semProposta) return NAO_TRATADO;
  const dito = semAcento(limpar(text));
  try {
    if (pendente && now <= pendente.ate) {
      if (SIM_RE.test(dito)) {
        if (!enabled) return resposta('desativada', 'A memória está desativada no momento; não guardei nada.');
        const r = await memory.remember(ctx, { type: pendente.type, content: pendente.content, source: 'continuidade', importance: 4 });
        if (r?.deduplicated) return resposta('gravado', 'Esse texto já estava guardado na sua memória; só renovei o registro.');
        return resposta('gravado', `Guardei como ${nome(pendente.type)}: "${pendente.content}"`);
      }
      if (NAO_RE.test(dito)) return resposta('descartado', 'Certo, não guardei.');
    }
    const pedido = detectarPedido(text);
    if (!pedido) return NAO_TRATADO;
    if (!enabled) return resposta('desativada', 'A memória está desativada no momento; não guardei nada.');
    if (pedido.kind === 'listar') return resposta('lista', await listar(ctx, memory, pedido.type));
    if (pedido.kind === 'longo') return resposta('longo', `Esse texto passa de ${MAX_CONTEUDO} caracteres. Resuma e peça de novo; não guardei nada.`);
    pendentes.set(k, { type: pedido.type, content: pedido.content, ate: now + VALIDADE_MS });
    return resposta('proposta', `Vou guardar como ${nome(pedido.type)} exatamente este texto:\n"${pedido.content}"\nPosso guardar? Responda sim ou não.`);
  } catch (_) {
    return resposta('erro', 'Não consegui mexer na sua memória agora. Tente de novo daqui a pouco.');
  }
}

const ASSUNTO_RE = /\b(?:projetos?|decisao|decisoes|decidi|decidimos|decidiu)\b/;
const TETO_NO_PROMPT = 5;

/** A fala é sobre projeto ou decisão? (usado pelo bloco de memória do prompt) */
export function falaDeContinuidade(texto) {
  return ASSUNTO_RE.test(semAcento(texto ?? ''));
}

/** Acrescenta os projetos e decisões mais recentes ao que o recall achou, sem repetir e com teto. */
export function juntarContinuidade(achadas, todas) {
  const vistos = new Set(achadas.map((r) => r.id));
  const recentes = todas.filter((r) => TIPOS.includes(r.type)).slice(0, TETO_NO_PROMPT).filter((r) => !vistos.has(r.id));
  return [...achadas, ...recentes];
}
