// A AGENDA do Google, SOMENTE LEITURA (etapa 15): os eventos de um período, em dados enxutos (título, hora, local). Nada é criado, alterado nem apagado.
// calendar/v3/calendars/primary/events com timeMin/timeMax, singleEvents (a série recorrente vira uma instância por dia) e orderBy=startTime.
import { hostsDoGoogle } from './endpoints.js';
import { fusoDoGoogle } from './config.js';
import { lerDoGoogle } from './cliente.js';
import { portaoDoRecurso } from './portao.js';
import { estadoDaRotaPrivada } from '../../core/ai/rotaPerfil.js';
import { janelaDeConsulta, dataDeHoje, somarDias } from './fuso.js';

export const MAX_EVENTOS = 25;
/** Quantos eventos pedir por página ao Google e até quantas páginas seguir (o teto evita um laço sem fim com uma agenda enorme). */
export const TAMANHO_DA_PAGINA = 50;
export const MAX_PAGINAS = 5;
const MAX_TEXTO = 300; // o corte final do texto bruto; a limpeza para o prompt é do dados.js
const DATA_RE = /^\d{4}-\d{2}-\d{2}$/;

const texto = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

/** O dono RECUSOU o convite (o participante marcado como `self` tem `responseStatus: declined`): o compromisso não vale para ele e fica de fora. */
export function recusadoPeloDono(e) {
  return Array.isArray(e?.attendees) && e.attendees.some((a) => a && typeof a === 'object' && a.self === true && a.responseStatus === 'declined');
}

/**
 * Um evento de DIA INTEIRO cobre algum dia de [diaDe, diaAte)? As datas são "AAAA-MM-DD" do fuso do dono; no Google o `end.date` é EXCLUSIVO (um evento de um dia só
 * tem end = start + 1). O Google decide o dia inteiro pelo fuso da AGENDA, não pelo da consulta: um evento do dia vizinho pode voltar na janela, então a conferência é em código.
 * Evento com horário (ou que não é de dia inteiro) passa direto: quem decide é o Google (timeMin/timeMax).
 */
export function diaInteiroDentroDaJanela(e, diaDe, diaAte) {
  const inicio = e?.start?.date;
  if (e?.start?.dateTime || typeof inicio !== 'string' || !DATA_RE.test(inicio)) return true;
  const fimBruto = e?.end?.date;
  let fim = typeof fimBruto === 'string' && DATA_RE.test(fimBruto) && fimBruto > inicio ? fimBruto : null;
  if (!fim) { const [a, m, d] = inicio.split('-').map(Number); const n = somarDias({ ano: a, mes: m, dia: d }, 1); fim = `${n.ano}-${String(n.mes).padStart(2, '0')}-${String(n.dia).padStart(2, '0')}`; }
  return inicio < diaAte && fim > diaDe;
}

/** Um evento do Google em dado enxuto, ou null (cancelado ou sem horário). */
export function eventoEnxuto(e) {
  if (!e || typeof e !== 'object' || e.status === 'cancelled') return null;
  const ini = e.start?.dateTime ?? null;
  const dia = e.start?.date ?? null;
  if (ini && !Number.isNaN(Date.parse(ini))) {
    const fim = e.end?.dateTime && !Number.isNaN(Date.parse(e.end.dateTime)) ? e.end.dateTime : null;
    return { titulo: texto(e.summary, MAX_TEXTO) || '(sem título)', inicio: ini, fim, diaInteiro: false, local: texto(e.location, MAX_TEXTO) || null };
  }
  if (dia && /^\d{4}-\d{2}-\d{2}$/.test(dia)) {
    return { titulo: texto(e.summary, MAX_TEXTO) || '(sem título)', inicio: dia, fim: null, diaInteiro: true, local: texto(e.location, MAX_TEXTO) || null };
  }
  return null;
}

/**
 * Os eventos de hoje, de amanhã ou da semana (os próximos 7 dias), no fuso configurado.
 * Fica de fora: o cancelado, o convite que o dono recusou e o evento de dia inteiro de outro dia (conferido em código). Segue o `nextPageToken` do Google (até `maxPaginas` páginas)
 * para que o que sobrou depois desses filtros não se perca atrás da primeira página.
 * @param {{ autenticador: object, periodo?: 'hoje'|'amanha'|'semana', agora?: () => number, fuso?: string, fetchImpl?: Function, hosts?: () => object, maxEventos?: number, env?: object, estadoDaRota?: Function, tamanhoDaPagina?: number, maxPaginas?: number }} p
 * @returns {Promise<{ ok: true, eventos: object[], janela: object, fuso: string, truncado: boolean, portao: string } | { ok: false, motivo: string }>}
 */
export async function listarEventos({ autenticador, periodo = 'hoje', agora = Date.now, fuso = null, fetchImpl, hosts = hostsDoGoogle, maxEventos = MAX_EVENTOS, env = process.env, estadoDaRota = estadoDaRotaPrivada, timeoutMs, tamanhoDaPagina = TAMANHO_DA_PAGINA, maxPaginas = MAX_PAGINAS }) {
  // O PORTÃO da rota privada (portao.js) ANTES de qualquer chamada ao Google, inclusive a renovação do token: sem ele, nada é baixado.
  const portao = portaoDoRecurso({ recurso: 'agenda', env, estadoDaRota });
  if (!portao.liberado) return { ok: false, motivo: portao.motivo };
  const tz = fuso ?? fusoDoGoogle(env);
  const janela = janelaDeConsulta(periodo, agora(), tz);
  // Os dias (AAAA-MM-DD, no fuso do dono) que a janela cobre: [diaDe, diaAte). O `ate` da janela é a meia-noite do dia seguinte, então o seu dia já é o exclusivo.
  const diaDe = dataDeHoje(janela.de, tz);
  const diaAte = dataDeHoje(janela.ate, tz);
  const todos = [];
  let pagina = null;
  let paginas = 0;
  do {
    const q = new URLSearchParams({
      timeMin: janela.de.toISOString(), timeMax: janela.ate.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(Math.max(2, tamanhoDaPagina)),
      timeZone: tz, fields: 'nextPageToken,items(summary,start,end,location,status,attendees(self,responseStatus))',
    });
    if (pagina) q.set('pageToken', pagina);
    const r = await lerDoGoogle({ autenticador, recurso: 'agenda', url: `${hosts().agenda}/calendars/primary/events?${q}`, fetchImpl, timeoutMs });
    if (!r.ok) return r;
    const itens = Array.isArray(r.json?.items) ? r.json.items : [];
    for (const item of itens) {
      if (recusadoPeloDono(item) || !diaInteiroDentroDaJanela(item, diaDe, diaAte)) continue;
      const e = eventoEnxuto(item);
      if (e) todos.push(e);
    }
    paginas += 1;
    pagina = typeof r.json?.nextPageToken === 'string' && r.json.nextPageToken && r.json.nextPageToken.length <= 2000 ? r.json.nextPageToken : null;
  } while (pagina && todos.length <= maxEventos && paginas < maxPaginas);
  // Sobrou uma página que não foi lida (o teto de páginas ou já há eventos de sobra): há mais compromissos do que os mostrados.
  return { ok: true, eventos: todos.slice(0, maxEventos), janela, fuso: tz, truncado: todos.length > maxEventos || Boolean(pagina), portao: portao.motivo };
}
