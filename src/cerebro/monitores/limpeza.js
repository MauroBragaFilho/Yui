// A LIMPEZA da consulta de um monitor (etapa 16, ajuste da revisão): o assunto que a pessoa pede fica no disco (monitores.json) enquanto o monitor está aberto
// e vai a um buscador de terceiros a cada checagem. Por isso passa, ANTES de ser gravada e ANTES de cada busca, pela MESMA limpeza da pesquisa privada
// (scrubQuery, src/core/ai/researchAgent.js: dado pessoal, segredo e palavra proibida bloqueiam; menção, link e bloco de código saem).
//
// FALHA FECHADA: a consulta só vale se a limpeza PROVA que está limpa. Recusa quando:
//  - a limpeza lança (qualquer erro);
//  - a limpeza bloqueia (dado pessoal, segredo, palavra proibida) ou devolve algo que não é um texto utilizável (incerta, vazio);
//  - limpar de novo a consulta já limpa não devolve exatamente a mesma (o texto mudou de um jeito que não prova que está limpo).
// O resultado é UMA versão só da consulta: a que fica gravada e a que vai ao buscador (nunca a bruta). O motivo da recusa é uma palavra fixa (nunca o texto
// nem o valor encontrado).
import { scrubQuery } from '../../core/ai/researchAgent.js';
import { forbiddenKeywords as PALAVRAS_PROIBIDAS } from '../../core/forbiddenKeywords.js';
import { LIMITES } from './config.js';
import { tituloSeguro } from './assinatura.js';

/** O que a Yui responde quando a consulta não passa (frase fixa: nunca repete o texto da pessoa). */
export const TEXTO_CONSULTA_BARRADA = 'Não consegui guardar esse assunto: ele parece ter dado pessoal ou algo que não posso mandar a um buscador. Peça de novo reformulando, sem dados pessoais.';

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
    // uma linha só, sem menção, link nem formatação (o mesmo cuidado de todo texto que vai numa mensagem)
    const consulta = tituloSeguro(a.query, LIMITES.consultaMax);
    if (!a.query.trim() || consulta === 'sem título' || !/[\p{L}\p{N}]/u.test(consulta)) return { ok: false, motivo: 'incerta' };
    // A PROVA: a consulta final, limpa de novo, volta igual. Se mudar, nada garante que o que ficou é o que foi limpo.
    const b = scrub(consulta, opcoes);
    if (!b || b.ok !== true || b.query !== consulta) return { ok: false, motivo: 'incerta' };
    return { ok: true, consulta };
  } catch {
    return { ok: false, motivo: 'falhou' };
  }
}
