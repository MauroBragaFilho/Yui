/**
 * Interpretador de "quando" em português (pt-BR) para lembretes. Sem IA e sem rede: só regras, para dar sempre o mesmo resultado.
 *
 *   parseWhen(texto, agora)  -> { ok: true, at: Date, repeat: null | {...}, text }   (text = o que sobrou da frase, sem a parte de tempo)
 *                            -> { ok: false, reason: 'sem-horario' | 'passado' | 'invalido', message }
 *   nextOccurrence(repeat, depois)  -> Date da próxima vez que a repetição cai
 *   describeWhen(at, agora) / describeRepeat(repeat)  -> texto curto para mostrar ("amanhã às 09:00", "toda segunda às 08:00")
 *
 * Tudo é calculado no fuso do processo (no notebook, o horário de Brasília). `agora` é injetável, para testar.
 * Entende: "daqui a 30 minutos", "em 2 horas", "em uma hora e meia", "hoje às 18:30", "amanhã às 9h", "depois de amanhã",
 * "sexta às 10h", "dia 15 às 14h", "15/11 às 10h", "às 15h", "meio-dia", "9 da noite", e repetições: "todo dia às 8h",
 * "de segunda a sexta às 8h", "toda segunda às 9h", "todo dia 5 às 10h", "toda semana".
 */

export const DEFAULT_HOUR = 9;

const WEEKDAYS = { domingo: 0, segunda: 1, terca: 2, quarta: 3, quinta: 4, sexta: 5, sabado: 6 };
const WEEKDAY_NAMES = ['domingo', 'segunda', 'terça', 'quarta', 'quinta', 'sexta', 'sábado'];
const NUMS = { um: 1, uma: 1, dois: 2, duas: 2, tres: 3, quatro: 4, cinco: 5, seis: 6, sete: 7, oito: 8, nove: 9, dez: 10, onze: 11, doze: 12, quinze: 15, vinte: 20, trinta: 30, quarenta: 40, cinquenta: 50, sessenta: 60, meia: 0.5, meio: 0.5 };
const MAX_AHEAD_DAYS = 366 * 2;

/** Mesmo tamanho do original, sem acento e em minúsculas (assim a posição de um trecho vale para as duas versões). */
export function normChars(s) {
  return Array.from(String(s ?? '').normalize('NFC'))
    .map((c) => (c.length > 1 ? ' '.repeat(c.length) : c.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().slice(0, 1) || ' '))
    .join('');
}

const pad = (n) => String(n).padStart(2, '0');
const hm = (h, m) => `${pad(h)}:${pad(m)}`;

function atTime(base, h, m = 0) { const d = new Date(base); d.setHours(h, m, 0, 0); return d; }
function addDays(base, n) { const d = new Date(base); d.setDate(d.getDate() + n); return d; }
function daysInMonth(y, mIdx) { return new Date(y, mIdx + 1, 0).getDate(); }

/** Próxima ocorrência de uma repetição estritamente depois de `after`. */
export function nextOccurrence(repeat, after = new Date()) {
  const { kind, hour, minute = 0 } = repeat;
  const a = new Date(after);
  if (kind === 'daily') {
    const t = atTime(a, hour, minute);
    return t > a ? t : addDays(t, 1);
  }
  if (kind === 'weekdays' || kind === 'weekly') {
    for (let i = 0; i < 9; i++) {
      const t = atTime(addDays(a, i), hour, minute);
      const wd = t.getDay();
      const okDay = kind === 'weekdays' ? wd >= 1 && wd <= 5 : wd === repeat.weekday;
      if (okDay && t > a) return t;
    }
  }
  if (kind === 'monthly') {
    for (let i = 0; i < 3; i++) {
      const base = new Date(a.getFullYear(), a.getMonth() + i, 1);
      const day = Math.min(repeat.day, daysInMonth(base.getFullYear(), base.getMonth()));
      const t = new Date(base.getFullYear(), base.getMonth(), day, hour, minute, 0, 0);
      if (t > a) return t;
    }
  }
  return null;
}

export function describeRepeat(r) {
  if (!r) return '';
  const at = hm(r.hour, r.minute ?? 0);
  if (r.kind === 'daily') return `todo dia às ${at}`;
  if (r.kind === 'weekdays') return `de segunda a sexta às ${at}`;
  if (r.kind === 'weekly') return `toda ${WEEKDAY_NAMES[r.weekday]} às ${at}`;
  if (r.kind === 'monthly') return `todo dia ${r.day} às ${at}`;
  return '';
}

/** "hoje às 15:00", "amanhã às 09:00", "sexta, 14/11 às 10:00", "15/12/2027 às 08:00". */
export function describeWhen(at, now = new Date()) {
  const d = new Date(at);
  const startToday = atTime(now, 0, 0);
  const diffDays = Math.round((atTime(d, 0, 0) - startToday) / 86400000);
  const time = hm(d.getHours(), d.getMinutes());
  if (diffDays === 0) return `hoje às ${time}`;
  if (diffDays === 1) return `amanhã às ${time}`;
  const date = `${pad(d.getDate())}/${pad(d.getMonth() + 1)}${d.getFullYear() !== now.getFullYear() ? `/${d.getFullYear()}` : ''}`;
  if (diffDays > 1 && diffDays < 7) return `${WEEKDAY_NAMES[d.getDay()]}, ${date} às ${time}`;
  return `${date} às ${time}`;
}

function numberOf(tok) {
  if (tok === undefined || tok === null) return null;
  if (/^\d+(?:[.,]\d+)?$/.test(tok)) return Number(tok.replace(',', '.'));
  return NUMS[tok] ?? null;
}

const UNIT_MS = { segundo: 1000, minuto: 60_000, min: 60_000, hora: 3_600_000, h: 3_600_000, hr: 3_600_000, dia: 86_400_000, semana: 604_800_000 };
function unitOf(u) { return UNIT_MS[u.replace(/s$/, '')] ?? null; }

/**
 * Procura a parte de tempo no texto e devolve o instante. `text` é a frase SEM o verbo ("me lembra"): o que sobrar,
 * sem a parte de tempo, vem em `text`.
 */
export function parseWhen(input, now = new Date(), { defaultHour = DEFAULT_HOUR } = {}) {
  const original = String(input ?? '').normalize('NFC');
  const n = normChars(original);
  const spans = [];
  const take = (m) => { spans.push([m.index, m.index + m[0].length]); return m; };
  const fail = (reason, message) => ({ ok: false, reason, message });

  // ── 1) repetição ──
  let repeat = null;
  let m;
  if ((m = /\b(?:de segunda a sexta|dias uteis|todo dia util|todos os dias uteis)\b/.exec(n))) { take(m); repeat = { kind: 'weekdays' }; }
  else if ((m = /\b(?:todos os dias|todo dia(?! \d)|diariamente|todo santo dia)\b/.exec(n))) { take(m); repeat = { kind: 'daily' }; }
  else if ((m = /\btod[oa]s? (?:as? |os )?(segunda|terca|quarta|quinta|sexta|sabado|domingo)s?(?:-feira)?\b/.exec(n))) { take(m); repeat = { kind: 'weekly', weekday: WEEKDAYS[m[1]] }; }
  else if ((m = /\btodo dia (\d{1,2})\b/.exec(n))) { take(m); repeat = { kind: 'monthly', day: Number(m[1]) }; }
  else if ((m = /\btodo mes\b/.exec(n))) { take(m); repeat = { kind: 'monthly', day: now.getDate() }; }
  else if ((m = /\btoda semana\b/.exec(n))) { take(m); repeat = { kind: 'weekly', weekday: now.getDay() }; }
  if (repeat?.kind === 'monthly' && (repeat.day < 1 || repeat.day > 31)) return fail('invalido', 'Esse dia do mês não existe.');

  // ── 2) duração relativa ("daqui a 2 horas", "em meia hora", "em uma hora e meia") ──
  let relative = null;
  if (!repeat) {
    const rel = /\b(?:daqui a|daqui|de aqui a|em|dentro de)\s+(\d+(?:[.,]\d+)?|um|uma|dois|duas|tres|quatro|cinco|seis|sete|oito|nove|dez|onze|doze|quinze|vinte|trinta|quarenta|cinquenta|sessenta|meia|meio)\s*(segundos?|minutos?|min|horas?|hrs?|h|dias?|semanas?)\b(?:\s+e\s+(meia|\d{1,2}\s*(?:minutos?|min)))?/.exec(n);
    if (rel) {
      let qty = numberOf(rel[1]);
      const unit = unitOf(rel[2]);
      if (qty !== null && unit) {
        let ms = qty * unit;
        if (rel[3]) ms += rel[3] === 'meia' ? unit / 2 : Number(rel[3].replace(/\D+/g, '')) * 60_000;
        if (ms < 30_000) return fail('invalido', 'O menor prazo é 1 minuto.');
        take(rel); relative = new Date(now.getTime() + ms);
      }
    } else if ((m = /\b(?:daqui a|em|dentro de)\s+meia hora\b/.exec(n))) { take(m); relative = new Date(now.getTime() + 30 * 60_000); }
  }
  if (relative) {
    if (relative.getTime() - now.getTime() > MAX_AHEAD_DAYS * 86400000) return fail('invalido', 'Isso é longe demais (o limite é 2 anos).');
    return { ok: true, at: relative, repeat: null, text: stripSpans(original, spans) };
  }

  // ── 3) dia (hoje, amanhã, dia da semana, dia 15, 15/11) ──
  let day = null; // { date: Date (meia-noite), kind: 'hoje'|'amanha'|'semana'|'data', ... }
  if (/\b(?:ontem|anteontem)\b/.test(n)) return fail('passado', 'Isso já passou.');
  if ((m = /\bdepois de amanha\b/.exec(n))) { take(m); day = { date: addDays(atTime(now, 0), 2), kind: 'amanha' }; }
  else if ((m = /\bamanha\b(?!\s+(?:de |a )?(?:manha))/.exec(n)) && !/\bamanha (?:de )?(?:manha|cedo)\b/.test(n)) { take(m); day = { date: addDays(atTime(now, 0), 1), kind: 'amanha' }; }
  else if ((m = /\bhoje\b/.exec(n))) { take(m); day = { date: atTime(now, 0), kind: 'hoje' }; }
  else if ((m = /\b(?:(?:no|na|nesta|nessa|neste|nesse|proxim[oa]|o|a|para|pra)\s+)*(segunda|terca|quarta|quinta|sexta|sabado|domingo)(?:-feira)?\b/.exec(n)) && !repeat) {
    take(m);
    const wd = WEEKDAYS[m[1]];
    const proxima = /proxim[oa]/.test(m[0]);
    let delta = (wd - now.getDay() + 7) % 7;
    if (delta === 0 && proxima) delta = 7;
    day = { date: addDays(atTime(now, 0), delta), kind: 'semana', weekday: wd, delta };
  } else if ((m = /\b(?:no |em |para |pra )?(?:dia )?(\d{1,2})\/(\d{1,2})(?:\/(\d{2,4}))?\b/.exec(n))) {
    take(m);
    let y = m[3] ? Number(m[3]) : now.getFullYear();
    if (y < 100) y += 2000;
    const mo = Number(m[2]) - 1; const dd = Number(m[1]);
    if (mo < 0 || mo > 11 || dd < 1 || dd > daysInMonth(y, mo)) return fail('invalido', 'Essa data não existe.');
    let date = new Date(y, mo, dd);
    if (!m[3] && date < atTime(now, 0)) date = new Date(y + 1, mo, dd);
    day = { date, kind: 'data' };
  } else if ((m = /\b(?:no |em |para |pra )?dia (\d{1,2})\b(?!\s*(?:de|do|da)\s+(?:semana))/.exec(n))) {
    take(m);
    const dd = Number(m[1]);
    if (dd < 1 || dd > 31) return fail('invalido', 'Esse dia do mês não existe.');
    let y = now.getFullYear(); let mo = now.getMonth();
    if (dd < now.getDate()) { mo += 1; if (mo > 11) { mo = 0; y += 1; } }
    if (dd > daysInMonth(y, mo)) return fail('invalido', `O mês ${pad(mo + 1)} não tem dia ${dd}.`);
    day = { date: new Date(y, mo, dd), kind: 'data', fromDayWord: true };
  }

  // ── 4) hora do dia ──
  let h = null; let min = 0; let hasTime = false;
  if ((m = /\bmeio[- ]?dia\b/.exec(n))) { take(m); h = 12; hasTime = true; }
  else if ((m = /\bmeia[- ]?noite\b/.exec(n))) { take(m); h = 0; hasTime = true; }
  else {
    // Três jeitos de dizer a hora: com preposição ("às 9", "às 9h30"), com marca ("9h", "9:30") ou com o período ("9 da noite").
    const withPrep = /\b(?:as|a|pelas|ate as)\s+(\d{1,2})(?:\s*(?::|h|horas?)\s*(\d{2})?)?\b(?:\s+(?:da |de )?(manha|tarde|noite|madrugada))?/.exec(n);
    const withMark = /\b(\d{1,2})\s*(?::|h|horas?)\s*(\d{2})?\b(?:\s+(?:da |de )?(manha|tarde|noite|madrugada))?/.exec(n);
    const withPeriod = /\b(\d{1,2})()\s+(?:da |de )?(manha|tarde|noite|madrugada)\b/.exec(n);
    const t = [withPrep, withMark, withPeriod].filter(Boolean).sort((a, b) => a.index - b.index || b[0].length - a[0].length)[0];
    if (t) {
      let hh = Number(t[1]); const mm = t[2] ? Number(t[2]) : 0; const per = t[3];
      if (per === 'tarde' || per === 'noite') { if (hh < 12) hh += 12; if (per === 'noite' && hh === 24) hh = 0; }
      if (per === 'madrugada' && hh === 12) hh = 0;
      if (hh > 23 || mm > 59) return fail('invalido', 'Esse horário não existe.');
      // leva junto a preposição que vem logo antes ("às"), para ela não sobrar no texto do lembrete
      const before = /(?:^|\s)(?:as|a|pelas|ate as)\s+$/.exec(n.slice(0, t.index));
      spans.push([before ? t.index - before[0].replace(/^\s/, '').length : t.index, t.index + t[0].length]);
      h = hh; min = mm; hasTime = true;
    }
    // só o período ("amanhã de manhã", "hoje à noite"): horários padrão
    if (!hasTime && day) {
      const per = /\b(?:de |pela |a |à )?(manha|tarde|noite)\b/.exec(n);
      if (per) { take(per); h = { manha: 8, tarde: 15, noite: 20 }[per[1]]; hasTime = true; }
    }
  }

  // ── 5) juntar ──
  const rest = stripSpans(original, spans);
  if (repeat) {
    if (!hasTime) { h = defaultHour; min = 0; }
    const r = { ...repeat, hour: h, minute: min };
    const at = nextOccurrence(r, now);
    if (!at) return fail('invalido', 'Não consegui calcular essa repetição.');
    return { ok: true, at, repeat: r, text: rest };
  }
  if (!day && !hasTime) return fail('sem-horario', 'Não achei quando.');
  let at;
  if (day) {
    if (!hasTime) {
      if (day.kind === 'hoje') return fail('sem-horario', 'Hoje a que horas?');
      h = defaultHour; min = 0;
    }
    at = atTime(day.date, h, min);
    if (at <= now) {
      if (day.kind === 'semana' && day.delta === 0) at = addDays(at, 7); // "na sexta às 9h" dito na sexta depois das 9h: a da semana que vem
      else if (day.fromDayWord) at = atTime(new Date(day.date.getFullYear(), day.date.getMonth() + 1, day.date.getDate()), h, min);
      else return fail('passado', day.kind === 'hoje' ? 'Esse horário já passou hoje.' : 'Essa data já passou.');
    }
  } else {
    at = atTime(now, h, min);
    if (at <= new Date(now.getTime() + 30_000)) at = addDays(at, 1); // só a hora ("às 15h") e já passou: amanhã
  }
  if (at.getTime() - now.getTime() > MAX_AHEAD_DAYS * 86400000) return fail('invalido', 'Isso é longe demais (o limite é 2 anos).');
  return { ok: true, at, repeat: null, text: rest };
}

/** Remove os trechos já lidos (índices do texto normalizado, que valem no original) e arruma os espaços. */
function stripSpans(original, spans) {
  const chars = original.split(''); // por unidade UTF-16, como os índices do texto normalizado (emoji fica inteiro: só se remove texto ASCII)
  const dead = new Array(chars.length).fill(false);
  for (const [a, b] of spans) for (let i = a; i < b && i < dead.length; i++) dead[i] = true;
  return chars.filter((_, i) => !dead[i]).join('').replace(/\s{2,}/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}
