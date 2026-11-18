// ENTREGA dos lembretes no cérebro separado, com estados explícitos (etapa 4, depois da revisão da Liz; relatório §14).
//
// O cérebro é o dono do lembretes.json: o estado da entrega de cada ocorrência fica ali, visível na lista do dono, no relatório
// de saúde e na auditoria.
//
//   pendente  -> nada pedido ainda (ou o Discord recusou com certeza: nada saiu; conta a tentativa, como antes)
//   enviando  -> gravado ANTES de pedir a DM ao bot. Se a resposta não vier (o bot caiu, o canal caiu, o prazo estourou), a
//                ocorrência continua "enviando" e a próxima passada pede de novo com `reconciliar`: o bot procura a mensagem
//                antes de mandar (nonce do Discord e histórico da DM). Nunca reenvia às cegas
//   enviado   -> o bot confirmou (ou a reconciliação achou a mensagem): a ocorrência sai da lista (ou vai para a próxima, se
//                repete), com `reminder.fire` na auditoria
//   incerto   -> a reconciliação foi impossível (sem acesso ao histórico da DM e fora da janela da nonce). Fica visível e só
//                sai pela decisão do dono ("reenvia o lembrete N" ou "descarta o lembrete N"); a cada 10 min o cérebro tenta
//                reconciliar de novo, sem reenviar às cegas. Nunca duplica sozinho e nunca some em silêncio
// O processo único não passa por aqui: lá o agendador do bot manda direto, como sempre (reminders/runner.js).
import { formatReminderMessage } from '../reminders/runner.js';

export const ESTADOS = Object.freeze({ PENDENTE: 'pendente', ENVIANDO: 'enviando', ENVIADO: 'enviado', INCERTO: 'incerto' });
/** De quanto em quanto tempo um lembrete incerto tenta reconciliar de novo (sem reenviar às cegas). */
export const RECONCILIAR_INCERTO_MS = 10 * 60_000;
/** Erros em que o bot GARANTE que nada saiu (o lembrete pode voltar a "pendente"). */
const NADA_SAIU = new Set(['BAD_PARAMS', 'FORBIDDEN', 'DISCORD_OFFLINE', 'DM_NAO_SAIU', 'METHOD_NOT_FOUND', 'METHOD_NOT_ALLOWED']);
const GIVE_UP_TRIES = 60; // o mesmo de reminders/runner.js para o lembrete de outra pessoa (DM fechada)
const iso = (ms) => new Date(ms).toISOString();

/** Estado da entrega da ocorrência atual. */
export function estadoDaEntrega(r) {
  return r?.entrega?.estado ?? ESTADOS.PENDENTE;
}

/** Chave de idempotência da ocorrência: a mesma em todas as tentativas; um reenvio autorizado pelo dono ganha chave nova. */
export function chaveDaOcorrencia(r) {
  const base = `lembrete:${r.id}:${r.at}`;
  return r?.entrega?.reenvio ? `${base}:r${r.entrega.reenvio}` : base;
}

/**
 * Uma passada: entrega o que venceu, respeitando os estados.
 * @param {{ store: object, enviar: (texto: string, r: object, opcoes: {chave: string, reconciliar: boolean, desde: string}) => Promise<object>,
 *           audit?: Function, now?: number, logger?: object }} p
 *   `enviar` resolve com a resposta do bot ({ sent, repetido?, reconciliado?, incerto?, motivo? }) ou rejeita com o erro.
 * @returns {Promise<{enviados: number, reconciliados: number, adiados: number, incertos: number, aConfirmar: number}>}
 */
export async function entregarLembretesDevidos({ store, enviar, audit = () => {}, now = Date.now(), logger = null }) {
  const out = { enviados: 0, reconciliados: 0, adiados: 0, incertos: 0, aConfirmar: 0 };
  const registrar = (event, data) => { try { audit(event, null, data); } catch { /* a auditoria nunca derruba a entrega */ } };
  for (const r of store.due(now)) {
    const e = r.entrega ?? null;
    const estado = estadoDaEntrega(r);
    if (estado === ESTADOS.INCERTO && now < Date.parse(e?.proximaTentativa ?? 0)) { out.incertos += 1; continue; }
    const reconciliar = estado === ESTADOS.ENVIANDO || estado === ESTADOS.INCERTO;
    const chave = reconciliar && e?.chave ? e.chave : chaveDaOcorrencia(r);
    const desde = reconciliar && e?.desde ? e.desde : iso(now);
    const reenvio = e?.reenvio ? { reenvio: e.reenvio } : {};
    // ANTES de pedir ao bot: se o cérebro cair agora, a próxima subida sabe que precisa reconciliar.
    if (!reconciliar) store.setEntrega(r.id, { estado: ESTADOS.ENVIANDO, desde, chave, ...reenvio });

    let res = null;
    let erro = null;
    try { res = await enviar(formatReminderMessage(r, now), r, { chave, reconciliar, desde }); } catch (err) { erro = err; }

    if (!erro && res && (res.sent === true || res.repetido === true)) {
      store.complete(r.id, now); // enviado
      out.enviados += 1;
      if (res.reconciliado) out.reconciliados += 1;
      registrar('reminder.fire', { id: r.id, repeat: Boolean(r.repeat), ...(res.reconciliado ? { reconciliado: res.reconciliado } : {}), ...reenvio });
      continue;
    }
    if (!erro && res?.incerto) {
      const motivo = String(res.motivo ?? 'reconciliação impossível').slice(0, 160);
      store.setEntrega(r.id, { estado: ESTADOS.INCERTO, desde, chave, motivo, incertoDesde: e?.incertoDesde ?? iso(now), proximaTentativa: iso(now + RECONCILIAR_INCERTO_MS), ...reenvio });
      out.incertos += 1;
      if (estado !== ESTADOS.INCERTO) {
        registrar('reminder.incerto', { id: r.id, motivo, ...reenvio });
        logger?.warn?.(`[Lembretes] Aviso #${r.id} com entrega INCERTA (${motivo}). Não reenvio às cegas: o dono decide ("reenvia o lembrete ${r.id}" ou "descarta o lembrete ${r.id}").`);
      }
      continue;
    }
    if (!reconciliar && NADA_SAIU.has(erro?.code)) {
      // Com certeza nada saiu: volta a "pendente" e conta a tentativa (como no processo único).
      store.setEntrega(r.id, e?.reenvio ? { estado: ESTADOS.PENDENTE, ...reenvio } : null);
      store.recordFailure(r.id);
      out.adiados += 1;
      if (r.userId && (r.tries || 0) + 1 >= GIVE_UP_TRIES) {
        store.remove(r.id);
        registrar('reminder.drop', { id: r.id });
      }
      continue;
    }
    // Qualquer outro caso (o canal caiu, o prazo estourou, Discord fora no meio de uma reconciliação, resposta estranha): a
    // ocorrência continua "enviando" e a próxima passada reconcilia antes de mandar. Nunca reenvia às cegas.
    out.aConfirmar += 1;
    if (erro) logger?.warn?.(`[Lembretes] o bot não entregou a DM (${erro?.code || 'erro'}); a entrega do aviso #${r.id} fica a confirmar na próxima passada.`);
  }
  return out;
}

/** Resumo dos incertos para a lista, o relatório de saúde e o /v1/health. */
export function resumoIncertos(itens = []) {
  const incertos = itens.filter((r) => estadoDaEntrega(r) === ESTADOS.INCERTO);
  const enviando = itens.filter((r) => estadoDaEntrega(r) === ESTADOS.ENVIANDO);
  return { incertos: incertos.map((r) => r.id), enviando: enviando.map((r) => r.id) };
}
