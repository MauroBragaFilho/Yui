import crypto from 'crypto';
import fs from 'fs';
import { ACOES_COM_CHAVE, ConfirmacaoError, confirmacoesDoPainel, sessaoDe } from './confirmacao.js';
import os from 'os';
import path from 'path';
import * as memory from '../memory/store.js';
import { listTools } from '../agent/tools.js';
import { checkToolAccess, isOwnerId, isReadOnlyMode, ROLES } from '../permissions.js';
import { isMemoryEnabled } from '../discordAdapter.js';
import { audit, auditFilePath } from '../audit.js';
import { descrever as descreverConfig, definir as definirConfig, remover as removerConfig, exigeConfirmacao, PainelConfigError } from '../painelConfig.js';
import { interactionSeries } from '../interactionStats.js';
import { parseWhen, describeWhen, describeRepeat } from '../../reminders/when.js';
import { ReminderError } from '../../reminders/store.js';
import { listRadio, RADIO_ACTIONS, RADIO_ESCOLHA_MS, MAX_OPCOES_DO_RADIO, buscaDoRadio, canaisDoRadio, defaultRadioDeps, faixaCurta, opcoesDoRadio } from './radioAdmin.js';
import { readLogs } from './panelLogs.js';
import { buildIntegrations, comContasDaYui, loadGuildDetail, loadIntegrationData } from './integrations.js';
import { limitesDoComputador, nivelDoLivre, pastaDoDisco } from '../limitesDoComputador.js';
import {
  criarLeiturasPadrao, linhaCurta, montarVistaDoGta, vistaDaContinuidade, vistaDaLive, vistaDasListas, vistaDasSkills, vistaDoGoogle, vistaDosAvisos, vistaDosObservados, vistaDosPlanos,
} from './leiturasDoPainel.js';
import { planosLigados, planosPeloPainel } from '../planos/pedido.js';
import { apagarDaContinuidade, continuidadeLigada, listarContinuidade, podeContinuidade } from '../continuidade.js';
import { montarDiagnostico } from '../diagnostico.js';
import { criarPedidoDeVerificacao } from '../ai/verificacaoRotaPrivada.js';
import { addCustom, addCustomKey, setCustomOptions, addKey, AiSettingsError, describeAi, isEditEnabled, removeCustom, removeKey, setCloudflareAccount, setEnabled } from '../aiSettings.js';

/**
 * Administração da Yui pelo painel (somente o DONO).
 *
 * O que o painel controla: visão geral, servidores (AutoMod, canais, avisos de
 * YouTube/Twitch), banimentos, memória dos usuários (SÓ metadados), auditoria,
 * lista de ferramentas, provedores de IA (adicionar chaves e provedores próprios,
 * ligar/desligar; as chaves só ENTRAM, nunca saem; YUI_PANEL_AI_EDIT=false trava)
 * e reinício da Yui.
 *
 * O que o painel NÃO controla, de propósito (só pelo .env): o modo somente
 * leitura, a senha/o login e os tokens de acesso. Assim, um painel comprometido
 * não consegue se desbloquear nem trocar as próprias credenciais de entrada.
 *
 * Toda ação que altera algo é registrada na auditoria (só metadados).
 */

export class AdminError extends Error {
  constructor(status, message) {
    super(message);
    this.name = 'AdminError';
    this.status = status;
  }
}

const ID_RE = /^\d{15,25}$/;
const AUTOMOD_MODES = ['off', 'trigger', 'mcp', 'both'];
const BAN_TYPES = ['user', 'guild', 'channel'];
const MAX_AUDIT = 500;
const FREQUENCIAS = ['low', 'medium', 'high'];
const SERVIDOR_FORA = 'As configurações por servidor só funcionam com o bot do Discord ligado a este processo.';

// A ponte registrada pelo processo do bot ANTES de subir a API (processo único): assim a chamada startApi(client) do src/index.js continua a mesma
// (o test:cotahora confere que a cota liga antes dela). Quem passa `servidor` ao createAdmin (o cérebro separado, os testes) vence.
let servidorRegistrado = null;
export function registrarServidorDoPainel(loader) {
  servidorRegistrado = typeof loader === 'function' ? loader : null;
}

// O reinício com o cérebro separado (etapa 10): o que o dono lê é a verdade sobre o que reinicia e, se o supervisor recusa, que NADA reiniciou.
const RESTART_MESSAGE_BOTH = 'Reiniciando o cérebro e o bot do Discord, nesta ordem: o bot para, o cérebro para, o cérebro sobe e depois o bot. O app fica sem resposta até o cérebro voltar (de alguns segundos a cerca de um minuto) e o bot fica fora do Discord nesse intervalo.';
const RESTART_REFUSALS = Object.freeze({
  'sem-supervisor': { status: 503, texto: 'Nada foi reiniciado: este cérebro não está sob o supervisor, então ninguém o religaria. Reinicie à mão.' },
  'ja-em-curso': { status: 409, texto: 'Já existe um reinício em andamento. Nada novo foi pedido; aguarde o cérebro voltar.' },
  'sem-resposta': { status: 504, texto: 'O supervisor não respondeu ao pedido. Não sei se o reinício começou: espere um pouco e confira o estado antes de pedir de novo.' },
  'supervisor-parando': { status: 409, texto: 'Nada foi reiniciado: o supervisor está parando a Yui.' },
  'modo-unico': { status: 409, texto: 'Nada foi reiniciado: o supervisor está no modo de processo único.' },
  padrao: { status: 502, texto: 'O supervisor recusou o pedido. Nada foi reiniciado.' },
});

function requireOwner(ctx) {
  if (ctx?.role !== ROLES.OWNER) throw new AdminError(403, 'Apenas o dono pode usar o painel de administração.');
}

// Entrega E das lacunas do painel (aprovar planos e entrar na live pelo painel): um limite simples de repetição, só na memória (a API é só do dono).
// "Sair da live" fica de fora de propósito: a parada tem de funcionar sempre.
export const LIMITE_DAS_DECISOES = Object.freeze({ max: 20, janelaMs: 60_000 });
export const LIMITE_DAS_ENTRADAS = Object.freeze({ max: 10, janelaMs: 60_000 });
// Entrega E, parte 2 (item 9 v2): republicar o GTA. Uma republicação do MESMO tipo no MESMO servidor a cada 10 minutos (o duplo clique e a repetição não
// enchem o canal). Só conta o que chegou a publicar: servidor sem canal, nada salvo e falha do Discord não prendem o próximo pedido.
export const LIMITE_DA_REPUBLICACAO = Object.freeze({ janelaMs: 10 * 60_000 });
export const TIPOS_DA_REPUBLICACAO = Object.freeze(['diario', 'semanal', 'noticia']);
const NOME_DO_TIPO = Object.freeze({ diario: 'diário', semanal: 'semanal', noticia: 'de notícias' });
const LIVE_DESLIGADA = 'A live do YouTube está desligada ("Yui na live" em Configuração e chaves).';
// Entrega F, parte 2 (item 14): reautorizar o Google pelo painel (YUI_GOOGLE_REAUTORIZAR_PAINEL; desligada = 404).
const GOOGLE_PAINEL_DESLIGADO = 'Reautorizar o Google pelo painel está desligado ("Reautorizar o Google pelo painel" em Configuração e chaves).';
const GOOGLE_FORA_DO_PROCESSO = 'Reautorizar o Google só funciona no processo que serve o painel.';
const LINK_DA_LIVE_INVALIDO = 'Esse link não parece de uma live do YouTube.';
/** true = passou do limite (e o pedido não conta); false = conta e segue. */
function passouDoLimite(marcas, { max, janelaMs }, agora = Date.now()) {
  while (marcas.length && agora - marcas[0] >= janelaMs) marcas.shift();
  if (marcas.length >= max) return true;
  marcas.push(agora);
  return false;
}
/** Só "está numa live" e "desde quando", do painel() do serviço (para saber se a entrada ou a saída valeu). */
function retratoDaLive(servico) {
  try {
    const p = servico?.painel?.();
    return { ativo: p?.ativo === true, desde: p?.desde ?? null };
  } catch {
    return { ativo: false, desde: null };
  }
}

function requireId(value, label = 'ID') {
  const id = String(value ?? '').trim();
  if (!ID_RE.test(id)) throw new AdminError(400, `${label} inválido (use só números, 15 a 25 dígitos).`);
  return id;
}

const LIVE_MODE_VALUES = ['auto', 'new', 'edit'];
function requireLiveMode(value) {
  const mode = String(value ?? '').trim().toLowerCase();
  if (!LIVE_MODE_VALUES.includes(mode)) throw new AdminError(400, `Modo de live inválido. Use: ${LIVE_MODE_VALUES.join(', ')}.`);
  return mode;
}

function requireConfirm(body, oQue) {
  if (body?.confirm !== true) throw new AdminError(400, `Confirmação necessária (confirm: true) para ${oQue}.`);
}

function requireBool(value, campo) {
  if (typeof value !== 'boolean') throw new AdminError(400, `Informe ${campo}: true ou false.`);
  return value;
}

// Caracteres de controle: o humor é de linha única (como no Discord); a instrução aceita quebra de linha e tabulação.
const CONTROLE_LINHA_RE = new RegExp('[\\u0000-\\u001f\\u007f-\\u009f\\u2028\\u2029]');
const CONTROLE_TEXTO_RE = new RegExp('[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u2028\\u2029]');

/** Texto da persona: ausente/null = não muda; "" = limpa. Acima do limite é recusado (nada é cortado calado). */
function textoDaPersona(value, campo, max, { multilinha = false } = {}) {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') throw new AdminError(400, `O campo ${campo} precisa ser texto.`);
  const texto = multilinha ? value.replace(/\r\n/g, '\n') : value;
  if (texto.length > max) throw new AdminError(400, `O campo ${campo} passa de ${max} caracteres.`);
  if ((multilinha ? CONTROLE_TEXTO_RE : CONTROLE_LINHA_RE).test(texto)) throw new AdminError(400, `O campo ${campo} não pode ter ${multilinha ? '' : 'quebra de linha nem '}caractere de controle.`);
  return texto;
}

/** As funções de salvar do bot devolvem false quando o disco recusa: o painel não pode dizer que salvou. */
function exigirGravacao(resultado) {
  if (resultado === false) throw new AdminError(500, 'Não consegui gravar no disco: a mudança vale só até o próximo reinício. Confira o arquivo e tente de novo.');
}

/** Como o painel vê a configuração de um canal (o formato antigo, só texto, é a instrução). */
function canalView(channel, settings, limites) {
  const s = typeof settings === 'string' ? { instruction: settings } : (settings ?? {});
  const c = s.chatter ?? {};
  return {
    channelId: channel.id,
    nome: channel.name ?? null,
    persona: { instrucao: s.instruction || null, humor: s.mood || null },
    espontaneo: { ativo: c.active === true, frequencia: c.frequency ?? null, porcentagem: c.percentage ?? null },
    limites: { ...limites },
  };
}

/** Dependências reais do bot, carregadas só quando necessário (os testes injetam fakes). */
async function defaultDeps() {
  const ban = await import('../../handlers/banHandler.js');
  const tos = await import('../../handlers/tosHandler.js');
  return {
    getBans: ban.getBans,
    addBan: ban.addBan,
    removeBan: ban.removeBan,
    setAutoBlock: ban.setAutoBlock,
    getAutoBlockMode: ban.getAutoBlockMode,
    isServerAccepted: tos.isServerAccepted,
  };
}

/**
 * Saúde da máquina que roda a Yui: RAM e disco livres. Nunca lança: o que não der para ler vem null.
 * Entra no painel porque o notebook tem 4 GB e HD: é o primeiro lugar onde se vê se ele está apertado.
 * Fase 1 do painel (R10): o disco é medido na MESMA pasta que o alerta por DM mede (a dos dados; core/limitesDoComputador.js), e `alerta` traz os
 * limites do cofre e o nível de cada recurso pela mesma regra do alerta. O app só mostra; não tem regra própria. `volume` é só a raiz da unidade
 * medida (ex.: "C:\"), nunca o caminho, para conferir se o servidor de arquivos está no mesmo disco.
 */
export function readHostStats({ osImpl = os, fsImpl = fs, cwd = process.cwd(), env = process.env } = {}) {
  const mb = (bytes) => Math.round(bytes / 1024 / 1024);
  const gb = (bytes) => Math.round((bytes / 1024 / 1024 / 1024) * 10) / 10;
  const out = { platform: osImpl.platform(), ramTotalMB: null, ramFreeMB: null, diskTotalGB: null, diskFreeGB: null, volume: null, alerta: null };
  try {
    out.ramTotalMB = mb(osImpl.totalmem());
    out.ramFreeMB = mb(osImpl.freemem());
  } catch { /* sem leitura de RAM */ }
  try {
    const pasta = pastaDoDisco(env, { fsImpl, cwd: () => cwd });
    const st = fsImpl.statfsSync(pasta);
    out.diskTotalGB = gb(st.blocks * st.bsize);
    out.diskFreeGB = gb(st.bavail * st.bsize);
    out.volume = path.parse(path.resolve(pasta)).root || null;
  } catch { /* sem leitura de disco */ }
  try {
    const lim = limitesDoComputador(env);
    out.alerta = {
      discoLivreMinGB: lim.discoGB > 0 ? lim.discoGB : null,
      ramLivreMinMB: lim.ramMB > 0 ? lim.ramMB : null,
      ramMinutos: lim.ramMin,
      nivelDisco: nivelDoLivre(out.diskFreeGB, lim.discoGB),
      nivelRam: nivelDoLivre(out.ramFreeMB, lim.ramMB),
    };
  } catch { /* sem limites: o painel não colore */ }
  return out;
}

/** Lê as últimas `limit` linhas do arquivo de auditoria sem carregá-lo inteiro. */
function tailAudit(file, limit) {
  let fd;
  try {
    fd = fs.openSync(file, 'r');
    const size = fs.fstatSync(fd).size;
    const chunk = Math.min(size, 512 * 1024);
    const buf = Buffer.alloc(chunk);
    fs.readSync(fd, buf, 0, chunk, size - chunk);
    const lines = buf.toString('utf8').split('\n').filter((l) => l.startsWith('{'));
    const rows = [];
    for (const line of lines.slice(-limit)) {
      try { rows.push(JSON.parse(line)); } catch { /* linha cortada no início do trecho */ }
    }
    return rows.reverse();
  } catch {
    return [];
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

/** Conta, nas últimas 24 h da auditoria, os eventos que merecem atenção do dono (sem detalhes, só quantos). */
export function countProblems(rows, now = Date.now()) {
  const out = { loginFail: 0, toolError: 0, toolDenied: 0, alertFail: 0 };
  for (const e of rows || []) {
    const t = Date.parse(e?.ts);
    if (Number.isNaN(t) || now - t > 24 * 60 * 60 * 1000) continue;
    if (e.event === 'auth.login.fail') out.loginFail += 1;
    else if (e.event === 'agent.tool.error') out.toolError += 1;
    else if (e.event === 'agent.tool.denied') out.toolDenied += 1;
    else if (e.event === 'alert.fail') out.alertFail += 1;
  }
  return out;
}

const CHANNEL_COLUMNS = { noticias: 'news_channel_id', diario: 'daily_channel_id', semanal: 'weekly_channel_id' };

/** Canal de texto/anúncios que existe no servidor (a Yui só publica nesses). */
function requireTextChannel(guild, value) {
  const id = requireId(value, 'ID do canal');
  const ch = guild.channels?.cache?.get?.(id);
  if (!ch || ![0, 5].includes(ch.type)) throw new AdminError(400, 'Esse canal não existe neste servidor ou não é de texto.');
  return id;
}

/** Mensagem útil quando o teste falha: o erro real do provedor (sem chaves) ou o motivo de estar inativo. */
async function explainAiFailure(e, id, deps) {
  const msg = String(e?.message ?? 'falhou');
  if (deps?.aiChat) return msg.slice(0, 200);
  try {
    const { getGateway } = await import('../../gateway/index.js');
    const st = getGateway().status().providers.find((p) => p.id === id);
    if (!st) return 'Provedor inativo: falta chave (ou a chave é curta demais), está desligado ou o ID da conta não foi informado.';
    if (st.cooldownSeconds > 0) {
      const last = st.targets.map((t) => t.lastError).find(Boolean);
      return `Em descanso por ${Math.ceil(st.cooldownSeconds / 60)} min após erro: ${String(last ?? msg).replace(/\s+/g, ' ').slice(0, 170)}`;
    }
    const last = st.targets.map((t) => t.lastError).find(Boolean);
    if (last) return String(last).replace(/\s+/g, ' ').slice(0, 200);
  } catch {
    /* sem detalhes extras */
  }
  return msg.slice(0, 200);
}

async function aiChange(ctx, event, meta, fn) {
  requireOwner(ctx);
  if (!isEditEnabled()) throw new AdminError(403, 'A edição de IA pelo painel está desligada (YUI_PANEL_AI_EDIT=false no .env).');
  let out;
  try {
    out = fn();
  } catch (e) {
    if (e instanceof AiSettingsError) throw new AdminError(e.status, e.message);
    throw e;
  }
  const { resetGateway } = await import('../../gateway/index.js');
  resetGateway();
  audit(event, ctx, meta);
  return { ok: true, ...out };
}

async function defaultSetGuildChannel(guildId, column, channelId) {
  const { guildRepository } = await import('../../database/repositories/guildRepo.js');
  guildRepository.setChannel(guildId, column, channelId);
}

async function defaultAddYoutube({ guildId, input, discordChannelId, roleId, videos, shorts, lives, liveMode }) {
  const { resolveChannel } = await import('../../handlers/youtubeApiHandler.js');
  const { youtubeRepository } = await import('../../database/repositories/youtubeRepo.js');
  let resolved;
  try {
    resolved = await resolveChannel(input);
  } catch (e) {
    throw new AdminError(502, `Falha ao consultar a API do YouTube: ${e.message}`);
  }
  if (!resolved) throw new AdminError(404, 'Não encontrei esse canal no YouTube. Confira o @handle, o ID (UC...) ou a URL.');
  const r = youtubeRepository.addSubscription({
    guildId,
    youtubeChannelId: resolved.channelId,
    channelName: resolved.title,
    uploadsPlaylistId: resolved.uploadsPlaylistId,
    discordChannelId,
    mentionRoleId: roleId,
    notifyVideos: videos ? 1 : 0,
    notifyShorts: shorts ? 1 : 0,
    notifyLives: lives ? 1 : 0,
    liveMode,
  });
  return { added: r.changes > 0, channelId: resolved.channelId, name: resolved.title };
}

async function defaultSetYoutubeLiveMode(guildId, youtubeChannelId, discordChannelId, mode) {
  const { youtubeRepository } = await import('../../database/repositories/youtubeRepo.js');
  return youtubeRepository.setLiveMode(guildId, youtubeChannelId, discordChannelId, mode).changes > 0;
}

async function defaultRemoveYoutube(guildId, youtubeChannelId, discordChannelId) {
  const { youtubeRepository } = await import('../../database/repositories/youtubeRepo.js');
  return youtubeRepository.removeSubscription(guildId, youtubeChannelId, discordChannelId).changes > 0;
}

async function defaultAddTwitch({ guildId, login, discordChannelId, roleId }) {
  const { getTwitchUser } = await import('../../handlers/twitchApiHandler.js');
  const { twitchRepository } = await import('../../database/repositories/twitchRepo.js');
  let user;
  try {
    user = await getTwitchUser(login);
  } catch (e) {
    throw new AdminError(502, `Falha ao consultar a API da Twitch: ${e.message}`);
  }
  if (!user) throw new AdminError(404, 'Não encontrei esse canal na Twitch. Confira o login.');
  const r = twitchRepository.addSubscription({ guildId, twitchLogin: user.login, twitchUserId: user.id, discordChannelId, mentionRoleId: roleId });
  return { added: r.changes > 0, login: user.login, name: user.displayName || user.login };
}

async function defaultRemoveTwitch(guildId, login, discordChannelId) {
  const { twitchRepository } = await import('../../database/repositories/twitchRepo.js');
  return twitchRepository.removeSubscription(guildId, login, discordChannelId).changes > 0;
}

/** Como o painel vê um lembrete: o próprio dado mais os textos prontos ("amanhã às 09:00", "todo dia às 08:00"). */
function reminderView(r, now = new Date()) {
  return {
    id: r.id, text: r.text, at: r.at, repeat: r.repeat, whenText: describeWhen(r.at, now), repeatText: r.repeat ? describeRepeat(r.repeat) : null, tries: r.tries || 0,
    // Só com o cérebro separado: o estado da entrega do aviso ('enviando' a confirmar ou 'incerto', que o dono resolve).
    ...(r.entrega?.estado ? { entrega: { estado: r.entrega.estado, desde: r.entrega.desde ?? null, motivo: r.entrega.motivo ?? null } } : {}),
  };
}

export function createAdmin({
  client = null,
  deps = null,
  reminders = null, // { store, compose(now), send(text) }: injetável para teste; o padrão é o armazenamento e o envio reais

  auditFile = null,
  exit = () => process.exit(0),
  // Reinício CONTROLADO pelo supervisor (o cérebro separado passa esta função; ver src/operacao/filho.js e supervisor.js): `({ motivo }) => Promise<{ aceito, motivo }>`.
  // Sem ela (processo único, testes) vale o `exit` de sempre: o processo sai e a tarefa/o supervisor o religa em ~15 s.
  reinicio = null,
  startedAt = Date.now(),
  // Monitores do dono (etapa 16, YUI_MONITORES; só o cérebro separado passa): `{ listar(), cancelar(id) }`. Sem eles a rota diz "desligado" e não faz nada.
  monitores = null,
  // Configurações por servidor (src/discord/painelServidor.js): `() => Promise<ponte>`. Injetada pelo processo do bot; o Core não importa nada dele.
  servidor = null,
  // Qual processo é este: 'unico' (processo único), 'cerebro' (serve a API com os dois processos) ou 'bot' (o bot separado, que só atende o cérebro pelo canal).
  // No bot separado as Integrações não montam o grupo "Contas da Yui" (a live e o Google rodam no cérebro, que o acrescenta).
  processo = 'unico',
  // As leituras das entregas B e D das lacunas do painel (live, Google, planos, avisos, listas, skills; src/core/api/leiturasDoPainel.js). Injetáveis para teste.
  leituras = null,
  // Entrega E (itens 3 v2 e 4 v2): os serviços que as AÇÕES do painel chamam. `planos`: o serviço dos planos (o cérebro passa o dele); sem ele, a porta dos
  // planos, que no processo único É o serviço. `live`: o serviço da live; sem ele, a porta da live, que no cérebro e no processo único É o serviço.
  planos = null,
  live = null,
  // O relógio do freio de pedido repetido (correção C6). Injetável para teste.
  relogio = () => Date.now(),
  // Correção C2: as chaves de confirmação (o padrão é o lugar compartilhado deste processo, src/core/api/confirmacao.js) e quem manda a DM ao dono
  // (o padrão é o sendOwnerMessage das alertas: no cérebro separado, pelo bot). Injetáveis para teste.
  confirmacoes = null,
  enviarDmAoDono = null,
} = {}) {
  let leiturasCache = leituras;
  const chavesDeConfirmacao = () => confirmacoes ?? confirmacoesDoPainel();
  async function dmAoDono(texto) {
    const enviar = enviarDmAoDono ?? (await import('../alerts.js')).sendOwnerMessage;
    return enviar(texto);
  }
  /**
   * Correção C2: confere e consome a chave de confirmação pela DM desta ação neste alvo, nesta sessão. Lança AdminError (428 sem chave, 422 inválida ou
   * vencida, 429 travada). Auditoria só com a ação e o resultado, nunca a chave; a trava avisa o dono.
   */
  async function exigirChave(ctx, acao, alvo, chave) {
    try {
      chavesDeConfirmacao().conferir({ userId: String(ctx?.userId ?? ''), sessao: sessaoDe(ctx), acao, alvo, chave });
    } catch (e) {
      if (!(e instanceof ConfirmacaoError)) throw e;
      audit('admin.confirmacao.recusada', ctx, { acao, status: e.status });
      if (e.travou) {
        try {
          const { alertOwner } = await import('../alerts.js');
          alertOwner('lock-confirmacao', 'Chaves de confirmação bloqueadas', 'Houve várias chaves de confirmação erradas seguidas no painel. A confirmação ficou travada por 15 minutos. Se não foi você, troque a senha do painel e saia das outras sessões.', { level: 'error' });
        } catch { /* o aviso nunca muda a recusa */ }
      }
      throw new AdminError(e.status, e.message);
    }
    audit('admin.confirmacao.usada', ctx, { acao });
  }
  const ler = () => (leiturasCache ??= criarLeiturasPadrao());
  // O bot separado não serve a API: as ações nunca usam a porta dele (que é o pedido ao cérebro pelo canal).
  async function servicoDosPlanos() {
    if (planos) return planos;
    if (processo === 'bot') return null;
    const { portaDePlanos } = await import('../planos/porta.js');
    return portaDePlanos();
  }
  async function servicoDaLive() {
    const s = live ?? (processo === 'bot' ? null : (await import('../../adaptadores/youtube/porta.js')).portaDaLive());
    if (typeof s?.rotear !== 'function') throw new AdminError(503, 'A live está indisponível agora (o serviço não subiu neste processo).');
    return s;
  }
  const decisoesRecentes = [];
  const entradasRecentes = [];
  // Entrega F, parte 2 (item 14): a reautorização do Google (src/integrations/google/reautorizar.js). A sessão, com o verificador do PKCE, vive SÓ na memória
  // deste processo (o que serve a API e lê o arquivo da autorização). `deps.googleReautorizar` só existe para teste (relógio, permissão restrita).
  let reautorizacao = null;
  let moduloDaReautorizacao = null;
  async function reautorizacaoDoGoogle() {
    moduloDaReautorizacao ??= await import('../../integrations/google/reautorizar.js');
    reautorizacao ??= moduloDaReautorizacao.criarReautorizacao(deps?.googleReautorizar ?? {});
    return { r: reautorizacao, textos: moduloDaReautorizacao.TEXTOS_DAS_FALHAS };
  }
  /** Só o dono, só no processo da API e só com a chave ligada (desligada: descarta a sessão em andamento e responde 404). */
  async function exigirReautorizacaoLigada(ctx) {
    requireOwner(ctx);
    if (processo === 'bot') throw new AdminError(503, GOOGLE_FORA_DO_PROCESSO);
    const { reautorizacaoPeloPainelLigada } = await import('../../integrations/google/config.js');
    if (!reautorizacaoPeloPainelLigada()) {
      reautorizacao?.descartar();
      throw new AdminError(404, GOOGLE_PAINEL_DESLIGADO);
    }
    return reautorizacaoDoGoogle();
  }
  // Item 9 v2: a última republicação de cada tipo em cada servidor ("tipo:guildId" -> ms). O relógio é injetável só para teste (deps.agora).
  const republicacoes = new Map();
  const agoraMs = () => (typeof deps?.agora === 'function' ? Number(deps.agora()) : Date.now());
  // Item 10: as opções de uma busca ambígua do rádio ficam AQUI (no processo do rádio), por servidor e por pouco tempo. O painel só devolve o NÚMERO da
  // opção: uma faixa (com o link dela) escolhida ou montada pelo painel nunca chega ao player.
  const escolhasDoRadio = new Map();
  /** O grupo "Contas da Yui" de Integrações: o Google e a live, lidos aqui (nunca derruba a tela: sem leitura, o item diz que está desligado). */
  async function contasDaYui() {
    const seguro = async (fn) => { try { return await fn(); } catch { return null; } };
    const live = await seguro(() => ler().live());
    const google = await seguro(() => ler().google());
    return { live: live ? vistaDaLive(live.bruto ?? null, { ligado: live.ligado === true }) : null, google: google ? vistaDoGoogle(google) : null };
  }
  let servidorCache = null;
  const srv = async () => {
    const carregar = servidor ?? servidorRegistrado;
    if (!carregar) throw new AdminError(503, SERVIDOR_FORA);
    return (servidorCache ??= await carregar());
  };
  let cached = deps;
  const d = async () => (cached ??= await defaultDeps());
  let remCache = reminders;
  const rem = async () => {
    if (remCache) return remCache;
    const { getReminderStore } = await import('../../reminders/assistant.js');
    const { createMorningComposer } = await import('../../reminders/service.js');
    const { sendOwnerMessage } = await import('../alerts.js');
    remCache = { store: getReminderStore(), compose: createMorningComposer({ client }), send: sendOwnerMessage };
    return remCache;
  };

  const userName = (id) => { try { return client?.users?.cache?.get(String(id))?.username ?? null; } catch { return null; } };
  const guildList = () => (client?.guilds?.cache ? [...client.guilds.cache.values()] : []);
  let radioCache = null;
  const radioDeps = async () => deps?.radio ?? (radioCache ??= await defaultRadioDeps());
  // Pedido de nova verificação da rota privada de IA (etapa 13): o limite de repetição vive aqui (em memória). `deps.rotaPrivada` só existe para teste.
  let pedirVerificacao = null;
  const verificacaoDaRota = () => (pedirVerificacao ??= criarPedidoDeVerificacao(deps?.rotaPrivada ?? {}));
  const findGuild = (guildId) => {
    const id = requireId(guildId, 'ID do servidor');
    const g = guildList().find((x) => x.id === id);
    if (!g) throw new AdminError(404, 'A Yui não está nesse servidor.');
    return g;
  };

  // ── Rádio pelo painel (item 10): o que a fila respondeu, em palavras fixas, e a busca (gênero, música ou link) que pode virar uma escolha ──
  const respostaDaFila = (entrou) => {
    if (!entrou || !(Number(entrou.count) > 0)) return { resultado: 'nao-encontrado' };
    const resultado = entrou.playing === true ? 'tocando' : 'na-fila';
    return entrou.kind === 'playlist' ? { resultado, adicionadas: Number(entrou.count) } : { resultado, adicionadas: 1, faixa: faixaCurta(entrou.track) };
  };
  async function tocarNoRadio(ctx, id, r, busca) {
    let achado = null;
    try { achado = await r.resolve(busca, id); } catch { achado = null; }
    if (!achado || achado.type === 'not_found') return { resultado: 'nao-encontrado' };
    if (achado.type === 'ambiguous' && Array.isArray(achado.results) && achado.results.length > 1) {
      const opcoes = achado.results.slice(0, MAX_OPCOES_DO_RADIO);
      escolhasDoRadio.set(id, { opcoes, ate: agoraMs() + RADIO_ESCOLHA_MS });
      return { resultado: 'escolher', opcoes: opcoesDoRadio(opcoes) };
    }
    escolhasDoRadio.delete(id);
    return respostaDaFila(await r.enqueue(id, achado, String(ctx.userId ?? ''), client));
  }
  /**
   * Iniciar sem ninguém na call: só canais DESTE servidor, de voz (em que a Yui pode entrar e falar) e de texto (em que ela pode escrever). O gênero ou a
   * música vêm depois, pelo `play` (cada pedido cabe no prazo do canal entre o cérebro e o bot: entrar na call e buscar a música, juntos, podem passar dele).
   */
  async function iniciarRadio(ctx, id, body, r) {
    const guild = findGuild(id);
    const voiceId = requireId(body?.voiceChannelId, 'Canal de voz');
    const textId = requireId(body?.textChannelId, 'Canal de texto');
    const { voz, texto } = canaisDoRadio(guild);
    const v = voz.find((c) => c.id === voiceId);
    if (!v) throw new AdminError(400, 'Esse canal de voz não é deste servidor (ou não é um canal de voz).');
    if (!v.pode) throw new AdminError(409, v.motivo === 'cheio' ? 'Esse canal de voz está cheio.' : 'A Yui não tem permissão para entrar e falar nesse canal de voz.');
    const t = texto.find((c) => c.id === textId);
    if (!t) throw new AdminError(400, 'Esse canal de texto não é deste servidor (ou não é um canal de texto).');
    if (!t.pode) throw new AdminError(409, 'A Yui não tem permissão para escrever (com embeds) nesse canal de texto.');
    const cache = guild.channels.cache;
    const st = await r.start(cache.get(voiceId), cache.get(textId), client);
    if (st?.success !== true) throw new AdminError(409, linhaCurta(st?.error, 200) || 'Não consegui ligar o rádio.');
    escolhasDoRadio.delete(id);
    audit('admin.radio', ctx, { guild: id, action: 'start' });
    return { ok: true, iniciado: true };
  }

  const metodos = {
    /** Visão geral: estado da Yui e das proteções. */
    async overview(ctx) {
      requireOwner(ctx);
      const dep = await d();
      const bans = dep.getBans();
      const mem = mem_count(ctx);
      return {
        uptimeSeconds: Math.round((Date.now() - startedAt) / 1000),
        pid: process.pid,
        node: process.version,
        memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
        discord: {
          online: Boolean(client?.isReady?.()),
          tag: client?.user?.tag ?? null,
          guilds: guildList().length,
        },
        bans: {
          users: Object.keys(bans.users || {}).length,
          guilds: Object.keys(bans.guilds || {}).length,
          channels: Object.keys(bans.channels || {}).length,
        },
        memoryUsers: mem,
        // Nome para a saudação do painel (opcional: YUI_OWNER_NAME). Sem ele a tela só diz "Boa noite.".
        ownerName: String(process.env.YUI_OWNER_NAME || '').trim().slice(0, 40) || null,
        host: deps?.hostStats ? deps.hostStats() : readHostStats(),
        // Atividade recente: só quando, o quê e por qual canal (nunca o conteúdo de mensagens nem os detalhes do evento).
        activity: tailAudit(auditFile || auditFilePath(), 8).map((e) => ({ ts: e.ts ?? null, event: String(e.event ?? ''), role: e.role ?? null, platform: e.platform ?? null })),
        retention: { ownerPermanent: true, othersPermanent: safeIsPermanent(), othersDays: safeRetentionDays() },
        // Respostas da IA por hora nas últimas 24 h (contador gravado em disco, vale desde `since`) e problemas vistos na auditoria no mesmo período.
        interactions: deps?.interactions ? deps.interactions() : interactionSeries(),
        problems: countProblems(tailAudit(auditFile || auditFilePath(), 1500)),
        flags: {
          readOnly: isReadOnlyMode(),
          memoryEnabled: isMemoryEnabled(),
          pcToolsEnabled: String(process.env.YUI_TOOLS_PC_ENABLED || 'false').toLowerCase() === 'true',
        },
      };
    },

    // ── Lembretes e relatório matinal (só o dono) ──
    async reminders(ctx) {
      requireOwner(ctx);
      const r = await rem();
      const now = new Date();
      return { reminders: r.store.list().map((x) => reminderView(x, now)), now: now.toISOString() };
    },

    /** `when` em português ("amanhã às 9h", "em 2 horas", "todo dia às 8h") ou `at` (ISO). */
    async addReminder(ctx, { text, when, at } = {}) {
      requireOwner(ctx);
      const r = await rem();
      const now = new Date();
      let whenAt; let repeat = null; let clean = String(text ?? '');
      if (at) {
        whenAt = new Date(at);
        if (Number.isNaN(whenAt.getTime())) throw new AdminError(400, 'Data inválida.');
      } else {
        const w = parseWhen(String(when ?? ''), now);
        if (!w.ok) throw new AdminError(400, w.reason === 'sem-horario' ? 'Diga quando, por exemplo: "amanhã às 9h" ou "em 2 horas".' : w.message);
        whenAt = w.at; repeat = w.repeat;
      }
      if (!clean.trim()) throw new AdminError(400, 'Do que devo te lembrar?');
      try {
        const added = r.store.add({ text: clean, at: whenAt, repeat });
        audit('admin.reminder.add', ctx, { repeat: Boolean(repeat) });
        return { reminder: reminderView(added, now) };
      } catch (err) {
        if (err instanceof ReminderError) throw new AdminError(400, err.message);
        throw err;
      }
    },

    async removeReminder(ctx, id) {
      requireOwner(ctx);
      const r = await rem();
      if (!r.store.remove(id)) throw new AdminError(404, 'Lembrete não encontrado.');
      audit('admin.reminder.remove', ctx, {});
      return { ok: true };
    },

    /** Adia: `minutes` (a partir de agora) ou `when` em português ("amanhã às 9h"). */
    async snoozeReminder(ctx, id, { minutes, when } = {}) {
      requireOwner(ctx);
      const r = await rem();
      const now = new Date();
      let to;
      if (Number.isFinite(Number(minutes)) && Number(minutes) > 0) to = new Date(now.getTime() + Math.min(Number(minutes), 60 * 24 * 365) * 60_000);
      else {
        const w = parseWhen(String(when ?? ''), now);
        if (!w.ok) throw new AdminError(400, w.message);
        to = w.at;
      }
      const upd = r.store.reschedule(id, to);
      if (!upd) throw new AdminError(404, 'Lembrete não encontrado.');
      audit('admin.reminder.snooze', ctx, {});
      return { reminder: reminderView(upd, now) };
    },

    // ── Monitores de busca (etapa 16, só o dono): `GET` lista (id, consulta curta, estado, próxima checagem) e `DELETE /:id` cancela ──
    async monitores(ctx) {
      requireOwner(ctx);
      if (!monitores) return { ligado: false, monitores: [] };
      // `resumo`: só contadores (passadas, buscas, avisos, adiadas por cota ou porta...), nunca consulta nem texto de resultado.
      return { ligado: true, monitores: monitores.listar(), ...(typeof monitores.status === 'function' ? { resumo: monitores.status() } : {}) };
    },

    async removeMonitor(ctx, id) {
      requireOwner(ctx);
      if (!monitores) throw new AdminError(404, 'Os monitores estão desligados.');
      if (!monitores.cancelar(Number(id))) throw new AdminError(404, 'Monitor não encontrado (ou já encerrado).');
      audit('admin.monitor.remove', ctx, {});
      return { ok: true };
    },

    /** O texto do relatório matinal de agora (sem enviar). */
    async morningPreview(ctx) {
      requireOwner(ctx);
      const r = await rem();
      return { text: await r.compose(new Date()) };
    },

    /** Manda o relatório matinal ao dono por DM agora. */
    async morningSend(ctx) {
      requireOwner(ctx);
      const r = await rem();
      // `dm: true`: este texto vai por mensagem privada ao dono, então leva a seção do Google (Agenda e Tarefas) como o relatório das 08:00; a prévia no painel (acima) não leva.
      const text = await r.compose(new Date(), { dm: true });
      const ok = (await r.send(text)) === true;
      audit('admin.morning.send', ctx, { ok });
      if (!ok) throw new AdminError(503, 'Não consegui enviar a mensagem privada (o Discord está desconectado?).');
      return { ok: true };
    },

    /** Servidores em que a Yui está, com o modo de AutoMod de cada um. */
    async guilds(ctx) {
      requireOwner(ctx);
      const dep = await d();
      return guildList()
        .map((g) => ({
          id: g.id,
          name: g.name,
          members: g.memberCount ?? null,
          automod: dep.getAutoBlockMode(g.id),
          tosAccepted: dep.isServerAccepted(g.id),
        }))
        .sort((a, b) => a.name.localeCompare(b.name));
    },

    async setAutomod(ctx, guildId, mode) {
      requireOwner(ctx);
      const id = requireId(guildId, 'ID do servidor');
      if (!AUTOMOD_MODES.includes(mode)) throw new AdminError(400, `Modo inválido. Use: ${AUTOMOD_MODES.join(', ')}.`);
      if (client && !guildList().some((g) => g.id === id)) throw new AdminError(404, 'A Yui não está nesse servidor.');
      const dep = await d();
      dep.setAutoBlock(id, mode);
      audit('admin.automod', ctx, { guild: id, mode });
      return { ok: true, guildId: id, automod: dep.getAutoBlockMode(id) };
    },

    async bans(ctx) {
      requireOwner(ctx);
      const dep = await d();
      const b = dep.getBans();
      const list = (obj) =>
        Object.entries(obj || {})
          .map(([id, v]) => ({ id, reason: v?.reason ?? '', timestamp: v?.timestamp ?? null }))
          .sort((x, y) => String(y.timestamp).localeCompare(String(x.timestamp)));
      return { users: list(b.users), guilds: list(b.guilds), channels: list(b.channels) };
    },

    async addBan(ctx, type, id, reason) {
      requireOwner(ctx);
      if (!BAN_TYPES.includes(type)) throw new AdminError(400, `Tipo inválido. Use: ${BAN_TYPES.join(', ')}.`);
      const target = requireId(id);
      if (type === 'user' && isOwnerId(target)) throw new AdminError(400, 'Não é possível banir o dono.');
      const text = String(reason ?? '').trim().slice(0, 200) || 'Banido pelo painel.';
      const dep = await d();
      dep.addBan(type, target, text);
      audit('admin.ban.add', ctx, { type, target });
      return { ok: true };
    },

    async removeBan(ctx, type, id) {
      requireOwner(ctx);
      if (!BAN_TYPES.includes(type)) throw new AdminError(400, `Tipo inválido. Use: ${BAN_TYPES.join(', ')}.`);
      const target = requireId(id);
      const dep = await d();
      dep.removeBan(type, target);
      audit('admin.ban.remove', ctx, { type, target });
      return { ok: true };
    },

    // ── Memória dos usuários (só metadados; o conteúdo nunca é exibido) ──
    async memoryUsers(ctx) {
      requireOwner(ctx);
      const r = memory.adminListUsers(ctx, { limit: 50 });
      return { ...r, permanent: memory.isPermanent(), users: r.users.map((u) => ({ ...u, name: userName(u.userId) })) };
    },
    async memoryInspect(ctx, userId) {
      requireOwner(ctx);
      return { memories: memory.adminListMetadata(ctx, requireId(userId, 'ID do usuário'), { limit: 50 }) };
    },
    async memoryContent(ctx, userId) {
      requireOwner(ctx);
      const id = requireId(userId, 'ID do usuário');
      return { name: userName(id), permanent: memory.isPermanent(), memories: memory.adminListContent(ctx, id, { limit: 100 }) };
    },
    async memoryForget(ctx, userId, memoryId) {
      requireOwner(ctx);
      const n = Number(memoryId);
      if (!Number.isInteger(n) || n < 1) throw new AdminError(400, 'Número da lembrança inválido.');
      return { ok: memory.adminForget(ctx, requireId(userId, 'ID do usuário'), n) };
    },
    async memoryForgetUser(ctx, userId) {
      requireOwner(ctx);
      return { removed: memory.adminForgetUser(ctx, requireId(userId, 'ID do usuário')) };
    },

    /** Últimos eventos da auditoria (só metadados). */
    async audit(ctx, limit = 100) {
      requireOwner(ctx);
      const n = Math.min(MAX_AUDIT, Math.max(1, parseInt(limit, 10) || 100));
      return { events: tailAudit(auditFile || auditFilePath(), n) };
    },

    /** Ferramentas do Agent e se cada uma está liberada agora. Somente leitura: não dá para alterar por aqui. */
    async tools(ctx) {
      requireOwner(ctx);
      return {
        readOnly: isReadOnlyMode(),
        tools: listTools().map((t) => {
          const a = checkToolAccess(ctx, t.name);
          return { name: t.name, description: t.description, access: t.access, confirm: Boolean(t.confirm), allowed: a.allowed, reason: a.reason ?? null };
        }),
      };
    },

    /** Estado das integrações (YouTube, Twitch, Reddit, IA, voz...), só leitura e sem chaves. */
    async integrations(ctx) {
      requireOwner(ctx);
      const data = deps?.integrationData ? await deps.integrationData() : await loadIntegrationData();
      const out = buildIntegrations({
        env: process.env,
        client,
        data,
        readOnly: isReadOnlyMode(),
        memoryEnabled: isMemoryEnabled(),
        tools: listTools().length,
        // o mesmo cálculo da memória que as outras telas mostram (Fase 1 do painel: nada de "retenção de 0 dias" com a memória permanente)
        retencao: safeIsPermanent() ? 'permanente' : safeRetentionDays() ? `${safeRetentionDays()} dias sem interação` : null,
      });
      // Google e live do YouTube (entrega B das lacunas do painel): só onde elas rodam. No bot separado, quem acrescenta é o cérebro.
      return processo === 'bot' ? out : comContasDaYui(out, await contasDaYui());
    },

    /** O grupo "Contas da Yui" (Google e live), para o cérebro juntar às Integrações que o bot montou. Só o dono. */
    async contasDaYui(ctx) {
      requireOwner(ctx);
      return contasDaYui();
    },

    // ── Lacunas do painel, entrega B (26/11/2026): SÓ LEITURA, só o dono. Cada resposta passa por uma vista com lista fechada de campos
    //    (src/core/api/leiturasDoPainel.js): nada de token, segredo, código, texto do chat, nome de quem escreveu, argumentos ou resultados de plano, texto de aviso. ──
    /** A live do YouTube: ligada, em qual live, desde quando, mensagens lidas e respondidas, cota do dia e último erro (código fixo). */
    async live(ctx) {
      requireOwner(ctx);
      const r = await ler().live();
      return vistaDaLive(r?.bruto ?? null, { ligado: r?.ligado === true });
    },
    /** A autorização do Google: ligada, escopos em nome curto, validade em modo Testando, última renovação, último erro e se precisa autorizar de novo. */
    async google(ctx) {
      requireOwner(ctx);
      return vistaDoGoogle(await ler().google());
    },
    /** Os últimos 20 planos: estado, datas e, dos passos, só a ferramenta e o estado. */
    async planos(ctx) {
      requireOwner(ctx);
      const r = await ler().planos();
      // Correção C1: o resumo seguro de cada passo, montado pelo código das próprias ferramentas de plano a partir do passo GUARDADO (sem o texto livre).
      const { criarFerramentasDePlano, resumoSeguroDoPasso } = await import('../planos/ferramentas.js');
      const ferramentas = criarFerramentasDePlano({ env: process.env });
      const resumir = (s) => resumoSeguroDoPasso(ferramentas.get(String(s?.ferramenta ?? '')), s?.args);
      return vistaDosPlanos(r?.lista, { ligado: r?.ligado === true, auto: r?.auto === true, ilegivel: r?.ilegivel === true, painel: r?.painel === true, resumir });
    },
    /** A fila de avisos e o que o modo observar registrou neste processo (o cérebro junta o que o bot registrou: src/cerebro/painel.js). */
    async avisos(ctx) {
      requireOwner(ctx);
      const r = await ler().avisos();
      let obs = null;
      try { obs = await ler().observados(); } catch { obs = null; }
      const origem = processo === 'cerebro' ? 'cerebro' : 'unico';
      return vistaDosAvisos({ modo: r?.modo, fila: r?.fila, observados: [obs ? { ...vistaDosObservados(obs, origem) } : { origem, indisponivel: true }] });
    },
    /** Só o que o modo observar registrou NESTE processo (o cérebro pede ao bot separado por panel.admin). */
    async avisosObservados(ctx) {
      requireOwner(ctx);
      return vistaDosObservados(await ler().observados(), processo === 'bot' ? 'bot' : processo === 'cerebro' ? 'cerebro' : 'unico');
    },

    // ── Lacunas do painel, entrega D (27/11/2026): SÓ O DONO. Leituras com lista fechada de campos (leiturasDoPainel.js) e um único apagar (continuidade). ──
    /**
     * GTA (item 9 v1, só leitura): o último diário, o último semanal válido, a última notícia, onde cada um saiu e o estado das fontes. Os bancos do GTA são
     * do bot: lê pela ponte do painel (src/discord/painelServidor.js -> gtaPainel.js), que só existe no processo do bot (o único ou o bot separado; com os
     * dois processos o cérebro pede ao bot por panel.admin e limpa de novo a vista). Os nomes de servidor e canal vêm do cliente do Discord daqui.
     */
    async gta(ctx) {
      requireOwner(ctx);
      const s = await srv();
      if (typeof s.gta !== 'function') throw new AdminError(503, SERVIDOR_FORA);
      return montarVistaDoGta(await s.gta(), {
        nomeDoServidor: (id) => client?.guilds?.cache?.get?.(id)?.name ?? null,
        nomeDoCanal: (id) => client?.channels?.cache?.get?.(id)?.name ?? null,
      });
    },
    /**
     * Republica (item 9 v2, entrega E parte 2) o diário, o semanal ou a notícia MAIS RECENTES num servidor, com `{ tipo, guildId, confirm: true }`. Sempre no
     * canal daquele tipo configurado no servidor (o mesmo do agendador; o painel nunca escolhe nem digita um canal) e pelas MESMAS funções de publicação do
     * agendador (src/discord/gtaPainel.js: republicarGtaNoBot -> src/discord/publisher.js). Roda no processo do bot (o único ou o bot separado, pedido pelo
     * cérebro por panel.admin). Uma republicação do mesmo tipo no mesmo servidor a cada 10 minutos. A auditoria guarda só o tipo, o servidor e se saiu.
     */
    async republicarGta(ctx, body = {}) {
      requireOwner(ctx);
      const tipo = String(body?.tipo ?? '');
      if (!TIPOS_DA_REPUBLICACAO.includes(tipo)) throw new AdminError(400, `Tipo inválido. Use: ${TIPOS_DA_REPUBLICACAO.join(', ')}.`);
      const id = requireId(body?.guildId, 'ID do servidor');
      requireConfirm(body, 'republicar no Discord');
      const s = await srv();
      if (typeof s.republicarGta !== 'function') throw new AdminError(503, SERVIDOR_FORA);
      findGuild(id);
      const chave = `${tipo}:${id}`;
      const agora = agoraMs();
      const ultima = republicacoes.get(chave);
      if (ultima !== undefined && agora - ultima < LIMITE_DA_REPUBLICACAO.janelaMs) {
        const min = Math.max(1, Math.ceil((LIMITE_DA_REPUBLICACAO.janelaMs - (agora - ultima)) / 60_000));
        // começa com "Muito": o app mostra a frase do servidor no 429 só quando ela começa assim (src/api/client.ts: messageForStatus)
        throw new AdminError(429, `Muito cedo para republicar: isso saiu nesse servidor há pouco. Espere ${min} min.`);
      }
      republicacoes.set(chave, agora); // marca antes de publicar: dois cliques seguidos não publicam duas vezes
      let r;
      try {
        r = await s.republicarGta(tipo, id, client);
      } catch {
        r = { situacao: 'falhou' };
      }
      if (r?.situacao !== 'ok') republicacoes.delete(chave);
      if (r?.situacao === 'sem-canal') throw new AdminError(409, `Esse servidor não tem canal ${NOME_DO_TIPO[tipo]} configurado (escolha em Servidores > Canais).`);
      if (r?.situacao === 'sem-conteudo') throw new AdminError(404, 'Ainda não há nada salvo desse tipo para republicar.');
      if (r?.situacao === 'e-o-semanal') throw new AdminError(409, 'Essa notícia é o próprio evento semanal (ela sai pelo semanal): republique o semanal.');
      audit('admin.gta.republicar', ctx, { tipo, guild: id, ok: r?.situacao === 'ok' });
      if (r?.situacao !== 'ok') throw new AdminError(502, 'Não consegui publicar no Discord (confira se a Yui pode escrever no canal configurado).');
      return { ok: true, tipo, guildId: id, canalId: /^\d{15,25}$/.test(String(r.canalId ?? '')) ? String(r.canalId) : null };
    },
    /** As listas pessoais do DONO da sessão (item 12, só leitura): o arquivo é escolhido pelo id da sessão, nunca por um parâmetro do pedido. */
    async listas(ctx) {
      requireOwner(ctx);
      let r;
      try { r = await ler().listas(String(ctx.userId ?? '')); } catch { r = { situacao: 'ilegivel', listas: [] }; }
      return vistaDasListas(r, { ligado: r?.ligado !== false });
    },
    /** As skills instaladas e quais estão permitidas (item 12, só leitura; ligar e desligar cada uma fica para uma v2). */
    async skills(ctx) {
      requireOwner(ctx);
      return vistaDasSkills(await ler().skills());
    },
    /**
     * Continuidade (item 12): os projetos e as decisões registrados na memória pessoal do dono. Mora com a memória (o cérebro, com os dois processos).
     * Com a memória desligada nada é lido (`memoria: false`).
     */
    async continuidade(ctx) {
      requireOwner(ctx);
      if (!podeContinuidade(ctx)) throw new AdminError(403, 'Só na memória pessoal do dono.');
      const ligado = continuidadeLigada();
      if (!isMemoryEnabled()) return vistaDaContinuidade({ ligado, memoria: false, itens: [] });
      return vistaDaContinuidade({ ligado, memoria: true, itens: await listarContinuidade(ctx, deps?.memoria ?? memory) });
    },
    /** Apaga UM projeto ou UMA decisão (com `confirm: true`). Outra lembrança nunca sai por aqui (404). A auditoria guarda só o tipo, nunca o texto. */
    async removerContinuidade(ctx, id, body = {}) {
      requireOwner(ctx);
      if (!podeContinuidade(ctx)) throw new AdminError(403, 'Só na memória pessoal do dono.');
      const n = Number(id);
      if (!Number.isInteger(n) || n < 1) throw new AdminError(400, 'Número do item inválido.');
      requireConfirm(body, 'apagar um projeto ou uma decisão');
      if (!isMemoryEnabled()) throw new AdminError(503, 'A memória está desativada: não há o que apagar agora.');
      const r = await apagarDaContinuidade(ctx, deps?.memoria ?? memory, n);
      if (!r.apagado) throw new AdminError(404, 'Projeto ou decisão não encontrado (ou já apagado).');
      audit('admin.continuidade.remove', ctx, { tipo: r.tipo === 'project' ? 'projeto' : 'decisao' });
      return { ok: true };
    },

    // ── Lacunas do painel, entrega E (27/11/2026; itens 3 v2 e 4 v2): AÇÕES sobre o que roda no processo da API. SÓ O DONO, no routeGuard. Nenhuma regra nova:
    //    o painel chama a MESMA função do serviço que a DM e o chat do app chamam. Nada de argumentos, resultados, link nem texto do chat na resposta ou na auditoria. ──
    /**
     * Aprova ou recusa UM plano (item 3 v2; YUI_PLANOS_PAINEL, desligada = 404). Chama a MESMA decidir() dos botões da DM (src/core/planos/servico.js) com o
     * dono da sessão: plano dele, mesma versão, mesmo hash (prefixo de 16 ou mais), aguardando e dentro da validade. A primeira decisão gravada vale (a DM depois
     * responde "já foi respondido"). A auditoria é a da decidir() (plan.approved / plan.rejected com a origem "painel"). Devolve só ok, final e a frase dela.
     */
    /**
     * Correção C2: pede a chave de confirmação de UMA ação crítica do painel. Ela chega só pela DM do dono (6 dígitos, 5 minutos, uma vez, presa a esta
     * sessão, à ação e ao alvo); a resposta nunca a traz. Corpo: { acao: 'plano.aprovar', plano: { id, versao, hash } } ou { acao: 'google.reautorizar' }.
     */
    async pedirConfirmacao(ctx, body = {}) {
      requireOwner(ctx);
      const acao = String(body?.acao ?? '');
      if (!Object.hasOwn(ACOES_COM_CHAVE, acao)) throw new AdminError(400, 'Ação de confirmação desconhecida.');
      let alvo = 'google';
      let paraQue = 'reautorizar o Google pelo painel';
      if (acao === 'plano.aprovar') {
        const p = body?.plano && typeof body.plano === 'object' ? body.plano : {};
        const id = String(p.id ?? '');
        const versao = Number(p.versao);
        const hash = typeof p.hash === 'string' ? p.hash : '';
        if (!/^[0-9a-f]{6,32}$/.test(id) || !Number.isInteger(versao) || versao < 1 || versao > 1000 || !/^[0-9a-f]{16,128}$/.test(hash)) {
          throw new AdminError(400, 'Informe o plano (id, versão e hash) para pedir a chave.');
        }
        alvo = alvoDoPlano(id, versao, hash);
        paraQue = `aprovar o plano ${id.slice(0, 12)}${versao > 1 ? ` (versão ${versao})` : ''}`;
      } else if (processo === 'bot') {
        throw new AdminError(503, GOOGLE_FORA_DO_PROCESSO);
      }
      let emitida;
      try {
        emitida = chavesDeConfirmacao().emitir({ userId: String(ctx.userId ?? ''), sessao: sessaoDe(ctx), acao, alvo });
      } catch (e) {
        if (e instanceof ConfirmacaoError) throw new AdminError(e.status, e.message);
        throw e;
      }
      const minutos = Math.max(1, Math.round(emitida.expiraEmSegundos / 60));
      const texto = [
        '🔐 **Confirmação no painel da Yui**',
        '',
        `\`${emitida.codigo}\``,
        '',
        `Serve só para: **${paraQue}**.`,
        `Digite no painel. Vale por **${minutos} minutos** e só pode ser usada **uma vez**.`,
        'Se não foi você que pediu, não digite em lugar nenhum e troque a senha do painel.',
      ].join('\n');
      let saiu = false;
      try { saiu = (await dmAoDono(texto)) === true; } catch { saiu = false; }
      if (!saiu) {
        emitida.revogar(); // não deixa uma chave que o dono nunca recebeu
        audit('admin.confirmacao.falhou', ctx, { acao });
        throw new AdminError(502, 'Não consegui mandar a chave pela DM. Confira se a Yui pode te mandar mensagem privada e tente de novo.');
      }
      audit('admin.confirmacao.pedida', ctx, { acao });
      return { ok: true, acao, expiraEmSegundos: emitida.expiraEmSegundos };
    },

    async decidirPlano(ctx, id, body = {}) {
      requireOwner(ctx);
      if (!planosPeloPainel()) throw new AdminError(404, 'Aprovar planos pelo painel está desligado ("Aprovar e recusar planos pelo painel" em Configuração e chaves).');
      const planoId = String(id ?? '');
      if (!/^[0-9a-f]{6,32}$/.test(planoId)) throw new AdminError(400, 'Plano inválido.');
      const versao = Number(body?.versao);
      if (!Number.isInteger(versao) || versao < 1 || versao > 1000) throw new AdminError(400, 'Informe a versão do plano.');
      const hash = typeof body?.hash === 'string' ? body.hash : '';
      if (!/^[0-9a-f]{16,128}$/.test(hash)) throw new AdminError(400, 'Informe o hash do plano (16 caracteres ou mais).');
      if (typeof body?.aprovar !== 'boolean') throw new AdminError(400, 'Informe aprovar: true ou false.');
      // o limite conta só o pedido que chegaria à decidir() (o corpo fora do formato já parou acima)
      if (passouDoLimite(decisoesRecentes, LIMITE_DAS_DECISOES)) throw new AdminError(429, 'Muitas decisões seguidas. Espere um minuto e tente de novo.');
      // Correção C2: APROVAR pelo painel pede a chave de confirmação pela DM, presa a este plano (id, versão e hash). Recusar não pede.
      if (body.aprovar === true) await exigirChave(ctx, 'plano.aprovar', alvoDoPlano(planoId, versao, hash), body?.confirmacao);
      const servico = await servicoDosPlanos();
      if (typeof servico?.decidir !== 'function') {
        throw planosLigados() ? new AdminError(503, 'Os planos estão indisponíveis agora (o serviço não subiu neste processo).') : new AdminError(409, 'Os planos estão desligados.');
      }
      const r = await servico.decidir({ userId: String(ctx.userId ?? ''), id: planoId, versao, hash, aprovar: body.aprovar, origem: 'painel' });
      // Correção C1: plano que manda texto da pessoa para fora só se aprova pela DM (o serviço decide; o painel recebe 409 e o plano segue aguardando).
      if (r?.codigo === 'so-pela-dm') throw new AdminError(409, linhaCurta(r.text, 200));
      return { ok: r?.ok === true, final: r?.final !== false, texto: linhaCurta(r?.text, 200) || 'Não consegui decidir agora.' };
    },
    /**
     * Entra numa live do YouTube (item 4 v2; YUI_YOUTUBE_LIVE, desligada = 404). Monta o MESMO comando da conversa ("entra na live <link> [por N horas]") e o
     * passa ao MESMO rotear() do serviço, pelo canal do app: as mesmas validações do link, o mesmo ritmo pela duração, a mesma autorização do canal da Yui e os
     * mesmos limites de cota. Devolve a frase do serviço e se ela entrou. A auditoria leva só as horas e o resultado (nunca o link).
     */
    async entrarNaLive(ctx, body = {}) {
      requireOwner(ctx);
      const { youtubeLigado } = await import('../../adaptadores/youtube/adaptador.js');
      if (!youtubeLigado()) throw new AdminError(404, LIVE_DESLIGADA);
      const endereco = typeof body?.endereco === 'string' ? body.endereco.trim() : '';
      if (!endereco || endereco.length > 300 || /[\s<>\u0000-\u001f\u007f-\u009f]/.test(endereco)) throw new AdminError(400, LINK_DA_LIVE_INVALIDO);
      let horas = null;
      if (body?.horas !== undefined && body?.horas !== null && body?.horas !== '') {
        horas = Number(body.horas);
        if (!Number.isInteger(horas) || horas < 1 || horas > 99) throw new AdminError(400, 'A duração vai em horas inteiras, de 1 a 99 (ou deixe em branco).');
      }
      const { pedidoDeLive } = await import('../../adaptadores/youtube/pedido.js');
      const texto = `entra na live ${endereco}${horas ? ` por ${horas} horas` : ''}`;
      const pedido = pedidoDeLive(texto);
      if (pedido?.tipo !== 'entrar' || (pedido.horas ?? null) !== horas) throw new AdminError(400, LINK_DA_LIVE_INVALIDO);
      // o limite conta só o pedido que chegaria ao serviço (o link fora do formato já parou acima)
      if (passouDoLimite(entradasRecentes, LIMITE_DAS_ENTRADAS)) throw new AdminError(429, 'Muitos pedidos de entrar seguidos. Espere um minuto e tente de novo.');
      const servico = await servicoDaLive();
      const antes = retratoDaLive(servico);
      const r = await servico.rotear({ userId: String(ctx.userId ?? ''), texto, canal: 'app' });
      if (r?.handled !== true) throw new AdminError(503, 'A live está indisponível agora.');
      const depois = retratoDaLive(servico);
      const ok = depois.ativo && depois.desde !== null && depois.desde !== antes.desde;
      audit('admin.live.enter', ctx, { origem: 'painel', ...(horas ? { horas } : {}), ok });
      return { ok, texto: linhaCurta(r.text, 600) };
    },
    /** Sai da live (item 4 v2): o MESMO "sai da live" da conversa, pelo canal do app. Sem limite de repetição (a parada tem de funcionar sempre). */
    async sairDaLive(ctx) {
      requireOwner(ctx);
      const { youtubeLigado } = await import('../../adaptadores/youtube/adaptador.js');
      if (!youtubeLigado()) throw new AdminError(404, LIVE_DESLIGADA);
      const servico = await servicoDaLive();
      const antes = retratoDaLive(servico);
      const r = await servico.rotear({ userId: String(ctx.userId ?? ''), texto: 'sai da live', canal: 'app' });
      if (r?.handled !== true) throw new AdminError(503, 'A live está indisponível agora.');
      const ok = antes.ativo && !retratoDaLive(servico).ativo;
      audit('admin.live.leave', ctx, { origem: 'painel', ok });
      return { ok, texto: linhaCurta(r.text, 300) };
    },

    // ── Lacunas do painel, entrega F, parte 2 (27/11/2026; item 14; docs/DESENHO_PAINEL_APROVACAO_E_GOOGLE.md seção 2): REAUTORIZAR O GOOGLE pelo painel, com
    //    YUI_GOOGLE_REAUTORIZAR_PAINEL (desligada = 404). SÓ O DONO, no routeGuard (admin.google_reauth) e fora do PANEL_ACTIONS: o Google vive no processo da API.
    //    A resposta e a auditoria nunca levam token, client_secret, código, verificador, `state` (fora do link) nem corpo de resposta do Google: só códigos fixos. ──
    /**
     * Começa uma reautorização: só com um arquivo de autorização que já existe (a primeira vez continua pelo script). Devolve SÓ o link de consentimento (Agenda e
     * Tarefas, somente leitura; nunca o Gmail), até quando ele vale (10 min) e se o Gmail do arquivo atual fica para o script. 5 inícios por hora (429).
     */
    async googleReautorizarInicio(ctx, body = {}) {
      const { r: reaut, textos } = await exigirReautorizacaoLigada(ctx);
      // Correção C2: começar a reautorização (que vai gravar credencial) pede a chave de confirmação pela DM.
      await exigirChave(ctx, 'google.reautorizar', 'google', body?.confirmacao);
      const r = reaut.iniciar({ userId: String(ctx.userId ?? '') });
      if (!r.ok) {
        audit('google.reauth.fail', ctx, { etapa: 'inicio', codigo: r.codigo });
        // começa com "Muitas": o app mostra a frase do servidor no 429 só quando ela começa assim (src/api/client.ts: messageForStatus)
        if (r.codigo === 'limite') throw new AdminError(429, textos.limite);
        return { ok: false, codigo: r.codigo, texto: textos[r.codigo] ?? textos.erro };
      }
      audit('google.reauth.start', ctx, { gmailFicaNoScript: r.gmailFicaNoScript === true });
      return { ok: true, link: r.link, expiraEm: r.expiraEm, gmailFicaNoScript: r.gmailFicaNoScript === true };
    },
    /**
     * Conclui com o endereço colado (`{ endereco }`, o da página 127.0.0.1 que não abriu). A sessão é apagada na primeira tentativa, certa ou errada. Devolve só
     * "autorizado" com a nova validade (7 dias em modo Testando) e o que o Google não concedeu, ou um código fixo de falha com a frase dele.
     */
    async googleReautorizarRetorno(ctx, body = {}) {
      const { r: reaut, textos } = await exigirReautorizacaoLigada(ctx);
      let r;
      try {
        r = await reaut.concluir({ userId: String(ctx.userId ?? ''), endereco: body?.endereco });
      } catch {
        r = { ok: false, codigo: 'erro' };
      }
      if (!r?.ok) {
        const codigo = typeof r?.codigo === 'string' && Object.hasOwn(textos, r.codigo) ? r.codigo : 'erro';
        audit('google.reauth.fail', ctx, { etapa: 'retorno', codigo });
        return { ok: false, codigo, texto: textos[codigo] };
      }
      audit('google.reauth.ok', ctx, { faltam: r.faltam.length ? r.faltam.join(',') : null, gmailFicaNoScript: r.gmailFicaNoScript === true });
      return { ok: true, codigo: 'autorizado', venceEm: r.venceEm, escopos: r.escopos, faltam: r.faltam, gmailFicaNoScript: r.gmailFicaNoScript === true };
    },

    /** Detalhes de um servidor: canais, avisos de YouTube/Twitch e ferramentas liberadas. */
    async guildDetail(ctx, guildId) {
      requireOwner(ctx);
      const id = requireId(guildId, 'ID do servidor');
      const guild = guildList().find((g) => g.id === id);
      if (!guild) throw new AdminError(404, 'A Yui não está nesse servidor.');
      return deps?.guildDetail ? deps.guildDetail(guild) : loadGuildDetail(guild);
    },

    // ── Ferramentas por servidor (as mesmas do /yui-ferramentas) ──
    async guildTools(ctx, guildId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      return { guildId: guild.id, ferramentas: (await srv()).ferramentas(guild.id) };
    },

    async setGuildTool(ctx, guildId, nome, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const ligada = requireBool(body?.ligada, 'ligada');
      const s = await srv();
      // Lista fechada: só o que o /yui-ferramentas alterna.
      if (!s.ferramentas(guild.id).some((f) => f.nome === nome)) throw new AdminError(404, 'Ferramenta desconhecida ou que não pode ser alterada.');
      requireConfirm(body, 'mudar uma ferramenta do servidor');
      exigirGravacao(s.definirFerramenta(guild.id, nome, ligada));
      audit('admin.guild.tool', ctx, { guild: guild.id, tool: nome, enabled: ligada });
      return { ok: true, ferramentas: s.ferramentas(guild.id) };
    },

    async resetGuildTools(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      requireConfirm(body, 'restaurar as ferramentas do servidor');
      const s = await srv();
      exigirGravacao(s.restaurarFerramentas(guild.id));
      audit('admin.guild.tools.reset', ctx, { guild: guild.id });
      return { ok: true, ferramentas: s.ferramentas(guild.id) };
    },

    // ── Termos de Uso ──
    async tosTerms(ctx) {
      requireOwner(ctx);
      return { paginas: (await srv()).paginasDosTermos() };
    },

    async guildTos(ctx, guildId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      return { guildId: guild.id, donoDoServidor: guild.ownerId === ctx.userId, ...(await srv()).estadoDosTermos(guild.id) };
    },

    /** Aceite pelo painel: fica registrado com origem 'painel'. Já registrado = não regrava nem manda o aviso de novo. */
    async acceptGuildTos(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      requireConfirm(body, 'aceitar os Termos de Uso por este servidor');
      const s = await srv();
      const estado = () => ({ guildId: guild.id, donoDoServidor: guild.ownerId === ctx.userId, ...s.estadoDosTermos(guild.id) });
      if (s.estadoDosTermos(guild.id).aceitoEm) return { ok: true, jaAceito: true, canalAtualizacoes: s.opcoes(guild.id)?.updateChannelId ?? null, avisoEnviado: false, estado: estado() };
      // Servidor de terceiros: além do confirm, quem chama precisa reconhecer que aceita em nome de outra pessoa.
      if (guild.ownerId !== ctx.userId && body.emNomeDeTerceiros !== true) throw new AdminError(400, 'Você não é o dono deste servidor: confirme que aceita em nome de terceiros (emNomeDeTerceiros: true).');
      const r = await s.aceitarTermos(guild, ctx.userId);
      audit('admin.guild.tos.accept', ctx, { guild: guild.id, donoDoServidor: guild.ownerId === ctx.userId });
      return { ok: true, jaAceito: false, canalAtualizacoes: r.canalId, avisoEnviado: r.avisado, estado: estado() };
    },

    async revokeGuildTos(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      requireConfirm(body, 'revogar o aceite dos Termos de Uso');
      const s = await srv();
      s.revogarTermos(guild.id);
      audit('admin.guild.tos.revoke', ctx, { guild: guild.id });
      return { ok: true, estado: { guildId: guild.id, donoDoServidor: guild.ownerId === ctx.userId, ...s.estadoDosTermos(guild.id) } };
    },

    // ── Persona e falas espontâneas por canal (as mesmas estruturas do /yui-servidor) ──
    async channelConfig(ctx, guildId, channelId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const id = requireTextChannel(guild, channelId);
      const s = await srv();
      return canalView(guild.channels.cache.get(id), s.canal(id), s.limites);
    },

    async setPersona(ctx, guildId, channelId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const id = requireTextChannel(guild, channelId);
      const s = await srv();
      const instruction = textoDaPersona(body?.instrucao, 'instrucao', s.limites.instrucao, { multilinha: true });
      const mood = textoDaPersona(body?.humor, 'humor', s.limites.humor);
      if (instruction === undefined && mood === undefined) throw new AdminError(400, 'Informe instrucao e/ou humor.');
      requireConfirm(body, 'mudar a personalidade do canal');
      exigirGravacao(s.definirPersona(id, { instruction, mood }));
      // Auditoria sem conteúdo: só quais campos mudaram.
      audit('admin.guild.persona', ctx, { guild: guild.id, channel: id, campos: [instruction !== undefined ? 'instrucao' : null, mood !== undefined ? 'humor' : null].filter(Boolean).join(',') });
      return { ok: true, ...canalView(guild.channels.cache.get(id), s.canal(id), s.limites) };
    },

    async resetPersona(ctx, guildId, channelId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const id = requireTextChannel(guild, channelId);
      requireConfirm(body, 'restaurar a personalidade do canal');
      const s = await srv();
      exigirGravacao(s.definirPersona(id, { reset: true }));
      audit('admin.guild.persona.reset', ctx, { guild: guild.id, channel: id });
      return { ok: true, ...canalView(guild.channels.cache.get(id), s.canal(id), s.limites) };
    },

    async setChatter(ctx, guildId, channelId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const id = requireTextChannel(guild, channelId);
      const has = (v) => v !== undefined && v !== null;
      const { ativo, frequencia, porcentagem } = body ?? {};
      if (!has(ativo) && !has(frequencia) && !has(porcentagem)) throw new AdminError(400, 'Informe ativo, frequencia e/ou porcentagem.');
      if (has(ativo)) requireBool(ativo, 'ativo');
      if (has(frequencia) && has(porcentagem)) throw new AdminError(400, 'Use frequencia OU porcentagem, não as duas.');
      if (has(frequencia) && !FREQUENCIAS.includes(frequencia)) throw new AdminError(400, `Frequência inválida. Use: ${FREQUENCIAS.join(', ')}.`);
      if (has(porcentagem) && !(Number.isInteger(porcentagem) && porcentagem >= 0 && porcentagem <= 100)) throw new AdminError(400, 'Porcentagem inválida (número inteiro de 0 a 100).');
      requireConfirm(body, 'mudar as falas espontâneas do canal');
      const s = await srv();
      exigirGravacao(s.definirEspontaneo(id, { active: has(ativo) ? ativo : undefined, frequency: has(frequencia) ? frequencia : undefined, percentage: has(porcentagem) ? porcentagem : undefined }));
      audit('admin.guild.chatter', ctx, { guild: guild.id, channel: id, ativo: ativo ?? null, frequencia: frequencia ?? null, porcentagem: porcentagem ?? null });
      return { ok: true, ...canalView(guild.channels.cache.get(id), s.canal(id), s.limites) };
    },

    /** Responder a @everyone/@here. */
    async setMentions(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const ligado = requireBool(body?.respondToEveryone, 'respondToEveryone');
      requireConfirm(body, 'mudar a resposta a @everyone/@here');
      exigirGravacao((await srv()).definirMencoes(guild.id, ligado));
      audit('admin.guild.mentions', ctx, { guild: guild.id, respondToEveryone: ligado });
      return { ok: true, respondToEveryone: ligado };
    },

    // ── Canais do servidor e avisos de YouTube/Twitch ──
    async setGuildChannel(ctx, guildId, type, channelId, confirm) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      // 'atualizacoes' (o canal_updates do /yui-servidor) mora no server_settings.json; os outros, no banco do bot.
      const column = Object.hasOwn(CHANNEL_COLUMNS, type) ? CHANNEL_COLUMNS[type] : null;
      if (!column && type !== 'atualizacoes') throw new AdminError(400, `Tipo de canal inválido. Use: ${[...Object.keys(CHANNEL_COLUMNS), 'atualizacoes'].join(', ')}.`);
      const target = channelId === null || channelId === '' || channelId === undefined ? null : requireTextChannel(guild, channelId);
      if (type === 'atualizacoes') requireConfirm({ confirm }, 'mudar o canal de avisos do servidor');
      if (column) {
        const dep = await d();
        await (dep.setGuildChannel ?? defaultSetGuildChannel)(guild.id, column, target);
      } else {
        exigirGravacao((await srv()).definirCanalDeUpdates(guild.id, target));
      }
      audit('admin.guild.channel', ctx, { guild: guild.id, type, channel: target });
      return { ok: true };
    },

    async addYoutubeFollow(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const discordChannelId = requireTextChannel(guild, body.discordChannelId);
      const input = String(body.channel ?? '').trim();
      if (!input || input.length > 200) throw new AdminError(400, 'Informe o canal do YouTube (@handle, ID UC... ou URL).');
      const roleId = body.roleId ? requireId(body.roleId, 'ID do cargo') : null;
      const dep = await d();
      const result = await (dep.addYoutube ?? defaultAddYoutube)({
        guildId: guild.id, input, discordChannelId, roleId,
        videos: body.videos !== false, shorts: body.shorts !== false, lives: body.lives !== false,
        liveMode: body.liveMode === undefined ? 'auto' : requireLiveMode(body.liveMode),
      });
      audit('admin.follow.youtube.add', ctx, { guild: guild.id, youtube: result.channelId, channel: discordChannelId });
      return { ok: true, added: result.added, name: result.name };
    },

    /** Muda como os avisos de live saem em UMA inscrição ('auto' | 'new' | 'edit'). */
    async setYoutubeLiveMode(ctx, guildId, youtubeChannelId, discordChannelId, liveMode) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      if (!/^[\w-]{3,80}$/.test(String(youtubeChannelId))) throw new AdminError(400, 'ID do canal do YouTube inválido.');
      const mode = requireLiveMode(liveMode);
      const dep = await d();
      const updated = await (dep.setYoutubeLiveMode ?? defaultSetYoutubeLiveMode)(guild.id, youtubeChannelId, requireId(discordChannelId, 'ID do canal'), mode);
      audit('admin.follow.youtube.liveMode', ctx, { guild: guild.id, youtube: youtubeChannelId, mode });
      return { ok: true, updated, liveMode: mode };
    },

    async removeYoutubeFollow(ctx, guildId, youtubeChannelId, discordChannelId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      if (!/^[\w-]{3,80}$/.test(String(youtubeChannelId))) throw new AdminError(400, 'ID do canal do YouTube inválido.');
      const dep = await d();
      const removed = await (dep.removeYoutube ?? defaultRemoveYoutube)(guild.id, youtubeChannelId, requireId(discordChannelId, 'ID do canal'));
      audit('admin.follow.youtube.remove', ctx, { guild: guild.id, youtube: youtubeChannelId });
      return { ok: true, removed };
    },

    async addTwitchFollow(ctx, guildId, body = {}) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      const discordChannelId = requireTextChannel(guild, body.discordChannelId);
      let input = String(body.streamer ?? '').trim();
      const fromUrl = input.match(/twitch\.tv\/([a-zA-Z0-9_]+)/);
      if (fromUrl) input = fromUrl[1];
      const login = input.toLowerCase().replace(/^@/, '');
      if (!/^[a-z0-9_]{3,25}$/.test(login)) throw new AdminError(400, 'Login da Twitch inválido (3 a 25 letras, números ou _).');
      const roleId = body.roleId ? requireId(body.roleId, 'ID do cargo') : null;
      const dep = await d();
      const result = await (dep.addTwitch ?? defaultAddTwitch)({ guildId: guild.id, login, discordChannelId, roleId });
      audit('admin.follow.twitch.add', ctx, { guild: guild.id, twitch: result.login, channel: discordChannelId });
      return { ok: true, added: result.added, name: result.name };
    },

    async removeTwitchFollow(ctx, guildId, login, discordChannelId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      if (!/^[a-zA-Z0-9_]{3,25}$/.test(String(login))) throw new AdminError(400, 'Login da Twitch inválido.');
      const dep = await d();
      const removed = await (dep.removeTwitch ?? defaultRemoveTwitch)(guild.id, String(login).toLowerCase(), requireId(discordChannelId, 'ID do canal'));
      audit('admin.follow.twitch.remove', ctx, { guild: guild.id, twitch: String(login).toLowerCase() });
      return { ok: true, removed };
    },

    // ── Provedores de IA: chaves e provedores próprios (as chaves só entram, nunca saem) ──
    // Configuração e chaves pelo painel (cofre secrets/painel-config.json, lista fechada em src/core/painelConfig.js): só o dono; segredo só ENTRA (nenhuma resposta o devolve);
    // a auditoria leva só o NOME do ajuste, nunca o valor.
    async config(ctx) {
      requireOwner(ctx);
      return descreverConfig();
    },
    // `versao`: a que a tela viu (correção C5 do parecer da Liz). Se o Discord ou outra aba gravou no meio, o cofre recusa com 409 e nada é sobrescrito.
    async configSet(ctx, chave, valor, confirm, versao) {
      requireOwner(ctx);
      if (exigeConfirmacao(chave, valor ?? '')) requireConfirm({ confirm }, 'afrouxar um ajuste de privacidade ou segurança');
      try {
        const r = definirConfig(chave, valor, process.env, { versao });
        audit('admin.config.set', ctx, { chave: r.chave });
        return { ok: true, ...r };
      } catch (e) {
        if (e instanceof PainelConfigError) throw new AdminError(e.status, e.message);
        throw e;
      }
    },
    async configRemove(ctx, chave, confirm, versao) {
      requireOwner(ctx);
      if (exigeConfirmacao(chave)) requireConfirm({ confirm }, 'remover um ajuste de privacidade ou segurança');
      try {
        const r = removerConfig(chave, process.env, { versao });
        audit('admin.config.remove', ctx, { chave: r.chave });
        return { ok: true, ...r };
      } catch (e) {
        if (e instanceof PainelConfigError) throw new AdminError(e.status, e.message);
        throw e;
      }
    },

    async ai(ctx) {
      requireOwner(ctx);
      const { getGateway } = await import('../../gateway/index.js');
      return describeAi({ gateway: getGateway().status() });
    },

    async aiAddKey(ctx, providerId, key) {
      return aiChange(ctx, 'admin.ai.key.add', { provider: String(providerId) }, () => addKey(String(providerId), key));
    },
    async aiRemoveKey(ctx, providerId, index) {
      return aiChange(ctx, 'admin.ai.key.remove', { provider: String(providerId) }, () => removeKey(String(providerId), index));
    },
    async aiCloudflare(ctx, accountId) {
      return aiChange(ctx, 'admin.ai.cloudflare', {}, () => setCloudflareAccount(accountId));
    },
    async aiSetEnabled(ctx, providerId, enabled) {
      if (typeof enabled !== 'boolean') throw new AdminError(400, 'Informe enabled: true ou false.');
      return aiChange(ctx, 'admin.ai.enabled', { provider: String(providerId), enabled }, () => setEnabled(String(providerId), enabled));
    },
    async aiAddCustom(ctx, body = {}) {
      return aiChange(ctx, 'admin.ai.custom.add', { id: String(body.id ?? '') }, () => addCustom(body));
    },
    async aiAddCustomKey(ctx, id, key) {
      return aiChange(ctx, 'admin.ai.custom.key', { id: String(id) }, () => addCustomKey(String(id), key));
    },
    async aiCustomOptions(ctx, id, body = {}) {
      return aiChange(ctx, 'admin.ai.custom.options', { id: String(id), first: body.first, anonymous: body.anonymous, models: body.models !== undefined }, () => setCustomOptions(String(id), { first: body.first, anonymous: body.anonymous, models: body.models }));
    },
    async aiRemoveCustom(ctx, id) {
      return aiChange(ctx, 'admin.ai.custom.remove', { id: String(id) }, () => removeCustom(String(id)));
    },

    /** Faz uma pergunta mínima ao provedor para conferir se a chave/endereço funcionam. */
    async aiTest(ctx, providerId) {
      requireOwner(ctx);
      const id = String(providerId);
      if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(id)) throw new AdminError(400, 'Provedor inválido.');
      const t0 = Date.now();
      try {
        const chat = deps?.aiChat ?? (async (model) => (await import('../../gateway/index.js')).getGateway().chat(
          { model, messages: [{ role: 'user', content: 'Responda somente: ok' }], max_tokens: 400 }, { sensitive: false }));
        const res = await chat(id);
        audit('admin.ai.test', ctx, { provider: id, ok: true });
        return { ok: true, ms: Date.now() - t0, via: res?.x_gateway?.model ?? null };
      } catch (e) {
        audit('admin.ai.test', ctx, { provider: id, ok: false });
        return { ok: false, ms: Date.now() - t0, error: await explainAiFailure(e, id, deps) };
      }
    },

    // ── Modo Rádio (sessões) e logs ──
    async radio(ctx) {
      requireOwner(ctx);
      const r = await radioDeps();
      const guildOf = (id) => guildList().find((g) => g.id === id);
      const sessions = await listRadio(r, (id) => guildOf(id)?.name ?? null, (id, voiceId) => guildOf(id)?.channels?.cache?.get?.(voiceId)?.name ?? null);
      return { sessions };
    },

    /**
     * Uma ação no rádio de um servidor. `pause`, `resume`, `stop` e `leave` (as de sempre) e, do item 10: `start` ({ voiceChannelId, textChannelId }: liga
     * o rádio sem ninguém na call), `skip` (próxima faixa), `play` ({ query }: gênero, música ou link) e `choose` ({ opcao }: o número de uma das opções de
     * uma busca ambígua). A auditoria guarda só a ação e o servidor, NUNCA a busca digitada nem a faixa.
     */
    async radioAction(ctx, guildId, action, body = {}) {
      requireOwner(ctx);
      const id = requireId(guildId, 'ID do servidor');
      if (!RADIO_ACTIONS.includes(action)) throw new AdminError(400, `Ação inválida. Use: ${RADIO_ACTIONS.join(', ')}.`);
      const b = body && typeof body === 'object' ? body : {};
      const r = await radioDeps();
      if (action === 'start') return iniciarRadio(ctx, id, b, r);
      if (!r.getSession(id)) throw new AdminError(404, 'Não há sessão de rádio nesse servidor.');
      if (action === 'play') {
        const busca = buscaDoRadio(b.query);
        if (!busca) throw new AdminError(400, 'Diga o gênero, a música ou o link (2 a 200 caracteres, numa linha só).');
        const out = await tocarNoRadio(ctx, id, r, busca);
        audit('admin.radio', ctx, { guild: id, action });
        return { ok: true, ...out };
      }
      if (action === 'choose') {
        const pendente = escolhasDoRadio.get(id);
        if (!pendente || pendente.ate <= agoraMs()) {
          escolhasDoRadio.delete(id);
          throw new AdminError(409, 'Não há opções esperando escolha nesse servidor (ou elas venceram). Busque de novo.');
        }
        const n = b.opcao;
        if (!Number.isInteger(n) || n < 0 || n >= pendente.opcoes.length) throw new AdminError(400, 'Opção inválida.');
        escolhasDoRadio.delete(id);
        const out = respostaDaFila(await r.enqueue(id, { type: 'track', track: pendente.opcoes[n] }, String(ctx.userId ?? ''), client));
        audit('admin.radio', ctx, { guild: id, action });
        return { ok: true, ...out };
      }
      if (action === 'skip') {
        const proxima = await r.skip(id, client);
        audit('admin.radio', ctx, { guild: id, action });
        return proxima ? { ok: true, resultado: 'tocando', faixa: faixaCurta(proxima) } : { ok: true, resultado: 'fim-da-fila' };
      }
      let ok = true;
      if (action === 'pause') ok = await r.pause(id);
      else if (action === 'resume') ok = await r.resume(id);
      else if (action === 'stop') await r.stopMusic(id);
      else await r.leave(id);
      if (ok === false) throw new AdminError(409, 'Não há nada tocando agora.');
      if (action === 'stop' || action === 'leave') escolhasDoRadio.delete(id);
      audit('admin.radio', ctx, { guild: id, action });
      return { ok: true };
    },

    /**
     * Os canais de um servidor para iniciar o rádio (item 10; só leitura, fora do routeGuard como as outras leituras): os de voz (nome, pessoas na call e se
     * a Yui pode entrar e falar) e os de texto (se ela pode escrever com embeds). Só canais deste servidor.
     */
    async radioCanais(ctx, guildId) {
      requireOwner(ctx);
      const guild = findGuild(guildId);
      return { guildId: guild.id, ...canaisDoRadio(guild) };
    },

    /** Últimas linhas dos logs (segredos mascarados). Só leitura. */
    async logs(ctx, query = {}) {
      requireOwner(ctx);
      const res = readLogs({
        dir: deps?.logDir ?? process.env.YUI_LOG_DIR ?? path.resolve('logs'),
        kind: query.kind || 'app',
        date: query.date || null,
        level: query.level || null,
        q: query.q || '',
        limit: query.limit,
      });
      if (res.error) throw new AdminError(400, res.error);
      return res;
    },

    /**
     * DIAGNÓSTICO (etapa 8): estado, provedor de IA, limites de tokens, cotas de busca, avisos de configuração e erros (src/core/diagnostico.js).
     * SÓ LEITURA e SÓ O DONO. Nada de conversa, pesquisa privada, id de pessoa ou servidor, segredo, caminho de arquivo ou texto de erro.
     * `deps.diagnostico` (fontes) e `deps.modoDiagnostico` só existem para teste e para o cérebro separado.
     */
    async diagnostico(ctx) {
      requireOwner(ctx);
      return montarDiagnostico({ modo: deps?.modoDiagnostico ?? 'unico', fontes: deps?.diagnostico ?? {} });
    },

    /**
     * PEDE a nova verificação da rota privada de IA (etapa 13; o perfil privado continua desligado até uma sonda válida). Só o dono, só com `confirm: true`,
     * auditada e com limite de repetição (3 pedidos a cada 10 minutos: a sonda é uma chamada paga). Só PEDE: nunca desbloqueia direto; uma rota bloqueada só
     * volta com uma sonda VÁLIDA (src/core/ai/rotaPerfil.js). A resposta tem só palavras fixas: o estado, o motivo e uma mensagem curta, nunca conteúdo.
     */
    async verificarRotaPrivada(ctx, confirm) {
      requireOwner(ctx);
      if (confirm !== true) throw new AdminError(400, 'Confirmação necessária para pedir a verificação da rota privada.');
      const r = await verificacaoDaRota()();
      if (r.limitado) {
        audit('admin.ia.rota_privada.recusado', ctx, { motivo: 'limite' });
        throw new AdminError(429, `Pedido repetido cedo demais: no máximo ${r.max} pedidos a cada ${r.janelaMin} minutos. Tente de novo em ${Math.max(1, Math.ceil(r.esperaSegundos / 60))} min.`);
      }
      audit('admin.ia.rota_privada.verificar', ctx, { estado: r.estado, motivo: r.motivo, sondaEnviada: r.sondaEnviada });
      return r;
    },

    /** Saúde do Yui Gateway: provedores, modelos, descansos e contadores (sem chaves). */
    async gateway(ctx) {
      requireOwner(ctx);
      const { getGateway } = await import('../../gateway/index.js');
      return getGateway().status();
    },

    /** Zera os "descansos" dos provedores (útil depois de resolver um problema de chave/crédito). */
    async gatewayReset(ctx) {
      requireOwner(ctx);
      const { getGateway } = await import('../../gateway/index.js');
      getGateway().reset();
      audit('admin.gateway.reset', ctx, {});
      return { ok: true };
    },

    /**
     * Reinicia a Yui. Exige o dono e a confirmação explícita (`confirm: true`); a auditoria `admin.restart` vale nos dois modos.
     *  - cérebro separado (`reinicio`): pede ao SUPERVISOR o reinício dos dois processos (bot e cérebro). Só o supervisor que abriu os processos os reinicia;
     *    se ele não aceita (sem supervisor, já em curso, sem resposta), NADA reinicia e o dono recebe o motivo verdadeiro;
     *  - processo único: o processo sai e a tarefa/o supervisor o religa em ~15 s (como sempre).
     */
    async restart(ctx, confirm) {
      requireOwner(ctx);
      if (confirm !== true) throw new AdminError(400, 'Confirmação necessária para reiniciar.');
      if (typeof reinicio === 'function') {
        let r;
        try { r = await reinicio({ motivo: 'pedido-do-dono' }); } catch { r = { aceito: false, motivo: 'erro' }; }
        if (r?.aceito !== true) {
          // O pedido do dono foi recusado: NADA reiniciou (a auditoria diz isso, sem se passar por um reinício).
          audit('admin.restart.recusado', ctx, { motivo: typeof r?.motivo === 'string' ? r.motivo.slice(0, 40) : 'desconhecido' });
          const recusa = RESTART_REFUSALS[r?.motivo] ?? RESTART_REFUSALS.padrao;
          throw new AdminError(recusa.status, recusa.texto);
        }
        // O supervisor aceitou e só para os processos depois de `reinicioAtrasoMs` (700 ms): a auditoria sai antes de qualquer parada.
        audit('admin.restart', ctx, { escopo: 'cerebro-e-bot' });
        return { ok: true, escopo: 'cerebro-e-bot', message: RESTART_MESSAGE_BOTH };
      }
      audit('admin.restart', ctx, {});
      setTimeout(exit, 700);
      return { ok: true, escopo: 'processo-unico', message: 'Reiniciando… volto em alguns segundos.' };
    },
  };
  return comFreioDeRepeticao(metodos, { agora: relogio });
}

/**
 * Correção C6 do parecer da Liz (docs/PLANO_LACUNAS_PAINEL_CORRECOES.md): as ações do painel que NÃO são idempotentes (repetir faz de novo: cria outro
 * lembrete, manda outra DM, reinicia de novo, pula outra faixa, chama o provedor de novo) ganham um freio contra o clique duplo: o MESMO pedido (mesma
 * pessoa, mesma ação, mesmos argumentos) enquanto o primeiro roda ou até FREIO_DE_REPETICAO_MS depois que ele deu certo é recusado com 429, e nada é feito
 * de novo. Um pedido diferente passa na hora; um pedido que FALHOU não segura o próximo (nada foi feito, então tentar de novo é seguro).
 * As outras ações de escrita já são idempotentes (gravar um valor, tirar algo que já saiu) ou já têm limite próprio (planos, live, GTA, Google, rota
 * privada, DM de teste); sair da live fica sem freio de propósito (a parada tem de funcionar sempre). A lista é conferida em tests/test-painel-escritas.js.
 * Só o resumo (hash) dos argumentos fica na memória, por FREIO_DE_REPETICAO_MS: nunca o conteúdo (uma chave de IA, por exemplo).
 */
// Fora de propósito (já são idempotentes ou recusam a duplicata com a mensagem própria): seguir canal (a segunda vez só diz que já segue), banir
// (o mesmo banimento de novo), cadastrar chave ou provedor de IA (a mesma chave ou o mesmo ID dá 409 "já está cadastrada").
export const ACOES_COM_FREIO = Object.freeze(['addReminder', 'snoozeReminder', 'morningSend', 'restart', 'aiTest', 'radioAction']);
/**
 * Ações em que só ALGUNS pedidos levam o freio. Rádio: só o tocar (a mesma busca de novo entraria duas vezes na fila). Pular duas faixas seguidas é de
 * propósito; iniciar de novo o rádio já recusa sozinho ("já estou em outro canal"); escolher vale uma vez; parar é idempotente.
 */
const FREIO_SO_QUANDO = Object.freeze({ radioAction: (_guildId, acao) => acao === 'play' });
export const FREIO_DE_REPETICAO_MS = 5_000;

/** Correção C2: o alvo da chave de aprovar um plano (o mesmo id, versão e prefixo de 16 do hash que a decisão manda). */
export const alvoDoPlano = (id, versao, hash) => `${String(id)}:${Number(versao)}:${String(hash).slice(0, 16)}`;
export const TEXTO_PEDIDO_REPETIDO = 'Muitos pedidos iguais seguidos: espere alguns segundos e confira se o primeiro já foi feito.';

function comFreioDeRepeticao(metodos, { agora = () => Date.now(), janelaMs = FREIO_DE_REPETICAO_MS } = {}) {
  const vistos = new Map(); // resumo do pedido -> quando
  for (const nome of ACOES_COM_FREIO) {
    const original = metodos[nome];
    if (typeof original !== 'function') continue;
    metodos[nome] = async function freado(ctx, ...args) {
      // Só o dono passa por estas ações: para os outros, o próprio método responde 403 (o freio nunca troca a recusa de permissão por um 429).
      if (ctx?.role !== ROLES.OWNER) return original.call(this, ctx, ...args);
      if (FREIO_SO_QUANDO[nome] && !FREIO_SO_QUANDO[nome](...args)) return original.call(this, ctx, ...args);
      const t = agora();
      for (const [k, quando] of vistos) if (t - quando >= janelaMs) vistos.delete(k);
      let resumo;
      try { resumo = crypto.createHash('sha256').update(JSON.stringify([nome, String(ctx?.userId ?? ''), args])).digest('hex'); } catch { resumo = null; }
      if (resumo && vistos.has(resumo)) {
        audit('admin.negado', ctx, { acao: nome, status: 429, motivo: 'repetido' });
        throw new AdminError(429, TEXTO_PEDIDO_REPETIDO);
      }
      // A marca vale enquanto o primeiro pedido roda (o clique duplo simultâneo também é barrado) e depois que ele DEU CERTO. Se ele falhou (recusa,
      // erro, Discord fora), a marca sai: corrigir o problema e tentar de novo funciona na hora, porque nada foi feito.
      if (resumo) vistos.set(resumo, t);
      try {
        return await original.call(this, ctx, ...args);
      } catch (err) {
        if (resumo) vistos.delete(resumo);
        throw err;
      }
    };
  }
  return metodos;
}

function safeIsPermanent() {
  try {
    return memory.isPermanent() === true;
  } catch {
    return false;
  }
}

function safeRetentionDays() {
  try {
    if (memory.isPermanent()) return null; // permanente: não existe prazo (retentionDays() cairia no 30 padrão)
    const n = Number(memory.retentionDays());
    return Number.isFinite(n) && n > 0 ? n : null;
  } catch {
    return null;
  }
}

function mem_count(ctx) {
  try {
    return memory.adminListUsers(ctx, { limit: 1 }).total;
  } catch {
    return null; // memória desativada/não inicializada
  }
}
