// Painel (Yui API) no YuiCerebro, sem o cliente do Discord (etapa 3, docs/ETAPA3_DONOS_E_CONTRATO.md §2 e §4).
//
// O que o painel faz com o Discord vira PEDIDO AO BOT pelo canal (ação do adaptador):
//  - guild.list, guild.get e guild.setChannel: a lista de servidores, o detalhe de um servidor e o canal de publicação (o
//    banco `core` é do bot);
//  - discord.status: Discord ligado, servidores e contagem de banimentos (visão geral);
//  - panel.admin: as outras telas que dependem do bot (AutoMod, banimentos, avisos de YouTube e Twitch, rádio, integrações),
//    só as da lista PANEL_ACTIONS (o bot confere a mesma lista).
// Com o bot desconectado, essas rotas respondem 503 com "Disponível só com o bot conectado". A rota passou antes pelo
// guardRoute do cérebro (motor de políticas); o bot confere de novo que quem pede é o dono.
// O cérebro nunca carrega os módulos do bot (banHandler, tosHandler, rádio): as dependências do createAdmin são injetadas aqui.
import { createAdmin, AdminError } from '../core/api/admin.js';
import { comContasDaYui } from '../core/api/integrations.js';
import { limparVistaDoGta, vistaDosAvisos, vistaDosObservados } from '../core/api/leiturasDoPainel.js';
import { montarDiagnostico } from '../core/diagnostico.js';
import { ROLES } from '../core/permissions.js';

export const BOT_OFFLINE_TEXT = 'Disponível só com o bot conectado: o bot do Discord não está ligado ao cérebro agora.';

/** Telas do painel que vão ao bot por `panel.admin` (método do createAdmin -> efeito?). */
export const PANEL_ACTIONS = Object.freeze({
  setAutomod: true,
  bans: false,
  addBan: true,
  removeBan: true,
  addYoutubeFollow: true,
  setYoutubeLiveMode: true,
  removeYoutubeFollow: true,
  addTwitchFollow: true,
  removeTwitchFollow: true,
  radio: false,
  radioAction: true,
  integrations: false,
  // Configurações por servidor (quem grava os arquivos é o bot).
  guildTools: false,
  setGuildTool: true,
  resetGuildTools: true,
  tosTerms: false,
  guildTos: false,
  acceptGuildTos: true,
  revokeGuildTos: true,
  channelConfig: false,
  setPersona: true,
  resetPersona: true,
  setChatter: true,
  setMentions: true,
  // Lacunas do painel, entrega B (só leitura): o que o modo observar dos avisos registrou no BOT (o cérebro junta ao dele em GET /v1/admin/avisos).
  avisosObservados: false,
  // Lacunas do painel, entrega D (só leitura): o GTA (o que saiu, onde e o estado das fontes); os bancos do GTA são do bot. O cérebro limpa de novo a vista.
  // A continuidade (projetos e decisões) NÃO entra aqui: ela mora na memória do cérebro, que lê e apaga sem falar com o bot (como os monitores).
  gta: false,
  // Entrega E, parte 2: republicar o GTA (item 9 v2; ESCRITA, com chave de idempotência: a publicação e o limite de repetição são do bot) e os canais de
  // voz e de texto para iniciar o rádio (item 10; leitura). As ações novas do rádio (iniciar, pular, tocar, escolher) vão pelo radioAction de sempre.
  republicarGta: true,
  radioCanais: false,
});

/**
 * Ações que demoram mais que o normal no bot (o rádio entra na call ou busca a música): o cérebro espera por elas um pouco mais que o prazo do próprio
 * handler no bot (30 s, src/core/channel/protocol.js), para a resposta do bot chegar antes do prazo daqui.
 */
export const PANEL_TIMEOUTS = Object.freeze({ radioAction: 35_000 });

const UNAVAILABLE = new Set(['NOT_CONNECTED', 'CONNECTION_LOST', 'TIMEOUT', 'CLOSED']);

/** Erro do canal -> AdminError (o servidor da API usa o `status`). */
export function adminErrorFromChannel(err) {
  const m = /^ADMIN_(\d{3})$/.exec(String(err?.code ?? ''));
  if (m) return new AdminError(Number(m[1]), String(err.message ?? 'Erro.'));
  if (UNAVAILABLE.has(err?.code)) return new AdminError(503, BOT_OFFLINE_TEXT);
  if (err?.code === 'FORBIDDEN') return new AdminError(403, String(err.message ?? 'Apenas o dono.'));
  return new AdminError(502, `O bot não conseguiu atender: ${String(err?.message ?? err).slice(0, 160)}`);
}

const offline = () => { throw new AdminError(503, BOT_OFFLINE_TEXT); };

/** Dependências do createAdmin no cérebro: nada do bot é carregado; o que muda estado no bot vai pelo canal. */
export const CEREBRO_ADMIN_DEPS = Object.freeze({
  getBans: () => ({ users: {}, guilds: {}, channels: {} }),
  addBan: offline,
  removeBan: offline,
  setAutoBlock: offline,
  getAutoBlockMode: () => null,
  isServerAccepted: () => null,
  integrationData: async () => ({}),
  radio: { getSession: () => null, pause: offline, resume: offline, stopMusic: offline, leave: offline, listSessions: () => [], start: offline, resolve: offline, enqueue: offline, skip: offline },
});

function requireOwner(ctx) {
  if (ctx?.role !== ROLES.OWNER) throw new AdminError(403, 'Apenas o dono pode usar o painel de administração.');
}

/**
 * O admin do painel no cérebro: o createAdmin de sempre (memória, lembretes, IA, auditoria, logs, reinício) com as telas do
 * Discord trocadas por pedidos ao bot.
 * `diagnostico`: função que devolve os números do cérebro para a aba Diagnóstico (a saúde dele: canal, conversa, pesquisa, comentários...);
 * `fontes`: fontes extras do diagnóstico (só teste);
 * `reinicio`: `({ motivo }) => Promise<{ aceito, motivo }>`, o pedido de reinício controlado ao SUPERVISOR (etapa 10; src/operacao/filho.js: pedirReinicio). O
 * cérebro passa sempre: sem supervisor ele responde "recusado" e o app mostra que nada foi reiniciado (o `exit` de sempre nunca é usado aqui);
 * `monitores`: os monitores do cérebro (src/cerebro/monitores: `listar()` e `cancelar(id)`), ou null com a chave desligada.
 * `leituras`: as leituras da live, do Google, dos planos, dos avisos, das listas e das skills (src/core/api/leiturasDoPainel.js; só teste; o padrão lê neste processo).
 * `planos`: o serviço dos planos do cérebro (src/cerebro/planos.js), para aprovar e recusar pelo painel (entrega E, item 3 v2); null = desligados. A live não
 * precisa: a porta da live do cérebro já é o serviço. As duas ações rodam AQUI, sem pedido ao bot (por isso não estão em PANEL_ACTIONS). A reautorização do
 * Google pelo painel (entrega F, item 14: googleReautorizarInicio e googleReautorizarRetorno) também: o arquivo da autorização é lido pelo cérebro.
 * @param {{ channel: {request: Function, isConnected: Function}, timeoutMs?: number, base?: object, diagnostico?: Function, fontes?: object, reinicio?: Function, monitores?: object|null, leituras?: object|null, planos?: object|null }} options
 */
export function createCerebroAdmin({ channel, timeoutMs = 20_000, base = null, diagnostico = null, fontes = {}, reinicio = null, monitores = null, leituras = null, planos = null } = {}) {
  // Sem `reinicio` o cérebro NUNCA cai no `exit` do createAdmin (ninguém religaria o cérebro): o pedido é recusado como "sem supervisor".
  // `monitores` (etapa 16, YUI_MONITORES): a lista e o cancelamento dos monitores do dono pela API (`GET` e `DELETE /v1/admin/monitores`); null = desligados.
  const admin = base ?? createAdmin({ client: null, deps: CEREBRO_ADMIN_DEPS, reinicio: typeof reinicio === 'function' ? reinicio : async () => ({ aceito: false, motivo: 'sem-supervisor' }), monitores, processo: 'cerebro', leituras, planos });
  let seq = 0;

  async function call(method, params, effect = false, espera = timeoutMs) {
    if (!channel.isConnected('bot')) throw new AdminError(503, BOT_OFFLINE_TEXT);
    try {
      return await channel.request('bot', method, params, { timeoutMs: espera, ...(effect ? { idem: `painel:${process.pid}:${Date.now()}:${++seq}` } : {}) });
    } catch (err) {
      throw adminErrorFromChannel(err);
    }
  }

  const panel = (action) => async (ctx, ...args) => {
    requireOwner(ctx);
    return call('panel.admin', { action, userId: ctx.userId, args }, PANEL_ACTIONS[action] === true, Math.max(timeoutMs, PANEL_TIMEOUTS[action] ?? 0));
  };

  const wrapped = {
    ...admin,
    async overview(ctx) {
      const out = await admin.overview(ctx);
      out.cerebro = { botConectado: channel.isConnected('bot') };
      try {
        const st = await call('discord.status', { userId: ctx.userId });
        out.discord = { online: st?.online === true, tag: st?.tag ?? null, guilds: Number(st?.guilds) || 0 };
        if (st?.bans) out.bans = st.bans;
      } catch {
        out.discord = { online: false, tag: null, guilds: 0 };
      }
      return out;
    },
    /**
     * O diagnóstico com o cérebro separado (só leitura, só o dono): o estado do cérebro, a conexão com o bot e o Discord visto pelo bot, mais o que o
     * Core já sabe (provedores, limites, cotas, avisos, erros). Bot fora: o Discord fica "desconhecido" (null), o resto sai igual.
     */
    async diagnostico(ctx) {
      requireOwner(ctx);
      const botConectado = channel.isConnected('bot');
      let discordOnline = null;
      if (botConectado) {
        try { discordOnline = (await call('discord.status', { userId: ctx.userId }))?.online === true; } catch { discordOnline = null; }
      }
      let raw = {};
      try { raw = typeof diagnostico === 'function' ? (diagnostico() ?? {}) : {}; } catch { raw = {}; }
      return montarDiagnostico({ modo: 'cerebro-separado', fontes: { ...fontes, cerebro: { ...raw, botConectado, discordOnline } } });
    },
    async guilds(ctx) {
      requireOwner(ctx);
      return call('guild.list', { userId: ctx.userId });
    },
    async guildDetail(ctx, guildId) {
      requireOwner(ctx);
      return call('guild.get', { userId: ctx.userId, guildId: String(guildId ?? '') });
    },
    async setGuildChannel(ctx, guildId, type, channelId, confirm) {
      requireOwner(ctx);
      return call('guild.setChannel', { userId: ctx.userId, guildId: String(guildId ?? ''), type, channelId: channelId ?? null, confirm: confirm === true }, true);
    },
  };
  for (const action of Object.keys(PANEL_ACTIONS)) wrapped[action] = panel(action);

  // Lacunas do painel, entrega B: as Integrações que o bot monta ganham aqui o grupo "Contas da Yui" (o Google e a live do YouTube rodam no cérebro).
  wrapped.integrations = async (ctx) => {
    requireOwner(ctx);
    const out = await panel('integrations')(ctx);
    return typeof admin.contasDaYui === 'function' ? comContasDaYui(out, await admin.contasDaYui(ctx)) : out;
  };
  // O GTA (entrega D): o bot monta a vista (os bancos e o estado do Reddit são dele) e o cérebro a passa de novo pela lista fechada de campos.
  wrapped.gta = async (ctx) => limparVistaDoGta(await panel('gta')(ctx));
  // Os avisos: a fila e o que o modo observar registrou no cérebro (aqui) mais o que ele registrou no bot (pedido de LEITURA pelo canal). O bot fora não
  // derruba a tela: a parte dele aparece como indisponível. O que vem do bot passa de novo pela vista (lista fechada de campos).
  if (typeof admin.avisos === 'function') wrapped.avisos = async (ctx) => {
    const out = await admin.avisos(ctx); // confere o dono antes de qualquer pedido ao bot
    let doBot;
    try {
      doBot = vistaDosObservados(await call('panel.admin', { action: 'avisosObservados', userId: ctx.userId, args: [] }), 'bot');
    } catch {
      doBot = { origem: 'bot', indisponivel: true };
    }
    return vistaDosAvisos({ modo: out.modo, fila: out.fila, observados: [...out.observados, doBot] });
  };

  // Provedores de IA: o painel grava no cérebro (secrets/ai-providers.json e o ambiente DESTE processo). O bot tem a cadeia de
  // IA dele (legacy-chain + Gateway em processo): avisa por evento para ele reler as chaves (ou zerar os descansos). Bot fora:
  // ele relê ao reconectar (o cérebro manda o mesmo evento a cada conexão do bot) e ao subir.
  const notifyBot = (tipo) => { try { channel.emit?.('ai.settingsChanged', { tipo }, { role: 'bot' }); } catch { /* o aviso nunca derruba o painel */ } };
  for (const name of AI_SETTINGS_METHODS) {
    const original = admin[name];
    if (typeof original !== 'function') continue;
    wrapped[name] = async (...args) => {
      const out = await original(...args);
      notifyBot(name === 'gatewayReset' ? 'descanso' : 'chaves');
      return out;
    };
  }
  // Ajustes do painel (cofre): o cérebro grava e aplica aqui; o bot relê ao receber o aviso (SEM valores) ou ao reconectar.
  // `botConectado` vai na resposta dos ajustes que valem na hora, para a tela não afirmar que o bot já mudou quando ele está fora.
  for (const name of ['configSet', 'configRemove']) {
    const original = admin[name];
    if (typeof original !== 'function') continue;
    wrapped[name] = async (...args) => {
      const out = await original(...args);
      let avisados = 0;
      try { avisados = channel.emit?.('painel.settingsChanged', {}, { role: 'bot' }) ?? 0; } catch { /* o aviso nunca derruba o painel */ }
      return out?.reinicio === false ? { ...out, botConectado: avisados > 0 } : out;
    };
  }
  return wrapped;
}

/** Métodos do createAdmin que mudam a configuração de IA (o bot precisa saber). */
export const AI_SETTINGS_METHODS = Object.freeze(['aiAddKey', 'aiRemoveKey', 'aiCloudflare', 'aiSetEnabled', 'aiAddCustom', 'aiAddCustomKey', 'aiCustomOptions', 'aiRemoveCustom', 'gatewayReset']);
