// A ROTA PRIVADA COM IA LOCAL: as chamadas de IA PRIVADAS (conversa privada do dono em DM ou canal privado, memória pessoal, dados do Google, texto de anexo: tudo
// que a Yui já marca como `sensitive`) tentam PRIMEIRO um modelo pequeno que roda num computador do dono (LM Studio, Ollama, llama.cpp... qualquer servidor compatível
// com a API da OpenAI). Se o computador estiver desligado, dormindo ou lento, vale o FALLBACK (YUI_IA_LOCAL_PRIVADA_FALLBACK): `fechar` (padrão do código: a conversa privada NÃO vai a
// nenhum provedor da cadeia e a pessoa lê uma frase fixa) ou `nuvem` (a MESMA chamada cai para a cadeia de provedores de sempre, sem erro visível; a nuvem é a reserva e isso NÃO é
// privacidade total). Chamada PÚBLICA nunca passa por aqui. O computador com o modelo é uma DEPENDÊNCIA EXTERNA: a Yui nunca presume que ele está no ar (prazos, disjuntor, sondagem).
//
// DESLIGADO por padrão: sem YUI_IA_LOCAL_PRIVADA=on nada aqui toca a rede nem muda um byte do que a Yui manda a qualquer provedor. As chaves são lidas A CADA USO (nunca no
// import). Este módulo é independente do perfil `privado` do OmniRoute (core/ai/rotaPerfil.js) e do perfil `local` reservado (core/ai/local.js): não os liga nem os desliga.
//
// Desenho:
//  - UM ponto de encaixe por modo de execução, sempre ANTES da cadeia: o llmHandler (processo único: um provedor "local-privada" à frente da lista, só em chamada
//    sensitive) e o AI Manager (app e cérebro separado: antes do perfil e do backend). O backend "legacy-chain" já passa pelo llmHandler, então o Manager não repete;
//  - a decisão de "privada" vem de quem monta a chamada a partir dos FATOS (o cérebro: memoryScope pessoal, texto de anexo), nunca de uma afirmação do bot;
//  - o endereço é validado na leitura da chave: só http(s) para IP privado, loopback, CGNAT do Tailscale, nome `.ts.net` ou `.local`, sem usuário, senha, parâmetros nem
//    redirecionamento. O conteúdo privado NUNCA vai a outro endereço;
//  - falha de conexão, prazo, HTTP de erro, resposta vazia, só "raciocínio" ou JSON de ferramenta quebrado = a chamada cai para a cadeia (a resposta local só é entregue se
//    inteira e válida: nada de pedaço), e o DISJUNTOR segura o local por um tempo crescente depois de várias falhas seguidas (uma sondagem leve o reabilita);
//  - o modelo tem contexto pequeno (teto de 4096 tokens): menos histórico e, se preciso, sem a memória; sem caber, vai para a cadeia. O modelo NÃO recebe ferramentas
//    nativas: o fluxo de ferramentas por JSON em texto da Yui continua valendo, com uma lista COMPACTA das ferramentas;
//  - observabilidade sem vazamento: o log e o diagnóstico levam só metadados (qual rota respondeu, latência, o motivo da queda em palavra fixa, o TIPO do endereço), nunca o
//    conteúdo, o prompt, o modelo da resposta nem o endereço.
import http from 'node:http';
import https from 'node:https';
import { logger } from '../../utils/logger.js';
import { stripThinking } from './limpezaResposta.js';
import { extractFirstJsonObject } from './llmSafety.js';
import { alertOwner } from '../alerts.js';

export const VAR_LIGADA = 'YUI_IA_LOCAL_PRIVADA';
export const VAR_URL = 'YUI_IA_LOCAL_PRIVADA_URL';
export const VAR_MODELO = 'YUI_IA_LOCAL_PRIVADA_MODELO';
export const VAR_TIMEOUT_S = 'YUI_IA_LOCAL_PRIVADA_TIMEOUT_S';
export const VAR_MAX_TOKENS = 'YUI_IA_LOCAL_PRIVADA_MAX_TOKENS';
export const VAR_FALLBACK = 'YUI_IA_LOCAL_PRIVADA_FALLBACK';
/** Os dois valores do VAR_FALLBACK; qualquer outro (inclusive lixo) vale `fechar`, o lado seguro. */
export const FALLBACKS = Object.freeze(['fechar', 'nuvem']);
export const FALLBACK_PADRAO = 'fechar';
/**
 * As frases FIXAS que a pessoa lê quando o fallback é `fechar` e o local não atendeu (nenhum conteúdo, nenhum detalhe técnico). Começam por "🔒 Rota privada de IA" para as marcas de resposta de
 * sistema do bot (isSystemReply, isErrorReply) as reconhecerem: não entram no contexto como fala da Yui.
 */
export const TEXTO_ROTA_PRIVADA_FORA = '🔒 Rota privada de IA fora do ar agora: não mandei sua conversa a nenhum outro provedor. Tente de novo daqui a pouco.';
export const TEXTO_ROTA_PRIVADA_GRANDE = '🔒 Rota privada de IA: a mensagem é grande demais para o modelo local e não mandei nada a nenhum outro provedor. Mande um trecho menor.';

/**
 * O erro do fallback `fechar` (o mesmo desenho da falha fechada do perfil privado: `code` PERFIL_FECHADO, que a conversa do cérebro e a API do app já tratam mostrando só a `mensagemCurta`).
 * Nada foi enviado a nenhum provedor da cadeia.
 */
export class ErroRotaLocalFechada extends Error {
  constructor(motivo) {
    super(`rota privada local fechada (${MOTIVOS.includes(motivo) ? motivo : 'outro'})`);
    this.name = 'ErroRotaLocalFechada';
    this.code = 'PERFIL_FECHADO';
    this.fechado = true;
    this.perfil = 'local-privada';
    this.motivo = MOTIVOS.includes(motivo) ? motivo : 'outro';
    this.mensagemCurta = motivo === 'grande-demais' ? TEXTO_ROTA_PRIVADA_GRANDE : TEXTO_ROTA_PRIVADA_FORA;
  }
}

export const MODELO_PADRAO = 'granite-4.0-micro';
export const TIMEOUT_PADRAO_S = 20;
export const TIMEOUT_MIN_S = 2;
export const TIMEOUT_MAX_S = 120;
/** Quanto a Yui espera o computador ATENDER a conexão (ligado e na rede) antes de desistir. */
export const CONEXAO_MS = 3000;
export const MAX_TOKENS_PADRAO = 768;
export const MAX_TOKENS_MIN = 64;
export const MAX_TOKENS_MAX = 2048;
/** O teto de contexto do modelo local (pedido + resposta). Constante de propósito: o modelo escolhido é pequeno. */
export const CONTEXTO_MAX_TOKENS = 4096;
const MARGEM_TOKENS = 160;
/** A estimativa de tokens é por caracteres (conservadora para o português: 3 caracteres por token) mais um custo fixo por mensagem. */
const CARACTERES_POR_TOKEN = 3;
const TOKENS_POR_MENSAGEM = 8;
export const RESPOSTA_MAX_BYTES = 512 * 1024;
/** Quantas falhas SEGUIDAS abrem o disjuntor, e o descanso crescente (30 s, 1 min, 2 min, 4 min, 8 min e o teto de 10 min). */
export const FALHAS_PARA_ABRIR = 3;
export const DESCANSO_BASE_MS = 30_000;
export const DESCANSO_MAX_MS = 600_000;
/** Faltando menos que isto para o prazo da pesquisa, nem tenta o local. */
const PRAZO_MINIMO_MS = 1500;

/** Os motivos (palavras fixas) pelos quais uma chamada vai para a cadeia: tudo o que o log e o diagnóstico podem dizer. */
export const MOTIVOS = Object.freeze([
  'desligada', 'url-invalida', 'descanso', 'prazo', 'grande-demais',
  'recusada', 'inalcancavel', 'conexao-timeout', 'timeout', 'rede', 'resposta-grande',
  'http-erro', 'json-invalido', 'formato-invalido', 'vazia', 'so-raciocinio', 'json-quebrado', 'json-desconhecido', 'ferramenta-nao-oferecida',
  'outro',
]);
/** Estes motivos NÃO contam como falha do computador local (o pedido não foi enviado ou não coube). */
const MOTIVOS_SEM_FALHA = new Set(['desligada', 'url-invalida', 'descanso', 'prazo', 'grande-demais']);

// ── A configuração (lida a cada uso) ────────────────────────────────────────────────────────────────────────────────────────────────

const inteiroNoIntervalo = (valor, min, max, padrao) => {
  const n = Number.parseInt(String(valor ?? '').trim(), 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : padrao;
};

/** A chave está em `on`? Só `on` (e `true`, `1`, `sim`) liga; qualquer outro valor, inclusive lixo, deixa desligado. */
export function chaveLigada(env = process.env) {
  return ['on', 'true', '1', 'sim'].includes(String(env?.[VAR_LIGADA] ?? '').trim().toLowerCase());
}

/**
 * O endereço é aceito? Só http(s) para a própria máquina ou a rede local do dono: IPv4 de loopback (127.x), privado (10.x, 172.16 a 31.x, 192.168.x), CGNAT do Tailscale
 * (100.64 a 127.x), `localhost`, `::1`, ou um nome `.ts.net` (MagicDNS) ou `.local`. Sem usuário, senha, parâmetros nem âncora. Qualquer outra coisa é recusada.
 * @returns {{ ok: true, base: string, tipoDeHost: 'loopback'|'rede-privada'|'tailscale'|'nome-local' } | { ok: false, codigo: string }}
 */
export function validarUrlLocalPrivada(url) {
  let u;
  try { u = new URL(String(url ?? '').trim()); } catch { return { ok: false, codigo: 'url-invalida' }; }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') return { ok: false, codigo: 'protocolo-nao-permitido' };
  if (u.username || u.password) return { ok: false, codigo: 'credencial-na-url' };
  if (u.search || u.hash) return { ok: false, codigo: 'parametros-na-url' };
  const tipo = tipoDoHost(u.hostname);
  if (!tipo) return { ok: false, codigo: 'endereco-nao-privado' };
  const caminho = u.pathname.replace(/\/+$/, '');
  if (caminho && !/^\/[\w./-]{0,100}$/.test(caminho)) return { ok: false, codigo: 'url-invalida' };
  return { ok: true, base: `${u.origin}${caminho || '/v1'}`, tipoDeHost: tipo };
}

function tipoDoHost(hostname) {
  const h = String(hostname ?? '').toLowerCase().replace(/^\[|\]$/g, '').replace(/\.$/, '');
  if (!h) return null;
  if (h === 'localhost' || h === '::1') return 'loopback';
  const m = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(h);
  if (m) {
    const [a, b, c, d] = m.slice(1).map(Number);
    if ([a, b, c, d].some((n) => n > 255)) return null;
    if (a === 127) return 'loopback';
    if (a === 100 && b >= 64 && b <= 127) return 'tailscale';
    if (a === 10 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168)) return 'rede-privada';
    return null;
  }
  // nomes: só os dois sufixos de rede local conhecidos, com pelo menos um rótulo antes (um nome comum pode apontar para fora)
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.ts\.net$/.test(h)) return 'tailscale';
  if (/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*\.local$/.test(h)) return 'nome-local';
  return null;
}

/**
 * A configuração da rota, lida AGORA do ambiente.
 * @returns {{ ligada: boolean, motivo: 'desligada'|'url-invalida'|null, base: string|null, tipoDeHost: string|null, modelo: string, timeoutMs: number, conexaoMs: number, maxTokens: number, fallback: 'fechar'|'nuvem' }}
 */
export function lerConfigLocalPrivada(env = process.env) {
  const modeloBruto = String(env?.[VAR_MODELO] ?? '').trim();
  const modelo = /^[\w.:/@+-]{1,120}$/.test(modeloBruto) ? modeloBruto : MODELO_PADRAO;
  const timeoutMs = inteiroNoIntervalo(env?.[VAR_TIMEOUT_S], TIMEOUT_MIN_S, TIMEOUT_MAX_S, TIMEOUT_PADRAO_S) * 1000;
  const maxTokens = inteiroNoIntervalo(env?.[VAR_MAX_TOKENS], MAX_TOKENS_MIN, MAX_TOKENS_MAX, MAX_TOKENS_PADRAO);
  const fallback = String(env?.[VAR_FALLBACK] ?? '').trim().toLowerCase() === 'nuvem' ? 'nuvem' : FALLBACK_PADRAO;
  const base = { modelo, timeoutMs, conexaoMs: Math.min(CONEXAO_MS, timeoutMs), maxTokens: Math.min(maxTokens, CONTEXTO_MAX_TOKENS - 1024), fallback };
  if (!chaveLigada(env)) return { ligada: false, motivo: 'desligada', base: null, tipoDeHost: null, ...base };
  const v = validarUrlLocalPrivada(env?.[VAR_URL]);
  if (!v.ok) return { ligada: false, motivo: 'url-invalida', base: null, tipoDeHost: null, ...base };
  return { ligada: true, motivo: null, base: v.base, tipoDeHost: v.tipoDeHost, ...base };
}

/**
 * A rota foi LIGADA pelo dono (YUI_IA_LOCAL_PRIVADA=on)? É a pergunta barata que quem chama faz antes de montar qualquer coisa para o local. Nunca lança nem toca a rede. Ligada com um endereço
 * recusado conta como ligada: a chamada então segue o fallback (com `fechar`, nada vai à nuvem por causa de um erro de configuração).
 */
export function localPrivadaLigada(env = process.env) {
  try { return chaveLigada(env); } catch { return false; }
}

/** O fallback em vigor, lido agora: `fechar` (padrão) ou `nuvem`. */
export function fallbackLocalPrivada(env = process.env) {
  try { return lerConfigLocalPrivada(env).fallback; } catch { return FALLBACK_PADRAO; }
}

// ── O contexto pequeno: o que cabe em 4096 tokens ───────────────────────────────────────────────────────────────────────────────────

const estimar = (texto) => Math.ceil(String(texto ?? '').length / CARACTERES_POR_TOKEN) + TOKENS_POR_MENSAGEM;

/**
 * Monta as mensagens que cabem no contexto do modelo local. Corta o histórico pelo MAIS ANTIGO; se o sistema completo (persona, memória) ainda não cabe com o pedido,
 * tenta `sistemaLeve` (sem a memória); se nada couber, devolve `grande-demais` (a chamada vai para a cadeia). Nunca estoura o teto.
 * @returns {{ ok: true, messages: Array<{role: string, content: string}>, reducao: null|'historico'|'sem-memoria', tokens: number } | { ok: false, motivo: 'grande-demais' }}
 */
export function montarMensagensLocais({ system, sistemaLeve = null, history = [], prompt, maxTokens = MAX_TOKENS_PADRAO }) {
  const orcamento = CONTEXTO_MAX_TOKENS - maxTokens - MARGEM_TOKENS;
  const turnos = (Array.isArray(history) ? history : [])
    .filter((m) => m && (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim())
    .map((m) => ({ role: m.role, content: m.content }));
  const encaixar = (sistema) => {
    const fixo = estimar(sistema) + estimar(prompt);
    if (fixo > orcamento) return null;
    let gasto = fixo;
    const mantidos = [];
    for (let i = turnos.length - 1; i >= 0; i--) {
      const custo = estimar(turnos[i].content);
      if (gasto + custo > orcamento) break;
      gasto += custo;
      mantidos.unshift(turnos[i]);
    }
    while (mantidos.length && mantidos[0].role !== 'user') { gasto -= estimar(mantidos[0].content); mantidos.shift(); } // o histórico começa na fala da pessoa
    return { mantidos, gasto };
  };
  const monta = (sistema, r, reducao) => ({
    ok: true,
    messages: [{ role: 'system', content: String(sistema ?? '') }, ...r.mantidos, { role: 'user', content: String(prompt ?? '') }],
    reducao: reducao ?? (r.mantidos.length < turnos.length ? 'historico' : null),
    tokens: r.gasto,
  });
  const completo = encaixar(system);
  if (completo) return monta(system, completo, null);
  if (typeof sistemaLeve === 'string' && sistemaLeve && sistemaLeve !== system) {
    const leve = encaixar(sistemaLeve);
    if (leve) return monta(sistemaLeve, leve, 'sem-memoria');
  }
  return { ok: false, motivo: 'grande-demais' };
}

// ── A resposta: só vale inteira e válida ────────────────────────────────────────────────────────────────────────────────────────────

const CHAVES_DE_RESPOSTA_JSON = ['tool', 'name', 'action', 'generate_reply', 'response', 'reply', 'content', 'text', 'resposta', 'mensagem'];

/**
 * A resposta do modelo local serve? Vazia, só com "raciocínio" ou com um JSON de ferramenta quebrado (o mesmo critério do despachante da fila: primeiro objeto JSON por
 * chaves balanceadas, que precisa ser lido) NÃO servem: a chamada cai para a cadeia. `ferramentas`: true = as ferramentas foram oferecidas; false = não foram (um JSON que chama
 * outra ferramenta que não a resposta não vale); null = não se sabe (vale qualquer JSON bem formado).
 * @returns {{ ok: true, texto: string } | { ok: false, motivo: string }}
 */
export function avaliarRespostaLocal(conteudo, { ferramentas = null } = {}) {
  const bruto = typeof conteudo === 'string' ? conteudo.trim() : '';
  if (!bruto) return { ok: false, motivo: 'vazia' };
  const depoisDoRaciocinio = bruto.includes('</think>') ? bruto.slice(bruto.lastIndexOf('</think>') + 8).trim() : bruto;
  let limpo = '';
  try { limpo = String(stripThinking(bruto) ?? '').trim(); } catch { limpo = depoisDoRaciocinio; }
  const chamadaEscrita = /default_api\.|tool_code|^print\(/i.test(depoisDoRaciocinio); // `print(default_api.x(...))`: o despachante converte
  if (!limpo && !chamadaEscrita) return { ok: false, motivo: /<think|<\/think>/i.test(bruto) ? 'so-raciocinio' : 'vazia' };
  if (limpo && !/[\p{L}\p{N}]/u.test(limpo.replace(/<\/?think>/gi, ''))) return { ok: false, motivo: 'so-raciocinio' };
  const semCerca = depoisDoRaciocinio.replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/, '').trim();
  if (semCerca.startsWith('{') || /"tool"\s*:/.test(semCerca)) {
    let objeto = null;
    try { objeto = JSON.parse(extractFirstJsonObject(semCerca)); } catch { objeto = null; }
    if (!objeto || typeof objeto !== 'object' || Array.isArray(objeto)) return { ok: false, motivo: 'json-quebrado' };
    if (!CHAVES_DE_RESPOSTA_JSON.some((k) => objeto[k])) return { ok: false, motivo: 'json-desconhecido' };
    const nome = objeto.tool ?? objeto.name ?? objeto.action;
    if (ferramentas === false && typeof nome === 'string' && nome !== 'generate_reply') return { ok: false, motivo: 'ferramenta-nao-oferecida' };
  }
  return { ok: true, texto: bruto };
}

// ── O transporte (http/https do Node: a conexão tem prazo próprio, o corpo tem limite e NENHUM redirecionamento é seguido) ──────────

function codigoDoErroDeRede(e) {
  const c = String(e?.code ?? '');
  if (c === 'ECONNREFUSED') return 'recusada';
  if (['ENOTFOUND', 'EHOSTUNREACH', 'ENETUNREACH', 'EAI_AGAIN', 'ECONNRESET'].includes(c)) return 'inalcancavel';
  return 'rede';
}

/**
 * Uma requisição ao servidor local. Resolve { status, texto } ou rejeita com `.motivo` (palavra fixa). Nunca segue redirecionamento (a resposta 3xx volta como está) e lê no
 * máximo `maxBytes`. O corpo enviado é o único lugar em que o conteúdo privado sai daqui, e o destino é só o endereço já validado.
 */
export function requisitarLocal({ url, metodo = 'GET', corpo = null, conexaoMs = CONEXAO_MS, totalMs = TIMEOUT_PADRAO_S * 1000, maxBytes = RESPOSTA_MAX_BYTES }) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch { reject(Object.assign(new Error('url'), { motivo: 'url-invalida' })); return; }
    const modulo = u.protocol === 'https:' ? https : http;
    const dados = corpo === null ? null : Buffer.from(JSON.stringify(corpo), 'utf8');
    let acabou = false;
    let timerConexao = null;
    let timerTotal = null;
    let req = null;
    const fim = (fn, valor) => {
      if (acabou) return;
      acabou = true;
      clearTimeout(timerConexao);
      clearTimeout(timerTotal);
      fn(valor);
    };
    const falhar = (motivo) => { fim(reject, Object.assign(new Error(motivo), { motivo })); try { req?.destroy(); } catch { /* já fechado */ } };
    try {
      req = modulo.request({
        hostname: u.hostname.replace(/^\[|\]$/g, ''), port: u.port || undefined, path: `${u.pathname}${u.search}`, method: metodo, agent: false,
        headers: { accept: 'application/json', ...(dados ? { 'content-type': 'application/json', 'content-length': dados.length } : {}) },
      });
    } catch { reject(Object.assign(new Error('rede'), { motivo: 'rede' })); return; }
    timerTotal = setTimeout(() => falhar('timeout'), Math.max(1, totalMs));
    timerConexao = setTimeout(() => falhar('conexao-timeout'), Math.max(1, conexaoMs));
    req.on('socket', (socket) => {
      if (socket.connecting) socket.once('connect', () => clearTimeout(timerConexao));
      else clearTimeout(timerConexao);
    });
    req.on('error', (e) => falhar(codigoDoErroDeRede(e)));
    req.on('response', (res) => {
      clearTimeout(timerConexao);
      const partes = [];
      let total = 0;
      res.on('data', (parte) => {
        total += parte.length;
        if (total > maxBytes) { falhar('resposta-grande'); return; }
        partes.push(parte);
      });
      res.on('end', () => fim(resolve, { status: res.statusCode ?? 0, texto: Buffer.concat(partes).toString('utf8') }));
      res.on('error', (e) => falhar(codigoDoErroDeRede(e)));
      res.on('aborted', () => falhar('rede'));
    });
    if (dados) req.write(dados);
    req.end();
  });
}

// ── O disjuntor ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** O descanso (ms) depois de abrir pela N-ésima vez seguida: 30 s dobrando até 10 min. */
export const descansoDoNivel = (nivel) => Math.min(DESCANSO_MAX_MS, DESCANSO_BASE_MS * 2 ** Math.max(0, nivel));

/**
 * Cria o disjuntor (um só por processo na prática; criado à parte para o teste). Depois de FALHAS_PARA_ABRIR falhas seguidas o local fica em descanso, por um tempo crescente;
 * passado o descanso, UMA sondagem leve (GET /models) roda em segundo plano (a conversa nunca espera por ela): se responder, o local volta; se não, novo descanso, maior.
 */
export function criarDisjuntor({ agora = Date.now } = {}) {
  const e = { falhasSeguidas: 0, nivel: 0, ate: 0, sondando: null, chave: null, ultimoMotivo: null };
  const reinicia = () => { e.falhasSeguidas = 0; e.nivel = 0; e.ate = 0; };
  const abre = (motivo) => {
    const descanso = descansoDoNivel(e.nivel);
    e.ate = agora() + descanso;
    e.nivel = Math.min(e.nivel + 1, 20);
    logger.warn(`[IA-local-privada] disjuntor aberto: o local descansa ${Math.round(descanso / 1000)}s (último motivo: ${motivo}).`);
  };
  return {
    /** O local pode ser tentado agora? 'descanso' = não (e, vencido o descanso, a sondagem sai em segundo plano). */
    permitir({ cfg, requisitar = requisitarLocal }) {
      const chave = `${cfg.base}|${cfg.modelo}`;
      if (e.chave !== null && e.chave !== chave) reinicia(); // outro endereço ou modelo: o estado do antigo não vale
      e.chave = chave;
      if (!e.ate) return { ok: true };
      if (agora() < e.ate) return { ok: false, motivo: 'descanso' };
      if (!e.sondando) {
        e.sondando = (async () => {
          try {
            const r = await requisitar({ url: `${cfg.base}/models`, conexaoMs: cfg.conexaoMs, totalMs: cfg.conexaoMs });
            let bom = r.status === 200;
            if (bom) { try { bom = Array.isArray(JSON.parse(r.texto)?.data); } catch { bom = false; } }
            if (bom) { reinicia(); logger.info('[IA-local-privada] a sondagem respondeu: o local voltou.'); } else abre('sondagem');
          } catch { abre('sondagem'); } finally { e.sondando = null; }
        })();
      }
      return { ok: false, motivo: 'descanso' };
    },
    sucesso() { e.falhasSeguidas = 0; if (e.ate) reinicia(); },
    falha(motivo) {
      e.ultimoMotivo = motivo;
      e.falhasSeguidas += 1;
      if (e.falhasSeguidas >= FALHAS_PARA_ABRIR && !e.ate) abre(motivo);
    },
    /** A sondagem em andamento (para o teste esperar por ela). */
    sondagem() { return e.sondando; },
    estado() {
      const restante = e.ate ? Math.max(0, e.ate - agora()) : 0;
      return { falhasSeguidas: e.falhasSeguidas, aberto: e.ate > 0, descansoSegundos: Math.ceil(restante / 1000), sondando: e.sondando !== null };
    },
    reiniciar: reinicia,
  };
}

const disjuntorPadrao = criarDisjuntor();
export const disjuntorDoProcesso = () => disjuntorPadrao;

// ── Contadores (só números e palavras fixas, para o diagnóstico) ────────────────────────────────────────────────────────────────────

const contadores = { local: 0, cadeia: 0, fechadas: 0, porMotivo: {}, ultimaLatenciaMs: null, ultimoMotivo: null };
function contarLocal(ms) { contadores.local += 1; contadores.ultimaLatenciaMs = ms; }
function contarQueda(motivo, fechada) {
  if (fechada) contadores.fechadas += 1; else contadores.cadeia += 1;
  contadores.porMotivo[motivo] = (contadores.porMotivo[motivo] ?? 0) + 1;
  contadores.ultimoMotivo = motivo;
}
/** Zera os contadores (teste). */
export function zerarContadoresLocalPrivada() {
  contadores.local = 0; contadores.cadeia = 0; contadores.fechadas = 0; contadores.porMotivo = {}; contadores.ultimaLatenciaMs = null; contadores.ultimoMotivo = null;
}

/**
 * O que o diagnóstico mostra: só estado, números e palavras fixas. Nunca o endereço (só o TIPO dele), o prompt ou o conteúdo de qualquer resposta.
 * @returns {{ estado: 'desligada'|'url-invalida'|'ativa'|'em-descanso'|'sondando', fallback: 'fechar'|'nuvem'|null, tipoDeHost: string|null, modelo: string|null, respostasLocais: number, quedasParaCadeia: number,
 *             respostasFechadas: number, motivosDasQuedas: Record<string, number>, ultimoMotivo: string|null, ultimaLatenciaMs: number|null, falhasSeguidas: number, descansoSegundos: number }}
 */
export function diagnosticoLocalPrivada({ env = process.env, disjuntor = disjuntorPadrao } = {}) {
  let cfg;
  try { cfg = lerConfigLocalPrivada(env); } catch { cfg = { ligada: false, motivo: 'desligada', tipoDeHost: null, modelo: MODELO_PADRAO, fallback: FALLBACK_PADRAO }; }
  const d = disjuntor.estado();
  const estado = !cfg.ligada ? (cfg.motivo === 'url-invalida' ? 'url-invalida' : 'desligada') : d.sondando ? 'sondando' : d.aberto ? 'em-descanso' : 'ativa';
  return {
    estado,
    fallback: estado === 'desligada' ? null : cfg.fallback,
    tipoDeHost: cfg.ligada ? cfg.tipoDeHost : null,
    modelo: cfg.ligada ? cfg.modelo : null,
    respostasLocais: contadores.local,
    quedasParaCadeia: contadores.cadeia,
    respostasFechadas: contadores.fechadas,
    motivosDasQuedas: Object.fromEntries(Object.entries(contadores.porMotivo).filter(([k]) => MOTIVOS.includes(k))),
    ultimoMotivo: MOTIVOS.includes(contadores.ultimoMotivo) ? contadores.ultimoMotivo : null,
    ultimaLatenciaMs: contadores.ultimaLatenciaMs,
    falhasSeguidas: d.falhasSeguidas,
    descansoSegundos: d.descansoSegundos,
  };
}

// ── A chamada ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

const avisados = new Set();
function avisarUmaVez(chave, texto) {
  if (avisados.has(chave)) return;
  avisados.add(chave);
  logger.warn(texto);
}

const motivoDoTransporte = (m) => (MOTIVOS.includes(m) ? m : 'outro');

/**
 * Tenta responder pelo modelo local. NUNCA lança e nunca devolve um pedaço: ou `{ ok: true, texto, ... }` com a resposta inteira e válida, ou `{ ok: false, motivo, fechar }`. Com `fechar: false`
 * (fallback `nuvem`, ou rota desligada) quem chamou segue pela cadeia de hoje (a MESMA chamada, sem repetir nada ao usuário); com `fechar: true` (fallback `fechar`, o padrão) a chamada NÃO
 * vai a nenhum provedor: quem chamou responde a frase fixa (TEXTO_ROTA_PRIVADA_FORA / _GRANDE).
 * @param {{ system: string, sistemaLeve?: string|null, history?: Array<{role: string, content: string}>, prompt: string, ferramentas?: boolean|null, deadlineAt?: number|null }} p
 * @param {{ env?: object, agora?: () => number, requisitar?: typeof requisitarLocal, disjuntor?: ReturnType<typeof criarDisjuntor>, alertar?: Function }} [deps]  tudo injetável para o teste
 * @returns {Promise<{ ok: true, texto: string, modelo: string, ms: number, finishReason: string|null, reducao: string|null } | { ok: false, motivo: string, fechar: boolean }>}
 */
export async function chamarLocalPrivada(p, { env = process.env, agora = Date.now, requisitar = requisitarLocal, disjuntor = disjuntorPadrao, alertar = alertOwner } = {}) {
  let cfg;
  try { cfg = lerConfigLocalPrivada(env); } catch { return { ok: false, motivo: 'desligada', fechar: false }; }
  if (cfg.motivo === 'desligada') return { ok: false, motivo: 'desligada', fechar: false };
  const fechar = cfg.fallback === 'fechar';
  const cai = (motivo, ms = 0) => {
    const m = motivoDoTransporte(motivo);
    contarQueda(m, fechar);
    const rota = fechar ? 'fechada' : 'cadeia';
    if (m === 'descanso') logger.debug?.(`[IA-local-privada] rota=${rota} motivo=${m}`);
    else logger.info(`[IA-local-privada] rota=${rota} motivo=${m} ms=${ms} host=${cfg.tipoDeHost ?? 'invalido'}`);
    // com `fechar` a conversa privada fica sem IA enquanto o computador não volta: o dono é avisado (só a palavra do motivo; limite de repetição do alerta)
    if (fechar && m !== 'grande-demais') {
      try { alertar('ia-local-privada-fora', 'A rota privada de IA está fora do ar', `motivo: ${m}. Com YUI_IA_LOCAL_PRIVADA_FALLBACK=fechar a conversa privada responde um aviso até o computador voltar.`, { level: 'warn', cooldownMinutes: 30 }); } catch { /* o aviso nunca atrapalha */ }
    }
    return { ok: false, motivo: m, fechar };
  };
  if (!cfg.ligada) {
    if (cfg.motivo === 'url-invalida') avisarUmaVez('url', '[IA-local-privada] ligada, mas o endereço (YUI_IA_LOCAL_PRIVADA_URL) não é aceito (só IP privado, loopback, Tailscale, .ts.net ou .local, sem usuário, senha ou parâmetros): a rota não recebe nada.');
    return cai('url-invalida');
  }
  try {
    const liberado = disjuntor.permitir({ cfg, requisitar });
    if (!liberado.ok) return cai(liberado.motivo);
    const restante = Number.isFinite(p?.deadlineAt) ? Number(p.deadlineAt) - agora() : Infinity;
    if (restante < PRAZO_MINIMO_MS) return cai('prazo');
    const montado = montarMensagensLocais({ system: p?.system, sistemaLeve: p?.sistemaLeve ?? null, history: p?.history ?? [], prompt: p?.prompt, maxTokens: cfg.maxTokens });
    if (!montado.ok) return cai(montado.motivo);
    const inicio = agora();
    const totalMs = Math.min(cfg.timeoutMs, restante);
    let resposta;
    try {
      resposta = await requisitar({
        url: `${cfg.base}/chat/completions`, metodo: 'POST', conexaoMs: Math.min(cfg.conexaoMs, totalMs), totalMs,
        corpo: { model: cfg.modelo, messages: montado.messages, temperature: 0.7, max_tokens: cfg.maxTokens, stream: false },
      });
    } catch (e) {
      const motivo = motivoDoTransporte(e?.motivo);
      disjuntor.falha(motivo);
      return cai(motivo, agora() - inicio);
    }
    const ms = agora() - inicio;
    const falha = (motivo) => { disjuntor.falha(motivo); return cai(motivo, ms); };
    if (resposta.status < 200 || resposta.status >= 300) return falha('http-erro');
    let json;
    try { json = JSON.parse(resposta.texto); } catch { return falha('json-invalido'); }
    const escolha = json?.choices?.[0];
    if (!escolha || typeof escolha !== 'object') return falha('formato-invalido');
    const conteudo = typeof escolha.message?.content === 'string' ? escolha.message.content : '';
    if (!conteudo.trim() && typeof escolha.message?.reasoning_content === 'string' && escolha.message.reasoning_content.trim()) return falha('so-raciocinio');
    const aval = avaliarRespostaLocal(conteudo, { ferramentas: p?.ferramentas ?? null });
    if (!aval.ok) return falha(aval.motivo);
    disjuntor.sucesso();
    contarLocal(ms);
    logger.info(`[IA-local-privada] rota=local-privada ms=${ms} host=${cfg.tipoDeHost}${montado.reducao ? ` contexto=${montado.reducao}` : ''}`);
    return { ok: true, texto: aval.texto, modelo: cfg.modelo, ms, finishReason: typeof escolha.finish_reason === 'string' ? escolha.finish_reason : null, reducao: montado.reducao };
  } catch {
    // o que nunca deveria acontecer: a chamada segue pela cadeia, sem ruído
    return cai('outro');
  }
}
