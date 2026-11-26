// O bot do Discord como ADAPTADOR do cérebro separado (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §1 e §4).
// Só roda com YUI_CEREBRO_EXTERNO=true (src/index.js). Sem a chave, nada daqui é carregado.
//
// 1. Conecta no canal local do cérebro (papel `bot`; reconecta sozinho, o segredo vem do arquivo restrito).
// 2. Liga as fachadas para o cérebro (dono da memória, dos arquivos de contexto e do lembretes.json):
//    - memória (core/memory/facade.js): memory.* pelo canal;
//    - contexto por horas: só o apagar (context.forgetUser e context.forgetGuild);
//    - lembretes por conversa: reminders.route e reminders.list;
//    - listas por conversa (só com YUI_APP_COMANDOS=true): lists.route;
//    - a CONVERSA (etapa 5, discord/turnoCerebro.js): cada pedido da fila do llmHandler e cada /yui viram um turno do cérebro (chat.turn e
//      chat.commit); o cérebro é o dono do contexto por horas e do histórico.
//    Cérebro fora: a memória responde "indisponível agora" e a conversa responde "a Yui está indisponível agora" (sem prender a fila).
// 3. Atende as AÇÕES que o cérebro pede ao Discord:
//    - discord.dm.send: mensagem privada (lembretes, relatório matinal, avisos ao dono, chave do painel). Só o motivo
//      'lembrete' pode ir para alguém que não é o dono (os lembretes de outras pessoas); o resto vai só ao dono. Com a
//      chave de idempotência do pedido, a DM sai NO MÁXIMO UMA VEZ, mesmo se o bot reiniciar no meio do envio: as chaves
//      ficam em <DATABASE_DIR>/idempotencia-bot.json (core/channel/idemPersistente.js, etapa 4);
//    - discord.status: Discord ligado, servidores e banimentos (para o painel e a passada dos lembretes);
//    - guild.list, guild.get, guild.setChannel e panel.admin (telas do painel que dependem do bot), executadas pelo
//      createAdmin daqui (com o cliente do Discord e os bancos do bot). Quem pede tem de ser o dono (conferido de novo aqui).
import path from 'node:path';
import crypto from 'node:crypto';
import { connectChannel } from '../core/channel/client.js';
import { ChannelError } from '../core/channel/protocol.js';
import { createPersistentIdemStore, efeitoUnico } from '../core/channel/idemPersistente.js';
import { setMemoryRemote } from '../core/memory/facade.js';
import { setContextRemote } from '../core/context/contextStore.js';
import { setRemindersRemote } from '../reminders/assistant.js';
import { descartarContinuidade } from '../core/continuidade.js';
import { setListsRemote } from '../handlers/listAssistant.js';
import { setChatRemote } from './turnoCerebro.js';
import { buildContext, isOwnerId, ROLES } from '../core/permissions.js';
import { splitForDiscord } from '../core/alerts.js';
import { redact } from '../core/api/panelLogs.js';
import { createAdmin, AdminError } from '../core/api/admin.js';
import { ownerUserId } from '../core/api/auth.js';
import { carregarServidorDoBot } from './painelServidor.js';
import { applyAiSettings } from '../core/aiSettings.js';
import { getGateway, resetGateway } from '../gateway/index.js';
import { logger as defaultLogger } from '../utils/logger.js';

export const BOT_CAPABILITIES = Object.freeze(['discord.dm', 'discord.status', 'guild.admin', 'panel.admin']);
/** As telas do painel que o cérebro pode pedir por panel.admin (a mesma lista do src/cerebro/painel.js). */
export const BOT_PANEL_ACTIONS = Object.freeze(['setAutomod', 'bans', 'addBan', 'removeBan', 'addYoutubeFollow', 'setYoutubeLiveMode', 'removeYoutubeFollow', 'addTwitchFollow', 'removeTwitchFollow', 'radio', 'radioAction', 'integrations', 'guildTools', 'setGuildTool', 'resetGuildTools', 'tosTerms', 'guildTos', 'acceptGuildTos', 'revokeGuildTos', 'channelConfig', 'setPersona', 'resetPersona', 'setChatter', 'setMentions']);
const DM_MOTIVOS = new Set(['lembrete', 'relatorio', 'alerta', 'painel']);
const MAX_DM_CHARS = 8000;
const ID_RE = /^\d{5,25}$/;

const coded = (code, message) => new ChannelError(code, message);

/** Erro do createAdmin -> erro do canal com o status HTTP no código (o cérebro devolve o mesmo status ao painel). */
function adminFailure(err) {
  if (err instanceof AdminError || Number.isInteger(err?.status)) return coded(`ADMIN_${err.status}`, String(err.message ?? 'Erro.'));
  return err;
}

/** Contexto do dono para as telas do painel (o cérebro já conferiu; o bot confere de novo com as regras dele). */
function ownerContext(params) {
  const userId = String(params?.userId ?? '');
  if (!ID_RE.test(userId)) throw coded('FORBIDDEN', 'Pedido do painel sem o dono.');
  const ctx = buildContext({ platform: 'api', userId, isDM: true });
  if (ctx.role !== ROLES.OWNER) throw coded('FORBIDDEN', 'Apenas o dono pode usar o painel de administração.');
  return ctx;
}

// ── Reconciliação das DMs (etapa 4, depois da revisão da Liz) ──
// Nonce estável por chave de idempotência (no máximo 25 caracteres, o limite do Discord): a mesma chave manda sempre a mesma
// nonce, e com `enforceNonce` o Discord devolve a mensagem que já existe (do mesmo autor, por alguns minutos) em vez de criar
// outra. Uma nonce por parte (a mesma nonce na parte 2 devolveria a parte 1).
export function nonceDaChave(idem, parte = 0) {
  return `y${crypto.createHash('sha256').update(`${idem}#${parte}`).digest('base64url').slice(0, 24)}`;
}
/** Marcador discreto no fim de cada parte (`-# ref <marca>`), para achar a mensagem no histórico da DM fora da janela da nonce. */
export function marcaDaChave(idem) {
  return crypto.createHash('sha256').update(`marca:${idem}`).digest('hex').slice(0, 10);
}
/** Janela em que a nonce do Discord é confiável para deduplicar (conservadora; o Discord fala em "alguns minutos"). */
export function nonceJanelaMs(env = process.env) {
  const raw = String(env.YUI_DM_NONCE_JANELA_MS ?? '').trim();
  const n = Number(raw);
  return raw && Number.isFinite(n) && n >= 0 ? Math.round(n) : 60_000;
}
/** Erro que prova que nada saiu: a PRIMEIRA parte recusada pelo próprio Discord (erro com status HTTP, ex.: DM fechada). */
function dmNadaSaiu(err) {
  return err?.partesEnviadas === 0 && Number.isInteger(err?.status);
}
/** Folga para o relógio do computador e o do Discord não baterem: a leitura só "alcança" o envio com essa margem antes dele. */
export const HISTORICO_FOLGA_MS = 2 * 60_000;
/**
 * Procura no histórico recente da DM as mensagens do PRÓPRIO bot com o marcador. Devolve:
 *  - { achou: Set(índices das partes), cobre, lidas }: leu o histórico. `cobre` diz se a leitura ALCANÇA o horário do envio (a
 *    DM inteira coube na leitura, ou a mensagem mais antiga lida é anterior a `desdeMs` com folga). Só com `cobre` a ausência
 *    do marcador prova que a mensagem não saiu (revisão da Liz: ausência de evidência não é prova de que não saiu);
 *  - { impossivel: motivo }: não deu para ler (sem permissão, Discord fora...).
 */
export async function procurarNoHistorico(client, user, marca, { limite = 100, desdeMs = NaN, folgaMs = HISTORICO_FOLGA_MS } = {}) {
  try {
    const dm = user.dmChannel ?? (await user.createDM());
    const msgs = await dm.messages.fetch({ limit: limite });
    const eu = client?.user?.id ?? null;
    const re = new RegExp(`-# ref ${marca}(?: · (\\d+)/\\d+)?\\s*$`);
    const achou = new Set();
    let maisAntiga = Infinity;
    for (const m of msgs.values()) {
      const ts = Number(m.createdTimestamp);
      if (Number.isFinite(ts) && ts < maisAntiga) maisAntiga = ts;
      if (eu && m.author?.id !== eu) continue;
      const mm = re.exec(String(m.content ?? ''));
      if (mm) achou.add(mm[1] ? Number(mm[1]) - 1 : 0);
    }
    const leuTudo = msgs.size < limite; // a DM inteira coube na leitura
    const alcanca = Number.isFinite(desdeMs) && maisAntiga <= desdeMs - folgaMs;
    return { achou, cobre: leuTudo || alcanca, lidas: msgs.size };
  } catch (err) {
    return { impossivel: `histórico da DM indisponível (${err?.code ?? err?.status ?? 'erro'})` };
  }
}

/** Arquivo da idempotência persistente do bot (dono: o bot; fica com os dados dele em DATABASE_DIR). */
export function botIdemFile(env = process.env) {
  return path.join(env.DATABASE_DIR || path.join(process.cwd(), 'database'), 'idempotencia-bot.json');
}

/**
 * Registra as ações do bot num cliente do canal. Separado de startBotChannel para os testes.
 * @param {{handle: Function}} channel
 * @param {{ getClient: () => import('discord.js').Client|null, admin?: object, getBans?: () => Promise<object>,
 *           idemStore?: ReturnType<typeof createPersistentIdemStore>|null, logger?: object }} deps
 *   idemStore: idempotência persistente das DMs (sem ela, só o cache em memória do canal, como na etapa 3)
 */
export function registerBotActions(channel, { getClient, admin = null, getBans = async () => (await import('../handlers/banHandler.js')).getBans(), idemStore = null, logger = defaultLogger } = {}) {
  let cachedAdmin = admin;
  const adminFor = () => {
    if (cachedAdmin) return cachedAdmin;
    const client = getClient();
    if (!client) throw coded('DISCORD_OFFLINE', 'O cliente do Discord ainda não foi criado.');
    cachedAdmin = createAdmin({ client, servidor: carregarServidorDoBot });
    return cachedAdmin;
  };
  const run = async (fn) => { try { return await fn(); } catch (err) { throw adminFailure(err); } };

  channel.handle('discord.dm.send', async (p, meta) => {
    const userId = String(p?.userId ?? '');
    const motivo = String(p?.motivo ?? '');
    const text = String(p?.text ?? '');
    if (!ID_RE.test(userId)) throw coded('BAD_PARAMS', 'Destinatário inválido.');
    if (!DM_MOTIVOS.has(motivo)) throw coded('BAD_PARAMS', 'Motivo da mensagem desconhecido.');
    if (motivo !== 'lembrete' && !isOwnerId(userId) && userId !== ownerUserId()) throw coded('FORBIDDEN', 'Só lembretes podem ir para quem não é o dono.');
    if (!text.trim() || text.length > MAX_DM_CHARS) throw coded('BAD_PARAMS', 'Mensagem vazia ou grande demais.');
    // Idempotência persistente: a mesma chave (ex.: lembrete:<id>:<horário>) nunca manda a DM duas vezes às cegas, nem
    // depois de um reinício do bot. Chave já feita = devolve a resposta guardada. Chave que ficou "enviando" (o bot caiu
    // entre mandar e confirmar) ou pedido com `reconciliar` (o cérebro não sabe se saiu) = RECONCILIA antes de mandar.
    const key = idemStore && meta?.idem ? `discord.dm.send:${meta.idem}` : null;
    const prev = key ? idemStore.consultar(key) : { estado: 'novo' };
    if (prev.estado === 'feito') return { ...(prev.resultado && typeof prev.resultado === 'object' ? prev.resultado : { sent: true }), repetido: true };
    const reconciliar = prev.estado === 'incerto' || p?.reconciliar === true;
    const desdeMs = prev.estado === 'incerto' ? Date.parse(prev.desde) : Date.parse(String(p?.desde ?? ''));
    const client = getClient();
    if (!client?.isReady?.()) throw coded('DISCORD_OFFLINE', 'O bot não está conectado ao Discord agora.');
    const user = await client.users.fetch(userId);
    // Lembretes e relatório: mascarados como no processo único (sendOwnerMessage/sendUserMessage). Os avisos já chegam
    // mascarados (alertas) e a mensagem do painel e a chave de acesso vão como estão, também como no processo único.
    // Com a chave: cada parte vai com uma `nonce` estável (derivada da chave) e `enforceNonce` (o Discord devolve a mensagem
    // que já existe em vez de criar outra, por alguns minutos); lembretes e relatório levam um marcador discreto
    // (`-# ref <marca>`) para a reconciliação achar a mensagem no histórico da DM depois dessa janela.
    const corpo = motivo === 'lembrete' || motivo === 'relatorio' ? redact(text, process.env) : text;
    const marca = meta?.idem && (motivo === 'lembrete' || motivo === 'relatorio') ? marcaDaChave(meta.idem) : null;
    const brutas = splitForDiscord(corpo);
    const parts = marca ? brutas.map((part, i) => `${part}\n-# ref ${marca}${brutas.length > 1 ? ` · ${i + 1}/${brutas.length}` : ''}`) : brutas;
    const enviarParte = (i) => user.send(meta?.idem ? { content: parts[i], nonce: nonceDaChave(meta.idem, i), enforceNonce: true } : parts[i]);

    if (!reconciliar) {
      try {
        return await efeitoUnico(idemStore, key, async () => {
          let sent = 0;
          try {
            for (let i = 0; i < parts.length; i += 1) { await enviarParte(i); sent += 1; }
          } catch (err) {
            if (err && typeof err === 'object') err.partesEnviadas = sent;
            throw err;
          }
          return { sent: true, parts: parts.length };
        }, { nadaSaiu: dmNadaSaiu });
      } catch (err) {
        // Nada saiu com certeza: o cérebro pode voltar o lembrete a "pendente". Qualquer outro erro: a entrega fica a confirmar.
        if (dmNadaSaiu(err)) throw coded('DM_NAO_SAIU', `O Discord recusou a mensagem (${err?.status ?? 'erro'}); nada saiu.`);
        throw err;
      }
    }

    // ── Reconciliação: nunca reenviar às cegas ──
    const achado = marca ? await procurarNoHistorico(client, user, marca, { desdeMs }) : { impossivel: 'sem marcador para procurar' };
    let faltam;
    let via;
    let impossivel = achado.impossivel ?? null;
    if (!impossivel) {
      faltam = parts.map((_, i) => i).filter((i) => !achado.achou.has(i));
      // Ausência de evidência só prova "não saiu" quando a leitura alcança o envio (`cobre`). Exceção segura: as partes saem em
      // ordem, então uma parte que falta DEPOIS de uma parte achada é mais nova que ela e estaria na leitura.
      const menorAchada = achado.achou.size ? Math.min(...achado.achou) : Infinity;
      if (!achado.cobre && faltam.some((i) => i < menorAchada)) {
        impossivel = `o histórico lido (${achado.lidas} mensagens) não alcança o horário do envio`;
      } else {
        via = faltam.length === 0 ? 'historico' : (achado.achou.size ? 'historico-parcial' : 'nao-saiu');
      }
    }
    if (impossivel) {
      const dentroDaJanela = Number.isFinite(desdeMs) && Date.now() - desdeMs < nonceJanelaMs();
      if (!dentroDaJanela || !meta?.idem) {
        logger.warn?.(`[Cérebro] DM a confirmar (motivo ${motivo}): ${impossivel}; fora da janela da nonce. Fica INCERTA para o dono decidir (nada é reenviado às cegas).`);
        return { sent: null, incerto: true, motivo: impossivel };
      }
      // Dentro da janela: a mesma nonce com enforceNonce faz o Discord devolver a mensagem que já existe, sem criar outra.
      faltam = parts.map((_, i) => i);
      via = 'nonce';
    }
    if (key) idemStore.iniciar(key, Number.isFinite(desdeMs) ? desdeMs : null);
    for (const i of faltam) await enviarParte(i); // erro aqui: a chave continua "enviando" e a próxima tentativa reconcilia de novo
    const resultado = { sent: true, parts: parts.length };
    if (key) { try { idemStore.concluir(key, resultado); } catch { /* na memória já está feita */ } }
    logger.info?.(`[Cérebro] DM reconciliada (motivo ${motivo}, ${via}): ${faltam.length} parte(s) enviada(s) agora de ${parts.length}.`);
    return { ...resultado, reconciliado: via, reenviadas: faltam.length };
  });

  channel.handle('discord.status', async () => {
    const client = getClient();
    const online = Boolean(client?.isReady?.());
    let bans = null;
    try {
      const b = (await getBans()) || {};
      bans = { users: Object.keys(b.users || {}).length, guilds: Object.keys(b.guilds || {}).length, channels: Object.keys(b.channels || {}).length };
    } catch { bans = null; }
    return { online, tag: online ? client.user?.tag ?? null : null, guilds: online ? client.guilds?.cache?.size ?? 0 : 0, bans };
  });

  channel.handle('guild.list', async (p) => run(() => adminFor().guilds(ownerContext(p))));
  channel.handle('guild.get', async (p) => run(() => adminFor().guildDetail(ownerContext(p), String(p?.guildId ?? ''))));
  channel.handle('guild.setChannel', async (p) => run(() => adminFor().setGuildChannel(ownerContext(p), String(p?.guildId ?? ''), p?.type, p?.channelId ?? null, p?.confirm)));
  channel.handle('panel.admin', async (p) => {
    const action = String(p?.action ?? '');
    if (!BOT_PANEL_ACTIONS.includes(action)) throw coded('METHOD_NOT_ALLOWED', 'Tela do painel desconhecida.');
    const args = Array.isArray(p?.args) ? p.args.slice(0, 6) : [];
    return run(() => adminFor()[action](ownerContext(p), ...args));
  });
}

/**
 * Sobe o adaptador: conecta no canal, liga as fachadas e registra as ações. Devolve o cliente do canal.
 * @param {{ getClient: () => import('discord.js').Client|null, logger?: object, connect?: Function }} options
 */
export function startBotChannel({ getClient, logger = defaultLogger, connect = connectChannel, idemFile = botIdemFile() } = {}) {
  const channel = connect({ role: 'bot', capabilities: [...BOT_CAPABILITIES], logger });
  const idemStore = idemFile ? createPersistentIdemStore({ file: idemFile, logger }) : null;
  if (idemStore?.size) logger.info?.(`[Cérebro] Idempotência persistente: ${idemStore.size} chave(s) recente(s) carregada(s) de ${path.basename(idemStore.file)}.`);
  registerBotActions(channel, { getClient, idemStore, logger });
  setMemoryRemote(channel);
  const effect = (method) => `${method}:${process.pid}:${Date.now()}:${Math.random().toString(36).slice(2, 10)}`;
  setContextRemote({
    forgetUser: (userId) => channel.request('context.forgetUser', { userId }, { idem: effect('context.forgetUser') }),
    forgetGuild: (guildId) => channel.request('context.forgetGuild', { guildId }, { idem: effect('context.forgetGuild') }),
  });
  setRemindersRemote({
    route: (params) => channel.request('reminders.route', params, { idem: effect('reminders.route') }),
    list: (params) => channel.request('reminders.list', params),
  });
  setListsRemote({ route: (params) => channel.request('lists.route', params, { idem: effect('lists.route') }) });
  // A conversa do Discord pelo cérebro (etapa 5): o llmHandler passa a montar turnos (chat.turn/chat.commit) em vez de chamar a IA daqui.
  setChatRemote(channel, { logger });
  channel.onState(({ state }) => {
    if (state === 'open') logger.info('[Cérebro] Bot ligado ao cérebro: conversa, memória, lembretes e pesquisa pelo canal.');
  });
  // O painel (no cérebro) mudou as chaves/provedores de IA ou zerou os descansos: a cadeia de IA do bot acompanha.
  // "Apagar tudo" feito no cérebro (app): a proposta de continuidade da DM vive na memória deste processo.
  channel.on('continuidade.descartar', (p) => { if (p?.userId) descartarContinuidade(String(p.userId)); });
  channel.on('ai.settingsChanged', (payload) => { applyAiSettingsChange(payload, logger); });
  return channel;
}

/** Relê as chaves de IA (secrets/ai-providers.json + .env) e refaz o Gateway deste processo; 'descanso' só zera os descansos. */
export function applyAiSettingsChange(payload, logger = defaultLogger, { apply = applyAiSettings, gateway = { getGateway, resetGateway }, env = process.env } = {}) {
  // Só as variáveis de IA (chaves, provedores, Gateway): na reconexão o Gateway só é refeito se algo mudou (não perde os descansos à toa).
  const snapshot = () => JSON.stringify(Object.entries(env).filter(([k]) => /KEY|TOKEN|GATEWAY|CLOUDFLARE|^AI_/.test(k)).sort());
  try {
    if (payload?.tipo === 'descanso') {
      gateway.getGateway().reset();
      logger.info?.('[Cérebro] Descansos dos provedores de IA zerados pelo painel.');
      return true;
    }
    const before = snapshot();
    apply();
    if (payload?.tipo === 'reconexao' && snapshot() === before) return false;
    gateway.resetGateway();
    logger.info?.('[Cérebro] Chaves e provedores de IA relidos (mudança feita no painel).');
    return true;
  } catch (err) {
    logger.warn?.(`[Cérebro] Não consegui aplicar a mudança de IA do painel: ${String(err?.message ?? err).slice(0, 120)}`);
    return false;
  }
}
