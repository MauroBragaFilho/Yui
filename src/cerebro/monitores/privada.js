// A PESQUISA PRIVADA LIBERADA ao dono (etapa 16, ajuste da revisão): os monitores são buscas na web em nome do dono, a partir de uma conversa privada com ele. Por isso só
// existem enquanto a pesquisa privada estiver liberada para o dono, pela MESMA regra que o cérebro usa para oferecer a pesquisa numa conversa privada
// (searchOfferedFor, src/core/ai/promptConversa.js: o agente de pesquisa ligado E YUI_PRIVATE_SEARCH = `owner` ou `all`; `off` não libera). Nenhum valor novo.
//  - criar um monitor exige a liberação (rota.js);
//  - a liberação é relida a CADA busca (executor.js), nunca guardada na subida: desligada, o monitor não busca, não gasta cota e não envia a consulta a ninguém; ele
//    fica ADIADO (nada é encerrado nem apagado) e volta sozinho quando a chave voltar. O prazo dele continua correndo.
// Isto NÃO substitui a limpeza de dados pessoais (limpeza.js): são proteções independentes. Nunca lança; qualquer dúvida é "não liberada" (falha fechada).
import { searchOfferedFor } from '../../core/ai/promptConversa.js';

/** A pesquisa privada está liberada para esta pessoa (o dono) agora? Lê a chave neste instante. */
export function pesquisaPrivadaLiberada(userId) {
  try {
    return searchOfferedFor({ sensitive: true, userId }) === true;
  } catch {
    return false;
  }
}

/** O que a Yui responde quando pedem um monitor e a pesquisa privada não está liberada (frase fixa). */
export const TEXTO_PESQUISA_PRIVADA_DESLIGADA = 'Não posso criar monitores agora: a pesquisa privada não está liberada para o dono (YUI_PRIVATE_SEARCH).';
