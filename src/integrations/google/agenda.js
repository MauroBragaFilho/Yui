// A AGENDA do Google, SOMENTE LEITURA (etapa 15): os eventos de um período, em dados enxutos (título, hora, local). Nada é criado, alterado nem apagado.
// calendar/v3/calendars/primary/events com timeMin/timeMax, singleEvents (a série recorrente vira uma instância por dia) e orderBy=startTime.
import { hostsDoGoogle } from './endpoints.js';
import { fusoDoGoogle } from './config.js';
import { lerDoGoogle } from './cliente.js';
import { portaoDoRecurso } from './portao.js';
import { estadoDaRotaPrivada } from '../../core/ai/rotaPerfil.js';
import { janelaDeConsulta } from './fuso.js';

export const MAX_EVENTOS = 25;
const MAX_TEXTO = 300; // o corte final do texto bruto; a limpeza para o prompt é do dados.js

const texto = (v, max) => (typeof v === 'string' ? v.slice(0, max) : '');

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
 * @param {{ autenticador: object, periodo?: 'hoje'|'amanha'|'semana', agora?: () => number, fuso?: string, fetchImpl?: Function, hosts?: () => object, maxEventos?: number, env?: object, estadoDaRota?: Function }} p
 * @returns {Promise<{ ok: true, eventos: object[], janela: object, fuso: string, truncado: boolean, portao: string } | { ok: false, motivo: string }>}
 */
export async function listarEventos({ autenticador, periodo = 'hoje', agora = Date.now, fuso = null, fetchImpl, hosts = hostsDoGoogle, maxEventos = MAX_EVENTOS, env = process.env, estadoDaRota = estadoDaRotaPrivada, timeoutMs }) {
  // O PORTÃO da rota privada (portao.js) ANTES de qualquer chamada ao Google, inclusive a renovação do token: sem ele, nada é baixado.
  const portao = portaoDoRecurso({ recurso: 'agenda', env, estadoDaRota });
  if (!portao.liberado) return { ok: false, motivo: portao.motivo };
  const tz = fuso ?? fusoDoGoogle(env);
  const janela = janelaDeConsulta(periodo, agora(), tz);
  const q = new URLSearchParams({
    timeMin: janela.de.toISOString(), timeMax: janela.ate.toISOString(), singleEvents: 'true', orderBy: 'startTime', maxResults: String(maxEventos + 1),
    timeZone: tz, fields: 'items(summary,start,end,location,status)',
  });
  const r = await lerDoGoogle({ autenticador, recurso: 'agenda', url: `${hosts().agenda}/calendars/primary/events?${q}`, fetchImpl, timeoutMs });
  if (!r.ok) return r;
  const itens = Array.isArray(r.json?.items) ? r.json.items : [];
  const todos = itens.map(eventoEnxuto).filter(Boolean);
  return { ok: true, eventos: todos.slice(0, maxEventos), janela, fuso: tz, truncado: todos.length > maxEventos, portao: portao.motivo };
}
