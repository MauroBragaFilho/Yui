// O FUSO DO DONO: o único lugar que sabe em que fuso horário a pessoa vive. Tudo que a Yui FALA de hora, dia ou "hoje/amanhã" com a pessoa (a hora que ela
// diz, os lembretes, o relatório matinal, a agenda do Google, a data na pesquisa) passa por aqui. Sem biblioteca: só o Intl do Node.
//
//   YUI_FUSO   nome IANA do fuso do dono (ex.: America/Cuiaba). Padrão do CÓDIGO: America/Sao_Paulo (quem não configurar continua como sempre foi).
//              Valor inválido cai no padrão, com UM aviso no log (por valor, não a cada uso).
//
// O que NÃO passa por aqui, de propósito (infraestrutura e calendário de terceiros): os agendadores em UTC e o relógio dos resets do GTA (src/utils/gtaSeed.js,
// src/scheduler), a chave da semana (src/utils/weekKey.js), os dias dos logs, a cota diária de APIs e o banco. Eles seguem o relógio deles, não o da pessoa.

export const FUSO_PADRAO = 'America/Sao_Paulo';

const formatadores = new Map();
function formatadorDe(fuso) {
  let f = formatadores.get(fuso);
  if (!f) {
    f = new Intl.DateTimeFormat('en-US', { timeZone: fuso, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric', weekday: 'short' });
    formatadores.set(fuso, f);
  }
  return f;
}

/** `fuso` é um nome IANA que o Node conhece? */
export function fusoValido(fuso) {
  try {
    new Intl.DateTimeFormat('pt-BR', { timeZone: String(fuso) }).format(new Date(0));
    return true;
  } catch {
    return false;
  }
}

const avisados = new Set();

function avisoPadrao(texto) {
  import('../utils/logger.js').then((m) => m.logger.warn(texto)).catch(() => { try { console.warn(texto); } catch { /* sem log */ } });
}

/** Esquece os valores já avisados (só para teste). */
export function reiniciarAvisosDoFuso() { avisados.clear(); }

/**
 * O fuso do dono: YUI_FUSO se for um nome IANA válido; senão o padrão (America/Sao_Paulo).
 * Valor inválido: usa o padrão e avisa UMA vez por valor. `aviso` é injetável (teste).
 */
export function fusoDoDono(env = process.env, { aviso = avisoPadrao } = {}) {
  const bruto = String(env?.YUI_FUSO ?? '').trim();
  if (!bruto) return FUSO_PADRAO;
  if (fusoValido(bruto)) return bruto;
  if (!avisados.has(bruto)) {
    avisados.add(bruto);
    try { aviso(`[Fuso] YUI_FUSO="${bruto.slice(0, 60)}" não é um fuso válido (use um nome IANA, como America/Cuiaba); usando ${FUSO_PADRAO}.`); } catch { /* o aviso nunca derruba a conversa */ }
  }
  return FUSO_PADRAO;
}

const SEMANA = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };

/** As partes de um instante no fuso (ano, mês 1-12, dia, hora 0-23, minuto, segundo, dia da semana 0=domingo). */
export function partesNoFuso(instante, fuso = fusoDoDono()) {
  const p = Object.fromEntries(formatadorDe(fuso).formatToParts(new Date(instante)).map((x) => [x.type, x.value]));
  return { ano: Number(p.year), mes: Number(p.month), dia: Number(p.day), hora: Number(p.hour) % 24, minuto: Number(p.minute), segundo: Number(p.second), semana: SEMANA[p.weekday] ?? 0 };
}

/** O deslocamento do fuso em relação a UTC naquele instante, em ms (positivo a leste de UTC). */
export function deslocamentoMs(instante, fuso = fusoDoDono()) {
  const t = Math.floor(new Date(instante).getTime() / 1000) * 1000;
  const p = partesNoFuso(t, fuso);
  return Date.UTC(p.ano, p.mes - 1, p.dia, p.hora, p.minuto, p.segundo) - t;
}

/**
 * O instante (UTC) em que o relógio do fuso marca `ano-mes-dia hora:minuto` (mês 1-12). Valores fora da faixa viram o calendário
 * seguinte (dia 32 = dia 1 do mês seguinte), como no Date. Se a hora não existe (salto do horário de verão), vale a hora seguinte.
 */
export function instanteNoFuso(ano, mes, dia, hora = 0, minuto = 0, fuso = fusoDoDono()) {
  const local = Date.UTC(ano, mes - 1, dia, hora, minuto, 0);
  let utc = local - deslocamentoMs(local, fuso);
  const depois = deslocamentoMs(utc, fuso);
  if (local - depois !== utc) utc = local - depois;
  return new Date(utc);
}

/** O instante em que começa o dia `ano-mes-dia` no fuso (00:00 local). */
export function inicioDoDia(ano, mes, dia, fuso = fusoDoDono()) {
  return instanteNoFuso(ano, mes, dia, 0, 0, fuso);
}

/** O mesmo dia do calendário deslocado em `n` dias (puro: usa só o calendário). */
export function somarDias({ ano, mes, dia }, n) {
  const d = new Date(Date.UTC(ano, mes - 1, dia + n));
  return { ano: d.getUTCFullYear(), mes: d.getUTCMonth() + 1, dia: d.getUTCDate() };
}

/** Quantos dias tem o mês (mês 1-12). */
export function diasNoMes(ano, mes) {
  return new Date(Date.UTC(ano, mes, 0)).getUTCDate();
}

/** A chave do dia no fuso, "AAAA-MM-DD". */
export function chaveDoDia(instante, fuso = fusoDoDono()) {
  const p = partesNoFuso(instante, fuso);
  return `${p.ano}-${String(p.mes).padStart(2, '0')}-${String(p.dia).padStart(2, '0')}`;
}

/** Diferença em dias de calendário entre o dia de `instante` e o de `base`, no fuso (0 = mesmo dia, 1 = o dia seguinte). */
export function diasDeDiferenca(instante, base, fuso = fusoDoDono()) {
  const a = partesNoFuso(instante, fuso); const b = partesNoFuso(base, fuso);
  return Math.round((Date.UTC(a.ano, a.mes - 1, a.dia) - Date.UTC(b.ano, b.mes - 1, b.dia)) / 86_400_000);
}

// Nomes de lugar para o texto ("horário de Cuiabá"): só os fusos do Brasil, com acento. Os outros aparecem pelo nome IANA.
const LUGAR_DO_FUSO = {
  'America/Sao_Paulo': 'Brasília', 'America/Cuiaba': 'Cuiabá', 'America/Campo_Grande': 'Campo Grande', 'America/Manaus': 'Manaus',
  'America/Porto_Velho': 'Porto Velho', 'America/Boa_Vista': 'Boa Vista', 'America/Rio_Branco': 'Rio Branco', 'America/Belem': 'Belém',
  'America/Fortaleza': 'Fortaleza', 'America/Recife': 'Recife', 'America/Bahia': 'Salvador', 'America/Maceio': 'Maceió',
  'America/Araguaina': 'Araguaína', 'America/Santarem': 'Santarém', 'America/Eirunepe': 'Eirunepé', 'America/Noronha': 'Fernando de Noronha',
};

/** Como o texto chama o fuso: "horário de Brasília" (padrão), "horário de Cuiabá"... ou "fuso America/Xyz" para um nome que não conhecemos. */
export function rotuloDoFuso(fuso = fusoDoDono()) {
  const lugar = LUGAR_DO_FUSO[fuso];
  return lugar ? `horário de ${lugar}` : `fuso ${fuso}`;
}

/** Data e hora de um instante no fuso, em português: { day: 'terça-feira, 6 de outubro de 2026', time: '12:30' }. */
export function dataEHoraNoFuso(instante = new Date(), fuso = fusoDoDono()) {
  const day = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).format(instante);
  const time = new Intl.DateTimeFormat('pt-BR', { timeZone: fuso, hour: '2-digit', minute: '2-digit' }).format(instante);
  return { day, time };
}
