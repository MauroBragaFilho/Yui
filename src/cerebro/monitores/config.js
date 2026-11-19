// Configuração e limites dos MONITORES de busca (etapa 16, proatividade; docs/content_pt/MONITORES.md). Tudo nasce DESLIGADO.
//
// YUI_MONITORES (padrão false): liga os monitores "me avisa quando..." do dono (só com o cérebro separado).
// YUI_MONITORES_MS (padrão 600000 = 10 min): de quanto em quanto tempo o laço do cérebro olha quais monitores estão devidos.
// YUI_MONITORES_RESERVA (padrão 10, de 0 a 90): a parte da cota de busca por hora que os monitores NUNCA tocam (fica para a conversa).
// Os limites abaixo são fixos de propósito (o que a pessoa pode pedir não muda por variável de ambiente).

const FALSOS = new Set(['false', '0', 'off', 'no', 'nao', 'não']);
const VERDADEIROS = new Set(['true', '1', 'on', 'yes', 'sim']);

/** Interpreta uma chave liga/desliga (vazio ou desconhecido = o padrão). */
export function flag(valor, padrao = false) {
  const s = String(valor ?? '').trim().toLowerCase();
  if (!s) return padrao;
  if (FALSOS.has(s)) return false;
  if (VERDADEIROS.has(s)) return true;
  return padrao;
}

export const LIMITES = Object.freeze({
  /** No máximo 5 monitores ATIVOS por dono (os pausados e os encerrados não contam). */
  maxAtivos: 5,
  intervaloMinimoMin: 60,
  intervaloPadraoMin: 360,
  intervaloMaximoMin: 1440,
  prazoPadraoDias: 14,
  prazoMaximoDias: 60,
  prazoMinimoHoras: 1,
  /** Tamanho máximo da consulta (caracteres, por pontos de código). */
  consultaMax: 120,
  /** Quantos registros o arquivo guarda (os encerrados mais antigos saem primeiro) e por quanto tempo um encerrado fica. */
  maxRegistros: 40,
  encerradoGuardadoMs: 7 * 24 * 60 * 60_000,
  /**
   * Depois de uma busca que falhou (ou que não trouxe resultado nenhum), quanto tempo até a nova tentativa (no máximo o intervalo do monitor). A espera DOBRA a cada
   * falha seguida (30, 60, 120, 240 min...) até o teto: 4 vezes o intervalo do monitor, no máximo `falhaTetoMin`. Uma busca boa zera a conta (retomada).
   */
  falhaNovaTentativaMin: 30,
  falhaTetoMin: 720,
  /** Quantos endereços já vistos (só o hash curto de cada um) o monitor guarda: o aviso é só do que NÃO está neste conjunto. */
  vistasMax: 60,
  /** O aviso que o Discord recusa com certeza (DM fechada): quantas passadas antes de desistir (e registrar). */
  avisoMaxTentativas: 24,
  /** O aviso com a entrega incerta tenta reconciliar de novo a cada tanto, e depois deste tempo é descartado (com registro). */
  reconciliarIncertoMs: 10 * 60_000,
  incertoExpiraMs: 24 * 60 * 60_000,
  /** Quantas buscas, no máximo, uma passada faz (a cota compartilhada manda antes disto). */
  porPassada: 5,
  /** Quantos resultados a busca pede; a assinatura usa os 3 primeiros. */
  resultadosPedidos: 5,
});

/** A pessoa de mentira que a cota de busca enxerga nas buscas dos monitores (separada de qualquer pessoa real: a conversa nunca gasta com ela). */
export const MONITOR_USER_ID = 'monitores';

export function monitoresLigados(env = process.env) {
  return flag(env.YUI_MONITORES, false);
}

function inteiro(valor, min, max, padrao) {
  const n = Number(String(valor ?? '').trim());
  return String(valor ?? '').trim() !== '' && Number.isFinite(n) && n >= min ? Math.min(max, Math.round(n)) : padrao;
}

/** O intervalo do laço (YUI_MONITORES_MS, padrão 10 min, no mínimo 200 ms para os testes). */
export function tickDosMonitoresMs(env = process.env) {
  return inteiro(env.YUI_MONITORES_MS, 200, 24 * 60 * 60_000, 10 * 60_000);
}

/** A reserva da cota para a conversa, em % (YUI_MONITORES_RESERVA, de 0 a 90, padrão 10; 0 = sem reserva). */
export function reservaDosMonitores(env = process.env) {
  return inteiro(env.YUI_MONITORES_RESERVA, 0, 90, 10);
}

/**
 * SÓ TESTE (NODE_ENV=test): troca o intervalo de TODOS os monitores por este número de segundos, para os testes com processos de verdade
 * não esperarem horas. Fora de NODE_ENV=test a variável é ignorada. Devolve milissegundos ou null.
 */
export function intervaloDeTesteMs(env = process.env) {
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'test') return null;
  const n = Number(String(env.YUI_TESTE_MONITORES_INTERVALO_S ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.round(n * 1000) : null;
}

/** Quanto tempo (ms) até a próxima checagem de um monitor depois de uma checagem boa. */
export function intervaloDoMonitorMs(monitor, env = process.env) {
  const teste = intervaloDeTesteMs(env);
  if (teste) return teste;
  const min = Number(monitor?.intervaloMin);
  const valido = Number.isFinite(min) ? Math.min(LIMITES.intervaloMaximoMin, Math.max(LIMITES.intervaloMinimoMin, Math.round(min))) : LIMITES.intervaloPadraoMin;
  return valido * 60_000;
}
