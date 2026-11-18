// Etapa 8, rodada depois da revisão da Liz (§12 do docs/RELATORIO_ETAPA8_PRE_PILOTO.md), num processo só, com IA, busca (o "buscador" é o fetch) e Discord falsos:
//
//  A. FALHAR FECHADO NA PESQUISA PÚBLICA TAMBÉM (item 2): nenhuma pesquisa externa começa sem o registro persistente (a marca do diário e a cota em disco) e sem o
//     dono da cota (a trava; item 1). Em cada caminho (a pesquisa da fila `research.turn`, o ramo antigo `YUI_RESEARCH_ENABLED=false`, o `/yui` = `chat.yui` e a busca
//     automática do passo do `chat.turn`) e com cada causa (o diário não grava, a cota por hora não grava, sem a trava, bot separado): NENHUMA chamada chega ao
//     "buscador", nada é cobrado, a Yui continua conversando e responde, no lugar da pesquisa, o aviso ÚNICO de pesquisa temporariamente indisponível. As escolhas EXPLÍCITAS
//     do dono (YUI_COTA_HORA_DISCO=false e YUI_PESQUISA_RETOMADA=false) seguem pesquisando. A pesquisa PRIVADA também.
//     Tudo pelo código de PRODUÇÃO (os buscadores padrão: searchForAgent e searchWeb, com o orçamento do processo); só o fetch (o "buscador"), a IA e o disco "cheio" são falsos.
//  B. A REUTILIZAÇÃO SEM COBRANÇA, com as condições da Liz (item 3): a segunda pessoa que faz a MESMA consulta pública ao mesmo tempo recebe o resultado CRU da busca que já
//     aconteceu (nenhuma chamada externa nova, nenhuma cobrança, nenhuma gravação), a reutilização é contada UMA vez (`reutilizadas`), a pesquisa PRIVADA nunca é
//     compartilhada nem reaproveitada (nem em andamento, nem pelo cache), e nada do contexto, da conversa ou da síntese de uma pessoa chega à outra.
// SEM rede (fetch falso, o bloqueio de integração externa vale no CI), SEM bancos reais (pasta temporária).
// Execução: npm run test:falhafechada   (node tests/test-pesquisa-falha-fechada.js)
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const repoRoot = path.resolve(import.meta.dirname, '..');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'yui-falha-fechada-'));
const OWNER = '111111111111111111';
const MEMBER = '222222222222222222';
const OTHER = '333333333333333333';
const GUILD = '444444444444444444';
const CHAN = '555555555555555555';
const DMCH = '777777777777777777';
const DMCH2 = '777777777777777778';
const HORA_ARQ = path.join(tmp, 'cota', 'search-budget-hora.json');

Object.assign(process.env, {
  DATABASE_DIR: path.join(tmp, 'db'), YUI_AUDIT_FILE: path.join(tmp, 'audit.jsonl'), YUI_OWNER_ID: OWNER, YUI_MEMORY_ENABLED: 'false', YUI_ALERTS: 'false',
  YUI_GATEWAY_IN_CHAIN: 'false', LOG_LEVEL: 'error', YUI_RESEARCH_ENABLED: 'true', YUI_RESEARCH_GUARD: 'on', YUI_RESEARCH_PRE_ROUTE: 'false', YUI_PRIVATE_SEARCH: 'off',
  YUI_CONTEXT_ENABLED: 'false', YUI_SEARCH_BUDGET_FILE: path.join(tmp, 'cota', 'search-budget.json'), YUI_POLICY_MODE: 'observe', YUI_RESEARCH_DEADLINE_MS: '20000',
  YUI_SEARCH_USER_PER_HOUR: '5', YUI_SEARCH_GLOBAL_PER_HOUR: '20', YUI_SEARCH_PROVIDERS: 'searxng', SEARXNG_URL: 'http://127.0.0.1:8080/',
  GROQ_API_KEY: 'gsk_chave_falsa_so_para_o_teste_1234567890', YUI_CHANNEL_SECRET_FILE: path.join(tmp, 'secrets', 'channel-secret.json'),
});
for (const k of ['GEMINI_API_KEYS', 'GEMINI_API_KEY', 'HF_TOKEN', 'CLOUDFLARE_ACCOUNT_ID', 'CLOUDFLARE_API_TOKEN', 'LM_STUDIO_API_KEY', 'AI_API_KEY', 'AI_BASE_URL', 'LOCAL_LLM_URL',
  'YUI_VOICE_TOOLS', 'YUI_PRIVATE_CHANNEL_IDS', 'YUI_TRUSTED_IDS', 'YUI_CEREBRO_EXTERNO', 'YUI_CHAT_TURN_TIMEOUT_MS', 'YUI_REPLY_MAX_TOKENS', 'YUI_CEREBRO_MAX_TOKENS',
  'YUI_MAX_TOKENS_TETO', 'YUI_CEREBRO_BUSCA_AUTOMATICA', 'YUI_CEREBRO_BUSCA_RESERVA', 'YUI_PESQUISA_RETOMADA', 'YUI_PESQUISA_RETOMADA_MIN', 'YUI_PESQUISA_RETOMADA_PRIVADA',
  'YUI_READ_ONLY', 'AI_MAX_TOKENS', 'AI_BACKEND', 'YUI_GATEWAY_DISABLE', 'OPENROUTER_API_KEY', 'TOGETHER_API_KEY', 'YUI_GATEWAY_CUSTOM', 'YUI_COTA_HORA_DISCO', 'YUI_SEARCH_CACHE_TTL_MIN']) delete process.env[k];
fs.mkdirSync(path.join(tmp, 'db'), { recursive: true });
fs.mkdirSync(path.join(tmp, 'persona'), { recursive: true });
for (const f of ['yui-publica.md', 'yui-voz.md']) { try { fs.copyFileSync(path.join(repoRoot, 'persona', f), path.join(tmp, 'persona', f)); } catch { /* texto de reserva */ } }
process.chdir(tmp);

const imp = (rel) => import(pathToFileURL(path.join(repoRoot, rel)).href);
const { default: axios } = await import('axios');
axios.post = async () => { throw new Error('offline (teste)'); };
axios.get = async () => { throw new Error('offline (teste)'); };

// O "BUSCADOR": o fetch global. Cada chamada que CHEGA aqui é uma busca externa que saiu (o teste conta). Um portão opcional segura as chamadas (a concorrência).
const externo = [];
let portao = null;
const jsonResp = (body) => ({ ok: true, status: 200, headers: new Headers(), json: async () => body, text: async () => JSON.stringify(body) });
globalThis.fetch = async (u) => {
  const url = new URL(String(u));
  if (url.hostname !== '127.0.0.1' || url.port !== '8080') throw new Error(`fetch bloqueado no teste: ${url.hostname}`);
  const q = url.searchParams.get('q') ?? '';
  const n = externo.push({ q }) ;
  if (portao) await portao.p;
  const marcas = (q.match(/\btok-[A-Za-z0-9]+\b/g) ?? []).join(' ');
  return jsonResp({ results: [1, 2, 3].map((i) => ({ title: `Resultado ${i} sobre ${q.slice(0, 60)}`, url: `https://fonte${i}.exemplo-teste.org/artigo-${i}-${n}`, content: `Trecho ${i} da web (chamada ${n}) para a consulta ${marcas}: informação útil.` })) });
};
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

const conversa = await imp('src/cerebro/conversa.js');
const pesquisa = await imp('src/cerebro/pesquisa.js');
const retomadaMod = await imp('src/cerebro/pesquisaRetomada.js');
const { createBudget, getDefaultBudget } = await imp('src/search/budget.js');
const { searchWeb, resetCooldowns } = await imp('src/search/providers.js');
const { ligarCotaHora, estadoDaCotaHora } = await imp('src/search/cotaHora.js');
const { TEXTO_PESQUISA_INDISPONIVEL } = await imp('src/search/indisponivel.js');
const { createCoreResearch } = await imp('src/core/ai/research.js');

let passed = 0;
const failures = [];
const test = async (name, fn) => {
  try {
    await fn();
    passed += 1;
    say(`  ok   ${name}`);
  } catch (err) {
    failures.push(name);
    say(`  FALHA ${name}\n        ${String(err?.stack ?? err).split('\n').slice(0, 9).join('\n        ')}`);
  } finally {
    // um teste que falhou no meio não pode deixar o "buscador" segurado para os seguintes
    if (portao) { portao.abrir(); portao = null; }
  }
};
const section = (t) => say(`\n${t}`);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitUntil(check, ms = 10_000, what = 'condição') {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) { if (await check()) return; await sleep(20); }
  throw new Error(`tempo esgotado esperando: ${what}`);
}
const META = { role: 'bot' };
let idSeq = 960000000000000000n;
const nextId = () => String(++idSeq);
const tokensOf = (text) => [...new Set(String(text).match(/\btok-[A-Za-z0-9]+\b/g) ?? [])];
function porta() { let abrir; const p = new Promise((r) => { abrir = r; }); return { p, abrir }; }
const TEMPO = { YUI_DB_OWNER_HEARTBEAT_MS: '100', YUI_DB_OWNER_STALE_MS: '500' }; // as travas do teste batem e vencem rápido
const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const logLinhas = [];
const capt = { debug() {}, info: (m) => logLinhas.push(String(m)), warn: (m) => logLinhas.push(String(m)), error: (m) => logLinhas.push(String(m)) };

/** IA falsa: otimizador "SIM: <entrada>", síntese com as marcas que recebeu, conversa com as marcas do prompt (e o aviso do sistema, se veio). */
function fakeAi() {
  const calls = [];
  const answer = async (a, isolated) => {
    const sys = String(a.system ?? '');
    const prompt = String(a.prompt ?? '');
    let tipo = 'conversa';
    if (sys === 'Responda apenas com o comando solicitado.') tipo = 'otimizador';
    else if (prompt.includes('[PERGUNTA DO USUÁRIO]:')) tipo = 'sintese';
    calls.push({ ...a, tipo, isolated });
    if (tipo === 'otimizador') { const m = /ENTRADA: "([^"]*)"/.exec(prompt); return `SIM: ${m ? m[1] : 'consulta'}`; }
    if (tipo === 'sintese') return `Segundo as fontes [1], está tudo certo. marcas=[${tokensOf(prompt).join(',')}]`;
    const web = /\[CONTEXTO OBTIDO NA WEB\]|DADOS EXTERNOS NÃO CONFIÁVEIS/.test(prompt);
    return `resposta da conversa marcas=[${tokensOf(prompt).join(',')}] web=${web ? 'sim' : 'nao'}`;
  };
  return { calls, listBackends: () => [{ name: 'falsa', active: true }], chat: (a) => answer(a, false), isolatedChat: (a) => answer(a, true) };
}
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
 * Um "cérebro" com os buscadores PADRÃO de produção (searchForAgent e searchWeb, com o orçamento do PROCESSO e o fetch falso), o diário numa pasta e a IA falsa.
 * Só o leitor de páginas é trocado (o de verdade abriria uma conexão). `diario: false` = YUI_PESQUISA_RETOMADA=false (o dono desligou o diário de propósito).
 */
function cerebro({ dir, ai = fakeAi(), env = process.env, diario = true } = {}) {
  const budget = getDefaultBudget();
  const busca = { readPage: async () => null };
  const retomada = diario ? retomadaMod.createRetomadaDePesquisa({ dir, env, logger: capt, budget }) : null;
  const chat = conversa.createChatBrain({ ai, logger: capt, busca, env, memoryBlock: () => '', persona: () => '', ...(retomada ? { retomada } : {}) });
  const research = pesquisa.createResearchBrain({ chat, ai, logger: capt, busca, env, emit: () => 0, ...(retomada ? { retomada } : {}), budget });
  return { chat, research, retomada, budget, ai };
}
const arquivoDe = (dir, userId) => path.join(dir, retomadaMod.arquivoDaPessoa(userId));
const lerDiario = (dir, userId) => { try { return JSON.parse(fs.readFileSync(arquivoDe(dir, userId), 'utf8')); } catch { return null; } };
const usadas = (user) => getDefaultBudget().userStatus(user).used;
const globais = () => getDefaultBudget().globalStatus().used;

/**
 * O estado da COTA deste processo (o orçamento do processo, getDefaultBudget) numa causa de indisponibilidade:
 *  - 'diario': a cota está normal (a trava na mão), mas o DIÁRIO não grava (o arquivo dele vira uma pasta; quem chama prepara);
 *  - 'cota': a trava na mão, mas o registro da cota por hora NÃO grava (o arquivo vira uma pasta: o "disco cheio" simulado, sem tocar no disco de verdade);
 *  - 'trava': a trava é de OUTRO processo vivo (este processo espera e não busca);
 *  - 'bot': o bot separado (nunca busca);
 *  - 'normal': a trava na mão e tudo gravando.
 * `fim()` solta tudo (as travas, o estado) para o próximo cenário.
 */
function estadoDaCota(causa, nome) {
  resetCooldowns();
  const budget = getDefaultBudget();
  budget.reset();
  externo.length = 0;
  const arquivo = path.join(tmp, 'cota', nome, 'search-budget-hora.json');
  fs.mkdirSync(path.dirname(arquivo), { recursive: true });
  const parar = [];
  let h;
  if (causa === 'bot') {
    h = ligarCotaHora({ papel: 'bot-separado', budget, logger: quiet, env: TEMPO });
  } else if (causa === 'trava') {
    const dono = createBudget({ filePath: path.join(path.dirname(arquivo), 'dono.json') });
    parar.push(ligarCotaHora({ papel: 'unico', budget: dono, logger: quiet, env: TEMPO, arquivo }));
    h = ligarCotaHora({ papel: 'cerebro', budget, logger: quiet, env: TEMPO, arquivo });
  } else {
    h = ligarCotaHora({ papel: 'cerebro', budget, logger: quiet, env: TEMPO, arquivo });
    if (causa === 'cota') fs.mkdirSync(arquivo, { recursive: true }); // o disco "cheio": o registro da cota não consegue mais gravar
  }
  parar.push(h);
  return { h, budget, arquivo, fim: () => { for (const x of parar) x.parar(); try { fs.rmSync(arquivo, { recursive: true, force: true }); } catch { /* */ } } };
}
/** Diz se o arquivo do diário de cada pessoa NÃO consegue gravar (vira uma pasta). */
function diarioQuebrado(dir, ...pessoas) { for (const p of pessoas) fs.mkdirSync(arquivoDe(dir, p), { recursive: true }); }

const CAUSAS = ['diario', 'cota', 'trava', 'bot'];
const NOME = { diario: 'o diário não grava a marca', cota: 'a cota por hora não grava', trava: 'sem a trava (outro processo é o dono)', bot: 'bot separado' };

try {
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('A. Falhar fechado nos QUATRO caminhos (fila, ramo antigo, /yui e a busca automática do passo), com cada causa');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  await test('A1. research.turn (a pesquisa da fila): sem a trava / sem gravar o diário ou a cota / bot separado, NENHUMA busca sai, nada é cobrado e a Yui avisa que a pesquisa está indisponível', async () => {
    for (const causa of CAUSAS) {
      const cota = estadoDaCota(causa, `a1-${causa}`);
      const dir = path.join(tmp, `d-a1-${causa}`);
      if (causa === 'diario') diarioQuebrado(dir, MEMBER);
      try {
        const A = cerebro({ dir });
        const tok = `tok-A1${causa.toUpperCase()}`;
        const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: `pesquise o preço da mesa ${tok}` });
        logLinhas.length = 0;
        const out = await A.research.turn({ ...f, pedido: { question: f.ownText, query: `mesa ${tok}` } }, { ...META, idem: `research.turn:${f.turn.id}:1` });
        assert.equal(out.text, TEXTO_PESQUISA_INDISPONIVEL, `${NOME[causa]}: ${out.text}`);
        assert.equal(out.kind, 'failed');
        assert.equal(out.private, false);
        assert.equal(externo.length, 0, `${NOME[causa]}: NENHUMA chamada chegou ao buscador`);
        assert.equal(usadas(MEMBER), 0, `${NOME[causa]}: nada cobrado`);
        assert.equal(globais(), 0);
        assert.ok(logLinhas.every((l) => !l.includes(tok) && !/\bmesa\b/.test(l)), `${NOME[causa]}: o log não leva a consulta`);
        assert.ok(A.research.stats().indisponiveis >= 1, 'a saúde conta o aviso (só um número)');
      } finally { cota.fim(); }
    }
  });

  await test('A2. o ramo ANTIGO (YUI_RESEARCH_ENABLED=false): a busca rápida também falha fechado, com o mesmo aviso, em cada causa', async () => {
    const envAntigo = { ...process.env, YUI_RESEARCH_ENABLED: 'false' };
    for (const causa of CAUSAS) {
      const cota = estadoDaCota(causa, `a2-${causa}`);
      const dir = path.join(tmp, `d-a2-${causa}`);
      if (causa === 'diario') diarioQuebrado(dir, MEMBER);
      try {
        const A = cerebro({ dir, env: envAntigo });
        const tok = `tok-A2${causa.toUpperCase()}`;
        const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: `pesquise o preço da cadeira ${tok}` });
        const out = await A.research.turn({ ...f, pedido: { question: f.ownText, query: `cadeira ${tok}`, antigo: true, prompt: f.ownText } }, { ...META, idem: `research.turn:${f.turn.id}:1` });
        assert.equal(out.text, TEXTO_PESQUISA_INDISPONIVEL, `${NOME[causa]}: ${out.text}`);
        assert.equal(out.kind, 'failed');
        assert.equal(out.usedSearch, false);
        assert.equal(externo.length, 0, `${NOME[causa]}: NENHUMA chamada chegou ao buscador`);
        assert.equal(usadas(MEMBER), 0, `${NOME[causa]}: nada cobrado`);
        assert.equal(A.ai.calls.filter((c) => c.tipo === 'conversa').length, 0, 'e a IA nem foi chamada para a resposta com a web (não há web)');
      } finally { cota.fim(); }
    }
  });

  await test('A3. o /yui (chat.yui): sem a trava / sem gravar, nenhuma busca sai; a Yui continua conversando (responde com o que sabe) e leva o aviso único (ou só o aviso, se o diário é quem não grava)', async () => {
    for (const causa of CAUSAS) {
      const cota = estadoDaCota(causa, `a3-${causa}`);
      const dir = path.join(tmp, `d-a3-${causa}`);
      if (causa === 'diario') diarioQuebrado(dir, MEMBER);
      try {
        const A = cerebro({ dir });
        const tok = `tok-A3${causa.toUpperCase()}`;
        const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: `qual o preço do PS5 hoje ${tok}`, entry: 'yui' });
        const out = await A.research.yui({ ...f, pergunta: f.ownText }, { ...META, idem: `chat.yui:${f.turn.id}` });
        assert.equal(out.decisao?.modo, 'pesquisar', 'a decisão era pesquisar (assunto atual)');
        assert.ok(out.text.includes(TEXTO_PESQUISA_INDISPONIVEL), `${NOME[causa]}: ${out.text}`);
        assert.equal(out.text.split(TEXTO_PESQUISA_INDISPONIVEL).length, 2, 'o aviso aparece UMA vez só');
        assert.equal(out.usedSearch, false);
        assert.equal(out.failed, false, 'a conversa continua (não é uma falha da IA)');
        if (causa !== 'diario') assert.match(out.text, /^resposta da conversa/, `${NOME[causa]}: a Yui respondeu com o que sabe, antes do aviso`);
        assert.equal(externo.length, 0, `${NOME[causa]}: NENHUMA chamada chegou ao buscador`);
        assert.equal(usadas(MEMBER), 0);
        const conversaIa = A.ai.calls.filter((c) => c.tipo === 'conversa');
        assert.ok(conversaIa.length >= 1 && conversaIa.every((c) => !/\[CONTEXTO OBTIDO NA WEB\]/.test(c.prompt)), 'a IA nunca recebeu "web" (não houve busca)');
        if (causa !== 'diario') assert.match(conversaIa[0].prompt, /temporariamente indisponível/, 'o modelo foi avisado (não promete pesquisar)');
      } finally { cota.fim(); }
    }
  });

  await test('A4. a busca automática do passo do chat.turn (allowSearch): sem a trava / sem gravar, nenhuma busca sai; o passo volta com o motivo "unavailable" e a conversa segue', async () => {
    for (const causa of CAUSAS) {
      const cota = estadoDaCota(causa, `a4-${causa}`);
      const dir = path.join(tmp, `d-a4-${causa}`);
      if (causa === 'diario') diarioQuebrado(dir, MEMBER);
      try {
        const A = cerebro({ dir });
        const tok = `tok-A4${causa.toUpperCase()}`;
        const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: `pesquise o jogo ${tok}` });
        const params = { ...f, step: 1, prompt: `pesquise o jogo ${tok}`, options: { noTools: true, allowSearch: true, searchPrompt: `pesquise o jogo ${tok}` } };
        const out = await A.chat.turn(params, { ...META, idem: `chat.turn:${f.turn.id}:1` });
        assert.equal(out.searchFailure, 'unavailable', `${NOME[causa]}: o motivo que o bot recebe`);
        assert.equal(out.usedSearch, false);
        assert.equal(out.failed, false, 'a conversa continua');
        assert.match(out.text, /^resposta da conversa/, 'a Yui respondeu (a IA foi chamada para a resposta)');
        assert.equal(externo.length, 0, `${NOME[causa]}: NENHUMA chamada chegou ao buscador`);
        assert.equal(usadas(MEMBER), 0, `${NOME[causa]}: nada cobrado`);
        const conv = A.ai.calls.filter((c) => c.tipo === 'conversa');
        assert.match(conv[0].prompt, /AVISO DO SISTEMA/);
        assert.match(conv[0].prompt, /temporariamente indisponível/, 'o modelo sabe que a pesquisa está indisponível e não promete pesquisar');
      } finally { cota.fim(); }
    }
  });

  await test('A5. a PESQUISA PRIVADA também falha fechado (cota por hora e sem a trava): nada sai, nada é cobrado, o mesmo aviso, e o conteúdo privado fica fora do log', async () => {
    process.env.YUI_PRIVATE_SEARCH = 'owner';
    try {
      for (const causa of ['cota', 'trava', 'bot']) {
        const cota = estadoDaCota(causa, `a5-${causa}`);
        try {
          const A = cerebro({ dir: path.join(tmp, `d-a5-${causa}`), env: { ...process.env, YUI_PRIVATE_SEARCH: 'owner' } });
          const f = facts({ user: OWNER, channel: DMCH, text: `pesquise o preço do cabo tok-A5${causa.toUpperCase()} porque é presente` });
          logLinhas.length = 0;
          const out = await A.research.turn({ ...f, pedido: { question: f.ownText, query: 'cabo' } }, { ...META, idem: `research.turn:${f.turn.id}:1` });
          assert.equal(out.text, TEXTO_PESQUISA_INDISPONIVEL, `${NOME[causa]}: ${out.text}`);
          assert.equal(out.private, true);
          assert.equal(externo.length, 0);
          assert.equal(usadas(OWNER), 0);
          assert.ok(logLinhas.every((l) => !/tok-A5|\bcabo\b|presente/.test(l)), 'o log não tem o conteúdo da pesquisa privada');
        } finally { cota.fim(); }
      }
    } finally { process.env.YUI_PRIVATE_SEARCH = 'off'; }
  });

  await test('A6. com o disco de VOLTA (o diário e a cota gravam) e a trava na mão, a MESMA chave pesquisa UMA vez e conta UMA vez (nada ficou cobrado pela falha)', async () => {
    const cota = estadoDaCota('cota', 'a6');
    const dir = path.join(tmp, 'd-a6');
    diarioQuebrado(dir, MEMBER);
    try {
      const A = cerebro({ dir });
      const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço da lâmpada tok-A6' });
      const chave = `research.turn:${f.turn.id}:1`;
      const pedido = { question: f.ownText, query: 'lampada tok-A6' };
      const falha = await A.research.turn({ ...f, pedido }, { ...META, idem: chave });
      assert.equal(falha.text, TEXTO_PESQUISA_INDISPONIVEL);
      assert.equal(externo.length, 0);
      // o disco volta: o arquivo da cota e o do diário voltam a ser arquivos (e o cérebro é outro "processo": a mesma chave, o mesmo pedido)
      fs.rmSync(cota.arquivo, { recursive: true, force: true });
      fs.rmSync(arquivoDe(dir, MEMBER), { recursive: true, force: true });
      const B = cerebro({ dir });
      const ok = await B.research.turn({ ...f, pedido }, { ...META, idem: chave });
      assert.equal(ok.kind, 'answer', ok.text);
      assert.equal(externo.length, 1, 'UMA busca saiu');
      assert.equal(usadas(MEMBER), 1, 'e conta UMA vez');
      assert.equal(globais(), 1);
      assert.equal(lerDiario(dir, MEMBER).pesquisas[retomadaMod.chaveProtegida(chave)].estado, 'completed');
    } finally { cota.fim(); }
  });

  await test('A7. as ESCOLHAS EXPLÍCITAS do dono não são falha: YUI_COTA_HORA_DISCO=false (só memória) e YUI_PESQUISA_RETOMADA=false (sem diário) seguem pesquisando', async () => {
    resetCooldowns();
    const budget = getDefaultBudget();
    budget.reset();
    externo.length = 0;
    const avisos = [];
    const h = ligarCotaHora({ papel: 'cerebro', budget, logger: { ...quiet, warn: (m) => avisos.push(m) }, env: { YUI_COTA_HORA_DISCO: 'false' } });
    try {
      assert.equal(estadoDaCotaHora().codigo, 'desligada');
      assert.equal(estadoDaCotaHora().pesquisaDisponivel, true);
      assert.match(avisos.join('\n'), /escolha explícita do dono/);
      const A = cerebro({ dir: path.join(tmp, 'd-a7'), env: { ...process.env, YUI_PESQUISA_RETOMADA: 'false' }, diario: false });
      const f = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço da cama tok-A7' });
      const out = await A.research.turn({ ...f, pedido: { question: f.ownText, query: 'cama tok-A7' } }, { ...META, idem: `research.turn:${f.turn.id}:1` });
      assert.equal(out.kind, 'answer', out.text);
      assert.equal(externo.length, 1, 'a busca saiu: o dono escolheu a memória e o diário desligado');
      assert.equal(usadas(MEMBER), 1, 'conta na memória (zera num reinício: o dono sabe)');
      assert.equal(fs.existsSync(HORA_ARQ), false, 'nenhum arquivo de cota foi criado');
    } finally { h.parar(); }
  });

  // ═════════════════════════════════════════════════════════════════════════════════════════════
  section('B. Reutilização sem cobrança (a segunda pessoa com a mesma consulta pública), com as condições da Liz');
  // ═════════════════════════════════════════════════════════════════════════════════════════════
  const ENV_B = { SEARXNG_URL: 'http://127.0.0.1:8080/', YUI_SEARCH_PROVIDERS: 'searxng', YUI_SEARCH_USER_PER_HOUR: '3', YUI_SEARCH_GLOBAL_PER_HOUR: '10' };
  /** Um orçamento em disco com a trava na mão (a pesquisa disponível), para os testes do searchWeb. */
  function orcamento(nome, env = TEMPO) {
    const dir = path.join(tmp, 'cota', nome);
    fs.mkdirSync(dir, { recursive: true });
    const budget = createBudget({ filePath: path.join(dir, 'search-budget.json') });
    const h = ligarCotaHora({ papel: 'cerebro', budget, logger: quiet, env });
    return { budget, h, dir, arquivo: path.join(dir, 'search-budget-hora.json') };
  }
  const via = (budget, env = ENV_B) => (q, o = {}) => searchWeb(q, { logger: quiet, env, budget, ...o });
  /** Duas buscas concorrentes: a primeira chega ao "buscador" (esperamos o SINAL, nunca um tempo fixo) e fica segurada; a segunda é disparada; o portão abre. */
  async function concorrentes(fa, fb) {
    const p = porta();
    portao = p;
    externo.length = 0;
    const antes = externo.length;
    const a = fa();
    await waitUntil(() => externo.length === antes + 1, 5000, 'a primeira busca chegar ao buscador');
    const b = fb();
    return { a, b, soltar: async () => { p.abrir(); portao = null; return Promise.all([a, b]); }, chegou: () => externo.length - antes };
  }

  await test('B1. a mesma consulta pública ao mesmo tempo: UMA chamada externa, a segunda pessoa NÃO paga (nem reserva nem grava) e a reutilização é contada UMA vez, só como um número', async () => {
    resetCooldowns();
    const { budget, h, arquivo } = orcamento('b1');
    try {
      const busca = via(budget);
      const c = await concorrentes(() => busca('consulta compartilhada tok-B1', { userId: 'ua' }), () => busca('consulta compartilhada tok-B1', { userId: 'ub' }));
      // a segunda pessoa já está esperando a busca que está no ar (juntou-se na hora, de forma síncrona): nenhuma chamada nova (nem a vaga reservada)
      assert.equal(c.chegou(), 1, 'nenhuma chamada externa nova');
      assert.equal(budget.userStatus('ub', ENV_B).used, 0, 'e a vaga dela nem foi reservada');
      const gravacoesAntes = budget.hourlyStats().gravacoes;
      const [ra, rb] = await c.soltar();
      assert.equal(ra.provider, 'searxng');
      assert.equal(rb.provider, 'searxng');
      assert.deepEqual(rb.results, ra.results, 'a segunda recebeu o resultado CRU da primeira');
      assert.notEqual(rb.results, ra.results, 'cada uma com a sua cópia');
      assert.equal(budget.userStatus('ua', ENV_B).used, 1, 'a primeira pagou');
      assert.equal(budget.userStatus('ub', ENV_B).used, 0, 'a segunda NÃO gastou a cota dela');
      assert.equal(budget.globalStatus(ENV_B).used, 1, 'e o global conta uma busca só');
      assert.equal(budget.hourlyStats().gravacoes, gravacoesAntes, 'a reutilização não gravou nada no disco');
      assert.equal(JSON.parse(fs.readFileSync(arquivo, 'utf8')).global.length, 1);
      assert.equal(budget.reutilizadas(), 1, 'a reutilização conta UMA vez');
      assert.equal(budget.hourlyStats().reutilizadas, 1, 'e vai para a saúde como um número');
      assert.equal(typeof budget.hourlyStats().reutilizadas, 'number');
      // o que a segunda recebeu não tem nada da primeira pessoa (só o resultado do buscador)
      assert.deepEqual(Object.keys(rb).sort(), Object.keys(ra).sort());
      assert.ok(!JSON.stringify(rb).includes('ua'), 'nenhum rastro de quem fez a primeira busca');
    } finally { h.parar(); }
  });

  await test('B2. a reutilização NÃO exige gravar: com o registro em disco quebrado depois de a primeira busca sair, a segunda ainda recebe o resultado (e a falha de gravação não a atinge)', async () => {
    resetCooldowns();
    const { budget, h, arquivo } = orcamento('b2');
    try {
      const busca = via(budget);
      const c = await concorrentes(() => busca('consulta sem disco tok-B2', { userId: 'ua' }), () => { fs.rmSync(arquivo, { force: true }); fs.mkdirSync(arquivo); return busca('consulta sem disco tok-B2', { userId: 'ub' }); });
      const [ra, rb] = await c.soltar();
      assert.equal(ra.provider, 'searxng');
      assert.equal(rb.provider, 'searxng', 'a segunda recebeu o resultado mesmo com o disco quebrado');
      assert.equal(rb.indisponivel, undefined);
      assert.equal(budget.hourlyStats().falhas, 0, 'nenhuma tentativa de gravar por causa da reutilização');
      assert.equal(budget.userStatus('ub', ENV_B).used, 0);
      assert.equal(externo.length, 1);
    } finally { h.parar(); }
  });

  await test('B3. os LIMITES continuam valendo para quem só reutiliza: a pessoa que já estourou o limite dela é recusada mesmo na reutilização (sem cobrança, sem nova chamada)', async () => {
    resetCooldowns();
    const { budget, h } = orcamento('b3');
    try {
      const busca = via(budget);
      for (const i of [1, 2, 3]) await busca(`consulta antiga ${i} tok-B3`, { userId: 'uc' }); // uc estourou as 3 por hora
      assert.equal(budget.userStatus('uc', ENV_B).full, true);
      const c = await concorrentes(() => busca('consulta compartilhada tok-B3', { userId: 'ua' }), () => busca('consulta compartilhada tok-B3', { userId: 'uc' }));
      const [ra, rc] = await c.soltar();
      assert.equal(ra.provider, 'searxng');
      assert.equal(rc.limited, 'user', 'recusada pelo limite dela (sem usar o resultado da outra)');
      assert.deepEqual(rc.results, []);
      assert.equal(budget.reutilizadas(), 0, 'e a recusa não conta como reutilização');
      assert.equal(budget.userStatus('uc', ENV_B).used, 3, 'nada cobrado a mais');
    } finally { h.parar(); }
  });

  await test('B4. a pesquisa PRIVADA nunca é compartilhada nem reaproveitada: privada x pública, pública x privada e privada x privada, com a MESMA consulta ao mesmo tempo, fazem uma chamada externa cada e cada uma paga a sua', async () => {
    const combos = [['privada', 'publica'], ['publica', 'privada'], ['privada', 'privada']];
    for (const [i, [tipoA, tipoB]] of combos.entries()) {
      resetCooldowns();
      const { budget, h } = orcamento(`b4-${i}`);
      try {
        const busca = via(budget);
        const c = await concorrentes(
          () => busca('consulta igual tok-B4', { userId: 'ua', privado: tipoA === 'privada' }),
          () => busca('consulta igual tok-B4', { userId: 'ub', privado: tipoB === 'privada' }),
        );
        await waitUntil(() => c.chegou() === 2, 5000, `a segunda chamada externa (${tipoA} x ${tipoB})`);
        const [ra, rb] = await c.soltar();
        assert.equal(externo.length, 2, `${tipoA} x ${tipoB}: DUAS chamadas externas (nada compartilhado)`);
        assert.ok(ra.results[0].snippet.includes('chamada 1') && rb.results[0].snippet.includes('chamada 2'), `${tipoA} x ${tipoB}: cada uma recebeu o resultado da PRÓPRIA chamada`);
        assert.equal(budget.userStatus('ua', ENV_B).used, 1);
        assert.equal(budget.userStatus('ub', ENV_B).used, 1, `${tipoA} x ${tipoB}: cada uma pagou a sua`);
        assert.equal(budget.reutilizadas(), 0, 'nenhuma reutilização foi registrada');
      } finally { h.parar(); }
    }
  });

  await test('B5. o CACHE (opcional) também respeita a privada: a privada não lê nem grava o cache; a pública guarda e a reutilização do cache é contada, mas só entre públicas', async () => {
    resetCooldowns();
    const { budget, h } = orcamento('b5');
    try {
      const comCache = { ...ENV_B, YUI_SEARCH_CACHE_TTL_MIN: '5', YUI_SEARCH_USER_PER_HOUR: '9' };
      const busca = via(budget, comCache);
      externo.length = 0;
      // a privada NÃO grava no cache: a pública seguinte, idêntica, faz a PRÓPRIA chamada
      await busca('consulta de cache tok-B5', { userId: 'ua', privado: true });
      assert.equal(externo.length, 1);
      const pub = await busca('consulta de cache tok-B5', { userId: 'ub' });
      assert.equal(pub.cached, undefined, 'não veio do cache (a privada não o alimentou)');
      assert.equal(externo.length, 2, 'a pública fez a própria chamada');
      // agora o cache TEM a pública: a privada idêntica NÃO o lê (faz a própria chamada) e outra pública o reaproveita
      const priv = await busca('consulta de cache tok-B5', { userId: 'uc', privado: true });
      assert.equal(priv.cached, undefined, 'a privada nunca lê o cache');
      assert.equal(externo.length, 3);
      const pub2 = await busca('consulta de cache tok-B5', { userId: 'ud' });
      assert.equal(pub2.cached, true, 'a pública reaproveita o cache');
      assert.equal(externo.length, 3, 'sem nova chamada');
      assert.equal(budget.reutilizadas(), 1, 'a reutilização do cache também é registrada, uma vez');
      assert.equal(budget.userStatus('ud', comCache).used, 0, 'e não custa nada');
    } finally { h.parar(); }
  });

  await test('B6. a reutilização NÃO mistura nada entre pessoas no agente inteiro: duas pessoas, a MESMA consulta pública ao mesmo tempo; cada síntese recebe só a pergunta DELA e a mesma web crua; uma chamada externa só', async () => {
    resetCooldowns();
    const { budget, h } = orcamento('b6');
    try {
      const sinteses = [];
      const agente = createCoreResearch({
        searchImpl: (q, o) => searchWeb(q, { ...o, env: ENV_B }), budget, readPage: async () => null,
        chat: async ({ prompt }) => { sinteses.push(prompt); return `Segundo as fontes [1], está tudo certo. marcas=[${tokensOf(prompt).join(',')}]`; },
        forbiddenKeywords: [], isToolDisabled: () => false, log: () => {},
      });
      const p = porta();
      portao = p;
      externo.length = 0;
      const pa = agente.runResearchFor({ question: 'qual o preço do PS5 tok-QA', query: 'preço do ps5 tok-COMUM', userId: 'ua' });
      await waitUntil(() => externo.length === 1, 5000, 'a primeira busca chegar ao buscador');
      const pb = agente.runResearchFor({ question: 'qual o preço do PS5 tok-QB', query: 'preço do ps5 tok-COMUM', userId: 'ub' });
      assert.equal(externo.length, 1, 'a segunda se juntou à busca em andamento (nenhuma chamada nova)');
      p.abrir();
      portao = null;
      const [ra, rb] = await Promise.all([pa, pb]);
      assert.equal(externo.length, 1, 'UMA chamada externa');
      assert.equal(ra.kind, 'answer', ra.text);
      assert.equal(rb.kind, 'answer', rb.text);
      assert.equal(sinteses.length, 2);
      const sa = sinteses.find((s) => s.includes('tok-QA'));
      const sb = sinteses.find((s) => s.includes('tok-QB'));
      assert.ok(sa && sb && sa !== sb, 'cada síntese recebeu a pergunta da PRÓPRIA pessoa');
      assert.ok(!sa.includes('tok-QB') && !sb.includes('tok-QA'), 'a pergunta de uma pessoa nunca chega à síntese da outra');
      assert.ok(sa.includes('tok-COMUM') && sb.includes('tok-COMUM'), 'a web crua é a mesma');
      assert.match(ra.text, /tok-QA/);
      assert.ok(!ra.text.includes('tok-QB') && !rb.text.includes('tok-QA'));
      assert.equal(budget.userStatus('ub', ENV_B).used, 0, 'a segunda não pagou');
      assert.equal(budget.reutilizadas(), 1);
    } finally { h.parar(); }
  });

  await test('B7. no cérebro inteiro (os buscadores PADRÃO de produção): duas pessoas públicas fazem UMA chamada externa; duas pessoas em conversa PRIVADA com o mesmo pedido fazem DUAS (a privada é marcada até o searchWeb)', async () => {
    // pública x pública: a segunda aproveita a busca em andamento (o diário dela marca a busca antes: o sinal de que ela já chegou ao searchWeb)
    {
      const cota = estadoDaCota('normal', 'b7-pub');
      try {
        const dir = path.join(tmp, 'd-b7-pub');
        const A = cerebro({ dir });
        const p = porta();
        portao = p;
        const fa = facts({ user: MEMBER, guild: GUILD, channel: CHAN, text: 'pesquise o preço da TV tok-B7QA' });
        const fb = facts({ user: OTHER, guild: GUILD, channel: CHAN, text: 'pesquise o preço da TV tok-B7QB' });
        const chaveB = `research.turn:${fb.turn.id}:1`;
        const pa = A.research.turn({ ...fa, pedido: { question: fa.ownText, query: 'preco da tv tok-B7COMUM' } }, { ...META, idem: `research.turn:${fa.turn.id}:1` });
        await waitUntil(() => externo.length === 1, 5000, 'a primeira busca chegar ao buscador');
        const pb = A.research.turn({ ...fb, pedido: { question: fb.ownText, query: 'preco da tv tok-B7COMUM' } }, { ...META, idem: chaveB });
        await waitUntil(() => lerDiario(dir, OTHER)?.pesquisas?.[retomadaMod.chaveProtegida(chaveB)]?.etapas?.['agente:1']?.estado === 'running', 5000, 'a segunda marcar a busca no diário');
        p.abrir();
        portao = null;
        const [ra, rb] = await Promise.all([pa, pb]);
        assert.equal(ra.kind, 'answer', ra.text);
        assert.equal(rb.kind, 'answer', rb.text);
        assert.equal(externo.length, 1, 'públicas: UMA chamada externa');
        assert.equal(usadas(MEMBER), 1);
        assert.equal(usadas(OTHER), 0, 'a segunda não pagou');
        assert.equal(getDefaultBudget().reutilizadas(), 1, 'uma reutilização');
        assert.match(ra.text, /tok-B7QA/);
        assert.match(rb.text, /tok-B7QB/);
        assert.ok(!ra.text.includes('tok-B7QB') && !rb.text.includes('tok-B7QA'), 'nenhuma mistura entre as duas respostas');
      } finally { cota.fim(); }
    }
    // privada x privada (o dono e um membro, ambos em DM, com YUI_PRIVATE_SEARCH=all): o MESMO pedido literal, e nada é compartilhado
    process.env.YUI_PRIVATE_SEARCH = 'all';
    {
      const cota = estadoDaCota('normal', 'b7-priv');
      try {
        const A = cerebro({ dir: path.join(tmp, 'd-b7-priv'), env: { ...process.env, YUI_PRIVATE_SEARCH: 'all' } });
        const p = porta();
        portao = p;
        const texto = 'pesquise o preço da geladeira tok-B7PRIV';
        const fa = facts({ user: OWNER, channel: DMCH, text: texto });
        const fb = facts({ user: MEMBER, channel: DMCH2, text: texto });
        const pa = A.research.turn({ ...fa, pedido: { question: texto, query: 'ignorada' } }, { ...META, idem: `research.turn:${fa.turn.id}:1` });
        await waitUntil(() => externo.length === 1, 5000, 'a primeira busca privada chegar ao buscador');
        const pb = A.research.turn({ ...fb, pedido: { question: texto, query: 'ignorada' } }, { ...META, idem: `research.turn:${fb.turn.id}:1` });
        await waitUntil(() => externo.length === 2, 5000, 'a segunda busca privada chegar ao buscador (não se juntou à primeira)');
        p.abrir();
        portao = null;
        const [ra, rb] = await Promise.all([pa, pb]);
        assert.equal(ra.kind, 'answer', ra.text);
        assert.equal(rb.kind, 'answer', rb.text);
        assert.equal(externo[0].q, externo[1].q, 'a MESMA consulta literal (a comparação vale: só a marca de "privada" impede o compartilhamento)');
        assert.equal(externo.length, 2, 'privadas: DUAS chamadas externas');
        assert.equal(usadas(OWNER), 1);
        assert.equal(usadas(MEMBER), 1, 'cada uma pagou a sua');
        assert.equal(getDefaultBudget().reutilizadas(), 0, 'nenhuma reutilização');
        assert.equal(ra.private, true);
        assert.equal(rb.private, true);
      } finally { cota.fim(); process.env.YUI_PRIVATE_SEARCH = 'off'; }
    }
  });

  await test('B8. a reutilização aparece no diagnóstico e na saúde só como um NÚMERO (nenhuma consulta, nenhuma pessoa)', async () => {
    const { montarDiagnostico } = await imp('src/core/diagnostico.js');
    const d = montarDiagnostico({ fontes: { cota: () => ({ global: { usadas: 1, limite: 20, cheia: false }, hora: { persistente: true, reutilizadas: 3 }, dono: {}, mes: [] }), erros: () => ({ errors: 0, reconnects: 0, byTag: {} }), bancos: () => [], gateway: () => null, limites: () => ({ teto: 4096, discord: [], app: [] }), backends: () => [], avisos: () => [] } });
    assert.equal(d.cotasDeBusca.hora.reutilizadas, 3);
    const { budget, h } = orcamento('b8');
    try {
      budget.registrarReuso();
      assert.deepEqual(Object.keys(budget.hourlyStats()).filter((k) => k === 'reutilizadas'), ['reutilizadas']);
      assert.equal(budget.hourlyStats().reutilizadas, 1);
    } finally { h.parar(); }
  });
} finally {
  say(`\n${passed} testes OK${failures.length ? `, ${failures.length} FALHA(S): ${failures.join(' | ')}` : ''}`);
  try { process.chdir(repoRoot); } catch { /* */ }
  try { const db = await imp('src/database/db.js'); db.closeAllDatabases?.(); } catch { /* */ }
  fs.writeFileSync = realWrite;
  try { fs.rmSync(tmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* */ }
}
process.exit(failures.length ? 1 : 0);
