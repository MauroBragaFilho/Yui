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

// ANIVERSÁRIOS (A4): "quando é o próximo aniversário?", "tem aniversário hoje?", "aniversários do mês". Frase inteira só com estas palavras (nome de pessoa fica de fora de propósito).
const PERMITIDAS_ANIVERSARIO = new Set([
  'aniversario', 'aniversarios', 'aniversariante', 'aniversariantes', 'quando', 'e', 'o', 'a', 'os', 'as', 'um', 'uma', 'proximo', 'proximos', 'proxima', 'proximas', 'tem', 'tenho', 'algum', 'alguns',
  'alguma', 'quais', 'qual', 'sao', 'ha', 'existe', 'que', 'meu', 'meus', 'minha', 'minhas', 'de', 'do', 'da', 'dos', 'das', 'no', 'na', 'nos', 'nas', 'calendario', 'agenda', 'esse', 'este', 'nesse',
  'neste', 'essa', 'esta', 'nesta', 'dessa', 'desta', 'desse', 'deste', 'mes', 'semana', 'hoje', 'amanha', 'yui', 'me', 'diz', 'diga', 'fala', 'fale', 'mostra', 'mostre', 'lista', 'liste', 'por', 'favor',
  'pode', 'poderia', 'voce', 'queria', 'quero', 'gostaria', 'saber', 'ver', 'veja', 'la', 'em', 'amigos', 'contatos', 'ai', 'oi', 'entao',
]);

function classificarAniversario(norm) {
  if (!/\baniversari/.test(norm)) return null;
  const palavras = norm.split(/\s+/).filter(Boolean);
  if (palavras.length > 12 || !palavras.every((p) => PERMITIDAS_ANIVERSARIO.has(p))) return null;
  const periodo = palavras.includes('amanha') ? 'amanha' : palavras.includes('semana') ? 'semana' : palavras.includes('mes') ? 'mes' : palavras.includes('hoje') ? 'hoje' : 'ano';
  return { tipo: 'aniversarios', periodo };
}

/** Quanto tempo uma consulta ao Google ainda vale como "assunto" para uma continuação ("e amanhã?"). */
export const VALIDADE_CONTINUACAO_MS = 10 * 60_000;
const SOBRA_CONTINUACAO = new Set(['agenda', 'compromisso', 'compromissos', 'reuniao', 'reunioes', 'evento', 'eventos', 'tarefa', 'tarefas', 'afazeres', 'aniversario', 'aniversarios', 'proximo', 'proximos', 'dias', 'dia', 'que', 'tenho']);

/**
 * A CONTINUAÇÃO de uma consulta recente ("e nesta semana?", "e amanhã?", "e as tarefas?"). `ultimo` = { tipo, periodo, em } da última consulta que a Yui fez ao Google
 * para a mesma pessoa, ou null. Sem consulta recente (10 min) nada é reconhecido: a frase segue como conversa. E-mail nunca continua.
 * @returns {null | { tipo: 'agenda'|'tarefas'|'aniversarios', periodo: string|null }}
 */
export function classificarContinuacao(textoOriginal, ultimo, agora = Date.now()) {
  if (!ultimo || !['agenda', 'tarefas', 'aniversarios'].includes(ultimo.tipo)) return null;
  const idade = agora - Number(ultimo.em);
  if (!Number.isFinite(idade) || idade < 0 || idade > VALIDADE_CONTINUACAO_MS) return null;
  let original = String(textoOriginal ?? '').trim();
  if (!original || original.length > 60 || /[\r\n]/.test(original)) return null;
  original = original.replace(/^(?:<@!?\d{5,25}>[\s,:;-]*)+/, '').trim();
  if (!original || /[<>]|https?:|www\./i.test(original)) return null;
  let norm = normalizar(original).replace(/^yui /, '');
  if (!/^e /.test(norm)) return null;
  norm = norm.slice(2);
  const { periodo, resto } = extrairPeriodo(norm);
  const palavras = resto.split(/\s+/).filter((p) => p && !ENFEITE.has(p));
  if (palavras.length > 4 || !soDe(palavras, SOBRA_CONTINUACAO)) return null;
  if (temUma(palavras, NUCLEO_TAREFAS)) return { tipo: 'tarefas', periodo };
  if (temUma(palavras, NUCLEO_AGENDA)) return { tipo: 'agenda', periodo: periodo ?? (ultimo.tipo === 'agenda' ? ultimo.periodo : 'hoje') };
  if (palavras.some((p) => p.startsWith('aniversari'))) return { tipo: 'aniversarios', periodo: periodo ?? 'ano' };
  // Sem assunto novo ("e amanhã?"): vale o assunto da consulta anterior, mas só com uma janela dita.
  if (!palavras.length && periodo) return { tipo: ultimo.tipo, periodo };
  return null;
}

const CRIAR_OU_MEXER = /\b(coloca|colocar|coloque|anota|anotar|anote|adiciona|adicionar|adicione|cria|criar|crie|marca|marcar|marque|agende|agendar|lembra|lembre|lembrar|lembrete|apaga|apagar|cancela|cancelar|remove|remover|exclui|excluir)\b/;
const FALA_DA_AGENDA = /\b(?:minha|meu|meus|minhas)\s+(?:agenda|calendario|compromissos?|tarefas?|aniversarios?)\b|\bna\s+minha\s+agenda\b|\b(?:tarefas|compromissos|aniversarios)\s+(?:minhas|meus)\b/;
// Negação ("não quero consultar minha agenda") e fala de OUTRA pessoa citada ("meu amigo perguntou: qual é o meu compromisso...?") não são pedido do dono: ambiguidade = não orienta.
const NEGACAO = /\b(?:nao|nunca|sem|jamais)\b/;
const FALA_CITADA = /\b(?:perguntou|pergunta|disse|diz|falou|pediu|mandou|escreveu|respondeu|contou|quer saber)\b|["“”«»':]/;
const COM_JEITO_DE_PERGUNTA = /\?|^(?:yui )?(?:o que|quais|qual|quando|tem|tenho|ha|existe|como esta|me (?:mostra|mostre|diz|diga|fala|fale|conta)|mostra|mostre|ver|veja)\b/;

/**
 * A frase PARECE uma pergunta sobre a PRÓPRIA agenda, tarefas ou aniversários, mas não é um dos pedidos curtos reconhecidos (para a Yui orientar em vez de deixar o modelo
 * inventar ou dizer "não tenho acesso"). Nunca é pedido de criar/mudar nada. Só para uma pergunta curta de uma linha.
 */
export function pareceAgendaNaoReconhecida(textoOriginal) {
  const original = String(textoOriginal ?? '').trim();
  if (!original || original.length > 120 || /[\r\n]/.test(original) || /[<>]|https?:|www\./i.test(original.replace(/^(?:<@!?\d{5,25}>[\s,:;-]*)+/, ''))) return false;
  const norm = normalizar(original.replace(/^(?:<@!?\d{5,25}>[\s,:;-]*)+/, ''));
  if (CRIAR_OU_MEXER.test(norm) || NEGACAO.test(norm) || FALA_CITADA.test(original.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, ''))) return false;
  return FALA_DA_AGENDA.test(norm) && COM_JEITO_DE_PERGUNTA.test(original.toLowerCase().normalize('NFD').replace(/[̀-ͯ]/g, '').trim());
}

/** Reconhece o pedido (ou null). */
export function classificarPedido(textoOriginal) {
  let original = String(textoOriginal ?? '').trim();
  if (!original || original.length > MAX_CHARS || /[\r\n]/.test(original)) return null;
  original = original.replace(/^(?:<@!?\d{5,25}>[\s,:;-]*)+/, '').trim(); // "@Yui, ..." (a menção ao bot no começo)
  if (!original || /[<>]|https?:|www\./i.test(original)) return null;
  const aniversario = classificarAniversario(normalizar(original));
  if (aniversario) return aniversario;
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
