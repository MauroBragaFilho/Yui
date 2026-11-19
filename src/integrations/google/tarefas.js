// As TAREFAS do Google, SOMENTE LEITURA (etapa 15): as pendentes da lista padrão, em dados enxutos (título e prazo). As notas e as outras listas não são lidas.
// tasks/v1/lists/@default/tasks, sem as concluídas nem as escondidas.
import { hostsDoGoogle } from './endpoints.js';
import { lerDoGoogle } from './cliente.js';
import { portaoDoRecurso } from './portao.js';
import { estadoDaRotaPrivada } from '../../core/ai/rotaPerfil.js';

export const MAX_TAREFAS = 25;
/** Tarefas por página pedidas ao Google (o máximo dele é 100) e o teto de páginas seguidas (até 1000 tarefas). */
export const TAMANHO_DA_PAGINA = 100;
export const MAX_PAGINAS = 10;
const MAX_TEXTO = 300;

/** Uma tarefa do Google em dado enxuto, ou null (concluída ou sem título). O prazo do Google guarda só a data: "AAAA-MM-DD" (sem converter de fuso). */
export function tarefaEnxuta(t) {
  if (!t || typeof t !== 'object') return null;
  if (t.status && t.status !== 'needsAction') return null;
  const titulo = typeof t.title === 'string' ? t.title.slice(0, MAX_TEXTO).trim() : '';
  if (!titulo) return null;
  const vence = typeof t.due === 'string' && /^\d{4}-\d{2}-\d{2}/.test(t.due) ? t.due.slice(0, 10) : null;
  return { titulo, vence };
}

/** Com prazo primeiro (do mais antigo ao mais novo), sem prazo depois, na ordem do Google. */
export function ordenarPorPrazo(tarefas) {
  return tarefas.map((t, i) => ({ t, i })).sort((a, b) => {
    if (a.t.vence && b.t.vence) return a.t.vence < b.t.vence ? -1 : a.t.vence > b.t.vence ? 1 : a.i - b.i;
    if (a.t.vence) return -1;
    if (b.t.vence) return 1;
    return a.i - b.i;
  }).map((x) => x.t);
}

/**
 * As tarefas pendentes. `ate` ("AAAA-MM-DD"): só as que vencem até essa data (inclusive; as atrasadas entram); sem `ate`, todas.
 * @returns {Promise<{ ok: true, tarefas: object[], truncado: boolean, portao: string } | { ok: false, motivo: string }>}
 */
export async function listarTarefas({ autenticador, ate = null, fetchImpl, hosts = hostsDoGoogle, maxTarefas = MAX_TAREFAS, env = process.env, estadoDaRota = estadoDaRotaPrivada, timeoutMs, tamanhoDaPagina = TAMANHO_DA_PAGINA, maxPaginas = MAX_PAGINAS }) {
  // O PORTÃO da rota privada (portao.js) ANTES de qualquer chamada ao Google, inclusive a renovação do token: sem ele, nada é baixado.
  const portao = portaoDoRecurso({ recurso: 'tarefas', env, estadoDaRota });
  if (!portao.liberado) return { ok: false, motivo: portao.motivo };
  // O Google devolve as tarefas em páginas: segue o `nextPageToken` (até `maxPaginas`) ANTES de ordenar por prazo e cortar, senão uma tarefa atrasada que está na página 2 some.
  const todasBrutas = [];
  let pagina = null;
  let paginas = 0;
  do {
    const q = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: String(Math.max(1, tamanhoDaPagina)), fields: 'nextPageToken,items(title,due,status)' });
    if (pagina) q.set('pageToken', pagina);
    const r = await lerDoGoogle({ autenticador, recurso: 'tarefas', url: `${hosts().tarefas}/lists/@default/tasks?${q}`, fetchImpl, timeoutMs });
    if (!r.ok) return r;
    const itens = Array.isArray(r.json?.items) ? r.json.items : [];
    for (const t of itens) { const e = tarefaEnxuta(t); if (e) todasBrutas.push(e); }
    paginas += 1;
    pagina = typeof r.json?.nextPageToken === 'string' && r.json.nextPageToken && r.json.nextPageToken.length <= 2000 ? r.json.nextPageToken : null;
  } while (pagina && paginas < maxPaginas);
  let todas = ordenarPorPrazo(todasBrutas);
  if (ate) todas = todas.filter((t) => t.vence && t.vence <= ate);
  // `pagina` ainda preenchida = o teto de páginas foi atingido e há tarefas que não foram lidas: a lista é parcial.
  return { ok: true, tarefas: todas.slice(0, maxTarefas), truncado: todas.length > maxTarefas || Boolean(pagina), portao: portao.motivo };
}
