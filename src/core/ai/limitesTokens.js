// Limites de tokens da RESPOSTA por provedor (etapa 6, pedido da Liz no relatório da etapa 5, §9: o AI_MAX_TOKENS=1500 não substitui os
// limites de cada provedor; o cérebro respeita a configuração e a capacidade de cada um, com um teto global de segurança).
//
// Onde vale (etapa 6 e os ajustes da Liz, §11 do relatório: os limites UNIFICADOS do Discord e do app):
//  - Discord no processo ÚNICO (sem YUI_CEREBRO_EXTERNO): nada muda. A cadeia do bot (llmHandler) usa o limite de cada provedor
//    (providerSettings), que sai da tabela LIMITES_PADRAO_CADEIA daqui (uma fonte só), com o YUI_REPLY_MAX_TOKENS e o painel do Discord;
//  - Discord pelo CÉREBRO (a conversa, o /yui e a síntese da pesquisa, com o pedido `tokensPorProvedor`): o backend "gateway" manda a cada
//    provedor o limite DELE, e o "openai-compatible" o dele;
//  - APP (/v1/chat e o agente do app, nos dois modos): o mesmo "menor dos três", com o AI_MAX_TOKENS como a configuração própria do app.
//
// Regra, por provedor P (a mais restritiva vence):
//   limite(P) = mínimo entre
//     1. o CONFIGURADO de P, que depende do canal:
//        - Discord pelo cérebro: o ajuste do PAINEL do Discord para o provedor equivalente da cadeia do bot (fato do canal que o bot manda)
//          > YUI_CEREBRO_MAX_TOKENS (JSON por provedor, ex. {"groq":2048,"huggingface":512}, ou um número para todos)
//          > YUI_REPLY_MAX_TOKENS (o mesmo ajuste que a cadeia do bot usa, para todos) > o PADRÃO da cadeia do bot para o mesmo provedor;
//        - app: o AI_MAX_TOKENS (padrão 1500); pelo backend "legacy-chain" (a cadeia do bot, só no processo único), a configuração da
//          própria cadeia (a mesma do Discord), como sempre;
//     2. a CAPACIDADE de P: o teto de saída que a integração aceita (CAPACIDADE_PADRAO / CAPACIDADE_CADEIA, valores conservadores) ou o
//        `maxTokens` que o dono declarou para um provedor próprio no YUI_GATEWAY_CUSTOM;
//     3. o TETO GLOBAL de segurança: YUI_MAX_TOKENS_TETO (padrão 4096; aceita de 256 a 8192). O roteador do Gateway ainda corta em 8192.
// Nada aqui lê rede nem o bot; tudo é puro e testável (tests/test-pesquisa-cerebro-unidade.js e tests/test-retomada-pesquisa.js).
//
// Segunda revisão da Liz (§12/§13 do relatório da etapa 6):
//  - o AI_MAX_TOKENS é lido por UMA regra só (lerAiMaxTokens), igual no Discord (backend "openai-compatible" do cérebro) e no app: um número
//    inteiro a partir de 64 (acima do teto global, o teto corta). Vazio = o padrão 1500, sem aviso. Qualquer outra coisa (texto, 0, negativo,
//    abaixo de 64, "1500abc") é INVÁLIDA: vale o padrão 1500, mas o erro NÃO fica escondido: vai para o log UMA vez (avisarConfigDosLimites)
//    e aparece no diagnóstico (diagnosticoDosLimites: o relatório de saúde, o /v1/health e a saúde do cérebro);
//  - o ajuste do PAINEL do Discord vale só no Discord: o app nunca o herda (nem pela cadeia do bot no processo único: llmHandler.maxTokensDe
//    passa ao app a configuração da cadeia SEM o ajuste do painel).
import { logger as defaultLogger } from '../../utils/logger.js';

/** Padrão de saída de cada provedor da cadeia do BOT (llmHandler.providerSettings). A mesma tabela nos dois processos. */
export const LIMITES_PADRAO_CADEIA = Object.freeze({
  local: 1024, gemini: 2048, cloudflare: 1024, pollinations: 1024, hf: 512, groq: 1024, gateway: 1024, horde: 256,
});

/**
 * Capacidade de saída assumida para cada provedor do GATEWAY (conservadora: abaixo do que a documentação de cada serviço aceita hoje, para
 * um pedido nunca ser recusado por "max_tokens grande demais"). Provedor sem linha aqui (um próprio do YUI_GATEWAY_CUSTOM sem `maxTokens`)
 * fica com CAPACIDADE_DESCONHECIDA.
 */
export const CAPACIDADE_PADRAO = Object.freeze({
  groq: 8192, gemini: 8192, huggingface: 4096, openrouter: 4096, cloudflare: 2048, together: 4096, pollinations: 4096,
});
export const CAPACIDADE_DESCONHECIDA = 4096;

/**
 * Capacidade de saída assumida para cada provedor da cadeia do BOT (o app pelo backend "legacy-chain"). Os mesmos números do Gateway para o
 * mesmo serviço; o LM Studio local e o Gateway em processo (que repassa a vários) ficam com CAPACIDADE_DESCONHECIDA; o Horde aceita pouco
 * (o max_length dele já fica em até 512 com o YUI_REPLY_MAX_TOKENS).
 */
export const CAPACIDADE_CADEIA = Object.freeze({
  local: CAPACIDADE_DESCONHECIDA, gemini: 8192, cloudflare: 2048, pollinations: 4096, hf: 4096, groq: 8192, gateway: CAPACIDADE_DESCONHECIDA, horde: 512,
});

/**
 * O provedor do gateway e o provedor equivalente da cadeia do bot (para o padrão e para o ajuste do painel). Os demais (OpenRouter, Together,
 * os próprios do YUI_GATEWAY_CUSTOM) usam o do "gateway" do bot. O "local" (LM Studio) e o "horde" da cadeia não têm equivalente no Gateway.
 */
export const EQUIVALENTE_NA_CADEIA = Object.freeze({ groq: 'groq', gemini: 'gemini', huggingface: 'hf', cloudflare: 'cloudflare', pollinations: 'pollinations' });

export const TETO_PADRAO = 4096;
const TETO_MIN = 256;
const TETO_MAX = 8192;
const LIMITE_MIN = 64;

const inteiro = (v) => {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isInteger(n) ? n : null;
};

/** O teto global de segurança (YUI_MAX_TOKENS_TETO; padrão 4096; de 256 a 8192). */
export function tetoGlobal(env = process.env) {
  const n = inteiro(env?.YUI_MAX_TOKENS_TETO);
  return n === null ? TETO_PADRAO : Math.min(TETO_MAX, Math.max(TETO_MIN, n));
}

/** YUI_REPLY_MAX_TOKENS (64 a 8192) ou null. A mesma leitura do discord/longReply.js (parseReplyMaxTokens). */
export function ajusteGeral(env = process.env) {
  const n = inteiro(env?.YUI_REPLY_MAX_TOKENS);
  return n !== null && n >= LIMITE_MIN && n <= TETO_MAX ? n : null;
}

/** YUI_CEREBRO_MAX_TOKENS: { porProvedor: {id: n}, todos: n|null, erro: string|null }. JSON inválido é ignorado (com o erro, para o log). */
export function ajustesDoCerebro(env = process.env) {
  const raw = String(env?.YUI_CEREBRO_MAX_TOKENS ?? '').trim();
  const out = { porProvedor: {}, todos: null, erro: null };
  if (!raw) return out;
  const valido = (n) => Number.isInteger(n) && n >= LIMITE_MIN && n <= TETO_MAX;
  if (/^\d+$/.test(raw)) {
    const n = Number(raw);
    if (valido(n)) out.todos = n; else out.erro = `YUI_CEREBRO_MAX_TOKENS fora da faixa (${LIMITE_MIN} a ${TETO_MAX})`;
    return out;
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('não é um objeto');
    for (const [id, v] of Object.entries(parsed)) {
      const n = Number(v);
      if (/^[a-z0-9][a-z0-9-]{0,30}$/.test(id) && valido(n)) out.porProvedor[id] = n;
    }
  } catch (err) {
    out.erro = `YUI_CEREBRO_MAX_TOKENS não é um JSON válido (${String(err?.message ?? err).slice(0, 60)})`;
  }
  return out;
}

/**
 * Os ajustes de max_tokens que o PAINEL do Discord fez na cadeia do bot (o fato do canal `maxTokens` que o bot manda ao cérebro), conferidos:
 * só provedores da cadeia (LIMITES_PADRAO_CADEIA) e números inteiros de 64 a 8192. Qualquer outra coisa é ignorada. Nunca lança.
 * @returns {Record<string, number>}
 */
export function limitesDoCanal(raw) {
  const out = {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return out;
  for (const [id, v] of Object.entries(raw)) {
    const n = Number(v);
    if (Object.hasOwn(LIMITES_PADRAO_CADEIA, id) && Number.isInteger(n) && n >= LIMITE_MIN && n <= TETO_MAX) out[id] = n;
  }
  return out;
}

/**
 * O limite de UM provedor do gateway no cérebro.
 * @param {string} provedor  id do provedor do gateway (groq, gemini, huggingface, ... ou o id de um próprio)
 * @param {{ env?: object, capacidadeDeclarada?: number|null, canal?: Record<string, number>|null }} [o]  `canal`: os ajustes do painel do
 *   Discord (limitesDoCanal), pelo provedor equivalente da cadeia do bot
 * @returns {{ limite: number, configurado: number, capacidade: number, teto: number, origem: string }}
 */
export function limiteDoProvedor(provedor, { env = process.env, capacidadeDeclarada = null, canal = null } = {}) {
  const id = String(provedor ?? '').toLowerCase();
  const cerebro = ajustesDoCerebro(env);
  const geral = ajusteGeral(env);
  const doCanal = limitesDoCanal(canal);
  const naCadeia = EQUIVALENTE_NA_CADEIA[id] ?? 'gateway';
  let configurado;
  let origem;
  if (Object.hasOwn(doCanal, naCadeia)) { configurado = doCanal[naCadeia]; origem = `painel do Discord (${naCadeia})`; }
  else if (Object.hasOwn(cerebro.porProvedor, id)) { configurado = cerebro.porProvedor[id]; origem = 'YUI_CEREBRO_MAX_TOKENS (provedor)'; }
  else if (cerebro.todos !== null) { configurado = cerebro.todos; origem = 'YUI_CEREBRO_MAX_TOKENS (todos)'; }
  else if (geral !== null) { configurado = geral; origem = 'YUI_REPLY_MAX_TOKENS'; }
  else { configurado = LIMITES_PADRAO_CADEIA[naCadeia]; origem = 'padrão da cadeia do bot'; }
  const declarada = Number.isInteger(capacidadeDeclarada) && capacidadeDeclarada >= LIMITE_MIN ? capacidadeDeclarada : null;
  const capacidade = declarada ?? (Object.hasOwn(CAPACIDADE_PADRAO, id) ? CAPACIDADE_PADRAO[id] : CAPACIDADE_DESCONHECIDA);
  const teto = tetoGlobal(env);
  const limite = Math.max(LIMITE_MIN, Math.min(configurado, capacidade, teto));
  if (limite < configurado) origem += limite === teto ? ' (cortado pelo teto global)' : ' (cortado pela capacidade do provedor)';
  return { limite, configurado, capacidade, teto, origem };
}

/**
 * Limite do backend "openai-compatible" (AI_BASE_URL: OmniRoute, LM Studio...): YUI_CEREBRO_MAX_TOKENS["openai-compatible"] (ou o número
 * para todos) > AI_MAX_TOKENS (o de sempre, padrão 1500), sempre abaixo do teto global. A capacidade de um endpoint próprio não é conhecida.
 */
export function limiteOpenAiCompativel(env = process.env) {
  const cerebro = ajustesDoCerebro(env);
  // o AI_MAX_TOKENS pela MESMA regra do app (lerAiMaxTokens): inválido vale 1500, mas vai para o log e para o diagnóstico
  const configurado = cerebro.porProvedor['openai-compatible'] ?? cerebro.todos ?? aiMaxTokens(env);
  return Math.max(LIMITE_MIN, Math.min(configurado, tetoGlobal(env)));
}

/**
 * A função que o roteador do Gateway usa por alvo: (provedor) => limite. `provedor.maxTokens` é a capacidade declarada no YUI_GATEWAY_CUSTOM;
 * `canal` são os ajustes do painel do Discord (o fato do canal que o bot manda ao cérebro).
 */
export function limitePorProvedor(env = process.env, { canal = null } = {}) {
  return (provedor) => limiteDoProvedor(provedor?.id ?? provedor, { env, capacidadeDeclarada: provedor?.maxTokens ?? null, canal }).limite;
}

/** Tabela para o relatório de saúde e para a documentação: um item por provedor ativo do gateway. */
export function tabelaDeLimites(provedores = [], env = process.env) {
  return provedores.map((p) => ({ provedor: p.id, ...limiteDoProvedor(p.id, { env, capacidadeDeclarada: p.maxTokens ?? null }) }));
}

// ── O APP (etapa 6, ajustes da Liz: os limites unificados com o Discord) ─────────────────────────────────────────────────────────────

export const AI_MAX_TOKENS_PADRAO = 1500;

/**
 * O AI_MAX_TOKENS lido por UMA regra só (Discord e app). `definido`: a variável tem algum valor; `valido`: é um inteiro a partir de 64 (acima
 * do teto global, o teto corta depois); `valor`: o que vale (o padrão 1500 quando vazio ou inválido); `erro`: a frase para o log e o
 * diagnóstico (sem repetir o valor bruto inteiro). Nunca lança.
 * @returns {{ valor: number, valido: boolean, definido: boolean, erro: string|null }}
 */
export function lerAiMaxTokens(env = process.env) {
  const bruto = String(env?.AI_MAX_TOKENS ?? '').trim();
  if (!bruto) return { valor: AI_MAX_TOKENS_PADRAO, valido: true, definido: false, erro: null };
  const n = /^\d{1,9}$/.test(bruto) ? Number(bruto) : NaN;
  if (Number.isInteger(n) && n >= LIMITE_MIN) return { valor: n, valido: true, definido: true, erro: null };
  return {
    valor: AI_MAX_TOKENS_PADRAO, valido: false, definido: true,
    erro: `AI_MAX_TOKENS inválido ("${bruto.slice(0, 12)}"): precisa ser um número inteiro a partir de ${LIMITE_MIN}; valendo o padrão ${AI_MAX_TOKENS_PADRAO} até corrigir o .env`,
  };
}

/**
 * A configuração própria do app (e do backend "openai-compatible" do cérebro): o AI_MAX_TOKENS pela regra única (lerAiMaxTokens). Inválido
 * vale o padrão 1500, e o erro vai para o log (uma vez) e para o diagnóstico. Antes da etapa 6 um valor inválido ia ao provedor como `null`
 * (texto) ou 0; de 1 a 63 o app usava o número e o Discord, o padrão (agora os dois tratam como inválido).
 */
export function aiMaxTokens(env = process.env) {
  const lido = lerAiMaxTokens(env);
  if (!lido.valido) avisarConfigDosLimites(env);
  return lido.valor;
}

// ── Diagnóstico da configuração dos limites (segunda revisão da Liz, §12) ────────────────────────────────────────────────────────────

/**
 * Os problemas de configuração dos limites de tokens, para o log e o diagnóstico (relatório de saúde, /v1/health, saúde do cérebro). Só
 * nomes de variáveis, o problema e o valor que vale no lugar (nunca uma chave ou um texto de conversa). Nunca lança.
 * @returns {{ variavel: string, problema: string, usando: number|string }[]}
 */
export function diagnosticoDosLimites(env = process.env) {
  const out = [];
  try {
    const ai = lerAiMaxTokens(env);
    if (!ai.valido) out.push({ variavel: 'AI_MAX_TOKENS', problema: `inválido (precisa ser um número inteiro a partir de ${LIMITE_MIN})`, usando: ai.valor });
    const cerebro = ajustesDoCerebro(env);
    if (cerebro.erro) out.push({ variavel: 'YUI_CEREBRO_MAX_TOKENS', problema: cerebro.erro.replace(/^YUI_CEREBRO_MAX_TOKENS\s*/, ''), usando: 'os limites padrão por provedor' });
    const teto = String(env?.YUI_MAX_TOKENS_TETO ?? '').trim();
    if (teto && (!/^\d{1,9}$/.test(teto) || Number(teto) < TETO_MIN || Number(teto) > TETO_MAX)) {
      out.push({ variavel: 'YUI_MAX_TOKENS_TETO', problema: `fora da faixa (${TETO_MIN} a ${TETO_MAX}) ou não é um número`, usando: tetoGlobal(env) });
    }
    const geral = String(env?.YUI_REPLY_MAX_TOKENS ?? '').trim();
    if (geral && ajusteGeral(env) === null) out.push({ variavel: 'YUI_REPLY_MAX_TOKENS', problema: `fora da faixa (${LIMITE_MIN} a ${TETO_MAX}) ou não é um número`, usando: 'ignorada (o padrão de cada provedor)' });
  } catch { /* o diagnóstico nunca derruba ninguém */ }
  return out;
}

const avisados = new Set();
/**
 * Manda ao log, UMA vez por processo e por problema, cada erro de configuração dos limites (diagnosticoDosLimites). Chamado na subida dos
 * dois processos e a cada leitura do AI_MAX_TOKENS inválido (que não repete a linha). Devolve quantas linhas novas saíram.
 */
export function avisarConfigDosLimites(env = process.env, log = defaultLogger) {
  let novas = 0;
  for (const d of diagnosticoDosLimites(env)) {
    const linha = `[Config] ${d.variavel} ${d.problema}: valendo ${d.usando}. Corrija no .env (aparece também no relatório de saúde e no /v1/health).`;
    if (avisados.has(linha)) continue;
    avisados.add(linha);
    novas += 1;
    try { log?.warn?.(linha); } catch { /* */ }
  }
  return novas;
}
/** Só para teste: esquece o que já foi avisado. */
export function esquecerAvisosParaTeste() { avisados.clear(); }

/**
 * O limite de UM provedor do Gateway para o APP: o menor entre o AI_MAX_TOKENS, a capacidade do provedor (a da tabela ou a declarada no
 * YUI_GATEWAY_CUSTOM) e o teto global. Com os padrões (1500), nada muda; muda só quando a capacidade ou o teto ficam abaixo do AI_MAX_TOKENS.
 * @returns {{ limite: number, configurado: number, capacidade: number, teto: number, origem: string }}
 */
export function limiteDoApp(provedor, { env = process.env, capacidadeDeclarada = null } = {}) {
  const id = String(provedor ?? '').toLowerCase();
  const configurado = aiMaxTokens(env);
  const declarada = Number.isInteger(capacidadeDeclarada) && capacidadeDeclarada >= LIMITE_MIN ? capacidadeDeclarada : null;
  const capacidade = declarada ?? (Object.hasOwn(CAPACIDADE_PADRAO, id) ? CAPACIDADE_PADRAO[id] : CAPACIDADE_DESCONHECIDA);
  const teto = tetoGlobal(env);
  const limite = Math.min(configurado, capacidade, teto);
  let origem = 'AI_MAX_TOKENS';
  if (limite < configurado) origem += limite === teto ? ' (cortado pelo teto global)' : ' (cortado pela capacidade do provedor)';
  return { limite, configurado, capacidade, teto, origem };
}

/** A função do roteador do Gateway para o APP: (provedor) => limite (limiteDoApp). */
export function limitePorProvedorNoApp(env = process.env) {
  return (provedor) => limiteDoApp(provedor?.id ?? provedor, { env, capacidadeDeclarada: provedor?.maxTokens ?? null }).limite;
}

/** O limite do backend "openai-compatible" para o APP: o AI_MAX_TOKENS abaixo do teto global (a capacidade de um endpoint próprio não é conhecida). */
export function limiteAppOpenAiCompativel(env = process.env) {
  return Math.min(aiMaxTokens(env), tetoGlobal(env));
}

/**
 * O limite de um provedor da CADEIA DO BOT quando quem pede é o APP (backend "legacy-chain", só no processo único): o configurado é o da
 * própria cadeia (`configurado`: o providerSettings do bot, a mesma configuração do Discord, como sempre foi para o app por esse backend),
 * cortado pela capacidade (CAPACIDADE_CADEIA) e pelo teto global. Com os padrões (todos de 256 a 2048), nada muda. Valor que não é um
 * número positivo volta como veio.
 */
export function limiteDaCadeiaNoApp(provedorDaCadeia, configurado, env = process.env) {
  const n = Number(configurado);
  if (!Number.isFinite(n) || n <= 0) return configurado;
  const capacidade = Object.hasOwn(CAPACIDADE_CADEIA, provedorDaCadeia) ? CAPACIDADE_CADEIA[provedorDaCadeia] : CAPACIDADE_DESCONHECIDA;
  return Math.min(n, capacidade, tetoGlobal(env));
}
