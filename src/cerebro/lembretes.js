// Lembretes, relatório matinal e limpeza da memória no YuiCerebro (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §2).
//
// O cérebro é o dono do lembretes.json (e das listas que o relatório lê). O aviso sai pelo canal: o cérebro pede ao bot a ação
// `discord.dm.send`. Regras da entrega pelo canal:
//  - bot DESCONECTADO (ou o Discord dele fora): a passada nem começa. O lembrete fica pendente SEM contar tentativa (nada de
//    desistir do lembrete de outra pessoa porque o bot ficou fora uma hora) e sai assim que o bot volta: a conexão do bot
//    dispara uma passada na hora;
//  - cada aviso leva a chave de idempotência `lembrete:<id>:<horário>`: se a resposta do bot se perder (queda no meio, prazo
//    estourado) e o cérebro tentar de novo, o bot devolve a resposta guardada em vez de mandar a DM duas vezes. A chave fica
//    em disco no bot (etapa 4, core/channel/idemPersistente.js): nem um REINÍCIO do bot no meio do envio repete o aviso;
//  - estados explícitos da entrega (pendente, enviando, enviado, incerto) no lembretes.json: veja cerebro/entregaLembretes.js.
//    "Enviando" sem resposta = a próxima passada RECONCILIA (nonce do Discord e histórico da DM) antes de mandar; se não der,
//    o aviso fica "incerto", visível, até o dono decidir (reenviar ou descartar). Nunca duplica sozinho, nunca some calado;
//  - o lembrete que repete ganha um horário novo depois de avisado, logo uma chave nova.
// A passada vale a cada YUI_CEREBRO_LEMBRETES_MS (padrão 60 s; os testes usam menos) e passa pelo motor de políticas
// (reminders.tick, como no agendador do bot).
import cron from 'node-cron';
import { audit } from '../core/audit.js';
import { observarAviso } from '../core/avisos/observar.js';
import { jobAllowed, guardedJob } from '../core/security/jobGuard.js';
import { purgeExpired } from '../core/memory/store.js';
import { healthReportSchedule, sendHealthReport } from '../core/healthReport.js';
import { getReminderStore } from '../reminders/assistant.js';
import { entregarLembretesDevidos, resumoIncertos } from './entregaLembretes.js';
import { createMorningComposer } from '../reminders/service.js';
import { morningSchedule, sendMorningReport, shouldCatchUp } from '../reminders/morning.js';

export const DEFAULT_TICK_MS = 60_000;
const MIN_TICK_MS = 200;

/** Chave de idempotência de UM aviso (o mesmo lembrete na mesma ocorrência = a mesma chave). */
export function reminderIdemKey(r) {
  return `lembrete:${r.id}:${r.at}`;
}

function tickFromEnv(env) {
  const n = Number(String(env.YUI_CEREBRO_LEMBRETES_MS ?? '').trim());
  return Number.isFinite(n) && n >= MIN_TICK_MS ? Math.round(n) : DEFAULT_TICK_MS;
}

function dmTimeoutFromEnv(env) {
  const n = Number(String(env.YUI_CEREBRO_DM_TIMEOUT_MS ?? '').trim());
  return Number.isFinite(n) && n >= 200 ? Math.round(n) : 30_000;
}

/**
 * Liga os lembretes ao canal.
 * @param {{ channel: {request: Function, isConnected: Function}, logger: object, ownerId: string|null, env?: object,
 *           store?: () => object, tickMs?: number, dmTimeoutMs?: number, schedule?: Function }} options
 * @returns {{ tick: (reason?: string) => Promise<object>, stop: () => void, status: () => object }}
 */
export function startCerebroReminders({
  channel, logger, ownerId = null, env = process.env, store = getReminderStore,
  tickMs = tickFromEnv(env), dmTimeoutMs = dmTimeoutFromEnv(env), schedule = cron.schedule,
} = {}) {
  let busy = false;
  let botDiscordOnline = null; // última leitura do bot (null = ainda não sabe)
  let relatorioIncerto = null; // última DM do relatório com entrega incerta (visível na saúde)
  const counters = { ticks: 0, skippedOffline: 0, fired: 0, failed: 0, incertos: 0, reconciliados: 0 };
  const tasks = [];

  /**
   * Pede UMA mensagem privada ao bot e devolve a resposta dele ({ sent, repetido?, reconciliado?, incerto?, motivo? }).
   * Lança o erro do canal ou do bot (quem chama decide o estado). `reconciliar`: o cérebro não sabe se a tentativa anterior
   * saiu, então o bot procura a mensagem antes de mandar (nunca reenvia às cegas).
   */
  async function pedirDm(userId, text, { idem, motivo, reconciliar = false, desde = null }) {
    if (!userId) throw Object.assign(new Error('Sem destinatário.'), { code: 'BAD_PARAMS' });
    try {
      return await channel.request('bot', 'discord.dm.send', { userId: String(userId), text: String(text ?? ''), motivo, ...(reconciliar ? { reconciliar: true, desde } : {}) }, { idem, timeoutMs: dmTimeoutMs });
    } catch (err) {
      logger.warn?.(`[Lembretes] o bot não entregou a DM (${err?.code || 'erro'}); fica para a próxima passada${reconciliar ? ' (reconciliando antes de mandar)' : ''}.`);
      throw err;
    }
  }

  /** Relatório matinal (e outras DMs do dono sem estado próprio): true se saiu. Incerto fica visível (log, auditoria, saúde). */
  async function sendDm(userId, text, { idem, motivo }) {
    try {
      const r = await pedirDm(userId, text, { idem, motivo });
      if (r?.incerto) {
        counters.incertos += 1;
        relatorioIncerto = { motivo, em: new Date().toISOString(), detalhe: String(r.motivo ?? '').slice(0, 120) };
        logger.warn?.(`[Lembretes] DM (${motivo}) com entrega INCERTA: ${r.motivo ?? 'reconciliação impossível'}. Não reenvio às cegas.`);
        try { audit('channel.dm_incerta', null, { motivo, chave: String(idem ?? '').slice(0, 128) }); } catch { /* */ }
        return false;
      }
      return r?.sent === true || r?.repetido === true;
    } catch {
      return false;
    }
  }

  async function readBotDiscord() {
    try {
      const st = await channel.request('bot', 'discord.status', {}, { timeoutMs: 5_000 });
      botDiscordOnline = st?.online === true;
    } catch {
      botDiscordOnline = false;
    }
    return botDiscordOnline;
  }

  async function tick(reason = 'agenda') {
    if (busy) return { skipped: 'ocupado' };
    if (!jobAllowed('reminders.tick')) return { skipped: 'política' };
    if (!channel.isConnected('bot')) { counters.skippedOffline += 1; return { skipped: 'bot desconectado' }; }
    busy = true;
    try {
      counters.ticks += 1;
      if (!(await readBotDiscord())) { counters.skippedOffline += 1; return { skipped: 'Discord do bot fora' }; }
      const r = await entregarLembretesDevidos({
        store: store(),
        audit,
        logger,
        enviar: (text, rem, { chave, reconciliar, desde }) => pedirDm(rem?.userId || ownerId, text, { idem: chave, motivo: 'lembrete', reconciliar, desde }),
      });
      counters.fired += r.enviados;
      counters.failed += r.adiados;
      counters.reconciliados += r.reconciliados;
      if (r.enviados || r.adiados || r.aConfirmar) {
        logger.info?.(`[Lembretes] ${r.enviados} aviso(s) enviado(s) pelo bot${r.reconciliados ? ` (${r.reconciliados} pela reconciliação)` : ''}${r.adiados ? `, ${r.adiados} adiado(s) para a próxima passada` : ''}${r.aConfirmar ? `, ${r.aConfirmar} a confirmar` : ''} (${reason}).`);
      }
      return { fired: r.enviados, failed: r.adiados, ...r };
    } catch (err) {
      logger.warn?.(`[Lembretes] Falha na passada: ${String(err?.message ?? err).slice(0, 120)}`);
      return { error: true };
    } finally {
      busy = false;
    }
  }

  const timer = setInterval(() => { tick().catch(() => {}); }, tickMs);
  timer.unref?.();
  logger.info?.(`[Lembretes] No cérebro: conferência a cada ${tickMs >= 1000 ? `${Math.round(tickMs / 1000)} s` : `${tickMs} ms`}; aviso pelo bot (canal).`);

  // Relatório matinal (ou só o de saúde, se o matinal estiver desligado): a mensagem ao dono também vai pelo bot.
  const healthClient = { isReady: () => botDiscordOnline === true };
  const morning = morningSchedule(env);
  if (morning) {
    const compose = createMorningComposer({ client: healthClient, env });
    const run = () => sendMorningReport({
      send: (text) => sendDm(ownerId, text, { idem: `matinal:${new Date().toISOString().slice(0, 10)}`, motivo: 'relatorio' }),
      compose,
    }).then((r) => {
      if (!r.ok) logger.warn?.('[Matinal] A DM do relatório não saiu (bot ou Discord fora?).');
      else observarAviso({ chave: 'matinal', env });
    })
      .catch((err) => logger.warn?.(`[Matinal] Falha: ${err.message}`));
    tasks.push(schedule(morning.cron, guardedJob('reminders.morning', run), { timezone: morning.timezone }));
    const catchUp = setTimeout(() => { if (shouldCatchUp(new Date(), morning)) run(); }, 3 * 60 * 1000);
    catchUp.unref?.();
    tasks.push({ stop: () => clearTimeout(catchUp) });
  } else {
    const health = healthReportSchedule(env);
    if (health) {
      tasks.push(schedule(health.cron, guardedJob('reminders.health', () => {
        sendHealthReport({ client: healthClient }).catch((err) => logger.warn?.(`[Saúde] Relatório falhou: ${err.message}`));
      }), { timezone: health.timezone }));
    }
  }

  // Limpeza diária da memória temporária expirada: roda no dono dos bancos de memória (o bot separado não a agenda).
  tasks.push(schedule('30 5 * * *', guardedJob('scheduler.memory_purge', () => {
    try {
      const removed = purgeExpired();
      logger.info?.(`[Memória] ${removed} lembrança(s) expirada(s) removida(s).`);
    } catch (err) {
      logger.error?.(`[Memória] Erro ao limpar memória expirada: ${err.message}`);
    }
  }), { timezone: 'UTC' }));

  return {
    tick,
    status: () => {
      let entrega = null;
      try { entrega = resumoIncertos(store().list()); } catch { entrega = null; }
      return { ...counters, tickMs, botDiscordOnline, entrega, relatorioIncerto };
    },
    stop() {
      clearInterval(timer);
      for (const t of tasks) { try { t?.stop?.(); } catch { /* */ } }
    },
  };
}
