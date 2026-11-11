// Modos dos avisos de live do YouTube (youtube_subscriptions.live_mode). Módulo puro, sem banco nem Discord:
// o repositório, o publicador, o comando e a API usam as mesmas regras.
//  'new'  = uma mensagem nova a cada etapa (agendada, ao vivo, encerrada), como sempre foi;
//  'edit' = uma mensagem só, editada a cada etapa (sem novo aviso);
//  'auto' = edita quando a live começa logo depois de agendada; se foi agendada para longe, manda mensagem nova no início (com o aviso).
export const LIVE_MODES = Object.freeze(['auto', 'new', 'edit']);
export const DEFAULT_LIVE_MODE = 'auto';
export function normalizeLiveMode(value, fallback = DEFAULT_LIVE_MODE) {
  const v = String(value ?? '').trim().toLowerCase();
  return LIVE_MODES.includes(v) ? v : fallback;
}
