// Os três comandos do dono por conversa (DM do Discord e chat do app). PURO. Frases explícitas e a mensagem INTEIRA: um comentário que só cita a live não é comando.
//   "entra na live <link>" (opcional: "por 8 horas")   "sai da live"   "como está a live"
const NOME = String.raw`^\s*(?:(?:oi\s+)?yui\s*[,:!]?\s*)?`;
// Cortesias no fim não mudam o comando (a parada de emergência não pode cair na conversa com a IA).
const FIM = String.raw`(?:[\s,]+(?:agora|já|ja|por\s+favor|por\s+gentileza|pfv|pf|yui))*\s*[.!?]*\s*$`;
const ENTRAR_RE = new RegExp(String.raw`${NOME}(?:entra|entre|entrar)\s+(?:na|nesta|nessa)\s+live\s*:?\s*<?((?:https?:\/\/|(?:(?:www|m)\.)?(?:youtube\.com|youtu\.be)\/)[^\s<>]+?)>?(?:\s+(?:por|de)\s+(\d{1,2})\s*(?:h|hs|horas?))?${FIM}`, 'i');
const SAIR_RE = new RegExp(String.raw`${NOME}(?:sai|saia|sair)\s+da\s+live${FIM}`, 'i');
const STATUS_RE = new RegExp(String.raw`${NOME}como\s+(?:está|esta|tá|ta)\s+a\s+live${FIM}`, 'i');

/** @returns {{ tipo: 'entrar', link: string, horas?: number } | { tipo: 'sair' } | { tipo: 'status' } | null} */
export function pedidoDeLive(texto) {
  const t = String(texto ?? '').trim();
  if (!t || t.length > 400 || /[\r\n]/.test(t)) return null;
  const entrar = ENTRAR_RE.exec(t);
  if (entrar) {
    const horas = Number(entrar[2] ?? 0);
    return { tipo: 'entrar', link: /^https?:/i.test(entrar[1]) ? entrar[1] : `https://${entrar[1]}`, ...(horas > 0 ? { horas } : {}) };
  }
  if (SAIR_RE.test(t)) return { tipo: 'sair' };
  if (STATUS_RE.test(t)) return { tipo: 'status' };
  return null;
}
