// A ROTA DE UM PERFIL DE IA (etapa 9): faz UMA chamada ao OmniRoute (pelo provedor cadastrado na Yui) com o `modelo` do perfil, e cuida de tudo
// que cerca essa chamada: o limite de tokens, a leitura do cabeçalho de decisão, o fallback, a falha fechada do perfil privado e os números do
// diagnóstico. Quem chama é o AI Manager (src/core/ai/manager.js), quando o cérebro passa um `perfil` na chamada.
//
// Regras:
//  - A Yui NÃO tem um segundo roteador: a chamada é UMA só (sem revezar provedores nem repetir); o OmniRoute escolhe o provedor dentro do combo;
//  - perfil NÃO privado: falhou a rota inteira (rede, tempo, HTTP, resposta vazia, provedor não cadastrado) = cai no fluxo de hoje (a cadeia ou
//    o gateway que já existe), registrando o fallback. O cabeçalho de decisão aqui é só DIAGNÓSTICO (leitor tolerante): faltando, o diagnóstico
//    diz "não confirmado" e a conversa segue;
//  - perfil PRIVADO (falha fechada, decisão da Liz na etapa 9):
//      * só sai com a configuração COMPLETA (classificação privada, chave vinculada declarada, lista de provedores permitidos, formato estrito da
//        decisão, provedor da Yui cadastrado como NÃO anônimo e com chave) E a rota VERIFICADA por uma SONDA (uma chamada sem nenhum conteúdo
//        privado, pela mesma rota e chave do perfil) cujo cabeçalho é lido pelo leitor ESTRITO e nomeia um provedor da lista permitida;
//      * em cada chamada privada real, cabeçalho ausente, inválido, em formato desconhecido ou nomeando provedor fora da lista = a resposta NÃO é
//        entregue, a rota passa a BLOQUEADA (só volta por uma nova verificação pedida de propósito), o dono é avisado (com limite de repetição) e a
//        auditoria registra. Nunca cai em outra rota nem em rota anônima: a falha fechada devolve uma mensagem curta e clara;
//      * um fallback nunca muda o nível de privacidade da tarefa: o perfil geral nunca atende uma chamada privada;
//  - nada de chave, cabeçalho bruto, prompt ou conteúdo no log, no erro, na auditoria nem no diagnóstico: só códigos, nomes de perfil/combo/provedor
//    (já filtrados) e números. Um segredo plantado no cabeçalho nunca sai daqui.
// Um pedido nunca herda o perfil, a privacidade nem a chave de outro: nada aqui guarda "a conversa atual"; cada chamada leva o seu perfil e a sua
// privacidade, e a chave vem só do cadastro do provedor do perfil.
import crypto from 'node:crypto';
import { logger as defaultLogger } from '../../utils/logger.js';
import { audit } from '../audit.js';
import { alertOwner } from '../alerts.js';
import { lerDecisaoTolerante, lerDecisaoEstrita, CABECALHO_DA_DECISAO, PROVEDORES_CONHECIDOS } from './decisaoOmniRoute.js';
import {
  carregarPerfis, perfisAtivos, privadoDeclarado, resolverProvedorDoPerfil, limiteDoPerfil, avaliarConfigDoPrivado, NOMES_DE_PERFIL,
} from './perfis.js';

/** Mensagem curta e clara da falha fechada. Contém "erro ao processar seu pedido" para as marcas de resposta de sistema do bot a reconhecerem (não entra no contexto). */
export const TEXTO_ROTA_PRIVADA_FECHADA = '🔒 Tive um erro ao processar seu pedido: a rota privada da IA não está liberada agora e, para proteger a conversa, não mandei nada a nenhum provedor. Tente de novo mais tarde.';
/** O texto da sonda: fixo, sem nenhum conteúdo privado. */
export const TEXTO_DA_SONDA = 'Responda apenas com a palavra: ok';

/** O erro da falha fechada (e só dela: o fallback do perfil geral nunca lança). `mensagemCurta` é o que a pessoa vê. */
export class ErroDePerfil extends Error {
  constructor(motivo, { perfil = 'privado' } = {}) {
    super(`rota do perfil ${perfil} fechada (${motivo})`);
    this.name = 'ErroDePerfil';
    this.code = 'PERFIL_FECHADO';
    this.fechado = true;
    this.perfil = perfil;
    this.motivo = motivo;
    this.mensagemCurta = TEXTO_ROTA_PRIVADA_FECHADA;
  }
}

const MAX_ULTIMAS = 20;
const MAX_FALHAS_RECENTES = 5;
const deps = { fetchImpl: null, agora: () => Date.now(), alertar: null, auditar: null, log: null };
/** Só para teste: troca o fetch, o relógio, o alerta ao dono, a auditoria e o log. `restaurarRotaPerfilParaTeste` desfaz. */
export function configurarRotaPerfilParaTeste(parcial = {}) { Object.assign(deps, parcial); }
export function restaurarRotaPerfilParaTeste() {
  Object.assign(deps, { fetchImpl: null, agora: () => Date.now(), alertar: null, auditar: null, log: null });
  zerarEstadoParaTeste();
}
const fetchDaRota = (...a) => (deps.fetchImpl ?? globalThis.fetch)(...a);
const log = () => deps.log ?? defaultLogger;
const alertar = (...a) => (deps.alertar ?? alertOwner)(...a);
const auditar = (...a) => { try { (deps.auditar ?? audit)(...a); } catch { /* a auditoria nunca derruba a chamada */ } };

// ── O estado do processo (só contadores e o estado da rota privada; nada de conteúdo, nada por pessoa) ──────────────────────────────

const novoContador = () => ({ chamadas: 0, ok: 0, erros: 0, fallbacks: 0, fechadas: 0, recusadasPorPrivacidade: 0 });
let estado = novoEstado();
function novoEstado() {
  return {
    porPerfil: Object.fromEntries(NOMES_DE_PERFIL.map((n) => [n, novoContador()])),
    ultimas: [],
    privada: { estado: 'nao-verificada', motivo: null, desde: 0, sondas: 0, sondasOk: 0, violacoes: 0, ultimaSondaEm: 0, assinatura: null, rota: null, falhasSeguidas: 0, sondaSozinhaPausada: false, falhasRecentes: [] },
    sonda: null,
    avisos: new Map(),
  };
}
/** Só para teste: zera os contadores e o estado da rota privada. */
export function zerarEstadoParaTeste() { estado = novoEstado(); }

function registrar(item) {
  estado.ultimas.push({ quando: new Date(deps.agora()).toISOString(), ...item });
  if (estado.ultimas.length > MAX_ULTIMAS) estado.ultimas.splice(0, estado.ultimas.length - MAX_ULTIMAS);
}

/** Uma linha de aviso no log por motivo, no máximo uma a cada 10 minutos (a falha fechada pode repetir a cada mensagem). */
function avisoUnico(chave, texto, minutos = 10) {
  const t = deps.agora();
  if (t - (estado.avisos.get(chave) ?? -Infinity) < minutos * 60_000) return;
  estado.avisos.set(chave, t);
  try { log().warn?.(texto); } catch { /* */ }
}

/** Quando a configuração muda (o arquivo trocado, a variável nova), a rota privada volta a exigir verificação. */
function sincronizar(cfg) {
  if (estado.privada.assinatura !== cfg.assinatura) {
    const antes = estado.privada.assinatura !== null;
    // a configuração nova recomeça a conta das falhas seguidas (e retoma as sondas sozinhas pausadas)
    estado.privada = { ...estado.privada, estado: 'nao-verificada', motivo: antes ? 'configuracao-mudou' : null, desde: deps.agora(), assinatura: cfg.assinatura, falhasSeguidas: 0, sondaSozinhaPausada: false, falhasRecentes: [] };
  }
}

// ── A chamada HTTP ao OmniRoute (uma só) ────────────────────────────────────────────────────────────────────────────────────────

/** O tempo máximo de uma chamada por perfil (YUI_IA_PERFIL_TIMEOUT_MS: de 500 ms a 5 min; padrão 60 s). */
export function tempoLimiteDoPerfilMs(env = process.env) {
  const n = Number(String(env?.YUI_IA_PERFIL_TIMEOUT_MS ?? '').trim());
  return Number.isFinite(n) && n > 0 ? Math.min(300_000, Math.max(500, Math.round(n))) : 60_000;
}

/** O código (só uma palavra fixa) de um status HTTP. */
function codigoDoHttp(status) {
  if (status === 429) return 'cota';
  if (status === 401 || status === 403) return 'autenticacao';
  if (status >= 500) return 'servidor';
  return 'http';
}

/**
 * UMA chamada ao OmniRoute. Lança um objeto { codigo } (só palavras fixas) em qualquer falha; nunca um texto de rede, de corpo ou de cabeçalho.
 * @returns {Promise<{ texto: string, cabecalho: string|null, status: number, latenciaMs: number }>}
 */
async function postar({ provedor, modelo, messages, maxTokens, deadlineAt, cabecalho = CABECALHO_DA_DECISAO, env = process.env }) {
  const t0 = deps.agora();
  let limite = tempoLimiteDoPerfilMs(env);
  if (deadlineAt) limite = Math.min(limite, Math.max(0, Number(deadlineAt) - t0));
  if (limite < 500) throw { codigo: 'prazo-esgotado' };
  const controlador = new AbortController();
  const timer = setTimeout(() => controlador.abort(), limite);
  const headers = { 'Content-Type': 'application/json', Accept: 'application/json' };
  if (provedor.chave) headers.Authorization = `Bearer ${provedor.chave}`;
  let res;
  try {
    res = await fetchDaRota(provedor.endpoint, { method: 'POST', headers, body: JSON.stringify({ model: modelo, messages, max_tokens: maxTokens, stream: false }), signal: controlador.signal });
    if (!res.ok) throw { codigo: codigoDoHttp(res.status), status: res.status };
    let texto;
    try { texto = await res.text(); } catch { throw { codigo: controlador.signal.aborted ? 'tempo-esgotado' : 'rede' }; }
    let json;
    try { json = JSON.parse(texto); } catch { throw { codigo: 'resposta-invalida' }; }
    const conteudo = json?.choices?.[0]?.message?.content;
    if (typeof conteudo !== 'string' || !conteudo.trim()) throw { codigo: 'resposta-vazia' };
    let valorDoCabecalho = null;
    try { valorDoCabecalho = res.headers?.get?.(cabecalho) ?? null; } catch { valorDoCabecalho = null; }
    return { texto: conteudo.trim(), cabecalho: valorDoCabecalho, status: res.status, latenciaMs: Math.max(0, deps.agora() - t0) };
  } catch (e) {
    if (e && typeof e === 'object' && typeof e.codigo === 'string') throw e;
    throw { codigo: controlador.signal.aborted ? 'tempo-esgotado' : 'rede' };
  } finally {
    clearTimeout(timer);
  }
}

// ── O perfil privado: a verificação, o bloqueio e a chamada ─────────────────────────────────────────────────────────────────────────

/** A impressão da rota (o endereço e a chave do provedor do perfil), só como hash: o que foi verificado é ESTA rota, e se ela mudar a verificação não vale mais. */
const impressaoDaRota = (provedor) => crypto.createHash('sha256').update(`${provedor?.endpoint ?? ''}\u0000${provedor?.chave ?? ''}`).digest('hex').slice(0, 16);

/** A rota (endereço ou chave do provedor) mudou depois da verificação? Então a rota volta a "não verificada" (a validação era de outra rota). */
function conferirRotaVerificada(provedor) {
  const p = estado.privada;
  if (p.estado === 'validada' && p.rota !== null && p.rota !== impressaoDaRota(provedor)) {
    estado.privada = { ...p, estado: 'nao-verificada', motivo: 'rota-mudou', desde: deps.agora(), rota: null };
  }
}

/** O estado da rota privada AGORA (calculado: a configuração incompleta tem prioridade sobre o estado guardado). */
export function estadoDaRotaPrivada(env = process.env) {
  const cfg = carregarPerfis(env);
  if (!privadoDeclarado(env)) return { estado: 'desligada', motivo: null, motivos: [] };
  sincronizar(cfg);
  const avaliacao = avaliarConfigDoPrivado(env);
  if (!avaliacao.ok) return { estado: 'incompleta', motivo: avaliacao.motivos[0] ?? null, motivos: avaliacao.motivos };
  conferirRotaVerificada(avaliacao.provedor);
  return { estado: estado.privada.estado, motivo: estado.privada.motivo, motivos: [] };
}

function permitidosDe(perfil) { return new Set((perfil?.provedoresPermitidos ?? []).map((p) => String(p).toLowerCase())); }

/**
 * Passa a rota privada a BLOQUEADA (só uma vez por violação: as respostas que já estavam a caminho só contam). Avisa o dono (com limite de repetição),
 * registra na auditoria e no log. Nunca escreve o cabeçalho: só o motivo e o nome do provedor, já filtrado.
 */
function bloquear(motivo, provedorRecebido) {
  estado.privada.violacoes += 1;
  if (estado.privada.estado === 'bloqueada') return;
  estado.privada = { ...estado.privada, estado: 'bloqueada', motivo, desde: deps.agora() };
  const quem = provedorRecebido ? ` (provedor citado: ${provedorRecebido})` : '';
  auditar('ia.rota_privada_bloqueada', null, { perfil: 'privado', motivo, provedorCitado: provedorRecebido ?? null });
  try { log().error?.(`[IA] A rota privada foi BLOQUEADA (${motivo})${quem}. A conversa privada fica sem IA até a rota ser verificada de novo.`); } catch { /* */ }
  try {
    alertar('ia-rota-privada-bloqueada', 'A rota privada da IA foi bloqueada',
      `Motivo: ${motivo}${quem}. A resposta daquele pedido não foi entregue e a conversa privada fica sem IA até a rota ser verificada de novo (reconfigure o combo ou o formato e peça a nova verificação).`,
      { level: 'error', cooldownMinutes: 60 });
  } catch { /* */ }
}

/**
 * O intervalo mínimo entre sondas sozinhas (YUI_IA_SONDA_INTERVALO_S: de 1 s a 1 dia; padrão 300 s = 5 minutos, decisão da Liz em 18/11/2026;
 * "0" desliga as sondas sozinhas: só a subida do cérebro e o pedido explícito).
 */
function intervaloDaSondaMs(env) {
  const bruto = String(env?.YUI_IA_SONDA_INTERVALO_S ?? '').trim();
  if (bruto === '0') return null;
  const n = Number(bruto);
  return Number.isFinite(n) && n >= 1 ? Math.min(86_400, n) * 1000 : 300_000;
}

/**
 * Quantas sondas SEGUIDAS podem falhar antes de as sondas sozinhas PARAREM (YUI_IA_SONDA_MAX_TENTATIVAS: 1 a 1000; padrão 12 = cerca de 1 hora de
 * tentativas a cada 5 minutos). Pausadas, só voltam por um pedido de propósito (a subida do cérebro ou o dono), por uma configuração nova ou por um reinício.
 */
function maxTentativasDaSonda(env) {
  const n = Number(String(env?.YUI_IA_SONDA_MAX_TENTATIVAS ?? '').trim());
  return Number.isInteger(n) && n >= 1 ? Math.min(1000, n) : 12;
}

/** Vale a pena tentar a sonda sozinha (em segundo plano)? Só do estado "não verificada" ou de uma falha de rede; nunca do bloqueio nem pausada. */
function podeSondarSozinha(env) {
  const p = estado.privada;
  const intervalo = intervaloDaSondaMs(env);
  if (intervalo === null) return false;
  if (p.sondaSozinhaPausada === true) return false;
  if (deps.agora() - p.ultimaSondaEm < intervalo) return false;
  if (p.estado === 'nao-verificada') return true;
  return p.estado === 'nao-validada' && ['rede', 'tempo-esgotado', 'servidor', 'http', 'cota', 'prazo-esgotado'].includes(p.motivo);
}

/**
 * A SONDA: uma chamada sem nenhum conteúdo privado, pela mesma rota e chave do perfil privado. Só liga a rota (estado "validada") se o cabeçalho, lido
 * pelo leitor ESTRITO, nomeia um provedor da lista permitida. Várias chamadas ao mesmo tempo dividem UMA sonda só.
 * `desbloquear: true` (um PEDIDO de nova verificação de quem opera, depois de reconfigurar) é o único jeito de tentar sair do estado "bloqueada", e só sai
 * se a sonda for VÁLIDA (cabeçalho estrito e provedor da lista permitida): uma verificação que falha a mantém bloqueada (regra da Liz).
 * `origem: 'automatica'` é a sonda sozinha em segundo plano (conta para o limite de tentativas seguidas); qualquer outra origem (a subida do cérebro, o
 * dono) é um pedido de propósito e recomeça a conta.
 * @returns {Promise<{ estado: string, motivo: string|null }>}
 */
export function verificarRotaPrivada({ desbloquear = false, env = process.env, origem = 'pedido' } = {}) {
  if (estado.sonda) return estado.sonda;
  const atual = estadoDaRotaPrivada(env);
  if (atual.estado === 'desligada' || atual.estado === 'incompleta') return Promise.resolve({ estado: atual.estado, motivo: atual.motivo });
  if (atual.estado === 'bloqueada' && !desbloquear) return Promise.resolve({ estado: 'bloqueada', motivo: atual.motivo });
  const avaliacao = avaliarConfigDoPrivado(env);
  const { perfil, provedor } = avaliacao;
  const p = estado.privada;
  if (origem !== 'automatica') { p.falhasSeguidas = 0; p.sondaSozinhaPausada = false; } // um pedido de propósito recomeça a conta das falhas seguidas
  p.sondas += 1;
  p.ultimaSondaEm = deps.agora();
  const eraBloqueada = p.estado === 'bloqueada';
  const terminar = (novo, motivo) => {
    const antes = estado.privada;
    // Só uma sonda VÁLIDA tira a rota do bloqueio: uma nova verificação que falha a mantém bloqueada, com o motivo do bloqueio.
    const mantemBloqueio = eraBloqueada && novo !== 'validada';
    const estadoFinal = mantemBloqueio ? 'bloqueada' : novo;
    const motivoFinal = mantemBloqueio ? antes.motivo : motivo;
    let falhas = antes.falhasSeguidas ?? 0;
    let pausada = antes.sondaSozinhaPausada === true;
    let recentes = antes.falhasRecentes ?? [];
    if (novo === 'validada') {
      falhas = 0; pausada = false; recentes = [];
    } else {
      // o registro das falhas: contagem seguida, as últimas (motivo e quando) e uma linha de aviso no log
      falhas += 1;
      recentes = [...recentes, { em: deps.agora(), motivo }].slice(-MAX_FALHAS_RECENTES);
      const max = maxTentativasDaSonda(env);
      try { log().warn?.(`[IA] A sonda da rota privada falhou (${motivo}); falhas seguidas: ${falhas} de ${max}.`); } catch { /* */ }
      if (falhas >= max && !pausada) {
        pausada = true;
        try { log().warn?.(`[IA] As sondas sozinhas da rota privada foram PAUSADAS depois de ${falhas} falhas seguidas; só um pedido de propósito, uma configuração nova ou um reinício as retoma.`); } catch { /* */ }
      }
    }
    estado.privada = {
      ...antes, estado: estadoFinal, motivo: motivoFinal, desde: mantemBloqueio ? antes.desde : deps.agora(), sondasOk: antes.sondasOk + (novo === 'validada' ? 1 : 0),
      rota: novo === 'validada' ? impressaoDaRota(provedor) : null, falhasSeguidas: falhas, sondaSozinhaPausada: pausada, falhasRecentes: recentes,
    };
    try { log().info?.(`[IA] Verificação da rota privada: ${estadoFinal}${motivoFinal ? ` (${motivoFinal})` : ''}.`); } catch { /* */ }
    return { estado: estadoFinal, motivo: motivoFinal };
  };
  const limite = limiteDoPerfil(perfil, provedor, env);
  estado.sonda = (async () => {
    try {
      const r = await postar({ provedor, modelo: perfil.modelo, messages: [{ role: 'user', content: TEXTO_DA_SONDA }], maxTokens: Math.min(16, limite.efetivo), cabecalho: perfil.decisao.cabecalho, env });
      const e = lerDecisaoEstrita(r.cabecalho, perfil.decisao);
      if (!e.ok) return terminar('nao-validada', e.motivo);
      if (!permitidosDe(perfil).has(e.provedor)) return terminar('nao-validada', 'provedor-fora-da-lista');
      return terminar('validada', null);
    } catch (err) {
      return terminar('nao-validada', typeof err?.codigo === 'string' ? err.codigo : 'rede');
    } finally {
      estado.sonda = null;
    }
  })();
  return estado.sonda;
}

/** A conversa privada precisa de uma rota verificada: dispara a sonda em segundo plano (com intervalo) e fecha a chamada de agora. */
function disparaSondaEmSegundoPlano(env) {
  if (estado.sonda || !podeSondarSozinha(env)) return;
  verificarRotaPrivada({ env, origem: 'automatica' }).catch(() => {});
}

function fechar(motivo, { ponto = null, combo = null, avisarODono = true } = {}) {
  estado.porPerfil.privado.fechadas += 1;
  registrar({ ponto, perfil: 'privado', combo, provedor: null, estrategia: null, fallback: false, limiteTokens: null, latenciaMs: null, resultado: 'fechado', motivo, decisao: 'nao-aplicavel' });
  avisoUnico(`fechada:${motivo}`, `[IA] Conversa privada FECHADA (${motivo}): nada foi enviado a nenhum provedor.`);
  // Rota BLOQUEADA: o dono já foi avisado do bloqueio (com o limite de repetição dele); este aviso a mais seria repetição.
  if (avisarODono) {
    try { alertar('ia-perfil-privado-fechado', 'A conversa privada está sem rota de IA', `A rota privada não está liberada (${motivo}). As conversas privadas respondem com um aviso até a rota ser configurada e verificada.`, { level: 'warn', cooldownMinutes: 180 }); } catch { /* */ }
  }
  return new ErroDePerfil(motivo);
}

async function chamarPrivado({ messages, deadlineAt, ponto, env }) {
  const cfg = carregarPerfis(env);
  sincronizar(cfg);
  const c = estado.porPerfil.privado;
  c.chamadas += 1;
  const avaliacao = avaliarConfigDoPrivado(env);
  if (!avaliacao.ok) throw fechar(`config-${avaliacao.motivos[0] ?? 'incompleta'}`, { ponto });
  const { perfil, provedor } = avaliacao;
  conferirRotaVerificada(provedor);
  if (estado.privada.estado !== 'validada') {
    disparaSondaEmSegundoPlano(env);
    throw fechar(`rota-${estado.privada.estado}`, { ponto, combo: perfil.modelo, avisarODono: estado.privada.estado !== 'bloqueada' });
  }
  const limite = limiteDoPerfil(perfil, provedor, env);
  let r;
  try {
    r = await postar({ provedor, modelo: perfil.modelo, messages, maxTokens: limite.efetivo, deadlineAt, cabecalho: perfil.decisao.cabecalho, env });
  } catch (err) {
    c.erros += 1;
    const codigo = typeof err?.codigo === 'string' ? err.codigo : 'rede';
    registrar({ ponto, perfil: 'privado', combo: perfil.modelo, provedor: null, estrategia: null, fallback: false, limiteTokens: limite.efetivo, latenciaMs: null, resultado: 'erro', motivo: codigo, decisao: 'nao-aplicavel' });
    try { log().warn?.(`[IA] perfil privado: a chamada falhou (${codigo}); nada foi enviado a outra rota.`); } catch { /* */ }
    throw new ErroDePerfil(`chamada-${codigo}`);
  }
  // A decisão de segurança: só o leitor ESTRITO. Qualquer dúvida = a resposta NÃO é entregue e a rota fica bloqueada.
  const e = lerDecisaoEstrita(r.cabecalho, perfil.decisao);
  // o provedor citado só vai ao registro quando o leitor estrito o entendeu (um cabeçalho que não segue o formato não é confiável nem para citar)
  const citado = e.ok ? e.provedor : null;
  let violacao = null;
  if (!e.ok) violacao = e.motivo;
  else if (!permitidosDe(perfil).has(e.provedor)) violacao = 'provedor-fora-da-lista';
  if (violacao) {
    bloquear(violacao, citado);
    c.erros += 1;
    c.fechadas += 1;
    registrar({ ponto, perfil: 'privado', combo: perfil.modelo, provedor: citado, estrategia: null, fallback: false, limiteTokens: limite.efetivo, latenciaMs: r.latenciaMs, resultado: 'bloqueado', motivo: violacao, decisao: 'violada' });
    throw new ErroDePerfil(`rota-bloqueada-${violacao}`);
  }
  const t = lerDecisaoTolerante(r.cabecalho, { conhecidos: perfil.provedoresPermitidos });
  c.ok += 1;
  registrar({ ponto, perfil: 'privado', combo: perfil.modelo, provedor: e.provedor, estrategia: t.estrategia, fallback: false, limiteTokens: limite.efetivo, latenciaMs: r.latenciaMs, resultado: 'ok', motivo: null, decisao: 'verificada' });
  return { texto: r.texto, nome: 'privado', combo: perfil.modelo, provedor: e.provedor, latenciaMs: r.latenciaMs };
}

// ── A porta de entrada (o AI Manager chama só esta) ─────────────────────────────────────────────────────────────────────────────────

/** O pedido de perfil do cérebro, em texto ou { nome, ponto, motivo }: só o nome conhecido e o ponto (uma palavra) valem. */
function lerPedido(perfil) {
  const bruto = typeof perfil === 'string' ? { nome: perfil } : perfil;
  if (!bruto || typeof bruto !== 'object') return null;
  const nome = String(bruto.nome ?? '').trim();
  if (!NOMES_DE_PERFIL.includes(nome)) return null;
  const ponto = /^[a-z][a-z-]{0,30}$/.test(String(bruto.ponto ?? '')) ? String(bruto.ponto) : null;
  return { nome, ponto };
}

/**
 * Tenta atender a chamada pelo perfil pedido.
 * @param {{ perfil: string|{nome: string, ponto?: string}, privada: boolean, messages: object[], deadlineAt?: number|null, somenteLocal?: boolean, env?: object }} p
 *   `privada`: a chamada leva conteúdo privado (nunca provedor anônimo): quem decide é o AI Manager, a partir da própria chamada (sensitive, escopo da memória).
 *   `somenteLocal`: AI_PRIVATE_LOCAL_ONLY com memória pessoal: a rota do perfil é nuvem, então não vale (o backend local atende).
 * @returns {Promise<{ via: 'nenhum' } | { via: 'fallback', motivo: string } | { via: 'perfil', texto: string, nome: string, combo: string, provedor: string|null, latenciaMs: number }>}
 *   `nenhum`: sem rota por perfil (nada configurado, perfil não ativo, ...): o fluxo de hoje. `fallback`: a rota do perfil geral falhou: o fluxo de hoje, já registrado.
 * @throws {ErroDePerfil} só o perfil privado: a falha fechada.
 */
export async function tentarPerfil({ perfil, privada = false, messages, deadlineAt = null, somenteLocal = false, env = process.env }) {
  const pedido = lerPedido(perfil);
  if (!pedido) return { via: 'nenhum' };
  const cfg = carregarPerfis(env);
  if (!cfg.temConfig) return { via: 'nenhum' };
  sincronizar(cfg);
  if (somenteLocal) return { via: 'nenhum' };
  const { nome, ponto } = pedido;

  if (nome === 'privado') {
    if (!privadoDeclarado(env)) return { via: 'nenhum' };
    const r = await chamarPrivado({ messages, deadlineAt, ponto, env });
    return { via: 'perfil', ...r };
  }

  // Perfil geral: nunca atende uma chamada privada (um fallback nunca muda o nível de privacidade da tarefa).
  const ativos = perfisAtivos(env);
  const p = ativos[nome];
  if (!p) return { via: 'nenhum' };
  const c = estado.porPerfil[nome];
  if (privada) {
    c.recusadasPorPrivacidade += 1;
    registrar({ ponto, perfil: nome, combo: p.modelo, provedor: null, estrategia: null, fallback: false, limiteTokens: null, latenciaMs: null, resultado: 'recusado', motivo: 'chamada-privada', decisao: 'nao-aplicavel' });
    return { via: 'nenhum' };
  }
  c.chamadas += 1;
  const falhou = (motivo, extra = {}) => {
    c.erros += 1;
    c.fallbacks += 1;
    registrar({ ponto, perfil: nome, combo: p.modelo, provedor: null, estrategia: null, fallback: true, limiteTokens: extra.limite ?? null, latenciaMs: extra.latenciaMs ?? null, resultado: 'fallback', motivo, decisao: 'nao-aplicavel' });
    try { log().warn?.(`[IA] perfil ${nome} (combo ${p.modelo}): a rota falhou (${motivo}); seguindo pelo fluxo de hoje.`); } catch { /* */ }
    return { via: 'fallback', motivo };
  };
  const r = resolverProvedorDoPerfil(p, env);
  if (!r.ok) return falhou(r.codigo);
  const limite = limiteDoPerfil(p, r.provedor, env);
  let resposta;
  const t0 = deps.agora();
  try {
    resposta = await postar({ provedor: r.provedor, modelo: p.modelo, messages, maxTokens: limite.efetivo, deadlineAt, env });
  } catch (err) {
    return falhou(typeof err?.codigo === 'string' ? err.codigo : 'rede', { limite: limite.efetivo, latenciaMs: Math.max(0, deps.agora() - t0) });
  }
  // O leitor TOLERANTE (só diagnóstico): o cabeçalho que faltar ou vier estranho não derruba nem muda nada; o diagnóstico diz "não confirmado".
  const conhecidos = [...PROVEDORES_CONHECIDOS, r.provedor.id];
  const d = lerDecisaoTolerante(resposta.cabecalho, { conhecidos });
  c.ok += 1;
  registrar({ ponto, perfil: nome, combo: p.modelo, provedor: d.provedor, estrategia: d.estrategia, fallback: false, limiteTokens: limite.efetivo, latenciaMs: d.latenciaMs ?? resposta.latenciaMs, resultado: 'ok', motivo: null, decisao: d.confirmada ? 'confirmada' : 'nao-confirmada' });
  return { via: 'perfil', texto: resposta.texto, nome, combo: p.modelo, provedor: d.provedor, latenciaMs: resposta.latenciaMs };
}

// ── O diagnóstico (só palavras fixas, nomes já filtrados e números) ─────────────────────────────────────────────────────────────

/**
 * Os números dos perfis para o diagnóstico (src/core/diagnostico.js ainda reconstrói por uma lista de permitidos). Nunca lança. Nada de chave,
 * cabeçalho, prompt nem conteúdo; os provedores citados passaram pelo filtro de palavras permitidas.
 */
export function estadoDosPerfis(env = process.env) {
  try {
    const cfg = carregarPerfis(env);
    const rota = estadoDaRotaPrivada(env);
    const ativos = perfisAtivos(env);
    const perfis = Object.values(cfg.perfis).map((p) => {
      const r = resolverProvedorDoPerfil(p, env);
      const lim = r.ok ? limiteDoPerfil(p, r.provedor, env) : null;
      const contador = estado.porPerfil[p.nome] ?? novoContador();
      return {
        nome: p.nome, habilitado: Boolean(ativos[p.nome]), privacidade: p.privacidade, combo: p.modelo, provedorDaYui: p.provedor,
        provedorCadastrado: r.ok, maxTokens: p.maxTokens, limiteEfetivo: lim?.efetivo ?? null, capacidadeConhecida: lim?.capacidade ?? null,
        ...contador,
      };
    });
    const totais = Object.values(estado.porPerfil).reduce((t, c) => { for (const k of Object.keys(c)) t[k] = (t[k] ?? 0) + c[k]; return t; }, {});
    const privado = cfg.perfis.privado ?? null;
    return {
      configurado: Object.keys(ativos).length > 0,
      origem: cfg.origem,
      errosDeConfiguracao: cfg.erros.map((e) => ({ perfil: NOMES_DE_PERFIL.includes(e.perfil) ? e.perfil : null, codigo: e.codigo })),
      perfis,
      totais,
      ultimas: estado.ultimas.map((u) => ({ ...u })),
      rotaPrivada: {
        estado: rota.estado, motivo: rota.motivo, motivos: rota.motivos,
        formatoDefinido: Boolean(privado?.decisao), sondas: estado.privada.sondas, sondasOk: estado.privada.sondasOk, violacoes: estado.privada.violacoes,
        ultimaSondaHaSegundos: estado.privada.ultimaSondaEm ? Math.max(0, Math.round((deps.agora() - estado.privada.ultimaSondaEm) / 1000)) : null,
        falhasSeguidas: estado.privada.falhasSeguidas ?? 0,
        sondaSozinhaPausada: estado.privada.sondaSozinhaPausada === true,
        falhasRecentes: (estado.privada.falhasRecentes ?? []).map((f) => ({ haSegundos: Math.max(0, Math.round((deps.agora() - f.em) / 1000)), motivo: f.motivo })),
      },
    };
  } catch {
    return null;
  }
}

