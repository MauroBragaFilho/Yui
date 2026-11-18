// OS MOTORES DO AGENTE (etapa 9, só a INTERFACE): o Motor 0 (nativo, o padrão) e o Motor 1 (o Mastra, que NÃO está implementado).
//
// YUI_MOTOR_AGENTE (padrão "nativo"). O valor "mastra" é recusado: o cérebro registra no log e na auditoria, mostra no diagnóstico e continua no
// nativo. Qualquer outro valor também é recusado (motor desconhecido). Nunca instala nada nem carrega o Mastra.
//
// O CONTRATO MÍNIMO de qualquer motor (o do Mastra, no futuro, e o falso dos testes):
//  1. o motor NÃO executa ferramentas: ele devolve PEDIDOS ({ ferramenta, argumentos }). Quem executa é sempre o MESMO executor da Yui (o `executor`
//     que o dono do processo injeta), e só DEPOIS do guardToolCall (que consulta o motor de políticas) e de conferir o pedido;
//  2. o motor recebe só `pedirFerramenta` (o caminho guardado): nunca o executor nem a lista de funções das ferramentas;
//  3. o pedido é só dado: nome de ferramenta e argumentos em JSON; um pedido com função, nome estranho ou argumentos enormes é recusado;
//  4. um pedido por turno por padrão (o agente da Yui faz um passo por vez, de propósito, contra injeção de prompt); os limites de um motor de
//     vários passos serão definidos no piloto do app, com aprovação;
//  5. o motor escolhido (e o perfil de IA que ele use) NÃO concede permissão nenhuma: a decisão do guardToolCall e do motor de políticas é a mesma
//     para qualquer motor e qualquer perfil.
import { guardToolCall } from '../security/discordGuard.js';
import { audit } from '../audit.js';
import { logger as defaultLogger } from '../../utils/logger.js';

export const MOTORES = Object.freeze({
  nativo: Object.freeze({ implementado: true, descricao: 'Motor 0: o agente nativo da Yui (identidade, memória, ferramentas e segurança dela).' }),
  mastra: Object.freeze({ implementado: false, descricao: 'Motor 1: o Mastra (opcional, só no app, com aprovação). Ainda não implementado.' }),
});
export const MOTOR_PADRAO = 'nativo';

/**
 * Escolhe o motor a partir de YUI_MOTOR_AGENTE. O resultado sempre tem `ativo: "nativo"` (o único implementado).
 * @returns {{ pedido: string, ativo: 'nativo', recusado: boolean, motivo: string|null }}
 */
export function lerMotorAgente(env = process.env) {
  const bruto = String(env?.YUI_MOTOR_AGENTE ?? '').trim().toLowerCase();
  if (!bruto || bruto === MOTOR_PADRAO) return { pedido: MOTOR_PADRAO, ativo: 'nativo', recusado: false, motivo: null };
  const nome = /^[a-z][a-z0-9_-]{0,30}$/.test(bruto) ? bruto : 'invalido';
  if (Object.hasOwn(MOTORES, nome) && !MOTORES[nome].implementado) return { pedido: nome, ativo: 'nativo', recusado: true, motivo: 'motor-nao-implementado' };
  return { pedido: nome, ativo: 'nativo', recusado: true, motivo: 'motor-desconhecido' };
}

let ultimo = lerMotorAgente({});
/**
 * A subida do cérebro chama isto: lê, REGISTRA a recusa (log e auditoria) e segue no motor nativo. Nunca lança.
 * @returns {ReturnType<typeof lerMotorAgente>}
 */
export function escolherMotorAgente(env = process.env, { logger = defaultLogger, auditFn = audit } = {}) {
  const r = lerMotorAgente(env);
  ultimo = r;
  if (r.recusado) {
    try { logger?.warn?.(`[Motor] YUI_MOTOR_AGENTE="${r.pedido}" foi recusado (${r.motivo}): o cérebro segue no motor nativo.`); } catch { /* */ }
    try { auditFn('ia.motor_recusado', null, { pedido: r.pedido, motivo: r.motivo, ativo: r.ativo }); } catch { /* */ }
  }
  return r;
}
/** O motor que o processo escolheu (para o diagnóstico). */
export function estadoDoMotor() {
  return { pedido: ultimo.pedido, ativo: ultimo.ativo, recusado: ultimo.recusado, motivo: ultimo.motivo, implementados: { nativo: true, mastra: false } };
}

// ── O executor guardado: o único caminho de uma ferramenta pedida por um motor ──────────────────────────────────────────────────────

const NOME_DE_FERRAMENTA_RE = /^[A-Za-z0-9_.-]{1,64}$/;
const MAX_ARGUMENTOS_BYTES = 20_000;

/** O pedido é só dado? Devolve o pedido limpo { ferramenta, argumentos } ou null. */
export function normalizarPedido(pedido) {
  if (!pedido || typeof pedido !== 'object' || Array.isArray(pedido)) return null;
  if (typeof pedido.ferramenta !== 'string' || !NOME_DE_FERRAMENTA_RE.test(pedido.ferramenta)) return null;
  const argumentos = pedido.argumentos === undefined ? {} : pedido.argumentos;
  if (!argumentos || typeof argumentos !== 'object' || Array.isArray(argumentos)) return null;
  let texto;
  try { texto = JSON.stringify(argumentos, (_k, v) => { if (typeof v === 'function' || typeof v === 'symbol') throw new Error('função'); return v; }); } catch { return null; }
  if (texto === undefined || texto.length > MAX_ARGUMENTOS_BYTES) return null;
  return { ferramenta: pedido.ferramenta, argumentos: JSON.parse(texto) };
}

/**
 * O caminho guardado de UM pedido de ferramenta: confere o pedido, passa pelo guardToolCall (motor de políticas) e só então chama o executor.
 * @param {{ ferramenta: string, argumentos?: object }} pedido
 * @param {{ userId: string, channelId?: string|null, guildId?: string|null, isDM?: boolean, guildAdmin?: boolean }} quem  de quem é o pedido (a política decide por ele)
 * @param {{ executor: (ferramenta: string, argumentos: object) => Promise<unknown>|unknown, guard?: Function, motor?: string, auditFn?: Function }} deps
 * @returns {Promise<{ ok: boolean, bloqueado?: boolean, motivo?: string, mensagem?: string, resultado?: unknown }>}
 */
export async function pedirFerramenta(pedido, quem, { executor, guard = guardToolCall, motor = 'nativo', auditFn = audit } = {}) {
  const p = normalizarPedido(pedido);
  const nota = (decisao) => { try { auditFn('ia.motor_pedido', null, { motor, ferramenta: p?.ferramenta ?? null, decisao }); } catch { /* */ } };
  if (!p) { nota('pedido-invalido'); return { ok: false, motivo: 'pedido-invalido' }; }
  if (typeof executor !== 'function') { nota('sem-executor'); return { ok: false, motivo: 'sem-executor' }; }
  let bloqueio = null;
  try {
    bloqueio = guard({ tool: p.ferramenta, userId: quem?.userId, channelId: quem?.channelId ?? null, guildId: quem?.guildId ?? null, isDM: quem?.isDM === true, guildAdmin: quem?.guildAdmin === true });
  } catch {
    bloqueio = { message: 'Não consegui conferir a política desta ferramenta.' }; // falha do guarda = bloqueio
  }
  if (bloqueio) { nota('bloqueado'); return { ok: false, bloqueado: true, motivo: 'politica', mensagem: String(bloqueio.message ?? '') }; }
  const resultado = await executor(p.ferramenta, p.argumentos);
  nota('executado');
  return { ok: true, resultado };
}

/**
 * Roda um motor (o nativo, o Mastra no futuro, ou um falso de teste) sob o contrato. O motor devolve `{ texto?, pedidos? }`; cada pedido (os que ele
 * mandou por `pedirFerramenta` durante a execução e os que devolveu) passa pelo caminho guardado. Mais pedidos que `maxPedidos` são recusados.
 * @param {{ nome: string, executar: (entrada: object, api: { pedirFerramenta: Function }) => Promise<{ texto?: string, pedidos?: object[] }> }} motor
 * @returns {Promise<{ texto: string, resultados: object[] }>}
 */
export async function rodarMotor(motor, entrada, quem, { executor, guard = guardToolCall, maxPedidos = 1, auditFn = audit } = {}) {
  const nome = String(motor?.nome ?? 'desconhecido').slice(0, 30);
  const resultados = [];
  let usados = 0;
  const guardado = async (pedido) => {
    if (usados >= maxPedidos) { resultados.push({ ok: false, motivo: 'limite-de-pedidos' }); return resultados.at(-1); }
    usados += 1;
    const r = await pedirFerramenta(pedido, quem, { executor, guard, motor: nome, auditFn });
    resultados.push(r);
    return r;
  };
  if (!motor || typeof motor.executar !== 'function') return { texto: '', resultados: [{ ok: false, motivo: 'motor-invalido' }] };
  // O motor só enxerga o caminho guardado (nunca o executor): `api` é a única porta.
  const saida = (await motor.executar(entrada, Object.freeze({ pedirFerramenta: guardado }))) ?? {};
  for (const pedido of Array.isArray(saida.pedidos) ? saida.pedidos : []) await guardado(pedido);
  return { texto: typeof saida.texto === 'string' ? saida.texto : '', resultados };
}
