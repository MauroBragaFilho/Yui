// A ENTREGA do aviso de um monitor, com estados e reconciliação (etapa 16, proatividade). É o mesmo desenho da entrega dos lembretes
// (src/cerebro/entregaLembretes.js): nunca em dobro, nunca perdido em silêncio. O aviso sai como uma DM ao dono pelo MESMO caminho dos
// lembretes (a ação `discord.dm.send` do bot, motivo `lembrete`, com a chave de idempotência persistente e a reconciliação pela nonce e
// pelo marcador `-# ref` no histórico da DM).
//
//   pendente  -> nada pedido ainda (ou o Discord recusou com certeza: nada saiu; conta a tentativa)
//   enviando  -> gravado ANTES de pedir a DM ao bot. Se a resposta não vier (o bot caiu, o canal caiu, o prazo estourou, o cérebro caiu), o
//                aviso continua "enviando" e a próxima passada pede de novo com `reconciliar`: o bot procura a mensagem antes de mandar
//   incerto   -> a reconciliação foi impossível (sem acesso ao histórico da DM e fora da janela da nonce). Fica visível (lista, saúde,
//                auditoria); a cada 10 min tenta reconciliar de novo, sem reenviar às cegas; passadas 24 h é descartado COM registro
//   (enviado: o aviso sai do monitor e conta em `avisos`)
// A chave é `monitor:<id>:<assinatura>` (novidade: a mesma mudança nunca tem outra chave) ou `monitor:<id>:fim` (o fim do prazo): por isso
// um reinício do cérebro no meio do envio, ou uma segunda passada, nunca manda o mesmo aviso duas vezes. O texto do aviso NÃO vai para o
// disco: depois de um reinício, a novidade sai com um texto genérico (sem o título do resultado, que nunca é guardado).
import { observarAviso } from '../../core/avisos/observar.js';
import { LIMITES } from './config.js';
import { ESTADOS_DO_AVISO as E, TIPOS_DE_AVISO } from './store.js';

/** Erros em que o bot GARANTE que nada saiu (o aviso pode voltar a "pendente"). Os mesmos da entrega dos lembretes. */
export const NADA_SAIU = new Set(['BAD_PARAMS', 'FORBIDDEN', 'DISCORD_OFFLINE', 'DM_NAO_SAIU', 'METHOD_NOT_FOUND', 'METHOD_NOT_ALLOWED']);

export const chaveDaNovidade = (id, assinatura) => `monitor:${id}:${assinatura}`;
export const chaveDoFim = (id) => `monitor:${id}:fim`;

const iso = (ms) => new Date(ms).toISOString();

/**
 * Uma tentativa de entregar o aviso que o monitor tem em andamento. Nunca lança.
 * @param {{ store: object, id: number, enviar: (texto: string, opcoes: {chave: string, reconciliar: boolean, desde: string}) => Promise<object>,
 *           texto: (monitor: object) => string, now?: () => number, audit?: Function, logger?: object|null }} p
 *   `enviar` resolve com a resposta do bot ({ sent, repetido?, reconciliado?, incerto?, motivo? }) ou rejeita com o erro.
 * @returns {Promise<{ resultado: 'nenhum'|'enviado'|'incerto'|'a-confirmar'|'adiado'|'desistiu'|'descartado'|'aguardando', reconciliado?: string }>}
 */
export async function entregarAviso({ store, id, enviar, texto, now = () => Date.now(), audit = () => {}, logger = null }) {
  const registrar = (evento, dados) => { try { audit(evento, null, dados); } catch { /* a auditoria nunca derruba a entrega */ } };
  const m = store.obter(id);
  if (!m?.aviso) return { resultado: 'nenhum' };
  const a = m.aviso;
  const t = now();

  if (a.estado === E.INCERTO) {
    if (a.incertoDesde && t - Date.parse(a.incertoDesde) >= LIMITES.incertoExpiraMs) {
      try { store.atualizar(id, { aviso: null }); } catch { return { resultado: 'adiado' }; }
      registrar('monitor.aviso_incerto_expirou', { id, tipo: a.tipo });
      logger?.warn?.(`[Monitores] o aviso incerto do monitor #${id} passou de 24 h sem confirmação e foi descartado (registrado na auditoria).`);
      return { resultado: 'descartado' };
    }
    if (t < Date.parse(a.proximaTentativa ?? 0)) return { resultado: 'aguardando' };
  }

  const reconciliar = a.estado === E.ENVIANDO || a.estado === E.INCERTO;
  const desde = reconciliar && a.desde ? a.desde : iso(t);
  // ANTES de pedir ao bot: se o cérebro cair agora, a próxima subida sabe que precisa reconciliar. Sem o registro durável, nada sai.
  if (!reconciliar) {
    try { store.atualizar(id, { aviso: { ...a, estado: E.ENVIANDO, desde } }); } catch (err) {
      logger?.warn?.(`[Monitores] não consegui gravar o estado do aviso do monitor #${id} (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}): nada foi enviado.`);
      return { resultado: 'adiado' };
    }
  }

  let resposta = null;
  let erro = null;
  try { resposta = await enviar(texto(m), { chave: a.chave, reconciliar, desde }); } catch (err) { erro = err; }

  // O monitor pode ter sido cancelado enquanto o pedido ao bot corria: só mexe no aviso que ainda é este.
  const atual = store.obter(id);
  const aindaEste = atual?.aviso?.chave === a.chave;

  if (!erro && resposta && (resposta.sent === true || resposta.repetido === true)) {
    if (aindaEste) {
      try { store.atualizar(id, { aviso: null, ...(a.tipo === TIPOS_DE_AVISO.NOVIDADE ? { avisos: atual.avisos + 1 } : {}) }); } catch (err) {
        // O aviso SAIU: se o disco não aceitou o "enviado", continua "enviando" e a próxima passada reconcilia (acha a mensagem, sem repetir).
        logger?.warn?.(`[Monitores] o aviso do monitor #${id} saiu, mas não consegui gravar o "enviado" (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}); a próxima passada confirma sem repetir.`);
        return { resultado: 'a-confirmar' };
      }
    }
    observarAviso({ chave: a.tipo === TIPOS_DE_AVISO.FIM ? 'monitor:fim' : 'monitor:novidade', agora: t });
    registrar(a.tipo === TIPOS_DE_AVISO.FIM ? 'monitor.fim_avisado' : 'monitor.aviso', { id, ...(resposta.reconciliado ? { reconciliado: resposta.reconciliado } : {}) });
    return { resultado: 'enviado', ...(resposta.reconciliado ? { reconciliado: resposta.reconciliado } : {}) };
  }

  if (!erro && resposta?.incerto) {
    const motivo = String(resposta.motivo ?? 'reconciliação impossível').slice(0, 160);
    if (aindaEste) {
      try {
        store.atualizar(id, { aviso: { ...atual.aviso, estado: E.INCERTO, desde, motivo, incertoDesde: atual.aviso.incertoDesde ?? iso(t), proximaTentativa: iso(t + LIMITES.reconciliarIncertoMs) } });
      } catch { return { resultado: 'a-confirmar' }; }
      if (a.estado !== E.INCERTO) {
        registrar('monitor.aviso_incerto', { id, tipo: a.tipo });
        logger?.warn?.(`[Monitores] o aviso do monitor #${id} está com a entrega INCERTA (${motivo}). Não reenvio às cegas: tento reconciliar de novo a cada 10 min.`);
      }
    }
    return { resultado: 'incerto' };
  }

  if (!reconciliar && NADA_SAIU.has(erro?.code)) {
    // Com certeza nada saiu: volta a "pendente" e conta a tentativa; passadas muitas tentativas, desiste (com registro).
    if (aindaEste) {
      const tentativas = (atual.aviso.tentativas ?? 0) + 1;
      try {
        if (tentativas >= LIMITES.avisoMaxTentativas) {
          store.atualizar(id, { aviso: null });
          registrar('monitor.aviso_descartado', { id, tipo: a.tipo, tentativas });
          logger?.warn?.(`[Monitores] o aviso do monitor #${id} não saiu em ${tentativas} tentativas (o Discord recusou) e foi descartado (registrado na auditoria).`);
          return { resultado: 'desistiu' };
        }
        store.atualizar(id, { aviso: { chave: a.chave, tipo: a.tipo, estado: E.PENDENTE, tentativas, ...(a.assinatura ? { assinatura: a.assinatura } : {}) } });
      } catch { return { resultado: 'a-confirmar' }; }
    }
    return { resultado: 'adiado' };
  }

  // Qualquer outro caso (o canal caiu, o prazo estourou, Discord fora no meio de uma reconciliação, resposta estranha): o aviso continua
  // "enviando" e a próxima passada reconcilia antes de mandar. Nunca reenvia às cegas.
  if (erro) logger?.warn?.(`[Monitores] o bot não entregou a DM (${erro?.code || 'erro'}); a entrega do aviso do monitor #${id} fica a confirmar na próxima passada.`);
  return { resultado: 'a-confirmar' };
}
