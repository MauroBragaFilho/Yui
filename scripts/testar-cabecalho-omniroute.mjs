#!/usr/bin/env node
// TESTE REAL DO CABEÇALHO `X-OmniRoute-Decision` (etapa 13). Roda no PC de quem opera a Yui, contra um OmniRoute de verdade, com um combo e uma chave DE TESTE.
//
// Para que serve: o perfil de IA `privado` da Yui só liga se, em cada resposta, o OmniRoute disser QUAL provedor atendeu (o cabeçalho `X-OmniRoute-Decision`), e se
// a Yui conseguir ler esse nome com o leitor ESTRITO (src/core/ai/decisaoOmniRoute.js). Este script faz UMA chamada mínima, lê o cabeçalho do jeito que a Yui o lê e
// diz, em palavras claras, se o cabeçalho nomeia UM provedor e se ele está na lista de permitidos. Não altera nada no OmniRoute nem na Yui.
//
// A chave vem SÓ da variável de ambiente OMNIROUTE_KEY: nunca por argumento (ficaria no histórico do terminal), e nunca é impressa. Toda a saída passa por um filtro que
// apaga a chave e qualquer coisa com cara de segredo. Nada do que o servidor devolve (corpo da resposta, texto de erro) é impresso: só o status, os nomes e os números.
//
// Uso:      node scripts/testar-cabecalho-omniroute.mjs --modelo <combo> [--url <endereço>] [--permitidos a,b] [--repetir N] [--timeout S]
// Ajuda:    node scripts/testar-cabecalho-omniroute.mjs --ajuda
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { lerDecisaoEstrita, lerDecisaoTolerante, validarFormatoEstrito, pareceSegredo, ID_DE_PROVEDOR_RE } from '../src/core/ai/decisaoOmniRoute.js';

/** Os códigos de saída (um para cada motivo). Com `--repetir`, vale o primeiro código diferente de zero. */
export const CODIGOS = Object.freeze({
  OK: 0,
  USO: 2,
  SEM_CHAVE: 3,
  SEM_RESPOSTA: 4,
  ERRO_HTTP: 5,
  SEM_CABECALHO: 6,
  CABECALHO_INVALIDO: 7,
  FORA_DA_LISTA: 8,
});

export const URL_PADRAO = 'http://127.0.0.1:20128';
/** A frase fixa da chamada: curta, sem nenhum conteúdo privado. */
export const FRASE_DO_TESTE = 'Responda apenas: ok';
export const MAX_TOKENS_DO_TESTE = 8;
/** A definição estrita que o perfil privado da Yui usa para o formato real do OmniRoute: `strategy=<nome>; provider=<apelido>; latency_ms=<n>`. */
export const FORMATO_ESTRITO = validarFormatoEstrito({ formato: 'pares', campoProvedor: 'provider' }).formato;

const MODELO_RE = /^[A-Za-z0-9][\w.:@/-]{0,119}$/;
const NOMES_DE_CHAVE_NO_ARGUMENTO = new Set(['chave', 'key', 'token', 'senha', 'password', 'api-key', 'apikey', 'api_key', 'authorization', 'bearer', 'omniroute-key', 'secret', 'segredo']);

// ── O filtro de segredos (tudo o que é impresso passa por aqui) ─────────────────────────────────────────────────────────────────────────

const PADROES_DE_SEGREDO = [
  /\b(?:sk|gsk|hf|rk|pk|ak|ghp|glpat|xox[bpa]?)[-_][A-Za-z0-9_-]{6,}/gi,
  /\bBearer\s+\S+/gi,
  /\bAIza[0-9A-Za-z_-]{10,}/g,
  /\beyJ[A-Za-z0-9_-]{8,}[.\w-]*/g,
  /[A-Za-z0-9_-]{32,}/g,
];

/** Apaga do texto a chave inteira, qualquer pedaço dela com 10 caracteres ou mais, e tudo o que tem cara de segredo. */
export function redigir(texto, chave = '') {
  let saida = String(texto ?? '');
  const k = String(chave ?? '');
  if (k.length >= 4) {
    saida = saida.split(k).join('[chave apagada]');
    if (k.length >= 10) {
      for (let i = 0; i + 10 <= k.length; i += 1) {
        const pedaco = k.slice(i, i + 10);
        if (saida.includes(pedaco)) saida = saida.split(pedaco).join('[…]');
      }
    }
  }
  for (const re of PADROES_DE_SEGREDO) saida = saida.replace(re, '[apagado]');
  return saida;
}

const temChave = (valor, chave) => Boolean(chave) && String(chave).length >= 4 && String(valor).includes(String(chave));
const valorSeguro = (v, chave) => typeof v === 'string' && /^[A-Za-z0-9._:@+/-]{1,60}$/.test(v) && !pareceSegredo(v) && !temChave(v, chave);
const nomeSeguro = (n, chave) => typeof n === 'string' && /^[A-Za-z][\w.-]{0,30}$/.test(n) && !pareceSegredo(n) && !temChave(n, chave);
const CAMPOS_DA_DECISAO = new Set(['strategy', 'provider', 'latency_ms']);

function mostrarCampo(nome, valor, chave) {
  const n = String(nome).toLowerCase();
  if (!CAMPOS_DA_DECISAO.has(n)) return '[apagado]';
  if (n === 'latency_ms') return /^\d{1,7}$/.test(String(valor)) ? String(valor) : '[apagado]';
  return valorSeguro(String(valor), chave) ? String(valor) : '[apagado]';
}

function mostrarObjeto(obj, chave, nivel = 0) {
  const out = {};
  for (const [k, v] of Object.entries(obj).slice(0, 12)) {
    const nome = nomeSeguro(k, chave) ? k : '[apagado]';
    if (v && typeof v === 'object' && !Array.isArray(v) && nivel < 2) out[nome] = mostrarObjeto(v, chave, nivel + 1);
    else out[nome] = typeof v === 'string' || typeof v === 'number' ? mostrarCampo(k, v, chave) : '[apagado]';
  }
  return out;
}

/**
 * O valor do cabeçalho de decisão como pode ser mostrado: só os campos `strategy`, `provider` e `latency_ms` com valores de aparência segura; qualquer outra
 * coisa (outros campos, texto livre, algo com cara de segredo ou com a chave) vira "[apagado]". Nunca devolve o valor bruto. Ausente = null.
 */
export function mostrarCabecalho(valor, chave = '') {
  if (valor === null || valor === undefined) return null;
  const texto = String(valor);
  if (!texto.trim()) return '(vazio)';
  if (texto.length > 400 || /[\u0000-\u001f\u007f]/.test(texto)) return '[apagado: valor longo demais ou com caracteres de controle]';
  if (texto.trim().startsWith('{')) {
    try {
      const j = JSON.parse(texto);
      if (j && typeof j === 'object' && !Array.isArray(j)) return JSON.stringify(mostrarObjeto(j, chave));
    } catch { /* cai no texto livre */ }
    return `[apagado: texto livre de ${texto.length} caracteres]`;
  }
  const pedacos = texto.split(';').map((s) => s.trim()).filter(Boolean);
  const pares = pedacos.map((seg) => /^([^=\s]{1,40})=(.{0,120})$/.exec(seg));
  if (!pares.length || pares.some((m) => !m)) return `[apagado: texto livre de ${texto.length} caracteres]`;
  return pares.slice(0, 8).map((m) => `${nomeSeguro(m[1], chave) ? m[1] : '[apagado]'}=${mostrarCampo(m[1], m[2], chave)}`).join('; ');
}

// ── Os argumentos ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────

export const AJUDA = `Teste real do cabeçalho X-OmniRoute-Decision (a verificação do provedor que atendeu, que o perfil privado de IA da Yui exige).

O que faz: uma chamada mínima (sem streaming, ${MAX_TOKENS_DO_TESTE} tokens, a frase fixa "${FRASE_DO_TESTE}", nenhum conteúdo privado) ao OmniRoute, e mostra o que a Yui leria.
Não altera nada no OmniRoute nem na Yui. Rode com um combo e uma chave DE TESTE, no computador onde o OmniRoute está.

Uso:
  node scripts/testar-cabecalho-omniroute.mjs --modelo <combo> [opções]

Opções:
  --modelo <combo>      o id do combo (ou modelo) que vai no campo model. Obrigatório.
  --url <endereço>      o endereço do OmniRoute (padrão ${URL_PADRAO}). Aceita com ou sem /v1. Sem usuário, senha nem parâmetros.
  --permitidos a,b      os apelidos de provedor que o perfil privado vai permitir (o apelido do OmniRoute, não o id completo). Opcional:
                        se dado, o apelido lido é conferido contra a lista.
  --repetir N           N chamadas seguidas (1 a 20; padrão 1), para ver se o provedor muda num combo com fallback.
  --timeout S           o tempo máximo de cada chamada, em segundos (0,5 a 120; padrão 30).
  --ajuda               este texto.

A chave:
  Vem SÓ da variável de ambiente OMNIROUTE_KEY. Nunca por argumento (ficaria no histórico do terminal) e nunca é impressa.
  PowerShell:  $env:OMNIROUTE_KEY = '<a chave de teste>'; node scripts/testar-cabecalho-omniroute.mjs --modelo <combo>
  Bash:        OMNIROUTE_KEY='<a chave de teste>' node scripts/testar-cabecalho-omniroute.mjs --modelo <combo>

O que aparece: o status HTTP, o cabeçalho X-OmniRoute-Decision (só estratégia, apelido e latência; qualquer outra coisa é apagada), o apelido lido pelo leitor
ESTRITO da Yui (a definição formato "pares", campo "provider"), a estratégia, o cabeçalho X-OmniRoute-Provider (se vier) e o veredito. O corpo da resposta nunca é impresso.

Códigos de saída:
  0  o cabeçalho nomeia UM provedor (e, com --permitidos, ele está na lista)
  2  uso errado (argumento inválido ou faltando)
  3  a variável OMNIROUTE_KEY não está definida (ou é inválida)
  4  sem resposta do servidor (conexão recusada, tempo esgotado ou erro de rede)
  5  o servidor respondeu com erro HTTP, ou com um corpo que não é uma resposta de chat
  6  o cabeçalho X-OmniRoute-Decision não veio
  7  o cabeçalho veio, mas a Yui não consegue ler dele o nome de UM provedor
  8  o provedor lido não está na lista de --permitidos
  Com --repetir, vale o primeiro código diferente de zero.
`;

function nomeDoArgumento(bruto) {
  const nome = String(bruto).replace(/^-+/, '').split('=')[0].toLowerCase();
  return /^[a-z][a-z-]{0,29}$/.test(nome) ? nome : '?';
}

/**
 * Lê os argumentos. Nunca devolve (nem imprime) o valor de um argumento desconhecido: só o nome do argumento, e só se ele tem cara de nome.
 * @returns {{ ok: true, ajuda: boolean, endpoint?: string, modelo?: string, permitidos?: string[]|null, repetir?: number, timeoutMs?: number } | { ok: false, erro: string }}
 */
export function lerArgumentos(argv) {
  const lista = Array.isArray(argv) ? argv.map(String) : [];
  const valores = new Map();
  let ajuda = false;
  for (let i = 0; i < lista.length; i += 1) {
    const arg = lista[i];
    if (arg === '--ajuda' || arg === '-h' || arg === '--help') { ajuda = true; continue; }
    if (!arg.startsWith('--')) return { ok: false, erro: 'argumento solto: use --nome valor (veja --ajuda). O valor não é mostrado.' };
    const nome = nomeDoArgumento(arg);
    if (NOMES_DE_CHAVE_NO_ARGUMENTO.has(nome)) return { ok: false, erro: 'a chave não vai em argumento (ficaria no histórico do terminal): use só a variável de ambiente OMNIROUTE_KEY.' };
    if (!['url', 'modelo', 'permitidos', 'repetir', 'timeout'].includes(nome)) return { ok: false, erro: `argumento desconhecido: --${nome} (veja --ajuda).` };
    let valor;
    const igual = arg.indexOf('=');
    if (igual > 0) valor = arg.slice(igual + 1);
    else { valor = lista[i + 1]; i += 1; }
    if (valor === undefined || (igual < 0 && String(valor).startsWith('--'))) return { ok: false, erro: `faltou o valor de --${nome}.` };
    if (valores.has(nome)) return { ok: false, erro: `--${nome} foi dado duas vezes.` };
    valores.set(nome, String(valor));
  }
  if (ajuda) return { ok: true, ajuda: true };

  const modelo = (valores.get('modelo') ?? '').trim();
  if (!modelo) return { ok: false, erro: 'faltou --modelo (o id do combo que vai no campo model).' };
  if (!MODELO_RE.test(modelo)) return { ok: false, erro: '--modelo inválido (letras, números, ponto, dois-pontos, arroba, barra, sublinhado e hífen; até 120 caracteres).' };

  let url;
  try { url = new URL((valores.get('url') ?? URL_PADRAO).trim()); } catch { return { ok: false, erro: '--url inválida (use algo como http://127.0.0.1:20128).' }; }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return { ok: false, erro: '--url precisa começar com http:// ou https://.' };
  if (url.username || url.password) return { ok: false, erro: '--url não pode levar usuário nem senha.' };
  if (url.search || url.hash) return { ok: false, erro: '--url não pode levar parâmetros (?...) nem âncora (#...).' };
  let caminho = url.pathname.replace(/\/+$/, '');
  if (!/\/chat\/completions$/.test(caminho)) caminho = /\/v1$/.test(caminho) ? `${caminho}/chat/completions` : `${caminho}/v1/chat/completions`;
  const endpoint = `${url.origin}${caminho}`;

  let permitidos = null;
  if (valores.has('permitidos')) {
    const itens = valores.get('permitidos').split(',').map((s) => s.trim().toLowerCase());
    if (!itens.length || itens.length > 30 || itens.some((p) => !ID_DE_PROVEDOR_RE.test(p))) return { ok: false, erro: '--permitidos: use até 30 apelidos separados por vírgula (minúsculas, números, ponto, sublinhado e hífen).' };
    permitidos = [...new Set(itens)];
  }

  let repetir = 1;
  if (valores.has('repetir')) {
    repetir = Number(valores.get('repetir'));
    if (!Number.isInteger(repetir) || repetir < 1 || repetir > 20) return { ok: false, erro: '--repetir precisa ser um número inteiro de 1 a 20.' };
  }
  let timeoutMs = 30_000;
  if (valores.has('timeout')) {
    const s = Number(String(valores.get('timeout')).replace(',', '.'));
    if (!Number.isFinite(s) || s < 0.5 || s > 120) return { ok: false, erro: '--timeout precisa ser um número de segundos de 0,5 a 120.' };
    timeoutMs = Math.round(s * 1000);
  }
  return { ok: true, ajuda: false, endpoint, modelo, permitidos, repetir, timeoutMs };
}

// ── A chamada e o veredito ───────────────────────────────────────────────────────────────────────────────────────────────────────────

/** O que a falha de rede foi, em palavras fixas (nunca o texto do erro: ele pode trazer endereço ou detalhe). */
function causaDaRede(err, abortou) {
  if (abortou) return 'tempo esgotado';
  const codigo = String(err?.cause?.code ?? err?.code ?? '');
  if (codigo === 'ECONNREFUSED') return 'conexão recusada (o OmniRoute está rodando neste endereço e porta?)';
  if (codigo === 'ENOTFOUND' || codigo === 'EAI_AGAIN') return 'nome do servidor não encontrado';
  if (codigo === 'ECONNRESET' || codigo === 'UND_ERR_SOCKET') return 'a conexão foi derrubada pelo servidor';
  return 'erro de rede';
}

function explicarHttp(status) {
  if (status === 401 || status === 403) return 'a chave foi recusada (confira OMNIROUTE_KEY e se ela está vinculada ao combo)';
  if (status === 404) return 'modelo ou rota não encontrados (confira --modelo e --url)';
  if (status === 429) return 'limite ou cota atingidos';
  if (status >= 500) return 'erro do servidor';
  return 'a chamada foi recusada';
}

/** Uma chamada ao OmniRoute. Nunca lança e nunca devolve o corpo: só o status, os cabeçalhos de decisão e se o corpo é uma resposta de chat. */
async function chamarUma({ endpoint, modelo, chave, timeoutMs, fetchImpl }) {
  const controlador = new AbortController();
  let abortou = false;
  const timer = setTimeout(() => { abortou = true; controlador.abort(); }, timeoutMs);
  try {
    const res = await fetchImpl(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json', Authorization: `Bearer ${chave}` },
      body: JSON.stringify({ model: modelo, messages: [{ role: 'user', content: FRASE_DO_TESTE }], max_tokens: MAX_TOKENS_DO_TESTE, stream: false }),
      signal: controlador.signal,
      redirect: 'error',
    });
    let decisao = null;
    let provedorHeader = null;
    try { decisao = res.headers.get('x-omniroute-decision'); } catch { decisao = null; }
    try { provedorHeader = res.headers.get('x-omniroute-provider'); } catch { provedorHeader = null; }
    let corpo = 'nenhum';
    if (res.status >= 200 && res.status < 300) {
      try {
        const j = JSON.parse(await res.text());
        const conteudo = j?.choices?.[0]?.message?.content;
        corpo = typeof conteudo !== 'string' ? 'invalido' : (conteudo.trim() ? 'valido' : 'vazio');
      } catch { corpo = 'invalido'; }
    } else {
      try { await res.text(); } catch { /* o corpo de um erro nunca é impresso */ }
    }
    return { ok: true, status: res.status, decisao, provedorHeader, corpo };
  } catch (err) {
    return { ok: false, causa: causaDaRede(err, abortou) };
  } finally {
    clearTimeout(timer);
  }
}

/** O veredito de UMA chamada, em palavras claras, e o código de saída dela. */
function julgar(r, leitura, permitidos) {
  if (!r.ok) return { codigo: CODIGOS.SEM_RESPOSTA, texto: `sem resposta do servidor: ${r.causa}.` };
  if (r.status < 200 || r.status >= 300) return { codigo: CODIGOS.ERRO_HTTP, texto: `o servidor respondeu HTTP ${r.status}: ${explicarHttp(r.status)}.` };
  if (r.corpo === 'invalido') return { codigo: CODIGOS.ERRO_HTTP, texto: 'o corpo da resposta não é uma resposta de chat válida (a sonda da Yui falharia por resposta inválida).' };
  if (r.corpo === 'vazio') return { codigo: CODIGOS.ERRO_HTTP, texto: 'a resposta de chat veio vazia (a sonda da Yui falharia por resposta vazia).' };
  if (r.decisao === null || String(r.decisao).trim() === '') {
    return { codigo: CODIGOS.SEM_CABECALHO, texto: 'o OmniRoute NÃO enviou o cabeçalho X-OmniRoute-Decision: a Yui não consegue verificar qual provedor atendeu, e o perfil privado não pode ser ligado.' };
  }
  if (!leitura.ok) {
    const porMotivo = {
      'formato-desconhecido': 'o cabeçalho existe, mas não segue o formato "campo=valor" separado por ";" que a Yui lê (ou repete algum campo)',
      'campo-ausente': 'o cabeçalho existe, mas não tem o campo "provider"',
      'provedor-invalido': 'o campo "provider" existe, mas o valor dele não parece o apelido de um provedor',
      'cabecalho-invalido': 'o cabeçalho tem um valor inválido (longo demais ou com caracteres de controle)',
    };
    return { codigo: CODIGOS.CABECALHO_INVALIDO, texto: `${porMotivo[leitura.motivo] ?? 'a Yui não consegue ler o provedor do cabeçalho'}: o cabeçalho NÃO nomeia um provedor que a Yui consiga ler, e o perfil privado não pode ser ligado com ele.` };
  }
  if (permitidos && !permitidos.includes(leitura.provedor)) {
    return { codigo: CODIGOS.FORA_DA_LISTA, texto: `o cabeçalho nomeia UM provedor ("${leitura.provedor}"), mas ele NÃO está na lista de --permitidos (${permitidos.join(', ')}): numa chamada real a Yui bloquearia a rota.` };
  }
  return { codigo: CODIGOS.OK, texto: `o cabeçalho nomeia UM provedor ("${leitura.provedor}")${permitidos ? ' e ele está na lista de --permitidos' : ''}.` };
}

/**
 * Roda o script. Devolve o código de saída; escreve só pelo `saida` e pelo `erroSaida` (que recebem texto JÁ filtrado).
 * @param {string[]} argv  os argumentos (sem o node e o caminho do script)
 * @param {{ env?: object, fetchImpl?: Function, saida?: Function, erroSaida?: Function }} [o]
 * @returns {Promise<number>}
 */
export async function executar(argv, { env = process.env, fetchImpl = globalThis.fetch, saida = (t) => process.stdout.write(t), erroSaida = (t) => process.stderr.write(t) } = {}) {
  const chave = String(env?.OMNIROUTE_KEY ?? '').trim();
  const dizer = (t = '') => saida(`${redigir(t, chave)}\n`);
  const reclamar = (t) => erroSaida(`${redigir(t, chave)}\n`);

  const a = lerArgumentos(argv);
  if (!a.ok) { reclamar(`Erro: ${a.erro}`); return CODIGOS.USO; }
  if (a.ajuda) { saida(`${AJUDA}`); return CODIGOS.OK; }
  if (!chave) { reclamar('Erro: a variável de ambiente OMNIROUTE_KEY não está definida. A chave de teste só vem dela (veja --ajuda).'); return CODIGOS.SEM_CHAVE; }
  if (!/^[\x21-\x7e]{8,512}$/.test(chave)) { reclamar('Erro: OMNIROUTE_KEY tem caracteres inválidos ou é curta demais.'); return CODIGOS.SEM_CHAVE; }
  if (typeof fetchImpl !== 'function') { reclamar('Erro: este Node não tem fetch (use o Node 18 ou mais novo).'); return CODIGOS.USO; }

  dizer('Teste do cabeçalho X-OmniRoute-Decision');
  dizer(`  Endereço:     ${a.endpoint}`);
  dizer(`  Combo:        ${a.modelo}`);
  dizer('  Chave:        lida de OMNIROUTE_KEY (não é impressa)');
  dizer(`  Permitidos:   ${a.permitidos ? a.permitidos.join(', ') : '(não informados: só leio o apelido)'}`);
  dizer(`  Chamadas:     ${a.repetir} (cada uma: sem streaming, ${MAX_TOKENS_DO_TESTE} tokens, frase fixa, nenhum conteúdo privado)`);

  const resultados = [];
  let primeiroErro = CODIGOS.OK;
  for (let n = 1; n <= a.repetir; n += 1) {
    const r = await chamarUma({ endpoint: a.endpoint, modelo: a.modelo, chave, timeoutMs: a.timeoutMs, fetchImpl });
    const leitura = r.ok ? lerDecisaoEstrita(r.decisao, FORMATO_ESTRITO) : { ok: false, motivo: 'sem-resposta' };
    const tolerante = r.ok && r.decisao ? lerDecisaoTolerante(r.decisao) : null;
    const veredito = julgar(r, leitura, a.permitidos);
    resultados.push({ r, leitura, veredito });
    if (primeiroErro === CODIGOS.OK) primeiroErro = veredito.codigo;

    dizer();
    dizer(`Chamada ${n} de ${a.repetir}`);
    if (!r.ok) {
      dizer('  Status HTTP:                          (sem resposta)');
    } else {
      dizer(`  Status HTTP:                          ${r.status}`);
      const mostrado = mostrarCabecalho(r.decisao, chave);
      dizer(`  X-OmniRoute-Decision:                 ${mostrado === null ? '(não veio)' : mostrado}`);
      dizer(`  Provedor lido pelo leitor estrito:    ${leitura.ok ? leitura.provedor : `(não leu: ${leitura.motivo})`}`);
      dizer(`  Estratégia:                           ${tolerante?.estrategia ?? '(não informada)'}`);
      dizer(`  Latência informada:                   ${tolerante?.latenciaMs !== null && tolerante?.latenciaMs !== undefined ? `${tolerante.latenciaMs} ms` : '(não informada)'}`);
      const provedorHeader = r.provedorHeader === null ? null : mostrarCampo('provider', String(r.provedorHeader).trim(), chave);
      dizer(`  X-OmniRoute-Provider:                 ${provedorHeader === null ? '(não veio)' : provedorHeader}`);
      if (provedorHeader && leitura.ok && provedorHeader !== '[apagado]' && provedorHeader.toLowerCase() !== leitura.provedor) {
        dizer(`  AVISO: o X-OmniRoute-Provider (${provedorHeader}) difere do provider do X-OmniRoute-Decision (${leitura.provedor}).`);
      }
    }
    dizer(`  Veredito:                             ${veredito.texto}`);
    // Repetir não adianta quando o servidor nem respondeu ou recusou a chave, o modelo ou a rota: para na primeira.
    if (!r.ok || r.status === 401 || r.status === 403 || r.status === 404) {
      if (n < a.repetir) dizer(`  (as ${a.repetir - n} chamadas restantes foram canceladas: repetir não resolve isto)`);
      break;
    }
  }

  if (a.repetir > 1) {
    const lidos = resultados.filter((x) => x.leitura.ok).map((x) => x.leitura.provedor);
    const unicos = [...new Set(lidos)];
    dizer();
    dizer('Resumo');
    dizer(`  Chamadas feitas:                      ${resultados.length} de ${a.repetir}`);
    dizer(`  Com um provedor lido:                 ${lidos.length}`);
    dizer(`  Provedores vistos:                    ${unicos.length ? unicos.join(', ') : '(nenhum)'}`);
    if (unicos.length > 1) dizer('  O provedor MUDOU entre as chamadas (combo com fallback ou rodízio): a lista de permitidos do perfil privado precisa ter todos os apelidos vistos, e cada chamada será conferida.');
    else if (unicos.length === 1 && lidos.length === resultados.length) dizer('  O provedor foi o MESMO em todas as chamadas.');
  }

  dizer();
  const final = primeiroErro === CODIGOS.OK
    ? 'RESULTADO: o cabeçalho nomeia UM provedor lido pela Yui. (Isto é um teste do formato: as outras condições para ligar o perfil privado estão em docs/content_pt/PERFIS_IA.md.)'
    : `RESULTADO: falhou (código de saída ${primeiroErro}). O perfil privado NÃO deve ser ligado com este combo e esta configuração.`;
  dizer(final);
  return primeiroErro;
}

// Só roda sozinho quando é o arquivo principal (importado por um teste, não faz nada).
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  executar(process.argv.slice(2)).then((codigo) => { process.exitCode = codigo; }, () => { process.stderr.write('Erro inesperado no script.\n'); process.exitCode = 1; });
}
