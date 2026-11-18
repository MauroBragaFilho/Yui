// Ajustes da etapa 6 depois da revisão da Liz (docs/RELATORIO_ETAPA6_PESQUISA.md §11), num processo só:
//  A. a RETOMADA da pesquisa sem repetição cega (src/cerebro/pesquisaRetomada.js): o cérebro "morre" em cada estado (antes da busca, durante a
//     busca, depois de guardar a busca, durante a síntese) e um cérebro NOVO, com a mesma pasta e contadores de cota novos (como um processo
//     novo), recebe a mesma chave: nenhuma busca concluída roda de novo, a busca incerta tem UMA nova tentativa, e a cota é contada certo;
//     a busca incerta duas vezes desiste; a resposta pronta é devolvida sem buscar nem chamar a IA; um arquivo por pessoa; nada de texto no log;
//  B. a busca automática do /yui decidida pelo CONTEXTO: pergunta simples não pesquisa (nem pela promessa do modelo), assunto atual e
//     documentação pesquisam, cota perto do fim avisa e não começa busca desnecessária (o pedido explícito ainda pesquisa), privada como antes;
//  C. os limites de tokens UNIFICADOS (Discord e app): o app pelo gateway, pelo openai-compatible e pela cadeia do bot, com cada caso em que o
//     comportamento muda em relação a antes; o Discord no processo único não muda;
//  D. o ajuste do PAINEL do Discord chegando ao cérebro como fato do canal e aplicado como "configurado" (capacidade e teto ainda cortam).
// SEM rede (axios e fetch bloqueados; busca, IA e Discord falsos), SEM bancos reais (pasta temporária).
// Execução: npm run test:retomadapesquisa   (node tests/test-retomada-pesquisa.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-retomada-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const REGISTRO = path.join(tmp, 'buscas.jsonl');
const BUSCA_CTRL = path.join(tmp, 'busca-controle.json');

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_RESEARCH_ENABLED: 'true', YUI_RESEARCH_GUARD: 'on', YUI_RESEARCH_PRE_ROUTE: 'false', YUI_PRIVATE_SEARCH: 'off',
  YUI_CONTEXT_ENABLED: 'false', YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'search-budget.json'), YUI_POLICY_MODE: 'observe', YUI_RESEARCH_DEADLINE_MS: '20000',
  YUI_SEARCH_USER_PER_HOUR: '5', YUI_SEARCH_GLOBAL_PER_HOUR: '20', YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: '',
  GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890', YUI_CHANNEL_SECRET_FILE: path.join(tmp, 'secrets', 'channel-secret.json'),
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'YUI_VOICE_TOOLS', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'YUI_CEREBRO_EXTERNO', 'YUI_CHAT_TURN_TIMEOUT_MS', 'YUI_REPLY_MAX_TOKENS', 'YUI_CEREBRO_MAX_TOKENS',
  'YUI_MAX_TOKENS_TETO', 'YUI_CEREBRO_BUSCA_AUTOMATICA', 'YUI_CEREBRO_BUSCA_RESERVA', 'YUI_PESQUISA_RETOMADA', 'YUI_PESQUISA_RETOMADA_MIN', 'YUI_PESQUISA_RETOMADA_PRIVADA',
  'YUI_READ_ONLY', 'AI_MAX_TOKENS', 'AI_BACKEND', 'YUI_GATEWAY_DISABLE', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'YUI_GATEWAY_CUSTOM']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: axios } = await import('axios');
let axiosHook = null;
axios.post = async (url, body) => { if (axiosHook) return axiosHook(String(url), body); throw new Error('offline (teste)'); };
axios.get = async () => { throw new Error('offline (teste)'); };
let fetchHook = null;
globalThis.fetch = async (u, init) => { if (fetchHook) return fetchHook(String(u), init); throw new Error(`fetch bloqueado no teste: ${String(u).slice(0, 40)}`); };
const realWrite = fs.writeFileSync;
fs.writeFileSync = function guarded(file, ...rest) {
  if (/[\\/]data[\\/][^\\/]+\.json$/.test(String(file)) && !String(file).startsWith(tmp)) return undefined; // nada nos arquivos de dados reais
  return realWrite.call(this, file, ...rest);
};
const realAppendFile = fs.appendFile;
fs.appendFile = function guardedAppend(file, data, cb) {
  if (String(file).endsWith(path.join('data', 'historico.txt'))) { if (typeof cb === 'function') cb(null); return undefined; }
  return realAppendFile.call(this, file, data, cb);
};

const { default: config } = await imp('src/config/index.js');
config.saveHistory = false;
const { logger } = await imp('src/utils/logger.js');
for (const level of ['info', 'warn', 'error', 'debug']) logger[level] = () => {};
const realConsole = { log: console.log };
const say = (s) => realConsole.log(s);
console.log = console.warn = console.error = () => {};

const llm = await imp('src/handlers/llmHandler.js');
const conversa = await imp('src/cerebro/conversa.js');
const pesquisa = await imp('src/cerebro/pesquisa.js');
const retomadaMod = await imp('src/cerebro/pesquisaRetomada.js');
const turno = await imp('src/discord/turnoCerebro.js');
const limites = await imp('src/core/ai/limitesTokens.js');
const manager = await imp('src/core/ai/manager.js');
const gatewayIndex = await imp('src/gateway/index.js');
const { createRouter } = await imp('src/gateway/router.js');
const { createFakeSearch } = await imp('src/cerebro/buscaFalsa.js');
const { createBudget } = await imp('src/search/budget.js');
const { createIdemCache } = await imp('src/core/channel/protocol.js');
const { TEXTO_PESQUISA_INDISPONIVEL } = await imp('src/search/indisponivel.js');
const { precisaDeFonteExterna } = await imp('src/core/ai/searchIntent.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    say(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 8).join('\n        ')}`);
  }
};
const section = (t) => say(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const META = { role: 'bot' };
let idSeq = 960000000000000000n;
const nextId = () => String(++idSeq);
const tokensOf = (text) => [...new Set(String(text).match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
const registro = () => { try { return fs.readFileSync(REGISTRO, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
realWrite(BUSCA_CTRL, '{}');
const FAKE_ENV = { YUI_TESTE_BUSCA_FALSA_REGISTRO: REGISTRO, YUI_TESTE_BUSCA_FALSA_CONTROLE: BUSCA_CTRL };
async function waitUntil(check, ms = 10_000, what = 'condição') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await check()) return; await sleep(20); }
  throw new Error(`tempo esgotado esperando: ${what}`);
}
/** Uma porta que segura uma chamada até o teste abrir (simula o processo que parou ali). */
function portao() { let abrir; const p = new Promise((r) => { abrir = r; }); return { p, abrir }; }

/** IA falsa: otimizador "SIM: <entrada>", síntese com as marcas que recebeu, conversa com `reply` (ou o padrão). `trava`: segura UM tipo de chamada. */
function fakeAi({ reply = null, trava = null } = {}) {
  const calls = [];
  const answer = async (a, isolated) => {
    const sys = String(a.system ?? '');
    const prompt = String(a.prompt ?? '');
    let tipo = 'conversa';
    if (sys === 'Responda apenas com o comando solicitado.') tipo = 'otimizador';
    else if (prompt.includes('[PERGUNTA DO USUÁRIO]:')) tipo = 'sintese';
    calls.push({ ...a, tipo, isolated });
    if (trava && trava.tipo === tipo && !trava.usada) { trava.usada = true; trava.chegou = true; await trava.p; }
    if (tipo === 'otimizador') { const m = /ENTRADA: "([^"]*)"/.exec(prompt); return `SIM: ${m ? m[1] : 'consulta'}`; }
    if (tipo === 'sintese') return `Segundo as fontes [1], está tudo certo. marcas=[${tokensOf(prompt).join(',')}]`;
    if (typeof reply === 'function') return reply(a, calls.length);
    const web = /\[CONTEXTO OBTIDO NA WEB\]|DADOS EXTERNOS NÃO CONFIÁVEIS/.test(prompt);
    return `resposta da conversa marcas=[${tokensOf(prompt).join(',')}] web=${web ? 'sim' : 'nao'}`;
  };
  return { calls, listBackends: () => [{ name: 'falsa', active: true }], chat: (a) => answer(a, false), isolatedChat: (a) => answer(a, true) };
}
const logLinhas = [];
const capt = { debug() {}, info: (m) => logLinhas.push(String(m)), warn: (m) => logLinhas.push(String(m)), error: (m) => logLinhas.push(String(m)) };

const CANAL = { serverPrompt: null, channelSettings: null, radioBlock: '', toolsActive: [], toolsDisabled: [] };
function facts({ id = nextId(), user, guild = null, channel, text, entry = 'fila', canal = CANAL } = {}) {
  return {
    turn: { id, at: Date.now() - 500 },
    ctx: { platform: 'discord', userId: user, guildId: guild, channelId: channel, isDM: !guild, isBlocked: false },
    call: { entry, type: entry === 'yui' ? 'slash' : 'mention', record: true, mentionsBot: true, hasBotName: false, repliesToBot: false, thirdParty: false, voice: false, voiceInteraction: false, voiceItem: false, chatter: false, contextOptIn: false },
    ownText: text, memoryQuery: text, channel: canal,
  };
}
/**
 * Um "processo" do cérebro: o diário numa pasta, contadores de cota PRÓPRIOS (createBudget: em memória, como num processo novo), a busca
 * falsa passando por essa cota, e a IA falsa. `pausaBusca` e `pausaPagina` seguram a busca e a leitura (o processo "morre" ali).
 */
function cerebro({ dir, ai = fakeAi(), pausaBusca = null, pausaPagina = null, env = process.env } = {}) {
  const budget = createBudget({ filePath: path.join(tmp, `cota-${nextId()}.json`) });
  const base = createFakeSearch({ env: FAKE_ENV, budget, pausa: pausaBusca });
  const busca = pausaPagina ? { ...base, readPage: async (url, o) => { await pausaPagina(); return base.readPage(url, o); } } : base;
  const retomada = retomadaMod.createRetomadaDePesquisa({ dir, env, logger: capt, budget });
  const chat = conversa.createChatBrain({ ai, logger: capt, busca, env, memoryBlock: () => '', persona: () => '', retomada });
  const research = pesquisa.createResearchBrain({ chat, ai, logger: capt, busca, env, emit: () => 0, retomada, budget });
  return { chat, research, retomada, budget, ai, morrer: () => retomada.fechar() };
}
const arquivoDe = (dir, userId) => path.join(dir, retomadaMod.arquivoDaPessoa(userId));
const lerDiario = (dir, userId) => { try { return JSON.parse(fs.readFileSync(arquivoDe(dir, userId), 'utf8')); } catch { return null; } };
const agente = (tok) => registro().filter((r) => r.tipo === 'agente' && r.consulta.includes(tok));
const rapida = (tok) => registro().filter((r) => r.tipo === 'rapida' && r.consulta.includes(tok));
const usadasDa = (c, user = MEMBER) => c.budget.userStatus(user).used;

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. Retomada da pesquisa depois de derrubar o cérebro (sem repetição cega)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('antes da busca (pending): o /yui registrado e parado no otimizador; o cérebro novo retoma, busca UMA vez e conta UMA vez', async () => {
    const dir = path.join(tmp, 'r-antes');
    const trava = { tipo: 'otimizador', ...portao() };
    const A = cerebro({ dir, ai: fakeAi({ trava }) });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'qual o preço do PS5 hoje tok-A1', entry: 'yui' });
    const chave = `chat.yui:${f.turn.id}`;
    const pend = A.research.yui({ ...f, pergunta: f.ownText }, { ...META, idem: chave });
    await waitUntil(() => trava.chegou, 5000, 'o otimizador');
    A.morrer();
    const disco = lerDiario(dir, MEMBER);
    assert.equal(disco.pesquisas[retomadaMod.chaveProtegida(chave)].estado, 'pending', 'registrada, nada enviado ao buscador');
    assert.equal(rapida('tok-A1').length, 0);
    const B = cerebro({ dir });
    assert.equal(B.retomada.stats().porEstado.pending, 1);
    const out = await B.research.yui({ ...f, pergunta: f.ownText }, { ...META, idem: chave });
    assert.equal(out.usedSearch, true, out.text);
    assert.equal(rapida('tok-A1').length, 1, 'uma busca só');
    assert.equal(usadasDa(B), 1, 'a cota do cérebro novo conta essa busca UMA vez');
    assert.equal(B.retomada.stats().novasTentativas, 0);
    trava.abrir();
    await Promise.race([pend, sleep(3000)]);
    assert.equal(lerDiario(dir, MEMBER).pesquisas[retomadaMod.chaveProtegida(chave)].estado, 'completed', 'o processo "morto" não grava mais nada');
  });

  await test('durante a busca (uncertain): o pedido saiu e o resultado não foi registrado; UMA nova tentativa controlada, contada uma vez, no log e na saúde', async () => {
    const dir = path.join(tmp, 'r-durante');
    const segura = portao();
    let chegou = false;
    const A = cerebro({ dir, pausaBusca: async () => { chegou = true; await segura.p; } });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do PS5 tok-D1' });
    const chave = `research.turn:${f.turn.id}:1`;
    const pedido = { question: f.ownText, query: 'ps5 tok-D1' };
    const pend = A.research.turn({ ...f, pedido }, { ...META, idem: chave });
    await waitUntil(() => chegou, 5000, 'a busca chegar ao buscador');
    A.morrer();
    const disco = lerDiario(dir, MEMBER).pesquisas[retomadaMod.chaveProtegida(chave)];
    assert.equal(disco.estado, 'running');
    assert.equal(disco.etapas['agente:1'].estado, 'running', 'marcada "enviando" no disco ANTES de ir ao buscador');
    assert.equal(usadasDa(A), 1, 'o processo antigo contou a busca (e essa conta morre com ele)');
    logLinhas.length = 0;
    const B = cerebro({ dir });
    const st0 = B.retomada.stats();
    assert.equal(st0.incertasNaCarga, 1, 'na carga, a busca sem resultado virou INCERTA');
    assert.equal(st0.porEstado.uncertain, 1);
    const out = await B.research.turn({ ...f, pedido }, { ...META, idem: chave });
    assert.equal(out.kind, 'answer', out.text);
    assert.equal(agente('tok-D1').length, 2, 'a busca incerta + UMA nova tentativa');
    assert.equal(usadasDa(B), 1, 'a nova tentativa contou na cota UMA vez');
    const st = B.retomada.stats();
    assert.equal(st.novasTentativas, 1);
    assert.equal(st.desistencias, 0);
    const reg = lerDiario(dir, MEMBER).pesquisas[retomadaMod.chaveProtegida(chave)];
    assert.equal(reg.estado, 'completed');
    assert.equal(reg.etapas['agente:1'].tentativas, 2, 'a nova tentativa ficou registrada no diário');
    assert.ok(logLinhas.some((l) => /INCERTA/.test(l) && /nova tentativa controlada \(2 de 2\)/.test(l)), logLinhas.join('\n'));
    assert.ok(logLinhas.every((l) => !/tok-|PS5|ps5/.test(l)), `o log não leva a pergunta nem a consulta: ${logLinhas.join(' | ')}`);
    segura.abrir();
    await Promise.race([pend, sleep(3000)]);
  });

  await test('depois de guardar a busca (parado na leitura das páginas): a busca NÃO roda de novo e volta a contar na cota do cérebro novo', async () => {
    const dir = path.join(tmp, 'r-guardada');
    const segura = portao();
    let chegou = false;
    const A = cerebro({ dir, pausaPagina: async () => { chegou = true; await segura.p; } });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o melhor ssd tok-G1' });
    const chave = `research.turn:${f.turn.id}:1`;
    const pedido = { question: f.ownText, query: 'melhor ssd tok-G1' };
    const pend = A.research.turn({ ...f, pedido }, { ...META, idem: chave });
    await waitUntil(() => chegou, 5000, 'a leitura começar');
    A.morrer();
    assert.equal(lerDiario(dir, MEMBER).pesquisas[retomadaMod.chaveProtegida(chave)].etapas['agente:1'].estado, 'completed', 'a busca está guardada');
    const B = cerebro({ dir });
    const out = await B.research.turn({ ...f, pedido }, { ...META, idem: chave });
    assert.equal(out.kind, 'answer', out.text);
    assert.equal(agente('tok-G1').length, 1, 'nenhuma busca nova');
    assert.equal(usadasDa(B), 1, 'a busca feita antes da queda conta na cota do cérebro novo (uma vez)');
    const st = B.retomada.stats();
    assert.equal(st.buscasReaproveitadas, 1);
    assert.equal(st.cotaDevolvida, 1);
    assert.equal(st.novasTentativas, 0);
    segura.abrir();
    await Promise.race([pend, sleep(3000)]);
  });

  await test('durante a síntese: nem a busca nem a leitura das páginas se repetem; a síntese roda UMA vez no cérebro novo; a cota conta certo', async () => {
    const dir = path.join(tmp, 'r-sintese');
    const trava = { tipo: 'sintese', ...portao() };
    const A = cerebro({ dir, ai: fakeAi({ trava }) });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o melhor teclado tok-S1' });
    const chave = `research.turn:${f.turn.id}:1`;
    const pedido = { question: f.ownText, query: 'melhor teclado tok-S1' };
    const pend = A.research.turn({ ...f, pedido }, { ...META, idem: chave });
    await waitUntil(() => trava.chegou, 5000, 'a síntese começar');
    A.morrer();
    const paginasAntes = registro().filter((r) => r.tipo === 'pagina').length;
    const reg = lerDiario(dir, MEMBER).pesquisas[retomadaMod.chaveProtegida(chave)];
    assert.equal(reg.etapas['sintese:1'].estado, 'running');
    assert.ok(Object.keys(reg.etapas).filter((k) => k.startsWith('pagina:')).length >= 1, 'as páginas lidas estão guardadas');
    const aiB = fakeAi();
    const B = cerebro({ dir, ai: aiB });
    const out = await B.research.turn({ ...f, pedido }, { ...META, idem: chave });
    assert.equal(out.kind, 'answer', out.text);
    assert.match(out.text, /tok-PAGINA/, 'a síntese recebeu as páginas guardadas');
    assert.equal(agente('tok-S1').length, 1, 'nenhuma busca nova');
    assert.equal(registro().filter((r) => r.tipo === 'pagina').length, paginasAntes, 'nenhuma página lida de novo');
    assert.equal(aiB.calls.filter((c) => c.tipo === 'sintese').length, 1, 'a síntese rodou uma vez no cérebro novo');
    assert.equal(usadasDa(B), 1);
    trava.abrir();
    await Promise.race([pend, sleep(3000)]);
  });

  await test('incerta DUAS vezes (o cérebro cai também na nova tentativa): sem terceira busca; a Yui pede para mandar de novo', async () => {
    const dir = path.join(tmp, 'r-duas');
    const s1 = portao();
    const s2 = portao();
    let c1 = false;
    let c2 = false;
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço da RAM tok-X1' });
    const chave = `research.turn:${f.turn.id}:1`;
    const pedido = { question: f.ownText, query: 'preço ram tok-X1' };
    const A = cerebro({ dir, pausaBusca: async () => { c1 = true; await s1.p; } });
    const pa = A.research.turn({ ...f, pedido }, { ...META, idem: chave });
    await waitUntil(() => c1, 5000);
    A.morrer();
    const B = cerebro({ dir, pausaBusca: async () => { c2 = true; await s2.p; } });
    const pb = B.research.turn({ ...f, pedido }, { ...META, idem: chave });
    await waitUntil(() => c2, 5000);
    B.morrer();
    const C = cerebro({ dir });
    const out = await C.research.turn({ ...f, pedido }, { ...META, idem: chave });
    assert.equal(out.text, retomadaMod.TEXTO_INTERROMPIDA);
    assert.equal(agente('tok-X1').length, 2, 'só as duas tentativas; nenhuma terceira');
    assert.equal(usadasDa(C), 0, 'o cérebro novo não buscou');
    assert.equal(C.retomada.stats().desistencias, 1);
    s1.abrir(); s2.abrir();
    await Promise.race([Promise.all([pa, pb]), sleep(3000)]);
  });

  await test('pesquisa CONCLUÍDA e repetida depois do reinício: a resposta guardada volta igual, sem buscar e sem chamar a IA', async () => {
    const dir = path.join(tmp, 'r-pronta');
    const A = cerebro({ dir });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do mouse tok-P1' });
    const chave = `research.turn:${f.turn.id}:1`;
    const pedido = { question: f.ownText, query: 'mouse tok-P1' };
    const primeira = await A.research.turn({ ...f, pedido }, { ...META, idem: chave });
    A.morrer();
    const reg = lerDiario(dir, MEMBER).pesquisas[retomadaMod.chaveProtegida(chave)];
    assert.equal(reg.estado, 'completed');
    assert.ok(Object.values(reg.etapas).every((e) => e.resultado === undefined), 'concluída: o conteúdo das etapas saiu do diário (fica só a resposta)');
    const aiB = fakeAi();
    const B = cerebro({ dir, ai: aiB });
    const again = await B.research.turn({ ...f, pedido }, { ...META, idem: chave });
    assert.deepEqual(again, primeira);
    assert.equal(agente('tok-P1').length, 1);
    assert.equal(aiB.calls.length, 0);
    assert.equal(B.retomada.stats().respostasReaproveitadas, 1);
    assert.equal(usadasDa(B), 1, 'a busca feita antes do reinício continua contando na cota do cérebro novo');
  });

  await test('a busca automática do passo da fila (chat.turn) também retoma: o mesmo passo depois do reinício reaproveita a web, sem buscar de novo', async () => {
    const dir = path.join(tmp, 'r-passo');
    const trava = { tipo: 'conversa', ...portao() };
    const A = cerebro({ dir, ai: fakeAi({ trava }) });
    const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o jogo tok-T1' });
    const params = { ...f, step: 1, prompt: 'pesquise o jogo tok-T1', options: { noTools: true, allowSearch: true, searchPrompt: 'pesquise o jogo tok-T1' } };
    const chave = `chat.turn:${f.turn.id}:1`;
    const pend = A.chat.turn(params, { ...META, idem: chave });
    await waitUntil(() => trava.chegou, 5000);
    A.morrer();
    assert.equal(rapida('tok-T1').length, 1);
    const B = cerebro({ dir });
    const out = await B.chat.turn(params, { ...META, idem: chave });
    assert.equal(out.usedSearch, true);
    assert.match(out.text, /web=sim/);
    assert.equal(rapida('tok-T1').length, 1, 'a busca do passo não rodou de novo');
    trava.abrir();
    await Promise.race([pend, sleep(3000)]);
  });

  await test('privacidade: um arquivo por pessoa (nome = hash, nunca o id); a pesquisa privada do Braga SEM conteúdo no disco (nem no arquivo dele); chave protegida; nada de texto no log', async () => {
    const dir = path.join(tmp, 'r-privado');
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    logLinhas.length = 0;
    try {
      const segura = portao();
      let chegou = false;
      const A = cerebro({ dir, pausaPagina: async () => { chegou = true; await segura.p; } });
      const d = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço do PS5 tok-DONO porque é presente' });
      const m = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço do Xbox tok-MEMBRO' });
      const pd = A.research.turn({ ...d, pedido: { question: d.ownText, query: 'ps5' } }, { ...META, idem: `research.turn:${d.turn.id}:1` });
      const pm = A.research.turn({ ...m, pedido: { question: m.ownText, query: 'xbox tok-MEMBRO' } }, { ...META, idem: `research.turn:${m.turn.id}:1` });
      await waitUntil(() => chegou, 5000);
      await sleep(200);
      const arquivos = fs.readdirSync(dir).filter((n) => n.endsWith('.json'));
      assert.equal(arquivos.length, 2, 'um arquivo por pessoa');
      assert.ok(arquivos.every((n) => /^[0-9a-f]{32}\.json$/.test(n) && !n.includes(OWNER) && !n.includes(MEMBER)), 'o nome do arquivo é um hash');
      const doDono = fs.readFileSync(arquivoDe(dir, OWNER), 'utf8');
      const doMembro = fs.readFileSync(arquivoDe(dir, MEMBER), 'utf8');
      // Segunda revisão da Liz (§12): da pesquisa PRIVADA só o estado e os metadados; nada da pergunta, da consulta (nem o hash), da web
      for (const proibido of ['tok-DONO', 'PS5', 'ps5', 'presente', 'exemplo-teste', 'consulta', 'resultado', d.turn.id]) assert.ok(!doDono.includes(proibido), `o diário privado tem "${proibido}": ${doDono}`);
      const regDono = Object.values(JSON.parse(doDono).pesquisas)[0];
      assert.equal(regDono.privado, true);
      assert.equal(regDono.estado, 'running');
      assert.ok(Object.keys(regDono.etapas).every((k) => /^(agente|pagina|sintese):\d+$/.test(k)), `etapas só pela ordem: ${Object.keys(regDono.etapas)}`);
      assert.ok(Object.keys(JSON.parse(doDono).pesquisas).every((k) => /^[0-9a-f]{32}$/.test(k)), 'a chave de recuperação fica só como hash');
      // a pública continua com o conteúdo (a retomada dela segue como antes), mas também com a chave protegida
      assert.ok(doMembro.includes('tok-MEMBRO') && !doMembro.includes('tok-DONO'));
      assert.ok(!doMembro.includes(m.turn.id), 'nem a chave da pública vai em texto');
      assert.ok(logLinhas.every((l) => !/tok-|PS5|Xbox|presente/.test(l)), logLinhas.join(' | '));
      A.morrer();
      segura.abrir();
      await Promise.race([Promise.all([pd, pm]), sleep(3000)]);
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
  });

  await test('a privada interrompida por um reinício fica uncertain e a Yui pede para mandar de novo: NENHUMA busca nova (research.turn e /yui); concluída também não é refeita', async () => {
    const dir = path.join(tmp, 'r-privado-reinicio');
    // a antiga opção de guardar o conteúdo da privada foi REMOVIDA: mesmo "true" é ignorado (e o log avisa)
    const env = { ...process.env, YUI_PRIVATE_SEARCH: 'owner', YUI_PESQUISA_RETOMADA_PRIVADA: 'true' };
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    logLinhas.length = 0;
    try {
      const segura = portao();
      let chegou = false;
      const A = cerebro({ dir, env, pausaPagina: async () => { chegou = true; await segura.p; } });
      assert.ok(logLinhas.some((l) => /YUI_PESQUISA_RETOMADA_PRIVADA foi removida/.test(l)), 'a opção removida é avisada no log');
      const d = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço da TV tok-PRIV' });
      const chave = `research.turn:${d.turn.id}:1`;
      const pd = A.research.turn({ ...d, pedido: { question: d.ownText, query: 'tv' } }, { ...META, idem: chave });
      await waitUntil(() => chegou, 5000);
      A.morrer();
      const conteudo = fs.readFileSync(arquivoDe(dir, OWNER), 'utf8');
      assert.ok(!conteudo.includes('tok-PRIV') && !conteudo.includes('exemplo-teste') && !conteudo.includes('TV'), 'nada da web nem da consulta no disco');
      const B = cerebro({ dir, env });
      assert.equal(B.retomada.stats().privadasIncertasNaCarga, 1, 'na subida, a privada começada vira uncertain');
      assert.equal(B.retomada.stats().porEstado.uncertain, 1);
      const out = await B.research.turn({ ...d, pedido: { question: d.ownText, query: 'tv' } }, { ...META, idem: chave });
      assert.equal(out.text, retomadaMod.TEXTO_PRIVADA_REENVIAR);
      assert.equal(out.private, true);
      assert.equal(agente('tok-PRIV').length, 1, 'nenhuma busca nova (a Yui não pesquisa sozinha de novo)');
      // a mesma chave de novo: o mesmo pedido para mandar de novo (nunca uma busca)
      const out2 = await B.research.turn({ ...d, pedido: { question: d.ownText, query: 'tv' } }, { ...META, idem: chave });
      assert.equal(out2.text, retomadaMod.TEXTO_PRIVADA_REENVIAR);
      assert.equal(agente('tok-PRIV').length, 1);
      assert.equal(B.research.stats().privadasReenviar, 2);
      // /yui privado CONCLUÍDO num processo e repetido depois do reinício: a resposta não ficou guardada, então pede para mandar de novo
      const y = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço do fone tok-PRIVY', entry: 'yui' });
      const ychave = `chat.yui:${y.turn.id}`;
      const r1 = await B.research.yui({ ...y, pergunta: y.ownText }, { ...META, idem: ychave });
      assert.ok(r1.researched, JSON.stringify(r1));
      const buscasY = agente('tok-PRIVY').length;
      assert.ok(!fs.readFileSync(arquivoDe(dir, OWNER), 'utf8').includes('tok-PRIVY'), 'a resposta privada pronta não fica no disco');
      B.morrer();
      const C = cerebro({ dir, env });
      const r2 = await C.research.yui({ ...y, pergunta: y.ownText }, { ...META, idem: ychave });
      assert.equal(r2.text, retomadaMod.TEXTO_PRIVADA_REENVIAR);
      assert.equal(agente('tok-PRIVY').length, buscasY, 'a concluída não é refeita');
      assert.ok(logLinhas.every((l) => !/tok-|TV|fone/.test(l)), logLinhas.join(' | '));
      segura.abrir();
      await Promise.race([pd, sleep(3000)]);
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
  });

  await test('a privada que ainda não começou nada (pending, sem etapas) pode ser reconstruída: roda normalmente com o pedido que o bot repete', async () => {
    const dir = path.join(tmp, 'r-privado-pendente');
    const env = { ...process.env, YUI_PRIVATE_SEARCH: 'owner' };
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    try {
      const A = cerebro({ dir, env });
      const d = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço da cadeira tok-PEND' });
      const chave = `research.turn:${d.turn.id}:1`;
      A.retomada.abrir(chave, { userId: OWNER, privado: true, tipo: 'research.turn' }); // registrada; o processo morre antes de qualquer etapa
      A.morrer();
      const B = cerebro({ dir, env });
      assert.equal(B.retomada.stats().porEstado.pending, 1);
      const out = await B.research.turn({ ...d, pedido: { question: d.ownText, query: 'cadeira' } }, { ...META, idem: chave });
      assert.notEqual(out.text, retomadaMod.TEXTO_PRIVADA_REENVIAR, out.text);
      assert.equal(agente('tok-PEND').length, 1, 'uma busca (nada tinha saído antes)');
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
  });

  // ── Etapa 8: as condições da Liz (§9 do relatório da etapa 7) para a privada `pending` ──────────────────────────────────────────
  await test('CONDIÇÃO DA LIZ: a marca de envio vem ANTES do despacho ao buscador: no instante em que a busca chega ao buscador, o diário NO DISCO já a tem como "running" (pública e privada; na privada, sem conteúdo)', async () => {
    for (const privado of [false, true]) {
      const dir = path.join(tmp, `r-marca-${privado ? 'priv' : 'pub'}`);
      const user = privado ? OWNER : MEMBER;
      const tok = privado ? 'tok-MARCAPRIV' : 'tok-MARCAPUB';
      const env = { ...process.env, ...(privado ? { YUI_PRIVATE_SEARCH: 'owner' } : {}) };
      if (privado) process.env.YUI_PRIVATE_SEARCH = 'owner';
      try {
        let noDespacho = null;
        // `pausaBusca` roda NO PONTO DO DESPACHO (a busca já chegou ao "buscador" e foi registrada): lê o disco ali, antes de qualquer resposta
        const A = cerebro({ dir, env, pausaBusca: async () => { noDespacho = lerDiario(dir, user); } });
        const f = facts({ user, guild: privado ? null : GUILD, channel: privado ? DMCH : CHAN, text: `pesquise o preço da mesa ${tok}` });
        const chave = `research.turn:${f.turn.id}:1`;
        const out = await A.research.turn({ ...f, pedido: { question: f.ownText, query: `mesa ${tok}` } }, { ...META, idem: chave });
        assert.equal(out.kind, 'answer', out.text);
        assert.ok(noDespacho, 'o diário existia no disco quando a busca chegou ao buscador');
        const reg = noDespacho.pesquisas[retomadaMod.chaveProtegida(chave)];
        assert.equal(reg.estado, 'running', 'a pesquisa já estava "em andamento" no disco');
        assert.equal(reg.etapas['agente:1'].estado, 'running', 'a busca já estava marcada "enviando" no disco ANTES de ir ao buscador');
        assert.equal(reg.privado, privado);
        assert.ok(Number.isFinite(reg.etapas['agente:1'].inicio), 'com o horário em que começou');
        if (privado) {
          const bruto = JSON.stringify(noDespacho);
          assert.ok(!bruto.includes(tok) && !bruto.includes('mesa') && !reg.etapas['agente:1'].consulta, 'a marca da privada não tem conteúdo (nem a consulta, nem o hash dela)');
        }
        // e o fim: concluída, no disco
        assert.equal(lerDiario(dir, user).pesquisas[retomadaMod.chaveProtegida(chave)].estado, 'completed');
        assert.equal(agente(tok).length, 1);
      } finally {
        process.env.YUI_PRIVATE_SEARCH = 'off';
      }
    }
  });

  await test('FALHAR FECHADO (Liz, etapa 8 §12): a marca de envio NÃO grava (disco com problema): a PRIVADA e a PÚBLICA não enviam NADA ao buscador nem cobram a cota e avisam, com o MESMO texto, que a pesquisa está temporariamente indisponível; com o disco de volta, a mesma chave roda UMA vez', async () => {
    const dir = path.join(tmp, 'r-sem-marca');
    const env = { ...process.env, YUI_PRIVATE_SEARCH: 'owner' };
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    logLinhas.length = 0;
    try {
      // o arquivo do diário de cada pessoa vira uma PASTA: nenhuma gravação (nem a da marca) consegue
      fs.mkdirSync(arquivoDe(dir, OWNER), { recursive: true });
      fs.mkdirSync(arquivoDe(dir, MEMBER), { recursive: true });
      const A = cerebro({ dir, env });
      const d = facts({ user: OWNER, channel: DMCH, text: 'pesquise o preço da lâmpada tok-SEMMARCA' });
      const chave = `research.turn:${d.turn.id}:1`;
      const out = await A.research.turn({ ...d, pedido: { question: d.ownText, query: 'lampada tok-SEMMARCA' } }, { ...META, idem: chave });
      assert.equal(out.text, retomadaMod.TEXTO_SEM_MARCA, out.text);
      assert.equal(out.text, TEXTO_PESQUISA_INDISPONIVEL, 'é o aviso ÚNICO de pesquisa indisponível');
      assert.equal(out.private, true);
      assert.equal(out.kind, 'failed');
      assert.equal(agente('tok-SEMMARCA').length, 0, 'NADA foi enviado ao buscador: sem a marca, um reinício não provaria o que saiu');
      assert.equal(usadasDa(A, OWNER), 0, 'sem despacho, sem cobrança');
      const st = A.retomada.stats();
      assert.equal(st.privadasSemMarca, 1);
      assert.equal(st.buscasSemMarca, 1);
      assert.ok(st.falhasDeGravacao >= 1, 'a falha de gravação aparece na saúde');
      assert.equal(st.gravacaoComFalha, true, 'e o diagnóstico sabe que a pesquisa está indisponível');
      assert.ok(logLinhas.some((l) => /NADA foi enviado ao buscador/.test(l)), logLinhas.join(' | '));
      assert.ok(logLinhas.every((l) => !/tok-SEMMARCA|lâmpada|lampada/.test(l)), 'o log não tem a consulta');
      // a PÚBLICA também FALHA FECHADO (antes seguia sem a marca): nada vai ao buscador, nada é cobrado, o mesmo aviso
      const p = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço da cadeira tok-PUBSEMDISCO' });
      const chavePub = `research.turn:${p.turn.id}:1`;
      const pub = await A.research.turn({ ...p, pedido: { question: p.ownText, query: 'cadeira tok-PUBSEMDISCO' } }, { ...META, idem: chavePub });
      assert.equal(pub.text, TEXTO_PESQUISA_INDISPONIVEL, pub.text);
      assert.equal(pub.kind, 'failed');
      assert.equal(pub.private, false);
      assert.equal(agente('tok-PUBSEMDISCO').length, 0, 'a pública NÃO pesquisou: sem a marca persistente nenhuma busca sai');
      assert.equal(usadasDa(A, MEMBER), 0, 'sem despacho, sem cobrança');
      assert.equal(A.retomada.stats().buscasSemMarca, 2);
      assert.ok(A.research.stats().indisponiveis >= 2, 'a saúde conta os avisos de pesquisa indisponível');
      assert.ok(logLinhas.every((l) => !/tok-PUBSEMDISCO|cadeira/.test(l)), 'o log não tem a consulta da pública');
      // o disco volta: a MESMA chave da privada roda, UMA vez, e conta UMA vez
      fs.rmSync(arquivoDe(dir, OWNER), { recursive: true, force: true });
      const B = cerebro({ dir, env });
      const ok = await B.research.turn({ ...d, pedido: { question: d.ownText, query: 'lampada tok-SEMMARCA' } }, { ...META, idem: chave });
      assert.equal(ok.kind, 'answer', ok.text);
      assert.equal(agente('tok-SEMMARCA').length, 1, 'uma busca só, depois que a marca pôde ser gravada');
      assert.equal(usadasDa(B, OWNER), 1);
      // e a pública, com o disco de volta, também roda UMA vez com a mesma chave
      fs.rmSync(arquivoDe(dir, MEMBER), { recursive: true, force: true });
      const C = cerebro({ dir, env });
      const okPub = await C.research.turn({ ...p, pedido: { question: p.ownText, query: 'cadeira tok-PUBSEMDISCO' } }, { ...META, idem: chavePub });
      assert.equal(okPub.kind, 'answer', okPub.text);
      assert.equal(agente('tok-PUBSEMDISCO').length, 1, 'uma busca só, depois que a marca pôde ser gravada');
      assert.equal(usadasDa(C, MEMBER), 1);
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
  });

  await test('CONDIÇÃO DA LIZ: a privada só roda de novo se o diário PROVA que nada saiu: "pending" sem etapa roda; qualquer outra coisa (etapa começada, em andamento, concluída ou incerta) vira "mande de novo", sem pesquisar', async () => {
    const env = { ...process.env, YUI_PRIVATE_SEARCH: 'owner' };
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    try {
      const casos = [
        { nome: 'pending sem etapa (a prova de que nada saiu)', estado: 'pending', etapas: {}, roda: true },
        { nome: 'pending com uma busca "running" (a marca de envio existe)', estado: 'pending', etapas: { 'agente:1': { tipo: 'busca', estado: 'running', tentativas: 1 } }, roda: false },
        { nome: 'pending com uma busca já concluída', estado: 'pending', etapas: { 'agente:1': { tipo: 'busca', estado: 'completed', tentativas: 1 } }, roda: false },
        { nome: 'pending com uma página lida', estado: 'pending', etapas: { 'pagina:1': { tipo: 'pagina', estado: 'completed' } }, roda: false },
        { nome: 'running sem etapa nenhuma', estado: 'running', etapas: {}, roda: false },
        { nome: 'uncertain', estado: 'uncertain', etapas: {}, roda: false },
        { nome: 'completed', estado: 'completed', etapas: {}, roda: false },
      ];
      for (const [i, c] of casos.entries()) {
        const dir = path.join(tmp, `r-prova-${i}`);
        fs.mkdirSync(dir, { recursive: true });
        const tok = `tok-PROVA${i}`;
        const d = facts({ user: OWNER, channel: DMCH, text: `pesquise o preço do cabo ${tok}` });
        const chave = `research.turn:${d.turn.id}:1`;
        const agora = Date.now();
        realWrite(arquivoDe(dir, OWNER), JSON.stringify({ versao: 2, gravadoEm: new Date(agora).toISOString(), pesquisas: { [retomadaMod.chaveProtegida(chave)]: { tipo: 'research.turn', estado: c.estado, privado: true, criadaEm: agora, atualizadaEm: agora, etapas: c.etapas } } }));
        const B = cerebro({ dir, env });
        const out = await B.research.turn({ ...d, pedido: { question: d.ownText, query: `cabo ${tok}` } }, { ...META, idem: chave });
        if (c.roda) {
          assert.notEqual(out.text, retomadaMod.TEXTO_PRIVADA_REENVIAR, c.nome);
          assert.equal(agente(tok).length, 1, `${c.nome}: roda UMA vez`);
        } else {
          assert.equal(out.text, retomadaMod.TEXTO_PRIVADA_REENVIAR, `${c.nome}: ${out.text}`);
          assert.equal(agente(tok).length, 0, `${c.nome}: nenhuma busca`);
          assert.equal(usadasDa(B, OWNER), 0, `${c.nome}: nada cobrado`);
        }
      }
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
  });

  await test('o diário: arquivo ilegível, os ".corrompido-*" antigos e o diário da versão anterior (com conteúdo privado) são APAGADOS na subida; vencido sai; temporário recolhido; YUI_PESQUISA_RETOMADA=false desliga', () => {
    const dir = path.join(tmp, 'r-modulo');
    fs.mkdirSync(dir, { recursive: true });
    realWrite(arquivoDe(dir, OTHER), '{quebrado');
    realWrite(path.join(dir, `${retomadaMod.arquivoDaPessoa(OTHER)}.corrompido-1763400000000`), '{"privado":true,"texto":"tok-VELHO"}');
    realWrite(path.join(dir, `${retomadaMod.arquivoDaPessoa(MEMBER)}.123.tmp`), 'x');
    // um diário da versão 1 (chave em texto e CONTEÚDO de uma pesquisa privada)
    realWrite(arquivoDe(dir, OWNER), JSON.stringify({ versao: 1, pesquisas: { 'research.turn:1:1': { tipo: 'research.turn', estado: 'running', privado: true, criadaEm: Date.now(), etapas: { 'agente:1': { tipo: 'busca', estado: 'completed', resultado: { results: [{ title: 'tok-PRIVADO-V1' }] } } } } } }));
    let agora = Date.now();
    logLinhas.length = 0;
    const r = retomadaMod.createRetomadaDePesquisa({ dir, now: () => agora, logger: capt });
    const sobrou = fs.readdirSync(dir);
    assert.ok(!sobrou.some((n) => n.includes('.corrompido-')), 'nada guardado ao lado (podia ter conteúdo privado)');
    assert.ok(!sobrou.includes(retomadaMod.arquivoDaPessoa(OTHER)), 'o ilegível foi apagado');
    assert.ok(!sobrou.includes(retomadaMod.arquivoDaPessoa(OWNER)), 'o diário antigo com conteúdo privado foi apagado');
    assert.ok(!sobrou.some((n) => n.endsWith('.tmp')), 'o temporário saiu');
    assert.equal(r.stats().antigosApagados, 1);
    assert.equal(r.stats().ilegiveisApagados, 2);
    assert.ok(logLinhas.some((l) => /versão anterior apagado/.test(l)) && logLinhas.every((l) => !/tok-/.test(l)), logLinhas.join(' | '));
    // defesa em profundidade: um registro privado da versão atual com conteúdo (vindo de fora) perde o conteúdo na carga
    const k = retomadaMod.chaveProtegida('research.turn:77:1');
    realWrite(arquivoDe(dir, OWNER), JSON.stringify({ versao: 2, pesquisas: { [k]: { tipo: 'research.turn', estado: 'completed', privado: true, criadaEm: agora, resultado: { text: 'tok-FORA' }, etapas: { 'agente:1': { tipo: 'busca', estado: 'completed', consulta: 'abc', resultado: { results: [] } } } } } }));
    const rs = retomadaMod.createRetomadaDePesquisa({ dir, now: () => agora, logger: capt });
    assert.equal(rs.stats().privadasSaneadas, 1);
    assert.ok(!fs.readFileSync(arquivoDe(dir, OWNER), 'utf8').includes('tok-FORA'), 'o conteúdo saiu do disco');
    const h = r.abrir('research.turn:900:1', { userId: MEMBER });
    assert.equal(h.estado, 'pending');
    agora += 31 * 60_000;
    const r2 = retomadaMod.createRetomadaDePesquisa({ dir, now: () => agora, logger: capt });
    assert.equal(r2.stats().porEstado.pending, 0, 'vencido (30 min) não volta');
    assert.equal(retomadaMod.createRetomadaDePesquisa({ dir, env: { YUI_PESQUISA_RETOMADA: 'false' } }).abrir('research.turn:901:1', { userId: MEMBER }), null);
    assert.deepEqual(retomadaMod.retomadaConfig({}), { ligada: true, validadeMs: 30 * 60_000, opcaoPrivadaRemovida: false });
    assert.equal(retomadaMod.retomadaConfig({ YUI_PESQUISA_RETOMADA_PRIVADA: 'true' }).opcaoPrivadaRemovida, true);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. A busca automática do /yui decidida pelo contexto');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('os critérios (só os detectores do searchIntent.js + documentação/fonte): conversa e pergunta simples não; atual, pedido e fonte sim', () => {
    const casos = [
      ['oi yui, tudo bem?', false, 'conversa'], ['qual a capital da França?', false, 'conversa'], ['me explica o que é fotossíntese', false, 'conversa'],
      ['quanto é 2+2?', false, 'conversa'], ['quanto tá o dólar hoje?', false, 'cotacao'], ['não pesquise nada, só diga oi', false, 'negated'],
      ['como pesquisar no google?', false, 'howto'], ['você consegue pesquisar?', false, 'capability'],
      ['qual o preço do PS5 hoje?', true, 'atual'], ['quais as últimas notícias do GTA 6?', true, 'atual'], ['já saiu o trailer do GTA 6?', true, 'atual'],
      ['pesquise o preço do PS5', true, 'pedido'], ['onde fica a documentação da API do Discord?', true, 'fonte'], ['qual a fonte disso?', true, 'fonte'],
    ];
    for (const [t, precisa, motivo] of casos) {
      const d = precisaDeFonteExterna(t);
      assert.equal(d.precisa, precisa, t);
      assert.equal(d.motivo, motivo, t);
    }
    assert.equal(precisaDeFonteExterna('pesquise o preço do PS5').explicito, true);
    assert.equal(precisaDeFonteExterna('qual o preço do PS5 hoje?').explicito, false);
  });

  const yuiDe = (c, user, text, extra = {}) => {
    const f = facts({ user, guild: extra.guild === undefined ? GUILD : extra.guild, channel: extra.channel ?? CHAN, text, entry: 'yui' });
    return c.research.yui({ ...f, pergunta: text }, { ...META, idem: `chat.yui:${f.turn.id}` });
  };
  await test('pergunta simples: não pesquisa (nem o otimizador roda), e a promessa do modelo NÃO vira pesquisa (a cota não é gasta)', async () => {
    const promete = fakeAi({ reply: (a, n) => (n === 1 ? 'Vou pesquisar isso e já te falo! tok-C1' : 'Paris é a capital da França.') });
    const c = cerebro({ dir: path.join(tmp, 'y1'), ai: promete });
    const out = await yuiDe(c, MEMBER, 'qual a capital da França? tok-C1');
    assert.equal(out.decisao.modo, 'sem_fonte');
    assert.equal(out.usedSearch, false);
    assert.equal(out.researched, false);
    assert.equal(registro().filter((r) => r.consulta?.includes('tok-C1')).length, 0, 'nada foi ao buscador');
    assert.equal(promete.calls.filter((x) => x.tipo === 'otimizador').length, 0, 'nem o otimizador foi chamado');
    assert.match(out.text, /Paris/, 'a promessa virou a resposta final, sem pesquisa');
    assert.equal(usadasDa(c), 0);
    assert.equal(fs.existsSync(path.join(tmp, 'y1')) ? fs.readdirSync(path.join(tmp, 'y1')).length : 0, 0, 'o /yui que não pesquisou não deixa nada no diário');
  });
  await test('assunto atual e documentação: a busca automática roda (sem exigir palavra-gatilho) e a resposta vem com a web', async () => {
    const c = cerebro({ dir: path.join(tmp, 'y2') });
    const atual = await yuiDe(c, MEMBER, 'qual o preço do PS5 hoje? tok-C2');
    assert.equal(atual.decisao.modo, 'pesquisar');
    assert.equal(atual.decisao.motivo, 'atual');
    assert.equal(atual.usedSearch, true, atual.text);
    assert.match(atual.text, /web=sim/);
    assert.equal(rapida('tok-C2').length, 1);
    const doc = await yuiDe(c, OTHER, 'onde fica a documentação da API do discord.js tok-C3?');
    assert.equal(doc.decisao.motivo, 'fonte');
    assert.equal(doc.usedSearch, true);
  });
  await test('cota perto do fim: a pergunta atual NÃO começa a busca e a Yui avisa; o pedido explícito ainda pesquisa', async () => {
    const c = cerebro({ dir: path.join(tmp, 'y3') });
    for (let i = 0; i < 4; i += 1) c.budget.takeUser(MEMBER); // 4 de 5 por hora: sobra 1 (a reserva de 20%)
    const atual = await yuiDe(c, MEMBER, 'qual o preço do PS5 hoje? tok-C4');
    assert.equal(atual.decisao.modo, 'cota');
    assert.equal(atual.usedSearch, false);
    assert.ok(atual.text.endsWith(pesquisa.AVISO_COTA), atual.text);
    assert.equal(registro().filter((r) => r.consulta?.includes('tok-C4')).length, 0);
    assert.equal(usadasDa(c), 4, 'nada gasto');
    const pedido = await yuiDe(c, MEMBER, 'pesquise o preço do PS5 tok-C5');
    assert.equal(pedido.decisao.modo, 'pesquisar');
    assert.equal(pedido.usedSearch, true, 'pedido explícito: a busca é necessária');
    assert.equal(usadasDa(c), 5);
    assert.deepEqual(pesquisa.cotaDaBusca(MEMBER, { budget: c.budget }).restantes.usuario, 0);
    assert.equal(pesquisa.cotaDaBusca(MEMBER, { budget: c.budget, env: { ...process.env, YUI_CEREBRO_BUSCA_RESERVA: '0' } }).perto, false, 'reserva 0 desliga o aviso');
  });
  await test('global perto do fim também conta; conversa privada segue as regras de antes (sem busca automática; o agente só com pedido explícito)', async () => {
    const c = cerebro({ dir: path.join(tmp, 'y4') });
    for (let i = 0; i < 16; i += 1) c.budget.takeUser(null); // 16 de 20 no teto global
    assert.equal(pesquisa.cotaDaBusca(MEMBER, { budget: c.budget }).motivo, 'global');
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    try {
      const atual = await yuiDe(c, OWNER, 'qual o preço do PS5 hoje? tok-C6', { guild: null, channel: DMCH });
      assert.equal(atual.decisao.modo, 'privada');
      assert.equal(atual.usedSearch, false);
      assert.equal(registro().filter((r) => r.consulta?.includes('tok-C6')).length, 0, 'privada: pergunta atual sem pedido explícito não pesquisa (como antes)');
      const pedido = await yuiDe(c, OWNER, 'pesquise o preço do PS5 tok-C7', { guild: null, channel: DMCH });
      assert.equal(pedido.researched, true, pedido.text);
      assert.ok(agente('tok-C7').every((r) => r.privado === true) && agente('tok-C7').length === 1, 'privada: o pedido explícito pesquisa com o texto literal');
    } finally {
      process.env.YUI_PRIVATE_SEARCH = 'off';
    }
    const off = await yuiDe(c, OWNER, 'pesquise o preço do PS5 tok-C8', { guild: null, channel: DMCH });
    assert.equal(off.researched, false);
    assert.equal(registro().filter((r) => r.consulta?.includes('tok-C8')).length, 0, 'sem YUI_PRIVATE_SEARCH a privada não pesquisa (como antes)');
  });
  await test('a Porta C (manager.reviewResearchReply) com semBuscaPorContexto: a promessa vira "resposta final", nunca pesquisa; sem o campo, nada muda', async () => {
    let pesquisou = 0;
    const deps = { llm: { runResearchFor: async () => { pesquisou += 1; return { kind: 'answer', text: 'achei', private: false }; }, isToolDisabled: () => false } };
    const base = { reply: 'Vou pesquisar o preço do PS5 hoje e já te falo!', text: 'qual o preço do PS5 hoje?', userId: MEMBER, guildId: GUILD, regenerate: async () => 'Custa uns R$ 3.800.' };
    const a = await manager.reviewResearchReply({ ...base, semBuscaPorContexto: true }, deps);
    assert.equal(pesquisou, 0);
    assert.equal(a.action, 'regenerate');
    assert.match(a.text, /3\.800/);
    const b = await manager.reviewResearchReply(base, deps);
    assert.equal(pesquisou, 1, 'sem o campo, a Porta C pesquisa como sempre');
    assert.equal(b.researched, true);
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('C. Limites de tokens unificados (Discord e app)');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const antigoApp = (env) => parseInt(env.AI_MAX_TOKENS || '1500', 10); // a regra de ANTES no app (gateway e openai-compatible)
  await test('a regra do app: o menor entre o AI_MAX_TOKENS, a capacidade do provedor e o teto; a lista de TODOS os casos que mudam em relação a antes', () => {
    const lim = (p, env, cap = null) => limites.limiteDoApp(p, { env, capacidadeDeclarada: cap }).limite;
    // nada muda com o padrão (1500) em nenhum provedor do Gateway, nem com valores até 2048
    for (const p of ['groq', 'gemini', 'huggingface', 'openrouter', 'cloudflare', 'together', 'pollinations', 'proprio-sem-declarar']) {
      assert.equal(lim(p, {}), 1500, p);
      assert.equal(lim(p, { AI_MAX_TOKENS: '2048' }), 2048, p);
    }
    // os casos que MUDAM (e só eles): capacidade ou teto abaixo do AI_MAX_TOKENS, e o valor inválido
    const mudam = [
      ['cloudflare', { AI_MAX_TOKENS: '3000' }, null, 2048, 'capacidade do Cloudflare (2048)'],
      ['groq', { AI_MAX_TOKENS: '6000' }, null, 4096, 'teto global (4096)'],
      ['gemini', { AI_MAX_TOKENS: '9000' }, null, 4096, 'teto global (antes o roteador cortava em 8192)'],
      ['meu-proprio', {}, 300, 300, 'capacidade declarada no YUI_GATEWAY_CUSTOM (maxTokens: 300)'],
      ['groq', { AI_MAX_TOKENS: '3000', YUI_MAX_TOKENS_TETO: '2000' }, null, 2000, 'teto global ajustado abaixo'],
    ];
    for (const [p, env, cap, novo, porque] of mudam) {
      assert.equal(lim(p, env, cap), novo, porque);
      assert.notEqual(Math.min(antigoApp(env), 8192), novo, `muda: ${porque}`);
    }
    assert.equal(limites.aiMaxTokens({ AI_MAX_TOKENS: 'abc' }), 1500, 'inválido: o padrão (antes ia null ao provedor)');
    assert.equal(limites.aiMaxTokens({ AI_MAX_TOKENS: '0' }), 1500, 'zero: o padrão (antes ia 0)');
    // segunda revisão da Liz (§12): a regra única do AI_MAX_TOKENS (Discord e app): abaixo de 64 é inválido (vai ao log e ao diagnóstico) e vale 1500
    assert.equal(limites.aiMaxTokens({ AI_MAX_TOKENS: '50' }), 1500, 'abaixo de 64: inválido, o padrão (antes o app usava 50 e o Discord 1500)');
    assert.equal(limites.limiteAppOpenAiCompativel({}), 1500);
    assert.equal(limites.limiteAppOpenAiCompativel({ AI_MAX_TOKENS: '6000' }), 4096, 'openai-compatible: muda só acima do teto');
    assert.equal(limites.limiteDaCadeiaNoApp('groq', 1024, {}), 1024, 'cadeia do bot no app: o padrão não muda');
    assert.equal(limites.limiteDaCadeiaNoApp('cloudflare', 6000, {}), 2048);
    assert.equal(limites.limiteDaCadeiaNoApp('groq', 6000, {}), 4096);
    assert.equal(limites.limiteDaCadeiaNoApp('horde', 900, {}), 512);
  });
  await test('o app pelo AI Manager + Gateway de verdade (fetch falso): padrão igual a antes; AI_MAX_TOKENS=6000 vira 4096 (teto); o Cloudflare fica em 2048', async () => {
    const seen = [];
    fetchHook = async (url, init) => {
      const body = JSON.parse(init.body);
      seen.push({ host: new URL(url).hostname, max: body.max_tokens });
      if (url.includes('groq')) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'fora' };
      if (url.includes('cloudflare')) return { ok: false, status: 503, headers: { get: () => null }, text: async () => 'fora' };
      return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok do gemini' }, finish_reason: 'stop' }] }) };
    };
    const saved = { ...process.env };
    Object.assign(process.env, { GEMINI_API_KEY: 'AIzaChaveFalsaSoParaTeste1234567890', CLOUDFLARE_ACCOUNT_ID: 'conta-falsa', CLOUDFLARE_API_TOKEN: 'token-falso-cloudflare-123', YUI_GATEWAY_DISABLE: 'pollinations', YUI_GATEWAY_PRIORITY: 'groq,cloudflare,gemini' });
    const ctx = { userId: MEMBER, platform: 'api', memoryScope: 'public' };
    const rodar = async (extra) => {
      seen.length = 0;
      for (const k of ['AI_MAX_TOKENS', 'YUI_MAX_TOKENS_TETO']) delete process.env[k];
      Object.assign(process.env, extra);
      gatewayIndex.resetGateway();
      manager.initAiManager();
      manager.setActiveBackend('gateway');
      await manager.chat({ prompt: 'oi', system: 'sys', ctx });
      return Object.fromEntries(seen.map((s) => [s.host.includes('groq') ? 'groq' : s.host.includes('cloudflare') ? 'cloudflare' : 'gemini', s.max]));
    };
    try {
      assert.deepEqual(await rodar({}), { groq: 1500, cloudflare: 1500, gemini: 1500 }, 'padrão: o mesmo de antes');
      assert.deepEqual(await rodar({ AI_MAX_TOKENS: '6000' }), { groq: 4096, cloudflare: 2048, gemini: 4096 }, 'antes: 6000 nos três');
      assert.deepEqual(await rodar({ AI_MAX_TOKENS: '1800' }), { groq: 1800, cloudflare: 1800, gemini: 1800 }, 'abaixo da capacidade e do teto: igual a antes');
    } finally {
      fetchHook = null;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      gatewayIndex.resetGateway();
      manager.initAiManager();
    }
  });
  await test('o app pelo openai-compatible (axios falso): padrão 1500 como antes; 6000 vira 4096; inválido vira 1500 (antes null)', async () => {
    const bodies = [];
    axiosHook = async (url, body) => { bodies.push(body.max_tokens); return { data: { choices: [{ message: { content: 'ok' } }] } }; };
    const saved = { ...process.env };
    try {
      for (const [valor, esperado] of [[undefined, 1500], ['6000', 4096], ['abc', 1500], ['2000', 2000]]) {
        Object.assign(process.env, { AI_BASE_URL: 'http://127.0.0.1:9/v1' });
        if (valor === undefined) delete process.env.AI_MAX_TOKENS; else process.env.AI_MAX_TOKENS = valor;
        manager.initAiManager();
        manager.setActiveBackend('openai-compatible');
        bodies.length = 0;
        await manager.chat({ prompt: 'oi', system: 'sys', ctx: { userId: MEMBER, platform: 'api', memoryScope: 'public' } });
        assert.deepEqual(bodies, [esperado], `AI_MAX_TOKENS=${valor}`);
      }
    } finally {
      axiosHook = null;
      for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
      Object.assign(process.env, saved);
      manager.initAiManager();
    }
  });
  await test('o app pela cadeia do bot (legacy-chain, processo único): capacidade e teto cortam a configuração da cadeia; o Discord no processo único NÃO muda', async () => {
    const bodies = [];
    axiosHook = async (url, body) => {
      if (String(url) === config.groqApiUrl) { bodies.push(body.max_tokens); return { data: { choices: [{ message: { content: 'resposta do groq' }, finish_reason: 'stop' }] } }; }
      throw new Error('offline (teste)');
    };
    const antes = llm.getProviderSettings().groq.max_tokens;
    try {
      manager.setLegacyBridge(async () => llm);
      manager.initAiManager();
      manager.setActiveBackend('legacy-chain');
      const ctx = { userId: MEMBER, platform: 'api', memoryScope: 'public' };
      await manager.chat({ prompt: 'oi', ctx });
      assert.deepEqual(bodies, [1024], 'padrão: o app recebe o mesmo de antes');
      llm.getProviderSettings().groq.max_tokens = 6000; // como o YUI_REPLY_MAX_TOKENS=6000 deixaria (sem passar pelo painel)
      bodies.length = 0;
      await manager.chat({ prompt: 'oi', ctx });
      assert.deepEqual(bodies, [4096], 'o app: cortado pelo teto global');
      bodies.length = 0;
      await llm.generateResponse('oi', CHAN, { guildId: GUILD, userId: MEMBER });
      assert.deepEqual(bodies, [6000], 'o Discord no processo único: o de sempre (o teto não entra)');
    } finally {
      llm.getProviderSettings().groq.max_tokens = antes;
      axiosHook = null;
      manager.setLegacyBridge(null);
      manager.initAiManager();
    }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('D. O ajuste do painel do Discord chegando ao cérebro');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('o painel ajusta a cadeia do bot; o bot manda o ajuste como fato do canal; o cérebro aplica como "configurado" (capacidade e teto ainda cortam)', async () => {
    const antes = { gemini: llm.getProviderSettings().gemini.max_tokens, hf: llm.getProviderSettings().hf.max_tokens };
    try {
      assert.equal(llm.channelFactsForCerebro({ guildId: GUILD, channelId: CHAN, userId: MEMBER }).maxTokens, undefined, 'sem ajuste do painel, nada a mandar');
      llm.updateProviderSetting('gemini', 'max_tokens', 3000);
      llm.updateProviderSetting('hf', 'max_tokens', 6000);
      const fatos = llm.channelFactsForCerebro({ guildId: GUILD, channelId: CHAN, userId: MEMBER });
      assert.deepEqual(fatos.maxTokens, { gemini: 3000, hf: 6000 });
      // pelo turno do bot (createRemoteTurn) e um canal falso: o chat.turn chega ao cérebro com o fato, e a IA recebe o pedido com o canal
      const ai = fakeAi();
      const chat = conversa.createChatBrain({ ai, logger: capt, memoryBlock: () => '', persona: () => '' });
      const idem = createIdemCache();
      turno.setChatRemote({
        connected: true, on: () => () => {}, onState: () => () => {}, ready: async () => ({}),
        request: async (method, params, { idem: key } = {}) => idem.run(`bot\u0000${method}\u0000${key}`, async () => ({ ok: true, payload: method === 'chat.turn' ? await chat.turn(params, { ...META, idem: key }) : { ok: true } })).promise.then((o) => o.payload),
      }, { logger: capt });
      const t = turno.createRemoteTurn({ ...facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'oi tok-PN1' }), channel: fatos });
      await t.generate('user: "oi tok-PN1"', { main: true });
      turno.setChatRemote(null);
      const pedido = ai.calls.at(-1).tokensPorProvedor;
      assert.deepEqual(pedido, { canal: { gemini: 3000, hf: 6000 } });
      // o que o Gateway manda a cada provedor com esse pedido
      const porProvedor = limites.limitePorProvedor({}, { canal: pedido.canal });
      assert.equal(porProvedor({ id: 'gemini' }), 3000, 'o painel vale como configurado');
      assert.equal(porProvedor({ id: 'huggingface' }), 4096, 'o hf do painel (6000) cortado pela capacidade/teto');
      assert.equal(porProvedor({ id: 'groq' }), 1024, 'provedor sem ajuste: o padrão');
      assert.equal(limites.limiteDoProvedor('gemini', { env: { YUI_CEREBRO_MAX_TOKENS: '{"gemini":900}' }, canal: { gemini: 3000 } }).limite, 3000, 'o painel vence o YUI_CEREBRO_MAX_TOKENS');
      assert.match(limites.limiteDoProvedor('gemini', { env: {}, canal: { gemini: 3000 } }).origem, /painel do Discord/);
      assert.deepEqual(limites.limitesDoCanal({ gemini: '3000', groq: 10, local: 99999, 'qualquer-coisa': 500, hf: 700.5 }), { gemini: 3000 }, 'o fato do canal é conferido');
      // e pelo Gateway de verdade, com o pedido do cérebro (fetch falso)
      const seen = [];
      fetchHook = async (url, init) => { seen.push(JSON.parse(init.body).max_tokens); return { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'ok' }, finish_reason: 'stop' }] }) }; };
      const saved = { ...process.env };
      Object.assign(process.env, { GEMINI_API_KEY: 'AIzaChaveFalsaSoParaTeste1234567890', YUI_GATEWAY_DISABLE: 'pollinations,groq' });
      try {
        gatewayIndex.resetGateway();
        manager.initAiManager();
        manager.setActiveBackend('gateway');
        await manager.chat({ prompt: 'oi', system: 'sys', ctx: { userId: MEMBER, platform: 'discord', memoryScope: 'public' }, tokensPorProvedor: pedido });
        assert.deepEqual(seen, [3000], 'o Gemini recebeu o ajuste do painel');
      } finally {
        fetchHook = null;
        for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
        Object.assign(process.env, saved);
        gatewayIndex.resetGateway();
        manager.initAiManager();
      }
      // o roteador do Gateway com o mesmo pedido, numa troca de provedor (o ajuste vale por provedor)
      const bodies = [];
      const router = createRouter({
        providers: [
          { id: 'huggingface', endpoint: 'https://primeiro.test/v1', keys: ['chave-falsa-123'], models: [{ id: 'm1', tier: 'smart' }], headers: {} },
          { id: 'gemini', endpoint: 'https://segundo.test/v1', keys: ['chave-falsa-456'], models: [{ id: 'm2', tier: 'smart' }], headers: {} },
        ],
        fetchImpl: async (url, init) => { bodies.push(JSON.parse(init.body).max_tokens); return url.includes('primeiro') ? { ok: false, status: 500, headers: { get: () => null }, text: async () => 'x' } : { ok: true, status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ choices: [{ message: { content: 'oi' } }] }) }; },
      });
      await router.chat({ model: 'auto', messages: [{ role: 'user', content: 'oi' }], max_tokens: 4096 }, { maxTokensFor: porProvedor });
      assert.deepEqual(bodies, [4096, 3000]);
    } finally {
      llm.updateProviderSetting('gemini', 'max_tokens', antes.gemini);
      llm.updateProviderSetting('hf', 'max_tokens', antes.hf);
    }
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { process.chdir(repoRoot); } catch { /* */ }
  try { const db = await imp('src/database/db.js'); db.closeAllDatabases?.(); } catch { /* */ }
  fs.writeFileSync = realWrite;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 3 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
