// Avisos de live do YouTube: quando editar a mensagem que já foi enviada em vez de mandar outra.
// Módulo puro (sem Discord, rede nem banco): o publicador passa os registros e o relógio, e aqui só se decide.
//
// Modos de cada inscrição (youtube_subscriptions.live_mode):
//   'new'  — uma mensagem nova a cada etapa (agendada, ao vivo, encerrada), como sempre foi;
//   'edit' — uma mensagem só, editada a cada etapa (editar não notifica ninguém);
//   'auto' — edita quando a live começa logo depois de agendada; se foi agendada para mais longe, manda mensagem
//            nova no início (para o cargo ser avisado de novo) e é ESSA que o fim edita.
// O fim da live nunca gera mensagem nova quando existe a do início (ou a da agenda) para editar.

const DEFAULT_AUTO_WINDOW_MIN = 120;

/** Janela do modo automático, em ms (YUI_YT_LIVE_AUTO_EDIT_MIN, de 5 a 1440; padrão 120). Lida a cada uso, nunca no import. */
export function autoEditWindowMs(env = process.env) {
  const n = Number.parseInt(String(env?.YUI_YT_LIVE_AUTO_EDIT_MIN ?? ''), 10);
  const min = Number.isFinite(n) ? Math.min(Math.max(n, 5), 1440) : DEFAULT_AUTO_WINDOW_MIN;
  return min * 60_000;
}

/** 'YYYY-MM-DD HH:MM:SS' (UTC, formato do SQLite) -> ms; null se não der para ler. */
export function parseSqlTime(value) {
  if (!value) return null;
  const text = String(value);
  const ms = Date.parse(text.replace(' ', 'T') + (/[zZ]|[+-]\d\d:?\d\d$/.test(text) ? '' : 'Z'));
  return Number.isNaN(ms) ? null : ms;
}

/**
 * Qual mensagem já enviada deve ser editada para este evento? null = mandar mensagem nova.
 * @param {{mode:string, type:string, scheduledRec:object|null, startedRec:object|null, now?:number, windowMs?:number}} p
 *   scheduledRec / startedRec: { channel_id, message_id, published_at } das publicações anteriores da mesma live neste servidor.
 * @returns {{channel_id:string, message_id:string}|null}
 */
export function pickLiveEditTarget({ mode, type, scheduledRec = null, startedRec = null, now = Date.now(), windowMs = autoEditWindowMs() } = {}) {
  if (mode !== 'edit' && mode !== 'auto') return null;
  if (type === 'live_ended') return startedRec || scheduledRec || null;
  if (type === 'live_started') {
    if (!scheduledRec) return null;
    if (mode === 'edit') return scheduledRec;
    const sentAt = parseSqlTime(scheduledRec.published_at);
    // Sem data legível não dá para saber se foi "logo antes": manda mensagem nova (com o aviso), que é o lado seguro.
    if (sentAt === null) return null;
    return now - sentAt <= windowMs ? scheduledRec : null;
  }
  return null; // agendada é sempre a primeira mensagem; gravação (vod) segue como aviso novo
}
