// ALERTAS POR EVENTO do cérebro (etapa 16, proatividade; docs/content_pt/MONITORES.md): verificações leves e periódicas que avisam o dono
// (o `alertOwner` de sempre: DM curta, com o intervalo de repetição e o limite por hora que ele já tem; nada novo para mais ninguém).
// Desligado por padrão: sem YUI_ALERTAS_EVENTOS=true, nada roda e nenhum timer nasce.
//
// As quatro verificações:
//  - DISCO: o espaço livre onde ficam os dados (DATABASE_DIR) abaixo de YUI_ALERTA_DISCO_GB (padrão 5 GB; 0 desliga);
//  - MEMÓRIA: a RAM livre abaixo de YUI_ALERTA_RAM_MB (padrão 400 MB; 0 desliga) POR vários minutos seguidos (YUI_ALERTA_RAM_MIN, padrão 5):
//    um pico curto não avisa;
//  - INTERNET: 3 sondas seguidas falhando contra o alvo YUI_ALERTA_INTERNET_ALVO (`host` ou `host:porta`, conexão TCP, sem enviar nada).
//    Padrão: DESLIGADA (sem alvo). Em teste (NODE_ENV=test) um alvo fora do computador NÃO é sondado (o bloqueio de integração externa dos
//    testes); quando a internet volta depois de um aviso, sai um segundo aviso curto ("voltou");
//  - SUPERVISOR: religadas do bot ou do cérebro (lê o logs/supervisor-estado.json em modo SÓ LEITURA; só contagens e o papel, nunca a saída do processo).
//    Um REINÍCIO CONTROLADO (o pedido do dono pelo app, ou a parada limpa pelo logs/supervisor.parar e a subida do atualizador) NÃO é queda: na primeira leitura só
//    vale o estado de um supervisor VIVO e deste cérebro (arquivo renovado há pouco, supervisor "rodando", o pid do cérebro é o deste processo) e uma saída que o
//    próprio reinício controlado causou não conta como religada.
// Cada tipo de evento tem o SEU intervalo de repetição (`COOLDOWN_EVENTOS_MIN`): a condição pode durar horas, e o aviso não repete a cada conferência (5 min) nem a cada
// 30 min (o intervalo geral do alertOwner). O intervalo vale no próprio verificador e vai também ao alertOwner (`cooldownMinutes`); recomeça se o cérebro reinicia.
// O aviso do supervisor não tem intervalo próprio: ele já é um fato novo a cada religada (a diferença das contagens), e o alertOwner o limita em 1 a cada 30 min.
// Chave: YUI_ALERTAS_EVENTOS_MS (padrão 5 min) = de quanto em quanto tempo olha. Tudo injetável para teste.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { alertOwner } from '../core/alerts.js';
import { jobAllowed } from '../core/security/jobGuard.js';
import { flag } from './monitores/config.js';

const RAIZ = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const GB = 1024 ** 3;
const MB = 1024 ** 2;
const MIN = 60_000;
export const SONDAS_SEGUIDAS = 3;
/** O intervalo mínimo (em minutos) entre dois avisos do MESMO tipo de evento. A volta da internet é um fato novo (um aviso curto, não repete a "fora"). */
export const COOLDOWN_EVENTOS_MIN = Object.freeze({ 'evento:disco': 720, 'evento:ram': 180, 'evento:internet': 120, 'evento:internet-voltou': 5 });
/** Quanto tempo o arquivo do supervisor pode ficar sem renovar (ele renova a cada 30 s) para ainda valer como "supervisor vivo". */
const SUPERVISOR_VIVO_MS = 3 * MIN;
/** A saída de um processo até este tempo depois do pedido de reinício controlado foi causada por ele (a parada limpa dos dois leva segundos). */
const REINICIO_CONTROLADO_JANELA_MS = 3 * MIN;

export function alertasPorEventoLigados(env = process.env) {
  return flag(env.YUI_ALERTAS_EVENTOS, false);
}

function numero(valor, padrao, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const bruto = String(valor ?? '').trim();
  const n = Number(bruto);
  return bruto !== '' && Number.isFinite(n) && n >= min ? Math.min(max, n) : padrao;
}

/** A configuração das verificações (cada limite, o intervalo e o alvo da internet). */
export function configDosEventos(env = process.env) {
  return {
    tickMs: Math.round(numero(env.YUI_ALERTAS_EVENTOS_MS, 5 * MIN, { min: 200, max: 24 * 60 * MIN })),
    discoGB: numero(env.YUI_ALERTA_DISCO_GB, 5),
    ramMB: numero(env.YUI_ALERTA_RAM_MB, 400),
    ramMin: numero(env.YUI_ALERTA_RAM_MIN, 5),
    internetAlvo: String(env.YUI_ALERTA_INTERNET_ALVO ?? '').trim(),
  };
}

/** `host` ou `host:porta` (padrão 443) -> { host, porta } ou null. */
export function lerAlvoDeInternet(alvo) {
  const m = /^([A-Za-z0-9][A-Za-z0-9.-]{0,252}):?(\d{1,5})?$/.exec(String(alvo ?? '').trim());
  if (!m) return null;
  const porta = m[2] ? Number(m[2]) : 443;
  return porta >= 1 && porta <= 65535 ? { host: m[1], porta } : null;
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1']);
/** Em NODE_ENV=test, só um alvo no próprio computador é sondado (nenhum teste acessa a internet de verdade). */
export function alvoBloqueadoEmTeste(alvo, env = process.env) {
  if (String(env.NODE_ENV ?? '').trim().toLowerCase() !== 'test') return false;
  const a = lerAlvoDeInternet(alvo);
  return !a || !LOOPBACK.has(a.host.toLowerCase());
}

/** A sonda padrão: conexão TCP com prazo. true = conectou; false = falhou; null = não sondou (alvo inválido ou bloqueado em teste). */
export function sondaTcp(alvo, { timeoutMs = 4000, env = process.env } = {}) {
  const a = lerAlvoDeInternet(alvo);
  if (!a || alvoBloqueadoEmTeste(alvo, env)) return Promise.resolve(null);
  return new Promise((resolve) => {
    let fim = false;
    const socket = net.connect({ host: a.host, port: a.porta });
    const acabar = (ok) => { if (fim) return; fim = true; try { socket.destroy(); } catch { /* */ } resolve(ok); };
    socket.setTimeout(timeoutMs, () => acabar(false));
    socket.once('connect', () => acabar(true));
    socket.once('error', () => acabar(false));
  });
}

/** O espaço livre (GB) no disco dos dados. null se não deu para ler. */
export function discoLivreGB(env = process.env) {
  try {
    const dir = env.DATABASE_DIR && fs.existsSync(env.DATABASE_DIR) ? env.DATABASE_DIR : process.cwd();
    const s = fs.statfsSync(dir);
    return (Number(s.bavail) * Number(s.bsize)) / GB;
  } catch {
    return null;
  }
}

export const ramLivreMB = () => os.freemem() / MB;

/** O estado do supervisor (só leitura). null se o arquivo não existe ou não presta. */
export function lerEstadoDoSupervisor(arquivo = path.join(RAIZ, 'logs', 'supervisor-estado.json')) {
  try {
    const e = JSON.parse(fs.readFileSync(arquivo, 'utf8'));
    return e && typeof e === 'object' && e.processos && typeof e.processos === 'object' ? e : null;
  } catch {
    return null;
  }
}

const NOME_DO_PROCESSO = { cerebro: 'o cérebro', bot: 'o bot' };
const fmt = (n, casas = 1) => Number(n).toFixed(casas).replace('.', ',');

/** O arquivo descreve um supervisor VIVO e ESTE cérebro? (renovado há pouco, em "rodando" e, se traz o pid do cérebro, é o deste processo; sem o campo, vale) */
function supervisorVivoDesteCerebro(e, c, t, pid = process.pid) {
  if (typeof e.estado === 'string' && e.estado !== 'rodando') return false;
  const atualizado = Date.parse(e.atualizadoEm);
  if (Number.isFinite(atualizado) && t - atualizado > SUPERVISOR_VIVO_MS) return false;
  if (Number.isFinite(Number(c?.pid)) && Number(c.pid) !== pid) return false;
  return true;
}

/** A última saída do cérebro foi causada por um reinício controlado (em curso, ou pedido pouco antes dela)? Nunca é queda. */
function saidaDoReinicioControlado(e, c) {
  const rc = e.reinicioControlado;
  if (!rc || typeof rc !== 'object') return false;
  if (rc.emCurso === true) return true;
  const pedido = Date.parse(rc.ultimo?.em);
  const saida = Date.parse(c?.ultimaSaida?.em);
  return Number.isFinite(pedido) && Number.isFinite(saida) && saida >= pedido - 1000 && saida - pedido <= REINICIO_CONTROLADO_JANELA_MS;
}

/**
 * O verificador (puro: as leituras, o relógio e o aviso são injetados). `passada()` olha as quatro coisas e pede os avisos.
 * @param {{ env?: object, now?: () => number, alertar?: Function, lerDisco?: () => number|null, lerRam?: () => number, sondar?: Function|null,
 *           lerSupervisor?: () => object|null, logger?: object|null }} deps
 */
export function criarVerificador({
  env = process.env, now = () => Date.now(), alertar = alertOwner, lerDisco = () => discoLivreGB(env), lerRam = ramLivreMB,
  sondar = null, lerSupervisor = () => lerEstadoDoSupervisor(), logger = null, pid = process.pid,
} = {}) {
  const cfg = configDosEventos(env);
  const sonda = sondar ?? ((alvo) => sondaTcp(alvo, { env }));
  const estado = { ramBaixaDesde: null, internetFalhas: 0, internetForaDesde: null, internetAvisou: false, supervisorVisto: null, supervisorIdent: null, internetAlvoInvalido: false };
  const ultimoPedido = new Map(); // chave do evento -> quando foi pedido o último aviso (o intervalo de repetição por tipo)
  const contadores = { passadas: 0, alertasPedidos: 0, alertasSuprimidos: 0, discoBaixo: 0, ramBaixa: 0, internetFora: 0, internetVoltou: 0, religadasVistas: 0, sondasBloqueadas: 0, erros: 0 };
  const ultimo = { discoLivreGB: null, ramLivreMB: null, internetFalhasSeguidas: 0, internetOk: null };
  const pedir = (saida, chave, titulo, detalhe, opcoes = {}) => {
    // O intervalo de repetição DESTE tipo de evento: dentro dele a condição continua, mas o aviso não se repete.
    const cooldownMinutes = COOLDOWN_EVENTOS_MIN[chave] ?? null;
    const t = now();
    if (cooldownMinutes && t - (ultimoPedido.get(chave) ?? -Infinity) < cooldownMinutes * MIN) { contadores.alertasSuprimidos += 1; return; }
    ultimoPedido.set(chave, t);
    contadores.alertasPedidos += 1;
    saida.alertas.push(chave);
    try { alertar(chave, titulo, detalhe, { level: 'warn', ...(cooldownMinutes ? { cooldownMinutes } : {}), ...opcoes }); } catch { /* o aviso nunca derruba a passada */ }
  };

  function disco(saida) {
    if (!(cfg.discoGB > 0)) return;
    const livre = lerDisco();
    if (livre === null || !Number.isFinite(livre)) return;
    ultimo.discoLivreGB = Number(livre.toFixed(2));
    if (livre < cfg.discoGB) {
      contadores.discoBaixo += 1;
      pedir(saida, 'evento:disco', 'Pouco espaço em disco', `Restam ${fmt(livre)} GB livres onde ficam os dados (o limite é ${fmt(cfg.discoGB)} GB).`);
    }
  }

  function ram(saida, t) {
    if (!(cfg.ramMB > 0)) return;
    const livre = lerRam();
    if (!Number.isFinite(livre)) return;
    ultimo.ramLivreMB = Math.round(livre);
    if (livre >= cfg.ramMB) { estado.ramBaixaDesde = null; return; }
    estado.ramBaixaDesde ??= t;
    if (t - estado.ramBaixaDesde >= cfg.ramMin * MIN) {
      contadores.ramBaixa += 1;
      pedir(saida, 'evento:ram', 'Pouca memória livre', `Menos de ${Math.round(cfg.ramMB)} MB de RAM livre há ${Math.max(1, Math.round((t - estado.ramBaixaDesde) / MIN))} min (agora ${Math.round(livre)} MB).`);
    }
  }

  async function internet(saida, t) {
    if (!cfg.internetAlvo) return;
    if (!lerAlvoDeInternet(cfg.internetAlvo)) {
      if (!estado.internetAlvoInvalido) { estado.internetAlvoInvalido = true; logger?.warn?.('[Eventos] YUI_ALERTA_INTERNET_ALVO inválido (use host ou host:porta): a verificação da internet fica desligada.'); }
      return;
    }
    let ok;
    try { ok = await sonda(cfg.internetAlvo); } catch { ok = false; }
    if (ok === null || ok === undefined) { contadores.sondasBloqueadas += 1; return; } // não sondou (bloqueada em teste): não conta como falha
    ultimo.internetOk = ok === true;
    if (ok === true) {
      if (estado.internetForaDesde !== null && estado.internetAvisou) {
        contadores.internetVoltou += 1;
        pedir(saida, 'evento:internet-voltou', 'A internet voltou', `Ficou fora por cerca de ${Math.max(1, Math.round((t - estado.internetForaDesde) / MIN))} min.`);
      }
      estado.internetFalhas = 0;
      estado.internetForaDesde = null;
      estado.internetAvisou = false;
      ultimo.internetFalhasSeguidas = 0;
      return;
    }
    estado.internetFalhas += 1;
    estado.internetForaDesde ??= t;
    ultimo.internetFalhasSeguidas = estado.internetFalhas;
    if (estado.internetFalhas >= SONDAS_SEGUIDAS) {
      contadores.internetFora += 1;
      estado.internetAvisou = true;
      pedir(saida, 'evento:internet', 'Internet fora', `${estado.internetFalhas} sondas seguidas falharam.`);
    }
  }

  function supervisor(saida, t) {
    const e = lerSupervisor();
    if (!e?.processos) return;
    const atual = {};
    for (const [papel, p] of Object.entries(e.processos)) atual[String(papel).slice(0, 20)] = Number.isFinite(Number(p?.religadas)) ? Number(p.religadas) : 0;
    const ident = `${e.pid ?? ''}:${e.iniciadoEm ?? ''}`;
    const delta = {};
    if (estado.supervisorVisto === null) {
      // A primeira leitura. Se o supervisor religou ESTE cérebro há pouco, esta subida é a consequência de uma queda: avisa uma vez. NÃO avisa quando o arquivo não é de
      // um supervisor vivo que descreve este cérebro (a parada limpa pelo supervisor.parar deixa o arquivo do supervisor que saiu, parado ou sem renovar), nem quando a
      // saída do cérebro foi causada por um REINÍCIO CONTROLADO (o contador de religadas pode vir de uma queda antiga e a subida de agora é recente de qualquer jeito).
      const c = e.processos.cerebro;
      const recente = c && Number(c.religadas) > 0 && Number.isFinite(Date.parse(c.iniciadoEm)) && t - Date.parse(c.iniciadoEm) < Math.max(15 * MIN, cfg.tickMs + 10 * MIN);
      if (recente && supervisorVivoDesteCerebro(e, c, t, pid) && !saidaDoReinicioControlado(e, c)) delta.cerebro = 1;
    } else if (ident !== estado.supervisorIdent) {
      // Outro supervisor (reiniciou o próprio): os contadores recomeçaram; só passa a olhar daqui para a frente.
    } else {
      for (const [papel, n] of Object.entries(atual)) { const d = n - (estado.supervisorVisto[papel] ?? 0); if (d > 0) delta[papel] = d; }
    }
    estado.supervisorVisto = atual;
    estado.supervisorIdent = ident;
    const partes = Object.entries(delta).map(([papel, d]) => `${NOME_DO_PROCESSO[papel] ?? 'um processo'}${d > 1 ? ` (${d} vezes)` : ''}`);
    if (!partes.length) return;
    contadores.religadasVistas += Object.values(delta).reduce((s, d) => s + d, 0);
    pedir(saida, 'evento:supervisor', 'O supervisor religou a Yui', `O supervisor religou ${partes.join(' e ')} depois de uma queda.`);
  }

  return {
    /** Uma passada: nunca lança. Devolve o que pediu (as chaves dos avisos). */
    async passada() {
      const saida = { alertas: [] };
      contadores.passadas += 1;
      const t = now();
      for (const verificar of [() => disco(saida), () => ram(saida, t), () => internet(saida, t), () => supervisor(saida, t)]) {
        try { await verificar(); } catch (err) { contadores.erros += 1; logger?.warn?.(`[Eventos] uma verificação falhou (${String(err?.code ?? err?.message ?? 'erro').slice(0, 60)}).`); }
      }
      return saida;
    },
    status: () => ({ ...contadores, ...ultimo, ramBaixaHaMin: estado.ramBaixaDesde === null ? 0 : Math.round((now() - estado.ramBaixaDesde) / MIN) }),
  };
}

/**
 * Liga os alertas por evento no cérebro. Devolve null com YUI_ALERTAS_EVENTOS desligada (o padrão): nada roda, nenhum timer nasce.
 * @param {{ env?: object, logger?: object|null, permitido?: (nome: string) => boolean } & Parameters<typeof criarVerificador>[0]} opcoes
 */
export function iniciarEventos({ env = process.env, logger = null, permitido = jobAllowed, ...deps } = {}) {
  if (!alertasPorEventoLigados(env)) return null;
  const verificador = criarVerificador({ env, logger, ...deps });
  const tickMs = configDosEventos(env).tickMs;
  let ocupado = false;
  const rodar = async () => {
    if (ocupado || !permitido('eventos.tick')) return { pulou: true };
    ocupado = true;
    try { return await verificador.passada(); } catch { return { erro: true }; } finally { ocupado = false; }
  };
  const primeira = setTimeout(() => { rodar(); }, Math.min(tickMs, 30_000));
  primeira.unref?.();
  const timer = setInterval(() => { rodar(); }, tickMs);
  timer.unref?.();
  logger?.info?.(`[Eventos] Alertas por evento ligados: conferência a cada ${tickMs >= 1000 ? `${Math.round(tickMs / 1000)} s` : `${tickMs} ms`} (disco, memória${configDosEventos(env).internetAlvo ? ', internet' : ''} e religadas do supervisor); o aviso vai ao dono pelo alertOwner.`);
  return {
    passada: rodar,
    status: () => ({ ligado: true, tickMs, ...verificador.status() }),
    parar() { clearTimeout(primeira); clearInterval(timer); },
  };
}
