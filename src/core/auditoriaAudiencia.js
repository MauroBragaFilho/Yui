// Gravação da auditoria de audiência da voz (Fase 1). Só depende de audit.js e politicaAudiencia.js:
// nada de Discord, TTS ou handlers, para o bot e o cérebro poderem importar sem puxar o outro lado.
import { audit } from './audit.js';
import { eventoAuditoria } from './politicaAudiencia.js';

/**
 * Registra a decisão de audiência (ou o bloqueio de um recurso) na auditoria encadeada.
 * Grava SEM userId de propósito: o evento só tem números, flags e códigos (ver eventoAuditoria); quem falou não entra no log.
 * Nunca lança: auditar não pode derrubar nem atrasar a resposta de voz (audit() já alerta o dono se a gravação falhar).
 *
 * @returns {object|null} o evento montado (útil para teste), ou null se nem montar deu
 */
export function registrarAudiencia(decisao, { turnId, bloqueio = null, env = process.env, auditFn = audit } = {}) {
  try {
    const evento = eventoAuditoria(decisao, { turnId, timestamp: Date.now(), bloqueio });
    const { action, ...resto } = evento;
    try {
      auditFn(action, { platform: 'discord', channelKind: 'voz' }, resto, { env });
    } catch {
      // gravação falhou: segue sem lançar
    }
    return evento;
  } catch {
    return null;
  }
}
