// O PORTÃO DA ROTA PRIVADA DE IA (etapa 15, ajuste pedido pela revisão): os dados pessoais do Google (agenda, tarefas, e-mail) NÃO podem ir a um provedor de IA público ou
// gratuito só porque a conversa é privada. Por isso, ANTES de qualquer consulta ao Google (inclusive renovar o token) e antes de qualquer dado entrar num prompt:
//   - exige-se `estadoDaRotaPrivada().estado === 'validada'`, consultado a CADA uso (a rota pode ser bloqueada a qualquer momento);
//   - sem a rota validada: falha FECHADA (nada é baixado, nenhuma IA é chamada, nenhum fallback para provedor público) e uma frase curta e fixa.
// Duas regras de recurso:
//   - AGENDA e TAREFAS: a exceção explícita do dono (YUI_GOOGLE_SEM_ROTA_PRIVADA=true, padrão false, config.js) dispensa o portão. É a decisão expressa de quem aceita que o texto
//     da agenda passe pela IA em nuvem (sempre por provedor NÃO anônimo: a conversa continua sensível);
//   - GMAIL: SEM exceção possível. Só com YUI_GOOGLE_GMAIL=true E a rota validada. Nenhuma chave dispensa isso.
// Este arquivo é a única fonte da regra: agenda.js, tarefas.js e gmail.js a consultam antes de qualquer chamada.
import { estadoDaRotaPrivada } from '../../core/ai/rotaPerfil.js';
import { gmailLigadoPelaChave, semRotaPrivadaPelaChave } from './config.js';

/** A frase (curta e fixa) de cada recurso quando o portão está fechado pela falta da rota privada. */
export const FRASE_AGENDA_SEM_ROTA = 'Ainda não leio a sua agenda: falta a rota privada de IA.';
export const FRASE_TAREFAS_SEM_ROTA = 'Ainda não leio as suas tarefas: falta a rota privada de IA.';
export const FRASE_GMAIL_SEM_ROTA = 'Ainda não leio e-mails: falta a rota privada de IA.';

/**
 * O portão de um recurso AGORA.
 * @param {{ recurso: 'agenda'|'tarefas'|'gmail', env?: object, estadoDaRota?: (env: object) => { estado?: string } }} p
 * @returns {{ liberado: boolean, motivo: 'ok'|'excecao-do-dono'|'sem-rota-privada'|'chave-desligada' }}
 *   'ok' = rota validada; 'excecao-do-dono' = rota NÃO validada, mas a exceção explícita vale (só Agenda e Tarefas);
 *   'chave-desligada' = só o Gmail, sem YUI_GOOGLE_GMAIL; 'sem-rota-privada' = fechado.
 */
export function portaoDoRecurso({ recurso, env = process.env, estadoDaRota = estadoDaRotaPrivada }) {
  if (recurso !== 'agenda' && recurso !== 'tarefas' && recurso !== 'gmail') return { liberado: false, motivo: 'sem-rota-privada' };
  if (recurso === 'gmail' && !gmailLigadoPelaChave(env)) return { liberado: false, motivo: 'chave-desligada' };
  let estado = null;
  try { estado = estadoDaRota(env)?.estado ?? null; } catch { estado = null; }
  if (estado === 'validada') return { liberado: true, motivo: 'ok' };
  // A exceção do dono: só Agenda e Tarefas. O Gmail nunca a lê.
  if (recurso !== 'gmail' && semRotaPrivadaPelaChave(env)) return { liberado: true, motivo: 'excecao-do-dono' };
  return { liberado: false, motivo: 'sem-rota-privada' };
}

/** A frase curta para o portão fechado de um recurso. */
export function fraseDoPortaoFechado(recurso) {
  return recurso === 'tarefas' ? FRASE_TAREFAS_SEM_ROTA : recurso === 'gmail' ? FRASE_GMAIL_SEM_ROTA : FRASE_AGENDA_SEM_ROTA;
}
