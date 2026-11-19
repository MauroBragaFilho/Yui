// MONITORES de busca do cérebro (etapa 16, proatividade; docs/content_pt/MONITORES.md): "me avisa quando...", desligados por padrão.
//
//   iniciarMonitores({ channel, logger, ownerId, ... }) -> null (YUI_MONITORES desligada: nada é aberto, nada roda, nenhum arquivo nasce)
//                                                      -> { rotear, passada, listar, cancelar, status, parar }
//
// As peças: pedido.js (a frase em português), rota.js (a pré-rota na conversa: só o dono, só mensagem dirigida à Yui), store.js (o estado, dono
// único: o cérebro), executor.js (a passada: busca pela porta central com a reserva de cota própria, assinatura, aviso), entrega.js (a DM ao dono
// com estados e reconciliação, como os lembretes) e assinatura.js (o hash dos resultados e a limpeza dos textos da web).
// O laço é do CÉREBRO (YUI_MONITORES_MS, padrão 10 min): sem o cérebro separado (processo único) não há monitores.
import { audit as auditoria } from '../../core/audit.js';
import { jobAllowed } from '../../core/security/jobGuard.js';
import { ESTADOS, criarStoreDeMonitores } from './store.js';
import { monitoresLigados, reservaDosMonitores, tickDosMonitoresMs } from './config.js';
import { consultaSegura } from './assinatura.js';
import { criarExecutor } from './executor.js';
import { criarRoteador } from './rota.js';
import { ativarBuscaFalsaDosMonitores } from './buscaFalsa.js';

function dmTimeoutMs(env) {
  const n = Number(String(env.YUI_CEREBRO_DM_TIMEOUT_MS ?? '').trim());
  return Number.isFinite(n) && n >= 200 ? Math.round(n) : 30_000;
}

/** Como o painel e a API veem um monitor: id, consulta curta, estado e próxima checagem. Palavras fixas; nunca texto de resultado. */
export function vistaDoMonitor(m) {
  return {
    id: m.id,
    consulta: consultaSegura(m.consulta, 60),
    estado: m.estado,
    proximaChecagem: m.estado === ESTADOS.ATIVO ? m.proximaChecagem : null,
    ate: m.ate,
    avisos: m.avisos,
    ...(m.aviso ? { entrega: m.aviso.estado } : {}),
    ...(m.motivoFim ? { fim: m.motivoFim } : {}),
  };
}

/**
 * Liga os monitores no cérebro. Devolve null com YUI_MONITORES desligada (o padrão).
 * @param {{ channel: {request: Function, isConnected: Function}, logger?: object, ownerId: string|null, env?: object,
 *           buscar?: Function|null, budget?: object|null, store?: object, now?: () => number, tickMs?: number, audit?: Function,
 *           permitido?: (nome: string) => boolean, engine?: () => object }} opcoes
 */
export function iniciarMonitores({
  channel, logger = null, ownerId = null, env = process.env, buscar = null, budget = null, store = null, now = () => Date.now(),
  tickMs = tickDosMonitoresMs(env), audit = auditoria, permitido = jobAllowed, engine = undefined,
} = {}) {
  if (!monitoresLigados(env)) return null;
  const estado = store ?? criarStoreDeMonitores({ env, now, logger });
  const timeoutDm = dmTimeoutMs(env);

  /** Pede UMA DM ao dono pelo bot (a mesma ação dos lembretes). Lança o erro do canal ou do bot: quem chama decide o estado do aviso. */
  const enviar = (texto, { chave, reconciliar = false, desde = null }) => {
    if (!ownerId) return Promise.reject(Object.assign(new Error('Sem destinatário.'), { code: 'BAD_PARAMS' }));
    return channel.request('bot', 'discord.dm.send', { userId: String(ownerId), text: String(texto ?? ''), motivo: 'lembrete', ...(reconciliar ? { reconciliar: true, desde } : {}) }, { idem: chave, timeoutMs: timeoutDm });
  };

  /** O bot está conectado e com o Discord no ar? (a passada dos lembretes pergunta o mesmo antes de começar) */
  async function canalPronto() {
    if (!channel?.isConnected?.('bot')) return false;
    try { return (await channel.request('bot', 'discord.status', {}, { timeoutMs: 5_000 }))?.online === true; } catch { return false; }
  }

  const executor = criarExecutor({
    store: estado, enviar, ownerId, env, now, budget,
    buscar: buscar ?? ativarBuscaFalsaDosMonitores({ env, logger }),
    audit, logger, canalPronto, passadaPermitida: () => permitido('monitores.tick'),
  });
  const roteador = criarRoteador({ store: estado, now, audit, ...(engine ? { engine } : {}) });

  const rodar = (motivo) => executor.passada(motivo).catch(() => ({ erro: true }));
  const primeira = setTimeout(() => { rodar('subida'); }, Math.min(tickMs, 15_000));
  primeira.unref?.();
  const timer = setInterval(() => { rodar('agenda'); }, tickMs);
  timer.unref?.();
  logger?.info?.(`[Monitores] Ligados: passada a cada ${tickMs >= 1000 ? `${Math.round(tickMs / 1000)} s` : `${tickMs} ms`}, reserva de ${reservaDosMonitores(env)}% da cota de busca para a conversa; aviso ao dono pelo bot (canal).`);

  return {
    store: estado,
    /** A pré-rota da conversa (chamada pelo chat.turn do cérebro). */
    rotear: (pedido) => roteador.rotear(pedido),
    /** Uma passada agora (ex.: o bot acabou de conectar e pode haver aviso a confirmar). */
    passada: (motivo = 'pedido') => rodar(motivo),
    /** Os monitores para a rota de administração (só o que a vista mostra). */
    listar: () => estado.todos().map(vistaDoMonitor),
    /** Cancela um monitor pelo painel/API (a pedido do dono). true se cancelou. */
    cancelar(id) {
      const r = estado.cancelar(id);
      if (r.ok) { try { audit('monitor.cancelado', null, { id: Number(id), origem: 'painel' }); } catch { /* */ } }
      return r.ok === true;
    },
    status: () => ({ ligado: true, tickMs, reservaPercentual: reservaDosMonitores(env), ...estado.resumo(), ...executor.status() }),
    parar() {
      clearTimeout(primeira);
      clearInterval(timer);
    },
  };
}
