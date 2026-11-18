// A RAZÃO DO CANCELAMENTO de uma busca (revisão da Liz na etapa 8, §14 do docs/RELATORIO_ETAPA8_PRE_PILOTO.md: a reutilização cancelada por outra pessoa).
//
// Quem só aproveitava uma busca idêntica e pública em andamento (src/search/providers.js, o mapa das buscas em andamento) ficava sem resultado se quem a
// iniciou (o "dono" da busca) a cancelava. A regra da Liz: quem esperava pode iniciar a PRÓPRIA busca, com cobrança normal, SE o cancelamento foi uma escolha de
// quem iniciou a busca. Um cancelamento imposto por política de segurança NÃO é repetido, e o prazo esgotado também não conta como cancelamento do dono. Para o
// `searchWeb` distinguir os casos, quem cancela diz a razão no próprio `signal.reason`, com uma palavra fixa:
//
//   | razão         | quem pede                                                        | o esperador refaz a busca?      |
//   | `dono`        | quem iniciou a busca desistiu (ex.: o botão de cancelar)         | SIM (uma nova tentativa, cobrada) |
//   | `politica`    | a política de segurança impôs o cancelamento                     | não (a política vale para todos) |
//   | `prazo`       | o tempo esgotou (TimeoutError: o prazo da cadeia ou o do pedido) | não (continua como sempre)       |
//   | `desconhecida`| qualquer outro motivo, ou nenhum motivo tipado                   | não (na dúvida, não repete)      |
//
// Este módulo é PURO (sem imports). O resultado do `searchWeb` cancelado leva `cancelamento: <a palavra>` (só isso, nunca texto livre).

export const RAZOES_DE_CANCELAMENTO = Object.freeze({ DONO: 'dono', POLITICA: 'politica', PRAZO: 'prazo', DESCONHECIDA: 'desconhecida' });
const RAZOES_TIPADAS = new Set([RAZOES_DE_CANCELAMENTO.DONO, RAZOES_DE_CANCELAMENTO.POLITICA]);

/** O motivo tipado que vai em `signal.reason` (`controller.abort(new CancelamentoDeBusca('dono'))`). Qualquer razão fora das conhecidas vira `desconhecida`. */
export class CancelamentoDeBusca extends Error {
  constructor(razao = RAZOES_DE_CANCELAMENTO.DESCONHECIDA) {
    super('cancelado');
    this.name = 'CancelamentoDeBusca';
    this.razao = RAZOES_TIPADAS.has(razao) ? razao : RAZOES_DE_CANCELAMENTO.DESCONHECIDA;
  }
}

/** Cancela o `controller` dizendo a razão (`dono` ou `politica`; qualquer outra vira `desconhecida`). */
export function cancelarBusca(controller, razao) {
  controller.abort(new CancelamentoDeBusca(razao));
}

/**
 * A razão que o `signal.reason` diz, como uma palavra fixa. TimeoutError (o `AbortSignal.timeout` do pedido e o prazo da cadeia) = `prazo`; o motivo tipado
 * (CancelamentoDeBusca) diz `dono` ou `politica`; qualquer outra coisa (um `abort()` sem motivo, um Error qualquer, um texto) = `desconhecida`.
 */
export function razaoDoCancelamento(reason) {
  if (reason instanceof CancelamentoDeBusca) return reason.razao;
  if (reason?.name === 'TimeoutError') return RAZOES_DE_CANCELAMENTO.PRAZO;
  return RAZOES_DE_CANCELAMENTO.DESCONHECIDA;
}

/** O esperador pode fazer a própria busca depois deste cancelamento? Só quando quem iniciou a busca desistiu (`dono`); política, prazo e dúvida não repetem. */
export const repeteAposCancelamento = (razao) => razao === RAZOES_DE_CANCELAMENTO.DONO;
