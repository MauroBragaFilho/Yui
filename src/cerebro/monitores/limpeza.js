// A LIMPEZA da consulta de um monitor (etapa 16, ajuste da revisão): o assunto que a pessoa pede fica no disco (monitores.json) enquanto o monitor está aberto
// e vai a um buscador de terceiros a cada checagem. Por isso passa, ANTES de ser gravada e ANTES de cada busca, pela MESMA limpeza da pesquisa privada
// (scrubQuery, src/core/ai/researchAgent.js: dado pessoal, segredo e palavra proibida bloqueiam; menção, link e bloco de código saem).
//
// FALHA FECHADA: a consulta só vale se a limpeza PROVA que está limpa. Recusa quando:
//  - a limpeza lança (qualquer erro);
//  - a limpeza bloqueia (dado pessoal, segredo, palavra proibida) ou devolve algo que não é um texto utilizável (incerta, vazio);
//  - limpar de novo a consulta já limpa não devolve exatamente a mesma (o texto mudou de um jeito que não prova que está limpo).
// Além da limpeza da pesquisa privada (que reconhece PADRÕES: documentos, e-mail, telefone, cartão, chaves, "senha: x"), os monitores aplicam uma segunda camada, só
// deles (`textoLivrePessoal`): o texto LIVRE que o padrão não pega ("senha do wifi: x", "minha senha é x", "usuário: x", endereço com rua e número, CEP, "meu endereço",
// "moro na..."). É por heurística e tem LIMITES (veja docs/content_pt/MONITORES.md): não reconhece nome de pessoa, endereço sem rua e número em sequência, nem dado
// pessoal escrito de um jeito que nenhuma regra imagine. Por isso o assunto de um monitor deve ser um tema público. Fica só dentro dos monitores (a pesquisa por
// conversa continua com a regra de sempre) e foi escrita para NÃO derrubar consultas legítimas ("senha do wifi" sozinho, "rodovia BR 116", "avenida paulista").
// O resultado é UMA versão só da consulta: a que fica gravada e a que vai ao buscador (nunca a bruta). O motivo da recusa é uma palavra fixa (nunca o texto
// nem o valor encontrado).
import { scrubQuery } from '../../core/ai/researchAgent.js';
import { forbiddenKeywords as PALAVRAS_PROIBIDAS } from '../../core/forbiddenKeywords.js';
import { LIMITES } from './config.js';
import { tituloSeguro } from './assinatura.js';

/** O que a Yui responde quando a consulta não passa (frase fixa: nunca repete o texto da pessoa). */
export const TEXTO_CONSULTA_BARRADA = 'Não consegui guardar esse assunto: ele parece ter dado pessoal ou algo que não posso mandar a um buscador. Peça de novo reformulando, sem dados pessoais.';

const INVISIVEIS_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\u061c\u00ad\ufeff\u180e]/g;
// "senha/token/pin/chave... (até 4 palavras) : ou = valor" ("senha do wifi: x", "senha do banco = abc", "pin do cartão: 1234")
const CREDENCIAL_COM_SINAL_RE = /\b(?:senha|senhas|password|passwd|pwd|passcode|credencial|credenciais)\b(?:\s+[\p{L}\p{N}_-]+){0,4}\s*[:=]\s*\S+/u;
// "a/minha senha ... é x" (com o acento: o "e" sem acento é só a conjunção) e "senha: x" em inglês ("password is x")
const CREDENCIAL_COM_VERBO_RE = /\b(?:senha|password|passwd|pwd)\b(?:\s+[\p{L}\p{N}_-]+){0,4}\s+(?:é|eh|is|foi|ficou)\s+\S*[\p{N}!@#$%^&*_+=-]\S*/u;
// usuário e login: "usuário: joao", "login = x"
const USUARIO_RE = /\b(?:usuario|usuário|login|username|user)\s*[:=]\s*\S+/u;
// endereço: rua/avenida/... + nome + vírgula e número ("rua das flores, 123", "av brasil, n 1500", "alameda santos nº 42"); CEP; "meu endereço"; "moro na rua"
const RUA_RE = /\b(?:rua|r\.|avenida|av\.|av|travessa|alameda|estrada|rodovia|praca|praça|quadra|largo|beco|viela)\s+(?:[\p{L}\p{N}.'-]+\s+){0,6}[\p{L}\p{N}.'-]+\s*(?:,\s*(?:n[ºo°.]?\s*)?\d{1,5}\b|\s+n[ºo°.]\s*\d{1,5}\b|\s+numero\s+\d{1,5}\b)/u;
const CEP_RE = /(?<!\d)\d{5}-\d{3}(?!\d)|\bcep\s*[:=]?\s*\d{5}\s?-?\s?\d{3}\b/u;
const MORADIA_RE = /\b(?:meu|minha|nosso|nossa)\s+(?:endereco|endereço|apartamento|apto|ap|condominio|condomínio|bairro|cep|rua)\b|\bmoro\s+(?:na|no|em|perto)\b|\bendereco\s*(?:é|eh|:)|\bendereço\s*(?:é|eh|:)/u;

/**
 * A segunda camada dos monitores: dado pessoal em TEXTO LIVRE que os padrões da pesquisa privada não pegam (senha com palavras no meio, usuário, endereço, CEP,
 * "meu endereço"). Devolve a palavra fixa do tipo ('senha', 'usuario', 'endereco') ou '' se nada casou. Heurística, com limites documentados.
 */
export function textoLivrePessoal(texto) {
  const t = String(texto ?? '').normalize('NFKC').replace(INVISIVEIS_RE, '').toLowerCase().slice(0, 2000);
  if (CREDENCIAL_COM_SINAL_RE.test(t) || CREDENCIAL_COM_VERBO_RE.test(t)) return 'senha';
  if (USUARIO_RE.test(t)) return 'usuario';
  if (RUA_RE.test(t) || CEP_RE.test(t) || MORADIA_RE.test(t)) return 'endereco';
  return '';
}

/**
 * @param {string} texto  a consulta como a pessoa escreveu (já sem o verbo do pedido)
 * @param {{ scrub?: Function, forbiddenKeywords?: string[]|null }} [opcoes]  `scrub`: a limpeza (padrão: scrubQuery); injetável só para teste
 * @returns {{ ok: true, consulta: string } | { ok: false, motivo: 'dado_pessoal'|'palavra_proibida'|'incerta'|'falhou' }}
 */
export function limparConsulta(texto, { scrub = scrubQuery, forbiddenKeywords = PALAVRAS_PROIBIDAS } = {}) {
  try {
    const opcoes = { forbiddenKeywords, max: LIMITES.consultaMax };
    const a = scrub(String(texto ?? ''), opcoes);
    if (a && a.ok === false) return { ok: false, motivo: a.reason === 'forbidden' ? 'palavra_proibida' : 'dado_pessoal' };
    if (!a || a.ok !== true || typeof a.query !== 'string') return { ok: false, motivo: 'incerta' };
    // a segunda camada, sobre o texto que a pessoa escreveu (antes de qualquer corte) e de novo sobre a versão final
    if (textoLivrePessoal(texto)) return { ok: false, motivo: 'dado_pessoal' };
    // uma linha só, sem menção, link nem formatação (o mesmo cuidado de todo texto que vai numa mensagem)
    const consulta = tituloSeguro(a.query, LIMITES.consultaMax);
    if (!a.query.trim() || consulta === 'sem título' || !/[\p{L}\p{N}]/u.test(consulta)) return { ok: false, motivo: 'incerta' };
    // A PROVA: a consulta final, limpa de novo, volta igual. Se mudar, nada garante que o que ficou é o que foi limpo.
    const b = scrub(consulta, opcoes);
    if (!b || b.ok !== true || b.query !== consulta) return { ok: false, motivo: 'incerta' };
    if (textoLivrePessoal(consulta)) return { ok: false, motivo: 'dado_pessoal' };
    return { ok: true, consulta };
  } catch {
    return { ok: false, motivo: 'falhou' };
  }
}
