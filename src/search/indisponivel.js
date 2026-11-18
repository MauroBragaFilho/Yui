// A PESQUISA TEMPORARIAMENTE INDISPONÍVEL (etapa 8, rodada depois da revisão da Liz, §12 do docs/RELATORIO_ETAPA8_PRE_PILOTO.md).
//
// Regra da Liz: nenhuma busca externa começa sem um dono (a trava do arquivo da cota por hora) e sem o registro persistente da operação (a cota
// em disco e o diário da retomada). Quando uma dessas condições falta, a busca NÃO sai: a Yui continua conversando e, no lugar da pesquisa, avisa
// com UM texto só (este) que a pesquisa está temporariamente indisponível. Nunca se pesquisa "assim mesmo" com uma cota só em memória.
//
// Este módulo é PURO (sem imports): o texto, o erro fixo que viaja na lista `errors` do resultado do buscador (para quem classifica a falha) e o
// resultado padrão. O mesmo texto vale nos três casos: sem a trava (ou no bot separado), sem gravar o diário/a cota, e na reutilização recusada.

/**
 * O aviso único que a pessoa recebe no lugar da pesquisa. Texto sugerido pela Liz na revisão da etapa 8 (§14 do relatório): curto e SEM a causa interna (nada de
 * trava, diário, cota, dono ou processo): a pessoa só precisa saber que a pesquisa não saiu e que a conversa continua.
 */
export const TEXTO_PESQUISA_INDISPONIVEL = 'Não consegui realizar a pesquisa agora. Posso continuar ajudando com o que já sei.';

/** O erro fixo que o resultado do buscador carrega em `errors` (nunca texto livre): `classifyFailure` o reconhece. */
export const ERRO_PESQUISA_INDISPONIVEL = 'pesquisa indisponível';

/**
 * Os motivos (palavras fixas) pelos quais a pesquisa fica indisponível. Só estes vão para o diagnóstico e para a saúde.
 *  - bot-separado: o bot nunca busca por conta própria (a pesquisa dele vai ao cérebro, que é o dono);
 *  - aguardando-trava | trava-de-outro-processo | dono-morto | erro-na-trava: este processo ainda não tem a trava do arquivo da cota por hora;
 *  - perdida: a trava foi perdida depois de ligada; parada: a cota foi parada (desligamento);
 *  - registro-da-cota | registro-mensal | registro-do-diario: o registro persistente (cota por hora, cota mensal, diário da retomada) não gravou.
 */
export const MOTIVOS_INDISPONIVEL = Object.freeze([
  'bot-separado', 'aguardando-trava', 'trava-de-outro-processo', 'dono-morto', 'erro-na-trava', 'perdida', 'parada',
  'registro-da-cota', 'registro-mensal', 'registro-do-diario',
]);

/** O resultado de uma busca que NÃO saiu porque a pesquisa está indisponível (o mesmo formato do resultado do searchWeb). */
export function resultadoIndisponivel(motivo = 'aguardando-trava') {
  return {
    provider: null, results: [], errors: [ERRO_PESQUISA_INDISPONIVEL], indisponivel: true,
    motivo: MOTIVOS_INDISPONIVEL.includes(motivo) ? motivo : 'aguardando-trava', retryAfterMs: 0,
  };
}

/** O resultado de um buscador (ou a lista de erros) diz que a pesquisa está indisponível? */
export function ehIndisponivel(found) {
  if (found?.indisponivel === true) return true;
  const errors = Array.isArray(found) ? found : Array.isArray(found?.errors) ? found.errors : [];
  return errors.some((e) => String(e).toLowerCase() === ERRO_PESQUISA_INDISPONIVEL);
}

/** Acrescenta o aviso (uma linha de subtexto, como o aviso da cota) ao fim da resposta, uma vez só. */
export function comAvisoDeIndisponivel(texto) {
  const t = String(texto ?? '');
  return t.includes(TEXTO_PESQUISA_INDISPONIVEL) ? t : `${t}\n-# ⚠️ ${TEXTO_PESQUISA_INDISPONIVEL}`;
}
