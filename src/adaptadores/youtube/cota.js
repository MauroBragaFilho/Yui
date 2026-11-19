// COTA DE UNIDADES DA API DO YOUTUBE (docs/PROPOSTA_CEREBRO_UNICO_YUI.md §7.5; docs/CANAIS_NOVOS.md §3.4). PURA: conta no código, nunca chama a API.
//
// A API do YouTube Data cobra em UNIDADES por projeto Google, por dia (o padrão de um projeto novo é 10.000 unidades; o contador zera à meia-noite do
// fuso do Pacífico). Ler o chat e enviar uma mensagem gastam unidades, e ENVIAR gasta bem mais que LER. Os custos abaixo são o que o dono conhece hoje e
// PRECISAM ser conferidos na documentação oficial antes de ligar (a Yui não confia nesta tabela como verdade: ela só decide quando falar menos e quando
// parar; o gasto REAL fica no painel do projeto Google).
//
// Contas rápidas com esta tabela (leitura de 5 unidades, envio de 20):
//   ler a cada 6 s por 1 hora = 600 leituras = 3.000 unidades; a cada 15 s = 240 leituras = 1.200 unidades;
//   dez respostas por hora = 200 unidades. Uma live de 4 horas lida a cada 6 s gastaria 12.000 unidades: mais que o dia inteiro.
// Por isso o ritmo de leitura tem um MÍNIMO (intervaloMinimoLeituraMs) e AUMENTA quando a cota aperta (fatorDeLeitura).
export const CUSTOS_PADRAO = Object.freeze({ 'videos.list': 1, 'liveChatMessages.list': 5, 'liveChatMessages.insert': 20 });
export const COTA_DIARIA_PADRAO = 10_000;
/** Unidades que ficam de reserva para os OUTROS usos do mesmo projeto Google (o motor de YouTube do bot, por exemplo, pode usar a mesma cota). */
export const RESERVA_PADRAO = 1000;
export const FUSO_DA_COTA = 'America/Los_Angeles';
const LIMIAR_ATENCAO = 0.7; // a partir daqui a Yui para de puxar assunto
const LIMIAR_CRITICO = 0.9; // a partir daqui a leitura fica bem mais devagar

const formatadorDoDia = new Intl.DateTimeFormat('en-CA', { timeZone: FUSO_DA_COTA, year: 'numeric', month: '2-digit', day: '2-digit' });
/** O dia da cota (AAAA-MM-DD no fuso do Pacífico) de um instante em ms: a cota zera quando ele muda. */
export const diaDaCota = (agoraMs) => formatadorDoDia.format(new Date(agoraMs));

/**
 * O contador de cota do dia.
 * @param {{ limiteDiario?: number, reserva?: number, custos?: Record<string, number>, agora?: () => number }} [o]
 */
export function criarCota({ limiteDiario = COTA_DIARIA_PADRAO, reserva = RESERVA_PADRAO, custos = CUSTOS_PADRAO, agora = Date.now } = {}) {
  if (!Number.isInteger(limiteDiario) || limiteDiario < 1) throw new RangeError('limiteDiario precisa ser um inteiro positivo');
  if (!Number.isInteger(reserva) || reserva < 0 || reserva >= limiteDiario) throw new RangeError('reserva precisa ser um inteiro de 0 até o limite');
  const usavel = limiteDiario - reserva;
  let dia = diaDaCota(agora());
  let gasto = 0;
  const porOperacao = {};

  const virouODia = () => {
    const hoje = diaDaCota(agora());
    if (hoje !== dia) { dia = hoje; gasto = 0; for (const k of Object.keys(porOperacao)) delete porOperacao[k]; }
  };
  const custoDe = (operacao) => {
    const c = custos[operacao];
    if (!Number.isInteger(c) || c < 0) throw new RangeError(`operação sem custo conhecido: ${String(operacao).slice(0, 40)}`);
    return c;
  };

  const api = {
    /** Pode gastar esta operação sem passar da parte usável (o limite menos a reserva)? */
    podeGastar(operacao) { virouODia(); return gasto + custoDe(operacao) <= usavel; },
    /** Registra o gasto (sempre registra, mesmo passando: o gasto aconteceu). */
    gastar(operacao) { virouODia(); const c = custoDe(operacao); gasto += c; porOperacao[operacao] = (porOperacao[operacao] ?? 0) + c; return gasto; },
    usado() { virouODia(); return gasto; },
    restante() { virouODia(); return Math.max(0, usavel - gasto); },
    fracao() { virouODia(); return gasto / usavel; },
    /**
     * 'ok' (abaixo de 70%), 'atencao' (70% a 90%: sem puxar assunto), 'critico' (90% até o fim: só responde a quem chama e lê bem mais devagar)
     * ou 'esgotada' (não cabe mais nem uma leitura: para).
     */
    nivel() {
      virouODia();
      if (gasto + custoDe('liveChatMessages.list') > usavel) return 'esgotada';
      const f = gasto / usavel;
      if (f >= LIMIAR_CRITICO) return 'critico';
      if (f >= LIMIAR_ATENCAO) return 'atencao';
      return 'ok';
    },
    /** Quantas vezes mais devagar ler o chat neste nível (1, 1, 2 ou 4). */
    fatorDeLeitura() { const n = api.nivel(); return n === 'critico' ? 2 : n === 'esgotada' ? 4 : 1; },
    /** Retrato SEM texto de ninguém: só números. */
    retrato() { virouODia(); return { dia, limiteDiario, reserva, usado: gasto, restante: Math.max(0, usavel - gasto), nivel: api.nivel(), porOperacao: { ...porOperacao } }; },
  };
  return api;
}

/**
 * Estimativa de gasto de uma live: quantas unidades ela gasta e quanto do dia isso é. Serve para escolher o ritmo ANTES de ligar.
 * @param {{ duracaoMin: number, intervaloLeituraMs: number, respostasPorHora?: number, espontaneasPorHora?: number, custos?: Record<string, number>, limiteDiario?: number }} p
 */
export function planejarCota({ duracaoMin, intervaloLeituraMs, respostasPorHora = 0, espontaneasPorHora = 0, custos = CUSTOS_PADRAO, limiteDiario = COTA_DIARIA_PADRAO }) {
  if (!(duracaoMin > 0) || !(intervaloLeituraMs >= 1000)) throw new RangeError('duracaoMin precisa ser positiva e intervaloLeituraMs, de pelo menos 1000');
  const horas = duracaoMin / 60;
  const leituras = Math.ceil((duracaoMin * 60_000) / intervaloLeituraMs);
  const envios = Math.round(horas * (respostasPorHora + espontaneasPorHora));
  const unidades = custos['videos.list'] + leituras * custos['liveChatMessages.list'] + envios * custos['liveChatMessages.insert'];
  return { leituras, envios, unidades, fracaoDoDia: unidades / limiteDiario, cabeNoDia: unidades <= limiteDiario };
}

/**
 * O MENOR intervalo de leitura (ms, múltiplo de 1000) com que uma live dessa duração cabe em `unidadesDisponiveis`, depois de descontar os envios estimados.
 * @returns {number | null} null se nem lendo uma vez por minuto couber
 */
export function intervaloMinimoQueCabe({ duracaoMin, unidadesDisponiveis, envios = 0, custos = CUSTOS_PADRAO }) {
  const paraLeituras = unidadesDisponiveis - custos['videos.list'] - envios * custos['liveChatMessages.insert'];
  if (paraLeituras < custos['liveChatMessages.list']) return null;
  const leituras = Math.floor(paraLeituras / custos['liveChatMessages.list']);
  const ms = Math.ceil(((duracaoMin * 60_000) / leituras) / 1000) * 1000;
  return ms > 60_000 ? null : Math.max(1000, ms);
}
