// Fase 2: o chat do painel/app do DONO usa o MESMO fio de conversa da DM do Discord (e o mesmo da voz privada).
// YUI_HISTORICO_COMPARTILHADO=true (padrão: desligado). A API roda no processo dono dos arquivos de contexto, então é o mesmo store, sem armazenamento novo.
//
// Regras (falha fechada: em qualquer dúvida o chat fica com o histórico em RAM de sempre):
//  - só o DONO com escopo pessoal; outra pessoa autenticada nunca lê nem grava o fio de ninguém;
//  - só com o contexto por horas ligado (YUI_CONTEXT...): este módulo não cria retenção nova;
//  - turno que pesquisou na web nunca entra no fio (a mesma regra do cérebro);
//  - as falas levam a etiqueta source='app' (só de armazenamento);
//  - "esquecer tudo" já apaga os fios da pessoa (forgetUserContext).
import {
  initContextStore, resolveContextTarget, readContextTurns, recordContextExchange, isUnsafeForContext, isErrorReply,
} from '../context/contextStore.js';
import { logger as defaultLogger } from '../../utils/logger.js';

export function historicoCompartilhadoLigado(env = process.env) {
  return String(env.YUI_HISTORICO_COMPARTILHADO ?? '').trim().toLowerCase() === 'true';
}

/**
 * O fio compartilhado deste pedido, ou null (segue o histórico em RAM do app).
 * @returns {Promise<null | { ler: () => Array<{role:string,content:string}>, gravar: (userText: string, assistantText: string) => boolean }>}
 */
export async function fioCompartilhado(ctx, { env = process.env, logger = defaultLogger, store = {} } = {}) {
  if (!historicoCompartilhadoLigado(env)) return null;
  if (!ctx?.userId || ctx.role !== 'OWNER' || ctx.memoryScope !== 'personal') return null;
  const api = { init: initContextStore, resolve: resolveContextTarget, read: readContextTurns, record: recordContextExchange, ...store };
  try {
    const alvo = api.resolve({ userId: ctx.userId, channelId: null, guildId: null, personal: true, env });
    if (!alvo?.active) return null; // contexto por horas desligado ou fora do escopo
    await api.init();
    return {
      ler: () => api.read(alvo, { sensitive: true }),
      // a mesma peneira do cérebro: marcador/JSON de ferramenta (viraria injeção que volta a cada pergunta) e aviso de erro da IA não entram no fio
      gravar: (userText, assistantText) => {
        if (isUnsafeForContext(userText) || isUnsafeForContext(assistantText) || isErrorReply(assistantText)) return false;
        return api.record(alvo, { userText, assistantText, source: 'app' });
      },
    };
  } catch (err) {
    logger.warn(`[API] histórico compartilhado indisponível (segue o do app): ${String(err?.message ?? err).slice(0, 100)}`);
    return null;
  }
}
