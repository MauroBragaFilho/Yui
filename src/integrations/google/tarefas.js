// As TAREFAS do Google, SOMENTE LEITURA (etapa 15): as pendentes da lista padrão, em dados enxutos (título e prazo). As notas e as outras listas não são lidas.
// tasks/v1/lists/@default/tasks, sem as concluídas nem as escondidas.
import { hostsDoGoogle } from './endpoints.js';
import { lerDoGoogle } from './cliente.js';
import { portaoDoRecurso } from './portao.js';
import { estadoDaRotaPrivada } from '../../core/ai/rotaPerfil.js';

export const MAX_TAREFAS = 25;
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
export async function listarTarefas({ autenticador, ate = null, fetchImpl, hosts = hostsDoGoogle, maxTarefas = MAX_TAREFAS, env = process.env, estadoDaRota = estadoDaRotaPrivada, timeoutMs }) {
  // O PORTÃO da rota privada (portao.js) ANTES de qualquer chamada ao Google, inclusive a renovação do token: sem ele, nada é baixado.
  const portao = portaoDoRecurso({ recurso: 'tarefas', env, estadoDaRota });
  if (!portao.liberado) return { ok: false, motivo: portao.motivo };
  const q = new URLSearchParams({ showCompleted: 'false', showHidden: 'false', maxResults: '100', fields: 'items(title,due,status)' });
  const r = await lerDoGoogle({ autenticador, recurso: 'tarefas', url: `${hosts().tarefas}/lists/@default/tasks?${q}`, fetchImpl, timeoutMs });
  if (!r.ok) return r;
  const itens = Array.isArray(r.json?.items) ? r.json.items : [];
  let todas = ordenarPorPrazo(itens.map(tarefaEnxuta).filter(Boolean));
  if (ate) todas = todas.filter((t) => t.vence && t.vence <= ate);
  return { ok: true, tarefas: todas.slice(0, maxTarefas), truncado: todas.length > maxTarefas, portao: portao.motivo };
}
