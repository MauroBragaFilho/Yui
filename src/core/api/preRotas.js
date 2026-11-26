// Pré-rotas por código do chat do app/painel (POST /v1/agent e POST /v1/chat), antes da pesquisa e da IA:
//  - continuidade (projetos e decisões), chave YUI_CONTINUIDADE: ver core/continuidade.js;
//  - listas, lembretes/resumo do dia e memória por conversa, chave YUI_APP_COMANDOS: as MESMAS funções da DM do Discord.
//  - comandos da live do YouTube, chave YUI_YOUTUBE_LIVE (adaptadores/youtube/pedido.js).
// As chaves nascem desligadas e só valem para o DONO na memória pessoal. A resposta daqui não entra no histórico, no fio
// compartilhado nem na captura automática de memória; a auditoria leva só o tipo e o tamanho, nunca o texto.
import * as memoryStore from '../memory/store.js';
import { isMemoryEnabled } from '../discordAdapter.js';
import { audit as coreAudit } from '../audit.js';
import { forgetUserContext } from '../context/contextStore.js';
import { rotearContinuidade, descartarContinuidade } from '../continuidade.js';
import { routeLists, parseListRequest, appComandosLigado } from '../../handlers/listAssistant.js';
import { detectMemoryIntent, runMemoryIntent, hasForgetAllPending, clearForgetAllPending } from '../../handlers/chatIntents.js';
import { routeReminders, parseReminderRequest, getReminderStore } from '../../reminders/assistant.js';
import { youtubeLigado } from '../../adaptadores/youtube/adaptador.js';
import { pedidoDeLive } from '../../adaptadores/youtube/pedido.js';
import { portaDaLive } from '../../adaptadores/youtube/porta.js';
import { logger as defaultLogger } from '../../utils/logger.js';

export const FALHA_LEMBRETES = 'Não consegui mexer nos lembretes agora. Confira com "meus lembretes" e tente de novo daqui a pouco.';
export const FALHA_LISTAS = 'Não consegui mexer nas listas agora. Confira a lista e tente de novo daqui a pouco.';

const chaveDoApp = (userId) => `app:${userId}`; // a confirmação de "apagar tudo" do app não se mistura com a da DM

/**
 * @param {object} p  { ctx, message, histories }
 * @param {object} [deps]  injetáveis nos testes
 * @returns {Promise<null | { reply: string, kind: string }>}  null = segue o fluxo normal
 */
export async function preRotaDoApp({ ctx, message, histories }, {
  env = process.env, memory = memoryStore, reminderStore = getReminderStore, listStore = null, aoMudar = null, aoApagarMemoria = null,
  report = async () => (await import('../../reminders/service.js')).createMorningComposer()(), audit = coreAudit, logger = defaultLogger,
} = {}) {
  if (!ctx?.userId || ctx.role !== 'OWNER' || ctx.memoryScope !== 'personal') return null;
  const userId = String(ctx.userId);
  const falha = (kind, err, reply) => {
    logger.warn(`[API] pré-rota ${kind} falhou: ${String(err?.code ?? err?.name ?? 'erro').slice(0, 60)}`);
    return { kind, reply };
  };

  // A confirmação de "apagar tudo" vale só para a mensagem seguinte: qualquer outra (lista, lembrete, conversa com a IA) a descarta,
  // para um "sim" ou "quero" dito sobre outro assunto não apagar a memória.
  const apagarPendente = hasForgetAllPending(chaveDoApp(userId));
  clearForgetAllPending(chaveDoApp(userId));

  const cont = await rotearContinuidade({ text: message, ctx, interfaceId: 'app', memory, enabled: isMemoryEnabled(), env });
  if (cont.handled) {
    return { kind: `continuidade.${cont.kind}`, reply: cont.text };
  }
  // Comandos da live do YouTube (chave própria, YUI_YOUTUBE_LIVE). Erro nunca cai na IA (ela poderia fingir que entrou ou saiu).
  if (youtubeLigado(env) && pedidoDeLive(message)) {
    try {
      const live = portaDaLive() ? await portaDaLive().rotear({ userId, texto: message, canal: 'app' }) : { handled: true, text: 'A live está indisponível agora.' };
      if (live.handled) return { kind: 'live', reply: live.text };
    } catch (err) {
      return falha('live', err, 'Não consegui falar com o serviço da live agora.');
    }
  }
  if (!appComandosLigado(env)) return null;

  // Mesma ordem da DM: listas, lembretes, memória. Erro em algo que ESCREVE não cai na IA (ela poderia fingir que fez).
  try {
    const listas = await routeLists({ text: message, userId }, { env, store: listStore });
    if (listas.handled) return { kind: 'listas', reply: listas.text };
  } catch (err) {
    if (parseListRequest(message)) return falha('listas', err, FALHA_LISTAS);
  }
  try {
    const lembretes = await routeReminders({ text: message, userId }, { store: reminderStore(), env, report, audit, aoMudar });
    if (lembretes.handled) return { kind: 'lembretes', reply: lembretes.text };
  } catch (err) {
    if (parseReminderRequest(message)) return falha('lembretes', err, FALHA_LEMBRETES);
  }
  const intent = detectMemoryIntent(message, { direct: true, pendingForgetAll: apagarPendente });
  if (intent.kind !== 'none') {
    const run = await runMemoryIntent(intent, {
      userId, pendingKey: chaveDoApp(userId), platform: 'api', isDM: true, enabled: isMemoryEnabled(), memoryCtx: ctx, memory, audit,
      scopeLabel: '🔒 memória pessoal (permanente)',
      wipeContext: async (uid) => {
        histories?.delete(uid);
        descartarContinuidade(uid);
        aoApagarMemoria?.(uid);
        return (await forgetUserContext(uid)).turns;
      },
    });
    if (run.handled) return { kind: `memoria.${intent.kind}`, reply: run.text };
  }
  return null;
}
