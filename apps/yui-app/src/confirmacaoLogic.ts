/**
 * Correção C2 do parecer da Liz (27/11/2026): a chave de confirmação pela DM nas ações críticas do painel (aprovar um plano, reautorizar o Google).
 * Regras da tela, sem React e sem rede (testáveis em Node):
 *  - a pessoa pede a chave; o servidor manda 6 dígitos pela DM (5 minutos, uma vez, presa a esta sessão) e responde só a validade;
 *  - a pessoa digita a chave como quiser ("482913", "482-913", "482 913"); aqui só os dígitos contam, e só 6 dígitos liberam o Confirmar;
 *  - a frase do erro é a do servidor (ele nunca diz o que estava errado: só "inválida ou vencida").
 */

export const DIGITOS_DA_CHAVE = 6;

/** Só os dígitos do que a pessoa digitou. */
export function normalizarChave(texto: string | null | undefined): string {
  return String(texto ?? '').replace(/\D/g, '').slice(0, 12);
}

/** A chave digitada pode ir? (exatamente 6 dígitos) */
export function chavePronta(texto: string | null | undefined): boolean {
  return normalizarChave(texto).length === DIGITOS_DA_CHAVE;
}

/** O texto do campo enquanto a pessoa digita: "482-913" (até 7 caracteres). */
export function mascaraDaChave(texto: string | null | undefined): string {
  const d = normalizarChave(texto).slice(0, DIGITOS_DA_CHAVE);
  return d.length > 3 ? `${d.slice(0, 3)}-${d.slice(3)}` : d;
}

/** O aviso depois de pedir a chave. */
export function textoDaChaveEnviada(r: { expiraEmSegundos?: number } | null | undefined, paraQue: string): string {
  const s = Number(r?.expiraEmSegundos);
  const minutos = Number.isFinite(s) && s > 0 ? Math.max(1, Math.round(s / 60)) : 5;
  return `Mandei uma chave de 6 dígitos na sua DM para ${paraQue}. Ela vale ${minutos} ${minutos === 1 ? 'minuto' : 'minutos'} e só pode ser usada uma vez.`;
}

/** O erro do servidor é da CHAVE (o campo continua aberto para tentar de novo ou pedir outra)? 422 inválida, 428 faltou, 429 travada. */
export function erroDaChave(status: number | null | undefined): boolean {
  return status === 422 || status === 428 || status === 429;
}

export const TEXTOS_DA_CHAVE = Object.freeze({
  paraAprovar: 'aprovar este plano',
  paraGoogle: 'reautorizar o Google',
  rotulo: 'Chave que chegou na DM',
  confirmar: 'Confirmar',
  pedirOutra: 'Pedir outra chave',
  cancelar: 'Cancelar',
});
