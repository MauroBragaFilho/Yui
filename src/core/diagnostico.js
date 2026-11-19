// O DIAGNÓSTICO da Yui para a aba "Diagnóstico" do app (etapa 8, 18/11/2026; o plano está no §4 do docs/RELATORIO_ETAPA8_PRE_PILOTO.md).
//
// É a rota `GET /v1/admin/diagnostico`: SÓ LEITURA e SÓ O DONO (o createAdmin confere o papel, como em todas as rotas /v1/admin/*). Junta o que já
// existe espalhado (o /v1/health, o relatório de saúde, a saúde do cérebro, o Gateway de IA, os limites de tokens, a cota de busca) numa resposta
// só, com UM formato fixo.
//
// O QUE NUNCA SAI daqui (e como isso é garantido): texto de conversa, pesquisa privada, ids de pessoas ou de servidores, segredos (chaves, tokens),
// caminhos de arquivo e o texto de qualquer erro. Nada é copiado de uma fonte para a resposta "como veio": cada campo é reconstruído por uma
// LISTA DE PERMITIDOS (números, booleanos, identificadores curtos de provedor e modelo, palavras fixas). Strings livres das fontes são descartadas
// (`soNumeros` guarda só número e booleano; `classificarErro` troca o texto do erro de um provedor por um tipo e um código HTTP). O formato
// (as chaves de cada seção) é conferido por teste: um campo novo só entra de propósito.
//
// Duas configurações: no processo único (`modo: "unico"`) a seção `cerebro` é null; com o cérebro separado (`modo: "cerebro-separado"`) o cérebro
// (src/cerebro/painel.js, createCerebroAdmin) acrescenta o estado dele, da conexão com o bot, da pesquisa, dos comentários e da conversa.
import path from 'node:path';
import * as ai from './ai/manager.js';
import { getGateway } from '../gateway/index.js';
import { loadProviders } from '../gateway/providers.js';
import { tetoGlobal, tabelaDeLimites, limiteDoApp, diagnosticoDosLimites, ajustesDoCerebro } from './ai/limitesTokens.js';
import { getDefaultBudget, userLimitPerHour, monthlyCap } from '../search/budget.js';
import { activeProviders } from '../search/providers.js';
import { estadoDaCotaHora } from '../search/cotaHora.js';
import { estadoDosPerfis } from './ai/rotaPerfil.js';
import { estadoDoMotor } from './ai/motorAgente.js';
import { diagnosticoLocalPrivada, MOTIVOS as MOTIVOS_LOCAL_PRIVADA } from './ai/localPrivada.js';
import { pareceSegredo } from './ai/decisaoOmniRoute.js';
import { NOMES_DE_PERFIL } from './ai/perfis.js';
import { readLogStats, summarizeDatabases } from './healthReport.js';
import * as database from '../database/db.js';

export const VERSAO_DIAGNOSTICO = 1;

// ── Sanitizadores (a lista de permitidos) ────────────────────────────────────────────────────────────────────────────────────────────
const inteiro = (v, padrao = 0) => { const n = Number(v); return Number.isFinite(n) ? Math.round(n) : padrao; };
const inteiroOuNull = (v) => (v === null || v === undefined || v === '' || !Number.isFinite(Number(v)) ? null : Math.round(Number(v)));
const booleano = (v) => (v === true ? true : v === false ? false : null);
/** Identificador curto (provedor, modelo): letras, números e `_ . : -`; senão null. Nunca um id numérico longo (id do Discord). */
const ID_RE = /^(?!\d{12,})[A-Za-z0-9][A-Za-z0-9_.:/@-]{0,79}$/;
const identificador = (v) => (typeof v === 'string' && ID_RE.test(v) ? v : null);
/** Rótulo de um provedor (texto que o dono escreveu): uma linha, sem caracteres de controle, até `max`. */
const rotulo = (v, max = 40) => String(v ?? '').replace(/[\x00-\x1f\x7f]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
/** Nome de variável do .env. */
const VARIAVEL_RE = /^[A-Z][A-Z0-9_]{1,60}$/;
/** Palavra fixa de um código (motivo, tipo): minúsculas e hífen. */
const CODIGO_RE = /^[a-z][a-z0-9-]{0,40}$/;
const codigo = (v) => (typeof v === 'string' && CODIGO_RE.test(v) ? v : null);

/**
 * Guarda de um objeto de contadores SÓ o que é número ou booleano (e objetos que, por dentro, são assim). Strings, listas e valores estranhos
 * somem; chave que não é uma palavra (começa com letra) ou parece um hash/id some também (um mapa por pessoa nunca vaza o id).
 */
export function soNumeros(obj, { profundidade = 3, maxChaves = 60 } = {}) {
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return {};
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(obj)) {
    if (n >= maxChaves) break;
    if (!/^[A-Za-z][A-Za-z0-9_]{0,40}$/.test(k) || /^[0-9a-f]{16,}$/i.test(k)) continue;
    if (typeof v === 'number' && Number.isFinite(v)) { out[k] = v; n += 1; }
    else if (typeof v === 'boolean') { out[k] = v; n += 1; }
    else if (v && typeof v === 'object' && !Array.isArray(v) && profundidade > 0) {
      const sub = soNumeros(v, { profundidade: profundidade - 1, maxChaves });
      if (Object.keys(sub).length) { out[k] = sub; n += 1; }
    }
  }
  return out;
}

/**
 * O último erro de um provedor sem o texto dele: só o TIPO e o código HTTP (se houver). O código vem do roteador (`lastStatus`); sem ele, só se o texto
 * COMEÇA com "HTTP 429" (a forma que o roteador escreve quando o provedor não manda mensagem): nunca um número achado no meio do texto.
 */
export function classificarErro(texto, statusDoRoteador = null) {
  const vazio = texto === null || texto === undefined || texto === '';
  if (vazio && !Number.isInteger(statusDoRoteador)) return null;
  const s = vazio ? '' : String(texto);
  const doTexto = /^\s*(?:HTTP|status)\s*:?\s*(\d{3})\b/i.exec(s);
  const status = Number.isInteger(statusDoRoteador) && statusDoRoteador >= 100 && statusDoRoteador <= 599 ? statusDoRoteador : doTexto ? Number(doTexto[1]) : null;
  let tipo = 'outro';
  if (status === 429 || /quota|cota|rate.?limit|limite/i.test(s)) tipo = 'cota';
  else if (status === 401 || status === 403 || /auth|chave|api.?key|token/i.test(s)) tipo = 'autenticacao';
  else if (/timeout|tempo esgotado|abort|prazo/i.test(s)) tipo = 'tempo';
  else if (/ECONN|ENOTFOUND|EAI_AGAIN|rede|network|fetch failed|socket/i.test(s)) tipo = 'rede';
  else if (status && status >= 500) tipo = 'servidor';
  else if (status) tipo = 'http';
  return { tipo, status };
}

// ── As seções (cada uma reconstruída a partir da fonte) ──────────────────────────────────────────────────────────────────────────────

function secaoIa(fontes) {
  const backends = (Array.isArray(fontes.backends) ? fontes.backends : []).slice(0, 12).map((b) => ({ nome: identificador(b?.name), ativo: booleano(b?.active), local: booleano(b?.local) })).filter((b) => b.nome);
  const g = fontes.gateway && typeof fontes.gateway === 'object' ? fontes.gateway : null;
  const provedores = (Array.isArray(g?.status?.providers) ? g.status.providers : []).slice(0, 30).map((p) => ({
    id: identificador(p?.id),
    rotulo: rotulo(p?.label),
    anonimo: booleano(p?.anonymous),
    prioridade: inteiroOuNull(p?.priority),
    chaves: inteiro(p?.keys),
    chavesEmDescanso: inteiro(p?.keysCoolingDown),
    descansoSegundos: inteiro(p?.cooldownSeconds),
    alvos: (Array.isArray(p?.targets) ? p.targets : []).slice(0, 40).map((t) => ({
      modelo: rotulo(t?.model, 60),
      disponivel: booleano(t?.available),
      descansoSegundos: inteiro(t?.cooldownSeconds),
      falhasSeguidas: inteiro(t?.failures),
      acertos: inteiro(t?.ok),
      falhas: inteiro(t?.fail),
      ultimoErro: classificarErro(t?.lastError, t?.lastStatus),
      ultimoOkHaSegundos: inteiroOuNull(t?.lastOkSecondsAgo),
    })),
  })).filter((p) => p.id);
  // o primeiro provedor (na ordem de prioridade do roteador) que tem um modelo disponível: o que responderia agora
  const atual = [...provedores].sort((a, b) => (a.prioridade ?? 999) - (b.prioridade ?? 999)).find((p) => p.alvos.some((t) => t.disponivel === true));
  return {
    backendAtivo: backends.find((b) => b.ativo)?.nome ?? null,
    backends,
    gatewayConfigurado: provedores.length > 0,
    algumDisponivel: provedores.length ? booleano(g?.algumDisponivel) : null,
    provedorAtual: atual?.id ?? null,
    totais: soNumeros(g?.status?.totals),
    provedores,
  };
}

function secaoLimites(fontes, modo) {
  const l = fontes.limites && typeof fontes.limites === 'object' ? fontes.limites : {};
  const item = (x) => ({ limite: inteiro(x?.limite), configurado: inteiro(x?.configurado), capacidade: inteiro(x?.capacidade), origem: rotulo(x?.origem, 100) });
  const lista = (a) => (Array.isArray(a) ? a : []).slice(0, 30).map((x) => ({ provedor: identificador(x?.provedor), ...item(x) })).filter((x) => x.provedor);
  return {
    teto: inteiro(l.teto, null),
    // pelo cérebro separado o Discord segue esta tabela; no processo único o Discord usa os limites da cadeia do bot (não são desta tabela)
    discord: { aplica: modo === 'cerebro-separado', provedores: lista(l.discord) },
    app: { provedores: lista(l.app) },
    erroDeConfiguracao: l.erro ? true : false,
  };
}

function secaoCotas(fontes) {
  const c = fontes.cota && typeof fontes.cota === 'object' ? fontes.cota : {};
  const dono = c.dono && typeof c.dono === 'object' ? c.dono : {};
  const hora = c.hora && typeof c.hora === 'object' ? c.hora : {};
  return {
    hora: {
      global: { usadas: inteiro(c.global?.usadas), limite: inteiro(c.global?.limite), cheia: booleano(c.global?.cheia), liberaEmSegundos: inteiro(c.global?.liberaEmSegundos) },
      porPessoaLimite: inteiro(c.porPessoaLimite),
      // quantas vezes a pessoa só aproveitou o resultado de uma busca que já aconteceu (sem nova chamada externa e sem cobrança): só um número
      reutilizadas: inteiro(hora.reutilizadas),
      // a cota por hora em disco (etapa 8): quem é o dono do arquivo, se está gravando e, se não, por quê (uma palavra fixa).
      // `pesquisaDisponivel`: este processo PODE buscar agora (false = sem o dono da cota; a Yui avisa que a pesquisa está temporariamente indisponível);
      // `gravacaoComFalha`: o registro da cota não gravou há pouco (a busca não sai enquanto isso)
      persistencia: {
        gravando: booleano(hora.persistente),
        pesquisaDisponivel: booleano(dono.pesquisaDisponivel),
        gravacaoComFalha: booleano(hora.gravacaoComFalha),
        papel: codigo(dono.papel),
        dono: codigo(dono.dono),
        gravacoes: inteiro(hora.gravacoes),
        falhasDeGravacao: inteiro(hora.falhas),
        buscasQueVoltaram: inteiro(hora.carregadas),
        aguardandoTrava: booleano(dono.aguardandoTrava),
        perdeuATrava: booleano(dono.perdida),
        motivo: codigo(dono.codigo),
      },
    },
    mes: (Array.isArray(c.mes) ? c.mes : []).slice(0, 12).map((m) => ({ provedor: identificador(m?.provedor), usadas: inteiro(m?.usadas), teto: inteiro(m?.teto) })).filter((m) => m.provedor),
    // a reserva da cota que segura a busca automática do /yui (só o cérebro decide isso; no processo único não existe)
    reservaPercentual: inteiroOuNull(fontes.cerebro?.reservaPercentual),
  };
}

// ── Os perfis de IA e o motor do agente (etapa 9) ────────────────────────────────────────────────────────────────────────────────────
/** Palavra de provedor ou estratégia (o que o OmniRoute disse): minúsculas, 2 a 40 caracteres, e nunca algo que pareça um segredo. */
const PALAVRA_DE_DECISAO_RE = /^[a-z][a-z0-9._-]{0,38}[a-z0-9]$/;
const palavraDeDecisao = (v) => (typeof v === 'string' && PALAVRA_DE_DECISAO_RE.test(v) && !pareceSegredo(v) ? v : null);
const nomeDePerfil = (v) => (NOMES_DE_PERFIL.includes(v) ? v : null);
/** Identificador (combo, provedor) que não parece um segredo: um valor plantado com cara de chave nunca sai. */
const idSeguro = (v) => { const s = identificador(v); return s && !pareceSegredo(s) ? s : null; };
const ESTADOS_DA_ROTA_PRIVADA = ['desligada', 'incompleta', 'nao-verificada', 'validada', 'nao-validada', 'bloqueada'];
const RESULTADOS_DE_CHAMADA = ['ok', 'erro', 'fallback', 'fechado', 'bloqueado', 'recusado'];
const DECISOES = ['confirmada', 'nao-confirmada', 'verificada', 'violada', 'nao-aplicavel'];
const ORIGENS_DA_CONFIG = ['nenhuma', 'ambiente', 'arquivo', 'arquivo+ambiente', 'ambiente+arquivo'];
const dataIso = (v) => (typeof v === 'string' && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(v) ? v : null);

function contadoresDeChamadas(x) {
  return { chamadas: inteiro(x?.chamadas), ok: inteiro(x?.ok), erros: inteiro(x?.erros), fallbacks: inteiro(x?.fallbacks), fechadas: inteiro(x?.fechadas), recusadasPorPrivacidade: inteiro(x?.recusadasPorPrivacidade) };
}

/**
 * Os perfis de IA: quais estão ligados, o combo e o limite de cada um, os contadores, as últimas chamadas e o estado da rota privada. Só palavras da
 * lista, nomes de perfil/combo/provedor já filtrados e números: nunca chave, cabeçalho (nem o de autenticação nem o de decisão), prompt ou conteúdo.
 */
function secaoPerfisIa(fontes) {
  const p = fontes.perfisIa && typeof fontes.perfisIa === 'object' ? fontes.perfisIa : {};
  const rota = p.rotaPrivada && typeof p.rotaPrivada === 'object' ? p.rotaPrivada : {};
  const estadoDaRota = ESTADOS_DA_ROTA_PRIVADA.includes(rota.estado) ? rota.estado : 'desligada';
  return {
    configurado: booleano(p.configurado) === true,
    origem: ORIGENS_DA_CONFIG.includes(p.origem) ? p.origem : 'nenhuma',
    errosDeConfiguracao: (Array.isArray(p.errosDeConfiguracao) ? p.errosDeConfiguracao : []).slice(0, 20).map((e) => ({ perfil: nomeDePerfil(e?.perfil), codigo: codigo(e?.codigo) })),
    perfis: (Array.isArray(p.perfis) ? p.perfis : []).slice(0, 10).map((x) => ({
      nome: nomeDePerfil(x?.nome),
      habilitado: booleano(x?.habilitado),
      privacidade: x?.privacidade === 'privada' ? 'privada' : x?.privacidade === 'geral' ? 'geral' : null,
      combo: idSeguro(x?.combo),
      provedorDaYui: idSeguro(x?.provedorDaYui),
      provedorCadastrado: booleano(x?.provedorCadastrado),
      maxTokens: inteiroOuNull(x?.maxTokens),
      limiteEfetivo: inteiroOuNull(x?.limiteEfetivo),
      capacidadeConhecida: inteiroOuNull(x?.capacidadeConhecida),
      ...contadoresDeChamadas(x),
    })).filter((x) => x.nome),
    totais: contadoresDeChamadas(p.totais),
    ultimas: (Array.isArray(p.ultimas) ? p.ultimas : []).slice(-20).map((u) => ({
      quando: dataIso(u?.quando),
      ponto: codigo(u?.ponto),
      perfil: nomeDePerfil(u?.perfil),
      combo: idSeguro(u?.combo),
      provedorQueRespondeu: palavraDeDecisao(u?.provedor),
      estrategia: palavraDeDecisao(u?.estrategia),
      fallbackUsado: booleano(u?.fallback),
      limiteDeTokens: inteiroOuNull(u?.limiteTokens),
      latenciaMs: inteiroOuNull(u?.latenciaMs),
      resultado: RESULTADOS_DE_CHAMADA.includes(u?.resultado) ? u.resultado : null,
      decisao: DECISOES.includes(u?.decisao) ? u.decisao : null,
      motivo: codigo(u?.motivo),
    })),
    rotaPrivada: {
      estado: estadoDaRota,
      motivo: codigo(rota.motivo),
      motivos: (Array.isArray(rota.motivos) ? rota.motivos : []).slice(0, 10).map(codigo).filter(Boolean),
      formatoDefinido: booleano(rota.formatoDefinido) === true,
      sondas: inteiro(rota.sondas),
      sondasValidas: inteiro(rota.sondasOk),
      violacoes: inteiro(rota.violacoes),
      ultimaSondaHaSegundos: inteiroOuNull(rota.ultimaSondaHaSegundos),
      // o registro das falhas da sonda (decisão da Liz em 18/11/2026): as seguidas, se as sozinhas estão PAUSADAS e as últimas (só o motivo em palavra fixa e há quanto tempo)
      falhasSeguidas: inteiro(rota.falhasSeguidas),
      sondaSozinhaPausada: booleano(rota.sondaSozinhaPausada) === true,
      falhasRecentes: (Array.isArray(rota.falhasRecentes) ? rota.falhasRecentes : []).slice(0, 5).map((f) => ({ haSegundos: inteiroOuNull(f?.haSegundos), motivo: codigo(f?.motivo) })),
    },
  };
}

const ESTADOS_LOCAL_PRIVADA = ['ativa', 'em-descanso', 'sondando', 'url-invalida'];
const FALLBACKS_LOCAL_PRIVADA = ['fechar', 'nuvem'];
const TIPOS_DE_HOST = ['loopback', 'rede-privada', 'tailscale', 'nome-local'];
/**
 * A rota privada com IA local (YUI_IA_LOCAL_PRIVADA): só aparece com a chave ligada (desligada, o diagnóstico é idêntico ao de antes). Só estado, números e palavras fixas: o TIPO do
 * endereço (nunca o endereço), o nome do modelo (filtrado), quantas respostas vieram do local e quantas caíram para a cadeia, por motivo em palavra fixa. Nunca prompt nem conteúdo.
 */
function secaoIaLocalPrivada(fontes) {
  const l = fontes.iaLocalPrivada && typeof fontes.iaLocalPrivada === 'object' ? fontes.iaLocalPrivada : null;
  if (!l || !ESTADOS_LOCAL_PRIVADA.includes(l.estado)) return null;
  const motivos = {};
  for (const [k, v] of Object.entries(l.motivosDasQuedas && typeof l.motivosDasQuedas === 'object' ? l.motivosDasQuedas : {})) {
    if (MOTIVOS_LOCAL_PRIVADA.includes(k)) motivos[k] = inteiro(v);
  }
  return {
    estado: l.estado,
    fallback: FALLBACKS_LOCAL_PRIVADA.includes(l.fallback) ? l.fallback : null,
    tipoDeHost: TIPOS_DE_HOST.includes(l.tipoDeHost) ? l.tipoDeHost : null,
    modelo: idSeguro(l.modelo),
    respostasLocais: inteiro(l.respostasLocais),
    quedasParaCadeia: inteiro(l.quedasParaCadeia),
    respostasFechadas: inteiro(l.respostasFechadas),
    motivosDasQuedas: motivos,
    ultimoMotivo: MOTIVOS_LOCAL_PRIVADA.includes(l.ultimoMotivo) ? l.ultimoMotivo : null,
    ultimaLatenciaMs: inteiroOuNull(l.ultimaLatenciaMs),
    falhasSeguidas: inteiro(l.falhasSeguidas),
    descansoSegundos: inteiro(l.descansoSegundos),
  };
}

/** O motor do agente: o que foi pedido (YUI_MOTOR_AGENTE), o que está ativo (sempre o nativo) e se o pedido foi recusado. */
function secaoMotor(fontes) {
  const m = fontes.motor && typeof fontes.motor === 'object' ? fontes.motor : {};
  return {
    pedido: idSeguro(m.pedido) ?? 'nativo',
    ativo: 'nativo', // o único implementado (um pedido diferente aparece em `pedido` e `recusado`)
    recusado: booleano(m.recusado) === true,
    motivo: codigo(m.motivo),
    implementados: { nativo: true, mastra: false },
  };
}

function secaoErros(fontes) {
  const e = fontes.erros && typeof fontes.erros === 'object' ? fontes.erros : {};
  const porEtiqueta = Object.entries(e.byTag && typeof e.byTag === 'object' ? e.byTag : {})
    // a etiqueta é a palavra entre colchetes que o CÓDIGO escreve no começo da linha ([IA], [Search], [Cérebro]...): uma palavra só, começando por
    // maiúscula; qualquer outra coisa vira "outras" (tests/test-diagnostico.js confere que nenhum log de erro tem etiqueta montada com texto de fora)
    .map(([tag, n]) => [/^[A-ZÀ-Ý][A-Za-zÀ-ÿ0-9]{1,23}$/.test(tag) ? tag : 'outras', inteiro(n)])
    .reduce((acc, [tag, n]) => { acc.set(tag, (acc.get(tag) ?? 0) + n); return acc; }, new Map());
  return {
    ultimas24h: inteiro(e.errors),
    reconexoesDoDiscord24h: inteiro(e.reconnects),
    // só a ETIQUETA do módulo (ex.: "IA", "Search") e a quantidade; nunca a mensagem do erro
    porEtiqueta: [...porEtiqueta].sort((a, b) => b[1] - a[1]).slice(0, 8).map(([etiqueta, quantidade]) => ({ etiqueta, quantidade })),
  };
}

function secaoBancos(fontes) {
  const lista = Array.isArray(fontes.bancos) ? fontes.bancos.filter((b) => b && typeof b === 'object') : [];
  let resumo = null;
  try { resumo = summarizeDatabases(lista); } catch { resumo = null; }
  const motores = {};
  let bytes = 0;
  for (const b of lista) {
    const m = b.engine === 'native' ? 'nativo' : b.engine === 'sqljs' ? 'sqljs' : 'fechado';
    motores[m] = (motores[m] ?? 0) + 1;
    bytes += inteiro(b.sizes?.db) + inteiro(b.sizes?.wal) + inteiro(b.sizes?.shm);
  }
  return {
    total: lista.length,
    motores,
    tamanhoTotalMB: Math.round((bytes / 1048576) * 10) / 10,
    comAlerta: (resumo?.alertNames ?? []).slice(0, 10).map((n) => identificador(String(n))).filter(Boolean),
  };
}

function secaoCerebro(fontes) {
  const c = fontes.cerebro && typeof fontes.cerebro === 'object' ? fontes.cerebro : null;
  if (!c) return null;
  return {
    uptimeSegundos: inteiro(c.uptimeSegundos),
    backend: identificador(c.backend),
    ponteDoBot: booleano(c.ponteDoBot),
    // a conexão do cérebro com o bot (o canal local) e o Discord visto pelo bot
    botConectado: booleano(c.botConectado),
    discordOnline: booleano(c.discordOnline),
    canal: soNumeros(c.canal),
    conversa: soNumeros(c.conversa),
    pesquisa: soNumeros(c.pesquisa),
    retomadaDaPesquisa: soNumeros(c.retomada),
    comentarios: soNumeros(c.comentarios),
    lembretes: soNumeros(c.lembretes),
    travasPerdidas: inteiro(c.travasPerdidas),
  };
}

// ── O estado geral ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const MOTIVOS = Object.freeze({
  'sem-provedor-de-ia': 'Nenhum provedor de IA está disponível agora.',
  'trava-perdida': 'Uma trava de dono foi perdida: o processo parou de gravar naquele arquivo.',
  'bot-desconectado': 'O bot do Discord não está conectado ao cérebro.',
  'discord-fora': 'O Discord está desconectado.',
  'config-invalida': 'Há variáveis do .env com valor inválido (o padrão está valendo).',
  'cota-sem-disco': 'A cota de busca por hora não está sendo gravada em disco.',
  'pesquisa-indisponivel': 'A pesquisa na web está temporariamente indisponível (sem o dono da cota por hora ou sem poder gravar o registro da busca).',
  'cota-cheia': 'O teto global de buscas por hora foi atingido.',
  'pesquisas-incertas': 'Há pesquisas interrompidas ou com a busca incerta.',
  'erros-no-log': 'Muitos erros no log nas últimas 24 horas.',
  'banco-com-alerta': 'Algum banco de dados tem alerta.',
  'rota-privada-bloqueada': 'A rota privada da IA está BLOQUEADA: a conversa privada fica sem IA até a rota ser verificada de novo.',
  'rota-privada-nao-validada': 'O perfil privado da IA está declarado, mas a rota dele não está verificada: a conversa privada responde com um aviso.',
  'perfis-com-erro': 'A configuração dos perfis de IA tem erros (os perfis com erro não valem).',
  'motor-recusado': 'O motor do agente pedido não está implementado: o cérebro segue no motor nativo.',
  'ia-local-privada-fora': 'A IA local da conversa privada não está respondendo (o computador pode estar desligado ou lento): a conversa privada segue o fallback configurado (YUI_IA_LOCAL_PRIVADA_FALLBACK).',
  'ia-local-privada-url-invalida': 'A IA local da conversa privada está ligada, mas o endereço (YUI_IA_LOCAL_PRIVADA_URL) não é aceito: nada é enviado a ela.',
});

/** O estado ("ok", "atencao" ou "problema") e os motivos (códigos fixos com a frase). Só vê os números já sanitizados. */
export function avaliarEstado(d) {
  const problemas = [];
  const atencoes = [];
  if (d.ia.gatewayConfigurado && d.ia.algumDisponivel === false) problemas.push('sem-provedor-de-ia');
  if ((d.cerebro?.travasPerdidas ?? 0) > 0 || d.cotas.hora.persistencia.perdeuATrava === true) problemas.push('trava-perdida');
  if (d.cerebro && d.cerebro.botConectado === false) atencoes.push('bot-desconectado');
  if (d.cerebro && d.cerebro.discordOnline === false) atencoes.push('discord-fora');
  if (d.avisosDeConfiguracao.length) atencoes.push('config-invalida');
  const p = d.cotas.hora.persistencia;
  // a cota em disco deveria estar gravando: com a chave desligada de propósito (YUI_COTA_HORA_DISCO=false) ou no bot separado, não é problema
  if (p.gravando === false && p.aguardandoTrava === true) atencoes.push('cota-sem-disco');
  // a pesquisa NÃO sai: sem a trava do arquivo da cota (esperando, de outro processo vivo, perdida, com erro) ou com o registro que não grava (a cota por
  // hora ou o diário da retomada). No bot separado a pesquisa vai ao cérebro (não conta); com a cota desligada de propósito a pesquisa segue saindo.
  if ((p.pesquisaDisponivel === false && p.motivo !== 'bot-separado') || p.gravacaoComFalha === true || d.cerebro?.retomadaDaPesquisa?.gravacaoComFalha === true) atencoes.push('pesquisa-indisponivel');
  if (d.cotas.hora.global.cheia === true) atencoes.push('cota-cheia');
  // etapa 9: os perfis de IA e o motor do agente
  const rotaPrivada = d.perfisDeIa?.rotaPrivada?.estado;
  if (rotaPrivada === 'bloqueada') problemas.push('rota-privada-bloqueada');
  else if (rotaPrivada === 'incompleta' || rotaPrivada === 'nao-validada' || rotaPrivada === 'nao-verificada') atencoes.push('rota-privada-nao-validada');
  if ((d.perfisDeIa?.errosDeConfiguracao?.length ?? 0) > 0) atencoes.push('perfis-com-erro');
  if (d.motorAgente?.recusado === true) atencoes.push('motor-recusado');
  if (d.iaLocalPrivada?.estado === 'url-invalida') problemas.push('ia-local-privada-url-invalida');
  else if (d.iaLocalPrivada?.estado === 'em-descanso') atencoes.push('ia-local-privada-fora');
  const r = d.cerebro?.retomadaDaPesquisa;
  if (r && (inteiro(r.interrompidas) > 0 || inteiro(r.porEstado?.uncertain) > 0)) atencoes.push('pesquisas-incertas');
  if (d.erros.ultimas24h >= 20) atencoes.push('erros-no-log');
  if (d.bancos.comAlerta.length) atencoes.push('banco-com-alerta');
  const motivos = [...problemas, ...atencoes].map((c) => ({ codigo: c, texto: MOTIVOS[c] }));
  return { estado: problemas.length ? 'problema' : atencoes.length ? 'atencao' : 'ok', motivos };
}

// ── As fontes de verdade (Core; o cérebro acrescenta a dele) ─────────────────────────────────────────────────────────────────────────
const seguro = (fn, padrao = null) => { try { return fn(); } catch { return padrao; } };

// A leitura dos logs (as últimas linhas de até 4 arquivos, no HD do notebook) é a parte cara do diagnóstico: o resultado vale 60 s, então um app que
// consulta a cada 30 s não faz o disco trabalhar a cada vez. Só as contagens ficam guardadas (nunca texto de log).
const VALIDADE_ERROS_MS = 60_000;
let memoErros = { em: 0, pasta: '', valor: null };

/** As fontes padrão do Core, lidas deste processo. Cada uma pode falhar sem derrubar o diagnóstico (a seção sai vazia). */
export function fontesPadrao(env = process.env) {
  return {
    processo: () => ({ uptimeSegundos: Math.round(process.uptime()), memoriaMB: Math.round(process.memoryUsage().rss / 1048576) }),
    backends: () => ai.listBackends(),
    gateway: () => { const g = getGateway(env); return { status: g.status(), algumDisponivel: g.anyAvailable() }; },
    limites: () => {
      const { providers } = loadProviders(env);
      return {
        teto: tetoGlobal(env),
        discord: tabelaDeLimites(providers, env),
        app: providers.map((p) => ({ provedor: p.id, ...limiteDoApp(p.id, { env, capacidadeDeclarada: p.maxTokens ?? null }) })),
        erro: ajustesDoCerebro(env).erro,
      };
    },
    cota: () => {
      const b = getDefaultBudget();
      const g = b.globalStatus(env);
      return {
        global: { usadas: g.used, limite: g.limit, cheia: g.full, liberaEmSegundos: Math.ceil(g.retryAfterMs / 1000) },
        porPessoaLimite: userLimitPerHour(env),
        hora: b.hourlyStats(),
        dono: estadoDaCotaHora(),
        mes: activeProviders(env).map((p) => ({ provedor: p, usadas: b.used(p), teto: monthlyCap(p, env) })),
      };
    },
    avisos: () => diagnosticoDosLimites(env),
    erros: () => {
      const pasta = env.YUI_LOG_DIR || path.resolve('logs');
      if (memoErros.valor && memoErros.pasta === pasta && Date.now() - memoErros.em < VALIDADE_ERROS_MS) return memoErros.valor;
      const valor = readLogStats({ logDir: pasta });
      memoErros = { em: Date.now(), pasta, valor };
      return valor;
    },
    bancos: () => database.databaseStats(),
    // etapa 9: os perfis de IA (contadores e o estado da rota privada) e o motor do agente escolhido por este processo
    perfisIa: () => estadoDosPerfis(env),
    motor: () => estadoDoMotor(),
    // a rota privada com IA local: o estado só vira seção do diagnóstico com a chave ligada (secaoIaLocalPrivada)
    iaLocalPrivada: () => { const l = diagnosticoLocalPrivada({ env }); return l.estado === 'desligada' ? null : l; },
  };
}

/**
 * Monta o diagnóstico. Tudo injetável para teste: `fontes` (sobrepõe as do Core; o cérebro passa a dele em `cerebro`).
 * @param {{ modo?: 'unico'|'cerebro-separado', fontes?: object, now?: () => number, env?: object }} [o]
 */
export function montarDiagnostico({ modo = 'unico', fontes = {}, now = Date.now, env = process.env } = {}) {
  const base = fontesPadrao(env);
  const f = {};
  for (const nome of new Set([...Object.keys(base), ...Object.keys(fontes)])) {
    const fn = Object.hasOwn(fontes, nome) ? fontes[nome] : base[nome];
    f[nome] = typeof fn === 'function' ? seguro(fn) : fn ?? null;
  }
  const agora = now();
  const avisos = (Array.isArray(f.avisos) ? f.avisos : []).slice(0, 10).map((a) => ({
    variavel: VARIAVEL_RE.test(String(a?.variavel ?? '')) ? String(a.variavel) : null,
    problema: rotulo(a?.problema, 160),
    usando: typeof a?.usando === 'number' ? a.usando : rotulo(a?.usando, 80),
  })).filter((a) => a.variavel);
  const d = {
    versao: VERSAO_DIAGNOSTICO,
    geradoEm: new Date(agora).toISOString(),
    modo: modo === 'cerebro-separado' ? 'cerebro-separado' : 'unico',
    estado: 'ok',
    motivos: [],
    processo: { uptimeSegundos: inteiro(f.processo?.uptimeSegundos), memoriaMB: inteiro(f.processo?.memoriaMB) },
    cerebro: secaoCerebro(f),
    ia: secaoIa(f),
    limitesDeTokens: secaoLimites(f, modo),
    cotasDeBusca: secaoCotas(f),
    avisosDeConfiguracao: avisos,
    erros: secaoErros(f),
    bancos: secaoBancos(f),
    perfisDeIa: secaoPerfisIa(f),
    motorAgente: secaoMotor(f),
    ...(secaoIaLocalPrivada(f) ? { iaLocalPrivada: secaoIaLocalPrivada(f) } : {}),
  };
  // `d.cotas` é o nome curto que o avaliarEstado lê; o nome público da seção é `cotasDeBusca`
  const { estado, motivos } = avaliarEstado({ ...d, cotas: d.cotasDeBusca });
  d.estado = estado;
  d.motivos = motivos;
  return d;
}
