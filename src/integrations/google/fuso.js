// Datas no FUSO do dono (YUI_GOOGLE_FUSO), sem biblioteca: só o Intl do Node. "Hoje", "amanhã" e "semana" são dias do fuso, não do servidor nem de UTC.
const DIAS = ['dom.', 'seg.', 'ter.', 'qua.', 'qui.', 'sex.', 'sáb.'];
const pad = (n) => String(n).padStart(2, '0');

/** As partes de um instante no fuso (ano, mês 1-12, dia, hora 0-23, minuto, segundo, dia da semana 0=domingo). */
export function partesNoFuso(instante, fuso) {
  const f = new Intl.DateTimeFormat('en-US', { timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
  const p = Object.fromEntries(f.formatToParts(new Date(instante)).map((x) => [x.type, x.value]));
  const semana = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[p.weekday] ?? 0;
  return { ano: Number(p.year), mes: Number(p.month), dia: Number(p.day), hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second), semana };
}

/** O deslocamento do fuso em relação a UTC naquele instante, em ms (positivo a leste de UTC). */
export function deslocamentoMs(instante, fuso) {
  const t = Math.floor(new Date(instante).getTime() / 1000) * 1000;
  const p = partesNoFuso(t, fuso);
  return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - t;
}

/** O instante (UTC) em que começa o dia `ano-mes-dia` no fuso (00:00 local). */
export function inicioDoDia(ano, mes, dia, fuso) {
  const local = Date.UTC(ano, mes - 1, dia, 0, 0, 0);
  let utc = local - deslocamentoMs(local, fuso);
  const depois = deslocamentoMs(utc, fuso);
  if (local - depois !== utc) utc = local - depois;
  return new Date(utc);
}

/** O mesmo dia do calendário deslocado em `n` dias (puro: usa só o calendário). */
export function somarDias({ ano, mes, dia }, n) {
  const d = new Date(Date.UTC(ano, mes - 1, dia + n));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/**
 * A janela de uma consulta: "hoje", "amanha" ou "semana" (os próximos 7 dias, a partir do começo de hoje).
 * @returns {{ de: Date, ate: Date, rotulo: string, dias: number }}  `de` inclusive, `ate` exclusivo
 */
export function janelaDeConsulta(tipo, agora, fuso) {
  const hoje = partesNoFuso(agora, fuso);
  const base = { ano: hoje.ano, mes: hoje.mes, dia: hoje.dia };
  const [dia0, dias, rotulo] = tipo === 'amanha' ? [1, 1, 'amanhã'] : tipo === 'semana' ? [0, 7, 'os próximos 7 dias'] : [0, 1, 'hoje'];
  const ini = somarDias(base, dia0);
  const fim = somarDias(base, dia0 + dias);
  return { de: inicioDoDia(ini.ano, ini.mes, ini.dia, fuso), ate: inicioDoDia(fim.ano, fim.mes, fim.dia, fuso), rotulo, dias };
}

/** "HH:MM" de um instante no fuso. */
export function formatarHora(instante, fuso) {
  const p = partesNoFuso(instante, fuso);
  return `${pad(p.hora)}:${pad(p.minuto)}`;
}

/** "sex., 20/11" de um instante no fuso (ou de uma data "AAAA-MM-DD" puxada de um evento de dia inteiro). */
export function formatarDia(instanteOuData, fuso) {
  if (typeof instanteOuData === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(instanteOuData)) {
    const [a, m, d] = instanteOuData.split('-').map(Number);
    const semana = new Date(Date.UTC(a, m - 1, d)).getUTCDay();
    return `${DIAS[semana]}, ${pad(d)}/${pad(m)}`;
  }
  const p = partesNoFuso(instanteOuData, fuso);
  return `${DIAS[p.semana]}, ${pad(p.dia)}/${pad(p.mes)}`;
}

/** A data de hoje no fuso, "AAAA-MM-DD". */
export function dataDeHoje(agora, fuso) {
  const p = partesNoFuso(agora, fuso);
  return `${p.ano}-${pad(p.mes)}-${pad(p.dia)}`;
}
