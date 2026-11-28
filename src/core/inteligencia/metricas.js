// Contas puras usadas pelos scripts de relatório e de avaliação do interpretador (sem rede, sem disco).

export function percentil(valores, p) {
  const v = valores.filter((x) => Number.isFinite(x)).sort((a, b) => a - b);
  if (!v.length) return null;
  const i = Math.min(v.length - 1, Math.max(0, Math.ceil((p / 100) * v.length) - 1));
  return v[i];
}

/** A pré-rota que "pegou" (qualquer uma diferente de "nenhuma") corresponde a qual família de intenção? */
export const PRE_ROTA_PARA_INTENCOES = Object.freeze({
  google: ['agenda.consultar', 'agenda.livre', 'tarefas.consultar'],
  clima: ['clima.consultar'],
  'pesquisa-intencao': ['pesquisa.web'],
  skill: [],
});

/** A intenção do interpretador concorda com a pré-rota? (nenhuma pré-rota = concorda quando a IA diz "conversa") */
export function concorda(preRota, intencao) {
  if (!intencao) return null; // sem interpretação: não compara
  if (!preRota || preRota === 'nenhuma') return intencao === 'conversa';
  const familia = PRE_ROTA_PARA_INTENCOES[preRota];
  if (!familia) return null; // pré-rota desconhecida: não dá para comparar
  return familia.includes(intencao);
}

/** A regra de decisão do doc 02 §4: confiança >= 0,8 e não ambígua segue; senão não captura (conversa). */
export function intencaoEfetiva(res, limite = 0.8) {
  if (!res) return null;
  return res.confianca >= limite && !res.ambigua ? res.intencao : 'conversa';
}

/** Precisão e cobertura por intenção, falsos positivos em conversa e injeção, a partir de { esperado, previsto, categoria }. */
export function calcularMetricas(itens) {
  const intencoes = [...new Set(itens.flatMap((i) => [i.esperado, i.previsto]).filter(Boolean))].sort();
  const por = {};
  for (const k of intencoes) {
    const tp = itens.filter((i) => i.esperado === k && i.previsto === k).length;
    const fp = itens.filter((i) => i.esperado !== k && i.previsto === k).length;
    const fn = itens.filter((i) => i.esperado === k && i.previsto !== k).length;
    por[k] = { tp, fp, fn, precisao: tp + fp ? tp / (tp + fp) : null, cobertura: tp + fn ? tp / (tp + fn) : null };
  }
  const conversa = itens.filter((i) => i.esperado === 'conversa');
  const comuns = conversa.filter((i) => i.categoria === 'comum');
  const injecao = conversa.filter((i) => i.categoria === 'injecao');
  const capturou = (i) => i.previsto !== 'conversa' && i.previsto !== null;
  const certos = itens.filter((i) => i.previsto === i.esperado).length;
  const leitura = itens.filter((i) => /\.(consultar|livre)$/.test(i.esperado ?? ''));
  return {
    total: itens.length,
    acerto: itens.length ? certos / itens.length : null,
    acertoLeitura: leitura.length ? leitura.filter((i) => i.previsto === i.esperado).length / leitura.length : null,
    falsoPositivoConversa: conversa.length ? conversa.filter(capturou).length / conversa.length : null,
    falsoPositivoConversaComum: comuns.length ? comuns.filter(capturou).length / comuns.length : null,
    capturadasPorInjecao: injecao.filter(capturou).length,
    porIntencao: por,
  };
}

export const pct = (x) => (x === null || x === undefined ? '  -  ' : `${(x * 100).toFixed(1)}%`);
