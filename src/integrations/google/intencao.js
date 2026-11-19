// O PEDIDO DO DONO ao Google, reconhecido POR CÓDIGO (etapa 15): sem IA, só frases curtas e claras sobre a PRÓPRIA agenda, tarefas ou e-mails.
// Estrito de propósito: a frase inteira tem de ser o pedido ("o que tenho hoje na agenda?", "minhas tarefas", "o que tenho amanhã?", "compromissos da semana"),
// sem mais nada (nem menção a outra pessoa, nem link, nem várias linhas). Conversa comum ("a agenda do GTA", "me conta do meu dia") nunca é capturada.
//
//   classificarPedido(texto) -> null | { tipo: 'agenda', periodo: 'hoje'|'amanha'|'semana' } | { tipo: 'tarefas', periodo: null|'hoje'|'amanha'|'semana' } | { tipo: 'email' }
//
// O texto que vem para cá é o da PRÓPRIA pessoa (a fala do autor), nunca o prompt montado nem texto de anexo.
const MAX_CHARS = 140;
const MAX_PALAVRAS = 10;

/** Palavras de enfeite que não mudam o pedido ("me diz", "por favor", "o", "na", "minha"...). */
const ENFEITE = new Set([
  'yui', 'oi', 'ola', 'ai', 'entao', 'por', 'favor', 'pfv', 'pf', 'me', 'diz', 'diga', 'fala', 'fale', 'mostra', 'mostre', 'manda', 'mande', 'conta', 'conte',
  'lista', 'liste', 've', 'veja', 'ver', 'pode', 'poderia', 'voce', 'queria', 'quero', 'gostaria', 'saber', 'sao', 'e',
  'o', 'os', 'a', 'as', 'um', 'uma', 'meu', 'meus', 'minha', 'minhas', 'de', 'do', 'da', 'dos', 'das', 'na', 'no', 'nas', 'nos', 'em', 'para', 'pra', 'pro', 'eu', 'la',
]);

const NUCLEO_AGENDA = new Set(['agenda', 'compromisso', 'compromissos', 'reuniao', 'reunioes', 'evento', 'eventos']);
const SOBRA_AGENDA = new Set(['que', 'tenho', 'tem', 'ha', 'existe', 'quais', 'algum', 'alguma', 'agenda', 'compromisso', 'compromissos', 'reuniao', 'reunioes', 'evento', 'eventos']);
const NUCLEO_TAREFAS = new Set(['tarefa', 'tarefas', 'afazeres']);
const SOBRA_TAREFAS = new Set(['que', 'tenho', 'tem', 'ha', 'quais', 'pendente', 'pendentes', 'fazer', 'tarefa', 'tarefas', 'afazeres', 'alguma', 'ainda']);
const NUCLEO_EMAIL = new Set(['email', 'emails']);
const SOBRA_EMAIL = new Set(['tenho', 'tem', 'algum', 'alguma', 'novo', 'novos', 'nova', 'novas', 'email', 'emails', 'ler', 'leia', 'ultimo', 'ultimos', 'ultima', 'ultimas', 'recente', 'recentes', 'quais', 'chegou', 'chegaram', 'que', 'caixa', 'entrada', 'inbox', 'novidade', 'novidades']);

function normalizar(texto) {
  return String(texto ?? '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase()
    .replace(/\be[\s-]+mails?\b/g, (m) => (m.endsWith('s') ? 'emails' : 'email'))
    .replace(/[^a-z0-9]+/g, ' ').trim();
}

/** Tira a janela ("hoje", "amanhã", "essa semana", "da semana", "próximos dias") e diz qual era. */
function extrairPeriodo(s) {
  if (/\bamanha\b/.test(s)) return { periodo: 'amanha', resto: s.replace(/\bamanha\b/g, ' ') };
  if (/\b(?:(?:essa|esta|nessa|nesta|dessa|desta|na|da|nos)\s+)?semana\b|\bproximos dias\b/.test(s)) {
    return { periodo: 'semana', resto: s.replace(/\b(?:(?:essa|esta|nessa|nesta|dessa|desta|na|da|nos)\s+)?semana\b|\bproximos dias\b/g, ' ') };
  }
  if (/\bhoje\b/.test(s)) return { periodo: 'hoje', resto: s.replace(/\bhoje\b/g, ' ') };
  return { periodo: null, resto: s };
}

const soDe = (palavras, permitidas) => palavras.every((p) => permitidas.has(p));
const temUma = (palavras, nucleo) => palavras.some((p) => nucleo.has(p));

/** Reconhece o pedido (ou null). */
export function classificarPedido(textoOriginal) {
  let original = String(textoOriginal ?? '').trim();
  if (!original || original.length > MAX_CHARS || /[\r\n]/.test(original)) return null;
  original = original.replace(/^(?:<@!?\d{5,25}>[\s,:;-]*)+/, '').trim(); // "@Yui, ..." (a menção ao bot no começo)
  if (!original || /[<>]|https?:|www\./i.test(original)) return null;
  const { periodo, resto } = extrairPeriodo(normalizar(original));
  const palavras = resto.split(/\s+/).filter((p) => p && !ENFEITE.has(p));
  if (!palavras.length || resto.split(/\s+/).length > MAX_PALAVRAS) return null;
  // Agenda: tem um núcleo (agenda, compromissos...) e só palavras do pedido; ou "o que tenho <hoje|amanhã|semana>" com a janela dita.
  if (temUma(palavras, NUCLEO_AGENDA) && soDe(palavras, SOBRA_AGENDA)) return { tipo: 'agenda', periodo: periodo ?? 'hoje' };
  if (periodo && soDe(palavras, new Set(['que', 'tenho'])) && palavras.includes('que') && palavras.includes('tenho')) return { tipo: 'agenda', periodo };
  // Tarefas: tem um núcleo (tarefas, afazeres) ou "o que tenho para fazer".
  if (temUma(palavras, NUCLEO_TAREFAS) && soDe(palavras, SOBRA_TAREFAS)) return { tipo: 'tarefas', periodo };
  if (soDe(palavras, new Set(['que', 'tenho', 'fazer'])) && palavras.includes('tenho') && palavras.includes('fazer')) return { tipo: 'tarefas', periodo };
  // E-mails.
  if (!periodo && temUma(palavras, NUCLEO_EMAIL) && soDe(palavras, SOBRA_EMAIL)) return { tipo: 'email' };
  if (!periodo && palavras.includes('caixa') && palavras.includes('entrada') && soDe(palavras, SOBRA_EMAIL)) return { tipo: 'email' };
  return null;
}
