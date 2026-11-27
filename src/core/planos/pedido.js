// Planos com aprovação (Fase 3, parte 3B): a chave e o reconhecimento CONSERVADOR do pedido por conversa. Puro: sem imports.
export const planosLigados = (env = process.env) => String(env?.YUI_PLANOS ?? '').trim().toLowerCase() === 'true';

// Aprovação automática (padrão desligada): só vale junto com YUI_PLANOS e para plano inteiro de leituras marcadas com "auto".
export const planosAuto = (env = process.env) => String(env?.YUI_PLANOS_AUTO ?? '').trim().toLowerCase() === 'true';

// Aprovar e recusar pelo painel web (lacunas do painel, item 3 v2; padrão desligada). Sem ela a rota de decisão do painel responde 404 e a tela só mostra.
// As regras da decisão são as mesmas dos botões da DM (a mesma decidir() do serviço); esta chave só abre o segundo caminho até ela.
export const planosPeloPainel = (env = process.env) => String(env?.YUI_PLANOS_PAINEL ?? '').trim().toLowerCase() === 'true';

// A primeira linha de cada parte do resultado: quem monta contexto para a IA a partir do histórico do Discord pula essas mensagens
// (os dados lidos pelo plano não voltam a nenhum provedor). Só vale para mensagem da própria Yui.
export const MARCA_RESULTADO = '-# resultado de plano (não entra nas conversas com a IA)';
export const ehResultadoDePlano = (conteudo) => String(conteudo ?? '').startsWith(MARCA_RESULTADO);

const CHAMADA = /^yui\b[\s,:!-]*/i;
const VERBO = '(?:faz|faça|faca|monta|monte|cria|crie|prepara|prepare)\\s+(?:um\\s+)?';
const COM_APROVACAO = new RegExp(`^(?:${VERBO})?plano\\s+com\\s+aprova[cç][aã]o\\s*(?::|\\bpara\\b|\\bpra\\b)\\s*(.+)$`, 'i');
const COM_DOIS_PONTOS = new RegExp(`^${VERBO}plano\\s*:\\s*(.+)$`, 'i');
// "Só o plano": o pedido que quer o plano com os botões, sem execução automática.
const SO_O_PLANO = /^(?:(?:me\s+)?(?:faz|faça|faca|monta|monte|cria|crie|prepara|prepare)\s+)?(?:só|so|apenas|somente)\s+(?:o\s+|um\s+)?plano\s*(?::|\bpara\b|\bpra\b)\s*(.+)$/i;
const SEM_EXECUTAR = new RegExp(`^(?:${VERBO})?plano\\s+sem\\s+(?:executar|rodar)\\s*(?::|\\bpara\\b|\\bpra\\b)\\s*(.+)$`, 'i');
// Sinais AMPLOS no texto do pedido (sem acentos): negação, restrição, ordem no tempo ou controle do dono. Qualquer um deixa nos botões.
// Falso positivo é aceito de propósito ("só os de hoje" pede o botão): na dúvida não executa sozinho.
const RESSALVA = /\b(?:n|nn|nao|naum|nem|nunca|jamais|nada|sem|so|somente|apenas|antes|primeiro|depois|quando|ate|deix\w*|plan(?:o|os|ej\w*)|execu\w*|rod(?:a|e|ar|ando|em)|comec\w*|inici\w*|autoriz\w*|aprov\w*|confirm\w*|permi\w*|liber\w*|valid\w*|revis\w*|aguard\w*|esper[ae]\w*|pergunt\w*|mostr\w*|ok|okay|rascunho|simul\w*|previa|botao|botoes|eu (?:mando|mandar|disser|digo|decido|decidir|vejo|ver|quiser|pedir))\b/;
const semAcentos = (t) => t.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase();
const CANCELAR = /^(?:cancela|cancele|recusa|recuse)\s+(?:o\s+|meu\s+|o meu\s+)?plano\s*[.!]?$/i;
const SITUACAO = /^(?:como (?:est[aá]|anda)|status d[eo]|situa[cç][aã]o d[eo])\s+(?:o\s+|meu\s+|o meu\s+)?plano\s*[?.!]?$/i;
export const MAX_PEDIDO = 600;

/** { tipo: 'criar', pedido, soPlano } | { tipo: 'cancelar' } | { tipo: 'situacao' } | null. Só uma linha, começando pelo próprio pedido. */
export function pedidoDePlano(texto) {
  const t = String(texto ?? '').trim().replace(CHAMADA, '').trim();
  if (!t || t.length > MAX_PEDIDO + 60 || /[\r\n]/.test(t)) return null;
  if (CANCELAR.test(t)) return { tipo: 'cancelar' };
  if (SITUACAO.test(t)) return { tipo: 'situacao' };
  const soPlano = SO_O_PLANO.exec(t) ?? SEM_EXECUTAR.exec(t) ?? COM_APROVACAO.exec(t);
  const m = soPlano ?? COM_DOIS_PONTOS.exec(t);
  const pedido = m?.[1]?.trim() ?? '';
  return pedido.length >= 4 && pedido.length <= MAX_PEDIDO ? { tipo: 'criar', pedido, soPlano: Boolean(soPlano) || RESSALVA.test(semAcentos(pedido)) } : null;
}
