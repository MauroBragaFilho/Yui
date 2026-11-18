// O SELETOR DE PERFIL DE IA do cérebro (etapa 9, docs/RELATORIO_ETAPA9_PERFIS_IA.md).
//
// O cérebro escolhe o PERFIL (uma modalidade de execução: conversa, rapido, pesquisa, raciocinio, privado, visao) e o OmniRoute escolhe o provedor.
// Esta escolha é DETERMINÍSTICA: regras simples, sem chamar IA, sem ler rede nem disco (a configuração dos perfis já vem em memória): o mesmo
// pedido dá sempre o mesmo perfil. O seletor não sabe nada de pessoas: não recebe id, papel nem memória; recebe só o PONTO de chamada, se a chamada
// é privada, se tem imagem e um resumo do tamanho/aspecto do texto. Assim o pedido de uma pessoa nunca herda o perfil de outra.
//
// As regras, em ordem (a primeira que vale decide):
//  1. chamada PRIVADA (a do dono em DM, a que leva memória pessoal, texto de anexo...): perfil `privado`. Se o dono declarou o perfil privado, a chamada
//     SÓ vai por ele (se ele não estiver completo e verificado, ela falha fechada); se não declarou, `null` (o fluxo de hoje, que já nunca usa
//     provedor anônimo). A privacidade vence tudo: imagem e escalada não tiram uma chamada privada do `privado`;
//  2. IMAGEM anexada: `visao`;
//  3. o PONTO de chamada:
//       comentario (o comentário do /steam_jogo e do /converter_moeda), otimizador-busca (o otimizador da busca automática) e conversa-voz: `rapido`
//       sintese-pesquisa (a síntese do que a pesquisa achou): `pesquisa`
//       conversa (a conversa principal e o /yui): `conversa`, com a ESCALADA para `raciocinio` por sinais simples (veja sinaisDeEscalada);
//  4. perfil não configurado: `rapido`, `pesquisa` e `raciocinio` descem para `conversa`; `visao` segue a regra 3; `conversa` ausente = `null`
//     (o fluxo de hoje).
// Sem nenhum perfil configurado, devolve `null` em tudo: o fluxo de hoje continua EXATAMENTE igual (nenhum campo novo vai à chamada de IA).
import { perfisAtivos, privadoDeclarado } from '../core/ai/perfis.js';

export const PONTOS_DE_CHAMADA = Object.freeze(['conversa', 'conversa-voz', 'sintese-pesquisa', 'comentario', 'otimizador-busca']);

/** A resposta "o que fazer sem o perfil pedido": desce para a conversa. */
const DESCE_PARA = Object.freeze({ rapido: 'conversa', pesquisa: 'conversa', raciocinio: 'conversa' });

// ── A escalada para `raciocinio` (sinais simples, documentados e ajustáveis) ────────────────────────────────────────────────────────
// Ajustes: YUI_IA_ESCALADA = "on" (padrão: todos os sinais), "off" (desliga) ou uma lista "codigo,planejamento,contexto";
//          YUI_IA_ESCALADA_CONTEXTO_CHARS = a partir de quantos caracteres (histórico + pedido) o contexto conta como longo (padrão 8000).
export const SINAIS_DA_ESCALADA = Object.freeze(['codigo', 'planejamento', 'contexto']);
export const CONTEXTO_LONGO_PADRAO = 8000;

const BLOCO_DE_CODIGO = /```/;
const ERRO_DE_CODIGO = /\b(?:traceback|stack ?trace|segmentation fault|TypeError|SyntaxError|ReferenceError|NullPointerException|Uncaught \w+)\b/i;
const PALAVRA_DE_CODIGO = /\b(?:function|const|let|var|class|import|export|def|return|async|await|SELECT|INSERT|UPDATE|CREATE TABLE|npm|pip|git|undefined)\b/g;
const SIMBOLO_DE_CODIGO = /[{};]|=>|\(\)|\[\]/g;
const PALAVRA_DE_PLANO = /\b(?:planej\w+|plano de a[cç][aã]o|plano de|monte um plano|passo a passo|roteiro de|cronograma|arquitetura|trade-?offs?|pr[oó]s e contras|compar(?:e|ar|a[cç][aã]o)|projete|desenhe a)\b/i;
const MIN_PLANO_CHARS = 60;
const TEXTO_MAX = 6000;

function sinaisLigados(env) {
  const v = String(env?.YUI_IA_ESCALADA ?? '').trim().toLowerCase();
  if (!v || v === 'on' || v === 'true' || v === '1') return new Set(SINAIS_DA_ESCALADA);
  if (v === 'off' || v === 'false' || v === '0') return new Set();
  return new Set(v.split(',').map((s) => s.trim()).filter((s) => SINAIS_DA_ESCALADA.includes(s)));
}
function contextoLongoChars(env) {
  const n = Number.parseInt(String(env?.YUI_IA_ESCALADA_CONTEXTO_CHARS ?? '').trim(), 10);
  return Number.isInteger(n) && n >= 500 ? Math.min(n, 1_000_000) : CONTEXTO_LONGO_PADRAO;
}

/**
 * Os sinais de que esta conversa pede o perfil `raciocinio`: "codigo" (bloco de código, erro de programa ou palavras e símbolos de código),
 * "planejamento" (pede um plano, uma estratégia, uma comparação...) e "contexto" (o histórico mais o pedido são longos). Só texto simples.
 * @returns {string[]} os códigos dos sinais que valem (já filtrados pelo YUI_IA_ESCALADA)
 */
export function sinaisDeEscalada({ texto = '', historicoChars = 0 } = {}, env = process.env) {
  const ligados = sinaisLigados(env);
  const out = [];
  if (!ligados.size) return out;
  const t = String(texto ?? '').slice(0, TEXTO_MAX);
  if (ligados.has('codigo')) {
    const palavras = (t.match(PALAVRA_DE_CODIGO) ?? []).length;
    const simbolos = (t.match(SIMBOLO_DE_CODIGO) ?? []).length;
    if (BLOCO_DE_CODIGO.test(t) || ERRO_DE_CODIGO.test(t) || (palavras >= 2 && simbolos >= 3)) out.push('codigo');
  }
  if (ligados.has('planejamento') && t.length >= MIN_PLANO_CHARS && PALAVRA_DE_PLANO.test(t)) out.push('planejamento');
  if (ligados.has('contexto') && (Number(historicoChars) || 0) + String(texto ?? '').length >= contextoLongoChars(env)) out.push('contexto');
  return out;
}

/** O marcador do bloco de visão que o bot põe no prompt (src/events/messageCreate.js, applyVisionToAttachments): "a imagem foi analisada por um modelo de visão". */
export const MARCADOR_DE_IMAGEM = /Descri[cç][aã]o da\(s\) \d+ imagem\(ns\) anexada\(s\)/;

/**
 * Escolhe o perfil de uma chamada de IA.
 * @param {{ ponto: string, privada?: boolean, imagem?: boolean, texto?: string, historicoChars?: number }} t
 *   `texto`: o texto do pedido da pessoa (para os sinais da escalada); `historicoChars`: quantos caracteres tem o histórico enviado
 * @param {{ env?: object, ativos?: Record<string, object>, privado?: boolean }} [o]  `ativos`/`privado`: para teste (padrão: a configuração do ambiente)
 * @returns {{ nome: string, ponto: string, motivo: string } | null}  `null` = sem perfil (o fluxo de hoje)
 */
export function selecionarPerfil({ ponto, privada = false, imagem = false, texto = '', historicoChars = 0 } = {}, { env = process.env, ativos = perfisAtivos(env), privado = privadoDeclarado(env) } = {}) {
  const p = PONTOS_DE_CHAMADA.includes(ponto) ? ponto : 'conversa';
  // 1. privacidade
  if (privada === true) return privado ? { nome: 'privado', ponto: p, motivo: 'conversa-privada' } : null;
  if (!Object.keys(ativos).length) return null;
  const com = (nome, motivo) => {
    if (ativos[nome]) return { nome, ponto: p, motivo };
    const desce = DESCE_PARA[nome];
    return desce && ativos[desce] ? { nome: desce, ponto: p, motivo: `${motivo}+sem-${nome}` } : null;
  };
  // 2. imagem
  if (imagem === true && ativos.visao) return { nome: 'visao', ponto: p, motivo: 'imagem-anexada' };
  // 3. o ponto de chamada
  if (p === 'comentario') return com('rapido', 'comentario');
  if (p === 'otimizador-busca') return com('rapido', 'otimizador-da-busca');
  if (p === 'conversa-voz') return com('rapido', 'voz');
  if (p === 'sintese-pesquisa') return com('pesquisa', 'sintese-da-pesquisa');
  const sinais = sinaisDeEscalada({ texto, historicoChars }, env);
  if (sinais.length) {
    const r = com('raciocinio', `escalada:${sinais.join('+')}`);
    if (r) return r;
  }
  return com('conversa', 'conversa');
}

/** Para espalhar na chamada de IA: `{ perfil }` quando há perfil, `{}` quando não (a chamada fica idêntica à de antes). */
export function campoPerfil(perfil) {
  return perfil ? { perfil } : {};
}
