/**
 * Contador de respostas da IA por hora, só em memória (some quando a Yui reinicia; `since` diz desde quando vale).
 * Não guarda texto, usuário nem canal: só "quantas respostas em cada hora". Alimenta o gráfico de 24 h da Visão Geral.
 */
const HOUR = 60 * 60 * 1000;
const HOURS = 24;

const buckets = new Map(); // início da hora (ms) -> contagem
let since = Date.now();

function hourStart(ms) {
  return Math.floor(ms / HOUR) * HOUR;
}

function prune(now) {
  const limit = hourStart(now) - (HOURS - 1) * HOUR;
  for (const k of buckets.keys()) if (k < limit) buckets.delete(k);
}

/** Registra uma resposta da IA entregue (Discord, /yui ou app). Nunca lança. */
export function recordInteraction(now = Date.now()) {
  try {
    const k = hourStart(now);
    buckets.set(k, (buckets.get(k) || 0) + 1);
    prune(now);
  } catch { /* contador nunca atrapalha a resposta */ }
}

/** As últimas 24 horas, da mais antiga para a atual: [{ hour: ISO, count }], mais o total e o início da contagem. */
export function interactionSeries(now = Date.now()) {
  prune(now);
  const end = hourStart(now);
  const series = [];
  let total = 0;
  for (let i = HOURS - 1; i >= 0; i--) {
    const k = end - i * HOUR;
    const count = buckets.get(k) || 0;
    total += count;
    series.push({ hour: new Date(k).toISOString(), count });
  }
  return { series, total, since: new Date(since).toISOString() };
}

/** Zera tudo (testes). */
export function resetInteractionStats(now = Date.now()) {
  buckets.clear();
  since = now;
}
